-- ROLLBACK del endurecimiento de privilegios: vuelve al estado de Production (todos los privilegios de tabla para anon y authenticated; la RLS sigue siendo la barrera). Una sola transacción.
-- (STAGING originalmente no tenía TRUNCATE para anon/authenticated; este rollback los vuelve a conceder, igual que Production.)
BEGIN;
GRANT ALL ON TABLE public.cardiolink_hc_evoluciones, public.cardiolink_hc_resumen TO anon, authenticated;
COMMIT;
