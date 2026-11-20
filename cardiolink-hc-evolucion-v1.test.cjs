'use strict';
// Guardado clínico multidispositivo · pruebas de EVOLUCIONES EXISTENTES (Supabase simulado; el UPDATE condicionado se evalúa de forma atómica como lo hace Postgres).
// Ejecutar: node --test cardiolink-hc-evolucion-v1.test.cjs
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const E = require('./cardiolink-hc-evolucion-v1.js');
const clon = (o) => JSON.parse(JSON.stringify(o));
const imc = (p, t) => { p = Number(p); t = Number(t); return p > 0 && t > 0 ? Math.round((p / Math.pow(t / 100, 2)) * 10) / 10 : null; };

function entorno(filaInicial) {
  const tabla = new Map(); let reloj = 1000; const tic = () => new Date(Date.UTC(2026, 10, 21, 12, 0, 0, reloj++)).toISOString();
  const rastro = { lecturas: 0, updates: 0, updatesEfectivos: 0, ultimoUpdate: null }; const hooks = { antesDeUpdate: null, errorUpdate: null, pausaLectura: false };
  if (filaInicial) tabla.set(filaInicial.id, Object.assign({ editado_en: tic(), editado_por: 'x' }, filaInicial));
  const sb = {
    from(t) {
      assert.equal(t, 'cardiolink_hc_evoluciones'); const q = { op: 'select', f: [], valores: null };
      const api = {
        select() { return api; }, limit() { return api; }, eq(k, v) { q.f.push(['eq', k, v]); return api; }, is(k, v) { q.f.push(['is', k, v]); return api; },
        update(v) { q.op = 'update'; q.valores = v; return api; },
        insert() { throw new Error('PROHIBIDO: insert de una evolución existente'); }, upsert() { throw new Error('PROHIBIDO: upsert de la evolución completa'); }, delete() { throw new Error('PROHIBIDO: delete'); },
        then(res, rej) { return Promise.resolve(ejecutar()).then(res, rej); }
      };
      const coincide = (fila) => q.f.every(([op, k, v]) => (op === 'eq' ? fila[k] != null && String(fila[k]) === String(v) : fila[k] == null));
      async function ejecutar() {
        if (q.op === 'select') { rastro.lecturas++; const r = [...tabla.values()].filter(coincide).map(clon); if (hooks.pausaLectura) await new Promise((x) => setImmediate(x)); return { data: r, error: null }; }
        rastro.updates++; rastro.ultimoUpdate = { valores: clon(q.valores), filtros: clon(q.f) };
        if (hooks.antesDeUpdate) { const h = hooks.antesDeUpdate; if (!h.siempre) hooks.antesDeUpdate = null; (h.fn || h)(); }
        if (hooks.errorUpdate) return { data: null, error: hooks.errorUpdate };
        const objetivo = [...tabla.values()].filter(coincide); if (!objetivo.length) return { data: [], error: null };
        rastro.updatesEfectivos++; const nuevo = Object.assign({}, objetivo[0], q.valores); tabla.set(nuevo.id, nuevo); return { data: [clon(nuevo)], error: null };
      }
      return api;
    }
  };
  return { sb, tabla, rastro, hooks, ahora: tic, remoto(id, cambios) { const f = tabla.get(id); tabla.set(id, Object.assign({}, f, cambios, { editado_en: tic() })); }, borrar(id) { tabla.delete(id); } };
}
const fila = (extra) => Object.assign({ id: 'ev1', paciente_id: 'p1', fecha_hora: '2026-11-01T10:00:00.000Z', profesional_id: 'rogelio', profesional_nombre: 'Dr. R', motivo: 'Control', evolucion: 'estable', diagnostico: 'HTA', conducta: 'seguir', peso_kg: 80, talla_cm: 175, imc: 26.1, ta_sistolica: 120, ta_diastolica: 80, frecuencia_cardiaca: 70, sato2: 98, temperatura: 36.5, creado_en: '2026-11-01T10:00:00.000Z', creado_por: 'Dr. R', origen: 'CardioLink' }, extra);
const form = (f, extra) => Object.assign({ motivo: f.motivo, evolucion: f.evolucion, diagnostico: f.diagnostico, conducta: f.conducta, pesoKg: f.peso_kg, tallaCm: f.talla_cm, taSistolica: f.ta_sistolica, taDiastolica: f.ta_diastolica, frecuenciaCardiaca: f.frecuencia_cardiaca, sato2: f.sato2 }, extra);
const base0 = (ent) => E.desdeFila(ent.tabla.get('ev1'));

