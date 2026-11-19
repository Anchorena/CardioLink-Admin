'use strict';
// Persistencia V1 · Seguridad del almacenamiento local V1 (equipo compartido, claves por proyecto + uid, migración verificable, antigüedad y descarte explícito).
// Ejecutar: node --test cardiolink-seguridad-local-v1.test.cjs
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const M = require('./cardiolink-seguridad-local-v1.js');
const leer = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');

function almacenFalso(inicial, opciones) {
  const m = new Map(Object.entries(inicial || {}));
  return {
    m, getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { if (opciones && opciones.falla && opciones.falla(k)) throw new Error('cuota'); m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); }, key: (i) => Array.from(m.keys())[i] ?? null, get length() { return m.size; }
  };
}
const P = 'proyecto-stg';
function sellosFalsos(op) {
  const m = new Map(); return { m,
    get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { if (op && op.fallaPut) return false; m.set(k, v); return true; }, del: async (k) => { m.delete(k); return true; },
    keys: async (p) => Array.from(m.keys()).filter((k) => k.startsWith(p)) };
}
function entorno(inicial, op) {
  let t = Date.parse('2026-11-19T12:00:00Z'); const A = almacenFalso(inicial, op), SE = sellosFalsos(op);
  const S = M.crear({ almacen: A, proyecto: () => P, uid: () => 'u1', ahora: () => t, iteraciones: 1000, claveConfig: () => 'cardiolink_config_v25', crypto: globalThis.crypto, TextEncoder, TextDecoder, btoa: globalThis.btoa, atob: globalThis.atob, sellos: SE });
  return { S, A, SE, avanzar: (dias) => { t += dias * 86400000; } };
}
const J = (o) => JSON.stringify(o);
const K = (base, uid) => base + ':' + P + ':' + uid;

test('las claves incluyen proyecto y uid; la heredada <base>_<uid> es distinta', () => {
  const { S } = entorno();
  assert.equal(S.clave('cardiolink_docs_pendientes_v1', 'u1'), 'cardiolink_docs_pendientes_v1:proyecto-stg:u1');
  assert.notEqual(S.clave('x', 'u1'), S.viejaClave('x', 'u1'));
  assert.notEqual(S.clave('x', 'u1'), S.clave('x', 'u2'));
  const otro = M.crear({ almacen: almacenFalso(), proyecto: () => 'produccion' });
  assert.notEqual(S.clave('x', 'u1'), otro.clave('x', 'u1'), 'el mismo uid en otro proyecto no comparte clave');
});

test('migración: sólo el uid de la sesión; objeto con clave heredada pasa a la nueva sin duplicar y sin tocar a otros', () => {
  const docs = J({ docs: [{ id: 'd1' }], fecha: '2026-11-01T00:00:00Z' }), docs2 = J({ docs: [{ id: 'd9' }], fecha: '2026-11-01T00:00:00Z' });
  const { S, A } = entorno({ 'cardiolink_docs_pendientes_v1_u1': docs, 'cardiolink_docs_pendientes_v1_u2': docs2, 'cardiolink_config_pendiente_v1_u1': J({ fecha: '2026-11-02T00:00:00Z', config: {} }) });
  const r = S.migrarUsuario('u1');
  assert.deepEqual(r.migradas.sort(), ['cfg_pendiente', 'docs']);
  assert.equal(A.getItem(K('cardiolink_docs_pendientes_v1', 'u1')), docs);
  assert.equal(A.getItem('cardiolink_docs_pendientes_v1_u1'), null, 'la heredada se retira sólo tras copiar y verificar');
  assert.equal(A.getItem('cardiolink_docs_pendientes_v1_u2'), docs2, 'lo de otro uid NO se toca ni se atribuye');
  assert.equal(A.getItem(K('cardiolink_docs_pendientes_v1', 'u2')), null);
  const r2 = S.migrarUsuario('u1'); assert.equal(r2.migradas.length, 0, 'idempotente: sin duplicados');
});

test('migración sin pérdida: dos versiones distintas se conservan; escritura fallida no toca el original; duplicado idéntico se retira', () => {
  const a = J({ docs: [{ id: 'a' }], fecha: 'x' }), b = J({ docs: [{ id: 'b' }], fecha: 'x' });
  let e = entorno({ 'cardiolink_docs_pendientes_v1_u1': a, [K('cardiolink_docs_pendientes_v1', 'u1')]: b });
  let r = e.S.migrarUsuario('u1'); assert.deepEqual(r.conservadas, ['docs']);
  assert.equal(e.A.getItem('cardiolink_docs_pendientes_v1_u1'), a); assert.equal(e.A.getItem(K('cardiolink_docs_pendientes_v1', 'u1')), b);
  e = entorno({ 'cardiolink_docs_pendientes_v1_u1': a }, { falla: (k) => k.includes(':proyecto-stg:') });
  r = e.S.migrarUsuario('u1'); assert.deepEqual(r.conservadas, ['docs']); assert.equal(e.A.getItem('cardiolink_docs_pendientes_v1_u1'), a, 'cuota agotada: el original queda');
  e = entorno({ 'cardiolink_docs_pendientes_v1_u1': a, [K('cardiolink_docs_pendientes_v1', 'u1')]: a });
  r = e.S.migrarUsuario('u1'); assert.deepEqual(r.duplicadas, ['docs']); assert.equal(e.A.getItem('cardiolink_docs_pendientes_v1_u1'), null);
});

test('listas globales (rechazos, eliminadas): sólo se migran los elementos con el uid de la sesión; el resto queda en la global', () => {
  const mio = { id: 'a1', uid: 'u1', ts: '2026-11-01T00:00:00Z', valores: { x: 1 } }, ajeno = { id: 'a2', uid: 'u2', ts: '2026-11-01T00:00:00Z' }, sinUid = { id: 'a3', ts: '2026-11-01T00:00:00Z' };
  const { S, A } = entorno({ cardiolink_atenciones_rechazos_v1: J([mio, ajeno, sinUid]), cardiolink_atenciones_eliminadas_remotas_v1: J([{ id: 'e1', uid: 'u1', ts: 't' }]) });
  const r = S.migrarUsuario('u1');
  assert.deepEqual(r.migradas.sort(), ['eliminadas', 'rechazos']);
  assert.deepEqual(JSON.parse(A.getItem(K('cardiolink_atenciones_rechazos_v1', 'u1'))), [mio]);
  assert.deepEqual(JSON.parse(A.getItem('cardiolink_atenciones_rechazos_v1')), [ajeno, sinUid], 'ajeno y sin uid NO se atribuyen al usuario actual');
  assert.equal(A.getItem('cardiolink_atenciones_eliminadas_remotas_v1'), null, 'la global se elimina sólo cuando queda vacía');
  const r2 = S.migrarUsuario('u1'); assert.equal(r2.migradas.length, 0);
  assert.equal(JSON.parse(A.getItem(K('cardiolink_atenciones_rechazos_v1', 'u1'))).length, 1, 'sin duplicados al repetir');
});

