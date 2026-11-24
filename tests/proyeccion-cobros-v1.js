'use strict';
// Proyección mensual de cobros V1. Núcleo real (cardiolink-proyeccion-cobros-core.js) + chequeos estáticos de la interfaz y su cableado. Datos 100% sintéticos. Corre con Node (previsto: 22).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const C = require(path.join(root, 'cardiolink-proyeccion-cobros-core.js'));
const leer = (f) => fs.readFileSync(path.join(root, f), 'utf8');
let ok = 0, fail = 0; const pendientes = [];
const t = (n, f) => pendientes.push([n, f]);

let n = 0;
const pres = (o) => Object.assign({ id: 'pr' + (++n), cobertura: 'OSDE', professional_id: 'matias', periodo: '2026-11', cantidad: 4, total_importe: 4000, fecha_presentacion: '2026-11-26', presentado_en: '2026-11-26T15:00:00Z' }, o || {});
const PLAZOS = { osde: { cobertura: 'OSDE', dias: 60 }, galeno: { cobertura: 'Galeno', dias: 30 }, ioma: { cobertura: 'IOMA', dias: 90 }, 'swiss medical': { cobertura: 'Swiss Medical', dias: 45 } };
const clon = (x) => JSON.parse(JSON.stringify(x));
const profundo = (o) => { Object.values(o).forEach((v) => { if (v && typeof v === 'object') profundo(v); }); return Object.freeze(o); };

t('P1 · plazo: 30, 60, 90 o personalizado (entero 1–365); la cobertura se reconoce sin importar mayúsculas, tildes ni espacios', () => {
  assert.deepEqual(C.PLAZOS_PREDEFINIDOS, [30, 60, 90]);
  [1, 30, 45, 120, 365, '75', 90].forEach((x) => assert.ok(C.validarPlazo(x) !== null, String(x)));
  [0, -5, 366, 1.5, 'abc', '', null, undefined, true, NaN].forEach((x) => assert.equal(C.validarPlazo(x), null, String(x)));
  assert.equal(C.plazoDe(PLAZOS, 'OSDE'), 60); assert.equal(C.plazoDe(PLAZOS, ' osde '), 60); assert.equal(C.plazoDe(PLAZOS, 'Swiss  Medical'), 45); assert.equal(C.plazoDe(PLAZOS, 'Otra'), null); assert.equal(C.plazoDe({}, 'OSDE'), null); assert.equal(C.plazoDe(null, 'OSDE'), null);
  assert.equal(C.plazoDe({ osde: { dias: 'x' } }, 'OSDE'), null, 'un valor corrupto no se proyecta');
});

t('P2 · fecha efectiva de presentación: la elegida (cierre del 25) o, en las anteriores, el día de registro en hora de Buenos Aires; la fecha de cobro = presentación + plazo', () => {
  assert.deepEqual(C.fechaPresentacionDe({ fecha_presentacion: '2026-11-26', presentado_en: '2026-11-30T12:00:00Z' }), { fecha: '2026-11-26', origen: 'elegida' });
  assert.deepEqual(C.fechaPresentacionDe({ fecha_presentacion: null, presentado_en: '2026-11-24T01:30:00Z' }), { fecha: '2026-11-23', origen: 'registro' }, '01:30 UTC del 24 = 22:30 del 23 en Buenos Aires');
  assert.equal(C.fechaPresentacionDe({ presentado_en: 'x' }).fecha, ''); assert.equal(C.fechaPresentacionDe({ fecha_presentacion: '2026-02-30', presentado_en: '2026-03-01T12:00:00Z' }).origen, 'registro', 'una fecha elegida inválida no se usa');
  assert.equal(C.sumarDias('2026-11-26', 30), '2026-12-26'); assert.equal(C.sumarDias('2026-11-26', 60), '2027-01-25'); assert.equal(C.sumarDias('2026-11-26', 90), '2027-02-24'); assert.equal(C.sumarDias('2028-01-31', 29), '2028-02-29', 'año bisiesto');
  const r = C.proyectar({ presentaciones: [pres({ fecha_presentacion: '2026-11-26' })], plazos: PLAZOS });
  assert.equal(r.meses.length, 1); assert.equal(r.meses[0].mes, '2027-01'); assert.equal(r.meses[0].filas[0].fechaCobro, '2027-01-25'); assert.equal(r.meses[0].filas[0].plazo, 60);
});

