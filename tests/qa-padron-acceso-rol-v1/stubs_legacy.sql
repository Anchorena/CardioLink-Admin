-- Las cinco tablas heredadas de PRODUCTION (vacías, una política abierta cada una, como se verificó en solo lectura el 2026-11-24). STAGING no las tiene.
create table public.pacientes (id bigint generated always as identity primary key, nombre text);
create table public.atenciones (id bigint generated always as identity primary key, paciente_id bigint references public.pacientes(id), detalle text);
create table public.medicos (id bigint generated always as identity primary key, nombre text);
create table public.obras_sociales (id bigint generated always as identity primary key, nombre text);
create table public.prestaciones (id bigint generated always as identity primary key, nombre text);
alter table public.pacientes enable row level security;
alter table public.atenciones enable row level security;
alter table public.medicos enable row level security;
alter table public.obras_sociales enable row level security;
alter table public.prestaciones enable row level security;
grant all on public.pacientes, public.atenciones, public.medicos, public.obras_sociales, public.prestaciones to anon, authenticated, service_role;
create policy "Usuarios logueados pueden usar atenciones"      on public.atenciones      as permissive for all to authenticated using (true) with check (true);
create policy "Usuarios logueados pueden usar medicos"         on public.medicos         as permissive for all to authenticated using (true) with check (true);
create policy "Usuarios logueados pueden usar obras sociales"  on public.obras_sociales  as permissive for all to authenticated using (true) with check (true);
create policy "Usuarios logueados pueden usar pacientes"       on public.pacientes       as permissive for all to authenticated using (true) with check (true);
create policy "Usuarios logueados pueden usar prestaciones"    on public.prestaciones    as permissive for all to authenticated using (true) with check (true);
