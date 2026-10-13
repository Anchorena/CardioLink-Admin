-- CardioLink · Bloqueante 1 — DESCUBRIMIENTO DE SOLO LECTURA en STAGING (yslhwdlzdknhskawqrtv)
-- Ejecutar en el SQL Editor de STAGING. NO ejecutar en Production.
-- Sólo SELECT: no modifica nada. No imprime emails ni ids de auth (sólo relaciones y conteos).
-- Pegar los resultados de las 6 consultas para diseñar la identificación estable.

-- 1) ¿Con qué datos cuenta la fila de configuración? (claves de cada usuario configurado)
select k as clave_en_config_usuarios, count(*) as usuarios_con_la_clave
from public.cardiolink_atenciones a,
     jsonb_array_elements(coalesce(a.payload#>'{config,usuarios}','[]'::jsonb)) u,
     jsonb_object_keys(u) k
where a.id='__cardiolink_config_v1'
group by k order by k;

-- 2) Usuarios configurados (sin email ni alias): id, usuario, rol, profesionalId, activo
select u->>'id' as id, u->>'usuario' as usuario, u->>'rol' as rol, u->>'profesionalId' as profesional_id,
       u->>'activo' as activo, jsonb_array_length(coalesce(u->'aliases','[]'::jsonb)) as cant_aliases,
       (u ? 'email') as tiene_email
from public.cardiolink_atenciones a,
     jsonb_array_elements(coalesce(a.payload#>'{config,usuarios}','[]'::jsonb)) u
where a.id='__cardiolink_config_v1' order by 1;

-- 3) Relación REAL entre cuentas (cardiolink_user_roles) y usuarios configurados.
--    No muestra emails: sólo si cada criterio de unión encuentra exactamente 1 usuario configurado.
with cfg as (
  select u->>'id' as id, u->>'usuario' as usuario, u->>'profesionalId' as prof, u->'aliases' as aliases, u->>'email' as email
  from public.cardiolink_atenciones a, jsonb_array_elements(coalesce(a.payload#>'{config,usuarios}','[]'::jsonb)) u
  where a.id='__cardiolink_config_v1'
), cuentas as (
  select r.user_id, r.base_role, r.professional_id, r.active, lower(au.email) as email,
         lower(split_part(au.email,'@',1)) as prefijo
  from public.cardiolink_user_roles r join auth.users au on au.id=r.user_id
)
select c.base_role, c.professional_id, c.active,
  (select count(*) from cfg where cfg.prof is not null and cfg.prof<>'' and cfg.prof=c.professional_id) as por_profesional_id,
  (select count(*) from cfg where lower(cfg.usuario)=c.prefijo) as por_prefijo_vs_usuario,
  (select count(*) from cfg where lower(cfg.id)=c.prefijo) as por_prefijo_vs_id,
  (select count(*) from cfg where cfg.aliases ? c.prefijo) as por_prefijo_vs_alias,
  (select count(*) from cfg where lower(cfg.email)=c.email) as por_email_exacto,
  (select string_agg(distinct cfg.usuario, ',') from cfg where cfg.prof=c.professional_id) as usuario_cfg_por_profesional
from cuentas c order by c.base_role, c.professional_id;

-- 4) Inventario de mensajes internos: destinos y campos de autor presentes
select coalesce(payload->>'destino','(sin destino)') as destino,
       count(*) as mensajes,
       count(*) filter (where payload ? 'creadoUid')     as con_creadoUid,
       count(*) filter (where payload ? 'creadoUsuario') as con_creadoUsuario,
       count(*) filter (where payload ? 'deUsuario')     as con_deUsuario
from public.cardiolink_atenciones where payload->>'tipoRegistro'='mensaje'
group by 1 order by 2 desc;

-- 5) Remitentes y destinatarios históricos que NO corresponden a ningún usuario configurado
with cfg as (
  select lower(u->>'usuario') as usuario from public.cardiolink_atenciones a,
  jsonb_array_elements(coalesce(a.payload#>'{config,usuarios}','[]'::jsonb)) u where a.id='__cardiolink_config_v1'
)
select 'remitente' as tipo, payload->>'deUsuario' as valor, count(*) as mensajes
from public.cardiolink_atenciones where payload->>'tipoRegistro'='mensaje'
  and lower(payload->>'deUsuario') not in (select usuario from cfg) group by 2
union all
select 'destinatario', payload->>'destino', count(*)
from public.cardiolink_atenciones where payload->>'tipoRegistro'='mensaje'
  and payload->>'destino' like 'usuario:%'
  and lower(substr(payload->>'destino',9)) not in (select usuario from cfg) group by 2
order by 1,3 desc;

-- 6) Políticas vigentes sobre cardiolink_atenciones (para el snapshot previo a cualquier cambio)
select policyname, cmd, roles, qual, with_check from pg_policies
where schemaname='public' and tablename='cardiolink_atenciones' order by cmd, policyname;

-- 7) Privilegios EXECUTE actuales de las funciones cardiolink_* (en Supabase REVOKE ... FROM PUBLIC no quita anon/authenticated).
--    Guardar como snapshot; tras aplicar la v3.2 los helpers internos no deben tener anon/authenticated y las RPC no deben tener anon.
select routine_name, grantee, privilege_type
from information_schema.routine_privileges
where routine_schema='public' and routine_name like 'cardiolink\_%' and grantee in ('anon','authenticated','PUBLIC')
order by routine_name, grantee;

-- 8) ¿Todos los professional_id activos cumplen el formato exigido por la v3.2 (^[A-Za-z0-9_.-]{1,64}$)?
--    Un médico activo cuyo professional_id NO cumpla quedaría SIN acceso a atenciones con la v3.2.
select base_role, professional_id, (professional_id ~ '^[A-Za-z0-9_.-]{1,64}$') as formato_valido
from public.cardiolink_user_roles where active and base_role='medico' order by professional_id;

-- 9) Cantidad de médicos, secretarías y owners/admins activos (para saber si el QA necesita una 2ª identidad ficticia)
select base_role, count(*) as activos from public.cardiolink_user_roles where active group by base_role order by base_role;
