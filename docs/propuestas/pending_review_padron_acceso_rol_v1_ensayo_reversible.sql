-- CardioLink · Bloque 0B · acceso al padrón con rol activo · ENSAYO REVERSIBLE. GENERADO por pending_review_padron_acceso_rol_v1_generar_ensayo.sh: no editar a mano.
-- Sin BEGIN/COMMIT: el SQL Editor corre todo en UNA transacción y el script termina SIEMPRE con una EXCEPTION, que revierte todo (filas qa0b_*, cambios de rol sintéticos, políticas aplicadas).
-- RESULTADO ESPERADO: error final "ENSAYO_0B_OK: N pruebas ..." (señal de éxito + rollback). Cualquier otro mensaje "FALLA ..." indica la prueba que no pasó. Deja la base como estaba.
-- Orden: foto -> pruebas (estado de hoy: el problema) -> PARTE A -> PARTE B -> pruebas (cerrado) + extras -> rollback B -> rollback A -> pruebas (otra vez abierto) -> la foto debe coincidir exactamente.
-- No toca datos: sólo inserta y borra filas sintéticas qa0b_* dentro de la transacción.
CREATE TEMP TABLE t_antes AS SELECT tablename, policyname, cmd, permissive, roles::text AS roles, qual, with_check FROM pg_policies WHERE schemaname IN ('public','storage');
CREATE TEMP TABLE t_acl_antes AS SELECT relname, relacl::text AS acl FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r';
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
DO $ens$ BEGIN PERFORM pg_temp.suite('abierto'); END $ens$;
-- ===== PARTE A =====
-- CardioLink · Bloque 0B · Acceso al padrón sólo con rol ACTIVO · PARTE A · cardiolink_pacientes
-- BORRADOR PARA REVISIÓN. NO EJECUTAR en Production ni en STAGING sin autorización explícita. Primero el ensayo reversible (pending_review_padron_acceso_rol_v1_ensayo_reversible.sql).
-- Una sola transacción, sin DML sobre datos. Falla (y revierte todo) si el estado de partida no es exactamente el esperado. Rollback: pending_review_padron_acceso_rol_v1_a_pacientes_rollback.sql
--
-- PROBLEMA (verificado en solo lectura, 2026-11-24, en Production y en STAGING): cardiolink_pacientes tiene UNA sola política, cardiolink_pacientes_authenticated:
--   PERMISSIVE, ALL, TO authenticated, USING (true) WITH CHECK (true).
-- Cualquier sesión de Supabase Auth —aunque no tenga fila en cardiolink_user_roles, o la tenga con active=false— lee y escribe el padrón completo (1055 pacientes en Production).
-- Efecto directo sobre Gestión de Usuarios V1: desactivar una cuenta (active=false) NO le quita el padrón; sólo vencería su JWT.
--
-- CORRECCIÓN MÍNIMA. Se reemplaza esa política por una equivalente CON LA MISMA ALCANCE FUNCIONAL para el personal y cerrada para el resto:
--   cardiolink_pacientes_rol_activo_v1: PERMISSIVE, ALL, TO authenticated, USING / WITH CHECK  (SELECT cardiolink_ctx_rol_v1()) = ANY ('owner','admin','medico','secretaria').
-- cardiolink_ctx_rol_v1() (SECURITY DEFINER, search_path fijo, ya en uso por las políticas de atenciones, documentos y Storage) devuelve el base_role SÓLO si la fila de
-- cardiolink_user_roles del auth.uid() está activa; en cualquier otro caso NULL ⇒ la comparación da NULL ⇒ acceso denegado (falla cerrada).
--
-- PADRÓN COMPARTIDO PRESERVADO (decisión del Dueño): todo owner, admin, médico y Secretaría ACTIVO conserva exactamente el mismo acceso de hoy (leer, crear, actualizar/upsert y borrar);
-- no se distingue por profesional ni por asociación. No cambia ninguna otra política, ninguna función, ningún privilegio de tabla ni ningún dato.
-- NO se ven afectados: service_role (BYPASSRLS: portal-gateway, appointment-cancellation-public, patient-reminders-24h, patient-communications, patient-document-delivery);
-- las funciones SECURITY DEFINER que consultan el padrón (cardiolink_paciente_padron_v1, acceso_clinico, etc.); las comprobaciones de claves foráneas (las hace el sistema sin RLS).
-- Sí quedan sin acceso (intencionalmente): sesiones sin fila en cardiolink_user_roles y cuentas con active=false.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
DECLARE v_oid oid := to_regclass('public.cardiolink_pacientes');
        v_auth oid := (SELECT oid FROM pg_roles WHERE rolname = 'authenticated');
