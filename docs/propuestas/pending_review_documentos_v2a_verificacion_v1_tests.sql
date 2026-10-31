-- CardioLink · Documentos V2A / F0 — QA TRANSACCIONAL de pending_review_documentos_v2a_verificacion_v1.sql
-- NO EJECUTAR sin autorización explícita. Ejecutar en STAGING (SQL Editor) DESPUÉS de aplicar la migración. Todo ocurre dentro de UNA transacción y termina en ROLLBACK:
-- no deja filas ni cambios. Usa usuarios REALES existentes sólo para fijar auth.uid() (no los modifica) y filas de documentos de prueba (patient_id '__qa_v2a__').
-- Resultado: la ÚLTIMA sentencia lanza un error 'RESULTADO V2A (...): aprobadas=N, fallidas=M, total=T' con la lista de pruebas fallidas (el error es intencional: revierte todo).
-- Esperado: fallidas=0 (con roles reales: aprobadas = total - omitidas). Si falta algún rol, esas pruebas figuran como 'omitida'.

-- Sin BEGIN/COMMIT explícitos a propósito: el script completo corre como UNA transacción implícita y termina en el error intencional del final, que la revierte
-- y deja la sesión limpia (con un BEGIN explícito la sesión quedaría en transacción abortada).

create temp table _res (n serial, prueba text, ok boolean, detalle text) on commit drop;
grant all on _res to public; grant usage on sequence _res_n_seq to public;

-- ejecuta una sentencia como un rol/usuario y devuelve 'OK[: valor]' o 'ERR: mensaje' (subtransacción: un error no aborta el script)
create function pg_temp.como(p_rol text, p_uid uuid, p_sql text) returns text language plpgsql as $f$
declare v text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', p_rol)::text, true);
  execute 'set local role ' || quote_ident(p_rol);
  begin
    execute p_sql into v;
    execute 'reset role';
    perform set_config('request.jwt.claim.sub', '', true); perform set_config('request.jwt.claims', '', true);   -- sin usuario residual: auth.uid() vuelve a ser NULL
    return 'OK' || coalesce(': ' || v, '');
  exception when others then
    execute 'reset role';
    perform set_config('request.jwt.claim.sub', '', true); perform set_config('request.jwt.claims', '', true);
    return 'ERR: ' || sqlerrm;
  end;
end $f$;
-- sube un documento de prueba COMO ese usuario (así un trigger que fija uploaded_by = auth.uid(), como cardiolink_patient_documents_actor_guard_v1, no lo altera)
create function pg_temp.sube_doc(p_uid uuid, p_id uuid, p_tipo text, p_titulo text, p_chain text, p_hash text, p_prof text) returns text language sql as
$f$ select pg_temp.como('authenticated', p_uid, format($q$insert into public.cardiolink_patient_documents (id, patient_id, document_type, title, storage_path, original_filename, mime_type, source_document_id, source_content_hash, source_payload, uploaded_by, professional_id)
  values (%L,'__qa_v2a__',%L,%L,%L,'a.pdf','application/pdf',%L,%L,'{"v":2}'::jsonb,%L,%L) returning id::text$q$, p_id, p_tipo, p_titulo, 'qa-v2a/' || p_id || '.pdf', p_chain, p_hash, p_uid, p_prof)) $f$;
create function pg_temp.anota(p_prueba text, p_ok boolean, p_detalle text default null) returns void language sql as
$f$ insert into _res (prueba, ok, detalle) values (p_prueba, coalesce(p_ok, false), p_detalle) $f$;

