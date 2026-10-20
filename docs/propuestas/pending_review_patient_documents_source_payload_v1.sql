-- CardioLink · Documentos V1 · Bloque A — cardiolink_patient_documents.source_payload + trigger de inmutabilidad
-- DEFINITIVO PARA REVISIÓN. NO EJECUTAR sin autorización explícita.
-- SOLO STAGING (yslhwdlzdknhskawqrtv). NO ejecutar en Production.
-- No está en supabase/migrations a propósito: `supabase db push` no debe poder aplicarla por accidente.
--
-- Para qué: cada versión archivada de un documento (fila de cardiolink_patient_documents + PDF en Storage) lleva los datos
-- para RECONSTRUIR Y EDITAR el documento desde otro dispositivo. El cuerpo ("contenido") hoy existe sólo dentro del PDF y en la
-- caché local del navegador, y el perfil médico nunca escribe la config remota.
--
-- Qué hace (y nada más):
--   1) columna nullable source_payload jsonb (sin default, sin NOT NULL: las filas existentes quedan NULL);
--   2) CHECK: objeto JSON de hasta 256 KiB;
--   3) trigger BEFORE UPDATE: una versión archivada con payload NO puede cambiar source_payload, source_document_id,
--      source_content_hash (identidad y contenido de la versión), patient_id (no se reasigna a otro paciente) ni storage_path
--      (no se cambia el PDF al que apunta). Cada edición de un documento = INSERT de una fila NUEVA;
--      la vigente es la más reciente por source_document_id. Todo lo demás sigue siendo actualizable, en particular:
--        * evolution_id / attention_id (vincular o desvincular estudios de una evolución: es el único UPDATE que hace la app hoy),
--        * title, description, professional_id, document_date, document_type, updated_at (cambios administrativos);
--      (patient_id y storage_path quedan fijos SOLO en filas con payload; en filas sin payload siguen siendo actualizables);
--      las filas SIN payload (PDF subidos a mano, imágenes clínicas, versiones previas a esta columna) no quedan afectadas;
--      NULL -> valor (completar una fila vieja) está permitido: sólo se bloquea modificar un payload ya guardado;
--   4) autoprueba dentro de la transacción (inserta 3 filas de prueba, prueba el trigger y borra ÚNICAMENTE esas 3 por su UUID);
--      si algo falla, TODO se revierte.
--
-- NO modifica: datos existentes, policies, grants, Edge Functions, Storage, ni otras tablas. El trigger NO afecta INSERT ni DELETE
-- (eliminar una versión sigue gobernado por la policy de DELETE ya existente: owner/admin/médico).
--
-- RLS/grants existentes. CONFIRMADO en STAGING con checks de solo lectura (2026-10-13, antes de aplicar):
--   source_document_id y source_content_hash existen; source_payload NO existe; RLS activa; 6 policies; authenticated con
--   SELECT/INSERT/UPDATE/DELETE; anon sin permisos directos; sin ACL especiales de columna; sin triggers; FK evolution_id correcta.
--   * policies por FILA basadas en funciones/document_type, sin referencias a columnas => cubren la columna nueva;
--   * GRANT a nivel de TABLA (select/insert/update/delete a authenticated; nada a anon/PUBLIC) => la columna nueva los hereda.
--
-- Dry-run: reemplazar el COMMIT final por ROLLBACK y ejecutar. Rollback sin pérdida: ..._rollback.sql. Checks: ..._checks.sql.

begin;

