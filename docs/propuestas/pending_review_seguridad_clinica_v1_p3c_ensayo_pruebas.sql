-- ===== PRUEBAS p3c (como cada actor sintético, vía claims + SET LOCAL ROLE; todo qa3c_*; el veredicto final es una EXCEPTION que revierte TODO) =====
-- Actores: own (owner 'qa3c_matias' = Matías), adm (admin), med_a (médico tipo Rogelio 'qa3c_med_a'), med_b (médico NUEVO sin vínculos ni atenciones 'qa3c_med_b'),
-- sec (Secretaría), inact (médico INACTIVO), sinprof (médico activo sin professional_id), norol (cuenta sin fila de rol), anon.
CREATE TEMP TABLE t_act(clave text PRIMARY KEY, uid uuid, rol text, prof text);
CREATE TEMP TABLE t_res(nombre text);
CREATE TEMP TABLE t_pol(fase text, tablename name, policyname name, cmd text, permissive text, roles text, qual text, with_check text);
CREATE TEMP TABLE t_acl(fase text, rel name, grantee text, priv text);

CREATE FUNCTION pg_temp.snap_pol(p_fase text) RETURNS void LANGUAGE sql AS $f$
  INSERT INTO t_pol SELECT p_fase, tablename, policyname, cmd, permissive, roles::text, qual, with_check FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') $f$;
CREATE FUNCTION pg_temp.snap_acl(p_fase text) RETURNS void LANGUAGE sql AS $f$
  INSERT INTO t_acl SELECT p_fase, c.relname, (aclexplode(c.relacl)).grantee::regrole::text, (aclexplode(c.relacl)).privilege_type FROM pg_class c WHERE c.oid IN ('public.cardiolink_hc_evoluciones'::regclass,'public.cardiolink_hc_resumen'::regclass) $f$;
CREATE FUNCTION pg_temp.igual_pol(p_a text, p_b text) RETURNS boolean LANGUAGE sql AS $f$
  SELECT NOT EXISTS (SELECT tablename,policyname,cmd,permissive,roles,qual,with_check FROM t_pol WHERE fase=p_a EXCEPT SELECT tablename,policyname,cmd,permissive,roles,qual,with_check FROM t_pol WHERE fase=p_b)
     AND NOT EXISTS (SELECT tablename,policyname,cmd,permissive,roles,qual,with_check FROM t_pol WHERE fase=p_b EXCEPT SELECT tablename,policyname,cmd,permissive,roles,qual,with_check FROM t_pol WHERE fase=p_a) $f$;

CREATE FUNCTION pg_temp.como(p_clave text, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v_uid uuid; v_rol text; r text; n bigint;
BEGIN
  SELECT uid, rol INTO v_uid, v_rol FROM t_act WHERE clave = p_clave;
  IF v_rol = 'anon' THEN PERFORM set_config('request.jwt.claims', '', true); EXECUTE 'SET LOCAL ROLE anon';
  ELSE PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true); EXECUTE 'SET LOCAL ROLE authenticated'; END IF;
  BEGIN
    IF p_sql ~* '^\s*select' THEN EXECUTE p_sql INTO r; ELSE EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; r := n::text; END IF;
    EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claims', '', true); RETURN 'n=' || coalesce(r, 'null');
  EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claims', '', true); RETURN 'E' || SQLSTATE;
  END;
