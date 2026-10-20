-- CardioLink · CHECKS de SOLO LECTURA para la eliminación por emisor (sólo SELECT: no modifica nada)
-- Ejecutar en el SQL Editor ANTES y DESPUÉS de aplicar pending_review_patient_documents_delete_ownership_v1.sql, en cada entorno por
-- separado (primero STAGING; Production sólo con autorización) y comparar. No imprime textos clínicos ni emails.

-- 1) Policies DELETE/UPDATE vigentes (tabla y storage)
select schemaname, tablename, policyname, cmd, qual
  from pg_policies
 where (schemaname = 'public' and tablename = 'cardiolink_patient_documents')
    or (schemaname = 'storage' and tablename = 'objects' and policyname like 'cardiolink_patient_documents%')
 order by tablename, policyname;

-- 2) Funciones y trigger (antes: sólo la función por rol; después: también la función por emisor y el trigger)
select p.proname, pg_get_function_identity_arguments(p.oid) as args, p.prosecdef as security_definer
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('cardiolink_can_delete_clinical_documents','cardiolink_can_delete_clinical_document','cardiolink_patient_documents_actor_guard_v1');
select tgname, tgenabled from pg_trigger where tgrelid = 'public.cardiolink_patient_documents'::regclass and not tgisinternal order by tgname;

-- 3) Precondiciones de columnas (deben dar 1 fila cada una)
select 'user_roles.professional_id' as columna, count(*) from information_schema.columns where table_schema='public' and table_name='cardiolink_user_roles' and column_name='professional_id'
union all
select 'storage.objects.owner', count(*) from information_schema.columns where table_schema='storage' and table_name='objects' and column_name='owner';

-- 4) Cuentas activas y su vínculo con un profesional (sin emails): un médico con professional_id NULL en esta tabla NO podrá borrar ningún documento
--    que lleve professional_id (sólo los que tengan professional_id NULL y hayan sido subidos por él)
select base_role, active, (professional_id is not null) as vinculado_a_profesional, professional_id, count(*) as cuentas
  from public.cardiolink_user_roles
 group by base_role, active, (professional_id is not null), professional_id
 order by base_role, professional_id nulls first;

-- 5) Filas de documentos por atribución. Con professional_id: las borra el médico vinculado a ese profesional. Sin professional_id: el médico que las subió (uploaded_by).
--    Sin professional_id Y sin uploaded_by: sólo owner/admin
select (source_document_id is not null) as archivado_v1,
       (professional_id is not null)    as con_professional_id,
       (uploaded_by is not null)        as con_uploaded_by,
       count(*) as filas
  from public.cardiolink_patient_documents
 group by 1, 2, 3
 order by 1, 2, 3;

-- 6) Objetos del bucket sin fila de metadata (huérfanos) y su subidor
select count(*) as objetos_sin_fila
  from storage.objects o
 where o.bucket_id = 'patient-documents'
   and not exists (select 1 from public.cardiolink_patient_documents d where d.storage_path = o.name);

-- 7) Documentos con professional_id que NO coincide con ninguna cuenta médica activa vinculada: tras la corrección sólo los borrarán owner/admin
select d.professional_id, count(*) as filas
  from public.cardiolink_patient_documents d
 where d.professional_id is not null
   and not exists (select 1 from public.cardiolink_user_roles ur where ur.active and ur.base_role = 'medico' and ur.professional_id = d.professional_id)
 group by d.professional_id
 order by d.professional_id;
