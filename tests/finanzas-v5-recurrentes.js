'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const finanzasV5 = require('../cardiolink-finanzas-v5.js');

const modulePath = path.join(__dirname, '..', 'cardiolink-finanzas-v5.js');
const originalSource = fs.readFileSync(modulePath, 'utf8');
const injectionMarker = '  const api = Object.freeze({';

assert.equal(originalSource.split(injectionMarker).length - 1, 1, 'El punto de instrumentación Node debe seguir siendo único');

// Expone helpers puros sólo dentro de esta copia evaluada por Node. No agrega
// globals ni superficie pública al navegador productivo.
const instrumentedSource = originalSource.replace(injectionMarker, `
  globalThis.__finanzasV5RecurringTest = Object.freeze({
    normalizarPeriodoMes,
    desplazarPeriodoMes,
    sourceRefSueldo,
    sourceRefColocaciones,
    sourceRefRecurrente,
    hayRegistroActivo,
    plantillaAplicaAlPeriodo,
    construirEgresoRecurrente,
    construirEgresoObligacion
  });

${injectionMarker}`);

const context = vm.createContext({
  module: { exports: {} },
  exports: {},
  URL,
  Intl
});
vm.runInContext(instrumentedSource, context, { filename: 'cardiolink-finanzas-v5.js' });

const helpers = context.__finanzasV5RecurringTest;
const plain = (value) => JSON.parse(JSON.stringify(value));

const ingresosCero = {
  cajaCobrada: { total: 0 },
  produccionAFacturar: { total: 0 },
  ingresosOperativosEstimados: { total: 0 }
};
const plantilla = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  category_id: 'categoria-personal',
  concept: 'Servicio mensual',
  default_amount: 15000,
  beneficiary: 'Proveedor Test',
  payment_method: 'Transferencia',
  notes: 'Plantilla de prueba',
  professional_id: 'matias',
  due_day: 10,
  start_month: '2026-01-01',
  end_month: null,
  active: true,
  revision: 3
};

const soloPlantilla = finanzasV5.calcularResumenEgresos({
  ingresos: ingresosCero,
  egresos: [],
  egresosPagadosPorFechaPago: [],
  plantillas: [plantilla]
});
assert.equal(soloPlantilla.egresosOperativos, 0, 'Crear/calcular una plantilla no genera ni imputa un egreso');
assert.equal(soloPlantilla.resultadoOperativoEstimado, 0, 'Una plantilla sola no modifica los KPI');

assert.equal(helpers.plantillaAplicaAlPeriodo(plantilla, '2026-08'), true, 'La plantilla aplica dentro de su vigencia');
assert.equal(helpers.plantillaAplicaAlPeriodo({ ...plantilla, end_month: '2026-07-01' }, '2026-08'), false, 'La plantilla expirada no aplica');

const recurrente = plain(helpers.construirEgresoRecurrente(plantilla, {
  period_month: '2026-08',
  expense_date: '2026-08-10',
  concept: 'Servicio mensual agosto',
  amount: 17000,
  beneficiary: 'Proveedor Editado',
  payment_method: 'Transferencia',
  notes: 'Snapshot confirmado manualmente',
  professional_id: 'matias',
  status: 'paid',
  paid_on: '2026-08-10'
}));
assert.deepStrictEqual({
  source_type: recurrente.source_type,
  recurring_template_id: recurrente.recurring_template_id,
  period_month: recurrente.period_month,
  source_ref: recurrente.source_ref,
  amount: recurrente.amount,
  status: recurrente.status,
  paid_on: recurrente.paid_on
}, {
  source_type: 'recurring',
  recurring_template_id: plantilla.id,
  period_month: '2026-08-01',
  source_ref: `recurring:${plantilla.id}:2026-08`,
  amount: 17000,
  status: 'paid',
  paid_on: '2026-08-10'
}, 'La confirmación manual crea el payload recurrente con identidad y snapshot del período');
assert.equal(recurrente.source_snapshot.template_revision, 3, 'El snapshot conserva la revisión de plantilla confirmada');

const identidadRecurrente = { recurringTemplateId: plantilla.id, periodMonth: '2026-08' };
assert.equal(helpers.hayRegistroActivo([recurrente], identidadRecurrente), true, 'Detecta duplicado plantilla-período vigente');
assert.equal(helpers.hayRegistroActivo([{ ...recurrente, status: 'voided' }], identidadRecurrente), false, 'Un egreso anulado permite registrar reemplazo');

const salaryRef = helpers.sourceRefSueldo('2026-08');
assert.equal(salaryRef, 'salary_f4:secretaria:2026-08', 'El source_ref de sueldo es estable por origen y mes');
assert.equal(helpers.sourceRefSueldo('2026-08-31'), salaryRef, 'Distintas fechas del mismo mes conservan el source_ref de sueldo');
assert.equal(helpers.hayRegistroActivo([
  { source_type: 'salary_f4', source_ref: salaryRef, status: 'paid' }
], { sourceType: 'salary_f4', sourceRef: salaryRef }), true, 'Detecta sueldo F4 duplicado vigente');

assert.equal(helpers.desplazarPeriodoMes('2026-07', 1), '2026-08-01', 'Las colocaciones trabajadas en julio se liquidan en agosto');
const placementsRef = helpers.sourceRefColocaciones('2026-08');
assert.equal(placementsRef, 'placements_f4:all:2026-08', 'El source_ref de colocaciones es estable por liquidación');
assert.equal(helpers.hayRegistroActivo([
  { source_type: 'placements_f4', source_ref: placementsRef, status: 'pending' }
], { sourceType: 'placements_f4', sourceRef: placementsRef }), true, 'Detecta colocaciones F4 duplicadas vigentes');

const sueldoCalculado = {
  category_id: 'categoria-sueldo',
  concept: 'Sueldo Secretaría · 2026-08',
  amount: 400000,
  professional_id: null,
  period_month: '2026-08-01',
  source_type: 'salary_f4',
  source_ref: salaryRef,
  source_snapshot: { description: 'Sueldo Secretaría', amount: 400000, origin: 'data.configFinanzas411F.sueldosSecretaria' }
};
const antesDeRegistrar = finanzasV5.calcularResumenEgresos({
  ingresos: ingresosCero,
  egresos: [],
  egresosPagadosPorFechaPago: []
});
assert.equal(antesDeRegistrar.egresosPagados, 0, 'Una obligación calculada todavía no afecta KPI');

const sueldoRegistrado = plain(helpers.construirEgresoObligacion(sueldoCalculado, {
  expense_date: '2026-08-31',
  concept: sueldoCalculado.concept,
  beneficiary: 'Secretaría',
  payment_method: 'Transferencia',
  notes: null,
  status: 'paid',
  paid_on: '2026-08-31'
}));
const despuesDeRegistrar = finanzasV5.calcularResumenEgresos({
  ingresos: ingresosCero,
  egresos: [sueldoRegistrado],
  egresosPagadosPorFechaPago: [sueldoRegistrado]
});
assert.equal(despuesDeRegistrar.egresosPagados, 400000, 'La obligación confirmada impacta como egreso real');
assert.equal(despuesDeRegistrar.resultadoOperativoEstimado, -400000, 'El egreso real modifica el resultado operativo');
assert.equal(despuesDeRegistrar.resultadoCaja, -400000, 'El pago real modifica el resultado de caja');
assert.ok(Object.values(despuesDeRegistrar).every(Number.isFinite), 'Los cálculos recurrentes/F4 no producen NaN ni undefined');

console.log('Recurrentes y obligaciones F4 Finanzas 5 OK: confirmación manual, períodos, duplicados, reemplazo y KPI.');
