-- CardioLink · FACTURACIÓN MENSUAL V1 · BLOQUE 1 · PRESENTACIONES A OBRAS SOCIALES · tablas + autorización + RPC de confirmación
-- *** SQL PROPUESTO · Aplicado y verificado en STAGING (22/11/2026: ensayo reversible, concurrencia de 2 sesiones y QA real). NO aplicado en Production. ***
-- NO EJECUTAR en Production sin autorización explícita ni checks previos de solo lectura (ver ..._checks.sql). Esta versión ya incluye el cierre de incidencias (médico lee el control; PR412); una base que tenga la versión previa se actualiza con ..._delta_incidencias.sql.
-- No está en supabase/migrations a propósito: `supabase db push` no debe poder aplicarla por accidente (la CLI de este equipo apunta a Production).
-- Una sola transacción, ADITIVO: crea objetos NUEVOS y NO modifica ninguna tabla, función, política ni dato existente (ni cardiolink_atenciones, ni su sincronización, ni finance_expenses, ni copias_facturacion).
-- Falla (y revierte todo) si el estado de la base no es el esperado. Rollback: pending_review_facturacion_presentaciones_v1_rollback.sql. Verificaciones de solo lectura: ..._checks.sql
--
-- QUÉ GUARDA. Qué prestaciones se PRESENTARON a cada cobertura, cuándo, quién y por qué importe. Nada más.
--   * cardiolink_presentaciones_os_control_v1 : UNA fila: desde qué fecha arranca la lista AUTOMÁTICA de presentaciones (01/12/2026). Lo anterior NO se da por facturado: no se ofrece solo,
--                                               pero puede incorporarse como EXCEPCIÓN (p. ej. bonos pendientes de presentación), con su fecha original de producción y un motivo.
--   * cardiolink_presentaciones_os_v1         : cabecera de cada presentación (una por cobertura + profesional + confirmación): período, cantidad, total, fecha, usuario.
--   * cardiolink_presentaciones_os_items_v1   : cada prestación presentada, identificada por el ID ESTABLE de su atención (`atencion_id` = id de la fila de cardiolink_atenciones), con
--                                               una COPIA de su fecha (la fecha de producción no se toca) y del importe presentado. UNIQUE(atencion_id): una prestación se presenta UNA sola vez.
--                                               `excepcional` + `motivo_excepcion`: marcan las anteriores al inicio del control (las fija el servidor comparando la fecha de la atención con el control).
-- SEGURIDAD
--   * authenticated SOLO LEE (RLS por profesional). Toda escritura pasa por RPC SECURITY DEFINER que valida el permiso, revalida cada ítem contra la atención y FIJA usuario, rol y fecha desde la sesión (JWT).
--   * Ver: owner/admin todo; médico lo de SU professional_id (cardiolink_ctx_prof_v1); Secretaría lo de profesionales con ASOCIACIÓN ACTIVA (cardiolink_secretaria_autorizada_prof_v1).
--   * Confirmar: owner/admin; Secretaría solo profesionales asociados; médico NUNCA. Definir la fecha de control: solo owner/admin.
--   * Sin datos clínicos: cobertura, prestación, fecha, importe, id y nombre del paciente (administrativo). Sin diagnósticos, HC ni documentos.
--   * Sin sesión / anon / sin rol activo: nada.
-- NO HAY anulación ni edición de una presentación en este bloque (no se alteran históricos). Si hiciera falta: bloque posterior (columna anulada_en + índice único parcial).

BEGIN;

