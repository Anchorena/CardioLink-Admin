// CardioLink Admin — Comunicaciones V1.2, Bloque B1 · página pública de
// cancelación de turno.
//
// NO conectada todavía al botón real del email (eso es Bloque B2) - se
// prueba con una URL generada a mano contra STAGING. Sin frameworks, sin
// dependencias externas, sin trackers/analytics.
//
// Seguridad del token en el navegador:
// - viaja SIEMPRE por fragmento (#token=...), nunca por query string - el
//   fragmento no se envía al servidor HTTP (GitHub Pages) ni aparece en
//   ningún header Referer;
// - se lee UNA sola vez de location.hash y se guarda sólo en una variable
//   JS en memoria (nunca localStorage/sessionStorage/cookies);
// - la URL visible se limpia inmediatamente con history.replaceState(),
//   así el token no queda ni en el historial del navegador ni visible en
//   la barra de direcciones más que un instante.
//
// BRANDING: a propósito esta página NO usa el logo/branding centralizado
// de CardioLink todavía (ver instrucción explícita del bloque) - eso se
// incorpora en un paso separado, junto con el nuevo isologo oficial. Sólo
// texto "CardioLink" simple, sin sistema de logos ni colores nuevo.

(function () {
  'use strict';

  // Selección de entorno: MISMO criterio exacto ya centralizado en
  // portal/portal.js (esEntornoLocal/gatewayUrl) - no se inventa un
  // criterio nuevo. localhost/127.0.0.1/::1 -> Staging automáticamente,
  // sin configuración manual. Cualquier otro hostname (incluida cualquier
  // copia publicada de este portal, ej. anchorena.github.io) usa
  // Producción por default: una página publicada en GitHub Pages nunca
  // puede terminar apuntando a Staging por accidente, porque no depende de
  // reconocer una lista de hostnames "de producción" - lo que NO es local
  // ya cae en Producción. Override en runtime disponible con
  // window.CARDIOLINK_APPOINTMENT_CANCELLATION_URL si hiciera falta
  // apuntar a otro proyecto, mismo mecanismo que
  // window.CARDIOLINK_PORTAL_GATEWAY_URL en portal.js.
  function esEntornoLocal() {
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(window.location.hostname);
  }
  var FUNCTION_URL_STAGING_LOCAL = 'https://yslhwdlzdknhskawqrtv.supabase.co/functions/v1/appointment-cancellation-public';
  var FUNCTION_URL_PRODUCCION_DEFAULT = 'https://tupacclmhaqiahhlttyz.supabase.co/functions/v1/appointment-cancellation-public';
  function functionUrl() {
    if (esEntornoLocal()) return FUNCTION_URL_STAGING_LOCAL;
    return window.CARDIOLINK_APPOINTMENT_CANCELLATION_URL || FUNCTION_URL_PRODUCCION_DEFAULT;
  }

  function $(id) { return document.getElementById(id); }

  function leerTokenDeHash() {
    var hash = window.location.hash || '';
    if (hash.charAt(0) === '#') hash = hash.slice(1);
    var params = new URLSearchParams(hash);
    return params.get('token') || '';
  }

  // Limpia la URL visible INMEDIATAMENTE, antes de cualquier llamada de
  // red - el token ya quedó guardado en la variable `token` de este
  // closure, no hace falta que siga en la URL ni un instante más de lo
  // necesario.
  function limpiarUrl() {
    try {
      var sinHash = window.location.pathname + window.location.search;
      window.history.replaceState(null, '', sinHash);
    } catch (_error) { /* navegador muy viejo sin history.replaceState: no crítico */ }
  }

  function mostrarError(mensaje) {
    $('cancelarTurnoCargando').hidden = true;
    $('cancelarTurnoDatos').hidden = true;
    var el = $('cancelarTurnoError');
    el.textContent = mensaje || 'No se pudo procesar la solicitud. Probá de nuevo más tarde.';
    el.hidden = false;
  }

  function mostrarExito(mensaje) {
    $('cancelarTurnoCargando').hidden = true;
    $('cancelarTurnoError').hidden = true;
    $('cancelarTurnoDatos').hidden = true;
    var el = $('cancelarTurnoExito');
    el.textContent = mensaje;
    el.hidden = false;
  }

  async function llamarFuncion(body) {
    var respuesta = await fetch(functionUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    var cuerpo = null;
    try { cuerpo = await respuesta.json(); } catch (_error) { /* respuesta no-JSON: cuerpo queda null */ }
    return { status: respuesta.status, cuerpo: cuerpo || {} };
  }

  function mostrarDatosTurno(info) {
    $('cancelarTurnoCargando').hidden = true;
    $('ctPaciente').textContent = info.paciente || 's/d';
    $('ctFecha').textContent = info.fecha || 's/d';
    $('ctHora').textContent = info.horaInicio || 's/d';
    $('ctPrestacion').textContent = info.prestacion || 's/d';
    $('ctProfesional').textContent = info.profesional || 's/d';
    $('cancelarTurnoDatos').hidden = false;
  }

  async function iniciar() {
    var token = leerTokenDeHash();
    limpiarUrl();

    if (!token) {
      mostrarError('Este enlace no es válido. Verificá que copiaste la dirección completa del email, o comunicate con el consultorio.');
      return;
    }

    var resultadoInfo;
    try {
      resultadoInfo = await llamarFuncion({ action: 'info', token: token });
    } catch (_error) {
      mostrarError('No se pudo conectar. Revisá tu conexión a internet y volvé a abrir el enlace del email.');
      return;
    }

    if (!resultadoInfo.cuerpo.ok) {
      // 'appointment_changed' y cualquier otro motivo ya vienen como texto
      // seguro para mostrar tal cual (nunca detalle técnico/criptográfico).
      mostrarError(resultadoInfo.cuerpo.error || 'No se pudo validar el enlace.');
      return;
    }

    var info = resultadoInfo.cuerpo;
    if (info.yaCancelado) {
      mostrarExito('Tu turno ya estaba cancelado. No hace falta ninguna otra acción.');
      return;
    }
    if (!info.cancelable) {
      mostrarError('Este turno ya no puede cancelarse desde este enlace. Comunicate con el consultorio si necesitás hacer un cambio.');
      return;
    }

    mostrarDatosTurno(info);

    var boton = $('ctBotonConfirmar');
    // Sólo acá, tras un click EXPLÍCITO del paciente, se llama a
    // "confirmar" - abrir la página o recibir la info nunca cancela nada.
    boton.addEventListener('click', async function () {
      boton.disabled = true;
      boton.textContent = 'Procesando…';
      var motivo = ($('ctMotivo').value || '').trim();

      var resultadoConfirmar;
      try {
        resultadoConfirmar = await llamarFuncion({ action: 'confirmar', token: token, motivo: motivo });
      } catch (_error) {
        boton.disabled = false;
        boton.textContent = 'CONFIRMAR CANCELACIÓN';
        mostrarError('No se pudo conectar. Revisá tu conexión a internet e intentá de nuevo.');
        return;
      }

      if (!resultadoConfirmar.cuerpo.ok) {
        boton.disabled = false;
        boton.textContent = 'CONFIRMAR CANCELACIÓN';
        mostrarError(resultadoConfirmar.cuerpo.error || 'No se pudo confirmar la cancelación.');
        return;
      }

      mostrarExito('Tu turno fue cancelado correctamente.');
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();
})();
