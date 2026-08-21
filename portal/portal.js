/* =====================================================================
   CardioLink — Portal Público V1 (portal.js)
   Micrositio público del consultorio, separado del Admin. Nunca toca
   Supabase directamente: todas las escrituras/lecturas pasan por la Edge
   Function "portal-gateway" (supabase/functions/portal-gateway/), el único
   gateway autorizado.

   No muestra agenda, no reserva horarios, no elige profesional, no permite
   texto libre, no envía email/WhatsApp, no hace OCR, no cobra. Sólo:
   mostrar información pública del consultorio, verificar DNI, dar de alta
   si hace falta, y mandar una solicitud de turno para que el consultorio
   coordine manualmente.

   El contenido público (identidad, profesionales, prestaciones, modalidad,
   contacto, coberturas) vive centralizado en contenido-publico.js, que se
   carga antes que este archivo.

   La validación de acá es sólo para UX (evitar viajes de red inútiles). La
   validación real y autoritativa vive en la Edge Function
   (supabase/functions/portal-gateway/logica.js). Nunca hay que confiar en
   nada de este archivo del lado del servidor.
   ===================================================================== */
(function (root, factory) {
  'use strict';

  const api = factory();

  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && !root.CardioLinkPortal) root.CardioLinkPortal = api;
  if (root && root.document) api.install(root);
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const FUENTES_VALIDAS = ['qr', 'whatsapp', 'web'];

  // Sólo localhost/127.0.0.1/::1: mismo criterio que ya usan
  // cardiolink-finanzas-v5.js y cardiolink-solicitudes-turno.js. Fuera de un
  // origen local esto siempre da false, así que una versión publicada nunca
  // puede terminar apuntando a Staging por accidente.
  function esEntornoLocal() {
    if (!hayNavegador()) return false;
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(window.location.hostname);
  }

  // En local usa automáticamente el gateway de Staging (sin configuración
  // manual: portal.js no maneja ninguna clave/cliente Supabase propio, sólo
  // llama a esta URL con fetch()). Fuera de local usa la URL de Producción,
  // separada y configurable en tiempo de ejecución con
  // window.CARDIOLINK_PORTAL_GATEWAY_URL — reemplazar
  // GATEWAY_URL_PRODUCCION_DEFAULT por la URL real al desplegar.
  const GATEWAY_URL_STAGING_LOCAL = 'https://yslhwdlzdknhskawqrtv.supabase.co/functions/v1/portal-gateway';
  const GATEWAY_URL_PRODUCCION_DEFAULT = 'https://REEMPLAZAR-PROJECT-REF.functions.supabase.co/portal-gateway';

  function gatewayUrl() {
    if (esEntornoLocal()) return GATEWAY_URL_STAGING_LOCAL;
    return (typeof window !== 'undefined' && window.CARDIOLINK_PORTAL_GATEWAY_URL) || GATEWAY_URL_PRODUCCION_DEFAULT;
  }

  function contenidoPublico() {
    return (typeof window !== 'undefined' && window.CardioLinkContenidoPublico) || null;
  }

  function obtenerSourceDesdeUrl(search) {
    try {
      const params = new URLSearchParams(String(search || ''));
      const valor = String(params.get('source') || '').trim().toLowerCase();
      return FUENTES_VALIDAS.includes(valor) ? valor : 'web';
    } catch (_) {
      return 'web';
    }
  }

  function soloDigitos(valor) {
    return String(valor || '').replace(/\D/g, '');
  }

  // Validación liviana, sólo UX: la autoritativa vive en la Edge Function.
  function dniClienteValido(valor) {
    const dni = soloDigitos(valor);
    return dni.length >= 6 && dni.length <= 9;
  }

  function escapar(valor) {
    return String(valor ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  async function llamarGateway(accion, datos) {
    const respuesta = await fetch(gatewayUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ action: accion }, datos || {}))
    });
    let cuerpo = null;
    try { cuerpo = await respuesta.json(); } catch (_) {}
    if (!respuesta.ok || !cuerpo || cuerpo.ok !== true) {
      const mensaje = (cuerpo && cuerpo.error) || 'No se pudo completar la operación. Probá de nuevo en un momento.';
      throw new Error(mensaje);
    }
    return cuerpo;
  }

  const consultarDni = (dni) => llamarGateway('check-dni', { dni });
  const registrarPaciente = (datos) => llamarGateway('registro', datos);
  const enviarSolicitud = (datos) => llamarGateway('solicitud-turno', datos);

  const estado = {
    source: 'web',
    vista: 'landing', // 'landing' | 'flujo'
    paso: 'dni',
    dni: '',
    cargando: false,
    mensaje: '',
    tipoMensaje: ''
  };

  function hayNavegador() {
    return typeof window !== 'undefined' && typeof document !== 'undefined';
  }

  // -----------------------------------------------------------------------
  // Render raíz
  // -----------------------------------------------------------------------

  function render() {
    const raiz = document.getElementById('portalRoot');
    if (!raiz) return;
    // Aviso discreto, no invasivo: no cambia el flujo DNI/alta/solicitud,
    // sólo se agrega arriba de lo que ya se iba a mostrar.
    const badgeStaging = esEntornoLocal() ? '<div class="portal-staging-badge">STAGING LOCAL</div>' : '';
    raiz.innerHTML = badgeStaging + (estado.vista === 'flujo' ? renderFlujo() : renderLanding());
    enlazarEventos();
  }

  // -----------------------------------------------------------------------
  // Landing / micrositio
  // -----------------------------------------------------------------------

  function renderLanding() {
    const contenido = contenidoPublico();
    if (!contenido) return '<div class="portal-aviso portal-aviso-error">No se pudo cargar el contenido público.</div>';
    return `
      ${renderHero(contenido.identidad)}
      ${renderPrestacionesPublicas(contenido.prestaciones)}
      ${renderProfesionalesPublicos(contenido.profesionales)}
      ${renderModalidad(contenido.modalidad)}
      ${renderContacto(contenido.contacto)}
      ${renderCtaFinal()}
    `;
  }

  function renderHero(identidad) {
    const logo = identidad.logoUrl
      ? `<img class="portal-logo" src="${escapar(identidad.logoUrl)}" alt="${escapar(identidad.logoAlt || identidad.nombreConsultorio)}">`
      : `<div class="portal-logo portal-logo-placeholder" aria-hidden="true">${escapar((identidad.nombreConsultorio || 'C').trim().charAt(0))}</div>`;
    return `
      <section class="portal-hero">
        ${logo}
        <h1>${escapar(identidad.nombreConsultorio)}</h1>
        ${identidad.descripcionBreve ? `<p class="portal-hero-desc">${escapar(identidad.descripcionBreve)}</p>` : ''}
        <button type="button" class="portal-btn-primario" data-portal-accion="ir-solicitud">SOLICITAR TURNO</button>
      </section>
    `;
  }

  function renderPrestacionesPublicas(prestaciones) {
    if (!Array.isArray(prestaciones) || !prestaciones.length) return '';
    const tarjetas = prestaciones.map((p) => `
      <article class="portal-item-card">
        <h3>${escapar(p.nombre)}</h3>
        ${p.paraQueSirve ? `<p>${escapar(p.paraQueSirve)}</p>` : ''}
        ${p.descripcion ? `<p>${escapar(p.descripcion)}</p>` : ''}
        ${p.duracionAprox ? `<p class="portal-item-meta">Duración aproximada: ${escapar(p.duracionAprox)}</p>` : ''}
        ${p.preparacionPrevia ? `<p class="portal-item-meta">Preparación previa: ${escapar(p.preparacionPrevia)}</p>` : ''}
      </article>
    `).join('');
    return `
      <section class="portal-section">
        <h2>Prestaciones / estudios</h2>
        <div class="portal-grid-cards">${tarjetas}</div>
      </section>
    `;
  }

  function renderProfesionalesPublicos(profesionales) {
    if (!Array.isArray(profesionales) || !profesionales.length) return '';
    const tarjetas = profesionales.map((p) => {
      const avatar = p.fotoUrl
        ? `<img class="portal-profesional-foto" src="${escapar(p.fotoUrl)}" alt="${escapar(p.nombre)}">`
        : `<div class="portal-profesional-avatar" aria-hidden="true">${escapar((p.nombre || '').replace(/^Dr\.?a?\.?\s*/i, '').trim().charAt(0) || '?')}</div>`;
      const matriculas = [p.matriculaNacional, p.matriculaProvincial].filter(Boolean).join(' · ');
      return `
        <article class="portal-item-card portal-profesional-card">
          ${avatar}
          <h3>${escapar(p.nombre)}</h3>
          ${p.especialidad ? `<p class="portal-item-meta">${escapar(p.especialidad)}</p>` : ''}
          ${matriculas ? `<p class="portal-item-meta">${escapar(matriculas)}</p>` : ''}
          ${p.descripcionBreve ? `<p>${escapar(p.descripcionBreve)}</p>` : ''}
        </article>
      `;
    }).join('');
    return `
      <section class="portal-section">
        <h2>Profesionales</h2>
        <div class="portal-grid-cards">${tarjetas}</div>
      </section>
    `;
  }

  function renderModalidad(modalidad) {
    if (!Array.isArray(modalidad) || !modalidad.length) return '';
    const items = modalidad.map((texto) => `<li>${escapar(texto)}</li>`).join('');
    return `
      <section class="portal-section">
        <h2>Cómo es la atención</h2>
        <ul class="portal-modalidad-list">${items}</ul>
      </section>
    `;
  }

  function renderContacto(contacto) {
    const filas = [
      ['Dirección', contacto.direccion],
      ['Teléfono', contacto.telefono],
      ['WhatsApp', contacto.whatsapp],
      ['Instagram', contacto.instagram],
      ['Email', contacto.email]
    ].filter(([, valor]) => !!valor);
    const cuerpo = filas.length
      ? `<ul class="portal-contacto-list">${filas.map(([etiqueta, valor]) => `<li><strong>${escapar(etiqueta)}:</strong> ${escapar(valor)}</li>`).join('')}</ul>`
      : '<p class="portal-muted">Los datos de contacto se van a completar próximamente.</p>';
    return `
      <section class="portal-section">
        <h2>Contacto</h2>
        ${cuerpo}
      </section>
    `;
  }

  function renderCtaFinal() {
    return `
      <section class="portal-section portal-cta-final">
        <button type="button" class="portal-btn-primario" data-portal-accion="ir-solicitud">SOLICITAR TURNO</button>
      </section>
    `;
  }

  // -----------------------------------------------------------------------
  // Flujo de solicitud (DNI -> alta/ya-registrado -> solicitud -> enviado)
  // -----------------------------------------------------------------------

  function renderFlujo() {
    const aviso = estado.mensaje
      ? `<div class="portal-aviso portal-aviso-${escapar(estado.tipoMensaje || 'info')}" role="status">${escapar(estado.mensaje)}</div>`
      : '';
    return `
      <button type="button" class="portal-volver" data-portal-accion="volver-inicio">‹ Volver al inicio</button>
      ${aviso}
      <main class="portal-card">${renderPaso()}</main>
      ${estado.cargando ? '<div class="portal-cargando" aria-live="polite">Un momento…</div>' : ''}
    `;
  }

  function renderPaso() {
    if (estado.paso === 'dni') return renderPasoDni();
    if (estado.paso === 'ya-registrado') return renderPasoYaRegistrado();
    if (estado.paso === 'alta') return renderPasoAlta();
    if (estado.paso === 'alta-exitosa') return renderPasoAltaExitosa();
    if (estado.paso === 'solicitud') return renderPasoSolicitud();
    if (estado.paso === 'enviado') return renderPasoEnviado();
    return renderPasoDni();
  }

  function renderPasoDni() {
    return `
      <h2>Ingresá tu DNI</h2>
      <p class="portal-muted">Para empezar, necesitamos verificar si ya estás registrado.</p>
      <form id="portalFormDni" novalidate>
        <label>DNI<input name="dni" inputmode="numeric" autocomplete="off" maxlength="9" required></label>
        <button type="submit" class="portal-btn-primario">CONTINUAR</button>
      </form>
    `;
  }

  function renderPasoYaRegistrado() {
    return `
      <h2>Ya estás registrado en CardioLink.</h2>
      <p class="portal-muted">Podés solicitar un turno y el consultorio se va a comunicar con vos para coordinarlo.</p>
      <button type="button" class="portal-btn-primario" data-portal-accion="ir-solicitud">SOLICITAR TURNO</button>
    `;
  }

  // Alta recién confirmada: paso propio, distinto de "ya-registrado" (que es
  // para DNI preexistente). El QR/link también sirve para incorporar
  // pacientes al padrón sin que quieran pedir turno en el momento: por eso
  // FINALIZAR es una salida tan válida como SOLICITAR TURNO acá.
  function renderPasoAltaExitosa() {
    return `
      <h2>Tu registro fue realizado correctamente.</h2>
      <p class="portal-muted">Ya quedaste registrado en CardioLink. Podés solicitar un turno ahora o hacerlo más adelante.</p>
      <div class="portal-acciones-finales">
        <button type="button" class="portal-btn-primario" data-portal-accion="ir-solicitud">SOLICITAR TURNO</button>
        <button type="button" class="portal-btn-secundario" data-portal-accion="finalizar">FINALIZAR</button>
      </div>
    `;
  }

  function renderPasoAlta() {
    const coberturas = (contenidoPublico() && contenidoPublico().coberturas) || [];
    const opcionesCobertura = coberturas.map((c) => `<option value="${escapar(c)}"${c === 'Particular' ? ' selected' : ''}>${escapar(c)}</option>`).join('');
    return `
      <h2>Completá tus datos</h2>
      <p class="portal-muted">No encontramos tu DNI. Dejanos tus datos para darte de alta. El teléfono se pide una sola vez, acá.</p>
      <form id="portalFormAlta" novalidate>
        <label>Nombre<input name="nombre" maxlength="80" required></label>
        <label>Apellido<input name="apellido" maxlength="80" required></label>
        <label>DNI<input name="dni" inputmode="numeric" maxlength="9" value="${escapar(estado.dni)}" required></label>
        <label>Fecha de nacimiento<input name="fechaNacimiento" type="date" required></label>
        <label>Teléfono<input name="telefono" type="tel" maxlength="30" required></label>
        <label>Email (opcional)<input name="email" type="email" maxlength="200"></label>
        <label>Obra social / prepaga<select name="coberturaHabitual" required>${opcionesCobertura}</select></label>
        <label>N° de afiliado (opcional)<input name="numeroAfiliado" maxlength="60"></label>
        <button type="submit" class="portal-btn-primario">DARME DE ALTA</button>
      </form>
    `;
  }

  function renderPasoSolicitud() {
    const contenido = contenidoPublico();
    const prestaciones = (contenido && contenido.prestaciones) || [];
    const coberturas = (contenido && contenido.coberturas) || [];
    const opcionesPrestacion = ['<option value="">Elegí una opción</option>']
      .concat(prestaciones.map((p) => `<option value="${escapar(p.nombre)}">${escapar(p.nombre)}</option>`))
      .join('');
    // Cobertura de ESTA solicitud, no la habitual del paciente: se pide en
    // cada solicitud (nueva o existente) y nunca sobrescribe
    // cardiolink_pacientes.cobertura_habitual.
    const opcionesCobertura = coberturas.map((c) => `<option value="${escapar(c)}"${c === 'Particular' ? ' selected' : ''}>${escapar(c)}</option>`).join('');
    return `
      <h2>Solicitar turno</h2>
      <p class="portal-muted">Elegí la prestación y la cobertura para esta solicitud. No se reserva horario todavía: el consultorio te va a contactar al teléfono que ya nos dejaste para coordinarlo.</p>
      <form id="portalFormSolicitud" novalidate>
        <label>Prestación<select name="prestacion" required>${opcionesPrestacion}</select></label>
        <label>Cobertura para esta solicitud<select name="cobertura" required>${opcionesCobertura}</select></label>
        <button type="submit" class="portal-btn-primario">ENVIAR SOLICITUD</button>
      </form>
    `;
  }

  function renderPasoEnviado() {
    return `
      <h2>Tu solicitud fue recibida.</h2>
      <p class="portal-muted">El consultorio se comunicará con vos para coordinar el turno.</p>
    `;
  }

  // -----------------------------------------------------------------------
  // Eventos
  // -----------------------------------------------------------------------

  function enlazarEventos() {
    const formDni = document.getElementById('portalFormDni');
    if (formDni) formDni.addEventListener('submit', onSubmitDni);

    const formAlta = document.getElementById('portalFormAlta');
    if (formAlta) formAlta.addEventListener('submit', onSubmitAlta);

    const formSolicitud = document.getElementById('portalFormSolicitud');
    if (formSolicitud) formSolicitud.addEventListener('submit', onSubmitSolicitud);

    document.querySelectorAll('[data-portal-accion="ir-solicitud"]').forEach((boton) => {
      boton.addEventListener('click', irASolicitud);
    });

    // FINALIZAR es una salida tan válida como "Volver al inicio": el
    // registro ya quedó guardado, no hace falta pedir turno para terminar.
    document.querySelectorAll('[data-portal-accion="volver-inicio"], [data-portal-accion="finalizar"]').forEach((boton) => {
      boton.addEventListener('click', volverAlInicio);
    });
  }

  function volverAlInicio() {
    estado.vista = 'landing';
    estado.paso = 'dni';
    estado.mensaje = '';
    render();
  }

  async function onSubmitDni(evento) {
    evento.preventDefault();
    const dni = new FormData(evento.target).get('dni');
    if (!dniClienteValido(dni)) {
      estado.mensaje = 'Ingresá un DNI válido.';
      estado.tipoMensaje = 'error';
      render();
      return;
    }
    estado.dni = soloDigitos(dni);
    estado.cargando = true;
    estado.mensaje = '';
    render();
    try {
      const resultado = await consultarDni(estado.dni);
      estado.paso = resultado.existe ? 'ya-registrado' : 'alta';
      estado.mensaje = '';
    } catch (error) {
      estado.mensaje = error.message;
      estado.tipoMensaje = 'error';
    } finally {
      estado.cargando = false;
      render();
    }
  }

  async function onSubmitAlta(evento) {
    evento.preventDefault();
    const datosForm = new FormData(evento.target);
    const datos = {
      nombre: datosForm.get('nombre'),
      apellido: datosForm.get('apellido'),
      dni: datosForm.get('dni'),
      fechaNacimiento: datosForm.get('fechaNacimiento'),
      telefono: datosForm.get('telefono'),
      email: datosForm.get('email'),
      coberturaHabitual: datosForm.get('coberturaHabitual'),
      numeroAfiliado: datosForm.get('numeroAfiliado'),
      source: estado.source
    };
    estado.cargando = true;
    estado.mensaje = '';
    render();
    try {
      await registrarPaciente(datos);
      estado.dni = soloDigitos(datos.dni);
      // Paso propio (no "ya-registrado"): mensaje y botones distintos
      // ("Tu registro fue realizado correctamente." + SOLICITAR TURNO /
      // FINALIZAR). El alta ya quedó guardada en cardiolink_pacientes; no
      // hace falta pedir turno para que el registro sea válido.
      estado.paso = 'alta-exitosa';
      estado.mensaje = '';
    } catch (error) {
      estado.mensaje = error.message;
      estado.tipoMensaje = 'error';
    } finally {
      estado.cargando = false;
      render();
    }
  }

  // "Solicitar turno" tiene dos orígenes: desde la landing (no sabemos el
  // DNI todavía, hay que arrancar por ahí) o desde una pantalla donde el DNI
  // ya quedó confirmado en este mismo flujo — "ya-registrado" (paciente
  // preexistente) o "alta-exitosa" (recién registrado) — donde se salta
  // directo a elegir prestación/cobertura, sin volver a pedir nombre,
  // nacimiento, teléfono ni email.
  function irASolicitud() {
    const dniYaConfirmado = estado.vista === 'flujo' && ['ya-registrado', 'alta-exitosa'].includes(estado.paso);
    estado.vista = 'flujo';
    estado.paso = dniYaConfirmado ? 'solicitud' : 'dni';
    estado.mensaje = '';
    render();
  }

  async function onSubmitSolicitud(evento) {
    evento.preventDefault();
    const datosForm = new FormData(evento.target);
    const datos = {
      dni: estado.dni,
      prestacion: datosForm.get('prestacion'),
      cobertura: datosForm.get('cobertura'),
      source: estado.source
    };
    estado.cargando = true;
    estado.mensaje = '';
    render();
    try {
      await enviarSolicitud(datos);
      estado.paso = 'enviado';
    } catch (error) {
      estado.mensaje = error.message;
      estado.tipoMensaje = 'error';
    } finally {
      estado.cargando = false;
      render();
    }
  }

  function iniciar() {
    if (!hayNavegador()) return;
    estado.source = obtenerSourceDesdeUrl(window.location.search);
    render();
  }

  function install(rootWindow) {
    if (!rootWindow || !rootWindow.document) return;
    if (rootWindow.document.readyState === 'loading') {
      rootWindow.document.addEventListener('DOMContentLoaded', iniciar, { once: true });
    } else {
      iniciar();
    }
  }

  return Object.freeze({
    version: '2.2.0-portal-publico-v1-staging-local',
    obtenerSourceDesdeUrl,
    dniClienteValido,
    soloDigitos,
    esEntornoLocal,
    gatewayUrl,
    install
  });
});
