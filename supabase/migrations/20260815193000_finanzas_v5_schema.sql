-- CardioLink Admin - Finanzas 5 / Etapa 2A
-- Esquema, auditoria y RLS para egresos.
--
-- Migracion atomica de una sola ejecucion. No intenta reconciliar un esquema
-- parcialmente creado: ante un error, la transaccion completa debe revertir.
-- No crea egresos ni plantillas y no asigna roles a usuarios reales.

begin;

-- ---------------------------------------------------------------------------
-- Fuente backend minima de autorizacion
-- ---------------------------------------------------------------------------
-- La aplicacion actual resuelve baseRole desde config en el cliente. Ese dato
-- no es apto para RLS. Esta tabla vincula un auth.users.id verificado con el
-- rol base que Supabase puede usar de forma confiable.

create table public.cardiolink_user_roles (
  user_id uuid primary key
    references auth.users (id) on update restrict on delete cascade,
  cardiolink_user_key text null,
  base_role text not null,
  active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  created_by uuid null,
  updated_by uuid null,
  revision integer not null default 1,

  constraint cardiolink_user_roles_base_role_ck
    check (base_role in ('owner', 'admin', 'medico', 'secretaria')),
  constraint cardiolink_user_roles_user_key_ck
    check (cardiolink_user_key is null or btrim(cardiolink_user_key) <> ''),
  constraint cardiolink_user_roles_revision_ck check (revision > 0),
  constraint cardiolink_user_roles_timestamps_ck check (updated_at >= created_at)
);

create unique index cardiolink_user_roles_user_key_uq
  on public.cardiolink_user_roles (lower(btrim(cardiolink_user_key)))
  where cardiolink_user_key is not null;

comment on table public.cardiolink_user_roles is
  'Mapeo backend minimo auth.users -> baseRole. Sin acceso directo desde clientes.';
comment on column public.cardiolink_user_roles.cardiolink_user_key is
  'Identificador informativo del usuario CardioLink; nunca se usa para autorizar.';

-- ---------------------------------------------------------------------------
-- Categorias editables (raiz + un unico nivel de subcategoria)
-- ---------------------------------------------------------------------------

create table public.cardiolink_finance_categories (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid null,
  system_key text null,
  name text not null,
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  created_by uuid null,
  updated_by uuid null,
  revision integer not null default 1,

  constraint cardiolink_finance_categories_parent_fk
    foreign key (parent_id)
    references public.cardiolink_finance_categories (id)
    on update restrict on delete restrict,
  constraint cardiolink_finance_categories_name_ck check (btrim(name) <> ''),
  constraint cardiolink_finance_categories_system_key_ck check (
    system_key is null
    or (
      btrim(system_key) <> ''
      and system_key = upper(system_key)
      and system_key ~ '^[A-Z0-9_]+$'
    )
  ),
  constraint cardiolink_finance_categories_not_self_parent_ck
    check (parent_id is null or parent_id <> id),
  constraint cardiolink_finance_categories_revision_ck check (revision > 0),
  constraint cardiolink_finance_categories_timestamps_ck
    check (updated_at >= created_at)
);

create unique index cardiolink_finance_categories_system_key_uq
  on public.cardiolink_finance_categories (system_key)
  where system_key is not null;

create unique index cardiolink_finance_categories_active_sibling_name_uq
  on public.cardiolink_finance_categories (
    coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(btrim(name))
  )
  where active;

create index cardiolink_finance_categories_tree_idx
  on public.cardiolink_finance_categories (parent_id, sort_order, name);

comment on column public.cardiolink_finance_categories.system_key is
  'Clave reservada: clientes autenticados no pueden crearla ni modificarla.';
comment on column public.cardiolink_finance_categories.active is
  'Soft delete funcional. Las categorias usadas no se eliminan desde la app.';

-- ---------------------------------------------------------------------------
-- Plantillas recurrentes (solo precarga; no generan egresos automaticamente)
-- ---------------------------------------------------------------------------

