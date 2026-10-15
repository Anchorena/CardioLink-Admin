-- CardioLink · Identidad profesional V1 — CHECKS de SOLO LECTURA (sólo SELECT: no modifica nada)
-- Ejecutar en el SQL Editor ANTES y DESPUÉS de aplicar pending_review_identidad_profesional_v1.sql, en cada entorno por separado
-- (primero STAGING; Production sólo con autorización) y comparar. No imprime imágenes ni datos clínicos: sólo estructura y tamaños.

-- 1) ¿Existen las funciones previas y la nueva? (antes: config_medico y ctx_prof sí; guardar_identidad NO. Después: las tres)
select p.proname, pg_get_function_identity_arguments(p.oid) as args, p.prosecdef as security_definer, p.proconfig as config
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('cardiolink_config_medico_v1','cardiolink_ctx_prof_v1','cardiolink_ctx_rol_v1','cardiolink_guardar_identidad_profesional_v1')
order by p.proname;

-- 2) VERSIÓN EXACTA de las 7 funciones existentes (borrador v3.2: pending_review_atenciones_rls_medico_v2.sql). Correr en STAGING y en Production y
--    comparar: md5_actual debe ser IGUAL en ambos entornos y, si se aplicó el borrador tal cual, igual a md5_borrador_v3_2 (coincide_con_borrador = true).
--    Si algún md5 difiere del borrador, NO aplicar: comparar la definición con la consulta 2b. Después de aplicar la migración sólo cambia el md5 de
--    cardiolink_config_medico_v1 (pasa a debe0dc655339cc9002662a8026af927 salvo que cambie la migración; ver coincide_con_identidad_v1).
select p.proname,
       md5(p.prosrc) as md5_actual,
       e.md5_borrador_v3_2,
       md5(p.prosrc) = e.md5_borrador_v3_2 as coincide_con_borrador,
       p.prosecdef as security_definer, p.provolatile as volatilidad, p.proconfig as config,
       case when p.proname='cardiolink_config_medico_v1' then md5(p.prosrc)='debe0dc655339cc9002662a8026af927' end as coincide_con_identidad_v1
from (values
  ('cardiolink_login_cliente_v1',    '232ec1249ecb707f1055b87e9f07ec14'),
  ('cardiolink_ctx_rol_v1',          'c0314d96d77aca02cb16621a9ded79dd'),
  ('cardiolink_ctx_prof_v1',         'b3be4eb62f7a3706abaf38a71b040025'),
  ('cardiolink_config_usuarios_v1',  'e985dcefb95d8a246ea31a422b982b63'),
  ('cardiolink_login_seudonimo_v1',  '4f90e115ef94dec895c386055af60e23'),
  ('cardiolink_logins_propios_v1',   '12ba0bda1630c4bd9d2f17218cc026bc'),
  ('cardiolink_config_medico_v1',    '9f1c507f95530b8ad0b4ea2764114184')
) as e(proname, md5_borrador_v3_2)
left join pg_proc p on p.proname=e.proname and p.pronamespace='public'::regnamespace
order by e.proname;
-- 2b) Definición completa (para comparar a ojo si algún md5 no coincide). No contiene datos, sólo código.
select p.proname, pg_get_functiondef(p.oid) as definicion
from pg_proc p where p.pronamespace='public'::regnamespace
  and p.proname in ('cardiolink_config_medico_v1','cardiolink_ctx_prof_v1','cardiolink_ctx_rol_v1','cardiolink_logins_propios_v1')
order by p.proname;

-- 3) Privilegios de las funciones (esperado: authenticated sí; anon y PUBLIC no)
select 'config_medico' as funcion, has_function_privilege('anon','public.cardiolink_config_medico_v1()','EXECUTE') as anon,
       has_function_privilege('authenticated','public.cardiolink_config_medico_v1()','EXECUTE') as authenticated;
