-- Bloque 4C-1 · Chequeos de SOLO LECTURA (ejecutables ANTES y DESPUÉS de aplicar pending_review_documentos_seguridad_4c1.sql). No escriben nada; sin contenido clínico (sólo conteos y definiciones).
-- Correr cada consulta por separado. Las marcadas "ANTES" miden el IMPACTO; las marcadas "DESPUÉS" verifican lo instalado.

-- 1) Políticas vigentes de la tabla y de storage.objects. ANTES: 4 restrictivas *_no_img_* / *_no_secretaria. DESPUÉS: 5 restrictivas *_4c1 y ninguna permisiva nueva.
select schemaname, tablename, policyname, permissive, cmd, roles::text, qual, with_check
from pg_policies
where (schemaname='public' and tablename='cardiolink_patient_documents') or (schemaname='storage' and tablename='objects')
order by schemaname, tablename, cmd, permissive desc, policyname;

-- 2) DESPUÉS: funciones del bloque (cuerpo, SECURITY DEFINER y quién puede ejecutarlas) y triggers de la tabla.
select p.oid::regprocedure::text as funcion, p.prosecdef as security_definer, has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_exec, regexp_replace(p.prosrc, '\s+', ' ', 'g') as cuerpo
from pg_proc p where p.pronamespace='public'::regnamespace and (p.proname like '%\_4c1' escape '\' or p.proname in ('cardiolink_tipos_documento_secretaria_v1','cardiolink_paciente_acceso_clinico_v1',
  'cardiolink_profesionales_autorizados_secretaria_v1','cardiolink_secretaria_autorizada_prof_v1','cardiolink_objeto_sin_fila_v1','cardiolink_objeto_asignable_v1','cardiolink_can_delete_clinical_document','cardiolink_historial_envios_documento_v1')) order by 1;
select tgname, tgenabled, pg_get_triggerdef(oid) as definicion from pg_trigger where tgrelid='public.cardiolink_patient_documents'::regclass and not tgisinternal order by tgname;

-- 3) ANTES: ¿hay UNA tabla de asociaciones secretaria-médico? (el SQL la descubre por columnas; si aparecen 0 o 2, no se puede aplicar). Estructura y cantidad de asociaciones activas.
select c.table_name, string_agg(c.column_name || ':' || c.data_type, ', ' order by c.ordinal_position) as columnas, 'select count(*) filter (where activo), count(*) from public.' || quote_ident(c.table_name) || ';' as consulta_sugerida
from information_schema.columns c where c.table_schema='public' and c.table_name in
  (select table_name from information_schema.columns where table_schema='public' and column_name in ('secretaria_user_id','medico_user_id','activo') group by 1 having count(*)=3)
group by c.table_name;

-- 4) ANTES: IMPACTO en los MÉDICOS (transaccional, termina en ROLLBACK; no escribe nada). Por cada médico activo, simula su sesión y usa las MISMAS funciones que usarán las políticas
--    (titularidad = cardiolink_can_delete_clinical_document; acceso clínico = cardiolink_paciente_acceso_clinico_v1). 'dejaria_de_ver' = ni titular ni acceso clínico al paciente.
begin;
create temp table t_imp(profesional text, documentos_totales bigint, titular bigint, solo_por_acceso_clinico bigint, dejaria_de_ver bigint);
do $$
declare m record;
begin
  for m in select user_id, professional_id from public.cardiolink_user_roles where base_role='medico' and active and coalesce(professional_id,'') <> '' order by professional_id loop
    perform set_config('request.jwt.claims', json_build_object('sub', m.user_id, 'role', 'authenticated')::text, true);
    insert into t_imp
      select m.professional_id, count(*),
             count(*) filter (where public.cardiolink_can_delete_clinical_document(d.professional_id, d.uploaded_by)),
             count(*) filter (where not public.cardiolink_can_delete_clinical_document(d.professional_id, d.uploaded_by) and public.cardiolink_paciente_acceso_clinico_v1(d.patient_id)),
             count(*) filter (where not public.cardiolink_can_delete_clinical_document(d.professional_id, d.uploaded_by) and not public.cardiolink_paciente_acceso_clinico_v1(d.patient_id))
        from public.cardiolink_patient_documents d;
  end loop;
end $$;
select * from t_imp order by 1;
rollback;

-- 5) ANTES: IMPACTO en SECRETARÍA por TIPO/RUTA (el filtro por profesional está en 5b). Lo que verá = tipo de la lista y ruta fuera de clinical-images/. Lo que se cierra (esperado: sólo 'Imagen clínica' y 'Mensaje a colega').
with lista as (select array['Constancia','Orden','Certificado','Estudio','Informe','Laboratorio','ECG','ECG y riesgo quirúrgico','Holter','MAPA','Ecocardiograma','Ecografía','Radiografía','Receta','Indicaciones','Apto físico','Otro']::text[] as t)
select d.document_type, count(*) as filas, bool_or(d.document_type = any(((select t from lista))::text[]) and d.storage_path not like 'clinical-images/%') as seguiria_visible_para_secretaria
from public.cardiolink_patient_documents d group by 1 order by seguiria_visible_para_secretaria, filas desc;

