-- CardioLink · Facturación mensual V1 · APLICACIÓN ATÓMICA · ENSAYO REVERSIBLE (STAGING). GENERADO por pending_review_facturacion_presentaciones_v1_atomico_generar.sh: no editar a mano.
-- NO ejecutar en Production. Sin BEGIN/COMMIT: se corre en UNA transacción y termina SIEMPRE con una EXCEPTION que revierte todo (incluidos los DROP del paso 1).
-- STAGING ya tiene base + complemento: el paso 1 los deshace DENTRO de la transacción para dejar la base como Production (sin objetos de Presentaciones); el paso 2 aplica el archivo ATÓMICO; el paso 3 corre las pruebas del complemento sobre el resultado.
-- RESULTADO ESPERADO: error final "ENSAYO_ATOMICO_OK: N pruebas ..." (señal de éxito + rollback). Cualquier "FALLA ..." indica qué no pasó.
-- ===== PASO 1: dejar la base sin objetos de Presentaciones (rollback del complemento y del base, ambos sin BEGIN/COMMIT) =====
-- CardioLink · FACTURACIÓN MENSUAL V1 · COMPLEMENTO TERCEROS · ROLLBACK de pending_review_facturacion_presentaciones_v1_terceros.sql
-- *** Ensayado en el ensayo reversible y en un PostgreSQL local simulado. NO ejecutado en STAGING ni Production. ***  Vuelve el bloque al estado del bloque base (con PR412): RPC anterior, política de ítems anterior, sin delegaciones.
-- ATENCIÓN: borra las 3 columnas de trazabilidad (quién realizó, quién factura, texto de destino) de las presentaciones ya registradas. Si ya hay presentaciones de terceros, exportar antes pending_review_..._terceros_checks.sql (sección 4) y
-- la tabla de ítems, y confirmar con el Dueño. Lo presentado por un facturante distinto de quien realizó queda presentado (el índice único por atención no se toca): no se vuelve a ofrecer.
DROP POLICY cardiolink_presentaciones_os_items_select ON public.cardiolink_presentaciones_os_items_v1;
CREATE POLICY cardiolink_presentaciones_os_items_select ON public.cardiolink_presentaciones_os_items_v1
  FOR SELECT TO authenticated USING (public.cardiolink_presentacion_os_ver_v1(professional_id));
DROP INDEX IF EXISTS public.cardiolink_presentaciones_os_items_realizado_idx;
ALTER TABLE public.cardiolink_presentaciones_os_items_v1 DROP CONSTRAINT IF EXISTS cardiolink_presentaciones_os_items_facturante_ck;
ALTER TABLE public.cardiolink_presentaciones_os_items_v1 DROP COLUMN IF EXISTS realizado_por_professional_id, DROP COLUMN IF EXISTS facturante_professional_id, DROP COLUMN IF EXISTS destino_texto;
-- RPC del bloque base (idéntica a la del SQL base, con PR412)
CREATE OR REPLACE FUNCTION public.cardiolink_presentacion_os_confirmar_v1(p_periodo text, p_lotes jsonb)
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
-- RPC de la fecha de control del bloque base (idéntica a la del SQL base)
CREATE OR REPLACE FUNCTION public.cardiolink_presentacion_os_control_v1(p_fecha date)
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
DROP FUNCTION IF EXISTS public.cardiolink_presentacion_os_delegacion_v1(text,text,text,boolean);
DROP TABLE IF EXISTS public.cardiolink_presentaciones_os_delegaciones_v1;
DROP FUNCTION IF EXISTS public.cardiolink_presentacion_os_norm_v1(text);
DO $$
BEGIN
  IF to_regclass('public.cardiolink_presentaciones_os_delegaciones_v1') IS NOT NULL OR to_regprocedure('public.cardiolink_presentacion_os_norm_v1(text)') IS NOT NULL
     OR to_regprocedure('public.cardiolink_presentacion_os_delegacion_v1(text,text,text,boolean)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'cardiolink_presentaciones_os_items_v1' AND column_name IN ('realizado_por_professional_id', 'facturante_professional_id', 'destino_texto')) THEN
    RAISE EXCEPTION 'FALLA: quedaron objetos del complemento'; END IF;
  IF coalesce(pg_get_functiondef(to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb)')), '') LIKE '%delegaciones_v1%'
     OR coalesce(pg_get_functiondef(to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb)')), '') NOT LIKE '%PR412%' THEN
    RAISE EXCEPTION 'FALLA: la RPC no volvió a la versión del bloque base'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename LIKE 'cardiolink\_presentaciones\_os%' ESCAPE '\' AND permissive = 'PERMISSIVE') <> 3 THEN
    RAISE EXCEPTION 'FALLA: deben volver a quedar 3 políticas SELECT'; END IF;
END $$;
-- CardioLink · FACTURACIÓN MENSUAL V1 · BLOQUE 1 · ROLLBACK de pending_review_facturacion_presentaciones_v1.sql
-- *** Ensayado en un PostgreSQL local y dentro del ensayo reversible de STAGING. NO ejecutado en Production. ***  Solo elimina los objetos NUEVOS de este bloque. No toca atenciones ni ninguna otra tabla.
-- ATENCIÓN: borra las presentaciones registradas. Antes de ejecutarlo en una base con datos reales, exportar las tres tablas (ver checks) y confirmar con el Dueño.
DROP FUNCTION IF EXISTS public.cardiolink_presentacion_os_confirmar_v1(text, jsonb);
DROP FUNCTION IF EXISTS public.cardiolink_presentacion_os_control_v1(date);
DROP TABLE IF EXISTS public.cardiolink_presentaciones_os_items_v1;
DROP TABLE IF EXISTS public.cardiolink_presentaciones_os_v1;
DROP TABLE IF EXISTS public.cardiolink_presentaciones_os_control_v1;
DROP FUNCTION IF EXISTS public.cardiolink_presentacion_os_confirmar_permitido_v1(text);
DROP FUNCTION IF EXISTS public.cardiolink_presentacion_os_ver_v1(text);
DO $$
BEGIN
  IF to_regclass('public.cardiolink_presentaciones_os_v1') IS NOT NULL OR to_regclass('public.cardiolink_presentaciones_os_items_v1') IS NOT NULL OR to_regclass('public.cardiolink_presentaciones_os_control_v1') IS NOT NULL
     OR to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'FALLA: quedaron objetos del bloque'; END IF;
END $$;
DO $$
BEGIN
  IF to_regclass('public.cardiolink_presentaciones_os_v1') IS NOT NULL OR to_regclass('public.cardiolink_presentaciones_os_items_v1') IS NOT NULL OR to_regclass('public.cardiolink_presentaciones_os_control_v1') IS NOT NULL
     OR to_regclass('public.cardiolink_presentaciones_os_delegaciones_v1') IS NOT NULL OR to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb)') IS NOT NULL
     OR to_regprocedure('public.cardiolink_presentacion_os_norm_v1(text)') IS NOT NULL THEN
    RAISE EXCEPTION 'FALLA P1: la base no quedó sin objetos de Presentaciones (estado equivalente a Production)'; END IF;
END $$;
-- ===== PASO 2: APLICACIÓN ATÓMICA (el archivo real, sin su BEGIN/COMMIT) =====
-- CardioLink · FACTURACIÓN MENSUAL V1 · APLICACIÓN ATÓMICA (bloque base + complemento de terceros). GENERADO por pending_review_facturacion_presentaciones_v1_atomico_generar.sh: no editar a mano.
-- *** SQL PROPUESTO · NO aplicado en Production. NO EJECUTAR sin autorización explícita y sin los checks previos de solo lectura (..._checks.sql). ***
-- UNA sola transacción (un único BEGIN y un único COMMIT): nadie ve el bloque base sin el complemento. Si cualquier precondición o postcondición falla, se revierte TODO y la base queda como estaba.
-- Para Production (no tiene ningún objeto de Presentaciones). NO usar en una base que ya tenga el bloque base (STAGING): ahí corresponde solo ..._terceros.sql.
-- NO ejecutar los dos archivos por separado (cada uno trae su propio BEGIN/COMMIT: entre ambos quedaría la guarda vieja del control de fecha). Rollback completo: ..._terceros_rollback.sql y luego ..._rollback.sql.
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
-- ================= PARTE 1: BLOQUE BASE (pending_review_facturacion_presentaciones_v1.sql, sin su BEGIN/COMMIT) =================
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

-- ================= PARTE 2: COMPLEMENTO DE TERCEROS (pending_review_facturacion_presentaciones_v1_terceros.sql, sin su BEGIN/COMMIT) =================
-- CardioLink · FACTURACIÓN MENSUAL V1 · BLOQUE 1 · COMPLEMENTO · FACTURACIÓN POR TERCEROS (estudios realizados por un profesional y facturados por otro)
-- *** SQL PROPUESTO · Aplicado y verificado en STAGING (22/11/2026: ensayo reversible 53/53 y QA funcional 93/93). NO aplicado en Production. ***
-- NO EJECUTAR sin autorización explícita. Se aplica DESPUÉS del bloque base (pending_review_facturacion_presentaciones_v1.sql; en STAGING, que tiene la versión previa + delta, también corre).
-- No está en supabase/migrations a propósito: `supabase db push` no debe poder aplicarlo por accidente (la CLI de este equipo apunta a Production).
-- Una sola transacción. Falla (y revierte todo) si el bloque base no está aplicado o si este complemento ya lo está. Rollback: ..._terceros_rollback.sql. Verificaciones de solo lectura: ..._terceros_checks.sql.
--
-- PROBLEMA. En el consultorio es habitual que un estudio lo REALICE un profesional (p. ej. Matías) y lo FACTURE otro (p. ej. Rogelio). La V1 base obliga a presentar cada prestación por el profesional de la atención,
--           así que esos estudios solo podían quedar «aparte». Además `prestacionA` (destino del estudio) es un TEXTO libre («Rogelio», «Dr. Rogelio Anchorena», «No aplica», «A definir»…): no identifica por sí solo a un profesional.
-- SOLUCIÓN (mínima y explícita).
--   * Tabla cardiolink_presentaciones_os_delegaciones_v1: DELEGACIONES aprobadas «los estudios que realiza X con destino Y los factura Z». Sin una fila ACTIVA no se reencamina nada (se asume que factura quien realizó).
--     El facturante no se deduce del convenio: un cambio posterior de la configuración de convenios NO altera lo ya registrado ni lo ya presentado.
--   * Cada ítem presentado guarda explícitamente: atención original, quién REALIZÓ (realizado_por_professional_id), quién FACTURA (facturante_professional_id, igual al professional_id de la presentación) y el texto de destino (destino_texto).
--   * La RPC de confirmación DERIVA el facturante de la atención + delegación (el cliente no lo decide), exige que el lote sea de ese facturante, valida el permiso sobre el FACTURANTE, el arancel FIJADO (PR412) y el importe (PR409).
--   * El índice único por atención (atencion_id) sigue siendo la garantía anti-duplicados: una prestación entra en UNA sola presentación, aunque se intente desde dos lotes o dos sesiones.
--   * Lectura: el facturante ve sus ítems (política por professional_id, como antes) y quien realizó también (nueva condición por realizado_por_professional_id). La escritura sigue siendo SOLO por RPC.
--   * NO toca atenciones, Caja, Finanzas, HC, Colocaciones ni la sincronización. Solo agrega objetos nuevos, 3 columnas a la tabla de ítems de este bloque y reemplaza una política y la RPC de este bloque.
-- SEMILLA: la migración carga dos delegaciones aprobadas por el Dueño: Matías → Rogelio con destino «Rogelio» y con destino «Dr. Rogelio Anchorena». Se pueden cambiar con cardiolink_presentacion_os_delegacion_v1 (solo owner/admin).


-- ===== 0) Precondiciones =====
DO $$
BEGIN
  IF to_regclass('public.cardiolink_presentaciones_os_items_v1') IS NULL OR to_regclass('public.cardiolink_presentaciones_os_v1') IS NULL OR to_regclass('public.cardiolink_presentaciones_os_control_v1') IS NULL
     OR to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb)') IS NULL OR to_regprocedure('public.cardiolink_presentacion_os_ver_v1(text)') IS NULL
     OR to_regprocedure('public.cardiolink_presentacion_os_confirmar_permitido_v1(text)') IS NULL THEN
    RAISE EXCEPTION 'Precondición: falta aplicar antes el bloque base pending_review_facturacion_presentaciones_v1.sql'; END IF;
  IF coalesce(pg_get_functiondef(to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb)')), '') NOT LIKE '%PR412%' THEN
    RAISE EXCEPTION 'Precondición: la RPC base no incluye el cierre PR412 (arancel fijado): aplicar antes la versión actual del bloque base (o su delta)'; END IF;
  IF to_regclass('public.cardiolink_presentaciones_os_delegaciones_v1') IS NOT NULL
     OR to_regprocedure('public.cardiolink_presentacion_os_norm_v1(text)') IS NOT NULL
     OR to_regprocedure('public.cardiolink_presentacion_os_delegacion_v1(text,text,text,boolean)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'cardiolink_presentaciones_os_items_v1'
                  AND column_name IN ('realizado_por_professional_id', 'facturante_professional_id', 'destino_texto')) THEN
    RAISE EXCEPTION 'El complemento de facturación por terceros ya está aplicado (o parcialmente): no se repite'; END IF;
END $$;

-- ===== 1) Normalización del destino (la MISMA que usa el cliente: minúsculas, sin tildes, espacios colapsados) =====
CREATE FUNCTION public.cardiolink_presentacion_os_norm_v1(p text)
 RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog
