-- CardioLink · Seguridad clínica V1 · ENSAYO DE INTEGRACIÓN REVERSIBLE (ARCHIVO GENERADO: no editar a mano; ver ..._generar_ensayo_integracion.sh)
-- SOLO STAGING (yslhwdlzdknhskawqrtv), donde 4C-1, 4C-1b y las partes 1-3 ya están aplicadas. NUNCA en Production. Termina SIEMPRE con una excepción informativa: se revierte TODO (sin COMMIT).
-- QUÉ DEMUESTRA (en una transacción): (1) toma la huella del catálogo de los objetos de las partes 1-3; (2) los revierte con los rollback versionados (4C-1b, 4C-1, p3, p2, p1) hasta un estado equivalente a Production;
-- (3) re-aplica p1, p2 y p3 y exige que la huella sea IDÉNTICA a la de STAGING (tablas, columnas, constraints, índices, RLS, políticas, triggers, grants y cuerpos de función); (4) re-aplica 4C-1 y 4C-1b sobre ese estado y corre los checks.
-- RESULTADO: el mensaje de la excepción final. «ENSAYO_INTEGRACION_OK …» = todo pasó. Cualquier otro mensaje = falla (nada queda persistido).
-- SIN EJECUTAR: sintaxis sin validar contra una base.

DO $$
BEGIN
  IF to_regclass('public.cardiolink_secretaria_medicos') IS NULL OR to_regclass('public.cardiolink_paciente_profesionales_v1') IS NULL
     OR to_regprocedure('public.cardiolink_paciente_acceso_clinico_v1(text)') IS NULL OR to_regprocedure('public.cardiolink_tipos_documento_secretaria_v1()') IS NULL
     OR to_regprocedure('public.cardiolink_config_tipos_doc_sec_v1()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'cardiolink_hc_evoluciones_select_v1') THEN
    RAISE EXCEPTION 'El ensayo requiere STAGING con las partes 1-3, 4B, 4C-1 y 4C-1b aplicados. No se hizo nada.'; END IF;
END $$;

BEGIN;
SET LOCAL cardiolink.rollback_confirmado = 'si';

CREATE TEMP TABLE t_huella(fase text PRIMARY KEY, h jsonb);
CREATE FUNCTION pg_temp.huella() RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object(
   'tablas', (SELECT jsonb_object_agg(n, jsonb_build_object(
      'columnas', (SELECT jsonb_agg(jsonb_build_object('c', a.attname, 't', format_type(a.atttypid, a.atttypmod), 'nn', a.attnotnull, 'def', pg_get_expr(d.adbin, d.adrelid), 'ident', a.attidentity) ORDER BY a.attnum)
                     FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=('public.'||n)::regclass AND a.attnum>0 AND NOT a.attisdropped),
      'constraints', (SELECT jsonb_agg(jsonb_build_object('n', conname, 'd', pg_get_constraintdef(oid)) ORDER BY conname) FROM pg_constraint WHERE conrelid=('public.'||n)::regclass),
      'indices', (SELECT jsonb_agg(pg_get_indexdef(i.indexrelid) ORDER BY i.indexrelid::regclass::text) FROM pg_index i WHERE i.indrelid=('public.'||n)::regclass AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid=i.indexrelid)),
      'rls', (SELECT relrowsecurity FROM pg_class WHERE oid=('public.'||n)::regclass),
      'politicas', (SELECT jsonb_agg(jsonb_build_object('n', policyname, 'p', permissive, 'r', roles, 'c', cmd, 'q', qual, 'w', with_check) ORDER BY policyname) FROM pg_policies WHERE schemaname='public' AND tablename=n),
      'triggers', (SELECT jsonb_agg(pg_get_triggerdef(oid) ORDER BY tgname) FROM pg_trigger WHERE tgrelid=('public.'||n)::regclass AND NOT tgisinternal),
      'grants', (SELECT jsonb_agg(jsonb_build_object('g', CASE WHEN e.grantee=0 THEN 'PUBLIC' ELSE (SELECT rolname FROM pg_roles WHERE oid=e.grantee) END, 'p', e.privilege_type) ORDER BY e.grantee, e.privilege_type) FROM pg_class c, LATERAL aclexplode(c.relacl) e WHERE c.oid=('public.'||n)::regclass)
    )) FROM unnest(ARRAY['cardiolink_secretaria_medicos','cardiolink_secretaria_medicos_eventos_v1','cardiolink_paciente_profesionales_v1','cardiolink_paciente_profesionales_eventos_v1','cardiolink_hc_evoluciones','cardiolink_hc_resumen']) AS n),
   'funciones', (SELECT jsonb_object_agg(p.proname, jsonb_build_object('def', pg_get_functiondef(p.oid),
      'grants', (SELECT jsonb_agg(jsonb_build_object('g', CASE WHEN e.grantee=0 THEN 'PUBLIC' ELSE (SELECT rolname FROM pg_roles WHERE oid=e.grantee) END, 'p', e.privilege_type) ORDER BY e.grantee, e.privilege_type) FROM pg_proc q, LATERAL aclexplode(q.proacl) e WHERE q.oid=p.oid)))
      FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname IN ('cardiolink_validar_asociacion_secretaria_medico_v1','cardiolink_auditar_secretaria_medico_v1','cardiolink_asociar_secretaria_medico_v1','cardiolink_listar_asociaciones_v1','cardiolink_auditar_paciente_profesional_v1','cardiolink_asociar_paciente_profesional_v1','cardiolink_paciente_acceso_clinico_v1')))
$f$;
INSERT INTO t_huella SELECT 'inicial', pg_temp.huella();

-- ===== 1) Retroceso hasta un estado equivalente a Production (rollback versionados, en orden inverso) =====
-- ---------- rollback 4C-1b ----------
-- Rollback del Bloque 4C-1b (v2.2): vuelve la lista de tipos heredados legibles por Secretaría a {constancia_atencion} Y la vista de lectura a su definición original (IMMUTABLE, sin filtro por profesional). No toca datos.
CREATE OR REPLACE FUNCTION public.cardiolink_config_tipos_doc_sec_v1()
 RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $f$
 SELECT ARRAY[
  -- TIPOS_DOC_INICIO
  'constancia_atencion'
  -- TIPOS_DOC_FIN
 ]::text[]
$f$;
CREATE OR REPLACE FUNCTION public.cardiolink_config_vista_sec_v1(p_config jsonb)
 RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $f$
 SELECT coalesce(jsonb_object_agg(k,
          CASE
            WHEN k = 'pacientes' AND jsonb_typeof(p_config -> k) = 'array'
              THEN public.cardiolink_config_filtrar_objetos_v1(p_config -> k, public.cardiolink_config_campos_paciente_v1())
            WHEN k = 'profesionales' AND jsonb_typeof(p_config -> k) = 'array'
              THEN public.cardiolink_config_filtrar_objetos_v1(p_config -> k,
                     public.cardiolink_config_campos_profesional_admin_v1() || public.cardiolink_config_claves_identidad_v1())
            WHEN k = 'documentosClinicos' AND jsonb_typeof(p_config -> k) = 'array'
              THEN coalesce((SELECT jsonb_agg(d.x ORDER BY d.ord)
                               FROM jsonb_array_elements(p_config -> k) WITH ORDINALITY AS d(x, ord)
                              WHERE jsonb_typeof(d.x) = 'object' AND (d.x ->> 'tipo') = ANY (public.cardiolink_config_tipos_doc_sec_v1())), '[]'::jsonb)
            ELSE p_config -> k
          END) FILTER (WHERE p_config ? k), '{}'::jsonb)
   FROM unnest(public.cardiolink_config_claves_lectura_sec_v1()) AS k
$f$;
DO $$
BEGIN
  IF (SELECT public.cardiolink_config_tipos_doc_sec_v1()) IS DISTINCT FROM ARRAY['constancia_atencion']::text[] THEN RAISE EXCEPTION 'FALLA: no se restauró la lista'; END IF;
  IF (SELECT provolatile FROM pg_proc WHERE oid = 'public.cardiolink_config_vista_sec_v1(jsonb)'::regprocedure) <> 'i' THEN RAISE EXCEPTION 'FALLA: no se restauró la vista de lectura original'; END IF;
  IF pg_get_functiondef('public.cardiolink_config_vista_sec_v1(jsonb)'::regprocedure) ~ 'profesionalId' THEN RAISE EXCEPTION 'FALLA: la vista de lectura conserva el filtro por profesional'; END IF;
END $$;
-- ---------- rollback 4C-1 ----------
-- Rollback del Bloque 4C-1 (seguridad documental): quita las 6 políticas restrictivas, el trigger y las 7 funciones nuevas, RESTAURA la función del historial de envíos (v2.3: si 4C-1 la REEMPLAZÓ vuelve su cuerpo
-- anterior —el de la PARTE 1 de pending_review_communications_historial_documental_v1—; si 4C-1 la CREÓ, la elimina; se distingue por la marca «[4C-1: …]» de su comentario) y RESTAURA EXACTAMENTE las 4 políticas restrictivas
-- de 'Imagen clínica' de la migración 20261007130000. No toca datos. Las políticas permisivas, DELETE, los triggers previos (actor_guard, guard_version) y cardiolink_paciente_acceso_clinico_v1 no se tocaron y no se tocan.
-- Ejecutar sólo con autorización explícita.

DROP TRIGGER IF EXISTS cardiolink_patient_documents_inmutables_4c1 ON public.cardiolink_patient_documents;
DROP POLICY IF EXISTS cardiolink_patient_documents_select_4c1 ON public.cardiolink_patient_documents;
DROP POLICY IF EXISTS cardiolink_patient_documents_insert_4c1 ON public.cardiolink_patient_documents;
DROP POLICY IF EXISTS cardiolink_patient_documents_update_4c1 ON public.cardiolink_patient_documents;
DROP POLICY IF EXISTS cardiolink_patient_documents_storage_select_4c1 ON storage.objects;
DROP POLICY IF EXISTS cardiolink_patient_documents_storage_insert_4c1 ON storage.objects;
DROP POLICY IF EXISTS cardiolink_communications_select_docs_4c1 ON public.cardiolink_communications;

CREATE POLICY cardiolink_patient_documents_select_no_img_secretaria ON public.cardiolink_patient_documents
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (document_type <> 'Imagen clínica' OR public.cardiolink_can_delete_clinical_documents());

CREATE POLICY cardiolink_patient_documents_insert_no_img_secretaria ON public.cardiolink_patient_documents
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (document_type <> 'Imagen clínica' OR public.cardiolink_can_delete_clinical_documents());

CREATE POLICY cardiolink_clinical_images_storage_select_no_secretaria ON storage.objects
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (bucket_id <> 'patient-documents' OR name NOT LIKE 'clinical-images/%' OR public.cardiolink_can_delete_clinical_documents());

CREATE POLICY cardiolink_clinical_images_storage_insert_no_secretaria ON storage.objects
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (bucket_id <> 'patient-documents' OR name NOT LIKE 'clinical-images/%' OR public.cardiolink_can_delete_clinical_documents());

-- Historial de envíos (v2.3). Se restaura ANTES de quitar las funciones de las que depende su validación de Secretaría.
DO $rb$
BEGIN
  IF to_regprocedure('public.cardiolink_historial_envios_documento_v1(text[])') IS NULL THEN
    NULL;  -- no existe: nada que restaurar
  ELSIF coalesce(obj_description('public.cardiolink_historial_envios_documento_v1(text[])'::regprocedure, 'pg_proc'), '') LIKE '%[4C-1: creada por este bloque]%' THEN
    DROP FUNCTION public.cardiolink_historial_envios_documento_v1(text[]);
  ELSE
    -- la función ya existía (PARTE 1): se restaura su cuerpo anterior, privilegios y comentario
    EXECUTE $orig$
