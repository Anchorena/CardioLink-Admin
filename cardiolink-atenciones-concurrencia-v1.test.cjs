'use strict';
// Persistencia V1 / R2C · pruebas del módulo de concurrencia de atenciones con un Supabase simulado en memoria.
// Ejecutar: node --test cardiolink-atenciones-concurrencia-v1.test.cjs
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const F = require('./cardiolink-atenciones-merge-v1.js');

const clon = (o) => JSON.parse(JSON.stringify(o));
const estable = (v) => {
  if (v === null || typeof v !== 'object') { const s = JSON.stringify(v); return s === undefined ? 'null' : s; }
  if (Array.isArray(v)) return '[' + v.map(estable).join(',') + ']';
  return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + estable(v[k])).join(',') + '}';
};

function entorno(opciones) {
  opciones = opciones || {};
  const tabla = new Map();            // id → { payload, updated_at }
  let reloj = 1000; const tic = () => new Date(Date.UTC(2026, 10, 17, 12, 0, 0, reloj++)).toISOString();
  const almacen = {}; const rastro = { updates: 0, lecturas: 0, upserts: 0 };
  const hooks = { antesDeUpdate: null, errorUpdate: null, errorLectura: null, sinFilas: false };
  const sb = {
    from(t) {
      assert.equal(t, 'cardiolink_atenciones');
      const q = { op: null, filtros: {}, valores: null };
      const api = {
        select() { if (!q.op) q.op = 'select'; return api; }, limit() { return api; },
        update(v) { q.op = 'update'; q.valores = v; return api; },
        eq(k, v) { q.filtros[k] = v; return api; },
        then(res, rej) { return Promise.resolve(ejecutar()).then(res, rej); }
      };
      function ejecutar() {
        if (q.op === 'select') {
          rastro.lecturas++;
          if (hooks.errorLectura) return { data: null, error: hooks.errorLectura };
          const f = tabla.get(q.filtros.id); return { data: f ? [{ id: q.filtros.id, payload: clon(f.payload), updated_at: f.updated_at }] : [], error: null };
        }
        if (q.op === 'update') {
          rastro.updates++;
          if (hooks.antesDeUpdate) { const h = hooks.antesDeUpdate; hooks.antesDeUpdate = null; h(); }
          if (hooks.errorUpdate) return { data: null, error: hooks.errorUpdate };
          if (hooks.sinFilas) return { data: [], error: null };            // RLS: el UPDATE no alcanza ninguna fila y la versión no cambia
          const f = tabla.get(q.filtros.id);
          if (!f || f.updated_at !== q.filtros.updated_at) return { data: [], error: null };
          f.payload = clon(q.valores.payload); f.updated_at = q.valores.updated_at;
          return { data: [{ id: q.filtros.id, updated_at: f.updated_at }], error: null };
        }
        return { data: null, error: new Error('op no soportada') };
      }
      return api;
    }
  };
  // sesión simulada
  const locales = new Map(), bases = new Map(), versiones = new Map(); let rolActual = opciones.rol || 'secretaria';
  const ventana = {
    cardiolinkAtencionesMergeV1: F,
    cardiolinkConfigR2B: null
  };
  const contexto = { window: ventana, usuarioSupabase: { id: 'u-1' }, localStorage: { getItem: (k) => (k in almacen ? almacen[k] : null), setItem: (k, v) => { almacen[k] = String(v); }, removeItem: (k) => { delete almacen[k]; } }, console, JSON, Date, Promise, Map, Set, Array, Object, String, Error, setTimeout };
  vm.createContext(contexto);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'cardiolink-atenciones-concurrencia-v1.js'), 'utf8'), contexto);
  const M = ventana.cardiolinkAtencionesR2C;
  const puente = {
    supabase: () => sb, rol: () => rolActual, estable, usuario: () => 'Tester',
    actual: (id) => locales.get(String(id)), base: (id) => bases.get(String(id)),
    fijarBase: (id, p, v) => { bases.set(String(id), estable(p)); if (v) versiones.set(String(id), v); }, fijarVersion: (id, v) => { if (v) versiones.set(String(id), v); },
    reemplazar: (id, p) => locales.set(String(id), clon(p)), quitarLocal: (id) => { locales.delete(String(id)); bases.delete(String(id)); versiones.delete(String(id)); },
    restaurar: (id, p) => { bases.delete(String(id)); versiones.delete(String(id)); locales.set(String(id), clon(p)); }, guardar: () => {}, puedeRecrear: () => rolActual !== 'medico'
  };
  M.conectar(puente);
  return {
    M, tabla, locales, bases, versiones, hooks, rastro, almacen, tic, setRol: (r) => { rolActual = r; },
    // la sesión "carga" una atención: remoto + local + base
    cargar(a) { const v = tic(); tabla.set(String(a.id), { payload: clon(a), updated_at: v }); locales.set(String(a.id), clon(a)); bases.set(String(a.id), estable(a)); versiones.set(String(a.id), v); return v; },
    // otra sesión cambia el remoto
    remoto(id, cambios) { const f = tabla.get(String(id)); f.payload = Object.assign(clon(f.payload), cambios); f.updated_at = tic(); },
    editarLocal(id, cambios) { locales.set(String(id), Object.assign(clon(locales.get(String(id))), cambios)); }
  };
}
const atencion = (extra) => Object.assign({
  id: 'a1', pacienteId: 'p1', paciente: 'Ana Test', profesionalId: 'm1', profesional: 'Dr. M', fecha: '2026-11-20', horaInicio: '09:00', estadoTurno: 'reservado', estado: 'reservado',
  observaciones: '', cobertura: 'OSDE', montoConsulta: 1000, montoTotal: 1000, estadoCobro: 'pendiente', bonoFirmado: false, copiaImpresa: false,
  editadoPor: 'u0', editadoEn: '2026-11-17T08:00:00Z', auditoriaPendientes: []
}, extra || {});