create table public.cardiolink_finance_recurring_templates (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null
    references public.cardiolink_finance_categories (id)
    on update restrict on delete restrict,
  concept text not null,
  default_amount numeric(14, 2) null,
  beneficiary text null,
  payment_method text null,
  notes text null,
  professional_id text null,
  due_day smallint null,
  start_month date not null,
  end_month date null,
  active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  created_by uuid null,
  updated_by uuid null,
  revision integer not null default 1,

  constraint cardiolink_finance_recurring_templates_concept_ck
    check (btrim(concept) <> ''),
  constraint cardiolink_finance_recurring_templates_amount_ck
    check (default_amount is null or default_amount > 0),
  constraint cardiolink_finance_recurring_templates_professional_ck
    check (professional_id is null or btrim(professional_id) <> ''),
  constraint cardiolink_finance_recurring_templates_due_day_ck
    check (due_day is null or due_day between 1 and 31),
  constraint cardiolink_finance_recurring_templates_start_month_ck
    check (start_month = date_trunc('month', start_month)::date),
  constraint cardiolink_finance_recurring_templates_end_month_ck
    check (
      end_month is null
      or (
        end_month = date_trunc('month', end_month)::date
        and end_month >= start_month
      )
    ),
  constraint cardiolink_finance_recurring_templates_revision_ck
    check (revision > 0),
  constraint cardiolink_finance_recurring_templates_timestamps_ck
    check (updated_at >= created_at)
);

create index cardiolink_finance_recurring_templates_active_idx
  on public.cardiolink_finance_recurring_templates
    (active, start_month, end_month);

create index cardiolink_finance_recurring_templates_category_idx
  on public.cardiolink_finance_recurring_templates (category_id, active);

-- professional_id integra la identidad para permitir plantillas equivalentes
-- legitimas asignadas a profesionales distintos. Las inactivas quedan fuera
-- para conservar historia y permitir crear luego un reemplazo equivalente.
create unique index cardiolink_finance_recurring_active_identity_uq
  on public.cardiolink_finance_recurring_templates (
    category_id,
    lower(btrim(concept)),
    coalesce(lower(btrim(beneficiary)), ''),
    coalesce(lower(btrim(professional_id)), '')
  )
  where active;

comment on table public.cardiolink_finance_recurring_templates is
  'Plantillas de precarga. No existe trigger ni tarea que cree egresos automaticamente.';

-- ---------------------------------------------------------------------------
-- Egresos: una fila independiente por movimiento real
-- ---------------------------------------------------------------------------

create table public.cardiolink_finance_expenses (
  id uuid primary key default gen_random_uuid(),
  expense_date date not null,
  category_id uuid not null
    references public.cardiolink_finance_categories (id)
    on update restrict on delete restrict,
  concept text not null,
  amount numeric(14, 2) not null,
  beneficiary text null,
  payment_method text null,
  notes text null,
  professional_id text null,
  receipt_reference text null,
  status text not null default 'pending',
  paid_on date null,
  recurring_template_id uuid null
    references public.cardiolink_finance_recurring_templates (id)
    on update restrict on delete restrict,
  period_month date null,
  source_type text not null default 'manual',
  source_ref text null,
  source_snapshot jsonb null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  voided_at timestamptz null,
  created_by uuid null,
  updated_by uuid null,
  voided_by uuid null,
  revision integer not null default 1,

  constraint cardiolink_finance_expenses_concept_ck check (btrim(concept) <> ''),
  constraint cardiolink_finance_expenses_amount_ck check (amount > 0),
  constraint cardiolink_finance_expenses_professional_ck
    check (professional_id is null or btrim(professional_id) <> ''),
  constraint cardiolink_finance_expenses_status_ck
    check (status in ('pending', 'paid', 'voided')),
  constraint cardiolink_finance_expenses_paid_on_ck check (
    (status <> 'paid' or paid_on is not null)
    and (status <> 'pending' or paid_on is null)
  ),
  constraint cardiolink_finance_expenses_voided_ck check (
    (
      status = 'voided'
      and voided_at is not null
      and voided_by is not null
    )
    or (
      status <> 'voided'
      and voided_at is null
      and voided_by is null
    )
  ),
  constraint cardiolink_finance_expenses_period_month_ck
    check (
      period_month is null
      or period_month = date_trunc('month', period_month)::date
    ),
  constraint cardiolink_finance_expenses_source_type_ck check (
    source_type in (
      'manual',
      'recurring',
      'salary_f4',
      'placements_f4',
      'migration_f4'
    )
  ),
  constraint cardiolink_finance_expenses_source_ref_ck
    check (
      source_ref is null
      or (source_ref = btrim(source_ref) and source_ref <> '')
    ),
  constraint cardiolink_finance_expenses_source_snapshot_ck
    check (source_snapshot is null or jsonb_typeof(source_snapshot) = 'object'),
  constraint cardiolink_finance_expenses_recurring_source_ck check (
    (
      source_type = 'recurring'
      and recurring_template_id is not null
      and period_month is not null
    )
    or (
      source_type <> 'recurring'
      and recurring_template_id is null
    )
  ),
  constraint cardiolink_finance_expenses_calculated_source_ck check (
    source_type not in ('salary_f4', 'placements_f4', 'migration_f4')
    or source_ref is not null
  ),
  constraint cardiolink_finance_expenses_calculated_period_ck check (
    source_type not in ('salary_f4', 'placements_f4')
    or period_month is not null
  ),
  constraint cardiolink_finance_expenses_revision_ck check (revision > 0),
  constraint cardiolink_finance_expenses_timestamps_ck
    check (updated_at >= created_at)
);