create or replace function public.cardiolink_historial_envios_documento_v1(p_document_ids text[])
returns table (
  id uuid,
  document_id text,
  paciente_id text,
  created_at timestamptz,
  canal text,
  status text,
  destinatario text,
  recipient_name text,
  recipient_source text,
  error_message text,
  creado_por_mi boolean,
  automatico boolean
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  with yo as (
    select bool_or(ur.base_role in ('owner', 'admin', 'secretaria')) as amplio,
           bool_or(ur.base_role = 'medico') as medico,
           max(ur.professional_id) filter (where ur.base_role = 'medico') as professional_id
      from public.cardiolink_user_roles as ur
     where ur.user_id = auth.uid()
       and ur.active
       and ur.base_role in ('owner', 'admin', 'secretaria', 'medico')
  )
  select c.id, c.document_id, c.paciente_id, c.created_at, c.canal, c.status, c.destinatario,
         c.recipient_name, c.recipient_source, c.error_message,
         (c.created_by is not null and c.created_by = auth.uid()) as creado_por_mi,
         (c.created_by is null) as automatico
    from public.cardiolink_communications as c
   cross join yo
   where c.tipo = 'document_delivery'
     and p_document_ids is not null
     and cardinality(p_document_ids) between 1 and 500
     and c.document_id = any (p_document_ids)
     and (
          coalesce(yo.amplio, false)
       or (
            coalesce(yo.medico, false)
        and exists (
              select 1
                from public.cardiolink_patient_documents as d
               where d.id::text = c.document_id
                 and (
                      (d.professional_id is not null and yo.professional_id is not null and d.professional_id = yo.professional_id)
                   or (d.professional_id is null and d.uploaded_by is not null and d.uploaded_by = auth.uid())
                 )
            )
          )
     )
   order by c.created_at asc, c.id asc;
$function$;
    $orig$;
    REVOKE ALL PRIVILEGES ON FUNCTION public.cardiolink_historial_envios_documento_v1(text[]) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.cardiolink_historial_envios_documento_v1(text[]) TO authenticated;
    COMMENT ON FUNCTION public.cardiolink_historial_envios_documento_v1(text[]) IS
      'Historial de envíos de documentos (tipo document_delivery) de los ids pedidos. owner/admin/secretaria: todos; médico: sólo los de documentos que emitió él '
      '(professional_id propio, o sin professional_id y subido por él). Nunca devuelve message, subject ni provider_message_id.';
  END IF;
END $rb$;

DROP FUNCTION IF EXISTS public.cardiolink_patient_documents_inmutables_4c1();
DROP FUNCTION IF EXISTS public.cardiolink_vinculo_documental_v1(text, text, text, boolean);
DROP FUNCTION IF EXISTS public.cardiolink_objeto_sin_fila_v1(text);
DROP FUNCTION IF EXISTS public.cardiolink_secretaria_autorizada_prof_v1(text);
DROP FUNCTION IF EXISTS public.cardiolink_profesionales_autorizados_secretaria_v1();
DROP FUNCTION IF EXISTS public.cardiolink_objeto_asignable_v1(text, text);
DROP FUNCTION IF EXISTS public.cardiolink_tipos_documento_secretaria_v1();

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_policies WHERE policyname IN ('cardiolink_patient_documents_select_no_img_secretaria','cardiolink_patient_documents_insert_no_img_secretaria',
        'cardiolink_clinical_images_storage_select_no_secretaria','cardiolink_clinical_images_storage_insert_no_secretaria') AND permissive='RESTRICTIVE') <> 4 THEN
    RAISE EXCEPTION 'FALLA: no se restauraron las 4 políticas anteriores'; END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE policyname LIKE '%\_4c1' ESCAPE '\') THEN RAISE EXCEPTION 'FALLA: quedaron políticas del Bloque 4C-1'; END IF;
  IF to_regprocedure('public.cardiolink_tipos_documento_secretaria_v1()') IS NOT NULL OR to_regprocedure('public.cardiolink_objeto_asignable_v1(text,text)') IS NOT NULL OR to_regprocedure('public.cardiolink_vinculo_documental_v1(text,text,text,boolean)') IS NOT NULL
     OR to_regprocedure('public.cardiolink_profesionales_autorizados_secretaria_v1()') IS NOT NULL OR to_regprocedure('public.cardiolink_secretaria_autorizada_prof_v1(text)') IS NOT NULL
     OR to_regprocedure('public.cardiolink_objeto_sin_fila_v1(text)') IS NOT NULL OR to_regprocedure('public.cardiolink_patient_documents_inmutables_4c1()') IS NOT NULL THEN
    RAISE EXCEPTION 'FALLA: quedaron funciones del Bloque 4C-1'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='cardiolink_patient_documents' AND policyname='cardiolink_patient_documents_update' AND permissive='PERMISSIVE') THEN
    RAISE EXCEPTION 'FALLA: falta la política permisiva de UPDATE que no debía tocarse'; END IF;
  IF to_regprocedure('public.cardiolink_historial_envios_documento_v1(text[])') IS NOT NULL
     AND (SELECT prosrc FROM pg_proc WHERE oid = 'public.cardiolink_historial_envios_documento_v1(text[])'::regprocedure) LIKE '%cardiolink_profesionales_autorizados_secretaria_v1%' THEN
    RAISE EXCEPTION 'FALLA: la función del historial de envíos sigue dependiendo de funciones de 4C-1'; END IF;
END $$;

-- ---------- rollback p3 ----------
-- CardioLink · Seguridad clínica V1 · ROLLBACK de la PARTE 3 (restaura las políticas abiertas *_authenticated)
-- Recuperado de STAGING (catálogo: pg_get_functiondef / pg_get_constraintdef / pg_policies / aclexplode, 2026-11-13); QA de STAGING aprobado. Versionado para publicar en Production.
-- NO EJECUTAR en Production sin autorización explícita. Una sola transacción, sin DML sobre datos. Falla (y revierte todo) si el estado no es el esperado.
-- Orden de publicación y rollback: docs/propuestas/pending_review_seguridad_clinica_v1_PUBLICACION.md
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND policyname LIKE '%\_authenticated' ESCAPE '\') THEN RAISE EXCEPTION 'Rollback: ya existen políticas *_authenticated (¿ya revertido?)'; END IF;
END $$;
DROP POLICY IF EXISTS cardiolink_hc_evoluciones_delete_v1 ON public.cardiolink_hc_evoluciones;
DROP POLICY IF EXISTS cardiolink_hc_evoluciones_insert_v1 ON public.cardiolink_hc_evoluciones;
DROP POLICY IF EXISTS cardiolink_hc_evoluciones_select_v1 ON public.cardiolink_hc_evoluciones;
DROP POLICY IF EXISTS cardiolink_hc_evoluciones_update_v1 ON public.cardiolink_hc_evoluciones;
DROP POLICY IF EXISTS cardiolink_hc_resumen_delete_v1 ON public.cardiolink_hc_resumen;
DROP POLICY IF EXISTS cardiolink_hc_resumen_insert_v1 ON public.cardiolink_hc_resumen;
DROP POLICY IF EXISTS cardiolink_hc_resumen_select_v1 ON public.cardiolink_hc_resumen;
DROP POLICY IF EXISTS cardiolink_hc_resumen_update_v1 ON public.cardiolink_hc_resumen;

CREATE POLICY cardiolink_hc_evoluciones_authenticated ON public.cardiolink_hc_evoluciones AS PERMISSIVE FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY cardiolink_hc_resumen_authenticated ON public.cardiolink_hc_resumen AS PERMISSIVE FOR ALL TO authenticated USING (true) WITH CHECK (true);

DO $$ BEGIN
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen')) <> 2 THEN RAISE EXCEPTION 'Rollback: estado final inesperado'; END IF;
END $$;
-- ---------- rollback p2 ----------
-- CardioLink · Seguridad clínica V1 · ROLLBACK de la PARTE 2 (quita acceso clínico y vínculos manuales)
-- Recuperado de STAGING (catálogo: pg_get_functiondef / pg_get_constraintdef / pg_policies / aclexplode, 2026-11-13); QA de STAGING aprobado. Versionado para publicar en Production.
-- NO EJECUTAR en Production sin autorización explícita. Una sola transacción, sin DML sobre datos. Falla (y revierte todo) si el estado no es el esperado.
-- Orden de publicación y rollback: docs/propuestas/pending_review_seguridad_clinica_v1_PUBLICACION.md
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND policyname LIKE '%\_v1' ESCAPE '\') THEN RAISE EXCEPTION 'Rollback: revertir antes la PARTE 3 (HC RLS)'; END IF;
  IF to_regprocedure('public.cardiolink_tipos_documento_secretaria_v1()') IS NOT NULL THEN RAISE EXCEPTION 'Rollback: revertir antes 4C-1b y 4C-1 (usan cardiolink_paciente_acceso_clinico_v1)'; END IF;
  IF coalesce(current_setting('cardiolink.rollback_confirmado', true), '') <> 'si' AND (EXISTS (SELECT 1 FROM public.cardiolink_paciente_profesionales_v1) OR EXISTS (SELECT 1 FROM public.cardiolink_paciente_profesionales_eventos_v1)) THEN
    RAISE EXCEPTION 'Las tablas tienen datos: el rollback los DESTRUIRÍA. Si es lo que se quiere, ejecutar antes SET LOCAL cardiolink.rollback_confirmado = ''si''; (después del BEGIN).'; END IF;
END $$;
DROP FUNCTION public.cardiolink_paciente_acceso_clinico_v1(text);
DROP FUNCTION public.cardiolink_asociar_paciente_profesional_v1(text, text, text, boolean);
DROP TABLE public.cardiolink_paciente_profesionales_v1;
DROP TABLE public.cardiolink_paciente_profesionales_eventos_v1;
DROP FUNCTION public.cardiolink_auditar_paciente_profesional_v1();
-- ---------- rollback p1 ----------
-- CardioLink · Seguridad clínica V1 · ROLLBACK de la PARTE 1 (quita asociaciones Secretaría–Médico)
-- Recuperado de STAGING (catálogo: pg_get_functiondef / pg_get_constraintdef / pg_policies / aclexplode, 2026-11-13); QA de STAGING aprobado. Versionado para publicar en Production.
-- NO EJECUTAR en Production sin autorización explícita. Una sola transacción, sin DML sobre datos. Falla (y revierte todo) si el estado no es el esperado.
-- Orden de publicación y rollback: docs/propuestas/pending_review_seguridad_clinica_v1_PUBLICACION.md
DO $$ BEGIN
  IF to_regprocedure('public.cardiolink_profesionales_autorizados_secretaria_v1()') IS NOT NULL THEN RAISE EXCEPTION 'Rollback: revertir antes 4C-1 (usa la tabla de asociaciones)'; END IF;
  IF coalesce(current_setting('cardiolink.rollback_confirmado', true), '') <> 'si' AND (EXISTS (SELECT 1 FROM public.cardiolink_secretaria_medicos) OR EXISTS (SELECT 1 FROM public.cardiolink_secretaria_medicos_eventos_v1)) THEN
    RAISE EXCEPTION 'Las tablas tienen datos: el rollback los DESTRUIRÍA. Si es lo que se quiere, ejecutar antes SET LOCAL cardiolink.rollback_confirmado = ''si''; (después del BEGIN).'; END IF;
END $$;
DROP FUNCTION public.cardiolink_listar_asociaciones_v1();
DROP FUNCTION public.cardiolink_asociar_secretaria_medico_v1(uuid, uuid, boolean);
DROP TABLE public.cardiolink_secretaria_medicos;
DROP TABLE public.cardiolink_secretaria_medicos_eventos_v1;
DROP FUNCTION public.cardiolink_validar_asociacion_secretaria_medico_v1();
DROP FUNCTION public.cardiolink_auditar_secretaria_medico_v1();

-- Estado equivalente a Production: sin tablas/funciones de las partes 1-3 y con las dos políticas abiertas de HC y las 4 políticas anteriores de imagen clínica
DO $$
BEGIN
  IF to_regclass('public.cardiolink_secretaria_medicos') IS NOT NULL OR to_regclass('public.cardiolink_paciente_profesionales_v1') IS NOT NULL OR to_regprocedure('public.cardiolink_paciente_acceso_clinico_v1(text)') IS NOT NULL
     OR to_regprocedure('public.cardiolink_listar_asociaciones_v1()') IS NOT NULL THEN RAISE EXCEPTION 'FALLA I1: tras los rollback quedan objetos de las partes 1-3'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE policyname IN ('cardiolink_hc_evoluciones_authenticated','cardiolink_hc_resumen_authenticated') AND qual = 'true' AND with_check = 'true') <> 2 THEN RAISE EXCEPTION 'FALLA I2: no se restauraron las políticas abiertas de HC'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE policyname IN ('cardiolink_patient_documents_select_no_img_secretaria','cardiolink_patient_documents_insert_no_img_secretaria','cardiolink_clinical_images_storage_select_no_secretaria','cardiolink_clinical_images_storage_insert_no_secretaria')) <> 4 THEN RAISE EXCEPTION 'FALLA I3: no se restauraron las 4 políticas anteriores de imagen clínica'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE policyname LIKE '%\_4c1' ESCAPE '\') <> 0 OR to_regprocedure('public.cardiolink_tipos_documento_secretaria_v1()') IS NOT NULL THEN RAISE EXCEPTION 'FALLA I4: quedan objetos de 4C-1'; END IF;
END $$;

-- ===== 2) Aplicación en el orden de publicación: p1, p2, p3 =====
-- ---------- p1 ----------
-- CardioLink · Seguridad clínica V1 · PARTE 1 · Asociaciones Secretaría–Médico (Bloque 3)
-- Recuperado de STAGING (catálogo: pg_get_functiondef / pg_get_constraintdef / pg_policies / aclexplode, 2026-11-13); QA de STAGING aprobado. Versionado para publicar en Production.
-- NO EJECUTAR en Production sin autorización explícita. Una sola transacción, sin DML sobre datos. Falla (y revierte todo) si el estado no es el esperado.
-- Orden de publicación y rollback: docs/propuestas/pending_review_seguridad_clinica_v1_PUBLICACION.md

DO $$
BEGIN
  IF to_regclass('public.cardiolink_user_roles') IS NULL THEN RAISE EXCEPTION 'Precondición: falta public.cardiolink_user_roles'; END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='cardiolink_user_roles' AND column_name IN ('user_id','base_role','active','professional_id','cardiolink_user_key')) <> 5 THEN
    RAISE EXCEPTION 'Precondición: faltan columnas de cardiolink_user_roles (user_id, base_role, active, professional_id, cardiolink_user_key)'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid='public.cardiolink_user_roles'::regclass AND i.indisunique AND i.indnatts=1
                  AND (SELECT a.attname FROM pg_attribute a WHERE a.attrelid=i.indrelid AND a.attnum=i.indkey[0]) = 'user_id') THEN
    RAISE EXCEPTION 'Precondición: cardiolink_user_roles.user_id debe ser único (clave de las asociaciones)'; END IF;
  IF to_regclass('public.cardiolink_secretaria_medicos') IS NOT NULL OR to_regclass('public.cardiolink_secretaria_medicos_eventos_v1') IS NOT NULL OR to_regprocedure('public.cardiolink_validar_asociacion_secretaria_medico_v1()') IS NOT NULL OR to_regprocedure('public.cardiolink_auditar_secretaria_medico_v1()') IS NOT NULL OR to_regprocedure('public.cardiolink_asociar_secretaria_medico_v1(uuid, uuid, boolean)') IS NOT NULL OR to_regprocedure('public.cardiolink_listar_asociaciones_v1()') IS NOT NULL THEN RAISE EXCEPTION 'La PARTE 1 (asociaciones) ya está aplicado (o parcialmente): no se repite'; END IF;
