'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appPath = path.join(__dirname, '..', 'app.js');
const source = fs.readFileSync(appPath, 'utf8');
const startMarker = '  function rangoCalendarioMesObligacionesF5(ym){';
const endMarker = '  const proveedorObligacionesF4411F=Object.freeze({';
const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker, start);

assert.notEqual(start, -1, 'Debe existir el helper mensual usado por el adaptador F5');
assert.notEqual(end, -1, 'Debe encontrarse el límite del helper antes del proveedor F4');
assert.equal(source.indexOf(startMarker, start + startMarker.length), -1, 'El helper mensual debe tener una única implementación');

const helperSource = source.slice(start, end);
const providerEnd = source.indexOf('  window.CardioLinkFinanzasV5?.conectarProveedorObligacionesF4?.', end);
const providerSource = source.slice(end, providerEnd);
assert.equal(
  providerSource.includes('total:colocacionesLiquidacion411F(rangoLiquidacion.desde,rangoLiquidacion.hasta,perfil)'),
  true,
  'El total continúa usando la función canónica F4 con el rango calendario real'
);
assert.equal(
  providerSource.includes("colocacionesLiquidacion411F(ym+'-01',ym+'-31'"),
  false,
  'El adaptador no conserva el hasta YYYY-MM-31 artificial'
);
const rangoCalendarioMesObligacionesF5 = vm.runInNewContext(
  `(() => { ${helperSource}; return rangoCalendarioMesObligacionesF5; })()`,
  { Date }
);

const casos = [
  ['2026-06', { desde: '2026-06-01', hasta: '2026-06-30' }],
  ['2026-02', { desde: '2026-02-01', hasta: '2026-02-28' }],
  ['2028-02', { desde: '2028-02-01', hasta: '2028-02-29' }],
  ['2026-07', { desde: '2026-07-01', hasta: '2026-07-31' }]
];

casos.forEach(([mes, esperado]) => {
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(rangoCalendarioMesObligacionesF5(mes))),
    esperado,
    `Rango calendario real para ${mes}`
  );
});

['2026-02', '2026-04', '2026-06', '2026-09', '2026-11'].forEach((mes) => {
  assert.notEqual(
    rangoCalendarioMesObligacionesF5(mes).hasta,
    `${mes}-31`,
    `${mes} nunca debe generar un día 31 inválido`
  );
});

assert.equal(rangoCalendarioMesObligacionesF5('2026-13'), null, 'Rechaza un mes inválido');

console.log('Rango mensual de obligaciones F5 OK: meses de 28, 29, 30 y 31 días.');
