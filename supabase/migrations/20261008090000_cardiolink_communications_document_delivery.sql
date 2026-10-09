-- CardioLink Admin - Envío digital de documentos/estudios ya almacenados
-- (Fase 6 / Bloque 6E.1)
--
-- Auditoría previa (ver informe 6E.1): cardiolink_communications YA
-- representa correctamente este evento (mismas columnas: paciente_id,
-- document_id -sin FK, agregada por 20260904120000_...-, canal,
-- destinatario, recipient_source/name, subject/message, status,
-- provider*, created_by). Sólo falta UN valor en el CHECK de `tipo`: los
-- valores existentes ('document' incluido) significan específicamente
-- "aviso automático al profesional de que Secretaría generó un
-- certificado/orden en su nombre" - un evento distinto de "se envió al
-- paciente/responsable un documento/estudio YA ALMACENADO". Mismo patrón
-- aditivo ya usado dos veces antes (20260829090000 agregó 'assignment',
-- 20260904120000 agregó 'document') - no se toca ninguna fila ni
-- constraint existente más allá de ampliar este único CHECK.
--
-- El aviso al profesional de ESTE nuevo flujo (Bloque 6E.1, punto 9 de la
-- tarea) reutiliza el tipo 'document' ya existente sin cambios (sigue
-- siendo "aviso administrativo al profesional sobre algo relacionado a un
-- documento"), distinguible de la generación de certificados/órdenes por
-- el propio texto de message/subject. Sólo el envío al PACIENTE necesita
-- un valor nuevo.

begin;

alter table public.cardiolink_communications
  drop constraint cardiolink_communications_tipo_ck;
alter table public.cardiolink_communications
  add constraint cardiolink_communications_tipo_ck
  check (tipo in ('confirmation', 'reminder', 'reschedule', 'cancellation', 'manual', 'assignment', 'document', 'document_delivery'));

comment on column public.cardiolink_communications.tipo is
  'confirmation/reminder/reschedule/cancellation/manual: comunicacion al '
  'paciente (o su contacto responsable) sobre un turno. assignment: aviso '
  'automatico al profesional de que se le asigno un turno nuevo. '
  'document: aviso automatico al profesional de que Secretaria genero en '
  'su nombre un certificado u orden medica. document_delivery (Bloque '
  '6E.1): envio/preparacion de envio al paciente o su contacto '
  'responsable de un documento/estudio/imagen clinica YA ALMACENADO en '
  'cardiolink_patient_documents (ver columna document_id).';

commit;
