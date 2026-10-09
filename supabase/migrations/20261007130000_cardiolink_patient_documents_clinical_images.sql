-- CardioLink Admin - Imagen clínica desde cámara/webcam (Fase 6 / Bloque 6D.3)
--
-- Auditoría previa (ver informe 6D.3): el bucket patient-documents sólo
-- aceptaba application/pdf (20MB, privado). Las policies de
-- cardiolink_patient_documents y de storage.objects para ese bucket son
-- TODAS "permissive" (confirmado con pg_policies): select/insert usan
-- cardiolink_has_clinical_documents_access() (owner/admin/médico/
-- secretaria); update/delete ya usan cardiolink_can_delete_clinical_
-- documents() (owner/admin/médico, sin secretaria) desde 6D.2.
--
-- Las policies permissive se combinan entre sí con OR: agregar una nueva
-- policy "permissive" que intente ser más restrictiva NO funciona (la
-- policy vieja seguiría permitiendo todo igual). Por eso esta migración
-- agrega policies RESTRICTIVE (se combinan con AND) que recortan
-- exactamente el caso document_type = 'Imagen clínica' / path
-- clinical-images/ para quien no tenga acceso clínico completo
-- (Secretaría). No se toca ninguna policy existente, no se inventa
-- ninguna función de rol nueva - se reutiliza
-- cardiolink_can_delete_clinical_documents() (mismo conjunto owner/
-- admin/médico ya usado para delete/update desde 6D.2).
--
-- No modifica ninguna migración anterior (20261007100000, 20261007110000
-- ni 20261007120000).

begin;

-- ---------------------------------------------------------------------------
-- 1) Bucket: admitir también image/jpeg (las imágenes clínicas se
--    normalizan SIEMPRE a JPEG en el cliente antes de subir - nunca se
--    sube el archivo original ni HEIC). Límite de 20MB sin cambios: no
--    hay razón técnica para subirlo, una foto normalizada a JPEG entra
--    cómoda en ese límite. Los PDFs existentes no se ven afectados.
-- ---------------------------------------------------------------------------

update storage.buckets
   set allowed_mime_types = array['application/pdf', 'image/jpeg']
 where id = 'patient-documents';

-- ---------------------------------------------------------------------------
-- 2) RLS metadata (cardiolink_patient_documents): Secretaría no debe
--    poder listar/insertar filas con document_type = 'Imagen clínica'.
--    Sigue pudiendo listar/insertar cualquier otro tipo de documento,
--    sin cambios (6D/6D.1/6D.2 intactos). update/delete no se tocan:
--    Secretaría ya no tenía esos permisos para ningún document_type.
-- ---------------------------------------------------------------------------

create policy cardiolink_patient_documents_select_no_img_secretaria
on public.cardiolink_patient_documents
as restrictive
for select to authenticated
using (
  document_type <> 'Imagen clínica'
  or public.cardiolink_can_delete_clinical_documents()
);

create policy cardiolink_patient_documents_insert_no_img_secretaria
on public.cardiolink_patient_documents
as restrictive
for insert to authenticated
with check (
  document_type <> 'Imagen clínica'
  or public.cardiolink_can_delete_clinical_documents()
);

-- ---------------------------------------------------------------------------
-- 3) RLS storage.objects: mismo criterio sobre el ARCHIVO, no sólo la
--    metadata (storage.objects no tiene document_type, se usa el prefijo
--    de path clinical-images/ que sólo usan las imágenes clínicas - ver
--    punto 9 de la tarea, las imágenes NUNCA usan otro prefijo).
--    PDFs/documentos existentes (cualquier otro path) siguen exactamente
--    con el mismo acceso que ya tenían.
-- ---------------------------------------------------------------------------

create policy cardiolink_clinical_images_storage_select_no_secretaria
on storage.objects
as restrictive
for select to authenticated
using (
  bucket_id <> 'patient-documents'
  or name not like 'clinical-images/%'
  or public.cardiolink_can_delete_clinical_documents()
);

create policy cardiolink_clinical_images_storage_insert_no_secretaria
on storage.objects
as restrictive
for insert to authenticated
with check (
  bucket_id <> 'patient-documents'
  or name not like 'clinical-images/%'
  or public.cardiolink_can_delete_clinical_documents()
);

commit;
