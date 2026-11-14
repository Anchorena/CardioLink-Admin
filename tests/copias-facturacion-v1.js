'use strict';

// tests/copias-facturacion-v1.js — Copias para facturación V1. Revisión ESTÁTICA del SQL, su rollback, el módulo de cliente, el cableado en index.html y la documentación.
// Sin red ni base: el SQL se valida aparte (ensayo en PostgreSQL real con stubs de Supabase y pruebas transaccionales en STAGING). Esto fija su estructura y que no rompa flujos ajenos.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const leer = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const P = 'docs/propuestas/pending_review_copias_facturacion_v1';
const APPLY = leer(P + '.sql'), ROLLBACK = leer(P + '_rollback.sql');
const MOD = leer('cardiolink-copias-facturacion-v1.js'), CSS = leer('cardiolink-copias-facturacion-v1.css'), INDEX = leer('index.html');
const sinComentarios = t => t.replace(/--[^\n]*/g, '');
const compacto = t => sinComentarios(t).replace(/\s+/g, '').toLowerCase();
const inc = (texto, frag, msg) => assert.ok(compacto(texto).includes(compacto(frag)), msg || ('falta: ' + frag.slice(0, 90)));

const pruebas = [];
const prueba = (n, f) => pruebas.push({ n, f });

prueba('S1 el SQL es una sola transacción, aditiva, con precondiciones y postcondiciones, y NO está en supabase/migrations', () => {
  const s = sinComentarios(APPLY);
  assert.equal((s.match(/^BEGIN;/gm) || []).length, 1); assert.equal((s.match(/^COMMIT;/gm) || []).length, 1);
  assert.ok(!fs.existsSync(path.join(root, 'supabase/migrations')) || !fs.readdirSync(path.join(root, 'supabase/migrations')).some(f => /copias_facturacion/.test(f)), 'no debe poder aplicarse por db push');
  ['falta cardiolink_secretaria_autorizada_prof_v1(text)', 'storage.objects.owner debe ser uuid', 'ya está aplicado', 'sin filtro por bucket', 'FALLA:'].forEach(t => assert.ok(APPLY.includes(t), 'falta: ' + t));
  // aditivo: nada de DROP/ALTER sobre objetos ajenos ni DML sobre datos existentes
  const sinBloques = s.replace(/DO \$\$[\s\S]*?\$\$;/g, '').replace(/\$(f|body)\$[\s\S]*?\$\1\$/g, '').replace(/'(?:[^']|'')*'/g, "''");   // sin bloques ni literales de texto
  assert.ok(!/\b(DROP |TRUNCATE|DELETE FROM|UPDATE )/i.test(sinBloques.replace(/BEFORE INSERT OR UPDATE ON/g, '')), 'no debe borrar ni actualizar nada existente');
  assert.ok(!/ALTER TABLE (?!public\.cardiolink_copias_facturacion ENABLE ROW LEVEL SECURITY)/i.test(sinBloques), 'sólo se altera la tabla nueva (RLS)');
  ['cardiolink_patient_documents', 'cardiolink_communications', 'cardiolink_hc_'].forEach(t => assert.ok(!s.includes(t), 'no debe tocar ' + t));
  assert.ok(!/(INSERT INTO|UPDATE|DELETE FROM)\s+public\.cardiolink_atenciones/i.test(s) && /FROM public\.cardiolink_atenciones x/.test(s), 'cardiolink_atenciones sólo se LEE (validación del vínculo)');
});

prueba('S2 bucket PRIVADO propio, sólo PDF, 10 MB; políticas de Storage acotadas a ese bucket y sin UPDATE', () => {
  const s = sinComentarios(APPLY);
  assert.match(s, /INSERT INTO storage\.buckets[^;]*'billing-copies', 'billing-copies', false, 10485760, ARRAY\['application\/pdf'\]/);
  assert.ok(!/public\s*=\s*true/i.test(s));
  const pol = [...s.matchAll(/CREATE POLICY (\w+) ON storage\.objects\s+FOR (\w+) TO authenticated/g)];
  assert.deepEqual(pol.map(m => m[2]).sort(), ['DELETE', 'INSERT', 'SELECT']);
  pol.forEach(m => { const cuerpo = s.slice(s.indexOf(m[0]), s.indexOf(';', s.indexOf(m[0]) + 1000) + 1); assert.ok(cuerpo.includes("bucket_id = 'billing-copies'"), m[1] + ' sin filtro de bucket'); });
  assert.ok(!/FOR UPDATE/i.test(s.replace(/BEFORE INSERT OR UPDATE/g, '')) && !/FOR ALL/i.test(s));
  assert.ok(!/AS RESTRICTIVE/i.test(s), 'no agrega restrictivas (no puede bloquear otros buckets)');
});

