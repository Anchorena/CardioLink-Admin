-- CardioLink · FACTURACIÓN MENSUAL V1 · COMPLEMENTO TERCEROS · verificaciones de SOLO LECTURA (no modifican nada; sin datos personales: catálogo, ids de profesional y conteos).
-- Ejecutar en STAGING y en Production ANTES (estado = 'sin_aplicar') y DESPUÉS (estado = 'aplicado') de pending_review_facturacion_presentaciones_v1_terceros.sql. Una consulta por vez en el SQL Editor.

-- 1) Estado del complemento (y del bloque base que necesita)
SELECT CASE WHEN to_regclass('public.cardiolink_presentaciones_os_items_v1') IS NULL THEN 'falta_base'
            WHEN to_regclass('public.cardiolink_presentaciones_os_delegaciones_v1') IS NULL
                 AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'cardiolink_presentaciones_os_items_v1' AND column_name = 'facturante_professional_id') THEN 'sin_aplicar'
            WHEN to_regclass('public.cardiolink_presentaciones_os_delegaciones_v1') IS NOT NULL
                 AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'cardiolink_presentaciones_os_items_v1' AND column_name = 'facturante_professional_id')
                 AND to_regprocedure('public.cardiolink_presentacion_os_delegacion_v1(text,text,text,boolean)') IS NOT NULL AND to_regprocedure('public.cardiolink_presentacion_os_norm_v1(text)') IS NOT NULL THEN 'aplicado'
            ELSE 'parcial' END AS estado;

-- 2) Precondiciones (esperado antes de aplicar: base_aplicada=true, rpc_base_con_pr412=true)
SELECT to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb)') IS NOT NULL AS base_aplicada,
       coalesce(pg_get_functiondef(to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb)')) LIKE '%PR412%', false) AS rpc_base_con_pr412;

-- 3) Después de aplicar (esperado: anon_select=false, auth_insert=false, auth_update=false, auth_select=true, politicas=4, indice_unico=true, rpc_con_delegaciones=true, rpc_con_pr412=true, items_politica_incluye_realizo=true, control_guarda_robusta=true)
SELECT has_table_privilege('anon', 'public.cardiolink_presentaciones_os_delegaciones_v1', 'SELECT') AS anon_select,
       has_table_privilege('authenticated', 'public.cardiolink_presentaciones_os_delegaciones_v1', 'INSERT') AS auth_insert,
       has_table_privilege('authenticated', 'public.cardiolink_presentaciones_os_delegaciones_v1', 'UPDATE') AS auth_update,
       has_table_privilege('authenticated', 'public.cardiolink_presentaciones_os_delegaciones_v1', 'SELECT') AS auth_select,
       (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename LIKE 'cardiolink\_presentaciones\_os%' ESCAPE '\') AS politicas,
       EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'cardiolink_presentaciones_os_items_atencion_uq' AND indexdef ILIKE '%UNIQUE%(atencion_id)%') AS indice_unico,
       coalesce(pg_get_functiondef(to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb)')) LIKE '%delegaciones_v1%', false) AS rpc_con_delegaciones,
       coalesce(pg_get_functiondef(to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb)')) LIKE '%PR412%', false) AS rpc_con_pr412,
       EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND policyname = 'cardiolink_presentaciones_os_items_select' AND qual LIKE '%realizado_por_professional_id%') AS items_politica_incluye_realizo,
       coalesce(pg_get_functiondef(to_regprocedure('public.cardiolink_presentacion_os_control_v1(date)')) LIKE '%coalesce((SELECT public.cardiolink_ctx_rol_v1()%', false) AS control_guarda_robusta;

-- 4) Delegaciones cargadas (ids de profesional y texto de destino normalizado; sin datos personales)
SELECT realiza_professional_id, destino_norm, facturante_professional_id, activa FROM public.cardiolink_presentaciones_os_delegaciones_v1 ORDER BY 1, 2;

-- 5) Presentaciones de terceros e integridad (esperado: inconsistentes = 0 en las tres columnas de la derecha)
SELECT (SELECT count(*) FROM public.cardiolink_presentaciones_os_items_v1) AS items,
       (SELECT count(*) FROM public.cardiolink_presentaciones_os_items_v1 WHERE realizado_por_professional_id <> facturante_professional_id) AS items_de_terceros,
       (SELECT count(*) FROM public.cardiolink_presentaciones_os_items_v1 WHERE facturante_professional_id <> professional_id) AS facturante_distinto_de_la_presentacion,
       (SELECT count(*) FROM public.cardiolink_presentaciones_os_items_v1 WHERE coalesce(btrim(realizado_por_professional_id), '') = '' OR coalesce(btrim(facturante_professional_id), '') = '') AS sin_trazabilidad,
       (SELECT count(*) - count(DISTINCT atencion_id) FROM public.cardiolink_presentaciones_os_items_v1) AS atenciones_duplicadas;

-- 6) Normalización (esperado: dr. rogelio anchorena | matias)
SELECT public.cardiolink_presentacion_os_norm_v1('  Dr.  ROGELIO   Anchorena ') AS a, public.cardiolink_presentacion_os_norm_v1('MATÍAS') AS b;
