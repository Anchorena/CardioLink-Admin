-- CardioLink · Seguridad clínica V1 · ROLLBACK de p3c (vuelve a las políticas abiertas *_authenticated = estado de Production ANTES de p3c)
-- OJO: restaura la brecha (cualquier cuenta autenticada accede a la HC). Úsese sólo para volver atrás una publicación fallida. Una sola transacción.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND policyname LIKE '%\_authenticated' ESCAPE '\') THEN RAISE EXCEPTION 'Rollback: ya existen políticas *_authenticated (¿ya revertido?)'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND policyname LIKE '%\_v1' ESCAPE '\') <> 8 THEN RAISE EXCEPTION 'Rollback: se esperaban las 8 políticas _v1 de HC'; END IF;
  IF (SELECT qual FROM pg_policies WHERE policyname='cardiolink_hc_evoluciones_select_v1') NOT LIKE '%cardiolink_paciente_padron_v1%' THEN RAISE EXCEPTION 'Rollback: p3c no está aplicada (usar el rollback del delta o el de p3 según corresponda)'; END IF;
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
