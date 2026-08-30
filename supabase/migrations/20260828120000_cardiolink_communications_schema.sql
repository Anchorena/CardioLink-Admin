-- CardioLink Admin - Patient Communications V1
-- Esquema, plantillas por prestacion y funcion de candidatos a recordatorio.
--
-- REDACTADA, NO EJECUTADA TODAVIA.
--
-- Migracion atomica de una sola ejecucion. No intenta reconciliar un esquema
-- parcialmente creado: ante un error, la transaccion completa debe revertir.
--
-- Objetivo: reemplazar gradualmente a MediCloud en la comunicacion con
-- pacientes (confirmacion/reprogramacion/cancelacion/recordatorio de turno
-- por email y WhatsApp), sin tocar Historia Clinica, Finanzas, backfill de
-- pacientes, Portal ni autenticacion. No crea una segunda nocion de "turno":
-- lee cardiolink_atenciones tal cual la sincroniza app.js hoy (payload
-- jsonb con fecha/horaInicio/estadoTurno/paciente/email/telefono/etc), no
-- agrega una tabla relacional de turnos.
--
-- No guarda ningun secret de proveedor de email aca: RESEND_API_KEY /
-- RESEND_FROM_EMAIL viven unicamente como variables de entorno de la Edge
-- Function patient-communications / patient-reminders-24h. Esta migracion
-- no los referencia en ningun lado.

begin;

-- ---------------------------------------------------------------------------
-- 1) Autorizacion (se crea primero: las policies de abajo la referencian).
--    Mismo patron que cardiolink_has_appointment_requests_access() (Portal
--    Pacientes V1 / Fase 2A): SECURITY DEFINER solo para poder leer la
--    tabla de roles cerrada; depende exclusivamente de auth.uid(), nunca de
--    un rol que mande el cliente.
--
--    Permisos pedidos: owner/admin y secretaria pueden enviar comunicaciones
--    administrativas; medico tambien puede (la app ya solo expone el modal
--    de notificacion en pantallas donde el medico gestiona el turno; el
--    respaldo real de "solo ese turno" a nivel de fila no es posible hoy
--    porque cardiolink_atenciones no tiene identidad relacional propia -
--    mismo limite que ya documenta la migracion de appointment_requests).
-- ---------------------------------------------------------------------------

create function public.cardiolink_has_communications_access()
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
       and user_role.base_role in ('owner', 'admin', 'secretaria', 'medico')
  );
$function$;

revoke all privileges on function public.cardiolink_has_communications_access()
  from public, anon, authenticated;
grant execute on function public.cardiolink_has_communications_access() to authenticated;

-- ---------------------------------------------------------------------------
-- 2) Plantillas por prestacion (instrucciones + textos de cada tipo de
--    comunicacion). Tabla independiente: no deforma como se modelan hoy las
--    prestaciones (strings sueltos por profesional en data.profesionales[]
--    .prestaciones, sin catalogo con id propio) - se relaciona por el
--    nombre de la prestacion, normalizado.
-- ---------------------------------------------------------------------------

create table public.cardiolink_prestacion_templates (
  id uuid primary key default gen_random_uuid(),
  -- Clave de union con la prestacion real (string libre en
  -- data.profesionales[].prestaciones). '_default' es la fila de respaldo
  -- para cualquier prestacion sin fila propia.
  prestacion_normalizada text not null unique,
  -- Solo para mostrar en el editor (Table Editor en V1: no hay pantalla de
  -- administracion todavia, ver docs). No participa de ninguna busqueda.
  prestacion_label text null,
  instrucciones_paciente text null,
  asunto_email text null,
  plantilla_confirmacion text null,
  plantilla_recordatorio text null,
  plantilla_reprogramacion text null,
  plantilla_cancelacion text null,
  activo boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  created_by uuid null,
  updated_by uuid null,
  revision integer not null default 1,

  constraint cardiolink_prestacion_templates_clave_ck
    check (btrim(prestacion_normalizada) <> ''),
  constraint cardiolink_prestacion_templates_revision_ck check (revision > 0),
  constraint cardiolink_prestacion_templates_timestamps_ck
    check (updated_at >= created_at)
);

comment on table public.cardiolink_prestacion_templates is
  'Instrucciones y plantillas de mensaje por prestacion. Clave "_default" '
  'es el respaldo para cualquier prestacion sin fila propia. Sin pantalla '
  'de administracion en V1: se edita desde Table Editor de Supabase.';