test('datos ilegibles o claves nuevas dañadas no se pisan', () => {
  let e = entorno({ cardiolink_atenciones_rechazos_v1: 'no-es-json' });
  let r = e.S.migrarUsuario('u1'); assert.deepEqual(r.ilegibles, ['rechazos']); assert.equal(e.A.getItem('cardiolink_atenciones_rechazos_v1'), 'no-es-json');
  e = entorno({ cardiolink_atenciones_rechazos_v1: J([{ id: 'a', uid: 'u1' }]), [K('cardiolink_atenciones_rechazos_v1', 'u1')]: '{roto' });
  r = e.S.migrarUsuario('u1'); assert.deepEqual(r.ilegibles, ['rechazos']); assert.equal(e.A.getItem(K('cardiolink_atenciones_rechazos_v1', 'u1')), '{roto'); assert.ok(e.A.getItem('cardiolink_atenciones_rechazos_v1').includes('"a"'));
});

test('mensajes de la clave global (sin uid): NO se atribuyen al usuario actual; se informan como heredados sin dueño', () => {
  const { S, A } = entorno({ cardiolink_mensajes_no_enviados_v1: J([{ id: 'm1', texto: 'secreto', fecha: '2026-09-01T00:00:00Z' }]) });
  S.migrarUsuario('u1');
  assert.ok(A.getItem('cardiolink_mensajes_no_enviados_v1'), 'sigue donde estaba');
  assert.equal(A.getItem(K('cardiolink_mensajes_no_enviados_v1', 'u1')), null);
  assert.equal(S.inventario('u1').filter((i) => i.id === 'mensajes').length, 0, 'no aparece como dato del usuario');
  assert.equal(S.contarSinDueno('u1').sinDueno, 1);
});

test('inventario y antigüedad: avisa a los 30 días y NUNCA borra solo', () => {
  const e = entorno({ [K('cardiolink_docs_pendientes_v1', 'u1')]: J({ docs: [{ id: 'd1' }, { id: 'd2' }], fecha: '2026-10-10T12:00:00Z' }), [PREF + 'u1:cola']: undefined });
  const { S, A } = e; const antes = JSON.stringify(Array.from(A.m.entries()));
  let inv = S.inventario('u1'); const d = inv.find((i) => i.id === 'docs'); assert.equal(d.n, 2); assert.equal(d.dias, 40);
  assert.equal(S.avisos('u1').length, 1); assert.equal(S.avisos('u1', 60).length, 0);
  e.avanzar(400); S.inventario('u1'); S.avisos('u1'); assert.equal(JSON.stringify(Array.from(A.m.entries())), antes, 'consultar y envejecer no modifica ni elimina nada');
});
const PREF = 'cardiolink_x:'; // (clave inocua usada sólo para comprobar que entradas ajenas no rompen el inventario)

test('la cola R2D y las copias apartadas aparecen en el inventario (la cola no es descartable en bloque)', () => {
  const { S } = entorno({ ['cardiolink_outbox_r2d_v1:' + P + ':u1']: J({ v: 1, tabs: {}, ops: { a: { ts: '2026-09-01T00:00:00Z' }, b: { ts: '2026-11-18T00:00:00Z' } } }), 'cardiolink_apartado_u1__cfg': 'x', 'cardiolink_apartado_u2__cfg': 'y' });
  const inv = S.inventario('u1'); const c = inv.find((i) => i.id === 'cola'); assert.equal(c.n, 2); assert.ok(c.dias >= 70); assert.equal(c.descartable, false);
  assert.equal(inv.find((i) => i.id === 'apartado').n, 1, 'sólo las del propio uid');
});

test('descarte explícito: alcance limitado al usuario; no toca a otros ni la cola activa', () => {
  const { S, A } = entorno({
    [K('cardiolink_docs_pendientes_v1', 'u1')]: J({ docs: [{ id: 'd1' }], fecha: 'x' }), [K('cardiolink_docs_pendientes_v1', 'u2')]: J({ docs: [{ id: 'd2' }], fecha: 'x' }),
    cardiolink_atenciones_rechazos_v1: J([{ id: 'a', uid: 'u1' }, { id: 'b', uid: 'u2' }]), ['cardiolink_outbox_r2d_v1:' + P + ':u1']: J({ v: 1, tabs: {}, ops: { a: { ts: 'x' } } }), cardiolink_apartado_u1__cfg: 'x'
  });
  const r = S.descartar('u1', ['docs', 'rechazos', 'cola']);
  assert.equal(r.docs, 1); assert.equal(r.rechazos, 1); assert.equal(r.cola, undefined, 'la cola no se descarta en bloque');
  assert.ok(A.getItem(K('cardiolink_docs_pendientes_v1', 'u2'))); assert.deepEqual(JSON.parse(A.getItem('cardiolink_atenciones_rechazos_v1')), [{ id: 'b', uid: 'u2' }]);
  assert.ok(A.getItem('cardiolink_outbox_r2d_v1:' + P + ':u1')); assert.ok(A.getItem('cardiolink_apartado_u1__cfg'), 'sin pedirlo no se toca');
  assert.equal(S.descartar('u1', ['apartado']).apartado, 1);
});

test('descartarSinDueno: sólo mensajes globales y elementos globales SIN uid; nunca elementos de otro usuario', () => {
  const { S, A } = entorno({ cardiolink_mensajes_no_enviados_v1: J([{ id: 'm' }]), cardiolink_atenciones_rechazos_v1: J([{ id: 'x' }, { id: 'y', uid: 'u2' }]) });
  assert.equal(S.descartarSinDueno(), 2);
  assert.equal(A.getItem('cardiolink_mensajes_no_enviados_v1'), null); assert.deepEqual(JSON.parse(A.getItem('cardiolink_atenciones_rechazos_v1')), [{ id: 'y', uid: 'u2' }]);
});

test('equipo compartido: activado por defecto; el ajuste es por equipo', () => {
  const { S, A } = entorno();
  assert.equal(S.equipoCompartido(), true); S.fijarEquipoCompartido(false); assert.equal(S.equipoCompartido(), false); assert.equal(A.getItem('cardiolink_equipo_compartido_v1'), '0');
  S.fijarEquipoCompartido(true); assert.equal(S.equipoCompartido(), true);
});

