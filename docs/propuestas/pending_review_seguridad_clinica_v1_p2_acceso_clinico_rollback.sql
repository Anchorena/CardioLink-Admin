-- CardioLink · Seguridad clínica V1 · ROLLBACK de la PARTE 2 (quita acceso clínico y vínculos manuales)
-- Recuperado de STAGING (catálogo: pg_get_functiondef / pg_get_constraintdef / pg_policies / aclexplode, 2026-11-13); QA de STAGING aprobado. Versionado para publicar en Production.
-- NO EJECUTAR en Production sin autorización explícita. Una sola transacción, sin DML sobre datos. Falla (y revierte todo) si el estado no es el esperado.
-- Orden de publicación y rollback: docs/propuestas/pending_review_seguridad_clinica_v1_PUBLICACION.md
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND policyname LIKE '%\_v1' ESCAPE '\') THEN RAISE EXCEPTION 'Rollback: revertir antes la PARTE 3 (HC RLS)'; END IF;
  IF to_regprocedure('public.cardiolink_tipos_documento_secretaria_v1()') IS NOT NULL THEN RAISE EXCEPTION 'Rollback: revertir antes 4C-1b y 4C-1 (usan cardiolink_paciente_acceso_clinico_v1)'; END IF;
  IF coalesce(current_setting('cardiolink.rollback_confirmado', true), '') <> 'si' AND (EXISTS (SELECT 1 FROM public.cardiolink_paciente_profesionales_v1) OR EXISTS (SELECT 1 FROM public.cardiolink_paciente_profesionales_eventos_v1)) THEN
    RAISE EXCEPTION 'Las tablas tienen datos: el rollback los DESTRUIRÍA. Si es lo que se quiere, ejecutar antes SET LOCAL cardiolink.rollback_confirmado = ''si''; (después del BEGIN).'; END IF;
END $$;
DROP FUNCTION public.cardiolink_paciente_acceso_clinico_v1(text);
DROP FUNCTION public.cardiolink_asociar_paciente_profesional_v1(text, text, text, boolean);
DROP TABLE public.cardiolink_paciente_profesionales_v1;
DROP TABLE public.cardiolink_paciente_profesionales_eventos_v1;
DROP FUNCTION public.cardiolink_auditar_paciente_profesional_v1();
COMMIT;
