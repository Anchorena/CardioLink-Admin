'use strict';

// tests/documentos-guardar-imprimir-enviar-v1.js
// Bloque 3 (Documentos V1): Guardar / Imprimir / Enviar separados.
//  - Reutilización del PDF archivado sin regenerar ni subir cuando el contenido no cambió.
//  - Envío: controles de sesión (PR #11), un canal fallido nunca figura como enviado y WhatsApp nunca se muestra como éxito confirmado.
// Ejecuta el módulo REAL (cardiolink-documentos-pdf-v1.js) contra un cliente Supabase y un DOM mínimos simulados (sin red); la parte de app.js es estática.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'cardiolink-documentos-pdf-v1.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

const AHORA = Math.floor(Date.now() / 1000);
const sesionValida = { user: { id: 'u_vivo' }, expires_at: AHORA + 3600 };
const docCert = { id: 'doc_cert_1', tipo: 'certificado' };

function montar(cfg) {
  const llamadas = { from: [], upload: [], insert: [], generarPdf: 0, invoke: [], hash: 0 };
  const respuestas = Object.assign({ ultima: { data: [], error: null }, insert: { data: { id: 'row_nueva', created_at: '2026-10-27T00:00:00Z' }, error: null } }, cfg.respuestas || {});
  function consulta() {
    const q = { op: 'select' };
    const c = {
      select() { return c; }, eq() { return c; }, order() { return c; }, limit() { return c; }, single() { return c; },
      insert(f) { q.op = 'insert'; llamadas.insert.push(f); return c; },
      then(ok, ko) { return Promise.resolve(q.op === 'insert' ? respuestas.insert : (q.n = (llamadas.nSel = (llamadas.nSel || 0) + 1), q.n === 1 ? respuestas.ultima : { data: [], error: null })).then(ok, ko); }
    };
    return c;
  }
  const cliente = {
    auth: {
      async getSession() { return { data: { session: cfg.sesion === undefined ? sesionValida : cfg.sesion }, error: null }; },
      async refreshSession() { return { data: { session: null }, error: { message: 'x' } }; },
      async getUser() { return { data: { user: { id: 'u_getuser' } }, error: null }; }
    },
    from(t) { llamadas.from.push(t); return consulta(); },
    storage: { from() { return { async upload(p) { llamadas.upload.push(p); return { error: null }; }, async remove() { return { error: null }; } }; } },
    functions: { async invoke(nombre, opts) { llamadas.invoke.push(opts.body.action); const r = (cfg.invoke || {})[opts.body.action]; return { data: r || { ok: true }, error: null }; } }
  };
  const ventanas = [];
  const win = {
    addEventListener() {},
    crypto: { randomUUID: () => '11111111-1111-4111-8111-111111111111' },
    open() { if (cfg.popupBloqueado) return null; const w = { closed: false, location: { href: '' }, close() { this.closed = true; } }; ventanas.push(w); return w; },
    generarPdfDocumentoGenerado406: async (id) => {
      llamadas.generarPdf++;
      return { ok: true, blob: { size: 10 }, patientId: 'p1', documentDate: '2026-10-27', documentType: 'Certificado', title: 'Cert', description: '', professionalId: 'rogelio', originalFilename: 'c.pdf', sourceDocumentId: id, sourceContentHash: 'h_nuevo', payload: { v: 2 } };
    }
  };
  if (cfg.hash !== undefined) win.hashContenidoDocumento406 = async () => { llamadas.hash++; if (cfg.hash instanceof Error) throw cfg.hash; return cfg.hash; };

  // DOM mínimo para el modal de envío
  const estado = { innerHTML: '', insertAdjacentHTML(_, h) { this.innerHTML += h; } };
  const btn = { dataset: { pdfDocumentV1: 'row_1' }, disabled: false, textContent: 'Enviar' };
  const listeners = { click: [] };
  const doc = {
    readyState: 'loading',
    addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
    getElementById(id) { return id === 'pdfEnviarConfirmarBtnV1' ? btn : null; },
    querySelector(sel) { if (/pdfEnviarCanalV1/.test(sel)) return cfg.canal ? { value: cfg.canal } : null; if (/data-pdf-enviar-estado-v1/.test(sel)) return estado; return null; },
    querySelectorAll() { return []; }
  };
  const usuario = { id: 'u_memoria' };
  const real = cfg.pacienteReal === undefined ? 'p1' : cfg.pacienteReal;
  new Function('window', 'document', 'supabaseClient', 'usuarioSupabase', 'crypto', 'pacienteRealIdDeDocV1', source)(win, doc, cliente, usuario, win.crypto, () => real);

  async function pulsarEnviar() {
    const ev = { target: { id: 'pdfEnviarConfirmarBtnV1', closest() { return null; }, dataset: {} }, preventDefault() {}, stopPropagation() {} };
    listeners.click.forEach(f => { try { f(ev); } catch (e) { /* otros listeners de la página */ } });
    for (let i = 0; i < 300; i++) await null;
  }
  return { archivar: win.archivarVersionDocumentoV1, llamadas, estado, btn, ventanas, pulsarEnviar };
}