END $f$;
CREATE FUNCTION pg_temp.chk(p_nombre text, p_got text, p_exp text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  IF p_got IS DISTINCT FROM p_exp THEN RAISE EXCEPTION 'FALLA %: obtuvo [%] esperado [%]', p_nombre, p_got, p_exp; END IF;
  INSERT INTO t_res VALUES (p_nombre);
END $f$;
CREATE FUNCTION pg_temp.chk_uno(p_nombre text, p_got text, p_ok text[]) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  IF NOT (p_got = ANY (p_ok)) THEN RAISE EXCEPTION 'FALLA %: obtuvo [%] esperado uno de %', p_nombre, p_got, p_ok; END IF;
  INSERT INTO t_res VALUES (p_nombre);
END $f$;
CREATE FUNCTION pg_temp.arma_insert(p_tabla text, p_val jsonb) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE c record; cols text := ''; vals text := ''; v text; k text;
BEGIN
  FOR k IN SELECT jsonb_object_keys(p_val) LOOP
    cols := cols || CASE WHEN cols = '' THEN '' ELSE ',' END || quote_ident(k);
    vals := vals || CASE WHEN vals = '' THEN '' ELSE ',' END || quote_literal(p_val ->> k);
  END LOOP;
  FOR c IN SELECT column_name, data_type FROM information_schema.columns
            WHERE table_schema='public' AND table_name=p_tabla AND is_nullable='NO' AND column_default IS NULL AND NOT (p_val ? column_name) ORDER BY ordinal_position LOOP
    IF c.data_type IN ('text','character varying','character') THEN v := quote_literal('QA SINTETICO p3c');
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

-- ===== actores y fixture (como postgres) =====
DO $$
DECLARE k text; u uuid; r record;
BEGIN
  IF EXISTS (SELECT 1 FROM public.cardiolink_pacientes WHERE id LIKE 'qa3c\_%' ESCAPE '\') OR EXISTS (SELECT 1 FROM public.cardiolink_hc_evoluciones WHERE id LIKE 'qa3c\_%' ESCAPE '\') OR EXISTS (SELECT 1 FROM auth.users WHERE email LIKE 'qa3c\_%' ESCAPE '\') THEN
    RAISE EXCEPTION 'Ya existen filas qa3c_*: se aborta'; END IF;
  FOR r IN SELECT * FROM (VALUES ('own','owner','qa3c_matias',true),('adm','admin','qa3c_admin',true),('med_a','medico','qa3c_med_a',true),('med_b','medico','qa3c_med_b',true),
                                 ('sec','secretaria',NULL,true),('inact','medico','qa3c_inact',false),('sinprof','medico',NULL,true),('norol',NULL,NULL,NULL)) v(clave, rol, prof, activo) LOOP
    u := gen_random_uuid();
    INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    VALUES (u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'qa3c_' || r.clave || '@cardiolink.local', crypt('x', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', now(), now());
    IF r.rol IS NOT NULL THEN
      INSERT INTO public.cardiolink_user_roles (user_id, cardiolink_user_key, base_role, active, professional_id) VALUES (u, 'qa3c_' || r.clave || '@cardiolink.local', r.rol, r.activo, r.prof);
    END IF;
    INSERT INTO t_act VALUES (r.clave, u, r.rol, r.prof);
  END LOOP;
  INSERT INTO t_act VALUES ('anon', NULL, 'anon', NULL);
  -- pacientes: uno CON HC de otro profesional (Matías) y uno sin nada
  EXECUTE pg_temp.arma_insert('cardiolink_pacientes', jsonb_build_object('id', 'qa3c_pac_viejo'));
  EXECUTE pg_temp.arma_insert('cardiolink_pacientes', jsonb_build_object('id', 'qa3c_pac_otro'));
  EXECUTE pg_temp.arma_insert('cardiolink_hc_evoluciones', jsonb_build_object('id', 'qa3c_evo_m1', 'paciente_id', 'qa3c_pac_viejo', 'profesional_id', 'qa3c_matias', 'evolucion', 'EVO_M1_ORIGINAL'));
  EXECUTE pg_temp.arma_insert('cardiolink_hc_evoluciones', jsonb_build_object('id', 'qa3c_evo_a1', 'paciente_id', 'qa3c_pac_viejo', 'profesional_id', 'qa3c_med_a', 'evolucion', 'EVO_A1_ORIGINAL'));
  EXECUTE pg_temp.arma_insert('cardiolink_hc_resumen', jsonb_build_object('paciente_id', 'qa3c_pac_viejo', 'alergias', 'ALERGIA_ORIGINAL'));
  -- paciente atendido SÓLO por Matías (ningún otro médico tiene evolución, atención ni vínculo con él): caso Rogelio/médico nuevo ante un paciente de Matías
  EXECUTE pg_temp.arma_insert('cardiolink_pacientes', jsonb_build_object('id', 'qa3c_pac_matias'));
  EXECUTE pg_temp.arma_insert('cardiolink_hc_evoluciones', jsonb_build_object('id', 'qa3c_evo_m2', 'paciente_id', 'qa3c_pac_matias', 'profesional_id', 'qa3c_matias', 'evolucion', 'EVO_M2_ORIGINAL'));
  EXECUTE pg_temp.arma_insert('cardiolink_hc_resumen', jsonb_build_object('paciente_id', 'qa3c_pac_matias', 'alergias', 'ALERGIA_M'));
END $$;
CREATE TEMP TABLE t_h AS SELECT md5(evolucion) h, (SELECT md5(evolucion) FROM public.cardiolink_hc_evoluciones WHERE id='qa3c_evo_m2') h2 FROM public.cardiolink_hc_evoluciones WHERE id='qa3c_evo_m1';

-- ===== T1 OWNER / ADMIN: acceso completo según los permisos existentes =====
DO $t$
DECLARE k text;
BEGIN
  FOREACH k IN ARRAY ARRAY['own','adm'] LOOP
    PERFORM pg_temp.chk('T1 '||k||' lee evoluciones ajenas y propias', pg_temp.como(k, $q$SELECT count(*)::text FROM public.cardiolink_hc_evoluciones WHERE paciente_id='qa3c_pac_viejo'$q$), 'n=2');
    PERFORM pg_temp.chk('T1 '||k||' lee resumen', pg_temp.como(k, $q$SELECT count(*)::text FROM public.cardiolink_hc_resumen WHERE paciente_id='qa3c_pac_viejo'$q$), 'n=1');
    PERFORM pg_temp.chk('T1 '||k||' inserta evolución', pg_temp.como(k, pg_temp.arma_insert('cardiolink_hc_evoluciones', jsonb_build_object('id','qa3c_evo_'||k,'paciente_id','qa3c_pac_otro','profesional_id','qa3c_med_b'))), 'n=1');
    PERFORM pg_temp.chk('T1 '||k||' edita evolución ajena', pg_temp.como(k, format($q$UPDATE public.cardiolink_hc_evoluciones SET evolucion='OWNER_EDIT' WHERE id='qa3c_evo_%s'$q$, k)), 'n=1');
    PERFORM pg_temp.chk('T1 '||k||' borra evolución', pg_temp.como(k, format($q$DELETE FROM public.cardiolink_hc_evoluciones WHERE id='qa3c_evo_%s'$q$, k)), 'n=1');
    PERFORM pg_temp.chk('T1 '||k||' actualiza resumen', pg_temp.como(k, $q$UPDATE public.cardiolink_hc_resumen SET alertas='OWNER_ALERTA' WHERE paciente_id='qa3c_pac_viejo'$q$), 'n=1');
  END LOOP;
  -- el owner inserta/borra resumen (único rol con DELETE de resumen)
  PERFORM pg_temp.chk('T1 owner crea resumen', pg_temp.como('own', pg_temp.arma_insert('cardiolink_hc_resumen', jsonb_build_object('paciente_id','qa3c_pac_otro'))), 'n=1');
  PERFORM pg_temp.chk('T1 owner borra resumen', pg_temp.como('own', $q$DELETE FROM public.cardiolink_hc_resumen WHERE paciente_id='qa3c_pac_otro'$q$), 'n=1');
END $t$;

-- ===== T2 MÉDICO tipo Rogelio (med_a): consulta lo de Matías, no lo edita; escribe lo propio =====
DO $t$
BEGIN
  PERFORM pg_temp.chk('T2 Rogelio CONSULTA la evolución de Matías', pg_temp.como('med_a', $q$SELECT count(*)::text FROM public.cardiolink_hc_evoluciones WHERE id='qa3c_evo_m1'$q$), 'n=1');
  PERFORM pg_temp.chk('T2 consulta todas las evoluciones del paciente (propia y ajena)', pg_temp.como('med_a', $q$SELECT count(*)::text FROM public.cardiolink_hc_evoluciones WHERE paciente_id='qa3c_pac_viejo'$q$), 'n=2');
  PERFORM pg_temp.chk('T2 CONSULTA la evolución de Matías en un paciente que sólo atendió Matías (sin ningún vínculo propio)', pg_temp.como('med_a', $q$SELECT count(*)::text FROM public.cardiolink_hc_evoluciones WHERE id='qa3c_evo_m2'$q$), 'n=1');
  PERFORM pg_temp.chk('T2 ... y su resumen clínico (alergias)', pg_temp.como('med_a', $q$SELECT count(*)::text FROM public.cardiolink_hc_resumen WHERE paciente_id='qa3c_pac_matias' AND alergias='ALERGIA_M'$q$), 'n=1');
  PERFORM pg_temp.chk('T2 ... pero NO la edita', pg_temp.como('med_a', $q$UPDATE public.cardiolink_hc_evoluciones SET evolucion='SUPLANTADA' WHERE id='qa3c_evo_m2'$q$), 'n=0');
  PERFORM pg_temp.chk('T2 ... ni la borra', pg_temp.como('med_a', $q$DELETE FROM public.cardiolink_hc_evoluciones WHERE id='qa3c_evo_m2'$q$), 'n=0');
  PERFORM pg_temp.chk('T2 NO edita la evolución de Matías', pg_temp.como('med_a', $q$UPDATE public.cardiolink_hc_evoluciones SET evolucion='SUPLANTADA' WHERE id='qa3c_evo_m1'$q$), 'n=0');
  PERFORM pg_temp.chk('T2 NO borra la evolución de Matías', pg_temp.como('med_a', $q$DELETE FROM public.cardiolink_hc_evoluciones WHERE id='qa3c_evo_m1'$q$), 'n=0');
  PERFORM pg_temp.chk('T2 NO se la apropia (profesional_id)', pg_temp.como('med_a', $q$UPDATE public.cardiolink_hc_evoluciones SET profesional_id='qa3c_med_a' WHERE id='qa3c_evo_m1'$q$), 'n=0');
  PERFORM pg_temp.chk('T2 inserta la PRIMERA evolución en un paciente sin vínculos ni atenciones (con RETURNING)', pg_temp.como('med_a', pg_temp.arma_insert('cardiolink_hc_evoluciones', jsonb_build_object('id','qa3c_evo_a2','paciente_id','qa3c_pac_otro','profesional_id','qa3c_med_a')) || ' RETURNING id'), 'n=1');
  PERFORM pg_temp.chk('T2 NO suplanta profesional_id (Matías)', pg_temp.como('med_a', pg_temp.arma_insert('cardiolink_hc_evoluciones', jsonb_build_object('id','qa3c_evo_x1','paciente_id','qa3c_pac_otro','profesional_id','qa3c_matias'))), 'E42501');
  PERFORM pg_temp.chk('T2 NO suplanta profesional_id (otro médico)', pg_temp.como('med_a', pg_temp.arma_insert('cardiolink_hc_evoluciones', jsonb_build_object('id','qa3c_evo_x2','paciente_id','qa3c_pac_otro','profesional_id','qa3c_med_b'))), 'E42501');
  PERFORM pg_temp.chk('T2 NO inserta con profesional_id nulo', pg_temp.como('med_a', $q$INSERT INTO public.cardiolink_hc_evoluciones (id, paciente_id) VALUES ('qa3c_evo_x3','qa3c_pac_otro')$q$), 'E42501');
  PERFORM pg_temp.chk('T2 NO inserta en paciente inexistente', pg_temp.como('med_a', pg_temp.arma_insert('cardiolink_hc_evoluciones', jsonb_build_object('id','qa3c_evo_x4','paciente_id','qa3c_no_existe','profesional_id','qa3c_med_a'))), 'E42501');
  -- guardado del PR #33: UPDATE condicionado (compare-and-swap) sobre la evolución propia
  PERFORM pg_temp.chk('T2 UPDATE condicionado (editado_en nulo) en la propia', pg_temp.como('med_a', $q$UPDATE public.cardiolink_hc_evoluciones SET evolucion='A1_EDIT1', editado_en=now() WHERE id='qa3c_evo_a1' AND editado_en IS NULL RETURNING id$q$), 'n=1');
  PERFORM pg_temp.chk('T2 UPDATE condicionado obsoleto: 0 filas (CAS normal, no error)', pg_temp.como('med_a', $q$UPDATE public.cardiolink_hc_evoluciones SET evolucion='A1_EDIT2', editado_en=now() WHERE id='qa3c_evo_a1' AND editado_en IS NULL RETURNING id$q$), 'n=0');
  PERFORM pg_temp.chk('T2 NO transfiere su evolución a otro profesional', pg_temp.como('med_a', $q$UPDATE public.cardiolink_hc_evoluciones SET profesional_id='qa3c_med_b' WHERE id='qa3c_evo_a1'$q$), 'E42501');
  PERFORM pg_temp.chk('T2 NO mueve su evolución a un paciente inexistente', pg_temp.como('med_a', $q$UPDATE public.cardiolink_hc_evoluciones SET paciente_id='qa3c_no_existe' WHERE id='qa3c_evo_a1'$q$), 'E42501');
  PERFORM pg_temp.chk('T2 borra una evolución PROPIA', pg_temp.como('med_a', $q$DELETE FROM public.cardiolink_hc_evoluciones WHERE id='qa3c_evo_a2'$q$), 'n=1');
  -- resumen compartido
  PERFORM pg_temp.chk('T2 lee el resumen (alergias) cargado por otro', pg_temp.como('med_a', $q$SELECT count(*)::text FROM public.cardiolink_hc_resumen WHERE paciente_id='qa3c_pac_viejo' AND alergias='ALERGIA_ORIGINAL'$q$), 'n=1');
  PERFORM pg_temp.chk('T2 actualiza el resumen (UPDATE condicionado por actualizado_en nulo o vigente)', pg_temp.como('med_a', $q$UPDATE public.cardiolink_hc_resumen SET alergias='ALERGIA_A', actualizado_en=now() WHERE paciente_id='qa3c_pac_viejo' RETURNING paciente_id$q$), 'n=1');
  PERFORM pg_temp.chk('T2 crea el primer resumen de un paciente nuevo', pg_temp.como('med_a', pg_temp.arma_insert('cardiolink_hc_resumen', jsonb_build_object('paciente_id','qa3c_pac_otro','alergias','A_NUEVO'))), 'n=1');
  PERFORM pg_temp.chk('T2 NO borra resúmenes', pg_temp.como('med_a', $q$DELETE FROM public.cardiolink_hc_resumen WHERE paciente_id='qa3c_pac_otro'$q$), 'n=0');
END $t$;

-- ===== T3 MÉDICO NUEVO (med_b): sin vínculos, atenciones ni evoluciones =====
DO $t$
BEGIN
  PERFORM pg_temp.chk('T3 médico nuevo lee evoluciones de Matías y de otro médico', pg_temp.como('med_b', $q$SELECT count(*)::text FROM public.cardiolink_hc_evoluciones WHERE paciente_id='qa3c_pac_viejo'$q$), 'n=2');
  PERFORM pg_temp.chk('T3 lee el resumen actualizado por otro médico', pg_temp.como('med_b', $q$SELECT count(*)::text FROM public.cardiolink_hc_resumen WHERE paciente_id='qa3c_pac_viejo' AND alergias='ALERGIA_A'$q$), 'n=1');
  PERFORM pg_temp.chk('T3 médico nuevo consulta una evolución de Matías en un paciente sin vínculo propio', pg_temp.como('med_b', $q$SELECT count(*)::text FROM public.cardiolink_hc_evoluciones WHERE id='qa3c_evo_m2'$q$), 'n=1');
  PERFORM pg_temp.chk('T3 NO edita la evolución de otro (Rogelio)', pg_temp.como('med_b', $q$UPDATE public.cardiolink_hc_evoluciones SET evolucion='X' WHERE id='qa3c_evo_a1'$q$), 'n=0');
  PERFORM pg_temp.chk('T3 NO borra la evolución de otro', pg_temp.como('med_b', $q$DELETE FROM public.cardiolink_hc_evoluciones WHERE id='qa3c_evo_a1'$q$), 'n=0');
  PERFORM pg_temp.chk('T3 inserta la suya en el mismo paciente', pg_temp.como('med_b', pg_temp.arma_insert('cardiolink_hc_evoluciones', jsonb_build_object('id','qa3c_evo_b1','paciente_id','qa3c_pac_viejo','profesional_id','qa3c_med_b'))), 'n=1');
  PERFORM pg_temp.chk('T3 actualiza el resumen compartido', pg_temp.como('med_b', $q$UPDATE public.cardiolink_hc_resumen SET medicacion_habitual='MED_B', actualizado_en=now() WHERE paciente_id='qa3c_pac_viejo'$q$), 'n=1');
END $t$;

-- ===== T4 SECRETARÍA: sin acceso directo a HC y flujos administrativos intactos =====
DO $t$
BEGIN
  PERFORM pg_temp.chk('T4 Secretaría: 0 evoluciones visibles', pg_temp.como('sec', $q$SELECT count(*)::text FROM public.cardiolink_hc_evoluciones$q$), 'n=0');
  PERFORM pg_temp.chk('T4 Secretaría: 0 resúmenes visibles', pg_temp.como('sec', $q$SELECT count(*)::text FROM public.cardiolink_hc_resumen$q$), 'n=0');
  PERFORM pg_temp.chk('T4 Secretaría NO inserta evolución', pg_temp.como('sec', pg_temp.arma_insert('cardiolink_hc_evoluciones', jsonb_build_object('id','qa3c_evo_s1','paciente_id','qa3c_pac_viejo','profesional_id','qa3c_med_a'))), 'E42501');
  PERFORM pg_temp.chk('T4 Secretaría NO inserta resumen', pg_temp.como('sec', pg_temp.arma_insert('cardiolink_hc_resumen', jsonb_build_object('paciente_id','qa3c_pac_otro'))), 'E42501');
  PERFORM pg_temp.chk('T4 Secretaría NO edita evoluciones', pg_temp.como('sec', $q$UPDATE public.cardiolink_hc_evoluciones SET evolucion='S'$q$), 'n=0');
  PERFORM pg_temp.chk('T4 Secretaría NO borra evoluciones', pg_temp.como('sec', $q$DELETE FROM public.cardiolink_hc_evoluciones$q$), 'n=0');
  PERFORM pg_temp.chk('T4 Secretaría NO edita resúmenes', pg_temp.como('sec', $q$UPDATE public.cardiolink_hc_resumen SET alergias='S'$q$), 'n=0');
  PERFORM pg_temp.chk('T4 Secretaría NO borra resúmenes', pg_temp.como('sec', $q$DELETE FROM public.cardiolink_hc_resumen$q$), 'n=0');
  -- administrativo intacto: ficha de paciente (crear y leer) sigue funcionando
  PERFORM pg_temp.chk('T4 Secretaría crea una ficha de paciente nueva (flujo administrativo)', pg_temp.como('sec', pg_temp.arma_insert('cardiolink_pacientes', jsonb_build_object('id','qa3c_pac_sec'))), 'n=1');
  PERFORM pg_temp.chk('T4 Secretaría lee la ficha', pg_temp.como('sec', $q$SELECT count(*)::text FROM public.cardiolink_pacientes WHERE id='qa3c_pac_sec'$q$), 'n=1');
  -- paciente nuevo (ficha de Secretaría): el médico lo ve y crea su primera evolución y resumen
  PERFORM pg_temp.chk('T4b paciente nuevo creado por Secretaría: el médico crea su 1.ª evolución', pg_temp.como('med_a', pg_temp.arma_insert('cardiolink_hc_evoluciones', jsonb_build_object('id','qa3c_evo_a3','paciente_id','qa3c_pac_sec','profesional_id','qa3c_med_a'))), 'n=1');
  PERFORM pg_temp.chk('T4b ... y su resumen', pg_temp.como('med_a', pg_temp.arma_insert('cardiolink_hc_resumen', jsonb_build_object('paciente_id','qa3c_pac_sec'))), 'n=1');
  PERFORM pg_temp.chk('T4b ... Secretaría sigue sin ver esa HC', pg_temp.como('sec', $q$SELECT count(*)::text FROM public.cardiolink_hc_evoluciones WHERE paciente_id='qa3c_pac_sec'$q$), 'n=0');
END $t$;

-- ===== T5 INACTIVO, SIN PROFESIONAL, SIN ROL, ANON =====
DO $t$
DECLARE k text;
BEGIN
  FOREACH k IN ARRAY ARRAY['inact','sinprof','norol'] LOOP
    PERFORM pg_temp.chk('T5 '||k||': 0 evoluciones', pg_temp.como(k, $q$SELECT count(*)::text FROM public.cardiolink_hc_evoluciones$q$), 'n=0');
    PERFORM pg_temp.chk('T5 '||k||': 0 resúmenes', pg_temp.como(k, $q$SELECT count(*)::text FROM public.cardiolink_hc_resumen$q$), 'n=0');
    PERFORM pg_temp.chk('T5 '||k||': no inserta evolución', pg_temp.como(k, pg_temp.arma_insert('cardiolink_hc_evoluciones', jsonb_build_object('id','qa3c_evo_i_'||k,'paciente_id','qa3c_pac_viejo','profesional_id', coalesce((SELECT prof FROM t_act WHERE clave=k),'qa3c_x')))), 'E42501');
    PERFORM pg_temp.chk('T5 '||k||': no inserta resumen', pg_temp.como(k, pg_temp.arma_insert('cardiolink_hc_resumen', jsonb_build_object('paciente_id','qa3c_pac_otro'))), 'E42501');
    PERFORM pg_temp.chk('T5 '||k||': no edita ni borra', pg_temp.como(k, $q$UPDATE public.cardiolink_hc_evoluciones SET evolucion='X'$q$) || '/' || pg_temp.como(k, $q$DELETE FROM public.cardiolink_hc_resumen$q$), 'n=0/n=0');
  END LOOP;
  -- anon: sin sesión (sin privilegios o sin filas; nunca datos ni escritura)
  PERFORM pg_temp.chk_uno('T5 anon no lee evoluciones', pg_temp.como('anon', $q$SELECT count(*)::text FROM public.cardiolink_hc_evoluciones$q$), ARRAY['n=0','E42501']);
  PERFORM pg_temp.chk_uno('T5 anon no lee resúmenes', pg_temp.como('anon', $q$SELECT count(*)::text FROM public.cardiolink_hc_resumen$q$), ARRAY['n=0','E42501']);
  PERFORM pg_temp.chk_uno('T5 anon no inserta evolución', pg_temp.como('anon', pg_temp.arma_insert('cardiolink_hc_evoluciones', jsonb_build_object('id','qa3c_evo_anon','paciente_id','qa3c_pac_viejo','profesional_id','qa3c_med_a'))), ARRAY['E42501']);
  PERFORM pg_temp.chk_uno('T5 anon no inserta resumen', pg_temp.como('anon', pg_temp.arma_insert('cardiolink_hc_resumen', jsonb_build_object('paciente_id','qa3c_pac_otro'))), ARRAY['E42501']);
  PERFORM pg_temp.chk_uno('T5 anon no edita', pg_temp.como('anon', $q$UPDATE public.cardiolink_hc_evoluciones SET evolucion='X'$q$), ARRAY['n=0','E42501']);
  PERFORM pg_temp.chk_uno('T5 anon no borra', pg_temp.como('anon', $q$DELETE FROM public.cardiolink_hc_resumen$q$), ARRAY['n=0','E42501']);
  PERFORM pg_temp.chk_uno('T5 anon no ejecuta el padrón', pg_temp.como('anon', $q$SELECT public.cardiolink_paciente_padron_v1('qa3c_pac_viejo')::text$q$), ARRAY['E42501']);
END $t$;

-- ===== T6 REVOCACIÓN: desactivar la fila de rol corta el acceso al instante; reactivar lo devuelve =====
DO $t$
BEGIN
  UPDATE public.cardiolink_user_roles SET active = false WHERE user_id = (SELECT uid FROM t_act WHERE clave='med_b');
  PERFORM pg_temp.chk('T6 médico desactivado: 0 evoluciones', pg_temp.como('med_b', $q$SELECT count(*)::text FROM public.cardiolink_hc_evoluciones$q$), 'n=0');
  PERFORM pg_temp.chk('T6 médico desactivado: no edita ni su propia evolución', pg_temp.como('med_b', $q$UPDATE public.cardiolink_hc_evoluciones SET evolucion='X' WHERE id='qa3c_evo_b1'$q$), 'n=0');
  UPDATE public.cardiolink_user_roles SET active = true WHERE user_id = (SELECT uid FROM t_act WHERE clave='med_b');
  PERFORM pg_temp.chk('T6 reactivado: vuelve a leer', pg_temp.como('med_b', $q$SELECT (count(*) > 0)::text FROM public.cardiolink_hc_evoluciones$q$), 'n=true');
  -- un médico NUEVO sólo con la fila de rol (alta = autorización): se crea en el momento y accede
  PERFORM pg_temp.chk('T6 alta de un médico = fila de rol: ya consulta', pg_temp.como('inact', $q$SELECT count(*)::text FROM public.cardiolink_hc_evoluciones$q$), 'n=0');
  UPDATE public.cardiolink_user_roles SET active = true WHERE user_id = (SELECT uid FROM t_act WHERE clave='inact');
  PERFORM pg_temp.chk('T6 ... al activarlo consulta toda la HC', pg_temp.como('inact', $q$SELECT (count(*) >= 3)::text FROM public.cardiolink_hc_evoluciones$q$), 'n=true');
  PERFORM pg_temp.chk('T6 ... y no edita la de otros', pg_temp.como('inact', $q$UPDATE public.cardiolink_hc_evoluciones SET evolucion='X' WHERE id='qa3c_evo_m1'$q$), 'n=0');
  UPDATE public.cardiolink_user_roles SET active = false WHERE user_id = (SELECT uid FROM t_act WHERE clave='inact');
END $t$;

-- ===== T7 la evolución de Matías quedó INTACTA tras todos los intentos de los demás =====
DO $t$
BEGIN
  IF (SELECT md5(evolucion) FROM public.cardiolink_hc_evoluciones WHERE id='qa3c_evo_m1') IS DISTINCT FROM (SELECT h FROM t_h) THEN RAISE EXCEPTION 'FALLA T7: la evolución de Matías cambió'; END IF;
  IF (SELECT md5(evolucion) FROM public.cardiolink_hc_evoluciones WHERE id='qa3c_evo_m2') IS DISTINCT FROM (SELECT h2 FROM t_h) THEN RAISE EXCEPTION 'FALLA T7: la evolución m2 de Matías cambió'; END IF;
  IF (SELECT profesional_id FROM public.cardiolink_hc_evoluciones WHERE id='qa3c_evo_m1') <> 'qa3c_matias' THEN RAISE EXCEPTION 'FALLA T7: cambió el profesional de la evolución de Matías'; END IF;
  INSERT INTO t_res VALUES ('T7 la evolución de Matías no cambió (texto ni profesional_id)');
END $t$;

-- ===== T8 políticas: abiertas reemplazadas; 8 políticas _v1 sólo TO authenticated =====
DO $t$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND (policyname LIKE '%\_authenticated' ESCAPE '\' OR qual='true' OR with_check='true')) THEN RAISE EXCEPTION 'FALLA T8: quedan políticas abiertas'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen')) <> 8 THEN RAISE EXCEPTION 'FALLA T8: no son 8 políticas'; END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND (permissive <> 'PERMISSIVE' OR roles <> ARRAY['authenticated']::name[])) THEN RAISE EXCEPTION 'FALLA T8: política con rol distinto de authenticated'; END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.cardiolink_hc_evoluciones'::regclass) OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.cardiolink_hc_resumen'::regclass) THEN RAISE EXCEPTION 'FALLA T8: RLS apagada'; END IF;
  INSERT INTO t_res VALUES ('T8 abiertas reemplazadas; 8 políticas _v1 PERMISSIVE sólo TO authenticated; RLS activa');
END $t$;

-- ===== T9 SECURITY DEFINER: no permiten eludir; sin EXECUTE para anon/PUBLIC; todo lo ejecutable que toca HC devuelve sólo boolean =====
DO $t$
DECLARE f record; n int := 0;
BEGIN
  FOR f IN SELECT p.oid, p.oid::regprocedure::text AS firma, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS dueno, p.prorettype
             FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname IN ('cardiolink_ctx_rol_v1','cardiolink_ctx_prof_v1','cardiolink_paciente_padron_v1','cardiolink_paciente_acceso_clinico_v1') LOOP
    n := n + 1;
    IF NOT f.prosecdef OR f.dueno <> 'postgres' OR NOT (f.proconfig::text LIKE '%search_path=pg_catalog, public%') THEN RAISE EXCEPTION 'FALLA T9: % no es SECURITY DEFINER con search_path fijo y dueño postgres', f.firma; END IF;
    IF has_function_privilege('anon', f.oid, 'EXECUTE') OR has_function_privilege('public', f.oid, 'EXECUTE') THEN RAISE EXCEPTION 'FALLA T9: % ejecutable por anon/PUBLIC', f.firma; END IF;
  END LOOP;
  IF n < 4 THEN RAISE EXCEPTION 'FALLA T9: faltan funciones de contexto (%)', n; END IF;
  -- cualquier función SECURITY DEFINER que lea HC y sea ejecutable por anon/authenticated debe devolver sólo boolean
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.prosecdef AND p.prosrc ~* 'cardiolink_hc_(evoluciones|resumen)' AND p.prorettype <> 'boolean'::regtype
               AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))) THEN RAISE EXCEPTION 'FALLA T9: una función SECURITY DEFINER que lee HC y devuelve algo distinto de boolean es ejecutable por anon/authenticated'; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.prosecdef AND p.prosrc ~* 'cardiolink_hc_(evoluciones|resumen)' AND has_function_privilege('anon', p.oid, 'EXECUTE')) THEN RAISE EXCEPTION 'FALLA T9: una función que lee HC es ejecutable por anon'; END IF;
  IF EXISTS (SELECT 1 FROM pg_class c WHERE c.relkind IN ('v','m') AND c.relnamespace='public'::regnamespace AND pg_get_viewdef(c.oid) ~* 'cardiolink_hc_(evoluciones|resumen)') THEN RAISE EXCEPTION 'FALLA T9: hay vistas sobre las tablas de HC (evitarían la RLS)'; END IF;
  IF EXISTS (SELECT 1 FROM pg_publication_tables WHERE tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen')) THEN RAISE EXCEPTION 'FALLA T9: las tablas de HC están en una publicación (Realtime)'; END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid IN ('public.cardiolink_hc_evoluciones'::regclass,'public.cardiolink_hc_resumen'::regclass) AND NOT tgisinternal) THEN RAISE EXCEPTION 'FALLA T9: hay triggers sobre HC (revisar que no sean SECURITY DEFINER que eludan permisos)'; END IF;
  INSERT INTO t_res VALUES ('T9 funciones de contexto SECURITY DEFINER con search_path fijo y sin EXECUTE para anon/PUBLIC; las que leen HC devuelven sólo boolean; sin vistas, publicaciones ni triggers sobre HC');
END $t$;
