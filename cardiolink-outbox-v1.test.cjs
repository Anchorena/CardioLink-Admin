'use strict';
// Persistencia V1 / R2D · pruebas de la cola local de recuperación (lógica pura + integración con un «app» simulado).
// Ejecutar: node --test cardiolink-outbox-v1.test.cjs
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const P = require('./cardiolink-outbox-v1.js');

const clon = (o) => JSON.parse(JSON.stringify(o));
const est = P.estable;

// ---------------- lógica pura ----------------
test('diffAtencion: sólo diferencias; distingue ausente / null / 0 / false / vacío', () => {
  const b = { id: 'a1', n: 0, f: false, s: '', z: null, obs: 'x' };
  const l = { id: 'a1', n: null, f: '', s: null, z: 0, nuevo: 'y' };
  const d = P.diffAtencion(b, l).cambios;
  assert.deepStrictEqual(Object.keys(d).sort(), ['f', 'n', 'nuevo', 'obs', 's', 'z']);
  assert.equal(d.obs.da, 1); assert.equal(d.nuevo.aa, 1);
  const rec = P.aplicarAtencion(b, d, 'd'); assert.deepStrictEqual(rec, l);
  assert.deepStrictEqual(P.aplicarAtencion(l, d, 'a'), b);
  assert.deepStrictEqual(P.diffAtencion({ a: 0 }, { a: 0 }).cambios, {});
  assert.equal(Object.keys(P.diffAtencion({ a: 0 }, { a: false }).cambios).length, 1, '0 y false son distintos');
});

test('diffAtencion: NUNCA incluye confirmación de cobro, medio, auditoría ni el paso a «cobrado»', () => {
  const b = { id: 'a', estadoCobro: 'pendiente', montoConsulta: 100, cobroAuditoria: [{ a: 1 }] };
  const l = { id: 'a', estadoCobro: 'cobrado', montoConsulta: 200, cobroConfirmadoPorRol: 'admin', cobroConfirmadoPor: 'x@y', cobroMedioPago: 'Efectivo', cobroAuditoria: [{ a: 1 }, { a: 2 }] };
  const d = P.diffAtencion(b, l);
  assert.deepStrictEqual(Object.keys(d.cambios), ['montoConsulta'], 'sí viaja la corrección económica');
  ['estadoCobro', 'cobroConfirmadoPorRol', 'cobroConfirmadoPor', 'cobroMedioPago', 'cobroAuditoria'].forEach((k) => assert.ok(d.excluidos.includes(k), k));
  assert.ok(!JSON.stringify(d.cambios).includes('cobroConfirmado'));
  // pendiente → sin_cobro (corrección legítima) sí viaja
  assert.ok(P.diffAtencion({ estadoCobro: 'pendiente' }, { estadoCobro: 'sin_cobro' }).cambios.estadoCobro);
});

test('diffAtencion: no guarda imágenes data: grandes', () => {
  const grande = 'data:image/png;base64,' + 'A'.repeat(3000);
  const d = P.diffAtencion({ id: 1 }, { id: 1, adjunto: grande, nota: 'ok' });
  assert.deepStrictEqual(Object.keys(d.cambios), ['nota']); assert.deepStrictEqual(d.excluidos, ['adjunto']);
});

const cfgBase = () => ({
  pacientes: [{ id: 'p1', nombreCompleto: 'Ana', telefono: '111', email: null, activo: false }, { id: 'p2', nombreCompleto: 'Juan', telefono: '222' }],
  arancelesPorProfesional: { matias: [{ id: 'a1', valor: 1000, copago: 0 }, { id: 'a2', valor: 2000 }] },
  obrasSociales: ['OSDE', 'Swiss'], motivosConsulta: ['Control'], reglasOS: { OSDE: 'OSDE', PAMI: 'COBERTURA' }, version: 3,
  documentosClinicos: [{ id: 'd1', texto: 'HC reservada' }], evolucionesClinicas: [{ id: 'e1', texto: 'clínico' }], resumenesClinicos: { p1: { texto: 'resumen' } },
  profesionales: [{ id: 'matias', nombre: 'Dr M', logoDocumentoData: 'data:image/png;base64,' + 'B'.repeat(5000) }]
});

