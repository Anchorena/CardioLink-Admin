-- CardioLink · CHECKS de SOLO LECTURA del historial documental seguro (sólo SELECT: no modifica nada)
-- Ejecutar en el SQL Editor ANTES y DESPUÉS de cada parte, en cada entorno por separado (primero STAGING) y comparar.
-- No imprime mensajes, asuntos, emails ni teléfonos.

-- 1) Policy SELECT vigente de communications (antes: cardiolink_has_communications_access(); tras la PARTE 2: ..._read_access())
select policyname, cmd, roles, qual from pg_policies where schemaname='public' and tablename='cardiolink_communications' order by policyname;

-- 2) Funciones: existencia, SECURITY DEFINER, search_path fijado y quién puede ejecutarlas (anon y public deben dar false)
select p.proname, p.prosecdef as security_definer, p.proconfig as config,
       has_function_privilege('anon', p.oid, 'execute')          as anon_ejecuta,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_ejecuta,
       pg_get_function_result(p.oid) as devuelve
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname='public' and p.proname in ('cardiolink_has_communications_access','cardiolink_has_communications_read_access','cardiolink_historial_envios_documento_v1')
 order by p.proname;

-- 3) La función del historial NO debe devolver message/subject/provider_message_id (0 filas esperadas)
select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname='cardiolink_historial_envios_documento_v1'
   and pg_get_function_result(p.oid) ~* '\y(message|subject|provider_message_id)\y';

-- 4) Privilegios de tabla de communications (authenticated: sólo SELECT; nada de INSERT/UPDATE/DELETE)
select grantee, privilege_type from information_schema.role_table_grants
 where table_schema='public' and table_name='cardiolink_communications' and grantee in ('anon','authenticated','public')
 order by grantee, privilege_type;

-- 5) Cuentas que leen hoy y mañana: rol, activo, vinculado a profesional (sin emails)
select base_role, active, (professional_id is not null) as vinculado_a_profesional, count(*) as cuentas
  from public.cardiolink_user_roles group by 1,2,3 order by 1,2,3;

-- 6) Alcance actual de la exposición: filas por tipo (todas las lee hoy cualquier médico activo)
select tipo, canal, count(*) as filas from public.cardiolink_communications group by 1,2 order by 1,2;

-- 7) Envíos de documentos por atribución del documento: cuántos vería un médico emisor, cuáles quedan sólo para owner/admin/secretaría
select (d.id is not null)            as documento_existe,
       (d.professional_id is not null) as con_professional_id,
       (d.uploaded_by is not null)     as con_uploaded_by,
       count(*) as envios
  from public.cardiolink_communications c
  left join public.cardiolink_patient_documents d on d.id::text = c.document_id
 where c.tipo='document_delivery'
 group by 1,2,3 order by 1,2,3;
