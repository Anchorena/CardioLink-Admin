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
