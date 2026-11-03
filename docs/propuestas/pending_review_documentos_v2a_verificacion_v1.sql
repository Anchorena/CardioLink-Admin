-- CardioLink · Documentos V2A / F0 — Registro de verificación (QR) por versión archivada + eventos
-- BORRADOR PARA REVISIÓN. NO EJECUTAR sin autorización explícita. Primero STAGING (yslhwdlzdknhskawqrtv); Production sólo con autorización aparte.
-- No está en supabase/migrations a propósito: `supabase db push` no debe poder aplicarla por accidente.
--
-- Qué agrega (y nada más):
--   1) cardiolink_document_verifications: UNA fila por versión archivada con QR. Registro append-only: el código del QR sólo vive en el PDF (acá, su SHA-256).
--   2) cardiolink_document_verification_events: bitácora append-only de emisión, consultas, PIN y anulación (IP sólo hasheada).
--   3) RPC para el cliente autenticado: reservar / vincular / anular (propiedad por profesional: ver cardiolink_es_profesional_propio_v1). RPC sólo service_role (Edge Function): consultar / pin_set / pin_intento.
--
-- NO modifica: cardiolink_patient_documents (ni sus filas, policies, grants o triggers), Storage, Edge Functions, ni documentos históricos
-- (los ya archivados no tienen fila de verificación ni QR y quedan intactos). Sin recetas: document_kind sólo certificado/constancia/orden.
--
-- Secuencia (la define el cliente; ver docs de F0):  código aleatorio (128 bits) -> reservar(code_hash) -> PDF con QR -> sha256 del PDF final ->
--   Storage + fila en cardiolink_patient_documents (flujo V1, sin cambios; source_content_hash NO incluye el QR) -> vincular(id, document_id, pdf_sha256).
--   Reservas sin vincular son inertes (la verificación pública responde "no disponible"). Reemplazo = nueva versión (derivado); anulación = marca en ESTA tabla.
--
-- Dependencias (se comprueban abajo): cardiolink_patient_documents + source_payload + trigger de inmutabilidad (Bloque A), funciones
-- cardiolink_has_clinical_documents_access() / cardiolink_can_delete_clinical_documents(), tabla cardiolink_user_roles.
-- Dry-run: reemplazar el COMMIT final por ROLLBACK. Rollback: ..._rollback.sql. Checks de sólo lectura: ..._checks.sql. QA transaccional: ..._tests.sql.

begin;

-- 0) Precondiciones: aborta si el esquema no es el esperado o si esto ya se aplicó.
do $$
begin
  if to_regclass('public.cardiolink_patient_documents') is null then raise exception 'Falta public.cardiolink_patient_documents'; end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='cardiolink_patient_documents' and column_name='source_payload') then
    raise exception 'Falta source_payload: aplicar antes pending_review_patient_documents_source_payload_v1.sql'; end if;
  if not exists (select 1 from pg_trigger where tgrelid='public.cardiolink_patient_documents'::regclass and tgname='cardiolink_patient_documents_guard_version' and not tgisinternal and tgenabled='O') then
    raise exception 'Falta el trigger de inmutabilidad cardiolink_patient_documents_guard_version'; end if;
  if to_regprocedure('public.cardiolink_has_clinical_documents_access()') is null or to_regprocedure('public.cardiolink_can_delete_clinical_documents()') is null then
    raise exception 'Faltan las funciones de acceso a documentos clínicos'; end if;
  if to_regclass('public.cardiolink_user_roles') is null then raise exception 'Falta public.cardiolink_user_roles'; end if;
  if to_regclass('public.cardiolink_document_verifications') is not null or to_regclass('public.cardiolink_document_verification_events') is not null then
    raise exception 'Las tablas de verificación ya existen: no se repite'; end if;
end $$;