test('sin cambios (incluye 80 vs "80" y espacios) no lee ni escribe', async () => {
  const X = entorno(fila()); const b = base0(X);
  const r = await E.guardarEvolucion({ sb: X.sb, id: 'ev1', base: b, nuevo: Object.assign({}, b, { pesoKg: '80', motivo: '  Control ' }), ahora: X.ahora, imc });
  assert.equal(r.estado, 'sin_cambios'); assert.equal(X.rastro.lecturas + X.rastro.updates, 0);
});

test('escribe SÓLO el campo cambiado (no fecha, profesional, creación ni temperatura) con UPDATE condicionado a editado_en', async () => {
  const X = entorno(fila()); const f0 = X.tabla.get('ev1'); const b = base0(X);
  const r = await E.guardarEvolucion({ sb: X.sb, id: 'ev1', base: b, nuevo: Object.assign({}, b, { diagnostico: 'HTA + DBT' }), usuario: 'Dr. R', ahora: X.ahora, imc });
  assert.equal(r.estado, 'confirmado'); assert.deepStrictEqual(r.aplicados, ['diagnostico']);
  assert.deepStrictEqual(Object.keys(X.rastro.ultimoUpdate.valores).sort(), ['diagnostico', 'editado_en', 'editado_por']);
  assert.ok(X.rastro.ultimoUpdate.filtros.some(([op, k, v]) => op === 'eq' && k === 'editado_en' && v === f0.editado_en), 'condición de concurrencia efectiva');
  const f = X.tabla.get('ev1'); assert.equal(f.diagnostico, 'HTA + DBT'); assert.equal(f.temperatura, 36.5); assert.equal(f.fecha_hora, f0.fecha_hora); assert.equal(f.creado_por, 'Dr. R'); assert.equal(f.evolucion, 'estable');
});

test('PC e iPad cambian campos DIFERENTES de la misma evolución: se conservan ambos, sin conflicto', async () => {
  const X = entorno(fila()); const bA = base0(X), bB = base0(X);
  const a = await E.guardarEvolucion({ sb: X.sb, id: 'ev1', base: bA, nuevo: Object.assign({}, bA, { evolucion: 'texto editado en iPad' }), ahora: X.ahora, imc });
  const b = await E.guardarEvolucion({ sb: X.sb, id: 'ev1', base: bB, nuevo: Object.assign({}, bB, { diagnostico: 'Dx agregado en la PC' }), ahora: X.ahora, imc });
  assert.equal(a.estado, 'confirmado'); assert.equal(b.estado, 'confirmado'); assert.deepStrictEqual(b.conflictos, []);
  const f = X.tabla.get('ev1'); assert.equal(f.evolucion, 'texto editado en iPad'); assert.equal(f.diagnostico, 'Dx agregado en la PC');
});

test('un dispositivo con datos viejos NO pisa lo reciente si no modificó ese campo', async () => {
  const X = entorno(fila()); const bViejo = base0(X); X.remoto('ev1', { evolucion: 'nuevo texto', conducta: 'ajustar dosis' });
  const r = await E.guardarEvolucion({ sb: X.sb, id: 'ev1', base: bViejo, nuevo: Object.assign({}, bViejo, { motivo: 'Control + dolor' }), ahora: X.ahora, imc });
  assert.equal(r.estado, 'confirmado'); const f = X.tabla.get('ev1'); assert.equal(f.evolucion, 'nuevo texto'); assert.equal(f.conducta, 'ajustar dosis'); assert.equal(f.motivo, 'Control + dolor');
});

test('MISMO campo con valores distintos: no se fusiona ni se pisa; se devuelve el conflicto y lo demás se guarda', async () => {
  const X = entorno(fila()); const b = base0(X); X.remoto('ev1', { evolucion: 'versión del iPad' });
  const r = await E.guardarEvolucion({ sb: X.sb, id: 'ev1', base: b, nuevo: Object.assign({}, b, { evolucion: 'versión de la PC', conducta: 'control en 1 mes' }), ahora: X.ahora, imc });
  assert.equal(r.estado, 'conflicto'); assert.deepStrictEqual(r.conflictos, [{ campo: 'evolucion', etiqueta: 'Evolución', remoto: 'versión del iPad', mio: 'versión de la PC' }]);
  const f = X.tabla.get('ev1'); assert.equal(f.evolucion, 'versión del iPad'); assert.equal(f.conducta, 'control en 1 mes');
});

