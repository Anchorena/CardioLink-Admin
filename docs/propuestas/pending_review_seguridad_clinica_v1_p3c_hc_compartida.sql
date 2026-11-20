-- CardioLink · Seguridad clínica V1 · p3c · HISTORIA CLÍNICA COMPARTIDA entre profesionales activos autorizados (reemplaza a p3 + p4b en Production)
-- ESTADO: PREPARADO PARA REVISIÓN. NO EJECUTAR en Production sin autorización explícita. Probar primero con el ensayo reversible (…_p3c_ensayo_reversible.sql).
-- Una sola transacción, sin DML sobre datos. Falla (y revierte todo) si el estado no es el esperado. Rollback: pending_review_seguridad_clinica_v1_p3c_hc_compartida_rollback.sql
-- Para una base que YA tiene p3 (hoy: STAGING) usar el delta: pending_review_seguridad_clinica_v1_p3c_delta_staging.sql (deja las políticas IDÉNTICAS a las de este archivo; el ensayo lo comprueba).
--
-- DECISIÓN DEL DUEÑO (D1/D2, 2026-11-20): la HC es COMPARTIDA entre los profesionales activos del consultorio. No hay vínculos manuales por paciente como condición para consultarla.
-- REGLAS (cardiolink_paciente_padron_v1 = hay sesión + rol ACTIVO owner/admin/médico con professional_id válido + el paciente existe):
--   cardiolink_hc_evoluciones  SELECT : cualquier profesional activo (padrón).
--                              INSERT/UPDATE/DELETE : owner/admin (cualquier evolución) o médico SÓLO con profesional_id = el SUYO (no se puede suplantar ni transferir a otro: WITH CHECK).
--   cardiolink_hc_resumen      SELECT/INSERT/UPDATE : cualquier profesional activo (antecedentes, alergias, medicación, alertas). DELETE : sólo owner/admin (los médicos consultan y actualizan, no borran).
--   Secretaría, cuentas sin rol, cuentas inactivas y anon: SIN acceso (no hay política para ellos). El control de concurrencia del PR #33 (UPDATE condicionado) no se toca: es el cliente.
-- Las 8 políticas nuevas y el DROP de las abiertas ocurren en la misma transacción: no hay ventana sin política.
-- Requiere p4 (cardiolink_paciente_padron_v1), ya aplicada en Production.
BEGIN;
DO $$
BEGIN
  IF to_regprocedure('public.cardiolink_paciente_padron_v1(text)') IS NULL THEN RAISE EXCEPTION 'Precondición: aplicar antes p4 (cardiolink_paciente_padron_v1)'; END IF;
  IF to_regprocedure('public.cardiolink_ctx_rol_v1()') IS NULL OR to_regprocedure('public.cardiolink_ctx_prof_v1()') IS NULL THEN RAISE EXCEPTION 'Precondición: faltan cardiolink_ctx_rol_v1() / cardiolink_ctx_prof_v1()'; END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.cardiolink_hc_evoluciones'::regclass) OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.cardiolink_hc_resumen'::regclass) THEN
    RAISE EXCEPTION 'Precondición: RLS apagada en las tablas de HC'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen')
        AND policyname IN ('cardiolink_hc_evoluciones_authenticated','cardiolink_hc_resumen_authenticated') AND permissive='PERMISSIVE' AND cmd='ALL' AND qual='true' AND with_check='true' AND roles = ARRAY['authenticated']::name[]) <> 2 THEN
    RAISE EXCEPTION 'Precondición: se esperaban exactamente las dos políticas abiertas *_authenticated (cmd ALL, true/true, authenticated); el estado difiere (¿p3 ya aplicada? usar el delta)'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen')) <> 2 THEN
    RAISE EXCEPTION 'Precondición: hay otras políticas en las tablas de HC; revisar antes de continuar'; END IF;
END $$;

