-- Rollback del Bloque 4C-1 (seguridad documental): quita las 6 políticas restrictivas, el trigger y las 7 funciones nuevas, RESTAURA la función del historial de envíos (v2.3: si 4C-1 la REEMPLAZÓ vuelve su cuerpo
-- anterior —el de la PARTE 1 de pending_review_communications_historial_documental_v1—; si 4C-1 la CREÓ, la elimina; se distingue por la marca «[4C-1: …]» de su comentario) y RESTAURA EXACTAMENTE las 4 políticas restrictivas
-- de 'Imagen clínica' de la migración 20261007130000. No toca datos. Las políticas permisivas, DELETE, los triggers previos (actor_guard, guard_version) y cardiolink_paciente_acceso_clinico_v1 no se tocaron y no se tocan.
-- Ejecutar sólo con autorización explícita.
BEGIN;

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

COMMIT;
