-- CardioLink · COPIAS PARA FACTURACIÓN V1 · tabla + bucket privado + autorización + RPC de impresión
-- NO EJECUTAR en STAGING ni en Production sin autorización explícita. Primero STAGING (yslhwdlzdknhskawqrtv); Production sólo con autorización aparte.
-- No está en supabase/migrations a propósito: `supabase db push` no debe poder aplicarla por accidente (CLI de este equipo apunta a Production).
-- Una sola transacción, ADITIVO: crea objetos nuevos y NO modifica ninguna tabla, función, política, bucket ni dato existente (ni 4C-1, ni patient_documents, ni el portal).
-- Falla (y revierte todo) si el estado de la base no es el esperado. Rollback: pending_review_copias_facturacion_v1_rollback.sql
--
-- QUÉ ES. Archivos PDF INDEPENDIENTES de los informes clínicos, destinados a la facturación mensual al Círculo Médico (Holter / MAPA: primera página firmada y sellada;
-- Eco: versión para facturación de EcoApp). Secretaría los descarga e imprime uno por uno para adjuntarlos a los bonos.
--   * Bucket PRIVADO propio `billing-copies` (no se comparte con patient-documents: las políticas restrictivas de 4C-1 sólo afectan a ese bucket y no interfieren).
--   * Tabla propia `cardiolink_copias_facturacion` (metadata + estado de impresión). NO toca cardiolink_patient_documents, HC, evoluciones ni el portal del paciente.
--
-- VÍNCULO CON LA ATENCIÓN: si attention_id viene informado debe existir y ser del mismo paciente y profesional (error CF002 si no corresponde; CF001 si todavía no está sincronizada: se carga sin vincular).
--
-- AUTORIZACIÓN (reutiliza lo ya publicado en Production por Seguridad clínica V1; no crea un segundo sistema de roles):
--   owner/admin  : todas las copias.
--   médico       : las de SU professional_id (cardiolink_ctx_prof_v1()).
--   secretaría   : las de profesionales con ASOCIACIÓN ACTIVA (cardiolink_secretaria_autorizada_prof_v1); al desactivar la asociación pierde el acceso al instante.
--   sin sesión / anon / sin rol activo: nada.
--   Subir  : mismas reglas (el profesional de la copia es obligatorio).
--   Eliminar (DECISIÓN POR DEFECTO, cambiar en UNA sola función: cardiolink_copia_facturacion_puede_eliminar_v1): owner/admin; médico las de su profesional;
--            Secretaría SÓLO las que ella misma subió y mientras siga asociada a ese profesional. Eliminar una copia NUNCA toca informes clínicos ni documentos de HC.
--   Marcar impreso / reimprimir: por RPC SECURITY DEFINER con la misma autorización (authenticated NO tiene UPDATE sobre la tabla).
--   Retención: no hay borrado automático (plazo por definir).

BEGIN;

