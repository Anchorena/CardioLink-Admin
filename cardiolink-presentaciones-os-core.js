/* CardioLink · FACTURACIÓN MENSUAL V1 · Bloque 1 · Presentaciones a obras sociales · NÚCLEO (lógica pura, sin DOM, sin red, sin globales de la app)
 *
 * Qué resuelve: armar AUTOMÁTICAMENTE el listado de prestaciones realizadas, facturables y todavía no presentadas (las del mes y las de meses anteriores),
 * permitir dejar afuera excepciones SIN tildar prestación por prestación, y preparar el lote para confirmarlo UNA sola vez (sin duplicados).
 *
 * Reglas (alineadas con Finanzas V5 `calcularIngresosCanonicos` para que la producción y lo presentado hablen de lo mismo):
 *   · REALIZADA: la atención NO está ausente ni cancelada (mismo filtro que la producción).
 *   · FACTURABLE: cobertura distinta de Particular/PAMI y con arancel FIJADO > 0 en la atención (arancelId + valorArancelEstimado; el servidor exige lo mismo, PR412).
 *   · NO PRESENTADA: su ID no figura entre las ya presentadas. El ID estable de una prestación es el `id` de su fila en cardiolink_atenciones.
 *   · Control desde `desde` (fecha de inicio del control de presentaciones; 01/12/2026): la lista AUTOMÁTICA arranca ahí. Lo anterior NO se considera presentado ni facturado: simplemente no se ofrece solo.
 *   · INCORPORACIÓN EXCEPCIONAL: una prestación realizada y facturable ANTERIOR al inicio del control, que no figure presentada en el sistema (p. ej. con bono pendiente de presentación), se puede sumar a mano
 *     a un lote, con un motivo. Conserva su fecha original de producción, queda marcada como excepcional y el índice único por atención sigue evitando duplicados.
 *   · Período de presentación `hastaMes` (AAAA-MM): entra todo lo realizado hasta el último día de ese mes (incluye meses anteriores sin presentar).
 *   · La fecha de producción (`fecha` de la atención) NO se modifica nunca: este módulo no escribe atenciones; guarda una COPIA de la fecha en cada ítem presentado.
 *   · «Terceros» (la facturación la hace otro profesional/destino): por defecto NO se incluyen en el lote; se informan aparte (decisión de negocio pendiente).
 *   · Sin arancel fijado: no se pueden presentar (importe 0); quedan aparte como incidencias pendientes. El importe nunca lo define el cliente.
 * UMD: Node (pruebas) y navegador (window.CardioLinkPresentacionesCoreV1). */