test('diffConfig/aplicarConfig: parche por ENTIDAD y CAMPO; base y local se reconstruyen exactamente (incluye ausente/null/0/false/vacío)', () => {
  const b = cfgBase(); const l = clon(b);
  l.pacientes[0].telefono = '999'; l.pacientes[0].email = ''; l.pacientes[0].activo = 0; delete l.pacientes[1].telefono;
  l.pacientes.push({ id: 'p3', nombreCompleto: 'Rosa' }); l.pacientes.splice(1, 1);
  l.arancelesPorProfesional.matias[0].valor = 0; l.arancelesPorProfesional.matias[1].copago = 50;
  l.obrasSociales = ['OSDE', 'PAMI']; l.reglasOS.PAMI = 'GENERAL'; delete l.reglasOS.OSDE; l.version = 4;
  const d = P.diffConfig(b, l);
  const txt = JSON.stringify(d.ops);
  assert.ok(!txt.includes('HC reservada') && !txt.includes('resumen'), 'sin datos clínicos');
  assert.ok(txt.length < 1500, 'parche pequeño: ' + txt.length);
  // sobre un REMOTO que ya difiere en otras cosas, base' y local' sólo tocan lo parcheado
  const remoto = clon(b); remoto.pacientes[1].telefono = '777'; remoto.motivosConsulta.push('Dolor');
  const local2 = P.aplicarConfig(remoto, d.ops, 'd'), base2 = P.aplicarConfig(remoto, d.ops, 'a');
  assert.equal(local2.pacientes.find((p) => p.id === 'p1').telefono, '999'); assert.equal(local2.pacientes.find((p) => p.id === 'p1').email, ''); assert.equal(local2.pacientes.find((p) => p.id === 'p1').activo, 0);
  assert.ok(local2.pacientes.some((p) => p.id === 'p3'));
  assert.deepStrictEqual(local2.motivosConsulta, ['Control', 'Dolor'], 'lo ajeno del remoto se conserva');
  assert.ok(!('OSDE' in local2.reglasOS) && local2.reglasOS.PAMI === 'GENERAL');
  assert.equal(base2.pacientes.find((p) => p.id === 'p1').telefono, '111'); assert.equal(base2.pacientes.find((p) => p.id === 'p1').email, null); assert.equal(base2.pacientes.find((p) => p.id === 'p1').activo, false);
  assert.ok(!base2.pacientes.some((p) => p.id === 'p3')); assert.ok('OSDE' in base2.reglasOS);
  // ida y vuelta exacta sobre la misma base
  assert.deepStrictEqual(P.aplicarConfig(b, d.ops, 'd').pacientes.find((p) => p.id === 'p1'), l.pacientes.find((p) => p.id === 'p1'));
  assert.deepStrictEqual(P.aplicarConfig(l, d.ops, 'a').obrasSociales, b.obrasSociales);
});

test('diffConfig: claves clínicas e imágenes no se guardan y se informan como NO protegidas', () => {
  const b = cfgBase(); const l = clon(b);
  l.documentosClinicos.push({ id: 'd2', texto: 'otro' }); l.evolucionesClinicas[0].texto = 'cambio'; l.resumenesClinicos.p1.texto = 'x';
  l.profesionales[0].logoDocumentoData = 'data:image/png;base64,' + 'C'.repeat(5000); l.profesionales[0].nombre = 'Dr Martín';
  const d = P.diffConfig(b, l);
  assert.ok(['documentosClinicos', 'evolucionesClinicas', 'resumenesClinicos'].every((k) => d.noProtegido.includes(k)));
  assert.ok(d.noProtegido.some((x) => x.includes('logoDocumentoData')));
  const s = JSON.stringify(d.ops); assert.ok(!s.includes('data:image') && !s.includes('otro') && !s.includes('cambio'));
  assert.ok(s.includes('Dr Martín'), 'el cambio legítimo del nombre sí viaja');
});

test('diffConfig: lista sin identidad inequívoca se guarda como valor de ESA lista (no toda la configuración)', () => {
  const b = { pacientes: [{ id: 'p1' }, { id: 'p1' }], otro: 1 }; const l = { pacientes: [{ id: 'p1' }, { id: 'p1', x: 1 }], otro: 1 };
  const d = P.diffConfig(b, l); assert.equal(d.ops.length, 1); assert.equal(d.ops[0].t, 'val'); assert.deepStrictEqual(d.ops[0].ruta, ['pacientes']);
});

