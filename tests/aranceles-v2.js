'use strict';

// tests/aranceles-v2.js — Convenios y Aranceles V2 (Paso 1). Núcleo puro (comportamiento real) + comprobaciones estáticas del módulo de interfaz y su cableado.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const leer = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const C = require('../cardiolink-aranceles-v2-core.js');

const pruebas = [];
const prueba = (n, f) => pruebas.push({ n, f });
const cfg = () => ({ obrasSociales: ['IOMA', 'OSDE', 'PAMI'], arancelesPorProfesional: {} });
const V0 = '2026-08-01';
const cambio = (os, prest, valor, campo) => ({ os, prest, campo: campo || 'valor', valor, vacio: valor === null });
const filas = (c, pid) => (c.arancelesPorProfesional[pid] || []);

prueba('M1 formato monetario argentino y vacíos', () => {
  const v = t => C.parsearMonto(t);
  assert.equal(v('$ 35.000').valor, 35000); assert.equal(v('35.000,50').valor, 35000.5); assert.equal(v('35000').valor, 35000);
  assert.equal(v('1.234.567').valor, 1234567); assert.equal(v('35,5').valor, 35.5); assert.equal(v('35.5').valor, 35.5);
  assert.equal(v('0').valor, 0); assert.equal(v('0').vacio, false, '0 es un valor explícito');
  ['', '  ', '-', '—', 's/i', 'sin informar'].forEach(t => { assert.equal(v(t).vacio, true, t); assert.equal(v(t).valor, null); });
  ['abc', '-5', '12.34.56', '1,2,3', '1.23', '35.0000'].forEach(t => assert.equal(v(t).ok, t === '1.23' ? true : false, 'inválido: ' + t));
});

prueba('M2 fechas dd/mm/aaaa y ISO; inválidas se rechazan', () => {
  assert.equal(C.parsearFecha('01/08/2026'), '2026-08-01'); assert.equal(C.parsearFecha('1/8/26'), '2026-08-01'); assert.equal(C.parsearFecha('2026-08-01'), '2026-08-01');
  assert.equal(C.parsearFecha('31/02/2026'), ''); assert.equal(C.parsearFecha('xx'), ''); assert.equal(C.esFecha('2026-13-01'), false);
});