END $$;

CREATE TABLE public.cardiolink_secretaria_medicos (
  secretaria_user_id uuid NOT NULL,
  medico_user_id uuid NOT NULL,
  activo boolean NOT NULL DEFAULT true,
  creado_en timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT cardiolink_secretaria_medicos_pkey PRIMARY KEY (secretaria_user_id, medico_user_id),
  CONSTRAINT cardiolink_secretaria_medicos_medico_user_id_fkey FOREIGN KEY (medico_user_id) REFERENCES public.cardiolink_user_roles(user_id) ON DELETE CASCADE,
  CONSTRAINT cardiolink_secretaria_medicos_secretaria_user_id_fkey FOREIGN KEY (secretaria_user_id) REFERENCES public.cardiolink_user_roles(user_id) ON DELETE CASCADE,
  CONSTRAINT asociacion_usuarios_distintos CHECK ((secretaria_user_id <> medico_user_id))
);
CREATE INDEX cardiolink_secretaria_medicos_medico_idx ON public.cardiolink_secretaria_medicos USING btree (medico_user_id, secretaria_user_id) WHERE activo;
ALTER TABLE public.cardiolink_secretaria_medicos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.cardiolink_secretaria_medicos FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.cardiolink_secretaria_medicos TO service_role;

CREATE TABLE public.cardiolink_secretaria_medicos_eventos_v1 (
  id bigint GENERATED ALWAYS AS IDENTITY,
  secretaria_user_id uuid NOT NULL,
  medico_user_id uuid NOT NULL,
  activo_anterior boolean,
  activo_nuevo boolean NOT NULL,
  actor uuid NOT NULL,
  registrado_en timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT cardiolink_secretaria_medicos_eventos_v1_pkey PRIMARY KEY (id)
);
ALTER TABLE public.cardiolink_secretaria_medicos_eventos_v1 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.cardiolink_secretaria_medicos_eventos_v1 FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.cardiolink_secretaria_medicos_eventos_v1 TO service_role;

CREATE OR REPLACE FUNCTION public.cardiolink_validar_asociacion_secretaria_medico_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
begin
 if not exists (
   select 1 from public.cardiolink_user_roles u
   where u.user_id=new.secretaria_user_id and u.active and u.base_role='secretaria'
 ) then raise exception 'La secretaria debe tener rol activo de secretaria';
 end if;
 if not exists (
   select 1 from public.cardiolink_user_roles u
   where u.user_id=new.medico_user_id and u.active
     and u.base_role in ('medico','owner')
     and nullif(btrim(u.professional_id),'') is not null
 ) then raise exception 'El profesional debe tener rol activo y professional_id';
 end if;
 return new;
end;
$function$;
REVOKE ALL ON FUNCTION public.cardiolink_validar_asociacion_secretaria_medico_v1() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cardiolink_validar_asociacion_secretaria_medico_v1() TO service_role;

CREATE OR REPLACE FUNCTION public.cardiolink_auditar_secretaria_medico_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
begin
 insert into public.cardiolink_secretaria_medicos_eventos_v1
 (secretaria_user_id,medico_user_id,activo_anterior,activo_nuevo,actor)
 values(new.secretaria_user_id,new.medico_user_id,
 case when tg_op='UPDATE' then old.activo else null end,
 new.activo,auth.uid());
 return new;
end;
$function$;
REVOKE ALL ON FUNCTION public.cardiolink_auditar_secretaria_medico_v1() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cardiolink_auditar_secretaria_medico_v1() TO service_role;

CREATE OR REPLACE FUNCTION public.cardiolink_asociar_secretaria_medico_v1(p_secretaria_user_id uuid, p_medico_user_id uuid, p_activo boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
begin
 if auth.uid() is null or not exists(
   select 1 from public.cardiolink_user_roles r
    where r.user_id=auth.uid() and r.active and r.base_role in ('owner','admin')
 ) then raise exception 'Sin permiso para gestionar asociaciones' using errcode='42501'; end if;
 if p_activo is null or p_secretaria_user_id is null or p_medico_user_id is null then
   raise exception 'Parámetros obligatorios' using errcode='22023'; end if;

 -- Existing validation trigger rejects wrong or inactive roles on upsert.
 insert into public.cardiolink_secretaria_medicos (secretaria_user_id,medico_user_id,activo)
 values(p_secretaria_user_id,p_medico_user_id,p_activo)
 on conflict(secretaria_user_id,medico_user_id) do update set activo=excluded.activo;

 return jsonb_build_object('ok',true,'activo',p_activo);
end;
$function$;
REVOKE ALL ON FUNCTION public.cardiolink_asociar_secretaria_medico_v1(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cardiolink_asociar_secretaria_medico_v1(uuid, uuid, boolean) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.cardiolink_listar_asociaciones_v1()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare v_result jsonb;
begin
 if auth.uid() is null or not exists(
   select 1 from public.cardiolink_user_roles r
    where r.user_id=auth.uid() and r.active and r.base_role in ('owner','admin')
 ) then raise exception 'Sin permiso para ver asociaciones' using errcode='42501'; end if;

 select jsonb_build_object(
   'usuarios',coalesce((
     select jsonb_agg(jsonb_build_object('user_id',u.user_id,'usuario',u.cardiolink_user_key,
       'rol',u.base_role,'profesional_id',u.professional_id) order by u.base_role,u.cardiolink_user_key)
     from public.cardiolink_user_roles u
     where u.active and u.base_role in ('owner','medico','secretaria')
   ),'[]'::jsonb),
   'asociaciones',coalesce((
     select jsonb_agg(jsonb_build_object('secretaria_user_id',m.secretaria_user_id,
       'medico_user_id',m.medico_user_id,'activo',m.activo) order by m.secretaria_user_id,m.medico_user_id)
     from public.cardiolink_secretaria_medicos m
   ),'[]'::jsonb)
 ) into v_result;
 return v_result;
end;
$function$;
REVOKE ALL ON FUNCTION public.cardiolink_listar_asociaciones_v1() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cardiolink_listar_asociaciones_v1() TO authenticated, service_role;

CREATE TRIGGER cardiolink_validar_asociacion_secretaria_medico_v1 BEFORE INSERT OR UPDATE ON public.cardiolink_secretaria_medicos FOR EACH ROW EXECUTE FUNCTION public.cardiolink_validar_asociacion_secretaria_medico_v1();
CREATE TRIGGER cardiolink_secretaria_medicos_auditar_v1 AFTER INSERT OR UPDATE ON public.cardiolink_secretaria_medicos FOR EACH ROW EXECUTE FUNCTION public.cardiolink_auditar_secretaria_medico_v1();

COMMENT ON TABLE public.cardiolink_secretaria_medicos IS 'Seguridad clínica V1: asociaciones secretaria-médico. Sin acceso directo de authenticated; se gestionan con cardiolink_asociar_secretaria_medico_v1 (owner/admin).';
COMMENT ON TABLE public.cardiolink_secretaria_medicos_eventos_v1 IS 'Auditoría de cambios de asociaciones secretaria-médico (actor = auth.uid()).';

-- Postcondiciones
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.cardiolink_secretaria_medicos'::regclass AND NOT tgisinternal) <> 2 THEN RAISE EXCEPTION 'Postcondición: faltan triggers de asociaciones'; END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.cardiolink_secretaria_medicos'::regclass) THEN RAISE EXCEPTION 'Postcondición: RLS apagada en asociaciones'; END IF;
  IF has_table_privilege('authenticated','public.cardiolink_secretaria_medicos','SELECT') OR has_table_privilege('anon','public.cardiolink_secretaria_medicos','SELECT')
     OR has_function_privilege('anon','public.cardiolink_listar_asociaciones_v1()','EXECUTE') THEN RAISE EXCEPTION 'Postcondición: anon/authenticated no deben tocar las tablas ni anon las RPC'; END IF;
  IF NOT has_function_privilege('authenticated','public.cardiolink_asociar_secretaria_medico_v1(uuid,uuid,boolean)','EXECUTE') THEN RAISE EXCEPTION 'Postcondición: authenticated debe poder llamar la RPC (valida owner/admin adentro)'; END IF;
END $$;

-- ---------- p2 ----------
-- CardioLink · Seguridad clínica V1 · PARTE 2 · Acceso clínico médico–paciente (Bloque 4: vínculo manual + predicado)
-- Recuperado de STAGING (catálogo: pg_get_functiondef / pg_get_constraintdef / pg_policies / aclexplode, 2026-11-13); QA de STAGING aprobado. Versionado para publicar en Production.
-- NO EJECUTAR en Production sin autorización explícita. Una sola transacción, sin DML sobre datos. Falla (y revierte todo) si el estado no es el esperado.
-- Orden de publicación y rollback: docs/propuestas/pending_review_seguridad_clinica_v1_PUBLICACION.md

DO $$
BEGIN
  IF to_regclass('public.cardiolink_pacientes') IS NULL OR to_regclass('public.cardiolink_hc_evoluciones') IS NULL OR to_regclass('public.cardiolink_atenciones') IS NULL OR to_regclass('public.cardiolink_user_roles') IS NULL THEN
    RAISE EXCEPTION 'Precondición: faltan cardiolink_pacientes / cardiolink_hc_evoluciones / cardiolink_atenciones / cardiolink_user_roles'; END IF;
  IF (SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='cardiolink_pacientes' AND column_name='id') IS DISTINCT FROM 'text' THEN
    RAISE EXCEPTION 'Precondición: cardiolink_pacientes.id debe ser text'; END IF;
  IF to_regprocedure('public.cardiolink_ctx_rol_v1()') IS NULL OR to_regprocedure('public.cardiolink_ctx_prof_v1()') IS NULL THEN RAISE EXCEPTION 'Precondición: faltan cardiolink_ctx_rol_v1() / cardiolink_ctx_prof_v1()'; END IF;
  IF to_regclass('public.cardiolink_paciente_profesionales_v1') IS NOT NULL OR to_regclass('public.cardiolink_paciente_profesionales_eventos_v1') IS NOT NULL OR to_regprocedure('public.cardiolink_auditar_paciente_profesional_v1()') IS NOT NULL OR to_regprocedure('public.cardiolink_asociar_paciente_profesional_v1(text, text, text, boolean)') IS NOT NULL OR to_regprocedure('public.cardiolink_paciente_acceso_clinico_v1(text)') IS NOT NULL THEN RAISE EXCEPTION 'La PARTE 2 (acceso clínico) ya está aplicado (o parcialmente): no se repite'; END IF;
END $$;

CREATE TABLE public.cardiolink_paciente_profesionales_v1 (
  paciente_id text NOT NULL,
  profesional_id text NOT NULL,
  activo boolean NOT NULL DEFAULT true,
  motivo text NOT NULL,
  actualizado_por uuid NOT NULL,
  actualizado_en timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT cardiolink_paciente_profesionales_v1_pkey PRIMARY KEY (paciente_id, profesional_id),
  CONSTRAINT cardiolink_paciente_profesionales_v1_actualizado_por_fkey FOREIGN KEY (actualizado_por) REFERENCES auth.users(id),
  CONSTRAINT cardiolink_paciente_profesionales_v1_paciente_id_fkey FOREIGN KEY (paciente_id) REFERENCES public.cardiolink_pacientes(id) ON DELETE CASCADE,
  CONSTRAINT cppv1_motivo_length CHECK (((char_length(btrim(motivo)) >= 10) AND (char_length(btrim(motivo)) <= 300))),
  CONSTRAINT cppv1_prof_format CHECK ((profesional_id ~ '^[a-z0-9_.-]{1,64}$'::text))
);
ALTER TABLE public.cardiolink_paciente_profesionales_v1 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.cardiolink_paciente_profesionales_v1 FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.cardiolink_paciente_profesionales_v1 TO service_role;

CREATE TABLE public.cardiolink_paciente_profesionales_eventos_v1 (
  id bigint GENERATED ALWAYS AS IDENTITY,
  paciente_id text NOT NULL,
  profesional_id text NOT NULL,
  activo_anterior boolean,
  activo_nuevo boolean NOT NULL,
  motivo text NOT NULL,
  actor uuid NOT NULL,
  registrado_en timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT cardiolink_paciente_profesionales_eventos_v1_pkey PRIMARY KEY (id)
);
ALTER TABLE public.cardiolink_paciente_profesionales_eventos_v1 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.cardiolink_paciente_profesionales_eventos_v1 FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.cardiolink_paciente_profesionales_eventos_v1 TO service_role;

CREATE OR REPLACE FUNCTION public.cardiolink_auditar_paciente_profesional_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
begin
 insert into public.cardiolink_paciente_profesionales_eventos_v1
 (paciente_id,profesional_id,activo_anterior,activo_nuevo,motivo,actor)
 values(new.paciente_id,new.profesional_id,case when tg_op='UPDATE' then old.activo else null end,
 new.activo,new.motivo,new.actualizado_por);
 return new;
end;
$function$;
REVOKE ALL ON FUNCTION public.cardiolink_auditar_paciente_profesional_v1() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cardiolink_auditar_paciente_profesional_v1() TO service_role;

CREATE OR REPLACE FUNCTION public.cardiolink_asociar_paciente_profesional_v1(p_paciente_id text, p_profesional_id text, p_motivo text, p_activo boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare v_prof text := lower(btrim(coalesce(p_profesional_id,'')));
begin
 if auth.uid() is null or not exists (
   select 1 from public.cardiolink_user_roles r
    where r.user_id=auth.uid() and r.active and r.base_role in ('owner','admin')
 ) then raise exception 'Sin permiso para gestionar vínculos clínicos' using errcode='42501'; end if;

 if nullif(btrim(coalesce(p_paciente_id,'')),'') is null
    or not exists (select 1 from public.cardiolink_pacientes where id=p_paciente_id)
 then raise exception 'Paciente inexistente' using errcode='22023'; end if;

 if v_prof !~ '^[a-z0-9_.-]{1,64}$'
    or not exists(
     select 1 from public.cardiolink_user_roles r
      where r.active and r.base_role in ('owner','medico')
        and lower(btrim(r.professional_id))=v_prof
    )
 then raise exception 'Profesional sin identidad validada' using errcode='22023'; end if;

 if p_motivo is null or char_length(btrim(p_motivo)) not between 10 and 300
 then raise exception 'Motivo obligatorio entre 10 y 300 caracteres' using errcode='22023'; end if;
 if p_activo is null then raise exception 'Estado obligatorio' using errcode='22023'; end if;

 insert into public.cardiolink_paciente_profesionales_v1
      (paciente_id,profesional_id,activo,motivo,actualizado_por,actualizado_en)
 values(p_paciente_id,v_prof,p_activo,btrim(p_motivo),auth.uid(),now())
 on conflict (paciente_id,profesional_id) do update set
    activo=excluded.activo,motivo=excluded.motivo,
    actualizado_por=excluded.actualizado_por,actualizado_en=now();
 return jsonb_build_object('ok',true,'activo',p_activo);
end;
$function$;
REVOKE ALL ON FUNCTION public.cardiolink_asociar_paciente_profesional_v1(text, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cardiolink_asociar_paciente_profesional_v1(text, text, text, boolean) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.cardiolink_paciente_acceso_clinico_v1(p_paciente_id text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare v_usuario uuid := auth.uid(); v_rol text; v_prof text;
begin
 if v_usuario is null or nullif(btrim(p_paciente_id),'') is null then return false; end if;
 select r.base_role,nullif(lower(btrim(r.professional_id)),'')
   into v_rol,v_prof from public.cardiolink_user_roles r
  where r.user_id=v_usuario and r.active;
 if v_rol is null then return false; end if;
 if v_rol in ('owner','admin') then
   return exists(select 1 from public.cardiolink_pacientes p where p.id=p_paciente_id);
 end if;
 if v_rol <> 'medico' or v_prof is null then return false; end if;
 if not exists(select 1 from public.cardiolink_pacientes p where p.id=p_paciente_id) then return false; end if;
 return exists(
   select 1 from public.cardiolink_paciente_profesionales_v1 m
    where m.paciente_id=p_paciente_id and m.profesional_id=v_prof and m.activo
 ) or exists(
   select 1 from public.cardiolink_hc_evoluciones e
    where e.paciente_id=p_paciente_id and lower(btrim(e.profesional_id))=v_prof
 ) or exists(
   select 1 from public.cardiolink_atenciones a
    where a.payload->>'pacienteId'=p_paciente_id
      and lower(btrim(a.payload->>'profesionalId'))=v_prof
 );
end;
$function$;
REVOKE ALL ON FUNCTION public.cardiolink_paciente_acceso_clinico_v1(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cardiolink_paciente_acceso_clinico_v1(text) TO authenticated, service_role;

CREATE TRIGGER cardiolink_paciente_profesionales_audit_v1 AFTER INSERT OR UPDATE ON public.cardiolink_paciente_profesionales_v1 FOR EACH ROW EXECUTE FUNCTION public.cardiolink_auditar_paciente_profesional_v1();

COMMENT ON TABLE public.cardiolink_paciente_profesionales_v1 IS 'Seguridad clínica V1: vínculo clínico manual paciente-profesional; se gestiona con cardiolink_asociar_paciente_profesional_v1 (owner/admin).';
COMMENT ON TABLE public.cardiolink_paciente_profesionales_eventos_v1 IS 'Auditoría de vínculos clínicos manuales paciente-profesional.';
COMMENT ON FUNCTION public.cardiolink_paciente_acceso_clinico_v1(text) IS 'Seguridad clínica V1: acceso clínico por rol del backend y vínculo documentado paciente-profesional (asociación manual activa, evolución o atención). Lo evalúan las políticas de HC y de documentos.';

-- Postcondiciones
DO $$
BEGIN
  IF has_table_privilege('authenticated','public.cardiolink_paciente_profesionales_v1','SELECT') OR has_table_privilege('anon','public.cardiolink_paciente_profesionales_v1','SELECT') THEN RAISE EXCEPTION 'Postcondición: anon/authenticated no deben tocar la tabla de vínculos'; END IF;
  IF NOT has_function_privilege('authenticated','public.cardiolink_paciente_acceso_clinico_v1(text)','EXECUTE') OR has_function_privilege('anon','public.cardiolink_paciente_acceso_clinico_v1(text)','EXECUTE') THEN RAISE EXCEPTION 'Postcondición: permisos de cardiolink_paciente_acceso_clinico_v1'; END IF;
  IF (SELECT prorettype FROM pg_proc WHERE oid='public.cardiolink_paciente_acceso_clinico_v1(text)'::regprocedure) <> 'boolean'::regtype THEN RAISE EXCEPTION 'Postcondición: acceso_clinico debe devolver boolean'; END IF;
END $$;

-- ---------- p3 ----------
-- CardioLink · Seguridad clínica V1 · PARTE 3 · RLS de Historia Clínica por acceso clínico (Bloque 4)
-- Recuperado de STAGING (catálogo: pg_get_functiondef / pg_get_constraintdef / pg_policies / aclexplode, 2026-11-13); QA de STAGING aprobado. Versionado para publicar en Production.
-- NO EJECUTAR en Production sin autorización explícita. Una sola transacción, sin DML sobre datos. Falla (y revierte todo) si el estado no es el esperado.
-- Orden de publicación y rollback: docs/propuestas/pending_review_seguridad_clinica_v1_PUBLICACION.md
-- CAMBIA EL COMPORTAMIENTO: reemplaza las políticas abiertas `*_authenticated` (cualquier usuario autenticado) de cardiolink_hc_evoluciones y cardiolink_hc_resumen por políticas por rol/acceso clínico.
-- Owner/admin: todo. Médico: solo pacientes con vínculo manual activo, evolución o atención propia (y solo escribe evoluciones propias). Secretaría: sin acceso a estas tablas.
-- Las dos políticas nuevas y el DROP de las viejas ocurren en la misma transacción: no hay ventana sin política.
DO $$
BEGIN
  IF to_regprocedure('public.cardiolink_paciente_acceso_clinico_v1(text)') IS NULL THEN RAISE EXCEPTION 'Precondición: aplicar antes la PARTE 2 (cardiolink_paciente_acceso_clinico_v1)'; END IF;
  IF to_regprocedure('public.cardiolink_ctx_rol_v1()') IS NULL OR to_regprocedure('public.cardiolink_ctx_prof_v1()') IS NULL THEN RAISE EXCEPTION 'Precondición: faltan cardiolink_ctx_rol_v1() / cardiolink_ctx_prof_v1()'; END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.cardiolink_hc_evoluciones'::regclass) OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.cardiolink_hc_resumen'::regclass) THEN
    RAISE EXCEPTION 'Precondición: RLS apagada en las tablas de HC'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen')
        AND policyname IN ('cardiolink_hc_evoluciones_authenticated','cardiolink_hc_resumen_authenticated') AND permissive='PERMISSIVE' AND cmd='ALL' AND qual='true' AND with_check='true') <> 2 THEN
    RAISE EXCEPTION 'Precondición: se esperaban exactamente las dos políticas abiertas *_authenticated (cmd ALL, true/true); el estado difiere'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen')) <> 2 THEN
    RAISE EXCEPTION 'Precondición: hay otras políticas en las tablas de HC; revisar antes de continuar'; END IF;
END $$;

CREATE POLICY cardiolink_hc_evoluciones_delete_v1 ON public.cardiolink_hc_evoluciones
  AS PERMISSIVE FOR DELETE TO authenticated
  USING ((cardiolink_paciente_acceso_clinico_v1(paciente_id) AND ((cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text])) OR ((cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1())))))));

