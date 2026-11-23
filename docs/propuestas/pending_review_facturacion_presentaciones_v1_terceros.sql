-- CardioLink · FACTURACIÓN MENSUAL V1 · BLOQUE 1 · COMPLEMENTO · FACTURACIÓN POR TERCEROS (estudios realizados por un profesional y facturados por otro)
-- *** SQL PROPUESTO · NO aplicado en STAGING ni en Production. Ensayado solo en un PostgreSQL local simulado y por su ensayo reversible (ver _terceros_ensayo_reversible.sql). ***
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

BEGIN;

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

COMMIT;
