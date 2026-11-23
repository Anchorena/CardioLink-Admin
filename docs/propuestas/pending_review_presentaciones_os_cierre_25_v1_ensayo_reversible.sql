-- CardioLink · Presentaciones OS · CIERRE DEL DÍA 25 · ENSAYO REVERSIBLE (STAGING). GENERADO por pending_review_presentaciones_os_cierre_25_v1_generar_ensayo.sh: no editar a mano.
-- NO ejecutar en Production. Sin BEGIN/COMMIT: se corre en UNA transacción y termina SIEMPRE con una EXCEPTION que revierte todo (el SQL del cierre, las filas sintéticas qa_pres_*, la fecha de control y la asociación activada para el ensayo).
-- RESULTADO ESPERADO: error final "ENSAYO_CIERRE25_OK: N pruebas ..." (señal de éxito + rollback). Cualquier "FALLA ..." indica la prueba que no pasó. Deja la base como estaba.
-- Orden: actores y ayudas -> SQL del cierre (con sus precondiciones) -> pruebas -> rollback del cierre -> verificación de que quedó el estado del complemento de terceros -> veredicto.
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

-- ===== SQL del cierre del día 25 =====
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

-- ===== PRUEBAS del CIERRE DEL DÍA 25 (como cada usuario real, vía claims + SET LOCAL ROLE; todo sintético qa_pres_*) =====
-- Se ejecutan DESPUÉS de pending_review_presentaciones_os_cierre_25_v1.sql y ANTES del ENSAYO final, dentro de la MISMA transacción, que termina SIEMPRE con una EXCEPTION (revierte todo).
-- Las fechas son relativas a hoy (un mes ya cerrado M = el mes anterior al actual) para que el ensayo se pueda repetir cualquier día. Antes del ensayo se registra una foto de las presentaciones reales (no deben cambiar).
CREATE TEMP TABLE t_fx AS SELECT to_char(date_trunc('month', current_date) - interval '1 month', 'YYYY-MM') AS m, to_char(date_trunc('month', current_date) - interval '2 months', 'YYYY-MM') AS pm,
  to_char((date_trunc('month', current_date) - interval '1 month' + interval '1 month - 1 day')::date, 'YYYY-MM-DD') AS fin_m, to_char(current_date, 'YYYY-MM-DD') AS hoy;
CREATE FUNCTION pg_temp.fx(p_k text) RETURNS text LANGUAGE sql AS $f$
  SELECT CASE p_k WHEN 'm' THEN m WHEN 'pm' THEN pm WHEN 'fin' THEN fin_m WHEN 'hoy' THEN hoy ELSE NULL END FROM t_fx
$f$;
CREATE FUNCTION pg_temp.itc(p_id text, p_fecha text, p_importe numeric DEFAULT 1000) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object('atencion_id', p_id, 'fecha_atencion', p_fecha, 'cobertura', 'OSDE', 'prestacion', 'Holter', 'importe_presentado', p_importe, 'arancel_id', 'ar1',
                            'patient_id', 'qa_pres_pac', 'patient_name', 'PACIENTE SINTETICO', 'excepcional', false, 'motivo_excepcion', null)
$f$;
-- llamada de 2 argumentos (cliente viejo) y de 4 argumentos (cierre del día 25)
CREATE FUNCTION pg_temp.c2(p_prof text, p_periodo text, p_items jsonb) RETURNS text LANGUAGE sql AS $f$
  SELECT format('SELECT public.cardiolink_presentacion_os_confirmar_v1(%L, %L::jsonb)', p_periodo, jsonb_build_array(jsonb_build_object('cobertura', 'OSDE', 'professional_id', p_prof, 'items', p_items))::text)
$f$;
CREATE FUNCTION pg_temp.c4(p_prof text, p_periodo text, p_items jsonb, p_corte text, p_fpres text) RETURNS text LANGUAGE sql AS $f$
  SELECT format('SELECT public.cardiolink_presentacion_os_confirmar_v1(%L, %L::jsonb, %L::date, %L::date)', p_periodo, jsonb_build_array(jsonb_build_object('cobertura', 'OSDE', 'professional_id', p_prof, 'items', p_items))::text, p_corte, p_fpres)
