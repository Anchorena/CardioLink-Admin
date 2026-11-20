'use strict';
// Guardado clínico multidispositivo · pruebas del resumen clínico (Supabase simulado en memoria; el UPDATE condicionado se evalúa de forma atómica como lo hace Postgres).
// Ejecutar: node --test cardiolink-hc-resumen-v1.test.cjs
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const R = require('./cardiolink-hc-resumen-v1.js');
const clon = (o) => JSON.parse(JSON.stringify(o));

function entorno(filaInicial) {
  const tabla = new Map(); let reloj = 1000; const tic = () => new Date(Date.UTC(2026, 10, 20, 12, 0, 0, reloj++)).toISOString();
  const rastro = { lecturas: 0, updates: 0, updatesEfectivos: 0, inserts: 0, ultimoUpdate: null }; const hooks = { antesDeUpdate: null, errorUpdate: null, errorInsert: null, errorLectura: null, pausaLectura: false };
  if (filaInicial) tabla.set(filaInicial.paciente_id, Object.assign({ actualizado_en: tic(), actualizado_por: 'x' }, filaInicial));
  const sb = {
    from(t) {
      assert.equal(t, 'cardiolink_hc_resumen');
      const q = { op: 'select', f: [], valores: null };
      const api = {
        select() { return api; }, limit() { return api; },
        eq(k, v) { q.f.push(['eq', k, v]); return api; }, is(k, v) { q.f.push(['is', k, v]); return api; },
        update(v) { q.op = 'update'; q.valores = v; return api; }, insert(v) { q.op = 'insert'; q.valores = v; return api; },
        upsert() { throw new Error('PROHIBIDO: upsert del resumen'); },
        then(res, rej) { return Promise.resolve(ejecutar()).then(res, rej); }
      };
      const coincide = (fila) => q.f.every(([op, k, v]) => (op === 'eq' ? fila[k] != null && String(fila[k]) === String(v) : fila[k] == null));
      async function ejecutar() {
        if (q.op === 'select') {
          rastro.lecturas++; if (hooks.errorLectura) return { data: null, error: hooks.errorLectura };
          const r = [...tabla.values()].filter(coincide).map(clon);
          if (hooks.pausaLectura) await new Promise((x) => setImmediate(x));      // permite que dos sesiones lean ANTES de que cualquiera escriba
          return { data: r, error: null };
        }
        if (q.op === 'insert') {
          rastro.inserts++; if (hooks.errorInsert) { const e = hooks.errorInsert; if (e.una) hooks.errorInsert = null; return { data: null, error: e }; }
          const f = q.valores[0]; if (tabla.has(f.paciente_id)) return { data: null, error: { code: '23505', message: 'duplicate key' } };
          tabla.set(f.paciente_id, clon(f)); return { data: [clon(f)], error: null };
        }
        rastro.updates++; rastro.ultimoUpdate = { valores: clon(q.valores), filtros: clon(q.f) };
        if (hooks.antesDeUpdate) { const h = hooks.antesDeUpdate; if (!h.siempre) hooks.antesDeUpdate = null; (h.fn || h)(); }
        if (hooks.errorUpdate) return { data: null, error: hooks.errorUpdate };
        const objetivo = [...tabla.values()].filter(coincide); if (!objetivo.length) return { data: [], error: null };   // CONDICIÓN EFECTIVA: 0 filas = otra sesión escribió
        rastro.updatesEfectivos++; const nuevo = Object.assign({}, objetivo[0], q.valores); tabla.set(nuevo.paciente_id, nuevo); return { data: [clon(nuevo)], error: null };
      }
      return api;
    }
  };
  return { sb, tabla, rastro, hooks, ahora: tic, remoto(id, cambios) { const f = tabla.get(id); tabla.set(id, Object.assign({}, f, cambios, { actualizado_en: tic() })); } };
}
const fila = (extra) => Object.assign({ paciente_id: 'p1', antecedentes: 'HTA', alergias: 'penicilina', medicacion_habitual: 'enalapril', alertas: '' }, extra);
const vista = (f) => R.desdeFila(f);

test('abrir o guardar SIN cambios no lee ni escribe', async () => {
  const E = entorno(fila()); const base = vista(E.tabla.get('p1'));
  const r = await R.guardarResumen({ sb: E.sb, id: 'p1', base, nuevo: Object.assign({}, base, { alergias: '  penicilina ' }), ahora: E.ahora });
  assert.equal(r.estado, 'sin_cambios'); assert.equal(E.rastro.lecturas, 0); assert.equal(E.rastro.updates + E.rastro.inserts, 0);
});

