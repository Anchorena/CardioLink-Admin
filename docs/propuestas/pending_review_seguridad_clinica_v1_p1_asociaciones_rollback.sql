-- CardioLink · Seguridad clínica V1 · ROLLBACK de la PARTE 1 (quita asociaciones Secretaría–Médico)
-- Recuperado de STAGING (catálogo: pg_get_functiondef / pg_get_constraintdef / pg_policies / aclexplode, 2026-11-13); QA de STAGING aprobado. Versionado para publicar en Production.
-- NO EJECUTAR en Production sin autorización explícita. Una sola transacción, sin DML sobre datos. Falla (y revierte todo) si el estado no es el esperado.
-- Orden de publicación y rollback: docs/propuestas/pending_review_seguridad_clinica_v1_PUBLICACION.md
BEGIN;
DO $$ BEGIN
  IF to_regprocedure('public.cardiolink_profesionales_autorizados_secretaria_v1()') IS NOT NULL THEN RAISE EXCEPTION 'Rollback: revertir antes 4C-1 (usa la tabla de asociaciones)'; END IF;
  IF coalesce(current_setting('cardiolink.rollback_confirmado', true), '') <> 'si' AND (EXISTS (SELECT 1 FROM public.cardiolink_secretaria_medicos) OR EXISTS (SELECT 1 FROM public.cardiolink_secretaria_medicos_eventos_v1)) THEN
    RAISE EXCEPTION 'Las tablas tienen datos: el rollback los DESTRUIRÍA. Si es lo que se quiere, ejecutar antes SET LOCAL cardiolink.rollback_confirmado = ''si''; (después del BEGIN).'; END IF;
END $$;
DROP FUNCTION public.cardiolink_listar_asociaciones_v1();
DROP FUNCTION public.cardiolink_asociar_secretaria_medico_v1(uuid, uuid, boolean);
DROP TABLE public.cardiolink_secretaria_medicos;
DROP TABLE public.cardiolink_secretaria_medicos_eventos_v1;
DROP FUNCTION public.cardiolink_validar_asociacion_secretaria_medico_v1();
DROP FUNCTION public.cardiolink_auditar_secretaria_medico_v1();
COMMIT;