$f$;
CREATE TEMP TABLE t_pres_reales AS SELECT count(*) AS n, count(*) FILTER (WHERE fecha_corte IS NOT NULL OR fecha_presentacion IS NOT NULL) AS con_fechas FROM public.cardiolink_presentaciones_os_v1;

-- fixture como postgres. Fechas: pm-25 (pendiente de un período anterior), pm-26 (primer día del período M), M-10, M-24, M-25 (corte habitual), M-26, M-27 (posteriores al corte habitual).
DO $$
DECLARE p text; mk jsonb; m text := pg_temp.fx('m'); pm text := pg_temp.fx('pm');
BEGIN
  SELECT prof INTO p FROM t_act WHERE clave = 'med';
  mk := jsonb_build_object('obraSocial', 'OSDE', 'prestacion', 'Holter', 'estadoTurno', 'atendido', 'valorArancelEstimado', 1000, 'arancelId', 'ar1', 'prestacionA', '', 'profesionalId', p);
  EXECUTE pg_temp.arma_insert('cardiolink_atenciones', jsonb_build_object('id', 'qa_pres_c1', 'payload', (mk || jsonb_build_object('id','qa_pres_c1','fecha', pm || '-25'))::text));     -- pendiente de un período anterior
  EXECUTE pg_temp.arma_insert('cardiolink_atenciones', jsonb_build_object('id', 'qa_pres_c2', 'payload', (mk || jsonb_build_object('id','qa_pres_c2','fecha', pm || '-26'))::text));     -- primer día del período M
  EXECUTE pg_temp.arma_insert('cardiolink_atenciones', jsonb_build_object('id', 'qa_pres_c3', 'payload', (mk || jsonb_build_object('id','qa_pres_c3','fecha', m || '-10'))::text));
  EXECUTE pg_temp.arma_insert('cardiolink_atenciones', jsonb_build_object('id', 'qa_pres_c4', 'payload', (mk || jsonb_build_object('id','qa_pres_c4','fecha', m || '-24'))::text));
  EXECUTE pg_temp.arma_insert('cardiolink_atenciones', jsonb_build_object('id', 'qa_pres_c5', 'payload', (mk || jsonb_build_object('id','qa_pres_c5','fecha', m || '-25'))::text));     -- justo el corte habitual (inclusive)
  EXECUTE pg_temp.arma_insert('cardiolink_atenciones', jsonb_build_object('id', 'qa_pres_c6', 'payload', (mk || jsonb_build_object('id','qa_pres_c6','fecha', m || '-26'))::text));     -- posterior al corte habitual
  EXECUTE pg_temp.arma_insert('cardiolink_atenciones', jsonb_build_object('id', 'qa_pres_c7', 'payload', (mk || jsonb_build_object('id','qa_pres_c7','fecha', m || '-27'))::text));
  EXECUTE pg_temp.arma_insert('cardiolink_atenciones', jsonb_build_object('id', 'qa_pres_c8', 'payload', (mk || jsonb_build_object('id','qa_pres_c8','fecha', m || '-12'))::text));     -- llamada de 2 argumentos (cliente viejo)
  EXECUTE pg_temp.arma_insert('cardiolink_atenciones', jsonb_build_object('id', 'qa_pres_c9', 'payload', (mk || jsonb_build_object('id','qa_pres_c9','fecha', m || '-15'))::text));     -- rechazos de fechas
END $$;
CREATE TEMP TABLE t_foto AS SELECT id, payload::text AS payload FROM public.cardiolink_atenciones WHERE id LIKE 'qa\_pres\_%' ESCAPE '\';
CREATE TEMP TABLE t_n_real AS SELECT count(*) AS n FROM public.cardiolink_atenciones WHERE id NOT LIKE 'qa\_pres\_%' ESCAPE '\';