test('escribe SÓLO el campo cambiado, con UPDATE condicionado a actualizado_en (compare-and-swap)', async () => {
  const E = entorno(fila()); const f0 = E.tabla.get('p1'); const base = vista(f0);
  const r = await R.guardarResumen({ sb: E.sb, id: 'p1', base, nuevo: Object.assign({}, base, { alergias: 'penicilina, látex' }), usuario: 'Dr. A', ahora: E.ahora });
  assert.equal(r.estado, 'confirmado'); assert.deepStrictEqual(r.aplicados, ['alergias']);
  assert.deepStrictEqual(Object.keys(E.rastro.ultimoUpdate.valores).sort(), ['actualizado_en', 'actualizado_por', 'alergias'], 'no se envían los campos que no se tocaron');
  assert.ok(E.rastro.ultimoUpdate.filtros.some(([op, k, v]) => op === 'eq' && k === 'actualizado_en' && v === f0.actualizado_en), 'condición de concurrencia efectiva');
  const f = E.tabla.get('p1'); assert.equal(f.alergias, 'penicilina, látex'); assert.equal(f.antecedentes, 'HTA'); assert.equal(f.medicacion_habitual, 'enalapril'); assert.equal(f.actualizado_por, 'Dr. A');
  assert.equal(E.rastro.updates, 1);
});

test('dos dispositivos cambian datos DIFERENTES: se conservan ambos, sin conflicto ni aviso', async () => {
  const E = entorno(fila()); const baseA = vista(E.tabla.get('p1')), baseB = vista(E.tabla.get('p1'));   // los dos abrieron la misma versión
  const a = await R.guardarResumen({ sb: E.sb, id: 'p1', base: baseA, nuevo: Object.assign({}, baseA, { alergias: 'sin alergias conocidas' }), ahora: E.ahora });
  const b = await R.guardarResumen({ sb: E.sb, id: 'p1', base: baseB, nuevo: Object.assign({}, baseB, { medicacion: 'enalapril 10 mg, aspirina' }), ahora: E.ahora });
  assert.equal(a.estado, 'confirmado'); assert.equal(b.estado, 'confirmado'); assert.deepStrictEqual(b.conflictos, []);
  const f = E.tabla.get('p1'); assert.equal(f.alergias, 'sin alergias conocidas'); assert.equal(f.medicacion_habitual, 'enalapril 10 mg, aspirina'); assert.equal(f.antecedentes, 'HTA');
});

test('dispositivo con datos viejos NO pisa lo reciente si no modificó ese campo', async () => {
  const E = entorno(fila()); const baseVieja = vista(E.tabla.get('p1'));
  E.remoto('p1', { alergias: 'AINES', antecedentes: 'HTA, DBT' });                       // otro dispositivo guardó dos datos
  const r = await R.guardarResumen({ sb: E.sb, id: 'p1', base: baseVieja, nuevo: Object.assign({}, baseVieja, { medicacion: 'losartán' }), ahora: E.ahora });
  assert.equal(r.estado, 'confirmado'); const f = E.tabla.get('p1');
  assert.equal(f.alergias, 'AINES'); assert.equal(f.antecedentes, 'HTA, DBT'); assert.equal(f.medicacion_habitual, 'losartán');
});

test('MISMO dato con valores distintos: no se pisa, se devuelve el conflicto y lo demás se guarda', async () => {
  const E = entorno(fila()); const base = vista(E.tabla.get('p1'));
  E.remoto('p1', { alergias: 'AINES' });
  const r = await R.guardarResumen({ sb: E.sb, id: 'p1', base, nuevo: Object.assign({}, base, { alergias: 'látex', medicacion: 'losartán' }), ahora: E.ahora });
  assert.equal(r.estado, 'conflicto'); assert.equal(r.conflictos.length, 1);
  assert.deepStrictEqual(r.conflictos[0], { campo: 'alergias', etiqueta: 'Alergias', remoto: 'AINES', mio: 'látex' });
  const f = E.tabla.get('p1'); assert.equal(f.alergias, 'AINES', 'no se sobrescribió'); assert.equal(f.medicacion_habitual, 'losartán', 'el dato sin conflicto sí quedó guardado');
});

