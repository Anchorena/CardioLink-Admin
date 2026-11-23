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

prueba('I9 referencia de origen: columna opcional que se guarda en la fila, no pisa una existente y reimportar no cambia nada', () => {
  const c = cfg();
  const txt = 'convenio;prestacion;valor;referencia\nOSDE;Consulta;10;Excel fila 3 «APS Mercedes Benz (William Hope)»\n';
  const plan = C.planificarImportacion(c, txt, OPC());
  assert.equal(plan.resumen.nuevo, 1); C.aplicarImportacion(c, plan);
  assert.equal(filas(c, 'matias')[0].referenciaOrigen, 'Excel fila 3 «APS Mercedes Benz (William Hope)»');
  assert.equal(C.planificarImportacion(c, txt, OPC()).resumen.igual, 1);
  C.aplicarImportacion(c, C.planificarImportacion(c, 'convenio;prestacion;valor;referencia\nOSDE;Consulta;11;otra\n', OPC()));
  assert.equal(filas(c, 'matias')[0].valor, 11); assert.equal(filas(c, 'matias')[0].referenciaOrigen, 'Excel fila 3 «APS Mercedes Benz (William Hope)»', 'no se pisa la referencia original');
  assert.equal(C.historial(c, 'matias', 'OSDE')[0].referencia, 'Excel fila 3 «APS Mercedes Benz (William Hope)»');
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
  assert.equal((APP.match(/CardioLinkArancelesV2/g) || []).length, 3, 'app.js sólo consulta canonPrest en las 3 búsquedas de arancel');
  assert.equal((APP.match(/typeof cv\.canonPrest==='function'/g) || []).length, 3, 'las 3 consultas están protegidas: sin el módulo, comportamiento anterior');
});

prueba('U2 snapshots: la edición NO recalcula arancelId/arancelVigencia/valorArancelEstimado salvo cambio explícito de cobertura/prestación/profesional, y nunca con cobro confirmado', () => {
  assert.match(UI, /aplicarArancelSnapshot3102Final/); assert.match(UI, /guardarEdicionModal/);
  assert.match(UI, /estadoCobro\s*===\s*'cobrado'/, 'cobro confirmado = intocable');
  assert.match(UI, /obraSocial[\s\S]{0,200}prestacion[\s\S]{0,200}profesionalId/, 'compara cobertura, prestación y profesional');
});