t('P3 · por mes: total estimado, desglose por cobertura y por profesional facturante, fecha estimada de ingreso, cantidad e importe de presentaciones', () => {
  const lista = [
    pres({ id: 'a', cobertura: 'OSDE', professional_id: 'matias', cantidad: 4, total_importe: 4000, fecha_presentacion: '2026-11-26' }),             // +60 → 2027-01-25
    pres({ id: 'b', cobertura: 'OSDE', professional_id: 'rogelio', cantidad: 2, total_importe: 1500.5, fecha_presentacion: '2026-11-26' }),         // 2027-01-25
    pres({ id: 'c', cobertura: 'Galeno', professional_id: 'matias', cantidad: 1, total_importe: 700, fecha_presentacion: '2026-12-26' }),            // +30 → 2027-01-25
    pres({ id: 'd', cobertura: 'Galeno', professional_id: 'matias', cantidad: 3, total_importe: 2100, fecha_presentacion: '2026-12-28' }),           // +30 → 2027-01-27
    pres({ id: 'e', cobertura: 'IOMA', professional_id: 'matias', cantidad: 5, total_importe: 5000, fecha_presentacion: '2026-11-26' }),             // +90 → 2027-02-24
    pres({ id: 'f', cobertura: 'Swiss Medical', professional_id: 'rogelio', cantidad: 2, total_importe: 800, fecha_presentacion: '2026-12-10' })      // +45 → 2027-01-24
  ];
  const r = C.proyectar({ presentaciones: lista, plazos: PLAZOS });
  assert.deepEqual(r.meses.map((m) => m.mes), ['2027-01', '2027-02']);
  const ene = r.meses[0];
  assert.equal(ene.total, 9100.5); assert.equal(ene.cantidadPresentaciones, 5); assert.equal(ene.cantidad, 12);
  assert.deepEqual(ene.porCobertura.map((c) => [c.cobertura, c.total, c.presentaciones, c.cantidad, c.plazo]), [['Galeno', 2800, 2, 4, 30], ['OSDE', 5500.5, 2, 6, 60], ['Swiss Medical', 800, 1, 2, 45]]);
  assert.deepEqual(ene.porProfesional.map((p) => [p.profesionalId, p.total, p.presentaciones]), [['matias', 6800, 3], ['rogelio', 2300.5, 2]]);
  assert.deepEqual(ene.porFecha.map((f) => [f.fecha, f.total, f.presentaciones]), [['2027-01-24', 800, 1], ['2027-01-25', 6200.5, 3], ['2027-01-27', 2100, 1]]);
  assert.equal(r.meses[1].total, 5000); assert.equal(r.total, 14100.5); assert.equal(r.cantidadPresentaciones, 6);
  assert.equal(C.redondear(r.meses.reduce((s, m) => s + m.total, 0)), r.total, 'el total general es la suma de los meses');
  assert.equal(C.redondear(ene.porCobertura.reduce((s, c) => s + c.total, 0)), ene.total, 'el desglose por cobertura suma el total del mes'); assert.equal(C.redondear(ene.porProfesional.reduce((s, c) => s + c.total, 0)), ene.total, 'y el de profesional también');
});

t('P4 · sin duplicaciones: cada presentación cuenta una sola vez por su ID estable, aunque la lectura la traiga repetida', () => {
  const a = pres({ id: 'x1', total_importe: 1000 }), b = pres({ id: 'x2', total_importe: 500 });
  const r = C.proyectar({ presentaciones: [a, b, clon(a), clon(a), clon(b)], plazos: PLAZOS });
  assert.equal(r.total, 1500); assert.equal(r.cantidadPresentaciones, 2); assert.equal(r.duplicadasIgnoradas, 3);
  assert.equal(C.proyectar({ presentaciones: [a, Object.assign(clon(a), { total_importe: 9999 })], plazos: PLAZOS }).total, 1000, 'mismo ID con otro importe: gana la primera, no se suma dos veces');
  assert.equal(C.proyectar({ presentaciones: [a, clon(a)], plazos: {} }).sinPlazo.cantidadPresentaciones, 1, 'tampoco se duplican las que no tienen plazo');
  const dos = JSON.stringify(C.proyectar({ presentaciones: [a, b], plazos: PLAZOS })); assert.equal(JSON.stringify(C.proyectar({ presentaciones: [a, b], plazos: PLAZOS })), dos, 'recalcular da lo mismo (idempotente)');
});

