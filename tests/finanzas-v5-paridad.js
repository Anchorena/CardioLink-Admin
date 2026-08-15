'use strict';

const assert = require('node:assert/strict');
const finanzasV5 = require('../cardiolink-finanzas-v5.js');

const normalizar = (valor) => String(valor || '').trim().toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const obtenerEstado = (atencion) => String(atencion?.estadoTurno || atencion?.estado || '').toLowerCase();
const tipoPrestacion = (prestacion) => {
  const valor = String(prestacion || '').toLowerCase();
  if (valor.includes('consulta') && (valor.includes('ecg') || valor.includes('electro'))) return 'CONSULTA_ECG';
  if (valor.includes('consulta')) return 'CONSULTA';
  if (valor.includes('ecg') || valor.includes('electro')) return 'ECG';
  if (valor.includes('holter')) return 'HOLTER';
  if (valor.includes('mapa')) return 'MAPA';
  if (valor.includes('eco')) return 'ECO';
  return 'ESTUDIO';
};

const profesionales = [
  { id: 'matias', nombre: 'Dr. Matías Anchorena' },
  { id: 'rogelio', nombre: 'Dr. Rogelio Anchorena' }
];
const arancelesPorProfesional = {
  rogelio: [
    { obraSocial: 'Swiss Medical', prestacion: 'Ecocardiograma Doppler', valor: 65000, vigenteDesde: '2026-01-01', activo: true },
    { obraSocial: 'Swiss Medical', prestacion: 'Ecocardiograma Doppler', valor: 70000, vigenteDesde: '2026-08-01', activo: true },
    { obraSocial: 'Swiss Medical', prestacion: 'Ecocardiograma Doppler', valor: 90000, vigenteDesde: '2026-09-01', activo: true }
  ]
};

function buscarArancel(atencion) {
  const profesionalId = atencion.profesionalId || atencion.cajaPerfil || 'matias';
  const obraSocial = normalizar(atencion.obraSocial);
  const prestacion = normalizar(atencion.prestacion);
  const fecha = atencion.fecha || '2026-08-15';
  const vigentes = (arancelesPorProfesional[profesionalId] || [])
    .filter((item) => item && item.activo !== false
      && normalizar(item.obraSocial) === obraSocial
      && normalizar(item.prestacion) === prestacion
      && (!item.vigenteDesde || item.vigenteDesde <= fecha))
    .sort((a, b) => String(b.vigenteDesde || '').localeCompare(String(a.vigenteDesde || '')));
  return vigentes[0] || null;
}

function obtenerArancel(atencion) {
  if (['particular', 'pami'].includes(normalizar(atencion.obraSocial))) return 0;
  if (Number.isFinite(Number(atencion.valorArancelEstimado)) && Number(atencion.valorArancelEstimado) >= 0) {
    return Number(atencion.valorArancelEstimado || 0);
  }
  return Number(buscarArancel(atencion)?.valor || 0);
}

function esFacturaTercero(atencion, perfilId) {
  if (!atencion || !perfilId) return false;
  if (perfilId === 'matias') return atencion.facturaRogelio === true;
  const profesional = profesionales.find((item) => item.id === perfilId);
  const destino = String(atencion.destinoFacturacionEstimado || atencion.prestacionA || '');
  return !!(destino && profesional
    && normalizar(destino) !== normalizar(profesional.nombre)
    && normalizar(destino) !== 'no aplica');
}

