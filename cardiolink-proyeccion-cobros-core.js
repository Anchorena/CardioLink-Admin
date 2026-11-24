/* CardioLink · PROYECCIÓN MENSUAL DE COBROS V1 · NÚCLEO (lógica pura, sin DOM, sin red, sin globales de la app)
 *
 * Qué resuelve: una vista simple de INGRESOS ESPERADOS por obras sociales y prepagas, a partir de las presentaciones YA CONFIRMADAS (cardiolink_presentaciones_os_v1) y de un
 * plazo estimado de pago por cobertura (30, 60, 90 días o personalizado). Es una PROYECCIÓN: NO es dinero cobrado, NO entra en Caja ni en Finanzas, y no concilia nada.
 *
 * Regla:   fecha estimada de cobro = fecha EFECTIVA de presentación + plazo (días corridos) de la cobertura.
 *   · Solo presentaciones confirmadas: toda fila de cardiolink_presentaciones_os_v1 lo es (en V1 no existe «borrador», anulación ni rectificación).
 *   · Fecha efectiva de presentación: `fecha_presentacion` (cierre del día 25); en presentaciones anteriores a ese cierre (columna vacía) se usa el día en que se registró (`presentado_en`, hora de Buenos Aires).
 *   · Sin plazo configurado para la cobertura: la presentación NO se proyecta a ningún mes; se informa aparte (con su importe) para que no quede oculta.
 *   · Sin duplicaciones: cada presentación se cuenta una sola vez por su ID estable (`id` de la presentación), aunque la lectura la traiga repetida.
 *   · Los plazos viven en la configuración (`plazosPagoCobertura`, por cobertura normalizada). Cambiar un plazo NO modifica ninguna presentación: solo recalcula la proyección.
 * UMD: Node (pruebas) y navegador (window.CardioLinkProyeccionCobrosCoreV1). */