test('cambios independientes: se fusionan y se confirman con UPDATE condicionado; el remoto conserva ambos', async () => {
  const E = entorno(); E.cargar(atencion());
  E.remoto('a1', { copiaImpresa: true, editadoPor: 'u2', editadoEn: '2026-11-17T09:00:00Z' });
  E.editarLocal('a1', { bonoFirmado: true, editadoPor: 'u1', editadoEn: '2026-11-17T09:30:00Z' });
  const r = await E.M.reconciliarFila('a1');
  assert.equal(r.estado, 'confirmada'); assert.equal(r.fusionada, true);
  const f = E.tabla.get('a1').payload; assert.equal(f.bonoFirmado, true); assert.equal(f.copiaImpresa, true); assert.equal(f.editadoPor, 'u1');
  assert.equal(E.locales.get('a1').copiaImpresa, true, 'la sesión adopta lo fusionado');
  assert.equal(E.bases.get('a1'), estable(f), 'base = contenido confirmado'); assert.equal(E.versiones.get('a1'), E.tabla.get('a1').updated_at);
  assert.equal(E.M.hayRetenidas(), false);
});

test('reintento: otra sesión cambia la fila entre la lectura y la escritura → se relee y se vuelve a fusionar (máx. 3)', async () => {
  const E = entorno(); E.cargar(atencion());
  E.remoto('a1', { cobertura: 'Swiss' }); E.editarLocal('a1', { observaciones: 'mi nota' });
  E.hooks.antesDeUpdate = () => E.remoto('a1', { copiaImpresa: true });
  const r = await E.M.reconciliarFila('a1');
  assert.equal(r.estado, 'confirmada'); const f = E.tabla.get('a1').payload;
  assert.equal(f.observaciones, 'mi nota'); assert.equal(f.cobertura, 'Swiss'); assert.equal(f.copiaImpresa, true);
  assert.equal(E.rastro.updates, 2); assert.equal(E.M.estado().contadores.reintentos, 1);
});

test('reintentos agotados: tras 3 intentos se informa y NO se escribe a ciegas ni se descarta lo local', async () => {
  const E = entorno(); E.cargar(atencion()); E.editarLocal('a1', { observaciones: 'mía' }); E.remoto('a1', { cobertura: 'Swiss' });
  const original = E.hooks; let n = 0;
  const trampa = () => { E.remoto('a1', { telefono: String(n++) }); E.hooks.antesDeUpdate = trampa; };
  E.hooks.antesDeUpdate = trampa;
  const r = await E.M.reconciliarFila('a1');
  assert.equal(r.estado, 'reintentos_agotados'); assert.equal(E.rastro.updates, 3);
  assert.equal(E.locales.get('a1').observaciones, 'mía'); assert.notEqual(E.tabla.get('a1').payload.observaciones, 'mía');
});