CREATE POLICY cardiolink_hc_evoluciones_insert_v1 ON public.cardiolink_hc_evoluciones
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((cardiolink_paciente_acceso_clinico_v1(paciente_id) AND ((cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text])) OR ((cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1())))))));

CREATE POLICY cardiolink_hc_evoluciones_select_v1 ON public.cardiolink_hc_evoluciones
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (cardiolink_paciente_acceso_clinico_v1(paciente_id));

CREATE POLICY cardiolink_hc_evoluciones_update_v1 ON public.cardiolink_hc_evoluciones
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((cardiolink_paciente_acceso_clinico_v1(paciente_id) AND ((cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text])) OR ((cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1())))))))
  WITH CHECK ((cardiolink_paciente_acceso_clinico_v1(paciente_id) AND ((cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text])) OR ((cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1())))))));

CREATE POLICY cardiolink_hc_resumen_delete_v1 ON public.cardiolink_hc_resumen
  AS PERMISSIVE FOR DELETE TO authenticated
  USING (cardiolink_paciente_acceso_clinico_v1(paciente_id));

CREATE POLICY cardiolink_hc_resumen_insert_v1 ON public.cardiolink_hc_resumen
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (cardiolink_paciente_acceso_clinico_v1(paciente_id));

CREATE POLICY cardiolink_hc_resumen_select_v1 ON public.cardiolink_hc_resumen
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (cardiolink_paciente_acceso_clinico_v1(paciente_id));

CREATE POLICY cardiolink_hc_resumen_update_v1 ON public.cardiolink_hc_resumen
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (cardiolink_paciente_acceso_clinico_v1(paciente_id))
  WITH CHECK (cardiolink_paciente_acceso_clinico_v1(paciente_id));

DROP POLICY cardiolink_hc_evoluciones_authenticated ON public.cardiolink_hc_evoluciones;
DROP POLICY cardiolink_hc_resumen_authenticated ON public.cardiolink_hc_resumen;

-- Postcondiciones
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND policyname LIKE '%\_v1' ESCAPE '\') <> 8 THEN RAISE EXCEPTION 'Postcondición: se esperaban 8 políticas _v1'; END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND policyname LIKE '%\_authenticated' ESCAPE '\') THEN RAISE EXCEPTION 'Postcondición: siguen las políticas abiertas'; END IF;
END $$;


INSERT INTO t_huella SELECT 'tras_p1_p2_p3', pg_temp.huella();
DO $$
DECLARE a jsonb; b jsonb; dif text;
BEGIN
  SELECT h INTO a FROM t_huella WHERE fase = 'inicial'; SELECT h INTO b FROM t_huella WHERE fase = 'tras_p1_p2_p3';
  IF a IS DISTINCT FROM b THEN
    SELECT string_agg(k, ', ') INTO dif FROM (
      SELECT 'tabla ' || k || ' [' || coalesce((SELECT string_agg(s, ',') FROM jsonb_object_keys(a->'tablas'->k) s WHERE (a->'tablas'->k->s) IS DISTINCT FROM (b->'tablas'->k->s)), '?') || ']' AS k
        FROM jsonb_object_keys(a->'tablas') k WHERE (a->'tablas'->k) IS DISTINCT FROM (b->'tablas'->k)
      UNION ALL SELECT 'función ' || k || ' [' || CASE WHEN (a->'funciones'->k->'def') IS DISTINCT FROM (b->'funciones'->k->'def') THEN 'def' ELSE '' END
                      || CASE WHEN (a->'funciones'->k->'grants') IS DISTINCT FROM (b->'funciones'->k->'grants') THEN ' grants ' || coalesce((a->'funciones'->k->'grants')::text, 'null') || ' vs ' || coalesce((b->'funciones'->k->'grants')::text, 'null') ELSE '' END || ']'
        FROM jsonb_object_keys(a->'funciones') k WHERE (a->'funciones'->k) IS DISTINCT FROM (b->'funciones'->k)) q;
    RAISE EXCEPTION 'FALLA I5: la huella tras p1-p3 difiere de STAGING en: %', coalesce(dif, '(estructura)'); END IF;
END $$;

