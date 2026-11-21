'use strict';

// tests/carga-paginada-v1.js
// Carga paginada V1 (padrón compartido): cardiolink-carga-paginada-v1.js + su integración en app.js (cargar410 / carga de atenciones).
// Ejecuta el código REAL del módulo contra un PostgREST SIMULADO (límite de 1000 filas por consulta, orden, `gt`, `neq`, count exacto, errores, cambios entre páginas).
// Sin red ni Supabase real. Requisito: Node ≥ 18 (sólo módulos nativos).
//   node tests/carga-paginada-v1.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const api = require(path.join(root, 'cardiolink-carga-paginada-v1.js'));
const SRC = fs.readFileSync(path.join(root, 'cardiolink-carga-paginada-v1.js'), 'utf8');
const APP = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// ---------- PostgREST simulado ----------
function fakeSb(tablas, o) {
  o = o || {};
  const cap = o.cap || 1000, log = [];
  const sb = {
    log,
    from(tabla) {
      const q = { tabla, filtros: [], orden: null, limite: null, cuenta: false, cols: '*' };
      const b = {
        select(cols, opt) { q.cols = cols; q.cuenta = !!(opt && opt.count === 'exact'); return b; },
        neq(c, v) { q.filtros.push(['neq', c, v]); return b; },
        gt(c, v) { q.filtros.push(['gt', c, v]); return b; },
        order(c, opt) { q.orden = [c, !(opt && opt.ascending === false)]; return b; },
        limit(n) { q.limite = n; return b; },
        then(ok, ko) { return ejecutar().then(ok, ko); },
      };
      async function ejecutar() {
        const n = log.length; log.push({ tabla, filtros: q.filtros.slice(), orden: q.orden, limite: q.limite, cuenta: q.cuenta });
        if (o.hook) o.hook(n, tablas);
        if (o.fallar) { const e = o.fallar(n, q); if (e) return { data: null, error: e, count: null }; }
        if (o.siempreLoMismo) return { data: tablas[tabla].slice(0, 5), error: null, count: null };
        let filas = tablas[tabla].slice();
        for (const [op, c, v] of q.filtros) filas = filas.filter(r => op === 'neq' ? r[c] !== v : r[c] > v);
        if (q.orden) { const [c, asc] = q.orden; filas.sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (asc ? 1 : -1)); }
        const total = filas.length;
        const lim = Math.min(q.limite == null ? cap : q.limite, cap);
        return { data: filas.slice(0, lim).map(r => JSON.parse(JSON.stringify(r))), error: null, count: (q.cuenta && !o.sinCount) ? total : null };
      }
      return b;
    },
  };
  return sb;
}
const sinEspera = () => Promise.resolve();
const pacientes = (n) => Array.from({ length: n }, (_, i) => ({ id: 'pac_' + String(i + 1).padStart(5, '0'), nombre_completo: 'P' + (i + 1) }));
const pide = (sb, extra) => api.leerTodo(Object.assign({ sb, tabla: 'p', esperar: sinEspera }, extra || {}));
const solo = (r) => (r.data || []).map(x => x.id);

let ok = 0, fail = 0;
const pendientes = [];
function t(nombre, fn) { pendientes.push([nombre, fn]); }

