-- CardioLink · Facturación mensual V1 · Bloque 1 · Presentaciones a obras sociales · ENSAYO REVERSIBLE (STAGING). GENERADO por pending_review_facturacion_presentaciones_v1_generar_ensayo.sh: no editar a mano.
-- NO ejecutar en Production. Sin BEGIN/COMMIT: el SQL Editor corre todo en UNA transacción y el script termina SIEMPRE con una EXCEPTION, que revierte todo (tablas, funciones, filas sintéticas qa_pres_* y presentaciones de prueba).
-- RESULTADO ESPERADO: error final "ENSAYO_PRES_OK: N pruebas ..." (es la señal de éxito + rollback). Cualquier otro mensaje "FALLA ..." indica la prueba que no pasó. Deja la base como estaba.
-- Orden: SQL propuesto (precondiciones incluidas) -> pruebas como owner / secretaria asociada / médico / sin rol / anon -> rollback del bloque -> verificación de que no queda nada -> veredicto.
-- NO cubre dos sesiones simultáneas (hace falta otra conexión): la garantía es el índice único por atención, que P2f ejercita con un INSERT directo.
-- ===== SQL propuesto =====
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
-- constructores de la carga (cobertura y prestación fijas; sólo cambian id, fecha, importe y la marca de excepción)
CREATE FUNCTION pg_temp.it(p_id text, p_fecha text, p_importe numeric, p_exc boolean, p_motivo text) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object('atencion_id', p_id, 'fecha_atencion', p_fecha, 'cobertura', 'OSDE', 'prestacion', 'Ecocardiograma', 'importe_presentado', p_importe, 'arancel_id', 'ar1',
                            'patient_id', 'qa_pres_pac', 'patient_name', 'PACIENTE SINTETICO', 'excepcional', p_exc, 'motivo_excepcion', p_motivo)
$f$;
CREATE FUNCTION pg_temp.conf(p_prof text, p_items jsonb, p_periodo text DEFAULT '2026-12') RETURNS text LANGUAGE sql AS $f$
  SELECT format('SELECT public.cardiolink_presentacion_os_confirmar_v1(%L, %L::jsonb)', p_periodo, jsonb_build_array(jsonb_build_object('cobertura', 'OSDE', 'professional_id', p_prof, 'items', p_items))::text)
$f$;
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

