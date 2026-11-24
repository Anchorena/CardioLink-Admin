-- Stubs mínimos de Supabase + el estado de Production verificado en solo lectura el 2026-11-24 (políticas, privilegios y funciones copiados de las definiciones reales).
-- Parámetro: el HTML ejecuta primero este archivo y, para el escenario "Production", además stubs_legacy.sql (las 5 tablas heredadas, que STAGING no tiene).
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema auth;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

create table public.cardiolink_user_roles (
  user_id uuid primary key, base_role text not null check (base_role in ('owner','admin','medico','secretaria')),
  active boolean not null default true, professional_id text, cardiolink_user_key text);

-- Definiciones REALES (Production = STAGING, md5 c0314d96… y a3a8adfe…)
CREATE OR REPLACE FUNCTION public.cardiolink_ctx_rol_v1()
 RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog', 'public'
AS $function$
 SELECT r.base_role FROM public.cardiolink_user_roles r
 WHERE auth.uid() IS NOT NULL AND r.user_id=auth.uid() AND r.active IS TRUE
$function$;
REVOKE ALL ON FUNCTION public.cardiolink_ctx_rol_v1() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cardiolink_ctx_rol_v1() TO authenticated;

-- Padrón de Production: tabla con RLS activa (no forzada), privilegios completos a anon/authenticated/service_role (como en Supabase), UNA política abierta
create table public.cardiolink_pacientes (id text primary key, nombre_completo text, dni_normalizado text, created_at timestamptz default now());
alter table public.cardiolink_pacientes enable row level security;
grant all on public.cardiolink_pacientes to authenticated, service_role;   -- como en Production y STAGING (verificado): anon NO tiene privilegios sobre el padrón
create policy cardiolink_pacientes_authenticated on public.cardiolink_pacientes as permissive for all to authenticated using (true) with check (true);

CREATE OR REPLACE FUNCTION public.cardiolink_paciente_padron_v1(p_paciente_id text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog', 'public'
AS $function$
 SELECT auth.uid() IS NOT NULL
    AND nullif(btrim(p_paciente_id), '') IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.cardiolink_user_roles r
                 WHERE r.user_id = auth.uid() AND r.active IS TRUE
                   AND (r.base_role IN ('owner', 'admin')
                        OR (r.base_role = 'medico' AND r.professional_id ~ '^[A-Za-z0-9_.-]{1,64}$')))
    AND EXISTS (SELECT 1 FROM public.cardiolink_pacientes p WHERE p.id = p_paciente_id)
$function$;
REVOKE ALL ON FUNCTION public.cardiolink_paciente_padron_v1(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cardiolink_paciente_padron_v1(text) TO authenticated;

-- Tabla hija con FK al padrón (como cardiolink_hc_resumen / cardiolink_communications): la comprobación de la FK no debe depender de la RLS del padrón
create table public.cardiolink_hc_resumen (paciente_id text primary key references public.cardiolink_pacientes(id) on delete cascade, resumen text);
alter table public.cardiolink_hc_resumen enable row level security;
grant all on public.cardiolink_hc_resumen to authenticated, service_role;
create policy cardiolink_hc_resumen_select_v1 on public.cardiolink_hc_resumen for select to authenticated using (public.cardiolink_paciente_padron_v1(paciente_id));
create policy cardiolink_hc_resumen_insert_v1 on public.cardiolink_hc_resumen for insert to authenticated with check (public.cardiolink_paciente_padron_v1(paciente_id));

-- Actores
insert into public.cardiolink_user_roles (user_id, base_role, active, professional_id, cardiolink_user_key) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner',      true,  'matias',  'owner@x'),
  ('00000000-0000-0000-0000-0000000000a2', 'admin',      true,  null,      'admin@x'),
  ('00000000-0000-0000-0000-0000000000b1', 'medico',     true,  'rogelio', 'rogelio@x'),
  ('00000000-0000-0000-0000-0000000000b2', 'medico',     true,  null,      'medico_sin_prof@x'),
  ('00000000-0000-0000-0000-0000000000c1', 'secretaria', true,  null,      'sec@x'),
  ('00000000-0000-0000-0000-0000000000d1', 'medico',     false, 'inactivo','medico_inactivo@x'),
  ('00000000-0000-0000-0000-0000000000d2', 'secretaria', false, null,      'sec_inactiva@x');
-- N = '…e1' es una cuenta de Auth SIN fila en cardiolink_user_roles (no se inserta)

insert into public.cardiolink_pacientes (id, nombre_completo, dni_normalizado) values ('pac_fix_1', 'PACIENTE FIXTURE UNO', '10000001'), ('pac_fix_2', 'PACIENTE FIXTURE DOS', '10000002');
