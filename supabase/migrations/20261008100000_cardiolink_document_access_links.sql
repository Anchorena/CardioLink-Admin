-- CardioLink Admin - Ajuste WhatsApp 6E.1: enlace corto propio
--
-- Auditoría previa (ver informe): no existía infraestructura reutilizable
-- para esto. token-cancelacion.js (_shared) es un token HMAC sin estado,
-- de un solo propósito (cancelación de turnos) y sin revocación - no
-- encaja acá (el enlace de WhatsApp necesita poder expirar/revocarse
-- consultando una fila real). Se crea la tabla mínima sugerida.
--
-- Esta tabla NUNCA guarda un signed URL de Storage ni el token en texto
-- plano: sólo su hash (SHA-256 hex). El signed URL real se genera recién
-- al abrir el enlace (Edge Function patient-document-open), con una
-- vigencia mucho menor a los 7 días de este enlace corto.
--
-- Ningún rol de cliente (anon/authenticated) tiene ningún privilegio
-- sobre esta tabla: sólo las Edge Functions patient-document-delivery
-- (crea filas) y patient-document-open (las lee), ambas con service_role.
-- No hay ninguna pantalla que deba listar estos enlaces.

begin;

create table public.cardiolink_document_access_links (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  document_id uuid not null
    references public.cardiolink_patient_documents (id)
    on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  created_by uuid null,
  channel text not null,
  revoked_at timestamptz null,

  constraint cardiolink_document_access_links_channel_ck
    check (channel in ('whatsapp', 'email')),
  constraint cardiolink_document_access_links_expires_ck
    check (expires_at > created_at)
);

comment on table public.cardiolink_document_access_links is
  'Ajuste WhatsApp (posterior a 6E.1) - enlaces cortos y temporales, '
  'controlados por CardioLink, hacia un documento de '
  'cardiolink_patient_documents. token_hash es el hash (nunca el token en '
  'texto plano) del token opaco que viaja en la URL corta. El signed URL '
  'real de Supabase Storage se genera recién al abrir el enlace '
  '(patient-document-open), con una vigencia mucho menor a los 7 días de '
  'este enlace corto.';
comment on column public.cardiolink_document_access_links.token_hash is
  'SHA-256 (hex) del token opaco. Nunca se guarda el token en texto plano.';
comment on column public.cardiolink_document_access_links.channel is
  'Canal para el que se generó este enlace (whatsapp/email) - informativo, '
  'no cambia cómo se valida el token.';
comment on column public.cardiolink_document_access_links.revoked_at is
  'NULL = vigente (sujeto también a expires_at). No NULL = revocado '
  'manualmente antes de su vencimiento natural.';

create index idx_cardiolink_document_access_links_document
  on public.cardiolink_document_access_links (document_id);
create index idx_cardiolink_document_access_links_expires
  on public.cardiolink_document_access_links (expires_at);

alter table public.cardiolink_document_access_links enable row level security;
revoke all privileges on table public.cardiolink_document_access_links
  from public, anon, authenticated;
-- Deliberadamente sin ninguna policy: con RLS activa y cero grants a
-- anon/authenticated, ningún cliente (ni siquiera autenticado) puede
-- seleccionar/insertar/actualizar nada acá bajo ninguna circunstancia.
-- Sólo service_role (que ignora RLS) puede, exclusivamente desde las dos
-- Edge Functions de este bloque.

commit;