-- fixture como postgres: atenciones sintéticas (control sembrado = 2026-12-01)
DO $$
DECLARE p text; mk jsonb;
BEGIN
  SELECT prof INTO p FROM t_act WHERE clave = 'med';
  mk := jsonb_build_object('obraSocial', 'OSDE', 'prestacion', 'Ecocardiograma', 'estadoTurno', 'atendido', 'valorArancelEstimado', 1000, 'arancelId', 'ar1');
  EXECUTE pg_temp.arma_insert('cardiolink_atenciones', jsonb_build_object('id', 'qa_pres_a1', 'payload', (mk || jsonb_build_object('id','qa_pres_a1','fecha','2026-12-03','profesionalId',p))::text));   -- automática (posterior al inicio)
  EXECUTE pg_temp.arma_insert('cardiolink_atenciones', jsonb_build_object('id', 'qa_pres_a2', 'payload', (mk || jsonb_build_object('id','qa_pres_a2','fecha','2026-11-25','profesionalId',p))::text));   -- anterior al inicio (bono pendiente)
  EXECUTE pg_temp.arma_insert('cardiolink_atenciones', jsonb_build_object('id', 'qa_pres_a3', 'payload', (mk || jsonb_build_object('id','qa_pres_a3','fecha','2026-11-26','profesionalId',p))::text));   -- anterior al inicio
  EXECUTE pg_temp.arma_insert('cardiolink_atenciones', jsonb_build_object('id', 'qa_pres_a4', 'payload', (mk || jsonb_build_object('id','qa_pres_a4','fecha','2026-12-04','profesionalId','qa_pres_otroprof'))::text)); -- otro profesional
  EXECUTE pg_temp.arma_insert('cardiolink_atenciones', jsonb_build_object('id', 'qa_pres_a5', 'payload', (mk || jsonb_build_object('id','qa_pres_a5','fecha','2026-12-05','profesionalId',p,'estadoTurno','ausente'))::text));   -- no realizada
  EXECUTE pg_temp.arma_insert('cardiolink_atenciones', jsonb_build_object('id', 'qa_pres_a6', 'payload', (mk || jsonb_build_object('id','qa_pres_a6','fecha','2026-12-05','profesionalId',p,'obraSocial','Particular'))::text)); -- particular
  EXECUTE pg_temp.arma_insert('cardiolink_atenciones', jsonb_build_object('id', 'qa_pres_a7', 'payload', (mk || jsonb_build_object('id','qa_pres_a7','fecha','2027-01-05','profesionalId',p))::text));   -- posterior al período 2026-12
  EXECUTE pg_temp.arma_insert('cardiolink_atenciones', jsonb_build_object('id', 'qa_pres_a8', 'payload', (mk || jsonb_build_object('id','qa_pres_a8','fecha','2026-12-06','profesionalId',p,'valorArancelEstimado',500))::text)); -- arancel fijado 500
  EXECUTE pg_temp.arma_insert('cardiolink_atenciones', jsonb_build_object('id', 'qa_pres_a9', 'payload', (mk || jsonb_build_object('id','qa_pres_a9','fecha','2026-12-07','profesionalId',p))::text));   -- para la prueba de lote parcial
  EXECUTE pg_temp.arma_insert('cardiolink_atenciones', jsonb_build_object('id', 'qa_pres_a13', 'payload', (mk || jsonb_build_object('id','qa_pres_a13','fecha','2026-12-09','profesionalId',p))::text));   -- válida y sin presentar (prueba todo o nada con una sin arancel)
  -- sin arancel válido FIJADO (cierre de incidencias): a10 sin snapshot, a11 con arancelId pero valor 0, a12 con valor pero sin arancelId
  EXECUTE pg_temp.arma_insert('cardiolink_atenciones', jsonb_build_object('id', 'qa_pres_a10', 'payload', ((mk - 'valorArancelEstimado' - 'arancelId') || jsonb_build_object('id','qa_pres_a10','fecha','2026-12-08','profesionalId',p))::text));
  EXECUTE pg_temp.arma_insert('cardiolink_atenciones', jsonb_build_object('id', 'qa_pres_a11', 'payload', (mk || jsonb_build_object('id','qa_pres_a11','fecha','2026-12-08','profesionalId',p,'valorArancelEstimado',0))::text));
  EXECUTE pg_temp.arma_insert('cardiolink_atenciones', jsonb_build_object('id', 'qa_pres_a12', 'payload', ((mk - 'arancelId') || jsonb_build_object('id','qa_pres_a12','fecha','2026-12-08','profesionalId',p))::text));
END $$;
CREATE TEMP TABLE t_foto AS SELECT id, payload::text AS payload FROM public.cardiolink_atenciones WHERE id LIKE 'qa\_pres\_%' ESCAPE '\';
CREATE TEMP TABLE t_n_real AS SELECT count(*) AS n FROM public.cardiolink_atenciones WHERE id NOT LIKE 'qa\_pres\_%' ESCAPE '\';

-- P0 la fecha de inicio quedó sembrada en 2026-12-01 y nadie presentó nada todavía
DO $t$ BEGIN
  PERFORM pg_temp.esperar('P0 control sembrado 2026-12-01 y sin presentaciones', (SELECT fecha_inicio::text FROM public.cardiolink_presentaciones_os_control_v1) || '/' || (SELECT count(*) FROM public.cardiolink_presentaciones_os_items_v1), '^2026-12-01/0$');
END $t$;

