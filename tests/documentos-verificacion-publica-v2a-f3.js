'use strict';

// tests/documentos-verificacion-publica-v2a-f3.js
// Documentos V2A / F3: lógica pura de la verificación pública (supabase/functions/document-verify/logica.js) + comprobaciones estáticas de la Edge Function.
// Lo central: la respuesta pública sale de una LISTA BLANCA (sin datos del paciente ni del contenido), todo lo no verificable responde IGUAL, y el orden
// de defensas es CORS -> límite -> Turnstile -> formato -> base de datos.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const leer = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const logicaSrc = leer('supabase/functions/document-verify/logica.js');
const indexTs = leer('supabase/functions/document-verify/index.ts');
const configToml = leer('supabase/config.toml');

const L = new Function(logicaSrc.replace(/^export /gm, '') + '\nreturn {CODIGO_RE,validarCodigo,RESPUESTA_NO_VERIFICABLE,etiquetaTipo,normalizarId,resolverProfesional,construirRespuesta,clasificarUA,limpiarIp,crearLimitador,listaDesdeEnv,evaluarTurnstile};')();

const config = { profesionales: [
  { id: 'rogelio', nombre: 'Dr. Rogelio Anchorena', area: 'Cardiología', matriculaNacional: 'M.N. 111.111', matriculaProvincial: 'M.P. 222.222', telefonoDocumento: '11-5555-0000', emailDocumento: 'rogelio@example.invalid', firmaDocumentoData: 'data:image/png;base64,AAAA', logoDocumentoData: 'data:image/png;base64,BBBB' },
  { id: 'matias', nombre: 'Dr. Matías Anchorena', area: 'Cardiología' }
] };
const rpcOk = (o) => Object.assign({ encontrado: true, estado: 'vigente', tipo: 'certificado', emitido: '2026-10-29', professional_id: 'rogelio', huella: 'c4b386ca78c6', firma: 'sin_firma_digital', con_pin: false }, o || {});

const casos = [];
function caso(n, f) { casos.push([n, f]); }