test('«Guardar mi modificación» pisa sólo si el valor guardado sigue siendo el mostrado; si cambió otra vez, vuelve a preguntar', async () => {
  const X = entorno(fila()); const b = base0(X); X.remoto('ev1', { evolucion: 'versión del iPad' });
  const nuevo = Object.assign({}, b, { evolucion: 'versión de la PC' });
  const ok = await E.guardarEvolucion({ sb: X.sb, id: 'ev1', base: b, nuevo, resolucion: { evolucion: 'versión del iPad' }, ahora: X.ahora, imc });
  assert.equal(ok.estado, 'confirmado'); assert.equal(X.tabla.get('ev1').evolucion, 'versión de la PC');
  const Y = entorno(fila()); const b2 = base0(Y); Y.remoto('ev1', { evolucion: 'versión del iPad' }); Y.hooks.antesDeUpdate = () => Y.remoto('ev1', { evolucion: 'tercera versión' });
  const r2 = await E.guardarEvolucion({ sb: Y.sb, id: 'ev1', base: b2, nuevo: Object.assign({}, b2, { evolucion: 'versión de la PC' }), resolucion: { evolucion: 'versión del iPad' }, ahora: Y.ahora, imc });
  assert.equal(r2.estado, 'conflicto'); assert.equal(r2.conflictos[0].remoto, 'tercera versión'); assert.equal(Y.tabla.get('ev1').evolucion, 'tercera versión');
});

test('«Conservar lo guardado»: no se escribe ese campo y lo demás se guarda', async () => {
  const X = entorno(fila()); const b = base0(X); X.remoto('ev1', { evolucion: 'versión del iPad' });
  const r = await E.guardarEvolucion({ sb: X.sb, id: 'ev1', base: b, nuevo: Object.assign({}, b, { evolucion: 'versión de la PC', conducta: 'otra' }), omitir: ['evolucion'], ahora: X.ahora, imc });
  assert.equal(r.estado, 'confirmado'); assert.deepStrictEqual(r.omitidos, ['evolucion']); assert.equal(X.tabla.get('ev1').evolucion, 'versión del iPad'); assert.equal(X.tabla.get('ev1').conducta, 'otra');
});

test('otra sesión escribe ENTRE la lectura y el UPDATE: afecta 0 filas, se relee y se fusiona; sobre el mismo campo termina en conflicto', async () => {
  const X = entorno(fila()); const b = base0(X); X.hooks.antesDeUpdate = () => X.remoto('ev1', { diagnostico: 'HTA, DBT' });
  const r = await E.guardarEvolucion({ sb: X.sb, id: 'ev1', base: b, nuevo: Object.assign({}, b, { conducta: 'nueva' }), ahora: X.ahora, imc });
  assert.equal(r.estado, 'confirmado'); assert.equal(X.rastro.updates, 2); assert.equal(X.rastro.updatesEfectivos, 1); assert.equal(X.tabla.get('ev1').diagnostico, 'HTA, DBT'); assert.equal(X.tabla.get('ev1').conducta, 'nueva');
  const Y = entorno(fila()); const b2 = base0(Y); Y.hooks.antesDeUpdate = () => Y.remoto('ev1', { conducta: 'del iPad' });
  const r2 = await E.guardarEvolucion({ sb: Y.sb, id: 'ev1', base: b2, nuevo: Object.assign({}, b2, { conducta: 'de la PC' }), ahora: Y.ahora, imc });
  assert.equal(r2.estado, 'conflicto'); assert.equal(Y.tabla.get('ev1').conducta, 'del iPad'); assert.equal(Y.rastro.updatesEfectivos, 0);
});

