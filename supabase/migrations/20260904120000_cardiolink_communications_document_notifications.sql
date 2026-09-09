-- CardioLink Admin - Patient Communications V1: aviso de documento generado
--
-- REDACTADA, NO EJECUTADA TODAVIA (ni en Staging ni en Production).
--
-- cardiolink_communications YA ESTA DESPLEGADA (esquema de
-- 20260828120000_cardiolink_communications_schema.sql, ampliado luego por
-- 20260829090000_cardiolink_communications_professional_notifications.sql
-- para 'assignment'/recipient_source='professional'). Esta migracion repite
-- el mismo patron para un caso nuevo: Secretaria genera un certificado u
-- orden medica EN NOMBRE de un profesional, y ese profesional recibe un
-- aviso automatico por email (nunca el contenido del documento).
--
-- Dos cambios, ambos aditivos:
--   1) ampliar el CHECK de cardiolink_communications.tipo para aceptar
--      'document';
--   2) agregar la columna document_id (text null, sin FK). Los documentos
--      clinicos (data.documentosClinicos) no tienen atencionId propio -
--      viven en el config jsonb que sincroniza app.js, no en
--      cardiolink_atenciones - asi que un aviso de documento nunca debe
--      mezclarse semanticamente con atencion_id (esa columna sigue
--      significando exclusivamente "referencia informativa a un turno").
--      Para este tipo de aviso: atencion_id queda null y document_id lleva
--      el id real del documento, en texto libre, sin FK (mismo criterio ya
--      documentado para atencion_id: no hay tabla relacional de donde
--      validarlo).
--
-- No agrega tablas nuevas, no agrega ninguna otra columna, no modifica
-- ninguna fila existente.

begin;

alter table public.cardiolink_communications
  drop constraint cardiolink_communications_tipo_ck;
alter table public.cardiolink_communications
  add constraint cardiolink_communications_tipo_ck
  check (tipo in ('confirmation', 'reminder', 'reschedule', 'cancellation', 'manual', 'assignment', 'document'));

comment on column public.cardiolink_communications.tipo is
  'confirmation/reminder/reschedule/cancellation/manual: comunicacion al '
  'paciente (o su contacto responsable). assignment: aviso automatico al '
  'profesional de que se le asigno un turno nuevo. document: aviso '
  'automatico al profesional de que Secretaria genero en su nombre un '
  'certificado u orden medica (recipient_source=professional en ambos '
  'casos, nunca incluye el contenido del documento; ver columna '
  'document_id).';

alter table public.cardiolink_communications
  add column document_id text null;

comment on column public.cardiolink_communications.document_id is
  'Referencia informativa (sin FK) al id de un documento clinico '
  '(data.documentosClinicos, fuera de Supabase) para tipo=document '
  'unicamente. Nunca se usa para atenciones/turnos: eso sigue siendo '
  'atencion_id. Para tipo=document, atencion_id queda null.';

commit;