AS $f$
 SELECT btrim(regexp_replace(translate(lower(coalesce(p, '')), 'áàäâéèëêíìïîóòöôúùüûñ', 'aaaaeeeeiiiioooouuuun'), '\s+', ' ', 'g'))
$f$;
REVOKE ALL ON FUNCTION public.cardiolink_presentacion_os_norm_v1(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cardiolink_presentacion_os_norm_v1(text) TO authenticated;

-- ===== 2) Delegaciones de facturación (explícitas, aprobadas, editables solo por owner/admin) =====
CREATE TABLE public.cardiolink_presentaciones_os_delegaciones_v1 (
  realiza_professional_id text NOT NULL CHECK (btrim(realiza_professional_id) <> ''),                 -- profesional que REALIZA el estudio (el de la atención)
  destino_norm text NOT NULL CHECK (btrim(destino_norm) <> ''),                                       -- destino escrito en prestacionA, normalizado (cardiolink_presentacion_os_norm_v1)
  facturante_professional_id text NOT NULL CHECK (btrim(facturante_professional_id) <> ''),           -- profesional que FACTURA
  activa boolean NOT NULL DEFAULT true,
  nota text NULL,
  actualizado_por uuid NOT NULL,
  actualizado_en timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (realiza_professional_id, destino_norm),                                                -- un único facturante por (quien realiza, destino): sin ambigüedad
  CONSTRAINT cardiolink_presentaciones_os_deleg_distintos_ck CHECK (realiza_professional_id <> facturante_professional_id)
);
INSERT INTO public.cardiolink_presentaciones_os_delegaciones_v1 (realiza_professional_id, destino_norm, facturante_professional_id, activa, nota, actualizado_por) VALUES
  ('matias', 'rogelio', 'rogelio', true, 'Estudios realizados por Matías con destino «Rogelio»: los factura Rogelio (aprobado por el Dueño; sembrado por la migración).', '00000000-0000-0000-0000-000000000000'),
  ('matias', 'dr. rogelio anchorena', 'rogelio', true, 'La misma delegación escrita con el nombre completo (aprobado por el Dueño; sembrado por la migración).', '00000000-0000-0000-0000-000000000000');

ALTER TABLE public.cardiolink_presentaciones_os_delegaciones_v1 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.cardiolink_presentaciones_os_delegaciones_v1 FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.cardiolink_presentaciones_os_delegaciones_v1 TO authenticated;
GRANT ALL ON TABLE public.cardiolink_presentaciones_os_delegaciones_v1 TO service_role;
CREATE POLICY cardiolink_presentaciones_os_delegaciones_select ON public.cardiolink_presentaciones_os_delegaciones_v1
  FOR SELECT TO authenticated USING ((SELECT public.cardiolink_ctx_rol_v1()) IN ('owner', 'admin', 'secretaria', 'medico'));
COMMENT ON TABLE public.cardiolink_presentaciones_os_delegaciones_v1 IS
  'Delegaciones de facturación aprobadas: los estudios que realiza realiza_professional_id con destino destino_norm los factura facturante_professional_id. Sin fila activa factura quien realizó. Se escribe solo por cardiolink_presentacion_os_delegacion_v1 (owner/admin).';

-- RPC: alta/cambio/baja lógica de una delegación (solo owner/admin). Afecta solo a lo que se presente DESDE ahora: lo ya presentado conserva su facturante guardado.
CREATE FUNCTION public.cardiolink_presentacion_os_delegacion_v1(p_realiza text, p_destino text, p_facturante text, p_activa boolean DEFAULT true)
 RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $f$