BEGIN
  IF v_oid IS NULL THEN RAISE EXCEPTION 'Precondición: falta public.cardiolink_pacientes'; END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_oid) THEN RAISE EXCEPTION 'Precondición: RLS apagada en cardiolink_pacientes (no es el estado esperado)'; END IF;
  IF to_regprocedure('public.cardiolink_ctx_rol_v1()') IS NULL THEN RAISE EXCEPTION 'Precondición: falta public.cardiolink_ctx_rol_v1()'; END IF;
  IF NOT (SELECT prosecdef AND coalesce(proconfig::text, '') LIKE '%search_path=pg_catalog, public%' FROM pg_proc WHERE oid = to_regprocedure('public.cardiolink_ctx_rol_v1()')) THEN
    RAISE EXCEPTION 'Precondición: cardiolink_ctx_rol_v1() debe ser SECURITY DEFINER con search_path fijo'; END IF;
  IF NOT has_function_privilege('authenticated', 'public.cardiolink_ctx_rol_v1()', 'EXECUTE') OR has_function_privilege('anon', 'public.cardiolink_ctx_rol_v1()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Precondición: privilegios de cardiolink_ctx_rol_v1() (authenticated sí, anon no)'; END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = v_oid AND polname = 'cardiolink_pacientes_rol_activo_v1') THEN RAISE EXCEPTION 'La PARTE A ya está aplicada: no se repite'; END IF;
  IF (SELECT count(*) FROM pg_policy WHERE polrelid = v_oid) <> 1 THEN RAISE EXCEPTION 'Precondición: cardiolink_pacientes debe tener exactamente 1 política (tiene %)', (SELECT count(*) FROM pg_policy WHERE polrelid = v_oid); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = v_oid AND polname = 'cardiolink_pacientes_authenticated' AND polpermissive AND polcmd = '*'
                    AND polroles = ARRAY[v_auth]::oid[] AND pg_get_expr(polqual, polrelid) = 'true' AND pg_get_expr(polwithcheck, polrelid) = 'true') THEN
    RAISE EXCEPTION 'Precondición: la política de cardiolink_pacientes no es la esperada (cardiolink_pacientes_authenticated, PERMISSIVE, ALL, authenticated, true/true): el estado difiere'; END IF;
END $$;

-- Se crea la nueva ANTES de quitar la anterior, dentro de la misma transacción: ninguna otra sesión llega a ver un estado intermedio.
CREATE POLICY cardiolink_pacientes_rol_activo_v1 ON public.cardiolink_pacientes
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((SELECT public.cardiolink_ctx_rol_v1()) = ANY (ARRAY['owner', 'admin', 'medico', 'secretaria']))
  WITH CHECK ((SELECT public.cardiolink_ctx_rol_v1()) = ANY (ARRAY['owner', 'admin', 'medico', 'secretaria']));
COMMENT ON POLICY cardiolink_pacientes_rol_activo_v1 ON public.cardiolink_pacientes IS 'Bloque 0B: padrón compartido por todo el personal con rol ACTIVO (owner/admin/medico/secretaria). Sin fila en cardiolink_user_roles o con active=false: sin acceso. Reemplaza a cardiolink_pacientes_authenticated (true/true).';
DROP POLICY cardiolink_pacientes_authenticated ON public.cardiolink_pacientes;

