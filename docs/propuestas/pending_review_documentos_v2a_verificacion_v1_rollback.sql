-- CardioLink · Documentos V2A / F0 — ROLLBACK de pending_review_documentos_v2a_verificacion_v1.sql. NO EJECUTAR sin autorización explícita.
-- Quita sólo lo que creó la migración. NO toca cardiolink_patient_documents ni Storage (los PDFs y filas archivadas quedan intactos; sus QR dejarán de verificar).
-- Protección: si ya hay verificaciones EMITIDAS, aborta salvo que se confirme explícitamente (antes exportar ambas tablas con los checks):
--   select set_config('cardiolink.rollback_v2a_force', 'si', true);   -- en la MISMA transacción, antes de este script
begin;
do $$
begin
  if to_regclass('public.cardiolink_document_verifications') is not null
     and exists (select 1 from public.cardiolink_document_verifications where issued_at is not null)
     and coalesce(current_setting('cardiolink.rollback_v2a_force', true), '') <> 'si' then
    raise exception 'Hay verificaciones emitidas: exportarlas y confirmar con cardiolink.rollback_v2a_force = si';
  end if;
end $$;
drop function if exists public.cardiolink_verificacion_pin_intento_v1(text, text, text);
drop function if exists public.cardiolink_verificacion_pin_set_v1(uuid, text, timestamptz);
drop function if exists public.cardiolink_verificacion_consultar_v1(text, text, text);
drop function if exists public.cardiolink_verificacion_anular_v1(uuid, text);
drop function if exists public.cardiolink_verificacion_vincular_v1(uuid, uuid, text);
drop function if exists public.cardiolink_verificacion_reservar_v1(text, text, text);
drop function if exists public.cardiolink_es_profesional_propio_v1(text);
drop table if exists public.cardiolink_document_verification_events;
drop table if exists public.cardiolink_document_verifications;
drop sequence if exists public.cardiolink_doc_verif_issue_seq;
drop function if exists public.cardiolink_doc_verif_events_guard_v1();
drop function if exists public.cardiolink_doc_verif_guard_v1();
commit;
