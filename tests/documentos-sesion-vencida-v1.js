'use strict';

// tests/documentos-sesion-vencida-v1.js
// Contrato de archivarVersionDocumentoV1 (cardiolink-documentos-pdf-v1.js) frente a una sesión Supabase perdida.
// Caso real: "permission denied for table cardiolink_patient_documents" al guardar un certificado. Con la sesión perdida, supabase-js envía la clave
// publishable (rol anon) mientras app.js conserva usuarioSupabase en memoria. El módulo debe comprobar la sesión VIVA antes de archivar y, si no
// existe o no puede renovarse, NO generar el PDF, NO tocar Storage ni la tabla y devolver un mensaje claro (el llamador conserva el texto).
// Ejecuta el módulo REAL contra un cliente Supabase simulado (sin red, sin Supabase).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'cardiolink-documentos-pdf-v1.js'), 'utf8');

const MSG = 'Tu sesión venció. Volvé a iniciar sesión';
const AHORA = Math.floor(Date.now() / 1000);

// Carga el módulo con window/document/supabaseClient/usuarioSupabase simulados (parámetros que sombrean los globales de app.js).
function montar(cfg) {
  const llamadas = { getSession: 0, refreshSession: 0, from: [], upload: [], remove: [], insert: [], generarPdf: 0 };
  const respuestas = Object.assign({ ultima: { data: [], error: null }, insert: { data: { id: 'row_1', created_at: '2026-10-27T00:00:00Z' }, error: null }, existe: { data: [], error: null } }, cfg.respuestas || {});

  function consulta(tabla) {
    const q = { tabla, op: 'select' };
    const cadena = {
      select() { return cadena; }, eq() { return cadena; }, order() { return cadena; }, limit() { return cadena; },
      single() { return cadena; },
      insert(fila) { q.op = 'insert'; llamadas.insert.push(fila); return cadena; },
      then(ok, ko) {
        let r;
        if (q.op === 'insert') r = respuestas.insert;
        else { q.nSelect = (llamadas.nSelect = (llamadas.nSelect || 0) + 1); r = q.nSelect === 1 ? respuestas.ultima : respuestas.existe; }
        return Promise.resolve(r).then(ok, ko);
      }
    };
    return cadena;
  }

  const sesionActual = { valor: cfg.sesion };
  const cliente = {
    auth: {
      async getSession() { llamadas.getSession++; const s = typeof sesionActual.valor === 'function' ? sesionActual.valor(llamadas.getSession) : sesionActual.valor; return cfg.getSessionError ? { data: { session: null }, error: cfg.getSessionError } : { data: { session: s }, error: null }; },
      async refreshSession() { llamadas.refreshSession++; return cfg.refresh ? cfg.refresh() : { data: { session: null }, error: { message: 'Invalid Refresh Token' } }; },
      async getUser() { return { data: { user: { id: 'u_getuser' } }, error: null }; }
    },
    from(t) { llamadas.from.push(t); return consulta(t); },
    storage: { from() { return { async upload(p) { llamadas.upload.push(p); return { error: null }; }, async remove(p) { llamadas.remove.push(p); return { error: null }; } }; } }
  };

  const win = {
    addEventListener() {},
    crypto: { randomUUID: () => '11111111-1111-4111-8111-111111111111' },
    generarPdfDocumentoGenerado406: async (id) => {
      llamadas.generarPdf++;
      return { ok: true, blob: { size: 10 }, patientId: 'p1', documentDate: '2026-10-27', documentType: 'Certificado', title: 'Certificado', description: '', professionalId: 'rogelio', originalFilename: 'c.pdf', sourceDocumentId: id, sourceContentHash: 'h_nuevo', payload: { v: 2 } };
    }
  };
  const doc = { readyState: 'loading', addEventListener() {}, getElementById() { return null; }, querySelectorAll() { return []; } };
  const usuario = { id: 'u_memoria' }; // lo que app.js conserva aunque la sesión ya no exista

  new Function('window', 'document', 'supabaseClient', 'usuarioSupabase', 'crypto', source)(win, doc, cliente, usuario, win.crypto);
  assert.equal(typeof win.archivarVersionDocumentoV1, 'function', 'el módulo debe exponer archivarVersionDocumentoV1');
  return { archivar: win.archivarVersionDocumentoV1, llamadas };
}

