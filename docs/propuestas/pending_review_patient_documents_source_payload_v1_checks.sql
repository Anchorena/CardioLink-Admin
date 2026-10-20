-- CardioLink · Documentos V1 · Bloque A — CHECKS de SOLO LECTURA para source_payload (STAGING: yslhwdlzdknhskawqrtv)
-- Sólo SELECT: no modifica nada. Ejecutar ANTES y DESPUÉS de la migración y pegar los resultados.
-- Los textos clínicos no se imprimen: sólo estructura, conteos y tamaños.

-- 1) ¿Existe la columna? (antes: 0 filas; después: 1 fila jsonb / YES)
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema='public' and table_name='cardiolink_patient_documents' and column_name in ('source_document_id','source_content_hash','source_payload')
order by column_name;

-- 2) CHECK de la columna (después: 1 fila)
select conname, pg_get_constraintdef(oid) as definicion
from pg_constraint
where conrelid='public.cardiolink_patient_documents'::regclass and contype='c'
order by conname;

-- 3) RLS y policies de la tabla (deben ser las mismas antes y después; esperado: RLS=true y 6 policies)
select c.relrowsecurity as rls_habilitada, c.relforcerowsecurity as rls_forzada
from pg_class c where c.oid='public.cardiolink_patient_documents'::regclass;
select policyname, cmd, roles, qual, with_check
from pg_policies where schemaname='public' and tablename='cardiolink_patient_documents'
order by cmd, policyname;

-- 4) Privilegios a nivel TABLA (la columna nueva los hereda). Esperado: authenticated = select/insert/update/delete; anon y PUBLIC = ninguno.
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema='public' and table_name='cardiolink_patient_documents' and grantee in ('anon','authenticated','PUBLIC')
order by grantee, privilege_type;
-- ¿Hay privilegios definidos a nivel de COLUMNA (que NO heredaría una columna nueva)? Esperado: 0 filas.
select attname, attacl
from pg_attribute
where attrelid='public.cardiolink_patient_documents'::regclass and attnum>0 and not attisdropped and attacl is not null;

-- 5) Estado de los datos (sin contenido clínico)
select count(*)                                                     as filas_totales,
       count(*) filter (where source_document_id is not null)       as filas_con_source_id,
       count(*) filter (where document_type = 'Imagen clínica')     as imagenes_clinicas
from public.cardiolink_patient_documents;
-- DESPUÉS de la migración (la columna ya existe): payloads y tamaño máximo
-- select count(*) filter (where source_payload is not null) as con_payload, max(octet_length(source_payload::text)) as bytes_max
-- from public.cardiolink_patient_documents;

-- 6) Triggers de usuario sobre la tabla (antes: ninguno; después: sólo cardiolink_patient_documents_guard_version, tgenabled='O')
select tgname, tgenabled, pg_get_triggerdef(oid) as definicion
from pg_trigger where tgrelid='public.cardiolink_patient_documents'::regclass and not tgisinternal;

-- 7) Funciones/ triggers existentes que toquen esta tabla o sus columnas de versión (esperado antes: 0 filas; el único candidato a futuro es la función guard_version)
select p.proname, pg_get_function_identity_arguments(p.oid) as args, p.prosecdef as security_definer
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and (p.proname ilike '%patient_documents%' or p.prosrc ilike '%cardiolink_patient_documents%')
order by p.proname;

-- 8) Tabla de respaldo del rollback (antes: NULL; después de un rollback: existe)
select to_regclass('public.cardiolink_patient_documents_source_payload_backup') as tabla_respaldo;

-- 9) Triggers/reglas/vistas que dependan de la tabla (esperado antes: ninguno)
select 'regla' as tipo, rulename as nombre from pg_rules where schemaname='public' and tablename='cardiolink_patient_documents'
union all
select 'vista', c.relname from pg_depend d join pg_rewrite r on r.oid=d.objid join pg_class c on c.oid=r.ev_class
 where d.refobjid='public.cardiolink_patient_documents'::regclass and c.relkind in ('v','m') and c.oid<>d.refobjid;

-- 10) Foreign keys de la tabla (evolution_id -> cardiolink_hc_evoluciones esperado)
select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid='public.cardiolink_patient_documents'::regclass and contype='f';

-- 11) Policies de Storage del bucket patient-documents (no cambian con la migración; para el snapshot)
select policyname, cmd, roles from pg_policies where schemaname='storage' and tablename='objects' and (qual ilike '%patient-documents%' or with_check ilike '%patient-documents%') order by policyname;
