'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const finanzasV5 = require('../cardiolink-finanzas-v5.js');

const appPath = path.join(__dirname, '..', 'app.js');
const appSource = fs.readFileSync(appPath, 'utf8');
const functionMarker = '  function crearExtraDesdeModal293(base, prest, noCobrar){';
const endMarker = '\n\n  const abrirOriginal293 =';

assert.equal(appSource.split(functionMarker).length - 1, 1, 'El helper 293 debe seguir teniendo una única definición');
const functionStart = appSource.indexOf(functionMarker);
const functionEnd = appSource.indexOf(endMarker, functionStart);
assert.ok(functionStart >= 0 && functionEnd > functionStart, 'Se puede aislar crearExtraDesdeModal293 para el test');

const functionSource = appSource.slice(functionStart, functionEnd);
let domState = {};
let predicateCalls = 0;
const context = vm.createContext({
  data: { profesionales: [{ id: 'matias', nombre: 'Dr. Matías Anchorena' }] },
  $id: (id) => domState[id] || null,
  esCoberturaParticularNoCobrar: (value) => {
    predicateCalls += 1;
    return String(value || '').trim().toLowerCase() === 'particular';
  },
  getRegla: (obraSocial) => obraSocial === 'OSDE' ? 'OSDE' : 'SIN_REGLA',
  valorDePrestacion: () => 60000,
  copagoDePrestacion: () => 12000,
  normalizarHora293: (value) => String(value || ''),
  todayISO: () => '2026-08-19',
  tipoPrest: () => 'ECO',
  esPrestacionColocable: () => false,
  nombreUsuarioAuditoria: () => 'QA',
  usuarioActualNombreCorto: () => 'qa',
  perfilUsuarioActual: () => ({ rol: 'admin' })
});

vm.runInContext(`${functionSource}\nglobalThis.__crearExtraDesdeModal293 = crearExtraDesdeModal293;`, context, {
  filename: 'app.js#crearExtraDesdeModal293'
});

const crearExtraDesdeModal293 = context.__crearExtraDesdeModal293;
const plain = (value) => JSON.parse(JSON.stringify(value));
const base = {
  id: 'atencion-base',
  grupoTurnoId: 'turno-qa',
  fecha: '2026-08-19',
  paciente: 'Paciente QA',
  dni: '123',
  profesionalId: 'matias',
  profesional: 'Dr. Matías Anchorena',
  consultaA: 'No aplica',
  prestacionA: 'Matías',
  tipoCobro: 'Particular',
  formaPago: 'Efectivo',
  observaciones: ''
};

function prepararModal(obraSocial, tipoCobro, formaPago) {
  domState = {
    m_os: { value: obraSocial },
    m_prof: { value: 'matias' },
    m_tipoCobro: { value: tipoCobro },
    m_formaPago: { value: formaPago }
  };
}

function calcularIngreso(atencion, arancel = 0) {
  return finanzasV5.calcularIngresosCanonicos({
    atenciones: [atencion],
    obtenerEstado: () => 'atendido',
    obtenerArancel: () => arancel,
    normalizar: (value) => String(value || '').trim().toLowerCase(),
    tipoPrestacion: () => 'ECO'
  });
}

prepararModal('Particular', 'Particular', 'Efectivo');
const particularNoCobrar = plain(crearExtraDesdeModal293(base, 'Ecocardiograma Doppler', true));
assert.equal(particularNoCobrar.noCobrar, true, 'A: Particular + checkbox activa No cobrar');
assert.equal(particularNoCobrar.montoEstudio, 60000, 'A: conserva el valor real de referencia del estudio');
assert.equal(particularNoCobrar.montoCopago, 0, 'A: no genera copago');
assert.equal(particularNoCobrar.montoTotal, 0, 'A: el cobro efectivo queda en cero');
assert.equal(particularNoCobrar.formaPago, 'No aplica', 'A: no agrega medio de pago');
const ingresoNoCobrar = calcularIngreso(particularNoCobrar);
assert.equal(ingresoNoCobrar.cajaCobrada.total, 0, 'A: no genera ingreso particular');
assert.equal(ingresoNoCobrar.desglose.estudiosPrestaciones.cantidad, 1, 'A: sigue contando como estudio realizado');

prepararModal('OSDE', 'Sin cobro en caja', 'No aplica');
const prepagaConFlagManipulado = plain(crearExtraDesdeModal293({ ...base, obraSocial: 'OSDE' }, 'Ecocardiograma Doppler', true));
assert.equal(prepagaConFlagManipulado.noCobrar, false, 'B: una prepaga no activa No cobrar aunque el checkbox llegue marcado');
assert.notEqual(prepagaConFlagManipulado.tipoCobro, 'No cobrar', 'B: conserva el circuito normal de la cobertura');
assert.equal(
  calcularIngreso(prepagaConFlagManipulado, 50000).produccionAFacturar.obrasSocialesPrepagas,
  50000,
  'B: el flag manipulado no anula la facturación de OS/prepaga'
);

prepararModal('Particular', 'Particular', 'Transferencia');
const particularNormal = plain(crearExtraDesdeModal293(base, 'Ecocardiograma Doppler', false));
assert.equal(particularNormal.noCobrar, false, 'C: Particular normal mantiene No cobrar desactivado');
assert.equal(particularNormal.montoEstudio, 60000, 'C: conserva el monto particular normal');
assert.equal(particularNormal.montoTotal, 60000, 'C: mantiene el cobro efectivo normal');
assert.equal(particularNormal.formaPago, 'Transferencia', 'C: mantiene la forma de pago elegida');
assert.equal(calcularIngreso(particularNormal).cajaCobrada.particulares, 60000, 'C: mantiene el ingreso particular anterior');

assert.equal(predicateCalls, 2, 'El helper 293 reutiliza el predicate existente cuando el flag llega marcado');

console.log('No cobrar en crearExtraDesdeModal293 OK: Particular, OS/prepaga y flujo normal.');
