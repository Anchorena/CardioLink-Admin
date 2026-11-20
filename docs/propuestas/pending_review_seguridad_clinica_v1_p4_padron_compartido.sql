-- CardioLink · Seguridad clínica V1 · CORRECCIÓN P0 "PADRÓN COMPARTIDO" (p4) · DOCUMENTOS (INSERT de cardiolink_patient_documents)
-- BORRADOR PARA REVISIÓN. NO EJECUTAR en Production sin autorización explícita. Primero STAGING (ensayo reversible: pending_review_seguridad_clinica_v1_p4_ensayo_reversible.sql).
-- Una sola transacción, sin DML sobre datos. Falla (y revierte todo) si el estado no es el esperado. Rollback: pending_review_seguridad_clinica_v1_p4_padron_compartido_rollback.sql
--
-- PROBLEMA (confirmado en Production). La política RESTRICTIVE cardiolink_patient_documents_insert_4c1 exige, para el médico, cardiolink_paciente_acceso_clinico_v1(patient_id):
-- asociación manual, evolución propia o atención propia con ese paciente. Eso impide que un médico emita su PRIMER documento a un paciente que todavía no atendió.
-- DECISIÓN DEL DUEÑO: el padrón de pacientes es compartido por todos los médicos activos; los pacientes no son de un profesional.
--
-- CORRECCIÓN MÍNIMA. (1) Función nueva cardiolink_paciente_padron_v1(text): true sólo si hay sesión, el usuario tiene un rol ACTIVO owner/admin o médico (con professional_id válido)
-- y el paciente EXISTE en cardiolink_pacientes. Secretaría, usuarios sin rol, inactivos y sesiones ajenas: false. (2) ALTER POLICY de insert_4c1: en la rama del médico, la condición
-- "acceso clínico al paciente" pasa a "padrón" (el paciente existe). TODO LO DEMÁS DE LA POLÍTICA QUEDA IDÉNTICO: owner/admin; médico a nombre propio (o sin profesional) y con archivo asignable
-- (subido por él, hace menos de 1 h, en la ruta de ESE paciente); Secretaría con tipo permitido, profesional AUTORIZADO por asociación activa, sin evolución y con archivo asignable.
--
-- NO CAMBIA (sigue protegido por cardiolink_paciente_acceso_clinico_v1): SELECT de documentos ajenos, UPDATE, vínculos a evolución/atención ajenas, historial de envíos, Storage, notas internas
-- (viven en la config, fuera de este SQL), asociaciones Secretaría-profesional, trigger de inmutables. Un médico NO puede insertar a nombre de otro profesional ni sobre un archivo ajeno.
BEGIN;
DO $$
BEGIN
  IF to_regprocedure('public.cardiolink_ctx_rol_v1()') IS NULL OR to_regprocedure('public.cardiolink_ctx_prof_v1()') IS NULL
     OR to_regprocedure('public.cardiolink_objeto_asignable_v1(text,text)') IS NULL OR to_regprocedure('public.cardiolink_secretaria_autorizada_prof_v1(text)') IS NULL
     OR to_regprocedure('public.cardiolink_tipos_documento_secretaria_v1()') IS NULL OR to_regprocedure('public.cardiolink_paciente_acceso_clinico_v1(text)') IS NULL THEN
    RAISE EXCEPTION 'Precondición: falta alguna función de 4C-1 / p2 (¿4C-1 y p2 aplicados?)'; END IF;
  IF to_regclass('public.cardiolink_pacientes') IS NULL OR to_regclass('public.cardiolink_user_roles') IS NULL THEN RAISE EXCEPTION 'Precondición: faltan cardiolink_pacientes / cardiolink_user_roles'; END IF;
  IF to_regprocedure('public.cardiolink_paciente_padron_v1(text)') IS NOT NULL THEN RAISE EXCEPTION 'Precondición: p4 ya está aplicada (cardiolink_paciente_padron_v1 existe)'; END IF;
  IF (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.cardiolink_patient_documents'::regclass AND polname = 'cardiolink_patient_documents_insert_4c1' AND NOT polpermissive AND polcmd = 'a') <> 1 THEN
    RAISE EXCEPTION 'Precondición: falta la política RESTRICTIVE de INSERT cardiolink_patient_documents_insert_4c1'; END IF;
  IF (SELECT pg_get_expr(polwithcheck, polrelid) FROM pg_policy WHERE polrelid = 'public.cardiolink_patient_documents'::regclass AND polname = 'cardiolink_patient_documents_insert_4c1')
       NOT LIKE '%cardiolink_paciente_acceso_clinico_v1(patient_id)%' THEN
    RAISE EXCEPTION 'Precondición: la política INSERT 4C-1 no tiene la forma esperada (acceso clínico en la rama del médico); el estado difiere'; END IF;
END $$;

-- ===== 1) Padrón compartido: ¿el usuario es un profesional activo del consultorio y el paciente existe? =====
-- SECURITY DEFINER (ignora la RLS a propósito, como cardiolink_paciente_acceso_clinico_v1): "existe" no puede depender de lo que el usuario vea. No expone datos: sólo un boolean.
CREATE FUNCTION public.cardiolink_paciente_padron_v1(p_paciente_id text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $f$
 SELECT auth.uid() IS NOT NULL
    AND nullif(btrim(p_paciente_id), '') IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.cardiolink_user_roles r
                 WHERE r.user_id = auth.uid() AND r.active IS TRUE
                   AND (r.base_role IN ('owner', 'admin')
                        OR (r.base_role = 'medico' AND r.professional_id ~ '^[A-Za-z0-9_.-]{1,64}$')))
    AND EXISTS (SELECT 1 FROM public.cardiolink_pacientes p WHERE p.id = p_paciente_id)
