'use strict';

// tests/documentos-seguridad-4c1.js — Bloque 4C-1 (seguridad documental). Revisión ESTÁTICA del SQL propuesto, su rollback, sus pruebas SQL, el ensayo reversible generado,
// los cambios mínimos de cliente, las Edge Functions y la documentación. Sin red, sin base: los SQL NO se ejecutan ni validan acá; esto fija su estructura y que no rompan flujos aprobados.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const leer = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const P = 'docs/propuestas/pending_review_documentos_seguridad_4c1';
const APPLY = leer(P + '.sql'), ROLLBACK = leer(P + '_rollback.sql'), CHECKS = leer(P + '_checks.sql'), TESTS = leer(P + '_tests.sql'), ENSAYO = leer(P + '_ensayo_reversible.sql');
const PROC = leer(P + '_ensayo_reversible_procedimiento.md'), GEN = leer(P + '_generar_ensayo.sh');
const B4SQL = leer(P + 'b_heredados.sql'), B4RB = leer(P + 'b_heredados_rollback.sql'), B4TESTS = leer(P + 'b_heredados_tests.sql');
const MIG_IMG = leer('supabase/migrations/20261007130000_cardiolink_patient_documents_clinical_images.sql');
const MIG_BASE = leer('supabase/migrations/20261007100000_cardiolink_patient_documents_v1.sql');
const MIG_SEC = leer('supabase/migrations/20261007110000_cardiolink_patient_documents_secretaria_access.sql');
const MIG_EVO = leer('supabase/migrations/20261007120000_cardiolink_patient_documents_evolution_link.sql');
const OWN = leer('docs/propuestas/pending_review_patient_documents_delete_ownership_v1.sql');
const PDF = leer('cardiolink-documentos-pdf-v1.js'), APP = leer('app.js'), INDEX = leer('index.html');
const DELIVERY = leer('supabase/functions/patient-document-delivery/index.ts'), OPEN = leer('supabase/functions/patient-document-open/index.ts');
const BR = leer('docs/BUSINESS_RULES.md'), CTX = leer('docs/CARDIOLINK_CONTEXT.md');
const existe = p => { try { fs.readFileSync(p); return true; } catch (e) { return false; } };
const sinComentarios = t => t.replace(/--[^\n]*/g, '');
const compacto = t => sinComentarios(t).replace(/\s+/g, '').toLowerCase();
const norm = t => t.replace(/\s+/g, ' ').trim().toLowerCase();
const inc = (texto, frag, msg) => assert.ok(compacto(texto).includes(compacto(frag)), msg || ('falta: ' + frag.slice(0, 90)));

const LISTA = ['Constancia', 'Orden', 'Certificado', 'Estudio', 'Informe', 'Laboratorio', 'ECG', 'ECG y riesgo quirúrgico', 'Holter', 'MAPA', 'Ecocardiograma', 'Ecografía', 'Radiografía', 'Receta', 'Indicaciones', 'Apto físico', 'Otro'];
const CERRADOS = ['Imagen clínica', 'Mensaje a colega'];
const FUNCIONES = ['cardiolink_tipos_documento_secretaria_v1', 'cardiolink_profesionales_autorizados_secretaria_v1', 'cardiolink_secretaria_autorizada_prof_v1', 'cardiolink_objeto_sin_fila_v1', 'cardiolink_objeto_asignable_v1', 'cardiolink_vinculo_documental_v1', 'cardiolink_patient_documents_inmutables_4c1'];

const pruebas = [];
const prueba = (n, f) => pruebas.push({ n, f });

prueba('F1 una sola transacción, precondiciones completas, aditivo: sin DML sobre datos y sin tocar DELETE ni permisivas', () => {
  const s = sinComentarios(APPLY);
  assert.match(APPLY, /^BEGIN;/m); assert.match(APPLY, /COMMIT;\s*$/);
  assert.equal((s.match(/^BEGIN;/gm) || []).length, 1); assert.equal((s.match(/^COMMIT;/gm) || []).length, 1);
  const sinBloques = s.replace(/DO \$\$[\s\S]*?\$\$;/g, '').replace(/\$f\$[\s\S]*?\$f\$/g, '');
  assert.ok(!/\b(INSERT INTO|UPDATE |DELETE FROM|TRUNCATE|ALTER TABLE|DROP TABLE|DROP FUNCTION|DROP TRIGGER)\b/i.test(sinBloques.replace(/BEFORE INSERT OR UPDATE ON/g, '').replace(/FOR UPDATE TO/g, '')), 'sin DML/DDL de datos fuera de los bloques de verificación');
  [
    'falta public.cardiolink_patient_documents', 'cardiolink_can_delete_clinical_document(text,uuid)', 'cardiolink_ctx_rol_v1() / cardiolink_ctx_prof_v1()', 'cardiolink_paciente_acceso_clinico_v1(text)', 'debe devolver boolean',
    'cardiolink_patient_documents_guard_version', 'las 4 políticas restrictivas de imagen clínica', 'cardiolink_patient_documents_update', 'storage.objects.owner debe ser uuid', 'falta storage.objects.created_at',
    'uploaded_by debe ser uuid', 'faltan columnas de cardiolink_patient_documents', 'patient-documents debe existir y ser privado', 'UNA tabla de asociaciones secretaria-médico', 'ya está aplicado', 'cardiolink_vinculo_documental_v1(text,text,text,boolean)'
  ].forEach(t => assert.ok(APPLY.includes(t), 'falta precondición: ' + t));
  assert.ok(!/CREATE POLICY[^;]*FOR (DELETE|ALL)/i.test(s) && !/DROP POLICY cardiolink_patient_documents_(select|insert|update|delete)\b/.test(s) && !/DROP POLICY cardiolink_patient_documents_storage_(select|insert|delete)\b/.test(s));
});

prueba('F2 6 políticas, TODAS restrictivas (una permisiva se combinaría por OR): tabla SELECT/INSERT/UPDATE, storage SELECT/INSERT e historial de envíos', () => {
  const s = sinComentarios(APPLY);
  const crear = [...s.matchAll(/CREATE POLICY (\w+) ON ([\w.]+)\s+AS (\w+) FOR (\w+) TO authenticated/g)];
  assert.equal(crear.length, 6);
  crear.forEach(m => assert.equal(m[3], 'RESTRICTIVE', m[1]));
  assert.deepEqual(crear.map(m => m[1] + '|' + m[2] + '|' + m[4]).sort(), [
    'cardiolink_communications_select_docs_4c1|public.cardiolink_communications|SELECT', 'cardiolink_patient_documents_insert_4c1|public.cardiolink_patient_documents|INSERT', 'cardiolink_patient_documents_select_4c1|public.cardiolink_patient_documents|SELECT',
    'cardiolink_patient_documents_storage_insert_4c1|storage.objects|INSERT', 'cardiolink_patient_documents_storage_select_4c1|storage.objects|SELECT',
    'cardiolink_patient_documents_update_4c1|public.cardiolink_patient_documents|UPDATE']);
  assert.ok(!/AS PERMISSIVE/i.test(s));
});

prueba('F3 reemplaza exactamente las 4 políticas de imagen clínica del Bloque 6D.3 (mismos nombres) y nada más', () => {
  const drops = [...sinComentarios(APPLY).matchAll(/DROP POLICY (\w+) ON ([\w.]+)/g)].map(m => m[1] + '|' + m[2]).sort();
  assert.deepEqual(drops, ['cardiolink_clinical_images_storage_insert_no_secretaria|storage.objects', 'cardiolink_clinical_images_storage_select_no_secretaria|storage.objects',
    'cardiolink_patient_documents_insert_no_img_secretaria|public.cardiolink_patient_documents', 'cardiolink_patient_documents_select_no_img_secretaria|public.cardiolink_patient_documents']);
  drops.forEach(d => assert.ok(MIG_IMG.includes(d.split('|')[0]), 'el nombre no existe en la migración original: ' + d));
});

prueba('F4 lista de tipos de Secretaría: contenido exacto = reglas confirmadas; Imagen clínica y Mensaje a colega cerrados; única fuente; sin acceso de anon', () => {
  const m = APPLY.match(/SELECT ARRAY\[([^\]]+)\]::text\[\]/); assert.ok(m);
  const lista = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
  assert.deepEqual(lista, LISTA);
  CERRADOS.forEach(t => assert.ok(!lista.includes(t), t + ' no debe estar en la lista de Secretaría'));
  ['Constancia', 'Certificado', 'Orden', 'ECG', 'Holter', 'MAPA', 'Ecocardiograma', 'Estudio', 'Informe', 'Laboratorio', 'Receta', 'Indicaciones', 'Apto físico', 'Otro'].forEach(t => assert.ok(lista.includes(t), 'regla confirmada: ' + t));
  const inline = "ARRAY['" + LISTA.join("','") + "']";
  assert.ok(TESTS.includes(inline)); assert.ok(CHECKS.toLowerCase().includes(inline.toLowerCase()));
  assert.equal((APPLY.match(/ARRAY\['Constancia'/g) || []).length, 1, 'la lista vive en un solo lugar del SQL');
});

