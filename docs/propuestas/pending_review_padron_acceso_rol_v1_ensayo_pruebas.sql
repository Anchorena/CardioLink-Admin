-- ===== PRUEBAS Bloque 0B (como cada actor real, vía claims + SET LOCAL ROLE; todo sintético qa0b_*; el veredicto final es una EXCEPTION que revierte todo) =====
-- Actores reales del entorno: owner, Secretaría y médico activos. Se simulan variantes TEMPORALES (admin, médico sin professional_id, inactivo) con UPDATE dentro de la transacción; todo se revierte.
CREATE TEMP TABLE t_act(clave text PRIMARY KEY, uid uuid);
GRANT SELECT ON t_act TO authenticated;
CREATE TEMP TABLE t_res(nombre text);
GRANT ALL ON t_res TO authenticated;
CREATE TEMP TABLE t_rol_orig AS SELECT user_id, base_role, professional_id, active FROM public.cardiolink_user_roles;
DO $$
DECLARE o uuid; s uuid; m uuid;
BEGIN
  SELECT user_id INTO o FROM public.cardiolink_user_roles WHERE base_role = 'owner' AND active ORDER BY user_id LIMIT 1;
  SELECT user_id INTO s FROM public.cardiolink_user_roles WHERE base_role = 'secretaria' AND active ORDER BY user_id LIMIT 1;
  SELECT user_id INTO m FROM public.cardiolink_user_roles WHERE base_role = 'medico' AND active AND professional_id ~ '^[A-Za-z0-9_.-]{1,64}$' ORDER BY user_id LIMIT 1;
  IF o IS NULL OR s IS NULL OR m IS NULL THEN RAISE EXCEPTION 'Faltan actores (owner, secretaria y médico con professional_id, todos activos)'; END IF;
  INSERT INTO t_act VALUES ('own', o), ('adm', o), ('sec', s), ('med', m), ('medsp', m), ('inact', m), ('nadie', gen_random_uuid());
  IF EXISTS (SELECT 1 FROM public.cardiolink_pacientes WHERE id LIKE 'qa0b\_%' ESCAPE '\') THEN RAISE EXCEPTION 'Ya existen filas qa0b_* en cardiolink_pacientes: se aborta'; END IF;
END $$;

-- constructor de INSERT con valores sintéticos para columnas obligatorias sin default (sólo se llama como postgres; el sufijo del id evita choques con índices únicos)
CREATE FUNCTION pg_temp.arma_insert(p_tabla text, p_val jsonb) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE c record; cols text := ''; vals text := ''; v text; k text; suf text := coalesce(p_val ->> 'id', 'x');
BEGIN
  FOR k IN SELECT jsonb_object_keys(p_val) LOOP
    cols := cols || CASE WHEN cols = '' THEN '' ELSE ',' END || quote_ident(k);
    vals := vals || CASE WHEN vals = '' THEN '' ELSE ',' END || quote_literal(p_val ->> k);
  END LOOP;
  FOR c IN SELECT column_name, data_type FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = p_tabla AND is_nullable = 'NO' AND column_default IS NULL AND is_identity = 'NO' AND NOT (p_val ? column_name) ORDER BY ordinal_position LOOP
    IF c.data_type IN ('text', 'character varying', 'character') THEN v := quote_literal('QA0B-' || suf);
    ELSIF c.data_type LIKE 'timestamp%' THEN v := 'now()';
    ELSIF c.data_type = 'date' THEN v := 'current_date';
    ELSIF c.data_type = 'boolean' THEN v := 'false';
    ELSIF c.data_type IN ('integer', 'bigint', 'smallint', 'numeric') THEN v := '0';
    ELSIF c.data_type = 'uuid' THEN v := 'gen_random_uuid()';
    ELSIF c.data_type IN ('jsonb', 'json') THEN v := quote_literal('{}') || '::' || c.data_type;
    ELSE RAISE EXCEPTION 'columna obligatoria % (%) sin valor sintético', c.column_name, c.data_type; END IF;
    cols := cols || CASE WHEN cols = '' THEN '' ELSE ',' END || quote_ident(c.column_name); vals := vals || CASE WHEN vals = '' THEN '' ELSE ',' END || v;
  END LOOP;
  IF cols = '' THEN RETURN format('INSERT INTO public.%I DEFAULT VALUES', p_tabla); END IF;
  RETURN format('INSERT INTO public.%I (%s) VALUES (%s)', p_tabla, cols, vals);
END $f$;

-- fixture como postgres: dos pacientes sintéticos
DO $$ BEGIN
  EXECUTE pg_temp.arma_insert('cardiolink_pacientes', jsonb_build_object('id', 'qa0b_fix_1'));
  EXECUTE pg_temp.arma_insert('cardiolink_pacientes', jsonb_build_object('id', 'qa0b_fix_2'));
END $$;

CREATE FUNCTION pg_temp.prep(p_clave text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  IF p_clave = 'adm' THEN UPDATE public.cardiolink_user_roles SET base_role = 'admin' WHERE user_id = (SELECT uid FROM t_act WHERE clave = 'adm');
  ELSIF p_clave = 'medsp' THEN UPDATE public.cardiolink_user_roles SET professional_id = NULL WHERE user_id = (SELECT uid FROM t_act WHERE clave = 'medsp');
  ELSIF p_clave = 'inact' THEN UPDATE public.cardiolink_user_roles SET active = false WHERE user_id = (SELECT uid FROM t_act WHERE clave = 'inact');
  END IF;
END $f$;
CREATE FUNCTION pg_temp.restaurar() RETURNS void LANGUAGE sql AS $f$
  UPDATE public.cardiolink_user_roles u SET base_role = o.base_role, professional_id = o.professional_id, active = o.active
    FROM t_rol_orig o WHERE u.user_id = o.user_id AND (u.base_role, u.professional_id, u.active) IS DISTINCT FROM (o.base_role, o.professional_id, o.active)
$f$;

-- Las operaciones del padrón como la app: leer, upsert (INSERT … ON CONFLICT DO UPDATE), actualizar y borrar lo propio.
CREATE FUNCTION pg_temp.probar(p_clave text, p_uid uuid, p_role text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v_sel int; v_i text; v_u int; v_d int; v_id text := 'qa0b_' || p_clave; v_ins text;
BEGIN
  v_ins := pg_temp.arma_insert('cardiolink_pacientes', jsonb_build_object('id', v_id)) || ' ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id';
  PERFORM set_config('request.jwt.claims', CASE WHEN p_uid IS NULL THEN '' ELSE json_build_object('sub', p_uid, 'role', p_role)::text END, true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  -- "denegado" = la RLS filtra/rechaza (42501 de política) O la tabla no tiene privilegio para ese rol (42501 de GRANT; es el caso real de anon sobre el padrón): ambos cuentan como 0 / 'rls'
  BEGIN SELECT count(*) INTO v_sel FROM public.cardiolink_pacientes WHERE id IN ('qa0b_fix_1', 'qa0b_fix_2'); EXCEPTION WHEN insufficient_privilege THEN v_sel := 0; END;
  BEGIN EXECUTE v_ins; v_i := 'ok'; EXCEPTION WHEN insufficient_privilege THEN v_i := 'rls'; END;
  BEGIN UPDATE public.cardiolink_pacientes SET id = id WHERE id = 'qa0b_fix_2'; GET DIAGNOSTICS v_u = ROW_COUNT; EXCEPTION WHEN insufficient_privilege THEN v_u := 0; END;
  BEGIN DELETE FROM public.cardiolink_pacientes WHERE id = v_id; GET DIAGNOSTICS v_d = ROW_COUNT; EXCEPTION WHEN insufficient_privilege THEN v_d := 0; END;
  RESET ROLE;
  DELETE FROM public.cardiolink_pacientes WHERE id = v_id;
  RETURN format('sel=%s ins=%s upd=%s del=%s', v_sel, v_i, v_u, v_d);
END $f$;

-- Tablas heredadas (sólo existen en Production): ¿una escritura de este actor pasa la RLS? ('rls' = bloqueada por la política; 'pasa' = la RLS lo permite, aunque luego falle por una FK u otra restricción)
CREATE FUNCTION pg_temp.probar_leg(p_tabla text, p_uid uuid) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v_ins text; v_r text;
BEGIN
  v_ins := pg_temp.arma_insert(p_tabla, '{}'::jsonb);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN EXECUTE v_ins; v_r := 'pasa';
  EXCEPTION WHEN insufficient_privilege THEN v_r := 'rls'; WHEN OTHERS THEN v_r := 'pasa'; END;
  RESET ROLE;
  EXECUTE format('DELETE FROM public.%I', p_tabla);   -- sólo se llama si la tabla estaba vacía
  RETURN v_r;
END $f$;

-- Suite completa para una fase: 'abierto' (estado de hoy / tras el rollback) o 'cerrado' (tras aplicar A y B)
CREATE FUNCTION pg_temp.suite(p_fase text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE k text; u uuid; r text; esperado text; falla text := ''; tb text; n bigint;
  v_abierto constant text := 'sel=2 ins=ok upd=1 del=1'; v_cerrado constant text := 'sel=0 ins=rls upd=0 del=0';
BEGIN
  FOREACH k IN ARRAY ARRAY['own', 'adm', 'sec', 'med', 'medsp', 'inact', 'nadie'] LOOP
    SELECT uid INTO u FROM t_act WHERE clave = k;
    PERFORM pg_temp.prep(k);
    r := pg_temp.probar(k, u, 'authenticated');
    PERFORM pg_temp.restaurar();
    esperado := CASE WHEN k IN ('inact', 'nadie') AND p_fase = 'cerrado' THEN v_cerrado ELSE v_abierto END;
    IF r <> esperado THEN falla := falla || format(' [%s: %s <> %s]', k, r, esperado); END IF;
  END LOOP;
  r := pg_temp.probar('anon', NULL, 'anon');         IF r <> v_cerrado THEN falla := falla || format(' [anon: %s]', r); END IF;
  r := pg_temp.probar('svc', NULL, 'service_role');  IF r <> v_abierto THEN falla := falla || format(' [service_role: %s]', r); END IF;
  IF falla <> '' THEN RAISE EXCEPTION 'FALLA suite(%): %', p_fase, falla; END IF;
  INSERT INTO t_res VALUES ('padrón [' || p_fase || ']: personal activo (owner, admin, médico con y sin professional_id, Secretaría) y service_role conservan todo; ' ||
    CASE WHEN p_fase = 'cerrado' THEN 'inactivo y cuenta sin fila de roles: nada; ' ELSE 'inactivo y cuenta sin fila hoy también entran (el problema); ' END || 'anon: nada');
  FOREACH tb IN ARRAY ARRAY['atenciones', 'medicos', 'obras_sociales', 'pacientes', 'prestaciones'] LOOP
    CONTINUE WHEN to_regclass('public.' || tb) IS NULL;
    EXECUTE format('SELECT count(*) FROM public.%I', tb) INTO n;
    IF n <> 0 THEN INSERT INTO t_res VALUES ('heredada ' || tb || ': omitida (no está vacía: ' || n || ' filas)'); CONTINUE; END IF;
    r := pg_temp.probar_leg(tb, (SELECT uid FROM t_act WHERE clave = 'nadie'));
    esperado := CASE WHEN p_fase = 'cerrado' THEN 'rls' ELSE 'pasa' END;
    IF r <> esperado THEN RAISE EXCEPTION 'FALLA suite(%): heredada % para una cuenta sin fila de roles dio % (esperado %)', p_fase, tb, r, esperado; END IF;
    r := pg_temp.probar_leg(tb, (SELECT uid FROM t_act WHERE clave = 'sec'));
    IF r <> 'pasa' THEN RAISE EXCEPTION 'FALLA suite(%): heredada % para Secretaría activa dio %', p_fase, tb, r; END IF;
    INSERT INTO t_res VALUES ('heredada ' || tb || ' [' || p_fase || ']: personal activo escribe; cuenta sin fila ' || CASE WHEN p_fase = 'cerrado' THEN 'bloqueada' ELSE 'escribe (el problema)' END);
  END LOOP;
END $f$;

-- Comprobaciones adicionales (sólo tras aplicar A y B)
CREATE FUNCTION pg_temp.extras() RETURNS void LANGUAGE plpgsql AS $f$
DECLARE u uuid; r text; plan text; n int; k text;
BEGIN
  -- E1: las funciones SECURITY DEFINER que consultan el padrón no se afectan
  FOREACH k IN ARRAY ARRAY['med', 'own', 'sec', 'nadie'] LOOP
    SELECT uid INTO u FROM t_act WHERE clave = k;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    r := coalesce(r, '') || public.cardiolink_paciente_padron_v1('qa0b_fix_1')::text || ',';
    EXECUTE 'RESET ROLE';
  END LOOP;
  IF r <> 'true,true,false,false,' THEN RAISE EXCEPTION 'FALLA E1: cardiolink_paciente_padron_v1 cambió de comportamiento (obtuvo %)', r; END IF;
  -- E2: sólo cambiaron las políticas del padrón y de las tablas heredadas
  IF EXISTS (SELECT tablename, policyname, cmd, permissive, roles::text, qual, with_check FROM pg_policies WHERE schemaname IN ('public', 'storage') AND tablename NOT IN ('cardiolink_pacientes', 'atenciones', 'medicos', 'obras_sociales', 'pacientes', 'prestaciones')
             EXCEPT SELECT tablename, policyname, cmd, permissive, roles, qual, with_check FROM t_antes WHERE tablename NOT IN ('cardiolink_pacientes', 'atenciones', 'medicos', 'obras_sociales', 'pacientes', 'prestaciones'))
     OR EXISTS (SELECT tablename, policyname, cmd, permissive, roles, qual, with_check FROM t_antes WHERE tablename NOT IN ('cardiolink_pacientes', 'atenciones', 'medicos', 'obras_sociales', 'pacientes', 'prestaciones')
             EXCEPT SELECT tablename, policyname, cmd, permissive, roles::text, qual, with_check FROM pg_policies WHERE schemaname IN ('public', 'storage') AND tablename NOT IN ('cardiolink_pacientes', 'atenciones', 'medicos', 'obras_sociales', 'pacientes', 'prestaciones')) THEN
    RAISE EXCEPTION 'FALLA E2: cambió alguna política ajena al padrón y a las tablas heredadas'; END IF;
  -- E3: ningún privilegio de tabla cambió
  IF EXISTS (SELECT relname, relacl::text FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' EXCEPT SELECT relname, acl FROM t_acl_antes)
     OR EXISTS (SELECT relname, acl FROM t_acl_antes EXCEPT SELECT relname, relacl::text FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r') THEN
    RAISE EXCEPTION 'FALLA E3: cambiaron privilegios de tablas'; END IF;
  -- E4: la RLS sigue activa y no forzada; la política usa InitPlan
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.cardiolink_pacientes'::regclass) OR (SELECT relforcerowsecurity FROM pg_class WHERE oid = 'public.cardiolink_pacientes'::regclass) THEN RAISE EXCEPTION 'FALLA E4: RLS del padrón'; END IF;
  SELECT uid INTO u FROM t_act WHERE clave = 'own';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  plan := '';
  FOR r IN EXECUTE 'EXPLAIN (COSTS OFF) SELECT * FROM public.cardiolink_pacientes' LOOP plan := plan || r || E'\n'; END LOOP;
  EXECUTE 'RESET ROLE';
  IF plan NOT LIKE '%InitPlan%' THEN RAISE EXCEPTION 'FALLA E4: la política no usa InitPlan (plan: %)', plan; END IF;
  INSERT INTO t_res VALUES ('E1-E4: padrón_v1 intacta, políticas ajenas y privilegios idénticos, RLS activa y no forzada');
END $f$;