test('DOS GUARDADOS SIMULTÁNEOS: campos distintos → ambos persisten; mismo campo → uno gana y el otro recibe el conflicto', async () => {
  const X = entorno(fila()); X.hooks.pausaLectura = true; const b = base0(X);
  const [a, c] = await Promise.all([
    E.guardarEvolucion({ sb: X.sb, id: 'ev1', base: b, nuevo: Object.assign({}, b, { evolucion: 'texto A' }), ahora: X.ahora, imc }),
    E.guardarEvolucion({ sb: X.sb, id: 'ev1', base: b, nuevo: Object.assign({}, b, { diagnostico: 'Dx B' }), ahora: X.ahora, imc })
  ]);
  assert.equal(a.estado, 'confirmado'); assert.equal(c.estado, 'confirmado'); assert.equal(X.tabla.get('ev1').evolucion, 'texto A'); assert.equal(X.tabla.get('ev1').diagnostico, 'Dx B'); assert.equal(X.rastro.updatesEfectivos, 2);
  const Y = entorno(fila()); Y.hooks.pausaLectura = true; const b2 = base0(Y);
  const [p, q] = await Promise.all([
    E.guardarEvolucion({ sb: Y.sb, id: 'ev1', base: b2, nuevo: Object.assign({}, b2, { evolucion: 'texto A' }), ahora: Y.ahora, imc }),
    E.guardarEvolucion({ sb: Y.sb, id: 'ev1', base: b2, nuevo: Object.assign({}, b2, { evolucion: 'texto B' }), ahora: Y.ahora, imc })
  ]);
  assert.deepStrictEqual([p.estado, q.estado].sort(), ['confirmado', 'conflicto']); const perdedor = p.estado === 'conflicto' ? p : q;
  assert.equal(Y.tabla.get('ev1').evolucion, perdedor.conflictos[0].remoto); assert.ok(['texto A', 'texto B'].includes(Y.tabla.get('ev1').evolucion));
});

test('IMC: se recalcula con los valores FINALES (peso de un dispositivo + talla de otro)', async () => {
  const X = entorno(fila()); const bA = base0(X), bB = base0(X);
  await E.guardarEvolucion({ sb: X.sb, id: 'ev1', base: bA, nuevo: Object.assign({}, bA, { tallaCm: 180 }), ahora: X.ahora, imc });
  const r = await E.guardarEvolucion({ sb: X.sb, id: 'ev1', base: bB, nuevo: Object.assign({}, bB, { pesoKg: 90 }), ahora: X.ahora, imc });
  assert.equal(r.estado, 'confirmado'); const f = X.tabla.get('ev1'); assert.equal(f.peso_kg, 90); assert.equal(f.talla_cm, 180); assert.equal(f.imc, imc(90, 180));
  const Y = entorno(fila()); const b = base0(Y);
  await E.guardarEvolucion({ sb: Y.sb, id: 'ev1', base: b, nuevo: Object.assign({}, b, { diagnostico: 'otro' }), ahora: Y.ahora, imc });
  assert.equal(Y.tabla.get('ev1').imc, 26.1, 'sin cambio de peso/talla el IMC no se toca');
});

test('vaciar un campo guarda null; una evolución eliminada desde otro dispositivo NO se recrea', async () => {
  const X = entorno(fila()); const b = base0(X);
  await E.guardarEvolucion({ sb: X.sb, id: 'ev1', base: b, nuevo: Object.assign({}, b, { conducta: '' }), ahora: X.ahora, imc }); assert.equal(X.tabla.get('ev1').conducta, null);
  const Y = entorno(fila()); const b2 = base0(Y); Y.borrar('ev1');
  const r = await E.guardarEvolucion({ sb: Y.sb, id: 'ev1', base: b2, nuevo: Object.assign({}, b2, { conducta: 'x' }), ahora: Y.ahora, imc });
  assert.equal(r.estado, 'ausente'); assert.equal(Y.tabla.size, 0); assert.equal(Y.rastro.updates, 0);
});

test('errores: permiso se informa sin reintentar; reintentos acotados; editado_en nulo → IS NULL; reloj atrasado → marca posterior', async () => {
  const X = entorno(fila()); const b = base0(X); X.hooks.errorUpdate = { code: '42501', message: 'new row violates row-level security policy' };
  const r = await E.guardarEvolucion({ sb: X.sb, id: 'ev1', base: b, nuevo: Object.assign({}, b, { motivo: 'x' }), ahora: X.ahora, imc });
  assert.equal(r.estado, 'error'); assert.equal(r.permiso, true); assert.equal(X.rastro.updates, 1);
  const Y = entorno(fila()); Y.hooks.antesDeUpdate = { siempre: true, fn: () => Y.remoto('ev1', { diagnostico: 'c' + Math.random() }) };
  const r3 = await E.guardarEvolucion({ sb: Y.sb, id: 'ev1', base: base0(Y), nuevo: Object.assign({}, base0(Y), { motivo: 'x' }), ahora: Y.ahora, imc });
  assert.equal(r3.estado, 'error'); assert.equal(r3.reintentosAgotados, true); assert.equal(Y.rastro.updates, E.MAX_REINTENTOS); assert.notEqual(Y.tabla.get('ev1').motivo, 'x');
  const Z = entorno(fila()); Z.tabla.get('ev1').editado_en = null; const bz = base0(Z);
  const rz = await E.guardarEvolucion({ sb: Z.sb, id: 'ev1', base: bz, nuevo: Object.assign({}, bz, { motivo: 'y' }), ahora: Z.ahora, imc });
  assert.equal(rz.estado, 'confirmado'); assert.ok(Z.rastro.ultimoUpdate.filtros.some(([op, k]) => op === 'is' && k === 'editado_en'));
  const W = entorno(fila({ editado_en: '2030-01-01T00:00:00.000Z' })); const bw = base0(W);
  await E.guardarEvolucion({ sb: W.sb, id: 'ev1', base: bw, nuevo: Object.assign({}, bw, { motivo: 'y' }), ahora: () => '2026-11-21T12:00:00.000Z', imc });
  assert.ok(Date.parse(W.tabla.get('ev1').editado_en) > Date.parse('2030-01-01T00:00:00.000Z'));
});