prueba('S3 tabla: RLS activa, anon sin nada, authenticated sin UPDATE, policies sobre la función de acceso, RPC SECURITY DEFINER sólo para authenticated', () => {
  const s = sinComentarios(APPLY);
  assert.match(s, /ENABLE ROW LEVEL SECURITY/);
  assert.match(s, /REVOKE ALL ON TABLE public\.cardiolink_copias_facturacion FROM PUBLIC, anon, authenticated;/);
  assert.match(s, /GRANT SELECT, INSERT, DELETE ON TABLE public\.cardiolink_copias_facturacion TO authenticated;/);
  assert.ok(!/GRANT[^;]*UPDATE[^;]*TO authenticated/i.test(s));
  inc(APPLY, 'USING (public.cardiolink_copia_facturacion_acceso_v1(professional_id))');
  inc(APPLY, 'USING (public.cardiolink_copia_facturacion_puede_eliminar_v1(professional_id, uploaded_by))');
  inc(APPLY, 'public.cardiolink_copia_facturacion_objeto_asignable_v1(storage_path)');
  assert.match(s, /cardiolink_copia_facturacion_impresion_v1[\s\S]*?SECURITY DEFINER SET search_path = pg_catalog, public/);
  assert.match(s, /REVOKE ALL ON FUNCTION public\.cardiolink_copia_facturacion_impresion_v1\(uuid, text\) FROM PUBLIC, anon;/);
  assert.ok(!/service_role/.test(MOD), 'el cliente nunca usa service_role');
});

prueba('S4 autorización reutiliza lo publicado (asociaciones activas, ctx_rol/ctx_prof) y no crea otro sistema de roles', () => {
  inc(APPLY, 'public.cardiolink_secretaria_autorizada_prof_v1(p_prof)');
  inc(APPLY, 'p_prof = (SELECT public.cardiolink_ctx_prof_v1())');
  assert.ok(!/CREATE TABLE public\.(?!cardiolink_copias_facturacion)/.test(sinComentarios(APPLY)), 'una sola tabla nueva');
  // Secretaría sólo elimina lo que ella misma subió
  inc(APPLY, "WHEN 'secretaria' THEN p_uploaded_by IS NOT NULL AND p_uploaded_by = auth.uid() AND public.cardiolink_secretaria_autorizada_prof_v1(p_prof)");
});

prueba('S5 el servidor fija autor, estado inicial y la identidad inmutable (trigger)', () => {
  ['NEW.uploaded_by := auth.uid()', "NEW.print_status := 'pendiente'", 'NEW.print_count := 0', 'La identidad de una copia para facturación'].forEach(t => assert.ok(APPLY.includes(t), 'falta: ' + t));
});

prueba('S6 rollback: protege datos, no borra el bucket por SQL, no toca 4C-1 ni patient-documents', () => {
  const s = sinComentarios(ROLLBACK);
  assert.ok(ROLLBACK.includes('cardiolink.copias_rollback_forzar') && ROLLBACK.includes('Rollback abortado'));
  assert.ok(!/storage\.(buckets|objects)\s*(WHERE|;)/i.test(s.replace(/FROM storage\.objects WHERE bucket_id = 'billing-copies'/g, '')) || !/DELETE FROM storage/i.test(s), 'no borra storage por SQL');
  assert.ok(!/DELETE FROM/i.test(s) && !/patient[-_]documents/.test(s));
  ['cardiolink_copias_fact_storage_select', 'cardiolink_copias_fact_storage_insert', 'cardiolink_copias_fact_storage_delete', 'cardiolink_copia_facturacion_impresion_v1', 'cardiolink_copias_facturacion_guard_v1'].forEach(t => assert.ok(s.includes(t), 'rollback sin ' + t));
});

prueba('C1 el módulo es independiente: no usa patient-documents, tablas de documentos clínicos, portal ni envío al paciente', () => {
  const s = MOD.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  ['patient-documents', 'cardiolink_patient_documents', 'cardiolink_communications', 'patient-document-delivery', 'portal-gateway', 'document_delivery', 'cardiolink_hc_'].forEach(t => assert.ok(!s.includes(t), 'no debe referenciar ' + t));
  assert.ok(!/createSignedUrl|getPublicUrl|publicUrl/.test(s), 'sin URL pública ni firmada: descarga autenticada');
  assert.ok(s.includes(".storage.from(BUCKET).download("), 'descarga autenticada del bucket privado');
});

