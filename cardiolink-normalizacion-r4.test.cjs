'use strict';
// Persistencia V1 / R4 · normalización NO destructiva de la configuración y lectura única de las reglas comerciales.
// Ejecutar: node --test cardiolink-normalizacion-r4.test.cjs  (extrae las funciones reales de app.js; sin servidor ni navegador)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const APP = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

const defaults = {
  profesionales: [
    { id: 'general', nombre: 'Vista General', area: 'Todos', prestaciones: [], valores: { consulta: 0, estudio: 0, copagoConsulta: 0 } },
    { id: 'matias', nombre: 'Dr. Matías', area: 'Cardiología', prestaciones: ['Consulta', 'Electrocardiograma', 'Holter'], valores: { consulta: 35000, electro: 15000, estudio: 60000, copagoConsulta: 0, copagoElectro: 0, copagoEstudio: 0 } },
    { id: 'rogelio', nombre: 'Dr. Rogelio', area: 'Cardiología', prestaciones: ['Consulta', 'Ecocardiograma'], valores: { consulta: 30000, electro: 12000, estudio: 55000, copagoConsulta: 0, copagoElectro: 0, copagoEstudio: 0 } }
  ],
  obrasSociales: ['Particular', 'PAMI', 'OSDE', 'IOMA', 'Sancor', 'Prevención Salud', 'Integral', 'Otra'],
  reglasOS: { IOMA: 'IOMA_OSPRERA', OSPRERA: 'IOMA_OSPRERA', OSDE: 'OSDE', Sancor: 'SANCOR_PREVENCION', 'Prevención Salud': 'SANCOR_PREVENCION', Integral: 'INTEGRAL', PAMI: 'COBERTURA_COBRA_PARTICULAR' }
};
function cargar(dataInicial) {
  const a = APP.indexOf('function normalizarConfigCritica(cfg){'), b = APP.indexOf('function loadConfig(){');
  const g1 = APP.indexOf('function reglaConvenioProfesional('), g2 = APP.indexOf('function setRegla(');
  assert.ok(a > 0 && b > a && g1 > 0 && g2 > g1);
  const ctx = { structuredClone: (o) => JSON.parse(JSON.stringify(o)), defaults, data: dataInicial || {}, usuariosDefault: () => [], String, Array, Object, Number, console };
  vm.createContext(ctx);
  vm.runInContext(APP.slice(a, b) + '\n' + APP.slice(g1, g2) + '\nthis.normalizar=normalizarConfigCritica; this.getRegla=getRegla;', ctx);
  ctx.normalizar0 = ctx.normalizar; ctx.normalizar = (c) => JSON.parse(JSON.stringify(ctx.normalizar0(c)));   // salida en el reino principal (deepStrictEqual compara prototipos)
  return ctx;
}
const clon = (o) => JSON.parse(JSON.stringify(o));
const cfgReal = () => ({
  profesionales: [
    { id: 'matias', nombre: 'Dr. Matías', area: 'Cardiología', prestaciones: ['Consulta', 'Holter'], valores: { consulta: 0, electro: '', estudio: 72000, copagoConsulta: 1500, copagoElectro: null, copagoEstudio: 0 } },
    { id: 'rogelio', nombre: 'Dr. Rogelio', area: 'Cardiología', prestaciones: ['Ecocardiograma'], valores: { consulta: 28000, electro: 12000, estudio: 0, copagoConsulta: 0, copagoElectro: 0, copagoEstudio: 900 } }
  ],
  obrasSociales: ['Particular', 'OSDE', 'Swiss Medical'],
  reglasOS: { IOMA: 'GENERAL_CONSULTA_EXTRA', OSDE: 'TODO_MATIAS', PAMI: 'GENERAL_CONSULTA_EXTRA' },
  arancelesPorProfesional: { matias: [{ id: 'a1', obraSocial: 'OSDE', prestacion: 'Consulta', valor: 0, copago: 0 }] },
  conveniosPorProfesional: { matias: [{ obraSocial: 'Swiss Medical', activo: false, regla: 'SIN_REGLA' }] },
  pacientes: [{ id: 'p1', nombreCompleto: 'Ana' }]
});

