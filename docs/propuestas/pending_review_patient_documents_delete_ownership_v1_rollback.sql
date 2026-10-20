-- CardioLink · ROLLBACK de pending_review_patient_documents_delete_ownership_v1.sql
-- BORRADOR PARA REVISIÓN. NO EJECUTAR sin autorización explícita. No toca filas ni PDFs.
-- Restaura las policies DELETE de tabla y Storage con cardiolink_can_delete_clinical_documents() (owner/admin/médico por rol) y
-- elimina el trigger y las funciones nuevas. Vuelve a abrir el hueco original: usarlo sólo si la migración causa un problema.

begin;

drop trigger if exists cardiolink_patient_documents_actor_guard_v1 on public.cardiolink_patient_documents;
drop function if exists public.cardiolink_patient_documents_actor_guard_v1();

drop policy if exists cardiolink_patient_documents_delete on public.cardiolink_patient_documents;
create policy cardiolink_patient_documents_delete
on public.cardiolink_patient_documents
for delete to authenticated
using (public.cardiolink_can_delete_clinical_documents());

drop policy if exists cardiolink_patient_documents_storage_delete on storage.objects;
create policy cardiolink_patient_documents_storage_delete
on storage.objects
for delete to authenticated
using (
  bucket_id = 'patient-documents'
  and public.cardiolink_can_delete_clinical_documents()
);

drop function if exists public.cardiolink_can_delete_clinical_document(text, uuid);

commit;
