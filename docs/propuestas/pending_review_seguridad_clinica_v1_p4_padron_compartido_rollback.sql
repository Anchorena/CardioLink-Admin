-- ROLLBACK de pending_review_seguridad_clinica_v1_p4_padron_compartido.sql: restaura EXACTAMENTE la política INSERT de 4C-1 (rama del médico con acceso clínico) y elimina la función del padrón.
-- Una sola transacción. Si algo no coincide, aborta.
BEGIN;
DO $$
BEGIN
  IF to_regprocedure('public.cardiolink_paciente_padron_v1(text)') IS NULL THEN RAISE EXCEPTION 'Precondición: p4 no está aplicada'; END IF;
  IF (SELECT pg_get_expr(polwithcheck, polrelid) FROM pg_policy WHERE polrelid = 'public.cardiolink_patient_documents'::regclass AND polname = 'cardiolink_patient_documents_insert_4c1') NOT LIKE '%cardiolink_paciente_padron_v1(patient_id)%' THEN
    RAISE EXCEPTION 'Precondición: la política INSERT no usa el padrón'; END IF;
END $$;
ALTER POLICY cardiolink_patient_documents_insert_4c1 ON public.cardiolink_patient_documents
  WITH CHECK (
    (SELECT public.cardiolink_ctx_rol_v1()) IN ('owner', 'admin')
    OR ((SELECT public.cardiolink_ctx_rol_v1()) = 'medico'
        AND (professional_id IS NULL OR professional_id = (SELECT public.cardiolink_ctx_prof_v1()))
        AND public.cardiolink_paciente_acceso_clinico_v1(patient_id)
        AND public.cardiolink_objeto_asignable_v1(storage_path, patient_id))
    OR ((SELECT public.cardiolink_ctx_rol_v1()) = 'secretaria'
        AND document_type = ANY (public.cardiolink_tipos_documento_secretaria_v1()) AND storage_path NOT LIKE 'clinical-images/%'
        AND evolution_id IS NULL AND public.cardiolink_secretaria_autorizada_prof_v1(professional_id)
        AND public.cardiolink_objeto_asignable_v1(storage_path, patient_id))
  );
DROP FUNCTION public.cardiolink_paciente_padron_v1(text);
DO $$
BEGIN
  IF to_regprocedure('public.cardiolink_paciente_padron_v1(text)') IS NOT NULL THEN RAISE EXCEPTION 'Postcondición: la función del padrón sigue existiendo'; END IF;
  IF (SELECT pg_get_expr(polwithcheck, polrelid) FROM pg_policy WHERE polrelid = 'public.cardiolink_patient_documents'::regclass AND polname = 'cardiolink_patient_documents_insert_4c1') NOT LIKE '%cardiolink_paciente_acceso_clinico_v1(patient_id)%' THEN
    RAISE EXCEPTION 'Postcondición: la política no volvió a usar el acceso clínico'; END IF;
END $$;
COMMIT;
