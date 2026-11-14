-- Rollback de COPIAS PARA FACTURACIÓN V1: quita las 3 políticas de Storage, las 3 de la tabla, el trigger, la RPC, las 6 funciones y la tabla cardiolink_copias_facturacion.
-- NO toca cardiolink_patient_documents, el bucket patient-documents, HC, evoluciones, 4C-1 ni el portal.
-- PROTECCIÓN DE DATOS: si la tabla tiene copias o el bucket tiene archivos, ABORTA (no borra datos administrativos por accidente). Para forzar tras exportarlos/confirmarlo:
--     SET cardiolink.copias_rollback_forzar = 'si';   -- en la MISMA ejecución del SQL Editor, pegado justo antes de este script (sesión)
-- El bucket `billing-copies` NO se elimina por SQL (Supabase bloquea el borrado directo de storage.buckets/objects): queda PRIVADO y SIN políticas (nadie lo accede).
-- Si hace falta quitarlo, vaciarlo y eliminarlo desde el panel de Supabase Storage o su API. Ejecutar sólo con autorización explícita.
BEGIN;

DO $$
DECLARE n_filas bigint := 0; n_objs bigint := 0;
BEGIN
  IF to_regclass('public.cardiolink_copias_facturacion') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.cardiolink_copias_facturacion' INTO n_filas;
  END IF;
  SELECT count(*) INTO n_objs FROM storage.objects WHERE bucket_id = 'billing-copies' AND name <> '.emptyFolderPlaceholder';   -- el panel de Storage deja ese marcador vacío al vaciar el bucket
  IF (n_filas > 0 OR n_objs > 0) AND coalesce(current_setting('cardiolink.copias_rollback_forzar', true), '') <> 'si' THEN
    RAISE EXCEPTION 'Rollback abortado: hay % copia(s) en la tabla y % archivo(s) en billing-copies. No se borran datos sin confirmación (ver cabecera).', n_filas, n_objs;
  END IF;
END $$;

DROP POLICY IF EXISTS cardiolink_copias_fact_storage_select ON storage.objects;
DROP POLICY IF EXISTS cardiolink_copias_fact_storage_insert ON storage.objects;
DROP POLICY IF EXISTS cardiolink_copias_fact_storage_delete ON storage.objects;

DROP TABLE IF EXISTS public.cardiolink_copias_facturacion;   -- arrastra sus políticas, índices y trigger

DROP FUNCTION IF EXISTS public.cardiolink_copia_facturacion_impresion_v1(uuid, text);
DROP FUNCTION IF EXISTS public.cardiolink_copias_facturacion_guard_v1();
DROP FUNCTION IF EXISTS public.cardiolink_copia_facturacion_acceso_v1(text);
DROP FUNCTION IF EXISTS public.cardiolink_copia_facturacion_puede_eliminar_v1(text, uuid);
DROP FUNCTION IF EXISTS public.cardiolink_copia_facturacion_objeto_asignable_v1(text);
DROP FUNCTION IF EXISTS public.cardiolink_copia_facturacion_objeto_sin_fila_v1(text);
DROP FUNCTION IF EXISTS public.cardiolink_copia_facturacion_vinculo_v1(text, text, text, text);

DO $$
BEGIN
  IF to_regclass('public.cardiolink_copias_facturacion') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_policies WHERE policyname LIKE 'cardiolink\_copias\_fact\_%' ESCAPE '\')
     OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname LIKE 'cardiolink\_copia%facturacion%' ESCAPE '\') THEN
    RAISE EXCEPTION 'FALLA: quedaron objetos de Copias para facturación';
  END IF;
END $$;

COMMIT;