test('«Guardar mi modificación»: se pisa SÓLO si el valor guardado sigue siendo el que se mostró; si cambió otra vez, se vuelve a preguntar', async () => {
  const E = entorno(fila()); const base = vista(E.tabla.get('p1')); E.remoto('p1', { alergias: 'AINES' });
  const nuevo = Object.assign({}, base, { alergias: 'látex' });
  const ok = await R.guardarResumen({ sb: E.sb, id: 'p1', base, nuevo, resolucion: { alergias: 'AINES' }, ahora: E.ahora });
  assert.equal(ok.estado, 'confirmado'); assert.equal(E.tabla.get('p1').alergias, 'látex'); assert.equal(E.rastro.ultimoUpdate.valores.alergias, 'látex');
  const E2 = entorno(fila()); const base2 = vista(E2.tabla.get('p1')); E2.remoto('p1', { alergias: 'AINES' });
  E2.hooks.antesDeUpdate = () => E2.remoto('p1', { alergias: 'yodo' });                    // un tercer cambio llega mientras se confirma
  const r2 = await R.guardarResumen({ sb: E2.sb, id: 'p1', base: base2, nuevo: Object.assign({}, base2, { alergias: 'látex' }), resolucion: { alergias: 'AINES' }, ahora: E2.ahora });
  assert.equal(r2.estado, 'conflicto'); assert.equal(r2.conflictos[0].remoto, 'yodo'); assert.equal(E2.tabla.get('p1').alergias, 'yodo');
});

test('«Conservar lo guardado»: el dato no se escribe y no vuelve a preguntar; lo demás se guarda', async () => {
  const E = entorno(fila()); const base = vista(E.tabla.get('p1')); E.remoto('p1', { alergias: 'AINES' });
  const r = await R.guardarResumen({ sb: E.sb, id: 'p1', base, nuevo: Object.assign({}, base, { alergias: 'látex', medicacion: 'losartán' }), omitir: ['alergias'], ahora: E.ahora });
  assert.equal(r.estado, 'confirmado'); assert.deepStrictEqual(r.omitidos, ['alergias']); const f = E.tabla.get('p1'); assert.equal(f.alergias, 'AINES'); assert.equal(f.medicacion_habitual, 'losartán');
});

test('otra sesión escribe ENTRE la lectura y el UPDATE: el UPDATE afecta 0 filas, se relee y se fusiona (nada se pierde)', async () => {
  const E = entorno(fila()); const base = vista(E.tabla.get('p1'));
  E.hooks.antesDeUpdate = () => E.remoto('p1', { antecedentes: 'HTA, DBT' });
  const r = await R.guardarResumen({ sb: E.sb, id: 'p1', base, nuevo: Object.assign({}, base, { alergias: 'látex' }), ahora: E.ahora });
  assert.equal(r.estado, 'confirmado'); assert.equal(E.rastro.updates, 2); assert.equal(E.rastro.updatesEfectivos, 1, 'el primer UPDATE no escribió nada');
  const f = E.tabla.get('p1'); assert.equal(f.antecedentes, 'HTA, DBT'); assert.equal(f.alergias, 'látex');
});

test('la carrera sobre EL MISMO dato termina en conflicto, no en pérdida silenciosa', async () => {
  const E = entorno(fila()); const base = vista(E.tabla.get('p1'));
  E.hooks.antesDeUpdate = () => E.remoto('p1', { alergias: 'AINES' });
  const r = await R.guardarResumen({ sb: E.sb, id: 'p1', base, nuevo: Object.assign({}, base, { alergias: 'látex' }), ahora: E.ahora });
  assert.equal(r.estado, 'conflicto'); assert.equal(E.tabla.get('p1').alergias, 'AINES'); assert.equal(E.rastro.updatesEfectivos, 0);
});

test('DOS GUARDADOS SIMULTÁNEOS de datos distintos: ambos persisten (atomicidad por compare-and-swap)', async () => {
  const E = entorno(fila()); E.hooks.pausaLectura = true; const base = vista(E.tabla.get('p1'));
  const [a, b] = await Promise.all([
    R.guardarResumen({ sb: E.sb, id: 'p1', base, nuevo: Object.assign({}, base, { alergias: 'látex' }), ahora: E.ahora }),
    R.guardarResumen({ sb: E.sb, id: 'p1', base, nuevo: Object.assign({}, base, { medicacion: 'losartán' }), ahora: E.ahora })
  ]);
  assert.equal(a.estado, 'confirmado'); assert.equal(b.estado, 'confirmado'); const f = E.tabla.get('p1');
  assert.equal(f.alergias, 'látex'); assert.equal(f.medicacion_habitual, 'losartán'); assert.equal(E.rastro.updatesEfectivos, 2); assert.ok(E.rastro.updates >= 3, 'el perdedor de la carrera reintentó');
});

