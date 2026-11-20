-- ROLLBACK del ajuste de integridad de evoluciones: elimina el trigger y su función. Una sola transacción.
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.cardiolink_hc_evoluciones'::regclass AND tgname='cardiolink_hc_evoluciones_inmutables_v1') THEN RAISE EXCEPTION 'Rollback: el trigger de integridad no está aplicado'; END IF;
END $$;
DROP TRIGGER cardiolink_hc_evoluciones_inmutables_v1 ON public.cardiolink_hc_evoluciones;
DROP FUNCTION public.cardiolink_hc_evolucion_inmutables_v1();
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.cardiolink_hc_evoluciones'::regclass AND NOT tgisinternal) OR to_regprocedure('public.cardiolink_hc_evolucion_inmutables_v1()') IS NOT NULL THEN RAISE EXCEPTION 'Rollback: quedaron restos del trigger'; END IF;
END $$;
COMMIT;