-- ===== 3) 4C-1 y 4C-1b sobre ese estado + checks =====
-- ---------- 4C-1 ----------
-- CardioLink · Seguridad clínica V1 · BLOQUE 4C-1 (ajuste v2.6) · SEGURIDAD DOCUMENTAL (cardiolink_patient_documents + Storage patient-documents)
-- BORRADOR PARA REVISIÓN. NO EJECUTAR sin autorización explícita. Primero STAGING (yslhwdlzdknhskawqrtv); Production sólo con autorización aparte.
-- No está en supabase/migrations a propósito: `supabase db push` no debe poder aplicarla por accidente.
-- SIN EJECUTAR: la sintaxis no se validó contra una base. Antes de aplicar: ensayo reversible (pending_review_documentos_seguridad_4c1_ensayo_reversible.sql).
--
-- REGLAS DE NEGOCIO CONFIRMADAS (dueño).
--   * Secretaría EMITE constancias, certificados y órdenes, por indicación de un profesional autorizado y con SU membrete, sello y firma.
--   * Secretaría SUBE, consulta, gestiona, descarga, imprime y envía: lo anterior + ECG, Holter, MAPA, ecocardiogramas, estudios, informes, laboratorios, recetas, indicaciones,
--     aptos físicos y otros documentos administrativos y médicos. NO modifica el contenido médico firmado.
--   * Imágenes adjuntas a evoluciones ('Imagen clínica', ruta clinical-images/): acceso clínico (owner/admin/médico). Imágenes de estudios independientes: gestión administrativa.
--   * 'Mensaje a colega': reservado a médicos. Notas clínicas privadas: Bloque 4C-2 (no es materia de este SQL).
--
-- HALLAZGOS DE LA AUDITORÍA REAL DE STAGING (53 documentos, 15 tipos) QUE ESTE BLOQUE RESUELVE:
--   (1) el médico consulta documentos de cualquier paciente (sin comprobar asociación);  (2) el médico actualiza documentos ajenos;
--   (3) Storage no está ligado a la fila: el acceso es por ruta;  (4) Secretaría emite/sube a nombre de cualquier profesional (o de ninguno);
--   (5) una fila documental podía apuntar al storage_path de un archivo AJENO (huérfano o restringido) y así "abrirlo" por la regla de Storage;
--   (6) attention_id / evolution_id aceptaban cualquier texto (la FK sólo cubre evolution_id): un documento podía vincularse a la atención/evolución de OTRO paciente o de OTRO profesional.
--   (7) DECISIÓN v2.2: Secretaría sólo consulta, visualiza, descarga, imprime y ENVÍA documentos de profesionales con los que tiene una asociación ACTIVA; los documentos sin profesional identificable no le
--       son visibles; al desactivar la asociación pierde el acceso al instante. Se verifica en el SERVIDOR (tabla, Storage y, por herencia de la RLS, listados, búsquedas, vista previa, descargas, envíos y API directa);
--   (8) una fila "nueva versión" podía reclamar el source_document_id de un documento AJENO (paciente o profesional distintos) y pasar a ser la versión vigente (la más reciente por source_document_id).
--   (9) v2.3: la función SECURITY DEFINER cardiolink_historial_envios_documento_v1 (propuesta pending_review_communications_historial_documental_v1, PARTE 1; ya probada en STAGING) devolvía a Secretaría el historial
--       de TODOS los documentos pedidos: ignoraba la RLS y la regla de asociación activa. Este bloque la REEMPLAZA (mismo nombre, firma y columnas) con validación explícita en la propia función.
--   Ya correcto y NO se toca: Secretaría sin UPDATE ni DELETE; DELETE del médico con titularidad; políticas de imagen clínica ya RESTRICTIVE (se reemplazan por equivalentes más estrictas).
--
-- QUÉ HACE. Todo ADITIVO y RESTRICTIVE (se combina por AND con las permisivas existentes: ninguna permisiva presente o futura puede abrir lo que esto cierra):
--   1) cardiolink_tipos_documento_secretaria_v1(): única lista de tipos de Secretaría (cerrados: 'Imagen clínica', 'Mensaje a colega' y todo tipo no listado).
--   2) Acceso del médico al paciente: se REUTILIZA la función existente cardiolink_paciente_acceso_clinico_v1(text) (confirmada en STAGING: asociación manual activa, evolución propia, atención
--      propia y validación de paciente existente). Este bloque NO duplica esa lógica: sólo la invoca desde las políticas.
--   3) cardiolink_profesionales_autorizados_secretaria_v1() / cardiolink_secretaria_autorizada_prof_v1(prof): profesionales por cuenta de los cuales una Secretaría puede emitir/subir =
--      los de sus asociaciones ACTIVAS (Bloque 3), cualquiera sea el rol del profesional (el Dueño —rol owner— cuenta igual que un médico). La tabla de asociaciones se descubre por sus
--      columnas (secretaria_user_id, medico_user_id, activo); si no es única, el SQL aborta.
--   4) Ayudas SECURITY DEFINER para Storage: cardiolink_objeto_sin_fila_v1(name) ("archivo propio recién subido") y cardiolink_objeto_asignable_v1(path, paciente): una fila nueva sólo puede
--      apuntar a un archivo QUE YA EXISTE, subido por la misma persona hace menos de 1 hora, y cuya ruta pertenece al MISMO paciente de la fila (nunca al archivo de otro).
--   5) Tabla, 3 políticas RESTRICTIVE (reemplazan las 2 de imagen clínica):
--        SELECT : owner/admin; médico = titular del documento (misma regla que DELETE) o con acceso clínico al paciente (sin cambios); Secretaría = tipo de la lista Y ruta fuera de clinical-images/ Y
--                 profesional del documento entre sus ASOCIACIONES ACTIVAS (profesional NULL ⇒ invisible). Storage, listados, búsquedas, vista previa, descargas (URL firmada), envíos (la Edge Function lee con el
--                 JWT del usuario) y el acceso directo por API HEREDAN esta regla: una sola fuente de verdad, evaluada en cada consulta (sin caché: al desactivar la asociación el acceso cae de inmediato).
--        INSERT : owner/admin; médico = con acceso clínico al paciente, a nombre propio (o sin profesional) y con archivo asignable; Secretaría = tipo de la lista, ruta fuera de
--                 clinical-images/, sin vínculo a evolución, con profesional AUTORIZADO obligatorio y con archivo asignable (trazabilidad del profesional y del archivo).
--        UPDATE : owner/admin; médico = titular o asociado al paciente (qué columnas puede tocar lo decide el trigger de abajo). Secretaría: nunca.
--   5a) Historial de envíos: cardiolink_communications (document_delivery/document) ya no muestra a Secretaría filas de documentos que ella no puede ver (política RESTRICTIVE; médicos y owner/admin no cambian;
--      las filas sin document_id —turnos— tampoco).
--   5d) HISTORIAL POR FUNCIÓN (v2.3): cardiolink_historial_envios_documento_v1(text[]) es SECURITY DEFINER (ignora la RLS), así que la autorización va DENTRO de la función. owner/admin: sin cambios (todo lo pedido, incluso
--      filas de documentos ya eliminados). Médico: regla vigente sin cambios (documentos que emitió él). Secretaría: SOLO envíos de documentos que EXISTEN, con professional_id de una asociación ACTIVA con ella, de un tipo de
--      cardiolink_tipos_documento_secretaria_v1(), que no sean 'Imagen clínica' ni estén bajo clinical-images/. Documento inexistente (huérfano), sin profesional, de otro profesional o de tipo cerrado: no sale. Sigue sin
--      devolver message, subject ni provider_message_id. Si la función ya existía (PARTE 1 aplicada) se REEMPLAZA y el rollback restaura el cuerpo anterior; si no existía se CREA y el rollback la elimina (queda marcado en su comentario).
--   5b) NUEVAS VERSIONES (v2.2): un INSERT con un source_document_id que YA existe es una nueva versión de ese documento: debe conservar el paciente y el profesional de la familia (el tipo puede cambiar) y quien
--      la crea debe ser owner/admin, el médico dueño de ese profesional, o la Secretaría con ese profesional autorizado. El servidor fija created_at (la "versión vigente" es la más reciente: no se puede falsear ni
--      anticipar). Un source_document_id nuevo sigue siendo una primera versión.
--   5c) VÍNCULOS (v2.1): al insertar o CAMBIAR attention_id / evolution_id el destino debe EXISTIR y ser del MISMO paciente del documento (cardiolink_vinculo_documental_v1). Para MÉDICOS además debe
--      ser PROPIO (atención con payload.profesionalId = el suyo; evolución con profesional_id = el suyo) y con acceso clínico al paciente (cardiolink_paciente_acceso_clinico_v1). Desvincular (NULL) es libre
--      salvo que el médico no sea titular del documento y el vínculo vigente sea de otro profesional. Owner/admin: existencia y mismo paciente. Secretaría no vincula evolución (INSERT) ni actualiza.
--   6) Trigger BEFORE INSERT/UPDATE. Con sesión: INSERT fija uploaded_by = auth.uid(). UPDATE: (a) para TODOS (incluidos owner/admin y TODAS las filas, también los PDF subidos a mano) son
--      inmutables la identidad del archivo y del autor: patient_id, storage_path, original_filename, mime_type, size_bytes, created_at, uploaded_by y source_document_id/source_content_hash/
--      source_payload (no se "firma" a posteriori una fila sin payload; las versiones nuevas son INSERT de filas nuevas); (b) en documentos emitidos nadie cambia tipo, profesional ni fecha;
--      (c) salvo owner/admin, sólo attention_id, evolution_id, updated_at y —el titular— title, description, document_date. Complementa cardiolink_patient_documents_guard_version (que
--      protege el payload de las versiones archivadas con P0001) sin reemplazarlo. Es SECURITY DEFINER (con search_path fijo) para poder validar vínculos sin dar EXECUTE del validador a los clientes.
--   7) Storage (bucket patient-documents), 2 políticas RESTRICTIVE (reemplazan las 2 de clinical-images). Staging al auditar: 52 objetos, 0 sin owner, 0 sin owner_id, 0 sin fila:
--        SELECT : owner/admin; o existe una FILA del documento visible para ese usuario (hereda la RLS de la tabla: una sola fuente de verdad); o archivo PROPIO recién subido (1 h)
--                 que todavía no tiene fila (el cliente sube el PDF y recién después inserta la fila); Secretaría nunca bajo clinical-images/.
--        INSERT : owner/admin/médico en cualquier ruta; el resto, fuera de clinical-images/ (la subida manual usa "{paciente}/{uuid}.pdf" y los emitidos "documents/{paciente}/{uuid}.pdf").
-- NO modifica: datos, documentos existentes (no elimina nada), políticas permisivas, DELETE, grants de tablas, Edge Functions ni el portal. Rollback exacto: …_4c1_rollback.sql.