t('P5 · sin plazo configurado: no se proyecta a ningún mes pero se informa aparte con su importe; datos incompletos se separan; nada se pierde en silencio', () => {
  const lista = [pres({ id: 'a', cobertura: 'OSDE', total_importe: 1000 }), pres({ id: 'b', cobertura: 'Prepaga X', total_importe: 700, cantidad: 2 }), pres({ id: 'c', cobertura: 'prepaga x', total_importe: 300, cantidad: 1 }),
    pres({ id: 'd', total_importe: 0 }), pres({ id: 'e', cobertura: '' }), pres({ id: 'f', fecha_presentacion: null, presentado_en: null }), { total_importe: 100, cobertura: 'OSDE', professional_id: 'matias', presentado_en: '2026-11-26T15:00:00Z' }];
  const r = C.proyectar({ presentaciones: lista, plazos: PLAZOS });
  assert.equal(r.total, 1000); assert.equal(r.cantidadPresentaciones, 1);
  assert.equal(r.sinPlazo.cantidadPresentaciones, 2); assert.equal(r.sinPlazo.total, 1000); assert.equal(r.sinPlazo.cantidad, 3); assert.equal(r.sinPlazo.porCobertura.length, 1, 'misma cobertura aunque cambie la grafía');
  assert.equal(r.invalidas.length, 4, 'importe 0, sin cobertura, sin fecha y sin ID quedan informadas');
  assert.equal(C.proyectar({ presentaciones: lista, plazos: {} }).total, 0, 'sin plazos no hay proyección');
});

t('P6 · cambiar el plazo recalcula la proyección y NO modifica las presentaciones (que quedan idénticas); aplicarPlazo solo toca su clave', () => {
  const lista = profundo([pres({ id: 'a', cobertura: 'OSDE', fecha_presentacion: '2026-11-26' }), pres({ id: 'b', cobertura: 'Galeno', fecha_presentacion: '2026-11-26', total_importe: 900 })]);
  const foto = JSON.stringify(lista);
  const cfg = { obrasSociales: ['OSDE'], conveniosPorProfesional: { matias: [{ obraSocial: 'OSDE' }] }, arancelesPorProfesional: { matias: [] } }, antes = clon(cfg);
  let r = C.aplicarPlazo(cfg, 'OSDE', 60); assert.deepEqual(r, { ok: true, sinCambios: false, antes: null, despues: 60 }); assert.deepEqual(cfg[C.CLAVE_CONFIG], { osde: { cobertura: 'OSDE', dias: 60 } });
  ['obrasSociales', 'conveniosPorProfesional', 'arancelesPorProfesional'].forEach((k) => assert.deepEqual(cfg[k], antes[k], k + ' intacta'));
  C.aplicarPlazo(cfg, 'Galeno', 30);
  const p60 = C.proyectar({ presentaciones: lista, plazos: cfg[C.CLAVE_CONFIG] }); assert.deepEqual(p60.meses.map((m) => m.mes), ['2026-12', '2027-01']);
  r = C.aplicarPlazo(cfg, 'osde', 90); assert.equal(r.antes, 60); assert.equal(r.despues, 90); assert.equal(cfg[C.CLAVE_CONFIG].osde.cobertura, 'OSDE', 'conserva el nombre original');
  const p90 = C.proyectar({ presentaciones: lista, plazos: cfg[C.CLAVE_CONFIG] }); assert.deepEqual(p90.meses.map((m) => m.mes), ['2026-12', '2027-02']);
  assert.equal(JSON.stringify(lista), foto, 'las presentaciones (históricas) no cambian');
  assert.equal(C.aplicarPlazo(cfg, 'OSDE', 90).sinCambios, true); assert.equal(C.aplicarPlazo(cfg, 'OSDE', 'x').ok, false); assert.equal(C.aplicarPlazo(cfg, 'OSDE', 400).ok, false); assert.equal(C.aplicarPlazo(cfg, '', 30).ok, false);
  assert.equal(cfg[C.CLAVE_CONFIG].osde.dias, 90, 'un pedido inválido no modifica nada');
  assert.deepEqual(C.aplicarPlazo(cfg, 'OSDE', null), { ok: true, sinCambios: false, antes: 90, despues: null }); assert.equal(cfg[C.CLAVE_CONFIG].osde, undefined); assert.equal(C.aplicarPlazo(cfg, 'OSDE', '').sinCambios, true);
});

t('P7 · fechas ya pasadas se marcan (V1 no concilia: no se sabe si se cobró) y no se mezclan con las futuras', () => {
  const r = C.proyectar({ presentaciones: [pres({ id: 'a', fecha_presentacion: '2026-09-01' }), pres({ id: 'b', fecha_presentacion: '2026-11-26' })], plazos: PLAZOS, hoy: '2026-12-15' });
  const filas = r.meses.flatMap((m) => m.filas); assert.equal(filas.find((f) => f.id === 'a').pasada, true); assert.equal(filas.find((f) => f.id === 'b').pasada, false);
  assert.equal(C.proyectar({ presentaciones: [pres()], plazos: PLAZOS }).meses[0].filas[0].pasada, false, 'sin «hoy» no se marca nada');
});