DECLARE v_r text := btrim(coalesce(p_realiza, '')); v_f text := btrim(coalesce(p_facturante, '')); v_d text := public.cardiolink_presentacion_os_norm_v1(p_destino);
BEGIN
  IF auth.uid() IS NULL OR coalesce((SELECT public.cardiolink_ctx_rol_v1()), '') NOT IN ('owner', 'admin') THEN        -- coalesce: sin rol activo el rol es NULL y NULL NOT IN (...) no frena
    RAISE EXCEPTION 'PR403: solo el Dueño o un Administrador define las delegaciones de facturación' USING ERRCODE = '42501'; END IF;
  IF v_r = '' OR v_f = '' OR v_d = '' OR v_d IN ('no aplica', 'a definir', 'particular') OR v_r = v_f THEN
    RAISE EXCEPTION 'PR400: delegación inválida (el destino no identifica a un profesional o quien realiza y quien factura son el mismo)' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.cardiolink_presentaciones_os_delegaciones_v1 (realiza_professional_id, destino_norm, facturante_professional_id, activa, actualizado_por)
  VALUES (v_r, v_d, v_f, coalesce(p_activa, true), auth.uid())
  ON CONFLICT (realiza_professional_id, destino_norm) DO UPDATE SET facturante_professional_id = EXCLUDED.facturante_professional_id, activa = EXCLUDED.activa,
    actualizado_por = EXCLUDED.actualizado_por, actualizado_en = now();
  RETURN v_r || ' / ' || v_d || ' → ' || v_f || CASE WHEN coalesce(p_activa, true) THEN '' ELSE ' (inactiva)' END;
END
$f$;
REVOKE ALL ON FUNCTION public.cardiolink_presentacion_os_delegacion_v1(text,text,text,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cardiolink_presentacion_os_delegacion_v1(text,text,text,boolean) TO authenticated;

-- ===== 3) Trazabilidad en cada ítem presentado: quién realizó, quién factura, texto de destino =====
ALTER TABLE public.cardiolink_presentaciones_os_items_v1
  ADD COLUMN realizado_por_professional_id text NULL,
  ADD COLUMN facturante_professional_id text NULL,
  ADD COLUMN destino_texto text NULL;
-- filas previas (si las hubiera, de la V1): se presentaron por quien las realizó
UPDATE public.cardiolink_presentaciones_os_items_v1 SET realizado_por_professional_id = professional_id, facturante_professional_id = professional_id WHERE realizado_por_professional_id IS NULL;
ALTER TABLE public.cardiolink_presentaciones_os_items_v1
  ALTER COLUMN realizado_por_professional_id SET NOT NULL,
  ALTER COLUMN facturante_professional_id SET NOT NULL,
  ADD CONSTRAINT cardiolink_presentaciones_os_items_facturante_ck CHECK (facturante_professional_id = professional_id AND btrim(realizado_por_professional_id) <> '');
CREATE INDEX cardiolink_presentaciones_os_items_realizado_idx ON public.cardiolink_presentaciones_os_items_v1 (realizado_por_professional_id, fecha_atencion);
COMMENT ON COLUMN public.cardiolink_presentaciones_os_items_v1.professional_id IS 'Profesional FACTURANTE (el de la presentación). Igual a facturante_professional_id.';
COMMENT ON COLUMN public.cardiolink_presentaciones_os_items_v1.realizado_por_professional_id IS 'Profesional que realizó o registró la prestación (el de la atención).';

-- el facturante ve sus ítems (como antes) y quien realizó también ve los suyos (para saber quién los presentó)
DROP POLICY cardiolink_presentaciones_os_items_select ON public.cardiolink_presentaciones_os_items_v1;
CREATE POLICY cardiolink_presentaciones_os_items_select ON public.cardiolink_presentaciones_os_items_v1
  FOR SELECT TO authenticated USING (public.cardiolink_presentacion_os_ver_v1(professional_id) OR public.cardiolink_presentacion_os_ver_v1(realizado_por_professional_id));

-- ===== 4) RPC de confirmación: deriva el facturante (atención + delegación), valida permiso sobre el facturante, arancel fijado y duplicados; guarda quién realizó y quién factura =====
CREATE OR REPLACE FUNCTION public.cardiolink_presentacion_os_confirmar_v1(p_periodo text, p_lotes jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $f$
DECLARE
  v_uid uuid := auth.uid();
  v_rol text := (SELECT public.cardiolink_ctx_rol_v1());
  v_email text := coalesce(nullif(auth.jwt() ->> 'email', ''), '');
  v_ctrl date; v_fin date;
  v_lote jsonb; v_item jsonb; v_pl jsonb; v_pres uuid;
  v_prof text; v_cob text; v_n int; v_total numeric; v_f date; v_importe numeric; v_cob_item text; v_exc boolean; v_motivo text; v_val numeric; v_arancel_id text;
  v_real text; v_dest text; v_fact text; v_fact2 text;
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
      -- QUIÉN REALIZÓ y QUIÉN FACTURA. El facturante NO se supone ni se deduce del convenio: solo un ESTUDIO con una DELEGACIÓN activa y aprobada (profesional que realizó + destino escrito en prestacionA)
      -- se reencamina a otro profesional; todo lo demás lo factura quien lo realizó (como en la V1). El lote debe ser del facturante derivado por el servidor.
      v_real := coalesce(nullif(v_pl ->> 'profesionalId', ''), nullif(v_pl ->> 'cajaPerfil', ''), 'matias');
      v_dest := public.cardiolink_presentacion_os_norm_v1(v_pl ->> 'prestacionA');
      v_fact := v_real;
      IF lower(coalesce(v_pl ->> 'prestacion', '')) NOT LIKE '%consulta%' AND v_dest <> '' THEN
        SELECT d.facturante_professional_id INTO v_fact2 FROM public.cardiolink_presentaciones_os_delegaciones_v1 d
         WHERE d.realiza_professional_id = v_real AND d.destino_norm = v_dest AND d.activa;
        IF v_fact2 IS NOT NULL THEN v_fact := v_fact2; END IF;
      END IF;
      IF v_fact <> v_prof THEN
        RAISE EXCEPTION 'PR409: el profesional facturante no coincide con la atención' USING ERRCODE = 'P0001'; END IF;
      IF (nullif(btrim(coalesce(v_item ->> 'facturante_professional_id', '')), '') IS NOT NULL AND btrim(v_item ->> 'facturante_professional_id') <> v_fact)
         OR (nullif(btrim(coalesce(v_item ->> 'realizado_por_professional_id', '')), '') IS NOT NULL AND btrim(v_item ->> 'realizado_por_professional_id') <> v_real) THEN
        RAISE EXCEPTION 'PR409: el facturante o quien realizó no coincide con la atención' USING ERRCODE = 'P0001'; END IF;
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

      INSERT INTO public.cardiolink_presentaciones_os_items_v1 (presentacion_id, atencion_id, professional_id, cobertura, prestacion, fecha_atencion, importe_presentado, arancel_id, patient_id, patient_name, excepcional, motivo_excepcion, realizado_por_professional_id, facturante_professional_id, destino_texto)
      VALUES (v_pres, btrim(v_item ->> 'atencion_id'), v_prof, btrim(v_item ->> 'cobertura'), btrim(coalesce(nullif(v_item ->> 'prestacion', ''), v_pl ->> 'prestacion', 'Prestación')), v_f, v_importe,
              v_arancel_id, nullif(btrim(coalesce(v_item ->> 'patient_id', '')), ''), nullif(btrim(coalesce(v_item ->> 'patient_name', '')), ''), v_exc, v_motivo,
              v_real, v_prof, left(nullif(btrim(coalesce(v_pl ->> 'prestacionA', '')), ''), 120));
      -- (un atencion_id ya presentado dispara unique_violation 23505 y revierte TODA la confirmación)
    END LOOP;
    v_ids := v_ids || to_jsonb(v_pres); v_items := v_items + v_n; v_suma := v_suma + v_total;
  END LOOP;
  RETURN jsonb_build_object('presentaciones', v_ids, 'items', v_items, 'total', v_suma);
END
$f$;

-- ===== 4b) Corrección de la RPC de la fecha de control (base): la guarda dejaba pasar a un usuario autenticado SIN rol activo =====
CREATE OR REPLACE FUNCTION public.cardiolink_presentacion_os_control_v1(p_fecha date)
 RETURNS date LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $f$
BEGIN
  IF auth.uid() IS NULL OR coalesce((SELECT public.cardiolink_ctx_rol_v1()), '') NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'PR403: solo el Dueño o un Administrador define la fecha de control' USING ERRCODE = '42501'; END IF;
  IF p_fecha IS NULL OR p_fecha < DATE '2020-01-01' OR p_fecha > (current_date + 366) THEN
    RAISE EXCEPTION 'PR400: fecha de control inválida' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.cardiolink_presentaciones_os_control_v1 (id, fecha_inicio, actualizado_por, actualizado_en)
  VALUES (true, p_fecha, auth.uid(), now())
  ON CONFLICT (id) DO UPDATE SET fecha_inicio = EXCLUDED.fecha_inicio, actualizado_por = EXCLUDED.actualizado_por, actualizado_en = EXCLUDED.actualizado_en;
  RETURN p_fecha;
