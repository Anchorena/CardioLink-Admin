-- CardioLink · Documentos V1 · Eliminación de documentos por EMISOR/CREADOR (no sólo por rol)
-- BORRADOR PARA REVISIÓN. NO EJECUTAR sin autorización explícita. Primero STAGING; Production sólo con autorización aparte.
-- No está en supabase/migrations a propósito: `supabase db push` no debe poder aplicarla por accidente.
--
-- Problema: la policy DELETE de cardiolink_patient_documents y la de storage.objects (bucket patient-documents) usan
-- cardiolink_can_delete_clinical_documents() = base_role IN ('owner','admin','medico'). Un médico puede borrar documentos (fila y PDF)
-- de CUALQUIER profesional. Además la policy UPDATE deja cambiar professional_id / uploaded_by, así que filtrar por emisor sin cerrar
-- eso sería eludible (el médico se pone como emisor y borra).
--
-- Qué hace (y nada más):
--   1) función cardiolink_can_delete_clinical_document(professional_id, uploaded_by): owner/admin activos => siempre; médico activo =>
--        * si la fila TIENE professional_id: sólo cuando coincide con SU professional_id (cardiolink_user_roles.professional_id, vínculo
--          cuenta->profesional que sólo administra el servidor). Haberla subido él NO alcanza si está atribuida a otro profesional;
--        * si professional_id es NULL: sólo quien la subió, y sólo si uploaded_by está confirmado (uploaded_by = auth.uid());
--   2) policy DELETE de la tabla y de storage.objects pasan a usar esa función (en storage, vía la fila por storage_path; un objeto
--      huérfano, sin fila, sólo lo borra su subidor o owner/admin);
--   3) trigger BEFORE INSERT/UPDATE: uploaded_by lo fija el servidor (auth.uid()) y professional_id/uploaded_by NO cambian salvo
--      por owner/admin. service_role / SQL Editor (auth.uid() nulo) quedan sin cambios.
-- NO modifica: datos existentes, policies SELECT/INSERT/UPDATE, la función anterior (la sigue usando UPDATE), source_payload ni su trigger.
-- Rollback: pending_review_patient_documents_delete_ownership_v1_rollback.sql.

begin;

-- Precondiciones: si algo falta, todo se revierte.
do $$
begin
  if to_regprocedure('public.cardiolink_can_delete_clinical_documents()') is null then
    raise exception 'falta cardiolink_can_delete_clinical_documents()';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='cardiolink_user_roles' and column_name='professional_id') then
    raise exception 'falta cardiolink_user_roles.professional_id';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='storage' and table_name='objects' and column_name='owner') then
    raise exception 'falta storage.objects.owner';
  end if;
end $$;

-- 1) Autorización por emisor/creador
create or replace function public.cardiolink_can_delete_clinical_document(p_professional_id text, p_uploaded_by uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select exists (
    select 1
      from public.cardiolink_user_roles as ur
     where ur.user_id = auth.uid()
       and ur.active
       and (
            ur.base_role in ('owner', 'admin')
         or (
              ur.base_role = 'medico'
          and (
                case
                  when p_professional_id is not null
                    then ur.professional_id is not null and p_professional_id = ur.professional_id
                  else p_uploaded_by is not null and p_uploaded_by = auth.uid()
                end
              )
            )
       )
  );
$function$;

revoke all privileges on function public.cardiolink_can_delete_clinical_document(text, uuid) from public, anon, authenticated;
grant execute on function public.cardiolink_can_delete_clinical_document(text, uuid) to authenticated;

-- 2) DELETE de la tabla
drop policy cardiolink_patient_documents_delete on public.cardiolink_patient_documents;
create policy cardiolink_patient_documents_delete
on public.cardiolink_patient_documents
for delete to authenticated
using (public.cardiolink_can_delete_clinical_document(professional_id, uploaded_by));

-- 3) DELETE de Storage: misma regla, a través de la fila; objeto sin fila => sólo su subidor (o owner/admin)
drop policy cardiolink_patient_documents_storage_delete on storage.objects;
create policy cardiolink_patient_documents_storage_delete
on storage.objects
for delete to authenticated
using (
  bucket_id = 'patient-documents'
  and (
    exists (
      select 1 from public.cardiolink_patient_documents as d
       where d.storage_path = storage.objects.name
         and public.cardiolink_can_delete_clinical_document(d.professional_id, d.uploaded_by)
    )
    or (
      not exists (select 1 from public.cardiolink_patient_documents as d where d.storage_path = storage.objects.name)
      and public.cardiolink_can_delete_clinical_document(null, storage.objects.owner)
    )
  )
);

-- 4) Identidad confiable del emisor/creador
create or replace function public.cardiolink_patient_documents_actor_guard_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if auth.uid() is null then
    return new;                                   -- service_role / SQL Editor: sin cambios
  end if;
  if tg_op = 'INSERT' then
    new.uploaded_by := auth.uid();                -- no se confía en lo que manda el navegador
    return new;
  end if;
  if (new.professional_id is distinct from old.professional_id or new.uploaded_by is distinct from old.uploaded_by)
     and not exists (
       select 1 from public.cardiolink_user_roles as ur
        where ur.user_id = auth.uid() and ur.active and ur.base_role in ('owner', 'admin')
     ) then
    raise exception 'professional_id y uploaded_by sólo los modifica owner/admin' using errcode = '42501';
  end if;
  return new;
end;
$function$;

revoke all privileges on function public.cardiolink_patient_documents_actor_guard_v1() from public, anon, authenticated;

create trigger cardiolink_patient_documents_actor_guard_v1
  before insert or update on public.cardiolink_patient_documents
  for each row execute function public.cardiolink_patient_documents_actor_guard_v1();

commit;