-- 5b) ANTES (v2.2): IMPACTO de la regla «Secretaría sólo ve documentos de profesionales con asociación ACTIVA». Transaccional, termina en ROLLBACK. Por cada secretaria activa: sus profesionales autorizados
--     (tabla de asociaciones descubierta por columnas) y cuántos documentos dejaría de ver (de otro profesional, o SIN profesional: éstos quedan cerrados para Secretaría). Sólo conteos.
begin;
create temp table t_imp_sec(secretaria uuid, profesionales_autorizados int, documentos_visibles bigint, de_otro_profesional bigint, sin_profesional bigint);
do $$
declare s record; v_tabla text; v_aut text[];
begin
  select table_name into v_tabla from information_schema.columns where table_schema='public' and column_name in ('secretaria_user_id','medico_user_id','activo') group by table_name having count(*) = 3;
  if v_tabla is null then raise exception 'No hay (o hay más de una) tabla de asociaciones secretaria-médico'; end if;
  for s in select user_id from public.cardiolink_user_roles where base_role = 'secretaria' and active order by user_id loop
    execute format('select coalesce(array_agg(distinct m.professional_id), array[]::text[]) from public.%I a join public.cardiolink_user_roles m on m.user_id = a.medico_user_id and m.active and coalesce(m.professional_id,'''') <> ''''
                    where a.secretaria_user_id = $1 and a.activo is true', v_tabla) into v_aut using s.user_id;
    insert into t_imp_sec
      select s.user_id, coalesce(array_length(v_aut,1),0),
             count(*) filter (where d.professional_id = any (v_aut)),
             count(*) filter (where d.professional_id is not null and not d.professional_id = any (v_aut)),
             count(*) filter (where d.professional_id is null)
        from public.cardiolink_patient_documents d where d.document_type <> 'Imagen clínica' and d.document_type <> 'Mensaje a colega' and d.storage_path not like 'clinical-images/%';
  end loop;
end $$;
select * from t_imp_sec order by 1;
rollback;

-- 6) ANTES: trazabilidad histórica. Filas sin profesional y filas sin autor, por rol del autor (Secretaría deberá elegir profesional autorizado de ahora en más). Sólo conteos.
select coalesce(r.base_role, case when d.uploaded_by is null then '(sin uploaded_by)' else '(usuario sin rol activo)' end) as rol_del_autor,
       count(*) as filas, count(*) filter (where d.professional_id is null) as sin_professional_id, count(*) filter (where d.source_document_id is not null or d.source_payload is not null) as emitidos
from public.cardiolink_patient_documents d left join public.cardiolink_user_roles r on r.user_id = d.uploaded_by and r.active group by 1 order by 1;

-- 7) ANTES/DESPUÉS: Storage. Coherencia fila↔objeto y columnas de dueño del objeto (la excepción "archivo propio recién subido" usa storage.objects.owner: debe estar poblado).
select count(*) as objetos, count(*) filter (where owner is null) as sin_owner,
       count(*) filter (where not exists (select 1 from public.cardiolink_patient_documents d where d.storage_path = o.name)) as sin_fila,
       count(*) filter (where name like 'clinical-images/%') as clinical_images
from storage.objects o where bucket_id='patient-documents';
select column_name, data_type from information_schema.columns where table_schema='storage' and table_name='objects' and column_name in ('owner','owner_id','created_at') order by 1;

-- 7b) ANTES/DESPUÉS: coherencia fila↔archivo↔paciente (sólo conteos). La regla nueva exige que el archivo pertenezca al paciente de la fila y lo haya subido quien inserta la fila.
select count(*) as filas,
       count(*) filter (where not (split_part(d.storage_path,'/',1) = d.patient_id or (split_part(d.storage_path,'/',1) in ('documents','clinical-images') and split_part(d.storage_path,'/',2) = d.patient_id))) as ruta_de_otro_paciente,
       count(*) filter (where o.name is null) as sin_objeto,
       count(*) filter (where o.name is not null and o.owner is distinct from d.uploaded_by) as objeto_con_otro_dueno
from public.cardiolink_patient_documents d left join storage.objects o on o.bucket_id='patient-documents' and o.name = d.storage_path;

-- 7c) ANTES/DESPUÉS: historial de envíos con documento (cardiolink_communications.document_id). Después de aplicar, Secretaría sólo ve las filas de documentos que ella ve.
select tipo, count(*) as filas, count(*) filter (where document_id is not null) as con_documento,
       count(*) filter (where document_id is not null and not exists (select 1 from public.cardiolink_patient_documents d where d.id::text = c.document_id)) as con_documento_inexistente
from public.cardiolink_communications c group by 1 order by 1;