-- ===== 0) Precondiciones (si algo difiere de lo esperado, todo se revierte sin cambios) =====
DO $$
DECLARE n int; v_tipo text; v_tabla text;
BEGIN
  IF to_regclass('public.cardiolink_patient_documents') IS NULL THEN RAISE EXCEPTION 'Precondición: falta public.cardiolink_patient_documents'; END IF;
  IF to_regclass('public.cardiolink_hc_evoluciones') IS NULL OR to_regclass('public.cardiolink_atenciones') IS NULL THEN RAISE EXCEPTION 'Precondición: faltan cardiolink_hc_evoluciones / cardiolink_atenciones'; END IF;
  IF to_regprocedure('public.cardiolink_can_delete_clinical_documents()') IS NULL OR to_regprocedure('public.cardiolink_has_clinical_documents_access()') IS NULL THEN
    RAISE EXCEPTION 'Precondición: faltan las funciones de autorización de documentos'; END IF;
  IF to_regprocedure('public.cardiolink_can_delete_clinical_document(text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Precondición: falta cardiolink_can_delete_clinical_document(text,uuid) (eliminación por titularidad: pending_review_patient_documents_delete_ownership_v1)'; END IF;
  IF to_regprocedure('public.cardiolink_ctx_rol_v1()') IS NULL OR to_regprocedure('public.cardiolink_ctx_prof_v1()') IS NULL THEN
    RAISE EXCEPTION 'Precondición: faltan cardiolink_ctx_rol_v1() / cardiolink_ctx_prof_v1()'; END IF;
  IF to_regprocedure('public.cardiolink_paciente_acceso_clinico_v1(text)') IS NULL THEN
    RAISE EXCEPTION 'Precondición: falta cardiolink_paciente_acceso_clinico_v1(text) (acceso clínico médico-paciente)'; END IF;
  IF (SELECT prorettype FROM pg_proc WHERE oid = 'public.cardiolink_paciente_acceso_clinico_v1(text)'::regprocedure) <> 'boolean'::regtype THEN
    RAISE EXCEPTION 'Precondición: cardiolink_paciente_acceso_clinico_v1(text) debe devolver boolean'; END IF;
  IF NOT has_function_privilege('authenticated', 'public.cardiolink_paciente_acceso_clinico_v1(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Precondición: authenticated debe poder ejecutar cardiolink_paciente_acceso_clinico_v1(text) (la evalúan las políticas)'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.cardiolink_patient_documents'::regclass AND NOT tgisinternal AND tgname='cardiolink_patient_documents_guard_version') THEN
    RAISE EXCEPTION 'Precondición: falta el trigger cardiolink_patient_documents_guard_version (inmutabilidad de versiones archivadas)'; END IF;
  SELECT count(*) INTO n FROM pg_policies WHERE
       (schemaname='public'  AND tablename='cardiolink_patient_documents' AND policyname IN ('cardiolink_patient_documents_select_no_img_secretaria','cardiolink_patient_documents_insert_no_img_secretaria'))
    OR (schemaname='storage' AND tablename='objects' AND policyname IN ('cardiolink_clinical_images_storage_select_no_secretaria','cardiolink_clinical_images_storage_insert_no_secretaria'));
  IF n <> 4 THEN RAISE EXCEPTION 'Precondición: se esperaban las 4 políticas restrictivas de imagen clínica (hay %); el estado difiere del repo: revisar con …_checks.sql', n; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='cardiolink_patient_documents' AND policyname='cardiolink_patient_documents_update' AND permissive='PERMISSIVE') THEN
    RAISE EXCEPTION 'Precondición: falta la política permisiva cardiolink_patient_documents_update'; END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE policyname LIKE '%\_4c1' ESCAPE '\' AND ((schemaname='public' AND tablename='cardiolink_patient_documents') OR (schemaname='storage' AND tablename='objects')))
     OR to_regprocedure('public.cardiolink_tipos_documento_secretaria_v1()') IS NOT NULL
     OR to_regprocedure('public.cardiolink_profesionales_autorizados_secretaria_v1()') IS NOT NULL OR to_regprocedure('public.cardiolink_secretaria_autorizada_prof_v1(text)') IS NOT NULL
     OR to_regprocedure('public.cardiolink_objeto_sin_fila_v1(text)') IS NOT NULL OR to_regprocedure('public.cardiolink_objeto_asignable_v1(text,text)') IS NOT NULL
     OR to_regprocedure('public.cardiolink_vinculo_documental_v1(text,text,text,boolean)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='cardiolink_communications' AND policyname='cardiolink_communications_select_docs_4c1')
     OR to_regprocedure('public.cardiolink_patient_documents_inmutables_4c1()') IS NOT NULL
     OR coalesce(obj_description(to_regprocedure('public.cardiolink_historial_envios_documento_v1(text[])'), 'pg_proc'), '') LIKE '%[4C-1:%' THEN
    RAISE EXCEPTION 'Este bloque ya está aplicado (o parcialmente): no se repite'; END IF;
  SELECT data_type INTO v_tipo FROM information_schema.columns WHERE table_schema='storage' AND table_name='objects' AND column_name='owner';
  IF v_tipo IS DISTINCT FROM 'uuid' THEN RAISE EXCEPTION 'Precondición: storage.objects.owner debe ser uuid (es %)', v_tipo; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='storage' AND table_name='objects' AND column_name='created_at') THEN RAISE EXCEPTION 'Precondición: falta storage.objects.created_at'; END IF;
  SELECT data_type INTO v_tipo FROM information_schema.columns WHERE table_schema='public' AND table_name='cardiolink_patient_documents' AND column_name='uploaded_by';
  IF v_tipo IS DISTINCT FROM 'uuid' THEN RAISE EXCEPTION 'Precondición: cardiolink_patient_documents.uploaded_by debe ser uuid (es %)', v_tipo; END IF;
  SELECT count(*) INTO n FROM information_schema.columns WHERE table_schema='public' AND table_name='cardiolink_patient_documents'
     AND column_name IN ('evolution_id','professional_id','source_payload','source_document_id','document_date','attention_id');
  IF n <> 6 THEN RAISE EXCEPTION 'Precondición: faltan columnas de cardiolink_patient_documents (evolution_id, professional_id, source_payload, source_document_id, document_date, attention_id): hay %', n; END IF;
  SELECT count(*) INTO n FROM information_schema.columns WHERE table_schema='public' AND table_name='cardiolink_user_roles' AND column_name IN ('user_id','base_role','active','professional_id');
  IF n <> 4 THEN RAISE EXCEPTION 'Precondición: faltan columnas de cardiolink_user_roles'; END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id='patient-documents' AND NOT public) THEN RAISE EXCEPTION 'Precondición: el bucket patient-documents debe existir y ser privado'; END IF;
  IF to_regclass('public.cardiolink_communications') IS NULL OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='cardiolink_communications' AND column_name='document_id')
     OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='cardiolink_communications' AND policyname='cardiolink_communications_select') THEN
    RAISE EXCEPTION 'Precondición: falta cardiolink_communications (con document_id y su política cardiolink_communications_select)'; END IF;
  SELECT count(*) INTO n FROM (SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('secretaria_user_id','medico_user_id','activo')
                                GROUP BY table_name HAVING count(*) = 3) t;
  IF n <> 1 THEN RAISE EXCEPTION 'Precondición: se esperaba UNA tabla de asociaciones secretaria-médico (columnas secretaria_user_id, medico_user_id, activo) y hay %', n; END IF;
  SELECT table_name INTO v_tabla FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('secretaria_user_id','medico_user_id','activo')
     GROUP BY table_name HAVING count(*) = 3;
  IF (SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=v_tabla AND column_name='activo') <> 'boolean' THEN
    RAISE EXCEPTION 'Precondición: %.activo debe ser boolean', v_tabla; END IF;
END $$;

-- ===== 1) Lista de tipos de Secretaría (un único lugar). IMMUTABLE: la evalúan las políticas con los privilegios de quien consulta, por eso authenticated necesita EXECUTE =====
-- Futuro módulo de copias para facturación: se agregará su tipo acá (CREATE OR REPLACE) cuando exista; hoy no existe y no se anticipa.
CREATE FUNCTION public.cardiolink_tipos_documento_secretaria_v1()
 RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $f$
 SELECT ARRAY['Constancia','Orden','Certificado','Estudio','Informe','Laboratorio','ECG','ECG y riesgo quirúrgico','Holter','MAPA','Ecocardiograma','Ecografía','Radiografía','Receta','Indicaciones','Apto físico','Otro']::text[]
$f$;

-- ===== 2) Acceso médico-paciente: se reutiliza public.cardiolink_paciente_acceso_clinico_v1(text) (existente; no se redefine) =====

-- ===== 3) Profesionales autorizados de una Secretaría (sus asociaciones activas). La tabla de asociaciones se descubre por columnas =====
DO $$
DECLARE v_tabla text;
BEGIN
  SELECT table_name INTO v_tabla FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('secretaria_user_id','medico_user_id','activo')
     GROUP BY table_name HAVING count(*) = 3;
  EXECUTE format($fmt$
    CREATE FUNCTION public.cardiolink_profesionales_autorizados_secretaria_v1()
     RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
    AS $body$
     SELECT coalesce(array_agg(DISTINCT m.professional_id), ARRAY[]::text[])
       FROM public.cardiolink_user_roles s
       JOIN public.%I a ON a.secretaria_user_id = s.user_id AND a.activo IS TRUE
       JOIN public.cardiolink_user_roles m ON m.user_id = a.medico_user_id AND m.active IS TRUE AND coalesce(m.professional_id, '') <> ''
      WHERE s.user_id = auth.uid() AND s.active IS TRUE AND s.base_role = 'secretaria'
    $body$
  $fmt$, v_tabla);
END $$;

CREATE FUNCTION public.cardiolink_secretaria_autorizada_prof_v1(p_prof text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $f$
 SELECT coalesce(p_prof, '') <> '' AND p_prof = ANY (public.cardiolink_profesionales_autorizados_secretaria_v1())
$f$;

-- ===== 4) Archivo sin fila (ignora la RLS a propósito: "no existe NINGUNA fila", no "no veo ninguna") =====
CREATE FUNCTION public.cardiolink_objeto_sin_fila_v1(p_name text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $f$
 SELECT NOT EXISTS (SELECT 1 FROM public.cardiolink_patient_documents d WHERE d.storage_path = p_name)
$f$;

-- Una fila documental sólo puede apuntar a un archivo que (a) ya existe, (b) lo subió quien inserta la fila, hace menos de 1 hora, y (c) cuya ruta pertenece al MISMO paciente de la fila
-- ("{paciente}/…", "documents/{paciente}/…" o "clinical-images/{paciente}/…"). Ignora la RLS a propósito (SECURITY DEFINER): "existe y es mío" no puede depender de lo que yo vea.
-- Una fila no puede apuntar al archivo de otro (huérfano ajeno o restringido): storage_path es UNIQUE, así que un archivo con fila ya no es reasignable.
CREATE FUNCTION public.cardiolink_objeto_asignable_v1(p_path text, p_patient text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $f$
 SELECT coalesce(p_path, '') <> '' AND coalesce(p_patient, '') <> ''
    AND (split_part(p_path, '/', 1) = p_patient
         OR (split_part(p_path, '/', 1) IN ('documents', 'clinical-images') AND split_part(p_path, '/', 2) = p_patient))
    AND EXISTS (SELECT 1 FROM storage.objects o
                 WHERE o.bucket_id = 'patient-documents' AND o.name = p_path AND o.owner = auth.uid() AND o.created_at > now() - interval '1 hour')
$f$;

-- Vínculo documental válido: el destino EXISTE y es del MISMO paciente; con p_solo_propios (médicos) además es PROPIO (y con acceso clínico en la evolución). Ignora la RLS a propósito (SECURITY DEFINER):
-- "existe y corresponde" no puede depender de lo que el llamador pueda ver. NO es ejecutable por los clientes: sólo la invoca el trigger de la tabla. Un id vacío o NULL no se valida (no hay vínculo).
CREATE FUNCTION public.cardiolink_vinculo_documental_v1(p_patient text, p_attention text, p_evolution text, p_solo_propios boolean)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $f$
 SELECT coalesce(p_patient, '') <> ''
    AND (coalesce(p_attention, '') = '' OR EXISTS (
           SELECT 1 FROM public.cardiolink_atenciones a
            WHERE a.id = p_attention
              AND coalesce(a.payload ->> 'tipoRegistro', '') NOT IN ('mensaje', 'config')
              AND (a.payload ->> 'pacienteId' = p_patient
                   OR (p_patient LIKE 'legacy\_%' ESCAPE '\'
                       AND 'legacy_' || pg_catalog.regexp_replace(coalesce(a.payload ->> 'dni', ''), '\D', '', 'g') = p_patient))
              AND (NOT p_solo_propios OR a.payload ->> 'profesionalId' = (SELECT public.cardiolink_ctx_prof_v1()))))
    AND (coalesce(p_evolution, '') = '' OR EXISTS (
           SELECT 1 FROM public.cardiolink_hc_evoluciones e
            WHERE e.id = p_evolution AND e.paciente_id = p_patient
              AND (NOT p_solo_propios OR (e.profesional_id = (SELECT public.cardiolink_ctx_prof_v1()) AND public.cardiolink_paciente_acceso_clinico_v1(p_patient)))))
$f$;

REVOKE ALL ON FUNCTION public.cardiolink_vinculo_documental_v1(text, text, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cardiolink_tipos_documento_secretaria_v1()            FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cardiolink_profesionales_autorizados_secretaria_v1()  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cardiolink_secretaria_autorizada_prof_v1(text)        FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cardiolink_objeto_sin_fila_v1(text)                   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cardiolink_objeto_asignable_v1(text, text)            FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cardiolink_tipos_documento_secretaria_v1()            TO authenticated;
GRANT EXECUTE ON FUNCTION public.cardiolink_profesionales_autorizados_secretaria_v1()  TO authenticated;
GRANT EXECUTE ON FUNCTION public.cardiolink_secretaria_autorizada_prof_v1(text)        TO authenticated;
GRANT EXECUTE ON FUNCTION public.cardiolink_objeto_sin_fila_v1(text)                   TO authenticated;
GRANT EXECUTE ON FUNCTION public.cardiolink_objeto_asignable_v1(text, text)            TO authenticated;

-- ===== 5) Tabla: políticas RESTRICTIVE =====
DROP POLICY cardiolink_patient_documents_select_no_img_secretaria ON public.cardiolink_patient_documents;
DROP POLICY cardiolink_patient_documents_insert_no_img_secretaria ON public.cardiolink_patient_documents;

CREATE POLICY cardiolink_patient_documents_select_4c1 ON public.cardiolink_patient_documents
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (
    (SELECT public.cardiolink_ctx_rol_v1()) IN ('owner', 'admin')
    OR ((SELECT public.cardiolink_ctx_rol_v1()) = 'medico'
        AND (public.cardiolink_can_delete_clinical_document(professional_id, uploaded_by) OR public.cardiolink_paciente_acceso_clinico_v1(patient_id)))
    OR ((SELECT public.cardiolink_ctx_rol_v1()) = 'secretaria'
        AND document_type = ANY (public.cardiolink_tipos_documento_secretaria_v1()) AND storage_path NOT LIKE 'clinical-images/%'
        AND professional_id = ANY (((SELECT public.cardiolink_profesionales_autorizados_secretaria_v1()))::text[]))
  );

CREATE POLICY cardiolink_patient_documents_insert_4c1 ON public.cardiolink_patient_documents
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT public.cardiolink_ctx_rol_v1()) IN ('owner', 'admin')
    OR ((SELECT public.cardiolink_ctx_rol_v1()) = 'medico'
        AND (professional_id IS NULL OR professional_id = (SELECT public.cardiolink_ctx_prof_v1()))
        AND public.cardiolink_paciente_acceso_clinico_v1(patient_id)
        AND public.cardiolink_objeto_asignable_v1(storage_path, patient_id))
    OR ((SELECT public.cardiolink_ctx_rol_v1()) = 'secretaria'
        AND document_type = ANY (public.cardiolink_tipos_documento_secretaria_v1()) AND storage_path NOT LIKE 'clinical-images/%'
        AND evolution_id IS NULL AND public.cardiolink_secretaria_autorizada_prof_v1(professional_id)
        AND public.cardiolink_objeto_asignable_v1(storage_path, patient_id))
  );

CREATE POLICY cardiolink_patient_documents_update_4c1 ON public.cardiolink_patient_documents
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (
    (SELECT public.cardiolink_ctx_rol_v1()) IN ('owner', 'admin')
    OR ((SELECT public.cardiolink_ctx_rol_v1()) = 'medico'
        AND (public.cardiolink_can_delete_clinical_document(professional_id, uploaded_by) OR public.cardiolink_paciente_acceso_clinico_v1(patient_id)))
  )
  WITH CHECK (
    (SELECT public.cardiolink_ctx_rol_v1()) IN ('owner', 'admin')
    OR ((SELECT public.cardiolink_ctx_rol_v1()) = 'medico'
        AND (public.cardiolink_can_delete_clinical_document(professional_id, uploaded_by) OR public.cardiolink_paciente_acceso_clinico_v1(patient_id)))
  );