-- K0 estado: la RPC nueva existe, la de 2 argumentos ya no (sin ambigüedad), y las presentaciones reales no tienen fechas inventadas
DO $t$ BEGIN
  PERFORM pg_temp.esperar('K0a la RPC de 4 argumentos existe y la de 2 ya no (una sola función)', (to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb,date,date)') IS NOT NULL)::text || '/' || (to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb)') IS NULL)::text, '^true/true$');
  PERFORM pg_temp.esperar('K0b las presentaciones reales no tienen fechas inventadas', (SELECT con_fechas::text FROM t_pres_reales), '^0$');
  -- la fecha de control se baja SOLO dentro de esta transacción para poder usar fechas pasadas sin marcarlas como excepción
  PERFORM pg_temp.esperar('K0c owner fija el control en una fecha lejana (se revierte con todo)', pg_temp.como('own', 'SELECT public.cardiolink_presentacion_os_control_v1(DATE ''2020-01-01'')'), '^OK$');
END $t$;

-- K1 compatibilidad: una llamada de 2 argumentos (cliente sin actualizar) se comporta como antes; corte = fin de mes, fecha de presentación = hoy
DO $t$
DECLARE p text; r text; v record;
BEGIN
  SELECT prof INTO p FROM t_act WHERE clave = 'med';
  r := pg_temp.como('own', pg_temp.c2(p, pg_temp.fx('m'), jsonb_build_array(pg_temp.itc('qa_pres_c8', pg_temp.fx('m') || '-12'))));
  PERFORM pg_temp.esperar('K1a llamada de 2 argumentos → OK', r, '^OK$');
  SELECT * INTO v FROM public.cardiolink_presentaciones_os_v1 WHERE id IN (SELECT presentacion_id FROM public.cardiolink_presentaciones_os_items_v1 WHERE atencion_id = 'qa_pres_c8');
  PERFORM pg_temp.esperar('K1b corte = último día del mes del período y presentación = hoy', v.fecha_corte::text || '|' || v.fecha_presentacion::text, '^' || pg_temp.fx('fin') || '\|' || pg_temp.fx('hoy') || '$');
END $t$;

-- K2 período normal: del 26 del mes anterior al 25 inclusive, MÁS lo pendiente de períodos anteriores; corte y presentación guardados por separado; las fechas de atención no cambian
DO $t$
DECLARE p text; r text; v record; m text := pg_temp.fx('m'); pm text := pg_temp.fx('pm');
BEGIN
  SELECT prof INTO p FROM t_act WHERE clave = 'med';
  r := pg_temp.como('own', pg_temp.c4(p, m, jsonb_build_array(pg_temp.itc('qa_pres_c1', pm || '-25'), pg_temp.itc('qa_pres_c2', pm || '-26'), pg_temp.itc('qa_pres_c3', m || '-10'), pg_temp.itc('qa_pres_c5', m || '-25')), m || '-25', pg_temp.fx('hoy')));
  PERFORM pg_temp.esperar('K2a corte habitual 25: entra el pendiente anterior (c1), el 26 del mes anterior (c2), una del medio (c3) y la del día 25 inclusive (c5) → OK', r, '^OK$');
  SELECT * INTO v FROM public.cardiolink_presentaciones_os_v1 WHERE id IN (SELECT presentacion_id FROM public.cardiolink_presentaciones_os_items_v1 WHERE atencion_id = 'qa_pres_c5');
  PERFORM pg_temp.esperar('K2b la cabecera guarda período, corte (25) y fecha de presentación por separado, con 4 prestaciones y 4000', v.periodo || '|' || v.fecha_corte::text || '|' || v.fecha_presentacion::text || '|' || v.cantidad || '|' || v.total_importe, '^' || m || '\|' || m || '-25\|' || pg_temp.fx('hoy') || '\|4\|4000');
  PERFORM pg_temp.esperar('K2c cada ítem conserva su fecha de atención original', (SELECT string_agg(fecha_atencion::text, ',' ORDER BY fecha_atencion) FROM public.cardiolink_presentaciones_os_items_v1 WHERE atencion_id IN ('qa_pres_c1','qa_pres_c2','qa_pres_c3','qa_pres_c5')), '^' || pm || '-25,' || pm || '-26,' || m || '-10,' || m || '-25$');
  PERFORM pg_temp.esperar('K2d presentado_en sigue siendo el instante real del registro (distinto de la fecha de presentación elegida)', (SELECT (presentado_en IS NOT NULL)::text FROM public.cardiolink_presentaciones_os_v1 WHERE id = v.id), '^true$');
