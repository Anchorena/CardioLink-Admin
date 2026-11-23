-- CardioLink · FACTURACIÓN MENSUAL V1 · BLOQUE 1 · verificaciones de SOLO LECTURA (no modifican nada; sin datos personales: catálogo y conteos).
-- Ejecutar en STAGING y en Production ANTES (estado = 'sin_aplicar') y DESPUÉS (estado = 'aplicado') de pending_review_facturacion_presentaciones_v1.sql.

-- 1) Estado del bloque
SELECT CASE WHEN to_regclass('public.cardiolink_presentaciones_os_items_v1') IS NULL AND to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb)') IS NULL THEN 'sin_aplicar'
            WHEN to_regclass('public.cardiolink_presentaciones_os_items_v1') IS NOT NULL AND to_regclass('public.cardiolink_presentaciones_os_v1') IS NOT NULL
                 AND to_regclass('public.cardiolink_presentaciones_os_control_v1') IS NOT NULL AND to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb)') IS NOT NULL THEN 'aplicado'
            ELSE 'parcial' END AS estado;

-- 2) Precondiciones (deben dar true / true / true)
SELECT to_regprocedure('public.cardiolink_ctx_rol_v1()') IS NOT NULL AS ctx_rol,
       to_regprocedure('public.cardiolink_ctx_prof_v1()') IS NOT NULL AS ctx_prof,
       to_regprocedure('public.cardiolink_secretaria_autorizada_prof_v1(text)') IS NOT NULL AS asociaciones;

-- 3) Después de aplicar: privilegios y políticas (esperado: anon_select=false, auth_insert=false, auth_update=false, auth_select=true, politicas=3, indice_unico=true)
SELECT has_table_privilege('anon', 'public.cardiolink_presentaciones_os_items_v1', 'SELECT') AS anon_select,
       has_table_privilege('authenticated', 'public.cardiolink_presentaciones_os_items_v1', 'INSERT') AS auth_insert,
       has_table_privilege('authenticated', 'public.cardiolink_presentaciones_os_items_v1', 'UPDATE') AS auth_update,
       has_table_privilege('authenticated', 'public.cardiolink_presentaciones_os_items_v1', 'SELECT') AS auth_select,
       (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename LIKE 'cardiolink\_presentaciones\_os%' ESCAPE '\') AS politicas,
       EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'cardiolink_presentaciones_os_items_atencion_uq') AS indice_unico;

-- 4) Conteos agregados (sin datos personales)
SELECT (SELECT count(*) FROM public.cardiolink_presentaciones_os_v1) AS presentaciones,
       (SELECT count(*) FROM public.cardiolink_presentaciones_os_items_v1) AS items,
       (SELECT count(DISTINCT atencion_id) FROM public.cardiolink_presentaciones_os_items_v1) AS atenciones_distintas,
       (SELECT fecha_inicio FROM public.cardiolink_presentaciones_os_control_v1) AS fecha_inicio_control;

-- 4b) Excepciones (prestaciones anteriores al inicio del control incorporadas a mano). Esperado: 0 filas excepcionales sin motivo y 0 «no excepcionales» anteriores al control.
SELECT (SELECT count(*) FROM public.cardiolink_presentaciones_os_items_v1 WHERE excepcional) AS items_excepcionales,
       (SELECT count(*) FROM public.cardiolink_presentaciones_os_items_v1 WHERE excepcional AND coalesce(btrim(motivo_excepcion), '') = '') AS excepcionales_sin_motivo,
       (SELECT count(*) FROM public.cardiolink_presentaciones_os_items_v1 i, public.cardiolink_presentaciones_os_control_v1 c WHERE NOT i.excepcional AND i.fecha_atencion < c.fecha_inicio) AS anteriores_no_marcadas;

-- 5) Integridad (esperado 0 en ambas): ítems cuya presentación suma distinto del total, y ATENCIONES MODIFICADAS por este bloque (no debe haber: la tabla de atenciones no se toca)
SELECT (SELECT count(*) FROM public.cardiolink_presentaciones_os_v1 p WHERE p.total_importe <> (SELECT coalesce(sum(i.importe_presentado), 0) FROM public.cardiolink_presentaciones_os_items_v1 i WHERE i.presentacion_id = p.id)
          OR p.cantidad <> (SELECT count(*) FROM public.cardiolink_presentaciones_os_items_v1 i WHERE i.presentacion_id = p.id)) AS presentaciones_inconsistentes,
       (SELECT count(*) FROM public.cardiolink_presentaciones_os_items_v1 i WHERE NOT EXISTS (SELECT 1 FROM public.cardiolink_atenciones a WHERE a.id = i.atencion_id)) AS items_sin_atencion;

-- 6) Cierre de incidencias (esperado tras el delta: medico_lee_control=true, rpc_exige_arancel_fijado=true, control_escribible_auth=false)
SELECT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND policyname = 'cardiolink_presentaciones_os_control_select' AND qual LIKE '%medico%') AS medico_lee_control,
       coalesce(pg_get_functiondef(to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb)')) LIKE '%PR412%', false) AS rpc_exige_arancel_fijado,
       has_table_privilege('authenticated', 'public.cardiolink_presentaciones_os_control_v1', 'INSERT') OR has_table_privilege('authenticated', 'public.cardiolink_presentaciones_os_control_v1', 'UPDATE') AS control_escribible_auth;