// ---------- integración estática con app.js / index.html ----------
const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8'), idx = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
test('app.js: una evolución existente ya no se bloquea por «otra sesión» ni se reescribe completa; usa línea base y una única pregunta', () => {
  const s = app.slice(app.indexOf('async function saveEvolutionHC'), app.indexOf('function mostrarErrorGuardadoEvolucionV1'));
  assert.ok(!/Copiá tu texto, cerrá y volvé a abrir/.test(s) && !/vServ>vBase/.test(s), 'sin bloqueo por versión');
  assert.ok(/evoBaselineV1/.test(s) && /evolucionCambios:ecamEvo/.test(s) && /preguntarReemplazo/.test(s));
  const g = app.slice(app.indexOf('async function guardarEvolucionConfirmada410'), app.indexOf('// Guardado clínico multidispositivo - el estado local'));
  assert.ok(/cardiolinkHcEvolucionV1\.guardarEvolucion/.test(g) && /if\(erow&&!ecam\)/.test(g), 'la evolución existente no pasa por el upsert de fila completa');
  assert.ok(/overlay\.dataset\.evoBaselineV1=JSON\.stringify/.test(app), 'la línea base se fija al abrir');
});
test('app.js: se conserva la corrección del botón Editar y el resumen clínico no cambió de camino', () => {
  const e = app.slice(app.indexOf('function editSummaryHC'), app.indexOf('// Fase 6, Bloque 6C: printHC() (historia clínica'));
  assert.ok(!/sincronizarPacienteCompleto/.test(e) && /guardarResumenConfirmado/.test(e));
  const g = app.slice(app.indexOf('async function guardarEvolucionConfirmada410'), app.indexOf('// Guardado clínico multidispositivo - el estado local'));
  assert.ok(!/from\('cardiolink_hc_resumen'\)/.test(g) && /cardiolinkHcResumenV1\.guardarResumen/.test(g));
});
test('index.html carga ambos módulos', () => {
  assert.match(idx, /<script src="cardiolink-hc-resumen-v1\.js\?v=hm-1"><\/script>/); assert.match(idx, /<script src="cardiolink-hc-evolucion-v1\.js\?v=hm-1"><\/script>/);
});

// ---------- mensaje de evolución eliminada desde otro dispositivo (sin jerga técnica) ----------
test('evolución eliminada desde otro dispositivo: ambos caminos muestran el mismo mensaje operativo, sin «servidor», y no se antepone el aviso genérico', () => {
  const MSG = 'Esta evolución fue eliminada desde otro dispositivo. No se volvió a crear. Tu texto sigue en pantalla: copialo si lo necesitás.';
  const s = app.slice(app.indexOf('async function saveEvolutionHC'), app.indexOf('function mostrarErrorGuardadoEvolucionV1'));
  const g = app.slice(app.indexOf('async function guardarEvolucionConfirmada410'), app.indexOf('// Guardado clínico multidispositivo - el estado local'));
  assert.ok(s.includes("falloGuardado('" + MSG + "')"), 'camino «la evolución ya no está en el estado local»');
  assert.ok(g.includes("{ausente:true,message:'" + MSG + "'}") && /if\(err&&err\.ausente\)return \{ok:false,ausente:true,error:err\.message\}/.test(g), 'camino «el guardado por campos no encuentra la fila»');
  assert.ok(/if\(!r\.ok&&r\.ausente\)\{revertirLocal\(\);falloGuardado\(r\.error\);return;\}/.test(s), 'se muestra tal cual, sin el prefijo genérico «No se pudo confirmar el guardado en el servidor»');
  assert.ok(!/servidor/i.test(MSG));
});
