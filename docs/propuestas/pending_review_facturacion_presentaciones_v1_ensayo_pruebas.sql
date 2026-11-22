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