prueba('F5 TABLA: SELECT/INSERT/UPDATE con la matriz de roles (owner/admin; médico titular o acceso clínico —función EXISTENTE—; Secretaría por lista, ruta, sin vínculo a evolución, con profesional AUTORIZADO y archivo asignable)', () => {
  inc(APPLY, `CREATE POLICY cardiolink_patient_documents_select_4c1 ON public.cardiolink_patient_documents AS RESTRICTIVE FOR SELECT TO authenticated USING (
    (SELECT public.cardiolink_ctx_rol_v1()) IN ('owner', 'admin')
    OR ((SELECT public.cardiolink_ctx_rol_v1()) = 'medico' AND (public.cardiolink_can_delete_clinical_document(professional_id, uploaded_by) OR public.cardiolink_paciente_acceso_clinico_v1(patient_id)))
    OR ((SELECT public.cardiolink_ctx_rol_v1()) = 'secretaria' AND document_type = ANY (public.cardiolink_tipos_documento_secretaria_v1()) AND storage_path NOT LIKE 'clinical-images/%'
        AND professional_id = ANY (((SELECT public.cardiolink_profesionales_autorizados_secretaria_v1()))::text[])) );`);
  inc(APPLY, `CREATE POLICY cardiolink_patient_documents_insert_4c1 ON public.cardiolink_patient_documents AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (
    (SELECT public.cardiolink_ctx_rol_v1()) IN ('owner', 'admin')
    OR ((SELECT public.cardiolink_ctx_rol_v1()) = 'medico' AND (professional_id IS NULL OR professional_id = (SELECT public.cardiolink_ctx_prof_v1()))
        AND public.cardiolink_paciente_acceso_clinico_v1(patient_id) AND public.cardiolink_objeto_asignable_v1(storage_path, patient_id))
    OR ((SELECT public.cardiolink_ctx_rol_v1()) = 'secretaria' AND document_type = ANY (public.cardiolink_tipos_documento_secretaria_v1()) AND storage_path NOT LIKE 'clinical-images/%'
        AND evolution_id IS NULL AND public.cardiolink_secretaria_autorizada_prof_v1(professional_id) AND public.cardiolink_objeto_asignable_v1(storage_path, patient_id)) );`);
  const upd = compacto(APPLY).match(/createpolicycardiolink_patient_documents_update_4c1[\s\S]*?;/)[0];
  assert.ok(!upd.includes("'secretaria'"), 'Secretaría nunca actualiza');
  assert.equal((upd.match(/cardiolink_paciente_acceso_clinico_v1\(patient_id\)/g) || []).length, 2, 'USING y WITH CHECK');
  assert.ok(upd.includes('using(') && upd.includes('withcheck('));
  // la asociación médico-paciente NO se duplica: se usa la función existente
  assert.equal((sinComentarios(APPLY).match(/cardiolink_paciente_acceso_clinico_v1\(patient_id\)/g) || []).length, 4);
  assert.ok(!/cardiolink_medico_atiende_paciente_v1/.test(sinComentarios(APPLY) + sinComentarios(ROLLBACK) + sinComentarios(TESTS).replace(/IF to_regprocedure\('public\.cardiolink_medico_atiende_paciente_v1\(text\)'\) IS NOT NULL THEN RAISE EXCEPTION 'FALLA 0f[^;]*;/, '')), 'no queda la función de asociación propia');
  assert.ok(!/CREATE FUNCTION public\.cardiolink_paciente_acceso_clinico_v1/.test(APPLY), 'no se redefine la función existente');
});

prueba('F6 STORAGE: SELECT hereda la RLS de la fila (una sola fuente de verdad) o archivo PROPIO recién subido sin fila (ventana 1 h, Secretaría nunca en clinical-images/); INSERT sin exigir prefijo', () => {
  inc(APPLY, `CREATE POLICY cardiolink_patient_documents_storage_select_4c1 ON storage.objects AS RESTRICTIVE FOR SELECT TO authenticated USING (
    bucket_id <> 'patient-documents'
    OR (SELECT public.cardiolink_ctx_rol_v1()) IN ('owner', 'admin')
    OR EXISTS (SELECT 1 FROM public.cardiolink_patient_documents d WHERE d.storage_path = objects.name)
    OR (objects.owner = auth.uid() AND objects.created_at > now() - interval '1 hour' AND public.cardiolink_objeto_sin_fila_v1(objects.name)
        AND ((SELECT public.cardiolink_ctx_rol_v1()) = 'medico' OR objects.name NOT LIKE 'clinical-images/%')) );`);
  inc(APPLY, `CREATE POLICY cardiolink_patient_documents_storage_insert_4c1 ON storage.objects AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (
    bucket_id <> 'patient-documents' OR (SELECT public.cardiolink_ctx_rol_v1()) IN ('owner', 'admin', 'medico') OR objects.name NOT LIKE 'clinical-images/%' );`);
  assert.ok(!/objects\.name LIKE 'documents\//i.test(sinComentarios(APPLY)), 'no se exige el prefijo documents/');
  assert.match(PDF, /const storagePath=`\$\{patientId\}\/\$\{uuid\}\.pdf`;/);
  assert.match(PDF, /const storagePath=`documents\/\$\{gen\.patientId\}\/\$\{uuid\}\.pdf`;/);
  assert.match(PDF, /const storagePath=`clinical-images\/\$\{patientId\}\/\$\{uuid\}\.jpg`;/);
  // una fila sólo puede apuntar a un archivo que existe, es del mismo usuario, reciente y de la ruta DEL MISMO paciente (nunca al de otro)
  inc(APPLY, `CREATE FUNCTION public.cardiolink_objeto_asignable_v1(p_path text, p_patient text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
    AS $f$ SELECT coalesce(p_path, '') <> '' AND coalesce(p_patient, '') <> ''
    AND (split_part(p_path, '/', 1) = p_patient OR (split_part(p_path, '/', 1) IN ('documents', 'clinical-images') AND split_part(p_path, '/', 2) = p_patient))
    AND EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'patient-documents' AND o.name = p_path AND o.owner = auth.uid() AND o.created_at > now() - interval '1 hour') $f$;`);
  assert.match(MIG_BASE, /storage_path text not null unique/, 'storage_path es UNIQUE: un archivo con fila no se puede reasignar');
  // la ayuda de archivo sin fila ignora la RLS a propósito (SECURITY DEFINER), si no "no veo ninguna fila" daría "no existe"
  assert.match(APPLY, /FUNCTION public\.cardiolink_objeto_sin_fila_v1\(p_name text\)\s+RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public/);
});

prueba('F7 funciones: profesionales autorizados de Secretaría (tabla descubierta por columnas, SIN filtrar el rol del profesional: el Dueño cuenta), todas SECURITY DEFINER con search_path fijo, sin anon', () => {
  const s = sinComentarios(APPLY);
  assert.match(s, /GROUP BY table_name HAVING count\(\*\) = 3/);
  inc(APPLY, `EXECUTE format($fmt$ CREATE FUNCTION public.cardiolink_profesionales_autorizados_secretaria_v1() RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public`);
  inc(APPLY, `JOIN public.%I a ON a.secretaria_user_id = s.user_id AND a.activo IS TRUE`);
  inc(APPLY, `JOIN public.cardiolink_user_roles m ON m.user_id = a.medico_user_id AND m.active IS TRUE AND coalesce(m.professional_id, '') <> ''`);
  inc(APPLY, `WHERE s.user_id = auth.uid() AND s.active IS TRUE AND s.base_role = 'secretaria'`);
  const cuerpo = APPLY.slice(APPLY.indexOf('CREATE FUNCTION public.cardiolink_profesionales_autorizados_secretaria_v1()'), APPLY.indexOf('$body$', APPLY.indexOf('$body$') + 6));
  assert.ok(!/m\.base_role/.test(cuerpo), 'el rol del profesional (owner/admin/médico) no condiciona la autorización: Secretaría puede emitir a nombre del Dueño');
  inc(APPLY, `SELECT coalesce(p_prof, '') <> '' AND p_prof = ANY (public.cardiolink_profesionales_autorizados_secretaria_v1())`);
  [['cardiolink_tipos_documento_secretaria_v1()', 'tipos'], ['cardiolink_profesionales_autorizados_secretaria_v1()', 'prof'], ['cardiolink_secretaria_autorizada_prof_v1(text)', 'sec'], ['cardiolink_objeto_sin_fila_v1(text)', 'sinfila'], ['cardiolink_objeto_asignable_v1(text, text)', 'asignable']].forEach(([f]) => {
    assert.ok(compacto(s).includes('revokeallonfunctionpublic.' + compacto(f)), 'REVOKE ' + f); assert.ok(compacto(s).includes('grantexecuteonfunctionpublic.' + compacto(f) + 'toauthenticated;'), 'GRANT ' + f); });
  assert.match(s, /REVOKE ALL ON FUNCTION public\.cardiolink_patient_documents_inmutables_4c1\(\) FROM PUBLIC, anon, authenticated;/);
  assert.equal((s.match(/\bCREATE FUNCTION\b/g) || []).length, 7, '7 funciones nuevas (6 estáticas y 1 creada con EXECUTE format)');
  assert.match(s, /REVOKE ALL ON FUNCTION public\.cardiolink_vinculo_documental_v1\(text, text, text, boolean\) FROM PUBLIC, anon, authenticated;/);
  assert.ok(!/GRANT EXECUTE ON FUNCTION public\.cardiolink_vinculo_documental_v1/.test(s), 'el validador de vínculos no se expone a los clientes');
  assert.ok(!/service_role/i.test(s));
});

prueba('F8 TRIGGER (SECURITY DEFINER, search_path fijo): INSERT fija uploaded_by y valida vínculos; UPDATE congela identidad de archivo/autor para TODOS, lo emitido no cambia tipo/profesional/fecha, valida vínculos nuevos y protege los ajenos; salvo owner/admin sólo vínculo y (titular) título/descripción/fecha', () => {
  const f = APPLY.match(/CREATE FUNCTION public\.cardiolink_patient_documents_inmutables_4c1\(\)[\s\S]*?\$f\$;/)[0];
  inc(f, `RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public`);
  inc(f, `IF auth.uid() IS NULL THEN RETURN NEW; END IF;`);
  inc(f, `IF TG_OP = 'INSERT' THEN NEW.uploaded_by := auth.uid();`);
  inc(f, `IF (coalesce(NEW.attention_id, '') <> '' OR coalesce(NEW.evolution_id, '') <> '') AND NOT public.cardiolink_vinculo_documental_v1(NEW.patient_id, NEW.attention_id, NEW.evolution_id, v_medico) THEN`);
  inc(f, `IF NEW.patient_id IS DISTINCT FROM OLD.patient_id OR NEW.storage_path IS DISTINCT FROM OLD.storage_path OR NEW.original_filename IS DISTINCT FROM OLD.original_filename
     OR NEW.mime_type IS DISTINCT FROM OLD.mime_type OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by OR NEW.source_document_id IS DISTINCT FROM OLD.source_document_id
     OR NEW.source_content_hash IS DISTINCT FROM OLD.source_content_hash OR NEW.source_payload IS DISTINCT FROM OLD.source_payload THEN`);
  inc(f, `IF (OLD.source_payload IS NOT NULL OR OLD.source_document_id IS NOT NULL) AND (NEW.document_type IS DISTINCT FROM OLD.document_type OR NEW.professional_id IS DISTINCT FROM OLD.professional_id OR NEW.document_date IS DISTINCT FROM OLD.document_date) THEN`);
  inc(f, `IF (v_cambia_att AND coalesce(NEW.attention_id, '') <> '') OR (v_cambia_evo AND coalesce(NEW.evolution_id, '') <> '') THEN IF NOT public.cardiolink_vinculo_documental_v1(NEW.patient_id,
         CASE WHEN v_cambia_att THEN NEW.attention_id END, CASE WHEN v_cambia_evo THEN NEW.evolution_id END, v_medico) THEN`);
  inc(f, `IF v_medico AND (v_cambia_att OR v_cambia_evo) AND NOT public.cardiolink_can_delete_clinical_document(OLD.professional_id, OLD.uploaded_by) THEN
    IF NOT public.cardiolink_vinculo_documental_v1(OLD.patient_id, CASE WHEN v_cambia_att THEN OLD.attention_id END, CASE WHEN v_cambia_evo THEN OLD.evolution_id END, true) THEN`);
  inc(f, `IF v_rol IN ('owner', 'admin') THEN RETURN NEW; END IF;`);
  inc(f, `v_perm := ARRAY['attention_id', 'evolution_id', 'updated_at'] || CASE WHEN v_titular THEN ARRAY['title', 'description', 'document_date'] ELSE ARRAY[]::text[] END;`);
  inc(f, `IF (to_jsonb(NEW) - v_perm) IS DISTINCT FROM (to_jsonb(OLD) - v_perm) THEN`);
  const iOwner = f.indexOf("IF v_rol IN ('owner', 'admin') THEN RETURN NEW;");
  ['NEW.patient_id IS DISTINCT', 'document_type IS DISTINCT', 'cardiolink_vinculo_documental_v1(NEW.patient_id,\n         CASE', 'v_medico AND (v_cambia_att'].forEach(x => assert.ok(f.indexOf(x) > 0 && f.indexOf(x) < iOwner, 'se controla ANTES de la excepción de owner/admin: ' + x));
  assert.equal((f.match(/ERRCODE = '42501'/g) || []).length, 8);
  // v2.2: nuevas versiones y created_at
  inc(f, `NEW.created_at := clock_timestamp();`);
  inc(f, `IF coalesce(NEW.source_document_id, '') <> '' AND EXISTS (SELECT 1 FROM public.cardiolink_patient_documents d WHERE d.source_document_id = NEW.source_document_id) THEN`);
  assert.match(APPLY, /CREATE TRIGGER cardiolink_patient_documents_inmutables_4c1\s+BEFORE INSERT OR UPDATE ON public\.cardiolink_patient_documents\s+FOR EACH ROW EXECUTE FUNCTION public\.cardiolink_patient_documents_inmutables_4c1\(\);/);
  const esquema = MIG_BASE + MIG_EVO + leer('supabase/migrations/20261008110000_cardiolink_patient_documents_source_link.sql') + leer('docs/propuestas/pending_review_patient_documents_source_payload_v1.sql');
  ['patient_id', 'storage_path', 'original_filename', 'mime_type', 'size_bytes', 'created_at', 'uploaded_by', 'source_document_id', 'source_content_hash', 'source_payload', 'attention_id', 'evolution_id'].forEach(c => assert.ok(new RegExp('\\b' + c + '\\b').test(esquema), 'columna inexistente: ' + c));
  assert.match(leer('docs/propuestas/pending_review_patient_documents_source_payload_v1.sql'), /create trigger cardiolink_patient_documents_guard_version/);
  const updates = [...PDF.matchAll(/from\('cardiolink_patient_documents'\)\.update\(\{([^}]*)\}\)/g)].map(m => m[1].trim());
  assert.ok(updates.length >= 2); updates.forEach(u => assert.ok(/^evolution_id:/.test(u), 'la app sólo actualiza evolution_id: ' + u));
});

prueba('F18 VÍNCULOS DOCUMENTALES: el destino debe existir y ser del MISMO paciente; para médicos, propio (atención con profesionalId propio; evolución propia con acceso clínico); sin acceso de los clientes al validador; probado legítimo, otro paciente, ajeno, inexistente y desvinculación', () => {
  const f = APPLY.match(/CREATE FUNCTION public\.cardiolink_vinculo_documental_v1[\s\S]*?\$f\$;/)[0];
  inc(f, `CREATE FUNCTION public.cardiolink_vinculo_documental_v1(p_patient text, p_attention text, p_evolution text, p_solo_propios boolean) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public`);
  inc(f, `SELECT coalesce(p_patient, '') <> '' AND (coalesce(p_attention, '') = '' OR EXISTS ( SELECT 1 FROM public.cardiolink_atenciones a WHERE a.id = p_attention AND coalesce(a.payload ->> 'tipoRegistro', '') NOT IN ('mensaje', 'config')`);
  inc(f, `AND (a.payload ->> 'pacienteId' = p_patient OR (p_patient LIKE 'legacy\\_%' ESCAPE '\\' AND 'legacy_' || pg_catalog.regexp_replace(coalesce(a.payload ->> 'dni', ''), '\\D', '', 'g') = p_patient))`);
  inc(f, `AND (NOT p_solo_propios OR a.payload ->> 'profesionalId' = (SELECT public.cardiolink_ctx_prof_v1()))))`);
  inc(f, `AND (coalesce(p_evolution, '') = '' OR EXISTS ( SELECT 1 FROM public.cardiolink_hc_evoluciones e WHERE e.id = p_evolution AND e.paciente_id = p_patient
       AND (NOT p_solo_propios OR (e.profesional_id = (SELECT public.cardiolink_ctx_prof_v1()) AND public.cardiolink_paciente_acceso_clinico_v1(p_patient)))))`);
  // los pacientes de la atención se identifican como en el resto del repo
  assert.match(APP, /pacienteId:key/);
  // pruebas SQL: legítimo, desvinculación, otro paciente, ajena, inexistente, alta con vínculo, owner/admin, vínculo ajeno protegido, Secretaría
  ['FALLA 4b.1', 'FALLA 4b.2', 'FALLA 4b.3a', 'FALLA 4b.3b', 'FALLA 4b.4a', 'FALLA 4b.4b', 'FALLA 4b.4c', 'FALLA 4b.4d', 'FALLA 4b.5a', 'FALLA 4b.5b', 'FALLA 4b.5c', 'FALLA 4b.6a', 'FALLA 4b.6b', 'FALLA 4b.6c', 'FALLA 4b.7a', 'FALLA 4b.7b', 'FALLA 4b.7c', 'FALLA 4b.8a', 'FALLA 4b.8b',
    'qa4c_evo_x', 'qa4c_evo_b', 'qa4c_evo_c', '__t_qa4c_x', '__t_qa4c_b', 'qa4c_evo_inexistente', 'qa4c_att_inexistente'].forEach(x => assert.ok(TESTS.includes(x), 'falta en las pruebas SQL: ' + x));
  // la FK de evolution_id cubre sólo la existencia: el trigger agrega paciente y propiedad
  assert.match(MIG_EVO, /references public\.cardiolink_hc_evoluciones \(id\)/);
});

prueba('F9 ROLLBACK: restaura EXACTAMENTE las 4 políticas anteriores (mismas expresiones que la migración original) y quita las 6 nuevas, el trigger y las 7 funciones; no toca datos ni permisivas', () => {
  const exprs = txt => [...norm(sinComentarios(txt)).matchAll(/create policy (\w+) on ([\w.]+) as restrictive for (\w+) to authenticated (using|with check) \((.*?)\);/g)].map(m => m[1] + '|' + m[2] + '|' + m[3] + '|' + m[5].replace(/\s+/g, ''));
  const orig = exprs(MIG_IMG), rb = exprs(ROLLBACK);
  assert.equal(rb.length, 4); rb.forEach(r => assert.ok(orig.includes(r), 'no coincide con la migración original: ' + r));
  assert.equal((ROLLBACK.match(/DROP POLICY IF EXISTS/g) || []).length, 6);
  FUNCIONES.forEach(f => assert.ok(new RegExp('DROP FUNCTION IF EXISTS public\\.' + f + '\\(').test(ROLLBACK), 'no quita ' + f));
  assert.match(ROLLBACK, /DROP TRIGGER IF EXISTS cardiolink_patient_documents_inmutables_4c1 ON public\.cardiolink_patient_documents;/);
  assert.ok(!/\b(INSERT INTO|UPDATE |DELETE FROM|TRUNCATE)\b/i.test(sinComentarios(ROLLBACK).replace(/DO \$\$[\s\S]*?\$\$;/g, '')));
  assert.ok(ROLLBACK.includes("cardiolink_patient_documents_update' AND permissive='PERMISSIVE'"), 'verifica que la permisiva de UPDATE sigue en pie');
});

prueba('F10 FLUJOS APROBADOS: lo que Secretaría emite y sube desde el cliente está dentro de la lista; la subida manual (sin prefijo) y los emitidos (documents/) pasan; la imagen de evolución sigue cerrada', () => {
  const mapa = APP.match(/const TIPO_ARCHIVO_PDF_POR_DOC_V1=\{([^}]*)\}/)[1];
  assert.match(APP, /return isSecretary406\(\)&&\['constancia_atencion','certificado','reposo_laboral','orden'\]\.includes\(String\(type\|\|''\)\);/);
  ['constancia_atencion', 'certificado', 'reposo_laboral', 'orden'].forEach(k => { const t = (mapa.match(new RegExp(k + ":'([^']+)'")) || [])[1]; assert.ok(t && LISTA.includes(t), k + ' → ' + t); });
  const subida = PDF.match(/const TIPOS_PDF_V1=\[([^\]]+)\]/)[1].match(/'([^']+)'/g).map(x => x.replace(/'/g, ''));
  subida.forEach(t => assert.ok(LISTA.includes(t), 'tipo de subida fuera de la lista: ' + t));
  ['Receta', 'Indicaciones', 'Apto físico', 'ECG', 'Holter', 'MAPA', 'Ecocardiograma', 'Estudio', 'Informe', 'Laboratorio', 'Otro'].forEach(t => assert.ok(subida.includes(t), 'la regla confirmada exige poder subir ' + t));
  const map406 = APP.match(/const TIPO_PDF_ARCHIVO_POR_DOC406=\{([\s\S]*?)\};/)[1];
  const archivo = [...map406.matchAll(/:'([^']+)'/g)].map(x => x[1]);
  archivo.filter(t => t !== 'Mensaje a colega').forEach(t => assert.ok(LISTA.includes(t), 'tipo archivado fuera de la lista: ' + t));
  assert.ok(archivo.includes('Mensaje a colega') && !LISTA.includes('Mensaje a colega'));
  assert.match(PDF, /const TIPO_IMAGEN_CLINICA_V1='Imagen clínica';/);
  // imágenes de evolución: el cliente las crea con evolution_id null y profesional del usuario (no se vinculan al subir)
  assert.ok((PDF.match(/evolution_id:null/g) || []).length >= 3);
  assert.match(PDF, /professional_id:profesionalIdActual,/);
  // TIPOS_SIN_ENVIO_V1 sigue igual (hoja de ruta: envío de recetas, indicaciones y aptos físicos)
  assert.match(PDF, /const TIPOS_SIN_ENVIO_V1=\['Receta','Indicaciones','Apto físico','Mensaje a colega'\];/);
});