-- 8) DESPUÉS: SIMULACIÓN transaccional (termina en ROLLBACK) de lo que ve cada rol. Requiere una secretaria, un médico y un owner/admin activos.
begin;
create temp table t_act as select
  (select user_id from public.cardiolink_user_roles where base_role='secretaria' and active order by user_id limit 1) as sec,
  (select user_id from public.cardiolink_user_roles where base_role='medico' and active and coalesce(professional_id,'')<>'' order by user_id limit 1) as med,
  (select user_id from public.cardiolink_user_roles where base_role in ('owner','admin') and active order by base_role, user_id limit 1) as own;
grant select on t_act to authenticated;
create temp table t_sim(rol text, documentos bigint, tipos_cerrados_visibles bigint, objetos bigint, objetos_clinical_images bigint);
grant all on t_sim to authenticated;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub',(select sec from t_act),'role','authenticated')::text, true);
insert into t_sim select 'secretaria', (select count(*) from public.cardiolink_patient_documents), (select count(*) from public.cardiolink_patient_documents where document_type in ('Imagen clínica','Mensaje a colega')),
   (select count(*) from storage.objects where bucket_id='patient-documents'), (select count(*) from storage.objects where bucket_id='patient-documents' and name like 'clinical-images/%');
select set_config('request.jwt.claims', json_build_object('sub',(select med from t_act),'role','authenticated')::text, true);
insert into t_sim select 'medico', (select count(*) from public.cardiolink_patient_documents), (select count(*) from public.cardiolink_patient_documents where document_type in ('Imagen clínica','Mensaje a colega')),
   (select count(*) from storage.objects where bucket_id='patient-documents'), (select count(*) from storage.objects where bucket_id='patient-documents' and name like 'clinical-images/%');
select set_config('request.jwt.claims', json_build_object('sub',(select own from t_act),'role','authenticated')::text, true);
insert into t_sim select 'owner/admin', (select count(*) from public.cardiolink_patient_documents), (select count(*) from public.cardiolink_patient_documents where document_type in ('Imagen clínica','Mensaje a colega')),
   (select count(*) from storage.objects where bucket_id='patient-documents'), (select count(*) from storage.objects where bucket_id='patient-documents' and name like 'clinical-images/%');
reset role;
select * from t_sim order by rol;      -- secretaria: tipos_cerrados_visibles = 0 y objetos_clinical_images = 0; owner/admin ve todo
rollback;

-- 9) DESPUÉS (v2.3): historial de envíos POR FUNCIÓN (SECURITY DEFINER). Transaccional (termina en ROLLBACK). Por cada rol simulado: filas que devuelve la función sobre TODOS los document_id con envíos 'document_delivery'
--    y, de ellas, cuántas son de documentos que ESA cuenta no ve en la tabla (la función no usa la RLS, pero debe coincidir con ella). Secretaría: 'de_documentos_que_no_ve' debe ser 0 y 'de_documento_inexistente' 0.
--    Sólo conteos. Requiere una secretaria, un médico y un owner/admin activos.
begin;
create temp table t_act9 as select
  (select user_id from public.cardiolink_user_roles where base_role='secretaria' and active order by user_id limit 1) as sec,
  (select user_id from public.cardiolink_user_roles where base_role='medico' and active and coalesce(professional_id,'')<>'' order by user_id limit 1) as med,
  (select user_id from public.cardiolink_user_roles where base_role in ('owner','admin') and active order by base_role, user_id limit 1) as own;
grant select on t_act9 to authenticated;
create temp table t_ids9 as select array_agg(document_id) as ids from (select distinct document_id from public.cardiolink_communications where tipo = 'document_delivery' and document_id is not null order by 1 limit 500) q;   -- la función acepta hasta 500 ids
grant select on t_ids9 to authenticated;
create temp table t_hist9(rol text, pedidos int, filas_devueltas bigint, de_documentos_que_no_ve bigint, de_documento_inexistente bigint);
grant all on t_hist9 to authenticated;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub',(select sec from t_act9),'role','authenticated')::text, true);
insert into t_hist9 select 'secretaria', coalesce(array_length((select ids from t_ids9),1),0), count(*),
       count(*) filter (where exists (select 1 from public.cardiolink_patient_documents d where d.id::text = r.document_id) is not true),
       count(*) filter (where not exists (select 1 from public.cardiolink_patient_documents d where d.id::text = r.document_id))
  from public.cardiolink_historial_envios_documento_v1((select ids from t_ids9)) r;
select set_config('request.jwt.claims', json_build_object('sub',(select med from t_act9),'role','authenticated')::text, true);
insert into t_hist9 select 'medico', coalesce(array_length((select ids from t_ids9),1),0), count(*), null, null
  from public.cardiolink_historial_envios_documento_v1((select ids from t_ids9)) r;
select set_config('request.jwt.claims', json_build_object('sub',(select own from t_act9),'role','authenticated')::text, true);
insert into t_hist9 select 'owner/admin', coalesce(array_length((select ids from t_ids9),1),0), count(*), null, null
  from public.cardiolink_historial_envios_documento_v1((select ids from t_ids9)) r;
reset role;
select * from t_hist9 order by rol;     -- secretaria: de_documentos_que_no_ve = 0 y de_documento_inexistente = 0; owner/admin: >= lo de los otros roles
rollback;