-- 1) Registro de verificación (una fila por versión archivada)
-- Orden de emisión: secuencia monótona (no depende de la resolución del reloj ni de la transacción).
create sequence public.cardiolink_doc_verif_issue_seq;
create table public.cardiolink_document_verifications (
  id                 uuid primary key default gen_random_uuid(),
  code_hash          text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),     -- SHA-256 hex del código del QR; nunca el código
  chain_id           text not null check (char_length(chain_id) between 1 and 200),  -- source_document_id: une todas las versiones de un mismo documento
  document_kind      text not null check (document_kind in ('certificado','constancia','orden')),
  document_id        uuid null references public.cardiolink_patient_documents (id) on delete set null,  -- NULL = reservado o documento eliminado
  pdf_sha256         text null check (pdf_sha256 ~ '^[0-9a-f]{64}$'),                -- huella del PDF FINAL (con QR)
  professional_id    text null,                                                      -- se toma del documento archivado (servidor), no del cliente
  issued_by          uuid not null,
  reserved_at        timestamptz not null default now(),
  issued_at          timestamptz null,
  issue_seq          bigint null unique,                                            -- orden de emisión dentro de la cadena (reemplazo derivado)
  annulled_at        timestamptz null,
  annulled_by        uuid null,
  annulment_reason   text null check (annulment_reason is null or char_length(annulment_reason) between 3 and 300),
  signature_status   text not null default 'sin_firma_digital' check (signature_status in ('sin_firma_digital','firmado_pades','firmado_externo')),
  signature_provider text null,
  pin_hash           text null check (pin_hash is null or pin_hash ~ '^[0-9a-f]{64}$'),
  pin_expires_at     timestamptz null,
  pin_failed_attempts integer not null default 0,
  pin_locked_until   timestamptz null,
  constraint cardiolink_doc_verif_bound_ck  check (document_id is null or (issued_at is not null and pdf_sha256 is not null and issue_seq is not null)),
  constraint cardiolink_doc_verif_annul_ck  check ((annulled_at is null) = (annulled_by is null) and (annulled_at is null) = (annulment_reason is null))
);
comment on table public.cardiolink_document_verifications is
  'Documentos V2A. Registro append-only de verificación (QR) por versión archivada. El código del QR no se guarda (sólo code_hash). Estado vigente/reemplazado/anulado: ver cardiolink_verificacion_consultar_v1.';
create index idx_cardiolink_doc_verif_chain on public.cardiolink_document_verifications (chain_id, issued_at);
create index idx_cardiolink_doc_verif_document on public.cardiolink_document_verifications (document_id);

-- 2) Bitácora de eventos (append-only)
create table public.cardiolink_document_verification_events (
  id              bigint generated always as identity primary key,
  verification_id uuid null references public.cardiolink_document_verifications (id),
  event_type      text not null check (event_type in ('reservada','emitida','consulta','pin_generado','pin_ok','pin_fallido','pin_bloqueado','anulada')),
  outcome         text null check (outcome is null or char_length(outcome) <= 40),
  actor           uuid null,
  ip_hash         text null check (ip_hash is null or char_length(ip_hash) <= 64),
  ua_class        text null check (ua_class is null or char_length(ua_class) <= 40),
  created_at      timestamptz not null default now()
);
comment on table public.cardiolink_document_verification_events is
  'Documentos V2A. Bitácora append-only. verification_id NULL = código inexistente. Sin IP en claro, sin datos del paciente.';
create index idx_cardiolink_doc_verif_events_v on public.cardiolink_document_verification_events (verification_id, created_at);

-- 3) Inmutabilidad
create function public.cardiolink_doc_verif_guard_v1() returns trigger language plpgsql set search_path = pg_catalog, public as $f$
begin
  if tg_op = 'DELETE' then raise exception 'El registro de verificación no se elimina' using errcode = 'P0001'; end if;
  if new.id is distinct from old.id or new.code_hash is distinct from old.code_hash or new.chain_id is distinct from old.chain_id
     or new.document_kind is distinct from old.document_kind or new.issued_by is distinct from old.issued_by or new.reserved_at is distinct from old.reserved_at then
    raise exception 'Identidad de la verificación inmutable' using errcode = 'P0001'; end if;
  -- emisión: una sola vez (reservado -> emitido); después sólo document_id puede pasar a NULL (documento eliminado)
  if old.issued_at is null then
    if (new.document_id is null) <> (new.issued_at is null) or (new.document_id is null) <> (new.pdf_sha256 is null) or (new.document_id is null) <> (new.issue_seq is null) then
      raise exception 'La emisión requiere document_id, issued_at, issue_seq y pdf_sha256 juntos' using errcode = 'P0001'; end if;
  else
    if new.issued_at is distinct from old.issued_at or new.issue_seq is distinct from old.issue_seq or new.pdf_sha256 is distinct from old.pdf_sha256 or new.professional_id is distinct from old.professional_id then
      raise exception 'La versión emitida es inmutable' using errcode = 'P0001'; end if;
    if new.document_id is not null and new.document_id is distinct from old.document_id then
      raise exception 'El documento vinculado no se reasigna' using errcode = 'P0001'; end if;
  end if;
  -- anulación: una sola vez
  if old.annulled_at is not null and (new.annulled_at is distinct from old.annulled_at or new.annulled_by is distinct from old.annulled_by or new.annulment_reason is distinct from old.annulment_reason) then
    raise exception 'La anulación es definitiva' using errcode = 'P0001'; end if;
  return new;