-- ===== 0) Precondiciones =====
DO $$
BEGIN
  IF to_regclass('public.cardiolink_atenciones') IS NULL THEN RAISE EXCEPTION 'Precondición: falta public.cardiolink_atenciones'; END IF;
  IF to_regprocedure('public.cardiolink_ctx_rol_v1()') IS NULL OR to_regprocedure('public.cardiolink_ctx_prof_v1()') IS NULL THEN
    RAISE EXCEPTION 'Precondición: faltan cardiolink_ctx_rol_v1() / cardiolink_ctx_prof_v1() (Seguridad clínica V1)'; END IF;
  IF to_regprocedure('public.cardiolink_secretaria_autorizada_prof_v1(text)') IS NULL THEN
    RAISE EXCEPTION 'Precondición: falta cardiolink_secretaria_autorizada_prof_v1(text) (asociaciones activas)'; END IF;
  IF NOT has_function_privilege('authenticated', 'public.cardiolink_ctx_rol_v1()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.cardiolink_ctx_prof_v1()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.cardiolink_secretaria_autorizada_prof_v1(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Precondición: authenticated debe poder ejecutar las funciones de contexto y de asociación (las evalúan las políticas)'; END IF;
  IF to_regclass('public.cardiolink_presentaciones_os_v1') IS NOT NULL
     OR to_regclass('public.cardiolink_presentaciones_os_items_v1') IS NOT NULL
     OR to_regclass('public.cardiolink_presentaciones_os_control_v1') IS NOT NULL
     OR to_regprocedure('public.cardiolink_presentacion_os_ver_v1(text)') IS NOT NULL
     OR to_regprocedure('public.cardiolink_presentacion_os_confirmar_permitido_v1(text)') IS NOT NULL
     OR to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb)') IS NOT NULL
     OR to_regprocedure('public.cardiolink_presentacion_os_control_v1(date)') IS NOT NULL THEN
    RAISE EXCEPTION 'Presentaciones a obras sociales V1 ya está aplicado (o parcialmente): no se repite'; END IF;
END $$;

-- ===== 1) Tablas =====
CREATE TABLE public.cardiolink_presentaciones_os_control_v1 (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),                       -- una sola fila
  fecha_inicio date NOT NULL,
  actualizado_por uuid NOT NULL,
  actualizado_en timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.cardiolink_presentaciones_os_v1 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cobertura text NOT NULL CHECK (btrim(cobertura) <> ''),
  professional_id text NOT NULL CHECK (btrim(professional_id) <> ''),
  periodo text NOT NULL CHECK (periodo ~ '^\d{4}-(0[1-9]|1[0-2])$'),                         -- mes en que se presenta (AAAA-MM)
  cantidad integer NOT NULL CHECK (cantidad > 0),
  total_importe numeric(14,2) NOT NULL CHECK (total_importe > 0),
  presentado_en timestamptz NOT NULL DEFAULT now(),
  presentado_por uuid NOT NULL,
  presentado_por_email text NOT NULL,
  presentado_por_rol text NOT NULL CHECK (presentado_por_rol IN ('owner', 'admin', 'secretaria'))
);
CREATE INDEX cardiolink_presentaciones_os_prof_idx ON public.cardiolink_presentaciones_os_v1 (professional_id, periodo DESC);

CREATE TABLE public.cardiolink_presentaciones_os_items_v1 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  presentacion_id uuid NOT NULL REFERENCES public.cardiolink_presentaciones_os_v1 (id) ON DELETE RESTRICT,
  atencion_id text NOT NULL CHECK (btrim(atencion_id) <> ''),
  professional_id text NOT NULL CHECK (btrim(professional_id) <> ''),
  cobertura text NOT NULL CHECK (btrim(cobertura) <> ''),
  prestacion text NOT NULL CHECK (btrim(prestacion) <> ''),
  fecha_atencion date NOT NULL,                                                                -- COPIA de la fecha de producción (la atención no se modifica)
  importe_presentado numeric(14,2) NOT NULL CHECK (importe_presentado > 0),
  arancel_id text NULL,
  patient_id text NULL,
  patient_name text NULL,
  excepcional boolean NOT NULL DEFAULT false,                                                  -- true = anterior al inicio del control, incorporada a mano (la fija el servidor)
  motivo_excepcion text NULL,
  creado_en timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cardiolink_presentaciones_os_items_excepcion_ck CHECK (excepcional = (motivo_excepcion IS NOT NULL AND btrim(motivo_excepcion) <> ''))
);
-- CLAVE ANTI-DUPLICADOS: una prestación (ID estable de la atención) se presenta UNA sola vez, también entre dos sesiones simultáneas.
CREATE UNIQUE INDEX cardiolink_presentaciones_os_items_atencion_uq ON public.cardiolink_presentaciones_os_items_v1 (atencion_id);
CREATE INDEX cardiolink_presentaciones_os_items_pres_idx ON public.cardiolink_presentaciones_os_items_v1 (presentacion_id);
CREATE INDEX cardiolink_presentaciones_os_items_prof_idx ON public.cardiolink_presentaciones_os_items_v1 (professional_id, fecha_atencion);