END $t$;

-- K3 una prestación posterior al corte se rechaza (y no se guarda nada); con corte manual 26 entra
DO $t$
DECLARE p text; r text; m text := pg_temp.fx('m'); n0 bigint;
BEGIN
  SELECT prof INTO p FROM t_act WHERE clave = 'med';
  SELECT count(*) INTO n0 FROM public.cardiolink_presentaciones_os_v1;
  r := pg_temp.como('own', pg_temp.c4(p, m, jsonb_build_array(pg_temp.itc('qa_pres_c4', m || '-24'), pg_temp.itc('qa_pres_c6', m || '-26')), m || '-25', pg_temp.fx('hoy')));
  PERFORM pg_temp.esperar('K3a con corte 25, una prestación del 26 se rechaza (PR409) y se revierte todo', r, 'PR409');
  PERFORM pg_temp.esperar('K3b nada quedó guardado (ni cabecera ni ítems)', (SELECT count(*) FROM public.cardiolink_presentaciones_os_v1)::text || '/' || n0::text || '/' || (SELECT count(*) FROM public.cardiolink_presentaciones_os_items_v1 WHERE atencion_id IN ('qa_pres_c4','qa_pres_c6')), '^(\d+)/\1/0$');
  r := pg_temp.como('own', pg_temp.c4(p, m, jsonb_build_array(pg_temp.itc('qa_pres_c4', m || '-24'), pg_temp.itc('qa_pres_c6', m || '-26')), m || '-26', pg_temp.fx('hoy')));
  PERFORM pg_temp.esperar('K3c con corte manual 26 las dos entran → OK', r, '^OK$');
  PERFORM pg_temp.esperar('K3d la cabecera guarda el corte manual', (SELECT fecha_corte::text FROM public.cardiolink_presentaciones_os_v1 WHERE id IN (SELECT presentacion_id FROM public.cardiolink_presentaciones_os_items_v1 WHERE atencion_id = 'qa_pres_c6')), '^' || m || '-26$');
END $t$;

-- K4 controles de fechas: corte fuera del mes (PR413), presentación futura (PR414), presentación anterior a una prestación (PR414); presentación pasada válida (se guarda tal cual)
DO $t$
DECLARE p text; r text; m text := pg_temp.fx('m'); sig text := to_char((to_date(pg_temp.fx('m') || '-01', 'YYYY-MM-DD') + interval '1 month')::date, 'YYYY-MM-DD'); v record;
BEGIN
  SELECT prof INTO p FROM t_act WHERE clave = 'med';
  PERFORM pg_temp.esperar('K4a corte fuera del mes del período → PR413', pg_temp.como('own', pg_temp.c4(p, m, jsonb_build_array(pg_temp.itc('qa_pres_c9', m || '-15')), sig, pg_temp.fx('hoy'))), 'PR413');
  PERFORM pg_temp.esperar('K4b fecha de presentación futura → PR414', pg_temp.como('own', pg_temp.c4(p, m, jsonb_build_array(pg_temp.itc('qa_pres_c9', m || '-15')), m || '-25', to_char(current_date + 1, 'YYYY-MM-DD'))), 'PR414');
  PERFORM pg_temp.esperar('K4c fecha de presentación anterior a la prestación (m-05 < m-15) → PR414', pg_temp.como('own', pg_temp.c4(p, m, jsonb_build_array(pg_temp.itc('qa_pres_c9', m || '-15')), m || '-25', m || '-05')), 'PR414');
  PERFORM pg_temp.esperar('K4d nada quedó guardado con esas fechas inválidas', (SELECT count(*) FROM public.cardiolink_presentaciones_os_items_v1 WHERE atencion_id = 'qa_pres_c9')::text, '^0$');
  r := pg_temp.como('own', pg_temp.c4(p, m, jsonb_build_array(pg_temp.itc('qa_pres_c9', m || '-15')), m || '-25', m || '-28'));
  PERFORM pg_temp.esperar('K4e presentación pasada válida (m-28 ≥ m-15) → OK', r, '^OK$');
  SELECT * INTO v FROM public.cardiolink_presentaciones_os_v1 WHERE id IN (SELECT presentacion_id FROM public.cardiolink_presentaciones_os_items_v1 WHERE atencion_id = 'qa_pres_c9');
  PERFORM pg_temp.esperar('K4f la fecha efectiva elegida queda guardada tal cual y es distinta de la fecha en que se registró', v.fecha_presentacion::text || '|' || (v.fecha_presentacion <> (v.presentado_en AT TIME ZONE 'UTC')::date)::text, '^' || m || '-28\|true$');
