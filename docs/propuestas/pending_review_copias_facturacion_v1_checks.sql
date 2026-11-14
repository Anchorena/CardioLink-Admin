-- Copias para facturación V1 · CHECKS de SOLO LECTURA (no modifican nada). Ejecutar en el SQL Editor de cada entorno ANTES y DESPUÉS de aplicar pending_review_copias_facturacion_v1.sql.
-- Una sola consulta (no falla aunque el módulo todavía no exista): devuelve una fila con pares clave/valor.
-- ANTES  esperado: dependencias_ok=true, copias_tabla=false, copias_bucket=false, copias_politicas_storage=0, restrictivas_storage_sin_bucket=0
-- DESPUÉS esperado: copias_tabla=true, copias_rls=true, copias_bucket=true, copias_bucket_privado=true, copias_politicas_tabla=3, copias_politicas_storage=3,
--                   copias_funciones=7, copias_trigger=1, authenticated_sin_update=true, anon_sin_tabla=true, anon_sin_rpc=true, restrictivas_storage_sin_bucket=0
SELECT jsonb_build_object(
  'dependencias_ok',
     to_regprocedure('public.cardiolink_ctx_rol_v1()') IS NOT NULL AND to_regprocedure('public.cardiolink_ctx_prof_v1()') IS NOT NULL
     AND to_regprocedure('public.cardiolink_secretaria_autorizada_prof_v1(text)') IS NOT NULL AND to_regclass('public.cardiolink_secretaria_medicos') IS NOT NULL,
  'asociaciones_activas', CASE WHEN to_regclass('public.cardiolink_secretaria_medicos') IS NULL THEN NULL
     ELSE (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.cardiolink_secretaria_medicos where activo', false, true, '')))[1]::text::int END,
  'restrictivas_storage_sin_bucket',
     (SELECT count(*) FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND permissive='RESTRICTIVE'
         AND (coalesce(qual,'') || ' ' || coalesce(with_check,'')) NOT LIKE '%bucket_id%'),
  'copias_tabla', to_regclass('public.cardiolink_copias_facturacion') IS NOT NULL,
  'copias_rls', coalesce((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.cardiolink_copias_facturacion')), false),
  'copias_bucket', EXISTS (SELECT 1 FROM storage.buckets WHERE id='billing-copies'),
  'copias_bucket_privado', EXISTS (SELECT 1 FROM storage.buckets WHERE id='billing-copies' AND NOT public AND allowed_mime_types = ARRAY['application/pdf']),
  'copias_politicas_tabla', (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='cardiolink_copias_facturacion'),
  'copias_politicas_storage', (SELECT count(*) FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname LIKE 'cardiolink\_copias\_fact\_storage\_%' ESCAPE '\'),
  'copias_funciones', (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'cardiolink\_copia%facturacion%' ESCAPE '\'),
  'copias_trigger', (SELECT count(*) FROM pg_trigger WHERE tgrelid = to_regclass('public.cardiolink_copias_facturacion') AND NOT tgisinternal),
  'authenticated_sin_update', CASE WHEN to_regclass('public.cardiolink_copias_facturacion') IS NULL THEN NULL
     ELSE NOT has_table_privilege('authenticated','public.cardiolink_copias_facturacion','UPDATE') END,
  'anon_sin_tabla', CASE WHEN to_regclass('public.cardiolink_copias_facturacion') IS NULL THEN NULL
     ELSE NOT has_table_privilege('anon','public.cardiolink_copias_facturacion','SELECT') END,
  'anon_sin_rpc', CASE WHEN to_regprocedure('public.cardiolink_copia_facturacion_impresion_v1(uuid,text)') IS NULL THEN NULL
     ELSE NOT has_function_privilege('anon','public.cardiolink_copia_facturacion_impresion_v1(uuid,text)','EXECUTE') END,
  'copias_cargadas', CASE WHEN to_regclass('public.cardiolink_copias_facturacion') IS NULL THEN NULL
     ELSE (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.cardiolink_copias_facturacion', false, true, '')))[1]::text::int END
) AS checks_copias_facturacion_v1;