(function (raiz, fabrica) {
  'use strict';
  var api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.CardioLinkProyeccionCobrosCoreV1 = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var PLAZOS_PREDEFINIDOS = [30, 60, 90];
  var PLAZO_MIN = 1, PLAZO_MAX = 365;
  var CLAVE_CONFIG = 'plazosPagoCobertura';
  var ZONA = 'America/Argentina/Buenos_Aires';

  function norm(v) { return String(v == null ? '' : v).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim(); }
  function redondear(n) { return Math.round((Number(n) || 0) * 100) / 100; }
  function esFechaExacta(f) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(f || '')); if (!m) return false; var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])); return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3]; }
  function sumarDias(iso, dias) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso), d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + dias)); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0'); }
  /** Día (AAAA-MM-DD) de un instante (timestamptz) en hora de Buenos Aires: la fecha «de calendario» en que se registró. */
  function fechaLocalDe(ts) {
    var d = new Date(ts); if (isNaN(d.getTime())) return '';
    try { var p = new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); if (esFechaExacta(p)) return p; } catch (e) { /* sin Intl: se usa UTC-3 fijo */ }
    var l = new Date(d.getTime() - 3 * 3600 * 1000); return l.getUTCFullYear() + '-' + String(l.getUTCMonth() + 1).padStart(2, '0') + '-' + String(l.getUTCDate()).padStart(2, '0');
  }
  /** Plazo válido: entero entre 1 y 365 días, o null. */
  function validarPlazo(x) {
    if (x === '' || x == null || typeof x === 'boolean') return null;
    var n = Number(x); return Number.isInteger(n) && n >= PLAZO_MIN && n <= PLAZO_MAX ? n : null;
  }
  /** Plazo configurado para una cobertura (nombre sin importar mayúsculas, tildes ni espacios), o null. */
  function plazoDe(plazos, cobertura) {
    var e = plazos && typeof plazos === 'object' ? plazos[norm(cobertura)] : null;
    return e && typeof e === 'object' ? validarPlazo(e.dias) : null;
  }
  /** Fecha efectiva de presentación de una cabecera: la elegida (cierre del 25) o, en las anteriores, el día de registro. */
  function fechaPresentacionDe(p) {
    if (p && esFechaExacta(String(p.fecha_presentacion || '').slice(0, 10))) return { fecha: String(p.fecha_presentacion).slice(0, 10), origen: 'elegida' };
    var f = p && p.presentado_en ? fechaLocalDe(p.presentado_en) : '';
    return f ? { fecha: f, origen: 'registro' } : { fecha: '', origen: '' };
  }

  function grupo(mapa, clave, base) { if (!mapa[clave]) mapa[clave] = base; return mapa[clave]; }
  function ordenar(obj, cmp) { return Object.keys(obj).map(function (k) { return obj[k]; }).sort(cmp); }

  /** Proyección. o: { presentaciones: [{id, cobertura, professional_id, periodo, cantidad, total_importe, fecha_presentacion?, presentado_en}], plazos, hoy (AAAA-MM-DD, opcional: marca fechas ya pasadas), profesionales (permitidos; opcional) }.
   *  Devuelve { meses[], sinPlazo, invalidas, duplicadasIgnoradas, total, cantidadPresentaciones }. No modifica sus argumentos. */
  function proyectar(o) {
    o = o || {};
    var vistos = {}, meses = {}, sinPlazo = { cantidadPresentaciones: 0, cantidad: 0, total: 0, porCobertura: {} }, r = { meses: [], sinPlazo: null, invalidas: [], duplicadasIgnoradas: 0, total: 0, cantidadPresentaciones: 0 };
    var permitidos = o.profesionales ? new Set(Array.from(o.profesionales).map(String)) : null;
    (Array.isArray(o.presentaciones) ? o.presentaciones : []).forEach(function (p) {
      if (!p) return;
      var id = p.id == null ? '' : String(p.id);
      if (!id) { r.invalidas.push({ id: '', motivo: 'sin ID estable' }); return; }
      if (vistos[id]) { r.duplicadasIgnoradas++; return; }
      vistos[id] = 1;
      var importe = redondear(p.total_importe), cob = String(p.cobertura || '').trim(), prof = String(p.professional_id || '').trim();
      if (permitidos && !permitidos.has(prof)) return;
      if (!cob || !prof || !(importe > 0)) { r.invalidas.push({ id: id, motivo: 'datos incompletos' }); return; }
      var fp = fechaPresentacionDe(p);
      if (!fp.fecha) { r.invalidas.push({ id: id, motivo: 'sin fecha de presentación' }); return; }
      var cantidad = Math.max(0, Math.trunc(Number(p.cantidad) || 0)), dias = plazoDe(o.plazos, cob);
      if (dias === null) {
        sinPlazo.cantidadPresentaciones++; sinPlazo.cantidad += cantidad; sinPlazo.total = redondear(sinPlazo.total + importe);
        var sc = grupo(sinPlazo.porCobertura, norm(cob), { cobertura: cob, presentaciones: 0, cantidad: 0, total: 0 });
        sc.presentaciones++; sc.cantidad += cantidad; sc.total = redondear(sc.total + importe);
        return;
      }
      var cobro = sumarDias(fp.fecha, dias), mes = cobro.slice(0, 7);
      var fila = { id: id, cobertura: cob, profesionalId: prof, periodo: String(p.periodo || ''), cantidad: cantidad, importe: importe, fechaPresentacion: fp.fecha, origenFecha: fp.origen, plazo: dias, fechaCobro: cobro, mes: mes, pasada: esFechaExacta(o.hoy) ? cobro < o.hoy : false };
      var m = grupo(meses, mes, { mes: mes, total: 0, cantidadPresentaciones: 0, cantidad: 0, porCobertura: {}, porProfesional: {}, porFecha: {}, filas: [] });
      m.total = redondear(m.total + importe); m.cantidadPresentaciones++; m.cantidad += cantidad; m.filas.push(fila);
      var c = grupo(m.porCobertura, norm(cob), { cobertura: cob, plazo: dias, presentaciones: 0, cantidad: 0, total: 0 }); c.presentaciones++; c.cantidad += cantidad; c.total = redondear(c.total + importe);
      var pr = grupo(m.porProfesional, prof, { profesionalId: prof, presentaciones: 0, cantidad: 0, total: 0 }); pr.presentaciones++; pr.cantidad += cantidad; pr.total = redondear(pr.total + importe);
      var fe = grupo(m.porFecha, cobro, { fecha: cobro, presentaciones: 0, cantidad: 0, total: 0, pasada: fila.pasada }); fe.presentaciones++; fe.cantidad += cantidad; fe.total = redondear(fe.total + importe);
      r.total = redondear(r.total + importe); r.cantidadPresentaciones++;
    });
    var porNombre = function (a, b) { return a.cobertura < b.cobertura ? -1 : a.cobertura > b.cobertura ? 1 : 0; };
    r.meses = ordenar(meses, function (a, b) { return a.mes < b.mes ? -1 : 1; }).map(function (m) {
      m.porCobertura = ordenar(m.porCobertura, porNombre);
      m.porProfesional = ordenar(m.porProfesional, function (a, b) { return a.profesionalId < b.profesionalId ? -1 : 1; });
      m.porFecha = ordenar(m.porFecha, function (a, b) { return a.fecha < b.fecha ? -1 : 1; });
      m.filas.sort(function (a, b) { return a.fechaCobro < b.fechaCobro ? -1 : a.fechaCobro > b.fechaCobro ? 1 : (a.cobertura < b.cobertura ? -1 : (a.id < b.id ? -1 : 1)); });
      return m;
    });
    sinPlazo.porCobertura = ordenar(sinPlazo.porCobertura, porNombre); r.sinPlazo = sinPlazo;
    return r;
  }

  /** Fija el plazo de una cobertura en la configuración (copia mínima: solo toca config.plazosPagoCobertura[cobertura]). dias=null/'' lo quita. No toca presentaciones, atenciones ni otras claves. */
  function aplicarPlazo(config, cobertura, dias) {
    var nombre = String(cobertura == null ? '' : cobertura).trim();
    if (!config || typeof config !== 'object') return { ok: false, error: 'Sin configuración.' };
    if (!nombre) return { ok: false, error: 'Falta la cobertura.' };
    var k = norm(nombre), mapa = config[CLAVE_CONFIG] && typeof config[CLAVE_CONFIG] === 'object' && !Array.isArray(config[CLAVE_CONFIG]) ? config[CLAVE_CONFIG] : null;
    if (dias === null || dias === '' || dias === undefined) {
      if (!mapa || !mapa[k]) return { ok: true, sinCambios: true, antes: null, despues: null };
      var a0 = validarPlazo(mapa[k].dias); delete mapa[k]; return { ok: true, sinCambios: false, antes: a0, despues: null };
    }
    var n = validarPlazo(dias);
    if (n === null) return { ok: false, error: 'El plazo debe ser un número entero de días entre ' + PLAZO_MIN + ' y ' + PLAZO_MAX + '.' };
    if (!mapa) mapa = config[CLAVE_CONFIG] = {};
    var antes = mapa[k] ? validarPlazo(mapa[k].dias) : null;
    if (antes === n && mapa[k].cobertura) return { ok: true, sinCambios: true, antes: antes, despues: n };
    mapa[k] = { cobertura: mapa[k] && mapa[k].cobertura ? mapa[k].cobertura : nombre, dias: n };
    return { ok: true, sinCambios: false, antes: antes, despues: n };
  }

  return {
    PLAZOS_PREDEFINIDOS: PLAZOS_PREDEFINIDOS, PLAZO_MIN: PLAZO_MIN, PLAZO_MAX: PLAZO_MAX, CLAVE_CONFIG: CLAVE_CONFIG, norm: norm, redondear: redondear, esFechaExacta: esFechaExacta, sumarDias: sumarDias,
    fechaLocalDe: fechaLocalDe, validarPlazo: validarPlazo, plazoDe: plazoDe, fechaPresentacionDe: fechaPresentacionDe, proyectar: proyectar, aplicarPlazo: aplicarPlazo
  };
});
