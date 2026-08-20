-- CardioLink Admin - Portal Pacientes V1 / Fase 2A
-- Backend de solicitudes de turno (bandeja interna, sin portal publico todavia).
--
-- Migracion atomica de una sola ejecucion. No intenta reconciliar un esquema
-- parcialmente creado: ante un error, la transaccion completa debe revertir.
--
-- Esta etapa NO crea el portal publico, NO agrega email/WhatsApp/OCR, NO da
-- de alta usuarios reales en cardiolink_user_roles (ese bootstrap se hace por
-- ambiente, fuera de esta migracion) y NO modifica cardiolink_pacientes,
-- Finanzas 5, ni ninguna tabla existente.

begin;

-- ---------------------------------------------------------------------------
-- Tabla: solicitudes de turno
-- ---------------------------------------------------------------------------
-- Cada fila es una solicitud recibida (por ahora siempre cargada por
-- personal interno; source queda abierta a futuros origenes como 'portal').
-- patient_id referencia al paciente ya existente en cardiolink_pacientes
-- (id text, tal como esta hoy en produccion). No hay FK a atenciones porque
-- esa tabla operativa usa un esquema de payload JSON, sin identidad
-- relacional propia todavia: assigned_attention_id queda como referencia de
-- texto informativa, asociada manualmente por el personal interno.

create table public.cardiolink_appointment_requests (
  id uuid primary key default gen_random_uuid(),
  patient_id text not null
    references public.cardiolink_pacientes (id)
    on update restrict on delete restrict,
  requested_professional_id text null,
  requested_professional_name text null,
  requested_service text not null,
  message text null,
  contact_phone text not null,
  contact_email text null,
  source text not null default 'direct',
  status text not null default 'new',
  assigned_attention_id text null,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  managed_by uuid null,
  managed_at timestamptz null,

  constraint cardiolink_appointment_requests_patient_id_ck
    check (btrim(patient_id) <> ''),
  constraint cardiolink_appointment_requests_service_ck
    check (btrim(requested_service) <> ''),
  constraint cardiolink_appointment_requests_phone_ck
    check (btrim(contact_phone) <> ''),
  constraint cardiolink_appointment_requests_source_ck
    check (btrim(source) <> ''),
  constraint cardiolink_appointment_requests_status_ck
    check (
      status in ('new', 'in_progress', 'appointment_assigned', 'closed', 'cancelled')
    ),
  constraint cardiolink_appointment_requests_managed_ck
    check ((managed_by is null) = (managed_at is null)),
  constraint cardiolink_appointment_requests_revision_ck
    check (revision > 0),
  constraint cardiolink_appointment_requests_timestamps_ck
    check (updated_at >= created_at)
);

comment on table public.cardiolink_appointment_requests is
  'Solicitudes de turno (bandeja interna). Sin portal publico todavia; '
  'source queda abierta para diferenciar origenes futuros.';
comment on column public.cardiolink_appointment_requests.patient_id is
  'Referencia a cardiolink_pacientes.id (text). El paciente debe existir '
  'previamente; esta etapa no crea pacientes nuevos.';
comment on column public.cardiolink_appointment_requests.assigned_attention_id is
  'Referencia informativa, sin FK: la tabla operativa de atenciones usa un '
  'esquema de payload JSON sin identidad relacional propia todavia. La '
  'asociacion queda manual por parte del personal interno.';
comment on column public.cardiolink_appointment_requests.status is
  'Uno de: new, in_progress, appointment_assigned, closed, cancelled. '
  'Sin DELETE desde cliente: cerrar o cancelar son cambios de estado.';
comment on column public.cardiolink_appointment_requests.revision is
  'Control optimista: el UPDATE debe filtrar por id y revision esperada. '
  'El trigger de esta migracion la incrementa solo; el cliente no puede '
  'asignarla directamente.';
comment on column public.cardiolink_appointment_requests.managed_by is
  'Snapshot de auth.uid() de quien cambio el estado por ultima vez. Sin FK '
  'a auth.users a proposito: una purga posterior de la cuenta no debe '
  'mutar ni bloquear el historial de la solicitud.';
comment on column public.cardiolink_appointment_requests.managed_at is
  'Se completa junto con managed_by, solo cuando cambia status. El '
  'trigger de esta migracion lo controla; el cliente no puede fijarlo '
  'directamente en un cambio de estado.';

-- ---------------------------------------------------------------------------
-- Indices
-- ---------------------------------------------------------------------------

create index cardiolink_appointment_requests_status_idx
  on public.cardiolink_appointment_requests (status);

create index cardiolink_appointment_requests_created_at_idx
  on public.cardiolink_appointment_requests (created_at desc);

