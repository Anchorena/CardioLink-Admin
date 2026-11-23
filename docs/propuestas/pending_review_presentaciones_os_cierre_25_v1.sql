-- CardioLink · PRESENTACIONES A OBRAS SOCIALES · CIERRE DEL CÍRCULO MÉDICO (día 25) · fecha de corte y fecha efectiva de presentación
-- *** SQL PROPUESTO · NO aplicado en STAGING ni en Production. Se ensaya con ..._cierre_25_v1_ensayo_reversible.sql (transacción con ROLLBACK). ***
-- NO EJECUTAR sin autorización explícita ni checks previos de solo lectura (..._cierre_25_v1_checks.sql). No está en supabase/migrations a propósito.
-- Se aplica DESPUÉS del bloque base y del complemento de terceros (o después de pending_review_facturacion_presentaciones_v1_APLICACION_ATOMICA.sql). Una sola transacción: si algo falla, se revierte todo.
--
-- QUÉ AGREGA (mínimo y aditivo)
--   * 2 columnas NULLABLE en la cabecera cardiolink_presentaciones_os_v1: fecha_corte (date) y fecha_presentacion (date). Las presentaciones ya registradas NO se tocan (quedan NULL: no se inventa una fecha histórica).
--   * La RPC cardiolink_presentacion_os_confirmar_v1 pasa de (text, jsonb) a (text, jsonb, date DEFAULT NULL, date DEFAULT NULL): p_fecha_corte y p_fecha_presentacion.
--       - Llamada vieja de 2 argumentos (cliente sin actualizar): MISMO comportamiento de antes (corte = último día del mes del período; fecha de presentación = hoy; sin otros controles nuevos).
--       - p_fecha_corte: debe caer dentro del mes del período (PR413). Una prestación posterior a la fecha de corte se rechaza (PR409, como antes con el fin de mes).
--       - p_fecha_presentacion: no puede ser futura y ninguna prestación puede ser posterior a ella (PR414). Es la fecha EFECTIVA que elige quien confirma; presentado_en sigue siendo el instante real del registro.
--   * Tres fechas separadas: fecha de la atención (copia en cada ítem, no se modifica), período (AAAA-MM) y fecha efectiva de presentación. No cambia ningún permiso, política, índice (el único por atención sigue evitando duplicados) ni tabla de ítems.
--   * El resto de la RPC es IDÉNTICO a la del complemento de terceros (derivación del facturante, permisos, arancel fijado PR412, excepciones PR411, importes PR409).
-- Rollback: ..._cierre_25_v1_rollback.sql (vuelve a la RPC de 2 argumentos y quita las 2 columnas: exportar antes si ya hay presentaciones con esas fechas).

BEGIN;

-- ===== 0) Precondiciones =====
DO $$
BEGIN
  IF to_regclass('public.cardiolink_presentaciones_os_v1') IS NULL OR to_regclass('public.cardiolink_presentaciones_os_delegaciones_v1') IS NULL THEN
    RAISE EXCEPTION 'Precondición: falta aplicar antes el bloque base y el complemento de terceros (o el SQL atómico)'; END IF;
  IF to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'Precondición: falta la RPC de confirmación de 2 argumentos'; END IF;
  IF coalesce(pg_get_functiondef(to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb)')), '') NOT LIKE '%delegaciones_v1%'
     OR coalesce(pg_get_functiondef(to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb)')), '') NOT LIKE '%PR412%' THEN
    RAISE EXCEPTION 'Precondición: la RPC actual no es la del complemento de terceros con PR412'; END IF;
  IF to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb,date,date)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'cardiolink_presentaciones_os_v1' AND column_name IN ('fecha_corte', 'fecha_presentacion')) THEN
    RAISE EXCEPTION 'El cierre del día 25 ya está aplicado (o parcialmente): no se repite'; END IF;
END $$;

-- ===== 1) Columnas nuevas (nullable: lo ya registrado no se toca) =====
ALTER TABLE public.cardiolink_presentaciones_os_v1 ADD COLUMN fecha_corte date NULL, ADD COLUMN fecha_presentacion date NULL;

