select jsonb_pretty(jsonb_build_object(
 'proyecto_db', current_database(),
 'columnas_documentos', (select jsonb_agg(column_name order by column_name) from information_schema.columns where table_schema='public' and table_name='cardiolink_patient_documents' and column_name in ('source_document_id','source_content_hash','source_payload')),
 'triggers_documentos', (select jsonb_agg(jsonb_build_object('t',tgname,'habilitado',tgenabled) order by tgname) from pg_trigger where tgrelid='public.cardiolink_patient_documents'::regclass and not tgisinternal),
 'funciones_acceso', (select jsonb_agg(jsonb_build_object('f',proname,'definer',prosecdef) order by proname) from pg_proc where pronamespace='public'::regnamespace and proname in ('cardiolink_has_clinical_documents_access','cardiolink_can_delete_clinical_documents')),
 'roles_activos', (select jsonb_object_agg(base_role, n) from (select base_role, count(*) filter (where active) n from public.cardiolink_user_roles group by base_role) x),
 'medicos_con_professional_id', (select count(*) from public.cardiolink_user_roles where active and base_role='medico' and nullif(btrim(professional_id),'') is not null),
 'tablas_v2a_existentes', (select jsonb_agg(relname) from pg_class where relnamespace='public'::regnamespace and relname in ('cardiolink_document_verifications','cardiolink_document_verification_events')),
 'funciones_v2a_existentes', (select jsonb_agg(proname) from pg_proc where pronamespace='public'::regnamespace and (proname like 'cardiolink\_verificacion\_%' or proname='cardiolink_es_profesional_propio_v1')),
 'policies_documentos', (select count(*) from pg_policies where schemaname='public' and tablename='cardiolink_patient_documents'),
 'rls_documentos', (select relrowsecurity from pg_class where oid='public.cardiolink_patient_documents'::regclass),
 'documentos_total', (select count(*) from public.cardiolink_patient_documents),
 'documentos_con_payload', (select count(*) from public.cardiolink_patient_documents where source_payload is not null)
)) as check_prerrequisitos;
