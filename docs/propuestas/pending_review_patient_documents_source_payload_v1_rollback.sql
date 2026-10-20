-- CardioLink · Documentos V1 · Bloque A — ROLLBACK de source_payload, SIN PÉRDIDA de documentos
-- BORRADOR PARA REVISIÓN. NO EJECUTAR sin autorización explícita. SOLO STAGING.
--
-- Qué se conserva siempre: TODAS las filas de cardiolink_patient_documents, todos los PDF de Storage y todos los demás campos.
-- Este script sólo quita la columna source_payload, su CHECK y el trigger de inmutabilidad (con su función). Como esa columna es lo único que permite reconstruir y EDITAR un
-- documento en otro dispositivo, antes de quitarla se COPIA a una tabla de respaldo (cardiolink_patient_documents_source_payload_backup)
-- y se verifica que la copia sea exacta; si no lo es, aborta y no se borra nada.
--
-- Orden de operaciones (todo en UNA transacción):
--   1) precondición: la columna existe;
--   2) crea la tabla de respaldo (si no existe) con RLS habilitada y SIN acceso para anon/authenticated (sólo el rol dueño /
--      service_role desde el SQL Editor la ven: el payload es texto clínico);
--   3) copia (idempotente) id, patient_id, source_document_id, source_content_hash, source_payload de cada fila con payload;
--   4) verifica que cada payload no nulo esté en el respaldo, idéntico; si no => EXCEPTION => nada cambia;
--   5) quita el trigger de inmutabilidad y su función, el CHECK y la columna.
-- La tabla de respaldo NO se elimina: se borra a mano, sólo cuando se confirme que ya no hace falta.
--
-- Restaurar (volver a aplicar la migración y recuperar los payloads): ver la sección RESTAURACIÓN al final.

begin;

do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='cardiolink_patient_documents' and column_name='source_payload') then
    raise exception 'source_payload no existe: no hay nada que revertir';
  end if;
end $$;

create table if not exists public.cardiolink_patient_documents_source_payload_backup (
  document_id          uuid primary key,          -- cardiolink_patient_documents.id (sin FK: sobrevive aunque la fila se borre)
  patient_id           text not null,
  source_document_id   text null,
  source_content_hash  text null,
  source_payload       jsonb not null,
  document_created_at  timestamptz null,
  backed_up_at         timestamptz not null default now()
);
alter table public.cardiolink_patient_documents_source_payload_backup enable row level security;
revoke all on table public.cardiolink_patient_documents_source_payload_backup from public, anon, authenticated;
-- sin policies a propósito: nadie por la API; sólo el SQL Editor / service_role.

insert into public.cardiolink_patient_documents_source_payload_backup
  (document_id, patient_id, source_document_id, source_content_hash, source_payload, document_created_at)
select id, patient_id, source_document_id, source_content_hash, source_payload, created_at
from public.cardiolink_patient_documents
where source_payload is not null
on conflict (document_id) do update
  set source_payload      = excluded.source_payload,
      source_document_id  = excluded.source_document_id,
      source_content_hash = excluded.source_content_hash,
      backed_up_at        = now();

do $$
declare v_faltan int; v_total int;
begin
  select count(*) into v_total from public.cardiolink_patient_documents where source_payload is not null;
  select count(*) into v_faltan
  from public.cardiolink_patient_documents d
  where d.source_payload is not null
    and not exists (select 1 from public.cardiolink_patient_documents_source_payload_backup b
                    where b.document_id = d.id and b.source_payload = d.source_payload);
  if v_faltan > 0 then
    raise exception 'Respaldo incompleto: % de % payloads no coinciden en la tabla de respaldo. No se quita la columna.', v_faltan, v_total;
  end if;
  raise notice 'Respaldo verificado: % payloads copiados y comparados.', v_total;
end $$;

-- El trigger y su función se quitan ANTES que la columna: si quedaran, la función haría referencia a una columna inexistente
-- y rompería todo UPDATE posterior de la tabla (incluido el de evolution_id al adjuntar estudios).
drop trigger if exists cardiolink_patient_documents_guard_version on public.cardiolink_patient_documents;
drop function if exists public.cardiolink_patient_documents_guard_version();
alter table public.cardiolink_patient_documents drop constraint if exists cardiolink_patient_documents_source_payload_chk;
alter table public.cardiolink_patient_documents drop column source_payload;

-- verificación final: la columna ya no está y las filas siguen todas ahí
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='cardiolink_patient_documents' and column_name='source_payload') then
    raise exception 'La columna source_payload sigue existiendo';
  end if;
  if exists (select 1 from pg_trigger where tgrelid='public.cardiolink_patient_documents'::regclass and not tgisinternal
             and tgname='cardiolink_patient_documents_guard_version')
     or to_regprocedure('public.cardiolink_patient_documents_guard_version()') is not null then
    raise exception 'El trigger/función de inmutabilidad siguen existiendo';
  end if;
end $$;

commit;

-- ---------------------------------------------------------------------------------------------------------------------
-- RESTAURACIÓN (volver a la versión con source_payload sin perder lo respaldado). Ejecutar en este orden:
--   1) volver a aplicar pending_review_patient_documents_source_payload_v1.sql (crea la columna vacía);
--   2) recuperar los payloads:
--
--   begin;
--   update public.cardiolink_patient_documents d
--      set source_payload = b.source_payload
--     from public.cardiolink_patient_documents_source_payload_backup b
--    where b.document_id = d.id and d.source_payload is null;
--   -- comprobar: debe devolver 0
--   select count(*) as sin_restaurar
--     from public.cardiolink_patient_documents_source_payload_backup b
--    where not exists (select 1 from public.cardiolink_patient_documents d where d.id = b.document_id and d.source_payload = b.source_payload);
--   commit;
--
--   (Los respaldos de filas que ya no existan en cardiolink_patient_documents quedan en la tabla de respaldo, no se pierden.)
-- ---------------------------------------------------------------------------------------------------------------------