t('P8 · interfaz: solo Dueño/Administración, rótulo PROYECTADO bien visible, solo lectura de presentaciones, plazo guardado en la configuración con confirmación', () => {
  const UI = leer('cardiolink-proyeccion-cobros-v1.js'), src = UI.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.match(src, /const puedeVer = \(\) => rolEs\('esMatiasDuenio'\) \|\| rolEs\('esAdminComun'\);/); assert.ok(!/esSecretaria|esMedico/.test(src), 'ni Secretaría ni Médico');
  assert.match(src, /Estos importes son PROYECTADOS \(estimados\): no son dinero cobrado, no se suman a Caja ni a los ingresos efectivamente cobrados/);
  assert.match(src, /className: 'pc-proyectado', text: 'Proyectado'/); assert.match(src, /Total proyectado: /); assert.match(src, /estimado '/);
  assert.ok(!/\.(insert|upsert)\(|\.rpc\(|sb\(\)[^;]*\.(update|delete)\(|\.from\([^)]*\)\s*\.(update|delete)\(/.test(src), 'la proyección no escribe en ninguna tabla ni llama RPC');
  assert.equal((src.match(/sb\(\)\.from\(/g) || []).length, 0, 'ninguna consulta directa: solo la lectura paginada de presentaciones');
  assert.match(src, /cp\.leerTodo\(\{ sb: sb\(\), tabla: T_PRES, columnas: COLS_CIERRE/); assert.match(src, /42703/, 'sin la columna del cierre del día 25 usa el día de registro');
  assert.match(src, /exigirConfigComercial/); assert.match(src, /window\.confirm\(/); assert.match(src, /g\('persistirConfigVisibleV1'\)[\s\S]{0,160}p\('El plazo de pago'\)/); assert.match(src, /programarSyncSupabase/); assert.match(src, /ok === false \? 'error'/);
  assert.match(UI, /sel\.value === 'otro' \? \(num\.value\.trim\(\) === '' \? 'sin-valor' : num\.value\) : sel\.value/, '«Personalizado» sin número no quita el plazo: es un error');
  assert.equal(C.validarPlazo('sin-valor'), null); assert.equal(C.aplicarPlazo({ [C.CLAVE_CONFIG]: { osde: { cobertura: 'OSDE', dias: 60 } } }, 'OSDE', 'sin-valor').ok, false);
  assert.match(src, /Core\.aplicarPlazo\(d, cobertura, dias\)/); assert.match(src, /no se modifica ninguna presentación ni Caja/);
});

t('P9 · alcance: no toca Caja, Finanzas V5, atenciones ni presentaciones; no usa SQL; cableado en index.html después de Presentaciones', () => {
  const UI = leer('cardiolink-proyeccion-cobros-v1.js'), CORE = leer('cardiolink-proyeccion-cobros-core.js');
  const src = (UI + CORE).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/calcularIngresosCanonicos|copagoDePrestacion|guardarAtencion|saveAtenciones|atenciones\b|finance_expenses|cobro_|estadoCobro|cardiolink_cobros|colocador|evolucion|cardiolink_patient/i.test(src.replace(/'proyeccion-cobros[^']*'/g, '')), 'sin referencias a Caja, Finanzas, atenciones, HC ni colocaciones');
  assert.ok(!/window\.(data|atenciones)\s*=|data\.(atenciones|caja|cobros)/.test(src), 'no reasigna datos de la app');
  const idx = leer('index.html'), i = (s) => idx.indexOf(s);
  assert.ok(i('cardiolink-proyeccion-cobros-core.js') > i('cardiolink-presentaciones-os-v1.js') && i('cardiolink-proyeccion-cobros-v1.js') > i('cardiolink-proyeccion-cobros-core.js'), 'se carga después de Presentaciones y del núcleo propio');
  assert.equal((idx.match(/cardiolink-proyeccion-cobros-core\.js/g) || []).length, 1); assert.equal((idx.match(/cardiolink-proyeccion-cobros-v1\.js/g) || []).length, 1); assert.equal((idx.match(/id="proyeccionCobros"/g) || []).length, 1); assert.match(idx, /data-section="proyeccionCobros">Proyección de cobros</);
  const app = leer('app.js'); assert.ok(!/proyeccionCobros|plazosPagoCobertura/.test(app), 'app.js no se modifica');
  assert.ok(!fs.readdirSync(path.join(root, 'docs/propuestas')).some((f) => /proyeccion/i.test(f)), 'sin SQL propuesto: usa las tablas y la configuración existentes');
  // la clave de configuración es una sola y de uso propio
  assert.equal(C.CLAVE_CONFIG, 'plazosPagoCobertura');
});

(async () => {
  for (const [nombre, fn] of pendientes) { try { await fn(); ok++; console.log('  OK  ' + nombre); } catch (e) { fail++; console.log('FALLA ' + nombre + '\n      ' + (e && e.message || e)); } }
  console.log('\nproyeccion-cobros-v1: ' + ok + '/' + (ok + fail) + ' pruebas OK');
  if (fail && typeof process !== 'undefined') process.exitCode = 1;
})();