-- 0) Precondiciones: aborta si el esquema no es el esperado o si esto ya se aplicó.
do $$
begin
  if to_regclass('public.cardiolink_patient_documents') is null then
    raise exception 'No existe public.cardiolink_patient_documents';
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='cardiolink_patient_documents' and column_name='source_document_id')
     or not exists (select 1 from information_schema.columns
                    where table_schema='public' and table_name='cardiolink_patient_documents' and column_name='source_content_hash') then
    raise exception 'Faltan source_document_id/source_content_hash: aplicar antes 20261008110000_cardiolink_patient_documents_source_link.sql';
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='cardiolink_patient_documents' and column_name='source_payload') then
    raise exception 'source_payload ya existe: la migración ya fue aplicada (no se repite)';
  end if;
  if to_regprocedure('public.cardiolink_patient_documents_guard_version()') is not null then
    raise exception 'Ya existe public.cardiolink_patient_documents_guard_version(): no se repite';
  end if;
  if not (select relrowsecurity from pg_class where oid='public.cardiolink_patient_documents'::regclass) then
    raise exception 'RLS no está habilitada en cardiolink_patient_documents: no continuar';
  end if;
end $$;

-- 1) La columna. Nullable, sin default: ninguna fila existente cambia.
alter table public.cardiolink_patient_documents
  add column source_payload jsonb null;

comment on column public.cardiolink_patient_documents.source_payload is
  'Documentos V1 / Bloque A. Datos para reconstruir y editar el documento fuente (data.documentosClinicos) a partir de esta '
  'versión archivada: tipo, título, contenido, adicional, fecha, profesional, incluirFirma, paciente (id/nombre/DNI). '
  'NULL para PDFs subidos a mano, imágenes clínicas y versiones archivadas antes de esta columna. Una fila = una versión; '
  'una vez guardado NO se modifica (trigger, que además fija patient_id y storage_path de la fila): una edición crea una fila nueva '
  '(la vigente es la más reciente por source_document_id).';

-- 2) Salvaguarda de forma/tamaño. octet_length(text) es inmutable (apto para CHECK).
alter table public.cardiolink_patient_documents
  add constraint cardiolink_patient_documents_source_payload_chk
  check (source_payload is null
         or (jsonb_typeof(source_payload) = 'object' and octet_length(source_payload::text) <= 262144));

-- 3) Inmutabilidad de la versión archivada. SECURITY INVOKER (no eleva privilegios): sólo compara OLD y NEW.
--    Con payload guardado quedan fijos: contenido (source_payload), identidad de la versión (source_document_id, source_content_hash),
--    paciente (patient_id) y archivo (storage_path). El resto de las columnas sigue siendo actualizable.
create function public.cardiolink_patient_documents_guard_version()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $function$
begin
  if old.source_payload is not null
     and (new.source_payload       is distinct from old.source_payload
          or new.source_document_id  is distinct from old.source_document_id
          or new.source_content_hash is distinct from old.source_content_hash
          or new.patient_id          is distinct from old.patient_id
          or new.storage_path        is distinct from old.storage_path) then
    raise exception 'Una versión archivada de un documento no se modifica (source_payload / source_document_id / source_content_hash / patient_id / storage_path): guardá una versión nueva.'
      using errcode = 'P0001', hint = 'Cada edición se archiva como una fila nueva; la vigente es la más reciente por source_document_id.';
  end if;
  return new;
end;
$function$;

revoke all privileges on function public.cardiolink_patient_documents_guard_version() from public, anon, authenticated;

create trigger cardiolink_patient_documents_guard_version
  before update on public.cardiolink_patient_documents
  for each row execute function public.cardiolink_patient_documents_guard_version();

-- 4) Autoprueba (se ejecuta con los privilegios de quien corre la migración; deja 0 filas: borra lo que crea).
do $$
declare
  v_marca constant text := '__qa_migracion_source_payload__';   -- sólo etiqueta de las filas de prueba; NUNCA se usa para borrar
  v_id    uuid := gen_random_uuid();
  v_id2   uuid := gen_random_uuid();
  v_id3   uuid := gen_random_uuid();
  v_evo   text;
  v_bloqueado boolean;