comment on column public.cardiolink_prestacion_templates.prestacion_normalizada is
  'Nombre de la prestacion en minusculas/sin acentos/espacios colapsados, '
  'o el literal "_default". No es una FK: las prestaciones no tienen '
  'catalogo relacional propio hoy (son strings en data.profesionales[].prestaciones).';
comment on column public.cardiolink_prestacion_templates.instrucciones_paciente is
  'Texto libre configurable (documentacion a traer, ayuno, ropa comoda, '
  'etc). Nunca hardcodeado en el codigo: se compone dentro de cada plantilla '
  'via el token {{instrucciones}}.';

create function public.cardiolink_prestacion_templates_stamp_row()
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
  new.created_at := old.created_at;
  new.updated_at := clock_timestamp();
  new.revision := old.revision + 1;
  return new;
end;
$function$;

create trigger cardiolink_prestacion_templates_90_stamp
before insert or update on public.cardiolink_prestacion_templates
for each row execute function public.cardiolink_prestacion_templates_stamp_row();

revoke all privileges on function public.cardiolink_prestacion_templates_stamp_row()
  from public, anon, authenticated;

alter table public.cardiolink_prestacion_templates enable row level security;

revoke all privileges on table public.cardiolink_prestacion_templates
  from public, anon, authenticated;

-- Lectura para cualquier rol interno activo (uso futuro: pantalla de
-- administracion de plantillas; hoy tambien la usan las Edge Functions,
-- pero esas leen con service_role y no dependen de esta policy).
-- Sin INSERT/UPDATE/DELETE desde cliente en V1: se editan desde Table
-- Editor con la cuenta del dueño del proyecto.
grant select on table public.cardiolink_prestacion_templates to authenticated;

create policy cardiolink_prestacion_templates_select
on public.cardiolink_prestacion_templates
for select to authenticated
using (public.cardiolink_has_communications_access());

-- Semillas: mismo contenido/tono que app.js textoWsTurno350() (v3.4,
-- "Plantillas WS 3.4"), la unica fuente de instrucciones por prestacion que
-- ya existia en el proyecto antes de este modulo. No se inventa ninguna
-- instruccion medica nueva: se reusa el texto existente, ahora editable.
insert into public.cardiolink_prestacion_templates
  (prestacion_normalizada, prestacion_label, instrucciones_paciente, asunto_email, plantilla_confirmacion, plantilla_recordatorio, plantilla_reprogramacion, plantilla_cancelacion)
values
  ('_default', 'Respaldo general',
   'Traer DNI y orden/bono o autorización si corresponde.',
   'Turno CardioLink',
   'Hola {{paciente}}. Confirmamos su turno para {{prestacion}} el {{fecha}}{{hora}} con {{profesional}}.{{direccion}} {{instrucciones}}',
   'Hola {{paciente}}. Le recordamos su turno para {{prestacion}} el {{fecha}}{{hora}} con {{profesional}}.{{direccion}} {{instrucciones}}',
   'Hola {{paciente}}. Su turno para {{prestacion}} fue reprogramado para el {{fecha}}{{hora}} con {{profesional}}.{{direccion}} {{instrucciones}}',
   'Hola {{paciente}}. Su turno para {{prestacion}} del {{fecha}}{{hora}} fue cancelado. Ante cualquier consulta, comuníquese con el consultorio.'),
  ('holter', 'Holter',
   'Traer DNI, orden/bono o autorización si corresponde. El equipo se retira según indicación del consultorio.',
   'Turno para Holter — CardioLink',
   'Hola {{paciente}}. Confirmamos su turno para Holter el {{fecha}}{{hora}} con {{profesional}}.{{direccion}} {{instrucciones}}',
   'Hola {{paciente}}. Le recordamos su turno para Holter el {{fecha}}{{hora}} con {{profesional}}.{{direccion}} {{instrucciones}}',
   'Hola {{paciente}}. Su turno para Holter fue reprogramado para el {{fecha}}{{hora}} con {{profesional}}.{{direccion}} {{instrucciones}}',
   'Hola {{paciente}}. Su turno para Holter del {{fecha}}{{hora}} fue cancelado. Ante cualquier consulta, comuníquese con el consultorio.'),
  ('mapa', 'MAPA',
   'Traer DNI, orden/bono o autorización si corresponde. Venir con ropa cómoda para la colocación del equipo.',
   'Turno para MAPA — CardioLink',
   'Hola {{paciente}}. Confirmamos su turno para MAPA el {{fecha}}{{hora}} con {{profesional}}.{{direccion}} {{instrucciones}}',
   'Hola {{paciente}}. Le recordamos su turno para MAPA el {{fecha}}{{hora}} con {{profesional}}.{{direccion}} {{instrucciones}}',
   'Hola {{paciente}}. Su turno para MAPA fue reprogramado para el {{fecha}}{{hora}} con {{profesional}}.{{direccion}} {{instrucciones}}',
   'Hola {{paciente}}. Su turno para MAPA del {{fecha}}{{hora}} fue cancelado. Ante cualquier consulta, comuníquese con el consultorio.'),
  ('eco', 'Eco / estudio',
   'Traer DNI, estudios previos si tiene y orden/bono o autorización si corresponde.',
   'Turno para ecografía — CardioLink',
   'Hola {{paciente}}. Confirmamos su turno para {{prestacion}} el {{fecha}}{{hora}} con {{profesional}}.{{direccion}} {{instrucciones}}',
   'Hola {{paciente}}. Le recordamos su turno para {{prestacion}} el {{fecha}}{{hora}} con {{profesional}}.{{direccion}} {{instrucciones}}',
   'Hola {{paciente}}. Su turno para {{prestacion}} fue reprogramado para el {{fecha}}{{hora}} con {{profesional}}.{{direccion}} {{instrucciones}}',
   'Hola {{paciente}}. Su turno para {{prestacion}} del {{fecha}}{{hora}} fue cancelado. Ante cualquier consulta, comuníquese con el consultorio.'),
  ('consulta', 'Consulta',
   'Traer DNI y orden/bono o autorización si corresponde.',
   'Turno de consulta — CardioLink',
   'Hola {{paciente}}. Confirmamos su turno de consulta el {{fecha}}{{hora}} con {{profesional}}.{{direccion}} {{instrucciones}}',
   'Hola {{paciente}}. Le recordamos su turno de consulta el {{fecha}}{{hora}} con {{profesional}}.{{direccion}} {{instrucciones}}',
   'Hola {{paciente}}. Su turno de consulta fue reprogramado para el {{fecha}}{{hora}} con {{profesional}}.{{direccion}} {{instrucciones}}',
   'Hola {{paciente}}. Su turno de consulta del {{fecha}}{{hora}} fue cancelado. Ante cualquier consulta, comuníquese con el consultorio.');

