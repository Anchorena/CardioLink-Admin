-- CardioLink Admin - Documentos y estudios PDF (Fase 6 / Bloque 6D.2)
-- Vínculo REAL documento <-> evolución clínica.
--
-- Corrección sobre el enfoque anterior de impresión, que usaba
-- attention_id como sustituto de una relación documento <-> evolución
-- (confirmado incorrecto por auditoría externa: ningún documento queda
-- realmente vinculado así). Esta migración agrega una columna explícita
-- evolution_id, con FK real a cardiolink_hc_evoluciones(id).
--
-- attention_id se mantiene SIN CAMBIOS: representa otra relación distinta
-- (documento <-> atención/turno), no se usa para este propósito y no hay
-- que confundirla con evolution_id.
--
-- No modifica las migraciones ya aplicadas (20261007100000_... y
-- 20261007110000_...).

begin;

alter table public.cardiolink_patient_documents
  add column evolution_id text null
    references public.cardiolink_hc_evoluciones (id)
    on delete set null;

comment on column public.cardiolink_patient_documents.evolution_id is
  'Fase 6 / Bloque 6D.2. Vínculo explícito con la evolución clínica a la '
  'que este documento quedó asociado (NULL = documento independiente, '
  'se muestra como "Estudio incorporado"). Distinto de attention_id '
  '(turno/atención) - no reemplaza esa columna, es una relación aparte.';

create index idx_cardiolink_patient_documents_evolution
  on public.cardiolink_patient_documents (evolution_id);

-- ---------------------------------------------------------------------------
-- Permiso UPDATE (hoy la tabla sólo tenía SELECT/INSERT/DELETE). Único uso
-- previsto: asociar/desasociar evolution_id al guardar una evolución.
-- Mismo criterio ya usado para DELETE (owner/admin/médico) - se reutiliza
-- la misma función cardiolink_can_delete_clinical_documents(), no se crea
-- una función ni un rol nuevo. Secretaría no participa de Historia
-- Clínica/evoluciones, así que tampoco puede vincular/desvincular
-- documentos (coherente con que ya no puede ver la sección de HC desde
-- la migración anterior).
-- ---------------------------------------------------------------------------

grant update on table public.cardiolink_patient_documents to authenticated;

create policy cardiolink_patient_documents_update
on public.cardiolink_patient_documents
for update to authenticated
using (public.cardiolink_can_delete_clinical_documents())
with check (public.cardiolink_can_delete_clinical_documents());

commit;
