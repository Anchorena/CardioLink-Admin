-- CardioLink · Pendientes de cobro V1 — ROLLBACK B de v4.2.1: restaura el estado previo SIN guard (Production, si partió sin guard).
-- NO EJECUTADO. Sólo si el COMMENT de la función registra estado_previo=sin_guard, es decir, si ANTES de aplicar v4.2.1 el catálogo de ese
-- proyecto mostró (con ..._v4211_checks.sql, consulta 1: estado_inferido = 'sin_guard') que no existía ningún guard de cobros.
-- NO usar en STAGING (estado_previo=v4.1.1): ahí corresponde el rollback A. Quita los 3 triggers y las 2 funciones. No toca datos ni
-- políticas ni el trigger de identidad. Los cobros pendientes/confirmados ya guardados NO se modifican: el rollback sólo quita la protección.
BEGIN;
DO $$
DECLARE v_cmt text;
BEGIN
  IF to_regprocedure('public.cardiolink_atenciones_guard_cobro_v1()') IS NULL THEN RAISE EXCEPTION 'No existe el guard: nada que revertir'; END IF;
  v_cmt := coalesce(obj_description('public.cardiolink_atenciones_guard_cobro_v1()'::regprocedure, 'pg_proc'), '');
  IF v_cmt NOT LIKE '%[cobros-guard v4.2.1]%' THEN RAISE EXCEPTION 'La función vigente no es la v4.2.1 (comentario: %). No se revierte.', v_cmt; END IF;
  IF v_cmt NOT LIKE '%estado_previo=sin_guard%' THEN
    RAISE EXCEPTION 'El estado previo registrado NO es sin_guard (%): usar el rollback A en lugar de este.', v_cmt; END IF;
END $$;

DROP TRIGGER IF EXISTS cardiolink_atenciones_guard_cobro_v1_ins ON public.cardiolink_atenciones;
DROP TRIGGER IF EXISTS cardiolink_atenciones_guard_cobro_v1_del ON public.cardiolink_atenciones;
DROP TRIGGER IF EXISTS cardiolink_atenciones_guard_cobro_v1 ON public.cardiolink_atenciones;
DROP FUNCTION IF EXISTS public.cardiolink_atenciones_guard_cobro_ins_v1();
DROP FUNCTION IF EXISTS public.cardiolink_atenciones_guard_cobro_v1();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.cardiolink_atenciones'::regclass AND tgname LIKE 'cardiolink\_atenciones\_guard\_cobro%')
     OR to_regprocedure('public.cardiolink_atenciones_guard_cobro_v1()') IS NOT NULL
     OR to_regprocedure('public.cardiolink_atenciones_guard_cobro_ins_v1()') IS NOT NULL THEN
    RAISE EXCEPTION 'El rollback no dejó limpio el guard de cobros';
  END IF;
  IF to_regprocedure('public.cardiolink_atenciones_proteger_identidad_v1()') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.cardiolink_atenciones'::regclass AND tgname = 'cardiolink_atenciones_proteger_identidad_v1') THEN
    RAISE EXCEPTION 'El rollback afectó el trigger de identidad';
  END IF;
END $$;
COMMIT;
