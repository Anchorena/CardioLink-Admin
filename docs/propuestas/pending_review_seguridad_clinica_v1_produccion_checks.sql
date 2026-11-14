-- CardioLink · Seguridad clínica V1 · CHECKS DE PUBLICACIÓN (SOLO LECTURA: un único SELECT sobre el catálogo; seguro de ejecutar en Production antes y después de CADA paso).
-- Devuelve un JSON con: qué pasos están aplicados, el estado de las políticas y los conteos de datos. Comparar con la tabla «estado esperado» de pending_review_seguridad_clinica_v1_PUBLICACION.md.
SELECT to_jsonb(x)::text AS estado FROM (SELECT
  to_regclass('public.cardiolink_secretaria_medicos') IS NOT NULL AND to_regprocedure('public.cardiolink_asociar_secretaria_medico_v1(uuid,uuid,boolean)') IS NOT NULL AS p1_asociaciones,
  to_regclass('public.cardiolink_paciente_profesionales_v1') IS NOT NULL AND to_regprocedure('public.cardiolink_paciente_acceso_clinico_v1(text)') IS NOT NULL AS p2_acceso_clinico,
  to_regprocedure('public.cardiolink_config_tipos_doc_sec_v1()') IS NOT NULL AND to_regprocedure('public.cardiolink_guardar_config_administrativa_v1(jsonb,text,text,uuid)') IS NOT NULL AS b4b_etapa_a,
  EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='cardiolink_atenciones' AND policyname='cardiolink_atenciones_config_solo_admin_v1') AS b4b_etapa_b,
  (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND policyname LIKE '%\_v1' ESCAPE '\') AS p3_politicas_hc_v1_de_8,
  (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND policyname LIKE '%\_authenticated' ESCAPE '\') AS hc_politicas_abiertas_de_2,
  (SELECT count(*) FROM pg_policies WHERE policyname LIKE '%\_4c1' ESCAPE '\' AND permissive='RESTRICTIVE') AS c4c1_politicas_restrictivas_de_6,
  (SELECT count(*) FROM pg_policies WHERE policyname IN ('cardiolink_patient_documents_select_no_img_secretaria','cardiolink_patient_documents_insert_no_img_secretaria','cardiolink_clinical_images_storage_select_no_secretaria','cardiolink_clinical_images_storage_insert_no_secretaria')) AS politicas_imagen_clinica_anteriores_de_4,
  (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('cardiolink_tipos_documento_secretaria_v1','cardiolink_profesionales_autorizados_secretaria_v1','cardiolink_secretaria_autorizada_prof_v1','cardiolink_objeto_sin_fila_v1','cardiolink_objeto_asignable_v1','cardiolink_vinculo_documental_v1','cardiolink_patient_documents_inmutables_4c1')) AS c4c1_funciones_de_7,
  (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.cardiolink_patient_documents'::regclass AND tgname='cardiolink_patient_documents_inmutables_4c1') AS c4c1_trigger_de_1,
  (SELECT md5(regexp_replace(prosrc, '\s+', ' ', 'g')) FROM pg_proc WHERE oid = to_regprocedure('public.cardiolink_historial_envios_documento_v1(text[])')) AS rpc_historial_md5__original_27fd6db7_estricta_distinta,
  coalesce(obj_description(to_regprocedure('public.cardiolink_historial_envios_documento_v1(text[])'), 'pg_proc'), '') LIKE '%[4C-1:%' AS rpc_historial_con_marca_4c1,
  (SELECT qual FROM pg_policies WHERE schemaname='public' AND tablename='cardiolink_communications' AND policyname='cardiolink_communications_select') AS comunicaciones_select_qual__debe_ser_read_access,
  (CASE WHEN to_regclass('public.cardiolink_secretaria_medicos') IS NOT NULL THEN (SELECT (xpath('/row/n/text()', query_to_xml('select count(*) as n from public.cardiolink_secretaria_medicos where activo', false, true, '')))[1]::text) END) AS asociaciones_activas,
  (SELECT jsonb_agg(jsonb_build_object('rol', base_role, 'activo', active, 'prof', professional_id) ORDER BY base_role) FROM public.cardiolink_user_roles WHERE active) AS usuarios_activos,
  (SELECT count(*) FROM public.cardiolink_patient_documents) AS docs_total,
  (SELECT count(*) FROM storage.objects WHERE bucket_id='patient-documents') AS objetos_total,
  (SELECT count(*) FROM storage.objects WHERE bucket_id='patient-documents' AND name LIKE 'documents/qa4c_storage/%') AS objetos_qa_descartables
) x;
