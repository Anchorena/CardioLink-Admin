-- CardioLink Admin - Documentos y estudios PDF (Fase 6 / Bloque 6D)
-- Ajuste incremental: acceso de Secretaria.
--
-- Migracion posterior a 20261007100000_cardiolink_patient_documents_v1.sql,
-- que NO se modifica. Ajusta unicamente el permiso de Secretaria sobre
-- cardiolink_patient_documents y storage.objects (bucket patient-documents):
--
--   owner / admin / medico : listar, subir, ver, descargar, ELIMINAR
--   secretaria              : listar, subir, ver, descargar, NO eliminar
--
-- Antes de este ajuste, cardiolink_has_clinical_documents_access() excluia
-- a secretaria de todo (select/insert/delete), reflejando la regla de
-- cliente puedeAccederInformacionClinica() (owner/admin/medico). Esta
-- migracion separa lectura/escritura de borrado en dos funciones:
--
--   cardiolink_has_clinical_documents_access()   -> ahora incluye
--     secretaria. Sigue gatillando SELECT e INSERT en la tabla y en
--     storage.objects.
--   cardiolink_can_delete_clinical_documents()   -> funcion NUEVA, solo
--     owner/admin/medico. Gatilla unicamente DELETE en la tabla y en
--     storage.objects.
--
-- No es un segundo sistema de roles: ambas funciones siguen el mismo
-- patron SECURITY DEFINER sobre cardiolink_user_roles.base_role que ya
-- usan las demas cardiolink_has_*_access() de este repo. No se agrega
-- UPDATE en ningun lado (no hace falta en V1).

begin;

-- ---------------------------------------------------------------------------
-- 1) Ampliar la funcion de lectura/escritura para incluir secretaria.
--    CREATE OR REPLACE conserva el nombre, la firma y los grants ya
--    otorgados en la migracion anterior - solo cambia el cuerpo.
-- ---------------------------------------------------------------------------

create or replace function public.cardiolink_has_clinical_documents_access()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select exists (
    select 1
      from public.cardiolink_user_roles as user_role
     where user_role.user_id = auth.uid()
       and user_role.active
       and user_role.base_role in ('owner', 'admin', 'medico', 'secretaria')
  );
$function$;

-- ---------------------------------------------------------------------------
-- 2) Funcion nueva, solo para DELETE: mismo patron, sin secretaria.
-- ---------------------------------------------------------------------------

create function public.cardiolink_can_delete_clinical_documents()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select exists (
    select 1
      from public.cardiolink_user_roles as user_role
     where user_role.user_id = auth.uid()
       and user_role.active
       and user_role.base_role in ('owner', 'admin', 'medico')
  );
$function$;

revoke all privileges on function public.cardiolink_can_delete_clinical_documents()
  from public, anon, authenticated;
grant execute on function public.cardiolink_can_delete_clinical_documents() to authenticated;

-- ---------------------------------------------------------------------------
-- 3) Policies de la tabla de metadata: select/insert sin cambio de regla
--    (siguen en la misma funcion, que ahora ya incluye secretaria); delete
--    pasa a usar la funcion nueva, mas estricta.
-- ---------------------------------------------------------------------------

drop policy cardiolink_patient_documents_delete on public.cardiolink_patient_documents;

create policy cardiolink_patient_documents_delete
on public.cardiolink_patient_documents
for delete to authenticated
using (public.cardiolink_can_delete_clinical_documents());

-- ---------------------------------------------------------------------------
-- 4) Policies de storage.objects del bucket patient-documents: mismo
--    criterio que el punto 3.
-- ---------------------------------------------------------------------------

drop policy cardiolink_patient_documents_storage_delete on storage.objects;

create policy cardiolink_patient_documents_storage_delete
on storage.objects
for delete to authenticated
using (
  bucket_id = 'patient-documents'
  and public.cardiolink_can_delete_clinical_documents()
);

commit;
