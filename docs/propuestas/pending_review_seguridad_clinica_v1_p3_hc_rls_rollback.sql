-- CardioLink · Seguridad clínica V1 · ROLLBACK de la PARTE 3 (restaura las políticas abiertas *_authenticated)
-- Recuperado de STAGING (catálogo: pg_get_functiondef / pg_get_constraintdef / pg_policies / aclexplode, 2026-11-13); QA de STAGING aprobado. Versionado para publicar en Production.
-- NO EJECUTAR en Production sin autorización explícita. Una sola transacción, sin DML sobre datos. Falla (y revierte todo) si el estado no es el esperado.
-- Orden de publicación y rollback: docs/propuestas/pending_review_seguridad_clinica_v1_PUBLICACION.md
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND policyname LIKE '%\_authenticated' ESCAPE '\') THEN RAISE EXCEPTION 'Rollback: ya existen políticas *_authenticated (¿ya revertido?)'; END IF;
END $$;
DROP POLICY IF EXISTS cardiolink_hc_evoluciones_delete_v1 ON public.cardiolink_hc_evoluciones;
DROP POLICY IF EXISTS cardiolink_hc_evoluciones_insert_v1 ON public.cardiolink_hc_evoluciones;
DROP POLICY IF EXISTS cardiolink_hc_evoluciones_select_v1 ON public.cardiolink_hc_evoluciones;
DROP POLICY IF EXISTS cardiolink_hc_evoluciones_update_v1 ON public.cardiolink_hc_evoluciones;
DROP POLICY IF EXISTS cardiolink_hc_resumen_delete_v1 ON public.cardiolink_hc_resumen;
DROP POLICY IF EXISTS cardiolink_hc_resumen_insert_v1 ON public.cardiolink_hc_resumen;
DROP POLICY IF EXISTS cardiolink_hc_resumen_select_v1 ON public.cardiolink_hc_resumen;
DROP POLICY IF EXISTS cardiolink_hc_resumen_update_v1 ON public.cardiolink_hc_resumen;

CREATE POLICY cardiolink_hc_evoluciones_authenticated ON public.cardiolink_hc_evoluciones AS PERMISSIVE FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY cardiolink_hc_resumen_authenticated ON public.cardiolink_hc_resumen AS PERMISSIVE FOR ALL TO authenticated USING (true) WITH CHECK (true);

DO $$ BEGIN
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen')) <> 2 THEN RAISE EXCEPTION 'Rollback: estado final inesperado'; END IF;
END $$;
COMMIT;