test('valores 0, vacío y null son decisiones explícitas: NO se pisan; sólo se completa lo ausente y se repara lo inválido', () => {
  const { normalizar } = cargar(); const c = normalizar(cfgReal());
  const m = c.profesionales.find((p) => p.id === 'matias').valores, r = c.profesionales.find((p) => p.id === 'rogelio').valores;
  assert.equal(m.consulta, 0); assert.equal(m.electro, ''); assert.equal(m.estudio, 72000); assert.equal(m.copagoConsulta, 1500); assert.equal(m.copagoElectro, null); assert.equal(m.copagoEstudio, 0);
  assert.equal(r.estudio, 0); assert.equal(r.copagoEstudio, 900); assert.equal(r.consulta, 28000);
  const x = cfgReal(); delete x.profesionales[0].valores.electro; x.profesionales[0].valores.estudio = -5; x.profesionales[0].valores.consulta = 'abc'; x.profesionales[1].valores.consulta = NaN;
  const y = normalizar(x).profesionales; assert.equal(y[0].valores.electro, 15000, 'ausente: se completa'); assert.equal(y[0].valores.estudio, 60000, 'negativo: se repara'); assert.equal(y[0].valores.consulta, 35000, 'texto no numérico: se repara'); assert.equal(y[1].valores.consulta, 30000, 'NaN: se repara');
  const z = cfgReal(); z.profesionales[0].valores.consulta = '25000'; assert.equal(normalizar(z).profesionales[0].valores.consulta, '25000', 'texto numérico: no se toca');
});

test('prestación destildada, profesional eliminado y cobertura eliminada NO se reactivan; una instalación vacía sí se siembra', () => {
  const { normalizar } = cargar(); const c = normalizar(cfgReal());
  assert.deepStrictEqual(c.profesionales.find((p) => p.id === 'matias').prestaciones, ['Consulta', 'Holter'], 'no se vuelve a agregar «Electrocardiograma»');
  assert.deepStrictEqual(c.profesionales.find((p) => p.id === 'rogelio').prestaciones, ['Ecocardiograma'], 'no se vuelve a agregar «Consulta»');
  assert.ok(!c.profesionales.some((p) => p.id === 'general'), 'un profesional eliminado/ausente no resucita');
  assert.deepStrictEqual(c.obrasSociales, ['Particular', 'OSDE', 'Swiss Medical'], 'las coberturas eliminadas (PAMI, IOMA…) no vuelven');
  const vacia = normalizar({}); assert.equal(vacia.profesionales.length, 3); assert.ok(vacia.obrasSociales.includes('PAMI')); assert.deepStrictEqual(vacia.profesionales[1].prestaciones, ['Consulta', 'Electrocardiograma', 'Holter']);
  const sinPrest = cfgReal(); delete sinPrest.profesionales[0].prestaciones; assert.deepStrictEqual(normalizar(sinPrest).profesionales[0].prestaciones, ['Consulta', 'Electrocardiograma', 'Holter'], 'sin lista: se siembra; con lista (aunque vacía): se respeta');
  const vaciaOk = cfgReal(); vaciaOk.profesionales[0].prestaciones = []; assert.deepStrictEqual(normalizar(vaciaOk).profesionales[0].prestaciones, []);
});

test('reglas comerciales editadas se conservan (incluidas IOMA, OSDE y PAMI); sólo se completan las ausentes o vacías', () => {
  const { normalizar } = cargar(); const c = normalizar(cfgReal());
  assert.equal(c.reglasOS.IOMA, 'GENERAL_CONSULTA_EXTRA'); assert.equal(c.reglasOS.OSDE, 'TODO_MATIAS'); assert.equal(c.reglasOS.PAMI, 'GENERAL_CONSULTA_EXTRA');
  assert.equal(c.reglasOS.Sancor, 'SANCOR_PREVENCION', 'ausente: se completa'); assert.equal(c.reglasOS.Integral, 'INTEGRAL');
  const v = cfgReal(); v.reglasOS.Sancor = ''; v.reglasOS.Integral = null; const d = normalizar(v); assert.equal(d.reglasOS.Sancor, 'SANCOR_PREVENCION'); assert.equal(d.reglasOS.Integral, 'INTEGRAL');
});

test('no altera aranceles, convenios (activo:false), pacientes ni ninguna otra clave; es idempotente', () => {
  const { normalizar } = cargar(); const base = cfgReal(); const c = normalizar(clon(base));
  assert.deepStrictEqual(c.arancelesPorProfesional, base.arancelesPorProfesional); assert.deepStrictEqual(c.conveniosPorProfesional, base.conveniosPorProfesional); assert.deepStrictEqual(c.pacientes, base.pacientes);
  assert.equal(c.conveniosPorProfesional.matias[0].activo, false, 'una cobertura desactivada no se reactiva'); assert.equal(c.arancelesPorProfesional.matias[0].valor, 0);
  assert.deepStrictEqual(normalizar(clon(c)), c, 'idempotente');
  const sinCambios = normalizar(clon(base)); assert.deepStrictEqual(sinCambios.profesionales, base.profesionales, 'una config ya completa queda IDÉNTICA (sin cambios fantasma que disparen guardados)');
});

