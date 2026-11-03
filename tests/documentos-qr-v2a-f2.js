'use strict';

// tests/documentos-qr-v2a-f2.js
// Documentos V2A / F2: QR de autenticidad por versión archivada. (1) Secuencia reservar -> PDF con QR -> huella del PDF final -> archivado V1 -> vincular, con la
// bandera CARDIOLINK_QR_V2A; (2) reutilización sin duplicar QR ni PDF; (3) un fallo de vinculación NUNCA queda como documento verificable; (4) dibujo vectorial del QR.
// Ejecuta el código REAL (módulo de archivado y funciones de dibujo de app.js) con Supabase y la librería QR simulados (sin red).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'cardiolink-documentos-pdf-v1.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');


// Polyfills sólo para motores sin WebCrypto (p. ej. JavaScriptCore en esta máquina); en Node y en el navegador se usan los nativos.
const TE = typeof TextEncoder !== 'undefined' ? TextEncoder : class { encode(s) { const o = []; const u = unescape(encodeURIComponent(String(s))); for (let i = 0; i < u.length; i++) o.push(u.charCodeAt(i)); return new Uint8Array(o); } };
const b64 = typeof btoa === 'function' ? btoa : (str) => { const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'; let o = '', i = 0; for (; i + 2 < str.length; i += 3) { const n = (str.charCodeAt(i) << 16) | (str.charCodeAt(i + 1) << 8) | str.charCodeAt(i + 2); o += A[n >> 18] + A[(n >> 12) & 63] + A[(n >> 6) & 63] + A[n & 63]; } const r = str.length - i; if (r === 1) { const n = str.charCodeAt(i) << 16; o += A[n >> 18] + A[(n >> 12) & 63] + '=='; } else if (r === 2) { const n = (str.charCodeAt(i) << 16) | (str.charCodeAt(i + 1) << 8); o += A[n >> 18] + A[(n >> 12) & 63] + A[(n >> 6) & 63] + '='; } return o; };
function sha256Bytes(msg) {
  const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  let H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const len = msg.length, l = ((len + 9 + 63) >> 6) << 6, m = new Uint8Array(l); m.set(msg); m[len] = 0x80;
  const bits = len * 8; for (let i = 0; i < 4; i++) m[l - 1 - i] = (bits >>> (8 * i)) & 255; m[l - 5] = Math.floor(len / 0x20000000) & 255;
  const rotr = (x, n) => (x >>> n) | (x << (32 - n)), w = new Array(64);
  for (let o = 0; o < l; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = (m[o + 4 * i] << 24) | (m[o + 4 * i + 1] << 16) | (m[o + 4 * i + 2] << 8) | m[o + 4 * i + 3];
    for (let i = 16; i < 64; i++) { const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10); w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0; }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) { const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25), ch = (e & f) ^ (~e & g), t1 = (h + S1 + ch + K[i] + w[i]) | 0, S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22), mj = (a & b) ^ (a & c) ^ (b & c), t2 = (S0 + mj) | 0; h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0; }
    H = [(H[0] + a) | 0, (H[1] + b) | 0, (H[2] + c) | 0, (H[3] + d) | 0, (H[4] + e) | 0, (H[5] + f) | 0, (H[6] + g) | 0, (H[7] + h) | 0];
  }
  const out = new Uint8Array(32); H.forEach((x, i) => { out[4 * i] = x >>> 24; out[4 * i + 1] = (x >>> 16) & 255; out[4 * i + 2] = (x >>> 8) & 255; out[4 * i + 3] = x & 255; }); return out;
}
const CR = (typeof crypto !== 'undefined' && crypto.subtle) ? crypto : { getRandomValues(a) { for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256); return a; }, subtle: { async digest(_, d) { return sha256Bytes(d instanceof Uint8Array ? d : new Uint8Array(d)).buffer; } } };

const AHORA = Math.floor(Date.now() / 1000);
const sesion = { user: { id: 'u_med' }, expires_at: AHORA + 3600 };
const hex = async (bytes) => { const d = await CR.subtle.digest('SHA-256', bytes); return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join(''); };