END
$f$;

-- ===== 5) Postcondiciones =====
DO $$
BEGIN
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'cardiolink_presentaciones_os_items_v1' AND column_name IN ('realizado_por_professional_id', 'facturante_professional_id', 'destino_texto')) <> 3 THEN
    RAISE EXCEPTION 'FALLA: faltan columnas de trazabilidad en los ítems'; END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'cardiolink_presentaciones_os_items_v1' AND column_name IN ('realizado_por_professional_id', 'facturante_professional_id') AND is_nullable = 'YES') THEN
    RAISE EXCEPTION 'FALLA: realizado_por y facturante deben ser NOT NULL'; END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.cardiolink_presentaciones_os_delegaciones_v1'::regclass AND NOT relrowsecurity) THEN RAISE EXCEPTION 'FALLA: RLS apagada en delegaciones'; END IF;
  IF has_table_privilege('anon', 'public.cardiolink_presentaciones_os_delegaciones_v1', 'SELECT') OR has_table_privilege('authenticated', 'public.cardiolink_presentaciones_os_delegaciones_v1', 'INSERT')
     OR has_table_privilege('authenticated', 'public.cardiolink_presentaciones_os_delegaciones_v1', 'UPDATE') OR has_table_privilege('authenticated', 'public.cardiolink_presentaciones_os_delegaciones_v1', 'DELETE') THEN
    RAISE EXCEPTION 'FALLA: delegaciones: anon sin nada y authenticated solo SELECT'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename LIKE 'cardiolink\_presentaciones\_os%' ESCAPE '\' AND permissive = 'PERMISSIVE') <> 4 THEN
    RAISE EXCEPTION 'FALLA: deben quedar exactamente 4 políticas SELECT (control, presentaciones, ítems, delegaciones)'; END IF;
  IF has_function_privilege('anon', 'public.cardiolink_presentacion_os_delegacion_v1(text,text,text,boolean)', 'EXECUTE') OR has_function_privilege('anon', 'public.cardiolink_presentacion_os_confirmar_v1(text,jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.cardiolink_presentacion_os_norm_v1(text)', 'EXECUTE') THEN RAISE EXCEPTION 'FALLA: anon no debe ejecutar funciones del bloque'; END IF;
  IF NOT has_function_privilege('authenticated', 'public.cardiolink_presentacion_os_confirmar_v1(text,jsonb)', 'EXECUTE') THEN RAISE EXCEPTION 'FALLA: authenticated debe poder llamar la RPC de confirmación'; END IF;
  IF coalesce(pg_get_functiondef(to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb)')), '') NOT LIKE '%delegaciones_v1%'
     OR coalesce(pg_get_functiondef(to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb)')), '') NOT LIKE '%PR412%' THEN
    RAISE EXCEPTION 'FALLA: la RPC de confirmación no quedó con delegaciones y PR412'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'cardiolink_presentaciones_os_items_atencion_uq' AND indexdef ILIKE '%UNIQUE%(atencion_id)%') THEN
    RAISE EXCEPTION 'FALLA: falta el índice único por atención (anti-duplicados)'; END IF;
  IF (SELECT count(*) FROM public.cardiolink_presentaciones_os_delegaciones_v1 WHERE realiza_professional_id = 'matias' AND facturante_professional_id = 'rogelio' AND activa) <> 2 THEN
    RAISE EXCEPTION 'FALLA: las dos delegaciones sembradas (Matías → Rogelio) no están'; END IF;
  IF public.cardiolink_presentacion_os_norm_v1('  Dr.  ROGELIO   Anchorena ') IS DISTINCT FROM 'dr. rogelio anchorena' OR public.cardiolink_presentacion_os_norm_v1('MATÍAS') IS DISTINCT FROM 'matias' THEN
    RAISE EXCEPTION 'FALLA: la normalización del destino no coincide con la del cliente'; END IF;
  IF EXISTS (SELECT 1 FROM public.cardiolink_presentaciones_os_items_v1 WHERE facturante_professional_id <> professional_id) THEN RAISE EXCEPTION 'FALLA: ítems con facturante distinto del profesional de la presentación'; END IF;
  IF coalesce(pg_get_functiondef(to_regprocedure('public.cardiolink_presentacion_os_control_v1(date)')), '') NOT LIKE '%coalesce((SELECT public.cardiolink_ctx_rol_v1()%' THEN RAISE EXCEPTION 'FALLA: la RPC del control no quedó con la guarda robusta ante usuarios sin rol'; END IF;
END $$;

-- ================= PARTE 3: verificación conjunta antes del COMMIT =================
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename LIKE 'cardiolink\_presentaciones\_os%' ESCAPE '\' AND permissive = 'PERMISSIVE') <> 4 THEN
    RAISE EXCEPTION 'FALLA conjunta: deben quedar 4 políticas SELECT'; END IF;
  IF coalesce(pg_get_functiondef(to_regprocedure('public.cardiolink_presentacion_os_control_v1(date)')), '') NOT LIKE '%coalesce((SELECT public.cardiolink_ctx_rol_v1()%' THEN
    RAISE EXCEPTION 'FALLA conjunta: el control de fecha no quedó con la guarda robusta ante usuarios sin rol'; END IF;
END $$;
-- ===== PASO 3: pruebas (como owner / secretaría asociada / médico / sin rol / anon) =====
-- ===== PRUEBAS del ensayo reversible de Presentaciones a obras sociales V1 (como cada usuario real, vía claims + SET LOCAL ROLE; todo sintético qa_pres_*) =====
-- Se ejecutan DESPUÉS de pending_review_facturacion_presentaciones_v1.sql y ANTES de su rollback, dentro de la MISMA transacción, que termina SIEMPRE con una EXCEPTION (revierte todo).
CREATE TEMP TABLE t_act(clave text PRIMARY KEY, uid uuid, prof text);
GRANT SELECT ON t_act TO authenticated, anon;
CREATE TEMP TABLE t_res(nombre text);
GRANT ALL ON t_res TO authenticated;

-- actores reales (sólo se leen sus ids): owner/admin activo, médico con professional_id y una secretaria con asociación ACTIVA a ese médico
DO $$
DECLARE v_tabla text; s uuid; m uuid; o uuid; p text;
BEGIN
  SELECT table_name INTO v_tabla FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('secretaria_user_id','medico_user_id','activo') GROUP BY table_name HAVING count(*) = 3;
  IF v_tabla IS NULL THEN RAISE EXCEPTION 'Faltan actores: no hay tabla de asociaciones secretaria-médico'; END IF;
  EXECUTE format($q$SELECT a.secretaria_user_id, a.medico_user_id, m.professional_id
                      FROM public.%I a
                      JOIN public.cardiolink_user_roles s ON s.user_id = a.secretaria_user_id AND s.active AND s.base_role = 'secretaria'
                      JOIN public.cardiolink_user_roles m ON m.user_id = a.medico_user_id AND m.active AND m.base_role = 'medico' AND coalesce(m.professional_id,'') <> ''
                     WHERE a.activo ORDER BY a.secretaria_user_id, a.medico_user_id LIMIT 1$q$, v_tabla) INTO s, m, p;
  -- si no hay NINGUNA asociación activa (caso real de STAGING), se activa/crea una entre la secretaria y el médico activos DENTRO de esta transacción (se revierte con todo lo demás)
  IF s IS NULL OR m IS NULL THEN
    SELECT user_id INTO s FROM public.cardiolink_user_roles WHERE active AND base_role = 'secretaria' ORDER BY user_id LIMIT 1;
    SELECT user_id, professional_id INTO m, p FROM public.cardiolink_user_roles WHERE active AND base_role = 'medico' AND coalesce(professional_id, '') <> '' ORDER BY user_id LIMIT 1;
    IF s IS NOT NULL AND m IS NOT NULL THEN
      -- la tabla de asociaciones tiene un trigger de auditoría que exige quién actúa (auth.uid()): se actúa como el owner/admin activo, sólo dentro de esta transacción
      SELECT user_id INTO o FROM public.cardiolink_user_roles WHERE base_role IN ('owner','admin') AND active ORDER BY base_role, user_id LIMIT 1;
      PERFORM set_config('request.jwt.claims', json_build_object('sub', o, 'role', 'authenticated')::text, true);
      EXECUTE format('INSERT INTO public.%I (secretaria_user_id, medico_user_id, activo) VALUES (%L, %L, true) ON CONFLICT (secretaria_user_id, medico_user_id) DO UPDATE SET activo = true', v_tabla, s, m);
    END IF;
    PERFORM set_config('request.jwt.claims', '', true);
  END IF;
  SELECT user_id INTO o FROM public.cardiolink_user_roles WHERE base_role IN ('owner','admin') AND active ORDER BY base_role, user_id LIMIT 1;
  IF s IS NULL OR m IS NULL OR o IS NULL THEN RAISE EXCEPTION 'Faltan actores (secretaria y médico activos con professional_id, y owner/admin activo)'; END IF;
  IF p = 'qa_pres_otroprof' THEN RAISE EXCEPTION 'professional_id real colisiona con el sintético'; END IF;
  INSERT INTO t_act VALUES ('sec', s, NULL), ('med', m, p), ('own', o, NULL), ('nadie', gen_random_uuid(), NULL), ('anon', NULL, NULL);
  IF EXISTS (SELECT 1 FROM public.cardiolink_atenciones WHERE id LIKE 'qa\_pres\_%' ESCAPE '\') THEN RAISE EXCEPTION 'Ya existen atenciones qa_pres_*: se aborta'; END IF;
END $$;

-- ejecuta una sentencia como un actor (rol de base de datos authenticated/anon + claims JWT) y devuelve 'OK' o 'SQLSTATE:mensaje'
CREATE FUNCTION pg_temp.como(p_clave text, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v_uid uuid; r text; v_rol text;
BEGIN
  SELECT uid INTO v_uid FROM t_act WHERE clave = p_clave;
  v_rol := CASE WHEN p_clave = 'anon' THEN 'anon' ELSE 'authenticated' END;
  PERFORM set_config('request.jwt.claims', CASE WHEN p_clave = 'anon' THEN json_build_object('role','anon')::text ELSE json_build_object('sub', v_uid, 'role', 'authenticated', 'email', p_clave || '@qa.test')::text END, true);
  BEGIN
    EXECUTE 'SET LOCAL ROLE ' || quote_ident(v_rol);
    EXECUTE p_sql;
    EXECUTE 'RESET ROLE';
    r := 'OK';
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    r := SQLSTATE || ':' || SQLERRM;
  END;
  RETURN r;
END $f$;
-- cuenta filas visibles para un actor (RLS); -1 si falla
CREATE FUNCTION pg_temp.cuenta_como(p_clave text, p_sql text) RETURNS bigint LANGUAGE plpgsql AS $f$
DECLARE v_uid uuid; n bigint; v_rol text;
BEGIN
  SELECT uid INTO v_uid FROM t_act WHERE clave = p_clave;
  v_rol := CASE WHEN p_clave = 'anon' THEN 'anon' ELSE 'authenticated' END;
  PERFORM set_config('request.jwt.claims', CASE WHEN p_clave = 'anon' THEN json_build_object('role','anon')::text ELSE json_build_object('sub', v_uid, 'role', 'authenticated', 'email', p_clave || '@qa.test')::text END, true);
  BEGIN
    EXECUTE 'SET LOCAL ROLE ' || quote_ident(v_rol);
    EXECUTE p_sql INTO n;
    EXECUTE 'RESET ROLE';
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE'; n := -1;
  END;
  RETURN n;
END $f$;
CREATE FUNCTION pg_temp.esperar(p_nombre text, p_obtenido text, p_patron text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  IF p_obtenido IS NULL OR p_obtenido !~ p_patron THEN RAISE EXCEPTION 'FALLA %: obtenido=[%] esperado~[%]', p_nombre, p_obtenido, p_patron; END IF;
  INSERT INTO t_res VALUES (p_nombre);
END $f$;
-- inserta una fila sintética de atención como postgres (se completan columnas obligatorias desconocidas)
CREATE FUNCTION pg_temp.arma_insert(p_tabla text, p_val jsonb) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE c record; cols text := ''; vals text := ''; v text; k text;
BEGIN
  FOR k IN SELECT jsonb_object_keys(p_val) LOOP
    cols := cols || CASE WHEN cols = '' THEN '' ELSE ',' END || quote_ident(k);
    vals := vals || CASE WHEN vals = '' THEN '' ELSE ',' END || quote_literal(p_val ->> k);
  END LOOP;
  FOR c IN SELECT column_name, data_type FROM information_schema.columns
            WHERE table_schema='public' AND table_name=p_tabla AND is_nullable='NO' AND column_default IS NULL AND NOT (p_val ? column_name) ORDER BY ordinal_position LOOP
    IF c.data_type IN ('text','character varying','character') THEN v := quote_literal('QA SINTETICO presentaciones');
    ELSIF c.data_type LIKE 'timestamp%' THEN v := 'now()';
    ELSIF c.data_type = 'date' THEN v := 'current_date';
    ELSIF c.data_type = 'boolean' THEN v := 'false';
    ELSIF c.data_type IN ('integer','bigint','smallint','numeric') THEN v := '0';
    ELSIF c.data_type = 'uuid' THEN v := 'gen_random_uuid()';
    ELSIF c.data_type IN ('jsonb','json') THEN v := quote_literal('{}') || '::' || c.data_type;
    ELSE RAISE EXCEPTION 'columna obligatoria % (%) sin valor sintético', c.column_name, c.data_type; END IF;
    cols := cols || ',' || quote_ident(c.column_name); vals := vals || ',' || v;
  END LOOP;
  RETURN format('INSERT INTO public.%I (%s) VALUES (%s)', p_tabla, cols, vals);
END $f$;

-- ===== PRUEBAS del complemento de facturación por terceros (como cada usuario real, vía claims + SET LOCAL ROLE; todo sintético qa_pres_*) =====
-- Se ejecutan DESPUÉS de pending_review_facturacion_presentaciones_v1_terceros.sql y ANTES de su rollback, dentro de la MISMA transacción, que termina SIEMPRE con una EXCEPTION (revierte todo).
-- helpers del complemento: ítem con facturante/realizó opcionales, lote por profesional (facturante) y salida «OK o SQLSTATE:mensaje»
CREATE FUNCTION pg_temp.itt(p_id text, p_fecha text, p_importe numeric, p_extra jsonb DEFAULT '{}'::jsonb) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object('atencion_id', p_id, 'fecha_atencion', p_fecha, 'cobertura', 'OSDE', 'prestacion', 'Holter', 'importe_presentado', p_importe, 'arancel_id', 'ar1',
                            'patient_id', 'qa_pres_pac', 'patient_name', 'PACIENTE SINTETICO', 'excepcional', false, 'motivo_excepcion', null) || p_extra
$f$;
CREATE FUNCTION pg_temp.conf(p_prof text, p_items jsonb, p_cob text DEFAULT 'OSDE') RETURNS text LANGUAGE sql AS $f$
  SELECT format('SELECT public.cardiolink_presentacion_os_confirmar_v1(%L, %L::jsonb)', '2026-12', jsonb_build_array(jsonb_build_object('cobertura', p_cob, 'professional_id', p_prof, 'items', p_items))::text)
$f$;

-- fixture como postgres: atenciones sintéticas (control sembrado = 2026-12-01). p = profesional real del médico de prueba; qa_pres_fact / qa_pres_fact2 = facturantes sintéticos
DO $$
DECLARE p text; mk jsonb;
BEGIN
  SELECT prof INTO p FROM t_act WHERE clave = 'med';
  mk := jsonb_build_object('obraSocial', 'OSDE', 'prestacion', 'Holter', 'estadoTurno', 'atendido', 'valorArancelEstimado', 1000, 'arancelId', 'ar1', 'prestacionA', 'qa_pres_dest', 'profesionalId', p);
  EXECUTE pg_temp.arma_insert('cardiolink_atenciones', jsonb_build_object('id', 'qa_pres_t1', 'payload', (mk || jsonb_build_object('id','qa_pres_t1','fecha','2026-12-03'))::text));                                      -- estudio delegado
  EXECUTE pg_temp.arma_insert('cardiolink_atenciones', jsonb_build_object('id', 'qa_pres_t2', 'payload', (mk || jsonb_build_object('id','qa_pres_t2','fecha','2026-12-04','prestacionA','  QA_PRES_DEST '))::text));      -- destino escrito distinto (mayúsculas/espacios)
  EXECUTE pg_temp.arma_insert('cardiolink_atenciones', jsonb_build_object('id', 'qa_pres_t3', 'payload', (mk || jsonb_build_object('id','qa_pres_t3','fecha','2026-12-05','prestacion','Consulta'))::text));          -- consulta: nunca se delega
  EXECUTE pg_temp.arma_insert('cardiolink_atenciones', jsonb_build_object('id', 'qa_pres_t4', 'payload', (mk || jsonb_build_object('id','qa_pres_t4','fecha','2026-12-06','prestacionA','No aplica'))::text));         -- destino «No aplica»: factura quien realizó
  EXECUTE pg_temp.arma_insert('cardiolink_atenciones', jsonb_build_object('id', 'qa_pres_t5', 'payload', ((mk - 'valorArancelEstimado' - 'arancelId') || jsonb_build_object('id','qa_pres_t5','fecha','2026-12-07'))::text)); -- delegado SIN arancel fijado
  EXECUTE pg_temp.arma_insert('cardiolink_atenciones', jsonb_build_object('id', 'qa_pres_t6', 'payload', (mk || jsonb_build_object('id','qa_pres_t6','fecha','2026-12-08','prestacionA','qa_pres_otrodest'))::text));     -- destino SIN delegación
  EXECUTE pg_temp.arma_insert('cardiolink_atenciones', jsonb_build_object('id', 'qa_pres_t7', 'payload', (mk || jsonb_build_object('id','qa_pres_t7','fecha','2026-12-09'))::text));                                      -- para el cambio de delegación
  EXECUTE pg_temp.arma_insert('cardiolink_atenciones', jsonb_build_object('id', 'qa_pres_t8', 'payload', (mk || jsonb_build_object('id','qa_pres_t8','fecha','2026-12-10'))::text));                                      -- para la delegación inactiva
  EXECUTE pg_temp.arma_insert('cardiolink_atenciones', jsonb_build_object('id', 'qa_pres_t9', 'payload', (mk || jsonb_build_object('id','qa_pres_t9','fecha','2026-12-11','profesionalId','qa_pres_otroprof'))::text));   -- otro profesional que realiza: no hay delegación para él
  EXECUTE pg_temp.arma_insert('cardiolink_atenciones', jsonb_build_object('id', 'qa_pres_t10', 'payload', (mk || jsonb_build_object('id','qa_pres_t10','fecha','2026-12-12'))::text));                                    -- campos del cliente
  EXECUTE pg_temp.arma_insert('cardiolink_atenciones', jsonb_build_object('id', 'qa_pres_t11', 'payload', (mk || jsonb_build_object('id','qa_pres_t11','fecha','2026-12-13','prestacionA','qa_pres_dest2'))::text));    -- delegación 2 (permisos)
  EXECUTE pg_temp.arma_insert('cardiolink_atenciones', jsonb_build_object('id', 'qa_pres_t12', 'payload', (mk || jsonb_build_object('id','qa_pres_t12','fecha','2026-12-14','prestacionA','No aplica'))::text));       -- propia (Secretaría asociada al realizador)
END $$;
CREATE TEMP TABLE t_foto AS SELECT id, payload::text AS payload FROM public.cardiolink_atenciones WHERE id LIKE 'qa\_pres\_%' ESCAPE '\';
CREATE TEMP TABLE t_n_real AS SELECT count(*) AS n FROM public.cardiolink_atenciones WHERE id NOT LIKE 'qa\_pres\_%' ESCAPE '\';

-- D0 sembrado: las dos delegaciones Matías → Rogelio y el control; nadie presentó nada
DO $t$ BEGIN
  PERFORM pg_temp.esperar('D0 delegaciones sembradas (2) y sin presentaciones', (SELECT count(*) FROM public.cardiolink_presentaciones_os_delegaciones_v1 WHERE realiza_professional_id = 'matias' AND facturante_professional_id = 'rogelio' AND activa) || '/' || (SELECT count(*) FROM public.cardiolink_presentaciones_os_items_v1), '^2/0$');
END $t$;

-- D1 solo owner/admin define delegaciones; validaciones; sin rol / anon no
DO $t$
DECLARE p text;
BEGIN
  SELECT prof INTO p FROM t_act WHERE clave = 'med';
  PERFORM pg_temp.esperar('D1a owner define la delegación (qa_pres_dest → qa_pres_fact)', pg_temp.como('own', format('SELECT public.cardiolink_presentacion_os_delegacion_v1(%L, %L, %L)', p, 'qa_pres_dest', 'qa_pres_fact')), '^OK$');
  PERFORM pg_temp.esperar('D1b owner define la delegación 2 (qa_pres_dest2 → qa_pres_fact)', pg_temp.como('own', format('SELECT public.cardiolink_presentacion_os_delegacion_v1(%L, %L, %L)', p, 'Qa_Pres_Dést2', 'qa_pres_fact')), '^OK$');
  PERFORM pg_temp.esperar('D1c la secretaría asociada NO define delegaciones', pg_temp.como('sec', format('SELECT public.cardiolink_presentacion_os_delegacion_v1(%L, %L, %L)', p, 'qa_pres_x', 'qa_pres_fact')), '^42501');
  PERFORM pg_temp.esperar('D1d el médico NO define delegaciones', pg_temp.como('med', format('SELECT public.cardiolink_presentacion_os_delegacion_v1(%L, %L, %L)', p, 'qa_pres_x', 'qa_pres_fact')), '^42501');
  PERFORM pg_temp.esperar('D1e sin rol NO define delegaciones', pg_temp.como('nadie', format('SELECT public.cardiolink_presentacion_os_delegacion_v1(%L, %L, %L)', p, 'qa_pres_x', 'qa_pres_fact')), '^42501');
  PERFORM pg_temp.esperar('D1f anon NO puede ni ejecutar la función', pg_temp.como('anon', format('SELECT public.cardiolink_presentacion_os_delegacion_v1(%L, %L, %L)', p, 'qa_pres_x', 'qa_pres_fact')), '^42501');
  PERFORM pg_temp.esperar('D1g una delegación de uno a sí mismo es inválida', pg_temp.como('own', format('SELECT public.cardiolink_presentacion_os_delegacion_v1(%L, %L, %L)', p, 'qa_pres_x', p)), '^22023');
  PERFORM pg_temp.esperar('D1h un destino que no identifica a un profesional («No aplica», «A definir», vacío) es inválido', pg_temp.como('own', format('SELECT public.cardiolink_presentacion_os_delegacion_v1(%L, %L, %L)', p, 'No aplica', 'qa_pres_fact')) || '|' || pg_temp.como('own', format('SELECT public.cardiolink_presentacion_os_delegacion_v1(%L, %L, %L)', p, 'A definir', 'qa_pres_fact')) || '|' || pg_temp.como('own', format('SELECT public.cardiolink_presentacion_os_delegacion_v1(%L, %L, %L)', p, '   ', 'qa_pres_fact')), '^22023.*\|22023.*\|22023');
  PERFORM pg_temp.esperar('D1j la fecha de control (RPC base) tampoco la define un usuario autenticado SIN rol (guarda corregida con coalesce)', pg_temp.como('nadie', 'SELECT public.cardiolink_presentacion_os_control_v1(DATE ''2026-12-01'')'), '^42501');
  PERFORM pg_temp.esperar('D1k … ni la secretaría ni el médico; el owner sí (misma fecha)', pg_temp.como('sec', 'SELECT public.cardiolink_presentacion_os_control_v1(DATE ''2026-12-01'')') || '|' || pg_temp.como('med', 'SELECT public.cardiolink_presentacion_os_control_v1(DATE ''2026-12-01'')') || '|' || pg_temp.como('own', 'SELECT public.cardiolink_presentacion_os_control_v1(DATE ''2026-12-01'')'), '^42501.*\|42501.*\|OK$');
  PERFORM pg_temp.esperar('D1i la delegación 2 quedó normalizada (sin tildes ni mayúsculas)', (SELECT count(*)::text FROM public.cardiolink_presentaciones_os_delegaciones_v1 WHERE destino_norm = 'qa_pres_dest2'), '^1$');
END $t$;

-- D2 el estudio delegado NO se puede presentar por quien lo realizó; SÍ por su facturante: el servidor deriva el facturante
DO $t$
DECLARE p text; r text; v_it record;
BEGIN
  SELECT prof INTO p FROM t_act WHERE clave = 'med';
  r := pg_temp.como('own', pg_temp.conf(p, jsonb_build_array(pg_temp.itt('qa_pres_t1', '2026-12-03', 1000))));
  PERFORM pg_temp.esperar('D2a presentar el estudio delegado por QUIEN LO REALIZÓ → PR409', r, 'PR409');
  r := pg_temp.como('own', pg_temp.conf('qa_pres_fact', jsonb_build_array(pg_temp.itt('qa_pres_t1', '2026-12-03', 1000))));
  PERFORM pg_temp.esperar('D2b presentarlo por su FACTURANTE → OK', r, '^OK$');
  SELECT i.* INTO v_it FROM public.cardiolink_presentaciones_os_items_v1 i WHERE i.atencion_id = 'qa_pres_t1';
  PERFORM pg_temp.esperar('D2c el ítem guarda atención, quien realizó, quién factura, destino e importe fijado', v_it.professional_id || '|' || v_it.realizado_por_professional_id || '|' || v_it.facturante_professional_id || '|' || v_it.destino_texto || '|' || v_it.importe_presentado || '|' || v_it.arancel_id, '^qa_pres_fact\|' || p || '\|qa_pres_fact\|qa_pres_dest\|1000\.00\|ar1$');
  PERFORM pg_temp.esperar('D2d la cabecera es del facturante', (SELECT professional_id FROM public.cardiolink_presentaciones_os_v1 WHERE id = v_it.presentacion_id), '^qa_pres_fact$');
  r := pg_temp.como('own', pg_temp.conf('qa_pres_fact', jsonb_build_array(pg_temp.itt('qa_pres_t2', '2026-12-04', 1000))));
  PERFORM pg_temp.esperar('D2e el destino escrito con otras mayúsculas/espacios se reconoce igual (normalización)', r, '^OK$');
END $t$;

-- D3 una prestación NUNCA entra en dos presentaciones (índice único por atención), venga de donde venga
DO $t$
DECLARE p text; r text; n_antes int;
BEGIN
  SELECT prof INTO p FROM t_act WHERE clave = 'med';
  SELECT count(*) INTO n_antes FROM public.cardiolink_presentaciones_os_items_v1;
  r := pg_temp.como('own', pg_temp.conf('qa_pres_fact', jsonb_build_array(pg_temp.itt('qa_pres_t1', '2026-12-03', 1000))));
  PERFORM pg_temp.esperar('D3a segunda confirmación del mismo estudio por su facturante → 23505', r, '^23505');
  r := pg_temp.como('own', pg_temp.conf(p, jsonb_build_array(pg_temp.itt('qa_pres_t1', '2026-12-03', 1000))));
  PERFORM pg_temp.esperar('D3b intentarlo ahora por quien lo realizó sigue rechazado (PR409), no se duplica', r, 'PR409');
  PERFORM pg_temp.esperar('D3c no se agregó nada', (SELECT count(*) FROM public.cardiolink_presentaciones_os_items_v1) || '/' || (SELECT count(*) - count(DISTINCT atencion_id) FROM public.cardiolink_presentaciones_os_items_v1), '^' || n_antes || '/0$');
  -- INSERT directo (como postgres) de la misma atención: lo frena el índice único aunque nadie pase por la RPC
  BEGIN
    INSERT INTO public.cardiolink_presentaciones_os_items_v1 (presentacion_id, atencion_id, professional_id, cobertura, prestacion, fecha_atencion, importe_presentado, realizado_por_professional_id, facturante_professional_id)
      SELECT presentacion_id, atencion_id, professional_id, cobertura, prestacion, fecha_atencion, importe_presentado, realizado_por_professional_id, facturante_professional_id FROM public.cardiolink_presentaciones_os_items_v1 WHERE atencion_id = 'qa_pres_t1';
    RAISE EXCEPTION 'FALLA D3d: el índice único no impidió el duplicado';
  EXCEPTION WHEN unique_violation THEN INSERT INTO t_res VALUES ('D3d INSERT directo duplicado: unique_violation');
  END;
END $t$;

-- D4 lo que NO es un estudio delegado se presenta como siempre (V1): consulta, «No aplica», destino sin delegación, otro realizador
DO $t$
DECLARE p text; r text;
BEGIN
  SELECT prof INTO p FROM t_act WHERE clave = 'med';
  PERFORM pg_temp.esperar('D4a una CONSULTA con el mismo destino no se delega: por el facturante → PR409', pg_temp.como('own', pg_temp.conf('qa_pres_fact', jsonb_build_array(pg_temp.itt('qa_pres_t3', '2026-12-05', 1000, '{"prestacion":"Consulta"}')))), 'PR409');
  PERFORM pg_temp.esperar('D4b … y por quien la realizó → OK', pg_temp.como('own', pg_temp.conf(p, jsonb_build_array(pg_temp.itt('qa_pres_t3', '2026-12-05', 1000, '{"prestacion":"Consulta"}')))), '^OK$');
  PERFORM pg_temp.esperar('D4c destino «No aplica»: factura quien realizó (por el facturante → PR409; por quien realizó → OK)', pg_temp.como('own', pg_temp.conf('qa_pres_fact', jsonb_build_array(pg_temp.itt('qa_pres_t4', '2026-12-06', 1000)))) || '|' || pg_temp.como('own', pg_temp.conf(p, jsonb_build_array(pg_temp.itt('qa_pres_t4', '2026-12-06', 1000)))), 'PR409.*\|OK$');
  PERFORM pg_temp.esperar('D4d destino SIN delegación: no se asume facturante (por qa_pres_fact → PR409; por quien realizó → OK)', pg_temp.como('own', pg_temp.conf('qa_pres_fact', jsonb_build_array(pg_temp.itt('qa_pres_t6', '2026-12-08', 1000)))) || '|' || pg_temp.como('own', pg_temp.conf(p, jsonb_build_array(pg_temp.itt('qa_pres_t6', '2026-12-08', 1000)))), 'PR409.*\|OK$');
  PERFORM pg_temp.esperar('D4e la delegación vale solo para el profesional que realiza: otro realizador con el mismo destino factura él (por qa_pres_fact → PR409; por él → OK)', pg_temp.como('own', pg_temp.conf('qa_pres_fact', jsonb_build_array(pg_temp.itt('qa_pres_t9', '2026-12-11', 1000)))) || '|' || pg_temp.como('own', pg_temp.conf('qa_pres_otroprof', jsonb_build_array(pg_temp.itt('qa_pres_t9', '2026-12-11', 1000)))), 'PR409.*\|OK$');
END $t$;

-- D5 el arancel fijado sigue siendo obligatorio y el importe lo define la atención, también en lo delegado
DO $t$ BEGIN
  PERFORM pg_temp.esperar('D5a delegado SIN arancel fijado → PR412', pg_temp.como('own', pg_temp.conf('qa_pres_fact', jsonb_build_array(pg_temp.itt('qa_pres_t5', '2026-12-07', 1000)))), 'PR412');
  PERFORM pg_temp.esperar('D5b delegado con importe distinto del arancel fijado → PR409', pg_temp.como('own', pg_temp.conf('qa_pres_fact', jsonb_build_array(pg_temp.itt('qa_pres_t10', '2026-12-12', 999)))), 'PR409');
END $t$;

-- D6 el cliente no decide quién factura ni quién realizó: si manda algo distinto de lo que deriva el servidor, se rechaza todo
DO $t$
DECLARE p text;
BEGIN
  SELECT prof INTO p FROM t_act WHERE clave = 'med';
  PERFORM pg_temp.esperar('D6a facturante_professional_id enviado distinto → PR409', pg_temp.como('own', pg_temp.conf('qa_pres_fact', jsonb_build_array(pg_temp.itt('qa_pres_t10', '2026-12-12', 1000, '{"facturante_professional_id":"otro_prof"}')))), 'PR409');
  PERFORM pg_temp.esperar('D6b realizado_por_professional_id enviado distinto → PR409', pg_temp.como('own', pg_temp.conf('qa_pres_fact', jsonb_build_array(pg_temp.itt('qa_pres_t10', '2026-12-12', 1000, '{"realizado_por_professional_id":"otro_prof"}')))), 'PR409');
  PERFORM pg_temp.esperar('D6c con los valores correctos → OK', pg_temp.como('own', pg_temp.conf('qa_pres_fact', jsonb_build_array(pg_temp.itt('qa_pres_t10', '2026-12-12', 1000, jsonb_build_object('facturante_professional_id', 'qa_pres_fact', 'realizado_por_professional_id', p))))), '^OK$');
END $t$;

-- D7 permisos: se autoriza sobre el FACTURANTE. Secretaría asociada solo al realizador no presenta lo de otro facturante; sí lo propio; el médico nunca
DO $t$
DECLARE p text;
BEGIN
  SELECT prof INTO p FROM t_act WHERE clave = 'med';
  PERFORM pg_temp.esperar('D7a Secretaría asociada SOLO al realizador no presenta por el facturante → 42501', pg_temp.como('sec', pg_temp.conf('qa_pres_fact', jsonb_build_array(pg_temp.itt('qa_pres_t11', '2026-12-13', 1000)))), '^42501');
  PERFORM pg_temp.esperar('D7b Secretaría asociada presenta lo propio del realizador (sin delegación) → OK', pg_temp.como('sec', pg_temp.conf(p, jsonb_build_array(pg_temp.itt('qa_pres_t12', '2026-12-14', 1000)))), '^OK$');
  PERFORM pg_temp.esperar('D7c el médico no confirma nada → 42501', pg_temp.como('med', pg_temp.conf(p, jsonb_build_array(pg_temp.itt('qa_pres_t8', '2026-12-10', 1000, '{"prestacion":"Holter"}')))), '^42501');
  PERFORM pg_temp.esperar('D7d sin rol → 42501', pg_temp.como('nadie', pg_temp.conf('qa_pres_fact', jsonb_build_array(pg_temp.itt('qa_pres_t11', '2026-12-13', 1000)))), '^42501');
  PERFORM pg_temp.esperar('D7e anon → no ejecuta', pg_temp.como('anon', pg_temp.conf('qa_pres_fact', jsonb_build_array(pg_temp.itt('qa_pres_t11', '2026-12-13', 1000)))), '^42501');
  PERFORM pg_temp.esperar('D7f la atención t11 sigue sin presentar (todo o nada)', (SELECT count(*)::text FROM public.cardiolink_presentaciones_os_items_v1 WHERE atencion_id = 'qa_pres_t11'), '^0$');
END $t$;

-- D8 cambiar o desactivar una delegación NO altera lo ya presentado; solo cambia lo que se presente después
DO $t$
DECLARE p text; antes text; despues text;
BEGIN
  SELECT prof INTO p FROM t_act WHERE clave = 'med';
  SELECT facturante_professional_id INTO antes FROM public.cardiolink_presentaciones_os_items_v1 WHERE atencion_id = 'qa_pres_t1';
  PERFORM pg_temp.esperar('D8a owner cambia el facturante de la delegación (→ qa_pres_fact2)', pg_temp.como('own', format('SELECT public.cardiolink_presentacion_os_delegacion_v1(%L, %L, %L)', p, 'qa_pres_dest', 'qa_pres_fact2')), '^OK$');
  SELECT facturante_professional_id INTO despues FROM public.cardiolink_presentaciones_os_items_v1 WHERE atencion_id = 'qa_pres_t1';
  PERFORM pg_temp.esperar('D8b lo YA presentado conserva su facturante guardado', antes || '=' || despues, '^qa_pres_fact=qa_pres_fact$');
  PERFORM pg_temp.esperar('D8c una atención nueva con ese destino se presenta ahora por el nuevo facturante (por el viejo → PR409; por el nuevo → OK)',
    pg_temp.como('own', pg_temp.conf('qa_pres_fact', jsonb_build_array(pg_temp.itt('qa_pres_t7', '2026-12-09', 1000)))) || '|' || pg_temp.como('own', pg_temp.conf('qa_pres_fact2', jsonb_build_array(pg_temp.itt('qa_pres_t7', '2026-12-09', 1000)))), 'PR409.*\|OK$');
  PERFORM pg_temp.esperar('D8d owner desactiva la delegación', pg_temp.como('own', format('SELECT public.cardiolink_presentacion_os_delegacion_v1(%L, %L, %L, false)', p, 'qa_pres_dest', 'qa_pres_fact2')), '^OK$');
  PERFORM pg_temp.esperar('D8e con la delegación inactiva factura quien realizó (por el facturante → PR409; por quien realizó → OK)',
    pg_temp.como('own', pg_temp.conf('qa_pres_fact2', jsonb_build_array(pg_temp.itt('qa_pres_t8', '2026-12-10', 1000)))) || '|' || pg_temp.como('own', pg_temp.conf(p, jsonb_build_array(pg_temp.itt('qa_pres_t8', '2026-12-10', 1000)))), 'PR409.*\|OK$');
END $t$;

-- D9 lectura (RLS): el facturante y quien realizó ven los ítems; un tercero sin vínculo no; anon nada. La escritura directa sigue cerrada
DO $t$
DECLARE p text; n_med bigint; n_sec bigint; n_own bigint; n_real bigint;
BEGIN
  SELECT prof INTO p FROM t_act WHERE clave = 'med';
  SELECT count(*) INTO n_real FROM public.cardiolink_presentaciones_os_items_v1 WHERE realizado_por_professional_id = p;
  n_own := pg_temp.cuenta_como('own', 'SELECT count(*) FROM public.cardiolink_presentaciones_os_items_v1');
  n_med := pg_temp.cuenta_como('med', 'SELECT count(*) FROM public.cardiolink_presentaciones_os_items_v1');
  n_sec := pg_temp.cuenta_como('sec', 'SELECT count(*) FROM public.cardiolink_presentaciones_os_items_v1');
  PERFORM pg_temp.esperar('D9a owner ve todos los ítems', n_own::text, '^' || (SELECT count(*) FROM public.cardiolink_presentaciones_os_items_v1) || '$');
  PERFORM pg_temp.esperar('D9b el médico que REALIZÓ ve sus ítems aunque los presentó otro (y no los de otros)', n_med::text, '^' || n_real || '$');
  PERFORM pg_temp.esperar('D9c la Secretaría asociada al realizador ve los mismos', n_sec::text, '^' || n_real || '$');
  PERFORM pg_temp.esperar('D9d sin rol no ve ítems; anon no puede leer', pg_temp.cuenta_como('nadie', 'SELECT count(*) FROM public.cardiolink_presentaciones_os_items_v1') || '|' || pg_temp.cuenta_como('anon', 'SELECT count(*) FROM public.cardiolink_presentaciones_os_items_v1'), '^0\|-1$');
  PERFORM pg_temp.esperar('D9e las delegaciones las leen owner/secretaría/médico; anon no', (pg_temp.cuenta_como('own', 'SELECT count(*) FROM public.cardiolink_presentaciones_os_delegaciones_v1') > 0 AND pg_temp.cuenta_como('sec', 'SELECT count(*) FROM public.cardiolink_presentaciones_os_delegaciones_v1') > 0 AND pg_temp.cuenta_como('med', 'SELECT count(*) FROM public.cardiolink_presentaciones_os_delegaciones_v1') > 0 AND pg_temp.cuenta_como('anon', 'SELECT count(*) FROM public.cardiolink_presentaciones_os_delegaciones_v1') = -1)::text, '^true$');
  PERFORM pg_temp.esperar('D9f escritura directa cerrada (ítems y delegaciones) para owner y secretaría',
    pg_temp.como('own', 'DELETE FROM public.cardiolink_presentaciones_os_items_v1') || '|' || pg_temp.como('own', 'UPDATE public.cardiolink_presentaciones_os_items_v1 SET facturante_professional_id = professional_id') || '|' || pg_temp.como('own', 'INSERT INTO public.cardiolink_presentaciones_os_delegaciones_v1 (realiza_professional_id, destino_norm, facturante_professional_id, actualizado_por) VALUES (''a'',''b'',''c'',gen_random_uuid())') || '|' || pg_temp.como('sec', 'DELETE FROM public.cardiolink_presentaciones_os_delegaciones_v1'),
    '^42501.*\|42501.*\|42501.*\|42501');
END $t$;

-- D10 integridad: las atenciones y Caja/Finanzas no se tocaron; trazabilidad completa; sin duplicados; totales coherentes
DO $t$
DECLARE v_mal int;
BEGIN
  PERFORM pg_temp.esperar('D10a ninguna atención sintética fue modificada', (SELECT count(*)::text FROM t_foto f JOIN public.cardiolink_atenciones a ON a.id = f.id WHERE a.payload::text <> f.payload), '^0$');
  PERFORM pg_temp.esperar('D10b la cantidad de atenciones reales no cambió', (SELECT count(*) FROM public.cardiolink_atenciones WHERE id NOT LIKE 'qa\_pres\_%' ESCAPE '\') || '/' || (SELECT n FROM t_n_real), '^(\d+)/\1$');
  SELECT count(*) INTO v_mal FROM public.cardiolink_presentaciones_os_items_v1 WHERE facturante_professional_id <> professional_id OR coalesce(btrim(realizado_por_professional_id), '') = '' OR coalesce(btrim(destino_texto), '') = '' AND realizado_por_professional_id <> facturante_professional_id;
  PERFORM pg_temp.esperar('D10c todo ítem tiene facturante = profesional de la presentación y realizó; los de terceros guardan el texto de destino', v_mal::text, '^0$');
  PERFORM pg_temp.esperar('D10d sin atenciones duplicadas entre presentaciones', (SELECT count(*) - count(DISTINCT atencion_id) FROM public.cardiolink_presentaciones_os_items_v1)::text, '^0$');
  PERFORM pg_temp.esperar('D10e cada cabecera suma lo de sus ítems', (SELECT count(*)::text FROM public.cardiolink_presentaciones_os_v1 p WHERE p.total_importe <> (SELECT coalesce(sum(i.importe_presentado), 0) FROM public.cardiolink_presentaciones_os_items_v1 i WHERE i.presentacion_id = p.id) OR p.cantidad <> (SELECT count(*) FROM public.cardiolink_presentaciones_os_items_v1 i WHERE i.presentacion_id = p.id)), '^0$');
END $t$;
DO $$
DECLARE v_np int;
BEGIN
  IF (SELECT count(*) FROM public.cardiolink_atenciones WHERE id NOT LIKE 'qa\_pres\_%' ESCAPE '\') <> (SELECT n FROM t_n_real) THEN RAISE EXCEPTION 'FALLA R2: cambió la cantidad de atenciones reales'; END IF;
  SELECT count(*) INTO v_np FROM t_res;
  RAISE EXCEPTION 'ENSAYO_ATOMICO_OK: % pruebas pasaron sobre la aplicación atómica base+complemento; se revierte todo (esta EXCEPTION es la señal de éxito)', v_np;
END $$;