test('DOS GUARDADOS SIMULTÁNEOS del MISMO dato: uno se guarda y el otro recibe el conflicto (ninguno se pierde en silencio)', async () => {
  const E = entorno(fila()); E.hooks.pausaLectura = true; const base = vista(E.tabla.get('p1'));
  const [a, b] = await Promise.all([
    R.guardarResumen({ sb: E.sb, id: 'p1', base, nuevo: Object.assign({}, base, { alergias: 'látex' }), ahora: E.ahora }),
    R.guardarResumen({ sb: E.sb, id: 'p1', base, nuevo: Object.assign({}, base, { alergias: 'yodo' }), ahora: E.ahora })
  ]);
  const estados = [a.estado, b.estado].sort(); assert.deepStrictEqual(estados, ['confirmado', 'conflicto']);
  const ganador = a.estado === 'confirmado' ? a : b, perdedor = a.estado === 'conflicto' ? a : b;
  assert.equal(E.tabla.get('p1').alergias, perdedor.conflictos[0].remoto, 'el valor guardado es el del ganador'); assert.ok(['látex', 'yodo'].includes(E.tabla.get('p1').alergias)); assert.ok(ganador.aplicados.includes('alergias'));
});

test('el resumen todavía no existe: se CREA con INSERT; si otra sesión lo crea a la vez (23505) se relee y se fusiona', async () => {
  const E = entorno(null); const base = vista(null);
  const r = await R.guardarResumen({ sb: E.sb, id: 'p9', base, nuevo: { antecedentes: 'DBT', alergias: '', medicacion: '', alertas: '' }, usuario: 'Dr. A', ahora: E.ahora });
  assert.equal(r.estado, 'confirmado'); assert.equal(r.creada, true); assert.equal(E.tabla.get('p9').antecedentes, 'DBT'); assert.equal(E.rastro.inserts, 1);
  const E2 = entorno(null); let primera = true;
  const sbOrig = E2.sb.from.bind(E2.sb); E2.sb.from = (t) => { const api = sbOrig(t); const ins = api.insert; api.insert = (v) => { if (primera) { primera = false; E2.tabla.set('p9', { paciente_id: 'p9', antecedentes: '', alergias: 'AINES', medicacion_habitual: '', alertas: '', actualizado_en: E2.ahora(), actualizado_por: 'otro' }); } return ins(v); }; return api; };
  const r2 = await R.guardarResumen({ sb: E2.sb, id: 'p9', base, nuevo: { antecedentes: 'DBT', alergias: '', medicacion: '', alertas: '' }, ahora: E2.ahora });
  assert.equal(r2.estado, 'confirmado'); assert.equal(E2.tabla.get('p9').antecedentes, 'DBT'); assert.equal(E2.tabla.get('p9').alergias, 'AINES', 'lo que cargó la otra sesión se conserva');
});

test('errores: permiso y clave foránea se informan tal cual; sin reintentos infinitos; nada se escribe a ciegas', async () => {
  const E = entorno(fila()); const base = vista(E.tabla.get('p1')); E.hooks.errorUpdate = { code: '42501', message: 'new row violates row-level security policy' };
  const r = await R.guardarResumen({ sb: E.sb, id: 'p1', base, nuevo: Object.assign({}, base, { alergias: 'x' }), ahora: E.ahora });
  assert.equal(r.estado, 'error'); assert.equal(r.permiso, true); assert.equal(E.rastro.updates, 1);
  const E2 = entorno(null); E2.hooks.errorInsert = { code: '23503', message: 'violates foreign key constraint' };
  const r2 = await R.guardarResumen({ sb: E2.sb, id: 'p1', base: vista(null), nuevo: { antecedentes: 'x', alergias: '', medicacion: '', alertas: '' }, ahora: E2.ahora });
  assert.equal(r2.estado, 'error'); assert.equal(r2.error.code, '23503');
  const E3 = entorno(fila()); E3.hooks.antesDeUpdate = { siempre: true, fn: () => E3.remoto('p1', { antecedentes: 'cambio ' + Math.random() }) };
  const r3 = await R.guardarResumen({ sb: E3.sb, id: 'p1', base: vista(E3.tabla.get('p1')), nuevo: Object.assign({}, vista(E3.tabla.get('p1')), { alergias: 'x' }), ahora: E3.ahora });
  assert.equal(r3.estado, 'error'); assert.equal(r3.reintentosAgotados, true); assert.equal(E3.rastro.updates, R.MAX_REINTENTOS); assert.notEqual(E3.tabla.get('p1').alergias, 'x');
});

