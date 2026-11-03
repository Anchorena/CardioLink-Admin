-- CardioLink · Documentos V2A / F3 — Límite de tasa PERSISTENTE para la verificación pública
-- BORRADOR PARA REVISIÓN. NO EJECUTAR sin autorización explícita. Primero STAGING (yslhwdlzdknhskawqrtv); Production sólo con autorización aparte.
-- No está en supabase/migrations a propósito: `supabase db push` no debe poder aplicarla por accidente.
--
-- Por qué: el límite en memoria de la Edge Function es por instancia (se pierde al reiniciar y no se comparte). Esto lo hace compartido y persistente.
-- Qué agrega (y nada más): 1 tabla mínima (cardiolink_verificacion_limites) + 1 función (cardiolink_verificacion_limitar_v1) sólo para service_role.
-- NO modifica tablas, policies, grants ni funciones existentes. Guarda sólo claves opacas (IP hasheada con sal; nunca la IP) y contadores; sin datos clínicos.
-- Dependencia: las tablas V2A de F1 (cardiolink_document_verifications). Rollback: ..._limites_v1_rollback.sql. QA transaccional: ..._limites_v1_tests.sql. Verificación de sólo lectura: ..._limites_v1_checks.sql.
--
-- Revisión de seguridad (permisos / RLS / atomicidad / concurrencia):
--  * Permisos: tabla sin privilegios para public/anon/authenticated; función SECURITY DEFINER con search_path fijo, EXECUTE sólo para service_role (no la alcanza PostgREST con la clave publishable).
--  * RLS: habilitada y sin policies (sólo accede el dueño de la función / service_role); mismo patrón ya probado en F1.
--  * Atomicidad: UN solo INSERT .. ON CONFLICT DO UPDATE; el bloqueo de la fila serializa los intentos concurrentes de una misma clave (no hay lectura-modificación-escritura separada).
--  * Concurrencia: la fila 'global' es un punto caliente (todas las llamadas la actualizan en serie): aceptable para el volumen esperado (una verificación = 2 escrituras cortas); la limpieza usa SKIP LOCKED y no espera.
--  * Límites conocidos: ventana FIJA (una ráfaga en el cambio de ventana puede llegar a 2x el máximo); sin la RPC la función pública responde 503 (fail-closed).

begin;

do $$
begin
  if to_regclass('public.cardiolink_document_verifications') is null then raise exception 'Falta F1: aplicar antes pending_review_documentos_v2a_verificacion_v1.sql'; end if;
  if to_regclass('public.cardiolink_verificacion_limites') is not null or to_regprocedure('public.cardiolink_verificacion_limitar_v1(text,integer,integer)') is not null then
    raise exception 'El límite de tasa ya existe: no se repite'; end if;
end $$;

create table public.cardiolink_verificacion_limites (
  clave          text primary key check (char_length(clave) between 1 and 80 and clave ~ '^[a-z0-9:_-]+$'),   -- 'ip:<hash>' | 'global'
  ventana_inicio timestamptz not null default now(),
  intentos       integer not null default 0 check (intentos >= 0)
);
comment on table public.cardiolink_verificacion_limites is
  'Documentos V2A / F3. Contadores de ventana fija del límite de tasa de la verificación pública. Claves opacas (IP hasheada con sal); sin datos clínicos. Sólo la función cardiolink_verificacion_limitar_v1 (service_role) la usa.';
alter table public.cardiolink_verificacion_limites enable row level security;
revoke all privileges on table public.cardiolink_verificacion_limites from public, anon, authenticated;

-- Ventana fija atómica (INSERT .. ON CONFLICT DO UPDATE toma el bloqueo de la fila): devuelve true si el intento está dentro del máximo.
create function public.cardiolink_verificacion_limitar_v1(p_clave text, p_max integer, p_ventana_seg integer) returns boolean
language plpgsql security definer set search_path = pg_catalog, public as $f$
declare v_n integer;
begin
  if p_clave is null or char_length(p_clave) not between 1 and 80 or p_clave !~ '^[a-z0-9:_-]+$'
     or p_max is null or p_max < 1 or p_max > 100000
     or p_ventana_seg is null or p_ventana_seg < 1 or p_ventana_seg > 86400 then
    raise exception 'Parámetros inválidos' using errcode = '22023';
  end if;
  insert into public.cardiolink_verificacion_limites as l (clave, ventana_inicio, intentos) values (p_clave, now(), 1)
  on conflict (clave) do update set
    intentos       = case when l.ventana_inicio <= now() - make_interval(secs => p_ventana_seg) then 1 else least(l.intentos + 1, 1000000) end,   -- tope: sin desborde
    ventana_inicio = case when l.ventana_inicio <= now() - make_interval(secs => p_ventana_seg) then now() else l.ventana_inicio end
  returning l.intentos into v_n;
  -- Limpieza oportunista y ACOTADA (≈2 % de las llamadas, hasta 50 filas con ventana de más de un día): la tabla no crece sin límite.
  --  * SKIP LOCKED: no espera filas que otra llamada esté usando (sin bloqueos cruzados ni esperas).
  --  * el filtro de antigüedad se repite en el DELETE: si otra llamada refrescó la fila entre la selección y el borrado, Postgres vuelve a evaluarlo y NO la borra.
  if random() < 0.02 then
    delete from public.cardiolink_verificacion_limites
     where ventana_inicio < now() - interval '1 day'
       and clave in (select x.clave from public.cardiolink_verificacion_limites x where x.ventana_inicio < now() - interval '1 day' order by x.ventana_inicio limit 50 for update skip locked);
  end if;
  return v_n <= p_max;
end $f$;

revoke all privileges on function public.cardiolink_verificacion_limitar_v1(text, integer, integer) from public, anon, authenticated;
grant execute on function public.cardiolink_verificacion_limitar_v1(text, integer, integer) to service_role;

do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.cardiolink_verificacion_limites'::regclass) then raise exception 'RLS no habilitada'; end if;
  if has_table_privilege('anon', 'public.cardiolink_verificacion_limites', 'select') or has_table_privilege('authenticated', 'public.cardiolink_verificacion_limites', 'select')
     or has_function_privilege('anon', 'public.cardiolink_verificacion_limitar_v1(text,integer,integer)', 'execute')
     or has_function_privilege('authenticated', 'public.cardiolink_verificacion_limitar_v1(text,integer,integer)', 'execute') then
    raise exception 'El cliente tiene acceso al límite de tasa'; end if;
end $$;

commit;