END $t$;

-- K5 nunca duplica: repetir una prestación ya presentada (con cualquier fecha de corte/presentación) falla con 23505 y no deja filas
DO $t$
DECLARE p text; m text := pg_temp.fx('m'); pm text := pg_temp.fx('pm'); n0 bigint;
BEGIN
  SELECT prof INTO p FROM t_act WHERE clave = 'med';
  SELECT count(*) INTO n0 FROM public.cardiolink_presentaciones_os_items_v1;
  PERFORM pg_temp.esperar('K5a repetir c1 con otro corte → 23505', pg_temp.como('own', pg_temp.c4(p, m, jsonb_build_array(pg_temp.itc('qa_pres_c1', pm || '-25')), m || '-26', pg_temp.fx('hoy'))), '^23505');
  PERFORM pg_temp.esperar('K5b repetir c8 con la llamada de 2 argumentos → 23505', pg_temp.como('own', pg_temp.c2(p, m, jsonb_build_array(pg_temp.itc('qa_pres_c8', m || '-12')))), '^23505');
  PERFORM pg_temp.esperar('K5c no quedaron filas extra', (SELECT count(*) FROM public.cardiolink_presentaciones_os_items_v1)::text || '/' || n0::text, '^(\d+)/\1$');
  PERFORM pg_temp.esperar('K5d una sola fila por atención', (SELECT count(*) - count(DISTINCT atencion_id) FROM public.cardiolink_presentaciones_os_items_v1)::text, '^0$');
END $t$;

-- K6 permisos sin cambios con la firma nueva: el médico, sin rol y anon no presentan; la cabecera sigue de solo lectura
DO $t$
DECLARE p text; m text := pg_temp.fx('m'); it jsonb := jsonb_build_array(pg_temp.itc('qa_pres_c7', pg_temp.fx('m') || '-27'));
BEGIN
  SELECT prof INTO p FROM t_act WHERE clave = 'med';
  PERFORM pg_temp.esperar('K6a el médico no presenta', pg_temp.como('med', pg_temp.c4(p, m, it, m || '-28', pg_temp.fx('hoy'))), '^42501');
  PERFORM pg_temp.esperar('K6b un usuario autenticado sin rol no presenta', pg_temp.como('nadie', pg_temp.c4(p, m, it, m || '-28', pg_temp.fx('hoy'))), '^42501');
  PERFORM pg_temp.esperar('K6c anon no ejecuta', pg_temp.como('anon', pg_temp.c4(p, m, it, m || '-28', pg_temp.fx('hoy'))), '^42501');
  PERFORM pg_temp.esperar('K6d la secretaría asociada SÍ presenta a su médico (con las fechas nuevas)', pg_temp.como('sec', pg_temp.c4(p, m, it, m || '-28', pg_temp.fx('hoy'))), '^OK$');
  PERFORM pg_temp.esperar('K6e authenticated no puede escribir la cabecera directamente', pg_temp.como('own', 'UPDATE public.cardiolink_presentaciones_os_v1 SET fecha_corte = current_date'), '^42501');