-- Fecha de inicio del control aprobada por el Dueño: 01/12/2026. (actualizado_por = uuid nulo: la fila la siembra esta migración, no una persona; el Dueño/Administrador puede cambiarla desde la pantalla.)
INSERT INTO public.cardiolink_presentaciones_os_control_v1 (id, fecha_inicio, actualizado_por) VALUES (true, DATE '2026-12-01', '00000000-0000-0000-0000-000000000000');

COMMENT ON TABLE public.cardiolink_presentaciones_os_v1 IS
  'Presentaciones a obras sociales V1: cabecera por cobertura + profesional + confirmación. Solo lectura para authenticated; se escribe por cardiolink_presentacion_os_confirmar_v1 (usuario, rol y fecha fijados por el servidor).';
COMMENT ON TABLE public.cardiolink_presentaciones_os_items_v1 IS
  'Prestaciones presentadas (ID estable = id de la fila de cardiolink_atenciones). UNIQUE(atencion_id): una sola presentación por prestación. fecha_atencion es copia: la producción no se modifica.';

-- ===== 2) Autorización (una sola fuente de verdad, reutilizada por las políticas y la RPC) =====
CREATE FUNCTION public.cardiolink_presentacion_os_ver_v1(p_prof text)
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

CREATE FUNCTION public.cardiolink_presentacion_os_confirmar_permitido_v1(p_prof text)
 RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public
AS $f$
 SELECT coalesce(
   coalesce(btrim(p_prof), '') <> '' AND CASE (SELECT public.cardiolink_ctx_rol_v1())
     WHEN 'owner' THEN true
     WHEN 'admin' THEN true
     WHEN 'secretaria' THEN public.cardiolink_secretaria_autorizada_prof_v1(p_prof)
     ELSE false END,                                                                            -- el médico NUNCA confirma
   false)