prueba('U3 Caja y copagos: la interfaz no llama ni redefine copagoDePrestacion, Caja ni Finanzas; el copago de la grilla se rotula con su efecto real (precarga el formulario de nueva atención)', () => {
  assert.ok(!/copagoDePrestacion\s*=|function\s+copagoDePrestacion|window\.copagoDePrestacion\s*=/.test(UI));
  assert.ok(!/CardioLinkFinanzasV5\s*=|cobroEfectivoAtencion\s*=/.test(UI));
  assert.match(UI, /Copago del arancel/); assert.match(UI, /Valores del profesional/); assert.match(UI, /precarga|propone|propondrá/i); assert.ok(!/No cambia lo que cobra Caja/.test(UI), 'no debe afirmar que el copago es inocuo para Caja');
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

prueba('E1 equivalencias: ECG = Electrocardiograma; ECO es sólo abreviatura de Ecocardiograma Doppler; nunca se muestran como prestaciones propias', () => {
  assert.equal(C.canonPrest('ECG'), C.canonPrest('Electrocardiograma')); assert.equal(C.canonPrest(' eCg '), C.canonPrest('ELECTROCARDIOGRAMA'));
  assert.equal(C.canonPrest('ECO'), C.canonPrest('Ecocardiograma Doppler')); assert.notEqual(C.canonPrest('Holter'), C.canonPrest('MAPA'));
  assert.equal(C.nombrePrest('ECG'), 'Electrocardiograma'); assert.equal(C.nombrePrest('ECO'), 'Ecocardiograma Doppler'); assert.equal(C.nombrePrest('Holter'), 'Holter');
  const c = cfg();   // un arancel histórico cargado como «ECG» se encuentra buscando «Electrocardiograma» y al revés; no se duplica
  c.arancelesPorProfesional.matias = [{ id: 'h1', profesionalId: 'matias', obraSocial: 'Integral', prestacion: 'ECG', valor: 100, copago: 0, vigenteDesde: '2026-01-01', activo: true }];
  assert.equal(C.vigente(c, 'matias', 'Integral', 'Electrocardiograma', V0).fila.valor, 100);
  assert.equal(C.aplicar(c, 'matias', [cambio('Integral', 'Electrocardiograma', 100)], V0).igual, 1, 'mismo valor vigente: nada que agregar');
  C.aplicar(c, 'matias', [cambio('Integral', 'Electrocardiograma', 150)], '2026-08-01');
  assert.equal(filas(c, 'matias').length, 2); assert.equal(C.vigente(c, 'matias', 'Integral', 'ECG', '2026-09-01').fila.valor, 150); assert.equal(C.vigente(c, 'matias', 'Integral', 'ECG', '2026-05-01').fila.valor, 100);
});

prueba('E2 importación: «ECO» y «ECG» del Excel se resuelven a Ecocardiograma Doppler y Electrocardiograma (sin crear prestaciones)', () => {
  const c = cfg();
  const plan = C.planificarImportacion(c, 'Convenio;ECO;ECG;Holter\nOSDE;10;5;7\n', OPC({ prestaciones: ['Consulta', 'ECG', 'Electrocardiograma', 'Ecocardiograma Doppler', 'Holter'] }));
  assert.deepEqual(plan.resumen, { nuevo: 3, actualiza: 0, igual: 0, vacio: 0, error: 0 });
  C.aplicarImportacion(c, plan);
  assert.deepEqual(filas(c, 'matias').map(f => f.prestacion).sort(), ['Ecocardiograma Doppler', 'Electrocardiograma', 'Holter']);
  assert.ok(!filas(c, 'matias').some(f => /^(eco|ecg)$/i.test(f.prestacion)));
  const sinEco = C.planificarImportacion(cfg(), 'Convenio;ECO\nOSDE;10\n', OPC({ prestaciones: ['Consulta', 'Holter'] }));
  assert.equal(sinEco.resumen.error, 1, 'si el catálogo no tiene Ecocardiograma Doppler no se inventa una prestación ECO');
});

prueba('G1 configurar un convenio «igual que» otro (Sancor Salud = Sancor): copia regla, destinos y facturantes; no reemplaza ni toca datos; sin nombres fijos', () => {
  const c = cfg();
  c.reglasOS = { Sancor: 'SANCOR_PREVENCION' };
  c.conveniosPorProfesional = { matias: [{ obraSocial: 'Sancor', activo: true, regla: 'SANCOR_PREVENCION', destinoConsulta: 'Matías', destinoEstudio: 'Rogelio', facturadorConsulta: 'Matías', facturadorEstudio: 'Rogelio', bonoConsulta: true, bonoEstudio: true, firmaRequerida: true, copiaRequerida: true, incluirFacturaRogelio: true }] };
  const antes = JSON.stringify(c.conveniosPorProfesional.matias[0]);
  const r = C.copiarConfiguracionConvenio(c, 'matias', 'sancor', 'Sancor Salud');
  assert.equal(r.ok, true); assert.equal(r.regla, 'SANCOR_PREVENCION'); assert.equal(r.reglaGlobalHeredada, true);
  const n = c.conveniosPorProfesional.matias.find(x => x.obraSocial === 'Sancor Salud'), o = c.conveniosPorProfesional.matias[0];
  assert.equal(JSON.stringify(o), antes, 'el origen no cambia');
  assert.deepEqual(Object.assign({}, n, { obraSocial: 'Sancor' }), o); assert.equal(n.facturadorConsulta, 'Matías'); assert.equal(n.facturadorEstudio, 'Rogelio'); assert.equal(n.incluirFacturaRogelio, true);
  assert.notEqual(n, o); n.facturadorConsulta = 'Rogelio'; assert.equal(o.facturadorConsulta, 'Matías', 'copia independiente: el facturante se puede cambiar después sin afectar al origen');
  assert.equal(c.reglasOS['Sancor Salud'], 'SANCOR_PREVENCION'); assert.equal(c.conveniosFacturacion.length, 2, 'espejo de matias');
  assert.equal(C.copiarConfiguracionConvenio(c, 'matias', 'Sancor', 'Sancor Salud').ok, false, 'no reemplaza una configuración existente');
  assert.equal(C.copiarConfiguracionConvenio(c, 'matias', 'Inexistente', 'X').ok, false); assert.equal(C.copiarConfiguracionConvenio(c, 'matias', 'Sancor', 'sancor').ok, false);
  assert.equal(c.arancelesPorProfesional.matias, undefined, 'no toca aranceles');
  assert.ok(!/Sancor/.test(UI.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), 'la interfaz no tiene nombres de cobertura fijos');
});

prueba('R1 reglaOS: la edición común conserva la regla registrada en la atención; sólo se recalcula si cambia cobertura o profesional', () => {
  assert.match(APP, /const reglaOSPrevia=a\.reglaOS, osPrevia=a\.obraSocial, profPrevio=a\.profesionalId;/);
  assert.match(APP, /a\.reglaOS=\(reglaOSPrevia&&String\(osPrevia\)===String\(a\.obraSocial\)&&String\(profPrevio\|\|''\)===String\(a\.profesionalId\|\|''\)\)\?reglaOSPrevia:getRegla\(a\.obraSocial,a\.profesionalId\);/);
  assert.ok(!/\n\s*a\.reglaOS=getRegla\(a\.obraSocial,a\.profesionalId\);/.test(APP), 'ya no se recalcula incondicionalmente');
});

// ---- Editar convenio / Dejar sin configurar (corrección CMP) ----
const convBase = (os, extra) => Object.assign({ obraSocial: os, activo: true, regla: 'SANCOR_PREVENCION', destinoConsulta: 'Matías', destinoEstudio: 'Rogelio', facturadorConsulta: 'Matías', facturadorEstudio: 'Rogelio', bonoConsulta: true, bonoEstudio: false, firmaRequerida: true, copiaRequerida: false, incluirFacturaRogelio: true }, extra || {});
const cfgCMP = () => {
  const c = cfg();
  c.obrasSociales = ['IOMA', 'OSDE', 'PAMI', 'CMP', 'Sancor'];
  c.reglasOS = { Sancor: 'SANCOR_PREVENCION', CMP: 'SANCOR_PREVENCION', PAMI: 'COBERTURA_COBRA_PARTICULAR' };
  c.conveniosPorProfesional = { matias: [convBase('Sancor'), convBase('CMP'), convBase('Particular', { regla: 'SIN_REGLA', incluirFacturaRogelio: false })], rogelio: [convBase('Sancor', { destinoConsulta: 'Rogelio', facturadorConsulta: 'Rogelio' })] };
  c.conveniosFacturacion = JSON.parse(JSON.stringify(c.conveniosPorProfesional.matias));
  C.aplicar(c, 'matias', [cambio('CMP', 'Consulta', 20000)], V0);
  C.aplicar(c, 'rogelio', [cambio('CMP', 'Consulta', 21000)], V0);
  return c;
};

prueba('EC1 «Dejar sin configurar» quita sólo la configuración de ese profesional: conserva catálogo, aranceles, historial, otros convenios y otros profesionales', () => {
  const c = cfgCMP(), antes = JSON.parse(JSON.stringify(c));
  const r = C.quitarConfiguracionConvenio(c, 'matias', 'cmp', { IOMA: 'IOMA_OSPRERA', PAMI: 'COBERTURA_COBRA_PARTICULAR' });
  assert.equal(r.ok, true); assert.equal(r.quitada.obraSocial, 'CMP');
  assert.equal(c.conveniosPorProfesional.matias.some(x => x.obraSocial === 'CMP'), false, 'CMP sin configuración operativa para matias');
  assert.deepEqual(c.conveniosPorProfesional.matias.map(x => x.obraSocial), ['Sancor', 'Particular'], 'los demás convenios de matias quedan intactos y en orden');
  assert.deepEqual(c.conveniosPorProfesional.matias[0], antes.conveniosPorProfesional.matias[0]);
  assert.deepEqual(c.conveniosPorProfesional.rogelio, antes.conveniosPorProfesional.rogelio, 'otro profesional intacto');
  assert.deepEqual(c.arancelesPorProfesional, antes.arancelesPorProfesional, 'aranceles e historial intactos (matias y rogelio)');
  assert.deepEqual(c.obrasSociales, antes.obrasSociales, 'el catálogo no cambia'); assert.equal(r.catalogoRepuesto, false);
  assert.deepEqual(c.conveniosFacturacion.map(x => x.obraSocial), ['Sancor', 'Particular'], 'espejo legado de matias sincronizado');
  assert.equal(C.vigente(c, 'matias', 'CMP', 'Consulta', V0).estado, 'valor', 'el arancel de CMP sigue vigente');
  assert.equal(r.reglaGlobal.quitada, true); assert.equal(c.reglasOS.CMP, undefined, 'la regla global que había heredado se quita');
  assert.equal(c.reglasOS.Sancor, 'SANCOR_PREVENCION'); assert.equal(c.reglasOS.PAMI, 'COBERTURA_COBRA_PARTICULAR');
  assert.equal(C.quitarConfiguracionConvenio(c, 'matias', 'CMP').ok, false, 'repetir: ya está sin configurar');
});

prueba('EC2 regla global: se conserva si es de fábrica, si otro profesional tiene la cobertura, si el valor no coincide o si no se puede comprobar', () => {
  let c = cfgCMP(); let r = C.quitarConfiguracionConvenio(c, 'matias', 'CMP', { CMP: 'X' });
  assert.equal(r.reglaGlobal.quitada, false); assert.equal(c.reglasOS.CMP, 'SANCOR_PREVENCION', 'de fábrica');
  c = cfgCMP(); c.conveniosPorProfesional.rogelio.push(convBase('CMP')); r = C.quitarConfiguracionConvenio(c, 'matias', 'CMP', {});
  assert.equal(r.reglaGlobal.quitada, false); assert.equal(c.reglasOS.CMP, 'SANCOR_PREVENCION', 'otro profesional la usa'); assert.ok(c.conveniosPorProfesional.rogelio.some(x => x.obraSocial === 'CMP'));
  c = cfgCMP(); c.reglasOS.CMP = 'OSDE'; r = C.quitarConfiguracionConvenio(c, 'matias', 'CMP', {});
  assert.equal(r.reglaGlobal.quitada, false); assert.equal(c.reglasOS.CMP, 'OSDE', 'valor distinto: no es el heredado');
  c = cfgCMP(); r = C.quitarConfiguracionConvenio(c, 'matias', 'CMP'); assert.equal(r.reglaGlobal.quitada, false); assert.equal(c.reglasOS.CMP, 'SANCOR_PREVENCION', 'sin lista de fábrica: no se borra nada global');
});

prueba('EC3 «Particular» no se puede dejar sin configurar; una cobertura que sólo existía por su configuración conserva su nombre en el catálogo', () => {
  const c = cfgCMP(); const r = C.quitarConfiguracionConvenio(c, 'matias', 'Particular', {});
  assert.equal(r.ok, false); assert.ok(c.conveniosPorProfesional.matias.some(x => x.obraSocial === 'Particular'));
  const d = cfgCMP(); d.obrasSociales = d.obrasSociales.filter(x => x !== 'CMP');
  const q = C.quitarConfiguracionConvenio(d, 'matias', 'CMP', {}); assert.equal(q.ok, true); assert.equal(q.catalogoRepuesto, true); assert.ok(d.obrasSociales.includes('CMP'));
});

prueba('EC4 otro profesional sin espejo: quitar a rogelio no toca conveniosFacturacion', () => {
  const c = cfgCMP(); c.conveniosPorProfesional.rogelio.push(convBase('CMP')); const esp = JSON.stringify(c.conveniosFacturacion);
  const r = C.quitarConfiguracionConvenio(c, 'rogelio', 'CMP', {}); assert.equal(r.ok, true);
  assert.equal(JSON.stringify(c.conveniosFacturacion), esp); assert.ok(c.conveniosPorProfesional.matias.some(x => x.obraSocial === 'CMP'));
});

prueba('EC5 «Editar convenio»: cambia sólo lo pedido, valida, no toca otros convenios, aranceles ni el estado', () => {
  const c = cfgCMP(), antes = JSON.parse(JSON.stringify(c));
  const r = C.editarConfiguracionConvenio(c, 'matias', 'cmp', { regla: 'OSDE', destinoEstudio: 'Matías', facturadorEstudio: 'Matías', bonoEstudio: true, incluirFacturaRogelio: false, copiaRequerida: true });
  assert.equal(r.ok, true); assert.equal(r.sinCambios, false);
  assert.deepEqual(r.cambios.map(x => x.campo).sort(), ['bonoEstudio', 'copiaRequerida', 'destinoEstudio', 'facturadorEstudio', 'incluirFacturaRogelio', 'regla']);
  const n = c.conveniosPorProfesional.matias.find(x => x.obraSocial === 'CMP');
  assert.equal(n.regla, 'OSDE'); assert.equal(n.destinoEstudio, 'Matías'); assert.equal(n.facturadorEstudio, 'Matías'); assert.equal(n.bonoEstudio, true); assert.equal(n.incluirFacturaRogelio, false); assert.equal(n.copiaRequerida, true);
  assert.equal(n.destinoConsulta, 'Matías'); assert.equal(n.bonoConsulta, true); assert.equal(n.firmaRequerida, true); assert.equal(n.activo, true); assert.equal(n.obraSocial, 'CMP');
  assert.deepEqual(c.conveniosPorProfesional.matias.filter(x => x.obraSocial !== 'CMP'), antes.conveniosPorProfesional.matias.filter(x => x.obraSocial !== 'CMP'));
  assert.deepEqual(c.conveniosPorProfesional.rogelio, antes.conveniosPorProfesional.rogelio); assert.deepEqual(c.arancelesPorProfesional, antes.arancelesPorProfesional);
  assert.equal(r.reglaGlobal.sincronizada, true); assert.equal(c.reglasOS.CMP, 'OSDE', 'la regla global que acompañaba al convenio lo sigue'); assert.deepEqual(Object.assign({}, c.reglasOS, { CMP: 'SANCOR_PREVENCION' }), antes.reglasOS, 'el resto de reglasOS no cambia');
  const c2 = cfgCMP(); c2.conveniosPorProfesional.rogelio.push(convBase('CMP')); const r2 = C.editarConfiguracionConvenio(c2, 'matias', 'CMP', { regla: 'OSDE' });
  assert.equal(r2.reglaGlobal.sincronizada, false); assert.equal(c2.reglasOS.CMP, 'SANCOR_PREVENCION', 'si otro profesional tiene la cobertura, la regla global no se toca');
  const c3 = cfgCMP(); c3.reglasOS.CMP = 'INTEGRAL'; assert.equal(C.editarConfiguracionConvenio(c3, 'matias', 'CMP', { regla: 'OSDE' }).reglaGlobal.sincronizada, false); assert.equal(c3.reglasOS.CMP, 'INTEGRAL', 'una regla global propia (distinta) no se toca');
  const c4 = cfgCMP(); C.editarConfiguracionConvenio(c4, 'matias', 'CMP', { regla: 'SIN_REGLA' }); assert.equal(c4.reglasOS.CMP, undefined, 'SIN_REGLA quita la global que lo acompañaba');
  const ce = cfgCMP(); C.editarConfiguracionConvenio(ce, 'matias', 'CMP', { regla: 'OSDE' }); assert.equal(C.quitarConfiguracionConvenio(ce, 'matias', 'CMP', {}).reglaGlobal.quitada, true, 'editar y luego dejar sin configurar no deja regla global huérfana'); assert.equal(ce.reglasOS.CMP, undefined);
  assert.deepEqual(c.conveniosFacturacion, c.conveniosPorProfesional.matias, 'espejo sincronizado');
  assert.equal(C.editarConfiguracionConvenio(c, 'matias', 'CMP', { regla: 'OSDE', bonoEstudio: true }).sinCambios, true, 'repetir no cambia nada');
  const mal = JSON.stringify(c);
  [{ regla: 'INVENTADA' }, { regla: '' }, { destinoConsulta: '  ' }, { bonoConsulta: 'si' }, { firmaRequerida: 1 }].forEach(x => assert.equal(C.editarConfiguracionConvenio(c, 'matias', 'CMP', x).ok, false, JSON.stringify(x)));
  assert.equal(JSON.stringify(c), mal, 'un pedido inválido no modifica nada');
  assert.equal(C.editarConfiguracionConvenio(c, 'matias', 'Inexistente', { regla: 'OSDE' }).ok, false, 'sin configuración: se crea con «igual que», no con editar');
  c.conveniosPorProfesional.matias.find(x => x.obraSocial === 'CMP').regla = 'REGLA_PROPIA'; assert.equal(C.editarConfiguracionConvenio(c, 'matias', 'CMP', { regla: 'REGLA_PROPIA', bonoEstudio: false }).ok, true, 'una regla existente fuera de la lista se conserva');
});

prueba('EC6 interfaz: acciones «Editar convenio» y «Dejar sin configurar» con confirmación, persistencia y sync; sin app.js; sin nombres fijos', () => {
  const U = UI.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.match(U, /data-ar2="editar"/); assert.match(U, /data-ar2="sinconf"/);
  assert.match(U, /e !== 'sin' && norm\(os\) !== 'particular'/, 'Particular no ofrece «Dejar sin configurar»');
  assert.match(U, /a === 'editar'\) abrirEditar/); assert.match(U, /a === 'editarOk'\) guardarEdicion/); assert.match(U, /a === 'sinconf'\) dejarSinConfigurar/);
  const g = U.slice(U.indexOf('async function guardarEdicion'), U.indexOf('async function dejarSinConfigurar')), d = U.slice(U.indexOf('async function dejarSinConfigurar'), U.indexOf('/* ---- ventanas'));
  [g, d].forEach(f => { assert.match(f, /exigirConfigComercial/); assert.match(f, /window\.confirm/); assert.match(f, /persistirConfigVisibleV1/); assert.match(f, /programarSyncSupabase/); assert.match(f, /ok === false \? 'err'/); });
  assert.match(d, /C\.quitarConfiguracionConvenio\(cfg\(\), S\.pid, os, protegidas\)/); assert.match(g, /C\.editarConfiguracionConvenio\(cfg\(\), S\.pid, os, cambios\)/);
  assert.ok(!/arancelesPorProfesional/.test(d + g), 'la UI de estas acciones no toca aranceles');
  assert.ok(!/CMP/.test(U), 'sin nombres de cobertura fijos');
});