const sesionValida = { user: { id: 'u_vivo' }, expires_at: AHORA + 3600 };
const sesionVencida = { user: { id: 'u_vivo' }, expires_at: AHORA - 60 };
const docCert = { id: 'doc_cert_1', tipo: 'certificado' };

function sinEfectos(llamadas, msg) {
  assert.equal(llamadas.generarPdf, 0, msg + ': no genera el PDF');
  assert.equal(llamadas.upload.length, 0, msg + ': no sube nada a Storage');
  assert.equal(llamadas.remove.length, 0, msg + ': no borra nada de Storage');
  assert.equal(llamadas.insert.length, 0, msg + ': no inserta metadata');
  assert.equal(llamadas.from.length, 0, msg + ': no consulta ni escribe la tabla (nada corre como anon)');
}

const casos = [];
function caso(nombre, fn) { casos.push([nombre, fn]); }

caso('sin sesión (getSession devuelve null): no inicia el guardado y avisa con mensaje claro', async () => {
  const { archivar, llamadas } = montar({ sesion: null });
  const r = await archivar(docCert, {});
  assert.equal(r.ok, false);
  assert.equal(r.sesionVencida, true);
  assert.ok(r.error.startsWith(MSG), r.error);
  assert.ok(!/permission denied/i.test(r.error));
  assert.equal(llamadas.refreshSession, 0, 'sin sesión no hay nada que renovar');
  sinEfectos(llamadas, 'sin sesión');
});

caso('getSession con error: mismo resultado, sin efectos', async () => {
  const { archivar, llamadas } = montar({ sesion: null, getSessionError: { message: 'storage no disponible' } });
  const r = await archivar(docCert, {});
  assert.equal(r.ok, false);
  assert.ok(r.error.startsWith(MSG));
  sinEfectos(llamadas, 'getSession con error');
});

caso('sesión vencida que no puede renovarse: no inicia el guardado', async () => {
  const { archivar, llamadas } = montar({ sesion: sesionVencida });
  const r = await archivar(docCert, {});
  assert.equal(r.ok, false);
  assert.equal(r.sesionVencida, true);
  assert.ok(r.error.startsWith(MSG));
  assert.equal(llamadas.refreshSession, 1, 'intenta renovar una vez');
  sinEfectos(llamadas, 'refresh fallido');
});

caso('sesión vencida pero renovable: continúa y archiva', async () => {
  const { archivar, llamadas } = montar({ sesion: sesionVencida, refresh: () => ({ data: { session: { user: { id: 'u_vivo' }, expires_at: AHORA + 3600 } }, error: null }) });
  const r = await archivar(docCert, {});
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(llamadas.refreshSession, 1);
  assert.equal(llamadas.upload.length, 1);
  assert.equal(llamadas.insert.length, 1);
});

caso('sesión válida: archiva una vez (Storage + metadata) y devuelve la fila confirmada', async () => {
  const { archivar, llamadas } = montar({ sesion: sesionValida });
  const r = await archivar(docCert, {});
  assert.equal(r.ok, true);
  assert.equal(r.rowId, 'row_1');
  assert.equal(r.reusado, false);
  assert.equal(llamadas.refreshSession, 0);
  assert.equal(llamadas.upload.length, 1);
  assert.equal(llamadas.insert.length, 1);
  assert.equal(llamadas.insert[0].uploaded_by, 'u_getuser');
  assert.equal(llamadas.insert[0].source_document_id, 'doc_cert_1');
});