const atenciones = [
  { id: 'part-consulta', fecha: '2026-08-03', profesionalId: 'matias', obraSocial: 'Particular', prestacion: 'Consulta', montoConsulta: 35000, montoCopago: 5000, formaPago: 'Efectivo', estado: 'atendido' },
  { id: 'part-eco', fecha: '2026-08-04', profesionalId: 'matias', obraSocial: 'Particular', prestacion: 'Ecocardiograma Doppler', montoEstudio: 60000, formaPago: 'Transferencia', estado: 'atendido' },
  { id: 'os-valor', fecha: '2026-08-05', profesionalId: 'matias', obraSocial: 'OSDE', prestacion: 'Holter', valorArancelEstimado: 80000, formaPago: 'No aplica', estado: 'atendido' },
  { id: 'os-vigente', fecha: '2026-08-06', profesionalId: 'rogelio', obraSocial: 'Swiss Medical', prestacion: 'Ecocardiograma Doppler', formaPago: 'No aplica', estado: 'atendido' },
  { id: 'tercero-general', fecha: '2026-08-07', profesionalId: 'matias', obraSocial: 'OSDE', prestacion: 'MAPA', valorArancelEstimado: 90000, facturaRogelio: true, estado: 'atendido' },
  { id: 'tercero-perfil', fecha: '2026-08-08', profesionalId: 'rogelio', obraSocial: 'OSDE', prestacion: 'Holter', valorArancelEstimado: 75000, destinoFacturacionEstimado: 'Dr. Matías Anchorena', estado: 'atendido' },
  { id: 'cancelado-senia', fecha: '2026-08-09', profesionalId: 'matias', obraSocial: 'OSDE', prestacion: 'Consulta', montoConsulta: 99999, montoCopago: 9999, valorArancelEstimado: 50000, seniaMonto: 10000, seniaFormaPago: 'Débito', estadoTurno: 'cancelado' },
  { id: 'ausente', fecha: '2026-08-10', profesionalId: 'matias', obraSocial: 'OSDE', prestacion: 'Holter', montoEstudio: 99999, valorArancelEstimado: 50000, estado: 'ausente' },
  { id: 'pami', fecha: '2026-08-11', profesionalId: 'matias', obraSocial: 'PAMI', prestacion: 'Consulta', montoConsulta: 1000, formaPago: 'Efectivo', estado: 'atendido' },
  { id: 'sin-arancel', fecha: '2026-08-12', profesionalId: 'matias', obraSocial: 'Medicus', prestacion: 'ECG', formaPago: 'No aplica', estado: 'atendido' },
  { id: 'fuera-rango', fecha: '2026-07-15', profesionalId: 'matias', obraSocial: 'Particular', prestacion: 'Consulta', montoConsulta: 123456, estado: 'atendido' }
];

// Referencia congelada de la fórmula previa de renderFinance411C.
function calcularLegacy({ desde = '', hasta = '', perfil = '' }) {
  const lista = atenciones.filter((atencion) => atencion
    && (!desde || atencion.fecha >= desde)
    && (!hasta || atencion.fecha <= hasta)
    && (!perfil || atencion.profesionalId === perfil || atencion.cajaPerfil === perfil));
  const ingresos = { particular: 0, copago: 0, os: 0, facturaOtro: 0, senias: 0 };
  const medios = { Efectivo: 0, Transferencia: 0, 'Débito': 0, Mixto: 0, 'No aplica': 0, Otro: 0 };
  const agregarMedio = (clave, monto) => { medios[clave] = (medios[clave] || 0) + Number(monto || 0); };

  lista.forEach((atencion) => {
    if (['ausente', 'cancelado'].includes(obtenerEstado(atencion))) {
      const senia = Number(atencion.seniaMonto || 0);
      ingresos.senias += senia;
      agregarMedio(atencion.seniaFormaPago || 'Otro', senia);
      return;
    }
    const particular = Number(atencion.montoConsulta || 0) + Number(atencion.montoEstudio || 0);
    const copago = Number(atencion.montoCopago || 0);
    ingresos.particular += particular;
    ingresos.copago += copago;
    agregarMedio(atencion.formaPago || 'Otro', particular + copago);
    const arancel = obtenerArancel(atencion);
    if (arancel > 0) {
      if (perfil && esFacturaTercero(atencion, perfil)) ingresos.facturaOtro += arancel;
      else if (!perfil && atencion.profesionalId === 'matias' && esFacturaTercero(atencion, 'matias')) ingresos.facturaOtro += arancel;
      else ingresos.os += arancel;
    }
  });

  const sinArancel = lista.filter((atencion) => !['particular', 'pami'].includes(normalizar(atencion.obraSocial))
    && !['ausente', 'cancelado'].includes(obtenerEstado(atencion))
    && obtenerArancel(atencion) <= 0).length;
  const cajaCobrada = ingresos.particular + ingresos.copago + ingresos.senias;
  const aFacturar = ingresos.os + ingresos.facturaOtro;
  return { ingresos, medios, cajaCobrada, aFacturar, totalIngresos: cajaCobrada + aFacturar, sinArancel };
}

function calcularNuevo(filtros) {
  return finanzasV5.calcularIngresosCanonicos({
    atenciones,
    ...filtros,
    obtenerEstado,
    obtenerArancel,
    esFacturaTercero,
    normalizar,
    tipoPrestacion
  });
}

