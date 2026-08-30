-- CardioLink Admin - Patient Communications V1: avisos automaticos al profesional
--
-- REDACTADA, NO EJECUTADA TODAVIA.
--
-- cardiolink_communications YA ESTA DESPLEGADA EN STAGING (esquema de
-- 20260828120000_cardiolink_communications_schema.sql). Por eso esta
-- migracion es un ALTER seguro sobre lo ya aplicado, nunca una reescritura
-- de esa migracion original.
--
-- Tres cambios:
--   1) Ampliar los CHECK de cardiolink_communications para aceptar
--      tipo='assignment' (nuevo turno asignado al profesional) y
--      recipient_source='professional' (destinatario = profesional, no
--      paciente ni contacto responsable). No se toca ninguna fila
--      existente, no se relaja ninguna otra restriccion.
--   2) Columna nueva cardiolink_user_roles.professional_id: vinculo
--      EXPLICITO cuenta Auth -> profesional (data.profesionales[].id),
--      separado de cardiolink_user_key. cardiolink_user_key ya representa
--      hoy la identidad/email real usada por CardioLink en produccion
--      (verificado contra las cuentas reales de Staging: owner, secretaria
--      y medico mapeados cada uno a su propia cuenta Auth) - reutilizarlo
--      como profesionalId hubiera exigido cambiar esos valores, con riesgo real
--      de romper login/autorizacion ya en uso. professional_id es NULL por
--      defecto: no se adivina ningun mapeo, cada cuenta se vincula a mano.
--   3) Tabla nueva, minima: cardiolink_professional_notification_preferences
--      (email_enabled/email_override por professional_id), con RLS: el
--      propio profesional (via cardiolink_user_roles.professional_id) o un
--      owner/admin pueden leer/escribir su fila; secretaria no.
--
-- Bootstrap manual REQUERIDO en Staging (fuera de esta migracion, nunca
-- con el email real embebido en un archivo del repo - mismo criterio que
-- los secrets de Vault en la migracion del cron):
--
--   update public.cardiolink_user_roles
--      set professional_id = 'matias'
--    where user_id = (select id from auth.users where email = '<email real de esa cuenta Auth en Staging>');
--
-- Los demas profesionales quedan con professional_id NULL hasta que se
-- vinculen a mano de la misma forma (no se adivina ningun otro mapeo).

begin;

-- ---------------------------------------------------------------------------
-- 1) cardiolink_user_roles.professional_id - vinculo explicito, separado
--    de cardiolink_user_key.
-- ---------------------------------------------------------------------------

alter table public.cardiolink_user_roles
  add column professional_id text null;

comment on column public.cardiolink_user_roles.professional_id is
  'Vinculo explicito con data.profesionales[].id (ej. "matias"). Distinto '
  'de cardiolink_user_key, que ya representa la identidad/email real usada '
  'por CardioLink y no debe reutilizarse para esto. NULL por defecto: '
  'ningun profesional queda vinculado hasta bootstrap manual explicito.';

-- ---------------------------------------------------------------------------
-- 2) Ampliar CHECKs de cardiolink_communications (ya desplegada)
-- ---------------------------------------------------------------------------

alter table public.cardiolink_communications
  drop constraint cardiolink_communications_tipo_ck;
alter table public.cardiolink_communications
  add constraint cardiolink_communications_tipo_ck
  check (tipo in ('confirmation', 'reminder', 'reschedule', 'cancellation', 'manual', 'assignment'));

alter table public.cardiolink_communications
  drop constraint cardiolink_communications_recipient_source_ck;
alter table public.cardiolink_communications
  add constraint cardiolink_communications_recipient_source_ck
  check (recipient_source is null or recipient_source in ('patient', 'responsible_contact', 'professional'));

comment on column public.cardiolink_communications.tipo is
  'confirmation/reminder/reschedule/cancellation/manual: comunicacion al '
  'paciente (o su contacto responsable). assignment: aviso automatico al '
  'profesional de que se le asigno un turno nuevo (recipient_source=professional).';

-- ---------------------------------------------------------------------------
-- 3) Preferencias de aviso por profesional
-- ---------------------------------------------------------------------------
-- professional_id NO es una FK: los profesionales viven en data.profesionales
-- (config local sincronizada como blob en cardiolink_atenciones), sin
-- catalogo relacional propio - mismo limite ya documentado para prestaciones
-- en cardiolink_prestacion_templates.