(function (raiz, fabrica) {
  'use strict';
  var api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.CardioLinkPresentacionesCoreV1 = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var COBERTURAS_NO_FACTURABLES = ['particular', 'pami'];
  var MAX_ITEMS_POR_CONFIRMACION = 2000;

  function norm(v) { return String(v == null ? '' : v).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim(); }
  function redondear(n) { return Math.round((Number(n) || 0) * 100) / 100; }
  function esMes(ym) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(ym || '')); }
  function esFecha(f) { return /^\d{4}-\d{2}-\d{2}/.test(String(f || '')); }
  function mesDe(f) { return esFecha(f) ? String(f).slice(0, 7) : ''; }
  function finDeMes(ym) {
    var p = String(ym).split('-'), y = Number(p[0]), m = Number(p[1]);
    return ym + '-' + String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0');
  }
  function idPrestacion(a) { return a && a.id != null && String(a.id) !== '' ? String(a.id) : ''; }
  function profesionalDe(a) { return String((a && (a.profesionalId || a.cajaPerfil)) || 'matias'); }
  function coberturaDe(a) { return String((a && (a.obraSocial || a.coberturaAtencion)) || '').trim(); }
  function estadoDe(a) { return String((a && (a.estadoTurno || a.estado)) || '').toLowerCase(); }

  /** Clasifica las atenciones dentro de un rango de fechas. `rango(f)` decide si la fecha (AAAA-MM-DD) entra. Devuelve { listos, sinArancel, terceros, yaPresentadas, resumenPorMes, total }.
   *  opciones: atenciones[], presentados (Set|Array de IDs), cobertura (texto; opcional), profesionales (Set|Array permitidos; null = todos), obtenerArancel(a)->número,
   *            esFacturaTercero(a)->bool, incluirTerceros (false), obtenerEstado(a), texto (paciente/prestación; opcional) */
  function clasificar(o, rango) {
    var presentados = new Set(Array.from(o.presentados || []).map(String));
    var permitidos = o.profesionales ? new Set(Array.from(o.profesionales).map(String)) : null;
    var cob = o.cobertura ? norm(o.cobertura) : '', txt = o.texto ? norm(o.texto) : '';
    var arancel = typeof o.obtenerArancel === 'function' ? o.obtenerArancel : function () { return 0; };
    var tercero = typeof o.esFacturaTercero === 'function' ? o.esFacturaTercero : function () { return false; };
    var estado = typeof o.obtenerEstado === 'function' ? o.obtenerEstado : estadoDe;
    var r = { listos: [], sinArancel: [], terceros: [], yaPresentadas: 0, resumenPorMes: [], total: 0 };
    (Array.isArray(o.atenciones) ? o.atenciones : []).forEach(function (a) {
      if (!a || a.tipoRegistro === 'mensaje' || a.tipoRegistro === 'config') return;
      var id = idPrestacion(a), f = String(a.fecha || '').slice(0, 10), cobertura = coberturaDe(a), pid = profesionalDe(a);
      if (!id || !esFecha(f) || !rango(f)) return;
      if (['ausente', 'cancelado'].indexOf(String(estado(a) || '').toLowerCase()) >= 0) return;                  // no realizada
      if (!cobertura || COBERTURAS_NO_FACTURABLES.indexOf(norm(cobertura)) >= 0) return;                         // particular / PAMI: no se presenta
      if (cob && norm(cobertura) !== cob) return;
      if (permitidos && !permitidos.has(pid)) return;                                                              // permisos por profesional
      if (txt && norm(String(a.paciente || '') + ' ' + String(a.prestacion || '')).indexOf(txt) < 0) return;
      if (presentados.has(id)) { r.yaPresentadas++; return; }
      var importe = redondear(arancel(a));
      var fila = { id: id, fecha: f, mes: mesDe(f), profesionalId: pid, cobertura: cobertura, prestacion: String(a.prestacion || ''), pacienteId: String(a.pacienteId || ''), paciente: String(a.paciente || ''), importe: importe, arancelId: String(a.arancelId || '') };
      if (!(importe > 0)) { r.sinArancel.push(fila); return; }
      if (tercero(a, pid) && !o.incluirTerceros) { r.terceros.push(fila); return; }
      r.listos.push(fila);
    });
    var orden = function (x, y) { return x.fecha < y.fecha ? -1 : x.fecha > y.fecha ? 1 : (x.paciente < y.paciente ? -1 : x.paciente > y.paciente ? 1 : (x.id < y.id ? -1 : 1)); };
    r.listos.sort(orden); r.sinArancel.sort(orden); r.terceros.sort(orden);
    r.resumenPorMes = resumenPorMes(r.listos);
    r.total = redondear(r.listos.reduce(function (s, x) { return s + x.importe; }, 0));
    return r;
  }

  /** Lista AUTOMÁTICA: lo realizado, facturable y no presentado desde el inicio del control (`desde`) hasta el último día de `hastaMes` (incluye meses anteriores sin presentar). */
  function calcularPendientes(o) {
    o = o || {};
    if (!esFecha(o.desde)) throw new Error('Falta la fecha de inicio del control de presentaciones.');
    if (!esMes(o.hastaMes)) throw new Error('Período de presentación inválido (se espera AAAA-MM).');
    var hasta = finDeMes(o.hastaMes), desde = String(o.desde).slice(0, 10);
    return clasificar(o, function (f) { return f >= desde && f <= hasta; });
  }

  /** Candidatas a INCORPORACIÓN EXCEPCIONAL: realizadas y facturables ANTERIORES al inicio del control que no figuran presentadas en el sistema. Nunca se ofrecen solas:
   *  se buscan acotando por fechas (`desdeFecha`, `hastaFecha`, opcionales), cobertura, paciente/prestación (`texto`) y se suman a mano. NO se las da por presentadas ni se toca su fecha. */
  function calcularAnteriores(o) {
    o = o || {};
    if (!esFecha(o.desde)) throw new Error('Falta la fecha de inicio del control de presentaciones.');
    var desde = String(o.desde).slice(0, 10), piso = esFecha(o.desdeFecha) ? String(o.desdeFecha).slice(0, 10) : '', techo = esFecha(o.hastaFecha) ? String(o.hastaFecha).slice(0, 10) : '';
    return clasificar(o, function (f) { return f < desde && (!piso || f >= piso) && (!techo || f <= techo); });
  }

  /** Marca filas como excepcionales (anteriores al inicio del control) con su motivo. Devuelve copias: no modifica las originales. */
  function marcarExcepcionales(filas, motivo) {
    var m = String(motivo == null ? '' : motivo).trim();
    return (filas || []).map(function (x) { var c = {}; Object.keys(x).forEach(function (k) { c[k] = x[k]; }); c.excepcional = true; c.motivo = m; return c; });
  }

  function resumenPorMes(lista) {
    var m = {};
    lista.forEach(function (x) { var k = x.mes; if (!m[k]) m[k] = { mes: k, cantidad: 0, total: 0 }; m[k].cantidad++; m[k].total = redondear(m[k].total + x.importe); });
    return Object.keys(m).sort().map(function (k) { return m[k]; });
  }

  /** Excepciones SIN tildar una por una: reglas por mes, prestación, profesional, paciente o IDs puntuales. Todo lo que no coincide queda INCLUIDO. */
  function aplicarExclusiones(listos, reglas) {
    reglas = reglas || {};
    var set = function (x) { return new Set(Array.from(x || []).map(function (v) { return norm(v); })); };
    var meses = set(reglas.meses), prest = set(reglas.prestaciones), profs = set(reglas.profesionales), pacs = set(reglas.pacientes), ids = new Set(Array.from(reglas.ids || []).map(String));
    var incluidos = [], excluidos = [];
    listos.forEach(function (x) {
      var fuera = ids.has(x.id) || meses.has(norm(x.mes)) || prest.has(norm(x.prestacion)) || profs.has(norm(x.profesionalId)) || (x.pacienteId && pacs.has(norm(x.pacienteId))) || (x.paciente && pacs.has(norm(x.paciente)));
      (fuera ? excluidos : incluidos).push(x);
    });
    return { incluidos: incluidos, excluidos: excluidos };
  }

  /** Un lote por (cobertura, profesional): la autorización del servidor es por profesional. */
  function armarLotes(incluidos) {
    var m = {};
    incluidos.forEach(function (x) {
      var k = norm(x.cobertura) + '\u0000' + x.profesionalId;
      if (!m[k]) m[k] = { cobertura: x.cobertura, profesionalId: x.profesionalId, items: [], cantidad: 0, total: 0 };
      m[k].items.push(x); m[k].cantidad++; m[k].total = redondear(m[k].total + x.importe);
    });
    return Object.keys(m).sort().map(function (k) { return m[k]; });
  }

  /** Controles previos a confirmar: nada vacío, sin repetidos dentro del lote ni contra lo ya presentado, sin importes inválidos, tope de tamaño.
   *  Con `desde` (inicio del control): lo anterior a esa fecha solo entra como EXCEPCIÓN marcada y con motivo. */
  function validarLotes(lotes, presentados, desde) {
    var ya = new Set(Array.from(presentados || []).map(String)), vistos = new Set(), errores = [], n = 0;
    if (!lotes || !lotes.length) errores.push('No hay prestaciones para presentar.');
    (lotes || []).forEach(function (l) {
      if (!l.items || !l.items.length) errores.push('Lote vacío: ' + l.cobertura + '.');
      (l.items || []).forEach(function (x) {
        n++;
        if (!x.id) errores.push('Prestación sin ID estable.');
        else if (vistos.has(x.id)) errores.push('Prestación repetida en el lote: ' + x.id + '.');
        else if (ya.has(x.id)) errores.push('La prestación ' + x.id + ' ya fue presentada.');
        vistos.add(x.id);
        if (!(x.importe > 0)) errores.push('Importe inválido en la prestación ' + x.id + '.');
        if (esFecha(desde) && esFecha(x.fecha) && String(x.fecha).slice(0, 10) < String(desde).slice(0, 10) && !(x.excepcional === true && String(x.motivo || '').trim()))
          errores.push('La prestación ' + x.id + ' es anterior al inicio del control: solo se puede incorporar como excepción, con un motivo.');
      });
    });
    if (n > MAX_ITEMS_POR_CONFIRMACION) errores.push('Demasiadas prestaciones en una sola confirmación (máximo ' + MAX_ITEMS_POR_CONFIRMACION + ').');
    return errores;
  }

  /** Cuerpo para el servidor. El servidor NO confía en esto: revalida contra la atención, el profesional, la cobertura, la fecha y el permiso, y fija fecha y usuario. */
  function payloadConfirmar(periodo, lotes) {
    return {
      p_periodo: periodo,
      p_lotes: lotes.map(function (l) {
        return {
          cobertura: l.cobertura, professional_id: l.profesionalId,
          items: l.items.map(function (x) { return { atencion_id: x.id, fecha_atencion: x.fecha, cobertura: x.cobertura, prestacion: x.prestacion, importe_presentado: x.importe, arancel_id: x.arancelId || null, patient_id: x.pacienteId || null, patient_name: x.paciente || null, excepcional: x.excepcional === true, motivo_excepcion: x.excepcional === true ? (String(x.motivo || '').trim() || null) : null }; })
        };
      })
    };
  }

  function mapearError(e) {
    var m = String((e && (e.message || e.details)) || e || ''), c = e && e.code;
    if (c === '23505' || /duplicate key|ya fue presentada|PR409/i.test(m) && /duplic|ya/i.test(m)) return { tipo: 'duplicada', texto: 'Alguna de estas prestaciones ya fue presentada (otra persona confirmó antes). No se guardó nada: se actualizó la lista.' };
    if (c === '42501' || /sin permiso|permission denied|row-level security/i.test(m)) return { tipo: 'permiso', texto: 'No tenés permiso para presentar prestaciones de este profesional. Si corresponde, pedile al administrador que revise tus asociaciones.' };
    if (/PR010|fecha de control/i.test(m)) return { tipo: 'control', texto: 'Falta definir desde qué fecha se controlan las presentaciones (lo define el Dueño o un Administrador).' };
    if (/PR412/i.test(m)) return { tipo: 'arancel', texto: 'Alguna prestación no tiene un arancel válido fijado, por eso no se puede presentar. No se guardó nada: se actualizó la lista.' };
    if (/PR411|excepci/i.test(m)) return { tipo: 'excepcion', texto: 'Una prestación anterior al inicio del control solo se puede presentar como excepción, indicando el motivo. No se guardó nada.' };
    if (/PR40[49]|no coincide|no existe/i.test(m)) return { tipo: 'cambio', texto: 'Alguna prestación cambió o ya no corresponde (profesional, cobertura, fecha o estado). No se guardó nada: se actualizó la lista.' };
    return { tipo: 'error', texto: 'No se pudo confirmar la presentación: ' + m };
  }

  /** Almacén EN MEMORIA que imita las reglas del servidor (unicidad por atención, atomicidad, control, permiso). Sólo para pruebas y QA sin base de datos. */
  function crearAlmacenMemoria(cfg) {
    cfg = cfg || {};
    var st = { control: cfg.control || null, lotes: [], items: [], ahora: cfg.ahora || function () { return new Date().toISOString(); } };
    var usuario = cfg.usuario || { id: 'u1', email: 'prueba@cardiolink.test', rol: 'owner' };
    var puede = typeof cfg.puedeConfirmar === 'function' ? cfg.puedeConfirmar : function (rol) { return ['owner', 'admin', 'secretaria'].indexOf(rol) >= 0; };
    var atenciones = cfg.atenciones || [];
    return {
      _estado: st,
      leerControl: function () { return Promise.resolve(st.control); },
      guardarControl: function (fecha) { if (['owner', 'admin'].indexOf(usuario.rol) < 0) return Promise.reject({ code: '42501', message: 'sin permiso' }); st.control = fecha; return Promise.resolve(fecha); },
      leerPresentados: function () { return Promise.resolve(st.items.map(function (i) { return i.atencion_id; })); },
      leerHistorial: function () { return Promise.resolve(st.lotes.slice()); },
      confirmar: function (payload) {
        if (!puede(usuario.rol, null)) return Promise.reject({ code: '42501', message: 'sin permiso' });
        if (!st.control) return Promise.reject({ message: 'PR010 falta fecha de control' });
        var nuevos = [], vistos = new Set(st.items.map(function (i) { return i.atencion_id; })), lotes = [];
        var fin = finDeMes(payload.p_periodo);
        for (var li = 0; li < payload.p_lotes.length; li++) {
          var l = payload.p_lotes[li];
          if (!puede(usuario.rol, l.professional_id)) return Promise.reject({ code: '42501', message: 'sin permiso' });
          var total = 0;
          for (var ii = 0; ii < l.items.length; ii++) {
            var it = l.items[ii], a = atenciones.filter(function (x) { return String(x.id) === String(it.atencion_id); })[0];
            if (!a) return Promise.reject({ message: 'PR404 la atención no existe' });
            if (profesionalDe(a) !== l.professional_id || norm(coberturaDe(a)) !== norm(it.cobertura) || String(a.fecha).slice(0, 10) !== it.fecha_atencion) return Promise.reject({ message: 'PR409 no coincide con la atención' });
            if (it.fecha_atencion > fin) return Promise.reject({ message: 'PR409 fuera del período' });
            if (it.fecha_atencion < st.control && !(it.excepcional === true && String(it.motivo_excepcion || '').trim())) return Promise.reject({ message: 'PR411 anterior al inicio del control: solo como excepción con motivo' });
            if (vistos.has(String(it.atencion_id))) return Promise.reject({ code: '23505', message: 'duplicate key value violates unique constraint' });
            vistos.add(String(it.atencion_id)); total = redondear(total + it.importe_presentado);
            nuevos.push({ presentacion: li, atencion_id: String(it.atencion_id), fecha_atencion: it.fecha_atencion, importe_presentado: it.importe_presentado, excepcional: it.fecha_atencion < st.control, motivo_excepcion: it.fecha_atencion < st.control ? String(it.motivo_excepcion).trim() : null });
          }
          lotes.push({ id: 'lote-' + (st.lotes.length + li + 1), cobertura: l.cobertura, professional_id: l.professional_id, periodo: payload.p_periodo, cantidad: l.items.length, total_importe: total, presentado_en: st.ahora(), presentado_por: usuario.id, presentado_por_email: usuario.email, presentado_por_rol: usuario.rol });
        }
        // atomicidad: recién acá se confirma (todo o nada)
        lotes.forEach(function (l) { st.lotes.push(l); });
        nuevos.forEach(function (n) { st.items.push({ presentacion_id: lotes[n.presentacion].id, atencion_id: n.atencion_id, fecha_atencion: n.fecha_atencion, importe_presentado: n.importe_presentado, excepcional: n.excepcional, motivo_excepcion: n.motivo_excepcion }); });
        return Promise.resolve({ presentaciones: lotes.length, items: nuevos.length, total: redondear(lotes.reduce(function (s, l) { return s + l.total_importe; }, 0)) });
      }
    };
  }

  return {
    MAX_ITEMS_POR_CONFIRMACION: MAX_ITEMS_POR_CONFIRMACION, norm: norm, redondear: redondear, esMes: esMes, finDeMes: finDeMes, idPrestacion: idPrestacion, profesionalDe: profesionalDe, coberturaDe: coberturaDe,
    calcularPendientes: calcularPendientes, calcularAnteriores: calcularAnteriores, marcarExcepcionales: marcarExcepcionales, resumenPorMes: resumenPorMes, aplicarExclusiones: aplicarExclusiones, armarLotes: armarLotes, validarLotes: validarLotes, payloadConfirmar: payloadConfirmar,
    mapearError: mapearError, crearAlmacenMemoria: crearAlmacenMemoria
  };
});