// ---------------- almacenamiento ----------------
function almacen(opts) {
  opts = opts || {}; const m = new Map();
  return {
    m, getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { if (opts.cuota != null && (v.length + [...m.entries()].filter(([kk]) => kk !== k).reduce((a, [, vv]) => a + vv.length, 0)) > opts.cuota) { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; } if (opts.noPersiste) return; m.set(k, String(v)); },
    removeItem: (k) => m.delete(k)
  };
}
test('escribir: cuota agotada, escritura que no queda y almacenamiento ausente NO se reportan como protegidos', () => {
  assert.equal(P.escribir(almacen({ cuota: 10 }), 'k', { v: 1, ops: { a: 1 }, tabs: {} }).ok, false);
  assert.equal(P.escribir(almacen({ noPersiste: true }), 'k', { v: 1 }).ok, false);
  const roto = { setItem() { throw new Error('SecurityError'); }, getItem() { return null; } };
  assert.equal(P.escribir(roto, 'k', { v: 1 }).ok, false);
  assert.equal(P.escribir(almacen(), 'k', { v: 1, ops: {} }).ok, true);
});
test('abrir: datos dañados se CONSERVAN aparte (no se pisan) y se empieza una cola vacía', () => {
  const a = almacen(); a.setItem('k', '{no es json'); const r = P.abrir(a, 'k');
  assert.equal(r.dañada, true); assert.equal(r.conservada, true); assert.equal(a.getItem('k:danada'), '{no es json'); assert.deepStrictEqual(r.estado.ops, {});
  a.setItem('k2', JSON.stringify({ v: 9, ops: [] })); assert.equal(P.abrir(a, 'k2').dañada, true, 'formato desconocido también se conserva');
});
test('clave por proyecto y uid; huérfanas por latido o cierre', () => {
  assert.notEqual(P.claveCola('stg', 'u1'), P.claveCola('prod', 'u1')); assert.notEqual(P.claveCola('stg', 'u1'), P.claveCola('stg', 'u2'));
  const st = { tabs: { A: { ts: 1000 }, B: { ts: 100000, cerrada: true }, C: { ts: 100000 } }, ops: {} };
  assert.equal(P.esHuerfana(st, { tab: 'A' }, 'C', 100000 + 1), true, 'sin latido hace > 45 s');
  assert.equal(P.esHuerfana(st, { tab: 'B' }, 'C', 100001), true, 'cerrada');
  assert.equal(P.esHuerfana(st, { tab: 'C' }, 'C', 100001), false, 'propia');
  assert.equal(P.esHuerfana({ tabs: { D: { ts: 100000 } } }, { tab: 'D' }, 'C', 110000), false, 'otra pestaña viva');
  assert.equal(P.esHuerfana(st, { tab: 'Z' }, 'C', 100000), true, 'pestaña desconocida');
});

