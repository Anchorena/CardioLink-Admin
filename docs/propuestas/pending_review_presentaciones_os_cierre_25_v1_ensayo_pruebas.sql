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
