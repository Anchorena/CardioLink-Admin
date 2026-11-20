-- ROLLBACK del delta p3c: vuelve a las 8 políticas de p3 (acceso clínico por paciente), exactamente como las deja pending_review_seguridad_clinica_v1_p3_hc_rls.sql. Una sola transacción.
-- (Si la base tenía además p4b, reaplicar p4b después.)
BEGIN;
DO $$ BEGIN
  IF (SELECT qual FROM pg_policies WHERE policyname='cardiolink_hc_evoluciones_select_v1') NOT LIKE '%cardiolink_paciente_padron_v1%' THEN RAISE EXCEPTION 'Rollback: el delta p3c no está aplicado'; END IF;
END $$;
ALTER POLICY cardiolink_hc_evoluciones_select_v1 ON public.cardiolink_hc_evoluciones USING (cardiolink_paciente_acceso_clinico_v1(paciente_id));
ALTER POLICY cardiolink_hc_evoluciones_insert_v1 ON public.cardiolink_hc_evoluciones
  WITH CHECK ((cardiolink_paciente_acceso_clinico_v1(paciente_id) AND ((cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text])) OR ((cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1())))))));
ALTER POLICY cardiolink_hc_evoluciones_update_v1 ON public.cardiolink_hc_evoluciones
  USING ((cardiolink_paciente_acceso_clinico_v1(paciente_id) AND ((cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text])) OR ((cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1())))))))
  WITH CHECK ((cardiolink_paciente_acceso_clinico_v1(paciente_id) AND ((cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text])) OR ((cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1())))))));
ALTER POLICY cardiolink_hc_evoluciones_delete_v1 ON public.cardiolink_hc_evoluciones
  USING ((cardiolink_paciente_acceso_clinico_v1(paciente_id) AND ((cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text])) OR ((cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1())))))));
ALTER POLICY cardiolink_hc_resumen_select_v1 ON public.cardiolink_hc_resumen USING (cardiolink_paciente_acceso_clinico_v1(paciente_id));
ALTER POLICY cardiolink_hc_resumen_insert_v1 ON public.cardiolink_hc_resumen WITH CHECK (cardiolink_paciente_acceso_clinico_v1(paciente_id));
ALTER POLICY cardiolink_hc_resumen_update_v1 ON public.cardiolink_hc_resumen USING (cardiolink_paciente_acceso_clinico_v1(paciente_id)) WITH CHECK (cardiolink_paciente_acceso_clinico_v1(paciente_id));
ALTER POLICY cardiolink_hc_resumen_delete_v1 ON public.cardiolink_hc_resumen USING (cardiolink_paciente_acceso_clinico_v1(paciente_id));
COMMENT ON POLICY cardiolink_hc_evoluciones_select_v1 ON public.cardiolink_hc_evoluciones IS NULL;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE policyname LIKE 'cardiolink_hc\_%\_v1' ESCAPE '\' AND (coalesce(qual,'') LIKE '%padron%' OR coalesce(with_check,'') LIKE '%padron%')) THEN RAISE EXCEPTION 'Rollback: quedan políticas con el padrón'; END IF;
END $$;
COMMIT;
