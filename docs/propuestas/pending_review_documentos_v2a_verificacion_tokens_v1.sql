-- CardioLink · Documentos V2A / F3 — Control de USO ÚNICO del token de Turnstile en la verificación pública
-- BORRADOR PARA REVISIÓN. NO EJECUTAR sin autorización explícita. Primero STAGING (yslhwdlzdknhskawqrtv); Production sólo con autorización aparte.
-- No está en supabase/migrations a propósito: `supabase db push` no debe poder aplicarla por accidente.
--
-- Por qué: QA real en STAGING (2026-10-31) mostró que Siteverify de Cloudflare aceptó DOS veces el mismo token real (la 3.ª vez respondió timeout-or-duplicate).
-- La garantía de "un token = una verificación" no puede delegarse en Siteverify: este control la impone del lado de CardioLink.
-- Qué agrega (y nada más): 1 tabla mínima (cardiolink_verificacion_tokens_usados) + 1 función (cardiolink_verificacion_token_usar_v1) sólo para service_role.
-- NO modifica tablas, policies, grants ni funciones existentes. Guarda sólo el SHA-256 del token (nunca el token), su hora y su vencimiento; sin datos clínicos ni IP.
-- Dependencia: las tablas V2A de F1. Rollback: ..._tokens_v1_rollback.sql. QA transaccional: ..._tokens_v1_tests.sql. Verificación de sólo lectura: ..._tokens_v1_checks.sql.
--
-- Revisión de seguridad (permisos / RLS / atomicidad / concurrencia):
--  * Permisos: tabla sin privilegios para public/anon/authenticated; función SECURITY DEFINER con search_path fijo, EXECUTE sólo para service_role (no la alcanza PostgREST con la clave publishable).
--  * RLS: habilitada y sin policies (sólo accede el dueño de la función / service_role); mismo patrón ya probado en F1 y en el límite de tasa.
--  * Atomicidad: UN solo INSERT .. ON CONFLICT (token_hash) DO NOTHING; la clave primaria decide en la base quién llegó primero. Devuelve true sólo a quien insertó la fila.
--  * Concurrencia: dos llamadas simultáneas con el mismo hash => la segunda espera la confirmación de la primera y luego cae en el conflicto => false. No hay lectura previa ni condición de carrera.
--    Dos tokens distintos no se bloquean entre sí (filas distintas).
--  * Vencimiento: Cloudflare vence el token a los 300 s; la fila se conserva p_ttl_seg (por defecto 600 s). Un hash vencido que no se haya limpiado SIGUE devolviendo false (nunca se reutiliza).
--  * Limpieza: oportunista y acotada (≈5 % de las llamadas, hasta 50 filas vencidas, SKIP LOCKED); la tabla no crece sin límite. Volumen esperado: una fila por verificación humana resuelta.
--  * Privacidad: el SHA-256 de un token de un solo uso y vida corta no permite reconstruir el token ni vincula a una persona.
--  * Límite conocido: si la función falla (error de base), la Edge Function responde 503 sin consultar certificados (fail-closed); no hay fallback permisivo.

begin;

do $$
begin
  if to_regclass('public.cardiolink_document_verifications') is null then raise exception 'Falta F1: aplicar antes pending_review_documentos_v2a_verificacion_v1.sql'; end if;
  if to_regclass('public.cardiolink_verificacion_tokens_usados') is not null or to_regprocedure('public.cardiolink_verificacion_token_usar_v1(text,integer)') is not null then
    raise exception 'El control de uso único de tokens ya existe: no se repite'; end if;
end $$;

create table public.cardiolink_verificacion_tokens_usados (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),                      -- SHA-256 hexadecimal del token; nunca el token
  creado_en  timestamptz not null default now(),
  expira_en  timestamptz not null,
  check (expira_en > creado_en)
);
create index cardiolink_verificacion_tokens_usados_expira_idx on public.cardiolink_verificacion_tokens_usados (expira_en);
comment on table public.cardiolink_verificacion_tokens_usados is
  'Documentos V2A / F3. Tokens de Turnstile ya consumidos por la verificación pública (sólo el SHA-256). Impone el uso único del lado de CardioLink. Sólo la función cardiolink_verificacion_token_usar_v1 (service_role) la usa.';
alter table public.cardiolink_verificacion_tokens_usados enable row level security;
revoke all privileges on table public.cardiolink_verificacion_tokens_usados from public, anon, authenticated;

-- Consume el token de forma atómica: true = primer uso (se registra); false = ya usado (o vencido y aún no limpiado).
create function public.cardiolink_verificacion_token_usar_v1(p_token_hash text, p_ttl_seg integer default 600) returns boolean
language plpgsql security definer set search_path = pg_catalog, public as $f$
declare v_nuevo boolean;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$'
     or p_ttl_seg is null or p_ttl_seg < 60 or p_ttl_seg > 3600 then
    raise exception 'Parámetros inválidos' using errcode = '22023';
  end if;
  insert into public.cardiolink_verificacion_tokens_usados (token_hash, creado_en, expira_en)
  values (p_token_hash, now(), now() + make_interval(secs => p_ttl_seg))
  on conflict (token_hash) do nothing
  returning true into v_nuevo;
  -- Limpieza oportunista y ACOTADA (≈5 % de las llamadas, hasta 50 filas vencidas):
  --  * SKIP LOCKED: no espera filas que otra llamada esté usando.
  --  * el filtro de vencimiento se repite en el DELETE: no se borra nada vigente.
  --  * borrar una fila vencida es seguro: Cloudflare ya no valida un token de más de 300 s.
  if random() < 0.05 then
    delete from public.cardiolink_verificacion_tokens_usados
     where expira_en < now()
       and token_hash in (select x.token_hash from public.cardiolink_verificacion_tokens_usados x where x.expira_en < now() order by x.expira_en limit 50 for update skip locked);
  end if;
  return coalesce(v_nuevo, false);
end $f$;

revoke all privileges on function public.cardiolink_verificacion_token_usar_v1(text, integer) from public, anon, authenticated;
grant execute on function public.cardiolink_verificacion_token_usar_v1(text, integer) to service_role;

do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.cardiolink_verificacion_tokens_usados'::regclass) then raise exception 'RLS no habilitada'; end if;
  if has_table_privilege('anon', 'public.cardiolink_verificacion_tokens_usados', 'select') or has_table_privilege('authenticated', 'public.cardiolink_verificacion_tokens_usados', 'select')
     or has_function_privilege('anon', 'public.cardiolink_verificacion_token_usar_v1(text,integer)', 'execute')
     or has_function_privilege('authenticated', 'public.cardiolink_verificacion_token_usar_v1(text,integer)', 'execute') then
    raise exception 'El cliente tiene acceso al control de tokens'; end if;
end $$;

commit;