begin
  insert into public.cardiolink_patient_documents
    (id, patient_id, document_type, title, storage_path, original_filename, mime_type,
     source_document_id, source_content_hash, source_payload)
  values
    (v_id, v_marca, 'Orden', 'qa v1', 'qa-migracion/' || v_id || '.pdf', 'qa.pdf', 'application/pdf',
     'doc_qa', 'hash_qa_1', '{"contenido":"original"}'::jsonb);

  -- 4a) cambios administrativos legítimos: PASAN
  update public.cardiolink_patient_documents
     set attention_id = 'att_qa', title = 'qa v1 (retitulada)', description = 'nota administrativa',
         professional_id = 'prof_qa', document_date = current_date
   where id = v_id;
  select id into v_evo from public.cardiolink_hc_evoluciones limit 1;        -- evolution_id tiene FK: se usa una evolución real si hay
  if v_evo is not null then
    update public.cardiolink_patient_documents set evolution_id = v_evo where id = v_id;   -- vincular a una evolución
    update public.cardiolink_patient_documents set evolution_id = null  where id = v_id;   -- desvincular
  end if;

  -- 4b) la versión archivada NO se puede reescribir: cada intento DEBE fallar
  v_bloqueado := false;
  begin update public.cardiolink_patient_documents set source_payload = '{"contenido":"reescrito"}'::jsonb where id = v_id;
  exception when others then v_bloqueado := true; end;
  if not v_bloqueado then raise exception 'Autoprueba: el trigger NO bloqueó el cambio de source_payload'; end if;

  v_bloqueado := false;
  begin update public.cardiolink_patient_documents set source_payload = null where id = v_id;
  exception when others then v_bloqueado := true; end;
  if not v_bloqueado then raise exception 'Autoprueba: el trigger NO bloqueó el borrado del source_payload'; end if;

  v_bloqueado := false;
  begin update public.cardiolink_patient_documents set source_content_hash = 'hash_otro' where id = v_id;
  exception when others then v_bloqueado := true; end;
  if not v_bloqueado then raise exception 'Autoprueba: el trigger NO bloqueó el cambio de source_content_hash'; end if;

  v_bloqueado := false;
  begin update public.cardiolink_patient_documents set source_document_id = 'doc_otro' where id = v_id;
  exception when others then v_bloqueado := true; end;
  if not v_bloqueado then raise exception 'Autoprueba: el trigger NO bloqueó el cambio de source_document_id'; end if;

  v_bloqueado := false;
  begin update public.cardiolink_patient_documents set patient_id = '__qa_otro_paciente__' where id = v_id;
  exception when others then v_bloqueado := true; end;
  if not v_bloqueado then raise exception 'Autoprueba: el trigger NO bloqueó la reasignación a otro paciente (patient_id)'; end if;

  v_bloqueado := false;
  begin update public.cardiolink_patient_documents set storage_path = 'qa-migracion/otro-archivo.pdf' where id = v_id;
  exception when others then v_bloqueado := true; end;
  if not v_bloqueado then raise exception 'Autoprueba: el trigger NO bloqueó el cambio de storage_path'; end if;

  -- 4c) una edición = fila NUEVA (INSERT no queda afectado) y la anterior permanece intacta
  insert into public.cardiolink_patient_documents
    (id, patient_id, document_type, title, storage_path, original_filename, mime_type,
     source_document_id, source_content_hash, source_payload)
  values
    (v_id2, v_marca, 'Orden', 'qa v2', 'qa-migracion/' || v_id2 || '.pdf', 'qa.pdf', 'application/pdf',
     'doc_qa', 'hash_qa_2', '{"contenido":"editado"}'::jsonb);
  if (select source_payload ->> 'contenido' from public.cardiolink_patient_documents where id = v_id) is distinct from 'original' then
    raise exception 'Autoprueba: la versión anterior cambió';
  end if;

  -- 4d) una fila SIN payload (anterior a esta columna) se puede completar una vez (NULL -> valor); desde ahí queda fija
  insert into public.cardiolink_patient_documents
    (id, patient_id, document_type, title, storage_path, original_filename, mime_type, source_document_id, source_content_hash)
  values
    (v_id3, v_marca, 'Orden', 'qa sin payload', 'qa-migracion/' || v_id3 || '.pdf', 'qa.pdf', 'application/pdf', 'doc_qa_viejo', 'hash_qa_3');
  update public.cardiolink_patient_documents set title = 'qa sin payload (retitulada)' where id = v_id3;                  -- administrativo: pasa
  update public.cardiolink_patient_documents set patient_id = v_marca || '_2', storage_path = 'qa-migracion/' || v_id3 || '_b.pdf' where id = v_id3;   -- sin payload: patient_id/storage_path siguen actualizables
  update public.cardiolink_patient_documents set source_payload = '{"contenido":"completado"}'::jsonb where id = v_id3;   -- NULL -> valor: pasa
  v_bloqueado := false;
  begin update public.cardiolink_patient_documents set source_payload = '{"contenido":"otra vez"}'::jsonb where id = v_id3;
  exception when others then v_bloqueado := true; end;
  if not v_bloqueado then raise exception 'Autoprueba: tras completarse, el payload quedó modificable'; end if;

  -- 4e) DELETE no queda afectado. Se borran ÚNICAMENTE las 3 filas creadas por esta prueba, por su UUID (nunca por patient_id).
  delete from public.cardiolink_patient_documents where id in (v_id, v_id2, v_id3);
  if exists (select 1 from public.cardiolink_patient_documents where id in (v_id, v_id2, v_id3)) then
    raise exception 'Autoprueba: quedaron filas de prueba sin borrar';
  end if;
