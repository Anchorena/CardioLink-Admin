-- CardioLink · Documentos V2A / F3 — VERIFICACIÓN de SOLO LECTURA del control de uso único de tokens (STAGING yslhwdlzdknhskawqrtv; Production sólo con autorización aparte).
-- Una única consulta que devuelve un JSON (el SQL Editor muestra sólo el último resultado). Sólo SELECT: no modifica nada. No imprime hashes ni datos de personas.
-- ANTES de instalar: tabla/funcion = null y prerrequisito F1 presente. DESPUÉS: ver los valores esperados en cada campo.

select jsonb_pretty(jsonb_build_object(
  'prerrequisito_f1_tablas', (select jsonb_agg(relname order by relname) from pg_class where relnamespace = 'public'::regnamespace and relname in ('cardiolink_document_verifications','cardiolink_document_verification_events')),
  'tabla', (select jsonb_build_object('existe', true, 'rls', relrowsecurity, 'rls_forzada', relforcerowsecurity) from pg_class where oid = to_regclass('public.cardiolink_verificacion_tokens_usados')),   -- esperado: rls=true
  'columnas', (select jsonb_agg(column_name order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = 'cardiolink_verificacion_tokens_usados'),   -- esperado: token_hash, creado_en, expira_en
  'policies', (select count(*) from pg_policies where schemaname = 'public' and tablename = 'cardiolink_verificacion_tokens_usados'),                                                            -- esperado: 0
  'privilegios_tabla_cliente', (select coalesce(jsonb_agg(jsonb_build_object('rol', grantee, 'priv', privilege_type)), '[]'::jsonb) from information_schema.role_table_grants
                                where table_schema = 'public' and table_name = 'cardiolink_verificacion_tokens_usados' and grantee in ('anon','authenticated','PUBLIC')),                           -- esperado: []
  'funcion', (select jsonb_build_object('security_definer', p.prosecdef, 'search_path_fijo', coalesce(array_to_string(p.proconfig, ',') like '%search_path=pg_catalog, public%', false),
                'anon', has_function_privilege('anon', p.oid, 'execute'), 'authenticated', has_function_privilege('authenticated', p.oid, 'execute'), 'service_role', has_function_privilege('service_role', p.oid, 'execute'))
              from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'cardiolink_verificacion_token_usar_v1'),                                                            -- esperado: definer=true, search_path_fijo=true, anon=false, authenticated=false, service_role=true
  'filas', case when to_regclass('public.cardiolink_verificacion_tokens_usados') is null then null else (   -- consulta dinámica: este archivo también corre ANTES de instalar
      select jsonb_build_object('total', (xpath('/row/total/text()', x))[1]::text::int, 'vencidas', (xpath('/row/venc/text()', x))[1]::text::int)
        from (select query_to_xml('select count(*) as total, count(*) filter (where expira_en < now()) as venc from public.cardiolink_verificacion_tokens_usados', false, true, '') as x) q
    ) end                                                                                                                                                                                  -- tras instalar: 0 filas; con uso: una por verificación y pocas vencidas (limpieza oportunista)
)) as verificacion_tokens;