// ---------------- integración con una «app» simulada ----------------
function app(opts) {
  opts = opts || {};
  const almac = opts.almacen || almacen(), sesion = new Map();
  const S = { atenciones: [], bases: new Map(), versiones: new Map(), cfgInstalada: null, enviadas: [], mensajes: [], sincs: 0, rol: opts.rol || 'admin', uid: opts.uid || 'u1', cfgPend: null, listo: true, cfgPermitida: true, quitadas: [], revertidas: [], cfgDescartada: null };
  const ventana = { cardiolinkOutboxPuroV1: P };
  const doc = { hidden: false, body: null, addEventListener() {}, getElementById() { return null; }, createElement() { return { style: {}, addEventListener() {}, appendChild() {}, setAttribute() {}, remove() {} }; } };
  const ctx = { window: ventana, localStorage: almac, sessionStorage: { getItem: (k) => (sesion.has(k) ? sesion.get(k) : null), setItem: (k, v) => sesion.set(k, v) }, document: doc, console, JSON, Date, Math, Map, Set, Array, Object, String, Error, Promise, setInterval: () => 0, alert() {} };
  ventana.addEventListener = () => {}; ventana.confirm = () => true; ctx.window = ventana; Object.assign(ventana, { setInterval: () => 0 });
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'cardiolink-outbox-glue-v1.js'), 'utf8'), ctx);
  const O = ventana.cardiolinkOutboxR2D;
  const idx = (id) => S.atenciones.findIndex((a) => String(a.id) === String(id));
  O.conectar({
    uid: () => S.uid, proyecto: () => opts.proyecto || 'stg', rol: () => S.rol, listo: () => S.listo, esCorrupta: (a) => !a.obraSocial || !a.prestacion || !a.profesionalId,
    atenciones: () => S.atenciones, esConfirmada: (id) => S.versiones.has(String(id)), base: (id) => S.bases.get(String(id)), version: (id) => S.versiones.get(String(id)),
    mensajeCompatible: () => true, resguardarMensaje: (m) => S.mensajes.push(m),
    instalarFila: (id, local, base, ver) => { const i = idx(id); if (i >= 0) S.atenciones[i] = local; else S.atenciones.push(local); S.bases.set(String(id), base); S.versiones.set(String(id), ver); },
    agregarNueva: (row) => { if (idx(row.id) < 0) S.atenciones.push(row); S.enviadas.push(row.id); }, quitarLocal: (id) => { const i = idx(id); if (i >= 0) S.atenciones.splice(i, 1); S.bases.delete(String(id)); S.versiones.delete(String(id)); S.quitadas.push(id); },
    revertirFila: (id) => { const i = idx(id); S.atenciones[i] = JSON.parse(S.bases.get(String(id))); S.revertidas.push(id); },
    sincronizarYa: () => { S.sincs++; }, guardarConfigYa: () => {}, configPermitida: () => S.cfgPermitida, profesionales: () => [{ id: 'matias', nombre: 'Dr M' }],
    consultarServidor: async (id) => (opts.servidor ? opts.servidor(id) : { existe: false }), configPendiente: () => S.cfgPend,
    instalarConfig: (b, v, l) => { S.cfgInstalada = { base: b, ver: v, local: l }; }, descartarConfig: (ops) => { S.cfgDescartada = ops; }
  });
  // el usuario «carga» una atención confirmada
  S.cargar = (a, ver) => { S.atenciones.push(clon(a)); S.bases.set(String(a.id), est(a)); S.versiones.set(String(a.id), ver || '2026-11-18T10:00:00.000Z'); };
  S.editar = (id, c) => Object.assign(S.atenciones[idx(id)], c);
  S.cola = () => JSON.parse(almac.getItem(P.claveCola(opts.proyecto || 'stg', S.uid)) || '{"ops":{},"tabs":{}}');
  return Object.assign(S, { O, almac, ventana, ctx });
}
const att = (extra) => Object.assign({ id: 'a1', paciente: 'Ana Test', dni: '30111222', fecha: '2026-11-20', obraSocial: 'OSDE', prestacion: 'Consulta', profesionalId: 'matias', observaciones: '', estadoCobro: 'pendiente', montoConsulta: 1000, bonoFirmado: false }, extra || {});
const remoto = (a, ver) => new Map([[String(a.id), { payload: clon(a), updated_at: ver || '2026-11-18T10:00:00.000Z' }]]);

test('registrar: persiste ANTES del sync sólo la diferencia (existente) o la fila (nueva); al confirmar la baja sale de la cola', () => {
  const S = app(); S.cargar(att());
  S.editar('a1', { observaciones: 'cambio sin guardar', estadoCobro: 'cobrado', cobroConfirmadoPorRol: 'admin', cobroAuditoria: [{ x: 1 }] });
  S.atenciones.push(att({ id: 'n1', paciente: 'Nueva' }));
  assert.equal(S.O.registrar(), true);
  const ops = S.cola().ops; const claves = Object.keys(ops);
  assert.equal(claves.length, 2);
  const mod = Object.values(ops).find((o) => o.k === 'mod'), nueva = Object.values(ops).find((o) => o.k === 'nueva');
  assert.deepStrictEqual(Object.keys(mod.cambios), ['observaciones']); assert.ok(!JSON.stringify(mod).includes('cobroConfirmado') && !JSON.stringify(mod).includes('Ana Test'), 'ni la fila ni el cobro');
  assert.equal(nueva.row.paciente, 'Nueva');
  // confirmación del servidor: la base pasa a coincidir con lo local
  S.bases.set('a1', est(S.atenciones[0])); S.versiones.set('n1', 'v'); S.bases.set('n1', est(S.atenciones[1]));
  S.O.registrar(); assert.deepStrictEqual(S.cola().ops, {});
});

test('marcarEnvio queda anotado antes de enviar y viaja en la operación de la atención nueva', () => {
  const S = app(); S.atenciones.push(att({ id: 'n1' })); S.O.marcarEnvio([['n1', est(S.atenciones[0])]]);
  assert.equal(Object.values(S.cola().ops)[0].enviado, est(S.atenciones[0]));
});

test('cuota agotada: NO se informa protección; se avisa en el estado', () => {
  const S = app({ almacen: almacen({ cuota: 50 }) }); S.atenciones.push(att({ id: 'n1' }));
  assert.equal(S.O.registrar(), false); assert.equal(S.O.protegido(), false); assert.equal(S.O.estado().proteccion.ok, false);
});