test('mismo campo: conflicto retenido; la fila deja de enviarse; resolver con «mi valor» relee y guarda', async () => {
  const E = entorno(); E.cargar(atencion());
  E.remoto('a1', { observaciones: 'remota' }); E.editarLocal('a1', { observaciones: 'local' });
  const r = await E.M.reconciliarFila('a1');
  assert.equal(r.estado, 'conflicto'); assert.equal(E.tabla.get('a1').payload.observaciones, 'remota', 'no se escribió nada');
  assert.equal(E.M.retenida('a1', estable(E.locales.get('a1'))), true);
  E.remoto('a1', { copiaImpresa: true });                               // el servidor cambió OTRA cosa mientras el panel estaba abierto
  const res = await E.M.reconciliarFila('a1', { resoluciones: { 'campo:observaciones': 'local' } });
  assert.equal(res.estado, 'confirmada'); const f = E.tabla.get('a1').payload; assert.equal(f.observaciones, 'local'); assert.equal(f.copiaImpresa, true);
  assert.equal(E.M.hayRetenidas(), false);
});

test('estados incompatibles: conflicto explícito; cancelación del paciente no se revierte aunque se pida «mi valor»', async () => {
  const E = entorno(); E.cargar(atencion());
  E.remoto('a1', { estadoTurno: 'cancelado', estado: 'cancelado', canceladoPor: 'Paciente (a@x.com)' });
  E.editarLocal('a1', { estadoTurno: 'confirmado', estado: 'confirmado', observaciones: 'otra cosa' });
  const r = await E.M.reconciliarFila('a1');
  assert.equal(r.estado, 'confirmada'); const f = E.tabla.get('a1').payload;
  assert.equal(f.estadoTurno, 'cancelado'); assert.equal(f.observaciones, 'otra cosa');
  assert.equal(r.rechazos.length, 1); assert.equal(E.M._recuperacion().rechazos[0].valores.estadoTurno, 'confirmado', 'el cambio rechazado queda para recuperación');
  const E2 = entorno(); E2.cargar(atencion());
  E2.remoto('a1', { estadoTurno: 'ausente', estado: 'ausente' }); E2.editarLocal('a1', { estadoTurno: 'atendido', estado: 'atendido' });
  assert.equal((await E2.M.reconciliarFila('a1')).estado, 'conflicto');
});

test('cobro confirmado por otra sesión: importes congelados, cambio económico local rechazado e informado; lo demás se conserva', async () => {
  const E = entorno(); E.cargar(atencion());
  E.remoto('a1', { estadoCobro: 'cobrado', cobroConfirmadoPorRol: 'admin', cobroConfirmadoPor: 'Caja', cobroConfirmadoEn: '2026-11-17T10:00:00Z', cobroMedioPago: 'Efectivo' });
  E.editarLocal('a1', { montoConsulta: 9999, montoTotal: 9999, observaciones: 'nota' });
  const r = await E.M.reconciliarFila('a1');
  const f = E.tabla.get('a1').payload; assert.equal(r.estado, 'confirmada');
  assert.equal(f.montoConsulta, 1000); assert.equal(f.montoTotal, 1000); assert.equal(f.estadoCobro, 'cobrado'); assert.equal(f.observaciones, 'nota');
  assert.ok(r.rechazos.some((x) => x.grupo === 'financiero')); assert.equal(E.locales.get('a1').montoConsulta, 1000);
});