END $t$;

-- K7 históricos y atenciones intactos
DO $t$ BEGIN
  PERFORM pg_temp.esperar('K7a ninguna atención sintética fue modificada', (SELECT count(*)::text FROM t_foto f JOIN public.cardiolink_atenciones a ON a.id = f.id WHERE a.payload::text <> f.payload), '^0$');
  PERFORM pg_temp.esperar('K7b la cantidad de atenciones reales no cambió', (SELECT count(*) FROM public.cardiolink_atenciones WHERE id NOT LIKE 'qa\_pres\_%' ESCAPE '\') || '/' || (SELECT n FROM t_n_real), '^(\d+)/\1$');
  PERFORM pg_temp.esperar('K7c las presentaciones reales siguen sin fechas inventadas', (SELECT count(*)::text FROM public.cardiolink_presentaciones_os_v1 WHERE fecha_corte IS NULL AND fecha_presentacion IS NULL AND presentado_por_email NOT LIKE '%@qa.test') || '/' || (SELECT n::text FROM t_pres_reales), '^(\d+)/\1$');
END $t$;
-- ===== ROLLBACK del cierre =====
-- CardioLink · PRESENTACIONES A OBRAS SOCIALES · CIERRE DEL DÍA 25 · ROLLBACK de pending_review_presentaciones_os_cierre_25_v1.sql
-- *** Ensayado dentro del ensayo reversible de STAGING. NO ejecutado en Production. *** Vuelve a la RPC de 2 argumentos del complemento de terceros (copia exacta) y quita las 2 columnas de fechas.
-- ATENCIÓN: borra fecha_corte y fecha_presentacion de las presentaciones ya registradas con el cierre del día 25 (el resto de los datos no se toca). Exportar antes esas dos columnas si ya hay presentaciones con ellas.
DROP FUNCTION IF EXISTS public.cardiolink_presentacion_os_confirmar_v1(text, jsonb, date, date);
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
REVOKE ALL ON FUNCTION public.cardiolink_presentacion_os_confirmar_v1(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cardiolink_presentacion_os_confirmar_v1(text, jsonb) TO authenticated;
ALTER TABLE public.cardiolink_presentaciones_os_v1 DROP COLUMN IF EXISTS fecha_corte, DROP COLUMN IF EXISTS fecha_presentacion;
DO $$
BEGIN
  IF to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb,date,date)') IS NOT NULL OR to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb)') IS NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'cardiolink_presentaciones_os_v1' AND column_name IN ('fecha_corte', 'fecha_presentacion')) THEN
    RAISE EXCEPTION 'FALLA: el rollback no dejó el estado del complemento de terceros'; END IF;
  IF coalesce(pg_get_functiondef(to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb)')), '') NOT LIKE '%delegaciones_v1%' OR coalesce(pg_get_functiondef(to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb)')), '') NOT LIKE '%PR412%' THEN
    RAISE EXCEPTION 'FALLA: la RPC restaurada no conserva delegaciones y PR412'; END IF;
END $$;
DO $$
DECLARE v_np int;
BEGIN
  IF (SELECT count(*) FROM public.cardiolink_atenciones WHERE id NOT LIKE 'qa\_pres\_%' ESCAPE '\') <> (SELECT n FROM t_n_real) THEN RAISE EXCEPTION 'FALLA R1: cambió la cantidad de atenciones reales'; END IF;
  IF to_regclass('public.cardiolink_presentaciones_os_delegaciones_v1') IS NULL OR to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb)') IS NULL THEN RAISE EXCEPTION 'FALLA R2: el rollback del cierre dañó el complemento de terceros'; END IF;
  SELECT count(*) INTO v_np FROM t_res;
  RAISE EXCEPTION 'ENSAYO_CIERRE25_OK: % pruebas pasaron, el rollback del cierre dejó el estado del complemento de terceros y se revierte todo (esta EXCEPTION es la señal de éxito)', v_np;
END $$;