-- Postcondiciones
DO $$
DECLARE v_oid oid := 'public.cardiolink_pacientes'::regclass; q text; w text;
BEGIN
  IF (SELECT count(*) FROM pg_policy WHERE polrelid = v_oid) <> 1 THEN RAISE EXCEPTION 'Postcondición: debe quedar exactamente 1 política en cardiolink_pacientes'; END IF;
  SELECT pg_get_expr(polqual, polrelid), pg_get_expr(polwithcheck, polrelid) INTO q, w FROM pg_policy
   WHERE polrelid = v_oid AND polname = 'cardiolink_pacientes_rol_activo_v1' AND polpermissive AND polcmd = '*' AND polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname = 'authenticated')]::oid[];
  IF q IS NULL THEN RAISE EXCEPTION 'Postcondición: la política nueva no quedó PERMISSIVE / ALL / authenticated'; END IF;
  IF q = 'true' OR w = 'true' OR q NOT LIKE '%cardiolink_ctx_rol_v1%' OR w NOT LIKE '%cardiolink_ctx_rol_v1%' THEN RAISE EXCEPTION 'Postcondición: la política no depende del rol activo'; END IF;
  IF q NOT LIKE '%owner%' OR q NOT LIKE '%admin%' OR q NOT LIKE '%medico%' OR q NOT LIKE '%secretaria%' THEN RAISE EXCEPTION 'Postcondición: falta alguno de los cuatro roles en la política'; END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_oid) OR (SELECT relforcerowsecurity FROM pg_class WHERE oid = v_oid) THEN RAISE EXCEPTION 'Postcondición: RLS debe quedar activada y NO forzada (service_role y las funciones SECURITY DEFINER dependen de ello)'; END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = v_oid AND polname = 'cardiolink_pacientes_authenticated') THEN RAISE EXCEPTION 'Postcondición: sigue existiendo la política abierta'; END IF;
END $$;
-- ===== PARTE B =====
-- CardioLink · Bloque 0B · Acceso sólo con rol ACTIVO · PARTE B · cinco tablas heredadas (atenciones, medicos, obras_sociales, pacientes, prestaciones)
-- BORRADOR PARA REVISIÓN. NO EJECUTAR sin autorización explícita. INDEPENDIENTE de la PARTE A (se puede aplicar antes, después o nunca). Una sola transacción, sin DML.
-- Rollback: pending_review_padron_acceso_rol_v1_b_legacy_rollback.sql
--
-- ESTADO VERIFICADO (solo lectura, 2026-11-24): existen SÓLO en Production (STAGING no las tiene). Las cinco están VACÍAS (0 filas), sin triggers, sin vistas dependientes, sin publicaciones;
-- ningún archivo del repo las consulta (el cliente usa cardiolink_atenciones y cardiolink_pacientes; las Edge Functions usan service_role). Cada una tiene RLS activada y UNA política
-- "Usuarios logueados pueden usar <tabla>": PERMISSIVE, ALL, TO authenticated, USING (true) WITH CHECK (true). Además atenciones.paciente_id tiene una FK hacia la tabla heredada pacientes.
-- Cualquier sesión autenticada (con o sin rol activo) puede escribir en ellas.
--
-- CORRECCIÓN MÍNIMA: cada política abierta se reemplaza por <tabla>_rol_activo_v1 con la MISMA condición que cardiolink_pacientes_rol_activo_v1 (rol ACTIVO owner/admin/medico/secretaria).
-- Para el personal activo el comportamiento no cambia en absoluto (hoy nadie las usa). No se borran tablas, filas ni políticas de ninguna otra tabla.
-- ALTERNATIVA (no elegida): quitar la política y dejar las tablas sin acceso para authenticated. Es más estricta, pero cambia el contrato de tablas que podrían tener algún cliente antiguo; se puede adoptar después.
-- Si en la base no existe ninguna de las cinco tablas (STAGING), el script no hace nada y lo avisa.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
DECLARE
  v_map text[][] := ARRAY[['atenciones', 'Usuarios logueados pueden usar atenciones'],
                          ['medicos', 'Usuarios logueados pueden usar medicos'],
                          ['obras_sociales', 'Usuarios logueados pueden usar obras sociales'],
                          ['pacientes', 'Usuarios logueados pueden usar pacientes'],
                          ['prestaciones', 'Usuarios logueados pueden usar prestaciones']];
  v_auth oid := (SELECT oid FROM pg_roles WHERE rolname = 'authenticated');
  v_oid oid; v_t text; v_old text; v_new text; i int; n int := 0;