function montar(cfg) {
  cfg = cfg || {};
  const L = { reservar: [], vincular: [], upload: [], remove: [], insert: [], deletes: [], pdf: [], from: [] };
  const rpcRes = cfg.rpc || {};
  const almacen = {};
  const consulta = (tabla) => {
    const q = { op: 'select', tabla };
    const c = {
      select() { return c; }, eq() { return c; }, order() { return c; }, limit() { return c; }, single() { return c; },
      insert(f) { q.op = 'insert'; L.insert.push(f); return c; },
      delete() { q.op = 'delete'; return c; },
      then(ok, ko) {
        let r;
        if (q.op === 'insert') r = { data: { id: 'row_nueva', created_at: '2026-10-29T00:00:00Z' }, error: null };
        else if (q.op === 'delete') { L.deletes.push(tabla); r = cfg.deleteDenegado ? { data: [], error: null } : { data: [{ id: 'row_nueva' }], error: null }; }
        else r = (L.nSel = (L.nSel || 0) + 1) === 1 ? { data: cfg.ultima ? [cfg.ultima] : [], error: null } : { data: [], error: null };
        return Promise.resolve(r).then(ok, ko);
      }
    };
    return c;
  };
  const cliente = {
    auth: {
      async getSession() { return { data: { session: sesion }, error: null }; },
      async refreshSession() { return { data: { session: sesion }, error: null }; },
      async getUser() { return { data: { user: { id: 'u_med' } }, error: null }; }
    },
    from(t) { L.from.push(t); return consulta(t); },
    storage: { from() { return { async upload(p) { L.upload.push(p); return { error: null }; }, async remove(p) { L.remove.push(p); return { error: null }; } }; } },
    async rpc(nombre, args) {
      if (nombre === 'cardiolink_verificacion_reservar_v1') { L.reservar.push(args); return cfg.reservarError ? { data: null, error: { message: 'boom reservar' } } : { data: 'ver_' + L.reservar.length, error: null }; }
      if (nombre === 'cardiolink_verificacion_vincular_v1') { L.vincular.push(args); return (cfg.vincularError || L.vincular.length <= (cfg.vincularFallaPrimeras || 0)) ? { data: null, error: { message: 'boom vincular' } } : { data: { ok: true }, error: null }; }
      return { data: null, error: { message: 'rpc desconocida' } };
    }
  };
  const win = {
    CARDIOLINK_QR_V2A: cfg.flag === true,
    crypto: CR,
    generarPdfDocumentoGenerado406: async (id, fmt, doc, opciones) => {
      L.pdf.push({ id, opciones });
      const bytes = new TE().encode('PDF-' + id + '-' + (opciones && opciones.qr ? opciones.qr.url : 'sin-qr'));
      return { ok: true, blob: { size: bytes.length, arrayBuffer: async () => bytes.buffer }, bytes, patientId: 'p1', documentDate: '2026-10-29', documentType: 'Certificado', title: 'Cert', description: '', professionalId: 'rogelio', originalFilename: 'c.pdf', sourceDocumentId: id, sourceContentHash: cfg.hashGen || 'h_nuevo', payload: { v: 2 } };
    }
  };
  if (cfg.hash !== undefined) win.hashContenidoDocumento406 = async () => { if (cfg.hash instanceof Error) throw cfg.hash; return cfg.hash; };
  const doc = { addEventListener() {}, getElementById() { return null; }, querySelectorAll() { return []; }, readyState: 'loading' };
  win.addEventListener = () => {};
  const ls = { getItem: k => (k in almacen ? almacen[k] : null), setItem: (k, v) => { almacen[k] = String(v); } };
  new Function('window', 'document', 'supabaseClient', 'usuarioSupabase', 'crypto', 'pacienteRealIdDeDocV1', 'localStorage', 'setTimeout', 'btoa', 'TextEncoder', source)(
    win, doc, cliente, { id: 'u_med' }, CR, () => 'p1', ls, f => { f(); return 0; }, b64, TE);
  return { archivar: win.archivarVersionDocumentoV1, L, almacen };
}
const docCert = { id: 'doc_c1', tipo: 'certificado' };
const ultimaIgual = { id: 'row_0', patient_id: 'p1', source_content_hash: 'h_igual', created_at: '2026-10-28T00:00:00Z', pv: '2' };