-- P1 owner: UNA confirmación con una automática (a1) + una anterior como EXCEPCIÓN (a2): fecha original conservada, marca, motivo, usuario y fecha fijados por el servidor
DO $t$
DECLARE p text; r text; v_it record; v_tot numeric;
BEGIN
  SELECT prof INTO p FROM t_act WHERE clave = 'med';
  r := pg_temp.como('own', pg_temp.conf(p, jsonb_build_array(pg_temp.it('qa_pres_a1', '2026-12-03', 1000, false, NULL), pg_temp.it('qa_pres_a2', '2026-11-25', 1000, true, 'Bono pendiente de presentación'))));
  PERFORM pg_temp.esperar('P1a el owner confirma 1 automática + 1 excepción', r, '^OK$');
  PERFORM pg_temp.esperar('P1b dos ítems guardados; la anterior conserva su fecha original y queda marcada con motivo; la automática no',
    (SELECT string_agg(atencion_id || ':' || fecha_atencion || ':' || excepcional || ':' || coalesce(motivo_excepcion, '-'), ',' ORDER BY atencion_id) FROM public.cardiolink_presentaciones_os_items_v1),
    '^qa_pres_a1:2026-12-03:false:-,qa_pres_a2:2026-11-25:true:Bono pendiente de presentación$');
  SELECT presentado_por, presentado_por_rol, presentado_por_email, presentado_en, total_importe, cantidad INTO v_it FROM public.cardiolink_presentaciones_os_v1 LIMIT 1;
  PERFORM pg_temp.esperar('P1c usuario, rol, email y fecha los fija el servidor; total y cantidad calculados',
    (v_it.presentado_por = (SELECT uid FROM t_act WHERE clave = 'own'))::text || '/' || v_it.presentado_por_rol || '/' || v_it.presentado_por_email || '/' || (abs(extract(epoch FROM now() - v_it.presentado_en)) < 60)::text || '/' || v_it.total_importe || '/' || v_it.cantidad,
    '^true/(owner|admin)/own@qa\.test/true/2000\.00/2$');
END $t$;

-- P2 duplicados: reconfirmar lo mismo (una sesión desactualizada) no duplica ni deja cabeceras huérfanas
DO $t$
DECLARE p text; r text; n_it bigint; n_pr bigint;
BEGIN
  SELECT prof INTO p FROM t_act WHERE clave = 'med';
  SELECT count(*) INTO n_it FROM public.cardiolink_presentaciones_os_items_v1; SELECT count(*) INTO n_pr FROM public.cardiolink_presentaciones_os_v1;
  r := pg_temp.como('own', pg_temp.conf(p, jsonb_build_array(pg_temp.it('qa_pres_a1', '2026-12-03', 1000, false, NULL))));
  PERFORM pg_temp.esperar('P2a reconfirmar una automática ya presentada: 23505', r, '^23505:');
  r := pg_temp.como('own', pg_temp.conf(p, jsonb_build_array(pg_temp.it('qa_pres_a2', '2026-11-25', 1000, true, 'Otro intento'))));
  PERFORM pg_temp.esperar('P2b reconfirmar una EXCEPCIÓN ya presentada: 23505', r, '^23505:');
  PERFORM pg_temp.esperar('P2c nada cambió (ni ítems ni cabeceras)', ((SELECT count(*) FROM public.cardiolink_presentaciones_os_items_v1) = n_it AND (SELECT count(*) FROM public.cardiolink_presentaciones_os_v1) = n_pr)::text, '^true$');
  -- todo o nada: a9 es nueva pero a1 ya estaba presentada -> no se guarda ninguna
  r := pg_temp.como('own', pg_temp.conf(p, jsonb_build_array(pg_temp.it('qa_pres_a9', '2026-12-07', 1000, false, NULL), pg_temp.it('qa_pres_a1', '2026-12-03', 1000, false, NULL))));
  PERFORM pg_temp.esperar('P2d lote con una repetida: 23505', r, '^23505:');
  PERFORM pg_temp.esperar('P2e todo o nada: la nueva (a9) tampoco se guardó', (EXISTS (SELECT 1 FROM public.cardiolink_presentaciones_os_items_v1 WHERE atencion_id = 'qa_pres_a9'))::text, '^false$');
  -- el índice único también frena un INSERT directo como postgres (red de seguridad bajo la RPC)
  BEGIN
    INSERT INTO public.cardiolink_presentaciones_os_items_v1 (presentacion_id, atencion_id, professional_id, cobertura, prestacion, fecha_atencion, importe_presentado)
    SELECT id, 'qa_pres_a1', professional_id, 'OSDE', 'x', DATE '2026-12-03', 1 FROM public.cardiolink_presentaciones_os_v1 LIMIT 1;
    RAISE EXCEPTION 'FALLA P2f: el índice único no frenó el duplicado';
  EXCEPTION WHEN unique_violation THEN INSERT INTO t_res VALUES ('P2f el índice único frena un INSERT directo duplicado'); END;