BEGIN
  IF to_regprocedure('public.cardiolink_ctx_rol_v1()') IS NULL THEN RAISE EXCEPTION 'Precondición: falta public.cardiolink_ctx_rol_v1()'; END IF;
  IF NOT has_function_privilege('authenticated', 'public.cardiolink_ctx_rol_v1()', 'EXECUTE') THEN RAISE EXCEPTION 'Precondición: authenticated no puede ejecutar cardiolink_ctx_rol_v1()'; END IF;
  -- 1) verificación de TODAS las tablas antes de tocar ninguna
  FOR i IN 1 .. array_length(v_map, 1) LOOP
    v_t := v_map[i][1]; v_old := v_map[i][2]; v_new := v_t || '_rol_activo_v1'; v_oid := to_regclass(format('public.%I', v_t));
    CONTINUE WHEN v_oid IS NULL;
    n := n + 1;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_oid) THEN RAISE EXCEPTION 'Precondición: RLS apagada en %', v_t; END IF;
    IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = v_oid AND polname = v_new) THEN RAISE EXCEPTION 'La PARTE B ya está aplicada (%): no se repite', v_t; END IF;
    IF (SELECT count(*) FROM pg_policy WHERE polrelid = v_oid) <> 1 THEN RAISE EXCEPTION 'Precondición: % debe tener exactamente 1 política', v_t; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = v_oid AND polname = v_old AND polpermissive AND polcmd = '*' AND polroles = ARRAY[v_auth]::oid[]
                      AND pg_get_expr(polqual, polrelid) = 'true' AND pg_get_expr(polwithcheck, polrelid) = 'true') THEN
      RAISE EXCEPTION 'Precondición: la política de % no es la esperada (%): el estado difiere', v_t, v_old; END IF;
  END LOOP;
  IF n = 0 THEN RAISE NOTICE 'PARTE B: no existe ninguna tabla heredada en esta base; no se hace nada.'; RETURN; END IF;
  -- 2) aplicar (la política nueva se crea antes de quitar la anterior, en la misma transacción)
  FOR i IN 1 .. array_length(v_map, 1) LOOP
    v_t := v_map[i][1]; v_old := v_map[i][2]; v_new := v_t || '_rol_activo_v1'; v_oid := to_regclass(format('public.%I', v_t));
    CONTINUE WHEN v_oid IS NULL;
    EXECUTE format($p$CREATE POLICY %I ON public.%I AS PERMISSIVE FOR ALL TO authenticated
                      USING ((SELECT public.cardiolink_ctx_rol_v1()) = ANY (ARRAY['owner', 'admin', 'medico', 'secretaria']))
                      WITH CHECK ((SELECT public.cardiolink_ctx_rol_v1()) = ANY (ARRAY['owner', 'admin', 'medico', 'secretaria']))$p$, v_new, v_t);
    EXECUTE format('DROP POLICY %I ON public.%I', v_old, v_t);
  END LOOP;
  -- 3) postcondiciones
  FOR i IN 1 .. array_length(v_map, 1) LOOP
    v_t := v_map[i][1]; v_new := v_t || '_rol_activo_v1'; v_oid := to_regclass(format('public.%I', v_t));
    CONTINUE WHEN v_oid IS NULL;
    IF (SELECT count(*) FROM pg_policy WHERE polrelid = v_oid) <> 1
       OR NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = v_oid AND polname = v_new AND polpermissive AND polcmd = '*' AND polroles = ARRAY[v_auth]::oid[]
                        AND pg_get_expr(polqual, polrelid) LIKE '%cardiolink_ctx_rol_v1%' AND pg_get_expr(polwithcheck, polrelid) LIKE '%cardiolink_ctx_rol_v1%'
                        AND pg_get_expr(polqual, polrelid) <> 'true' AND pg_get_expr(polwithcheck, polrelid) <> 'true') THEN
      RAISE EXCEPTION 'Postcondición: la política de % no quedó como se esperaba', v_t; END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_oid) OR (SELECT relforcerowsecurity FROM pg_class WHERE oid = v_oid) THEN RAISE EXCEPTION 'Postcondición: RLS de % debe quedar activa y no forzada', v_t; END IF;
  END LOOP;