const casos = [];
function caso(n, f) { casos.push([n, f]); }

// ---------- reutilización sin regenerar ----------
const filaIgual = { data: [{ id: 'row_0', patient_id: 'p1', source_content_hash: 'h_igual', created_at: '2026-10-26T00:00:00Z', pv: '2' }], error: null };

caso('misma huella y mismo paciente: reutiliza la versión archivada SIN generar el PDF ni subir ni insertar', async () => {
  const m = montar({ respuestas: { ultima: filaIgual }, hash: 'h_igual' });
  const r = await m.archivar(docCert, { baseArchivoId: 'row_0' });
  assert.equal(r.ok, true); assert.equal(r.reusado, true); assert.equal(r.rowId, 'row_0'); assert.equal(r.patientId, 'p1');
  assert.equal(m.llamadas.hash, 1);
  assert.equal(m.llamadas.generarPdf, 0, 'no regenera el PDF');
  assert.equal(m.llamadas.upload.length, 0, 'no sube otro archivo');
  assert.equal(m.llamadas.insert.length, 0, 'no inserta otra fila');
});
caso('contenido distinto: sigue el camino completo (genera, sube, inserta una versión nueva)', async () => {
  const m = montar({ respuestas: { ultima: filaIgual }, hash: 'h_otro' });
  const r = await m.archivar(docCert, { baseArchivoId: 'row_0' });
  assert.equal(r.ok, true); assert.equal(r.reusado, false);
  assert.equal(m.llamadas.generarPdf, 1); assert.equal(m.llamadas.upload.length, 1); assert.equal(m.llamadas.insert.length, 1);
});
caso('misma huella pero la fila es de OTRO paciente: no se reutiliza en silencio', async () => {
  const m = montar({ respuestas: { ultima: filaIgual }, hash: 'h_igual', pacienteReal: 'p_otro' });
  const r = await m.archivar(docCert, { baseArchivoId: 'row_0' });
  assert.equal(m.llamadas.generarPdf, 1, 'cae al camino completo');
  assert.ok(!(r.ok && r.reusado && m.llamadas.generarPdf === 0));
});
caso('si el cálculo de la huella falla: camino completo de siempre', async () => {
  const m = montar({ respuestas: { ultima: filaIgual }, hash: new Error('boom') });
  const r = await m.archivar(docCert, { baseArchivoId: 'row_0' });
  assert.equal(m.llamadas.generarPdf, 1);
  assert.equal(r.ok, true);
});
caso('sin versión archivada previa: archiva una vez (un solo PDF y una sola fila)', async () => {
  const m = montar({ hash: 'h_x' });
  const r = await m.archivar(docCert, {});
  assert.equal(r.ok, true); assert.equal(m.llamadas.upload.length, 1); assert.equal(m.llamadas.insert.length, 1);
});
caso('doble clic (Guardar + Enviar a la vez): una sola operación, sin duplicar', async () => {
  const m = montar({ hash: 'h_x' });
  const [a, b] = await Promise.all([m.archivar(docCert, {}), m.archivar(docCert, {})]);
  assert.equal(a.ok, true); assert.equal(b.ok, true);
  assert.equal(m.llamadas.upload.length, 1); assert.equal(m.llamadas.insert.length, 1);
});