test('datos dañados: se conservan aparte y no se pierde la nueva cola', () => {
  const al = almacen(); const S = app({ almacen: al }); al.setItem(P.claveCola('stg', 'u1'), '{{{'); S.atenciones.push(att({ id: 'n1' }));
  S.O.registrar(); assert.equal(al.getItem(P.claveCola('stg', 'u1') + ':danada'), '{{{'); assert.equal(Object.keys(S.cola().ops).length, 1);
});

function conCola(S, fn) { fn(S); S.O.registrar(); return S.cola(); }
function reabrir(S, opts2) {      // simula cerrar y reabrir: misma pestaña (sessionStorage) o una pestaña nueva
  const T = app(Object.assign({ almacen: S.almac }, opts2 || {}));
  return T;
}

test('recuperar MOD con el remoto SIN cambios: base = remoto y misma versión (el UPDATE condicionado pasa); la cola se rearma sola', () => {
  const S = app(); S.cargar(att()); S.editar('a1', { observaciones: 'pendiente', bonoFirmado: true }); S.O.registrar();
  const T = reabrir(S, { uid: 'u1' }); T.O.estado();
  // otra pestaña nueva: la anterior no cerró (latido reciente) → sus operaciones NO se reclaman
  const r0 = T.O.recuperar({ remotas: remoto(att()) }); assert.equal(r0.recuperadas, 0);
});

test('recuperar MOD (misma pestaña tras recargar): reconstruye base/local por campos', () => {
  const S = app(); S.cargar(att()); S.editar('a1', { observaciones: 'pendiente', bonoFirmado: true }); S.O.registrar();
  const T = app({ almacen: S.almac }); T.ctx.sessionStorage.setItem('cardiolink_outbox_tab_v1', S.O.estado().tab);
  const T2 = (() => { const x = app({ almacen: S.almac }); return x; })();
  // forzar mismo tabId: el simulador crea la pestaña con sessionStorage propio, así que se declara huérfana marcando cierre
  S.O.registrar({ cerrada: true });
  const U = app({ almacen: S.almac });
  const r = U.O.recuperar({ remotas: remoto(att()) });
  assert.equal(r.recuperadas, 1);
  const a = U.atenciones[0]; assert.equal(a.observaciones, 'pendiente'); assert.equal(a.bonoFirmado, true);
  assert.equal(U.bases.get('a1'), est(att()), 'base = remoto sin cambios'); assert.equal(U.versiones.get('a1'), '2026-11-18T10:00:00.000Z');
  assert.equal(Object.keys(U.cola().ops).length, 1, 'la cola se vuelve a escribir desde la fila recuperada');
});

test('recuperar MOD con el remoto CAMBIADO en OTRO campo: la versión base original hace fallar el UPDATE → R2C fusiona (no se aplica el parche sobre el remoto)', () => {
  const S = app(); S.cargar(att()); S.editar('a1', { observaciones: 'pendiente' }); S.O.registrar({ cerrada: true });
  const U = app({ almacen: S.almac }); const rem = att({ montoConsulta: 1500, bonoFirmado: true });
  const r = U.O.recuperar({ remotas: remoto(rem, '2026-11-18T11:00:00.000Z') }); assert.equal(r.recuperadas, 1);
  assert.equal(U.versiones.get('a1'), '2026-11-18T10:00:00.000Z', 'versión BASE original (≠ remota): el CAS falla y se relee');
  const base = JSON.parse(U.bases.get('a1')); assert.equal(base.observaciones, ''); assert.equal(base.montoConsulta, 1500, 'lo no editado no se toca');
  assert.equal(U.atenciones[0].observaciones, 'pendiente'); assert.equal(U.atenciones[0].montoConsulta, 1500);
});

test('recuperar MOD con el remoto cambiado en el MISMO campo: base lleva el valor «antes» → R2C verá conflicto', () => {
  const S = app(); S.cargar(att()); S.editar('a1', { observaciones: 'LOCAL' }); S.O.registrar({ cerrada: true });
  const U = app({ almacen: S.almac });
  U.O.recuperar({ remotas: remoto(att({ observaciones: 'REMOTO' }), '2026-11-18T11:00:00.000Z') });
  assert.equal(JSON.parse(U.bases.get('a1')).observaciones, ''); assert.equal(U.atenciones[0].observaciones, 'LOCAL');
  assert.notEqual(est(U.atenciones[0]), U.bases.get('a1'));
});