prueba('EC7 sincronización: la baja de la configuración viaja por la fusión de tres vías (no se resucita; frente a una edición ajena es conflicto explícito)', () => {
  const M = require('../cardiolink-config-merge-v1.js');
  const base = cfgCMP(), local = JSON.parse(JSON.stringify(base)), remoto = JSON.parse(JSON.stringify(base));
  C.quitarConfiguracionConvenio(local, 'matias', 'CMP', {});
  let r = M.fusionar(base, local, remoto);
  assert.equal(r.ok, true, JSON.stringify(r.conflictos));
  assert.equal(r.config.conveniosPorProfesional.matias.some(x => x.obraSocial === 'CMP'), false, 'la baja se conserva en la fusión');
  assert.equal(r.config.reglasOS.CMP, undefined); assert.deepEqual(r.config.arancelesPorProfesional, base.arancelesPorProfesional);
  const remoto2 = JSON.parse(JSON.stringify(base)); C.aplicar(remoto2, 'matias', [cambio('IOMA', 'Consulta', 5)], V0);          // otro equipo cambió un arancel ajeno
  r = M.fusionar(base, local, remoto2); assert.equal(r.ok, true); assert.equal(r.config.conveniosPorProfesional.matias.some(x => x.obraSocial === 'CMP'), false); assert.equal(C.vigente(r.config, 'matias', 'IOMA', 'Consulta', V0).estado, 'valor', 'el cambio ajeno se conserva');
  const remoto3 = JSON.parse(JSON.stringify(base)); C.editarConfiguracionConvenio(remoto3, 'matias', 'CMP', { regla: 'OSDE' });  // otro equipo editó el mismo convenio
  r = M.fusionar(base, local, remoto3); assert.equal(r.ok, false, 'eliminar frente a modificar = conflicto explícito, no se pisa en silencio');
  const ed = JSON.parse(JSON.stringify(base)); C.editarConfiguracionConvenio(ed, 'matias', 'CMP', { regla: 'OSDE', bonoEstudio: true });
  r = M.fusionar(base, ed, JSON.parse(JSON.stringify(base))); assert.equal(r.ok, true); assert.equal(r.config.conveniosPorProfesional.matias.find(x => x.obraSocial === 'CMP').regla, 'OSDE', 'una edición viaja campo a campo');
});

let falladas = 0;
pruebas.forEach(p => { try { p.f(); console.log('ok   - ' + p.n); } catch (e) { falladas++; console.log('FAIL - ' + p.n + '\n       ' + (e && e.message || e)); } });
console.log('\n' + (pruebas.length - falladas) + '/' + pruebas.length + ' pruebas');
process.exit(falladas ? 1 : 0);
