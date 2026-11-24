-- CardioLink · Bloque 0B · CHECKS de SOLO LECTURA (antes y después de cada parte). No escribe nada. Pegar en el SQL Editor; devuelve UNA fila (jsonb).
-- Esperado ANTES:   pacientes_forma='abierta', precondicion_a_ok=true, legacy_forma={…:'abierta'} (Production) o {} (STAGING), ctx_rol_ok=true.
-- Esperado DESPUÉS: pacientes_forma='rol_activo'; legacy_forma={…:'rol_activo'}; politicas_true_authenticated=[] (ninguna otra política abierta en public/storage); el resto igual.
SELECT jsonb_build_object(
  'pacientes_forma', CASE
      WHEN NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.cardiolink_pacientes'::regclass) THEN 'sin_politicas'
      WHEN (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.cardiolink_pacientes'::regclass) = 1
           AND EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.cardiolink_pacientes'::regclass AND polname = 'cardiolink_pacientes_authenticated' AND pg_get_expr(polqual, polrelid) = 'true' AND pg_get_expr(polwithcheck, polrelid) = 'true') THEN 'abierta'
      WHEN (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.cardiolink_pacientes'::regclass) = 1
           AND EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.cardiolink_pacientes'::regclass AND polname = 'cardiolink_pacientes_rol_activo_v1' AND pg_get_expr(polqual, polrelid) LIKE '%cardiolink_ctx_rol_v1%') THEN 'rol_activo'
      ELSE 'otra' END,
  'pacientes_rls', (SELECT jsonb_build_object('activa', relrowsecurity, 'forzada', relforcerowsecurity) FROM pg_class WHERE oid = 'public.cardiolink_pacientes'::regclass),
  'pacientes_filas', (SELECT count(*) FROM public.cardiolink_pacientes),
  'precondicion_a_ok', (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.cardiolink_pacientes'::regclass) = 1 AND to_regprocedure('public.cardiolink_ctx_rol_v1()') IS NOT NULL
        AND has_function_privilege('authenticated', 'public.cardiolink_ctx_rol_v1()', 'EXECUTE') AND NOT has_function_privilege('anon', 'public.cardiolink_ctx_rol_v1()', 'EXECUTE'),
  'ctx_rol_ok', (SELECT md5(prosrc) = 'c0314d96d77aca02cb16621a9ded79dd' AND prosecdef FROM pg_proc WHERE oid = to_regprocedure('public.cardiolink_ctx_rol_v1()')),
  'legacy_forma', coalesce((SELECT jsonb_object_agg(c.relname, CASE
        WHEN (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) = 1 AND EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND pg_get_expr(p.polqual, p.polrelid) = 'true') THEN 'abierta'
        WHEN EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = c.relname || '_rol_activo_v1') THEN 'rol_activo'
        ELSE 'otra' END)
      FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname IN ('atenciones', 'medicos', 'obras_sociales', 'pacientes', 'prestaciones')), '{}'::jsonb),
  'legacy_filas', coalesce((SELECT jsonb_object_agg(c.relname, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', c.relname), false, true, '')))[1]::text::bigint) FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname IN ('atenciones', 'medicos', 'obras_sociales', 'pacientes', 'prestaciones')), '{}'::jsonb),
  -- cualquier otra política abierta para authenticated/anon/public en public o storage (informativo: tras A y B no debería quedar ninguna)
  'politicas_true_authenticated', coalesce((SELECT jsonb_agg(tablename || '.' || policyname ORDER BY tablename, policyname) FROM pg_policies
        WHERE schemaname IN ('public', 'storage') AND (qual = 'true' OR with_check = 'true') AND roles && ARRAY['authenticated', 'anon', 'public']::name[]), '[]'::jsonb),
  -- cuentas de Auth que HOY entran al padrón sin rol activo y dejarían de hacerlo (sólo cantidades; sin correos)
  'cuentas_auth_sin_rol_activo', (SELECT count(*) FROM auth.users u WHERE NOT EXISTS (SELECT 1 FROM public.cardiolink_user_roles r WHERE r.user_id = u.id AND r.active)),
  'cuentas_auth_sin_rol_activo_ultimo_ingreso', (SELECT coalesce(jsonb_agg(u.last_sign_in_at ORDER BY u.last_sign_in_at), '[]'::jsonb) FROM auth.users u WHERE NOT EXISTS (SELECT 1 FROM public.cardiolink_user_roles r WHERE r.user_id = u.id AND r.active)),
  'privilegios_pacientes', (SELECT jsonb_agg(DISTINCT (CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END) || ':' || a.privilege_type) FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid = 'public.cardiolink_pacientes'::regclass AND a.privilege_type IN ('SELECT','INSERT','UPDATE','DELETE'))
) AS checks_padron_acceso;