-- 5a) Historial de envíos: Secretaría no ve filas de documentos que ella no puede ver (la subconsulta se evalúa con la RLS de quien consulta)
CREATE POLICY cardiolink_communications_select_docs_4c1 ON public.cardiolink_communications
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (
    document_id IS NULL
    OR (SELECT public.cardiolink_ctx_rol_v1()) IS DISTINCT FROM 'secretaria'
    OR EXISTS (SELECT 1 FROM public.cardiolink_patient_documents d WHERE d.id::text = cardiolink_communications.document_id)
  );

-- 5d) Historial de envíos por FUNCIÓN (SECURITY DEFINER: la RLS no interviene, por eso la autorización está escrita en la función). Reemplaza (o crea) cardiolink_historial_envios_documento_v1.
--     Mismo nombre, firma y 12 columnas que la PARTE 1 de pending_review_communications_historial_documental_v1: el cliente (cardiolink-documentos-pdf-v1.js) no cambia.
DO $$ BEGIN
  PERFORM set_config('cardiolink.rpc_historial_existia', CASE WHEN to_regprocedure('public.cardiolink_historial_envios_documento_v1(text[])') IS NULL THEN 'no' ELSE 'si' END, true);
END $$;

CREATE OR REPLACE FUNCTION public.cardiolink_historial_envios_documento_v1(p_document_ids text[])
RETURNS TABLE (
  id uuid,
  document_id text,
  paciente_id text,
  created_at timestamptz,
  canal text,
  status text,
  destinatario text,
  recipient_name text,
  recipient_source text,
  error_message text,
  creado_por_mi boolean,
  automatico boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  WITH yo AS (
    SELECT bool_or(ur.base_role IN ('owner', 'admin')) AS administrativo,
           bool_or(ur.base_role = 'secretaria') AS secretaria,
           bool_or(ur.base_role = 'medico') AS medico,
           max(ur.professional_id) FILTER (WHERE ur.base_role = 'medico') AS professional_id
      FROM public.cardiolink_user_roles AS ur
     WHERE ur.user_id = auth.uid()
       AND ur.active
       AND ur.base_role IN ('owner', 'admin', 'secretaria', 'medico')
  ),
  aut AS (
    SELECT public.cardiolink_profesionales_autorizados_secretaria_v1() AS profesionales
  )
  SELECT c.id, c.document_id, c.paciente_id, c.created_at, c.canal, c.status, c.destinatario,
         c.recipient_name, c.recipient_source, c.error_message,
         (c.created_by IS NOT NULL AND c.created_by = auth.uid()) AS creado_por_mi,
         (c.created_by IS NULL) AS automatico
    FROM public.cardiolink_communications AS c
   CROSS JOIN yo
   CROSS JOIN aut
   WHERE c.tipo = 'document_delivery'
     AND p_document_ids IS NOT NULL
     AND cardinality(p_document_ids) BETWEEN 1 AND 500
     AND c.document_id = ANY (p_document_ids)
     AND (
          -- owner / admin: acceso administrativo (sin cambios)
          coalesce(yo.administrativo, false)
       -- médico: regla vigente (documentos que emitió él)
       OR (
            coalesce(yo.medico, false)
        AND EXISTS (
              SELECT 1
                FROM public.cardiolink_patient_documents AS d
               WHERE d.id::text = c.document_id
                 AND (
                      (d.professional_id IS NOT NULL AND yo.professional_id IS NOT NULL AND d.professional_id = yo.professional_id)
                   OR (d.professional_id IS NULL AND d.uploaded_by IS NOT NULL AND d.uploaded_by = auth.uid())
                 )
            )
          )
       -- Secretaría (v2.3): validación EXPLÍCITA en la función (no depende de la RLS: SECURITY DEFINER la ignora). El documento debe existir, tener
       -- profesional identificable con ASOCIACIÓN ACTIVA con esta Secretaría, ser de un tipo permitido, no ser 'Imagen clínica' ni estar bajo clinical-images/
       OR (
            coalesce(yo.secretaria, false)
        AND EXISTS (
              SELECT 1
                FROM public.cardiolink_patient_documents AS d
               WHERE d.id::text = c.document_id
                 AND coalesce(d.professional_id, '') <> ''
                 AND d.professional_id = ANY (aut.profesionales)
                 AND d.document_type = ANY (public.cardiolink_tipos_documento_secretaria_v1())
                 AND d.document_type <> 'Imagen clínica'
                 AND d.storage_path NOT LIKE 'clinical-images/%'
            )
          )
     )
   ORDER BY c.created_at ASC, c.id ASC;
$function$;

REVOKE ALL PRIVILEGES ON FUNCTION public.cardiolink_historial_envios_documento_v1(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cardiolink_historial_envios_documento_v1(text[]) TO authenticated;

DO $$ BEGIN
  EXECUTE format('COMMENT ON FUNCTION public.cardiolink_historial_envios_documento_v1(text[]) IS %L',
    'Historial de envíos de documentos (tipo document_delivery) de los ids pedidos, sin message, subject ni provider_message_id. owner/admin: todos los pedidos; médico: sólo los de documentos que emitió él; '
    || 'Secretaría: sólo los de documentos existentes de profesionales con asociación ACTIVA con ella, de tipo permitido y que no sean Imagen clínica (validado dentro de la función; SECURITY DEFINER no usa la RLS). '
    || CASE WHEN current_setting('cardiolink.rpc_historial_existia', true) = 'no' THEN '[4C-1: creada por este bloque]' ELSE '[4C-1: reemplaza la versión de la propuesta PARTE 1]' END);
END $$;

-- ===== 6) Trigger: identidad del archivo y del autor, contenido firmado, vínculos. SECURITY DEFINER con search_path fijo; sin sesión (service_role / SQL Editor) no interviene =====
CREATE FUNCTION public.cardiolink_patient_documents_inmutables_4c1()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $f$
DECLARE v_perm text[]; v_rol text; v_medico boolean; v_titular boolean; v_cambia_att boolean; v_cambia_evo boolean;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  v_rol := (SELECT public.cardiolink_ctx_rol_v1());
  v_medico := v_rol = 'medico';
  IF TG_OP = 'INSERT' THEN
    NEW.uploaded_by := auth.uid();                      -- el autor lo fija el servidor, no el navegador
    NEW.created_at := clock_timestamp();                -- la versión vigente es la más reciente: la fecha de alta la fija el servidor
    -- NUEVA VERSIÓN de un documento existente (mismo source_document_id): conserva paciente y profesional de la familia y la crea quien está autorizado para ese profesional
    IF coalesce(NEW.source_document_id, '') <> '' AND EXISTS (SELECT 1 FROM public.cardiolink_patient_documents d WHERE d.source_document_id = NEW.source_document_id) THEN
      IF EXISTS (SELECT 1 FROM public.cardiolink_patient_documents d
                  WHERE d.source_document_id = NEW.source_document_id
                    AND (d.patient_id IS DISTINCT FROM NEW.patient_id OR d.professional_id IS DISTINCT FROM NEW.professional_id)) THEN
        RAISE EXCEPTION 'Una versión nueva conserva el paciente y el profesional del documento original' USING ERRCODE = '42501';
      END IF;
      IF NOT (v_rol IN ('owner', 'admin')
              OR (v_medico AND NEW.professional_id IS NOT NULL AND NEW.professional_id = (SELECT public.cardiolink_ctx_prof_v1()))
              OR (v_rol = 'secretaria' AND public.cardiolink_secretaria_autorizada_prof_v1(NEW.professional_id))) THEN
        RAISE EXCEPTION 'Sólo el profesional del documento, una Secretaría autorizada para él u owner/admin pueden emitir una versión nueva' USING ERRCODE = '42501';
      END IF;
    END IF;
    IF (coalesce(NEW.attention_id, '') <> '' OR coalesce(NEW.evolution_id, '') <> '')
       AND NOT public.cardiolink_vinculo_documental_v1(NEW.patient_id, NEW.attention_id, NEW.evolution_id, v_medico) THEN
      RAISE EXCEPTION 'La atención o evolución de destino no existe, no es de este paciente o no es propia' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.patient_id IS DISTINCT FROM OLD.patient_id OR NEW.storage_path IS DISTINCT FROM OLD.storage_path OR NEW.original_filename IS DISTINCT FROM OLD.original_filename
     OR NEW.mime_type IS DISTINCT FROM OLD.mime_type OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by OR NEW.source_document_id IS DISTINCT FROM OLD.source_document_id
     OR NEW.source_content_hash IS DISTINCT FROM OLD.source_content_hash OR NEW.source_payload IS DISTINCT FROM OLD.source_payload THEN
    RAISE EXCEPTION 'La identidad del documento (paciente, archivo, autor, contenido firmado) no se modifica: se archiva una versión nueva' USING ERRCODE = '42501';
  END IF;
  IF (OLD.source_payload IS NOT NULL OR OLD.source_document_id IS NOT NULL)
     AND (NEW.document_type IS DISTINCT FROM OLD.document_type OR NEW.professional_id IS DISTINCT FROM OLD.professional_id OR NEW.document_date IS DISTINCT FROM OLD.document_date) THEN
    RAISE EXCEPTION 'El tipo, el profesional y la fecha de un documento emitido o firmado no se modifican: se emite una versión nueva' USING ERRCODE = '42501';
  END IF;
  -- vínculos con la atención / evolución: lo NUEVO debe existir y ser del mismo paciente (y, para médicos, propio); desvincular (NULL) es libre
  v_cambia_att := NEW.attention_id IS DISTINCT FROM OLD.attention_id;
  v_cambia_evo := NEW.evolution_id IS DISTINCT FROM OLD.evolution_id;
  IF (v_cambia_att AND coalesce(NEW.attention_id, '') <> '') OR (v_cambia_evo AND coalesce(NEW.evolution_id, '') <> '') THEN
    IF NOT public.cardiolink_vinculo_documental_v1(NEW.patient_id,
         CASE WHEN v_cambia_att THEN NEW.attention_id END, CASE WHEN v_cambia_evo THEN NEW.evolution_id END, v_medico) THEN
      RAISE EXCEPTION 'La atención o evolución de destino no existe, no es de este paciente o no es propia' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF v_medico AND (v_cambia_att OR v_cambia_evo) AND NOT public.cardiolink_can_delete_clinical_document(OLD.professional_id, OLD.uploaded_by) THEN
    -- el médico que no es titular sólo suelta o reemplaza vínculos PROPIOS
    IF NOT public.cardiolink_vinculo_documental_v1(OLD.patient_id,
         CASE WHEN v_cambia_att THEN OLD.attention_id END, CASE WHEN v_cambia_evo THEN OLD.evolution_id END, true) THEN
      RAISE EXCEPTION 'El vínculo vigente es de otro profesional: sólo su titular o owner/admin pueden modificarlo' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF v_rol IN ('owner', 'admin') THEN RETURN NEW; END IF;
  v_titular := public.cardiolink_can_delete_clinical_document(OLD.professional_id, OLD.uploaded_by);
  v_perm := ARRAY['attention_id', 'evolution_id', 'updated_at']
         || CASE WHEN v_titular THEN ARRAY['title', 'description', 'document_date'] ELSE ARRAY[]::text[] END;
  IF (to_jsonb(NEW) - v_perm) IS DISTINCT FROM (to_jsonb(OLD) - v_perm) THEN
    RAISE EXCEPTION 'Sólo se pueden modificar el vínculo con la atención/evolución y, el titular, título, descripción y fecha; tipo y profesional los corrige owner/admin' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$f$;
REVOKE ALL ON FUNCTION public.cardiolink_patient_documents_inmutables_4c1() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER cardiolink_patient_documents_inmutables_4c1
  BEFORE INSERT OR UPDATE ON public.cardiolink_patient_documents
  FOR EACH ROW EXECUTE FUNCTION public.cardiolink_patient_documents_inmutables_4c1();

-- ===== 7) Storage (sólo el bucket patient-documents) =====
DROP POLICY cardiolink_clinical_images_storage_select_no_secretaria ON storage.objects;
DROP POLICY cardiolink_clinical_images_storage_insert_no_secretaria ON storage.objects;

CREATE POLICY cardiolink_patient_documents_storage_select_4c1 ON storage.objects
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (
    bucket_id <> 'patient-documents'
    OR (SELECT public.cardiolink_ctx_rol_v1()) IN ('owner', 'admin')
    OR EXISTS (SELECT 1 FROM public.cardiolink_patient_documents d WHERE d.storage_path = objects.name)
    OR (objects.owner = auth.uid()
        AND objects.created_at > now() - interval '1 hour'
        AND public.cardiolink_objeto_sin_fila_v1(objects.name)
        AND ((SELECT public.cardiolink_ctx_rol_v1()) = 'medico' OR objects.name NOT LIKE 'clinical-images/%'))
  );

CREATE POLICY cardiolink_patient_documents_storage_insert_4c1 ON storage.objects
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id <> 'patient-documents'
    OR (SELECT public.cardiolink_ctx_rol_v1()) IN ('owner', 'admin', 'medico')
    OR objects.name NOT LIKE 'clinical-images/%'
  );