// ---------- envío ----------
caso('envío con la sesión vencida: no invoca la función, no deja ventana de WhatsApp y avisa', async () => {
  const m = montar({ sesion: null, canal: 'ambos' });
  await m.pulsarEnviar();
  assert.equal(m.llamadas.invoke.length, 0, 'no llama a patient-document-delivery');
  assert.ok(m.ventanas.every(w => w.closed), 'la ventana en blanco se cierra');
  assert.ok(/Tu sesión venció\. Volvé a iniciar sesión/.test(m.estado.innerHTML) && /No se envió nada/.test(m.estado.innerHTML), m.estado.innerHTML);
  assert.equal(m.btn.disabled, false);
});
caso('email OK: una sola invocación y mensaje de email enviado', async () => {
  const m = montar({ canal: 'email', invoke: { 'send-email': { ok: true, enviado: true, adjuntoReal: true } } });
  await m.pulsarEnviar();
  assert.equal(JSON.stringify(m.llamadas.invoke), JSON.stringify(['send-email']));
  assert.ok(/Email ✓/.test(m.estado.innerHTML), m.estado.innerHTML);
});
caso('email fallido: se informa el fallo y NO figura como enviado', async () => {
  const m = montar({ canal: 'email', invoke: { 'send-email': { ok: false, error: 'proveedor caído' } } });
  await m.pulsarEnviar();
  assert.ok(/Email: no se pudo enviar/.test(m.estado.innerHTML), m.estado.innerHTML);
  assert.ok(!/Email ✓/.test(m.estado.innerHTML) && !/enviado por email/.test(m.estado.innerHTML));
});
caso('WhatsApp preparado con ventana abierta: se abre wa.me pero NO se muestra éxito confirmado', async () => {
  const m = montar({ canal: 'whatsapp', invoke: { 'prepare-whatsapp': { ok: true, telefono: '5491100000000', mensaje: 'hola' } } });
  await m.pulsarEnviar();
  assert.equal(JSON.stringify(m.llamadas.invoke), JSON.stringify(['prepare-whatsapp']));
  assert.ok(/^https:\/\/wa\.me\/5491100000000\?text=/.test(m.ventanas[0].location.href));
  assert.ok(/Falta pulsar Enviar en WhatsApp/.test(m.estado.innerHTML) && /no puede confirmar la entrega/.test(m.estado.innerHTML), m.estado.innerHTML);
  assert.ok(!/✓/.test(m.estado.innerHTML), 'sin tilde de éxito');
});
caso('WhatsApp con ventana bloqueada: no dice que se abrió y ofrece el enlace', async () => {
  const m = montar({ canal: 'whatsapp', popupBloqueado: true, invoke: { 'prepare-whatsapp': { ok: true, telefono: '5491100000000', mensaje: 'hola' } } });
  await m.pulsarEnviar();
  assert.ok(/no abrió la ventana/.test(m.estado.innerHTML) && /href="https:\/\/wa\.me\/5491100000000\?text=/.test(m.estado.innerHTML), m.estado.innerHTML);
  assert.ok(!/WhatsApp abierto/.test(m.estado.innerHTML) && !/✓/.test(m.estado.innerHTML));
});
caso('WhatsApp fallido: error visible, ventana cerrada, sin éxito', async () => {
  const m = montar({ canal: 'whatsapp', invoke: { 'prepare-whatsapp': { ok: false, error: 'sin teléfono' } } });
  await m.pulsarEnviar();
  assert.ok(/No se pudo preparar WhatsApp/.test(m.estado.innerHTML));
  assert.ok(m.ventanas.every(w => w.closed));
  assert.ok(!/✓/.test(m.estado.innerHTML));
});
caso('ambos canales: cada uno una vez y el fallo de uno no oculta ni inventa el otro', async () => {
  const m = montar({ canal: 'ambos', invoke: { 'send-email': { ok: false, error: 'rebotó' }, 'prepare-whatsapp': { ok: true, telefono: '5491100000000', mensaje: 'hola' } } });
  await m.pulsarEnviar();
  assert.equal(JSON.stringify(m.llamadas.invoke), JSON.stringify(['send-email', 'prepare-whatsapp']));
  assert.ok(/Email: no se pudo enviar/.test(m.estado.innerHTML) && /Falta pulsar Enviar en WhatsApp/.test(m.estado.innerHTML));
  assert.ok(!/Email ✓/.test(m.estado.innerHTML));
});

// ---------- app.js (estático) ----------
caso('formulario: Guardar no imprime ni envía; Imprimir y Enviar guardan primero', () => {
  assert.ok(app.includes('id="saveDoc406">Guardar</button><button class="secondary" type="button" id="savePrintDoc406">Imprimir</button><button class="primary" type="button" id="saveSendDoc406"'));
  assert.ok(app.includes("$406('saveDoc406').onclick=()=>saveDocument406(p,existing,false);"));
  assert.ok(app.includes("$406('saveSendDoc406').onclick=()=>saveDocument406(p,existing,false,undefined,true);"));
  assert.ok(app.includes("btns=[$406('saveDoc406'),$406('savePrintDoc406'),$406('saveSendDoc406')]"));
  const i = app.indexOf('if(printAfter)printDocument406(candidato.id,formatoImpresion);');
  const j = app.indexOf('else if(esTipoCompacto406(candidato.tipo))abrirModalPostGuardadoDoc406(candidato.id);', i);
  assert.ok(i > 0 && j > i, 'la impresión/envío ocurre después de confirmar el guardado y sólo una de las tres vías');
  assert.ok(app.indexOf('persist406();', app.indexOf('Servidor confirmado')) < i, 'el servidor confirma antes de imprimir/enviar');
});
caso('modal posterior sin "Guardar PDF" redundante; descarga desde el historial intacta', () => {
  const i = app.indexOf("modal.id='docPostSaveModal406'");
  const cuerpo = app.slice(i, app.indexOf('document.body.appendChild(modal);', i));
  assert.ok(/data-postsave-imprimir406/.test(cuerpo) && /data-postsave-enviar406/.test(cuerpo));
  assert.ok(!/Guardar PDF|guardarpdf/i.test(cuerpo));
  assert.ok(source.includes('data-pdf-descargar-v1'), 'el botón Descargar del historial sigue existiendo');
});

(async () => {
  let fallos = 0;
  for (const [n, f] of casos) {
    try { await f(); console.log('PASS ' + n); } catch (e) { fallos++; console.log('FAIL ' + n + '\n     ' + (e && e.message)); }
  }
  console.log(`\n${casos.length - fallos}/${casos.length} PASS`);
  if (fallos) process.exit(1);
})();
