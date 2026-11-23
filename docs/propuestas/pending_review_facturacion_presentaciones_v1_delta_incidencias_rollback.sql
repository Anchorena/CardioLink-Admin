-- CardioLink · Presentaciones OS V1 · ROLLBACK del DELTA de cierre de incidencias: vuelve la política del control (sin médico) y la RPC a su versión anterior (sin PR412).
-- NO EJECUTADO. No toca datos. Una transacción.
BEGIN;
ALTER POLICY cardiolink_presentaciones_os_control_select ON public.cardiolink_presentaciones_os_control_v1
  USING ((SELECT public.cardiolink_ctx_rol_v1()) IN ('owner', 'admin', 'secretaria'));

CREATE OR REPLACE FUNCTION public.cardiolink_presentacion_os_confirmar_v1(p_periodo text, p_lotes jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $f$
DECLARE
  v_uid uuid := auth.uid();
  v_rol text := (SELECT public.cardiolink_ctx_rol_v1());
  v_email text := coalesce(nullif(auth.jwt() ->> 'email', ''), '');
  v_ctrl date; v_fin date;
  v_lote jsonb; v_item jsonb; v_pl jsonb; v_pres uuid;
  v_prof text; v_cob text; v_n int; v_total numeric; v_f date; v_importe numeric; v_cob_item text; v_exc boolean; v_motivo text; v_dif boolean;
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
      -- Si la atención tiene el arancel FIJADO (snapshot), el importe presentado debe ser ese. (Se calcula en una asignación: un CASE ... THEN dentro de un IF ... THEN rompe el parser de plpgsql.)
      v_dif := coalesce(v_pl ->> 'arancelId', '') <> '' AND CASE WHEN (v_pl ->> 'valorArancelEstimado') ~ '^\d+(\.\d+)?$'
                                                                  THEN abs((v_pl ->> 'valorArancelEstimado')::numeric - v_importe) > 0.01 ELSE false END;   -- CASE: el cast solo se evalúa si el texto es numérico
      IF v_dif THEN RAISE EXCEPTION 'PR409: el importe no coincide con el arancel fijado en la atención' USING ERRCODE = 'P0001'; END IF;

      INSERT INTO public.cardiolink_presentaciones_os_items_v1 (presentacion_id, atencion_id, professional_id, cobertura, prestacion, fecha_atencion, importe_presentado, arancel_id, patient_id, patient_name, excepcional, motivo_excepcion)
      VALUES (v_pres, btrim(v_item ->> 'atencion_id'), v_prof, btrim(v_item ->> 'cobertura'), btrim(coalesce(nullif(v_item ->> 'prestacion', ''), v_pl ->> 'prestacion', 'Prestación')), v_f, v_importe,
              nullif(btrim(coalesce(v_item ->> 'arancel_id', '')), ''), nullif(btrim(coalesce(v_item ->> 'patient_id', '')), ''), nullif(btrim(coalesce(v_item ->> 'patient_name', '')), ''), v_exc, v_motivo);
      -- (un atencion_id ya presentado dispara unique_violation 23505 y revierte TODA la confirmación)
    END LOOP;
    v_ids := v_ids || to_jsonb(v_pres); v_items := v_items + v_n; v_suma := v_suma + v_total;
  END LOOP;
  RETURN jsonb_build_object('presentaciones', v_ids, 'items', v_items, 'total', v_suma);
END
$f$;

DO $$
BEGIN
  IF pg_get_functiondef('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb)'::regprocedure) LIKE '%PR412%' THEN RAISE EXCEPTION 'FALLA: la RPC sigue con PR412'; END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'cardiolink_presentaciones_os_control_select' AND qual LIKE '%medico%') THEN RAISE EXCEPTION 'FALLA: la política sigue incluyendo al médico'; END IF;
END $$;
COMMIT;