-- ---------------------------------------------------------------------------
-- 3) Direccion/sede del consultorio (opcional). Tabla singleton: exactamente
--    una fila siempre (el truco id boolean primary key default true, check
--    (id) evita que exista una segunda fila). Nunca obligatoria: el token
--    {{direccion}} de una plantilla queda vacio si no esta configurada.
-- ---------------------------------------------------------------------------

create table public.cardiolink_comunicaciones_config (
  id boolean primary key default true,
  direccion_consultorio text null,
  updated_at timestamptz not null default clock_timestamp(),
  updated_by uuid null,

  constraint cardiolink_comunicaciones_config_singleton_ck check (id)
);

comment on table public.cardiolink_comunicaciones_config is
  'Configuracion global de Patient Communications V1. Una unica fila. '
  'direccion_consultorio es opcional: si es NULL, el token {{direccion}} '
  'de las plantillas queda vacio. Sin pantalla de administracion en V1: '
  'se edita desde Table Editor de Supabase.';

insert into public.cardiolink_comunicaciones_config (id, direccion_consultorio) values (true, null);

alter table public.cardiolink_comunicaciones_config enable row level security;

revoke all privileges on table public.cardiolink_comunicaciones_config
  from public, anon, authenticated;

grant select on table public.cardiolink_comunicaciones_config to authenticated;

create policy cardiolink_comunicaciones_config_select
on public.cardiolink_comunicaciones_config
for select to authenticated
using (public.cardiolink_has_communications_access());

-- ---------------------------------------------------------------------------
-- 4) Registro de comunicaciones. Unico punto de escritura: la Edge Function
--    patient-communications / patient-reminders-24h, con service_role (que
--    bypasea RLS por diseño de Supabase). El cliente autenticado solo puede
--    LEER su historial (para consultarlo como historial del paciente);
--    no hay policy de INSERT/UPDATE/DELETE para authenticated a proposito -
--    evita que cualquier sesion pueda falsear un status='sent' o inventar
--    un provider_message_id.
-- ---------------------------------------------------------------------------

