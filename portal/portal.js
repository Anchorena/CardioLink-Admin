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

  // =========================================================================
  // Configuración de entorno — CENTRALIZADA ACÁ, un único lugar: gateway y
  // sitekey de Turnstile se deciden los dos con el mismo criterio
  // (esEntornoLocal), nunca por separado. No hay ninguna otra parte del
  // código que decida "¿local o producción?" por su cuenta.
  //
  // localhost/127.0.0.1/::1  → Staging (gateway de Staging + sitekey de
  //                            test invisible de Cloudflare).
  // cualquier otro origen    → Producción (gateway real + sitekey real),
  // (ej. anchorena.github.io)  incluida cualquier copia publicada de este
  //                            portal que no sea local: nunca cae en
  //                            Staging por accidente, porque no depende de
  //                            reconocer "anchorena.github.io" en una
  //                            lista — cualquier hostname que no sea local
  //                            ya usa Producción por default.
  // =========================================================================

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
  // llama a esta URL con fetch()). Fuera de local usa el gateway productivo
  // real, configurable en tiempo de ejecución con
  // window.CARDIOLINK_PORTAL_GATEWAY_URL si hiciera falta apuntar a otro.
  const GATEWAY_URL_STAGING_LOCAL = 'https://yslhwdlzdknhskawqrtv.supabase.co/functions/v1/portal-gateway';
  const GATEWAY_URL_PRODUCCION_DEFAULT = 'https://tupacclmhaqiahhlttyz.supabase.co/functions/v1/portal-gateway';

  function gatewayUrl() {
    if (esEntornoLocal()) return GATEWAY_URL_STAGING_LOCAL;
    return (typeof window !== 'undefined' && window.CARDIOLINK_PORTAL_GATEWAY_URL) || GATEWAY_URL_PRODUCCION_DEFAULT;
  }

  // Turnstile (anti-bots): la sitekey es pública por diseño (viaja al
  // navegador para poder mostrar el widget) — no es un secreto. La clave
  // SECRETA de verificación (TURNSTILE_SECRET_KEY) vive únicamente
  // server-side, en la Edge Function, ya configurada en Producción — nunca
  // se referencia ni existe en este archivo ni en ningún otro del frontend.
  //
  // En local siempre usa la sitekey de test pública que Cloudflare documenta
  // para el widget INVISIBLE (no es secreta ni exclusiva de este proyecto:
  // https://developers.cloudflare.com/turnstile/troubleshooting/testing/).
  // OJO: 1x00000000000000000000AA es la de test del widget VISIBLE (con
  // casilla) — acá el widget es invisible (size: 'invisible'), así que hay
  // que usar la sitekey de test invisible, distinta:
  // 1x00000000000000000000BB ("always passes", invisible). El secret de
  // test emparejado sigue siendo el mismo para las dos
  // (1x0000000000000000000000000000000AA, server-side en index.ts).
  // No hay que reemplazar esta sitekey por una clave real para probar en
  // localhost.
  const TURNSTILE_SITEKEY_QA_LOCAL = '1x00000000000000000000BB';
  const TURNSTILE_SITEKEY_PRODUCCION_DEFAULT = '0x4AAAAAAEYiWSCxfjAQOp3P';

  function turnstileSitekey() {
    if (esEntornoLocal()) return TURNSTILE_SITEKEY_QA_LOCAL;
    return (typeof window !== 'undefined' && window.CARDIOLINK_TURNSTILE_SITEKEY) || TURNSTILE_SITEKEY_PRODUCCION_DEFAULT;
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

  const consultarDni = (dni, turnstileToken) => llamarGateway('check-dni', { dni, turnstileToken });
  const registrarPaciente = (datos) => llamarGateway('registro', datos);
  const enviarSolicitud = (datos) => llamarGateway('solicitud-turno', datos);

  // -----------------------------------------------------------------------
  // Turnstile: un token por envío, para check-dni, registro y
  // solicitud-turno (los tres únicos llamados al gateway). Widget
  // "invisible" (sin casilla ni UI visible): no cambia la experiencia
  // visual del formulario. Esto sólo obtiene el token en el navegador; la
  // verificación real y obligatoria vive en la Edge Function.
  // -----------------------------------------------------------------------

  let turnstileWidget = { widgetId: null, containerId: null };
  // true mientras hay un reintento de montaje ya programado (setTimeout
  // pendiente) — evita arrancar varias cadenas de reintento en paralelo si
  // montarTurnstileSiCorresponde() se llama de nuevo (otro render()) antes
  // de que el primer reintento dispare.
  let turnstileEsperandoScript = false;

  function turnstileDisponible() {
    return hayNavegador() && typeof window.turnstile === 'object' && typeof window.turnstile.render === 'function';
  }

  // Se llama después de cada render(): si el paso actual tiene un
  // contenedor de Turnstile, lo monta (el nodo es siempre nuevo porque
  // render() reemplaza todo el HTML, así que no hay widget previo que
  // reutilizar sobre ese mismo nodo).
  //
  // El script de Cloudflare se carga con `async` (index.html/privacidad no
  // lo bloquean a propósito, para no frenar el resto de la página) — puede
  // no estar listo todavía la primera vez que se llama acá. Antes esto no
  // importaba: el primer contenedor de Turnstile recién aparecía cuando el
  // usuario hacía click en "SOLICITAR TURNO" en el hero, segundos después
  // de cargar la página, tiempo de sobra para que el script ya hubiera
  // cargado. Ahora el hero embebe el formulario de DNI (con su contenedor
  // de Turnstile) directamente en el primer render() de la página, así que
  // ese primer intento de montaje puede competir de verdad contra la carga
  // async del script — y perder, sobre todo con latencia de red real (no
  // en un entorno local con todo cacheado). Si eso pasa y no se reintenta,
  // turnstileWidget.widgetId queda en null para siempre y cualquier envío
  // falla de entrada con "No se pudo cargar la verificación anti-bots.",
  // aunque Turnstile termine cargando un instante después — por eso el
  // reintento con backoff fijo de acá, en vez de un intento único.
  function montarTurnstileSiCorresponde() {
    const contenedor = document.querySelector('[data-turnstile-container]');
    if (!contenedor) { turnstileWidget = { widgetId: null, containerId: null }; return; }
    if (!turnstileDisponible()) {
      turnstileWidget = { widgetId: null, containerId: null };
      if (!turnstileEsperandoScript) {
        turnstileEsperandoScript = true;
        reintentarMontajeTurnstile(0);
      }
      return;
    }
    try {
      const widgetId = window.turnstile.render(contenedor, {
        sitekey: turnstileSitekey(),
        size: 'invisible',
        execution: 'execute'
      });
      turnstileWidget = { widgetId, containerId: contenedor.id };
    } catch (_) {
      turnstileWidget = { widgetId: null, containerId: null };
    }
  }

  // 40 intentos × 250ms = 10s de margen, de sobra para cualquier latencia
  // real de carga del script — sin quedar reintentando para siempre.
  function reintentarMontajeTurnstile(intentos) {
    window.setTimeout(() => {
      turnstileEsperandoScript = false;
      // Si mientras tanto otro render() ya montó un widget con éxito (o ya
      // no queda ningún contenedor de Turnstile en la página), no hay nada
      // que hacer acá: nunca pisa un montaje que ya funcionó.
      if (turnstileWidget.widgetId !== null) return;
      if (!document.querySelector('[data-turnstile-container]')) return;
      if (turnstileDisponible()) {
        montarTurnstileSiCorresponde();
      } else if (intentos < 40) {
        turnstileEsperandoScript = true;
        reintentarMontajeTurnstile(intentos + 1);
      }
    }, 250);
  }

  // Ejecuta el desafío del widget ya montado y devuelve un token nuevo. Se
  // llama recién al enviar el formulario (no al montar), con un timeout
  // propio por si el challenge nunca resuelve (red caída, script
  // bloqueado, etc.). Un mismo widget nunca entrega el mismo token dos
  // veces: además de que cada render() posterior remonta un widget nuevo
  // desde cero, acá se llama a turnstile.reset() apenas se resuelve (haya
  // token o error), así que aunque este mismo widget se reutilizara sin
  // pasar por otro render(), el próximo turnstile.execute() igual va a
  // generar un token distinto.
  function obtenerTokenTurnstile() {
    return new Promise((resolve, reject) => {
      if (!turnstileDisponible() || turnstileWidget.widgetId === null) {
        reject(new Error('No se pudo cargar la verificación anti-bots. Recargá la página e intentá de nuevo.'));
        return;
      }
      const widgetId = turnstileWidget.widgetId;
      let resuelto = false;
      const finalizar = (fn, valor) => {
        if (resuelto) return;
        resuelto = true;
        try { window.turnstile.reset(widgetId); } catch (_) {}
        fn(valor);
      };
      window.setTimeout(() => finalizar(reject, new Error('La verificación anti-bots tardó demasiado. Probá de nuevo.')), 15000);
      try {
        window.turnstile.execute(widgetId, {
          callback: (token) => finalizar(resolve, token),
          'error-callback': () => finalizar(reject, new Error('No se pudo verificar que sos una persona. Probá de nuevo.'))
        });
      } catch (_) {
        finalizar(reject, new Error('No se pudo verificar que sos una persona. Probá de nuevo.'));
      }
    });
  }

  const estado = {
    source: 'web',
    vista: 'landing', // 'landing' | 'flujo'
    paso: 'dni',
    dni: '',
    cargando: false,
    mensaje: '',
    tipoMensaje: '',
    // 'solicitud': flujo normal de turno (hero, o tarjeta 'con_turno'/
    // 'mixta'), termina en 'ya-registrado'/'alta-exitosa' → 'solicitud'.
    // 'modalidad': flujo disparado por "Ver días y horarios" en una
    // tarjeta 'orden_llegada'/'mixta' — nunca ofrece solicitar turno,
    // termina mostrando la modalidad configurada de ese profesional.
    modoFlujo: 'solicitud',
    // Índice del profesional en contenido.profesionales, sólo relevante
    // cuando modoFlujo === 'modalidad' (fijado por irAVerModalidad).
    profesionalIndice: -1
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
      <div class="portal-top">
        <div class="portal-top-inner">
          ${renderHeader(contenido.identidad)}
          ${renderHero(contenido.identidad)}
        </div>
      </div>
      ${renderPrestacionesPublicas(contenido.prestaciones)}
      ${renderProfesionalesPublicos(contenido.profesionales)}
      ${renderEspecialidadesComplementarias(contenido.especialidadesComplementarias)}
      ${renderEquipamiento(contenido.equipamiento)}
      ${renderModalidad(contenido.modalidad)}
      ${renderEstudiosPaciente(contenido.estudiosPaciente)}
      ${renderContacto(contenido.contacto)}
      ${renderCtaFinal()}
      ${renderFooter(contenido.identidad)}
    `;
  }

  // El logo es 100% configurable desde contenido-publico.js: nunca queda
  // fijo en el layout, completar la ruta correspondiente alcanza para
  // reemplazarlo en toda la página (ver portal/assets/README.md). El header
  // y el hero tienen fondo oscuro, así que priorizan la versión pensada
  // para eso (logoOscuro); si no está, caen al logo horizontal general
  // (logoPrincipal); si tampoco, al isologo (hoy el único cargado, y un
  // fallback provisional — nunca se recrea un logo con SVG/CSS más allá de
  // ese fallback ya existente).
  function logoHeroSeleccionado(identidad) {
    if (identidad.logoOscuro) return { src: identidad.logoOscuro, esFallback: false };
    if (identidad.logoPrincipal) return { src: identidad.logoPrincipal, esFallback: false };
    if (identidad.isologo) return { src: identidad.isologo, esFallback: true };
    return null;
  }

  // Header: logo chico + nombre (link a #inicio), nav a las secciones ya
  // existentes (anclas simples, no cambian estado ni flujo) y un CTA que
  // baja a la card de DNI del hero — no dispara ninguna acción de JS.
  function renderHeader(identidad) {
    const seleccionado = logoHeroSeleccionado(identidad);
    const claseLogo = 'portal-header-logo' + (seleccionado && seleccionado.esFallback ? ' portal-logo-fallback' : '');
    const logo = seleccionado
      ? `<img class="${claseLogo}" src="${escapar(seleccionado.src)}" alt="${escapar(identidad.logoAlt || identidad.nombreConsultorio)}">`
      : `<span class="portal-header-logo portal-header-logo-placeholder" aria-hidden="true">${escapar((identidad.nombreConsultorio || 'C').trim().charAt(0))}</span>`;
    return `
      <header class="portal-header">
        <a class="portal-header-marca" href="#inicio">
          ${logo}
          <span class="portal-header-nombre">${escapar(identidad.nombreConsultorio)}</span>
        </a>
        <nav class="portal-header-nav" aria-label="Navegación principal">
          <a href="#inicio">Inicio</a>
          <a href="#prestaciones">Estudios</a>
          <a href="#profesionales">Profesionales</a>
          <a href="#contacto">Información</a>
        </nav>
        <a class="portal-header-cta" href="#hero-turno">Solicitar turno</a>
      </header>
    `;
  }

  // Íconos decorativos chicos (línea, currentColor) para los beneficios del
  // hero — NO son logos de marca, sólo UI genérica; no reemplazan ni
  // recrean ningún logo real.
  function iconoBeneficio(tipo) {
    const trazos = {
      turno: '<rect x="4" y="6" width="16" height="14" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/>',
      cardio: '<path d="M12 20s-6.7-4.1-9-8.6A4.8 4.8 0 0 1 12 6a4.8 4.8 0 0 1 9 5.4C18.7 15.9 12 20 12 20Z"/><path d="M3.5 11.5h4l1.8-3 2.2 5 1.8-3.5 1 1.5H20.5"/>',
      online: '<circle cx="12" cy="12" r="9"/><path d="M8.5 12.3l2.3 2.3 4.7-4.7"/>'
    };
    return `<svg class="portal-hero-beneficio-icono" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${trazos[tipo] || ''}</svg>`;
  }

  // El formulario en sí (mismo id/inputs/Turnstile que siempre tuvo el paso
  // "dni" del flujo): se usa embebido en el hero de la landing Y dentro de
  // renderPasoDni() para las re-entradas (modalidad, volver a intentar).
  // Nunca se duplica en el DOM al mismo tiempo: landing y flujo son vistas
  // mutuamente excluyentes (estado.vista). value precarga estado.dni para
  // no perder lo ya tipeado si el formulario se vuelve a mostrar por un
  // error de validación.
  function renderFormularioDni() {
    return `
      <form id="portalFormDni" novalidate>
        <label>DNI<input name="dni" inputmode="numeric" autocomplete="off" maxlength="9" value="${escapar(estado.dni)}" required placeholder="Ej: 20304050"></label>
        <div id="turnstileDni" data-turnstile-container></div>
        <button type="submit" class="portal-btn-primario">CONTINUAR</button>
      </form>
    `;
  }

  // Hero: dos columnas en desktop (mensaje institucional a la izquierda,
  // card de DNI a la derecha), una sola columna apilada en mobile (mensaje
  // primero, card después — mismo orden que en el DOM, sin necesitar CSS
  // de reordenamiento). Los turnos públicos son sólo para Matías hoy: este
  // formulario sigue siendo el mismo genérico de siempre (sin selector de
  // profesional), a propósito.
  function renderHero(identidad) {
    return `
      <section class="portal-hero" id="inicio">
        <div class="portal-hero-grid">
          <div class="portal-hero-mensaje">
            <h1>${escapar(identidad.nombreConsultorio)}</h1>
            ${identidad.descripcionBreve ? `<p class="portal-hero-desc">${escapar(identidad.descripcionBreve)}</p>` : ''}
            <ul class="portal-hero-beneficios">
              <li>
                ${iconoBeneficio('turno')}
                <div><strong>Modalidad flexible</strong><span>Turno programado o atención por orden de llegada, según el profesional.</span></div>
              </li>
              <li>
                ${iconoBeneficio('cardio')}
                <div><strong>Cardiología integral</strong><span>Estudios cardiológicos, clínica médica y diagnóstico por imágenes.</span></div>
              </li>
              <li>
                ${iconoBeneficio('online')}
                <div><strong>Solicitud online</strong><span>Identificate con tu DNI y coordiná desde acá, sin llamadas.</span></div>
              </li>
            </ul>
            <div class="portal-hero-como-funciona">
              <strong>¿Cómo funciona?</strong>
              <p>Ingresá tu DNI. Si es tu primera vez, te damos de alta en el momento. Según el profesional, vas a poder solicitar turno o ver directamente los días y horarios de atención.</p>
            </div>
          </div>
          <div class="portal-hero-card" id="hero-turno">
            <h2>Solicitá tu turno</h2>
            <p class="portal-muted">Ingresá tu DNI para comenzar.</p>
            ${renderFormularioDni()}
            <p class="portal-hero-card-nota">¿Todavía no estás registrado? Te damos de alta en el mismo paso, con este mismo DNI.</p>
          </div>
        </div>
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
      <section class="portal-section" id="prestaciones">
        <h2>Prestaciones / estudios</h2>
        <div class="portal-grid-cards">${tarjetas}</div>
      </section>
    `;
  }

  // Data-driven a propósito, sin ningún if/switch por nombre de
  // profesional: todo el comportamiento (badge + si ofrece o no
  // "Solicitar turno"/"Ver días y horarios") sale únicamente de
  // p.modalidadAtencion (+ si diasAtencion/horarios ya están cargados). El
  // día que un profesional pase de 'orden_llegada' a 'con_turno' (o
  // viceversa) en contenido-publico.js, la tarjeta y el flujo se adaptan
  // solos, sin tocar este archivo.
  function etiquetaModalidad(p) {
    // Sin día+horario confirmados todavía no tiene sentido ofrecer el CTA
    // (llevaría a un paso sin información real): la tarjeta muestra
    // "Horarios próximamente" en su lugar (ver renderProfesionalesPublicos).
    const tieneHorarioConfirmado = Boolean(p.diasAtencion && p.horarios);
    if (p.modalidadAtencion === 'con_turno') {
      return { badge: 'Turnos programados', claseBadge: 'portal-badge-modalidad-turno', cta: null, pendiente: false };
    }
    if (p.modalidadAtencion === 'mixta') {
      return {
        badge: 'Turnos programados y por orden de llegada',
        claseBadge: 'portal-badge-modalidad-mixta',
        cta: tieneHorarioConfirmado ? 'Ver días y horarios' : null,
        pendiente: !tieneHorarioConfirmado
      };
    }
    if (p.modalidadAtencion === 'orden_llegada') {
      return {
        badge: 'Atención por orden de llegada',
        claseBadge: 'portal-badge-modalidad-llegada',
        cta: tieneHorarioConfirmado ? 'Ver días y horarios' : null,
        pendiente: !tieneHorarioConfirmado
      };
    }
    return null;
  }

  // Genérico para cualquier profesional (no hay ningún if por nombre):
  // 1) fotoUrl → foto circular, tamaño avatar (la vamos a tener para caras).
  // 2) si no hay foto pero sí logoUrl → el logo COMPLETO, sin recortar ni
  //    deformar, en una caja rectangular con fondo propio
  //    (object-fit: contain) — un logo con texto (nombre/especialidad/
  //    matrícula) se vuelve ilegible si se lo fuerza a un círculo chico
  //    pensado para una cara.
  // 3) si no hay ninguno de los dos → iniciales, igual que siempre.
  function renderAvatarProfesional(p) {
    if (p.fotoUrl) {
      return `<img class="portal-profesional-foto" src="${escapar(p.fotoUrl)}" alt="${escapar(p.nombre)}">`;
    }
    if (p.logoUrl) {
      return `<div class="portal-profesional-logo-box"><img class="portal-profesional-logo-img" src="${escapar(p.logoUrl)}" alt="${escapar(p.nombre)}"></div>`;
    }
    return `<div class="portal-profesional-avatar" aria-hidden="true">${escapar((p.nombre || '').replace(/^Dr\.?a?\.?\s*/i, '').trim().charAt(0) || '?')}</div>`;
  }

  function renderProfesionalesPublicos(profesionales) {
    if (!Array.isArray(profesionales) || !profesionales.length) return '';
    // visibleEnPortal (default true si no está seteado) permite ocultar a
    // futuro un profesional puntual desde la configuración, sin borrar sus
    // datos ni tocar este archivo. Se guarda el índice ORIGINAL de
    // contenido.profesionales (no el de este array ya filtrado): es el que
    // usa data-profesional-index para que irAVerModalidad encuentre al
    // profesional correcto.
    const visibles = profesionales
      .map((p, indice) => ({ p, indice }))
      .filter(({ p }) => p.visibleEnPortal !== false);
    if (!visibles.length) return '';
    const tarjetas = visibles.map(({ p, indice }) => {
      // Prioridad foto → logo propio → iniciales (nunca una foto/logo
      // inventado; ver portal/assets/README.md y renderAvatarProfesional()).
      const avatar = renderAvatarProfesional(p);
      const matriculas = [p.matriculaNacional, p.matriculaProvincial].filter(Boolean).join(' · ');
      const horario = [p.diasAtencion, p.horarios].filter(Boolean).join(' · ');
      const tienePrestaciones = Array.isArray(p.prestaciones) && p.prestaciones.length;
      const prestaciones = tienePrestaciones
        ? `<p class="portal-profesional-prestaciones">${p.prestaciones.map((nombre) => `<span class="portal-chip">${escapar(nombre)}</span>`).join('')}</p>`
        : '';
      const modalidad = etiquetaModalidad(p);
      const modalidadBadge = modalidad
        ? `<span class="portal-badge-modalidad ${modalidad.claseBadge}">${escapar(modalidad.badge)}</span>`
        : '';
      // Sólo 'orden_llegada'/'mixta' ofrecen este botón, y sólo si ya
      // tienen día+horario confirmados. 'con_turno' no repite un segundo
      // "Solicitar turno" acá (el del hero ya alcanza); su modalidad queda
      // igual de clara con el badge solo. Si la modalidad está confirmada
      // pero todavía no el horario (como Rutter hoy), un aviso en vez de
      // un botón que llevaría a un paso sin información real.
      const modalidadCta = modalidad && modalidad.cta
        ? `<button type="button" class="portal-btn-secundario portal-profesional-cta" data-portal-accion="ver-modalidad" data-profesional-index="${indice}">${escapar(modalidad.cta)}</button>`
        : (modalidad && modalidad.pendiente ? '<p class="portal-muted portal-profesional-pendiente">Horarios próximamente.</p>' : '');
      // Si no hay ningún dato confirmado más allá del nombre (ni siquiera
      // la modalidad), un aviso discreto en vez de una tarjeta casi vacía o
      // campos inventados.
      const sinDatosConfirmados = !p.especialidad && !matriculas && !p.descripcionBreve && !horario && !tienePrestaciones && !modalidad;
      return `
        <article class="portal-item-card portal-profesional-card">
          ${avatar}
          <h3>${escapar(p.nombre)}</h3>
          ${modalidadBadge}
          ${p.especialidad ? `<p class="portal-item-meta">${escapar(p.especialidad)}</p>` : ''}
          ${matriculas ? `<p class="portal-item-meta">${escapar(matriculas)}</p>` : ''}
          ${p.descripcionBreve ? `<p>${escapar(p.descripcionBreve)}</p>` : ''}
          ${horario ? `<p class="portal-item-meta">${escapar(horario)}</p>` : ''}
          ${prestaciones}
          ${modalidadCta}
          ${sinDatosConfirmados ? '<p class="portal-muted portal-profesional-pendiente">Más información, próximamente.</p>' : ''}
        </article>
      `;
    }).join('');
    return `
      <section class="portal-section" id="profesionales">
        <h2>Profesionales</h2>
        <div class="portal-grid-cards">${tarjetas}</div>
      </section>
    `;
  }

  function renderEspecialidadesComplementarias(especialidades) {
    if (!especialidades || !Array.isArray(especialidades.items) || !especialidades.items.length) return '';
    const tarjetas = especialidades.items.map((e) => `
      <article class="portal-item-card">
        <h3>${escapar(e.nombre)}</h3>
        ${e.detalle ? `<p>${escapar(e.detalle)}</p>` : ''}
        ${Array.isArray(e.prestaciones) && e.prestaciones.length ? `<p class="portal-profesional-prestaciones">${e.prestaciones.map((nombre) => `<span class="portal-chip">${escapar(nombre)}</span>`).join('')}</p>` : ''}
      </article>
    `).join('');
    return `
      <section class="portal-section">
        <h2>Especialidades complementarias</h2>
        ${especialidades.descripcion ? `<p class="portal-muted">${escapar(especialidades.descripcion)}</p>` : ''}
        <div class="portal-grid-cards">${tarjetas}</div>
      </section>
    `;
  }

  // Chips en vez de una lista vertical: mismo dato, ocupa menos alto y no
  // suma otro bloque apilado más a la página.
  function renderEquipamiento(equipamiento) {
    if (!equipamiento || !Array.isArray(equipamiento.items) || !equipamiento.items.length) return '';
    const chips = equipamiento.items.map((e) => {
      const tituloAttr = e.detalle ? ` title="${escapar(e.detalle)}"` : '';
      return `<span class="portal-chip"${tituloAttr}>${escapar(e.estudio)}</span>`;
    }).join('');
    return `
      <section class="portal-section">
        <h2>Equipos disponibles</h2>
        ${equipamiento.descripcion ? `<p class="portal-muted">${escapar(equipamiento.descripcion)}</p>` : ''}
        <div class="portal-equipo-chips">${chips}</div>
      </section>
    `;
  }

  // Sin funcionalidad todavía: sólo un aviso "Próximamente", preparado para
  // no tener que rehacer el diseño cuando se implemente descarga real
  // (que va a necesitar autenticación del paciente, fuera de esta etapa).
  function renderEstudiosPaciente(estudios) {
    if (!estudios) return '';
    return `
      <section class="portal-section portal-estudios-paciente">
        <h2>${escapar(estudios.titulo || 'Mis estudios')}</h2>
        <p class="portal-muted">${escapar(estudios.descripcion || '')}</p>
        <span class="portal-chip portal-chip-proximamente">Próximamente</span>
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
      <section class="portal-section" id="contacto">
        <h2>Contacto</h2>
        ${cuerpo}
      </section>
    `;
  }

  // Un solo CTA fuerte de "SOLICITAR TURNO" en toda la landing (el del
  // hero, arriba). Acá, en vez de repetirlo, un link útil que vuelve a
  // subir a la sección de prestaciones (ancla simple, sin tocar el estado
  // del flujo).
  function renderCtaFinal() {
    return `
      <section class="portal-section portal-cta-final">
        <a href="#prestaciones" class="portal-btn-secundario">Conocé nuestras prestaciones</a>
      </section>
    `;
  }

  // Link discreto al anexo de privacidad de Turnstile (widget invisible:
  // Cloudflare pide que quede accesible). Página estática aparte
  // (privacidad.html), no un paso más del flujo: no toca el estado ni la
  // experiencia de DNI/alta/solicitud. nombreConsultorio es el único dato
  // que suma acá (ya real/aprobado): nada de teléfono/dirección/redes
  // ficticias del mockup.
  function renderFooter(identidad) {
    return `
      <footer class="portal-footer">
        <p class="portal-footer-nombre">${escapar((identidad && identidad.nombreConsultorio) || '')}</p>
        <a href="privacidad.html">Privacidad</a>
      </footer>
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
    if (estado.paso === 'modalidad-nueva') return renderPasoModalidad('nueva');
    if (estado.paso === 'modalidad-existente') return renderPasoModalidad('existente');
    if (estado.paso === 'solicitud') return renderPasoSolicitud();
    if (estado.paso === 'enviado') return renderPasoEnviado();
    return renderPasoDni();
  }

  function renderPasoDni() {
    return `
      <h2>Ingresá tu DNI</h2>
      <p class="portal-muted">Para empezar, necesitamos verificar si ya estás registrado.</p>
      ${renderFormularioDni()}
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

  function capitalizarPrimeraLetra(texto) {
    const str = String(texto || '');
    return str ? str.charAt(0).toUpperCase() + str.slice(1) : str;
  }

  // Arma las líneas del mensaje de modalidad a partir de los datos
  // configurados del profesional (diasAtencion, horarios) — nunca inventa
  // un día u horario. Nunca dice que el consultorio va a contactar para
  // coordinar: en "orden_llegada"/"mixta" no se coordina turno, así que esa
  // frase sería falsa acá (a diferencia del flujo "con_turno", que sí
  // coordina y lo dice en su propio paso, renderPasoYaRegistrado/
  // renderPasoAltaExitosa). mensajeModalidad, si está cargado, es un
  // override manual completo (para un caso puntual que no entre en esta
  // plantilla genérica) y reemplaza esta plantilla por completo.
  function lineasModalidad(profesional) {
    if (profesional.mensajeModalidad) return [profesional.mensajeModalidad];
    const dias = profesional.diasAtencion;
    const horarios = profesional.horarios;
    const primeraLinea = profesional.modalidadAtencion === 'mixta'
      ? 'Atención por orden de llegada y con turno programado, según el día.'
      : 'Atención por orden de llegada.';
    const lineas = [primeraLinea];
    lineas.push(dias && horarios ? `${capitalizarPrimeraLetra(dias)} de ${horarios}.` : 'Horarios próximamente.');
    lineas.push('No necesitás solicitar turno previamente.');
    return lineas;
  }

  // Paso de cierre para profesionales 'orden_llegada'/'mixta': mismo cierre
  // tanto si el paciente se acaba de registrar (origen 'nueva') como si ya
  // estaba registrado (origen 'existente', sin obligarlo a re-registrarse),
  // sólo cambia el título.
  function renderPasoModalidad(origen) {
    const contenido = contenidoPublico();
    const profesional = contenido && Array.isArray(contenido.profesionales)
      ? contenido.profesionales[estado.profesionalIndice]
      : null;
    const titulo = origen === 'nueva' ? 'Tu registro fue realizado correctamente.' : 'Ya estás registrado en CardioLink.';
    // Defensivo: no debería pasar (el índice se fija al hacer click en la
    // propia tarjeta del profesional), pero si por algo cambiara entre el
    // click y este render, no romper con un profesional inexistente.
    const cuerpo = profesional
      ? lineasModalidad(profesional).map((linea) => `<p class="portal-muted">${escapar(linea)}</p>`).join('')
      : '';
    return `
      <h2>${escapar(titulo)}</h2>
      ${cuerpo}
      <button type="button" class="portal-btn-primario" data-portal-accion="finalizar">FINALIZAR</button>
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
        <div id="turnstileAlta" data-turnstile-container></div>
        <button type="submit" class="portal-btn-primario">QUIERO REGISTRARME COMO PACIENTE</button>
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
        <div id="turnstileSolicitud" data-turnstile-container></div>
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

    document.querySelectorAll('[data-portal-accion="ver-modalidad"]').forEach((boton) => {
      boton.addEventListener('click', () => irAVerModalidad(boton));
    });

    // FINALIZAR es una salida tan válida como "Volver al inicio": el
    // registro ya quedó guardado, no hace falta pedir turno para terminar.
    document.querySelectorAll('[data-portal-accion="volver-inicio"], [data-portal-accion="finalizar"]').forEach((boton) => {
      boton.addEventListener('click', volverAlInicio);
    });

    montarTurnstileSiCorresponde();
  }

  function volverAlInicio() {
    estado.vista = 'landing';
    estado.paso = 'dni';
    estado.dni = '';
    estado.mensaje = '';
    estado.modoFlujo = 'solicitud';
    estado.profesionalIndice = -1;
    render();
  }

  async function onSubmitDni(evento) {
    evento.preventDefault();
    const dni = new FormData(evento.target).get('dni');
    // Entra a la vista de flujo apenas se envía el formulario — venga del
    // hero embebido en la landing, o de una re-entrada ya dentro del flujo
    // (modalidad, reintento): así loading/error/resultado siempre se
    // muestran en el mismo contenedor (renderFlujo), sin duplicar esa UI
    // en el hero. estado.dni se guarda ya (antes de validar) para no
    // perder lo tipeado si el formulario se vuelve a mostrar por un error.
    estado.vista = 'flujo';
    estado.dni = soloDigitos(dni);
    if (!dniClienteValido(dni)) {
      estado.mensaje = 'Ingresá un DNI válido.';
      estado.tipoMensaje = 'error';
      render();
      return;
    }
    // El token se pide ANTES de tocar estado.cargando/render(): render()
    // reemplaza todo el HTML del paso, incluido el contenedor del widget ya
    // montado, así que hay que usarlo mientras el nodo original sigue vivo.
    let turnstileToken;
    try {
      turnstileToken = await obtenerTokenTurnstile();
    } catch (error) {
      estado.mensaje = error.message;
      estado.tipoMensaje = 'error';
      render();
      return;
    }
    estado.cargando = true;
    estado.mensaje = '';
    render();
    try {
      const resultado = await consultarDni(estado.dni, turnstileToken);
      // Si ya existe: el destino depende de modoFlujo (solicitud de turno,
      // o directamente la info de modalidad si venía de "Ver días y
      // horarios" — sin volver a pedirle que se registre). Si no existe
      // todavía, el próximo paso es el mismo formulario de alta en los dos
      // casos: onSubmitAlta es quien decide el destino final después,
      // mirando el mismo estado.modoFlujo.
      if (resultado.existe) {
        estado.paso = estado.modoFlujo === 'modalidad' ? 'modalidad-existente' : 'ya-registrado';
      } else {
        estado.paso = 'alta';
      }
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
    let turnstileToken;
    try {
      turnstileToken = await obtenerTokenTurnstile();
    } catch (error) {
      estado.mensaje = error.message;
      estado.tipoMensaje = 'error';
      render();
      return;
    }
    const datos = {
      nombre: datosForm.get('nombre'),
      apellido: datosForm.get('apellido'),
      dni: datosForm.get('dni'),
      fechaNacimiento: datosForm.get('fechaNacimiento'),
      telefono: datosForm.get('telefono'),
      email: datosForm.get('email'),
      coberturaHabitual: datosForm.get('coberturaHabitual'),
      numeroAfiliado: datosForm.get('numeroAfiliado'),
      source: estado.source,
      turnstileToken
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
      // hace falta pedir turno para que el registro sea válido. Si venía de
      // "Ver días y horarios" (modoFlujo 'modalidad'), el cierre es el
      // mensaje de modalidad en vez de ofrecer solicitar turno.
      estado.paso = estado.modoFlujo === 'modalidad' ? 'modalidad-nueva' : 'alta-exitosa';
      estado.mensaje = '';
    } catch (error) {
      estado.mensaje = error.message;
      estado.tipoMensaje = 'error';
    } finally {
      estado.cargando = false;
      render();
    }
  }

  // "Solicitar turno" (data-portal-accion="ir-solicitud") sólo se dispara
  // hoy desde "ya-registrado" (paciente preexistente) o "alta-exitosa"
  // (recién registrado) — el DNI ya quedó confirmado en este mismo flujo,
  // así que salta directo a elegir prestación/cobertura, sin volver a pedir
  // nombre/nacimiento/teléfono/email. La entrada "no sabemos el DNI
  // todavía" ya no pasa por acá: el hero de la landing embebe directamente
  // el mismo formulario de DNI (ver renderFormularioDni()/onSubmitDni), sin
  // necesitar este botón como paso intermedio.
  function irASolicitud() {
    estado.vista = 'flujo';
    estado.modoFlujo = 'solicitud';
    estado.profesionalIndice = -1;
    estado.paso = 'solicitud';
    estado.mensaje = '';
    render();
  }

  // Disparado por "Ver días y horarios" en una tarjeta 'orden_llegada'/
  // 'mixta'. Reutiliza el mismo paso 'dni' (mismo formulario, mismo
  // Turnstile, mismo gateway) que el flujo de solicitud: lo único que
  // cambia es a dónde se va después de identificar/registrar al paciente
  // (ver onSubmitDni/onSubmitAlta, que miran estado.modoFlujo) — nunca
  // ofrece "Solicitar turno".
  function irAVerModalidad(boton) {
    const indice = parseInt(boton.getAttribute('data-profesional-index'), 10);
    estado.vista = 'flujo';
    estado.modoFlujo = 'modalidad';
    estado.profesionalIndice = Number.isFinite(indice) ? indice : -1;
    estado.paso = 'dni';
    estado.mensaje = '';
    render();
  }

  async function onSubmitSolicitud(evento) {
    evento.preventDefault();
    const datosForm = new FormData(evento.target);
    let turnstileToken;
    try {
      turnstileToken = await obtenerTokenTurnstile();
    } catch (error) {
      estado.mensaje = error.message;
      estado.tipoMensaje = 'error';
      render();
      return;
    }
    const datos = {
      dni: estado.dni,
      prestacion: datosForm.get('prestacion'),
      cobertura: datosForm.get('cobertura'),
      source: estado.source,
      turnstileToken
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
    version: '3.4.2-portal-publico-fix-race-turnstile-hero',
    obtenerSourceDesdeUrl,
    dniClienteValido,
    soloDigitos,
    esEntornoLocal,
    gatewayUrl,
    turnstileSitekey,
    install
  });
});
