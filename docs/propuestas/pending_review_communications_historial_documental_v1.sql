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
--     * owner / admin activos: todas las filas de los ids pedidos (acceso administrativo, sin cambios);
--     * secretaria activa (CORRECCIÓN 4C-1 v2.3): SÓLO filas de documentos que EXISTEN, cuyo professional_id sea de un profesional con asociación ACTIVA con esa Secretaría
--       (cardiolink_profesionales_autorizados_secretaria_v1), de un tipo de cardiolink_tipos_documento_secretaria_v1() y que no sean 'Imagen clínica' ni estén bajo clinical-images/.
--       Como la función es SECURITY DEFINER la RLS no interviene: la validación está escrita en la propia función. Documento inexistente, sin profesional o de otro profesional: no sale;
--     * médico activo: sólo filas cuyo documento (cardiolink_patient_documents.id = document_id) lo emitió ÉL, con la misma regla de
--       emisor que la eliminación: professional_id = su professional_id (vínculo cuenta->profesional); si la fila no tiene
--       professional_id, sólo si la subió él (uploaded_by = auth.uid()). Documento de otro profesional, huérfano (fila ya eliminada) o
--       sin dueño legible: no lo ve;
--     * cualquier otra cuenta, sin sesión o rol inactivo: conjunto vacío (falla cerrada, sin error que informe nada).
--   Máximo 500 ids por llamada (más: conjunto vacío). El cliente ya consulta por lotes de 80.
-- DEPENDENCIA (v2.3): esta parte requiere el Bloque 4C-1 aplicado ANTES (usa sus funciones de asociación y de tipos). Si 4C-1 ya instaló esta función (mismo cuerpo), este archivo no cambia nada.
--   El cuerpo es IDÉNTICO al de pending_review_documentos_seguridad_4c1.sql (sección 5d): tests/documentos-seguridad-4c1.js (F21) lo verifica.
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
  if to_regprocedure('public.cardiolink_profesionales_autorizados_secretaria_v1()') is null or to_regprocedure('public.cardiolink_tipos_documento_secretaria_v1()') is null then
    raise exception 'Aplicar primero el Bloque 4C-1 (pending_review_documentos_seguridad_4c1.sql): esta función valida a Secretaría con sus funciones de asociación activa y de tipos';
  end if;
end $$;

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

revoke all privileges on function public.cardiolink_historial_envios_documento_v1(text[]) from public, anon, authenticated;
grant execute on function public.cardiolink_historial_envios_documento_v1(text[]) to authenticated;

-- el comentario sólo se fija si la función no lo tiene (si 4C-1 ya la instaló, conserva su marca «[4C-1: …]», de la que depende su rollback)
do $$
begin
  if obj_description('public.cardiolink_historial_envios_documento_v1(text[])'::regprocedure, 'pg_proc') is null then
    comment on function public.cardiolink_historial_envios_documento_v1(text[]) is
      'Historial de envíos de documentos (tipo document_delivery) de los ids pedidos, sin message, subject ni provider_message_id. owner/admin: todos; médico: sólo los de documentos que emitió él; '
      'Secretaría: sólo los de documentos existentes de profesionales con asociación ACTIVA con ella, de tipo permitido y que no sean Imagen clínica (validado dentro de la función).';
  end if;
end $$;

commit;
