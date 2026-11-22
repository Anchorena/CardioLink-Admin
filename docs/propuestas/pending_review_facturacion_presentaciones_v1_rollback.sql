-- CardioLink · FACTURACIÓN MENSUAL V1 · BLOQUE 1 · ROLLBACK de pending_review_facturacion_presentaciones_v1.sql
-- *** Ensayado en un PostgreSQL local y dentro del ensayo reversible de STAGING. NO ejecutado en Production. ***  Solo elimina los objetos NUEVOS de este bloque. No toca atenciones ni ninguna otra tabla.
-- ATENCIÓN: borra las presentaciones registradas. Antes de ejecutarlo en una base con datos reales, exportar las tres tablas (ver checks) y confirmar con el Dueño.
BEGIN;
DROP FUNCTION IF EXISTS public.cardiolink_presentacion_os_confirmar_v1(text, jsonb);
DROP FUNCTION IF EXISTS public.cardiolink_presentacion_os_control_v1(date);
DROP TABLE IF EXISTS public.cardiolink_presentaciones_os_items_v1;
DROP TABLE IF EXISTS public.cardiolink_presentaciones_os_v1;
DROP TABLE IF EXISTS public.cardiolink_presentaciones_os_control_v1;
DROP FUNCTION IF EXISTS public.cardiolink_presentacion_os_confirmar_permitido_v1(text);
DROP FUNCTION IF EXISTS public.cardiolink_presentacion_os_ver_v1(text);
DO $$
BEGIN
  IF to_regclass('public.cardiolink_presentaciones_os_v1') IS NOT NULL OR to_regclass('public.cardiolink_presentaciones_os_items_v1') IS NOT NULL OR to_regclass('public.cardiolink_presentaciones_os_control_v1') IS NOT NULL
     OR to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'FALLA: quedaron objetos del bloque'; END IF;
END $$;
COMMIT;