-- La unicidad se aplica solo a movimientos vigentes. Una anulacion conserva
-- el historial y permite registrar luego el reemplazo corregido.
create unique index cardiolink_finance_expenses_source_ref_uq
  on public.cardiolink_finance_expenses (source_type, lower(source_ref))
  where source_ref is not null and status <> 'voided';

create unique index cardiolink_finance_expenses_template_month_uq
  on public.cardiolink_finance_expenses (recurring_template_id, period_month)
  where recurring_template_id is not null and status <> 'voided';

create index cardiolink_finance_expenses_date_idx
  on public.cardiolink_finance_expenses (expense_date desc);

create index cardiolink_finance_expenses_category_date_idx
  on public.cardiolink_finance_expenses (category_id, expense_date desc);

create index cardiolink_finance_expenses_status_date_idx
  on public.cardiolink_finance_expenses (status, expense_date desc);

create index cardiolink_finance_expenses_paid_on_idx
  on public.cardiolink_finance_expenses (paid_on desc)
  where status = 'paid';

create index cardiolink_finance_expenses_professional_date_idx
  on public.cardiolink_finance_expenses (professional_id, expense_date desc)
  where professional_id is not null;

create index cardiolink_finance_expenses_source_lookup_idx
  on public.cardiolink_finance_expenses (source_type, period_month, source_ref);

comment on column public.cardiolink_finance_expenses.revision is
  'Control optimista: el UPDATE futuro debe filtrar por id y revision esperada.';
comment on column public.cardiolink_finance_expenses.source_ref is
  'Referencia estable, por ejemplo salary:secretaria:2026-08.';
comment on column public.cardiolink_finance_expenses.source_snapshot is
  'Snapshot inmutable de los datos que originaron un egreso calculado.';
comment on column public.cardiolink_finance_expenses.voided_by is
  'Snapshot de auth.uid(); sin FK para preservar historia si se purga la cuenta Auth.';

-- ---------------------------------------------------------------------------
-- Auditoria append-only
-- ---------------------------------------------------------------------------

create table public.cardiolink_finance_audit_events (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  action text not null,
  before_data jsonb null,
  after_data jsonb null,
  actor_id uuid null,
  actor_label text null,
  created_at timestamptz not null default clock_timestamp(),

  constraint cardiolink_finance_audit_events_entity_type_ck check (
    entity_type in ('category', 'expense', 'recurring_template')
  ),
  constraint cardiolink_finance_audit_events_action_ck check (
    action in ('created', 'updated', 'status_changed', 'voided')
  )
);