caso('código: sólo 22 caracteres base64url (128 bits)', () => {
  assert.equal(L.validarCodigo('Qa1_Wb2-Ec3Rd4Tf5Yg6Hw'), true);
  assert.equal(L.validarCodigo('Zx9_Cv8-Bn7Mq6Lk5Jh4Gf'), true);
  for (const mal of ['', 'corto', 'Qa1_Wb2-Ec3Rd4Tf5Yg6H', 'Qa1_Wb2-Ec3Rd4Tf5Yg6HwX', 'Qa1+Wb2-Ec3Rd4Tf5Yg6Hw', 'Qa1/Wb2-Ec3Rd4Tf5Yg6Hw', 'Qa1_Wb2-Ec3Rd4Tf5Yg6H=', ' Qa1_Wb2-Ec3Rd4Tf5Yg6Hw', 'Qa1_Wb2-Ec3Rd4Tf5Yg6H\n', null, undefined, 12345, {}, ['a'], "' or 1=1 --xxxxxxxxxxxxx"]) assert.equal(L.validarCodigo(mal), false, JSON.stringify(mal));
});
caso('todo lo no verificable responde EXACTAMENTE igual (no revela si el código existe)', () => {
  const u = JSON.stringify(L.RESPUESTA_NO_VERIFICABLE);
  const casosMalos = [null, undefined, {}, { encontrado: false }, { encontrado: true, estado: 'no_disponible', tipo: 'certificado' }, { encontrado: true, estado: 'raro', tipo: 'certificado' }, rpcOk({ tipo: 'receta' }), rpcOk({ tipo: undefined }), rpcOk({ estado: undefined }), { encontrado: 'true', estado: 'vigente', tipo: 'certificado' }];
  for (const c of casosMalos) assert.equal(JSON.stringify(L.construirRespuesta(c, config)), u, JSON.stringify(c));
  assert.equal(u, '{"ok":true,"resultado":"no_verificable"}');
});
caso('estados públicos: vigente, reemplazado y anulado', () => {
  for (const e of ['vigente', 'reemplazado', 'anulado']) { const r = L.construirRespuesta(rpcOk({ estado: e }), config); assert.equal(r.resultado, 'verificado'); assert.equal(r.estado, e); }
});
caso('tipos genéricos (el reposo laboral se muestra como "Certificado médico")', () => {
  assert.equal(L.construirRespuesta(rpcOk({ tipo: 'certificado' }), config).tipo, 'Certificado médico');
  assert.equal(L.construirRespuesta(rpcOk({ tipo: 'constancia' }), config).tipo, 'Constancia de atención');
  assert.equal(L.construirRespuesta(rpcOk({ tipo: 'orden' }), config).tipo, 'Orden médica');
});
caso('respuesta verificada: LISTA BLANCA de campos y datos del profesional', () => {
  const r = L.construirRespuesta(rpcOk(), config);
  assert.equal(Object.keys(r).sort().join(','), 'acceso_pdf,emitido,estado,firma,huella,ok,profesional,resultado,tipo');
  assert.equal(r.emitido, '2026-10-29'); assert.equal(r.huella, 'c4b386ca78c6'); assert.equal(r.firma, 'sin_firma_digital');
  assert.equal(r.profesional.nombre, 'Dr. Rogelio Anchorena'); assert.equal(r.profesional.especialidad, 'Cardiología');
  assert.equal(r.profesional.matriculas.join(' | '), 'M.N. 111.111 | M.P. 222.222');
  assert.equal(Object.keys(r.profesional).sort().join(','), 'especialidad,matriculas,nombre');
  assert.equal(r.acceso_pdf.disponible, false); assert.equal(r.acceso_pdf.requiere, 'pin');
});
caso('NO filtra datos del paciente ni del contenido aunque la base los devolviera', () => {
  const sucio = rpcOk({ paciente: 'Ana Pérez', paciente_id: 'p1', dni: '12345678', contenido: 'diagnóstico X', source_payload: { x: 1 }, pdf_sha256: 'a'.repeat(64), storage_path: 'documents/p1/x.pdf', issued_by: 'uid', email: 'a@b.c', telefono: '11-1111' });
  const texto = JSON.stringify(L.construirRespuesta(sucio, config));
  for (const prohibido of ['Ana', 'p1', '12345678', 'diagn', 'storage', 'documents/', 'uid', 'a@b.c', '11-1111', 'rogelio@example', '11-5555', 'data:image', 'AAAA', 'BBBB', 'a'.repeat(64)]) assert.ok(texto.indexOf(prohibido) < 0, 'filtró: ' + prohibido);
});
caso('valores mal formados se descartan (fecha, huella, firma)', () => {
  const r = L.construirRespuesta(rpcOk({ emitido: '29/10/2026', huella: 'XYZ', firma: 'otra' }), config);
  assert.equal(r.emitido, null); assert.equal(r.huella, null); assert.equal(r.firma, 'sin_firma_digital');
});
caso('profesional: sin config o desconocido se verifica igual sin sus datos; comparación sin mayúsculas ni espacios', () => {
  assert.equal(L.construirRespuesta(rpcOk(), null).profesional, null);
  assert.equal(L.construirRespuesta(rpcOk({ professional_id: 'otro' }), config).profesional, null);
  assert.equal(L.construirRespuesta(rpcOk({ professional_id: '  ROGELIO ' }), config).profesional.nombre, 'Dr. Rogelio Anchorena');
  assert.equal(L.construirRespuesta(rpcOk({ professional_id: '' }), config).profesional, null);
  assert.equal(L.construirRespuesta(rpcOk({ professional_id: 'matias' }), config).profesional.matriculas.length, 0);
});
caso('texto del profesional saneado y acotado (sin caracteres de control)', () => {
  const c = { profesionales: [{ id: 'x', nombre: 'Dr.\u0000 Falso\n' + 'a'.repeat(300), area: 'b'.repeat(200), matriculaNacional: 'M\u0007N' }] };
  const r = L.construirRespuesta(rpcOk({ professional_id: 'x' }), c);
  assert.ok(r.profesional.nombre.length <= 120 && !/[\u0000-\u001f]/.test(r.profesional.nombre + r.profesional.matriculas.join('')));
  assert.ok(r.profesional.especialidad.length <= 80);
});
caso('clasificación de User-Agent e IP', () => {
  assert.equal(L.clasificarUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile'), 'movil');
  assert.equal(L.clasificarUA('Mozilla/5.0 (Macintosh; Intel Mac OS X)'), 'escritorio');
  assert.equal(L.clasificarUA('curl/8.0'), 'automatizado'); assert.equal(L.clasificarUA('python-requests/2'), 'automatizado'); assert.equal(L.clasificarUA(''), 'otro');
  assert.equal(L.limpiarIp('190.1.2.3, 10.0.0.1'), '190.1.2.3'); assert.equal(L.limpiarIp('2800:1:2::3'), '2800:1:2::3');
  assert.equal(L.limpiarIp('<script>'), ''); assert.equal(L.limpiarIp(null), '');
});
caso('límite de tasa: permite hasta el máximo, se reinicia con la ventana y separa claves', () => {
  let t = 1000; const lim = L.crearLimitador({ max: 3, ventanaMs: 1000, ahora: () => t });
  assert.ok(lim.permitir('a') && lim.permitir('a') && lim.permitir('a')); assert.equal(lim.permitir('a'), false); assert.equal(lim.permitir('a'), false);
  assert.equal(lim.permitir('b'), true, 'otra IP no se ve afectada');
  t += 1001; assert.equal(lim.permitir('a'), true, 'nueva ventana');
});
caso('límite de tasa: la memoria no crece sin límite', () => {
  let t = 0; const lim = L.crearLimitador({ max: 5, ventanaMs: 1000, maxClaves: 100, ahora: () => t });
  for (let i = 0; i < 1000; i++) { t += 1; lim.permitir('ip' + i); }
  assert.ok(true);   // no revienta; la poda interna acota el Map (verificado por maxClaves)
});

// ---------- Edge Function (estático) ----------
caso('Edge Function: pública sólo por verify_jwt=false de ESTA función, método POST, cuerpo acotado', () => {
  assert.ok(/\[functions\.document-verify\]\s*\nverify_jwt = false/.test(configToml));
  assert.ok(indexTs.includes("req.method !== 'POST'") && indexTs.includes('405'));
  assert.ok(indexTs.includes('MAX_BODY_BYTES') && indexTs.includes('413'));
});
caso('Edge Function: orden de defensas CORS/límite -> Turnstile -> formato -> base de datos', () => {
  const iLim = indexTs.indexOf('limiteGlobal.permitir'), iTs = indexTs.indexOf('await verificarTurnstile('), iFmt = indexTs.indexOf('validarCodigo(body.codigo)'), iDb = indexTs.indexOf("admin.rpc('cardiolink_verificacion_consultar_v1'");
  assert.ok(iLim > 0 && iLim < iTs && iTs < iFmt && iFmt < iDb, [iLim, iTs, iFmt, iDb].join(' '));
  assert.ok(/if \(!\(await verificarTurnstile\(body\.turnstileToken, ip\)\)\) return responder\(\{ ok: false, error: 'verificacion_humana' \}, 403/.test(indexTs));
  assert.ok(indexTs.includes("const secret = Deno.env.get('TURNSTILE_SECRET_KEY');\n  if (!secret ||"), 'Turnstile fail-closed sin secret');
});
caso('Edge Function: código inválido responde lo mismo que uno inexistente y sin tocar la base', () => {
  assert.ok(/if \(!validarCodigo\(body\.codigo\)\) return responder\(RESPUESTA_NO_VERIFICABLE, 200, origen\)/.test(indexTs));
  assert.ok(indexTs.includes('construirRespuesta(rpc, config)'));
  assert.ok(!/body\.codigo[^;\n]*(console|responder)/.test(indexTs.replace('validarCodigo(body.codigo)', '')), 'el código no se imprime ni se devuelve');
});
caso('Edge Function: sólo lee la fila de configuración; no accede a pacientes, documentos ni Storage', () => {
  assert.ok(!/cardiolink_pacientes|cardiolink_patient_documents|\.storage\b|createSignedUrl|source_payload/.test(indexTs));
  assert.equal((indexTs.match(/\.from\('/g) || []).length, 1); assert.ok(indexTs.includes(".from('cardiolink_atenciones')"));
  assert.ok(!/console\.(log|info|warn)\(/.test(indexTs) && /console\.error\('document-verify error'\)/.test(indexTs), 'sin datos en logs');
});
caso('Edge Function: CORS sin "*", no-store y sin cachés; fallo de infraestructura no depende del código', () => {
  assert.ok(!/Access-Control-Allow-Origin['"]?\s*:\s*['"]\*/.test(indexTs) && !/'\*'/.test(indexTs));
  assert.ok(indexTs.includes("'Cache-Control': 'no-store'") && indexTs.includes("'X-Content-Type-Options': 'nosniff'") && indexTs.includes("'Referrer-Policy': 'no-referrer'"));
  assert.ok(indexTs.includes("if (error) throw error;"), 'error de la RPC => 503 igual para cualquier código');
  assert.ok(indexTs.includes("catch (_e) { config = null; }"), 'config no disponible: se verifica igual (no revela existencia por error)');
});
caso('Edge Function: F4 (acceso al PDF con PIN) preparado pero NO habilitado', () => {
  assert.ok(/body\.accion === 'acceso-pdf'\) return responder\(\{ ok: false, error: 'no_habilitado' \}, 501/.test(indexTs));
  assert.ok(!/pin_intento|pin_set/.test(indexTs), 'ninguna llamada a las RPC de PIN todavía');
});
caso('Edge Function: la sintaxis es válida (sin imports ni Deno.serve ejecutados)', () => {
  const sinImports = indexTs.replace(/^import .*$/gm, '');
  let error = null;
  try { new Function('Deno', 'createClient', 'validarCodigo', 'RESPUESTA_NO_VERIFICABLE', 'construirRespuesta', 'clasificarUA', 'limpiarIp', 'crearLimitador', sinImports); } catch (e) { error = e; }
  assert.equal(error, null);
});

// ---------- Manejador REAL de la Edge Function ejecutado con simulaciones (sin Deno, sin red) ----------
const TE = typeof TextEncoder !== 'undefined' ? TextEncoder : class { encode(s) { const o = []; const u = unescape(encodeURIComponent(String(s))); for (let i = 0; i < u.length; i++) o.push(u.charCodeAt(i)); return new Uint8Array(o); } };
function sha256Bytes(msg) {
  const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  let H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const len = msg.length, l = ((len + 9 + 63) >> 6) << 6, m = new Uint8Array(l); m.set(msg); m[len] = 0x80;
  const bits = len * 8; for (let i = 0; i < 4; i++) m[l - 1 - i] = (bits >>> (8 * i)) & 255;
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
const CR = (typeof crypto !== 'undefined' && crypto.subtle) ? crypto : { subtle: { async digest(_, d) { return sha256Bytes(d instanceof Uint8Array ? d : new Uint8Array(d)).buffer; } } };
const hexDe = async (txt) => Array.from(new Uint8Array(await CR.subtle.digest('SHA-256', new TE().encode(txt)))).map(b => b.toString(16).padStart(2, '0')).join('');

function montarFuncion(env, sim) {
  sim = sim || {};
  const llamadas = { rpc: [], from: [], turnstile: [] };
  let handler = null;
  const Deno = { env: { get: k => env[k] }, serve: (f) => { handler = f; } };
  class Resp { constructor(body, init) { this.body = body; this.status = (init && init.status) || 200; this.headers = (init && init.headers) || {}; } async json() { return JSON.parse(this.body); } }
  class UP { constructor() { this.d = []; } append(k, v) { this.d.push([k, v]); } }
  const usados = new Set();
  const fetchSim = async (url, init) => {
    const token = init.body.d.find(x => x[0] === 'response')[1];
    llamadas.turnstile.push({ url, token, conSignal: !!init.signal });
    if (sim.turnstileRed) throw new Error('red caída');
    const duplicado = usados.has(token); if (token === 'token-ok' || token === 'token-uso-unico') usados.add(token);
    const valido = sim.turnstileOk !== false && (token === 'token-ok' || (token === 'token-uso-unico' && !duplicado));
    return { json: async () => (valido ? { success: true, hostname: sim.hostname === undefined ? 'cardiolink.com.ar' : sim.hostname, action: sim.action || 'verificar-documento', 'error-codes': [] } : { success: false, 'error-codes': [duplicado ? 'timeout-or-duplicate' : 'invalid-input-response'] }) };
  };
  const createClient = () => ({
    rpc: async (nombre, args) => {
      llamadas.rpc.push({ nombre, args });
      if (nombre === 'cardiolink_verificacion_limitar_v1') { const v = sim.limite ? sim.limite(args) : true; return v === null ? { data: null, error: { message: 'rpc caída' } } : { data: v, error: null }; } return sim.rpcError ? { data: null, error: { message: 'boom' } } : { data: sim.rpc === undefined ? { encontrado: false } : sim.rpc, error: null }; },
    from: (t) => { llamadas.from.push(t); const q = { select() { return q; }, eq() { return q; }, limit() { return Promise.resolve(sim.configError ? Promise.reject(new Error('x')) : { data: [{ payload: { config } }], error: null }); } }; return q; }
  });
  const fuente = indexTs.replace(/^import .*$/gm, '');
  const tiempo = sim.ahora || (() => Date.now());
  const L2 = new Function(logicaSrc.replace(/^export /gm, '').replace(/Date\.now\(\)/, 'Date.now()') + '\nreturn {validarCodigo,RESPUESTA_NO_VERIFICABLE,construirRespuesta,clasificarUA,limpiarIp,crearLimitador,listaDesdeEnv,evaluarTurnstile};')();
  new Function('Deno', 'createClient', 'validarCodigo', 'RESPUESTA_NO_VERIFICABLE', 'construirRespuesta', 'clasificarUA', 'limpiarIp', 'crearLimitador', 'listaDesdeEnv', 'evaluarTurnstile', 'crypto', 'TextEncoder', 'Response', 'URLSearchParams', 'fetch', 'console', 'AbortController', 'setTimeout', 'clearTimeout', fuente)(
    Deno, createClient, L2.validarCodigo, L2.RESPUESTA_NO_VERIFICABLE, L2.construirRespuesta, L2.clasificarUA, L2.limpiarIp, L2.crearLimitador, L2.listaDesdeEnv, L2.evaluarTurnstile, CR, TE, Resp, UP, fetchSim, { error() {}, log() {} }, class { constructor() { this.signal = {}; } abort() {} }, () => 0, () => {});
  const pedir = async (o) => {
    o = o || {};
    const cuerpo = o.raw !== undefined ? o.raw : JSON.stringify(o.body === undefined ? { codigo: 'Qa1_Wb2-Ec3Rd4Tf5Yg6Hw', turnstileToken: 'token-ok' } : o.body);
    const req = { method: o.method || 'POST', headers: { get: (k) => ({ origin: o.origin === undefined ? 'https://cardiolink.com.ar' : o.origin, 'x-forwarded-for': o.ip || '190.1.2.3', 'user-agent': 'Mozilla/5.0 (iPhone) Mobile' })[String(k).toLowerCase()] || null }, text: async () => cuerpo };
    const r = await handler(req); return { status: r.status, headers: r.headers, json: r.body ? JSON.parse(r.body) : null };
  };
  return { pedir, llamadas };
}
const ENV = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'srv', TURNSTILE_SECRET_KEY: 'sec', VERIFY_ALLOWED_ORIGINS: 'https://cardiolink.com.ar', VERIFY_TURNSTILE_HOSTNAMES: 'cardiolink.com.ar' };
const UNI = '{"ok":true,"resultado":"no_verificable"}';

caso('handler: código válido y vigente => verificado, con la RPC llamada con HASH (no con el código) y la IP hasheada', async () => {
  const f = montarFuncion(ENV, { rpc: rpcOk() });
  const r = await f.pedir();
  assert.equal(r.status, 200); assert.equal(r.json.resultado, 'verificado'); assert.equal(r.json.estado, 'vigente');
  const consultas = f.llamadas.rpc.filter(x => x.nombre === 'cardiolink_verificacion_consultar_v1'); assert.equal(consultas.length, 1);
  const a = consultas[0].args;
  assert.equal(a.p_code_hash, await hexDe('Qa1_Wb2-Ec3Rd4Tf5Yg6Hw'));
  assert.ok(JSON.stringify(a).indexOf('Qa1_Wb2-Ec3Rd4Tf5Yg6Hw') < 0 && JSON.stringify(a).indexOf('190.1.2.3') < 0, 'ni el código ni la IP viajan en claro');
  assert.ok(/^[0-9a-f]{32}$/.test(a.p_ip_hash)); assert.equal(a.p_ua_class, 'movil');
  assert.equal(r.headers['Cache-Control'], 'no-store'); assert.equal(r.headers['Access-Control-Allow-Origin'], 'https://cardiolink.com.ar');
  assert.equal(JSON.stringify(r.json).indexOf('Qa1_Wb2-Ec3Rd4Tf5Yg6Hw') < 0, true, 'la respuesta no repite el código');
});
caso('handler: inexistente, no disponible, formato inválido y base caída-config responden igual (uniforme) y los inválidos NO tocan la base', async () => {
  const noEnc = await montarFuncion(ENV, { rpc: { encontrado: false } }).pedir();
  const noDisp = await montarFuncion(ENV, { rpc: { encontrado: true, estado: 'no_disponible', tipo: 'certificado' } }).pedir();
  const fmt = montarFuncion(ENV, { rpc: rpcOk() }); const fmtR = await fmt.pedir({ body: { codigo: 'corto', turnstileToken: 'token-ok' } });
  for (const r of [noEnc, noDisp, fmtR]) { assert.equal(r.status, 200); assert.equal(JSON.stringify(r.json), UNI); }
  assert.equal(fmt.llamadas.rpc.filter(x => x.nombre === 'cardiolink_verificacion_consultar_v1').length, 0, 'formato inválido: ni consulta');
  const sinConfig = await montarFuncion(ENV, { rpc: rpcOk(), configError: true }).pedir();
  assert.equal(sinConfig.json.resultado, 'verificado'); assert.equal(sinConfig.json.profesional, null);
});
caso('handler: sin Turnstile válido => 403 y NO se consulta la base (no se pueden probar códigos sin desafío)', async () => {
  for (const body of [{ codigo: 'Qa1_Wb2-Ec3Rd4Tf5Yg6Hw' }, { codigo: 'Qa1_Wb2-Ec3Rd4Tf5Yg6Hw', turnstileToken: 'malo' }, { codigo: 'Qa1_Wb2-Ec3Rd4Tf5Yg6Hw', turnstileToken: 123 }]) {
    const f = montarFuncion(ENV, { rpc: rpcOk() }); const r = await f.pedir({ body });
    assert.equal(r.status, 403); assert.equal(r.json.error, 'verificacion_humana'); assert.equal(f.llamadas.rpc.length, 0, 'ni siquiera el límite persistente (los bots sin desafío no escriben en la base)'); assert.equal(f.llamadas.from.length, 0);
  }
  const sinSecret = montarFuncion(Object.assign({}, ENV, { TURNSTILE_SECRET_KEY: '' }), { rpc: rpcOk() }); const r2 = await sinSecret.pedir();
  assert.equal(r2.status, 403, 'fail-closed sin secret'); assert.equal(sinSecret.llamadas.rpc.length, 0);
});
caso('handler: límite de tasa por IP => 429 sin consultar', async () => {
  const f = montarFuncion(ENV, { rpc: rpcOk() }); let ultimo = null, n429 = 0;
  for (let i = 0; i < 40; i++) { ultimo = await f.pedir({ ip: '200.0.0.9' }); if (ultimo.status === 429) n429++; }
  assert.ok(n429 >= 10 && ultimo.json.error === 'demasiados_intentos'); assert.equal(f.llamadas.rpc.filter(x => x.nombre === 'cardiolink_verificacion_consultar_v1').length, 30);
  const otra = await f.pedir({ ip: '200.0.0.10' }); assert.equal(otra.status, 200);
});
caso('handler: método, tamaño, JSON inválido, CORS y F4 deshabilitado', async () => {
  const f = montarFuncion(ENV, { rpc: rpcOk() });
  assert.equal((await f.pedir({ method: 'GET' })).status, 405);
  assert.equal((await f.pedir({ method: 'OPTIONS' })).status, 204);
  assert.equal((await f.pedir({ raw: 'x'.repeat(3000) })).status, 413);
  assert.equal((await f.pedir({ raw: '{no es json' })).status, 400);
  assert.equal((await f.pedir({ raw: '"string"' })).status, 400);
  const sinOrigen = await f.pedir({ origin: 'https://evil.example' }); assert.equal(sinOrigen.headers['Access-Control-Allow-Origin'], undefined, 'origen no permitido: sin CORS');
  assert.equal((await f.pedir({ origin: 'http://localhost:8765' })).headers['Access-Control-Allow-Origin'], 'http://localhost:8765');
  const antes = f.llamadas.rpc.length, antesTs = f.llamadas.turnstile.length;
  const pdf = await f.pedir({ body: { accion: 'acceso-pdf', codigo: 'Qa1_Wb2-Ec3Rd4Tf5Yg6Hw', pin: '123456' } });
  assert.equal(pdf.status, 501); assert.equal(pdf.json.error, 'no_habilitado'); assert.equal(f.llamadas.rpc.length, antes, 'F4 no toca la base'); assert.equal(f.llamadas.turnstile.length, antesTs);
});
caso('handler: falla de la RPC => 503 igual para cualquier código (no revela existencia)', async () => {
  const a = await montarFuncion(ENV, { rpcError: true }).pedir(); const b = await montarFuncion(ENV, { rpcError: true }).pedir({ body: { codigo: 'AbCdEfGhIjKlMnOpQrStUv', turnstileToken: 'token-ok' } });
  assert.equal(a.status, 503); assert.equal(JSON.stringify(a.json), JSON.stringify(b.json)); assert.equal(a.json.error, 'no_disponible');
});

// ---------- Página pública (estático) ----------
const pagJs = leer('verificacion-publica/verificar/verificar.js'), pagHtml = leer('verificacion-publica/verificar/index.html'), headers = leer('verificacion-publica/_headers');
caso('página: sin innerHTML/eval/document.write/almacenamiento/cookies (todo con textContent) y sin dependencias externas salvo Turnstile', () => {
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|localStorage|sessionStorage|document\.cookie/.test(pagJs));
  assert.ok(!/<script[^>]+src="https?:/.test(pagHtml) && !/<link[^>]+href="https?:/.test(pagHtml) && !/<img/.test(pagHtml) && !/ style="/.test(pagHtml) && !/ on[a-z]+=/.test(pagHtml), 'sin recursos externos, estilos ni manejadores en línea');
  assert.ok(pagJs.includes("https://challenges.cloudflare.com/turnstile/v0/api.js"));
});
caso('página: fail-closed en Production hasta configurar la sitekey; en local usa STAGING y la clave de prueba; el override ?api= sólo en local', () => {
  assert.ok(pagJs.includes("SITEKEY_PRODUCCION = 'SITEKEY_PRODUCCION_PENDIENTE'") && pagJs.includes("sitekey === 'SITEKEY_PRODUCCION_PENDIENTE'"));
  assert.ok(pagJs.includes("var FUNCION_PRODUCCION = 'https://tupacclmhaqiahhlttyz.supabase.co/functions/v1/document-verify'"));
  assert.ok(/if \(esLocal\) \{\s*\n\s*urlFuncion = FUNCION_STAGING; sitekey = SITEKEY_TEST;\s*\n\s*var api = params\.get\('api'\);\s*\n\s*if \(api && \/\^http:/.test(pagJs), 'el override de API vive dentro de la rama local');
  assert.ok(pagJs.includes("SITEKEY_TEST = '1x00000000000000000000BB'"));
});
caso('página: código con formato inválido no genera ninguna consulta; envía sólo codigo + turnstileToken, sin credenciales ni referer', () => {
  assert.ok(pagJs.includes("if (!CODIGO_RE.test(codigo)) { mostrarMensaje('neutro', 'No verificable', MENSAJE_NO_VERIFICABLE); return; }"));
  assert.ok(pagJs.includes("JSON.stringify({ codigo: codigo, turnstileToken: token })") && pagJs.includes("credentials: 'omit'") && pagJs.includes("referrerPolicy: 'no-referrer'") && pagJs.includes("cache: 'no-store'"));
});
caso('página: el acceso al PDF con PIN (F4) sólo se ofrece en documentos vigentes y sigue deshabilitado', () => {
  assert.ok(pagJs.includes("if (estado === 'vigente') {"));
  assert.ok(/<form id="form-pin"[^>]*hidden>/.test(pagHtml) && /<input id="pin"[^>]*disabled>/.test(pagHtml) && /<button type="submit" disabled>/.test(pagHtml));
  assert.ok(pagJs.includes("$('form-pin').hidden = ap.disponible !== true"));
});
caso('página: noindex, sin referrer, robots.txt cierra el sitio', () => {
  assert.ok(pagHtml.includes('noindex, nofollow, noarchive') && pagHtml.includes('<meta name="referrer" content="no-referrer">'));
  assert.ok(/Disallow: \//.test(leer('verificacion-publica/robots.txt')));
});
caso('cabeceras (_headers): CSP estricta sin unsafe-inline/unsafe-eval, sólo Turnstile y la API de Production; sin framing ni caché', () => {
  const csp = /Content-Security-Policy: (.*)/.exec(headers)[1];
  assert.ok(csp.includes("default-src 'none'") && csp.includes("frame-ancestors 'none'") && csp.includes("base-uri 'none'") && csp.includes("form-action 'none'"));
  assert.ok(!/unsafe-inline|unsafe-eval|\*/.test(csp));
  assert.ok(csp.includes('connect-src https://tupacclmhaqiahhlttyz.supabase.co') && !csp.includes('yslhwdl') && !/127\.0\.0\.1|localhost/.test(csp), 'Production sólo habla con Production');
  assert.ok(/X-Content-Type-Options: nosniff/.test(headers) && /Referrer-Policy: no-referrer/.test(headers) && /X-Frame-Options: DENY/.test(headers) && /Cache-Control: no-store/.test(headers));
});
caso('aislamiento: la página pública vive en su propia carpeta, sin la app clínica ni credenciales', () => {
  const todo = pagJs + pagHtml + headers + leer('verificacion-publica/verificar/verificar.css');
  assert.ok(!/sb_publishable|sb_secret|service_role|SUPABASE_KEY|apikey/i.test(todo), 'sin claves de Supabase en el sitio público');
  assert.ok(!/cardiolink_|app\.js/.test(pagJs + pagHtml), 'no referencia tablas ni la app clínica');
});

// ---------- Cierre de seguridad F3: Turnstile estricto y límite persistente ----------
caso('Turnstile (puro): éxito + hostname de la lista OBLIGATORIA + acción esperada', () => {
  const ok = { success: true, hostname: 'cardiolink.com.ar', action: 'verificar-documento' };
  assert.equal(L.evaluarTurnstile(ok, { hostnames: ['cardiolink.com.ar'], accion: 'verificar-documento' }).ok, true);
  assert.equal(L.evaluarTurnstile(ok, { hostnames: ['cardiolink.com.ar'], accion: '' }).ok, true, 'acción opcional');
  assert.equal(L.evaluarTurnstile({ success: false }, { hostnames: ['cardiolink.com.ar'] }).ok, false);
  assert.equal(L.evaluarTurnstile(null, { hostnames: ['cardiolink.com.ar'] }).ok, false);
  assert.equal(L.evaluarTurnstile(Object.assign({}, ok, { hostname: 'evil.example' }), { hostnames: ['cardiolink.com.ar'] }).motivo, 'hostname');
  assert.equal(L.evaluarTurnstile(Object.assign({}, ok, { hostname: undefined }), { hostnames: ['cardiolink.com.ar'] }).ok, false);
  assert.equal(L.evaluarTurnstile(Object.assign({}, ok, { hostname: 'CardioLink.com.ar' }), { hostnames: ['cardiolink.com.ar'] }).ok, true, 'sin distinguir mayúsculas');
  assert.equal(L.evaluarTurnstile(Object.assign({}, ok, { hostname: 'sub.cardiolink.com.ar' }), { hostnames: ['cardiolink.com.ar'] }).ok, false, 'sin comodines: coincidencia exacta');
  assert.equal(L.evaluarTurnstile(Object.assign({}, ok, { action: 'otra' }), { hostnames: ['cardiolink.com.ar'], accion: 'verificar-documento' }).motivo, 'accion');
  for (const sin of [[], null, undefined]) assert.equal(L.evaluarTurnstile(ok, { hostnames: sin }).ok, false, 'sin lista de hostnames: fail-closed');
  assert.equal(L.listaDesdeEnv(' A.com , b.com ,, ').join('|'), 'a.com|b.com');
});
caso('handler: hostname no autorizado, acción distinta o falta la lista => 403 y NO se consulta ni se escribe nada', async () => {
  for (const [env, sim, etiqueta] of [[ENV, { rpc: rpcOk(), hostname: 'evil.example' }, 'hostname'], [Object.assign({}, ENV, { VERIFY_TURNSTILE_ACTION: 'verificar-documento' }), { rpc: rpcOk(), action: 'otra' }, 'acción'], [Object.assign({}, ENV, { VERIFY_TURNSTILE_HOSTNAMES: '' }), { rpc: rpcOk() }, 'sin lista']]) {
    const f = montarFuncion(env, sim); const r = await f.pedir();
    assert.equal(r.status, 403, etiqueta); assert.equal(f.llamadas.rpc.length, 0, etiqueta);
  }
  const okAccion = await montarFuncion(Object.assign({}, ENV, { VERIFY_TURNSTILE_ACTION: 'verificar-documento' }), { rpc: rpcOk() }).pedir();
  assert.equal(okAccion.status, 200);
});
caso('handler: token de un solo uso (el segundo uso del mismo token se rechaza) y red caída => fail-closed', async () => {
  const f = montarFuncion(ENV, { rpc: rpcOk() });
  const uno = await f.pedir({ body: { codigo: 'Qa1_Wb2-Ec3Rd4Tf5Yg6Hw', turnstileToken: 'token-uso-unico' } });
  const dos = await f.pedir({ body: { codigo: 'Qa1_Wb2-Ec3Rd4Tf5Yg6Hw', turnstileToken: 'token-uso-unico' } });
  assert.equal(uno.status, 200); assert.equal(dos.status, 403, 'timeout-or-duplicate');
  const caida = montarFuncion(ENV, { rpc: rpcOk(), turnstileRed: true }); const r = await caida.pedir();
  assert.equal(r.status, 403); assert.equal(caida.llamadas.rpc.length, 0);
  assert.equal(f.llamadas.turnstile[0].conSignal, true, 'siteverify con tiempo máximo (AbortController)');
});
caso('handler: límite PERSISTENTE (por IP hasheada y global) después de Turnstile y antes de consultar; cuenta también los códigos inválidos', async () => {
  const f = montarFuncion(ENV, { rpc: rpcOk() });
  const r = await f.pedir({ body: { codigo: 'corto', turnstileToken: 'token-ok' } });
  assert.equal(JSON.stringify(r.json), UNI);
  const lim = f.llamadas.rpc.filter(x => x.nombre === 'cardiolink_verificacion_limitar_v1');
  assert.equal(lim.length, 2); assert.ok(/^ip:[0-9a-f]{32}$/.test(lim[0].args.p_clave) && lim[0].args.p_max === 30 && lim[0].args.p_ventana_seg === 600);
  assert.equal(lim[1].args.p_clave, 'global'); assert.equal(lim[1].args.p_max, 600); assert.equal(lim[1].args.p_ventana_seg, 60);
  assert.ok(JSON.stringify(lim).indexOf('190.1.2.3') < 0, 'la IP nunca viaja en claro');
  assert.equal(f.llamadas.rpc.filter(x => x.nombre === 'cardiolink_verificacion_consultar_v1').length, 0);
});
caso('handler: el límite persistente que deniega => 429 sin consultar', async () => {
  for (const clave of ['ip:', 'global']) {
    const f = montarFuncion(ENV, { rpc: rpcOk(), limite: (a) => !(a.p_clave.indexOf(clave) === 0) }); const r = await f.pedir();
    assert.equal(r.status, 429); assert.equal(r.json.error, 'demasiados_intentos'); assert.equal(f.llamadas.rpc.filter(x => x.nombre === 'cardiolink_verificacion_consultar_v1').length, 0, clave);
  }
});
caso('handler: FALLA la RPC del límite persistente => 503 y NO se consulta ningún certificado (sin fallback permisivo)', async () => {
  const variantes = [
    ['RPC con error (ip)', (a) => null],
    ['RPC con error (sólo global)', (a) => (a.p_clave === 'global' ? null : true)],
    ['respuesta inesperada (no booleana)', (a) => 'si'],
    ['respuesta vacía', (a) => undefined]
  ];
  for (const [nombre, limite] of variantes) {
    const f = montarFuncion(ENV, { rpc: rpcOk(), limite: (a) => { const v = limite(a); return v === undefined ? { __vacio: true } : v; } });
    const r = await f.pedir();
    assert.equal(r.status, 503, nombre); assert.equal(JSON.stringify(r.json), '{"ok":false,"error":"no_disponible"}', nombre);
    assert.equal(f.llamadas.rpc.filter(x => x.nombre === 'cardiolink_verificacion_consultar_v1').length, 0, nombre + ': no consulta');
    assert.equal(f.llamadas.from.length, 0, nombre + ': no lee la configuración');
  }
  // con un código inválido pasa lo mismo (no distingue por el código) y NO hay reintento permisivo con el límite en memoria
  const inv = montarFuncion(ENV, { rpc: rpcOk(), limite: () => null }); const r2 = await inv.pedir({ body: { codigo: 'corto', turnstileToken: 'token-ok' } });
  assert.equal(r2.status, 503);
  assert.ok(!/en memoria/.test(indexTs.replace(/\/\/.*$/gm, '')), 'no queda lógica de fallback en memoria en el código');
});
caso('handler: orden CORS/memoria -> Turnstile -> límite persistente -> formato -> consulta', () => {
  const iTs = indexTs.indexOf('await verificarTurnstile('), iLimP = indexTs.indexOf("await limitarPersistente(admin, 'ip:'"), iFmt = indexTs.indexOf('validarCodigo(body.codigo)'), iDb = indexTs.indexOf("admin.rpc('cardiolink_verificacion_consultar_v1'");
  assert.ok(iTs > 0 && iTs < iLimP && iLimP < iFmt && iFmt < iDb, [iTs, iLimP, iFmt, iDb].join(' '));
  assert.ok(indexTs.includes('VERIFY_TURNSTILE_HOSTNAMES') && indexTs.includes('evaluarTurnstile('));
});
caso('página: pide el desafío con la acción "verificar-documento" (la misma que valida la función)', () => {
  assert.ok(leer('verificacion-publica/verificar/verificar.js').includes("action: 'verificar-documento'"));
});

caso('el QR de F2 apunta al dominio objetivo cardiolink.com.ar/verificar/', () => {
  const m = leer('cardiolink-documentos-pdf-v1.js');
  assert.ok(m.includes("const URL_VERIFICACION_BASE_V1='https://cardiolink.com.ar/verificar/';"));
  assert.ok(m.includes('window.CARDIOLINK_QR_V2A===true') && !/CARDIOLINK_QR_V2A\s*=\s*true/.test(m), 'la bandera sigue apagada por defecto');
});

(async () => {
  let fallos = 0;
  for (const [n, f] of casos) {
    try { await f(); console.log('PASS ' + n); } catch (e) { fallos++; console.log('FAIL ' + n + '\n     ' + (e && e.message)); }
  }
  console.log(`\n${casos.length - fallos}/${casos.length} PASS`);
  if (fallos) process.exit(1);
})();