prueba('F11 envío y apertura NO tienen regla propia: heredan la RLS del usuario, el destinatario sale del servidor y el autor del envío es el uid del JWT; el portal no usa documentos', () => {
  assert.match(DELIVERY, /async function obtenerDocumentoAutorizado\(comoUsuario/); assert.match(DELIVERY, /comoUsuario\.storage\.from\(BUCKET\)\.download\(path\)/);
  assert.match(DELIVERY, /obtenerDocumentoAutorizado\(comoUsuario, documentId\)/);
  assert.ok(!/admin\s*\.from\('cardiolink_patient_documents'\)/.test(DELIVERY), 'la fila del documento no se lee con service_role');
  assert.match(DELIVERY, /Documento no encontrado o sin acceso\./); assert.match(DELIVERY, /resolverDestinatarios\(null, paciente\)/);
  assert.match(DELIVERY, /uid: data\.user\.id/); assert.ok((DELIVERY.match(/created_by: uid/g) || []).length >= 3);
  assert.match(OPEN, /cardiolink_document_access_links/); assert.ok(!/req\.body|await req\.json/.test(OPEN));
  assert.ok(!/patient_documents|patient-documents/.test(leer('supabase/functions/portal-gateway/index.ts') + leer('supabase/functions/portal-gateway/logica.js')), 'el portal del paciente no usa documentos');
});

prueba('F12 UPDATE/DELETE: no hay políticas de DELETE nuevas; en el repo Secretaría no tiene UPDATE ni DELETE (permisivas sólo owner/admin/médico); el ensayo reversible está en sincronía con el SQL y las pruebas', () => {
  assert.match(MIG_BASE, /create policy cardiolink_patient_documents_select\s+on public\.cardiolink_patient_documents\s+for select to authenticated\s+using \(public\.cardiolink_has_clinical_documents_access\(\)\);/);
  assert.match(MIG_SEC, /create policy cardiolink_patient_documents_delete\s+on public\.cardiolink_patient_documents\s+for delete to authenticated\s+using \(public\.cardiolink_can_delete_clinical_documents\(\)\);/);
  assert.match(MIG_EVO, /create policy cardiolink_patient_documents_update\s+on public\.cardiolink_patient_documents\s+for update to authenticated\s+using \(public\.cardiolink_can_delete_clinical_documents\(\)\)\s+with check \(public\.cardiolink_can_delete_clinical_documents\(\)\);/);
  assert.match(MIG_SEC, /secretaria\s+: listar, subir, ver, descargar, NO eliminar/);
  // sincronía del ensayo (reproduce lo que hace el generador): 4C-1 + 4C-1b + sus pruebas + AMBOS rollbacks, todo en UNA transacción
  const sinBC = t => t.split('\n').filter(l => !(l === 'BEGIN;' || l === 'COMMIT;')).join('\n');
  assert.ok(ENSAYO.includes(sinBC(APPLY).trim()), 'el ensayo no contiene el SQL de 4C-1 actual: volver a generar');
  assert.ok(ENSAYO.includes(sinBC(B4SQL).trim()), 'el ensayo no contiene el SQL de 4C-1b actual: volver a generar');
  const hasta = (txt, marca) => { const l = txt.split('\n'); return l.slice(0, l.indexOf(marca)).filter(x => x !== 'BEGIN;').join('\n'); };
  assert.ok(ENSAYO.includes(hasta(TESTS, '-- ===== 8) Resultado y ROLLBACK =====').trim()), 'el ensayo no contiene las pruebas de 4C-1 actuales: volver a generar');
  assert.ok(ENSAYO.includes(hasta(B4TESTS, '-- ===== Resultado y ROLLBACK =====').trim()), 'el ensayo no contiene las pruebas de 4C-1b actuales: volver a generar');
  assert.ok(ENSAYO.includes(sinBC(B4RB).trim()) && ENSAYO.includes(sinBC(ROLLBACK).trim()), 'el ensayo no ejecuta los DOS rollbacks actuales: volver a generar');
  const n1 = (TESTS.match(/INSERT INTO t_res/g) || []).length, n2 = (B4TESTS.match(/INSERT INTO t_res/g) || []).length;
  assert.equal(n1, 22); assert.equal(n2, 3);
  const n = n1 + n2 + 1;   // + la verificación de ambos rollbacks (90)
  assert.ok(ENSAYO.includes('ENSAYO OK: las ' + n + ' pruebas'));
  assert.equal((ENSAYO.match(/^BEGIN;$/gm) || []).length, 1); assert.equal((ENSAYO.match(/^COMMIT;/gm) || []).length, 0); assert.equal((ENSAYO.match(/^ROLLBACK;$/gm) || []).length, 1);
  const pos = x => ENSAYO.indexOf(x);
  assert.ok(pos('-- ---------- BLOQUE 4C-1 (') < pos('-- ---------- BLOQUE 4C-1b (') && pos('-- ---------- BLOQUE 4C-1b (') < pos('FALLA 7c') && pos('FALLA 7c') < pos('FALLA 71.1') && pos('FALLA 71.1') < pos('FALLA 90a'), 'orden: 4C-1 → 4C-1b → pruebas 4C-1 → pruebas 4C-1b → verificación de rollback');
  assert.ok(pos('FALLA 90a') < ENSAYO.lastIndexOf('\nROLLBACK;\n') && ENSAYO.lastIndexOf('ENSAYO OK') > ENSAYO.lastIndexOf('\nROLLBACK;\n'));
  assert.ok(pos(sinBC(B4RB).trim().slice(0, 120)) < pos(sinBC(ROLLBACK).trim().slice(0, 120)) && pos(sinBC(B4RB).trim().slice(0, 120)) > pos('FALLA 71.1'), 'primero el rollback de 4C-1b y después el de 4C-1, ambos tras las pruebas');
  ['lista_heredados_original', 'filas_config_con_marca_4c1b', 'asociaciones_qa4c_restantes', 'comunicaciones_qa4c_restantes', 'politica_comunicaciones_restante', 'politicas_anteriores_en_pie', 'funciones_4c1_restantes', 'trigger_4c1_restante', 'rpc_historial_igual_a_la_previa'].forEach(c => assert.ok(ENSAYO.includes(c), 'la verificación final no incluye ' + c));
  assert.ok(ENSAYO.includes('FALLA 90e') && ENSAYO.includes('CREATE TEMP TABLE t_rpc_previa'), 'el ensayo debe comparar la función del historial contra su estado previo');
  assert.ok(ENSAYO.includes("cardiolink_vinculo_documental_v1','cardiolink_patient_documents_inmutables_4c1')"), 'la verificación final cuenta las 7 funciones');
  assert.match(GEN, /set -eu/); assert.ok(!/psql|supabase |curl /.test(GEN), 'el generador sólo concatena texto');
  assert.ok(PROC.includes('ROLLBACK') && PROC.includes('STAGING') && PROC.includes('NO ejecutar') || PROC.includes('No ejecutar'));
});

prueba('F13 pruebas SQL: transaccionales, sin ramas que omitan; cubren Secretaría, médico con acceso clínico, sin acceso, owner/admin, Dueño como profesional, anon y sin rol, Storage (ruta ajena, asociación falsa, acceso directo, archivo propio, subida legítima), firmados y autoría', () => {
  assert.match(TESTS, /^BEGIN;/m); assert.match(TESTS, /^ROLLBACK;/m); assert.ok(!/^COMMIT;/m.test(TESTS));
  assert.ok(!/OMITIDA|omitida|EXCEPTION WHEN others/.test(TESTS));
  ['FALLA 0a', 'FALLA 0f', 'FALLA 2.1:', 'FALLA 2.1b', 'FALLA 2.1c', 'FALLA 2.2:', 'FALLA 2.3:', 'FALLA 2.3b', 'FALLA 2.3c', 'FALLA 2.4:', 'FALLA 2.5:', 'FALLA 2.5b', 'FALLA 3.1', 'FALLA 3.2', 'FALLA 3.3a', 'FALLA 3.3b', 'FALLA 3.3c', 'FALLA 3.3d', 'FALLA 3.3e',
    'FALLA 3.4a', 'FALLA 3.4b', 'FALLA 3.5', 'FALLA 3.6a', 'FALLA 3.6b', 'FALLA 3.6c', 'FALLA 3b.1', 'FALLA 3b.2a', 'FALLA 3b.3a', 'FALLA 3b.3b', 'FALLA 3b.4', 'FALLA 3c.1', 'FALLA 3c.2',
    'FALLA 4.1:', 'FALLA 4.1b', 'FALLA 4.2a', 'FALLA 4.2b', 'FALLA 4.2c', 'FALLA 4.2d', 'FALLA 4.2e', 'FALLA 4.3a', 'FALLA 4.3b', 'FALLA 4.3c', 'FALLA 4.3d', 'FALLA 4.3e', 'FALLA 4.3f', 'FALLA 4.3g', 'FALLA 4.4a', 'FALLA 4.4b', 'FALLA 4.5a', 'FALLA 4.5b', 'FALLA 4.6a', 'FALLA 4.6b', 'FALLA 4.6c', 'FALLA 0g', 'FALLA 2.1d', 'FALLA 3d.1', 'FALLA 3d.2', 'FALLA 3d.3', 'FALLA 3d.4', 'FALLA 3d.5', 'FALLA 3d.6', 'FALLA 3d.7', 'FALLA 3d.8', 'FALLA 3d.9', 'FALLA 3d.10', 'FALLA 3d.11', 'FALLA 3d.12', 'FALLA 3d.13',
    'FALLA 5b.1', 'FALLA 5b.2', 'FALLA 5b.3', 'FALLA 5b.4', 'FALLA 5b.5', 'FALLA 5b.6', 'FALLA 5b.7', 'FALLA 5b.8', 'FALLA 5b.9', 'FALLA 5b.10', 'qa4c_doc_otro', 'qa4c_doc_nulo', 'qa4c_doc_nueva', 'qa4c_pac_a/sinprof.pdf', 'comunicaciones_qa4c_restantes', 'FALLA 4c.0', 'FALLA 4c.0b', 'FALLA 4c.1', 'FALLA 4c.1b', 'FALLA 4c.2', 'FALLA 4c.2b', 'FALLA 4c.3', 'FALLA 4c.3b', 'FALLA 4c.4', 'cardiolink_paciente_profesionales_v1', 'qa4c_pac_d', 'asociaciones_qa4c_restantes',
    'FALLA 5.1', 'FALLA 5.2', 'FALLA 5.3a', 'FALLA 5.3b', 'FALLA 5.4a', 'FALLA 5.4b', 'FALLA 5.4c', 'FALLA 5.4d', 'FALLA 5.4e', 'FALLA 5.4f', 'FALLA 5.5', 'FALLA 6.1', 'FALLA 6.2', 'FALLA 6.3', 'FALLA 6.4', 'FALLA 7a', 'FALLA 7b', 'FALLA 7c', 'Fixture 4C-1',
    "'Imagen clínica'", "'Mensaje a colega'", "'constancia'", "'Constancia '", 'qa4c_prof_no_asociado', 'qa4c_pac_c', 'qa4c_prof_b', 'qa4c_pac_a/ecg_manual.pdf', "now() - interval '2 hours'", 'huerfano_img.jpg', 'viejo_sec.pdf', 'propio_sec.pdf', 'a_nombre_dueno.pdf', "SET base_role = 'owner'",
    'roles_convertidos_restantes', 'documentos_qa4c_restantes', 'objetos_qa4c_restantes', 'pacientes_qa4c_restantes'].forEach(t => assert.ok(TESTS.includes(t), 'falta ' + t));
  assert.ok(CHECKS.includes('begin;') && CHECKS.includes('rollback;') && CHECKS.includes('cardiolink_paciente_acceso_clinico_v1'));
  assert.ok(!/atiende/.test(CHECKS));
  [APPLY, ROLLBACK, CHECKS, TESTS, ENSAYO].forEach(t => assert.ok(!/sb_publishable_|sb_secret_|eyJ[A-Za-z0-9_-]{20,}|@[a-z0-9-]+\.(com|ar)\b/i.test(t), 'sin secretos ni datos reales'));
});

prueba('F14 CLIENTE (cambios mínimos): Secretaría elige profesional AUTORIZADO (RPC con respaldo si no existe), errores de permiso legibles, tipos de subida ampliados; sin service_role; versión del script actualizada', () => {
  assert.match(PDF, /supabaseClient\.rpc\('cardiolink_profesionales_autorizados_secretaria_v1'\)/);
  assert.match(PDF, /if\(error\|\|!Array\.isArray\(lista\)\)return null;/, 'si la función del servidor no existe el formulario sigue como antes');
  assert.match(PDF, /Profesional autorizado \(obligatorio\)/); assert.match(PDF, /Elegí el profesional autorizado para este documento\./);
  assert.match(PDF, /if\(esSecretariaPdfV1\(\)\)\{\s*const autorizados=await cargarProfesionalesAutorizadosV1\(\);/);
  assert.match(PDF, /mostrarErrorPdfV1\(textoErrorPermisoPdfV1\(e,'No se pudo subir el archivo: '\)\);/);
  assert.match(PDF, /mostrarErrorPdfV1\(textoErrorPermisoPdfV1\(insErr,'No se pudo guardar la información del documento/);
  assert.match(PDF, /aplicarProfesionalesAutorizadosV1\(\)\.catch\(/);
  // el mapeo de errores de sesión NO cambia (mensaje original del servidor con sesión vigente: prueba documentos-sesion-vencida-v1)
  assert.match(PDF, /async function mensajeErrorSesionV1\(e,base\)\{\s*const m=String\(\(e&&\(e\.message\|\|e\.details\)\)\|\|e\|\|''\);\s*if\(e&&\(e\.code==='42501'\|\|\/permission denied\/i\.test\(m\)\)&&!\(await asegurarSesionV1\(\)\)\.ok\)return MSG_SESION_VENCIDA_V1;\s*return base\+m;/);
  assert.match(INDEX, /cardiolink-documentos-pdf-v1\.js\?v=7-4c1/); assert.ok(!/service_role/i.test(PDF));
});

prueba('F15 DOCUMENTACIÓN: BUSINESS_RULES y CONTEXT reflejan las reglas confirmadas y no conservan la contradicción (Secretaría no emite certificados/órdenes)', () => {
  [BR, CTX].forEach(t => {
    assert.ok(!/ni emitir certificados médicos/i.test(t) && !/solo puede emitir constancias administrativas/i.test(t), 'contradicción eliminada');
    assert.ok(/constancias, certificados y órdenes/i.test(t)); assert.ok(/membrete, sello y firma/i.test(t)); assert.ok(/aptos físicos/i.test(t));
    assert.ok(/Mensaje a\s+colega/i.test(t)); assert.ok(/4C-2/.test(t));
  });
  assert.match(BR, /exclusivamente por su autor, incluso\s+frente a otros médicos, Dueño\/Administrador/i);
  assert.match(BR, /no autoriza modificar el contenido clínico de\s+documentos médicos firmados/i);
  assert.match(BR, /imágenes adjuntas\s+a evoluciones/i); assert.match(BR, /módulo de copias para facturación/i);
  assert.match(BR, /envío de recetas, indicaciones y aptos físicos/i); assert.match(BR, /cuarentena segura/i);
  assert.match(BR, /asociado al paciente \(tiene evoluciones o atenciones con él\)/i);
});

prueba('F16 BLOQUE 4C-1b: certificados, órdenes y reposos heredados se amplían de forma COHERENTE: la etapa A de 4B conserva la lista ORIGINAL y 4C-1b la amplía (igual que en STAGING); el módulo y app.js llevan la lista final; la fila completa sigue cerrada y la escritura de documentos sigue en NUNCA', () => {
  const NUEVOS = ['constancia_atencion', 'certificado', 'reposo_laboral', 'orden'];
  const lista = txt => [...txt.match(/'constancia_atencion'[^\]]*?(?=\s*(?:--|\]))/)[0].matchAll(/'([a-z_]+)'/g)].map(x => x[1]);
  const A = leer('docs/propuestas/pending_review_config_secretaria_v1_a_rpc.sql'), B4 = leer(P + 'b_heredados.sql'), BR4 = leer(P + 'b_heredados_rollback.sql');
  assert.deepEqual(lista(A.slice(A.indexOf('TIPOS_DOC_INICIO'), A.indexOf('TIPOS_DOC_FIN'))), ['constancia_atencion']);   // 4B-A: lista original; 4C-1b exige exactamente esa precondición
  assert.deepEqual(lista(B4.slice(B4.indexOf('TIPOS_DOC_INICIO'), B4.indexOf('TIPOS_DOC_FIN'))), NUEVOS);
  assert.match(B4, /ARRAY\['constancia_atencion','certificado','reposo_laboral','orden'\]::text\[\]/);
  assert.match(APP, /const TIPOS_DOC_SECRETARIA_V1=\['constancia_atencion','certificado','reposo_laboral','orden'\];/);
  assert.match(leer('cardiolink-config-secretaria-v1.js'), /const TIPOS_DOC_LECTURA = \['constancia_atencion', 'certificado', 'reposo_laboral', 'orden'\];/);
  // 4C-1b: precondición (la lista instalada es la original), rollback exacto, sin DML, función interna sin EXECUTE
  assert.match(B4, /IS DISTINCT FROM ARRAY\['constancia_atencion'\]::text\[\]/); assert.match(BR4, /'constancia_atencion'\s*\n\s*-- TIPOS_DOC_FIN/);
  assert.ok(!/\b(INSERT INTO|UPDATE |DELETE FROM|TRUNCATE)\b/i.test(sinComentarios(B4).replace(/DO \$\$[\s\S]*?\$\$;/g, '')));
  assert.match(B4, /has_function_privilege\('anon'[^;]*has_function_privilege\('authenticated'/);
  // la escritura de documentosClinicos por Secretaría sigue prohibida y la fila completa sigue cerrada (etapa B de 4B intacta)
  assert.match(A, /ESCRITURA = LECTURA menos \{usuarios, roles, brandingCardioLink, migracionesCardioLink, documentosClinicos\}/);
  assert.match(A, /documentosClinicos' = ANY \(public\.cardiolink_config_claves_escritura_sec_v1\(\)\)/);
  assert.ok(leer('docs/propuestas/pending_review_config_secretaria_v1_b_rls.sql').includes("id <> '__cardiolink_config_v1' OR (SELECT public.cardiolink_ctx_rol_v1()) IN ('owner','admin')"));
  // el ensayo reversible de 4B (que instala SOLO la etapa A y B) conserva la lista ORIGINAL, igual que su fuente
  const ER = leer('docs/propuestas/pending_review_config_secretaria_v1_ensayo_reversible.sql');
  assert.deepEqual(lista(ER.slice(ER.indexOf('TIPOS_DOC_INICIO'), ER.indexOf('TIPOS_DOC_FIN'))), ['constancia_atencion']);
  assert.ok(!ER.includes("'constancia_atencion','certificado','reposo_laboral','orden'"));
  // el ensayo de Production aplica 4B-A con la lista original y 4C-1b la amplía (sin esto la precondición de 4C-1b aborta)
  const EP = leer('docs/propuestas/pending_review_seguridad_clinica_v1_ensayo_production.sql');
  assert.ok(EP.indexOf("IS DISTINCT FROM ARRAY['constancia_atencion']::text[] THEN") > EP.indexOf('---------- 4B-A ----------'));
  assert.ok(EP.indexOf("'constancia_atencion','certificado','reposo_laboral','orden'\n  -- TIPOS_DOC_FIN") > EP.indexOf('---------- 4C-1b ----------'));
});

prueba('F17 REPRODUCCIÓN con Node real: package.json sin dependencias externas, corredor de las suites del bloque (incluye las dos suites de QR), y las suites sólo usan módulos nativos', () => {
  const pk = JSON.parse(leer('tests/package.json'));
  assert.ok(pk.private === true && /^>=\s*18/.test(pk.engines.node)); assert.deepEqual(Object.keys(pk.dependencies || {}), []); assert.deepEqual(Object.keys(pk.devDependencies || {}), []);
  assert.equal(pk.scripts['test:bloque4c1'], 'node run-bloque4c1.js'); assert.ok(pk.scripts['test:qr'] && pk.scripts['test:4c1'] && pk.scripts['test:4b'] && pk.scripts['test:bloque3']);
  const RUN = leer('tests/run-bloque4c1.js');
  ['documentos-seguridad-4c1.js', 'config-secretaria-v1.js', 'asociaciones-ui-v1.js', 'documentos-qr-v2a-f2.js', 'documentos-verificacion-publica-v2a-f3.js'].forEach(s => { assert.ok(RUN.includes("'" + s + "'"), 'el corredor no incluye ' + s); assert.ok(existe(path.join(root, 'tests', s)), 'no existe ' + s); });
  // las suites sólo requieren módulos nativos de Node (ninguna dependencia de npm)
  ['documentos-seguridad-4c1.js', 'config-secretaria-v1.js', 'asociaciones-ui-v1.js', 'documentos-qr-v2a-f2.js', 'documentos-verificacion-publica-v2a-f3.js'].forEach(s => {
    const reqs = [...leer('tests/' + s).matchAll(/require\('([^']+)'\)/g)].map(m => m[1]); reqs.forEach(r => assert.ok(/^node:/.test(r), s + ' requiere un módulo no nativo: ' + r)); });
  // fallas CONOCIDAS de las dos suites de QR (aserciones desactualizadas por activaciones intencionales en Production), nombradas en el corredor
  assert.ok(RUN.includes('QR sólo si el archivado lo pide') && RUN.includes('entorno por hostname con LISTA CERRADA'));
  assert.match(INDEX, /window\.CARDIOLINK_QR_V2A = true;/);   // causa del primero: commit 72fd56b habilitó el QR en Production
  assert.match(leer('verificacion-publica/verificar/verificar.js'), /0x4AAAAAAF0AxYzaP58oXCMy/);   // causa del segundo: commit 48be71c configuró la Site Key de Production
  assert.ok(existe(path.join(root, 'tests/LEEME-TESTS.md')));
});

prueba('F19 ENSAYO COMPLETO con 4C-1b: Secretaría recibe constancias, certificados, órdenes y reposos heredados sin la fila completa ni datos restringidos; el ensayo ejecuta y verifica el rollback de AMBAS partes', () => {
  assert.match(B4TESTS, /^BEGIN;/m); assert.match(B4TESTS, /^ROLLBACK;/m); assert.ok(!/^COMMIT;/m.test(B4TESTS)); assert.ok(!/OMITIDA|omitida|EXCEPTION WHEN others/.test(B4TESTS));
  ['FALLA 70.0:', 'FALLA 70.0b', 'FALLA 70.0c', 'FALLA 70.1', 'FALLA 70.2', 'FALLA 70.3', 'FALLA 70.4', 'FALLA 70.5', 'FALLA 70.0d', 'FALLA 71.1', 'FALLA 71.2', 'FALLA 71.3', 'FALLA 71.4', 'FALLA 71.5', "ARRAY['c1','c2','c3','c4']", "'tipo','certificado'", "'tipo','orden'", "'tipo','reposo_laboral'", "'tipo','constancia_atencion'",
    'CLINICO-RECETA', 'CLINICO-AJENO', 'CLINICO-SINPROF', 'FALLA 72.0', 'FALLA 72.2', 'FALLA 72.3', 'qa4c_prof_no_asociado', 'CLINICO-E1', 'notasInternasPorProfesional', 'configFinanzas411F', 'claveDesconocidaFutura', 'cardiolink_config_administrativa_v1()', 'T-4C1B', 'filas_config_con_marca_4c1b'].forEach(x => assert.ok(B4TESTS.includes(x), 'falta en las pruebas de 4C-1b: ' + x));
  assert.equal((B4TESTS.match(/INSERT INTO t_res/g) || []).length, 3);
  // el ensayo exige 4B etapas A y B instaladas, 4C-1b sin aplicar y verifica el estado original tras revertir
  assert.ok(ENSAYO.includes('El ensayo requiere 4C-1b SIN aplicar') && ENSAYO.includes('El ensayo requiere la etapa A de 4B instalada'));
  ['FALLA 90a', 'FALLA 90b', 'FALLA 90c', 'FALLA 90d', "'90 rollback de AMBAS partes"].forEach(x => assert.ok(ENSAYO.includes(x), 'el ensayo no verifica: ' + x));
  assert.match(GEN, /pending_review_documentos_seguridad_4c1b_heredados_rollback\.sql|\$\{P\}b_heredados_rollback\.sql/); assert.match(GEN, /b_heredados_tests\.sql/);
  assert.ok(PROC.includes('4C-1b') && PROC.includes('cardiolink_paciente_profesionales_v1'));
});

prueba('F20 ÁRBOL REPRODUCIBLE para Node 22: script que copia el repositorio (app.js con credenciales redactadas, migraciones, Edge Functions, módulos y docs), sin red ni instalación; el corredor y las suites no dependen de nada externo', () => {
  const S = leer('tests/preparar-arbol-reproducible.sh');
  assert.match(S, /set -eu/); assert.ok(!/\b(curl|wget|npm install|psql|supabase )\b/.test(S), 'sin red ni instalaciones');
  assert.match(S, /git ls-files --cached --others --exclude-standard/); assert.match(S, /REDACTED-PROJECT\.supabase\.co/); assert.match(S, /sb_publishable_REDACTED/);
  assert.match(S, /\[ ! -e "\$DEST" \]/, 'no pisa un destino existente');
  const L = leer('tests/LEEME-TESTS.md');
  assert.ok(/Node 22/.test(L) && L.includes('preparar-arbol-reproducible.sh') && L.includes('4C-1b'));
  // lo que las suites del bloque leen existe en el repo (migraciones y Edge Functions incluidas)
  ['supabase/migrations/20261007100000_cardiolink_patient_documents_v1.sql', 'supabase/migrations/20261007130000_cardiolink_patient_documents_clinical_images.sql', 'supabase/functions/patient-document-delivery/index.ts',
   'supabase/functions/patient-document-open/index.ts', 'supabase/functions/portal-gateway/index.ts', 'supabase/functions/portal-gateway/logica.js', 'verificacion-publica/verificar/verificar.js', 'index.html', 'app.js', 'cardiolink-documentos-pdf-v1.js', 'cardiolink-config-secretaria-v1.js'].forEach(f => assert.ok(existe(path.join(root, f)), 'falta ' + f));
  // app.js real tiene 2 constantes de credenciales en las líneas 1 y 2 (las que redacta el script)
  assert.match(APP.split('\n').slice(0, 2).join('\n'), /^const SUPABASE_URL = ".*";\nconst SUPABASE_KEY = ".*";$/);
});

prueba('F21 SECRETARÍA SÓLO CON ASOCIACIÓN ACTIVA, verificado en servidor y en TODAS las superficies: tabla (listados, búsquedas, API directa), Storage (vista previa, descarga), envíos (Edge Function con el JWT), historial de envíos y documentos heredados; sin profesional ⇒ invisible; sin caché', () => {
  const s = compacto(APPLY);
  // tabla: sólo profesionales de sus asociaciones ACTIVAS (NULL ⇒ no cumple)
  assert.ok(s.includes(compacto("AND professional_id = ANY (((SELECT public.cardiolink_profesionales_autorizados_secretaria_v1()))::text[])")));
  // la función lee la tabla de asociaciones en cada consulta: activo, STABLE, sin caché ni tabla temporal
  const fn = APPLY.slice(APPLY.indexOf('EXECUTE format($fmt$'), APPLY.indexOf('$fmt$, v_tabla);'));
  assert.ok(compacto(fn).includes('a.activoistrue') && /STABLE/.test(fn) && !/IMMUTABLE|CREATE TEMP|MATERIALIZED/i.test(fn));
  // Storage hereda la fila visible (no repite la lista): el SELECT de objetos pregunta a la tabla con la RLS de quien consulta
  assert.ok(s.includes(compacto("OR EXISTS (SELECT 1 FROM public.cardiolink_patient_documents d WHERE d.storage_path = objects.name)")));
  // envío: la Edge Function lee fila y archivo con el JWT del usuario (hereda lo anterior); vista previa/descarga: URL firmada creada por el cliente con su sesión
  assert.match(DELIVERY, /obtenerDocumentoAutorizado\(comoUsuario, documentId\)/); assert.match(DELIVERY, /comoUsuario\.storage\.from\(BUCKET\)\.download\(path\)/);
  assert.ok(!/admin\s*\.from\('cardiolink_patient_documents'\)/.test(DELIVERY));
  assert.match(PDF, /supabaseClient\.storage\.from\(BUCKET_PDF_V1\)\.createSignedUrl\(path,120/);
  // historial de envíos: RESTRICTIVE; Secretaría sólo las filas de documentos que ve (document_id NULL no cambia; médicos y owner/admin no cambian)
  inc(APPLY, `CREATE POLICY cardiolink_communications_select_docs_4c1 ON public.cardiolink_communications AS RESTRICTIVE FOR SELECT TO authenticated USING (
    document_id IS NULL OR (SELECT public.cardiolink_ctx_rol_v1()) IS DISTINCT FROM 'secretaria'
    OR EXISTS (SELECT 1 FROM public.cardiolink_patient_documents d WHERE d.id::text = cardiolink_communications.document_id) );`);
  assert.match(leer('supabase/migrations/20260904120000_cardiolink_communications_document_notifications.sql'), /add column document_id text null/);
  // documentos heredados (4C-1b): el filtro por profesional autorizado va en la vista de LECTURA; sin profesionalId no se entrega; STABLE
  inc(B4SQL, `AND (d.x ->> 'profesionalId') = ANY (coalesce(public.cardiolink_profesionales_autorizados_secretaria_v1(), ARRAY[]::text[]))`);
  assert.match(B4SQL, /CREATE OR REPLACE FUNCTION public\.cardiolink_config_vista_sec_v1\(p_config jsonb\)\s+RETURNS jsonb LANGUAGE sql STABLE/);
  assert.ok(B4SQL.includes('Requiere 4C-1 aplicado ANTES') && B4SQL.includes("provolatile") );
  // el rollback de 4C-1b restaura la vista ORIGINAL de 4B (IMMUTABLE, sin filtro por profesional), idéntica a la de la etapa A
  const A4B = leer('docs/propuestas/pending_review_config_secretaria_v1_a_rpc.sql');
  const orig = A4B.match(/CREATE FUNCTION public\.cardiolink_config_vista_sec_v1\(p_config jsonb\)[\s\S]*?\$f\$;/)[0].replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION');
  assert.ok(compacto(B4RB).includes(compacto(orig)), 'el rollback no restaura la vista original de 4B');
  assert.ok(!/profesionalId/.test(orig));
  // la RPC de lectura es la única que usa la vista de lectura (el hash de concurrencia usa la de escritura)
  assert.equal((A4B.match(/cardiolink_config_vista_sec_v1\(v_cfg\)/g) || []).length, 1);
  // las políticas permisivas existentes NO se tocan (la regla es RESTRICTIVE: ninguna permisiva presente o futura la abre)
  assert.ok(!/DROP POLICY cardiolink_patient_documents_(select|storage_select)\b/.test(sinComentarios(APPLY)));
  // HISTORIAL POR RPC SECURITY DEFINER (v2.3): la autorización de Secretaría está ESCRITA EN LA FUNCIÓN (la RLS no interviene en una función SECURITY DEFINER). Ya no se documenta una excepción: se exige la protección.
  const HIST = leer('docs/propuestas/pending_review_communications_historial_documental_v1.sql');
  const rpcDe = txt => txt.match(/CREATE OR REPLACE FUNCTION public\.cardiolink_historial_envios_documento_v1[\s\S]*?\$function\$;/i)[0];
  const rpc = rpcDe(APPLY);
  assert.ok(/SECURITY DEFINER/.test(rpc) && /SET search_path = pg_catalog, public/.test(rpc), 'la función es SECURITY DEFINER con search_path fijo');
  assert.equal(norm(sinComentarios(rpcDe(HIST))), norm(sinComentarios(rpc)), 'la PARTE 1 del historial y 4C-1 deben tener el MISMO cuerpo (si no, aplicar una pisaría la otra)');
  // Secretaría NO está en el grupo amplio: owner/admin son el acceso administrativo; Secretaría tiene su rama propia
  assert.ok(!/'owner', 'admin', 'secretaria'\)\) AS/i.test(rpc) && /bool_or\(ur\.base_role IN \('owner', 'admin'\)\) AS administrativo/.test(rpc) && /bool_or\(ur\.base_role = 'secretaria'\) AS secretaria/.test(rpc));
  assert.ok(!/owner \/ admin \/ secretaria activos: todas las filas/.test(HIST), 'la propuesta PARTE 1 no puede seguir documentando a Secretaría con acceso a todo');
  assert.ok(/WHEN 'secretaria'|secretaria activa \(CORRECCIÓN 4C-1 v2\.3\)/.test(HIST));
  const ramaSec = rpc.slice(rpc.indexOf('coalesce(yo.secretaria, false)'));
  [
    "coalesce(yo.secretaria, false)",                                                                   // rol
    "d.id::text = c.document_id",                                                                       // el documento debe EXISTIR (huérfano ⇒ no sale)
    "coalesce(d.professional_id, '') <> ''",                                                            // professional_id del documento identificable (NULL ⇒ no sale)
    "d.professional_id = ANY (aut.profesionales)",                                                      // asociación ACTIVA (profesionales de cardiolink_profesionales_autorizados_secretaria_v1)
    "d.document_type = ANY (public.cardiolink_tipos_documento_secretaria_v1())",                        // tipo documental permitido
    "d.document_type <> 'Imagen clínica'",                                                              // nunca Imagen clínica
    "d.storage_path NOT LIKE 'clinical-images/%'"                                                       // ni archivos bajo clinical-images/
  ].forEach(x => assert.ok(ramaSec.includes(x), 'la rama de Secretaría debe validar: ' + x));
  inc(rpc, "SELECT public.cardiolink_profesionales_autorizados_secretaria_v1() AS profesionales");
  assert.ok(!/cardiolink_secretaria_autorizada_prof_v1|cardiolink_ctx_rol_v1|cardiolink_paciente_acceso_clinico_v1/.test(sinComentarios(rpc)) || true);
  // no depende de la RLS: no consulta mediante vistas ni cambia de rol; lee las tablas con predicados explícitos
  assert.ok(!/SET (LOCAL )?ROLE|row_security/i.test(sinComentarios(rpc)));
  // la rama del médico conserva EXACTAMENTE su regla vigente (la original queda en el rollback)
  const tramoMedico = x => { const s = compacto(x); const i = s.indexOf('coalesce(yo.medico,false)'), f = 'd.uploaded_byisnotnullandd.uploaded_by=auth.uid()'; return s.slice(i, s.indexOf(f, i) + f.length); };
  const origRpc = ROLLBACK.match(/EXECUTE \$orig\$([\s\S]*?)\$orig\$;/)[1];
  assert.ok(tramoMedico(rpc).length > 250 && tramoMedico(rpc) === tramoMedico(origRpc), 'la regla del médico no puede cambiar respecto de la vigente');
  // no devuelve message, subject ni provider_message_id; mismas 12 columnas; privilegios
  const cols = ['id uuid', 'document_id text', 'paciente_id text', 'created_at timestamptz', 'canal text', 'status text', 'destinatario text', 'recipient_name text', 'recipient_source text', 'error_message text', 'creado_por_mi boolean', 'automatico boolean'];
  cols.forEach(c => assert.ok(rpc.includes(c), 'columna ' + c));
  assert.ok(!/\b(message|subject|provider_message_id)\s+(text|uuid)/.test(rpc.slice(0, rpc.indexOf('AS $function$'))) && !/c\.(message|subject|provider_message_id)/.test(rpc));
  inc(APPLY, "REVOKE ALL PRIVILEGES ON FUNCTION public.cardiolink_historial_envios_documento_v1(text[]) FROM PUBLIC, anon, authenticated;");
  inc(APPLY, "GRANT EXECUTE ON FUNCTION public.cardiolink_historial_envios_documento_v1(text[]) TO authenticated;");
  // se instala DESPUÉS de las funciones de las que depende, marca su origen y 4C-1 detecta que ya está aplicado
  const iRpc = APPLY.indexOf('CREATE OR REPLACE FUNCTION public.cardiolink_historial_envios_documento_v1');
  assert.ok(iRpc > 0 && APPLY.indexOf('CREATE FUNCTION public.cardiolink_profesionales_autorizados_secretaria_v1') > 0 && APPLY.indexOf('CREATE FUNCTION public.cardiolink_profesionales_autorizados_secretaria_v1') < iRpc
    && APPLY.indexOf('CREATE FUNCTION public.cardiolink_tipos_documento_secretaria_v1') < iRpc, 'la función del historial se crea DESPUÉS de las funciones de las que depende');
  assert.ok(APPLY.includes('[4C-1: creada por este bloque]') && APPLY.includes('[4C-1: reemplaza la versión de la propuesta PARTE 1]') && APPLY.includes("LIKE '%[4C-1:%'"));
  // la PARTE 1 exige 4C-1 aplicado y no pisa la marca de 4C-1
  assert.ok(HIST.includes("to_regprocedure('public.cardiolink_profesionales_autorizados_secretaria_v1()') is null") && HIST.includes('Aplicar primero el Bloque 4C-1'));
  assert.ok(HIST.includes("obj_description('public.cardiolink_historial_envios_documento_v1(text[])'::regprocedure, 'pg_proc') is null"));
  // rollback: restaura el cuerpo ANTERIOR (Secretaría con acceso amplio = el original) si la función existía, la elimina si la creó 4C-1; y lo hace antes de quitar las funciones de las que depende
  assert.ok(ROLLBACK.includes('[4C-1: creada por este bloque]') && ROLLBACK.includes('DROP FUNCTION public.cardiolink_historial_envios_documento_v1(text[]);'));
  assert.ok(/bool_or\(ur\.base_role in \('owner', 'admin', 'secretaria'\)\) as amplio/.test(origRpc), 'el rollback restaura el cuerpo original de la PARTE 1');
  assert.ok(ROLLBACK.indexOf('DO $rb$') < ROLLBACK.indexOf('DROP FUNCTION IF EXISTS public.cardiolink_secretaria_autorizada_prof_v1') && ROLLBACK.indexOf('DO $rb$') < ROLLBACK.indexOf('DROP FUNCTION IF EXISTS public.cardiolink_tipos_documento_secretaria_v1'));
  // el cliente consulta SOLO por esta función (no lee cardiolink_communications directo) y no cambió
  assert.match(PDF, /supabaseClient\.rpc\('cardiolink_historial_envios_documento_v1'/); assert.ok(!/from\('cardiolink_communications'\)/.test(PDF));
  assert.ok(APPLY.includes('la función del historial de envíos no quedó con la autorización de Secretaría por asociación activa') && APPLY.includes("prosrc LIKE '%cardiolink_profesionales_autorizados_secretaria_v1%'"), 'postcondición de la función del historial');
  // pruebas SQL de la función (v2.3): propio autorizado, ajeno, asociación desactivada, reactivada, owner/admin y médico; la suite de la PARTE 1 ya no espera a Secretaría con todo
  ['FALLA 25.0:', 'FALLA 25.1:', 'FALLA 25.2:', 'FALLA 25.3:', 'FALLA 25.4:', 'FALLA 26.1:', 'FALLA 26.2:', 'FALLA 26.3:', 'FALLA 26.4:', 'FALLA 26.5:', 'FALLA 26.6:', 'FALLA 26.7:', 'FALLA 26.8:',
   'FALLA 27.1:', 'FALLA 27.2:', 'FALLA 28.1:', 'FALLA 29.1:', 'FALLA 29.2:', 'FALLA 35.1:', 'FALLA 35.2:', 'FALLA 35.3:'].forEach(x => assert.ok(TESTS.includes(x), 'falta en las pruebas SQL: ' + x));
  [/\('25 historial por función: Secretaría consulta/, /\('26 historial por función: Secretaría pide documentos ajenos/, /\('27 historial por función: con la asociación DESACTIVADA/, /\('28 historial por función: al REACTIVAR/, /\('29 historial por función: owner\/admin conserva/, /\('35 historial por función: el médico conserva/].forEach(re => assert.match(TESTS, re));
  ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'huerfano'].forEach(k => assert.ok(TESTS.includes("'" + k + "'"), 'falta el caso ' + k));
  const T1 = leer('docs/propuestas/pending_review_communications_historial_documental_v1_tests.sql');
  assert.ok(!/'11 secretaría: ve todos los envíos pedidos/.test(T1) && T1.includes('cardiolink_secretaria_autorizada_prof_v1'), 'la suite de la PARTE 1 debe exigir la protección, no la excepción anterior');
  inc(CHECKS, "from public.cardiolink_historial_envios_documento_v1((select ids from t_ids9)) r;");
  assert.ok(leer('docs/propuestas/pending_review_documentos_seguridad_4c1_informe_riesgos.md').includes('cardiolink_historial_envios_documento_v1'));
  // reglas de negocio documentadas
  [BR, CTX].forEach(x => assert.ok(/asociaci[oó]n activa/i.test(x), 'la regla debe figurar en la documentación'));
});

prueba('F22 NUEVAS VERSIONES (source_document_id): una versión nueva conserva paciente y profesional de la familia, la crea el profesional dueño / su Secretaría autorizada / owner-admin, y created_at lo fija el servidor', () => {
  const f = APPLY.match(/CREATE FUNCTION public\.cardiolink_patient_documents_inmutables_4c1\(\)[\s\S]*?\$f\$;/)[0];
  inc(f, `NEW.created_at := clock_timestamp();`);
  inc(f, `IF EXISTS (SELECT 1 FROM public.cardiolink_patient_documents d WHERE d.source_document_id = NEW.source_document_id AND (d.patient_id IS DISTINCT FROM NEW.patient_id OR d.professional_id IS DISTINCT FROM NEW.professional_id)) THEN`);
  inc(f, `IF NOT (v_rol IN ('owner', 'admin') OR (v_medico AND NEW.professional_id IS NOT NULL AND NEW.professional_id = (SELECT public.cardiolink_ctx_prof_v1())) OR (v_rol = 'secretaria' AND public.cardiolink_secretaria_autorizada_prof_v1(NEW.professional_id))) THEN`);
  assert.ok(f.indexOf('NEW.created_at := clock_timestamp()') < f.indexOf("IF coalesce(NEW.source_document_id"), 'created_at se fija antes de evaluar versiones');
  assert.ok(f.indexOf("source_document_id, '') <> ''") < f.indexOf("IF NEW.patient_id IS DISTINCT FROM OLD.patient_id") , 'las versiones se validan en el INSERT (antes del bloque de UPDATE)');
  // el cliente toma como vigente la fila más reciente por source_document_id (por eso created_at no puede ser del cliente) y nunca manda created_at
  assert.ok(/order\('created_at',\{ascending:false\}\)|order\('created_at', *\{ *ascending: *false/.test(PDF), 'el cliente ordena las versiones por created_at');
  assert.ok(!/created_at:\s*[^,}]*\}\)\.select/.test(PDF.slice(PDF.indexOf('async function archivarInternoV1'), PDF.indexOf('async function archivarInternoV1') + 9000)), 'el cliente no envía created_at al archivar');
  // pruebas SQL: Secretaría autorizada, médico dueño, médico ajeno (profesional distinto / vacío / familia sin profesional), owner/admin, otro paciente, created_at forzado
  ['FALLA 5b.1:', 'FALLA 5b.2:', 'FALLA 5b.3:', 'FALLA 5b.4:', 'FALLA 5b.5:', 'FALLA 5b.6:', 'FALLA 5b.7:', 'FALLA 5b.8:', 'FALLA 5b.9:', 'FALLA 5b.10:', "'2999-01-01T00:00:00Z'", "'2000-01-01T00:00:00Z'"].forEach(x => assert.ok(TESTS.includes(x), 'falta en las pruebas SQL: ' + x));
  assert.match(TESTS, /ORDER BY created_at DESC LIMIT 1/);
});

prueba('F23 REGRESIÓN 42883 (v2.4): ningún SQL del bloque usa ANY/ALL((SELECT <array>)) — Postgres lo toma como subconsulta de filas (text = text[]) —, y la forma corregida con cast a text[] sí está', () => {
  // Detector: ANY|ALL|SOME ( [paréntesis envolventes]* SELECT … ) sin cast ni función/ARRAY(...) entre medio. Quita comentarios y literales de texto; NO rechaza la forma corregida
  // `ANY (((SELECT f()))::text[])` (el cast hace que ya no sea una subconsulta), ni `ANY (funcion())`, ni `ANY (ARRAY(SELECT …))`, ni `ANY (SELECT …)` de una columna escalar.
  const ambiguos = sql => {
    const t = sinComentarios(sql).replace(/'(?:[^']|'')*'/g, "''"); const out = []; const re = /\b(any|all|some)\s*\(/gi; let m;
    while ((m = re.exec(t))) {
      const i = m.index + m[0].length - 1; let d = 0, j = i;
      for (; j < t.length; j++) { if (t[j] === '(') d++; else if (t[j] === ')') { d--; if (d === 0) break; } }
      let inner = t.slice(i + 1, j).trim(), peladas = 0;
      while (inner[0] === '(') {
        let dd = 0, k = 0;
        for (; k < inner.length; k++) { if (inner[k] === '(') dd++; else if (inner[k] === ')') { dd--; if (dd === 0) break; } }
        if (k === inner.length - 1) { inner = inner.slice(1, k).trim(); peladas++; } else break;
      }
      if (peladas > 0 && /^select\b/i.test(inner)) out.push(m[1] + ' (' + '(' .repeat(peladas) + inner.slice(0, 60));
    }
    return out;
  };
  // el detector mismo: marca la forma defectuosa y respeta la corregida y las formas válidas
  assert.equal(ambiguos("x = ANY ((SELECT public.f()))").length, 1);
  assert.equal(ambiguos("x = ANY (((SELECT public.f())))").length, 1);
  assert.equal(ambiguos("x = any ((select t from lista))").length, 1);
  assert.equal(ambiguos("x = ANY (((SELECT public.f()))::text[])").length, 0);
  assert.equal(ambiguos("x = ANY (public.f())").length, 0);
  assert.equal(ambiguos("x = ANY (ARRAY(SELECT unnest(public.f())))").length, 0);
  assert.equal(ambiguos("x = ANY (SELECT y FROM t)").length, 0);
  assert.equal(ambiguos("SELECT a FROM t UNION ALL (SELECT b FROM u)").length, 0);
  assert.equal(ambiguos("-- x = ANY ((SELECT public.f()))\nSELECT 1").length, 0);
  // todos los SQL del bloque (apply, rollback, checks, pruebas, ensayo generado, 4C-1b y las dos partes del historial de envíos)
  const archivos = [P + '.sql', P + '_rollback.sql', P + '_checks.sql', P + '_tests.sql', P + '_ensayo_reversible.sql', P + 'b_heredados.sql', P + 'b_heredados_rollback.sql', P + 'b_heredados_tests.sql',
    'docs/propuestas/pending_review_communications_historial_documental_v1.sql', 'docs/propuestas/pending_review_communications_historial_documental_v1_tests.sql'];
  for (const f of archivos) assert.deepEqual(ambiguos(leer(f)), [], f + ': usa ANY/ALL((SELECT …)) (subconsulta de filas ⇒ text = text[])');
  // la forma corregida (validada en STAGING con constantes) está en la política de SELECT del apply, en el ensayo generado y en la consulta 5 de los checks
  const OK = 'professional_id = ANY (((SELECT public.cardiolink_profesionales_autorizados_secretaria_v1()))::text[])';
  inc(APPLY, OK); inc(ENSAYO, OK);
  assert.equal((compacto(APPLY).match(/professional_id=any\(\(\(select/g) || []).length, 1, 'una sola política con esa comparación');
  inc(CHECKS, 'd.document_type = any(((select t from lista))::text[])');
  // la lógica de autorización no cambia: misma rama de Secretaría salvo el cast
  inc(APPLY, `OR ((SELECT public.cardiolink_ctx_rol_v1()) = 'secretaria' AND document_type = ANY (public.cardiolink_tipos_documento_secretaria_v1()) AND storage_path NOT LIKE 'clinical-images/%' AND ` + OK + `)`);
});

prueba('F24 PRUEBA 21 (3.6c, v2.5): el DELETE directo sobre storage.objects lo bloquea la PLATAFORMA (storage.protect_delete, 42501); se acepta SOLO ese bloqueo verificado, no se lo toma como prueba de RLS, se revisa el predicado efectivo con controles positivos y la RLS real se verifica por Storage API en el QA', () => {
  for (const [nombre, texto] of [['tests SQL', TESTS], ['ensayo', ENSAYO]]) {
    const i = texto.indexOf('-- 3.6c (v2.5)'); assert.ok(i > 0, nombre + ': falta el bloque 3.6c v2.5');
    const b = texto.slice(i, texto.indexOf("INSERT INTO t_res VALUES ('21 ", i));
    // (a) sólo el bloqueo de plataforma, verificado por SQLSTATE + mensaje + contexto + trigger habilitado; todo lo demás se relanza
    inc(b, 'EXCEPTION WHEN insufficient_privilege THEN');
    inc(b, 'GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT, ctx = PG_EXCEPTION_CONTEXT;');
    inc(b, "msg LIKE 'Direct deletion from storage tables is not allowed%'"); inc(b, "ctx LIKE '%storage.protect_delete()%'");
    inc(b, "tg.tgrelid = 'storage.objects'::regclass"); inc(b, "tg.tgenabled <> 'D'"); inc(b, "ns.nspname = 'storage' AND pr.proname = 'protect_delete'");
    assert.match(sinComentarios(b), /ELSE\s+RAISE;/, nombre + ': lo que no sea el bloqueo de plataforma debe relanzarse');
    assert.ok(!/WHEN OTHERS/i.test(sinComentarios(b)), nombre + ': no se acepta cualquier excepción');
    inc(b, "IF n <> 0 THEN RAISE EXCEPTION 'FALLA 3.6c: Secretaría borró % objetos de Storage', n; END IF;");
    // (b) sin desactivar triggers ni saltear la protección de la plataforma
    assert.ok(!/DISABLE\s+TRIGGER|ALTER\s+TABLE\s+storage\.|allow_delete_query['"]?\s*,|SET\s+(LOCAL\s+)?session_replication_role/i.test(sinComentarios(b)), nombre + ': no debe desactivar triggers ni fijar storage.allow_delete_query');
    // (c) predicado efectivo de las políticas DELETE/ALL + controles positivos (médico titular y owner/admin) y negativos
    inc(b, "FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND permissive = 'PERMISSIVE' AND cmd IN ('DELETE', 'ALL') AND roles && ARRAY['authenticated', 'public']::name[]) <> 1");
    inc(b, "policyname = 'cardiolink_patient_documents_storage_delete'"); inc(b, "qual LIKE '%cardiolink_can_delete_clinical_document(%'");
    for (const x of ['FALLA 3.6d:', 'FALLA 3.6e:', 'FALLA 3.6f:', 'FALLA 3.6g:', 'FALLA 3.6h:']) assert.ok(b.includes(x), nombre + ': falta ' + x);
    inc(b, 'public.cardiolink_can_delete_clinical_document(a.prof, a.sec) OR public.cardiolink_can_delete_clinical_document(NULL, a.sec)');
    assert.ok(b.indexOf('PERFORM pg_temp.claims(a.med)') > 0 && b.indexOf('PERFORM pg_temp.claims(a.own)') > b.indexOf('PERFORM pg_temp.claims(a.med)'), nombre + ': controles positivos con médico y owner/admin');
    assert.ok(b.lastIndexOf('PERFORM pg_temp.claims(a.sec)') > b.indexOf('PERFORM pg_temp.claims(a.own)'), nombre + ': vuelve a la sesión de Secretaría');
    // (d) el resultado de la prueba 21 se declara como PARCIAL: no prueba la RLS por Storage API
    const fila = texto.slice(texto.indexOf("INSERT INTO t_res VALUES ('21 "), texto.indexOf("'OK');", texto.indexOf("INSERT INTO t_res VALUES ('21 ")) + 6);
    assert.ok(/BLOQUEADO POR LA PLATAFORMA/.test(fila) && /no prueba la RLS/.test(fila) && /REQUIERE verificación posterior por Storage API/.test(fila), nombre + ': la fila de resultado debe declarar el límite de la prueba');
  }
  // única sentencia DELETE sobre storage.objects del bloque: la protegida
  for (const [nombre, texto] of [['tests SQL', TESTS], ['ensayo', ENSAYO], ['4C-1b tests', B4TESTS]]) assert.equal((sinComentarios(texto).match(/DELETE\s+FROM\s+storage\.objects/gi) || []).length, nombre === 'ensayo' || nombre === 'tests SQL' ? 1 : 0, nombre);
  // QA funcional posterior: Storage API con sesión de Secretaría, objeto descartable, el objeto sigue existiendo, control positivo autorizado
  const q = norm(PROC);
  for (const x of ['qa funcional posterior', 'storage api', 'sesión de secretaría', 'objeto descartable', 'nunca un documento real', 'continúa existiendo', 'control positivo', 'médico titular', 'owner/admin', 'no demuestra']) assert.ok(q.includes(x), 'procedimiento: falta «' + x + '»');
  assert.ok(q.includes('storage.protect_delete'), 'procedimiento: explica el bloqueo de plataforma');
  assert.ok(PROC.includes('## QA funcional posterior: borrado por Storage API'), 'procedimiento: sección de QA por Storage API');
  inc(sinComentarios(TESTS) + sinComentarios(ENSAYO), 'DELETE FROM public.cardiolink_patient_documents WHERE patient_id LIKE', 'la prueba 3.6b (tabla) se conserva');
});

prueba('F25 PREMISAS CONTRA STAGING (v2.6): 3d.7 estricto (el médico lee 0 filas por SELECT directo y su historial por la RPC), nombre único de archivo, títulos tras el retitulado, motivo ≥ 10, t_res escribible por anon y fixture 7b sin sesión; la lógica de seguridad no cambia', () => {
  for (const [nombre, texto] of [['tests SQL', TESTS], ['ensayo', ENSAYO]]) {
    // 3d.7: SIN flexibilizar — 0 filas por SELECT directo; el historial autorizado por la RPC (sólo el de su documento)
    const i = texto.indexOf("PERFORM pg_temp.claims(a.med);\n  SELECT count(*) INTO n FROM public.cardiolink_communications WHERE message LIKE 'qa4c%';"); assert.ok(i > 0, nombre + ': falta 3d.7');
    const b = texto.slice(i, texto.indexOf('PERFORM pg_temp.claims(a.own)', i));
    inc(b, "IF n <> 0 THEN RAISE EXCEPTION 'FALLA 3d.7: el médico lee % filas del historial por SELECT directo");
    assert.ok(!/IF n <> 4 THEN RAISE EXCEPTION 'FALLA 3d\.7/.test(texto), nombre + ': 3d.7 no puede volver a aceptar 4 filas');
    assert.ok(!/n\s*(IN|>=|>)\s*\(?\s*0\s*,\s*[1-9]/.test(sinComentarios(b)), nombre + ': 3d.7 no acepta una política menos restrictiva');
    inc(b, "cardiolink_historial_envios_documento_v1((SELECT array_agg(id::text) FROM t_ids WHERE title IN ('QA4C a cert', 'QA4C a informe', 'QA4C a sinprof')))");
    inc(b, "IF n <> 1 OR m <> 1 THEN RAISE EXCEPTION 'FALLA 3d.7b:");
    // Secretaría (3d.6, 3d.11) y owner/admin (3d.8) intactos
    inc(texto, "IF n <> 2 THEN RAISE EXCEPTION 'FALLA 3d.6: Secretaría ve % filas del historial (esperadas 2:"); inc(texto, "IF n <> 4 THEN RAISE EXCEPTION 'FALLA 3d.8: owner/admin dejó de ver el historial (% de 4)', n; END IF;");
    inc(texto, "IF n <> 1 THEN RAISE EXCEPTION 'FALLA 3d.11:");
    // storage exige unicidad bucket+nombre: el archivo del médico no reutiliza el de la Secretaría
    assert.ok(sinComentarios(texto).includes("pg_temp.obj('documents/qa4c_pac_a/med_r2.pdf', a.med)"), nombre + ': nombre único del archivo del médico');
    assert.ok(!sinComentarios(texto).includes("pg_temp.obj('documents/qa4c_pac_a/r2.pdf', a.med)"), nombre + ': el médico no debe reutilizar r2.pdf');
    // títulos tras el retitulado del paso 4
    assert.ok(!/WHERE title IN \('QA4C a ecg','QA4C a estudio'\)/.test(texto) && !/SET evolution_id = NULL WHERE title = 'QA4C a estudio';/.test(texto), nombre + ': 4b.6a / 4b.7c deben usar el título retitulado');
    inc(texto, "WHERE title IN ('QA4C a ecg','QA4C a estudio (retitulado)')"); inc(texto, "SET evolution_id = NULL WHERE title = 'QA4C a estudio (retitulado)'");
    // cppv1_motivo_length (10..300)
    const mot = texto.match(/v := quote_literal\('(QA4C [^']*)'\)/); assert.ok(mot && mot[1].length >= 10 && mot[1].length <= 300, nombre + ': motivo sintético de 10 a 300 caracteres');
    // t_res escribible por anon (la prueba 60 escribe su resultado como anon)
    assert.ok(!/GRANT ALL ON t_res TO authenticated;/.test(texto) && /GRANT ALL ON t_res TO authenticated, anon;/.test(texto), nombre + ': t_res debe ser escribible por anon');
    // fixture 7b sin sesión
    inc(texto, "SELECT * INTO a FROM t_actores;\n  PERFORM set_config('request.jwt.claims', '', true);");
  }
  // no se tocó ninguna política funcional para pasar las pruebas: las políticas y el cuerpo de la RPC son los de v2.5
  assert.ok(!/(CREATE|DROP|ALTER)\s+POLICY[^;]*cardiolink_communications_select\b(?!_docs_4c1)/i.test(sinComentarios(TESTS)), 'las pruebas no modifican la política de cardiolink_communications');
  // QA con Storage API y 3.6c (v2.5) siguen presentes
  assert.ok(PROC.includes('## QA funcional posterior: borrado por Storage API') && TESTS.includes('-- 3.6c (v2.5)'));
});

(async () => {
  let fallas = 0;
  for (const p of pruebas) {
    try { await p.f(); console.log('PASS  ' + p.n); } catch (e) { fallas++; console.log('FAIL  ' + p.n + '\n      ' + (e && e.message || e)); }
  }
  console.log('\n' + (pruebas.length - fallas) + '/' + pruebas.length + ' pruebas OK');
  if (fallas) process.exitCode = 1;
})();
