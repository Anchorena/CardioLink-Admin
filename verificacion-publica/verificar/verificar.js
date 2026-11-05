/* CardioLink · Documentos V2A / F3 — página pública de verificación. Sin dependencias (sólo Cloudflare Turnstile). Todo texto se inserta con textContent. */
(function () {
  'use strict';
  var FUNCION_PRODUCCION = 'https://tupacclmhaqiahhlttyz.supabase.co/functions/v1/document-verify';
  var FUNCION_STAGING = 'https://yslhwdlzdknhskawqrtv.supabase.co/functions/v1/document-verify';
  var HOST_PRODUCCION = 'cardiolink.com.ar';
  var SITEKEY_PRODUCCION = '0x4AAAAAAF0AxYzaP58oXCMy';          // widget de cardiolink.com.ar (clave pública; se completa al crearlo en Cloudflare)
  var SITEKEY_PRUEBAS_PAGES = '0x4AAAAAAFtDuw3xlPO1jtXy';           // widget del sitio de pruebas *.pages.dev (clave PÚBLICA de Turnstile; la secreta nunca va en el código)
  var SITEKEY_TEST = '1x00000000000000000000BB';                    // clave pública de prueba de Cloudflare (siempre pasa, widget invisible): sólo en local
  var CODIGO_RE = /^[A-Za-z0-9_-]{22}$/;
  var MENSAJE_NO_VERIFICABLE = 'No se pudo verificar este documento. Comprobá que escaneaste el código QR completo. Si el problema continúa, consultá con el profesional que lo emitió.';

  var $ = function (id) { return document.getElementById(id); };
  var host = location.hostname;
  var esLocal = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  var params = new URLSearchParams(location.search);
  var codigo = params.get('c') || '';

  // Entorno por hostname (LISTA CERRADA; cualquier otro host queda fuera de servicio):
  //   cardiolink.com.ar -> Production · *.pages.dev (sitio de pruebas) -> STAGING · localhost -> STAGING (o servidor simulado con ?api=, sólo en local).
  var urlFuncion = '', sitekey = '';
  if (esLocal) {
    urlFuncion = FUNCION_STAGING; sitekey = SITEKEY_TEST;
    var api = params.get('api');
    if (api && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(api)) urlFuncion = api;
  } else if (host === HOST_PRODUCCION) {
    urlFuncion = FUNCION_PRODUCCION; sitekey = SITEKEY_PRODUCCION;
  } else if (/\.pages\.dev$/.test(host)) {
    urlFuncion = FUNCION_STAGING; sitekey = SITEKEY_PRUEBAS_PAGES;
  }

  function ocultar(el) { el.hidden = true; }
  function mostrar(el) { el.hidden = false; }
  function limpiar(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function nodo(tag, clase, texto) { var e = document.createElement(tag); if (clase) e.className = clase; if (texto != null) e.textContent = texto; return e; }

  function fechaLegible(iso) {            // 'AAAA-MM-DD' -> 'DD/MM/AAAA' (sin pasar por Date: no hay corrimiento de zona horaria)
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    return m ? m[3] + '/' + m[2] + '/' + m[1] : null;
  }

  function mostrarMensaje(clase, titulo, texto, reintentar) {
    var r = $('resultado'); limpiar(r);
    r.appendChild(nodo('span', 'estado ' + clase, titulo));
    if (texto) r.appendChild(nodo('p', 'aviso ' + (clase === 'neutro' ? '' : clase), texto));
    if (reintentar) { var b = nodo('button', null, 'Reintentar'); b.type = 'button'; b.addEventListener('click', function () { location.reload(); }); r.appendChild(b); }
    ocultar($('cargando')); mostrar(r); ocultar($('acceso-pdf'));
  }

  var ETIQUETAS = { vigente: 'Documento vigente', reemplazado: 'Documento reemplazado', anulado: 'Documento anulado' };
  var AVISOS = {
    reemplazado: 'Este documento fue reemplazado por una versión más reciente. Consultá con el profesional cuál es la versión válida.',
    anulado: 'Este documento fue anulado por quien lo emitió y no tiene validez.'
  };

  function mostrarVerificado(d) {
    var estado = ETIQUETAS[d.estado] ? d.estado : null;
    if (!estado) { mostrarMensaje('neutro', 'No verificable', MENSAJE_NO_VERIFICABLE); return; }
    var r = $('resultado'); limpiar(r);
    r.appendChild(nodo('span', 'estado ' + estado, ETIQUETAS[estado]));
    if (AVISOS[estado]) r.appendChild(nodo('p', 'aviso ' + estado, AVISOS[estado]));
    var dl = nodo('dl');
    function fila(t, v) { if (v == null || v === '') return; dl.appendChild(nodo('dt', null, t)); dl.appendChild(nodo('dd', null, v)); }
    fila('Tipo', d.tipo);
    fila('Fecha de emisión', fechaLegible(d.emitido));
    if (d.profesional) {
      fila('Profesional', d.profesional.nombre);
      fila('Especialidad', d.profesional.especialidad);
      fila('Matrícula', Array.isArray(d.profesional.matriculas) && d.profesional.matriculas.length ? d.profesional.matriculas.join(' · ') : null);
    }
    fila('Huella del documento', d.huella);
    if (d.firma && d.firma !== 'sin_firma_digital') fila('Firma digital', d.firma === 'firmado_pades' ? 'Firmado digitalmente' : 'Firmado externamente');
    r.appendChild(dl);
    ocultar($('cargando')); mostrar(r);
    // F4: acceso protegido al documento completo (PIN temporal). Hoy el servidor informa disponible=false: sólo se muestra la explicación.
    var a = $('acceso-pdf'), ap = d.acceso_pdf || {};
    if (estado === 'vigente') {        // un documento anulado o reemplazado no ofrece acceso al PDF
      $('acceso-pdf-texto').textContent = 'El documento completo sólo puede verlo su titular con el PIN temporal que recibió al emitirse. Esta función se habilitará próximamente.';
      mostrar(a);
      $('form-pin').hidden = ap.disponible !== true;
    } else { ocultar(a); }
  }

  function aplicarRespuesta(status, d) {
    if (status === 200 && d && d.resultado === 'verificado') return mostrarVerificado(d);
    if (status === 200) return mostrarMensaje('neutro', 'No verificable', MENSAJE_NO_VERIFICABLE);
    if (status === 403) return mostrarMensaje('error', 'No pudimos confirmar que sos una persona', 'Reintentá en unos segundos.', true);
    if (status === 429) return mostrarMensaje('error', 'Demasiados intentos', 'Esperá unos minutos antes de volver a intentar.');
    return mostrarMensaje('error', 'Servicio no disponible', 'No pudimos completar la verificación ahora. Intentá de nuevo más tarde.', true);
  }

  function consultar(token) {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var t = ctl ? setTimeout(function () { ctl.abort(); }, 15000) : null;
    fetch(urlFuncion, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ codigo: codigo, turnstileToken: token }), cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctl ? ctl.signal : undefined })
      .then(function (r) { return r.json().then(function (d) { return { s: r.status, d: d }; }, function () { return { s: r.status, d: null }; }); })
      .then(function (x) { if (t) clearTimeout(t); aplicarRespuesta(x.s, x.d); })
      .catch(function () { if (t) clearTimeout(t); aplicarRespuesta(0, null); });
  }

  function obtenerToken(cb) {
    if (!sitekey || !urlFuncion || /_PENDIENTE$/.test(sitekey)) { mostrarMensaje('error', 'Servicio en configuración', 'La verificación todavía no está habilitada.'); return; }
    var s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true; s.defer = true;
    s.onload = function () {
      try {
        window.turnstile.render('#turnstile', { sitekey: sitekey, action: 'verificar-documento', size: 'invisible', execution: 'execute', callback: cb, 'error-callback': function () { aplicarRespuesta(403, null); } });
        window.turnstile.execute('#turnstile');
      } catch (e) { aplicarRespuesta(403, null); }
    };
    s.onerror = function () { aplicarRespuesta(0, null); };
    document.head.appendChild(s);
  }

  if (!CODIGO_RE.test(codigo)) { mostrarMensaje('neutro', 'No verificable', MENSAJE_NO_VERIFICABLE); return; }   // formato inválido: ni se consulta
  obtenerToken(consultar);
})();