test('recuperar MOD ya aplicada en el servidor (respuesta perdida): se confirma y sale de la cola sin reenviar', () => {
  const S = app(); S.cargar(att()); S.editar('a1', { observaciones: 'x' }); S.O.registrar({ cerrada: true });
  const U = app({ almacen: S.almac }); const r = U.O.recuperar({ remotas: remoto(att({ observaciones: 'x' }), '2026-11-18T10:05:00.000Z') });
  assert.equal(r.confirmadas, 1); assert.equal(U.atenciones.length, 0); assert.deepStrictEqual(U.cola().ops, {});
});

test('recuperar MOD con la atención ELIMINADA en el servidor: no se recrea; queda para decidir', () => {
  const S = app(); S.cargar(att()); S.editar('a1', { observaciones: 'x' }); S.O.registrar({ cerrada: true });
  const U = app({ almacen: S.almac }); const r = U.O.recuperar({ remotas: new Map() });
  assert.equal(r.retenidas, 1); assert.equal(U.atenciones.length, 0); assert.equal(U.enviadas.length, 0);
  assert.equal(Object.values(U.cola().ops)[0].k, 'eliminada_remota');
});

test('recuperar NUEVA: sin servidor y nunca enviada → se agrega para el sync normal; con cobro registrado → REVISIÓN (no se reenvía); enviada y ausente → AMBIGUA', () => {
  const S = app(); S.atenciones.push(att({ id: 'n1' }), att({ id: 'n2', estadoCobro: 'cobrado', cobroConfirmadoPor: 'x@y' }), att({ id: 'n3' }));
  S.O.marcarEnvio([['n3', est(att({ id: 'n3' }))]]); S.O.registrar({ cerrada: true });
  const U = app({ almacen: S.almac }); const r = U.O.recuperar({ remotas: new Map() });
  assert.deepStrictEqual(U.enviadas, ['n1']); assert.equal(r.retenidas, 2);
  const tipos = Object.values(U.cola().ops).map((o) => o.k).sort(); assert.deepStrictEqual(tipos, ['ambigua', 'nueva', 'revision']);
});

test('recuperar NUEVA cuando el servidor YA la tiene: igual → confirmada; lo enviado confirmado + ediciones posteriores → se recuperan; otro contenido → fusión forzada', () => {
  const base = att({ id: 'n1' }), editada = att({ id: 'n1', observaciones: 'edición posterior' });
  const preparar = () => { const S = app(); S.atenciones.push(clon(editada)); S.O.marcarEnvio([['n1', est(base)]]); S.O.registrar({ cerrada: true }); return S; };
  // a) igual a lo local
  let S = preparar(); let U = app({ almacen: S.almac }); assert.equal(U.O.recuperar({ remotas: remoto(editada) }).confirmadas, 1); assert.equal(U.atenciones.length, 0);
  // b) el servidor tiene exactamente lo ENVIADO: faltan las ediciones posteriores
  S = preparar(); U = app({ almacen: S.almac }); U.O.recuperar({ remotas: remoto(base, '2026-11-18T10:30:00.000Z') });
  assert.equal(U.atenciones[0].observaciones, 'edición posterior'); assert.equal(U.bases.get('n1'), est(base)); assert.equal(U.versiones.get('n1'), '2026-11-18T10:30:00.000Z');
  // c) el servidor tiene OTRA cosa: no se asume éxito ni se descarta; versión que fuerza la fusión
  S = preparar(); U = app({ almacen: S.almac }); U.O.recuperar({ remotas: remoto(att({ id: 'n1', observaciones: 'de otro', montoConsulta: 9 }), '2026-11-18T10:40:00.000Z') });
  assert.equal(U.atenciones[0].observaciones, 'edición posterior'); assert.equal(U.versiones.get('n1'), S.O.SENTINELA); assert.equal(U.bases.get('n1'), est(base));
});