END $t$;

-- P3 excepciones: una anterior al inicio SIN marca o SIN motivo se rechaza (PR411) y no se guarda nada
DO $t$
DECLARE p text; r text;
BEGIN
  SELECT prof INTO p FROM t_act WHERE clave = 'med';
  r := pg_temp.como('own', pg_temp.conf(p, jsonb_build_array(pg_temp.it('qa_pres_a3', '2026-11-26', 1000, false, NULL))));
  PERFORM pg_temp.esperar('P3a anterior sin marca de excepción: PR411', r, 'PR411');
  r := pg_temp.como('own', pg_temp.conf(p, jsonb_build_array(pg_temp.it('qa_pres_a3', '2026-11-26', 1000, true, '   '))));
  PERFORM pg_temp.esperar('P3b anterior con marca pero sin motivo: PR411', r, 'PR411');
  r := pg_temp.como('own', pg_temp.conf(p, jsonb_build_array(pg_temp.it('qa_pres_a9', '2026-12-07', 1000, false, NULL), pg_temp.it('qa_pres_a3', '2026-11-26', 1000, false, NULL))));
  PERFORM pg_temp.esperar('P3c una automática válida + una anterior sin marca: se rechaza TODO', r, 'PR411');
  PERFORM pg_temp.esperar('P3d no se guardó ni a3 ni a9', (SELECT count(*) FROM public.cardiolink_presentaciones_os_items_v1 WHERE atencion_id IN ('qa_pres_a3', 'qa_pres_a9'))::text, '^0$');
  -- una automática con marca de excepción NO se marca (el servidor decide comparando fechas)
  r := pg_temp.como('own', pg_temp.conf(p, jsonb_build_array(pg_temp.it('qa_pres_a9', '2026-12-07', 1000, true, 'motivo sobrante'))));
  PERFORM pg_temp.esperar('P3e una automática con marca de más se guarda como NO excepcional y sin motivo', r || '/' || (SELECT excepcional || ':' || coalesce(motivo_excepcion, '-') FROM public.cardiolink_presentaciones_os_items_v1 WHERE atencion_id = 'qa_pres_a9'), '^OK/false:-$');
END $t$;