do $$
declare
  u_owner uuid; u_med uuid; u_med2 uuid; u_sec uuid; p_med text; p_med2 text; p_otro text := 'otro_prof_qa'; d4 uuid := gen_random_uuid(); d5 uuid := gen_random_uuid(); d6 uuid := gen_random_uuid(); d7 uuid := gen_random_uuid(); d8 uuid := gen_random_uuid(); d9 uuid := gen_random_uuid(); vo uuid; vs uuid; va uuid; n_ins int := 4;
  h1 text := encode(sha256('qa-v2a-codigo-1'::bytea), 'hex'); h2 text := encode(sha256('qa-v2a-codigo-2'::bytea), 'hex'); h3 text := encode(sha256('qa-v2a-codigo-3'::bytea), 'hex');
  hp text := encode(sha256('pdf-1'::bytea), 'hex'); hp2 text := encode(sha256('pdf-2'::bytea), 'hex'); hpin text := encode(sha256('pin-123456'::bytea), 'hex');
  d1 uuid := gen_random_uuid(); d2 uuid := gen_random_uuid(); d3 uuid := gen_random_uuid(); dx uuid := gen_random_uuid();
  v1 uuid; v2 uuid; v3 uuid; r text; j jsonb; antes bigint; despues bigint; i int;
  chain text := 'doc_qa_v2a_cadena';