create table public.cardiolink_professional_notification_preferences (
  professional_id text primary key,
  email_enabled boolean not null default true,
  email_override text null,
  updated_at timestamptz not null default clock_timestamp(),
  updated_by uuid null,

  constraint cardiolink_professional_notification_preferences_id_ck
    check (btrim(professional_id) <> ''),
  constraint cardiolink_professional_notification_preferences_email_ck
    check (email_override is null or email_override ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$')
);

comment on table public.cardiolink_professional_notification_preferences is
  'Preferencias de aviso automatico por email al profesional cuando se le '
  'crea/confirma/reprograma/cancela un turno. Una fila por professional_id '
  '(mismo id que data.profesionales[].id en el cliente). Fila ausente = '
  'valores por defecto (email_enabled=true, sin override).';
comment on column public.cardiolink_professional_notification_preferences.email_enabled is
  'false = no enviar NINGUN aviso a este profesional (alta, confirmacion, '
  'reprogramacion ni cancelacion). Por defecto true.';
comment on column public.cardiolink_professional_notification_preferences.email_override is
  'Email personalizado para avisos. Si es NULL, se usa el email de la '
  'cuenta CardioLink/Auth del profesional (resuelto server-side, nunca '
  'expuesto al navegador). Si ninguno de los dos existe, no se envia nada '
  '(no es un error).';

-- Autorizacion: el propio profesional (via cardiolink_user_roles.professional_id,
-- NO cardiolink_user_key - ver seccion 1) o un owner/admin activo.
-- Comparacion normalizada (lower/btrim) para no depender de que el valor
-- se haya cargado con la misma capitalizacion.
create function public.cardiolink_es_propio_profesional(p_profesional_id text)
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
       and user_role.professional_id is not null
       and lower(btrim(user_role.professional_id)) = lower(btrim(p_profesional_id))
  );
$function$;

revoke all privileges on function public.cardiolink_es_propio_profesional(text)
  from public, anon, authenticated;
grant execute on function public.cardiolink_es_propio_profesional(text) to authenticated;

create function public.cardiolink_es_admin_u_owner()
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
       and user_role.base_role in ('owner', 'admin')
  );
$function$;

revoke all privileges on function public.cardiolink_es_admin_u_owner()
  from public, anon, authenticated;
grant execute on function public.cardiolink_es_admin_u_owner() to authenticated;

-- Trigger minimo propio (esta tabla no tiene created_at ni revision como
-- cardiolink_prestacion_templates, asi que no reutiliza ese trigger).
create function public.cardiolink_professional_notification_preferences_stamp()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $function$
begin
  new.updated_at := clock_timestamp();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end;
$function$;

create trigger cardiolink_professional_notification_preferences_stamp
before insert or update on public.cardiolink_professional_notification_preferences
for each row execute function public.cardiolink_professional_notification_preferences_stamp();

revoke all privileges on function public.cardiolink_professional_notification_preferences_stamp()
  from public, anon, authenticated;

alter table public.cardiolink_professional_notification_preferences enable row level security;

revoke all privileges on table public.cardiolink_professional_notification_preferences
  from public, anon, authenticated;

grant select, insert, update on table public.cardiolink_professional_notification_preferences
  to authenticated;

create policy cardiolink_professional_notification_preferences_select
on public.cardiolink_professional_notification_preferences
for select to authenticated
using (
  public.cardiolink_es_propio_profesional(professional_id)
  or public.cardiolink_es_admin_u_owner()
);

create policy cardiolink_professional_notification_preferences_insert
on public.cardiolink_professional_notification_preferences
for insert to authenticated
with check (
  public.cardiolink_es_propio_profesional(professional_id)
  or public.cardiolink_es_admin_u_owner()
);

create policy cardiolink_professional_notification_preferences_update
on public.cardiolink_professional_notification_preferences
for update to authenticated
using (
  public.cardiolink_es_propio_profesional(professional_id)
  or public.cardiolink_es_admin_u_owner()
)
with check (
  public.cardiolink_es_propio_profesional(professional_id)
  or public.cardiolink_es_admin_u_owner()
);

-- Sin policy de delete: ni el profesional ni un admin pueden borrar la
-- fila desde el cliente (no hace falta: "desactivar avisos" es
-- email_enabled=false, no ausencia de fila).

commit;