test('estado de cierre y purgas: sólo se retiran copias de otros usuarios con 0 pendientes confirmados; con pendientes o sin dato se conservan', () => {
  const { S, A } = entorno({ cardiolink_apartado_u2__cfg: 'a', cardiolink_apartado_u3__cfg: 'b', cardiolink_apartado_u4__cfg: 'c', cardiolink_apartado_u1__cfg: 'propia' });
  S.registrarCierre('u2', { pendientes: 0, protegido: true }); S.registrarCierre('u3', { pendientes: 2, protegido: false, auto: true });
  assert.deepEqual(S.cierresConPendientes('u1').map((x) => [x.uid, x.pendientes, x.auto]), [['u3', 2, true]]);
  assert.equal(S.purgarApartadosSinPendientes('u1'), 1);
  assert.equal(A.getItem('cardiolink_apartado_u2__cfg'), null); assert.ok(A.getItem('cardiolink_apartado_u3__cfg')); assert.ok(A.getItem('cardiolink_apartado_u4__cfg'), 'sin estado de cierre no se asume nada'); assert.ok(A.getItem('cardiolink_apartado_u1__cfg'));
  S.limpiarCierre('u3'); assert.equal(S.cierresConPendientes('u1').length, 0);
});

test('purgarSincronizadas: los rechazos ya vistos salen; los no vistos se conservan', () => {
  const { S, A } = entorno({ [K('cardiolink_atenciones_rechazos_v1', 'u1')]: J([{ id: 'a', visto: true }, { id: 'b', visto: false }]) });
  assert.equal(S.purgarSincronizadas('u1').rechazosVistos, 1); assert.deepEqual(JSON.parse(A.getItem(K('cardiolink_atenciones_rechazos_v1', 'u1'))), [{ id: 'b', visto: false }]);
});

test('descartarTodoUsuario (decisión explícita al cerrar): borra lo del usuario, su cola y las claves de caché indicadas; nada de otros', () => {
  const { S, A } = entorno({
    ['cardiolink_outbox_r2d_v1:' + P + ':u1']: J({ v: 1, tabs: {}, ops: { a: {}, b: {} } }), [K('cardiolink_nuevas_pendientes_v1', 'u1')]: J({ rows: [{ id: 1 }], fecha: 'x' }),
    [K('cardiolink_nuevas_pendientes_v1', 'u2')]: J({ rows: [{ id: 2 }], fecha: 'x' }), cardiolink_config_v25: 'cache', ['cardiolink_outbox_r2d_v1:' + P + ':u2']: J({ v: 1, tabs: {}, ops: { z: {} } })
  });
  S.registrarCierre('u1', { pendientes: 2 });
  const r = S.descartarTodoUsuario('u1', ['cardiolink_config_v25']);
  assert.equal(r.cola, 2); assert.equal(A.getItem('cardiolink_config_v25'), null); assert.equal(A.getItem(K('cardiolink_nuevas_pendientes_v1', 'u1')), null); assert.equal(S.leerCierre('u1'), null);
  assert.ok(A.getItem(K('cardiolink_nuevas_pendientes_v1', 'u2'))); assert.ok(A.getItem('cardiolink_outbox_r2d_v1:' + P + ':u2'), 'la cola de otro usuario no se toca');
});