prueba('M3 CSV/TSV: delimitador automático, comillas y filas vacías', () => {
  assert.deepEqual(C.parsearTabla('a\tb\n1\t2\n\n'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(C.parsearTabla('a;b\n"1;5";2'), [['a', 'b'], ['1;5', '2']]);
  assert.deepEqual(C.parsearTabla('﻿a,b\r\n"x ""y""",2'), [['a', 'b'], ['x "y"', '2']]);
});

prueba('A1 alta de un valor: una fila por profesional+convenio+prestación+vigencia; repetirlo no duplica', () => {
  const c = cfg();
  const r1 = C.aplicar(c, 'matias', [cambio('IOMA', 'Consulta', 35000)], V0);
  assert.equal(r1.nuevo, 1); assert.equal(filas(c, 'matias').length, 1);
  const f = filas(c, 'matias')[0];
  assert.equal(f.valor, 35000); assert.equal(f.vigenteDesde, V0); assert.equal(f.activo, true); assert.equal(f.profesionalId, 'matias'); assert.equal(f.copago, null);
  const r2 = C.aplicar(c, 'matias', [cambio('IOMA', 'Consulta', 35000)], V0);
  assert.equal(r2.igual, 1); assert.equal(filas(c, 'matias').length, 1);
  const r3 = C.aplicar(c, 'matias', [cambio('IOMA', 'Consulta', 35000)], '2026-09-01');
  assert.equal(r3.igual, 1, 'mismo valor con otra vigencia posterior: no hace falta una fila nueva'); assert.equal(filas(c, 'matias').length, 1);
});

prueba('A2 un vacío NUNCA sobrescribe; 0 es un valor explícito distinto de sin informar', () => {
  const c = cfg();
  C.aplicar(c, 'matias', [cambio('IOMA', 'Consulta', 35000)], V0);
  const r = C.aplicar(c, 'matias', [cambio('IOMA', 'Consulta', null), { os: 'IOMA', prest: 'Consulta', campo: 'valor', valor: undefined }], V0);
  assert.equal(r.vacio, 2); assert.equal(filas(c, 'matias')[0].valor, 35000);
  C.aplicar(c, 'matias', [cambio('OSDE', 'Consulta', 0)], V0);
  const o = filas(c, 'matias').find(f => f.obraSocial === 'OSDE');
  assert.equal(o.valor, 0); assert.equal(C.vigente(c, 'matias', 'OSDE', 'Consulta', V0).estado, 'valor');
  assert.equal(C.vigente(c, 'matias', 'PAMI', 'Consulta', V0).estado, 'sin_fila', 'sin cargar = sin informar, no se inventa nada');
});

prueba('A3 vigencia histórica: un valor nuevo con fecha posterior no cambia lo anterior', () => {
  const c = cfg();
  C.aplicar(c, 'matias', [cambio('IOMA', 'Consulta', 35000)], V0);
  C.aplicar(c, 'matias', [cambio('IOMA', 'Consulta', 42000)], '2026-12-01');
  assert.equal(filas(c, 'matias').length, 2);
  assert.equal(C.vigente(c, 'matias', 'IOMA', 'Consulta', '2026-11-30').fila.valor, 35000);
  assert.equal(C.vigente(c, 'matias', 'IOMA', 'Consulta', '2026-12-01').fila.valor, 42000);
  assert.equal(C.vigente(c, 'matias', 'IOMA', 'Consulta', '2026-07-31').estado, 'sin_fila');
});

prueba('A4 corrección en la misma vigencia: se actualiza esa fila y queda historial (sin duplicar)', () => {
  const c = cfg();
  C.aplicar(c, 'matias', [cambio('IOMA', 'Consulta', 35000)], V0);
  const r = C.aplicar(c, 'matias', [cambio('IOMA', 'Consulta', 36000)], V0, { por: 'qa' });
  assert.equal(r.actualiza, 1); assert.equal(filas(c, 'matias').length, 1);
  const f = filas(c, 'matias')[0];
  assert.equal(f.valor, 36000); assert.equal(f.historial.length, 1); assert.equal(f.historial[0].valorAntes, 35000); assert.equal(f.historial[0].por, 'qa');
});

prueba('A5 copago informativo: se arrastra el arancel vigente y viceversa; no se pierden datos', () => {
  const c = cfg();
  C.aplicar(c, 'matias', [cambio('IOMA', 'Consulta', 35000)], V0);
  C.aplicar(c, 'matias', [cambio('IOMA', 'Consulta', 5000, 'copago')], '2026-10-01');
  const nueva = C.vigente(c, 'matias', 'IOMA', 'Consulta', '2026-10-01').fila;
  assert.equal(nueva.valor, 35000, 'el arancel vigente se arrastra'); assert.equal(nueva.copago, 5000);
  assert.equal(C.vigente(c, 'matias', 'IOMA', 'Consulta', V0).fila.copago, null, 'lo anterior no cambió');
  C.aplicar(c, 'matias', [cambio('IOMA', 'Consulta', 40000)], '2026-11-01');
  assert.equal(C.vigente(c, 'matias', 'IOMA', 'Consulta', '2026-11-01').fila.copago, 5000, 'el copago vigente se arrastra');
});

prueba('A6 archivar: lápida desde la vigencia; no borra, no cambia fechas anteriores ni reactiva valores previos', () => {
  const c = cfg();
  C.aplicar(c, 'matias', [cambio('IOMA', 'Consulta', 35000)], V0);
  C.aplicar(c, 'matias', [cambio('IOMA', 'Consulta', 42000)], '2026-10-01');
  const antes = JSON.stringify(filas(c, 'matias'));
  const r = C.archivarSerie(c, 'matias', 'IOMA', 'Consulta', '2026-11-01');
  assert.equal(r.ok, true); assert.equal(filas(c, 'matias').length, 3, 'no se borra nada');
  assert.equal(JSON.stringify(filas(c, 'matias').slice(0, 2)), antes, 'las filas existentes no se tocaron');
  assert.equal(C.vigente(c, 'matias', 'IOMA', 'Consulta', '2026-10-31').fila.valor, 42000, 'histórico intacto');
  assert.equal(C.vigente(c, 'matias', 'IOMA', 'Consulta', '2026-11-01').estado, 'archivado');
  assert.equal(C.vigente(c, 'matias', 'IOMA', 'Consulta', '2027-01-01').estado, 'archivado', 'no reaparece 35000 ni 42000');
  assert.equal(C.archivarSerie(c, 'matias', 'IOMA', 'Consulta', '2026-11-05').ok, false, 'ya archivada');
  assert.equal(C.archivarSerie(c, 'matias', 'OSDE', 'Consulta', '2026-11-05').ok, false, 'nada que archivar');
  const choque = C.archivarSerie(c, 'matias', 'IOMA', 'Consulta', '2026-10-01');
  assert.equal(choque.ok, false); assert.match(choque.error, /fecha posterior/); assert.equal(C.vigente(c, 'matias', 'IOMA', 'Consulta', '2026-10-15').fila.valor, 42000, 'no se oculta un valor que ya rigió');
  C.aplicar(c, 'matias', [cambio('IOMA', 'Consulta', 50000)], '2026-12-01');
  assert.equal(C.vigente(c, 'matias', 'IOMA', 'Consulta', '2026-12-01').fila.valor, 50000, 'se reactiva sólo cargando un valor nuevo');
  assert.equal(C.vigente(c, 'matias', 'IOMA', 'Consulta', '2026-11-15').estado, 'archivado');
});

prueba('A7 espejo de compatibilidad arancelesConvenios sólo para «matias»; otros profesionales aislados', () => {
  const c = cfg();
  C.aplicar(c, 'matias', [cambio('IOMA', 'Consulta', 35000)], V0);
  assert.equal(c.arancelesConvenios.length, 1);
  C.aplicar(c, 'rogelio', [cambio('IOMA', 'Consulta', 33000)], V0);
  assert.equal(c.arancelesConvenios.length, 1, 'cargar a otro profesional no toca el espejo');
  assert.equal(C.vigente(c, 'matias', 'IOMA', 'Consulta', V0).fila.valor, 35000);
  assert.equal(C.vigente(c, 'rogelio', 'IOMA', 'Consulta', V0).fila.valor, 33000);
  assert.equal(filas(c, 'matias').length + filas(c, 'rogelio').length, 2, 'una fila por profesional, sin duplicar producción');
});

prueba('A8 los datos existentes no se tocan al planificar; planificar no escribe', () => {
  const c = cfg();
  c.arancelesPorProfesional.matias = [{ id: 'old1', profesionalId: 'matias', obraSocial: 'IOMA', prestacion: 'Consulta', valor: 30000, copago: 0, vigenteDesde: '2026-01-01', activo: true }];
  const copia = JSON.stringify(c);
  const plan = C.planificar(c, 'matias', [cambio('IOMA', 'Consulta', 35000), cambio('IOMA', 'Consulta', 35000), cambio('OSDE', 'Consulta', null)], V0);
  assert.equal(JSON.stringify(c), copia, 'planificar es de sólo lectura');
  assert.deepEqual(plan.items.map(i => i.accion), ['nuevo', 'igual', 'vacio']);
  assert.equal(plan.items[0].antes, 30000);
  assert.equal(C.planificar(c, 'matias', [], 'mala').ok, false);
});

prueba('A9 filas heredadas desactivadas (activo:false) se ignoran como en los lectores actuales', () => {
  const c = cfg();
  c.arancelesPorProfesional.matias = [{ id: 'x', obraSocial: 'IOMA', prestacion: 'Consulta', valor: 1, vigenteDesde: '2026-01-01', activo: false }];
  assert.equal(C.vigente(c, 'matias', 'IOMA', 'Consulta', V0).estado, 'sin_fila');
  assert.equal(C.aplicar(c, 'matias', [cambio('IOMA', 'Consulta', 5)], V0).nuevo, 1);
});

const OPC = (o) => Object.assign({ profesionales: [{ id: 'matias', nombre: 'Dr. Matías Anchorena' }, { id: 'rogelio', nombre: 'Dr. Rogelio Anchorena' }], prestaciones: ['Consulta', 'Holter', 'Ecocardiograma Doppler'], coberturas: ['IOMA', 'OSDE', 'PAMI'], profesionalId: 'matias', vigencia: V0, campoMatriz: 'valor', crearCoberturas: false }, o || {});

prueba('I1 importación en matriz (pegado de Excel): vista previa, aplicar y reimportar sin duplicar', () => {
  const c = cfg();
  const txt = 'Convenio\tConsulta\tHolter\tEcocardiograma Doppler\nIOMA\t$ 35.000\t60.000,00\t\nosde\t42000\t-\t0\n';
  const plan = C.planificarImportacion(c, txt, OPC());
  assert.equal(plan.ok, true); assert.match(plan.formato, /matriz/);
  assert.deepEqual(plan.resumen, { nuevo: 4, actualiza: 0, igual: 0, vacio: 2, error: 0 });
  assert.equal(filas(c, 'matias').length, 0, 'la vista previa no escribe');
  const r = C.aplicarImportacion(c, plan, { por: 'qa' });
  assert.equal(r.nuevo, 4); assert.equal(filas(c, 'matias').length, 4);
  assert.equal(C.vigente(c, 'matias', 'OSDE', 'Ecocardiograma Doppler', V0).fila.valor, 0);
  assert.equal(C.vigente(c, 'matias', 'IOMA', 'Ecocardiograma Doppler', V0).estado, 'sin_fila', 'vacío: no se inventa');
  assert.equal(filas(c, 'matias').find(f => f.obraSocial === 'OSDE').obraSocial, 'OSDE', 'usa el nombre del catálogo');
  const plan2 = C.planificarImportacion(c, txt, OPC());
  assert.deepEqual(plan2.resumen, { nuevo: 0, actualiza: 0, igual: 4, vacio: 2, error: 0 }, 'reimportar el mismo archivo no cambia nada');
  const r2 = C.aplicarImportacion(c, plan2); assert.equal(r2.nuevo + r2.actualiza, 0); assert.equal(filas(c, 'matias').length, 4);
});

prueba('I2 un vacío en la importación no pisa un valor existente; un cambio real se informa como «actualiza»/«nuevo»', () => {
  const c = cfg();
  C.aplicar(c, 'matias', [cambio('IOMA', 'Consulta', 35000)], V0);
  const plan = C.planificarImportacion(c, 'Convenio;Consulta\nIOMA;\n', OPC());
  assert.equal(plan.resumen.vacio, 1); C.aplicarImportacion(c, plan); assert.equal(filas(c, 'matias')[0].valor, 35000);
  const p2 = C.planificarImportacion(c, 'Convenio;Consulta\nIOMA;36.000\n', OPC());
  assert.equal(p2.filas[0].accion, 'actualiza'); assert.equal(p2.filas[0].antes, 35000); assert.equal(p2.filas[0].despues, 36000);
  const p3 = C.planificarImportacion(c, 'Convenio;Consulta\nIOMA;36.000\n', OPC({ vigencia: '2026-12-01' }));
  assert.equal(p3.filas[0].accion, 'nuevo');
});

prueba('I3 formato lista con vigencia y profesional por fila; errores por fila no frenan las válidas', () => {
  const c = cfg();
  const txt = 'convenio,prestacion,valor,copago,vigencia,profesional\nIOMA,Consulta,"35.000",5000,01/08/2026,rogelio\nOSDE,Holter,60000,,2026-08-01,\nOSDE,Inexistente,1,,,\nNoExiste,Consulta,1,,,\nIOMA,Consulta,abc,,,\nIOMA,Holter,1,,32/13/2026,\nOSDE,Consulta,1,,,zzz';
  const plan = C.planificarImportacion(c, txt, OPC());
  assert.equal(plan.resumen.error, 5, JSON.stringify(plan.filas.map(f => f.motivo)));
  const r = C.aplicarImportacion(c, plan);
  assert.equal(filas(c, 'rogelio').length, 1); assert.equal(filas(c, 'rogelio')[0].copago, 5000); assert.equal(filas(c, 'rogelio')[0].valor, 35000);
  assert.equal(filas(c, 'matias').length, 1); assert.equal(filas(c, 'matias')[0].obraSocial, 'OSDE');
  assert.equal(r.error, 5);
});

prueba('I4 duplicados dentro del archivo: igual → una sola; distinto importe → conflicto (no se aplica ninguno)', () => {
  const c = cfg();
  const plan = C.planificarImportacion(c, 'Convenio;Consulta\nIOMA;10\nIOMA;10\nOSDE;5\nOSDE;6\n', OPC());
  assert.equal(plan.filas.filter(f => f.accion === 'nuevo').length, 2, 'la primera de cada una');
  assert.equal(plan.filas[3].accion, 'error'); assert.match(plan.filas[3].motivo, /conflicto/);
  C.aplicarImportacion(c, plan);
  assert.equal(C.vigente(c, 'matias', 'OSDE', 'Consulta', V0).fila.valor, 5, 'queda el primero y el conflicto se informa');
});

prueba('I5 convenios nuevos: sólo con confirmación; se agregan al catálogo, sin crear reglas ni destinos', () => {
  const c = cfg();
  const txt = 'Convenio;Consulta\nGaleno;45.000\n';
  const sin = C.planificarImportacion(c, txt, OPC());
  assert.equal(sin.resumen.error, 1); assert.deepEqual(sin.nuevasCoberturas, []);
  const con = C.planificarImportacion(c, txt, OPC({ crearCoberturas: true }));
  assert.deepEqual(con.nuevasCoberturas, ['Galeno']); assert.equal(con.resumen.nuevo, 1);
  const r = C.aplicarImportacion(c, con);
  assert.equal(r.coberturasNuevas, 1); assert.ok(c.obrasSociales.includes('Galeno'));
  assert.equal(c.conveniosPorProfesional, undefined, 'no inventa convenios, reglas ni destinos');
  assert.equal(C.aplicarImportacion(c, C.planificarImportacion(c, txt, OPC({ crearCoberturas: true, coberturas: ['IOMA', 'OSDE', 'PAMI', 'Galeno'] }))).coberturasNuevas, 0);
});

prueba('I8 celdas vacías de una fila/columna inválida no cuentan como errores (sólo la celda con dato)', () => {
  const c = cfg();
  const plan = C.planificarImportacion(c, 'Convenio;Consulta;Holter;MAPA\nNoExiste;10;;\nOSDE;;;\n', OPC());
  assert.deepEqual(plan.resumen, { nuevo: 0, actualiza: 0, igual: 0, vacio: 2, error: 1 });
});

prueba('I6 modo copago en matriz escribe sólo el copago informativo; encabezado irreconocible se informa', () => {
  const c = cfg();
  C.aplicar(c, 'matias', [cambio('IOMA', 'Consulta', 35000)], V0);
  const plan = C.planificarImportacion(c, 'Convenio\tConsulta\nIOMA\t5.000\n', OPC({ campoMatriz: 'copago' }));
  C.aplicarImportacion(c, plan);
  const f = filas(c, 'matias')[0]; assert.equal(f.valor, 35000); assert.equal(f.copago, 5000);
  const mal = C.planificarImportacion(c, 'solo\nuna\n', OPC());
  assert.equal(mal.ok, false);
  assert.equal(C.planificarImportacion(c, '', OPC()).ok, false);
});

prueba('I7 historial por convenio: todas las filas (también archivadas), ordenadas por prestación y vigencia', () => {
  const c = cfg();
  C.aplicar(c, 'matias', [cambio('IOMA', 'Consulta', 35000), cambio('IOMA', 'Holter', 60000)], V0);
  C.aplicar(c, 'matias', [cambio('IOMA', 'Consulta', 42000)], '2026-12-01');
  C.archivarSerie(c, 'matias', 'IOMA', 'Holter', '2027-01-01');
  const h = C.historial(c, 'matias', 'ioma');
  assert.equal(h.length, 4); assert.deepEqual(h.map(x => x.prestacion + ':' + x.vigenteDesde), ['Consulta:2026-12-01', 'Consulta:2026-08-01', 'Holter:2027-01-01', 'Holter:2026-08-01']);
  assert.equal(h[2].archivado, true);
});

/* ---------------- estáticas: interfaz y cableado ---------------- */
const UI = fs.existsSync(path.join(root,'cardiolink-aranceles-v2.js')) ? leer('cardiolink-aranceles-v2.js') : '', INDEX = leer('index.html'), APP = leer('app.js');

prueba('U1 el módulo se carga después de app.js y de Caja; núcleo antes que la interfaz; app.js NO se modificó para esto', () => {
  const i = s => INDEX.indexOf(s);
  assert.ok(i('cardiolink-aranceles-v2-core.js') > i('cardiolink-cobros-v1.js') && i('cardiolink-aranceles-v2.js') > i('cardiolink-aranceles-v2-core.js'));
  assert.ok(i('cardiolink-aranceles-v2.js') > i('app.js?v='));
  assert.ok(!/aranceles-v2|CardioLinkArancelesV2/.test(APP), 'app.js no menciona el módulo');
});

prueba('U2 snapshots: la edición NO recalcula arancelId/arancelVigencia/valorArancelEstimado salvo cambio explícito de cobertura/prestación/profesional, y nunca con cobro confirmado', () => {
  assert.match(UI, /aplicarArancelSnapshot3102Final/); assert.match(UI, /guardarEdicionModal/);
  assert.match(UI, /estadoCobro\s*===\s*'cobrado'/, 'cobro confirmado = intocable');
  assert.match(UI, /obraSocial[\s\S]{0,200}prestacion[\s\S]{0,200}profesionalId/, 'compara cobertura, prestación y profesional');
});

prueba('U3 Caja y copagos: la interfaz no llama ni redefine copagoDePrestacion, Caja ni Finanzas; el copago de la grilla se rotula informativo', () => {
  assert.ok(!/copagoDePrestacion\s*=|function\s+copagoDePrestacion|window\.copagoDePrestacion\s*=/.test(UI));
  assert.ok(!/CardioLinkFinanzasV5\s*=|cobroEfectivoAtencion\s*=/.test(UI));
  assert.match(UI, /informativo/i); assert.match(UI, /Valores del profesional/);
});

prueba('U4 guardado conjunto con permisos comerciales y persistencia verificada (sin SQL, sin fetch propio)', () => {
  assert.match(UI, /exigirConfigComercial/); assert.match(UI, /persistirConfigVisibleV1/);
  assert.ok(!/\bfetch\(|supabaseClient|\.rpc\(|service_role/i.test(UI), 'sin red propia ni claves');
});

prueba('U5 snapshots (comportamiento real, en sandbox): edición común no recalcula; cambio explícito sí; cobro confirmado nunca; baja/archivado = sin informar', () => {
  const vm = require('node:vm');
  const sb = { console, atenciones: [], data: { arancelesPorProfesional: { matias: [{ id: 'tomb', valor: null, archivado: true }, { id: 'vacio', valor: null }, { id: 'ok', valor: 5 }] } } };
  sb.window = sb; sb.document = { readyState: 'complete', addEventListener() {}, getElementById() { return null; }, querySelector() { return null; } };
  sb.setTimeout = () => 0; sb.TextDecoder = TextDecoder;
  vm.createContext(sb);
  sb.CardioLinkArancelesV2 = C;
  let llamadas = 0;
  sb.window.aplicarArancelSnapshot3102Final = function (a, forzar) { llamadas++; if (!forzar && a.arancelId) return a; a.valorArancelEstimado = 111; a.arancelId = a.__nuevoId || 'ok'; a.arancelVigencia = '2099-01-01'; return a; };
  sb.window.guardarEdicionModal = function (id) { const a = sb.atenciones.find(x => String(x.id) === String(id)); sb.__editar(a); sb.window.aplicarArancelSnapshot3102Final(a, true); };
  vm.runInContext(UI, sb);
  const mk = (extra) => Object.assign({ id: 'a1', obraSocial: 'IOMA', prestacion: 'Consulta', profesionalId: 'matias', valorArancelEstimado: 35000, arancelId: 'orig', arancelVigencia: '2026-08-01' }, extra || {});
  const snap = a => [a.valorArancelEstimado, a.arancelId, a.arancelVigencia].join('|');
  // 1. edición administrativa: no recalcula
  let a = mk(); sb.atenciones = [a]; sb.__editar = x => { x.observaciones = 'x'; x.fecha = '2026-11-01'; }; llamadas = 0;
  sb.window.guardarEdicionModal('a1'); assert.equal(snap(a), '35000|orig|2026-08-01'); assert.equal(llamadas, 0);
  // 2. cambia la prestación: recálculo explícito
  a = mk(); sb.atenciones = [a]; sb.__editar = x => { x.prestacion = 'Holter'; }; llamadas = 0;
  sb.window.guardarEdicionModal('a1'); assert.equal(snap(a), '111|ok|2099-01-01'); assert.equal(llamadas, 1);
  // 3. cambia el profesional / la cobertura: idem; con el mismo nombre en otra capitalización NO cuenta como cambio
  a = mk(); sb.atenciones = [a]; sb.__editar = x => { x.obraSocial = ' ioma '; }; sb.window.guardarEdicionModal('a1'); assert.equal(snap(a), '35000|orig|2026-08-01');
  a = mk(); sb.atenciones = [a]; sb.__editar = x => { x.profesionalId = 'rogelio'; }; sb.window.guardarEdicionModal('a1'); assert.equal(a.arancelId, 'ok');
  // 4. cobro confirmado: nunca, aunque cambie todo
  a = mk({ estadoCobro: 'cobrado' }); sb.atenciones = [a]; sb.__editar = x => { x.obraSocial = 'OSDE'; x.prestacion = 'Holter'; x.profesionalId = 'rogelio'; }; sb.window.guardarEdicionModal('a1');
  assert.equal(snap(a), '35000|orig|2026-08-01');
  // 5. llamada de recálculo forzado fuera de una edición: no recalcula
  a = mk(); const antes = snap(a); sb.window.aplicarArancelSnapshot3102Final(a, true); assert.equal(snap(a), antes);
  // 6. alta de atención hacia una lápida o un valor sin informar: el snapshot queda vacío (no es un arancel cero)
  ['tomb', 'vacio'].forEach(id => { const n = { id: 'n', profesionalId: 'matias', __nuevoId: id }; sb.window.aplicarArancelSnapshot3102Final(n, false); assert.equal(n.arancelId, '', id); assert.equal(n.valorArancelEstimado, null); });
  const n2 = { id: 'n2', profesionalId: 'matias', __nuevoId: 'ok' }; sb.window.aplicarArancelSnapshot3102Final(n2, false); assert.equal(n2.valorArancelEstimado, 111);
  // 7. idempotente: cargar dos veces el módulo no apila envoltorios
  vm.runInContext(UI, sb); llamadas = 0; a = mk(); sb.atenciones = [a]; sb.__editar = x => { x.prestacion = 'Holter'; }; sb.window.guardarEdicionModal('a1'); assert.equal(llamadas, 1);
});

let falladas = 0;
pruebas.forEach(p => { try { p.f(); console.log('ok   - ' + p.n); } catch (e) { falladas++; console.log('FAIL - ' + p.n + '\n       ' + (e && e.message || e)); } });
console.log('\n' + (pruebas.length - falladas) + '/' + pruebas.length + ' pruebas');
process.exit(falladas ? 1 : 0);
