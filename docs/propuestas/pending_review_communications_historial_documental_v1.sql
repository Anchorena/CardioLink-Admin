-- CardioLink · Historial de envíos de documentos · PARTE 1: lectura segura por función (RPC)
-- BORRADOR PARA REVISIÓN. NO EJECUTAR sin autorización explícita. Primero STAGING; Production sólo con autorización aparte.
-- No está en supabase/migrations a propósito: `supabase db push` no debe poder aplicarla por accidente.
--
-- Problema: la policy SELECT de cardiolink_communications usa cardiolink_has_communications_access() (owner/admin/secretaria/médico) y no
-- filtra filas: cualquier médico activo lee TODAS las comunicaciones (todos los tipos, de todos los pacientes), incluidas las columnas
-- message, subject, provider_message_id y los emails/teléfonos de destino.
--
-- Qué hace esta parte (y nada más):
--   Crea cardiolink_historial_envios_documento_v1(p_document_ids text[]): devuelve SÓLO el historial de envíos de documentos
--   (tipo 'document_delivery') de los ids pedidos, con 12 columnas seguras (nunca message, subject ni provider_message_id; el uuid del
--   usuario que envió se reemplaza por dos banderas calculadas). Autorización en el servidor:
--     * owner / admin / secretaria activos: todas las filas de los ids pedidos (acceso operativo, sin cambios de alcance);
--     * médico activo: sólo filas cuyo documento (cardiolink_patient_documents.id = document_id) lo emitió ÉL, con la misma regla de
--       emisor que la eliminación: professional_id = su professional_id (vínculo cuenta->profesional); si la fila no tiene
--       professional_id, sólo si la subió él (uploaded_by = auth.uid()). Documento de otro profesional, huérfano (fila ya eliminada) o
--       sin dueño legible: no lo ve;
--     * cualquier otra cuenta, sin sesión o rol inactivo: conjunto vacío (falla cerrada, sin error que informe nada).
--   Máximo 500 ids por llamada (más: conjunto vacío). El cliente ya consulta por lotes de 80.
-- NO modifica: datos, la policy SELECT de cardiolink_communications (eso es la PARTE 2, aparte), cardiolink_has_communications_access()
-- (la sigue usando patient-communications para autorizar envíos), las Edge Functions, los envíos ni el historial existente.
-- Rollback: pending_review_communications_historial_documental_v1_rollback.sql (sección B).

begin;

-- Precondiciones: si algo falta, todo se revierte.
do $$
begin
  if to_regclass('public.cardiolink_communications') is null then
    raise exception 'falta public.cardiolink_communications';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='cardiolink_communications' and column_name='document_id') then
    raise exception 'falta cardiolink_communications.document_id';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='cardiolink_user_roles' and column_name='professional_id') then
    raise exception 'falta cardiolink_user_roles.professional_id (migración de eliminación por emisor)';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='cardiolink_patient_documents' and column_name='uploaded_by') then
    raise exception 'falta cardiolink_patient_documents.uploaded_by';
  end if;
end $$;

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

revoke all privileges on function public.cardiolink_historial_envios_documento_v1(text[]) from public, anon, authenticated;
grant execute on function public.cardiolink_historial_envios_documento_v1(text[]) to authenticated;

comment on function public.cardiolink_historial_envios_documento_v1(text[]) is
  'Historial de envíos de documentos (tipo document_delivery) de los ids pedidos. owner/admin/secretaria: todos; médico: sólo los de documentos que emitió él '
  '(professional_id propio, o sin professional_id y subido por él). Nunca devuelve message, subject ni provider_message_id.';

commit;