create table public.cardiolink_communications (
  id uuid primary key default gen_random_uuid(),
  paciente_id text null
    references public.cardiolink_pacientes (id)
    on update restrict on delete restrict,
  -- Sin FK: cardiolink_atenciones usa un esquema de payload JSON, sin
  -- identidad relacional propia todavia (mismo limite ya documentado en
  -- cardiolink_appointment_requests.assigned_attention_id).
  atencion_id text null,
  tipo text not null,
  canal text not null,
  destinatario text not null,
  -- De quien es el destinatario resuelto: el paciente mismo, o el contacto
  -- responsable/familiar de su ficha (cardiolink_pacientes.contacto_responsable_*)
  -- cuando el paciente no tenia ese canal cargado. recipient_name es el
  -- nombre correspondiente a esa fuente (nombre del paciente, o
  -- contacto_responsable_nombre) - nunca un dato clinico adicional.
  recipient_source text null,
  recipient_name text null,
  subject text null,
  message text not null,
  status text not null default 'pending',
  provider text null,
  provider_message_id text null,
  error_message text null,
  created_at timestamptz not null default clock_timestamp(),
  sent_at timestamptz null,
  created_by uuid null,

  constraint cardiolink_communications_tipo_ck
    check (tipo in ('confirmation', 'reminder', 'reschedule', 'cancellation', 'manual')),
  constraint cardiolink_communications_canal_ck
    check (canal in ('email', 'whatsapp')),
  constraint cardiolink_communications_recipient_source_ck
    check (recipient_source is null or recipient_source in ('patient', 'responsible_contact')),
  constraint cardiolink_communications_status_ck
    check (status in ('pending', 'sent', 'failed', 'opened', 'manual_started')),
  constraint cardiolink_communications_destinatario_ck
    check (btrim(destinatario) <> ''),
  constraint cardiolink_communications_message_ck
    check (btrim(message) <> ''),
  constraint cardiolink_communications_subject_email_ck
    check (canal <> 'email' or subject is not null),
  constraint cardiolink_communications_sent_ck
    check ((status in ('sent', 'opened', 'manual_started')) = (sent_at is not null))
);

comment on table public.cardiolink_communications is
  'Historial de comunicaciones enviadas/iniciadas a pacientes (email/WhatsApp). '
  'Unico escritor: las Edge Functions patient-communications y '
  'patient-reminders-24h, via service_role. El cliente autenticado solo lee.';
comment on column public.cardiolink_communications.atencion_id is
  'Referencia informativa (String(atencion.id) de cardiolink_atenciones.payload), '
  'sin FK: esa tabla usa un esquema de payload JSON sin identidad relacional propia.';
comment on column public.cardiolink_communications.recipient_source is
  'patient: el canal usado es del paciente mismo. responsible_contact: el '
  'paciente no tenia ese canal cargado y se uso el contacto responsable/ '
  'familiar de su ficha. NULL en filas previas a este campo.';
comment on column public.cardiolink_communications.recipient_name is
  'Nombre de quien recibio efectivamente el mensaje (paciente o contacto '
  'responsable, segun recipient_source). Nunca un dato clinico.';
comment on column public.cardiolink_communications.created_by is
  'Snapshot de auth.uid() de quien origino el envio (null para el proceso '
  'automatico de recordatorio 24h). Sin FK a auth.users a proposito: una '
  'purga posterior de la cuenta no debe mutar ni bloquear el historial.';
comment on column public.cardiolink_communications.status is
  'pending: fila recien creada, en camino (no deberia persistir asi - las '
  'Edge Functions siempre insertan ya con el resultado final). sent: '
  'entregado al proveedor. failed: fallo el envio (ver error_message). '
  'opened: reservado para tracking futuro de apertura de email, no usado '
  'en V1. manual_started: WhatsApp - se abrio wa.me con el mensaje, sin '
  'confirmacion de entrega real posible.';

-- Evita recordatorios duplicados para el mismo turno: idempotencia real a
-- nivel de base de datos, no solo logica en la Edge Function.
create unique index cardiolink_communications_reminder_unica_uq
  on public.cardiolink_communications (atencion_id, tipo)
  where tipo = 'reminder' and atencion_id is not null;

create index cardiolink_communications_paciente_idx
  on public.cardiolink_communications (paciente_id, created_at desc);

create index cardiolink_communications_atencion_idx
  on public.cardiolink_communications (atencion_id);

alter table public.cardiolink_communications enable row level security;

revoke all privileges on table public.cardiolink_communications
  from public, anon, authenticated;

grant select on table public.cardiolink_communications to authenticated;

create policy cardiolink_communications_select
on public.cardiolink_communications
for select to authenticated
using (public.cardiolink_has_communications_access());

-- Sin policies de insert/update/delete para authenticated: service_role
-- (Edge Functions) bypasea RLS por diseño de Supabase, no necesita ninguna.

