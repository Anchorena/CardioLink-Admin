-- CardioLink · Seguridad clínica V1 · p3c · DELTA para bases que YA tienen p3 (hoy: STAGING). En Production (políticas abiertas, sin p3) usar pending_review_seguridad_clinica_v1_p3c_hc_compartida.sql.
-- Transforma las 8 políticas _v1 de p3 (acceso clínico por paciente) en las de p3c (HC compartida entre profesionales activos) con ALTER POLICY: no hay ventana sin política.
-- Resultado IDÉNTICO a p3c_hc_compartida.sql (el ensayo reversible lo compara política por política). Funciona también si además estaba aplicada p4b. Una sola transacción, sin DML.
-- Requiere p4 (cardiolink_paciente_padron_v1). Rollback: pending_review_seguridad_clinica_v1_p3c_delta_staging_rollback.sql (vuelve a p3 exacta).
BEGIN;
DO $$
BEGIN
  IF to_regprocedure('public.cardiolink_paciente_padron_v1(text)') IS NULL THEN RAISE EXCEPTION 'Precondición: aplicar antes p4 (cardiolink_paciente_padron_v1)'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND policyname LIKE '%\_v1' ESCAPE '\') <> 8
     OR (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen')) <> 8 THEN
    RAISE EXCEPTION 'Precondición: se esperaban exactamente las 8 políticas _v1 de p3 (sin otras). Si la base tiene las abiertas usar p3c_hc_compartida.sql'; END IF;
END $$;

ALTER POLICY cardiolink_hc_evoluciones_select_v1 ON public.cardiolink_hc_evoluciones
  USING (cardiolink_paciente_padron_v1(paciente_id));
ALTER POLICY cardiolink_hc_evoluciones_insert_v1 ON public.cardiolink_hc_evoluciones
  WITH CHECK ((cardiolink_paciente_padron_v1(paciente_id) AND ((cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text])) OR ((cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1())))))));
ALTER POLICY cardiolink_hc_evoluciones_update_v1 ON public.cardiolink_hc_evoluciones
  USING ((cardiolink_paciente_padron_v1(paciente_id) AND ((cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text])) OR ((cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1())))))))
  WITH CHECK ((cardiolink_paciente_padron_v1(paciente_id) AND ((cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text])) OR ((cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1())))))));
ALTER POLICY cardiolink_hc_evoluciones_delete_v1 ON public.cardiolink_hc_evoluciones
  USING ((cardiolink_paciente_padron_v1(paciente_id) AND ((cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text])) OR ((cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1())))))));
ALTER POLICY cardiolink_hc_resumen_select_v1 ON public.cardiolink_hc_resumen USING (cardiolink_paciente_padron_v1(paciente_id));
ALTER POLICY cardiolink_hc_resumen_insert_v1 ON public.cardiolink_hc_resumen WITH CHECK (cardiolink_paciente_padron_v1(paciente_id));
ALTER POLICY cardiolink_hc_resumen_update_v1 ON public.cardiolink_hc_resumen USING (cardiolink_paciente_padron_v1(paciente_id)) WITH CHECK (cardiolink_paciente_padron_v1(paciente_id));
ALTER POLICY cardiolink_hc_resumen_delete_v1 ON public.cardiolink_hc_resumen USING ((cardiolink_paciente_padron_v1(paciente_id) AND (cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text]))));

COMMENT ON POLICY cardiolink_hc_evoluciones_select_v1 ON public.cardiolink_hc_evoluciones IS 'Seguridad clínica V1 p3c: HC compartida entre profesionales activos (owner/admin/médico); Secretaría y cuentas sin rol, sin acceso.';

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND policyname LIKE '%\_v1' ESCAPE '\' AND permissive='PERMISSIVE' AND roles = ARRAY['authenticated']::name[]) <> 8 THEN RAISE EXCEPTION 'Postcondición: se esperaban 8 políticas _v1 PERMISSIVE TO authenticated'; END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND (coalesce(qual,'') || coalesce(with_check,'') LIKE '%acceso_clinico%' OR coalesce(qual,'')='true' OR coalesce(with_check,'')='true')) THEN RAISE EXCEPTION 'Postcondición: quedan políticas con acceso clínico por paciente o abiertas'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='cardiolink_hc_evoluciones' AND policyname IN ('cardiolink_hc_evoluciones_insert_v1','cardiolink_hc_evoluciones_update_v1','cardiolink_hc_evoluciones_delete_v1') AND coalesce(qual,'') || coalesce(with_check,'') LIKE '%cardiolink_ctx_prof_v1%') <> 3 THEN RAISE EXCEPTION 'Postcondición: INSERT/UPDATE/DELETE de evoluciones deben exigir el profesional propio'; END IF;
END $$;
COMMIT;