-- P4 revalidación del servidor contra la atención real
DO $t$
DECLARE p text; r text; n0 bigint;
BEGIN
  SELECT prof INTO p FROM t_act WHERE clave = 'med';
  SELECT count(*) INTO n0 FROM public.cardiolink_presentaciones_os_items_v1;
  PERFORM pg_temp.esperar('P4a atención ausente: PR409', pg_temp.como('own', pg_temp.conf(p, jsonb_build_array(pg_temp.it('qa_pres_a5', '2026-12-05', 1000, false, NULL)))), 'PR409');
  PERFORM pg_temp.esperar('P4b cobertura Particular: PR409', pg_temp.como('own', pg_temp.conf(p, jsonb_build_array(pg_temp.it('qa_pres_a6', '2026-12-05', 1000, false, NULL)))), 'PR409');
  PERFORM pg_temp.esperar('P4c posterior al período: PR409', pg_temp.como('own', pg_temp.conf(p, jsonb_build_array(pg_temp.it('qa_pres_a7', '2027-01-05', 1000, false, NULL)))), 'PR409');
  PERFORM pg_temp.esperar('P4d importe distinto del arancel fijado: PR409', pg_temp.como('own', pg_temp.conf(p, jsonb_build_array(pg_temp.it('qa_pres_a8', '2026-12-06', 1000, false, NULL)))), 'PR409');
  PERFORM pg_temp.esperar('P4e fecha que no coincide con la atención: PR409', pg_temp.como('own', pg_temp.conf(p, jsonb_build_array(pg_temp.it('qa_pres_a8', '2026-12-08', 500, false, NULL)))), 'PR409');
  PERFORM pg_temp.esperar('P4f profesional del lote distinto al de la atención: PR409', pg_temp.como('own', pg_temp.conf('qa_pres_otroprof', jsonb_build_array(pg_temp.it('qa_pres_a8', '2026-12-06', 500, false, NULL)))), 'PR409');
  PERFORM pg_temp.esperar('P4g atención inexistente: PR404', pg_temp.como('own', pg_temp.conf(p, jsonb_build_array(pg_temp.it('qa_pres_noexiste', '2026-12-06', 500, false, NULL)))), 'PR404');
  PERFORM pg_temp.esperar('P4h con el importe correcto (500) a8 se presenta', pg_temp.como('own', pg_temp.conf(p, jsonb_build_array(pg_temp.it('qa_pres_a8', '2026-12-06', 500, false, NULL)))), '^OK$');
  PERFORM pg_temp.esperar('P4i las rechazadas no dejaron nada (sólo a8 se sumó)', ((SELECT count(*) FROM public.cardiolink_presentaciones_os_items_v1) - n0)::text, '^1$');
END $t$;

