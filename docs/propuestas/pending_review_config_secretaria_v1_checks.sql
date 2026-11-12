-- Chequeos de SOLO LECTURA del Bloque 4B (STAGING). No escriben nada. Ejecutar ANTES de la etapa A, DESPUÉS de la A, y DESPUÉS de la B,
-- y comparar los resultados 3 y 4 (huellas): las claves clínicas/restringidas deben ser idénticas en las tres corridas mientras no haya escrituras de owner/admin.
-- Las huellas son md5 de cada valor: no revelan contenido clínico y pueden compartirse.

-- 1) Políticas y predicado vigentes
select policyname, permissive, cmd, roles::text, qual, with_check
from pg_policies where schemaname='public' and tablename='cardiolink_atenciones' order by policyname;
select regexp_replace(prosrc,'\s+',' ','g') as cuerpo_predicado
from pg_proc where oid='public.cardiolink_atencion_permitida_v2(jsonb,text,text)'::regprocedure;

-- 2) Funciones del bloque (deben existir tras A; ninguna ejecutable por anon; helpers sin acceso de authenticated; la RPC de guardado: 4 argumentos y 0 con valor por defecto)
select p.oid::regprocedure::text as funcion, p.prosecdef as security_definer, p.pronargs as n_argumentos, p.pronargdefaults as n_con_valor_por_defecto,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_exec
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('cardiolink_config_administrativa_v1','cardiolink_guardar_config_administrativa_v1',
  'cardiolink_config_claves_lectura_sec_v1','cardiolink_config_claves_escritura_sec_v1','cardiolink_config_claves_identidad_v1',
  'cardiolink_config_campos_paciente_v1','cardiolink_config_campos_profesional_admin_v1','cardiolink_config_tipos_doc_sec_v1',
  'cardiolink_config_filtrar_objetos_v1','cardiolink_config_vista_sec_v1','cardiolink_config_vista_escritura_sec_v1',
  'cardiolink_config_paciente_con_clinica_v1','cardiolink_config_fusionar_pacientes_v1','cardiolink_config_fusionar_profesionales_v1',
  'cardiolink_config_unir_auditoria_v1')
order by 1;

-- 3) Huella por clave de primer nivel de config (md5 del valor) + tamaño. Comparar entre corridas.
select e.key as clave, md5(e.value::text) as huella, pg_column_size(e.value) as bytes
from public.cardiolink_atenciones a, jsonb_each(a.payload->'config') e
where a.id='__cardiolink_config_v1' order by e.key;

-- 4) Huella global de la fila y metadatos (no cambia si nadie escribe la config entre corridas)
select md5(payload::text) as huella_payload, updated_at, payload->>'version' as version, payload->>'tipoRegistro' as tipo
from public.cardiolink_atenciones where id='__cardiolink_config_v1';

-- 5) Clasificación de las claves reales de la fila (lectura / escritura / restringida). Tras la etapa A.
select e.key as clave,
       (e.key = any (public.cardiolink_config_claves_lectura_sec_v1()))   as visible_para_secretaria,
       (e.key = any (public.cardiolink_config_claves_escritura_sec_v1())) as escribible_por_secretaria
from public.cardiolink_atenciones a, jsonb_each(a.payload->'config') e
where a.id='__cardiolink_config_v1' order by 2 desc, 3 desc, 1;

-- 6) Claves de las listas que NO existen en la fila (informativo: no es un error)
select k as clave_en_lista_sin_valor
from unnest(public.cardiolink_config_claves_lectura_sec_v1()) k
where not exists (select 1 from public.cardiolink_atenciones a where a.id='__cardiolink_config_v1' and (a.payload->'config') ? k);

-- 7) Sólo la fila de configuración tiene tipoRegistro='config' (la política por payload depende de esto)
select count(*) filter (where id='__cardiolink_config_v1') as filas_config_por_id,
       count(*) filter (where payload->>'tipoRegistro'='config') as filas_config_por_tipo,
       count(*) filter (where payload->>'tipoRegistro'='config' and id<>'__cardiolink_config_v1') as config_con_otro_id
from public.cardiolink_atenciones;

-- 8) Documentos heredados (tras la etapa A): cuántos son legibles por Secretaría (tipo permitido) y cuántos tienen PDF archivado. Sin contenido.
select e->>'tipo' as tipo,
       (e->>'tipo') = any (public.cardiolink_config_tipos_doc_sec_v1()) as legible_por_secretaria,
       count(*) as total,
       count(*) filter (where d.id is null) as sin_pdf_archivado_por_source_document_id
from public.cardiolink_atenciones a
cross join lateral jsonb_array_elements(coalesce(a.payload#>'{config,documentosClinicos}','[]'::jsonb)) e
left join public.cardiolink_patient_documents d on d.source_document_id = e->>'id'
where a.id='__cardiolink_config_v1'
group by 1,2 order by 1;

-- 9) Campos reales de pacientes y profesionales que NO están en las listas anidadas (informativo: se conservan en la fila, pero Secretaría no los ve ni los escribe)
select 'paciente' as elemento, k as campo, count(*) as elementos
from public.cardiolink_atenciones a
cross join lateral jsonb_array_elements(coalesce(a.payload#>'{config,pacientes}','[]'::jsonb)) e
cross join lateral jsonb_object_keys(e) k
where a.id='__cardiolink_config_v1' and not (k = any (public.cardiolink_config_campos_paciente_v1())) group by 1,2
union all
select 'profesional', k, count(*)
from public.cardiolink_atenciones a
cross join lateral jsonb_array_elements(coalesce(a.payload#>'{config,profesionales}','[]'::jsonb)) e
cross join lateral jsonb_object_keys(e) k
where a.id='__cardiolink_config_v1'
  and not (k = any (public.cardiolink_config_campos_profesional_admin_v1() || public.cardiolink_config_claves_identidad_v1())) group by 1,2
order by 1,3 desc;