test('integración estática: claves por proyecto+uid en app.js, concurrencia y Secretaría; sin el módulo se usan las heredadas', () => {
  const app = leer('app.js'), con = leer('cardiolink-atenciones-concurrencia-v1.js'), sec = leer('cardiolink-config-secretaria-v1.js'), idx = leer('index.html');
  const f = app.slice(app.indexOf('function claveSegV1('), app.indexOf('function claveSegV1(') + 260); assert.match(f, /S\.clave\(base,uid\)/); assert.match(f, /return base\+'_'\+uid;/);
  assert.match(app, /claveSegV1\('cardiolink_docs_pendientes_v1',uid\)/); assert.match(app, /claveSegV1\('cardiolink_nuevas_pendientes_v1',usuarioSupabase\.id\)/);
  assert.match(app, /function claveMensajesNoEnviadosV1\(\)\{[^}]*claveSegV1\(MENSAJES_NO_ENVIADOS_KEY_V1,uid\)/);
  assert.doesNotMatch(app.replace(/\/\/.*$/gm, ''), /localStorage\.(get|set)Item\(MENSAJES_NO_ENVIADOS_KEY_V1/);
  assert.match(con, /function kSeg\(base\)[\s\S]{0,200}S\.clave\(base, u\)[\s\S]{0,80}return base;/); assert.doesNotMatch(con, /K_RECHAZOS|K_ELIMINADAS/);
  assert.match(sec, /S\.clave\(base\.replace\(\/_\$\/, ''\), id\)[\s\S]{0,200}return base \+ id;/);
  assert.ok(idx.indexOf('cardiolink-seguridad-local-v1.js') > 0 && idx.indexOf('cardiolink-seguridad-local-v1.js') < idx.indexOf('<script src="app.js'), 'el módulo carga ANTES que app.js y que los módulos que leen sus claves');
});

test('integración estática: ingreso migra por uid antes de aislar la caché; cierre decide el usuario (nunca descarta solo); el automático nunca descarta', () => {
  const app = leer('app.js'), glue = leer('cardiolink-outbox-glue-v1.js');
  assert.equal((app.match(/await window\.cardiolinkSeguridadLocalV1\?\.alIniciarSesion\(usuarioSupabase\?\.id\)/g) || []).length, 2);
  assert.ok(app.indexOf('alIniciarSesion(usuarioSupabase?.id)') < app.indexOf('aislarCacheLocalPorUsuarioV1(usuarioSupabase?.id, adminOwner'));
  assert.match(app, /recordarPassword\(password\)/);
  const c = app.slice(app.indexOf('async function cerrarSesionSupabase()'), app.indexOf('function agregarBotonCerrarSesion()'));
  assert.match(c, /SL\.elegirCierre\(\{n,sinProteger:sinP,noProt:/); assert.match(c, /r==='reintentar'\) continue/); assert.match(c, /r==='cancelar'\) return/);
  assert.match(c, /if\(r==='descartar'\)\{[\s\S]{0,300}descartarTodoUsuario/, 'el descarte sólo ocurre por elección explícita'); assert.doesNotMatch(c, /descartarTodoUsuario[\s\S]*descartarTodoUsuario/);
  assert.match(c, /if\(!descartoTodo&&!selladoOk&&!yaLiberada\) await liberarCacheLocalAlCerrarSesionV1\(\)/);
  const l = app.slice(app.indexOf('async function liberarCacheLocalAlCerrarSesionV1(auto)'), app.indexOf('// ---- Identidad profesional'));
  assert.match(l, /registrarCierre\(uidCierre,\{pendientes:Math\.max\(n2,1\)/); assert.match(l, /registrarCierre\(uidCierre,\{pendientes:0/); assert.match(l, /purgarSincronizadas\(uidCierre\)/);
  assert.doesNotMatch(l, /descartarTodoUsuario|\.descartar\(/, 'el cierre automático NUNCA descarta');
  assert.match(app, /const limpia = await liberarCacheLocalAlCerrarSesionV1\(true\);[\s\S]{0,1400}if \(supabaseClient\) await supabaseClient\.auth\.signOut\(\);/);
  assert.match(glue, /function registrar\(opciones\) \{\s*if \(window\.__cardiolinkDescarteCierre\) return false;/);
});

test('criptografía estándar de WebCrypto (PBKDF2-SHA256 + AES-GCM-256): sin algoritmos propios, sin aleatoriedad débil y la contraseña/clave nunca se escriben', () => {
  const src = leer('cardiolink-seguridad-local-v1.js'), codigo = src.replace(/\/\*[\s\S]*?\*\//, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(codigo, /'PBKDF2'/); assert.match(codigo, /name: 'AES-GCM', length: 256/); assert.match(codigo, /hash: 'SHA-256'/); assert.match(codigo, /iteraciones \|\| 600000/);
  assert.match(codigo, /getRandomValues/); assert.doesNotMatch(codigo, /Math\.random|\bxor\b|String\.fromCharCode\([^)]*\^/i);
  assert.match(codigo, /importKey\('raw', enc\.encode\(String\(pw\)\), 'PBKDF2', false, \['deriveKey'\]\)/, 'material no extraíble');
  assert.doesNotMatch(codigo, /(setItem|\.put)\([^)]*(pw|password|material)/, 'ni la contraseña ni la clave se guardan');
  assert.match(src, /NUNCA se guarda/);
});

// ---------------- sellado con contraseña (protección real al cierre) ----------------
const DATOS = { cache: JSON.stringify({ pacientes: [{ nombre: 'PACIENTE-SECRETO', dni: '30111222' }] }), cola: JSON.stringify({ v: 1, tabs: {}, ops: { a: { ts: '2026-11-18T00:00:00Z', cambios: { observaciones: 'DIAGNOSTICO-RESERVADO' } } } }), docs: JSON.stringify({ docs: [{ id: 'd1', contenido: 'CERTIFICADO-CLINICO' }], fecha: '2026-11-18T00:00:00Z' }) };
const EXTRA = ['cardiolink_config_v25', 'cardiolink_cache_owner_v1'];
function conDatos() {
  const e = entorno({ cardiolink_config_v25: DATOS.cache, cardiolink_cache_owner_v1: 'u1', ['cardiolink_outbox_r2d_v1:' + P + ':u1']: DATOS.cola, [K('cardiolink_docs_pendientes_v1', 'u1')]: DATOS.docs, 'cardiolink_otro_usuario': 'AJENO' });
  return e;
}

test('sellar: el texto plano desaparece, el paquete NO contiene datos legibles, ni la contraseña, y se abre con la misma contraseña', async () => {
  const e = conDatos(); const mat = await e.S.materialDe('clave-correcta');
  const r = await e.S.sellarUsuario('u1', mat, EXTRA); assert.equal(r.ok, true); assert.equal(r.n, 4);
  [...EXTRA, 'cardiolink_outbox_r2d_v1:' + P + ':u1', K('cardiolink_docs_pendientes_v1', 'u1')].forEach((k) => assert.equal(e.A.getItem(k), null, 'texto plano retirado: ' + k));
  assert.equal(e.A.getItem('cardiolink_otro_usuario'), 'AJENO', 'lo ajeno no se toca');
  const todo = JSON.stringify(Array.from(e.SE.m.values())) + JSON.stringify(Array.from(e.A.m.entries()));
  ['PACIENTE-SECRETO', 'DIAGNOSTICO-RESERVADO', 'CERTIFICADO-CLINICO', '30111222', 'clave-correcta'].forEach((x) => assert.ok(!todo.includes(x), 'no debe quedar legible: ' + x));
  assert.equal(e.S.contarSellados === undefined, false); assert.equal(await e.S.contarSellados('u1'), 1);
  const ab = await e.S.abrirSellados('u1', await e.S.materialDe('clave-correcta'));
  assert.equal(ab.restauradas, 2, 'sólo pendientes: cola y respaldo de documentos'); assert.equal(ab.omitidas, 2, 'las cachés completas no se restauran (se recargan del servidor)'); assert.equal(ab.paquetes, 1);
  assert.equal(e.A.getItem('cardiolink_config_v25'), null); assert.equal(e.A.getItem('cardiolink_cache_owner_v1'), null);
  assert.equal(e.A.getItem('cardiolink_outbox_r2d_v1:' + P + ':u1'), DATOS.cola); assert.equal(e.A.getItem(K('cardiolink_docs_pendientes_v1', 'u1')), DATOS.docs);
  assert.equal(await e.S.contarSellados('u1'), 0, 'el paquete se retira sólo tras restaurar');
});

test('contraseña distinta (otro usuario o contraseña cambiada): no se abre, no se pierde ni se pisa nada y el paquete queda intacto', async () => {
  const e = conDatos(); await e.S.sellarUsuario('u1', await e.S.materialDe('clave-correcta'), EXTRA);
  const ab = await e.S.abrirSellados('u1', await e.S.materialDe('otra-clave'));
  assert.equal(ab.noAbiertos, 1); assert.equal(ab.restauradas, 0); assert.equal(e.A.getItem('cardiolink_config_v25'), null); assert.equal(await e.S.contarSellados('u1'), 1);
  assert.equal((await e.S.abrirSellados('u1', await e.S.materialDe('clave-correcta'))).restauradas, 2, 'sigue abriéndose con la correcta');
});

test('el paquete está atado al usuario y al proyecto (AAD) y se detecta cualquier alteración', async () => {
  const e = conDatos(); const mat = await e.S.materialDe('pw'); await e.S.sellarUsuario('u1', mat, EXTRA);
  const [id, raw] = Array.from(e.SE.m.entries())[0], sobre = JSON.parse(raw);
  // copiado a otro uid: no abre aunque se conozca la contraseña
  e.SE.m.set(e.S.prefijoSello('u2') + 'x', raw); assert.equal((await e.S.abrirSellados('u2', mat)).noAbiertos, 1);
  // alterado un byte del texto cifrado: no abre
  const ct = Buffer.from(sobre.ct, 'base64'); ct[0] ^= 1; sobre.ct = ct.toString('base64'); e.SE.m.set(id, JSON.stringify(sobre));
  assert.equal((await e.S.abrirSellados('u1', mat)).noAbiertos, 1); assert.equal(e.A.getItem('cardiolink_config_v25'), null);
});

test('si no se puede sellar (almacén lleno, verificación o sin clave/WebCrypto) el texto plano NO se toca y se informa', async () => {
  let e = entorno({ cardiolink_config_v25: DATOS.cache }, { fallaPut: true });
  let r = await e.S.sellarUsuario('u1', await e.S.materialDe('pw'), EXTRA); assert.equal(r.ok, false); assert.equal(e.A.getItem('cardiolink_config_v25'), DATOS.cache, 'el plano queda intacto');
  e = entorno({ cardiolink_config_v25: DATOS.cache });
  r = await e.S.sellarUsuario('u1', null, EXTRA); assert.deepEqual([r.ok, r.error], [false, 'sin_clave']); assert.equal(e.A.getItem('cardiolink_config_v25'), DATOS.cache);
  const sinCrypto = M.crear({ almacen: almacenFalso({ cardiolink_config_v25: DATOS.cache }), proyecto: () => P });
  assert.equal(sinCrypto.webcryptoDisponible(), false); r = await sinCrypto.sellarUsuario('u1', {}, EXTRA); assert.deepEqual([r.ok, r.error], [false, 'sin_webcrypto']);
  // verificación: un almacén que devuelve otra cosa al leer no permite borrar el plano
  e = entorno({ cardiolink_config_v25: DATOS.cache }); const get0 = e.SE.get; e.SE.get = async (k) => { const v = await get0(k); return v && v.replace(/.$/, 'A'); };
  r = await e.S.sellarUsuario('u1', await e.S.materialDe('pw'), EXTRA); assert.equal(r.ok, false); assert.equal(e.A.getItem('cardiolink_config_v25'), DATOS.cache);
});

test('restauración: sólo pendientes ausentes; si hay uno distinto se conserva el paquete (sin pisar) y se informa el conflicto; una caché viva no genera conflicto', async () => {
  const e = conDatos(); const mat = await e.S.materialDe('pw'); await e.S.sellarUsuario('u1', mat, EXTRA);
  e.A.setItem('cardiolink_config_v25', '{"nuevo":1}'); e.A.setItem(K('cardiolink_docs_pendientes_v1', 'u1'), '{"docs":[{"id":"otro"}]}');
  const ab = await e.S.abrirSellados('u1', mat);
  assert.equal(ab.conflictos, 1); assert.equal(e.A.getItem(K('cardiolink_docs_pendientes_v1', 'u1')), '{"docs":[{"id":"otro"}]}', 'no se pisa'); assert.equal(await e.S.contarSellados('u1'), 1, 'el paquete se conserva');
  assert.equal(e.A.getItem('cardiolink_config_v25'), '{"nuevo":1}', 'la caché viva no se toca'); assert.equal(e.A.getItem('cardiolink_outbox_r2d_v1:' + P + ':u1'), DATOS.cola, 'lo demás sí se restauró');
});

test('descarte de paquetes sellados y purga de plano: alcance del usuario', async () => {
  const e = conDatos(); await e.S.sellarUsuario('u1', await e.S.materialDe('pw'), EXTRA); e.SE.m.set(e.S.prefijoSello('u2') + 'z', 'x');
  assert.equal(await e.S.descartarSellados('u1'), 1); assert.equal(await e.S.contarSellados('u1'), 0); assert.equal(await e.S.contarSellados('u2'), 1, 'otro usuario intacto');
  e.A.setItem('cardiolink_config_v25', 'tardío'); e.S.purgarClaves('u1', EXTRA); assert.equal(e.A.getItem('cardiolink_config_v25'), null);
});

test('clave de sesión: sólo existe en memoria tras recordarPassword y se olvida al cerrar', async () => {
  const e = conDatos(); assert.equal(e.S.hayMaterial(), false); assert.equal(await e.S.recordarPassword('pw'), true); assert.equal(e.S.hayMaterial(), true);
  const r = await e.S.sellarUsuario('u1', e.S._materialSesion(), EXTRA); assert.equal(r.ok, true);
  e.S.olvidarMaterial(); assert.equal(e.S.hayMaterial(), false);
  assert.ok(!Array.from(e.A.m.values()).join('').includes('"pw"'));
});

test('integración estática: en equipo compartido NO existe «conservar en claro»; cierre manual y automático sellan o bloquean; nunca quedan datos legibles', () => {
  const app = leer('app.js'), mod = leer('cardiolink-seguridad-local-v1.js');
  const c = app.slice(app.indexOf('async function cerrarSesionSupabase()'), app.indexOf('function agregarBotonCerrarSesion()'));
  assert.doesNotMatch(c, /r==='conservar'/); assert.match(c, /SL\.sellarConPassword\(/); assert.match(c, /if\(!sel\.ok\)[\s\S]{0,260}continue;/, 'si no se pudo sellar NO se cierra');
  assert.match(c, /purgarClaves\(uidSalida/);
  assert.doesNotMatch(mod, /data-r="conservar"/);
  const a = app.slice(app.indexOf('async function cerrarPorInactividad()'), app.indexOf('async function cerrarSesionSupabase()'));
  assert.match(a, /SL\.equipoCompartido\(\)/); assert.match(a, /sellarConSesion\(extraAuto, \{ noProt:/); assert.match(a, /if \(!sel\.ok\) \{ bloquearPorInactividadV1\(\); return; \}/, 'sin clave o con fallo: se BLOQUEA, no se cierra en claro');
  assert.match(app, /function bloquearPorInactividadV1\(\)/); assert.match(app, /SL\.desbloquear\(\); cerrarPorInactividad\(\)/);
});

test('el cierre cierra de verdad aun sin conexión: signOut local garantizado + token retirado (manual y automático); sin clave de sesión el cierre manual verifica o exige doble escritura', () => {
  const app = leer('app.js'), mod = leer('cardiolink-seguridad-local-v1.js');
  assert.match(app, /async function signOutLocalGarantizadoV1\(\)[\s\S]{0,260}scope: 'local'[\s\S]{0,260}auth-token/);
  assert.match(app, /auth\.signOut\(\);\s*if \(supabaseClient\) await signOutLocalGarantizadoV1\(\);/); assert.match(app, /auth\.signOut\(\);\s*await signOutLocalGarantizadoV1\(\);/);
  assert.match(mod, /if \(S\.hayMaterial\(\)\) return S\.sellarUsuario\(uid, S\._materialSesion\(\), extra, meta\);/);
  assert.match(mod, /Sin conexión: no se puede verificar la contraseña[\s\S]{0,300}pw2 !== pw/);
});

test('restauración sobre una cola/respaldo existente SIN contenido (esqueleto vacío): se restaura; con contenido distinto sigue siendo conflicto', async () => {
  const e = conDatos(); const mat = await e.S.materialDe('pw'); await e.S.sellarUsuario('u1', mat, EXTRA);
  e.A.setItem('cardiolink_outbox_r2d_v1:' + P + ':u1', JSON.stringify({ v: 1, tabs: { t1: { ts: 1 } }, ops: {} })); e.A.setItem(K('cardiolink_docs_pendientes_v1', 'u1'), JSON.stringify({ docs: [], fecha: 'x' }));
  let ab = await e.S.abrirSellados('u1', mat); assert.equal(ab.restauradas, 2); assert.equal(ab.conflictos, 0); assert.equal(e.A.getItem('cardiolink_outbox_r2d_v1:' + P + ':u1'), DATOS.cola); assert.equal(await e.S.contarSellados('u1'), 0);
  const e2 = conDatos(); await e2.S.sellarUsuario('u1', await e2.S.materialDe('pw'), EXTRA);
  const conOps = JSON.stringify({ v: 1, tabs: {}, ops: { x: { ts: 'y' } } }); e2.A.setItem('cardiolink_outbox_r2d_v1:' + P + ':u1', conOps);
  ab = await e2.S.abrirSellados('u1', await e2.S.materialDe('pw')); assert.equal(ab.conflictos, 1); assert.equal(e2.A.getItem('cardiolink_outbox_r2d_v1:' + P + ':u1'), conOps, 'no se pisa una cola con operaciones');
});

// ---------------- verificación previa a la publicación: caché sin pérdida silenciosa, datos sin dueño, reanudación sin contraseña ----------------
const COLA_NOPROT = JSON.stringify({ v: 1, tabs: {}, ops: { c: { k: 'config', ts: '2026-11-18T00:00:00Z', ops: [], noProt: ['documentosClinicos', 'logoDocumentoData'] } } });
const CFG_CLINICA = JSON.stringify({ documentosClinicos: [{ id: 'd9', contenido: 'EVOLUCION-CLINICA-RESERVADA' }], logoDocumentoData: 'data:image/png;base64,AAAA' });
async function conNoProt(duenoActual) {
  const e = entorno({ cardiolink_config_v25: CFG_CLINICA, cardiolink_cache_owner_v1: 'u1', ['cardiolink_outbox_r2d_v1:' + P + ':u1']: COLA_NOPROT });
  const mat = await e.S.materialDe('pw'); const r = await e.S.sellarUsuario('u1', mat, EXTRA); assert.equal(r.ok, true);
  assert.equal(e.A.getItem('cardiolink_config_v25'), null);
  if (duenoActual !== undefined) { if (duenoActual !== null) e.A.setItem('cardiolink_cache_owner_v1', duenoActual); e.A.setItem('cardiolink_config_v25', '{"porDefecto":1}'); }
  return { e, mat };
}



test('sin cambios no protegidos la caché NO se restaura (se recarga del servidor) y sí se advierte al sellar cuando los hay', async () => {
  const e = conDatos(); const mat = await e.S.materialDe('pw'); await e.S.sellarUsuario('u1', mat, EXTRA);
  const ab = await e.S.abrirSellados('u1', mat); assert.equal(ab.cachesRestauradas, 0); assert.equal(e.A.getItem('cardiolink_config_v25'), null);
  const e2 = entorno({ ['cardiolink_outbox_r2d_v1:' + P + ':u1']: COLA_NOPROT }); assert.deepEqual(e2.S.noProtegidosEnCola('u1'), ['documentosClinicos', 'logoDocumentoData']);
  assert.deepEqual(conDatos().S.noProtegidosEnCola('u1'), []);
});

test('datos heredados SIN dueño: custodia cifrada con la contraseña de quien decide (no se atribuye el contenido), sólo sale del claro tras verificar; otro usuario no la abre; lo de otro uid no se toca', async () => {
  const e = entorno({ cardiolink_mensajes_no_enviados_v1: J([{ id: 'm1', texto: 'MENSAJE-HEREDADO-RESERVADO' }]), cardiolink_atenciones_rechazos_v1: J([{ id: 'r1', valores: { dx: 'DX-SIN-DUENO' } }, { id: 'r2', uid: 'u9', valores: { x: 1 } }]) });
  assert.equal(e.S.recolectarSinDueno().n, 2);
  const mat = await e.S.materialDe('pw'); const r = await e.S.sellarSinDueno(mat); assert.equal(r.ok, true); assert.equal(r.n, 2);
  assert.equal(e.A.getItem('cardiolink_mensajes_no_enviados_v1'), null); assert.deepEqual(JSON.parse(e.A.getItem('cardiolink_atenciones_rechazos_v1')), [{ id: 'r2', uid: 'u9', valores: { x: 1 } }], 'el elemento de otro uid queda');
  const todo = JSON.stringify(Array.from(e.SE.m.values())) + JSON.stringify(Array.from(e.A.m.entries())); ['MENSAJE-HEREDADO-RESERVADO', 'DX-SIN-DUENO'].forEach((x) => assert.ok(!todo.includes(x)));
  assert.equal((await e.S.leerCustodia(await e.S.materialDe('otra'))).length, 0, 'otro usuario no la abre'); assert.equal(await e.S.contarCustodia(), 1);
  const mios = await e.S.leerCustodia(mat); assert.equal(mios.length, 1); assert.equal(mios[0].datos.mensajes[0].texto, 'MENSAJE-HEREDADO-RESERVADO');
  assert.equal(await e.S.abrirSellados('u1', mat).then((x) => x.paquetes), 0, 'la custodia no se restaura sola al ingresar'); assert.equal(await e.S.descartarCustodia(mat), 1); assert.equal(await e.S.contarCustodia(), 0);
  const f = entorno({ cardiolink_mensajes_no_enviados_v1: J([{ id: 'm' }]) }, { fallaPut: true }); assert.equal((await f.S.sellarSinDueno(await f.S.materialDe('pw'))).ok, false); assert.ok(f.A.getItem('cardiolink_mensajes_no_enviados_v1'), 'si falla, nada se toca');
});

test('integración estática: reanudar una sesión sin contraseña en equipo compartido bloquea la interfaz (declarado NO criptográfico); la decisión sobre datos sin dueño es explícita; el diálogo de cierre advierte los cambios no protegidos', () => {
  const mod = leer('cardiolink-seguridad-local-v1.js'), app = leer('app.js');
  assert.match(mod, /S\.equipoCompartido\(\) && hayTokenLocal\(\)\) w\.setTimeout\(/); assert.doesNotMatch(mod, /getItem\('cardiolink_sesion_validada'\) !== '1'/, 'la clave sólo vive en memoria: tras recargar se pide la contraseña SIEMPRE'); assert.match(mod, /Hay una sesión abierta en este equipo/);
  assert.match(mod, /no cifra los datos guardados en este navegador/); assert.match(mod, /BLOQUEO DE INTERFAZ \(NO es protección criptográfica/);
  assert.match(mod, /data-sc="1"[\s\S]{0,260}Sellar en mi custodia/); assert.match(mod, /Sin decisión quedan en claro/); assert.doesNotMatch(mod.replace(/\/\/.*$/gm, ''), /sellarSinDueno\([^)]*\);\s*\}\s*\}\s*catch/, 'nunca se sella solo');
  assert.match(app, /SL\.elegirCierre\(\{n,sinProteger:sinP,noProt:np\}\)/);
  assert.equal((app.match(/cachesRestauradas>0\)\{ data=loadConfig\(\); atenciones=loadAtenciones\(\); \}/g) || []).length, 2);
});

// ---------------- riesgos residuales: pendientes que no viajan en la cola, datos de otros usuarios, cierre de sesión ajena ----------------

test('heredados de OTROS usuarios: custodia cifrada (owner/admin), sin descartar; se pueden devolver; el descarte de la custodia sólo alcanza lo SIN dueño', async () => {
  const docsOtro = J({ docs: [{ id: 'dx', contenido: 'DOC-DE-OTRO-USUARIO' }], fecha: '2026-09-01T00:00:00Z' });
  const e = entorno({ ['cardiolink_docs_pendientes_v1_u9']: docsOtro, ['cardiolink_docs_pendientes_v1_u1']: DATOS.docs, 'cardiolink_apartado_u9__cardiolink_config_v25': 'CACHE-DE-OTRO', cardiolink_atenciones_rechazos_v1: J([{ id: 'r9', uid: 'u9', valores: { a: 1 } }, { id: 'r1', uid: 'u1' }]), cardiolink_mensajes_no_enviados_v1: J([{ id: 'm', texto: 'SIN-DUENO' }]) });
  const aj = e.S.recolectarAjenos('u1'); assert.equal(aj.n, 3); assert.ok(aj.claves['cardiolink_docs_pendientes_v1_u9']); assert.ok(!aj.claves['cardiolink_docs_pendientes_v1_u1'], 'lo del usuario actual no es ajeno');
  const mat = await e.S.materialDe('pw'); const r = await e.S.sellarAjenos('u1', mat); assert.equal(r.ok, true); assert.equal(r.n, 3);
  const todo = JSON.stringify(Array.from(e.SE.m.values())) + JSON.stringify(Array.from(e.A.m.entries())); ['DOC-DE-OTRO-USUARIO', 'CACHE-DE-OTRO'].forEach((x) => assert.ok(!todo.includes(x), 'no queda legible: ' + x));
  assert.equal(e.A.getItem('cardiolink_docs_pendientes_v1_u9'), null); assert.equal(e.A.getItem(K('x', 'u1')), null); assert.ok(e.A.getItem('cardiolink_docs_pendientes_v1_u1'), 'lo propio no se toca'); assert.deepEqual(JSON.parse(e.A.getItem('cardiolink_atenciones_rechazos_v1')), [{ id: 'r1', uid: 'u1' }]);
  await e.S.sellarSinDueno(mat); assert.equal(await e.S.descartarCustodia(mat), 1, 'sólo el paquete sin dueño se descarta'); assert.equal(await e.S.contarCustodia(), 1, 'el de otros usuarios sigue');
  assert.equal((await e.S.leerCustodia(await e.S.materialDe('otra'))).length, 0);
  const dv = await e.S.devolverAjenos(mat); assert.equal(dv.conflictos, 0); assert.equal(e.A.getItem('cardiolink_docs_pendientes_v1_u9'), docsOtro); assert.equal(e.A.getItem('cardiolink_apartado_u9__cardiolink_config_v25'), 'CACHE-DE-OTRO');
  assert.equal(JSON.parse(e.A.getItem('cardiolink_atenciones_rechazos_v1')).length, 2); assert.equal(await e.S.contarCustodia(), 0, 'el paquete se retira recién tras devolver');
});

test('integración estática: «pendiente» al cerrar incluye lo que no viaja en la cola; cerrar una sesión ajena sincroniza y purga o pide reintentar/descartar (nunca deja legible); sólo owner/admin custodian lo de otros', () => {
  const app = leer('app.js'), mod = leer('cardiolink-seguridad-local-v1.js'), glue = leer('cardiolink-outbox-glue-v1.js');
  const c = app.slice(app.indexOf('async function cerrarSesionSupabase()'), app.indexOf('function agregarBotonCerrarSesion()'));
  assert.match(c, /const limpia=await liberarCacheLocalAlCerrarSesionV1\(\); yaLiberada=true;\s*if\(limpia\) break;\s*const r=await SL\.elegirCierre\(/, 'la decisión de «hay pendientes» es la de liberarCache…, no sólo la cola');
  assert.match(c, /sellarConPassword\(\[\.\.\.clavesCacheLocalV1\(\),CACHE_OWNER_KEY_V1\],\{noProt:ob\.noProtegidos/);
  assert.match(glue, /noProtegidos: function \(\) \{ try \{ var c = puente\.configPendiente\(\); return c && c\.noProt/);
  const a = app.slice(app.indexOf('window.cerrarSesionAjenaV1 = async function'), app.indexOf('async function cerrarPorInactividad()'));
  assert.match(a, /sinClave: true/); assert.match(a, /if \(await liberarCacheLocalAlCerrarSesionV1\(\)\) break;/); assert.match(a, /r === 'cancelar'\) return 'cancelada'/); assert.doesNotMatch(a, /conservar/);
  assert.match(mod, /w\.cerrarSesionAjenaV1\(\)/); assert.doesNotMatch(mod, /Sus datos locales NO se pueden cifrar \(no tenés su contraseña\) y quedan en este navegador/);
  assert.match(mod, /S\.esAdminSesion\(\) && S\.recolectarAjenos\(uid\)\.n/); assert.match(mod, /esAdmin: function \(\) \{ try \{ return typeof backendEsAdminOwner !== 'undefined' && backendEsAdminOwner === true;/);
  assert.match(app, /sellarConSesion\(extraAuto, \{ noProt: window\.cardiolinkOutboxR2D\?\.noProtegidos\?\.\(\) \|\| \[\] \}\)/);
});

test('cerrar sesión NO purga la caché como «todo confirmado» si hay cambios de configuración sin guardar, cambios que no viajan en la cola u operaciones en la cola (se perdía un cambio clínico sólo presente en la caché)', () => {
  const app = leer('app.js'), l = app.slice(app.indexOf('async function liberarCacheLocalAlCerrarSesionV1(auto)'), app.indexOf('// ---- Identidad profesional'));
  assert.match(l, /const pendiente=\(typeof window\.hayPendientesSync298==='function'\?window\.hayPendientesSync298\(\):true\)\|\|otrosPendientesCierreV1\(\);/);
  assert.match(l, /r1\.configPendiente&&typeof gcfg==='function'\) await Promise\.race/, 'antes de decidir se intenta guardar la configuración pendiente');
  const f = app.slice(app.indexOf('function otrosPendientesCierreV1()'), app.indexOf('async function liberarCacheLocalAlCerrarSesionV1(auto)'));
  assert.match(f, /ob\.resumen\(\)\.length>0/); assert.match(f, /ob\.noProtegidos\(\)\.length>0/); assert.match(f, /r1\.configPendiente\|\|r1\.guardando>0/); assert.match(f, /catch\(e\)\{ return true; \}/, 'ante la duda se conserva');
  assert.ok(l.indexOf('if(pendiente){') !== -1 && l.indexOf('if(pendiente){') < l.indexOf('removeItem(k)'));
});

// ---------------- recuperación clínica explícita (la caché restaurada la pisa la carga del servidor) ----------------
const CFG_SELLADA = { resumenesClinicos: { p1: { antecedentes: 'CAMBIO-CLINICO-OFFLINE', actualizadoEn: '2026-11-19T02:00:00Z' }, p2: { antecedentes: 'viejo', actualizadoEn: '2026-01-01T00:00:00Z' }, p3: { antecedentes: 'igual', actualizadoEn: '2026-05-01T00:00:00Z' } },
  documentosClinicos: [{ id: 'dA', contenido: 'DOC-SOLO-LOCAL' }, { id: 'dB', contenido: 'ya-en-servidor' }], evolucionesClinicas: [{ id: 'eA', evolucion: 'EVO-SOLO-LOCAL' }] };
const CFG_VIVA = () => ({ resumenesClinicos: { p1: { antecedentes: 'servidor', actualizadoEn: '2026-11-01T00:00:00Z' }, p2: { antecedentes: 'nuevo-servidor', actualizadoEn: '2026-11-10T00:00:00Z' }, p3: { antecedentes: 'igual', actualizadoEn: '2026-05-01T00:00:00Z' } }, documentosClinicos: [{ id: 'dB', contenido: 'ya-en-servidor' }], evolucionesClinicas: [] });

test('plan de recuperación clínica: agrega lo que falta, actualiza un resumen SÓLO si lo sellado es más reciente, no pisa lo igual o más nuevo del servidor ni documentos/evoluciones existentes', () => {
  const { S } = entorno(); const plan = S.planRecuperacionClinica(CFG_SELLADA, CFG_VIVA());
  assert.deepEqual(plan.ops.map((o) => [o.tipo, o.accion, o.clave]), [['resumen', 'actualizar', 'p1'], ['documento', 'agregar', 'dA'], ['evolucion', 'agregar', 'eA']]); assert.equal(plan.omitidos, 1, 'p2: el servidor es más reciente');
  const viva = CFG_VIVA(); S.aplicarRecuperacionClinica(viva, plan.ops);
  assert.equal(viva.resumenesClinicos.p1.antecedentes, 'CAMBIO-CLINICO-OFFLINE'); assert.equal(viva.resumenesClinicos.p2.antecedentes, 'nuevo-servidor'); assert.deepEqual(viva.documentosClinicos.map((d) => d.id), ['dB', 'dA']); assert.deepEqual(viva.evolucionesClinicas.map((d) => d.id), ['eA']);
  S.aplicarRecuperacionClinica(viva, plan.ops); assert.equal(viva.documentosClinicos.length, 2, 'idempotente: no duplica');
  assert.equal(S.planRecuperacionClinica(CFG_VIVA(), CFG_VIVA()).ops.length, 0, 'sin diferencias no hay nada que ofrecer');
});

test('paquete con cambios no protegidos: la caché NO se restaura sola; la config sellada se entrega para la recuperación explícita y el paquete se CONSERVA hasta que el usuario decida', async () => {
  const e = entorno({ cardiolink_config_v25: JSON.stringify(CFG_SELLADA), cardiolink_cache_owner_v1: 'u1' });
  const mat = await e.S.materialDe('pw'); assert.equal((await e.S.sellarUsuario('u1', mat, EXTRA, { noProt: ['resumenesClinicos', 'profesionales[matias].logo'] })).ok, true);
  assert.equal(e.A.getItem('cardiolink_config_v25'), null);
  const ab = await e.S.abrirSellados('u1', mat);
  assert.equal(e.A.getItem('cardiolink_config_v25'), null, 'no se restaura la caché (la carga del servidor la pisaría)'); assert.equal(ab.recuperaciones.length, 1); assert.deepEqual(ab.recuperaciones[0].noProt, ['resumenesClinicos', 'profesionales[matias].logo']);
  assert.equal(JSON.parse(ab.recuperaciones[0].config).resumenesClinicos.p1.antecedentes, 'CAMBIO-CLINICO-OFFLINE'); assert.equal(await e.S.contarSellados('u1'), 1, 'el paquete sigue hasta que el usuario decida');
  await e.S.liberarPaquete(ab.recuperaciones[0].id); assert.equal(await e.S.contarSellados('u1'), 0);
  const e2 = entorno({ cardiolink_config_v25: JSON.stringify(CFG_SELLADA) }); const m2 = await e2.S.materialDe('pw'); await e2.S.sellarUsuario('u1', m2, EXTRA);
  assert.equal((await e2.S.abrirSellados('u1', m2)).recuperaciones.length, 0, 'sin marca de cambios no protegidos no hay recuperación (la cola cubre el resto)'); assert.equal(await e2.S.contarSellados('u1'), 0);
});

test('integración estática: la recuperación clínica espera la primera carga del servidor, ofrece aplicar/descartar/después y confirma el guardado antes de liberar el paquete', () => {
  const mod = leer('cardiolink-seguridad-local-v1.js');
  assert.match(mod, /w\.cardiolinkPersistenciaR1\.estado\(\)\.primeraCarga/); assert.match(mod, /Aplicar y guardar/); assert.match(mod, /Descartar \(se pierden\)/); assert.match(mod, /Decidir después/);
  assert.match(mod, /if \(ok === false\) \{ w\.alert\('Se aplicaron en este equipo pero NO se pudieron confirmar en el servidor\. El paquete cifrado se conserva/);
  assert.match(mod, /if \(!imagenes\.length\) S\.liberarPaquete\(r\.id\); mm\.remove\(\);/, 'con imágenes pendientes el paquete se conserva');
  assert.doesNotMatch(mod.replace(/\/\/.*$/gm, ''), /cachesRestauradas\+\+/, 'ya no se restauran cachés completas');
});