-- ---------------------------------------------------------------------------
-- 5) Recordatorio 24h: parseo seguro de fecha+hora del turno y funcion que
--    devuelve los candidatos de la ventana actual. Se usan desde
--    patient-reminders-24h via service_role. No son objetos temporales
--    (a diferencia de las funciones de un backfill puntual): se llaman
--    periodicamente, quedan como parte permanente del esquema.
-- ---------------------------------------------------------------------------

-- Un cast directo ((payload->>'fecha')::date + (payload->>'horaInicio')::time)
-- no es seguro: cualquier fecha/hora con formato roto rompe TODA la consulta,
-- no solo esa fila. Misma logica defensiva que ya uso el backfill de
-- pacientes (BEGIN/EXCEPTION + validacion de forma antes de castear). Si
-- falta la hora o esta mal formada, se devuelve NULL a proposito: sin hora
-- confiable no se envia un recordatorio "aproximado" - se omite ese turno
-- en vez de adivinar un horario.
--
-- ZONA HORARIA: fecha/horaInicio son hora local de Argentina (asi las
-- carga el consultorio, sin offset). Castear "date + time" directo a
-- timestamptz NO alcanza: Postgres interpreta un timestamp sin zona segun
-- el TimeZone de la SESION (UTC por defecto en Supabase), no segun donde
-- esta el consultorio - un turno a las 14:00 ART se leeria como 14:00 UTC
-- (=11:00 ART), un corrimiento de 3 horas que rompe por completo la
-- ventana de "24 horas antes". Por eso se usa "AT TIME ZONE
-- 'America/Argentina/Buenos_Aires'" de forma explicita: convierte el valor
-- naive interpretandolo SIEMPRE como hora de Argentina, sin depender de
-- ninguna configuracion de sesion/servidor. Argentina no tiene horario de
-- verano desde 2009 (UTC-3 fijo), asi que esta conversion no tiene
-- ambiguedad de DST que resolver.
create function public.cardiolink_intentar_datetime_turno(fecha_texto text, hora_texto text)
returns timestamptz
language plpgsql
stable
as $function$
declare
  candidata timestamptz;
begin
  if fecha_texto is null or btrim(fecha_texto) = '' then return null; end if;
  if btrim(fecha_texto) !~ '^\d{4}-\d{2}-\d{2}' then return null; end if;
  if hora_texto is null or btrim(hora_texto) = '' then return null; end if;
  begin
    candidata := (
      (substring(btrim(fecha_texto) from 1 for 10)::date + btrim(hora_texto)::time)
      at time zone 'America/Argentina/Buenos_Aires'
    );
  exception when others then
    return null;
  end;
  return candidata;
end;
$function$;

comment on function public.cardiolink_intentar_datetime_turno(text, text) is
  'Combina fecha+horaInicio de una atencion en un timestamptz, sin arriesgar '
  'romper la consulta completa si el formato esta roto (devuelve NULL). '
  'Usada por cardiolink_atenciones_para_recordatorio_24h().';

revoke all privileges on function public.cardiolink_intentar_datetime_turno(text, text)
  from public, anon, authenticated;
grant execute on function public.cardiolink_intentar_datetime_turno(text, text) to service_role;

-- Ventana de 30 minutos, acoplada a la cadencia de 30 minutos del cron job
-- (ver migracion 20260828121000, opcional/separada): cada turno confirmado
-- cae en exactamente una corrida. Solo lee cardiolink_atenciones (nunca la
-- escribe); excluye la fila tecnica de config igual que el resto del
-- proyecto.
create function public.cardiolink_atenciones_para_recordatorio_24h()
returns table (id text, payload jsonb)
language sql
stable
set search_path = pg_catalog, public
as $function$
  select a.id, a.payload
    from public.cardiolink_atenciones a
   where a.id <> '__cardiolink_config_v1'
     and coalesce(a.payload ->> 'estadoTurno', '') = 'confirmado'
     and public.cardiolink_intentar_datetime_turno(a.payload ->> 'fecha', a.payload ->> 'horaInicio')
         between (now() + interval '24 hours') and (now() + interval '24 hours 30 minutes');
$function$;

comment on function public.cardiolink_atenciones_para_recordatorio_24h() is
  'Turnos confirmados cuyo instante (fecha+hora) cae entre ahora+24h y '
  'ahora+24h30m. Llamada por patient-reminders-24h via service_role cada '
  '30 minutos. No es la unica proteccion contra duplicados: ver el indice '
  'unico parcial cardiolink_communications_reminder_unica_uq.';

revoke all privileges on function public.cardiolink_atenciones_para_recordatorio_24h()
  from public, anon, authenticated;
grant execute on function public.cardiolink_atenciones_para_recordatorio_24h() to service_role;

commit;
