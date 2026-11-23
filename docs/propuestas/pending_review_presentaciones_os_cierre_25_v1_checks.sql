-- CardioLink · PRESENTACIONES A OBRAS SOCIALES · CIERRE DEL DÍA 25 · verificaciones de SOLO LECTURA (no modifican nada; sin datos personales). Una consulta por vez.
-- ANTES de aplicar (estado = 'sin_aplicar') y DESPUÉS (estado = 'aplicado') de pending_review_presentaciones_os_cierre_25_v1.sql.

-- Las consultas 3 y 4 solo se pueden correr DESPUÉS de aplicar (consultan la RPC y las columnas nuevas). Antes de aplicar, correr solo la 1 y la 2.
-- 1) Estado
SELECT CASE WHEN to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb,date,date)') IS NULL
                 AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'cardiolink_presentaciones_os_v1' AND column_name IN ('fecha_corte', 'fecha_presentacion')) THEN 'sin_aplicar'
            WHEN to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb,date,date)') IS NOT NULL AND to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb)') IS NULL
                 AND (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'cardiolink_presentaciones_os_v1' AND column_name IN ('fecha_corte', 'fecha_presentacion')) = 2 THEN 'aplicado'
            ELSE 'parcial' END AS estado;

-- 2) Precondiciones (esperado antes de aplicar: todo true)
SELECT to_regclass('public.cardiolink_presentaciones_os_delegaciones_v1') IS NOT NULL AS terceros_aplicado,
       coalesce(pg_get_functiondef(to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb)')) LIKE '%delegaciones_v1%', false) AS rpc_con_delegaciones,
       coalesce(pg_get_functiondef(to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb)')) LIKE '%PR412%', false) AS rpc_con_pr412;

-- 3) Después de aplicar (esperado: columnas_nullable=2, anon_exec=false, auth_exec=true, rpc_pr413_pr414=true, firma_2_args_existe=false, cabecera_auth_insert=false, cabecera_auth_update=false)
SELECT (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'cardiolink_presentaciones_os_v1' AND column_name IN ('fecha_corte', 'fecha_presentacion') AND is_nullable = 'YES') AS columnas_nullable,
       has_function_privilege('anon', 'public.cardiolink_presentacion_os_confirmar_v1(text,jsonb,date,date)', 'EXECUTE') AS anon_exec,
       has_function_privilege('authenticated', 'public.cardiolink_presentacion_os_confirmar_v1(text,jsonb,date,date)', 'EXECUTE') AS auth_exec,
       coalesce(pg_get_functiondef(to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb,date,date)')) LIKE '%PR413%' AND pg_get_functiondef(to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb,date,date)')) LIKE '%PR414%', false) AS rpc_pr413_pr414,
       to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb)') IS NOT NULL AS firma_2_args_existe,
       has_table_privilege('authenticated', 'public.cardiolink_presentaciones_os_v1', 'INSERT') AS cabecera_auth_insert,
       has_table_privilege('authenticated', 'public.cardiolink_presentaciones_os_v1', 'UPDATE') AS cabecera_auth_update;

-- 4) Presentaciones históricas intactas y nuevas con fechas (esperado tras aplicar y antes de usarlo: con_fechas = 0; después, solo las nuevas)
SELECT count(*) AS presentaciones, count(*) FILTER (WHERE fecha_corte IS NOT NULL OR fecha_presentacion IS NOT NULL) AS con_fechas,
       count(*) FILTER (WHERE fecha_presentacion IS NOT NULL AND fecha_presentacion > (presentado_en AT TIME ZONE 'UTC')::date) AS fecha_presentacion_futura FROM public.cardiolink_presentaciones_os_v1;