end $f$;
revoke all privileges on function public.cardiolink_doc_verif_guard_v1() from public, anon, authenticated;
create trigger cardiolink_doc_verif_guard before update or delete on public.cardiolink_document_verifications
  for each row execute function public.cardiolink_doc_verif_guard_v1();

create function public.cardiolink_doc_verif_events_guard_v1() returns trigger language plpgsql set search_path = pg_catalog, public as $f$
begin raise exception 'La bitácora de verificación es append-only' using errcode = 'P0001'; end $f$;
revoke all privileges on function public.cardiolink_doc_verif_events_guard_v1() from public, anon, authenticated;
create trigger cardiolink_doc_verif_events_guard before update or delete on public.cardiolink_document_verification_events
  for each row execute function public.cardiolink_doc_verif_events_guard_v1();

-- 4) RLS y grants: ninguna tabla es accesible desde el cliente (sólo service_role / funciones SECURITY DEFINER)
alter table public.cardiolink_document_verifications enable row level security;
alter table public.cardiolink_document_verification_events enable row level security;
revoke all privileges on table public.cardiolink_document_verifications from public, anon, authenticated;
revoke all privileges on table public.cardiolink_document_verification_events from public, anon, authenticated;
revoke all privileges on sequence public.cardiolink_doc_verif_issue_seq from public, anon, authenticated;
revoke all privileges on sequence public.cardiolink_document_verification_events_id_seq from public, anon, authenticated;

-- Helper (SECURITY DEFINER, no ejecutable por el cliente): ¿el professional_id dado es el del médico que llama (cardiolink_user_roles)? Sin mayúsculas ni espacios.
create function public.cardiolink_es_profesional_propio_v1(p_professional_id text) returns boolean
language sql stable security definer set search_path = pg_catalog, public as $f$
  select p_professional_id is not null and nullif(btrim(p_professional_id), '') is not null and exists (
    select 1 from public.cardiolink_user_roles r
     where r.user_id = auth.uid() and r.active and r.base_role = 'medico' and nullif(btrim(r.professional_id), '') is not null
       and lower(btrim(r.professional_id)) = lower(btrim(p_professional_id)))
$f$;
revoke all privileges on function public.cardiolink_es_profesional_propio_v1(text) from public, anon, authenticated;

-- 5) RPC del cliente autenticado (médico/owner/admin/secretaría que ya pueden archivar documentos)
create function public.cardiolink_verificacion_reservar_v1(p_chain_id text, p_kind text, p_code_hash text) returns uuid
language plpgsql security definer set search_path = pg_catalog, public as $f$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'Sesión requerida' using errcode = '42501'; end if;
  if not public.cardiolink_has_clinical_documents_access() then raise exception 'Sin permiso' using errcode = '42501'; end if;
  if p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' then raise exception 'code_hash inválido' using errcode = '22023'; end if;
  insert into public.cardiolink_document_verifications (code_hash, chain_id, document_kind, issued_by)
  values (p_code_hash, p_chain_id, p_kind, auth.uid()) returning id into v_id;
  insert into public.cardiolink_document_verification_events (verification_id, event_type, outcome, actor) values (v_id, 'reservada', 'ok', auth.uid());
  return v_id;
end $f$;