-- P5 permisos por rol y por profesional
DO $t$
DECLARE p text; r text; n0 bigint;
BEGIN
  SELECT prof INTO p FROM t_act WHERE clave = 'med';
  SELECT count(*) INTO n0 FROM public.cardiolink_presentaciones_os_items_v1;
  -- el owner presenta la de OTRO profesional (a4) para probar después que la secretaria no la ve ni la toca
  PERFORM pg_temp.esperar('P5a owner presenta una de otro profesional', pg_temp.como('own', pg_temp.conf('qa_pres_otroprof', jsonb_build_array(pg_temp.it('qa_pres_a4', '2026-12-04', 1000, false, NULL)))), '^OK$');
  -- secretaria asociada: presenta de SU médico como EXCEPCIÓN (a3) y queda registrada como secretaria
  PERFORM pg_temp.esperar('P5b secretaria asociada presenta una excepción de su médico', pg_temp.como('sec', pg_temp.conf(p, jsonb_build_array(pg_temp.it('qa_pres_a3', '2026-11-26', 1000, true, 'Bono pendiente (secretaría)')))), '^OK$');
  PERFORM pg_temp.esperar('P5c queda registrada con rol secretaria', (SELECT presentado_por_rol FROM public.cardiolink_presentaciones_os_v1 pr JOIN public.cardiolink_presentaciones_os_items_v1 i ON i.presentacion_id = pr.id WHERE i.atencion_id = 'qa_pres_a3'), '^secretaria$');
  PERFORM pg_temp.esperar('P5d la secretaria NO puede presentar de un profesional no asociado: 42501', pg_temp.como('sec', pg_temp.conf('qa_pres_otroprof', jsonb_build_array(pg_temp.it('qa_pres_a4', '2026-12-04', 1000, false, NULL)))), '^42501:');
  PERFORM pg_temp.esperar('P5e el médico NO confirma (ni lo suyo): 42501', pg_temp.como('med', pg_temp.conf(p, jsonb_build_array(pg_temp.it('qa_pres_a9', '2026-12-07', 1000, false, NULL)))), '^42501:');
  PERFORM pg_temp.esperar('P5f usuario sin rol: 42501', pg_temp.como('nadie', pg_temp.conf(p, jsonb_build_array(pg_temp.it('qa_pres_a9', '2026-12-07', 1000, false, NULL)))), '^42501:');
  PERFORM pg_temp.esperar('P5g anon no puede ejecutar la RPC', pg_temp.como('anon', pg_temp.conf(p, jsonb_build_array(pg_temp.it('qa_pres_a9', '2026-12-07', 1000, false, NULL)))), '^42501:');
  -- lectura (RLS por profesional)
  PERFORM pg_temp.esperar('P5h owner ve todo', pg_temp.cuenta_como('own', 'SELECT count(*) FROM public.cardiolink_presentaciones_os_items_v1')::text, '^' || (SELECT count(*) FROM public.cardiolink_presentaciones_os_items_v1) || '$');
  PERFORM pg_temp.esperar('P5i secretaria asociada ve sólo lo de su médico (no la de otro profesional)', pg_temp.cuenta_como('sec', 'SELECT count(*) FROM public.cardiolink_presentaciones_os_items_v1 WHERE professional_id = ''qa_pres_otroprof''')::text || '/' ||
    (pg_temp.cuenta_como('sec', format('SELECT count(*) FROM public.cardiolink_presentaciones_os_items_v1 WHERE professional_id = %L', p)) > 0)::text, '^0/true$');
  PERFORM pg_temp.esperar('P5j el médico ve sólo lo suyo', pg_temp.cuenta_como('med', 'SELECT count(*) FROM public.cardiolink_presentaciones_os_items_v1 WHERE professional_id <> (SELECT prof FROM t_act WHERE clave = ''med'')')::text, '^0$');
  PERFORM pg_temp.esperar('P5k usuario sin rol no ve nada', pg_temp.cuenta_como('nadie', 'SELECT count(*) FROM public.cardiolink_presentaciones_os_items_v1')::text, '^0$');
  PERFORM pg_temp.esperar('P5l anon no puede leer', pg_temp.cuenta_como('anon', 'SELECT count(*) FROM public.cardiolink_presentaciones_os_items_v1')::text, '^-1$');
  PERFORM pg_temp.esperar('P5m la cabecera sigue la misma regla (secretaria: nada de otro profesional)', pg_temp.cuenta_como('sec', 'SELECT count(*) FROM public.cardiolink_presentaciones_os_v1 WHERE professional_id = ''qa_pres_otroprof''')::text, '^0$');
  -- sin escritura directa
  PERFORM pg_temp.esperar('P5n el owner NO puede insertar directo', pg_temp.como('own', 'INSERT INTO public.cardiolink_presentaciones_os_items_v1 (presentacion_id, atencion_id, professional_id, cobertura, prestacion, fecha_atencion, importe_presentado) SELECT id, ''qa_pres_x'', professional_id, ''OSDE'', ''x'', DATE ''2026-12-01'', 1 FROM public.cardiolink_presentaciones_os_v1 LIMIT 1'), '^42501:');
  PERFORM pg_temp.esperar('P5o ni actualizar', pg_temp.como('own', 'UPDATE public.cardiolink_presentaciones_os_items_v1 SET importe_presentado = 1'), '^42501:');
  PERFORM pg_temp.esperar('P5p ni borrar', pg_temp.como('own', 'DELETE FROM public.cardiolink_presentaciones_os_items_v1'), '^42501:');
  PERFORM pg_temp.esperar('P5q ni tocar la cabecera', pg_temp.como('own', 'UPDATE public.cardiolink_presentaciones_os_v1 SET total_importe = 1'), '^42501:');
END $t$;

-- P6 fecha de control: sólo owner/admin la cambia
DO $t$
BEGIN
  PERFORM pg_temp.esperar('P6a secretaria no cambia la fecha de control: 42501', pg_temp.como('sec', 'SELECT public.cardiolink_presentacion_os_control_v1(DATE ''2026-11-01'')'), '^42501:');
  PERFORM pg_temp.esperar('P6b el médico tampoco: 42501', pg_temp.como('med', 'SELECT public.cardiolink_presentacion_os_control_v1(DATE ''2026-11-01'')'), '^42501:');
  PERFORM pg_temp.esperar('P6c el owner sí', pg_temp.como('own', 'SELECT public.cardiolink_presentacion_os_control_v1(DATE ''2026-12-01'')'), '^OK$');
  PERFORM pg_temp.esperar('P6d fecha fuera de rango: 22023', pg_temp.como('own', 'SELECT public.cardiolink_presentacion_os_control_v1(DATE ''2010-01-01'')'), '^22023:');
  PERFORM pg_temp.esperar('P6e la fecha de control sigue en 2026-12-01', (SELECT fecha_inicio::text FROM public.cardiolink_presentaciones_os_control_v1), '^2026-12-01$');