create index cardiolink_finance_audit_events_entity_idx
  on public.cardiolink_finance_audit_events
    (entity_type, entity_id, created_at desc);

create index cardiolink_finance_audit_events_created_at_idx
  on public.cardiolink_finance_audit_events (created_at desc);

create index cardiolink_finance_audit_events_actor_idx
  on public.cardiolink_finance_audit_events (actor_id, created_at desc)
  where actor_id is not null;

comment on column public.cardiolink_finance_audit_events.actor_id is
  'Snapshot de auth.uid(); sin FK para mantener el evento estrictamente append-only.';

-- ---------------------------------------------------------------------------
-- Triggers de integridad, revision y auditoria
-- ---------------------------------------------------------------------------

create function public.cardiolink_finance_stamp_row()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $function$
begin
  if tg_op = 'INSERT' then
    new.created_at := clock_timestamp();
    new.updated_at := new.created_at;
    -- Un request autenticado siempre queda sellado con su propio uid. Un rol
    -- de migracion sin JWT puede informar explicitamente un actor confiable.
    new.created_by := coalesce(auth.uid(), new.created_by);
    new.updated_by := coalesce(auth.uid(), new.updated_by, new.created_by);
    new.revision := 1;
    return new;
  end if;

  if new.revision is distinct from old.revision then
    raise exception using
      errcode = '40001',
      message = 'revision must not be changed directly; filter by the expected revision';
  end if;

  if tg_table_name <> 'cardiolink_user_roles'
     and (to_jsonb(new) ->> 'id') is distinct from (to_jsonb(old) ->> 'id') then
    raise exception using
      errcode = '55000',
      message = 'finance entity ids are immutable';
  end if;

  new.created_at := old.created_at;
  new.created_by := old.created_by;
  new.updated_at := clock_timestamp();
  new.updated_by := coalesce(auth.uid(), new.updated_by, old.updated_by);
  new.revision := old.revision + 1;
  return new;
end;
$function$;

create function public.cardiolink_finance_enforce_category_hierarchy()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $function$
declare
  parent_parent_id uuid;
begin
  -- Serializa exclusivamente cambios de jerarquia. El catalogo es pequeno y
  -- esto evita que dos movimientos concurrentes creen accidentalmente nivel 3.
  perform pg_advisory_xact_lock(4045, 5001);

  if new.parent_id is null then
    return new;
  end if;

  if new.parent_id = new.id then
    raise exception using
      errcode = '23514',
      message = 'a finance category cannot be its own parent';
  end if;

  select c.parent_id
    into parent_parent_id
    from public.cardiolink_finance_categories as c
   where c.id = new.parent_id
   for key share;

  if not found then
    raise exception using
      errcode = '23503',
      message = 'finance category parent does not exist';
  end if;

  if parent_parent_id is not null then
    raise exception using
      errcode = '23514',
      message = 'finance categories support only one subcategory level';
  end if;

  if exists (
    select 1
      from public.cardiolink_finance_categories as child
     where child.parent_id = new.id
       and child.id <> new.id
  ) then
    raise exception using
      errcode = '23514',
      message = 'a category with children cannot become a subcategory';
  end if;

  return new;
end;
$function$;

create function public.cardiolink_finance_protect_system_key()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $function$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null and new.system_key is not null then
      raise exception using
        errcode = '42501',
        message = 'system_key is reserved for trusted migrations';
    end if;
    return new;
  end if;

  if new.system_key is distinct from old.system_key then
    raise exception using
      errcode = '42501',
      message = 'system_key is immutable';
  end if;

  return new;
end;
$function$;