test('fila con actualizado_en nulo → condición IS NULL; reloj del equipo atrasado → la marca nueva siempre es posterior', async () => {
  const E = entorno(fila({ actualizado_en: null })); E.tabla.get('p1').actualizado_en = null; const base = vista(E.tabla.get('p1'));
  const r = await R.guardarResumen({ sb: E.sb, id: 'p1', base, nuevo: Object.assign({}, base, { alergias: 'x' }), ahora: E.ahora });
  assert.equal(r.estado, 'confirmado'); assert.ok(E.rastro.ultimoUpdate.filtros.some(([op, k]) => op === 'is' && k === 'actualizado_en'));
  const E2 = entorno(fila({ actualizado_en: '2030-01-01T00:00:00.000Z' })); const b2 = vista(E2.tabla.get('p1'));
  const r2 = await R.guardarResumen({ sb: E2.sb, id: 'p1', base: b2, nuevo: Object.assign({}, b2, { alergias: 'x' }), ahora: () => '2026-11-20T12:00:00.000Z' });
  assert.equal(r2.estado, 'confirmado'); assert.ok(Date.parse(E2.tabla.get('p1').actualizado_en) > Date.parse('2030-01-01T00:00:00.000Z'));
});

// ---------- integración estática con app.js / index.html ----------
const app = fs.readFileSync(require('path').join(__dirname, 'app.js'), 'utf8'), idx = fs.readFileSync(require('path').join(__dirname, 'index.html'), 'utf8');
test('app.js: el resumen ya no se guarda con upsert de la fila completa ni con la reescritura de ficha + evoluciones', () => {
  const g = app.slice(app.indexOf('async function guardarEvolucionConfirmada410'), app.indexOf('// R3 - empujes y reintentos de la ficha'));
  assert.ok(!/from\('cardiolink_hc_resumen'\)/.test(g), 'guardarEvolucionConfirmada410 no escribe el resumen por su cuenta');
  assert.ok(/cardiolinkHcResumenV1\.guardarResumen/.test(g));
  const e = app.slice(app.indexOf('function editSummaryHC'), app.indexOf('// Fase 6, Bloque 6C: printHC() (historia clínica'));
  assert.ok(!/sincronizarPacienteCompleto/.test(e), 'el botón Editar del resumen NO reescribe la ficha ni las evoluciones');
  assert.ok(/guardarResumenConfirmado/.test(e) && /preguntarReemplazo/.test(e) && /sinCambios/.test(e));
});
test('app.js: el pedido de confirmación usa textos operativos (sin servidor / local / sincronización / divergencia)', () => {
  const m = fs.readFileSync(require('path').join(__dirname, 'cardiolink-hc-resumen-v1.js'), 'utf8');
  const textos = m.slice(m.indexOf('function preguntarReemplazo'), m.indexOf('return { CAMPOS'));
  assert.ok(/Este dato fue actualizado desde otro dispositivo\./.test(textos) && /¿Querés guardar tu modificación\?/.test(textos) && /Conservar lo guardado/.test(textos) && /Guardar mi modificación/.test(textos));
  assert.ok(!/servidor|local|divergencia|sincroniz/i.test(textos.replace(/<[^>]*>/g, '')), 'sin jerga técnica en lo que ve el médico');
});
test('index.html carga el módulo y la versión publicada coincide con la del service worker', () => {
  assert.match(idx, /<script src="cardiolink-hc-resumen-v1\.js\?v=hm-1"><\/script>/);
  assert.match(idx, /<script src="app\.js\?v=40130-hc-multidispositivo"><\/script>/);
  assert.match(fs.readFileSync(require('path').join(__dirname, 'sw.js'), 'utf8'), /app\.js\?v=40130-hc-multidispositivo/);
  assert.ok(/guardarResumenConfirmado:guardarResumenConfirmado410/.test(app));
});