END $$;
DO $ens$ BEGIN PERFORM pg_temp.suite('cerrado'); PERFORM pg_temp.extras(); END $ens$;
-- ===== ROLLBACKS =====
-- CardioLink · Bloque 0B · ROLLBACK de la PARTE B (tablas heredadas)
-- ATENCIÓN: restaura las políticas ABIERTAS originales (true/true) en las tablas heredadas que tengan la política *_rol_activo_v1. Una sola transacción; no toca datos.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $$
DECLARE
  v_map text[][] := ARRAY[['atenciones', 'Usuarios logueados pueden usar atenciones'],
                          ['medicos', 'Usuarios logueados pueden usar medicos'],
                          ['obras_sociales', 'Usuarios logueados pueden usar obras sociales'],
                          ['pacientes', 'Usuarios logueados pueden usar pacientes'],
                          ['prestaciones', 'Usuarios logueados pueden usar prestaciones']];
  v_auth oid := (SELECT oid FROM pg_roles WHERE rolname = 'authenticated');
  v_oid oid; v_t text; v_old text; v_new text; i int; n int := 0;
BEGIN
  FOR i IN 1 .. array_length(v_map, 1) LOOP
    v_t := v_map[i][1]; v_old := v_map[i][2]; v_new := v_t || '_rol_activo_v1'; v_oid := to_regclass(format('public.%I', v_t));
    CONTINUE WHEN v_oid IS NULL;
    IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = v_oid AND polname = v_new) THEN RAISE EXCEPTION 'La PARTE B no está aplicada en %: nada que revertir', v_t; END IF;
    IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = v_oid AND polname = v_old) OR (SELECT count(*) FROM pg_policy WHERE polrelid = v_oid) <> 1 THEN RAISE EXCEPTION 'Precondición: estado inesperado de las políticas de %', v_t; END IF;
    n := n + 1;
  END LOOP;
  IF n = 0 THEN RAISE NOTICE 'PARTE B: no existe ninguna tabla heredada en esta base; no se hace nada.'; RETURN; END IF;
  FOR i IN 1 .. array_length(v_map, 1) LOOP
    v_t := v_map[i][1]; v_old := v_map[i][2]; v_new := v_t || '_rol_activo_v1'; v_oid := to_regclass(format('public.%I', v_t));
    CONTINUE WHEN v_oid IS NULL;
    EXECUTE format('CREATE POLICY %I ON public.%I AS PERMISSIVE FOR ALL TO authenticated USING (true) WITH CHECK (true)', v_old, v_t);
    EXECUTE format('DROP POLICY %I ON public.%I', v_new, v_t);
    IF (SELECT count(*) FROM pg_policy WHERE polrelid = v_oid) <> 1
       OR NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = v_oid AND polname = v_old AND polpermissive AND polcmd = '*' AND polroles = ARRAY[v_auth]::oid[]
                        AND pg_get_expr(polqual, polrelid) = 'true' AND pg_get_expr(polwithcheck, polrelid) = 'true') THEN
      RAISE EXCEPTION 'Postcondición: no se restauró la política original de %', v_t; END IF;
  END LOOP;
