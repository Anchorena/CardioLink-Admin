/* =====================================================================
   CardioLink Admin — Finanzas 5 · Etapa 1
   Proveedor canónico de ingresos y base modular sin persistencia ni UI.

   Orden de carga: antes de app.js. app.js conecta las dependencias y expone
   el proveedor autorizado de solo lectura para los consumidores futuros.
   ===================================================================== */
(function (root, factory) {
  'use strict';

  const api = factory();

  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && !root.CardioLinkFinanzasV5) root.CardioLinkFinanzasV5 = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  let proveedorAutorizado = null;

  const numero = (valor) => Number(valor || 0);

  function nuevoDetallePrestacion(prestacion, tipo) {
    return {
      prestacion,
      tipo,
      cantidadRealizadas: 0,
      ausentesCancelados: 0,
      particulares: 0,
      copagos: 0,
      senias: 0,
      obrasSocialesPrepagas: 0,
      terceros: 0,
      totalCajaCobrada: 0,
      totalAFacturar: 0,
      totalIngresosOperativosEstimados: 0
    };
  }

  function cerrarDetallePrestacion(detalle) {
    detalle.totalCajaCobrada = detalle.particulares + detalle.copagos + detalle.senias;
    detalle.totalAFacturar = detalle.obrasSocialesPrepagas + detalle.terceros;
    detalle.totalIngresosOperativosEstimados = detalle.totalCajaCobrada + detalle.totalAFacturar;
    return detalle;
  }

  function calcularIngresosCanonicos(opciones = {}) {
    const listaCompleta = Array.isArray(opciones.atenciones) ? opciones.atenciones : [];
    const desde = String(opciones.desde || '');
    const hasta = String(opciones.hasta || '');
    const perfil = String(opciones.perfil || '');
    const obtenerEstado = typeof opciones.obtenerEstado === 'function'
      ? opciones.obtenerEstado
      : (atencion) => String(atencion?.estadoTurno || atencion?.estado || '').toLowerCase();
    const obtenerArancel = typeof opciones.obtenerArancel === 'function'
      ? opciones.obtenerArancel
      : () => 0;
    const esFacturaTercero = typeof opciones.esFacturaTercero === 'function'
      ? opciones.esFacturaTercero
      : () => false;
    const normalizar = typeof opciones.normalizar === 'function'
      ? opciones.normalizar
      : (valor) => String(valor || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const tipoPrestacion = typeof opciones.tipoPrestacion === 'function'
      ? opciones.tipoPrestacion
      : () => 'ESTUDIO';

    // Mantiene exactamente el filtro histórico de renderFinance411C.
    const lista = listaCompleta.filter((atencion) => atencion
      && (!desde || atencion.fecha >= desde)
      && (!hasta || atencion.fecha <= hasta)
      && (!perfil || atencion.profesionalId === perfil || atencion.cajaPerfil === perfil));

    const ingresos = { particular: 0, copago: 0, os: 0, facturaOtro: 0, senias: 0 };
    const mediosPago = { Efectivo: 0, Transferencia: 0, 'Débito': 0, Mixto: 0, 'No aplica': 0, Otro: 0 };
    const actividad = {
      consultas: { cantidad: 0, particulares: 0 },
      estudiosPrestaciones: { cantidad: 0, particulares: 0 }
    };
    const detalles = new Map();
    let sinArancel = 0;

    const agregarMedio = (medio, monto) => {
      const clave = medio || 'Otro';
      mediosPago[clave] = numero(mediosPago[clave]) + numero(monto);
    };

    const detallePara = (atencion) => {
      const prestacion = String(atencion?.prestacion || 'Sin prestación');
      const tipo = String(tipoPrestacion(prestacion) || 'ESTUDIO');
      const clave = `${tipo}\u0000${prestacion}`;
      if (!detalles.has(clave)) detalles.set(clave, nuevoDetallePrestacion(prestacion, tipo));
      return detalles.get(clave);
    };

    lista.forEach((atencion) => {
      const detalle = detallePara(atencion);
      const estado = String(obtenerEstado(atencion) || '').toLowerCase();

      if (['ausente', 'cancelado'].includes(estado)) {
        const senia = numero(atencion.seniaMonto);
        ingresos.senias += senia;
        detalle.ausentesCancelados += 1;
        detalle.senias += senia;
        agregarMedio(atencion.seniaFormaPago || 'Otro', senia);
        return;
      }

      const montoConsulta = numero(atencion.montoConsulta);
      const montoEstudio = numero(atencion.montoEstudio);
      const particular = montoConsulta + montoEstudio;
      const copago = numero(atencion.montoCopago);
      const formaPago = atencion.formaPago || 'Otro';
      const tipo = String(tipoPrestacion(atencion.prestacion) || 'ESTUDIO');

      ingresos.particular += particular;
      ingresos.copago += copago;
      agregarMedio(formaPago, particular + copago);

      detalle.cantidadRealizadas += 1;
      detalle.particulares += particular;
      detalle.copagos += copago;

      if (tipo === 'CONSULTA' || tipo === 'CONSULTA_ECG') {
        actividad.consultas.cantidad += 1;
      }
      if (tipo !== 'CONSULTA') actividad.estudiosPrestaciones.cantidad += 1;
      actividad.consultas.particulares += montoConsulta;
      actividad.estudiosPrestaciones.particulares += montoEstudio;

      const arancel = numero(obtenerArancel(atencion));
      if (arancel > 0) {
        if (perfil && esFacturaTercero(atencion, perfil)) {
          ingresos.facturaOtro += arancel;
          detalle.terceros += arancel;
        } else if (!perfil && atencion.profesionalId === 'matias' && esFacturaTercero(atencion, 'matias')) {
          ingresos.facturaOtro += arancel;
          detalle.terceros += arancel;
        } else {
          ingresos.os += arancel;
          detalle.obrasSocialesPrepagas += arancel;
        }
      }

      if (!['particular', 'pami'].includes(normalizar(atencion.obraSocial)) && arancel <= 0) {
        sinArancel += 1;
      }
    });

    const totalCajaCobrada = ingresos.particular + ingresos.copago + ingresos.senias;
    const totalAFacturar = ingresos.os + ingresos.facturaOtro;
    const totalIngresosOperativosEstimados = totalCajaCobrada + totalAFacturar;

    return {
      filtros: { desde, hasta, perfil },
      cantidadAtenciones: lista.length,
      cajaCobrada: {
        particulares: ingresos.particular,
        copagos: ingresos.copago,
        senias: ingresos.senias,
        total: totalCajaCobrada
      },
      produccionAFacturar: {
        obrasSocialesPrepagas: ingresos.os,
        terceros: ingresos.facturaOtro,
        total: totalAFacturar
      },
      ingresosOperativosEstimados: {
        total: totalIngresosOperativosEstimados
      },
      desglose: {
        consultas: actividad.consultas,
        estudiosPrestaciones: actividad.estudiosPrestaciones,
        porPrestacion: Array.from(detalles.values()).map(cerrarDetallePrestacion)
      },
      mediosPago,
      alertas: { atencionesSinArancel: sinArancel }
    };
  }

  function conectarProveedor(proveedor) {
    if (proveedorAutorizado || !proveedor || typeof proveedor.obtenerIngresos !== 'function') return false;
    proveedorAutorizado = proveedor;
    return true;
  }

  function puedeAcceder() {
    return !!proveedorAutorizado?.puedeAcceder?.();
  }

  function obtenerIngresos(filtros = {}) {
    if (!puedeAcceder()) return null;
    return proveedorAutorizado.obtenerIngresos(filtros);
  }

  function diagnostico(filtros = {}) {
    const resumen = obtenerIngresos(filtros);
    if (!resumen) return { disponible: false };
    return {
      disponible: true,
      cajaCobrada: resumen.cajaCobrada.total,
      aFacturar: resumen.produccionAFacturar.total,
      ingresosOperativosEstimados: resumen.ingresosOperativosEstimados.total
    };
  }

  return Object.freeze({
    version: '5.0.0-etapa-1',
    calcularIngresosCanonicos,
    conectarProveedor,
    puedeAcceder,
    obtenerIngresos,
    diagnostico
  });
});