begin
  select user_id into u_owner from public.cardiolink_user_roles where active and base_role = 'owner' limit 1;
  select user_id, professional_id into u_med, p_med from public.cardiolink_user_roles where active and base_role = 'medico' and nullif(btrim(professional_id),'') is not null order by user_id limit 1;
  select user_id, professional_id into u_med2, p_med2 from public.cardiolink_user_roles where active and base_role = 'medico' and nullif(btrim(professional_id),'') is not null and user_id <> u_med and lower(btrim(professional_id)) <> lower(btrim(p_med)) order by user_id limit 1;
  select user_id into u_sec from public.cardiolink_user_roles where active and base_role = 'secretaria' limit 1;
  if u_owner is null or u_med is null then
    perform pg_temp.anota('prerrequisitos: hace falta al menos un owner y un médico activo CON professional_id', false, 'owner=' || coalesce(u_owner::text,'-') || ' medico=' || coalesce(u_med::text,'-')); return;
  end if;
  select count(*) into antes from public.cardiolink_patient_documents;   -- documentos históricos: no se tocan

  -- documentos de prueba: se suben COMO su usuario real (en STAGING un trigger fija uploaded_by = auth.uid(); insertarlos como superusuario con un
  -- usuario residual en la sesión los atribuiría al usuario equivocado y falsearía las pruebas de propiedad).
  perform pg_temp.sube_doc(u_med, d1, 'Certificado', 'qa v1', chain, 'hh1', p_med);
  perform pg_temp.sube_doc(u_med, d2, 'Certificado', 'qa v2', chain, 'hh2', p_med);
  perform pg_temp.sube_doc(u_med, d3, 'Receta', 'qa receta', 'doc_qa_receta', 'hh3', p_med);
  perform pg_temp.sube_doc(u_med, dx, 'Certificado', 'qa otro', 'doc_qa_otra', 'hh4', p_med);

  -- 1) reservar
  r := pg_temp.como('authenticated', u_med, format($q$select public.cardiolink_verificacion_reservar_v1(%L,'certificado',%L)::text$q$, chain, h1));
  perform pg_temp.anota('1a. el médico reserva un código (hash)', r like 'OK:%', r);
  v1 := substr(r, 5)::uuid;
  r := pg_temp.como('anon', null, format($q$select public.cardiolink_verificacion_reservar_v1(%L,'certificado',%L)::text$q$, chain, h2));
  perform pg_temp.anota('1b. anon NO puede reservar', r like 'ERR:%', r);
  r := pg_temp.como('authenticated', u_med, format($q$select public.cardiolink_verificacion_reservar_v1(%L,'certificado','no-es-un-hash')::text$q$, chain));
  perform pg_temp.anota('1c. hash con formato inválido rechazado', r like 'ERR:%', r);
  r := pg_temp.como('authenticated', u_med, format($q$select public.cardiolink_verificacion_reservar_v1(%L,'certificado',%L)::text$q$, chain, h1));
  perform pg_temp.anota('1d. el mismo código no se reserva dos veces', r like 'ERR:%', r);
  r := pg_temp.como('authenticated', u_med, format($q$select public.cardiolink_verificacion_reservar_v1(%L,'receta',%L)::text$q$, chain, h3));
  perform pg_temp.anota('1e. NO hay verificación para recetas (kind fuera de certificado/constancia/orden)', r like 'ERR:%', r);

  -- 2) estado antes de vincular: no disponible
  j := public.cardiolink_verificacion_consultar_v1(h1, 'iphash', 'movil');
  perform pg_temp.anota('2. una reserva sin vincular responde no_disponible', j->>'estado' = 'no_disponible', j::text);

  -- 3) vincular
  r := pg_temp.como('authenticated', u_owner, format($q$select public.cardiolink_verificacion_vincular_v1(%L,%L,%L)::text$q$, v1, d1, hp));
  perform pg_temp.anota('3a. otro usuario NO puede vincular la reserva ajena', r like 'ERR:%', r);
  if u_med2 is not null then
    r := pg_temp.como('authenticated', u_med2, format($q$select public.cardiolink_verificacion_vincular_v1(%L,%L,%L)::text$q$, v1, d1, hp));
    perform pg_temp.anota('3b. otro médico NO puede vincular la reserva ajena', r like 'ERR:%', r);
  else perform pg_temp.anota('3b. otro médico NO puede vincular la reserva ajena', true, 'omitida: sólo hay un médico'); end if;
  r := pg_temp.como('authenticated', u_med, format($q$select public.cardiolink_verificacion_vincular_v1(%L,%L,%L)::text$q$, v1, dx, hp));
  perform pg_temp.anota('3c. un documento de OTRA cadena no se vincula', r like 'ERR:%', r);
  r := pg_temp.como('authenticated', u_med, format($q$select public.cardiolink_verificacion_vincular_v1(%L,%L,'xx')::text$q$, v1, d1));
  perform pg_temp.anota('3d. huella de PDF inválida rechazada', r like 'ERR:%', r);
  r := pg_temp.como('authenticated', u_med, format($q$select public.cardiolink_verificacion_vincular_v1(%L,%L,%L)::text$q$, v1, d1, hp));
  perform pg_temp.anota('3e. el emisor vincula su documento archivado', r like 'OK:%' and r like '%"ok": true%', r);
  r := pg_temp.como('authenticated', u_med, format($q$select public.cardiolink_verificacion_vincular_v1(%L,%L,%L)::text$q$, v1, d1, hp));
  perform pg_temp.anota('3f. vincular de nuevo (mismo documento y huella) es idempotente', r like '%idempotente": true%', r);
  r := pg_temp.como('authenticated', u_med, format($q$select public.cardiolink_verificacion_vincular_v1(%L,%L,%L)::text$q$, v1, d1, hp2));
  perform pg_temp.anota('3g. la huella del PDF emitido no cambia', r like 'ERR:%', r);

  -- 3h) PROPIEDAD POR PROFESIONAL (el médico sólo emite/anula lo de SU professional_id)
  perform pg_temp.sube_doc(u_med,   d4, 'Certificado', 'qa de otro prof',     'doc_qa_ajeno',  'hh5', p_otro);
  perform pg_temp.sube_doc(u_med,   d5, 'Certificado', 'qa sin prof',         'doc_qa_nulo',   'hh6', null);
  perform pg_temp.sube_doc(u_owner, d6, 'Certificado', 'qa del owner',        'doc_qa_owner',  'hh7', p_med);
  perform pg_temp.sube_doc(u_owner, d8, 'Certificado', 'qa suplanta cadena',  chain,           'hh8', p_otro);
  perform pg_temp.sube_doc(u_med,   d9, 'Certificado', 'qa para anular',      'doc_qa_anular', 'hh9', p_med);
  n_ins := n_ins + 5;
  -- los documentos de prueba deben existir y estar atribuidos a quien los subió (sin esto las pruebas de propiedad no significan nada)
  perform pg_temp.anota('3g0. fixtures íntegros: todos los documentos de prueba existen y uploaded_by = quien los subió',
    (select count(*) from public.cardiolink_patient_documents where patient_id = '__qa_v2a__') = n_ins
    and not exists (select 1 from public.cardiolink_patient_documents d join (values (d1,u_med),(d2,u_med),(d3,u_med),(dx,u_med),(d4,u_med),(d5,u_med),(d6,u_owner),(d7,u_sec),(d8,u_owner),(d9,u_med)) e(id,u) on e.id = d.id
                    where d.uploaded_by is distinct from e.u),
    'insertados=' || n_ins || ' en tabla=' || (select count(*) from public.cardiolink_patient_documents where patient_id = '__qa_v2a__'));
  r := pg_temp.como('authenticated', u_med, format($q$select public.cardiolink_verificacion_reservar_v1('doc_qa_ajeno','certificado',%L)::text$q$, encode(sha256('c-ajeno'::bytea),'hex'))); v3 := substr(r, 5)::uuid;
  r := pg_temp.como('authenticated', u_med, format($q$select public.cardiolink_verificacion_vincular_v1(%L,%L,%L)::text$q$, v3, d4, hp));
  perform pg_temp.anota('3h. el médico NO vincula una versión con el professional_id de OTRO profesional', r like 'ERR:%', r);
  r := pg_temp.como('authenticated', u_med, format($q$select public.cardiolink_verificacion_reservar_v1('doc_qa_nulo','certificado',%L)::text$q$, encode(sha256('c-nulo'::bytea),'hex'))); v3 := substr(r, 5)::uuid;
  r := pg_temp.como('authenticated', u_med, format($q$select public.cardiolink_verificacion_vincular_v1(%L,%L,%L)::text$q$, v3, d5, hp));
  perform pg_temp.anota('3i. el médico NO vincula un documento sin professional_id', r like 'ERR:%', r);
  r := pg_temp.como('authenticated', u_med, format($q$select public.cardiolink_verificacion_reservar_v1('doc_qa_owner','certificado',%L)::text$q$, encode(sha256('c-owner-med'::bytea),'hex'))); v3 := substr(r, 5)::uuid;
  r := pg_temp.como('authenticated', u_med, format($q$select public.cardiolink_verificacion_vincular_v1(%L,%L,%L)::text$q$, v3, d6, hp));
  perform pg_temp.anota('3j. el médico NO vincula un documento que archivó otro usuario (aunque sea de su profesional)', r like 'ERR:%', r);
  r := pg_temp.como('authenticated', u_owner, format($q$select public.cardiolink_verificacion_reservar_v1('doc_qa_owner','certificado',%L)::text$q$, encode(sha256('c-owner'::bytea),'hex'))); vo := substr(r, 5)::uuid;
  r := pg_temp.como('authenticated', u_owner, format($q$select public.cardiolink_verificacion_vincular_v1(%L,%L,%L)::text$q$, vo, d6, hp));
  perform pg_temp.anota('3k. owner/admin conservan su permiso: vinculan lo que ellos archivaron (para el profesional que corresponda)', r like 'OK:%', r);
  if u_sec is not null then
    perform pg_temp.sube_doc(u_sec, d7, 'Certificado', 'qa de secretaria', 'doc_qa_sec', 'hh10', p_med); n_ins := n_ins + 1;
    perform pg_temp.anota('3l0. el documento de Secretaría quedó atribuido a ella (fixture íntegro)', exists (select 1 from public.cardiolink_patient_documents where id = d7 and uploaded_by = u_sec), null);
    r := pg_temp.como('authenticated', u_sec, format($q$select public.cardiolink_verificacion_reservar_v1('doc_qa_sec','certificado',%L)::text$q$, encode(sha256('c-sec'::bytea),'hex'))); vs := substr(r, 5)::uuid;
    r := pg_temp.como('authenticated', u_sec, format($q$select public.cardiolink_verificacion_vincular_v1(%L,%L,%L)::text$q$, vs, d7, hp));
    perform pg_temp.anota('3l. Secretaría emite en nombre del profesional (documento que ella archivó)', r like 'OK:%', r);
    r := pg_temp.como('authenticated', u_med, format($q$select public.cardiolink_verificacion_anular_v1(%L,'emitido a mi nombre por error')::text$q$, vs));
    perform pg_temp.anota('3m. el médico anula un certificado de SU profesional emitido por Secretaría', r like 'OK:%', r);
  else perform pg_temp.anota('3l/3m. Secretaría emite y el médico anula lo emitido a su nombre', true, 'omitida: no hay secretaría'); end if;
  -- suplantación de cadena: un tercero NO puede reemplazar la verificación de un certificado de otro profesional reusando su source_document_id
  r := pg_temp.como('authenticated', u_owner, format($q$select public.cardiolink_verificacion_reservar_v1(%L,'certificado',%L)::text$q$, chain, encode(sha256('c-spoof'::bytea),'hex'))); va := substr(r, 5)::uuid;
  r := pg_temp.como('authenticated', u_owner, format($q$select public.cardiolink_verificacion_vincular_v1(%L,%L,%L)::text$q$, va, d8, hp2));
  perform pg_temp.anota('3n. la cadena de versiones no puede cruzar profesionales (no se suplanta ni se reemplaza el certificado de otro)', r like 'ERR:%cadena%', r);
  j := public.cardiolink_verificacion_consultar_v1(h1, null, null);
  perform pg_temp.anota('3o. tras el intento de suplantación la versión original sigue vigente', j->>'estado' = 'vigente', j::text);

  -- 4) estados derivados
  j := public.cardiolink_verificacion_consultar_v1(h1, 'iphash', 'movil');
  perform pg_temp.anota('4a. versión emitida y única = vigente', j->>'estado' = 'vigente', j::text);
  perform pg_temp.anota('4b. la respuesta pública SOLO trae campos mínimos (sin paciente ni contenido)',
    (select array_agg(k order by k) from jsonb_object_keys(j) k) = array['con_pin','emitido','encontrado','estado','firma','huella','professional_id','tipo'], j::text);
  r := pg_temp.como('authenticated', u_med, format($q$select public.cardiolink_verificacion_reservar_v1(%L,'certificado',%L)::text$q$, chain, h2)); v2 := substr(r, 5)::uuid;
  perform pg_temp.como('authenticated', u_med, format($q$select public.cardiolink_verificacion_vincular_v1(%L,%L,%L)::text$q$, v2, d2, hp2));
  j := public.cardiolink_verificacion_consultar_v1(h1, null, null);
  perform pg_temp.anota('4c. una versión nueva REEMPLAZA a la anterior (sin tocar la fila anterior)', j->>'estado' = 'reemplazado', j::text);
  j := public.cardiolink_verificacion_consultar_v1(h2, null, null);
  perform pg_temp.anota('4d. la versión nueva es vigente', j->>'estado' = 'vigente', j::text);
  j := public.cardiolink_verificacion_consultar_v1(encode(sha256('inexistente'::bytea), 'hex'), 'iphash', null);
  perform pg_temp.anota('4e. código inexistente: respuesta uniforme sin datos', j = '{"encontrado": false}'::jsonb, j::text);

  -- 5) anulación
  r := pg_temp.como('authenticated', u_owner, format($q$select public.cardiolink_verificacion_anular_v1(%L,'x')::text$q$, v2));
  perform pg_temp.anota('5a. el motivo de anulación es obligatorio (mín. 3 caracteres)', r like 'ERR:%', r);
  if u_med2 is not null then
    r := pg_temp.como('authenticated', u_med2, format($q$select public.cardiolink_verificacion_anular_v1(%L,'motivo de prueba')::text$q$, v2));
    perform pg_temp.anota('5b. un médico que NO es el emisor no anula', r like 'ERR:%', r);
  else perform pg_temp.anota('5b. un médico que NO es el emisor no anula', true, 'omitida: sólo hay un médico'); end if;
  r := pg_temp.como('anon', null, format($q$select public.cardiolink_verificacion_anular_v1(%L,'motivo de prueba')::text$q$, v2));
  perform pg_temp.anota('5c. anon no anula', r like 'ERR:%', r);
  r := pg_temp.como('authenticated', u_med, format($q$select public.cardiolink_verificacion_anular_v1(%L,'emitido por error')::text$q$, v2));
  perform pg_temp.anota('5d. el emisor anula con motivo', r like 'OK:%', r);
  j := public.cardiolink_verificacion_consultar_v1(h2, null, null);
  perform pg_temp.anota('5e. anulado (y la anterior sigue reemplazada, no vigente)', j->>'estado' = 'anulado' and (public.cardiolink_verificacion_consultar_v1(h1, null, null))->>'estado' = 'reemplazado', j::text);
  r := pg_temp.como('authenticated', u_med, format($q$select public.cardiolink_verificacion_anular_v1(%L,'es de mi profesional')::text$q$, vo));
  perform pg_temp.anota('5g. el médico anula un certificado de SU profesional emitido por owner/admin', r like 'OK:%', r);
  r := pg_temp.como('authenticated', u_med, format($q$select public.cardiolink_verificacion_reservar_v1('doc_qa_anular','certificado',%L)::text$q$, encode(sha256('c-anular'::bytea),'hex'))); v3 := substr(r, 5)::uuid;
  perform pg_temp.como('authenticated', u_med, format($q$select public.cardiolink_verificacion_vincular_v1(%L,%L,%L)::text$q$, v3, d9, hp));
  r := pg_temp.como('authenticated', u_owner, format($q$select public.cardiolink_verificacion_anular_v1(%L,'anulación administrativa')::text$q$, v3));
  perform pg_temp.anota('5h. owner/admin anulan cualquier certificado', r like 'OK:%', r);
  if u_med2 is not null then
    r := pg_temp.como('authenticated', u_med2, format($q$select public.cardiolink_verificacion_anular_v1(%L,'intento ajeno')::text$q$, v1));
    perform pg_temp.anota('5i. otro médico (otro profesional) NO anula certificados ajenos', r like 'ERR:%', r);
  else perform pg_temp.anota('5i. otro médico NO anula certificados ajenos', true, 'omitida: sólo hay un médico con professional_id'); end if;
  perform pg_temp.anota('5f. los documentos archivados NO se alteraron al anular',
    (select count(*) from public.cardiolink_patient_documents where id in (d1, d2) and source_payload is not null) = 2, null);

  -- 6) inmutabilidad (como superusuario: el trigger protege incluso así)
  begin update public.cardiolink_document_verifications set code_hash = h3 where id = v1; perform pg_temp.anota('6a. code_hash inmutable', false, 'no falló');
  exception when others then perform pg_temp.anota('6a. code_hash inmutable', true, sqlerrm); end;
  begin update public.cardiolink_document_verifications set pdf_sha256 = hp2 where id = v1; perform pg_temp.anota('6b. pdf_sha256 de una versión emitida inmutable', false, 'no falló');
  exception when others then perform pg_temp.anota('6b. pdf_sha256 de una versión emitida inmutable', true, sqlerrm); end;
  begin update public.cardiolink_document_verifications set issued_by = u_owner where id = v1; perform pg_temp.anota('6c. issued_by inmutable', false, 'no falló');
  exception when others then perform pg_temp.anota('6c. issued_by inmutable', true, sqlerrm); end;
  begin update public.cardiolink_document_verifications set annulled_at = null, annulled_by = null, annulment_reason = null where id = v2; perform pg_temp.anota('6d. la anulación es definitiva', false, 'no falló');
  exception when others then perform pg_temp.anota('6d. la anulación es definitiva', true, sqlerrm); end;
  begin delete from public.cardiolink_document_verifications where id = v1; perform pg_temp.anota('6e. el registro no se elimina', false, 'no falló');
  exception when others then perform pg_temp.anota('6e. el registro no se elimina', true, sqlerrm); end;
  begin update public.cardiolink_document_verification_events set outcome = 'x' where id = (select min(id) from public.cardiolink_document_verification_events); perform pg_temp.anota('6f. la bitácora es append-only (update)', false, 'no falló');
  exception when others then perform pg_temp.anota('6f. la bitácora es append-only (update)', true, sqlerrm); end;
  begin delete from public.cardiolink_document_verification_events where id = (select min(id) from public.cardiolink_document_verification_events); perform pg_temp.anota('6g. la bitácora es append-only (delete)', false, 'no falló');
  exception when others then perform pg_temp.anota('6g. la bitácora es append-only (delete)', true, sqlerrm); end;

  -- 7) PIN temporal con bloqueo
  r := pg_temp.como('authenticated', u_med, format($q$select public.cardiolink_verificacion_pin_set_v1(%L,%L,now()+interval '1 day')::text$q$, v1, hpin));
  perform pg_temp.anota('7a. el cliente NO puede fijar PIN (sólo service_role)', r like 'ERR:%', r);
  j := public.cardiolink_verificacion_pin_set_v1(v1, hpin, now() + interval '1 day');
  perform pg_temp.anota('7b. service_role fija el PIN de una versión emitida', (j->>'ok')::boolean, j::text);
  begin perform public.cardiolink_verificacion_pin_set_v1(v1, hpin, now() + interval '30 days'); perform pg_temp.anota('7c. el PIN no puede durar más de 7 días', false, 'no falló');
  exception when others then perform pg_temp.anota('7c. el PIN no puede durar más de 7 días', true, sqlerrm); end;
  j := public.cardiolink_verificacion_pin_set_v1(v2, hpin, now() + interval '1 day');
  perform pg_temp.anota('7d. no se fija PIN a una versión anulada', not (j->>'ok')::boolean, j::text);
  j := public.cardiolink_verificacion_pin_intento_v1(h1, hpin, 'iphash');
  perform pg_temp.anota('7e. PIN correcto devuelve el documento a abrir', j->>'resultado' = 'ok' and (j->>'document_id')::uuid = d1, j::text);
  for i in 1..4 loop j := public.cardiolink_verificacion_pin_intento_v1(h1, encode(sha256(('mal'||i)::bytea), 'hex'), 'iphash'); end loop;
  perform pg_temp.anota('7f. 4 intentos fallidos aún no bloquean', j->>'resultado' = 'pin_invalido', j::text);
  j := public.cardiolink_verificacion_pin_intento_v1(h1, encode(sha256('mal5'::bytea), 'hex'), 'iphash');
  perform pg_temp.anota('7g. el 5.º intento fallido bloquea', j->>'resultado' = 'bloqueado', j::text);
  j := public.cardiolink_verificacion_pin_intento_v1(h1, hpin, 'iphash');
  perform pg_temp.anota('7h. bloqueado: ni el PIN correcto entra', j->>'resultado' = 'bloqueado', j::text);
  update public.cardiolink_document_verifications set pin_locked_until = now() - interval '1 minute' where id = v1;
  j := public.cardiolink_verificacion_pin_intento_v1(h1, hpin, 'iphash');
  perform pg_temp.anota('7i. vencido el bloqueo, el PIN correcto vuelve a funcionar', j->>'resultado' = 'ok', j::text);
  update public.cardiolink_document_verifications set pin_expires_at = now() - interval '1 minute' where id = v1;
  j := public.cardiolink_verificacion_pin_intento_v1(h1, hpin, 'iphash');
  perform pg_temp.anota('7j. PIN vencido', j->>'resultado' = 'pin_expirado', j::text);
  j := public.cardiolink_verificacion_pin_intento_v1(h2, hpin, 'iphash');
  perform pg_temp.anota('7k. versión anulada: sin acceso al PDF', j->>'resultado' = 'no_disponible', j::text);

  -- 8) privilegios
  perform pg_temp.anota('8a. anon/authenticated sin acceso directo a las tablas',
    pg_temp.como('anon', null, 'select count(*)::text from public.cardiolink_document_verifications') like 'ERR:%'
    and pg_temp.como('authenticated', u_med, 'select count(*)::text from public.cardiolink_document_verifications') like 'ERR:%'
    and pg_temp.como('authenticated', u_med, 'select count(*)::text from public.cardiolink_document_verification_events') like 'ERR:%', null);
  perform pg_temp.anota('8b. el cliente no puede llamar consultar ni pin_intento',
    pg_temp.como('authenticated', u_med, format($q$select public.cardiolink_verificacion_consultar_v1(%L)::text$q$, h1)) like 'ERR:%'
    and pg_temp.como('anon', null, format($q$select public.cardiolink_verificacion_pin_intento_v1(%L,%L)::text$q$, h1, hpin)) like 'ERR:%', null);
  perform pg_temp.anota('8d. sin escalada: todas las funciones SECURITY DEFINER fijan search_path y el helper no es ejecutable por el cliente',
    (select count(*) from pg_proc where proname in ('cardiolink_verificacion_reservar_v1','cardiolink_verificacion_vincular_v1','cardiolink_verificacion_anular_v1','cardiolink_verificacion_consultar_v1',
       'cardiolink_verificacion_pin_set_v1','cardiolink_verificacion_pin_intento_v1','cardiolink_es_profesional_propio_v1') and prosecdef and proconfig is not null and array_to_string(proconfig, ',') like '%search_path=pg_catalog, public%') = 7
    and not has_function_privilege('authenticated', 'public.cardiolink_es_profesional_propio_v1(text)', 'execute') and not has_function_privilege('anon', 'public.cardiolink_es_profesional_propio_v1(text)', 'execute'), null);
  perform pg_temp.anota('8e. el cliente no puede escribir directo ni siquiera el estado de otro (UPDATE/INSERT denegados)',
    pg_temp.como('authenticated', u_med, format($q$update public.cardiolink_document_verifications set annulled_at = now() where id = %L$q$, v1)) like 'ERR:%'
    and pg_temp.como('authenticated', u_owner, 'insert into public.cardiolink_document_verification_events (event_type) values (''consulta'')') like 'ERR:%', null);
  if u_sec is not null then
    r := pg_temp.como('authenticated', u_sec, format($q$select public.cardiolink_verificacion_anular_v1(%L,'motivo de prueba')::text$q$, v1));
    perform pg_temp.anota('8c. Secretaría no anula', r like 'ERR:%', r);
  else perform pg_temp.anota('8c. Secretaría no anula', true, 'omitida: no hay secretaría'); end if;

  -- 9) documento eliminado: la verificación queda no_disponible y el registro permanece
  delete from public.cardiolink_patient_documents where id = d1;
  j := public.cardiolink_verificacion_consultar_v1(h1, null, null);
  perform pg_temp.anota('9a. si se elimina el documento, la verificación pasa a no_disponible', j->>'estado' = 'no_disponible', j::text);
  perform pg_temp.anota('9b. el registro de verificación se conserva (document_id NULL, huella intacta)',
    exists (select 1 from public.cardiolink_document_verifications where id = v1 and document_id is null and pdf_sha256 = hp), null);

  -- 10) bitácora y documentos históricos
  perform pg_temp.anota('10a. la bitácora registró reserva, emisión, consultas, anulación y PIN',
    (select count(distinct event_type) from public.cardiolink_document_verification_events) >= 7, (select string_agg(distinct event_type, ',') from public.cardiolink_document_verification_events));
  perform pg_temp.anota('10b. la bitácora no guarda la IP en claro', not exists (select 1 from public.cardiolink_document_verification_events where ip_hash like '%.%.%.%'), null);
  select count(*) into despues from public.cardiolink_patient_documents;
  perform pg_temp.anota('10c. los documentos históricos no cambian (sólo las filas de prueba, 1 ya eliminada)', despues = antes + n_ins - 1, 'antes=' || antes || ' despues=' || despues || ' insertadas=' || n_ins);
  perform pg_temp.anota('10d. ningún documento histórico tiene verificación',
    not exists (select 1 from public.cardiolink_document_verifications v join public.cardiolink_patient_documents d on d.id = v.document_id where d.patient_id <> '__qa_v2a__'), null);
end $$;

-- Informe: se devuelve como MENSAJE DE ERROR a propósito. Un error aborta y revierte la transacción SIEMPRE (nada puede quedar confirmado, ni siquiera si un
-- cliente ignora el ROLLBACK) y el SQL Editor muestra el texto completo (sólo muestra el resultado de la última sentencia).
do $$
declare v_fallidas text; v_ap int; v_fa int; v_to int;
begin
  select count(*) filter (where ok), count(*) filter (where not ok), count(*) into v_ap, v_fa, v_to from _res;
  select string_agg(n || ' ' || prueba || ' => ' || coalesce(left(detalle, 200), ''), E'\n' order by n) into v_fallidas from _res where not ok;
  raise exception E'RESULTADO V2A (esta transacción se revierte): aprobadas=%, fallidas=%, total=%\n%', v_ap, v_fa, v_to, coalesce(v_fallidas, 'sin fallas');
end $$;