END $t$;

-- P8 cierre de incidencias: (1) el médico LEE la fecha de control pero no la escribe ni confirma; (2) sin arancel válido FIJADO la RPC rechaza (PR412) aunque el cliente mande un importe
DO $t$
DECLARE p text; n0 bigint;
BEGIN
  SELECT prof INTO p FROM t_act WHERE clave = 'med';
  PERFORM pg_temp.esperar('P8a el médico lee la fecha de control', pg_temp.cuenta_como('med', 'SELECT count(*) FROM public.cardiolink_presentaciones_os_control_v1')::text, '^1$');
  PERFORM pg_temp.esperar('P8b el owner y la secretaria siguen leyéndola', pg_temp.cuenta_como('own', 'SELECT count(*) FROM public.cardiolink_presentaciones_os_control_v1')::text || pg_temp.cuenta_como('sec', 'SELECT count(*) FROM public.cardiolink_presentaciones_os_control_v1')::text, '^11$');
  PERFORM pg_temp.esperar('P8c un usuario sin rol y anon siguen sin leerla', pg_temp.cuenta_como('nadie', 'SELECT count(*) FROM public.cardiolink_presentaciones_os_control_v1')::text || '/' || pg_temp.cuenta_como('anon', 'SELECT count(*) FROM public.cardiolink_presentaciones_os_control_v1')::text, '^0/-1$');
  PERFORM pg_temp.esperar('P8d el médico NO escribe la fecha de control (ni directo ni por RPC)', pg_temp.como('med', 'UPDATE public.cardiolink_presentaciones_os_control_v1 SET fecha_inicio = DATE ''2026-01-01''') || '/' || pg_temp.como('med', 'SELECT public.cardiolink_presentacion_os_control_v1(DATE ''2026-11-01'')'), '^42501:.*/42501:');
  PERFORM pg_temp.esperar('P8e el médico sigue sin confirmar', pg_temp.como('med', pg_temp.conf(p, jsonb_build_array(pg_temp.it('qa_pres_a9', '2026-12-07', 1000, false, NULL)))), '^42501:');
  SELECT count(*) INTO n0 FROM public.cardiolink_presentaciones_os_items_v1;
  PERFORM pg_temp.esperar('P8f sin arancel fijado (a10) con importe del cliente: PR412', pg_temp.como('own', pg_temp.conf(p, jsonb_build_array(pg_temp.it('qa_pres_a10', '2026-12-08', 1000, false, NULL)))), 'PR412');
  PERFORM pg_temp.esperar('P8g arancelId con valor 0 (a11): PR412', pg_temp.como('own', pg_temp.conf(p, jsonb_build_array(pg_temp.it('qa_pres_a11', '2026-12-08', 1000, false, NULL)))), 'PR412');
  PERFORM pg_temp.esperar('P8h valor sin arancelId (a12): PR412', pg_temp.como('own', pg_temp.conf(p, jsonb_build_array(pg_temp.it('qa_pres_a12', '2026-12-08', 1000, false, NULL)))), 'PR412');
  PERFORM pg_temp.esperar('P8i tampoco con importe mínimo ni con la secretaria asociada', pg_temp.como('sec', pg_temp.conf(p, jsonb_build_array(pg_temp.it('qa_pres_a10', '2026-12-08', 1, false, NULL)))), 'PR412');
  PERFORM pg_temp.esperar('P8j todo o nada: una válida + una sin arancel fijado no guarda ninguna', pg_temp.como('own', pg_temp.conf(p, jsonb_build_array(pg_temp.it('qa_pres_a13', '2026-12-09', 1000, false, NULL), pg_temp.it('qa_pres_a10', '2026-12-08', 1000, false, NULL)))), 'PR412');
  PERFORM pg_temp.esperar('P8k no se guardó nada', ((SELECT count(*) FROM public.cardiolink_presentaciones_os_items_v1) - n0)::text, '^0$');
  PERFORM pg_temp.esperar('P8l el arancel_id guardado sale de la atención (ar1)', (SELECT arancel_id FROM public.cardiolink_presentaciones_os_items_v1 WHERE atencion_id = 'qa_pres_a1'), '^ar1$');
