/* CardioLink · Carga paginada V1 · lectura COMPLETA de una tabla de Supabase por páginas (módulo mínimo, sólo lectura).
   Por qué existe: Supabase/PostgREST devuelve como máximo 1000 filas por consulta (HTTP 206 con «0-999/1055»). Una lectura `select('*')` sin paginar de
   cardiolink_pacientes (1055 filas en Production) dejaba afuera las ~55 filas más nuevas o recién editadas: cada perfil veía un padrón distinto.
   Módulo sin globales de la app: recibe el cliente Supabase y devuelve resultados. Node (tests) y navegador (window.cardiolinkCargaPaginadaV1).

   REGLAS
    · SÓLO LECTURA: únicamente `select`. Jamás insert/upsert/update/delete/rpc: leer no escribe, no marca nada para sincronizar ni abre pendientes.
    · ORDEN DETERMINISTA y paginación por CLAVE (keyset): `ORDER BY <clave> ASC` + `<clave> > última de la página anterior`. La clave es la PK (única, inmutable), así que
      una fila editada o creada mientras se lee NO se salta ni se repite (con `offset` sí ocurriría). Se descartan duplicados por clave (defensa).
    · COMPLETITUD DEMOSTRADA: la lectura sólo es «completa» si (a) una página vino con menos filas que el tamaño efectivo de página, o (b) lo leído alcanza el total
      informado por el servidor (count exacto de la primera consulta). El tamaño efectivo se aprende de la primera página: si el servidor corta antes de lo pedido,
      se usa ese corte (así no se cree «terminé» por un límite de filas más bajo que el esperado).
    · NUNCA una carga parcial como completa: ante un error de página (tras reintentos) devuelve { data:null, error, completo:false }. El llamador NO debe usar datos
      parciales (por eso `data` es null y `parcial` sólo informa cuántas filas se alcanzaron a leer).
    · REINTENTOS: un error transitorio se reintenta con la MISMA página (mismo cursor ⇒ sin saltos ni duplicados), con espera creciente y tope. Los errores de permiso/sesión
      (401/403, 42501, PGRST301, JWT) NO se reintentan.
    · SIN BUCLES: la clave debe avanzar en cada página (si no, error), máximo `maxPaginas` páginas y todas las claves distintas.
    · SIN SOLICITUDES DUPLICADAS: con `dedup`, una segunda llamada mientras otra con la misma etiqueta sigue en curso recibe la MISMA promesa.
    · El resultado tiene la forma de Supabase ({ data, error }) más { completo, total, paginas, ms, parcial }: es un reemplazo directo de `await sb.from(t).select(c)`. */