create function public.cardiolink_finance_enforce_expense_lifecycle()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $function$
begin
  if tg_op = 'INSERT' then
    if new.status = 'voided' then
      new.voided_at := clock_timestamp();
      new.voided_by := coalesce(auth.uid(), new.voided_by);
    else
      new.voided_at := null;
      new.voided_by := null;
    end if;
    return new;
  end if;

  if old.status = 'voided' then
    raise exception using
      errcode = '55000',
      message = 'voided finance expenses are immutable';
  end if;

  if new.source_type is distinct from old.source_type
     or new.source_ref is distinct from old.source_ref
     or new.recurring_template_id is distinct from old.recurring_template_id
     or new.period_month is distinct from old.period_month
     or new.source_snapshot is distinct from old.source_snapshot then
    raise exception using
      errcode = '55000',
      message = 'finance expense source identity is immutable; void and recreate';
  end if;

  if new.status = 'voided' then
    -- La anulacion preserva exactamente la fecha de pago historica. Para un
    -- pending sera NULL; para un paid conserva el valor anterior aunque el
    -- payload intente limpiarlo o reemplazarlo.
    new.paid_on := old.paid_on;
    new.voided_at := clock_timestamp();
    -- Un actor backend sin JWT debe informar explicitamente su uid confiable.
    new.voided_by := coalesce(auth.uid(), new.voided_by);
  else
    new.voided_at := null;
    new.voided_by := null;
  end if;

  return new;
end;
$function$;

-- SECURITY DEFINER se justifica solo para insertar el evento producido por un
-- trigger aunque el cliente no tenga INSERT sobre la tabla de auditoria. No
-- acepta parametros, usa nombres calificados y fija search_path.
create function public.cardiolink_finance_write_audit_event()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  event_entity_type text;
  event_action text;
  event_before jsonb;
  event_after jsonb;
  event_actor_label text;
begin
  event_entity_type := case tg_table_name
    when 'cardiolink_finance_categories' then 'category'
    when 'cardiolink_finance_expenses' then 'expense'
    when 'cardiolink_finance_recurring_templates' then 'recurring_template'
    else null
  end;

  if event_entity_type is null then
    raise exception 'unsupported finance audit table: %', tg_table_name;
  end if;

  if tg_op = 'INSERT' then
    event_action := 'created';
    event_before := null;
    event_after := to_jsonb(new);
  else
    event_before := to_jsonb(old);
    event_after := to_jsonb(new);

    if event_entity_type = 'expense'
       and (event_before ->> 'status')
         is distinct from (event_after ->> 'status') then
      event_action := case
        when event_after ->> 'status' = 'voided' then 'voided'
        else 'status_changed'
      end;
    else
      event_action := 'updated';
    end if;
  end if;

  event_actor_label := coalesce(
    nullif(auth.jwt() ->> 'email', ''),
    auth.uid()::text,
    session_user::text
  );

  insert into public.cardiolink_finance_audit_events (
    entity_type,
    entity_id,
    action,
    before_data,
    after_data,
    actor_id,
    actor_label
  ) values (
    event_entity_type,
    new.id,
    event_action,
    event_before,
    event_after,
    auth.uid(),
    event_actor_label
  );

  return new;
end;
$function$;

create function public.cardiolink_finance_prevent_audit_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $function$
begin
  raise exception using
    errcode = '55000',
    message = 'finance audit events are append-only';
end;
$function$;

create trigger cardiolink_user_roles_90_stamp
before insert or update on public.cardiolink_user_roles
for each row execute function public.cardiolink_finance_stamp_row();

create trigger cardiolink_finance_categories_10_hierarchy
before insert or update of parent_id
on public.cardiolink_finance_categories
for each row execute function public.cardiolink_finance_enforce_category_hierarchy();

create trigger cardiolink_finance_categories_20_system_key
before insert or update of system_key
on public.cardiolink_finance_categories
for each row execute function public.cardiolink_finance_protect_system_key();

create trigger cardiolink_finance_categories_90_stamp
before insert or update on public.cardiolink_finance_categories
for each row execute function public.cardiolink_finance_stamp_row();

create trigger cardiolink_finance_recurring_templates_90_stamp
before insert or update on public.cardiolink_finance_recurring_templates
for each row execute function public.cardiolink_finance_stamp_row();

create trigger cardiolink_finance_expenses_10_lifecycle
before insert or update on public.cardiolink_finance_expenses
for each row execute function public.cardiolink_finance_enforce_expense_lifecycle();

