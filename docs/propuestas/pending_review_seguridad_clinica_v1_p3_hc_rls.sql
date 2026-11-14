-- CardioLink · Seguridad clínica V1 · PARTE 3 · RLS de Historia Clínica por acceso clínico (Bloque 4)
-- Recuperado de STAGING (catálogo: pg_get_functiondef / pg_get_constraintdef / pg_policies / aclexplode, 2026-11-13); QA de STAGING aprobado. Versionado para publicar en Production.
-- NO EJECUTAR en Production sin autorización explícita. Una sola transacción, sin DML sobre datos. Falla (y revierte todo) si el estado no es el esperado.
-- Orden de publicación y rollback: docs/propuestas/pending_review_seguridad_clinica_v1_PUBLICACION.md
-- CAMBIA EL COMPORTAMIENTO: reemplaza las políticas abiertas `*_authenticated` (cualquier usuario autenticado) de cardiolink_hc_evoluciones y cardiolink_hc_resumen por políticas por rol/acceso clínico.
-- Owner/admin: todo. Médico: solo pacientes con vínculo manual activo, evolución o atención propia (y solo escribe evoluciones propias). Secretaría: sin acceso a estas tablas.
-- Las dos políticas nuevas y el DROP de las viejas ocurren en la misma transacción: no hay ventana sin política.
BEGIN;
DO $$
BEGIN
  IF to_regprocedure('public.cardiolink_paciente_acceso_clinico_v1(text)') IS NULL THEN RAISE EXCEPTION 'Precondición: aplicar antes la PARTE 2 (cardiolink_paciente_acceso_clinico_v1)'; END IF;
  IF to_regprocedure('public.cardiolink_ctx_rol_v1()') IS NULL OR to_regprocedure('public.cardiolink_ctx_prof_v1()') IS NULL THEN RAISE EXCEPTION 'Precondición: faltan cardiolink_ctx_rol_v1() / cardiolink_ctx_prof_v1()'; END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.cardiolink_hc_evoluciones'::regclass) OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.cardiolink_hc_resumen'::regclass) THEN
    RAISE EXCEPTION 'Precondición: RLS apagada en las tablas de HC'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen')
        AND policyname IN ('cardiolink_hc_evoluciones_authenticated','cardiolink_hc_resumen_authenticated') AND permissive='PERMISSIVE' AND cmd='ALL' AND qual='true' AND with_check='true') <> 2 THEN
    RAISE EXCEPTION 'Precondición: se esperaban exactamente las dos políticas abiertas *_authenticated (cmd ALL, true/true); el estado difiere'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen')) <> 2 THEN
    RAISE EXCEPTION 'Precondición: hay otras políticas en las tablas de HC; revisar antes de continuar'; END IF;
END $$;

CREATE POLICY cardiolink_hc_evoluciones_delete_v1 ON public.cardiolink_hc_evoluciones
  AS PERMISSIVE FOR DELETE TO authenticated
  USING ((cardiolink_paciente_acceso_clinico_v1(paciente_id) AND ((cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text])) OR ((cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1())))))));

CREATE POLICY cardiolink_hc_evoluciones_insert_v1 ON public.cardiolink_hc_evoluciones
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((cardiolink_paciente_acceso_clinico_v1(paciente_id) AND ((cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text])) OR ((cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1())))))));

CREATE POLICY cardiolink_hc_evoluciones_select_v1 ON public.cardiolink_hc_evoluciones
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (cardiolink_paciente_acceso_clinico_v1(paciente_id));

CREATE POLICY cardiolink_hc_evoluciones_update_v1 ON public.cardiolink_hc_evoluciones
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((cardiolink_paciente_acceso_clinico_v1(paciente_id) AND ((cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text])) OR ((cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1())))))))
  WITH CHECK ((cardiolink_paciente_acceso_clinico_v1(paciente_id) AND ((cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text])) OR ((cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1())))))));

CREATE POLICY cardiolink_hc_resumen_delete_v1 ON public.cardiolink_hc_resumen
  AS PERMISSIVE FOR DELETE TO authenticated
  USING (cardiolink_paciente_acceso_clinico_v1(paciente_id));

CREATE POLICY cardiolink_hc_resumen_insert_v1 ON public.cardiolink_hc_resumen
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (cardiolink_paciente_acceso_clinico_v1(paciente_id));

CREATE POLICY cardiolink_hc_resumen_select_v1 ON public.cardiolink_hc_resumen
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (cardiolink_paciente_acceso_clinico_v1(paciente_id));

CREATE POLICY cardiolink_hc_resumen_update_v1 ON public.cardiolink_hc_resumen
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (cardiolink_paciente_acceso_clinico_v1(paciente_id))
  WITH CHECK (cardiolink_paciente_acceso_clinico_v1(paciente_id));

DROP POLICY cardiolink_hc_evoluciones_authenticated ON public.cardiolink_hc_evoluciones;
DROP POLICY cardiolink_hc_resumen_authenticated ON public.cardiolink_hc_resumen;

-- Postcondiciones
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND policyname LIKE '%\_v1' ESCAPE '\') <> 8 THEN RAISE EXCEPTION 'Postcondición: se esperaban 8 políticas _v1'; END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND policyname LIKE '%\_authenticated' ESCAPE '\') THEN RAISE EXCEPTION 'Postcondición: siguen las políticas abiertas'; END IF;
END $$;

COMMIT;
