-- CardioLink · Documentos V2A / F3 — VERIFICACIÓN de SOLO LECTURA del límite de tasa persistente (STAGING yslhwdlzdknhskawqrtv; Production sólo con autorización aparte).
-- Una única consulta que devuelve un JSON (el SQL Editor muestra sólo el último resultado). Sólo SELECT: no modifica nada. No imprime claves ni datos de personas.
-- ANTES de instalar: tabla/funcion = null y prerrequisitos F1 presentes. DESPUÉS: ver los valores esperados en cada campo.

select jsonb_pretty(jsonb_build_object(
  'prerrequisito_f1_tablas', (select jsonb_agg(relname order by relname) from pg_class where relnamespace = 'public'::regnamespace and relname in ('cardiolink_document_verifications','cardiolink_document_verification_events')),
  'tabla', (select jsonb_build_object('existe', true, 'rls', relrowsecurity, 'rls_forzada', relforcerowsecurity) from pg_class where oid = to_regclass('public.cardiolink_verificacion_limites')),   -- esperado: rls=true
  'columnas', (select jsonb_agg(column_name order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = 'cardiolink_verificacion_limites'),   -- esperado: clave, ventana_inicio, intentos
  'policies', (select count(*) from pg_policies where schemaname = 'public' and tablename = 'cardiolink_verificacion_limites'),                                                            -- esperado: 0
  'privilegios_tabla_cliente', (select coalesce(jsonb_agg(jsonb_build_object('rol', grantee, 'priv', privilege_type)), '[]'::jsonb) from information_schema.role_table_grants
                                where table_schema = 'public' and table_name = 'cardiolink_verificacion_limites' and grantee in ('anon','authenticated','PUBLIC')),                         -- esperado: []
  'funcion', (select jsonb_build_object('security_definer', p.prosecdef, 'search_path_fijo', coalesce(array_to_string(p.proconfig, ',') like '%search_path=pg_catalog, public%', false),
                'anon', has_function_privilege('anon', p.oid, 'execute'), 'authenticated', has_function_privilege('authenticated', p.oid, 'execute'), 'service_role', has_function_privilege('service_role', p.oid, 'execute'))
              from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'cardiolink_verificacion_limitar_v1'),                                                           -- esperado: definer=true, search_path_fijo=true, anon=false, authenticated=false, service_role=true
  'filas', case when to_regclass('public.cardiolink_verificacion_limites') is null then null else (   -- consulta dinámica: este archivo también corre ANTES de instalar
      select jsonb_build_object('total', (xpath('/row/total/text()', x))[1]::text::int, 'mas_viejas_que_1_dia', (xpath('/row/viejas/text()', x))[1]::text::int, 'max_intentos', (xpath('/row/max_i/text()', x))[1]::text::int)
        from (select query_to_xml('select count(*) as total, count(*) filter (where ventana_inicio < now() - interval ''1 day'') as viejas, coalesce(max(intentos), 0) as max_i from public.cardiolink_verificacion_limites', false, true, '') as x) q
    ) end                                                                                                                                                                                  -- tras instalar: 0 filas; con uso: pocas filas y sin acumulación de viejas
)) as verificacion_limites;
