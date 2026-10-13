-- SOLO PLAN DE EMERGENCIA para volver al estado RLS PREVIO de Production.
-- Basado en la verificación de 2026-10-12: policies authenticated USING true.
-- REQUIERE aprobación explícita; restaura la seguridad antigua (permisiva).
-- No ejecutar preventivamente ni en STAGING; guardar snapshot previo de políticas.
BEGIN;
DROP POLICY IF EXISTS cardiolink_atenciones_select ON public.cardiolink_atenciones;
DROP POLICY IF EXISTS cardiolink_atenciones_insert ON public.cardiolink_atenciones;
DROP POLICY IF EXISTS cardiolink_atenciones_update ON public.cardiolink_atenciones;
DROP POLICY IF EXISTS cardiolink_atenciones_delete ON public.cardiolink_atenciones;
CREATE POLICY cardiolink_atenciones_select ON public.cardiolink_atenciones FOR SELECT TO authenticated USING (true);
CREATE POLICY cardiolink_atenciones_insert ON public.cardiolink_atenciones FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY cardiolink_atenciones_update ON public.cardiolink_atenciones FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY cardiolink_atenciones_delete ON public.cardiolink_atenciones FOR DELETE TO authenticated USING (true);
COMMIT;
-- No eliminar las RPC hasta restaurar/retirar el frontend que las llama.