-- ===== cardiolink_hc_evoluciones =====
CREATE POLICY cardiolink_hc_evoluciones_select_v1 ON public.cardiolink_hc_evoluciones
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (cardiolink_paciente_padron_v1(paciente_id));

CREATE POLICY cardiolink_hc_evoluciones_insert_v1 ON public.cardiolink_hc_evoluciones
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((cardiolink_paciente_padron_v1(paciente_id) AND ((cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text])) OR ((cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1())))))));

CREATE POLICY cardiolink_hc_evoluciones_update_v1 ON public.cardiolink_hc_evoluciones
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((cardiolink_paciente_padron_v1(paciente_id) AND ((cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text])) OR ((cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1())))))))
  WITH CHECK ((cardiolink_paciente_padron_v1(paciente_id) AND ((cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text])) OR ((cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1())))))));

CREATE POLICY cardiolink_hc_evoluciones_delete_v1 ON public.cardiolink_hc_evoluciones
  AS PERMISSIVE FOR DELETE TO authenticated
  USING ((cardiolink_paciente_padron_v1(paciente_id) AND ((cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text])) OR ((cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1())))))));

-- ===== cardiolink_hc_resumen =====
CREATE POLICY cardiolink_hc_resumen_select_v1 ON public.cardiolink_hc_resumen
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (cardiolink_paciente_padron_v1(paciente_id));

CREATE POLICY cardiolink_hc_resumen_insert_v1 ON public.cardiolink_hc_resumen
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (cardiolink_paciente_padron_v1(paciente_id));

CREATE POLICY cardiolink_hc_resumen_update_v1 ON public.cardiolink_hc_resumen
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (cardiolink_paciente_padron_v1(paciente_id))
  WITH CHECK (cardiolink_paciente_padron_v1(paciente_id));

CREATE POLICY cardiolink_hc_resumen_delete_v1 ON public.cardiolink_hc_resumen
  AS PERMISSIVE FOR DELETE TO authenticated
  USING ((cardiolink_paciente_padron_v1(paciente_id) AND (cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text]))));

DROP POLICY cardiolink_hc_evoluciones_authenticated ON public.cardiolink_hc_evoluciones;
DROP POLICY cardiolink_hc_resumen_authenticated ON public.cardiolink_hc_resumen;

COMMENT ON POLICY cardiolink_hc_evoluciones_select_v1 ON public.cardiolink_hc_evoluciones IS 'Seguridad clínica V1 p3c: HC compartida entre profesionales activos (owner/admin/médico); Secretaría y cuentas sin rol, sin acceso.';

-- Postcondiciones
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen')) <> 8 THEN RAISE EXCEPTION 'Postcondición: se esperaban exactamente 8 políticas en las tablas de HC'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND policyname LIKE '%\_v1' ESCAPE '\' AND permissive='PERMISSIVE' AND roles = ARRAY['authenticated']::name[]) <> 8 THEN RAISE EXCEPTION 'Postcondición: las 8 políticas deben ser _v1, PERMISSIVE y sólo TO authenticated'; END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND (policyname LIKE '%\_authenticated' ESCAPE '\' OR coalesce(qual,'')='true' OR coalesce(with_check,'')='true')) THEN RAISE EXCEPTION 'Postcondición: siguen las políticas abiertas'; END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND coalesce(qual,'') || coalesce(with_check,'') LIKE '%acceso_clinico%') THEN RAISE EXCEPTION 'Postcondición: p3c no debe depender del vínculo/acceso clínico por paciente'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='cardiolink_hc_evoluciones' AND policyname IN ('cardiolink_hc_evoluciones_insert_v1','cardiolink_hc_evoluciones_update_v1','cardiolink_hc_evoluciones_delete_v1') AND coalesce(qual,'') || coalesce(with_check,'') LIKE '%cardiolink_ctx_prof_v1%') <> 3 THEN RAISE EXCEPTION 'Postcondición: INSERT/UPDATE/DELETE de evoluciones deben exigir el profesional propio'; END IF;
END $$;
COMMIT;