-- ===== 0) Precondiciones =====
DO $$
DECLARE v_tipo text;
BEGIN
  IF to_regclass('public.cardiolink_user_roles') IS NULL THEN RAISE EXCEPTION 'Precondición: falta public.cardiolink_user_roles'; END IF;
  IF to_regclass('public.cardiolink_atenciones') IS NULL THEN RAISE EXCEPTION 'Precondición: falta public.cardiolink_atenciones (vínculo con la atención)'; END IF;
  IF to_regprocedure('public.cardiolink_ctx_rol_v1()') IS NULL OR to_regprocedure('public.cardiolink_ctx_prof_v1()') IS NULL THEN
    RAISE EXCEPTION 'Precondición: faltan cardiolink_ctx_rol_v1() / cardiolink_ctx_prof_v1() (Seguridad clínica V1)'; END IF;
  IF to_regprocedure('public.cardiolink_secretaria_autorizada_prof_v1(text)') IS NULL THEN
    RAISE EXCEPTION 'Precondición: falta cardiolink_secretaria_autorizada_prof_v1(text) (asociaciones activas: Seguridad clínica V1 / 4C-1)'; END IF;
  IF NOT has_function_privilege('authenticated', 'public.cardiolink_ctx_rol_v1()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.cardiolink_ctx_prof_v1()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.cardiolink_secretaria_autorizada_prof_v1(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Precondición: authenticated debe poder ejecutar las funciones de contexto y de asociación (las evalúan las políticas)'; END IF;
  IF to_regclass('public.cardiolink_copias_facturacion') IS NOT NULL
     OR to_regprocedure('public.cardiolink_copia_facturacion_acceso_v1(text)') IS NOT NULL
     OR to_regprocedure('public.cardiolink_copia_facturacion_puede_eliminar_v1(text,uuid)') IS NOT NULL
     OR to_regprocedure('public.cardiolink_copia_facturacion_objeto_asignable_v1(text)') IS NOT NULL
     OR to_regprocedure('public.cardiolink_copia_facturacion_objeto_sin_fila_v1(text)') IS NOT NULL
     OR to_regprocedure('public.cardiolink_copia_facturacion_vinculo_v1(text,text,text,text)') IS NOT NULL
     OR to_regprocedure('public.cardiolink_copia_facturacion_impresion_v1(uuid,text)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'billing-copies')
     OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname LIKE 'cardiolink_copias_fact\_%' ESCAPE '\') THEN
    RAISE EXCEPTION 'Copias para facturación V1 ya está aplicado (o parcialmente): no se repite'; END IF;
  SELECT data_type INTO v_tipo FROM information_schema.columns WHERE table_schema = 'storage' AND table_name = 'objects' AND column_name = 'owner';
  IF v_tipo IS DISTINCT FROM 'uuid' THEN RAISE EXCEPTION 'Precondición: storage.objects.owner debe ser uuid (es %)', v_tipo; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'storage' AND table_name = 'objects' AND column_name = 'created_at') THEN
    RAISE EXCEPTION 'Precondición: falta storage.objects.created_at'; END IF;
  -- Una política RESTRICTIVE de storage.objects que no filtre por bucket se combinaría (AND) con las del bucket nuevo y podría bloquearlo: abortar para revisarla.
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND permissive = 'RESTRICTIVE'
              AND (coalesce(qual, '') || ' ' || coalesce(with_check, '')) NOT LIKE '%bucket_id%') THEN
    RAISE EXCEPTION 'Precondición: hay una política RESTRICTIVE en storage.objects sin filtro por bucket: revisarla antes de agregar un bucket'; END IF;
END $$;