create trigger cardiolink_finance_expenses_90_stamp
before insert or update on public.cardiolink_finance_expenses
for each row execute function public.cardiolink_finance_stamp_row();

create trigger cardiolink_finance_categories_90_audit
after insert or update on public.cardiolink_finance_categories
for each row execute function public.cardiolink_finance_write_audit_event();

create trigger cardiolink_finance_recurring_templates_90_audit
after insert or update on public.cardiolink_finance_recurring_templates
for each row execute function public.cardiolink_finance_write_audit_event();

create trigger cardiolink_finance_expenses_90_audit
after insert or update on public.cardiolink_finance_expenses
for each row execute function public.cardiolink_finance_write_audit_event();

create trigger cardiolink_finance_audit_events_00_append_only
before update or delete on public.cardiolink_finance_audit_events
for each row execute function public.cardiolink_finance_prevent_audit_mutation();

-- Las funciones de trigger no deben ser invocables directamente.
revoke all privileges on function public.cardiolink_finance_stamp_row()
  from public, anon, authenticated;
revoke all privileges on function public.cardiolink_finance_enforce_category_hierarchy()
  from public, anon, authenticated;
revoke all privileges on function public.cardiolink_finance_protect_system_key()
  from public, anon, authenticated;
revoke all privileges on function public.cardiolink_finance_enforce_expense_lifecycle()
  from public, anon, authenticated;
revoke all privileges on function public.cardiolink_finance_write_audit_event()
  from public, anon, authenticated;
revoke all privileges on function public.cardiolink_finance_prevent_audit_mutation()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- RLS y grants
-- ---------------------------------------------------------------------------

alter table public.cardiolink_user_roles enable row level security;
alter table public.cardiolink_finance_categories enable row level security;
alter table public.cardiolink_finance_recurring_templates enable row level security;
alter table public.cardiolink_finance_expenses enable row level security;
alter table public.cardiolink_finance_audit_events enable row level security;

-- Funcion minima de autorizacion. SECURITY DEFINER permite leer exclusivamente
-- el rol del auth.uid() actual sin exponer la tabla de roles. No recibe un uid
-- del llamador y por eso no puede consultar ni adoptar permisos ajenos.
create function public.cardiolink_has_finance_access()
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

revoke all privileges on function public.cardiolink_has_finance_access()
  from public, anon, authenticated;
grant execute on function public.cardiolink_has_finance_access() to authenticated;

-- El rol de base no se puede leer ni mutar con anon/authenticated. El alta y
-- mantenimiento se realizan solo por un canal backend confiable.
revoke all privileges on table public.cardiolink_user_roles
  from public, anon, authenticated;

revoke all privileges on table public.cardiolink_finance_categories
  from public, anon, authenticated;
revoke all privileges on table public.cardiolink_finance_recurring_templates
  from public, anon, authenticated;
revoke all privileges on table public.cardiolink_finance_expenses
  from public, anon, authenticated;
revoke all privileges on table public.cardiolink_finance_audit_events
  from public, anon, authenticated;

grant select, insert, update on table public.cardiolink_finance_categories
  to authenticated;
grant select, insert, update on table public.cardiolink_finance_recurring_templates
  to authenticated;
grant select, insert, update on table public.cardiolink_finance_expenses
  to authenticated;
grant select on table public.cardiolink_finance_audit_events
  to authenticated;

create policy cardiolink_finance_categories_select
on public.cardiolink_finance_categories
for select to authenticated
using (public.cardiolink_has_finance_access());

create policy cardiolink_finance_categories_insert
on public.cardiolink_finance_categories
for insert to authenticated
with check (public.cardiolink_has_finance_access());

create policy cardiolink_finance_categories_update
on public.cardiolink_finance_categories
for update to authenticated
using (public.cardiolink_has_finance_access())
with check (public.cardiolink_has_finance_access());

create policy cardiolink_finance_recurring_templates_select
on public.cardiolink_finance_recurring_templates
for select to authenticated
using (public.cardiolink_has_finance_access());