const escenarios = [
  { nombre: 'agosto todos', filtros: { desde: '2026-08-01', hasta: '2026-08-31', perfil: '' } },
  { nombre: 'agosto Matías', filtros: { desde: '2026-08-01', hasta: '2026-08-31', perfil: 'matias' } },
  { nombre: 'agosto Rogelio', filtros: { desde: '2026-08-01', hasta: '2026-08-31', perfil: 'rogelio' } },
  { nombre: 'día cancelado', filtros: { desde: '2026-08-09', hasta: '2026-08-09', perfil: 'matias' } },
  { nombre: 'rango vacío', filtros: { desde: '2026-06-01', hasta: '2026-06-30', perfil: '' } }
];

escenarios.forEach(({ nombre, filtros }) => {
  const legacy = calcularLegacy(filtros);
  const nuevo = calcularNuevo(filtros);
  const comparable = {
    ingresos: {
      particular: nuevo.cajaCobrada.particulares,
      copago: nuevo.cajaCobrada.copagos,
      os: nuevo.produccionAFacturar.obrasSocialesPrepagas,
      facturaOtro: nuevo.produccionAFacturar.terceros,
      senias: nuevo.cajaCobrada.senias
    },
    medios: nuevo.mediosPago,
    cajaCobrada: nuevo.cajaCobrada.total,
    aFacturar: nuevo.produccionAFacturar.total,
    totalIngresos: nuevo.ingresosOperativosEstimados.total,
    sinArancel: nuevo.alertas.atencionesSinArancel
  };
  assert.deepStrictEqual(comparable, legacy, `Paridad de ingresos: ${nombre}`);

  const detalle = nuevo.desglose.porPrestacion.reduce((totales, item) => ({
    caja: totales.caja + item.totalCajaCobrada,
    facturar: totales.facturar + item.totalAFacturar,
    total: totales.total + item.totalIngresosOperativosEstimados
  }), { caja: 0, facturar: 0, total: 0 });
  assert.deepStrictEqual(detalle, {
    caja: nuevo.cajaCobrada.total,
    facturar: nuevo.produccionAFacturar.total,
    total: nuevo.ingresosOperativosEstimados.total
  }, `Desglose por prestación: ${nombre}`);

  const egresosSinCambios = { sueldo: 400000, colocaciones: 30000, otros: 15000 };
  const totalEgresos = Object.values(egresosSinCambios).reduce((suma, monto) => suma + monto, 0);
  assert.equal(
    legacy.totalIngresos - totalEgresos,
    nuevo.ingresosOperativosEstimados.total - totalEgresos,
    `Neto Finanzas 4: ${nombre}`
  );
});

const agostoTodos = calcularNuevo(escenarios[0].filtros);
assert.deepStrictEqual(agostoTodos.cajaCobrada, {
  particulares: 96000,
  copagos: 5000,
  senias: 10000,
  total: 111000
}, 'Totales conocidos de Caja cobrada');
assert.deepStrictEqual(agostoTodos.produccionAFacturar, {
  obrasSocialesPrepagas: 225000,
  terceros: 90000,
  total: 315000
}, 'Totales conocidos de producción a facturar');
assert.equal(agostoTodos.ingresosOperativosEstimados.total, 426000, 'Total conocido de ingresos');
assert.equal(agostoTodos.alertas.atencionesSinArancel, 1, 'Detecta OS sin arancel');

let accesoPermitido = false;
let lecturasProveedor = 0;
assert.equal(finanzasV5.puedeAcceder(), false, 'El shell inicia sin acceso financiero');
assert.equal(finanzasV5.obtenerIngresos({}), null, 'Sin proveedor autorizado no expone ingresos');
assert.equal(finanzasV5.conectarProveedor({
  puedeAcceder: () => accesoPermitido,
  obtenerIngresos: () => {
    lecturasProveedor += 1;
    return { cajaCobrada: { total: 1 } };
  }
}), true, 'Conecta una sola fuente autorizada');
assert.equal(finanzasV5.obtenerIngresos({}), null, 'Un rol no autorizado no obtiene datos');
assert.equal(lecturasProveedor, 0, 'El proveedor no se consulta sin permiso');
accesoPermitido = true;
assert.deepStrictEqual(finanzasV5.obtenerIngresos({}), { cajaCobrada: { total: 1 } }, 'Dueño/Admin puede consultar');
assert.equal(lecturasProveedor, 1, 'La lectura autorizada usa el proveedor conectado');
assert.equal(finanzasV5.conectarProveedor({ obtenerIngresos: () => ({}) }), false, 'No permite reemplazar el proveedor conectado');

console.log(`Paridad Finanzas 4/5 OK: ${escenarios.length} escenarios, ${atenciones.length} atenciones de prueba.`);