prueba('C2 no modifica funcionalidades ajenas: sólo envuelve funciones existentes (sin reemplazarlas) y no toca app.js', () => {
  ['seccionPermitida', 'showSection', 'abrirAgendaModal', 'renderTabla'].forEach(f => {
    assert.ok(new RegExp('const prev\\w* = g\\(\'' + f + '\'\\)').test(MOD), 'envoltura de ' + f);
    assert.ok(new RegExp('prev\\w*\\.apply\\(this, arguments\\)').test(MOD));
  });
  assert.ok(!/__copiasFactV1\s*=\s*false/.test(MOD) && /w\.__copiasFactV1 = true/.test(MOD), 'envolturas idempotentes');
  assert.ok(!/atenciones\.push|saveAtenciones|guardarAtencion|a\.copiaImpresa\s*=/.test(MOD), 'no escribe atenciones ni toca copiaImpresa');
});

prueba('C3 cliente: confirmación al eliminar, validación de PDF, límite 10 MB, reversión del archivo huérfano y orden archivo→fila', () => {
  assert.ok(MOD.includes('window.confirm(\'¿Eliminar esta copia para facturación?') && MOD.includes('El informe clínico y los documentos de la historia clínica no se tocan'));
  assert.ok(MOD.includes("'%PDF-'") && MOD.includes('MAX_BYTES = 10 * 1024 * 1024'));
  assert.ok(MOD.includes('.remove([ruta])') && MOD.includes('se revirtió la subida'));
  assert.ok(MOD.indexOf('.storage.from(BUCKET).remove([ruta])') < MOD.indexOf(".from(TABLA).delete().eq('id', fila.id)"), 'primero el archivo (la política exige la fila), después la fila');
  assert.ok(MOD.includes("p_accion: accion") && MOD.includes("'marcar_impreso'") && MOD.includes("'reimprimir'"));
});

prueba('C4 vinculación automática desde la atención: paciente, DNI, atención, profesional, prestación, obra social y fecha; estado en la atención', () => {
  ['patient_id: pacienteId', 'patient_dni: dni', 'attention_id: st.atencionId', 'professional_id: prof', 'service:', 'obra_social:', 'study_date: fecha'].forEach(t => assert.ok(MOD.includes(t), 'falta ' + t));
  assert.ok(MOD.includes('Copia de facturación subida'));
  assert.ok(MOD.includes('agendaModalBody') && MOD.includes('tablaAtenciones'));
});

prueba('C5 la sección, filtros y acciones pedidas existen', () => {
  ['Mes y año', 'Profesional', 'Obra social', 'Estado', 'Descargar', 'Imprimir', 'Reimprimir', 'Marcar impreso', 'Eliminar', 'Copias para facturación'].forEach(t => assert.ok(MOD.includes(t), 'falta ' + t));
  assert.ok(!/setTimeout\([^)]*remove|retenci[oó]n.*(delete|borrar)/i.test(MOD), 'sin borrado automático');
});

prueba('I1 index.html: sección + botón en el grupo Administrativo + CSS + script después de app.js; permisos de menú los resuelve el módulo', () => {
  assert.ok(/<section id="copiasFacturacion" class="section"><\/section>/.test(INDEX));
  assert.ok(/data-section="copiasFacturacion">Copias para facturación<\/button>/.test(INDEX));
  assert.ok(INDEX.indexOf('nav-group-label">Administrativo') < INDEX.indexOf('data-section="copiasFacturacion"') && INDEX.indexOf('data-section="copiasFacturacion"') < INDEX.indexOf('nav-group-label">Configuración'));
  assert.ok(INDEX.indexOf('app.js?v=') < INDEX.indexOf('cardiolink-copias-facturacion-v1.js'));
  assert.ok(INDEX.includes('cardiolink-copias-facturacion-v1.css'));
  assert.ok(CSS.includes('.copias-fact-'));
});

(async () => {
  let fallas = 0;
  for (const p of pruebas) {
    try { await p.f(); console.log('PASS  ' + p.n); } catch (e) { fallas++; console.log('FAIL  ' + p.n + '\n      ' + (e && e.message || e)); }
  }
  console.log('\n' + (pruebas.length - fallas) + '/' + pruebas.length + ' pruebas OK');
  if (fallas) process.exitCode = 1;
})();