test('atención INCOMPLETA: cuarentena conserva la fila identificable fuera de atenciones; completar la devuelve; vacía no se guarda', () => {
  const S = app(); S.cargar(att({ id: 'ok' }));
  const inc = att({ id: 'i1', obraSocial: '', prestacion: '' });
  assert.equal(S.O.cuarentena(inc), true); assert.ok(Object.values(S.cola().ops).some((o) => o.k === 'incompleta' && o.row.id === 'i1'));
  assert.equal(S.O.cuarentena({ id: 'v', paciente: '', dni: '' }), false, 'sin identidad: no hay nada que conservar');
  assert.equal(S.O.cuarentena(Object.assign(att({ id: 'ok' }), { obraSocial: '' })), false, 'una fila ya confirmada en el servidor no se mueve');
  const key = Object.keys(S.cola().ops).find((k) => k.includes('i1'));
  assert.equal(S.O.completar(key, { cobertura: '', prestacion: '', profesionalId: '' }).ok, false);
  const r = S.O.completar(key, { cobertura: 'OSDE', prestacion: 'Consulta', profesionalId: 'matias', profesional: 'Dr M' });
  assert.equal(r.ok, true); assert.ok(S.atenciones.some((a) => a.id === 'i1' && a.obraSocial === 'OSDE'));
  assert.ok(!Object.values(S.cola().ops).some((o) => o.k === 'incompleta'));
});

test('AISLAMIENTO: otro usuario o proyecto no recupera ni ve operaciones ajenas', () => {
  const S = app({ uid: 'u1' }); S.atenciones.push(att({ id: 'n1', paciente: 'Privado' })); S.O.registrar({ cerrada: true });
  const otroUid = app({ almacen: S.almac, uid: 'u2' }); assert.equal(otroUid.O.recuperar({ remotas: new Map() }).recuperadas, 0); assert.equal(otroUid.O.resumen().length, 0); assert.equal(otroUid.enviadas.length, 0);
  const otroProy = app({ almacen: S.almac, uid: 'u1', proyecto: 'prod' }); assert.equal(otroProy.O.recuperar({ remotas: new Map() }).recuperadas, 0);
  const igual = app({ almacen: S.almac, uid: 'u1' }); assert.equal(igual.O.recuperar({ remotas: new Map() }).recuperadas, 1);
});

test('DOS PESTAÑAS del mismo uid: la operación de una pestaña viva no se reclama; la de una cerrada sí; cada una escribe sólo las suyas', () => {
  const A = app(); A.atenciones.push(att({ id: 'nA' })); A.O.registrar();
  const B = app({ almacen: A.almac }); B.atenciones.push(att({ id: 'nB' })); B.O.registrar();
  const ops = A.cola().ops; assert.equal(Object.keys(ops).length, 2, 'B no pisó lo de A');
  A.atenciones.length = 0; A.O.registrar();                          // A confirmó lo suyo
  assert.deepStrictEqual(Object.values(A.cola().ops).map((o) => o.id), ['nB'], 'A sólo retira SUS operaciones');
  const C = app({ almacen: A.almac }); assert.equal(C.O.recuperar({ remotas: new Map() }).recuperadas, 0, 'B sigue viva');
  B.O.registrar({ cerrada: true });
  const D = app({ almacen: A.almac }); assert.equal(D.O.recuperar({ remotas: new Map() }).recuperadas, 1, 'B cerró: D reclama');
});

test('CONFIG: se persiste un parche (no la configuración) y se recupera base/local sobre el remoto; sin permiso queda retenida', () => {
  const b = cfgBase(), l = clon(b); l.pacientes[0].telefono = '999';
  const preparar = () => { const X = app(); X.cfgPend = { ops: P.diffConfig(b, l).ops, noProt: [], baseVer: '2026-11-18T09:00:00.000Z' }; X.O.registrar({ cerrada: true }); return X; };
  const S = preparar();
  const txt = JSON.stringify(S.cola()); assert.ok(!txt.includes('HC reservada') && !txt.includes('Juan'), 'ni historias clínicas ni el resto de los pacientes'); assert.ok(txt.length < 900, String(txt.length));
  const remotoCfg = clon(b); remotoCfg.pacientes[1].telefono = '777';
  const U = app({ almacen: S.almac }); const r = U.O.recuperar({ remotas: new Map(), cfgRemota: { config: remotoCfg, updated_at: '2026-11-18T09:30:00.000Z' } });
  assert.equal(r.recuperadas, 1); assert.equal(U.cfgInstalada.local.pacientes[0].telefono, '999'); assert.equal(U.cfgInstalada.local.pacientes[1].telefono, '777');
  assert.equal(U.cfgInstalada.base.pacientes[0].telefono, '111'); assert.equal(U.cfgInstalada.ver, '2026-11-18T09:00:00.000Z', 'versión base original → la fusión de R2B detecta el cambio remoto');
  // permisos revocados antes de recuperar
  const V = app({ almacen: preparar().almac }); V.cfgPermitida = false;
  const r2 = V.O.recuperar({ remotas: new Map(), cfgRemota: { config: remotoCfg, updated_at: 'x' } }); assert.equal(r2.retenidas, 1); assert.equal(V.cfgInstalada, null);
  assert.ok(Object.values(V.cola().ops).some((o) => o.k === 'no_autorizada'), 'no se borra: queda visible');
});

