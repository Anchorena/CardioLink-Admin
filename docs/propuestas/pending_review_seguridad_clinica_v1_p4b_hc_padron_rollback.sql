-- ROLLBACK de p4b: restaura las políticas de HC tal como las deja p3. Una sola transacción.
BEGIN;
DO $$ BEGIN
  IF (SELECT with_check FROM pg_policies WHERE policyname='cardiolink_hc_evoluciones_insert_v1') NOT LIKE '%cardiolink_paciente_padron_v1(paciente_id)%' THEN RAISE EXCEPTION 'Precondición: p4b no está aplicada'; END IF;
END $$;
ALTER POLICY cardiolink_hc_evoluciones_insert_v1 ON public.cardiolink_hc_evoluciones
  WITH CHECK ((cardiolink_paciente_acceso_clinico_v1(paciente_id) AND ((cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text])) OR ((cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1())))))));
ALTER POLICY cardiolink_hc_evoluciones_select_v1 ON public.cardiolink_hc_evoluciones USING (cardiolink_paciente_acceso_clinico_v1(paciente_id));
ALTER POLICY cardiolink_hc_resumen_select_v1 ON public.cardiolink_hc_resumen USING (cardiolink_paciente_acceso_clinico_v1(paciente_id));
ALTER POLICY cardiolink_hc_resumen_insert_v1 ON public.cardiolink_hc_resumen WITH CHECK (cardiolink_paciente_acceso_clinico_v1(paciente_id));
ALTER POLICY cardiolink_hc_resumen_update_v1 ON public.cardiolink_hc_resumen USING (cardiolink_paciente_acceso_clinico_v1(paciente_id)) WITH CHECK (cardiolink_paciente_acceso_clinico_v1(paciente_id));
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE policyname LIKE 'cardiolink_hc\_%\_v1' ESCAPE '\' AND (coalesce(qual,'') LIKE '%padron%' OR coalesce(with_check,'') LIKE '%padron%')) THEN RAISE EXCEPTION 'Postcondición: quedan políticas de HC con el padrón'; END IF;
END $$;
COMMIT;