$f$;
REVOKE ALL ON FUNCTION public.cardiolink_presentacion_os_ver_v1(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cardiolink_presentacion_os_confirmar_permitido_v1(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cardiolink_presentacion_os_ver_v1(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cardiolink_presentacion_os_confirmar_permitido_v1(text) TO authenticated;

-- ===== 3) RLS: anon sin nada; authenticated SOLO SELECT =====
ALTER TABLE public.cardiolink_presentaciones_os_control_v1 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cardiolink_presentaciones_os_v1 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cardiolink_presentaciones_os_items_v1 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.cardiolink_presentaciones_os_control_v1, public.cardiolink_presentaciones_os_v1, public.cardiolink_presentaciones_os_items_v1 FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.cardiolink_presentaciones_os_control_v1 TO authenticated;
GRANT SELECT ON TABLE public.cardiolink_presentaciones_os_v1 TO authenticated;
GRANT SELECT ON TABLE public.cardiolink_presentaciones_os_items_v1 TO authenticated;
GRANT ALL ON TABLE public.cardiolink_presentaciones_os_control_v1, public.cardiolink_presentaciones_os_v1, public.cardiolink_presentaciones_os_items_v1 TO service_role;

CREATE POLICY cardiolink_presentaciones_os_control_select ON public.cardiolink_presentaciones_os_control_v1
  FOR SELECT TO authenticated USING ((SELECT public.cardiolink_ctx_rol_v1()) IN ('owner', 'admin', 'secretaria', 'medico'));   -- el médico LEE la fecha de control (no la escribe: sólo la RPC de owner/admin)
CREATE POLICY cardiolink_presentaciones_os_select ON public.cardiolink_presentaciones_os_v1
  FOR SELECT TO authenticated USING (public.cardiolink_presentacion_os_ver_v1(professional_id));
CREATE POLICY cardiolink_presentaciones_os_items_select ON public.cardiolink_presentaciones_os_items_v1
  FOR SELECT TO authenticated USING (public.cardiolink_presentacion_os_ver_v1(professional_id));

-- ===== 4) RPC: fecha de inicio del control (solo owner/admin) =====
CREATE FUNCTION public.cardiolink_presentacion_os_control_v1(p_fecha date)
 RETURNS date LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $f$
BEGIN
  IF auth.uid() IS NULL OR (SELECT public.cardiolink_ctx_rol_v1()) NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'PR403: solo el Dueño o un Administrador define la fecha de control' USING ERRCODE = '42501'; END IF;
  IF p_fecha IS NULL OR p_fecha < DATE '2020-01-01' OR p_fecha > (current_date + 366) THEN
    RAISE EXCEPTION 'PR400: fecha de control inválida' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.cardiolink_presentaciones_os_control_v1 (id, fecha_inicio, actualizado_por, actualizado_en)
  VALUES (true, p_fecha, auth.uid(), now())
  ON CONFLICT (id) DO UPDATE SET fecha_inicio = EXCLUDED.fecha_inicio, actualizado_por = EXCLUDED.actualizado_por, actualizado_en = EXCLUDED.actualizado_en;
  RETURN p_fecha;
END
$f$;
REVOKE ALL ON FUNCTION public.cardiolink_presentacion_os_control_v1(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cardiolink_presentacion_os_control_v1(date) TO authenticated;

-- ===== 5) RPC: confirmar presentación (TODO O NADA) =====
-- p_lotes = [ { cobertura, professional_id, items: [ { atencion_id, fecha_atencion, cobertura, prestacion, importe_presentado, arancel_id?, patient_id?, patient_name?, excepcional?, motivo_excepcion? } ] } ]
-- El cliente NO envía totales, usuario, rol ni fecha: el servidor los fija. Cada ítem se revalida contra la atención real. Un ítem ya presentado (índice único) revierte TODA la confirmación (23505).
CREATE FUNCTION public.cardiolink_presentacion_os_confirmar_v1(p_periodo text, p_lotes jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $f$
DECLARE
  v_uid uuid := auth.uid();
  v_rol text := (SELECT public.cardiolink_ctx_rol_v1());
  v_email text := coalesce(nullif(auth.jwt() ->> 'email', ''), '');
  v_ctrl date; v_fin date;
  v_lote jsonb; v_item jsonb; v_pl jsonb; v_pres uuid;
  v_prof text; v_cob text; v_n int; v_total numeric; v_f date; v_importe numeric; v_cob_item text; v_exc boolean; v_motivo text; v_val numeric; v_arancel_id text;
  v_ids jsonb := '[]'::jsonb; v_items int := 0; v_suma numeric := 0;
BEGIN
  IF v_uid IS NULL OR v_rol IS NULL OR v_rol NOT IN ('owner', 'admin', 'secretaria') THEN
    RAISE EXCEPTION 'PR403: sin permiso para presentar' USING ERRCODE = '42501'; END IF;
  IF p_periodo IS NULL OR p_periodo !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN RAISE EXCEPTION 'PR400: período inválido' USING ERRCODE = '22023'; END IF;
  IF p_lotes IS NULL OR jsonb_typeof(p_lotes) <> 'array' OR jsonb_array_length(p_lotes) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'PR400: lotes inválidos' USING ERRCODE = '22023'; END IF;
  SELECT fecha_inicio INTO v_ctrl FROM public.cardiolink_presentaciones_os_control_v1 WHERE id;
  IF v_ctrl IS NULL THEN RAISE EXCEPTION 'PR010: falta definir la fecha de inicio del control de presentaciones' USING ERRCODE = 'P0001'; END IF;
  v_fin := (to_date(p_periodo || '-01', 'YYYY-MM-DD') + interval '1 month - 1 day')::date;

  FOR v_lote IN SELECT value FROM jsonb_array_elements(p_lotes) LOOP
    v_prof := btrim(coalesce(v_lote ->> 'professional_id', ''));
    v_cob := btrim(coalesce(v_lote ->> 'cobertura', ''));
    IF v_prof = '' OR v_cob = '' OR jsonb_typeof(v_lote -> 'items') <> 'array' OR jsonb_array_length(v_lote -> 'items') NOT BETWEEN 1 AND 2000 THEN
      RAISE EXCEPTION 'PR400: lote inválido' USING ERRCODE = '22023'; END IF;
    IF NOT public.cardiolink_presentacion_os_confirmar_permitido_v1(v_prof) THEN
      RAISE EXCEPTION 'PR403: sin permiso para presentar prestaciones de este profesional' USING ERRCODE = '42501'; END IF;
    SELECT count(*), coalesce(sum(round((e ->> 'importe_presentado')::numeric, 2)), 0) INTO v_n, v_total FROM jsonb_array_elements(v_lote -> 'items') e;
    IF v_total <= 0 THEN RAISE EXCEPTION 'PR400: importe inválido' USING ERRCODE = '22023'; END IF;

    INSERT INTO public.cardiolink_presentaciones_os_v1 (cobertura, professional_id, periodo, cantidad, total_importe, presentado_por, presentado_por_email, presentado_por_rol)
    VALUES (v_cob, v_prof, p_periodo, v_n, v_total, v_uid, v_email, v_rol) RETURNING id INTO v_pres;

    FOR v_item IN SELECT value FROM jsonb_array_elements(v_lote -> 'items') LOOP
      SELECT payload INTO v_pl FROM public.cardiolink_atenciones WHERE id = btrim(coalesce(v_item ->> 'atencion_id', '')) AND id <> '__cardiolink_config_v1';
      IF v_pl IS NULL THEN RAISE EXCEPTION 'PR404: la atención no existe' USING ERRCODE = 'P0002'; END IF;
      v_f := (v_item ->> 'fecha_atencion')::date;
      v_importe := round((v_item ->> 'importe_presentado')::numeric, 2);
      v_cob_item := lower(btrim(coalesce(v_item ->> 'cobertura', '')));
      IF coalesce(nullif(v_pl ->> 'profesionalId', ''), nullif(v_pl ->> 'cajaPerfil', ''), 'matias') <> v_prof THEN
        RAISE EXCEPTION 'PR409: el profesional no coincide con la atención' USING ERRCODE = 'P0001'; END IF;
      IF v_cob_item IN ('', 'particular', 'pami')
         OR lower(btrim(coalesce(nullif(v_pl ->> 'obraSocial', ''), v_pl ->> 'coberturaAtencion', ''))) <> v_cob_item THEN
        RAISE EXCEPTION 'PR409: la cobertura no coincide con la atención o no es facturable' USING ERRCODE = 'P0001'; END IF;
      IF left(coalesce(v_pl ->> 'fecha', ''), 10) <> to_char(v_f, 'YYYY-MM-DD') THEN
        RAISE EXCEPTION 'PR409: la fecha no coincide con la atención' USING ERRCODE = 'P0001'; END IF;
      IF v_f > v_fin THEN RAISE EXCEPTION 'PR409: la prestación es posterior al período de presentación' USING ERRCODE = 'P0001'; END IF;
      -- Anterior al inicio del control (01/12/2026): NO se da por presentada ni por facturada, pero solo entra como EXCEPCIÓN explícita y con motivo (p. ej. bono pendiente). El servidor decide si es excepcional.
      v_exc := v_f < v_ctrl;
      v_motivo := nullif(btrim(coalesce(v_item ->> 'motivo_excepcion', '')), '');
      IF v_exc AND (coalesce(v_item ->> 'excepcional', '') <> 'true' OR v_motivo IS NULL) THEN
        RAISE EXCEPTION 'PR411: una prestación anterior al inicio del control solo se presenta como excepción, con motivo' USING ERRCODE = 'P0001'; END IF;
      IF NOT v_exc THEN v_motivo := NULL; END IF;
      IF lower(coalesce(v_pl ->> 'estadoTurno', v_pl ->> 'estado', '')) IN ('ausente', 'cancelado') THEN
        RAISE EXCEPTION 'PR409: la atención no fue realizada' USING ERRCODE = 'P0001'; END IF;
      IF v_importe <= 0 THEN RAISE EXCEPTION 'PR400: importe inválido' USING ERRCODE = '22023'; END IF;
      -- El arancel debe estar FIJADO en la atención (arancelId + valorArancelEstimado > 0, el mismo criterio de «fijado» de la app) y el importe presentado debe ser exactamente ese.
      -- Sin arancel válido fijado NO se confirma (PR412): el importe nunca lo define el cliente. (Un CASE ... THEN dentro de un IF ... THEN rompe el parser de plpgsql: se calcula en una asignación.)
      v_val := CASE WHEN (v_pl ->> 'valorArancelEstimado') ~ '^\d+(\.\d+)?$' THEN (v_pl ->> 'valorArancelEstimado')::numeric ELSE NULL END;                -- CASE: el cast solo se evalúa si el texto es numérico
      v_arancel_id := coalesce(btrim(v_pl ->> 'arancelId'), '');
      IF v_arancel_id = '' OR v_val IS NULL OR v_val <= 0 THEN
        RAISE EXCEPTION 'PR412: la prestación no tiene un arancel válido fijado: no se puede presentar' USING ERRCODE = 'P0001'; END IF;
      IF abs(v_val - v_importe) > 0.01 THEN RAISE EXCEPTION 'PR409: el importe no coincide con el arancel fijado en la atención' USING ERRCODE = 'P0001'; END IF;

      INSERT INTO public.cardiolink_presentaciones_os_items_v1 (presentacion_id, atencion_id, professional_id, cobertura, prestacion, fecha_atencion, importe_presentado, arancel_id, patient_id, patient_name, excepcional, motivo_excepcion)
      VALUES (v_pres, btrim(v_item ->> 'atencion_id'), v_prof, btrim(v_item ->> 'cobertura'), btrim(coalesce(nullif(v_item ->> 'prestacion', ''), v_pl ->> 'prestacion', 'Prestación')), v_f, v_importe,
              v_arancel_id, nullif(btrim(coalesce(v_item ->> 'patient_id', '')), ''), nullif(btrim(coalesce(v_item ->> 'patient_name', '')), ''), v_exc, v_motivo);
      -- (un atencion_id ya presentado dispara unique_violation 23505 y revierte TODA la confirmación)
    END LOOP;
    v_ids := v_ids || to_jsonb(v_pres); v_items := v_items + v_n; v_suma := v_suma + v_total;
  END LOOP;
  RETURN jsonb_build_object('presentaciones', v_ids, 'items', v_items, 'total', v_suma);
END
$f$;
REVOKE ALL ON FUNCTION public.cardiolink_presentacion_os_confirmar_v1(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cardiolink_presentacion_os_confirmar_v1(text, jsonb) TO authenticated;

-- ===== 6) Postcondiciones =====
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE oid IN ('public.cardiolink_presentaciones_os_control_v1'::regclass, 'public.cardiolink_presentaciones_os_v1'::regclass, 'public.cardiolink_presentaciones_os_items_v1'::regclass) AND NOT relrowsecurity) THEN
    RAISE EXCEPTION 'FALLA: RLS apagada en alguna tabla de presentaciones'; END IF;
  IF has_table_privilege('anon', 'public.cardiolink_presentaciones_os_v1', 'SELECT') OR has_table_privilege('anon', 'public.cardiolink_presentaciones_os_items_v1', 'SELECT')
     OR has_table_privilege('authenticated', 'public.cardiolink_presentaciones_os_v1', 'INSERT') OR has_table_privilege('authenticated', 'public.cardiolink_presentaciones_os_v1', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.cardiolink_presentaciones_os_v1', 'DELETE')
     OR has_table_privilege('authenticated', 'public.cardiolink_presentaciones_os_items_v1', 'INSERT') OR has_table_privilege('authenticated', 'public.cardiolink_presentaciones_os_items_v1', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.cardiolink_presentaciones_os_items_v1', 'DELETE')
     OR has_table_privilege('authenticated', 'public.cardiolink_presentaciones_os_control_v1', 'INSERT') OR has_table_privilege('authenticated', 'public.cardiolink_presentaciones_os_control_v1', 'UPDATE') THEN
    RAISE EXCEPTION 'FALLA: anon no debe tocar nada y authenticated solo puede SELECT'; END IF;
  IF NOT has_table_privilege('authenticated', 'public.cardiolink_presentaciones_os_v1', 'SELECT') OR NOT has_table_privilege('authenticated', 'public.cardiolink_presentaciones_os_items_v1', 'SELECT') THEN
    RAISE EXCEPTION 'FALLA: authenticated debe poder SELECT (la RLS decide)'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename LIKE 'cardiolink\_presentaciones\_os%' ESCAPE '\' AND permissive = 'PERMISSIVE') <> 3 THEN
    RAISE EXCEPTION 'FALLA: deben quedar exactamente 3 políticas SELECT'; END IF;
  IF has_function_privilege('anon', 'public.cardiolink_presentacion_os_confirmar_v1(text,jsonb)', 'EXECUTE') OR has_function_privilege('anon', 'public.cardiolink_presentacion_os_control_v1(date)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.cardiolink_presentacion_os_ver_v1(text)', 'EXECUTE') OR has_function_privilege('anon', 'public.cardiolink_presentacion_os_confirmar_permitido_v1(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FALLA: anon no debe ejecutar ninguna función'; END IF;
  IF NOT has_function_privilege('authenticated', 'public.cardiolink_presentacion_os_confirmar_v1(text,jsonb)', 'EXECUTE') THEN RAISE EXCEPTION 'FALLA: authenticated debe poder llamar la RPC de confirmación'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'cardiolink_presentaciones_os_items_atencion_uq' AND indexdef ILIKE '%UNIQUE%(atencion_id)%') THEN
    RAISE EXCEPTION 'FALLA: falta el índice único por atención (anti-duplicados)'; END IF;
  IF (SELECT fecha_inicio FROM public.cardiolink_presentaciones_os_control_v1 WHERE id) IS DISTINCT FROM DATE '2026-12-01' THEN
    RAISE EXCEPTION 'FALLA: la fecha de inicio del control debe quedar en 2026-12-01'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cardiolink_presentaciones_os_items_excepcion_ck') THEN
    RAISE EXCEPTION 'FALLA: falta la restricción de excepciones (marca + motivo)'; END IF;
  IF public.cardiolink_presentacion_os_ver_v1('cualquiera') IS NOT FALSE OR public.cardiolink_presentacion_os_confirmar_permitido_v1('cualquiera') IS NOT FALSE THEN
    RAISE EXCEPTION 'FALLA: sin sesión las funciones de acceso deben dar false'; END IF;
END $$;

COMMIT;