$f$;
REVOKE ALL ON FUNCTION public.cardiolink_paciente_padron_v1(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cardiolink_paciente_padron_v1(text) TO authenticated;
COMMENT ON FUNCTION public.cardiolink_paciente_padron_v1(text) IS 'Seguridad clínica V1 p4: padrón compartido. true si hay sesión, rol ACTIVO owner/admin/médico (professional_id válido) y el paciente existe. NO da acceso a la información clínica de otros profesionales (eso es cardiolink_paciente_acceso_clinico_v1).';

-- ===== 2) INSERT de documentos: la rama del médico usa el padrón (el resto de la política es idéntico a 4C-1) =====
ALTER POLICY cardiolink_patient_documents_insert_4c1 ON public.cardiolink_patient_documents
  WITH CHECK (
    (SELECT public.cardiolink_ctx_rol_v1()) IN ('owner', 'admin')
    OR ((SELECT public.cardiolink_ctx_rol_v1()) = 'medico'
        AND (professional_id IS NULL OR professional_id = (SELECT public.cardiolink_ctx_prof_v1()))
        AND public.cardiolink_paciente_padron_v1(patient_id)
        AND public.cardiolink_objeto_asignable_v1(storage_path, patient_id))
    OR ((SELECT public.cardiolink_ctx_rol_v1()) = 'secretaria'
        AND document_type = ANY (public.cardiolink_tipos_documento_secretaria_v1()) AND storage_path NOT LIKE 'clinical-images/%'
        AND evolution_id IS NULL AND public.cardiolink_secretaria_autorizada_prof_v1(professional_id)
        AND public.cardiolink_objeto_asignable_v1(storage_path, patient_id))
  );

-- ===== 3) Postcondiciones =====
DO $$
DECLARE v text;
BEGIN
  SELECT pg_get_expr(polwithcheck, polrelid) INTO v FROM pg_policy WHERE polrelid = 'public.cardiolink_patient_documents'::regclass AND polname = 'cardiolink_patient_documents_insert_4c1';
  IF v IS NULL OR v NOT LIKE '%cardiolink_paciente_padron_v1(patient_id)%' OR v LIKE '%cardiolink_paciente_acceso_clinico_v1%' THEN RAISE EXCEPTION 'Postcondición: la política INSERT no quedó con el padrón'; END IF;
  IF v NOT LIKE '%cardiolink_objeto_asignable_v1(storage_path, patient_id)%' OR v NOT LIKE '%cardiolink_secretaria_autorizada_prof_v1(professional_id)%' OR v NOT LIKE '%cardiolink_ctx_prof_v1()%' THEN
    RAISE EXCEPTION 'Postcondición: se perdió una condición del médico/Secretaría (archivo asignable, profesional autorizado o profesional propio)'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.cardiolink_patient_documents'::regclass AND polname = 'cardiolink_patient_documents_insert_4c1' AND NOT polpermissive AND polcmd = 'a') THEN
    RAISE EXCEPTION 'Postcondición: la política dejó de ser RESTRICTIVE de INSERT'; END IF;
  IF has_function_privilege('anon', 'public.cardiolink_paciente_padron_v1(text)', 'EXECUTE') OR has_function_privilege('public', 'public.cardiolink_paciente_padron_v1(text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.cardiolink_paciente_padron_v1(text)', 'EXECUTE') THEN RAISE EXCEPTION 'Postcondición: privilegios de cardiolink_paciente_padron_v1'; END IF;
  IF (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.cardiolink_patient_documents'::regclass AND polname LIKE '%\_4c1' ESCAPE '\') <> 3 THEN RAISE EXCEPTION 'Postcondición: se esperaban las 3 políticas _4c1 de la tabla'; END IF;
END $$;
COMMIT;