end $$;

-- 5) Verificación posterior (aborta y revierte si algo no quedó como se espera).
do $$
declare
  v_tipo text; v_nullable text; v_pol int; v_trg int;
begin
  select data_type, is_nullable into v_tipo, v_nullable
  from information_schema.columns
  where table_schema='public' and table_name='cardiolink_patient_documents' and column_name='source_payload';
  if v_tipo is distinct from 'jsonb' or v_nullable is distinct from 'YES' then
    raise exception 'source_payload no quedó como jsonb NULL (tipo=%, nullable=%)', v_tipo, v_nullable;
  end if;

  if exists (select 1 from public.cardiolink_patient_documents where source_payload is not null) then
    raise exception 'Hay filas con source_payload no nulo tras la migración: inesperado';
  end if;

  if not (select relrowsecurity from pg_class where oid='public.cardiolink_patient_documents'::regclass) then
    raise exception 'RLS dejó de estar habilitada';
  end if;

  select count(*) into v_pol from pg_policies where schemaname='public' and tablename='cardiolink_patient_documents';
  if v_pol < 6 then
    raise exception 'Se esperaban al menos 6 policies sobre cardiolink_patient_documents y hay %', v_pol;
  end if;

  select count(*) into v_trg from pg_trigger
   where tgrelid='public.cardiolink_patient_documents'::regclass and not tgisinternal
     and tgname='cardiolink_patient_documents_guard_version' and tgenabled='O';
  if v_trg <> 1 then
    raise exception 'El trigger de inmutabilidad no quedó habilitado';
  end if;

  if has_column_privilege('anon', 'public.cardiolink_patient_documents', 'source_payload', 'select')
     or has_column_privilege('anon', 'public.cardiolink_patient_documents', 'source_payload', 'insert') then
    raise exception 'anon tiene acceso a source_payload: revisar los grants de la tabla';
  end if;
  if not has_column_privilege('authenticated', 'public.cardiolink_patient_documents', 'source_payload', 'select')
     or not has_column_privilege('authenticated', 'public.cardiolink_patient_documents', 'source_payload', 'insert') then
    raise exception 'authenticated no puede leer/insertar source_payload: revisar los grants de la tabla';
  end if;
end $$;

commit;