END $$;
-- CardioLink · Bloque 0B · ROLLBACK de la PARTE A (cardiolink_pacientes)
-- ATENCIÓN: restaura la política ABIERTA original (USING true / WITH CHECK true): cualquier sesión autenticada, con o sin rol activo, vuelve a leer y escribir el padrón.
-- Usar sólo si la política nueva bloquea un flujo legítimo que no se pudo corregir de otra forma. Una sola transacción; falla si el estado no es el esperado.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $$
DECLARE v_oid oid := to_regclass('public.cardiolink_pacientes');
BEGIN
  IF v_oid IS NULL THEN RAISE EXCEPTION 'Precondición: falta public.cardiolink_pacientes'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = v_oid AND polname = 'cardiolink_pacientes_rol_activo_v1') THEN RAISE EXCEPTION 'La PARTE A no está aplicada: nada que revertir'; END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = v_oid AND polname = 'cardiolink_pacientes_authenticated') THEN RAISE EXCEPTION 'Precondición: ya existe cardiolink_pacientes_authenticated (estado inesperado)'; END IF;
  IF (SELECT count(*) FROM pg_policy WHERE polrelid = v_oid) <> 1 THEN RAISE EXCEPTION 'Precondición: se esperaba exactamente 1 política en cardiolink_pacientes'; END IF;
END $$;

CREATE POLICY cardiolink_pacientes_authenticated ON public.cardiolink_pacientes AS PERMISSIVE FOR ALL TO authenticated USING (true) WITH CHECK (true);
DROP POLICY cardiolink_pacientes_rol_activo_v1 ON public.cardiolink_pacientes;

DO $$
DECLARE v_oid oid := 'public.cardiolink_pacientes'::regclass;
BEGIN
  IF (SELECT count(*) FROM pg_policy WHERE polrelid = v_oid) <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = v_oid AND polname = 'cardiolink_pacientes_authenticated' AND polpermissive AND polcmd = '*'
                      AND polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname = 'authenticated')]::oid[] AND pg_get_expr(polqual, polrelid) = 'true' AND pg_get_expr(polwithcheck, polrelid) = 'true') THEN
    RAISE EXCEPTION 'Postcondición: no se restauró la política original'; END IF;
END $$;
DO $ens$ BEGIN PERFORM pg_temp.suite('abierto'); END $ens$;
DO $$
DECLARE n int;
BEGIN
  IF EXISTS (SELECT tablename, policyname, cmd, permissive, roles::text, qual, with_check FROM pg_policies WHERE schemaname IN ('public','storage')
             EXCEPT SELECT tablename, policyname, cmd, permissive, roles, qual, with_check FROM t_antes)
     OR EXISTS (SELECT tablename, policyname, cmd, permissive, roles, qual, with_check FROM t_antes
             EXCEPT SELECT tablename, policyname, cmd, permissive, roles::text, qual, with_check FROM pg_policies WHERE schemaname IN ('public','storage')) THEN
    RAISE EXCEPTION 'FALLA R1: tras los rollbacks las políticas NO coinciden con la foto inicial'; END IF;
  IF EXISTS (SELECT relname, relacl::text FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' EXCEPT SELECT relname, acl FROM t_acl_antes)
     OR EXISTS (SELECT relname, acl FROM t_acl_antes EXCEPT SELECT relname, relacl::text FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r') THEN
    RAISE EXCEPTION 'FALLA R2: tras los rollbacks cambiaron privilegios de tablas'; END IF;
  IF EXISTS (SELECT 1 FROM public.cardiolink_pacientes WHERE id LIKE 'qa0b\_%' ESCAPE '\' AND id NOT IN ('qa0b_fix_1','qa0b_fix_2')) THEN RAISE EXCEPTION 'FALLA R3: quedaron filas sintéticas sueltas'; END IF;
  SELECT count(*) INTO n FROM t_res;
  RAISE EXCEPTION 'ENSAYO_0B_OK: % pruebas pasaron, los rollbacks restauraron políticas y privilegios exactamente y todo se revierte (esta EXCEPTION es la señal de éxito)', n;
END $$;