t('A · 1100 pacientes con tope de 1000: se leen TODOS, en 2 consultas, sin repetir ni omitir', async () => {
  const sb = fakeSb({ p: pacientes(1100) });
  const r = await pide(sb);
  assert.equal(r.error, null); assert.equal(r.completo, true); assert.equal(r.data.length, 1100); assert.equal(r.total, 1100);
  assert.equal(new Set(solo(r)).size, 1100); assert.equal(r.paginas, 2); assert.equal(sb.log.length, 2);
  assert.deepEqual(solo(r), pacientes(1100).map(x => x.id));
});
t('B · 1055 pacientes (Production): los 55 de la cola llegan', async () => {
  const sb = fakeSb({ p: pacientes(1055) }); const r = await pide(sb);
  assert.equal(r.data.length, 1055); assert.ok(solo(r).includes('pac_01055')); assert.ok(solo(r).includes('pac_01001'));
});
t('C · menos de 1000: UNA sola consulta (sin costo extra)', async () => {
  const sb = fakeSb({ p: pacientes(670) }); const r = await pide(sb);
  assert.equal(r.data.length, 670); assert.equal(sb.log.length, 1); assert.equal(r.paginas, 1);
});
t('D · exactamente 1000: una consulta (el total informado demuestra que terminó)', async () => {
  const sb = fakeSb({ p: pacientes(1000) }); const r = await pide(sb);
  assert.equal(r.data.length, 1000); assert.equal(sb.log.length, 1); assert.equal(r.completo, true);
});
t('E · 2500 filas: 3 páginas', async () => {
  const sb = fakeSb({ p: pacientes(2500) }); const r = await pide(sb);
  assert.equal(r.data.length, 2500); assert.equal(sb.log.length, 3); assert.equal(new Set(solo(r)).size, 2500);
});
t('F · el servidor corta ANTES de lo pedido (500 por consulta): aprende el corte y lee todo', async () => {
  const sb = fakeSb({ p: pacientes(1300) }, { cap: 500 }); const r = await pide(sb);
  assert.equal(r.data.length, 1300); assert.equal(sb.log.length, 3); assert.equal(r.completo, true);
});
t('G · sin count del servidor y exactamente 1000: la página vacía demuestra el fin', async () => {
  const sb = fakeSb({ p: pacientes(1000) }, { sinCount: true }); const r = await pide(sb);
  assert.equal(r.data.length, 1000); assert.equal(r.completo, true); assert.equal(sb.log.length, 2);
});
t('H · tabla vacía', async () => {
  const sb = fakeSb({ p: [] }); const r = await pide(sb);
  assert.deepEqual(r.data, []); assert.equal(r.completo, true); assert.equal(r.error, null);
});
t('I · orden determinista por clave y cursor `gt`: cada página pide order id ASC y limit', async () => {
  const sb = fakeSb({ p: pacientes(1055) }); await pide(sb);
  assert.deepEqual(sb.log[0].orden, ['id', true]); assert.equal(sb.log[0].limite, 1000); assert.equal(sb.log[0].cuenta, true);
  assert.equal(sb.log[0].filtros.length, 0);
  assert.deepEqual(sb.log[1].filtros, [['gt', 'id', 'pac_01000']]); assert.equal(sb.log[1].cuenta, false);
});
t('J · una fila EDITADA entre páginas (mismo id) no se repite ni se pierde', async () => {
  const tablas = { p: pacientes(1500) };
  const sb = fakeSb(tablas, { hook(n, tb) { if (n === 1) { const x = tb.p.splice(10, 1)[0]; x.nombre_completo = 'EDITADO'; tb.p.push(x); } } });   // se «mueve al final» como en Postgres
  const r = await pide(sb);
  assert.equal(r.data.length, 1500); assert.equal(new Set(solo(r)).size, 1500);
});
t('K · una fila CREADA entre páginas no genera repetidos; las existentes siguen completas', async () => {
  const tablas = { p: pacientes(1500) };
  const sb = fakeSb(tablas, { hook(n, tb) { if (n === 1) tb.p.push({ id: 'pac_09999', nombre_completo: 'NUEVO' }); } });
  const r = await pide(sb);
  assert.equal(new Set(solo(r)).size, r.data.length); assert.ok(r.data.length >= 1500);
  assert.deepEqual(solo(r).filter(i => i <= 'pac_01500'), pacientes(1500).map(x => x.id));
});
t('L · una fila BORRADA entre páginas: se lee igual y termina', async () => {
  const tablas = { p: pacientes(1500) };
  const sb = fakeSb(tablas, { hook(n, tb) { if (n === 1) tb.p.splice(1200, 5); } });
  const r = await pide(sb);
  assert.equal(r.completo, true); assert.equal(new Set(solo(r)).size, r.data.length); assert.equal(r.data.length, 1495);
});
t('M · error TRANSITORIO en la página 2: se reintenta la MISMA página y no hay repetidos', async () => {
  const sb = fakeSb({ p: pacientes(1500) }, { fallar: (n) => (n === 1 ? { code: '57014', message: 'timeout' } : null) });
  const r = await pide(sb);
  assert.equal(r.error, null); assert.equal(r.data.length, 1500); assert.equal(new Set(solo(r)).size, 1500); assert.equal(sb.log.length, 3);
  assert.deepEqual(sb.log[1].filtros, sb.log[2].filtros);   // mismo cursor
});
t('N · error PERSISTENTE: devuelve error y data=null (nunca una carga parcial como completa)', async () => {
  const sb = fakeSb({ p: pacientes(1500) }, { fallar: (n) => (n >= 1 ? { code: '57014', message: 'timeout' } : null) });
  const r = await pide(sb);
  assert.ok(r.error); assert.equal(r.data, null); assert.equal(r.completo, false); assert.equal(r.parcial, 1000);
  assert.equal(sb.log.length, 1 + 1 + api.REINTENTOS);   // 1.ª página + página 2 con sus reintentos
});
t('O · error de PERMISO/sesión: no se reintenta', async () => {
  const sb = fakeSb({ p: pacientes(10) }, { fallar: () => ({ code: '42501', message: 'permission denied' }) });
  const r = await pide(sb); assert.ok(r.error); assert.equal(r.data, null); assert.equal(sb.log.length, 1);
  const sb2 = fakeSb({ p: pacientes(10) }, { fallar: () => ({ message: 'JWT expired', status: 401 }) });
  const r2 = await pide(sb2); assert.equal(sb2.log.length, 1); assert.equal(r2.data, null);
});
t('P · una excepción de red no escapa: se informa como error sin datos', async () => {
  const sb = { from() { throw new Error('fetch failed'); } };
  const r = await pide(sb, { reintentos: 1 }); assert.ok(r.error); assert.equal(r.data, null); assert.equal(r.completo, false);
});
t('Q · guarda contra bucle: si la clave no avanza se detiene con error', async () => {
  const sb = fakeSb({ p: pacientes(2000) }, { siempreLoMismo: true });
  const r = await pide(sb); assert.ok(r.error); assert.equal(r.error.code, 'CARGA_SIN_AVANCE'); assert.equal(r.data, null); assert.ok(sb.log.length <= 3);
});
t('R · máximo de páginas', async () => {
  const sb = fakeSb({ p: pacientes(2500) }, { cap: 100 });
  const r = await pide(sb, { maxPaginas: 5 }); assert.equal(r.error.code, 'CARGA_MAX_PAGINAS'); assert.equal(r.data, null);
});
t('S · sin clave en las filas: error claro', async () => {
  const sb = fakeSb({ p: [{ x: 1 }] }); const r = await pide(sb); assert.equal(r.error.code, 'CARGA_SIN_CLAVE'); assert.equal(r.data, null);
});
t('T · sin solicitudes duplicadas: dos llamadas simultáneas con la misma etiqueta comparten una lectura', async () => {
  const sb = fakeSb({ p: pacientes(1055) });
  const [a, b] = await Promise.all([pide(sb, { dedup: 'pac' }), pide(sb, { dedup: 'pac' })]);
  assert.equal(sb.log.length, 2); assert.equal(a, b);
  const c = await pide(sb, { dedup: 'pac' }); assert.equal(sb.log.length, 4);   // terminada la primera, una nueva lectura SÍ consulta
});
t('U · filtro (excluir la fila de configuración) y orden final «más reciente primero»', async () => {
  const filas = [{ id: '__cardiolink_config_v1', updated_at: '2026-11-21T10:00:00Z' }];
  for (let i = 1; i <= 1200; i++) filas.push({ id: 'att_' + String(i).padStart(5, '0'), updated_at: new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString(), payload: { n: i } });
  const sb = fakeSb({ a: filas });
  const r = await api.leerTodo({ sb, tabla: 'a', columnas: 'id,payload,updated_at', filtro: q => q.neq('id', '__cardiolink_config_v1'), ordenar: api.masRecientePrimero('updated_at', 'id'), esperar: sinEspera });
  assert.equal(r.data.length, 1200); assert.ok(!solo(r).includes('__cardiolink_config_v1'));
  assert.equal(r.data[0].id, 'att_01200'); assert.equal(r.data[1199].id, 'att_00001');
  assert.ok(sb.log.every(l => l.filtros.some(f => f[0] === 'neq')));
  const sb2 = fakeSb({ a: filas }); const r2 = await api.leerTodo({ sb: sb2, tabla: 'a', columnas: 'id,payload,updated_at', esperar: sinEspera });
  assert.equal(r2.data.length, 1201); assert.ok(solo(r2).includes('__cardiolink_config_v1'));
});
t('V · SÓLO LECTURA: el módulo no usa nada que escriba (fuente y accesos al cliente)', async () => {
  assert.ok(!/\.(insert|upsert|update|delete|rpc)\s*\(/.test(SRC), 'el módulo no debe escribir');
  const tocados = [];
  const sb = { from(t) { return new Proxy({}, { get(_, k) { tocados.push(k); if (k === 'then') return undefined; return () => new Proxy({}, { get: (__, k2) => { tocados.push(k2); if (k2 === 'then') return (ok) => ok({ data: [], error: null, count: 0 }); return () => ({ then: (ok) => ok({ data: [], error: null, count: 0 }), select() { return this; } }); } }); } }); } };
  try { await pide(sb); } catch (e) {}
  assert.ok(!tocados.some(k => ['insert', 'upsert', 'update', 'delete', 'rpc'].includes(k)), 'tocó ' + tocados.join(','));
});
t('W · integración estática: cargar410 y la carga de atenciones usan la lectura paginada (con respaldo si el módulo no cargó)', async () => {
  assert.match(APP, /cardiolinkCargaPaginadaV1[\s\S]{0,400}tabla:'cardiolink_pacientes'/);
  assert.match(APP, /tabla:'cardiolink_atenciones'[\s\S]{0,300}masRecientePrimero\('updated_at','id'\)/);
  assert.match(APP, /pa\.completo!==true\)throw/);                          // una lectura sin demostrar completa NO se aplica
  assert.match(APP, /aplicarCarga410\(pa\.data\|\|\[\],re\.data\|\|\[\],ev\.data\|\|\[\],true\)/);   // la regla R3 (fichas ausentes) sólo corre tras una lectura completa
  assert.doesNotMatch(APP, /\(pa\.data\|\|\[\]\)\.length<1000\)\{const idsRel/);   // ya no se infiere «completo» del largo (1000 = tope)
  const i = INDEX.indexOf('cardiolink-carga-paginada-v1.js'); assert.ok(i > 0, 'index.html carga el módulo');
  assert.ok(i < INDEX.indexOf('app.js?v='), 'el módulo carga antes de app.js');
  assert.match(INDEX, /cardiolink-carga-paginada-v1\.js\?v=pag-1/);
});
t('X · lo que NO cambia: resumen y evoluciones siguen igual; las lecturas por id de atenciones/evoluciones no se tocan', async () => {
  assert.match(APP, /from\('cardiolink_hc_resumen'\)\.select\('\*'\)/); assert.match(APP, /from\('cardiolink_hc_evoluciones'\)\.select\('\*'\)\.order\('fecha_hora'/);
  assert.match(APP, /id,editado_en,creado_en,motivo,evolucion/);
});

t('Y · arranque: la configuración descargada no deja fuera el padrón (se reaplica la última lectura completa, sin consultas nuevas)', async () => {
  assert.match(APP, /function reaplicarCarga410\(\)/);
  assert.match(APP, /c\.dataRef===data&&c\.pacRef===data\.pacientes/);        // sólo si `data` fue reemplazado
  assert.match(APP, /aplicarCarga410\(c\.pa,c\.re,c\.ev,false\)/);              // sin R3 (una copia en memoria no decide ausencias)
  const f = APP.slice(APP.indexOf('function reaplicarCarga410'), APP.indexOf('let carga410=null'));
  assert.ok(!/supabaseClient|\.from\(|leerTodo|fetch\(/.test(f), 'reaplicar no consulta ni escribe en el servidor');
  assert.match(APP, /eraPrimera298[\s\S]{0,200}reaplicarCarga/);                  // sólo en la primera carga de la sesión: sin refrescos repetitivos
  assert.match(APP, /reaplicarCarga:reaplicarCarga410/);
});
t('Z · fallo de la paginación: nada parcial se aplica, se mantiene lo último confirmado y sólo sin copia completa se avisa', async () => {
  assert.match(APP, /if\(carga410\)return carga410;/);                              // una sola lectura en curso (sin consultas duplicadas)
  assert.match(APP, /if\(!hayPadronConfirmado410\(\)\)mostrarAvisoPadron410\(\);\s*return false;/);
  assert.match(APP, /No se pudo completar la carga de pacientes\./);
  assert.match(APP, /select\('\*',\{count:'exact'\}\);\s*if\(r\.error\)return \{data:null/);     // sin el módulo: sólo vale con el conteo exacto
  assert.match(APP, /CARGA_INCOMPLETA/);                                              // atenciones sin el módulo: lo truncado no se presenta como completo
  assert.match(APP, /okRel382===false[\s\S]{0,800}return;/);                          // «Sincronizar ahora» no marca sincronizado si la carga falló
  assert.match(APP, /okRel382===false\)\{\s*try\{ if\(ultimaSync382===null\)localStorage\.removeItem\('cl_last_sync_382'\)/);   // y la «última sincronización» no avanza
  assert.ok(APP.indexOf("localStorage.setItem('cl_last_sync_382',String(Date.now()));", APP.indexOf('okRel382===false')) > APP.indexOf('okRel382===false'));
  assert.match(APP, /cardiolink_padron_completo_v1:'\+new URL\(SUPABASE_URL\)[\s\S]{0,80}\/\/ marca|k\.push\('cardiolink_padron_completo_v1/);   // se purga al cerrar sesión
});

(async () => {
  for (const [nombre, fn] of pendientes) {
    try { await fn(); ok++; console.log('  OK  ' + nombre); } catch (e) { fail++; console.log('FALLA ' + nombre + '\n      ' + (e && e.message || e)); }
  }
  console.log('\ncarga-paginada-v1: ' + ok + '/' + (ok + fail) + ' pruebas OK');
  if (fail && typeof process !== 'undefined') process.exitCode = 1;
})();
