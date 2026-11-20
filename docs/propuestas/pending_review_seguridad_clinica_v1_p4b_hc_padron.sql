-- CardioLink · Seguridad clínica V1 · p4b · HC por padrón compartido. SOLO donde p3 (HC RLS) YA está aplicada (hoy: STAGING). En Production p3 está postergada: allí NO aplicar; cuando se publique p3, aplicar p4b inmediatamente después.
-- NOTA 2026-11-20: OBSOLETO para Production; p3c (pending_review_seguridad_clinica_v1_p3c_hc_compartida.sql) incluye su efecto. Se conserva como historial.
-- NO EJECUTAR en Production sin autorización. Una sola transacción. Rollback: pending_review_seguridad_clinica_v1_p4b_hc_padron_rollback.sql. Requiere p4 (cardiolink_paciente_padron_v1).
-- Sin p4b, con p3 un médico no puede crear su PRIMERA evolución de un paciente (la política exige acceso clínico, que a su vez se obtiene al tener una evolución).
-- Cambios (todo lo demás de p3 queda igual: UPDATE/DELETE de evoluciones sólo propias y con acceso; SELECT de evoluciones ajenas sólo con acceso clínico; Secretaría sin acceso a HC):
--   evoluciones INSERT: padrón + (owner/admin o médico escribiendo con SU professional_id). evoluciones SELECT: acceso clínico O autoría propia (necesaria para INSERT ... RETURNING, que no ve su propia fila nueva a través de la función).
--   [D1] resumen clínico del paciente (antecedentes/alergias/medicación; es del paciente, no de un médico): SELECT/INSERT/UPDATE por padrón, para poder atender por primera vez con las alergias a la vista. DELETE sigue con acceso clínico. Si el Dueño no lo quiere: borrar el bloque D1.
BEGIN;
DO $$
BEGIN
  IF to_regprocedure('public.cardiolink_paciente_padron_v1(text)') IS NULL THEN RAISE EXCEPTION 'Precondición: aplicar antes p4'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND policyname LIKE '%\_v1' ESCAPE '\') <> 8 THEN
    RAISE EXCEPTION 'Precondición: p3 no está aplicada (se esperaban 8 políticas _v1 de HC). En Production NO aplicar p4b antes que p3'; END IF;
END $$;

ALTER POLICY cardiolink_hc_evoluciones_insert_v1 ON public.cardiolink_hc_evoluciones
  WITH CHECK (cardiolink_paciente_padron_v1(paciente_id) AND ((cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text])) OR ((cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1()))))));

ALTER POLICY cardiolink_hc_evoluciones_select_v1 ON public.cardiolink_hc_evoluciones
  USING (cardiolink_paciente_acceso_clinico_v1(paciente_id) OR ((cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1())))));

-- [D1] resumen clínico compartido
ALTER POLICY cardiolink_hc_resumen_select_v1 ON public.cardiolink_hc_resumen USING (cardiolink_paciente_padron_v1(paciente_id));
ALTER POLICY cardiolink_hc_resumen_insert_v1 ON public.cardiolink_hc_resumen WITH CHECK (cardiolink_paciente_padron_v1(paciente_id));
ALTER POLICY cardiolink_hc_resumen_update_v1 ON public.cardiolink_hc_resumen USING (cardiolink_paciente_padron_v1(paciente_id)) WITH CHECK (cardiolink_paciente_padron_v1(paciente_id));
-- [fin D1]

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND policyname LIKE '%\_v1' ESCAPE '\') <> 8 THEN RAISE EXCEPTION 'Postcondición: cambió la cantidad de políticas de HC'; END IF;
  IF (SELECT with_check FROM pg_policies WHERE policyname='cardiolink_hc_evoluciones_insert_v1') NOT LIKE '%cardiolink_paciente_padron_v1(paciente_id)%' THEN RAISE EXCEPTION 'Postcondición: evoluciones INSERT'; END IF;
  IF (SELECT qual FROM pg_policies WHERE policyname='cardiolink_hc_evoluciones_update_v1') NOT LIKE '%cardiolink_paciente_acceso_clinico_v1(paciente_id)%' THEN RAISE EXCEPTION 'Postcondición: evoluciones UPDATE debe seguir con acceso clínico'; END IF;
END $$;
COMMIT;