test('lectura ÚNICA de la regla: convenio del profesional (explícita) → global → fábrica → general; PAMI ya no está fijada en el código', () => {
  const ctx = cargar({ reglasOS: { OSDE: 'OSDE', PAMI: 'GENERAL_CONSULTA_EXTRA' }, conveniosPorProfesional: { rogelio: [{ obraSocial: 'OSDE', regla: 'TODO_MATIAS' }, { obraSocial: 'IOMA', regla: 'SIN_REGLA' }], matias: [{ obraSocial: ' osde ', regla: 'IOMA_OSPRERA' }] } });
  const g = ctx.getRegla;
  assert.equal(g('OSDE', 'rogelio'), 'TODO_MATIAS', 'regla explícita del profesional'); assert.equal(g('OSDE', 'matias'), 'IOMA_OSPRERA', 'compara sin espacios ni mayúsculas'); assert.equal(g('OSDE'), 'OSDE', 'sin profesional: la global');
  assert.equal(g('IOMA', 'rogelio'), 'IOMA_OSPRERA', 'SIN_REGLA se ignora: cae a la de fábrica'); assert.equal(g('Desconocida', 'rogelio'), 'GENERAL_CONSULTA_EXTRA');
  assert.equal(g('PAMI'), 'GENERAL_CONSULTA_EXTRA', 'PAMI editable: ya no se fuerza'); assert.equal(g('PAMI', 'sin-convenios'), 'GENERAL_CONSULTA_EXTRA');
});

test('app.js: sin reglas ni valores forzados, y los puntos de alta usan el profesional; los históricos siguen usando su snapshot', () => {
  const norm = APP.slice(APP.indexOf('function normalizarConfigCritica(cfg){'), APP.indexOf('function loadConfig(){'));
  assert.doesNotMatch(norm, /cfg\.reglasOS\['(IOMA|OSPRERA|OSDE|Sancor|Integral|PAMI)'\]\s*=/); assert.doesNotMatch(norm, /Number\(p\.valores\[k\]\)/); assert.doesNotMatch(norm, /def\.prestaciones\.forEach/);
  assert.doesNotMatch(APP, /if\(os==='PAMI'\) return 'COBERTURA_COBRA_PARTICULAR'/);
  ['getRegla(os,prof)', 'getRegla(osValor,profId)', 'getRegla(a.obraSocial,a.profesionalId)'].forEach((t) => assert.ok(APP.includes(t), t));
  assert.ok(APP.includes('a.reglaOS||getRegla(a.obraSocial)'), 'el fallback de históricos sin snapshot no cambia');
});

test('facturación por profesional y cobertura: con las reglas de fábrica la regla efectiva es IGUAL a la anterior a R4 para toda cobertura y profesional; un convenio de un profesional sólo cambia ESE profesional y esa cobertura', () => {
  const reglaAnterior = (data, os) => { if (os === 'PAMI') return 'COBERTURA_COBRA_PARTICULAR'; return (data.reglasOS || {})[os] || (defaults.reglasOS || {})[os] || 'GENERAL_CONSULTA_EXTRA'; };   // getRegla de main (antes de R4)
  const profs = ['matias', 'rogelio', 'humberto_drago', 'lucas_drago', 'general', undefined];
  const ctx = cargar({ reglasOS: { ...defaults.reglasOS } });             // configuración de fábrica (PAMI = cobertura cobra particular)
  defaults.obrasSociales.concat(['Particular', 'Desconocida']).forEach((os) => profs.forEach((p) => assert.equal(ctx.getRegla(os, p), reglaAnterior({ reglasOS: defaults.reglasOS }, os), os + '/' + p)));
  const c2 = cargar({ reglasOS: { ...defaults.reglasOS }, conveniosPorProfesional: { rogelio: [{ obraSocial: 'OSDE', regla: 'TODO_MATIAS' }] } });
  assert.equal(c2.getRegla('OSDE', 'rogelio'), 'TODO_MATIAS'); ['matias', 'humberto_drago', 'lucas_drago', 'general', undefined].forEach((p) => assert.equal(c2.getRegla('OSDE', p), 'OSDE', 'otro profesional: sin cambios'));
  assert.equal(c2.getRegla('IOMA', 'rogelio'), 'IOMA_OSPRERA', 'otra cobertura del mismo profesional: sin cambios');
  // ÚNICA diferencia de comportamiento respecto de main: PAMI ya no se fuerza en el código; si la configuración guardada tiene OTRA regla para PAMI, ahora se respeta (es dato a verificar en Production antes de publicar)
  const c3 = cargar({ reglasOS: { ...defaults.reglasOS, PAMI: 'GENERAL_CONSULTA_EXTRA' } });
  assert.equal(c3.getRegla('PAMI', 'matias'), 'GENERAL_CONSULTA_EXTRA'); assert.notEqual(c3.getRegla('PAMI', 'matias'), reglaAnterior({ reglasOS: {} }, 'PAMI'));
});