(function (raiz, fabrica) {
  'use strict';
  var api = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.cardiolinkCargaPaginadaV1 = api;
})(typeof self !== 'undefined' ? self : this, function (raiz) {
  'use strict';
  var TAMANO = 1000, MAX_PAGINAS = 200, REINTENTOS = 2, ESPERAS_MS = [300, 900];
  var enVuelo = {};

  function ahora() { try { return (raiz.performance && raiz.performance.now) ? raiz.performance.now() : Date.now(); } catch (e) { return Date.now(); } }
  function esperarPorDefecto(ms) { return new Promise(function (ok) { if (typeof setTimeout === 'function') setTimeout(ok, ms); else ok(); }); }
  // Errores que reintentar no arregla (permiso, sesión vencida, consulta inválida).
  function esFinal(e) {
    if (!e) return false;
    var c = String(e.code || ''), s = Number(e.status || 0), m = String(e.message || '');
    return c === '42501' || c === 'PGRST301' || c === 'PGRST302' || c === '42P01' || c === '42703' || c === 'PGRST100' || c === 'PGRST200' || c === 'PGRST204' ||
      s === 401 || s === 403 || /row-level security|permission denied|JWT/i.test(m);
  }

  // Lee UNA página (con reintentos de esa misma página). Devuelve { filas, total, error }.
  async function leerPagina(o, ultimo, primera, esperar) {
    var intento = 0, ultimoError = null;
    while (true) {
      var q;
      try {
        q = o.sb.from(o.tabla).select(o.columnas, primera ? { count: 'exact' } : undefined);
        if (typeof o.filtro === 'function') q = o.filtro(q);
        if (ultimo !== null && ultimo !== undefined) q = q.gt(o.clave, ultimo);
        q = q.order(o.clave, { ascending: true }).limit(o.tamano);
        var r = await q;
        if (!r || !r.error) return { filas: (r && Array.isArray(r.data)) ? r.data : [], total: (r && typeof r.count === 'number') ? r.count : null, error: null };
        ultimoError = r.error;
      } catch (e) { ultimoError = (e && e.message) ? e : { message: String(e) }; }
      if (esFinal(ultimoError) || intento >= o.reintentos) return { filas: null, total: null, error: ultimoError };
      await esperar(ESPERAS_MS[Math.min(intento, ESPERAS_MS.length - 1)]);
      intento++;
    }
  }

  async function leer(o) {
    var t0 = ahora(), esperar = o.esperar || esperarPorDefecto;
    var filas = [], vistas = {}, ultimo = null, paginas = 0, total = null, efectivo = o.tamano, completo = false, repetidas = 0;
    while (paginas < o.maxPaginas) {
      var p = await leerPagina(o, ultimo, paginas === 0, esperar);
      paginas++;
      if (p.error) return { data: null, error: p.error, completo: false, total: total, paginas: paginas, ms: ahora() - t0, parcial: filas.length };
      if (paginas === 1) {
        total = p.total;
        // Aprende el corte real del servidor: pidió min(tamaño, total) y vinieron menos ⇒ el servidor limita las páginas a esa cantidad.
        var esperado = total === null ? o.tamano : Math.min(o.tamano, total);
        if (p.filas.length > 0 && p.filas.length < esperado) efectivo = p.filas.length;
      }
      if (!p.filas.length) { completo = true; break; }
      var nuevas = 0, claveUltima = null;
      for (var i = 0; i < p.filas.length; i++) {
        var f = p.filas[i], k = f ? f[o.clave] : undefined;
        if (k === undefined || k === null) return { data: null, error: { code: 'CARGA_SIN_CLAVE', message: 'Una fila no trae la clave «' + o.clave + '»: la lectura paginada no puede continuar.' }, completo: false, total: total, paginas: paginas, ms: ahora() - t0, parcial: filas.length };
        claveUltima = k;
        var ks = String(k);
        if (Object.prototype.hasOwnProperty.call(vistas, ks)) { repetidas++; continue; }
        vistas[ks] = true; filas.push(f); nuevas++;
      }
      if (!nuevas || (ultimo !== null && String(claveUltima) === String(ultimo))) {
        return { data: null, error: { code: 'CARGA_SIN_AVANCE', message: 'La lectura paginada no avanza (claves repetidas). Se detuvo para no entrar en un bucle.' }, completo: false, total: total, paginas: paginas, ms: ahora() - t0, parcial: filas.length };
      }
      ultimo = claveUltima;
      if (p.filas.length < efectivo) { completo = true; break; }            // página incompleta ⇒ no queda nada más
      if (total !== null && filas.length >= total) { completo = true; break; } // lo leído alcanza el total informado: no hace falta otra consulta
    }
    if (!completo) return { data: null, error: { code: 'CARGA_MAX_PAGINAS', message: 'La lectura paginada superó el máximo de ' + o.maxPaginas + ' páginas sin terminar.' }, completo: false, total: total, paginas: paginas, ms: ahora() - t0, parcial: filas.length };
    if (typeof o.ordenar === 'function') filas = o.ordenar(filas);
    return { data: filas, error: null, completo: true, total: total, paginas: paginas, ms: ahora() - t0, parcial: filas.length, repetidas: repetidas };
  }

  // leerTodo({ sb, tabla, columnas='*', clave='id', filtro?, ordenar?, tamano=1000, maxPaginas=200, reintentos=2, dedup?, esperar? })
  function leerTodo(opciones) {
    var o = opciones || {};
    if (!o.sb || typeof o.sb.from !== 'function') return Promise.resolve({ data: null, error: { code: 'CARGA_SIN_CLIENTE', message: 'Sin cliente Supabase' }, completo: false });
    if (!o.tabla) return Promise.resolve({ data: null, error: { code: 'CARGA_SIN_TABLA', message: 'Falta la tabla' }, completo: false });
    o = { sb: o.sb, tabla: o.tabla, columnas: o.columnas || '*', clave: o.clave || 'id', filtro: o.filtro || null, ordenar: o.ordenar || null,
      tamano: Math.max(1, o.tamano || TAMANO), maxPaginas: o.maxPaginas || MAX_PAGINAS, reintentos: (o.reintentos == null ? REINTENTOS : o.reintentos), dedup: o.dedup || '', esperar: o.esperar };
    if (o.dedup && enVuelo[o.dedup]) return enVuelo[o.dedup];
    var pr = leer(o).then(function (r) { if (o.dedup) delete enVuelo[o.dedup]; return r; }, function (e) { if (o.dedup) delete enVuelo[o.dedup]; return { data: null, error: { code: 'CARGA_EXCEPCION', message: String(e && e.message || e) }, completo: false }; });
    if (o.dedup) enVuelo[o.dedup] = pr;
    return pr;
  }

  // Comparador «más reciente primero» por un campo de fecha (ISO) con desempate por clave: reproduce el orden `updated_at DESC` de la consulta original, ahora determinista.
  function masRecientePrimero(campo, clave) {
    return function (filas) {
      return filas.slice().sort(function (a, b) {
        var x = Date.parse(a && a[campo]) || 0, y = Date.parse(b && b[campo]) || 0;
        if (x !== y) return y - x;
        var ka = String(a && a[clave] != null ? a[clave] : ''), kb = String(b && b[clave] != null ? b[clave] : '');
        return ka < kb ? -1 : (ka > kb ? 1 : 0);
      });
    };
  }

  return { TAMANO: TAMANO, MAX_PAGINAS: MAX_PAGINAS, REINTENTOS: REINTENTOS, leerTodo: leerTodo, masRecientePrimero: masRecientePrimero, esFinal: esFinal };
});