-- ===== 8) Postcondiciones =====
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_policies WHERE permissive='RESTRICTIVE' AND policyname IN
        ('cardiolink_patient_documents_select_4c1','cardiolink_patient_documents_insert_4c1','cardiolink_patient_documents_update_4c1',
         'cardiolink_patient_documents_storage_select_4c1','cardiolink_patient_documents_storage_insert_4c1','cardiolink_communications_select_docs_4c1')) <> 6 THEN
    RAISE EXCEPTION 'FALLA: no quedaron las 6 políticas restrictivas nuevas'; END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE policyname IN ('cardiolink_patient_documents_select_no_img_secretaria','cardiolink_patient_documents_insert_no_img_secretaria',
        'cardiolink_clinical_images_storage_select_no_secretaria','cardiolink_clinical_images_storage_insert_no_secretaria')) THEN
    RAISE EXCEPTION 'FALLA: quedaron las políticas de lista negra anteriores'; END IF;
  IF has_function_privilege('anon','public.cardiolink_tipos_documento_secretaria_v1()','EXECUTE') OR has_function_privilege('anon','public.cardiolink_objeto_asignable_v1(text,text)','EXECUTE')
     OR has_function_privilege('anon','public.cardiolink_profesionales_autorizados_secretaria_v1()','EXECUTE') OR has_function_privilege('anon','public.cardiolink_secretaria_autorizada_prof_v1(text)','EXECUTE')
     OR has_function_privilege('anon','public.cardiolink_objeto_sin_fila_v1(text)','EXECUTE') OR has_function_privilege('authenticated','public.cardiolink_patient_documents_inmutables_4c1()','EXECUTE')
     OR has_function_privilege('anon','public.cardiolink_vinculo_documental_v1(text,text,text,boolean)','EXECUTE') OR has_function_privilege('authenticated','public.cardiolink_vinculo_documental_v1(text,text,text,boolean)','EXECUTE') THEN
    RAISE EXCEPTION 'FALLA: privilegios de ejecución inesperados'; END IF;
  IF NOT has_function_privilege('authenticated','public.cardiolink_tipos_documento_secretaria_v1()','EXECUTE') OR NOT has_function_privilege('authenticated','public.cardiolink_objeto_asignable_v1(text,text)','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.cardiolink_secretaria_autorizada_prof_v1(text)','EXECUTE') OR NOT has_function_privilege('authenticated','public.cardiolink_objeto_sin_fila_v1(text)','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.cardiolink_paciente_acceso_clinico_v1(text)','EXECUTE') THEN
    RAISE EXCEPTION 'FALLA: authenticated no puede ejecutar las funciones que evalúan las políticas'; END IF;
  IF 'Imagen clínica' = ANY (public.cardiolink_tipos_documento_secretaria_v1()) OR 'Mensaje a colega' = ANY (public.cardiolink_tipos_documento_secretaria_v1()) THEN
    RAISE EXCEPTION 'FALLA: tipos cerrados presentes en la lista de Secretaría'; END IF;
  IF public.cardiolink_paciente_acceso_clinico_v1('qa4c_sin_sesion') IS TRUE OR public.cardiolink_secretaria_autorizada_prof_v1(NULL) IS NOT FALSE
     OR public.cardiolink_objeto_asignable_v1('qa4c_sin_sesion/x.pdf', 'qa4c_sin_sesion') IS NOT FALSE THEN
    RAISE EXCEPTION 'FALLA: sin sesión las funciones de acceso deben dar false'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.cardiolink_patient_documents'::regclass AND tgname='cardiolink_patient_documents_inmutables_4c1' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'FALLA: no quedó el trigger de inmutables'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.cardiolink_historial_envios_documento_v1(text[])'::regprocedure AND prosecdef
                   AND prosrc LIKE '%cardiolink_profesionales_autorizados_secretaria_v1%' AND prosrc LIKE '%cardiolink_tipos_documento_secretaria_v1%' AND prosrc LIKE '%clinical-images/%')
     OR has_function_privilege('anon','public.cardiolink_historial_envios_documento_v1(text[])','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.cardiolink_historial_envios_documento_v1(text[])','EXECUTE')
     OR coalesce(obj_description('public.cardiolink_historial_envios_documento_v1(text[])'::regprocedure, 'pg_proc'), '') NOT LIKE '%[4C-1:%'
     OR pg_get_function_result('public.cardiolink_historial_envios_documento_v1(text[])'::regprocedure) ~* '\y(message|subject|provider_message_id)\y' THEN
    RAISE EXCEPTION 'FALLA: la función del historial de envíos no quedó con la autorización de Secretaría por asociación activa'; END IF;
END $$;

-- ---------- 4C-1b ----------
-- CardioLink · Seguridad clínica V1 · BLOQUE 4C-1b (ajuste v2.2; parte de la entrega 4C-1; se aplica por separado porque la etapa A de 4B ya está instalada en STAGING) · Certificados, órdenes y reposos HEREDADOS legibles por Secretaría, sin reabrir la fila de configuración completa
-- BORRADOR PARA REVISIÓN. NO EJECUTAR sin autorización explícita. Primero STAGING (yslhwdlzdknhskawqrtv). SIN EJECUTAR: sintaxis sin validar.
-- Decisión del dueño: ampliar el acceso administrativo a certificados y órdenes heredados SIN reabrir la fila completa. La fila `__cardiolink_config_v1` sigue cerrada a Secretaría (etapa B de 4B);
-- ella sólo recibe, por la RPC administrativa `cardiolink_config_administrativa_v1()`, la lista saneada de `documentosClinicos` filtrada por TIPO. Este SQL sólo amplía ESA lista de tipos.
-- QUÉ HACE (y nada más):
--   1) CREATE OR REPLACE de cardiolink_config_tipos_doc_sec_v1(): de {constancia_atencion} a {constancia_atencion, certificado, reposo_laboral, orden}.
--   2) DECISIÓN v2.2 (Secretaría sólo ve documentos de profesionales con asociación ACTIVA): CREATE OR REPLACE de cardiolink_config_vista_sec_v1(jsonb) —la vista de LECTURA de la RPC administrativa—: además del tipo, cada
--      documento heredado debe tener `profesionalId` entre los profesionales autorizados de la Secretaría que consulta (cardiolink_profesionales_autorizados_secretaria_v1, de 4C-1). Sin profesionalId ⇒ no se entrega. Deja de ser
--      IMMUTABLE (depende de la sesión): pasa a STABLE. Sólo la usa la RPC de LECTURA (el hash de concurrencia usa la vista de escritura, que no cambia). Requiere 4C-1 aplicado ANTES.
-- LECTURA solamente: la escritura de documentosClinicos por Secretaría sigue siendo NUNCA (la RPC de guardado no la admite). Receta, ECG, estudios, mensajes a colega y demás tipos heredados siguen fuera.
-- CLIENTE Y 4B: ya incorporados en el árbol (app.js TIPOS_DOC_SECRETARIA_V1, cardiolink-config-secretaria-v1.js TIPOS_DOC_LECTURA, etapa A de 4B y sus pruebas B2/C14/D8 y SQL QA). Este archivo lleva la BASE YA INSTALADA
-- a la misma lista (la etapa A original sólo devolvía constancia_atencion). Aplicarlo ANTES que el cliente nuevo es inocuo (el cliente viejo filtra por su cuenta); después, el cliente nuevo ve los tipos ampliados.
-- Rollback: pending_review_documentos_seguridad_4c1b_heredados_rollback.sql.

DO $$
BEGIN
  IF to_regprocedure('public.cardiolink_config_tipos_doc_sec_v1()') IS NULL THEN RAISE EXCEPTION 'Precondición: falta la etapa A de 4B (cardiolink_config_tipos_doc_sec_v1)'; END IF;
  IF (SELECT public.cardiolink_config_tipos_doc_sec_v1()) IS DISTINCT FROM ARRAY['constancia_atencion']::text[] THEN
    RAISE EXCEPTION 'Precondición: la lista vigente no es la esperada (constancia_atencion): ¿ya aplicado?'; END IF;
  IF to_regprocedure('public.cardiolink_config_vista_sec_v1(jsonb)') IS NULL THEN RAISE EXCEPTION 'Precondición: falta cardiolink_config_vista_sec_v1(jsonb) (etapa A de 4B)'; END IF;
  IF (SELECT provolatile FROM pg_proc WHERE oid = 'public.cardiolink_config_vista_sec_v1(jsonb)'::regprocedure) <> 'i' THEN RAISE EXCEPTION 'Precondición: la vista de lectura ya no es la original (¿ya aplicado?)'; END IF;
  IF to_regprocedure('public.cardiolink_profesionales_autorizados_secretaria_v1()') IS NULL THEN RAISE EXCEPTION 'Precondición: aplicar antes el bloque 4C-1 (profesionales autorizados de Secretaría)'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.cardiolink_config_tipos_doc_sec_v1()
 RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $f$
 SELECT ARRAY[
  -- TIPOS_DOC_INICIO
  'constancia_atencion','certificado','reposo_laboral','orden'
  -- TIPOS_DOC_FIN
 ]::text[]
$f$;

-- Vista de LECTURA con la restricción por profesional autorizado (v2.2). Conserva grants (CREATE OR REPLACE): sin EXECUTE para anon/authenticated.
CREATE OR REPLACE FUNCTION public.cardiolink_config_vista_sec_v1(p_config jsonb)
 RETURNS jsonb LANGUAGE sql STABLE
AS $f$
 SELECT coalesce(jsonb_object_agg(k,
          CASE
            WHEN k = 'pacientes' AND jsonb_typeof(p_config -> k) = 'array'
              THEN public.cardiolink_config_filtrar_objetos_v1(p_config -> k, public.cardiolink_config_campos_paciente_v1())
            WHEN k = 'profesionales' AND jsonb_typeof(p_config -> k) = 'array'
              THEN public.cardiolink_config_filtrar_objetos_v1(p_config -> k,
                     public.cardiolink_config_campos_profesional_admin_v1() || public.cardiolink_config_claves_identidad_v1())
            WHEN k = 'documentosClinicos' AND jsonb_typeof(p_config -> k) = 'array'
              THEN coalesce((SELECT jsonb_agg(d.x ORDER BY d.ord)
                               FROM jsonb_array_elements(p_config -> k) WITH ORDINALITY AS d(x, ord)
                              WHERE jsonb_typeof(d.x) = 'object' AND (d.x ->> 'tipo') = ANY (public.cardiolink_config_tipos_doc_sec_v1())
                                AND (d.x ->> 'profesionalId') = ANY (coalesce(public.cardiolink_profesionales_autorizados_secretaria_v1(), ARRAY[]::text[]))), '[]'::jsonb)
            ELSE p_config -> k
          END) FILTER (WHERE p_config ? k), '{}'::jsonb)
   FROM unnest(public.cardiolink_config_claves_lectura_sec_v1()) AS k
$f$;

DO $$
BEGIN
  IF (SELECT public.cardiolink_config_tipos_doc_sec_v1()) IS DISTINCT FROM ARRAY['constancia_atencion','certificado','reposo_laboral','orden']::text[] THEN RAISE EXCEPTION 'FALLA: lista inesperada'; END IF;
  IF (SELECT provolatile FROM pg_proc WHERE oid = 'public.cardiolink_config_vista_sec_v1(jsonb)'::regprocedure) <> 's' THEN RAISE EXCEPTION 'FALLA: la vista de lectura debe ser STABLE'; END IF;
  IF has_function_privilege('anon','public.cardiolink_config_vista_sec_v1(jsonb)','EXECUTE') OR has_function_privilege('authenticated','public.cardiolink_config_vista_sec_v1(jsonb)','EXECUTE') THEN RAISE EXCEPTION 'FALLA: la vista de lectura es interna'; END IF;
  IF has_function_privilege('anon','public.cardiolink_config_tipos_doc_sec_v1()','EXECUTE') OR has_function_privilege('authenticated','public.cardiolink_config_tipos_doc_sec_v1()','EXECUTE') THEN
    RAISE EXCEPTION 'FALLA: la función es interna (sin EXECUTE para anon/authenticated) y debe seguir así'; END IF;
END $$;


DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_policies WHERE policyname LIKE '%\_4c1' ESCAPE '\' AND permissive = 'RESTRICTIVE'; IF n <> 6 THEN RAISE EXCEPTION 'FALLA I6: políticas 4C-1 restrictivas = % (esperadas 6)', n; END IF;
  SELECT count(*) INTO n FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('cardiolink_tipos_documento_secretaria_v1','cardiolink_profesionales_autorizados_secretaria_v1','cardiolink_secretaria_autorizada_prof_v1','cardiolink_objeto_sin_fila_v1','cardiolink_objeto_asignable_v1','cardiolink_vinculo_documental_v1','cardiolink_patient_documents_inmutables_4c1'); IF n <> 7 THEN RAISE EXCEPTION 'FALLA I7: funciones 4C-1 = % (esperadas 7)', n; END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.cardiolink_patient_documents'::regclass AND tgname='cardiolink_patient_documents_inmutables_4c1') <> 1 THEN RAISE EXCEPTION 'FALLA I8: trigger de 4C-1'; END IF;
  IF coalesce(obj_description(to_regprocedure('public.cardiolink_historial_envios_documento_v1(text[])'), 'pg_proc'), '') NOT LIKE '%[4C-1:%' THEN RAISE EXCEPTION 'FALLA I9: la RPC del historial no quedó con la marca de 4C-1'; END IF;
  IF public.cardiolink_config_tipos_doc_sec_v1() IS DISTINCT FROM ARRAY['constancia_atencion','certificado','reposo_laboral','orden']::text[] THEN RAISE EXCEPTION 'FALLA I10: lista de heredados de 4C-1b'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND policyname LIKE '%\_v1' ESCAPE '\') <> 8 THEN RAISE EXCEPTION 'FALLA I11: políticas HC _v1'; END IF;
  RAISE EXCEPTION 'ENSAYO_INTEGRACION_OK: huella de p1-p3 idéntica a STAGING; 4C-1 (6 políticas, 7 funciones, trigger, RPC con marca) y 4C-1b aplican sobre el estado equivalente a Production; se revierte TODO.';
END $$;
ROLLBACK;