test('eliminación vs modificación: no se recrea; la fila sale de la sesión; se conserva para decidir; restaurar la vuelve como nueva (sin baseline)', async () => {
  const E = entorno(); E.cargar(atencion()); E.tabla.delete('a1'); E.editarLocal('a1', { observaciones: 'mi cambio' });
  const r = await E.M.reconciliarFila('a1');
  assert.equal(r.estado, 'eliminada_remota'); assert.equal(E.tabla.has('a1'), false); assert.equal(E.rastro.updates, 0);
  assert.equal(E.locales.has('a1'), false); assert.equal(E.bases.has('a1'), false); assert.equal(E.versiones.has('a1'), false);
  assert.equal(E.M.retenida('a1'), true); assert.ok(E.M._recuperacion().eliminadas.some((x) => x.id === 'a1' && x.local.observaciones === 'mi cambio'));
  // aceptar la eliminación: no se recrea y los cambios locales quedan como respaldo; restaurar: vuelve como atención NUEVA (sin baseline)
  const E2 = entorno(); E2.cargar(atencion()); E2.tabla.delete('a1'); E2.editarLocal('a1', { observaciones: 'mi cambio' }); await E2.M.reconciliarFila('a1');
  const ok = await E2.M.resolver({ 'a1|eliminada': 'local' });
  assert.equal(ok.ok, true); assert.equal(E2.locales.get('a1').observaciones, 'mi cambio'); assert.equal(E2.bases.has('a1'), false); assert.equal(E2.versiones.has('a1'), false); assert.equal(E2.tabla.has('a1'), false, 'la recreación la hace el sync normal, no el módulo');
  const E3 = entorno(); E3.cargar(atencion()); E3.tabla.delete('a1'); E3.editarLocal('a1', { observaciones: 'mi cambio' }); await E3.M.reconciliarFila('a1');
  await E3.M.resolver({ 'a1|eliminada': 'remoto' });
  assert.equal(E3.locales.has('a1'), false); assert.equal(E3.M.hayRetenidas(), false); assert.ok(E3.M._recuperacion().rechazos.some((x) => x.id === 'a1'));
});

test('error de permisos/guard: la fila se retiene sin reintento infinito y se libera al editarla de nuevo', async () => {
  const E = entorno(); E.cargar(atencion()); E.remoto('a1', { cobertura: 'Swiss' }); E.editarLocal('a1', { observaciones: 'x' });
  E.hooks.errorUpdate = { code: '42501', message: 'Rol no autorizado: el cobro ya fue confirmado' };
  const r = await E.M.reconciliarFila('a1'); assert.equal(r.estado, 'rechazada');
  const cont = estable(E.locales.get('a1')); assert.equal(E.M.retenida('a1', cont), true);
  assert.equal(E.M.manejarErrorFila('a2', atencion({ id: 'a2' }), { code: '42501', message: 'row-level security' }), 'rechazada');
  assert.equal(E.M.manejarErrorFila('a3', atencion({ id: 'a3' }), { code: '08006', message: 'network' }), 'transitoria');
  assert.equal(E.M.retenida('a1', estable(Object.assign(clon(E.locales.get('a1')), { observaciones: 'y' }))), false, 'al editarla de nuevo se vuelve a intentar');
  assert.ok(E.M._recuperacion().rechazos.length >= 1);
});

test('error transitorio de lectura: no se pierde nada; se reintenta en el próximo ciclo', async () => {
  const E = entorno(); E.cargar(atencion()); E.editarLocal('a1', { observaciones: 'x' }); E.hooks.errorLectura = new Error('Failed to fetch');
  const r = await E.M.reconciliarFila('a1'); assert.equal(r.estado, 'error_transitorio'); assert.equal(E.locales.get('a1').observaciones, 'x'); assert.equal(E.rastro.updates, 0);
});

test('edición durante el guardado: lo escrito en vuelo se conserva (rebase) y queda pendiente de subir', async () => {
  const E = entorno(); E.cargar(atencion()); E.remoto('a1', { cobertura: 'Swiss' }); E.editarLocal('a1', { observaciones: 'v1' });
  E.hooks.antesDeUpdate = () => E.editarLocal('a1', { bonoFirmado: true });      // el usuario sigue editando mientras se guarda
  const r = await E.M.reconciliarFila('a1');
  assert.equal(r.estado, 'confirmada'); assert.equal(r.editadaEnVuelo, true);
  const l = E.locales.get('a1'); assert.equal(l.bonoFirmado, true); assert.equal(l.cobertura, 'Swiss'); assert.equal(l.observaciones, 'v1');
  assert.equal(E.tabla.get('a1').payload.bonoFirmado, false, 'lo editado en vuelo todavía no está en el servidor');
  assert.notEqual(estable(l), E.bases.get('a1'), 'sigue figurando como modificada');
});