create policy cardiolink_finance_recurring_templates_insert
on public.cardiolink_finance_recurring_templates
for insert to authenticated
with check (public.cardiolink_has_finance_access());

create policy cardiolink_finance_recurring_templates_update
on public.cardiolink_finance_recurring_templates
for update to authenticated
using (public.cardiolink_has_finance_access())
with check (public.cardiolink_has_finance_access());

create policy cardiolink_finance_expenses_select
on public.cardiolink_finance_expenses
for select to authenticated
using (public.cardiolink_has_finance_access());

create policy cardiolink_finance_expenses_insert
on public.cardiolink_finance_expenses
for insert to authenticated
with check (public.cardiolink_has_finance_access());

create policy cardiolink_finance_expenses_update
on public.cardiolink_finance_expenses
for update to authenticated
using (public.cardiolink_has_finance_access())
with check (public.cardiolink_has_finance_access());

create policy cardiolink_finance_audit_events_select
on public.cardiolink_finance_audit_events
for select to authenticated
using (public.cardiolink_has_finance_access());

-- No existen politicas DELETE. Audit tampoco tiene politicas INSERT/UPDATE.
-- Secretaria, medico, anon y usuarios sin mapeo backend no pasan ninguna RLS.

-- ---------------------------------------------------------------------------
-- Catalogo inicial del sistema
-- ---------------------------------------------------------------------------

insert into public.cardiolink_finance_categories
  (id, parent_id, system_key, name, sort_order)
values
  ('10000000-0000-4000-8000-000000000001', null, 'PERSONAL', 'PERSONAL', 10),
  ('10000000-0000-4000-8000-000000000002', null, 'ALQUILER', 'ALQUILER', 20),
  ('10000000-0000-4000-8000-000000000003', null, 'LOGISTICA_TRASLADOS', 'LOGÍSTICA / TRASLADOS', 30),
  ('10000000-0000-4000-8000-000000000004', null, 'LIBRERIA', 'LIBRERÍA', 40),
  ('10000000-0000-4000-8000-000000000005', null, 'INSUMOS_MEDICOS', 'INSUMOS MÉDICOS', 50),
  ('10000000-0000-4000-8000-000000000006', null, 'CIRCULO_MEDICO', 'CÍRCULO MÉDICO', 60),
  ('10000000-0000-4000-8000-000000000007', null, 'SERVICIOS', 'SERVICIOS', 70),
  ('10000000-0000-4000-8000-000000000008', null, 'IMPUESTOS_TASAS', 'IMPUESTOS / TASAS', 80),
  ('10000000-0000-4000-8000-000000000009', null, 'OTROS', 'OTROS', 90);

insert into public.cardiolink_finance_categories
  (id, parent_id, system_key, name, sort_order)
values
  ('11000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'PERSONAL_SECRETARIA', 'Secretaría', 10),
  ('11000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'PERSONAL_OTRA_SECRETARIA', 'Otra Secretaría', 20),
  ('11000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'PERSONAL_LIMPIEZA', 'Limpieza', 30),
  ('11000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 'PERSONAL_OTRO_EMPLEADO', 'Otro empleado', 40),
  ('11000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001', 'PERSONAL_COLOCACIONES', 'Colocaciones', 50),
  ('12000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000004', 'LIBRERIA_TONER', 'Tóner', 10),
  ('12000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000004', 'LIBRERIA_PAPEL', 'Papel', 20),
  ('12000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000004', 'LIBRERIA_RESMAS', 'Resmas', 30),
  ('12000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000004', 'LIBRERIA_OTROS', 'Otros', 40),
  ('13000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000005', 'INSUMOS_MEDICOS_GEL_ECOGRAFIA', 'Gel ecografía', 10),
  ('13000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000005', 'INSUMOS_MEDICOS_ELECTRODOS_HOLTER', 'Electrodos Holter', 20),
  ('13000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000005', 'INSUMOS_MEDICOS_ALCOHOL_ECG', 'Alcohol ECG', 30),
  ('13000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000005', 'INSUMOS_MEDICOS_OTROS', 'Otros', 40);

commit;