create function public.cardiolink_verificacion_vincular_v1(p_id uuid, p_document_id uuid, p_pdf_sha256 text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $f$
declare v public.cardiolink_document_verifications%rowtype; d public.cardiolink_patient_documents%rowtype; v_tipo text; v_global boolean; v_medico boolean;
begin
  if auth.uid() is null then raise exception 'Sesión requerida' using errcode = '42501'; end if;
  if not public.cardiolink_has_clinical_documents_access() then raise exception 'Sin permiso' using errcode = '42501'; end if;
  if p_pdf_sha256 is null or p_pdf_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'pdf_sha256 inválido' using errcode = '22023'; end if;
  select * into v from public.cardiolink_document_verifications where id = p_id for update;
  if not found or v.issued_by <> auth.uid() then raise exception 'Reserva inexistente' using errcode = '42501'; end if;
  if v.document_id is not null then   -- idempotente: mismo documento y misma huella
    if v.document_id = p_document_id and v.pdf_sha256 = p_pdf_sha256 then return jsonb_build_object('ok', true, 'idempotente', true); end if;
    raise exception 'La reserva ya está emitida con otro documento' using errcode = 'P0001';
  end if;
  if v.issued_at is not null then raise exception 'El documento de esta verificación ya no existe' using errcode = 'P0001'; end if;
  select * into d from public.cardiolink_patient_documents where id = p_document_id;
  if not found or d.uploaded_by is distinct from auth.uid() or d.source_document_id is distinct from v.chain_id or d.source_payload is null then
    raise exception 'El documento no corresponde a esta reserva' using errcode = '42501'; end if;
  v_tipo := case d.document_type when 'Certificado' then 'certificado' when 'Constancia' then 'constancia' when 'Orden' then 'orden' else null end;
  if v_tipo is distinct from v.document_kind then raise exception 'Tipo de documento incompatible' using errcode = '22023'; end if;
  -- Un MÉDICO sólo emite versiones de SU profesional (professional_id del documento = el suyo, comparado sin mayúsculas/espacios). Owner/admin y Secretaría
  -- (que ya emiten certificados en nombre de un profesional) vinculan documentos que ellos mismos archivaron (uploaded_by, ya comprobado arriba).
  select exists (select 1 from public.cardiolink_user_roles r where r.user_id = auth.uid() and r.active and r.base_role in ('owner','admin')) into v_global;
  v_medico := not v_global and exists (select 1 from public.cardiolink_user_roles r where r.user_id = auth.uid() and r.active and r.base_role = 'medico');
  if v_medico and not public.cardiolink_es_profesional_propio_v1(d.professional_id) then
    raise exception 'El documento no pertenece a tu profesional' using errcode = '42501'; end if;
  -- La cadena de versiones no puede cruzar profesionales: nadie reemplaza ni suplanta la verificación de un certificado de otro profesional.
  if exists (select 1 from public.cardiolink_document_verifications o where o.chain_id = v.chain_id and o.id <> v.id and o.issued_at is not null
             and lower(btrim(coalesce(o.professional_id, ''))) is distinct from lower(btrim(coalesce(d.professional_id, '')))) then
    raise exception 'La cadena de versiones pertenece a otro profesional' using errcode = '42501'; end if;
  update public.cardiolink_document_verifications
     set document_id = d.id, pdf_sha256 = p_pdf_sha256, issued_at = now(), issue_seq = nextval('public.cardiolink_doc_verif_issue_seq'), professional_id = d.professional_id
   where id = v.id;
  insert into public.cardiolink_document_verification_events (verification_id, event_type, outcome, actor) values (v.id, 'emitida', 'ok', auth.uid());
  return jsonb_build_object('ok', true, 'idempotente', false);
end $f$;

create function public.cardiolink_verificacion_anular_v1(p_id uuid, p_motivo text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $f$
declare v public.cardiolink_document_verifications%rowtype; v_global boolean;
begin
  if auth.uid() is null then raise exception 'Sesión requerida' using errcode = '42501'; end if;
  if not public.cardiolink_can_delete_clinical_documents() then raise exception 'Sin permiso' using errcode = '42501'; end if;
  if p_motivo is null or char_length(btrim(p_motivo)) < 3 or char_length(p_motivo) > 300 then raise exception 'Motivo inválido' using errcode = '22023'; end if;
  select * into v from public.cardiolink_document_verifications where id = p_id for update;
  if not found then raise exception 'Verificación inexistente' using errcode = '42501'; end if;
  select exists (select 1 from public.cardiolink_user_roles r where r.user_id = auth.uid() and r.active and r.base_role in ('owner','admin')) into v_global;
  -- Owner/admin: cualquiera. Médico: sólo certificados de SU profesional (aunque los haya emitido Secretaría en su nombre); si el registro aún no tiene
  -- profesional (reserva sin emitir), sólo quien la reservó. Mismo criterio que la eliminación de documentos por emisor.
  if not v_global and not ((v.professional_id is not null and public.cardiolink_es_profesional_propio_v1(v.professional_id))
                           or (v.professional_id is null and v.issued_by = auth.uid())) then
    raise exception 'Sólo el profesional emisor, owner o admin pueden anular' using errcode = '42501'; end if;
  if v.annulled_at is not null then return jsonb_build_object('ok', true, 'idempotente', true); end if;
  update public.cardiolink_document_verifications
     set annulled_at = now(), annulled_by = auth.uid(), annulment_reason = btrim(p_motivo), pin_expires_at = now()   -- la anulación invalida el PIN
   where id = v.id;
  insert into public.cardiolink_document_verification_events (verification_id, event_type, outcome, actor) values (v.id, 'anulada', 'ok', auth.uid());
  return jsonb_build_object('ok', true, 'idempotente', false);
end $f$;

revoke all privileges on function public.cardiolink_verificacion_reservar_v1(text, text, text) from public, anon, authenticated;
revoke all privileges on function public.cardiolink_verificacion_vincular_v1(uuid, uuid, text) from public, anon, authenticated;
revoke all privileges on function public.cardiolink_verificacion_anular_v1(uuid, text) from public, anon, authenticated;
grant execute on function public.cardiolink_verificacion_reservar_v1(text, text, text) to authenticated;
grant execute on function public.cardiolink_verificacion_vincular_v1(uuid, uuid, text) to authenticated;
grant execute on function public.cardiolink_verificacion_anular_v1(uuid, text) to authenticated;

-- 6) RPC de servidor (Edge Function con service_role): consulta pública mínima, PIN temporal con bloqueo
-- Estado derivado: anulado > no_disponible (reservado o documento eliminado) > reemplazado (hay una versión emitida posterior de la misma cadena) > vigente.
create function public.cardiolink_verificacion_consultar_v1(p_code_hash text, p_ip_hash text default null, p_ua_class text default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $f$
declare v public.cardiolink_document_verifications%rowtype; v_estado text;
begin
  select * into v from public.cardiolink_document_verifications where code_hash = p_code_hash;
  if not found then
    insert into public.cardiolink_document_verification_events (event_type, outcome, ip_hash, ua_class) values ('consulta', 'no_encontrado', p_ip_hash, p_ua_class);
    return jsonb_build_object('encontrado', false);
  end if;
  v_estado := case
    when v.annulled_at is not null then 'anulado'
    when v.document_id is null then 'no_disponible'
    when exists (select 1 from public.cardiolink_document_verifications n where n.chain_id = v.chain_id and n.id <> v.id and n.issue_seq is not null and n.issue_seq > v.issue_seq
                  and lower(btrim(coalesce(n.professional_id, ''))) = lower(btrim(coalesce(v.professional_id, '')))) then 'reemplazado'
    else 'vigente' end;
  insert into public.cardiolink_document_verification_events (verification_id, event_type, outcome, ip_hash, ua_class) values (v.id, 'consulta', v_estado, p_ip_hash, p_ua_class);
  -- SOLO datos mínimos: nada del paciente ni del contenido
  return jsonb_build_object('encontrado', true, 'estado', v_estado, 'tipo', v.document_kind, 'emitido', (v.issued_at at time zone 'America/Argentina/Buenos_Aires')::date,
    'professional_id', v.professional_id, 'huella', left(v.pdf_sha256, 12), 'firma', v.signature_status, 'con_pin', coalesce(v.pin_hash is not null and v.pin_expires_at > now(), false));
end $f$;

create function public.cardiolink_verificacion_pin_set_v1(p_verification_id uuid, p_pin_hash text, p_expires_at timestamptz) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $f$
declare v public.cardiolink_document_verifications%rowtype;
begin
  if p_pin_hash is null or p_pin_hash !~ '^[0-9a-f]{64}$' or p_expires_at is null or p_expires_at <= now() or p_expires_at > now() + interval '7 days' then
    raise exception 'PIN o vencimiento inválido' using errcode = '22023'; end if;
  select * into v from public.cardiolink_document_verifications where id = p_verification_id for update;
  if not found or v.annulled_at is not null or v.document_id is null then return jsonb_build_object('ok', false, 'motivo', 'no_disponible'); end if;
  update public.cardiolink_document_verifications set pin_hash = p_pin_hash, pin_expires_at = p_expires_at, pin_failed_attempts = 0, pin_locked_until = null where id = v.id;
  insert into public.cardiolink_document_verification_events (verification_id, event_type, outcome) values (v.id, 'pin_generado', 'ok');
  return jsonb_build_object('ok', true);
end $f$;

create function public.cardiolink_verificacion_pin_intento_v1(p_code_hash text, p_pin_hash text, p_ip_hash text default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $f$
declare v public.cardiolink_document_verifications%rowtype; v_fallos integer;
begin
  select * into v from public.cardiolink_document_verifications where code_hash = p_code_hash for update;
  if not found or v.annulled_at is not null or v.document_id is null then
    insert into public.cardiolink_document_verification_events (verification_id, event_type, outcome, ip_hash) values (v.id, 'pin_fallido', 'no_disponible', p_ip_hash);
    return jsonb_build_object('resultado', 'no_disponible');
  end if;
  if v.pin_locked_until is not null and v.pin_locked_until > now() then
    insert into public.cardiolink_document_verification_events (verification_id, event_type, outcome, ip_hash) values (v.id, 'pin_bloqueado', 'bloqueado', p_ip_hash);
    return jsonb_build_object('resultado', 'bloqueado');
  end if;
  if v.pin_hash is null or v.pin_expires_at is null or v.pin_expires_at <= now() then
    insert into public.cardiolink_document_verification_events (verification_id, event_type, outcome, ip_hash) values (v.id, 'pin_fallido', 'expirado', p_ip_hash);
    return jsonb_build_object('resultado', 'pin_expirado');
  end if;
  if p_pin_hash is not null and p_pin_hash = v.pin_hash then
    update public.cardiolink_document_verifications set pin_failed_attempts = 0, pin_locked_until = null where id = v.id;
    insert into public.cardiolink_document_verification_events (verification_id, event_type, outcome, ip_hash) values (v.id, 'pin_ok', 'ok', p_ip_hash);
    return jsonb_build_object('resultado', 'ok', 'document_id', v.document_id);
  end if;
  v_fallos := v.pin_failed_attempts + 1;
  if v_fallos >= 5 then
    update public.cardiolink_document_verifications set pin_failed_attempts = 0, pin_locked_until = now() + interval '15 minutes' where id = v.id;
    insert into public.cardiolink_document_verification_events (verification_id, event_type, outcome, ip_hash) values (v.id, 'pin_bloqueado', 'bloqueado', p_ip_hash);
    return jsonb_build_object('resultado', 'bloqueado');
  end if;
  update public.cardiolink_document_verifications set pin_failed_attempts = v_fallos where id = v.id;
  insert into public.cardiolink_document_verification_events (verification_id, event_type, outcome, ip_hash) values (v.id, 'pin_fallido', 'invalido', p_ip_hash);
  return jsonb_build_object('resultado', 'pin_invalido');
end $f$;

revoke all privileges on function public.cardiolink_verificacion_consultar_v1(text, text, text) from public, anon, authenticated;
revoke all privileges on function public.cardiolink_verificacion_pin_set_v1(uuid, text, timestamptz) from public, anon, authenticated;
revoke all privileges on function public.cardiolink_verificacion_pin_intento_v1(text, text, text) from public, anon, authenticated;
grant execute on function public.cardiolink_verificacion_consultar_v1(text, text, text) to service_role;
grant execute on function public.cardiolink_verificacion_pin_set_v1(uuid, text, timestamptz) to service_role;
grant execute on function public.cardiolink_verificacion_pin_intento_v1(text, text, text) to service_role;

-- 7) Verificación posterior (aborta y revierte si algo no quedó como se espera)
do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.cardiolink_document_verifications'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'public.cardiolink_document_verification_events'::regclass) then raise exception 'RLS no habilitada'; end if;
  if has_table_privilege('anon', 'public.cardiolink_document_verifications', 'select') or has_table_privilege('authenticated', 'public.cardiolink_document_verifications', 'select')
     or has_table_privilege('authenticated', 'public.cardiolink_document_verification_events', 'insert') then raise exception 'Hay privilegios de tabla para anon/authenticated'; end if;
  if has_function_privilege('authenticated', 'public.cardiolink_verificacion_consultar_v1(text,text,text)', 'execute')
     or has_function_privilege('anon', 'public.cardiolink_verificacion_pin_intento_v1(text,text,text)', 'execute') then raise exception 'Las RPC de servidor son ejecutables por el cliente'; end if;
  if has_sequence_privilege('authenticated', 'public.cardiolink_doc_verif_issue_seq', 'usage') or has_sequence_privilege('anon', 'public.cardiolink_document_verification_events_id_seq', 'usage') then raise exception 'Las secuencias son usables por el cliente'; end if;
  if (select count(*) from pg_trigger where tgrelid in ('public.cardiolink_document_verifications'::regclass, 'public.cardiolink_document_verification_events'::regclass) and not tgisinternal) <> 2 then
    raise exception 'Faltan los triggers de inmutabilidad'; end if;
end $$;

commit;