test('la fila de configuración nunca se gestiona como atención', async () => {
  const E = entorno(); const r = await E.M.reconciliarFila('__cardiolink_config_v1'); assert.equal(r.estado, 'error_transitorio'); assert.equal(E.rastro.lecturas, 0);
});

test('una sola operación por atención a la vez (cola por id)', async () => {
  const E = entorno(); E.cargar(atencion()); E.remoto('a1', { cobertura: 'S' }); E.editarLocal('a1', { observaciones: 'x' });
  const [a, b] = await Promise.all([E.M.reconciliarFila('a1'), E.M.reconciliarFila('a1')]);
  assert.equal(a.estado, 'confirmada'); assert.equal(b.estado, 'confirmada'); assert.equal(E.rastro.updates, 1, 'la segunda no tenía nada que escribir');
});

// ---- R2D: lo que instala la recuperación (base reconstruida + versión base original) se resuelve por la fusión de R2C, nunca por el parche ----
const O = require('./cardiolink-outbox-v1.js');
function recuperado(E, localCambios, remotoCambios) {
  const original = atencion(); E.cargar(original);
  const diff = O.diffAtencion(original, Object.assign({}, original, localCambios)).cambios;
  const verOriginal = E.versiones.get('a1');
  E.remoto('a1', remotoCambios);                                                    // el servidor cambió mientras la app estaba cerrada
  const rem = E.tabla.get('a1').payload;
  // lo que hace cardiolink-outbox-glue-v1.js: base' = remoto + «antes», local' = remoto + «después», versión BASE original
  E.locales.set('a1', O.aplicarAtencion(rem, diff, 'd')); E.bases.set('a1', O.estable(O.aplicarAtencion(rem, diff, 'a'))); E.versiones.set('a1', verOriginal);
}
test('R2D: recuperación con el servidor cambiado en OTRO campo → se fusiona y ambos cambios quedan en el servidor', async () => {
  const E = entorno(); recuperado(E, { observaciones: 'pendiente local' }, { cobertura: 'Swiss' });
  const r = await E.M.reconciliarFila('a1'); assert.equal(r.estado, 'confirmada');
  const f = E.tabla.get('a1').payload; assert.equal(f.observaciones, 'pendiente local'); assert.equal(f.cobertura, 'Swiss');
});
test('R2D: recuperación con el servidor cambiado en el MISMO campo → CONFLICTO visible; no se escribe nada (el parche no pisa al remoto)', async () => {
  const E = entorno(); recuperado(E, { observaciones: 'LOCAL' }, { observaciones: 'REMOTA' });
  const r = await E.M.reconciliarFila('a1'); assert.equal(r.estado, 'conflicto'); assert.equal(E.tabla.get('a1').payload.observaciones, 'REMOTA'); assert.equal(E.rastro.updates, 0);
});
test('R2D: corrección económica pendiente (grupo indivisible) recuperada sobre un cobro confirmado por otra sesión → congelada e informada', async () => {
  const E = entorno(); recuperado(E, { montoConsulta: 5000, montoTotal: 5000 }, { estadoCobro: 'cobrado', cobroConfirmadoPorRol: 'admin', cobroConfirmadoPor: 'c@x', cobroConfirmadoEn: '2026-11-18T10:00:00Z', cobroMedioPago: 'Efectivo' });
  const r = await E.M.reconciliarFila('a1'); assert.equal(r.estado, 'confirmada');
  const f = E.tabla.get('a1').payload; assert.equal(f.montoConsulta, 1000); assert.equal(f.estadoCobro, 'cobrado'); assert.ok(r.rechazos.some((x) => x.grupo === 'financiero'));
});

test('R3: UPDATE con 0 filas y la versión SIN cambios = el servidor no permite modificarla: se retiene sin reintentos infinitos', async () => {
  const E = entorno(); E.cargar(atencion()); E.editarLocal('a1', { observaciones: 'x' }); E.remoto('a1', { cobertura: 'Swiss' }); E.hooks.sinFilas = true;
  const r = await E.M.reconciliarFila('a1');
  assert.equal(r.estado, 'rechazada'); assert.equal(E.rastro.updates, 1, 'un solo intento, sin reintentos'); assert.equal(E.M.retenida('a1', estable(E.locales.get('a1'))), true);
  assert.ok(E.M._recuperacion().rechazos.length >= 1);
});