caso('verificación de persistencia intacta: misma huella reutiliza la fila archivada sin subir ni insertar', async () => {
  const { archivar, llamadas } = montar({ sesion: sesionValida, respuestas: { ultima: { data: [{ id: 'row_0', source_content_hash: 'h_nuevo', created_at: '2026-10-26T00:00:00Z', pv: '2' }], error: null } } });
  const r = await archivar(docCert, { baseArchivoId: 'row_0' });
  assert.equal(r.ok, true);
  assert.equal(r.reusado, true);
  assert.equal(r.rowId, 'row_0');
  assert.equal(llamadas.upload.length, 0);
  assert.equal(llamadas.insert.length, 0);
});

caso('verificación de persistencia intacta: versión más reciente de otra sesión => conflicto, nada se sobrescribe', async () => {
  const { archivar, llamadas } = montar({ sesion: sesionValida, respuestas: { ultima: { data: [{ id: 'row_otra', source_content_hash: 'h_otro', created_at: '2026-10-26T00:00:00Z', pv: '2' }], error: null } } });
  const r = await archivar(docCert, { baseArchivoId: 'row_vieja' });
  assert.equal(r.ok, false);
  assert.equal(r.conflicto, true);
  assert.equal(llamadas.upload.length, 0);
  assert.equal(llamadas.insert.length, 0);
});

caso('la sesión se pierde entre el chequeo y la consulta (42501): se informa sesión vencida, sin subir nada', async () => {
  // 1ª comprobación OK; al re-evaluar tras el error ya no hay sesión
  const { archivar, llamadas } = montar({ sesion: (n) => (n === 1 ? sesionValida : null), respuestas: { ultima: { data: null, error: { code: '42501', message: 'permission denied for table cardiolink_patient_documents' } } } });
  const r = await archivar(docCert, {});
  assert.equal(r.ok, false);
  assert.ok(r.error.startsWith(MSG), r.error);
  assert.equal(llamadas.upload.length, 0);
  assert.equal(llamadas.insert.length, 0);
});

caso('42501 con la sesión intacta: no se atribuye a la sesión, se conserva el mensaje original del servidor', async () => {
  const { archivar, llamadas } = montar({ sesion: sesionValida, respuestas: { ultima: { data: null, error: { code: '42501', message: 'permission denied for table cardiolink_patient_documents' } } } });
  const r = await archivar(docCert, {});
  assert.equal(r.ok, false);
  assert.ok(r.error.startsWith('No se pudo consultar las versiones archivadas: permission denied'), r.error);
  assert.ok(!r.sesionVencida);
  assert.equal(llamadas.upload.length, 0);
});

caso('fallo del INSERT con fila inexistente: revierte el PDF subido (comportamiento previo)', async () => {
  const { archivar, llamadas } = montar({ sesion: sesionValida, respuestas: { insert: { data: null, error: { code: 'XX000', message: 'boom' } }, existe: { data: [], error: null } } });
  const r = await archivar(docCert, {});
  assert.equal(r.ok, false);
  assert.ok(r.error.startsWith('No se pudo archivar el PDF: boom'), r.error);
  assert.equal(llamadas.upload.length, 1);
  assert.equal(llamadas.remove.length, 1);
});

caso('estático: la sesión se comprueba ANTES de generar el PDF y no se tocó app.js ni signOut en el módulo', async () => {
  const iAsegurar = source.indexOf('const ses=await asegurarSesionV1();');
  const iGenerar = source.indexOf('window.generarPdfDocumentoGenerado406?.(doc.id', iAsegurar);
  assert.ok(iAsegurar > 0 && iGenerar > iAsegurar, 'asegurarSesionV1 debe ir antes de generar el PDF');
  assert.ok(!/\.signOut\s*\(/.test(source), 'el módulo no debe llamar signOut()');
});

(async () => {
  let fallos = 0;
  for (const [nombre, fn] of casos) {
    try { await fn(); console.log('PASS ' + nombre); }
    catch (e) { fallos++; console.log('FAIL ' + nombre + '\n     ' + (e && e.message)); }
  }
  console.log(`\n${casos.length - fallos}/${casos.length} PASS`);
  if (fallos) process.exit(1);
})();
