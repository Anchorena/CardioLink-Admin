-- Rollback de pending_review_cobros_v1_guard_medico.sql: sólo quita el trigger y su función. No toca datos,
-- políticas, columnas ni el trigger de identidad. Idempotente.
BEGIN;
DROP TRIGGER IF EXISTS cardiolink_atenciones_guard_cobro_v1 ON public.cardiolink_atenciones;
DROP TRIGGER IF EXISTS cardiolink_atenciones_guard_cobro_v1_del ON public.cardiolink_atenciones;
DROP FUNCTION IF EXISTS public.cardiolink_atenciones_guard_cobro_v1();
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.cardiolink_atenciones'::regclass AND tgname IN ('cardiolink_atenciones_guard_cobro_v1', 'cardiolink_atenciones_guard_cobro_v1_del'))
     OR to_regprocedure('public.cardiolink_atenciones_guard_cobro_v1()') IS NOT NULL THEN
    RAISE EXCEPTION 'El rollback no dejó limpio el guard de cobros';
  END IF;
  -- El trigger de identidad (si existe) debe seguir intacto.
  IF to_regprocedure('public.cardiolink_atenciones_proteger_identidad_v1()') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.cardiolink_atenciones'::regclass AND tgname = 'cardiolink_atenciones_proteger_identidad_v1') THEN
    RAISE EXCEPTION 'El rollback afectó el trigger de identidad';
  END IF;
END $$;
COMMIT;
