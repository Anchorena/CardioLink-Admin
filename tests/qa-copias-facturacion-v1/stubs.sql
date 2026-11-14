-- Stubs mínimos de Supabase + objetos de Production que el SQL de Copias para facturación necesita (copiados de las definiciones versionadas en el repo).
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema auth;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

create schema storage;
create table storage.buckets (id text primary key, name text not null, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (
  id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text, owner uuid,
  created_at timestamptz default now(), updated_at timestamptz default now(), unique (bucket_id, name));
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated, service_role;
grant select, insert, update, delete on storage.objects to authenticated;
grant select on storage.buckets to authenticated;
insert into storage.buckets (id, name, public) values ('patient-documents', 'patient-documents', false);

create table public.cardiolink_user_roles (
  user_id uuid primary key, base_role text not null, active boolean not null default true, professional_id text, cardiolink_user_key text);
create table public.cardiolink_secretaria_medicos (
  secretaria_user_id uuid not null, medico_user_id uuid not null, activo boolean not null default true, primary key (secretaria_user_id, medico_user_id));

CREATE OR REPLACE FUNCTION public.cardiolink_ctx_rol_v1()
 RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog', 'public'
AS $f$
 SELECT r.base_role FROM public.cardiolink_user_roles r
 WHERE auth.uid() IS NOT NULL AND r.user_id=auth.uid() AND r.active IS TRUE
$f$;
REVOKE ALL ON FUNCTION public.cardiolink_ctx_rol_v1() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cardiolink_ctx_rol_v1() TO authenticated;
CREATE OR REPLACE FUNCTION public.cardiolink_ctx_prof_v1()
 RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog', 'public'
AS $f$
 SELECT r.professional_id FROM public.cardiolink_user_roles r
 WHERE auth.uid() IS NOT NULL AND r.user_id=auth.uid() AND r.active IS TRUE AND r.base_role='medico'
   AND r.professional_id ~ '^[A-Za-z0-9_.-]{1,64}$'
$f$;
REVOKE ALL ON FUNCTION public.cardiolink_ctx_prof_v1() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cardiolink_ctx_prof_v1() TO authenticated;

-- 4C-1 §3 (con la tabla de asociaciones ya resuelta)
CREATE FUNCTION public.cardiolink_profesionales_autorizados_secretaria_v1()
 RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $body$
 SELECT coalesce(array_agg(DISTINCT m.professional_id), ARRAY[]::text[])
   FROM public.cardiolink_user_roles s
   JOIN public.cardiolink_secretaria_medicos a ON a.secretaria_user_id = s.user_id AND a.activo IS TRUE
   JOIN public.cardiolink_user_roles m ON m.user_id = a.medico_user_id AND m.active IS TRUE AND coalesce(m.professional_id, '') <> ''
  WHERE s.user_id = auth.uid() AND s.active IS TRUE AND s.base_role = 'secretaria'
$body$;
CREATE FUNCTION public.cardiolink_secretaria_autorizada_prof_v1(p_prof text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $f$
 SELECT coalesce(p_prof, '') <> '' AND p_prof = ANY (public.cardiolink_profesionales_autorizados_secretaria_v1())
$f$;
REVOKE ALL ON FUNCTION public.cardiolink_profesionales_autorizados_secretaria_v1() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cardiolink_secretaria_autorizada_prof_v1(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cardiolink_profesionales_autorizados_secretaria_v1() TO authenticated;
GRANT EXECUTE ON FUNCTION public.cardiolink_secretaria_autorizada_prof_v1(text) TO authenticated;

-- Política restrictiva de 4C-1 sobre storage.objects (filtra por bucket): debe NO interferir con billing-copies
CREATE POLICY cardiolink_patient_documents_storage_select_4c1 ON storage.objects
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (bucket_id <> 'patient-documents' OR (SELECT public.cardiolink_ctx_rol_v1()) IN ('owner', 'admin'));
CREATE POLICY cardiolink_patient_documents_storage_insert_4c1 ON storage.objects
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (bucket_id <> 'patient-documents' OR (SELECT public.cardiolink_ctx_rol_v1()) IN ('owner', 'admin', 'medico'));

create table public.cardiolink_atenciones (id text primary key, payload jsonb not null);
insert into public.cardiolink_atenciones values
  ('201', '{"pacienteId":"pac1","dni":"30.111.222","profesionalId":"rogelio","prestacion":"Holter"}'),
  ('202', '{"pacienteId":"pac9","dni":"99999999","profesionalId":"drago","prestacion":"MAPA"}'),
  ('203', '{"pacienteId":"","dni":"30111222","profesionalId":"rogelio","prestacion":"MAPA"}'),
  ('204', '{"pacienteId":"pacX","dni":"11111111","profesionalId":"rogelio","prestacion":"MAPA"}'),
  ('205', '{"tipoRegistro":"mensaje","pacienteId":"pac1","dni":"30111222","profesionalId":"rogelio"}');

-- Actores
insert into public.cardiolink_user_roles (user_id, base_role, active, professional_id, cardiolink_user_key) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner',      true, 'matias',  'matias'),
  ('00000000-0000-0000-0000-0000000000a2', 'admin',      true, null,      'admin1'),
  ('00000000-0000-0000-0000-0000000000b1', 'medico',     true, 'rogelio', 'rogelio'),
  ('00000000-0000-0000-0000-0000000000b2', 'medico',     true, 'drago',   'drago'),
  ('00000000-0000-0000-0000-0000000000c1', 'secretaria', true, null,      'geraldine'),
  ('00000000-0000-0000-0000-0000000000c2', 'secretaria', true, null,      'otra'),
  ('00000000-0000-0000-0000-0000000000d1', 'medico',     false, 'inactivo','inactivo');
insert into public.cardiolink_secretaria_medicos values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b1', true);