create index cardiolink_appointment_requests_patient_id_idx
  on public.cardiolink_appointment_requests (patient_id);

-- ---------------------------------------------------------------------------
-- Triggers: ciclo de vida (managed_by/managed_at) y control de revision
-- ---------------------------------------------------------------------------
-- Separados en dos funciones, igual que en la migracion de Finanzas 5, para
-- que el orden de ejecucion (nombres con prefijo numerico, Postgres los
-- corre en orden alfabetico dentro del mismo evento) sea explicito: el
-- ciclo de vida corre antes (10) que el sellado final de revision (90).

create function public.cardiolink_appointment_requests_enforce_lifecycle()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $function$
begin
  if tg_op = 'INSERT' then
    -- Una solicitud recien creada todavia no fue gestionada por nadie.
    new.managed_by := null;
    new.managed_at := null;
    return new;
  end if;

  if new.status is distinct from old.status then
    -- Un actor backend sin JWT debe informar explicitamente su uid confiable.
    new.managed_by := coalesce(auth.uid(), new.managed_by, old.managed_by);
    new.managed_at := clock_timestamp();
  else
    -- Sin cambio de estado, managed_by/managed_at quedan bajo control del
    -- servidor: el cliente no puede tocarlos en una edicion de otros campos.
    new.managed_by := old.managed_by;
    new.managed_at := old.managed_at;
  end if;

  return new;
end;
$function$;

create function public.cardiolink_appointment_requests_stamp_row()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $function$
begin
  if tg_op = 'INSERT' then
    new.created_at := clock_timestamp();
    new.updated_at := new.created_at;
    new.revision := 1;
    return new;
  end if;

  if new.revision is distinct from old.revision then
    raise exception using
      errcode = '40001',
      message = 'revision must not be changed directly; filter by the expected revision';
  end if;

  if new.id is distinct from old.id then
    raise exception using
      errcode = '55000',
      message = 'appointment request id is immutable';
  end if;

  new.created_at := old.created_at;
  new.updated_at := clock_timestamp();
  new.revision := old.revision + 1;
  return new;
end;
$function$;

create trigger cardiolink_appointment_requests_10_lifecycle
before insert or update on public.cardiolink_appointment_requests
for each row execute function public.cardiolink_appointment_requests_enforce_lifecycle();

create trigger cardiolink_appointment_requests_90_stamp
before insert or update on public.cardiolink_appointment_requests
for each row execute function public.cardiolink_appointment_requests_stamp_row();

-- Las funciones de trigger no deben ser invocables directamente.
revoke all privileges on function public.cardiolink_appointment_requests_enforce_lifecycle()
  from public, anon, authenticated;
revoke all privileges on function public.cardiolink_appointment_requests_stamp_row()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- RLS y autorizacion especifica de solicitudes (no reutiliza Finanzas 5)
-- ---------------------------------------------------------------------------

alter table public.cardiolink_appointment_requests enable row level security;

-- Funcion minima de autorizacion, independiente de
-- cardiolink_has_finance_access(). SECURITY DEFINER solo para poder leer la
-- tabla de roles cerrada; no acepta un uid del cliente y depende
-- exclusivamente de auth.uid(), nunca del rol mostrado en el frontend.
create function public.cardiolink_has_appointment_requests_access()
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
       and user_role.base_role in ('owner', 'admin', 'secretaria')
  );
$function$;

revoke all privileges on function public.cardiolink_has_appointment_requests_access()
  from public, anon, authenticated;
grant execute on function public.cardiolink_has_appointment_requests_access() to authenticated;

-- anon queda sin ningun privilegio directo. authenticated solo puede
-- select/insert/update, siempre sujeto a la policy de abajo; no hay grant
-- ni policy de delete.
revoke all privileges on table public.cardiolink_appointment_requests
  from public, anon, authenticated;

grant select, insert, update on table public.cardiolink_appointment_requests
  to authenticated;

create policy cardiolink_appointment_requests_select
on public.cardiolink_appointment_requests
for select to authenticated
using (public.cardiolink_has_appointment_requests_access());

create policy cardiolink_appointment_requests_insert
on public.cardiolink_appointment_requests
for insert to authenticated
with check (public.cardiolink_has_appointment_requests_access());

create policy cardiolink_appointment_requests_update
on public.cardiolink_appointment_requests
for update to authenticated
using (public.cardiolink_has_appointment_requests_access())
with check (public.cardiolink_has_appointment_requests_access());

-- No existen politicas DELETE. Secretaria/admin/owner solo pueden cerrar o
-- cancelar cambiando status; anon y usuarios sin mapeo backend activo no
-- pasan ninguna RLS.

commit;