END $t$;

-- P7 las atenciones NO se modificaron (ni la fecha de producción) y no se tocó ninguna atención real
DO $t$
BEGIN
  PERFORM pg_temp.esperar('P7a las atenciones sintéticas quedaron idénticas (id y payload completo, incluida la fecha)', (SELECT count(*) FROM public.cardiolink_atenciones a JOIN t_foto f ON f.id = a.id AND f.payload = a.payload::text)::text || '/' || (SELECT count(*) FROM t_foto), '^' || (SELECT count(*) FROM t_foto) || '/' || (SELECT count(*) FROM t_foto) || '$');
  PERFORM pg_temp.esperar('P7b la cantidad de atenciones reales no cambió', (SELECT count(*) FROM public.cardiolink_atenciones WHERE id NOT LIKE 'qa\_pres\_%' ESCAPE '\')::text, '^' || (SELECT n FROM t_n_real) || '$');
  PERFORM pg_temp.esperar('P7c cada ítem presentado conserva la fecha de producción de su atención', (SELECT count(*) FROM public.cardiolink_presentaciones_os_items_v1 i JOIN public.cardiolink_atenciones a ON a.id = i.atencion_id WHERE left(a.payload ->> 'fecha', 10) <> i.fecha_atencion::text)::text, '^0$');
  PERFORM pg_temp.esperar('P7d integridad: cada cabecera suma y cuenta lo que dicen sus ítems', (SELECT count(*) FROM public.cardiolink_presentaciones_os_v1 p WHERE p.total_importe <> (SELECT sum(importe_presentado) FROM public.cardiolink_presentaciones_os_items_v1 i WHERE i.presentacion_id = p.id) OR p.cantidad <> (SELECT count(*) FROM public.cardiolink_presentaciones_os_items_v1 i WHERE i.presentacion_id = p.id))::text, '^0$');
  PERFORM pg_temp.esperar('P7e las excepciones guardadas son las esperadas (a2 y a3) y todas con motivo', (SELECT string_agg(atencion_id, ',' ORDER BY atencion_id) FROM public.cardiolink_presentaciones_os_items_v1 WHERE excepcional AND btrim(motivo_excepcion) <> ''), '^qa_pres_a2,qa_pres_a3$');
END $t$;
-- ===== ROLLBACK del bloque =====
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
DECLARE v_np int;
BEGIN
  IF to_regclass('public.cardiolink_presentaciones_os_v1') IS NOT NULL OR to_regclass('public.cardiolink_presentaciones_os_items_v1') IS NOT NULL OR to_regclass('public.cardiolink_presentaciones_os_control_v1') IS NOT NULL
     OR to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb)') IS NOT NULL OR to_regprocedure('public.cardiolink_presentacion_os_control_v1(date)') IS NOT NULL
     OR to_regprocedure('public.cardiolink_presentacion_os_ver_v1(text)') IS NOT NULL OR to_regprocedure('public.cardiolink_presentacion_os_confirmar_permitido_v1(text)') IS NOT NULL THEN
    RAISE EXCEPTION 'FALLA R1: tras el rollback quedaron objetos del bloque'; END IF;
  IF (SELECT count(*) FROM public.cardiolink_atenciones WHERE id NOT LIKE 'qa\_pres\_%' ESCAPE '\') <> (SELECT n FROM t_n_real) THEN RAISE EXCEPTION 'FALLA R2: cambió la cantidad de atenciones reales'; END IF;
  SELECT count(*) INTO v_np FROM t_res;
  RAISE EXCEPTION 'ENSAYO_PRES_OK: % pruebas pasaron, el rollback del bloque dejó todo como estaba y se revierte todo (esta EXCEPTION es la señal de éxito)', v_np;
END $$;
