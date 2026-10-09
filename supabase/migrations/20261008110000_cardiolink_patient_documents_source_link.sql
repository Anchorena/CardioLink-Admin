-- CardioLink Admin - Documentos generados: Imprimir / Guardar PDF / Enviar
-- (Fase 6 / Bloque 6E.2)
--
-- Justificación (auditoría previa, punto 25 de la tarea): cada documento
-- generado (data.documentosClinicos, Orden/Certificado/Constancia) tiene
-- un id ESTABLE del lado cliente ('doc_...') y PUEDE editarse después de
-- creado (openDocumentModal406 modifica el mismo objeto in-place). Sin un
-- vínculo persistido entre ese id y el PDF ya archivado en
-- cardiolink_patient_documents, "Guardar PDF"/"Enviar"/"Descargar"
-- repetidos sobre el MISMO documento generarían filas duplicadas (no se
-- puede detectar de forma segura por título/fecha solamente, tal como
-- pide expresamente la tarea). Tampoco hay forma de distinguir "mismo
-- contenido ya archivado" de "contenido editado después de archivar"
-- (necesario para no sobrescribir retroactivamente un PDF ya enviado).
--
-- Dos columnas nuevas, nullable, sin FK (mismo criterio ya usado para
-- patient_id/document_id en este bloque: data.documentosClinicos no es
-- una tabla de Supabase, no hay nada contra qué foránear):
--   source_document_id  - el id de data.documentosClinicos ('doc_...').
--   source_content_hash - hash del contenido relevante en el momento de
--     archivar (título/contenido/adicional/profesional/fecha). Si al
--     volver a tocar "Guardar PDF" el hash actual coincide con el de la
--     última fila archivada para ese source_document_id, se reutiliza esa
--     fila (mismo document_id, sin duplicar). Si difiere (el documento
--     fue editado de forma material), se archiva una fila NUEVA,
--     preservando la anterior intacta (versionado simple, sin sistema de
--     versiones complejo).
--
-- No modifica ninguna migración anterior. No agrega ninguna tabla nueva.

begin;

alter table public.cardiolink_patient_documents
  add column source_document_id text null,
  add column source_content_hash text null;

comment on column public.cardiolink_patient_documents.source_document_id is
  'Fase 6 / Bloque 6E.2. Id de data.documentosClinicos (ej. "doc_...") '
  'que originó este PDF archivado, cuando corresponde (Orden/Certificado/'
  'Constancia generados desde CardioLink). NULL para documentos subidos '
  'manualmente (6D) o imágenes clínicas (6D.3) - esos no tienen un '
  '"documento fuente" del lado cliente.';
comment on column public.cardiolink_patient_documents.source_content_hash is
  'Fase 6 / Bloque 6E.2. Hash del contenido relevante del documento '
  'fuente en el momento de archivar este PDF (título/contenido/'
  'adicional/profesional/fecha). Permite detectar si el documento fuente '
  'cambió de forma material desde el último archivado (para no reusar un '
  'PDF desactualizado ni sobrescribir uno ya enviado) sin depender sólo '
  'de título/fecha.';

create index idx_cardiolink_patient_documents_source
  on public.cardiolink_patient_documents (source_document_id);

commit;
