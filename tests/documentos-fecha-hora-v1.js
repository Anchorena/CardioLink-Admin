'use strict';

// tests/documentos-fecha-hora-v1.js
// Bloque 1 (Documentos V1): fecha y hora de certificados en horario America/Argentina/Buenos_Aires.
// Bug original: el <input type="datetime-local"> se inicializaba con new Date().toISOString().slice(0,16) (UTC) y se leía con new Date(valor) (hora del
// dispositivo): cada certificado nuevo quedaba 3 h adelantado y reabrir+guardar sumaba otras 3 h. Ejecuta los helpers REALES extraídos de app.js.
// Para probar independencia del dispositivo, correr con distintos TZ del entorno (TZ=UTC, TZ=Asia/Tokyo, TZ=America/New_York, ...).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

const ini = app.indexOf('// Fecha y hora de los documentos clínicos');
const fin = app.indexOf('function fmtD406', ini);
assert.ok(ini > 0 && fin > ini, 'no se encontró el bloque de helpers de fecha en app.js');
const H = new Function(app.slice(ini, fin) + '\nreturn {fmtDT406,isoAInputAR406,inputARAIso406,resolverFechaHoraGuardado406};')();

const casos = [];
function caso(n, f) { casos.push([n, f]); }

caso('ISO UTC -> campo en hora de Buenos Aires (UTC-3)', () => {
  assert.equal(H.isoAInputAR406('2026-10-27T21:30:00.000Z'), '2026-10-27T18:30');
  assert.equal(H.isoAInputAR406('2026-01-01T00:00:00.000Z'), '2025-12-31T21:00');
});
caso('medianoche: 23:59 y 00:00 de Buenos Aires', () => {
  assert.equal(H.isoAInputAR406('2026-10-28T02:59:00.000Z'), '2026-10-27T23:59');
  assert.equal(H.isoAInputAR406('2026-10-28T03:00:00.000Z'), '2026-10-28T00:00');
  assert.equal(H.inputARAIso406('2026-10-27T23:59'), '2026-10-28T02:59:00.000Z');
  assert.equal(H.inputARAIso406('2026-10-28T00:00'), '2026-10-28T03:00:00.000Z');
});
caso('campo -> ISO UTC', () => {
  assert.equal(H.inputARAIso406('2026-10-27T18:30'), '2026-10-27T21:30:00.000Z');
  assert.equal(H.inputARAIso406('2024-02-29T12:00'), '2024-02-29T15:00:00.000Z');   // bisiesto
  assert.equal(H.inputARAIso406('2026-12-31T22:30'), '2027-01-01T01:30:00.000Z');   // cambio de año
});
caso('entradas inválidas', () => {
  assert.equal(H.isoAInputAR406('no es fecha'), '');
  assert.equal(H.isoAInputAR406(''), '');
  assert.equal(H.inputARAIso406(''), '');
  assert.equal(H.inputARAIso406('2026-10-27'), '');
  assert.equal(H.inputARAIso406('basura'), '');
});
caso('ida y vuelta sin corrimiento (cada 37 min durante 2 años)', () => {
  let n = 0;
  for (let t = Date.UTC(2025, 0, 1); t < Date.UTC(2027, 0, 1); t += 37 * 60 * 1000) {
    const iso = new Date(Math.floor(t / 60000) * 60000).toISOString();
    const campo = H.isoAInputAR406(iso);
    assert.equal(H.inputARAIso406(campo), iso, 'ida y vuelta falló en ' + iso);
    n++;
  }
  assert.ok(n > 28000);
});
caso('valor inicial = ahora real en Buenos Aires, sin importar el huso del dispositivo', () => {
  const antes = Date.now();
  const campo = H.isoAInputAR406(new Date(antes).toISOString());
  const esperado = new Date(antes - 3 * 3600 * 1000).toISOString().slice(0, 16);   // Buenos Aires = UTC-3 fijo
  assert.equal(campo, esperado);
  assert.ok(campo !== new Date(antes).toISOString().slice(0, 16), 'no debe ser la hora UTC (bug original)');
});
caso('reabrir y guardar sin tocar el campo conserva el instante original (con segundos), sin corrimiento', () => {
  const original = '2026-10-27T21:30:12.345Z';
  const campo = H.isoAInputAR406(original);
  assert.equal(H.resolverFechaHoraGuardado406(campo, original, 'AHORA'), original);
  // repetir 5 veces: nunca se desplaza
  let iso = original;
  for (let i = 0; i < 5; i++) iso = H.resolverFechaHoraGuardado406(H.isoAInputAR406(iso), iso, 'AHORA');
  assert.equal(iso, original);
});
caso('documento histórico (instante guardado adelantado): se muestra tal cual y no cambia al guardar sin editar', () => {
  const historico = '2026-10-28T00:30:00.000Z';   // creado a las 21:30 AR pero guardado 3 h adelantado
  assert.equal(H.resolverFechaHoraGuardado406(H.isoAInputAR406(historico), historico, 'AHORA'), historico);
});
caso('campo editado: se interpreta en Buenos Aires; vacío => ahora', () => {
  assert.equal(H.resolverFechaHoraGuardado406('2026-10-20T09:15', '2026-10-27T21:30:12.345Z', 'AHORA'), '2026-10-20T12:15:00.000Z');
  assert.equal(H.resolverFechaHoraGuardado406('', '2026-10-27T21:30:12.345Z', 'AHORA'), 'AHORA');
  assert.equal(H.resolverFechaHoraGuardado406('2026-10-20T09:15', '', 'AHORA'), '2026-10-20T12:15:00.000Z');
  assert.equal(H.resolverFechaHoraGuardado406('inválido', '', 'AHORA'), 'AHORA');
});
caso('presentación en horario de Buenos Aires', () => {
  const t = H.fmtDT406('2026-10-28T02:59:00.000Z');
  assert.ok(/(23:59|11:59)/.test(t) && /27/.test(t), t);   // es-AR puede dar 24 h o 12 h ("11:59 p. m.") según el motor
});
caso('estático: modal, guardado, fecha archivada y regla de 24 h usan los helpers', () => {
  assert.ok(app.includes('value="${esc406(isoAInputAR406(fechaIso406))}"'), 'el campo debe inicializarse con isoAInputAR406');
  assert.ok(app.includes('resolverFechaHoraGuardado406(fechaInput,fechaIsoInicial,now)'), 'saveDocument406 debe usar resolverFechaHoraGuardado406');
  assert.ok(!/docDate406[^\n]{0,200}slice\(0,16\)/.test(app), 'el campo ya no puede inicializarse con slice(0,16) de UTC');
  assert.ok(!app.includes("new Date(fechaInput).toISOString()"), 'no se debe interpretar el campo con la hora del dispositivo');
  assert.ok(app.includes("documentDate:(isoAInputAR406(d.fechaHora||new Date().toISOString())"), 'documentDate debe usar la fecha de Buenos Aires');
  assert.ok(app.includes('new Date(d.creadoEn||d.fechaHora||0).getTime()'), 'las 24 h de edición cuentan desde la creación real');
  assert.ok(app.includes('<label>Fecha y hora</label><input id="docDate406" type="datetime-local"'));
});

(async () => {
  let fallos = 0;
  for (const [n, f] of casos) {
    try { await f(); console.log('PASS ' + n); } catch (e) { fallos++; console.log('FAIL ' + n + '\n     ' + (e && e.message)); }
  }
  console.log(`\n${casos.length - fallos}/${casos.length} PASS (TZ=${typeof process !== 'undefined' && process.env && process.env.TZ || 'default'})`);
  if (fallos) process.exit(1);
})();