-- (después de aplicar)
-- select 'guardar_identidad' as funcion, has_function_privilege('anon','public.cardiolink_guardar_identidad_profesional_v1(text,jsonb)','EXECUTE') as anon,
--        has_function_privilege('authenticated','public.cardiolink_guardar_identidad_profesional_v1(text,jsonb)','EXECUTE') as authenticated;

-- 4) RLS de cardiolink_atenciones (la RPC es SECURITY DEFINER: si FORCE ROW LEVEL SECURITY estuviera activo, el dueño tampoco la saltearía)
select c.relrowsecurity as rls_habilitada, c.relforcerowsecurity as rls_forzada, pg_get_userbyid(c.relowner) as dueño
from pg_class c where c.oid='public.cardiolink_atenciones'::regclass;
select policyname, cmd, roles from pg_policies where schemaname='public' and tablename='cardiolink_atenciones' order by cmd, policyname;

-- 5) Triggers sobre cardiolink_atenciones (la RPC hace un UPDATE de la fila de config; no debe haber efectos externos inesperados).
--    Antes de la protección opcional: ninguno nuestro. Después: sólo cardiolink_atenciones_proteger_identidad_v1 (tgenabled='O', BEFORE UPDATE, WHEN OLD.id = config).
select t.tgname, t.tgenabled, p.proname as funcion
from pg_trigger t join pg_proc p on p.oid=t.tgfoid
where t.tgrelid='public.cardiolink_atenciones'::regclass and not t.tgisinternal;

-- 6) Roles backend (sin emails): cantidad por rol activo y médicos con su professional_id
select base_role, active, count(*) as cuentas, count(professional_id) as con_professional_id
from public.cardiolink_user_roles group by base_role, active order by base_role, active;
select r.professional_id,
       exists (select 1 from public.cardiolink_atenciones a, jsonb_array_elements(coalesce(a.payload#>'{config,profesionales}','[]'::jsonb)) p
               where a.id='__cardiolink_config_v1' and p->>'id'=r.professional_id) as existe_en_config
from public.cardiolink_user_roles r where r.base_role='medico' and r.active
order by r.professional_id;

-- 7) Identidad guardada hoy por profesional (sólo longitudes y banderas; NO imprime las imágenes)
select p->>'id' as profesional, p->>'nombre' as nombre,
       coalesce(length(p->>'logoDocumentoData'),0) as logo_chars, coalesce(length(p->>'firmaDocumentoData'),0) as firma_chars,
       left(coalesce(p->>'logoDocumentoData',''),22) as logo_prefijo,
       p->>'logoDocumento' as logo_ruta, p->>'marcaDocumento' as marca, p->>'matriculaNacional' as mn, p->>'matriculaProvincial' as mp,
       p->>'colorDocumento' as color, p->>'mostrarFirmaDocumento' as firma_visible
from public.cardiolink_atenciones a, jsonb_array_elements(coalesce(a.payload#>'{config,profesionales}','[]'::jsonb)) p
where a.id='__cardiolink_config_v1' order by 1;

-- 8) La fila de config: tamaño y última actualización (la RPC la reescribe con las imágenes dentro)
select id, pg_column_size(payload) as bytes, updated_at from public.cardiolink_atenciones where id='__cardiolink_config_v1';

-- 9) ¿Prefijos de imagen fuera de lo que valida la RPC (png/jpeg/webp en base64)? Esperado: 0 filas.
--    Si hubiera imágenes existentes con otro formato (p. ej. svg), la RPC rechazaría volver a guardarlas tal cual.
select p->>'id' as profesional, k as campo, left(p->>k,30) as prefijo
from public.cardiolink_atenciones a, jsonb_array_elements(coalesce(a.payload#>'{config,profesionales}','[]'::jsonb)) p,
     unnest(array['logoDocumentoData','firmaDocumentoData']) k
where a.id='__cardiolink_config_v1' and coalesce(p->>k,'')<>'' and (p->>k) !~ '^data:image/(png|jpeg|webp);base64,';