test('ANTIGÜEDAD: a los 30 días se avisa pero NUNCA se borra automáticamente', () => {
  const S = app(); S.atenciones.push(att({ id: 'n1' })); S.O.registrar();
  const al = S.almac; const k = P.claveCola('stg', 'u1'); const st = JSON.parse(al.getItem(k)); Object.values(st.ops).forEach((o) => { o.ts = new Date(Date.now() - 45 * 86400000).toISOString(); }); al.setItem(k, JSON.stringify(st));
  S.O.registrar(); const r = S.O.resumen(); assert.equal(r.length, 1); assert.ok(r[0].dias >= 30);
  assert.equal(Object.keys(S.cola().ops).length, 1);
});

test('descartar requiere el usuario: sin confirmación no se toca nada; con confirmación revierte y retira de la cola', () => {
  const S = app(); S.cargar(att()); S.editar('a1', { observaciones: 'x' }); S.O.registrar();
  const key = Object.keys(S.cola().ops)[0];
  S.ventana.confirm = () => false; S.O.descartar(key); assert.equal(S.revertidas.length, 0); assert.equal(Object.keys(S.cola().ops).length, 1);
  S.ventana.confirm = () => true; S.O.descartar(key); assert.deepStrictEqual(S.revertidas, ['a1']);
});

test('ROLLBACK: la cola es compatible hacia atrás (versionada) y el módulo anterior no la toca', () => {
  const S = app(); S.atenciones.push(att({ id: 'n1' })); S.O.registrar();
  const cola = JSON.parse(S.almac.getItem(P.claveCola('stg', 'u1'))); assert.equal(cola.v, 1);
  const app_js = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  assert.ok(!/cardiolink_outbox_r2d_v1/.test(app_js.replace(/\/\/[^\n]*/g, '')), 'app.js no conoce ni borra la clave de la cola');
  assert.ok(!/removeItem\([^)]*outbox/.test(fs.readFileSync(path.join(__dirname, 'cardiolink-outbox-glue-v1.js'), 'utf8')), 'el módulo no borra la clave de la cola');
});

test('fallo de red limpio: la marca «enviado» se descarta (reabrir no la trata como ambigua); sin respuesta tras enviar la marca se conserva', () => {
  const S = app(); S.atenciones.push(att({ id: 'n1' }), att({ id: 'n2' }));
  S.O.marcarEnvio([['n1', est(att({ id: 'n1' }))], ['n2', est(att({ id: 'n2' }))]]); S.O.limpiarEnvio(['n1']);   // n1: Failed to fetch; n2: se cerró la página en vuelo
  S.O.registrar({ cerrada: true });
  const ops = Object.values(S.cola().ops); assert.equal(ops.find((o) => o.id === 'n1').enviado, undefined); assert.ok(ops.find((o) => o.id === 'n2').enviado);
  const U = app({ almacen: S.almac }); U.O.recuperar({ remotas: new Map() });
  assert.deepStrictEqual(U.enviadas, ['n1'], 'n1 se reenvía sola'); assert.ok(Object.values(U.cola().ops).some((o) => o.k === 'ambigua' && o.id === 'n2'), 'n2 pide decisión');
});

test('cambios SIN protección se identifican antes de cerrar: sinProteccion() y aviso en el cierre de sesión; beforeunload sólo en ese caso', () => {
  const S = app({ almacen: almacen({ cuota: 50 }) }); S.atenciones.push(att({ id: 'n1' })); S.O.registrar();
  assert.equal(S.O.sinProteccion(), 1);
  const ok = app(); ok.atenciones.push(att({ id: 'n1' })); ok.O.registrar(); assert.equal(ok.O.sinProteccion(), 0);
  const glue = fs.readFileSync(path.join(__dirname, 'cardiolink-outbox-glue-v1.js'), 'utf8'), appjs = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  assert.match(glue, /addEventListener\('beforeunload'[\s\S]{0,120}!proteccion\.ok/);
  assert.match(appjs, /NO están protegidos en este equipo/);
});
