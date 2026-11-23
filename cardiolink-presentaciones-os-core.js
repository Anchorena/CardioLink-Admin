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
 *   · CIERRE DEL CÍRCULO MÉDICO (requiere el SQL _cierre_25): el cierre habitual es el día 25. Período normal del mes AAAA-MM = del 26 del mes anterior al 25 de AAAA-MM, inclusive. La FECHA DE CORTE se puede cambiar a mano (23, 24, 26 u otra
 *     dentro de ese mes). La lista automática entra hasta la fecha de corte inclusive y SIEMPRE incluye lo pendiente de períodos anteriores (lo realizado, facturable y no presentado desde el inicio del control): lo anterior al 26 del mes anterior se marca
 *     `anterior`. Se mantienen separadas TRES fechas: la de la atención (no se modifica), el período de presentación (mes) y la fecha EFECTIVA de presentación (la elige quien confirma; no puede ser futura ni anterior a la última atención incluida).
 *     Sin ese SQL se usa el comportamiento anterior: entra todo lo realizado hasta el último día del mes (`hastaMes`).
 *   · Período de presentación `hastaMes` (AAAA-MM): entra todo lo realizado hasta el último día de ese mes (incluye meses anteriores sin presentar), salvo que se indique `hastaFecha` (fecha de corte).
 *   · La fecha de producción (`fecha` de la atención) NO se modifica nunca: este módulo no escribe atenciones; guarda una COPIA de la fecha en cada ítem presentado.
 *   · «Terceros» (la facturación la hace otro profesional/destino): por defecto NO se incluyen en el lote; se informan aparte (decisión de negocio pendiente).
 *   · Sin arancel fijado: no se pueden presentar (importe 0); quedan aparte como incidencias pendientes. El importe nunca lo define el cliente.
 * FACTURACIÓN POR TERCEROS (bloque complementario; requiere el SQL _terceros): un estudio realizado por un profesional puede facturarlo OTRO. El facturante NO se deduce del convenio ni de lo que «coincida»:
 *   sale de una DELEGACIÓN EXPLÍCITA y aprobada (tabla cardiolink_presentaciones_os_delegaciones_v1: «los estudios de X con destino Y los factura Z»). Se lee `prestacionA` de la propia atención (no cambia si cambia el convenio).
 *   Cada ítem guarda quién realizó y quién factura; el lote es por (cobertura, FACTURANTE); el servidor revalida la delegación y el permiso sobre el facturante; el índice único por atención sigue impidiendo duplicados.
 *   Sin delegaciones cargadas (SQL no aplicado) el comportamiento es el de la V1: lo que factura otro queda aparte.
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
  var DIA_CIERRE = 25;
  function esFechaExacta(f) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(f || '')); if (!m) return false; var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])); return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3]; }
  function mesAnterior(ym) { var p = String(ym).split('-'), y = Number(p[0]), m = Number(p[1]) - 1; if (m < 1) { m = 12; y--; } return y + '-' + String(m).padStart(2, '0'); }
  /** Fecha de corte habitual del período AAAA-MM: el día 25. */
  function corteHabitual(ym) { return ym + '-' + String(DIA_CIERRE).padStart(2, '0'); }
  /** Primer día del período normal de AAAA-MM: el 26 del mes anterior. */
  function inicioPeriodo(ym) { return mesAnterior(ym) + '-' + String(DIA_CIERRE + 1).padStart(2, '0'); }
  /** Controles de las fechas del cierre. corte: dentro del mes del período; presentación: no futura (hoy) y no anterior a la última atención incluida (`ultimaAtencion`). Devuelve la lista de errores (vacía = válido). */
  function validarCierre(o) {
    o = o || {}; var e = [], f = function (x) { return String(x).slice(8, 10) + '/' + String(x).slice(5, 7) + '/' + String(x).slice(0, 4); };
    if (!esMes(o.periodo)) { e.push('Período de presentación inválido.'); return e; }
    if (!esFechaExacta(o.corte)) e.push('La fecha de corte no es válida.');
    else if (mesDe(o.corte) !== o.periodo) e.push('La fecha de corte debe estar dentro del mes del período (' + o.periodo.slice(5) + '/' + o.periodo.slice(0, 4) + ').');
    if (!esFechaExacta(o.presentacion)) e.push('La fecha de presentación no es válida.');
    else {
      if (esFechaExacta(o.hoy) && o.presentacion > o.hoy) e.push('La fecha de presentación no puede ser futura.');
      if (esFechaExacta(o.ultimaAtencion) && o.presentacion < o.ultimaAtencion) e.push('La fecha de presentación no puede ser anterior a la última prestación incluida (' + f(o.ultimaAtencion) + ').');
    }
    return e;
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
    var resolver = typeof o.facturanteDe === 'function' ? o.facturanteDe : null;          // facturación por terceros: devuelve { facturante, realiza, delegada, destino }
    var estado = typeof o.obtenerEstado === 'function' ? o.obtenerEstado : estadoDe;
    var r = { listos: [], sinArancel: [], terceros: [], yaPresentadas: 0, resumenPorMes: [], total: 0 };
    (Array.isArray(o.atenciones) ? o.atenciones : []).forEach(function (a) {
      if (!a || a.tipoRegistro === 'mensaje' || a.tipoRegistro === 'config') return;
      var id = idPrestacion(a), f = String(a.fecha || '').slice(0, 10), cobertura = coberturaDe(a), pid = profesionalDe(a);
      if (!id || !esFecha(f) || !rango(f)) return;
      if (['ausente', 'cancelado'].indexOf(String(estado(a) || '').toLowerCase()) >= 0) return;                  // no realizada
      if (!cobertura || COBERTURAS_NO_FACTURABLES.indexOf(norm(cobertura)) >= 0) return;                         // particular / PAMI: no se presenta
      if (cob && norm(cobertura) !== cob) return;
      var info = resolver ? resolver(a) : null, fact = info && info.facturante ? String(info.facturante) : pid, soloInforme = false;
      if (permitidos) {
        if (!resolver) { if (!permitidos.has(pid)) return; }                                                         // permisos por profesional (V1)
        else if (!permitidos.has(fact)) { if (fact !== pid && permitidos.has(pid)) soloInforme = true; else return; }  // con facturante explícito el permiso es el del que FACTURA; quien realizó solo ve un aviso
      }
      if (txt && norm(String(a.paciente || '') + ' ' + String(a.prestacion || '')).indexOf(txt) < 0) return;
      if (presentados.has(id)) { r.yaPresentadas++; return; }
      var importe = redondear(arancel(a));
      var fila = { id: id, fecha: f, mes: mesDe(f), profesionalId: resolver ? fact : pid, cobertura: cobertura, prestacion: String(a.prestacion || ''), pacienteId: String(a.pacienteId || ''), paciente: String(a.paciente || ''), importe: importe, arancelId: String(a.arancelId || '') };
      if (resolver) { fila.realizadoPor = pid; fila.facturante = fact; fila.delegada = fact !== pid; fila.destino = String((info && info.destino) || ''); }
      if (soloInforme) { r.terceros.push(fila); return; }                                                         // lo presenta su facturante: aquí solo se informa
      if (!(importe > 0)) { r.sinArancel.push(fila); return; }
      if ((!resolver || !fila.delegada) && tercero(a, pid) && !o.incluirTerceros) { r.terceros.push(fila); return; }   // sin delegación explícita, lo que factura otro NO se presenta (nunca se asume)
      r.listos.push(fila);
    });
    var orden = function (x, y) { return x.fecha < y.fecha ? -1 : x.fecha > y.fecha ? 1 : (x.paciente < y.paciente ? -1 : x.paciente > y.paciente ? 1 : (x.id < y.id ? -1 : 1)); };
    r.listos.sort(orden); r.sinArancel.sort(orden); r.terceros.sort(orden);
    r.resumenPorMes = resumenPorMes(r.listos);
    r.total = redondear(r.listos.reduce(function (s, x) { return s + x.importe; }, 0));
    return r;
  }

  /** Resolvedor del PROFESIONAL FACTURANTE a partir de DELEGACIONES EXPLÍCITAS [{ realiza_professional_id, destino_norm, facturante_professional_id, activa }].
   *  Solo reencamina un ESTUDIO (no una consulta) cuando existe una delegación activa para (profesional que realizó, destino escrito en `prestacionA`); en cualquier otro caso factura quien realizó (como en la V1).
   *  No usa la configuración de convenios: un cambio posterior del convenio no altera la asignación de lo ya registrado. Misma normalización y misma regla «consulta» que el servidor. */
  function esConsultaTexto(p) { return /consulta/i.test(String(p == null ? '' : p)); }
  function crearResolvedorFacturante(delegaciones) {
    var mapa = {};
    (Array.isArray(delegaciones) ? delegaciones : []).forEach(function (d) {
      if (d && d.activa !== false && d.realiza_professional_id && d.facturante_professional_id && d.destino_norm) mapa[String(d.realiza_professional_id) + '\u0000' + norm(d.destino_norm)] = String(d.facturante_professional_id);
    });
    return function (a) {
      var realiza = profesionalDe(a), destino = String((a && a.prestacionA) || '').trim();
      var f = (!esConsultaTexto(a && a.prestacion) && destino) ? mapa[realiza + '\u0000' + norm(destino)] : undefined;
      return { realiza: realiza, facturante: (f && f !== realiza) ? f : realiza, delegada: !!f && f !== realiza, destino: destino };
    };
  }

  /** Lista AUTOMÁTICA: lo realizado, facturable y no presentado desde el inicio del control (`desde`) hasta el último día de `hastaMes` (incluye meses anteriores sin presentar). */
  function calcularPendientes(o) {
    o = o || {};
    if (!esFecha(o.desde)) throw new Error('Falta la fecha de inicio del control de presentaciones.');
    if (!esMes(o.hastaMes)) throw new Error('Período de presentación inválido (se espera AAAA-MM).');
    var hasta = esFecha(o.hastaFecha) ? String(o.hastaFecha).slice(0, 10) : finDeMes(o.hastaMes), desde = String(o.desde).slice(0, 10);
    var r = clasificar(o, function (f) { return f >= desde && f <= hasta; });
    // Cierre del Círculo: lo realizado antes del 26 del mes anterior es «de períodos anteriores» (sigue apareciendo solo hasta que se presente).
    var ini = inicioPeriodo(o.hastaMes);
    r.periodo = { mes: o.hastaMes, desde: ini, corte: hasta, corteHabitual: corteHabitual(o.hastaMes) };
    [r.listos, r.sinArancel, r.terceros].forEach(function (l) { l.forEach(function (x) { x.anterior = x.fecha < ini; }); });
    r.anteriores = r.listos.filter(function (x) { return x.anterior; }).length;
    return r;
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
    // Cantidades e importes por lote (cobertura + facturante), separando lo del período de lo pendiente de períodos anteriores.
    return Object.keys(m).sort().map(function (k) {
      var l = m[k], ant = l.items.filter(function (x) { return x.anterior === true; });
      l.anteriores = { cantidad: ant.length, total: redondear(ant.reduce(function (s, x) { return s + x.importe; }, 0)) };
      l.delPeriodo = { cantidad: l.cantidad - ant.length, total: redondear(l.total - l.anteriores.total) };
      return l;
    });
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
        if (x.facturante && String(x.facturante) !== String(l.profesionalId)) errores.push('La prestación ' + x.id + ' debe presentarse por su profesional facturante.');
        if (esFecha(desde) && esFecha(x.fecha) && String(x.fecha).slice(0, 10) < String(desde).slice(0, 10) && !(x.excepcional === true && String(x.motivo || '').trim()))
          errores.push('La prestación ' + x.id + ' es anterior al inicio del control: solo se puede incorporar como excepción, con un motivo.');
      });
    });
    if (n > MAX_ITEMS_POR_CONFIRMACION) errores.push('Demasiadas prestaciones en una sola confirmación (máximo ' + MAX_ITEMS_POR_CONFIRMACION + ').');
    return errores;
  }

  /** Cuerpo para el servidor. El servidor NO confía en esto: revalida contra la atención, el profesional, la cobertura, la fecha y el permiso, y fija fecha y usuario. */
  function payloadConfirmar(periodo, lotes, cierre) {
    var extra = {};
    if (cierre && typeof cierre === 'object') { if (cierre.corte) extra.p_fecha_corte = cierre.corte; if (cierre.presentacion) extra.p_fecha_presentacion = cierre.presentacion; }   // solo con el SQL _cierre_25
    return Object.assign({
      p_periodo: periodo,
      p_lotes: lotes.map(function (l) {
        return {
          cobertura: l.cobertura, professional_id: l.profesionalId,
          items: l.items.map(function (x) { return { atencion_id: x.id, fecha_atencion: x.fecha, cobertura: x.cobertura, prestacion: x.prestacion, importe_presentado: x.importe, arancel_id: x.arancelId || null, realizado_por_professional_id: x.realizadoPor || null, facturante_professional_id: x.facturante || null, patient_id: x.pacienteId || null, patient_name: x.paciente || null, excepcional: x.excepcional === true, motivo_excepcion: x.excepcional === true ? (String(x.motivo || '').trim() || null) : null }; })
        };
      })
    }, extra);
  }

  function mapearError(e) {
    var m = String((e && (e.message || e.details)) || e || ''), c = e && e.code;
    if (c === '23505' || /duplicate key|ya fue presentada|PR409/i.test(m) && /duplic|ya/i.test(m)) return { tipo: 'duplicada', texto: 'Alguna de estas prestaciones ya fue presentada (otra persona confirmó antes). No se guardó nada: se actualizó la lista.' };
    if (c === '42501' || /sin permiso|permission denied|row-level security/i.test(m)) return { tipo: 'permiso', texto: 'No tenés permiso para presentar prestaciones de este profesional. Si corresponde, pedile al administrador que revise tus asociaciones.' };
    if (/PR413/i.test(m)) return { tipo: 'corte', texto: 'La fecha de corte no es válida para ese período (debe estar dentro del mes). No se guardó nada.' };
    if (/PR414/i.test(m)) return { tipo: 'fecha', texto: 'La fecha de presentación no es válida: no puede ser futura ni anterior a la última prestación incluida. No se guardó nada.' };
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
    var resolverSrv = Array.isArray(cfg.delegaciones) ? crearResolvedorFacturante(cfg.delegaciones) : null;      // con delegaciones, el servidor deriva el facturante de la atención
    return {
      _estado: st,
      leerDelegaciones: function () { return Promise.resolve(Array.isArray(cfg.delegaciones) ? cfg.delegaciones.slice() : null); },
      leerControl: function () { return Promise.resolve(st.control); },
      guardarControl: function (fecha) { if (['owner', 'admin'].indexOf(usuario.rol) < 0) return Promise.reject({ code: '42501', message: 'sin permiso' }); st.control = fecha; return Promise.resolve(fecha); },
      leerPresentados: function () { return Promise.resolve(st.items.map(function (i) { return i.atencion_id; })); },
      leerHistorial: function () { return Promise.resolve(st.lotes.slice()); },
      cierreDisponible: function () { return Promise.resolve(cfg.cierre !== false); },       // SQL _cierre_25 aplicado (por defecto sí en el almacén de pruebas)
      confirmar: function (payload) {
        if (!puede(usuario.rol, null)) return Promise.reject({ code: '42501', message: 'sin permiso' });
        if (!st.control) return Promise.reject({ message: 'PR010 falta fecha de control' });
        var nuevos = [], vistos = new Set(st.items.map(function (i) { return i.atencion_id; })), lotes = [];
        var hoyA = String(st.ahora()).slice(0, 10), fin = finDeMes(payload.p_periodo), fcorte = null, fpres = hoyA;
        if (payload.p_fecha_corte != null) { if (!esFechaExacta(payload.p_fecha_corte) || mesDe(payload.p_fecha_corte) !== payload.p_periodo) return Promise.reject({ message: 'PR413 fecha de corte fuera del mes del período' }); fcorte = payload.p_fecha_corte; fin = fcorte; }
        if (payload.p_fecha_presentacion != null) { if (!esFechaExacta(payload.p_fecha_presentacion) || payload.p_fecha_presentacion > hoyA) return Promise.reject({ message: 'PR414 fecha de presentación inválida' }); fpres = payload.p_fecha_presentacion; }
        for (var li = 0; li < payload.p_lotes.length; li++) {
          var l = payload.p_lotes[li];
          if (!puede(usuario.rol, l.professional_id)) return Promise.reject({ code: '42501', message: 'sin permiso' });
          var total = 0;
          for (var ii = 0; ii < l.items.length; ii++) {
            var it = l.items[ii], a = atenciones.filter(function (x) { return String(x.id) === String(it.atencion_id); })[0];
            if (!a) return Promise.reject({ message: 'PR404 la atención no existe' });
            var infoSrv = resolverSrv ? resolverSrv(a) : null, factSrv = infoSrv ? infoSrv.facturante : profesionalDe(a);
            if (factSrv !== l.professional_id || norm(coberturaDe(a)) !== norm(it.cobertura) || String(a.fecha).slice(0, 10) !== it.fecha_atencion) return Promise.reject({ message: 'PR409 no coincide con la atención' });
            if (resolverSrv && ((it.facturante_professional_id && it.facturante_professional_id !== factSrv) || (it.realizado_por_professional_id && it.realizado_por_professional_id !== profesionalDe(a)))) return Promise.reject({ message: 'PR409 el facturante o quien realizó no coincide con la atención' });
            if (it.fecha_atencion > fin) return Promise.reject({ message: 'PR409 fuera del período' });
            if (payload.p_fecha_presentacion != null && it.fecha_atencion > fpres) return Promise.reject({ message: 'PR414 la prestación es posterior a la fecha de presentación' });
            if (it.fecha_atencion < st.control && !(it.excepcional === true && String(it.motivo_excepcion || '').trim())) return Promise.reject({ message: 'PR411 anterior al inicio del control: solo como excepción con motivo' });
            if (vistos.has(String(it.atencion_id))) return Promise.reject({ code: '23505', message: 'duplicate key value violates unique constraint' });
            vistos.add(String(it.atencion_id)); total = redondear(total + it.importe_presentado);
            nuevos.push({ presentacion: li, atencion_id: String(it.atencion_id), realizado_por: profesionalDe(a), facturante: factSrv, destino_texto: String(a.prestacionA || '').trim() || null, fecha_atencion: it.fecha_atencion, importe_presentado: it.importe_presentado, excepcional: it.fecha_atencion < st.control, motivo_excepcion: it.fecha_atencion < st.control ? String(it.motivo_excepcion).trim() : null });
          }
          lotes.push({ id: 'lote-' + (st.lotes.length + li + 1), cobertura: l.cobertura, professional_id: l.professional_id, periodo: payload.p_periodo, fecha_corte: fcorte || fin, fecha_presentacion: fpres, cantidad: l.items.length, total_importe: total, presentado_en: st.ahora(), presentado_por: usuario.id, presentado_por_email: usuario.email, presentado_por_rol: usuario.rol });
        }
        // atomicidad: recién acá se confirma (todo o nada)
        lotes.forEach(function (l) { st.lotes.push(l); });
        nuevos.forEach(function (n) { st.items.push({ presentacion_id: lotes[n.presentacion].id, atencion_id: n.atencion_id, realizado_por_professional_id: n.realizado_por, facturante_professional_id: n.facturante, destino_texto: n.destino_texto, fecha_atencion: n.fecha_atencion, importe_presentado: n.importe_presentado, excepcional: n.excepcional, motivo_excepcion: n.motivo_excepcion }); });
        return Promise.resolve({ presentaciones: lotes.length, items: nuevos.length, total: redondear(lotes.reduce(function (s, l) { return s + l.total_importe; }, 0)) });
      }
    };
  }

  return {
    MAX_ITEMS_POR_CONFIRMACION: MAX_ITEMS_POR_CONFIRMACION, norm: norm, redondear: redondear, esMes: esMes, finDeMes: finDeMes, idPrestacion: idPrestacion, profesionalDe: profesionalDe, coberturaDe: coberturaDe,
    crearResolvedorFacturante: crearResolvedorFacturante, esConsultaTexto: esConsultaTexto, calcularPendientes: calcularPendientes, calcularAnteriores: calcularAnteriores, marcarExcepcionales: marcarExcepcionales, resumenPorMes: resumenPorMes, aplicarExclusiones: aplicarExclusiones, armarLotes: armarLotes, validarLotes: validarLotes, payloadConfirmar: payloadConfirmar,
    DIA_CIERRE: DIA_CIERRE, corteHabitual: corteHabitual, inicioPeriodo: inicioPeriodo, mesAnterior: mesAnterior, esFechaExacta: esFechaExacta, validarCierre: validarCierre,
    mapearError: mapearError, crearAlmacenMemoria: crearAlmacenMemoria
  };
});