const casos = [];
function caso(n, f) { casos.push([n, f]); }
caso('SHA-256 (polyfill de prueba) coincide con vectores conocidos', async () => {
  assert.equal(await hex(new TE().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(await hex(new TE().encode('')), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

caso('bandera apagada (Production por defecto): archivado idéntico a V1, sin RPC de verificación ni QR', async () => {
  const m = montar({ flag: false, hash: 'h_nuevo' });
  const r = await m.archivar(docCert, {});
  assert.equal(r.ok, true); assert.equal(r.verificacion, undefined);
  assert.equal(m.L.reservar.length, 0); assert.equal(m.L.vincular.length, 0);
  assert.equal(m.L.pdf[0].opciones, undefined, 'el PDF se pide sin QR');
  assert.equal(m.L.upload.length, 1); assert.equal(m.L.insert.length, 1);
});
caso('bandera activa: reservar -> PDF con QR -> huella del PDF final -> archivado -> vincular', async () => {
  const m = montar({ flag: true, hash: 'h_nuevo' });
  const r = await m.archivar(docCert, {});
  assert.equal(r.ok, true); assert.equal(r.verificacion.estado, 'ok'); assert.equal(r.verificacion.id, 'ver_1');
  assert.equal(m.L.reservar.length, 1);
  const rs = m.L.reservar[0];
  assert.equal(rs.p_chain_id, 'doc_c1'); assert.equal(rs.p_kind, 'certificado'); assert.ok(/^[0-9a-f]{64}$/.test(rs.p_code_hash));
  const qr = m.L.pdf[0].opciones.qr;
  assert.ok(qr.url.indexOf('?c=') > 0 && qr.codigo.length >= 21, 'URL con código de 128 bits');
  assert.equal(rs.p_code_hash, await hex(new TE().encode(qr.codigo)), 'se reserva el HASH del código del QR (nunca el código)');
  assert.ok(qr.url.indexOf(rs.p_code_hash) < 0, 'el hash no viaja en la URL');
  assert.equal(m.L.vincular.length, 1);
  assert.equal(m.L.vincular[0].p_id, 'ver_1'); assert.equal(m.L.vincular[0].p_document_id, 'row_nueva');
  const bytes = new TE().encode('PDF-doc_c1-' + qr.url);
  assert.equal(m.L.vincular[0].p_pdf_sha256, await hex(bytes), 'la huella vinculada es la del PDF FINAL (con QR)');
  assert.equal(m.L.upload.length, 1); assert.equal(m.L.insert.length, 1);
  assert.equal(m.L.insert[0].source_content_hash, 'h_nuevo', 'la huella de contenido V1 no incluye el QR');
});
caso('orden de operaciones: nada se sube antes de reservar, y vincular es lo último', async () => {
  const m = montar({ flag: true, hash: 'h_nuevo' });
  const orden = [];
  const w = m.L; // espiar con proxies simples
  ['reservar', 'upload', 'insert', 'vincular'].forEach(k => { const a = w[k]; const push = a.push.bind(a); a.push = (x) => { orden.push(k); return push(x); }; });
  await m.archivar(docCert, {});
  assert.equal(orden.join('>'), 'reservar>upload>insert>vincular');
});
caso('tipos: reposo -> certificado, constancia, orden; receta y otros sin QR', async () => {
  for (const [tipo, kind] of [['reposo_laboral', 'certificado'], ['constancia_atencion', 'constancia'], ['orden', 'orden']]) {
    const m = montar({ flag: true, hash: 'h_' + tipo });
    const r = await m.archivar({ id: 'd_' + tipo, tipo }, {});
    assert.equal(r.ok, true, tipo); assert.equal(m.L.reservar[0].p_kind, kind, tipo);
  }
  for (const tipo of ['receta', 'apto_fisico', 'ecg', 'mensaje_colega']) {
    const m = montar({ flag: true, hash: 'h' });
    const r = await m.archivar({ id: 'd_' + tipo, tipo }, {});
    assert.equal(r.ok, true, tipo); assert.equal(m.L.reservar.length, 0, tipo + ' sin verificación'); assert.equal(r.verificacion, undefined);
  }
});
caso('reutilizar un documento sin cambios NO reserva, NO genera PDF, NO sube y NO duplica el QR', async () => {
  const m = montar({ flag: true, hash: 'h_igual', ultima: ultimaIgual });
  const r = await m.archivar(docCert, { baseArchivoId: 'row_0' });
  assert.equal(r.ok, true); assert.equal(r.reusado, true); assert.equal(r.rowId, 'row_0');
  assert.equal(m.L.reservar.length, 0); assert.equal(m.L.vincular.length, 0); assert.equal(m.L.pdf.length, 0);
  assert.equal(m.L.upload.length, 0); assert.equal(m.L.insert.length, 0);
});
caso('una edición es una versión NUEVA con código distinto', async () => {
  const a = montar({ flag: true, hash: 'h_v1' }); await a.archivar(docCert, {});
  const b = montar({ flag: true, hash: 'h_v2' }); await b.archivar(docCert, {});
  assert.ok(a.L.reservar[0].p_code_hash !== b.L.reservar[0].p_code_hash, 'cada versión usa un código aleatorio propio');
});
caso('doble clic / Guardar+Enviar simultáneos: una sola reserva y un solo archivo', async () => {
  const m = montar({ flag: true, hash: 'h_nuevo' });
  const [a, b] = await Promise.all([m.archivar(docCert, {}), m.archivar(docCert, {})]);
  assert.equal(a.ok, true); assert.equal(b.ok, true);
  assert.equal(m.L.reservar.length, 1); assert.equal(m.L.upload.length, 1); assert.equal(m.L.vincular.length, 1);
});
caso('FALLA vincular (3 reintentos): el documento NO queda guardado ni verificable; se deshace fila y PDF', async () => {
  const m = montar({ flag: true, hash: 'h_nuevo', vincularError: true });
  const r = await m.archivar(docCert, {});
  assert.equal(r.ok, false); assert.equal(r.verificacionFallida, true); assert.ok(r.rowId === undefined && r.verificacion === undefined);
  assert.equal(m.L.vincular.length, 3, 'reintenta 3 veces');
  assert.equal(m.L.deletes.length, 1, 'borra la fila recién archivada');
  assert.equal(m.L.remove.length, 1, 'borra el PDF archivado');
  assert.ok(/No se pudo verificar el documento/.test(r.error) && /No se guardó/.test(r.error), r.error);
  assert.equal(Object.keys(m.almacen).length, 0, 'no hace falta marcar la fila: se pudo deshacer');
});
caso('FALLA vincular y la fila NO se puede borrar (p. ej. Secretaría): queda marcada y no se reutiliza como verificable', async () => {
  const m = montar({ flag: true, hash: 'h_nuevo', vincularError: true, deleteDenegado: true });
  const r = await m.archivar(docCert, {});
  assert.equal(r.ok, false); assert.equal(r.verificacionFallida, true);
  assert.ok(/NO es verificable/.test(r.error), r.error);
  assert.ok(JSON.parse(m.almacen['cardiolink_qr_fallidos_v1']).includes('row_nueva'));
  // próximo intento: la fila marcada se ignora (aunque la huella coincida) y se emite una versión nueva con código nuevo
  const m2 = montar({ flag: true, hash: 'h_igual', ultima: Object.assign({}, ultimaIgual, { id: 'row_nueva' }) });
  m2.almacen['cardiolink_qr_fallidos_v1'] = JSON.stringify(['row_nueva']);
  const r2 = await m2.archivar(docCert, { baseArchivoId: 'otra' });
  assert.equal(r2.ok, true); assert.equal(r2.reusado, false); assert.equal(m2.L.reservar.length, 1, 'reserva un código nuevo');
});
caso('vincular falla una vez y funciona al reintentar: guardado verificable (sin deshacer nada)', async () => {
  const m = montar({ flag: true, hash: 'h_nuevo', vincularFallaPrimeras: 1 });
  const r = await m.archivar(docCert, {});
  assert.equal(r.ok, true); assert.equal(r.verificacion.estado, 'ok');
  assert.equal(m.L.vincular.length, 2); assert.equal(m.L.deletes.length, 0); assert.equal(m.L.remove.length, 0);
});
caso('FALLA reservar: no se genera PDF, no se sube nada, error claro', async () => {
  const m = montar({ flag: true, hash: 'h_nuevo', reservarError: true });
  const r = await m.archivar(docCert, {});
  assert.equal(r.ok, false); assert.ok(/No se pudo reservar la verificación/.test(r.error) && /No se guardó nada/.test(r.error), r.error);
  assert.equal(m.L.pdf.length, 0); assert.equal(m.L.upload.length, 0); assert.equal(m.L.insert.length, 0);
});
caso('conflicto de edición se decide ANTES de reservar (no consume un código)', async () => {
  const m = montar({ flag: true, hash: 'h_distinto', ultima: ultimaIgual });
  const r = await m.archivar(docCert, { baseArchivoId: 'otra_version' });
  assert.equal(r.ok, false); assert.equal(r.conflicto, true);
  assert.equal(m.L.reservar.length, 0); assert.equal(m.L.pdf.length, 0);
});
caso('bandera activa sin huella de contenido disponible: falla cerrada (no se emite un documento sin QR por error)', async () => {
  const m = montar({ flag: true });   // sin hashContenidoDocumento406
  const r = await m.archivar(docCert, {});
  assert.equal(r.ok, false); assert.equal(m.L.reservar.length, 0); assert.equal(m.L.upload.length, 0);
});

// ---------- dibujo del QR en el PDF (app.js) ----------
function tramo(desde, hasta) { const i = app.indexOf(desde), j = app.indexOf(hasta, i + 1); assert.ok(i >= 0 && j > i, desde); return app.slice(i, j); }
function qrFalso(n) { return () => ({ addData() {}, make() {}, getModuleCount: () => n, isDark: (r, c) => (r + c) % 2 === 0 }); }
const dibujo = (qr) => new Function('qrcode', tramo('function matrizQr406', 'async function generarPdfBlobDocumento406') + '\nreturn {dibujarQrPdf406,matrizQr406};')(qr);

caso('dibujo vectorial: zona de silencio de 4 módulos, módulos dentro del área y fondo blanco', () => {
  const n = 33, tam = 24, x0 = 9, y0 = 150, rects = [], fills = [];
  const pdf = { setFillColor(...a) { fills.push(a.join(',')); }, rect(x, y, w, h, st) { rects.push({ x, y, w, h, st }); } };
  const ok = dibujo(qrFalso(n)).dibujarQrPdf406(pdf, 'https://x/y?c=abc', x0, y0, tam);
  assert.equal(ok, true);
  assert.equal(rects[0].w, tam); assert.equal(rects[0].h, tam); assert.equal(fills[0], '255,255,255', 'fondo blanco');
  const modulos = rects.slice(1), cell = tam / (n + 8);
  let oscuros = 0; for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if ((r + c) % 2 === 0) oscuros++;
  assert.equal(modulos.length, oscuros);
  const minX = Math.min(...modulos.map(m => m.x)), maxX = Math.max(...modulos.map(m => m.x + m.w)), minY = Math.min(...modulos.map(m => m.y));
  assert.ok(Math.abs(minX - (x0 + 4 * cell)) < 1e-9, 'margen izquierdo = 4 módulos');
  assert.ok(maxX <= x0 + tam - 4 * cell + 0.03, 'margen derecho = 4 módulos');
  assert.ok(Math.abs(minY - (y0 + 4 * cell)) < 1e-9);
  assert.ok(cell > 0.4, 'módulo de al menos 0,4 mm (legible con celular): ' + cell.toFixed(3));
  assert.equal(fills[1], '0,0,0');
});
caso('legibilidad: tamaños A5 (24 mm) y A4 (28 mm) con una URL típica caben en módulos >= 0,45 mm', () => {
  // QR versión 4 (33 módulos) es lo que genera una URL de ~75 caracteres con corrección M
  for (const [tam, nombre] of [[24, 'A5'], [28, 'A4']]) { const cell = tam / (33 + 8); assert.ok(cell >= 0.45, nombre + ' ' + cell.toFixed(3)); }
});
caso('sin librería QR: el dibujo devuelve false y el generador falla cerrado (no emite un PDF "verificable" sin QR)', () => {
  assert.equal(dibujo(undefined).dibujarQrPdf406({ setFillColor() {}, rect() {} }, 'x', 0, 0, 24), false);
  assert.ok(/if\(!dibujarQrPdf406\(pdf,datos406\.qr\.url,qx,qy,tam\)\)throw new Error/.test(app));
});
caso('estático: QR sólo si el archivado lo pide; no se toca la firma; librería fija con SRI; bandera apagada por defecto', () => {
  assert.ok(app.includes("if(datos406.qr&&datos406.qr.url){"));
  assert.ok(/qrcode-generator@1\.4\.4\/qrcode\.min\.js" integrity="sha384-[A-Za-z0-9+\/=]+" crossorigin="anonymous"/.test(indexHtml), 'versión fija + SRI');
  assert.ok(source.includes('window.CARDIOLINK_QR_V2A===true'), 'bandera estricta');
  assert.ok(!/CARDIOLINK_QR_V2A\s*=\s*true/.test(source + app + indexHtml), 'nadie la activa por defecto');
  // la firma y su caja siguen exactamente como en V1 (corrección de proporción ya aprobada)
  assert.ok(app.includes("cajaImagenPdf406(pdf,sigData,bw,bh)") && app.includes("pdf.line(sigX,sigY,sigX+sigW,sigY)"));
});

(async () => {
  let fallos = 0;
  for (const [n, f] of casos) {
    try { await f(); console.log('PASS ' + n); } catch (e) { fallos++; console.log('FAIL ' + n + '\n     ' + (e && e.message)); }
  }
  console.log(`\n${casos.length - fallos}/${casos.length} PASS`);
  if (fallos) process.exit(1);
})();