-- ===== 1) Tabla de metadata (el PDF vive SÓLO en Storage; esta tabla nunca guarda contenido binario) =====
CREATE TABLE public.cardiolink_copias_facturacion (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  copy_type text NOT NULL CHECK (copy_type IN ('Holter', 'MAPA', 'Ecocardiograma')),
  patient_id text NOT NULL CHECK (btrim(patient_id) <> ''),
  patient_name text NOT NULL CHECK (btrim(patient_name) <> ''),
  patient_dni text NULL,
  attention_id text NULL,
  professional_id text NOT NULL CHECK (btrim(professional_id) <> ''),
  professional_name text NULL,
  service text NULL,
  obra_social text NULL,
  study_date date NOT NULL,
  storage_path text NOT NULL UNIQUE
    CONSTRAINT copias_fact_storage_path_formato CHECK (storage_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$'),
  original_filename text NOT NULL,
  mime_type text NOT NULL CHECK (mime_type = 'application/pdf'),
  size_bytes bigint NULL CHECK (size_bytes IS NULL OR size_bytes BETWEEN 1 AND 10485760),
  print_status text NOT NULL DEFAULT 'pendiente' CHECK (print_status IN ('pendiente', 'impreso')),
  print_count integer NOT NULL DEFAULT 0 CHECK (print_count >= 0),
  printed_at timestamptz NULL,
  printed_by uuid NULL,
  uploaded_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cardiolink_copias_facturacion_fecha_idx ON public.cardiolink_copias_facturacion (study_date DESC);
CREATE INDEX cardiolink_copias_facturacion_prof_idx ON public.cardiolink_copias_facturacion (professional_id, study_date DESC);
CREATE INDEX cardiolink_copias_facturacion_atencion_idx ON public.cardiolink_copias_facturacion (attention_id) WHERE attention_id IS NOT NULL;

COMMENT ON TABLE public.cardiolink_copias_facturacion IS
  'Copias para facturación V1: PDF independientes de los informes clínicos (Holter/MAPA 1.ª página firmada, Eco versión EcoApp) para el Círculo Médico. El archivo vive en el bucket privado billing-copies. '
  'Acceso: owner/admin; médico por su professional_id; Secretaría por asociación activa. Sin UPDATE directo: el estado de impresión cambia por cardiolink_copia_facturacion_impresion_v1.';

-- ===== 2) Autorización (una sola fuente de verdad, reutilizada por tabla, Storage y RPC) =====
-- Ver / subir / marcar impreso: owner/admin; médico = su profesional; Secretaría = profesional de una asociación ACTIVA. Invoker: authenticated ya ejecuta las funciones de contexto.
CREATE FUNCTION public.cardiolink_copia_facturacion_acceso_v1(p_prof text)
 RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public
AS $f$
 SELECT coalesce(
   coalesce(btrim(p_prof), '') <> '' AND CASE (SELECT public.cardiolink_ctx_rol_v1())
     WHEN 'owner' THEN true
     WHEN 'admin' THEN true
     WHEN 'medico' THEN p_prof = (SELECT public.cardiolink_ctx_prof_v1())
     WHEN 'secretaria' THEN public.cardiolink_secretaria_autorizada_prof_v1(p_prof)
     ELSE false END,
   false)
$f$;

-- Eliminar. ÚNICO lugar donde se decide: owner/admin; médico = su profesional; Secretaría = sólo lo que ella subió y mientras siga asociada al profesional.
CREATE FUNCTION public.cardiolink_copia_facturacion_puede_eliminar_v1(p_prof text, p_uploaded_by uuid)
 RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public
AS $f$
 SELECT coalesce(
   coalesce(btrim(p_prof), '') <> '' AND CASE (SELECT public.cardiolink_ctx_rol_v1())
     WHEN 'owner' THEN true
     WHEN 'admin' THEN true
     WHEN 'medico' THEN p_prof = (SELECT public.cardiolink_ctx_prof_v1())
     WHEN 'secretaria' THEN p_uploaded_by IS NOT NULL AND p_uploaded_by = auth.uid() AND public.cardiolink_secretaria_autorizada_prof_v1(p_prof)
     ELSE false END,
   false)
$f$;

-- Archivo asignable a una fila nueva: ya existe en el bucket, lo subió quien inserta la fila hace menos de 1 hora (SECURITY DEFINER: "existe y es mío" no depende de lo que la RLS deje ver).
CREATE FUNCTION public.cardiolink_copia_facturacion_objeto_asignable_v1(p_path text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $f$
 SELECT coalesce(p_path, '') <> '' AND EXISTS (
   SELECT 1 FROM storage.objects o
    WHERE o.bucket_id = 'billing-copies' AND o.name = p_path AND o.owner = auth.uid() AND o.created_at > now() - interval '1 hour')
$f$;

-- "No existe NINGUNA fila" (ignora la RLS a propósito): permite al autor ver/limpiar su archivo recién subido que aún no tiene fila.
CREATE FUNCTION public.cardiolink_copia_facturacion_objeto_sin_fila_v1(p_name text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $f$
 SELECT NOT EXISTS (SELECT 1 FROM public.cardiolink_copias_facturacion c WHERE c.storage_path = p_name)
$f$;

-- Vínculo con la atención (sólo lo invoca el trigger; NO es ejecutable por los clientes). SECURITY DEFINER: "existe y corresponde" no depende de lo que la RLS deje ver al llamador.
--   'ok'                : la atención existe y es del MISMO paciente (pacienteId o, si no coincide, el mismo DNI) y del MISMO profesional.
--   'inexistente'       : no existe en cardiolink_atenciones (típico: todavía no sincronizada) -> el cliente ofrece cargar SIN atención vinculada.
--   'no_corresponde'    : existe pero es de otro paciente u otro profesional.
CREATE FUNCTION public.cardiolink_copia_facturacion_vinculo_v1(p_patient text, p_dni text, p_prof text, p_attention text)
 RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $f$
DECLARE a record; v_dni text := pg_catalog.regexp_replace(coalesce(p_dni, ''), '\D', '', 'g');
BEGIN
  SELECT x.payload INTO a FROM public.cardiolink_atenciones x
   WHERE x.id = p_attention AND coalesce(x.payload ->> 'tipoRegistro', '') NOT IN ('mensaje', 'config');
  IF NOT FOUND THEN RETURN 'inexistente'; END IF;
  IF a.payload ->> 'profesionalId' IS DISTINCT FROM p_prof THEN RETURN 'no_corresponde'; END IF;
  IF a.payload ->> 'pacienteId' = p_patient
     OR (v_dni <> '' AND pg_catalog.regexp_replace(coalesce(a.payload ->> 'dni', ''), '\D', '', 'g') = v_dni) THEN
    RETURN 'ok';
  END IF;
  RETURN 'no_corresponde';
END
$f$;
REVOKE ALL ON FUNCTION public.cardiolink_copia_facturacion_vinculo_v1(text, text, text, text) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.cardiolink_copia_facturacion_acceso_v1(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cardiolink_copia_facturacion_puede_eliminar_v1(text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cardiolink_copia_facturacion_objeto_asignable_v1(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cardiolink_copia_facturacion_objeto_sin_fila_v1(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cardiolink_copia_facturacion_acceso_v1(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cardiolink_copia_facturacion_puede_eliminar_v1(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cardiolink_copia_facturacion_objeto_asignable_v1(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cardiolink_copia_facturacion_objeto_sin_fila_v1(text) TO authenticated;

-- ===== 3) RLS de la tabla: anon sin nada; authenticated SELECT/INSERT/DELETE (sin UPDATE) =====
ALTER TABLE public.cardiolink_copias_facturacion ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.cardiolink_copias_facturacion FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.cardiolink_copias_facturacion TO authenticated;
GRANT ALL ON TABLE public.cardiolink_copias_facturacion TO service_role;

CREATE POLICY cardiolink_copias_fact_select ON public.cardiolink_copias_facturacion
  FOR SELECT TO authenticated
  USING (public.cardiolink_copia_facturacion_acceso_v1(professional_id));

CREATE POLICY cardiolink_copias_fact_insert ON public.cardiolink_copias_facturacion
  FOR INSERT TO authenticated
  WITH CHECK (public.cardiolink_copia_facturacion_acceso_v1(professional_id)
              AND public.cardiolink_copia_facturacion_objeto_asignable_v1(storage_path));

CREATE POLICY cardiolink_copias_fact_delete ON public.cardiolink_copias_facturacion
  FOR DELETE TO authenticated
  USING (public.cardiolink_copia_facturacion_puede_eliminar_v1(professional_id, uploaded_by));

-- ===== 4) Trigger: el servidor fija autor, fechas y estado inicial, valida el vínculo con la atención y vuelve inmutable la identidad de la copia =====
CREATE FUNCTION public.cardiolink_copias_facturacion_guard_v1()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $f$
DECLARE v_vinculo text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF auth.uid() IS NOT NULL THEN NEW.uploaded_by := auth.uid(); END IF;   -- el autor lo fija el servidor, no el navegador
    NEW.created_at := now();
    NEW.updated_at := now();
    NEW.print_status := 'pendiente';                                        -- toda copia nace sin imprimir
    NEW.print_count := 0;
    NEW.printed_at := NULL;
    NEW.printed_by := NULL;
    NEW.patient_id := btrim(NEW.patient_id);
    NEW.professional_id := btrim(NEW.professional_id);
    NEW.attention_id := nullif(btrim(coalesce(NEW.attention_id, '')), '');
    IF NEW.attention_id IS NOT NULL THEN        -- si hay atención vinculada debe corresponder al paciente y al profesional; si no, se carga explícitamente SIN vincular (attention_id NULL)
      v_vinculo := public.cardiolink_copia_facturacion_vinculo_v1(NEW.patient_id, NEW.patient_dni, NEW.professional_id, NEW.attention_id);
      IF v_vinculo = 'inexistente' THEN
        RAISE EXCEPTION 'La atención vinculada no existe en el servidor (puede no estar sincronizada todavía): cargá la copia sin vincular a la atención' USING ERRCODE = 'CF001';
      ELSIF v_vinculo <> 'ok' THEN
        RAISE EXCEPTION 'La atención vinculada no corresponde al paciente o al profesional de la copia' USING ERRCODE = 'CF002';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE (sólo posible vía la RPC o service_role): únicamente el estado de impresión y updated_at pueden cambiar.
  IF to_jsonb(NEW) - ARRAY['print_status', 'print_count', 'printed_at', 'printed_by', 'updated_at']
     IS DISTINCT FROM to_jsonb(OLD) - ARRAY['print_status', 'print_count', 'printed_at', 'printed_by', 'updated_at'] THEN
    RAISE EXCEPTION 'La identidad de una copia para facturación (paciente, profesional, archivo, autor) no se modifica' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$f$;
REVOKE ALL ON FUNCTION public.cardiolink_copias_facturacion_guard_v1() FROM PUBLIC, anon, authenticated;   -- sólo la ejecuta el trigger

CREATE TRIGGER cardiolink_copias_facturacion_guard_v1
  BEFORE INSERT OR UPDATE ON public.cardiolink_copias_facturacion
  FOR EACH ROW EXECUTE FUNCTION public.cardiolink_copias_facturacion_guard_v1();

-- ===== 5) RPC de impresión (SECURITY DEFINER: authenticated no tiene UPDATE; la autorización se valida acá) =====
--   'marcar_impreso' : pendiente -> impreso (print_count >= 1). Idempotente: si ya estaba impresa no cambia nada.
--   'reimprimir'     : registra una impresión más (print_count + 1, printed_at/printed_by = ahora/quien); si estaba pendiente pasa a impreso.
CREATE FUNCTION public.cardiolink_copia_facturacion_impresion_v1(p_id uuid, p_accion text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $f$
DECLARE v public.cardiolink_copias_facturacion%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sin sesión' USING ERRCODE = '42501'; END IF;
  IF p_id IS NULL OR p_accion IS NULL OR p_accion NOT IN ('marcar_impreso', 'reimprimir') THEN
    RAISE EXCEPTION 'Parámetros inválidos' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v FROM public.cardiolink_copias_facturacion WHERE id = p_id;
  -- mismo error si no existe o no corresponde: no revela la existencia de copias ajenas
  IF NOT FOUND OR NOT public.cardiolink_copia_facturacion_acceso_v1(v.professional_id) THEN
    RAISE EXCEPTION 'Copia inexistente o sin permiso' USING ERRCODE = '42501'; END IF;
  IF p_accion = 'marcar_impreso' THEN
    UPDATE public.cardiolink_copias_facturacion
       SET print_status = 'impreso', print_count = greatest(print_count, 1), printed_at = now(), printed_by = auth.uid(), updated_at = now()
     WHERE id = p_id AND print_status = 'pendiente';
  ELSE
    UPDATE public.cardiolink_copias_facturacion
       SET print_status = 'impreso', print_count = print_count + 1, printed_at = now(), printed_by = auth.uid(), updated_at = now()
     WHERE id = p_id;
  END IF;
  SELECT * INTO v FROM public.cardiolink_copias_facturacion WHERE id = p_id;
  RETURN jsonb_build_object('ok', true, 'id', v.id, 'print_status', v.print_status, 'print_count', v.print_count, 'printed_at', v.printed_at);
END
$f$;
REVOKE ALL ON FUNCTION public.cardiolink_copia_facturacion_impresion_v1(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cardiolink_copia_facturacion_impresion_v1(uuid, text) TO authenticated;

-- ===== 6) Bucket PRIVADO propio + políticas de Storage acotadas a ese bucket =====
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('billing-copies', 'billing-copies', false, 10485760, ARRAY['application/pdf']);   -- 10 MB, sólo PDF; NUNCA público: se abre con descarga autenticada

-- SELECT: el archivo de una fila VISIBLE para quien consulta (hereda la RLS de la tabla) o el propio recién subido sin fila (1 h).
CREATE POLICY cardiolink_copias_fact_storage_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'billing-copies'
    AND (
      EXISTS (SELECT 1 FROM public.cardiolink_copias_facturacion c WHERE c.storage_path = objects.name)
      OR (objects.owner = auth.uid() AND objects.created_at > now() - interval '1 hour'
          AND public.cardiolink_copia_facturacion_objeto_sin_fila_v1(objects.name))
    )
  );

-- INSERT: cualquier rol activo con acceso al módulo; la ruta debe ser "{uuid}.pdf" (sin carpetas ni nombres elegidos por el cliente).
CREATE POLICY cardiolink_copias_fact_storage_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'billing-copies'
    AND (SELECT public.cardiolink_ctx_rol_v1()) IN ('owner', 'admin', 'medico', 'secretaria')
    AND objects.name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$'
  );

-- DELETE: el archivo de una fila que quien consulta puede eliminar, o su propio archivo huérfano (limpieza si falló el alta de la fila). Sin política de UPDATE: no se reemplaza un archivo.
CREATE POLICY cardiolink_copias_fact_storage_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'billing-copies'
    AND (
      EXISTS (SELECT 1 FROM public.cardiolink_copias_facturacion c
               WHERE c.storage_path = objects.name AND public.cardiolink_copia_facturacion_puede_eliminar_v1(c.professional_id, c.uploaded_by))
      OR (objects.owner = auth.uid() AND public.cardiolink_copia_facturacion_objeto_sin_fila_v1(objects.name))
    )
  );

-- ===== 7) Postcondiciones =====
DO $$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.cardiolink_copias_facturacion'::regclass) THEN RAISE EXCEPTION 'FALLA: RLS apagada en cardiolink_copias_facturacion'; END IF;
  IF has_table_privilege('anon', 'public.cardiolink_copias_facturacion', 'SELECT') OR has_table_privilege('anon', 'public.cardiolink_copias_facturacion', 'INSERT')
     OR has_table_privilege('authenticated', 'public.cardiolink_copias_facturacion', 'UPDATE') THEN
    RAISE EXCEPTION 'FALLA: anon no debe tocar la tabla y authenticated no debe tener UPDATE'; END IF;
  IF NOT has_table_privilege('authenticated', 'public.cardiolink_copias_facturacion', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.cardiolink_copias_facturacion', 'INSERT')
     OR NOT has_table_privilege('authenticated', 'public.cardiolink_copias_facturacion', 'DELETE') THEN
    RAISE EXCEPTION 'FALLA: authenticated debe tener SELECT/INSERT/DELETE (la RLS decide)'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'cardiolink_copias_facturacion' AND permissive = 'PERMISSIVE') <> 3
     OR (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname LIKE 'cardiolink_copias_fact\_storage\_%' ESCAPE '\') <> 3 THEN
    RAISE EXCEPTION 'FALLA: no quedaron las 3 políticas de tabla y las 3 de Storage'; END IF;
  IF has_function_privilege('anon', 'public.cardiolink_copia_facturacion_acceso_v1(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.cardiolink_copia_facturacion_puede_eliminar_v1(text,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.cardiolink_copia_facturacion_objeto_asignable_v1(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.cardiolink_copia_facturacion_objeto_sin_fila_v1(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.cardiolink_copia_facturacion_impresion_v1(uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.cardiolink_copias_facturacion_guard_v1()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.cardiolink_copia_facturacion_vinculo_v1(text,text,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.cardiolink_copia_facturacion_vinculo_v1(text,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FALLA: privilegios de ejecución inesperados'; END IF;
  IF NOT has_function_privilege('authenticated', 'public.cardiolink_copia_facturacion_impresion_v1(uuid,text)', 'EXECUTE') THEN RAISE EXCEPTION 'FALLA: authenticated debe poder llamar la RPC de impresión'; END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'billing-copies' AND NOT public AND file_size_limit = 10485760 AND allowed_mime_types = ARRAY['application/pdf']) THEN
    RAISE EXCEPTION 'FALLA: el bucket billing-copies debe existir, ser privado y sólo PDF'; END IF;
  IF public.cardiolink_copia_facturacion_acceso_v1('cualquiera') IS NOT FALSE OR public.cardiolink_copia_facturacion_puede_eliminar_v1('cualquiera', NULL) IS NOT FALSE
     OR public.cardiolink_copia_facturacion_objeto_asignable_v1('x.pdf') IS NOT FALSE THEN
    RAISE EXCEPTION 'FALLA: sin sesión las funciones de acceso deben dar false'; END IF;
END $$;

COMMIT;