-- ===== 2) RPC de confirmación con fecha de corte y fecha efectiva de presentación =====
DROP FUNCTION public.cardiolink_presentacion_os_confirmar_v1(text, jsonb);
CREATE FUNCTION public.cardiolink_presentacion_os_confirmar_v1(p_periodo text, p_lotes jsonb, p_fecha_corte date DEFAULT NULL, p_fecha_presentacion date DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $f$
DECLARE
  v_uid uuid := auth.uid();
  v_rol text := (SELECT public.cardiolink_ctx_rol_v1());
  v_email text := coalesce(nullif(auth.jwt() ->> 'email', ''), '');
  v_ctrl date; v_fin date; v_corte date; v_fpres date;
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
  -- Cierre del Círculo: la fecha de corte (si se informa) debe estar dentro del mes del período; sin ella, el fin de mes (comportamiento anterior).
  IF p_fecha_corte IS NOT NULL THEN
    IF to_char(p_fecha_corte, 'YYYY-MM') <> p_periodo THEN RAISE EXCEPTION 'PR413: la fecha de corte debe estar dentro del mes del período' USING ERRCODE = '22023'; END IF;
    v_corte := p_fecha_corte; v_fin := p_fecha_corte;
  ELSE v_corte := v_fin; END IF;
  -- Fecha EFECTIVA de presentación (si se informa): no futura; ninguna prestación puede ser posterior a ella. Sin ella, hoy (comportamiento anterior, sin control de las fechas de las prestaciones).
  IF p_fecha_presentacion IS NOT NULL AND p_fecha_presentacion > current_date THEN
    RAISE EXCEPTION 'PR414: la fecha de presentación no puede ser futura' USING ERRCODE = '22023'; END IF;
  v_fpres := coalesce(p_fecha_presentacion, current_date);

  FOR v_lote IN SELECT value FROM jsonb_array_elements(p_lotes) LOOP
    v_prof := btrim(coalesce(v_lote ->> 'professional_id', ''));
    v_cob := btrim(coalesce(v_lote ->> 'cobertura', ''));
    IF v_prof = '' OR v_cob = '' OR jsonb_typeof(v_lote -> 'items') <> 'array' OR jsonb_array_length(v_lote -> 'items') NOT BETWEEN 1 AND 2000 THEN
      RAISE EXCEPTION 'PR400: lote inválido' USING ERRCODE = '22023'; END IF;
    IF NOT public.cardiolink_presentacion_os_confirmar_permitido_v1(v_prof) THEN
      RAISE EXCEPTION 'PR403: sin permiso para presentar prestaciones de este profesional' USING ERRCODE = '42501'; END IF;
    SELECT count(*), coalesce(sum(round((e ->> 'importe_presentado')::numeric, 2)), 0) INTO v_n, v_total FROM jsonb_array_elements(v_lote -> 'items') e;
    IF v_total <= 0 THEN RAISE EXCEPTION 'PR400: importe inválido' USING ERRCODE = '22023'; END IF;

    INSERT INTO public.cardiolink_presentaciones_os_v1 (cobertura, professional_id, periodo, cantidad, total_importe, presentado_por, presentado_por_email, presentado_por_rol, fecha_corte, fecha_presentacion)
    VALUES (v_cob, v_prof, p_periodo, v_n, v_total, v_uid, v_email, v_rol, v_corte, v_fpres) RETURNING id INTO v_pres;

    FOR v_item IN SELECT value FROM jsonb_array_elements(v_lote -> 'items') LOOP
      SELECT payload INTO v_pl FROM public.cardiolink_atenciones WHERE id = btrim(coalesce(v_item ->> 'atencion_id', '')) AND id <> '__cardiolink_config_v1';
      IF v_pl IS NULL THEN RAISE EXCEPTION 'PR404: la atención no existe' USING ERRCODE = 'P0002'; END IF;
      v_f := (v_item ->> 'fecha_atencion')::date;
      v_importe := round((v_item ->> 'importe_presentado')::numeric, 2);
      v_cob_item := lower(btrim(coalesce(v_item ->> 'cobertura', '')));
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
      IF p_fecha_presentacion IS NOT NULL AND v_f > v_fpres THEN
        RAISE EXCEPTION 'PR414: la prestación es posterior a la fecha de presentación' USING ERRCODE = '22023'; END IF;
      v_exc := v_f < v_ctrl;
      v_motivo := nullif(btrim(coalesce(v_item ->> 'motivo_excepcion', '')), '');
      IF v_exc AND (coalesce(v_item ->> 'excepcional', '') <> 'true' OR v_motivo IS NULL) THEN
        RAISE EXCEPTION 'PR411: una prestación anterior al inicio del control solo se presenta como excepción, con motivo' USING ERRCODE = 'P0001'; END IF;
      IF NOT v_exc THEN v_motivo := NULL; END IF;
      IF lower(coalesce(v_pl ->> 'estadoTurno', v_pl ->> 'estado', '')) IN ('ausente', 'cancelado') THEN
        RAISE EXCEPTION 'PR409: la atención no fue realizada' USING ERRCODE = 'P0001'; END IF;
      IF v_importe <= 0 THEN RAISE EXCEPTION 'PR400: importe inválido' USING ERRCODE = '22023'; END IF;
      v_val := CASE WHEN (v_pl ->> 'valorArancelEstimado') ~ '^\d+(\.\d+)?$' THEN (v_pl ->> 'valorArancelEstimado')::numeric ELSE NULL END;
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
REVOKE ALL ON FUNCTION public.cardiolink_presentacion_os_confirmar_v1(text, jsonb, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cardiolink_presentacion_os_confirmar_v1(text, jsonb, date, date) TO authenticated;

-- ===== 3) Postcondiciones =====
DO $$
BEGIN
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'cardiolink_presentaciones_os_v1' AND column_name IN ('fecha_corte', 'fecha_presentacion') AND is_nullable = 'YES' AND data_type = 'date') <> 2 THEN
    RAISE EXCEPTION 'FALLA: las 2 columnas de fechas deben existir y ser nullable'; END IF;
  IF to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb)') IS NOT NULL THEN RAISE EXCEPTION 'FALLA: quedó la RPC de 2 argumentos (ambigua con la nueva)'; END IF;
  IF to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb,date,date)') IS NULL THEN RAISE EXCEPTION 'FALLA: falta la RPC nueva'; END IF;
  IF has_function_privilege('anon', 'public.cardiolink_presentacion_os_confirmar_v1(text,jsonb,date,date)', 'EXECUTE') OR NOT has_function_privilege('authenticated', 'public.cardiolink_presentacion_os_confirmar_v1(text,jsonb,date,date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FALLA: privilegios de la RPC (anon sin acceso; authenticated sí)'; END IF;
  IF has_table_privilege('authenticated', 'public.cardiolink_presentaciones_os_v1', 'INSERT') OR has_table_privilege('authenticated', 'public.cardiolink_presentaciones_os_v1', 'UPDATE') OR has_table_privilege('anon', 'public.cardiolink_presentaciones_os_v1', 'SELECT') THEN
    RAISE EXCEPTION 'FALLA: la cabecera sigue siendo solo lectura para authenticated y sin acceso para anon'; END IF;
  IF coalesce(pg_get_functiondef(to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb,date,date)')), '') NOT LIKE '%PR413%'
     OR coalesce(pg_get_functiondef(to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb,date,date)')), '') NOT LIKE '%PR414%'
     OR coalesce(pg_get_functiondef(to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb,date,date)')), '') NOT LIKE '%delegaciones_v1%'
     OR coalesce(pg_get_functiondef(to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb,date,date)')), '') NOT LIKE '%PR412%' THEN
    RAISE EXCEPTION 'FALLA: la RPC nueva no conserva delegaciones y PR412 o no incluye PR413/PR414'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'cardiolink_presentaciones_os_items_atencion_uq' AND indexdef ILIKE '%UNIQUE%(atencion_id)%') THEN
    RAISE EXCEPTION 'FALLA: falta el índice único por atención (anti-duplicados)'; END IF;
  IF EXISTS (SELECT 1 FROM public.cardiolink_presentaciones_os_v1 WHERE fecha_corte IS NOT NULL OR fecha_presentacion IS NOT NULL) THEN
    RAISE EXCEPTION 'FALLA: las presentaciones ya registradas no deben tener fechas inventadas'; END IF;
END $$;

COMMIT;
