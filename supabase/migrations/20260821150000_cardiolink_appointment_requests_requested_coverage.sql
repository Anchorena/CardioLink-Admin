-- CardioLink Admin - Portal Publico V1 / Ajuste
-- Agrega la cobertura declarada para una solicitud de turno puntual,
-- separada de cardiolink_pacientes.cobertura_habitual.
--
-- PROPUESTA, NO EJECUTADA TODAVIA. No se corrio contra Staging ni
-- Produccion. Requiere aprobacion explicita antes de aplicarse.
--
-- Motivo: el portal publico y la bandeja interna necesitan poder guardar
-- "cobertura para esta solicitud/atencion" (puede diferir de la cobertura
-- habitual ya guardada en la ficha del paciente, o el paciente puede no
-- saberla todavia: "No se / consultar"). Nunca debe sobrescribir
-- automaticamente cardiolink_pacientes.cobertura_habitual; esta migracion
-- no toca esa tabla ni esa columna.

begin;

alter table public.cardiolink_appointment_requests
  add column requested_coverage text null;

comment on column public.cardiolink_appointment_requests.requested_coverage is
  'Cobertura declarada para esta solicitud puntual (select cerrado en el '
  'portal/bandeja, catalogo compartido con COBERTURAS_VALIDAS de '
  'supabase/functions/portal-gateway/logica.js). No es la cobertura '
  'habitual del paciente (cardiolink_pacientes.cobertura_habitual) ni la '
  'sobrescribe. Nullable: las solicitudes creadas antes de este cambio no '
  'la tienen, y no corresponde inventarla retroactivamente.';

-- Sin CHECK de enum a proposito, igual que requested_service: el catalogo
-- de coberturas puede crecer sin requerir otra migracion. La lista cerrada
-- se valida en la capa de aplicacion (Edge Function/bandeja), no en el
-- constraint. Solo se exige que, si viene, no sea una cadena vacia.
alter table public.cardiolink_appointment_requests
  add constraint cardiolink_appointment_requests_requested_coverage_ck
  check (requested_coverage is null or btrim(requested_coverage) <> '');

commit;
