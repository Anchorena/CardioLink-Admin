/* =====================================================================
   CardioLink Admin — Solicitudes de turno (bandeja interna) · Fase 2B
   Sin portal público, sin email/WhatsApp/OCR todavía. Lee y actualiza
   public.cardiolink_appointment_requests.

   Producción online: reutiliza el cliente Supabase principal ya
   autenticado por app.js (conectarClientePrincipal), igual que Finanzas 5.
   No crea cliente propio, no persiste nada en localStorage.

   Staging Local (sólo localhost/127.0.0.1/::1/file:): mismo patrón que
   Finanzas 5 Etapa 4B — cliente Supabase propio e independiente del
   principal, configurado a mano vía configurarStagingLocal() con una
   publishable/anon key, sesión Auth propia sin persistir. Fuera de un
   origen local, esa ruta queda completamente inerte.

   En ambos modos no reimplementa permisos: sólo llama a las funciones de
   rol frontend ya existentes y a la autorización backend específica de
   esta tabla (nunca cardiolink_has_finance_access()).
   ===================================================================== */
(function (root, factory) {
  'use strict';

  const api = factory();

  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && !root.CardioLinkSolicitudesTurno) root.CardioLinkSolicitudesTurno = api;
  if (root && root.document) api.install(root);
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const TABLA = 'cardiolink_appointment_requests';
  const RPC_ACCESO = 'cardiolink_has_appointment_requests_access';
  const CONFLICT_MESSAGE = 'Esta solicitud fue modificada desde otra sesión. Actualizá la lista antes de volver a guardar.';
  // Claves propias, independientes de las de Finanzas 5: cada módulo Staging
  // Local guarda su configuración y su sesión aisladas en el mismo navegador.
  const CONFIG_STORAGE_KEY = 'cardiolink_solicitudes_turno_staging_config_v1';
  const AUTH_STORAGE_KEY = 'cardiolink_solicitudes_turno_staging_auth_v1';

  const ESTADOS = Object.freeze({
    new: 'Nueva',
    in_progress: 'En gestión',
    appointment_assigned: 'Turno asignado',
    closed: 'Cerrada',
    cancelled: 'Cancelada'
  });

  let clientePrincipalAutorizado = null;

  const estadoUI = {
    client: null,
    clientOwned: false,
    authSubscription: null,
    config: null,
    modo: 'inactivo',
    session: null,
    accesoBackend: false,
    accesoDenegadoProduccion: false,
    inicializandoCliente: false,
    solicitudes: [],
    cargando: false,
    mensaje: '',
    tipoMensaje: '',
    root: null
  };

  const hayNavegador = () => typeof window !== 'undefined' && typeof document !== 'undefined';

  function esEntornoLocal() {
    if (!hayNavegador()) return false;
    if (window.location.protocol === 'file:') return true;
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(window.location.hostname);
  }

  function esProduccion() {
    return estadoUI.modo === 'produccion';
  }

  // Mismo criterio que Finanzas 5: en local siempre manda Staging (o queda
  // desactivado si no se configuró), nunca el cliente principal. Producción
  // online siempre usa el cliente principal inyectado por app.js.
  function resolverModoEjecucion({ local = false, stagingConfigurado = false, clientePrincipalDisponible = false } = {}) {
    if (local) return stagingConfigurado ? 'staging-local' : 'local-desactivado';
    return clientePrincipalDisponible ? 'produccion' : 'produccion-sin-cliente';
  }

  function conectarClientePrincipal(cliente) {
    if (clientePrincipalAutorizado || !cliente?.auth
      || typeof cliente.auth.getSession !== 'function'
      || typeof cliente.rpc !== 'function'
      || typeof cliente.from !== 'function') return false;
    clientePrincipalAutorizado = cliente;
    if (hayNavegador() && !esEntornoLocal() && document.readyState !== 'loading') {
      window.setTimeout(montarInterfaz, 0);
    }
    return true;
  }

  function frontendPuedeAcceder() {
    if (!hayNavegador()) return false;
    try {
      return !!(window.esMatiasDuenio?.() || window.esAdminComun?.() || window.esSecretaria?.());
    } catch (_) {
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Staging Local: mismo patrón de seguridad que Finanzas 5 (Etapa 4B).
  // Sólo localhost/127.0.0.1/::1/file:, cliente Supabase propio e
  // independiente del principal, sólo publishable/anon (nunca service_role),
  // sesión sin persistir. Producción online sigue usando el cliente
  // principal inyectado por conectarClientePrincipal.
  // -----------------------------------------------------------------------

  function normalizarUrl(valor) {
    const url = new URL(String(valor || '').trim());
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('La URL de Staging debe usar HTTPS o HTTP.');
    if (url.username || url.password || url.search || url.hash) throw new Error('La URL de Staging no debe incluir credenciales, parámetros ni fragmentos.');
    return url.origin;
  }

  function rolJwt(clave) {
    try {
      const partes = String(clave || '').split('.');
      if (partes.length !== 3) return '';
      const base64 = partes[1].replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(window.atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')));
      return String(payload?.role || '');
    } catch (_) {
      return '';
    }
  }

  function validarClavePublica(valor) {
    const clave = String(valor || '').trim();
    if (!clave) throw new Error('Falta la publishable key de Staging.');
    if (/^sb_secret_/i.test(clave) || /service[_-]?role/i.test(clave)) {
      throw new Error('Solicitudes de turno rechaza claves secret/service_role. Usá únicamente la publishable key de Staging.');
    }
    if (/^sb_publishable_/i.test(clave)) return clave;
    if (rolJwt(clave) === 'anon') return clave;
    throw new Error('La clave no es una publishable key ni una clave anon válida de Supabase.');
  }

  function leerConfigLocal() {
    if (!esEntornoLocal()) return null;
    try {
      const config = JSON.parse(window.localStorage.getItem(CONFIG_STORAGE_KEY) || 'null');
      if (!config || config.environment !== 'staging') return null;
      return {
        environment: 'staging',
        url: normalizarUrl(config.url),
        publishableKey: validarClavePublica(config.publishableKey)
      };
    } catch (_) {
      return null;
    }
  }

  function asegurarDestinoIndependiente(url) {
    const clientePrincipal = clientePrincipalAutorizado;
    const urlPrincipal = clientePrincipal?.supabaseUrl || clientePrincipal?.rest?.url?.replace(/\/rest\/v1\/?$/, '') || '';
    if (urlPrincipal && normalizarUrl(urlPrincipal) === normalizarUrl(url)) {
      throw new Error('La URL configurada coincide con el Supabase principal. Solicitudes de turno sólo admite un proyecto de Staging independiente.');
    }
  }

  function configurarStagingLocal(opciones = {}) {
    if (!esEntornoLocal()) throw new Error('La configuración de Solicitudes de turno sólo puede activarse desde localhost, 127.0.0.1 o file:.');
    const config = {
      environment: 'staging',
      url: normalizarUrl(opciones.url),
      publishableKey: validarClavePublica(opciones.publishableKey)
    };
    asegurarDestinoIndependiente(config.url);
    window.localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config));
    return { activa: true, entorno: 'staging', url: config.url, requiereRecarga: true };
  }

  async function desactivarStagingLocal() {
    if (!esEntornoLocal()) return { activa: false };
    try { await estadoUI.client?.auth?.signOut?.({ scope: 'local' }); } catch (_) {}
    window.localStorage.removeItem(CONFIG_STORAGE_KEY);
    window.localStorage.removeItem(AUTH_STORAGE_KEY);
    destruirCliente();
    limpiarDatos();
    estadoUI.config = null;
    estadoUI.mensaje = 'Solicitudes de turno Staging quedó desactivado en este navegador.';
    estadoUI.tipoMensaje = 'ok';
    montarInterfaz();
    return { activa: false, requiereRecarga: false };
  }

  function estadoStagingLocal() {
    const config = leerConfigLocal();
    return Object.freeze({
      local: esEntornoLocal(),
      activa: !!config,
      entorno: config ? 'staging' : null,
      url: config?.url || null,
      autenticada: !!estadoUI.session,
      accesoBackend: !!estadoUI.accesoBackend
    });
  }

  function destruirCliente() {
    if (estadoUI.clientOwned) {
      try { estadoUI.authSubscription?.unsubscribe?.(); } catch (_) {}
      try { estadoUI.client?.auth?.stopAutoRefresh?.(); } catch (_) {}
    }
    estadoUI.authSubscription = null;
    estadoUI.client = null;
    estadoUI.clientOwned = false;
    estadoUI.session = null;
    estadoUI.accesoBackend = false;
    estadoUI.inicializandoCliente = false;
  }

  function crearClienteStaging() {
    if (estadoUI.client) return estadoUI.client;
    if (!esEntornoLocal() || !frontendPuedeAcceder()) return null;
    const config = leerConfigLocal();
    if (!config) return null;
    asegurarDestinoIndependiente(config.url);
    if (!window.supabase?.createClient) throw new Error('No está disponible la biblioteca pública de Supabase.');
    estadoUI.config = config;
    estadoUI.client = window.supabase.createClient(config.url, config.publishableKey, {
      auth: {
        storageKey: AUTH_STORAGE_KEY,
        // La sesión de Staging no sobrevive una recarga ni queda disponible
        // para otro rol frontend que use después este navegador.
        persistSession: false,
        autoRefreshToken: true,
        detectSessionInUrl: false
      }
    });
    estadoUI.clientOwned = true;
    const suscripcion = estadoUI.client.auth.onAuthStateChange((_evento, session) => {
      if (!frontendPuedeAcceder()) return;
      estadoUI.session = session || null;
      if (!session) {
        estadoUI.accesoBackend = false;
        limpiarDatos();
        renderInterfaz();
      }
    });
    estadoUI.authSubscription = suscripcion?.data?.subscription || null;
    return estadoUI.client;
  }

  function escapar(valor) {
    return String(valor ?? '').replace(/[&<>"']/g, (caracter) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[caracter]);
  }

  function fechaVisible(valor) {
    if (!valor) return '—';
    const fecha = new Date(valor);
    if (Number.isNaN(fecha.getTime())) return escapar(valor);
    return fecha.toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
  }

  function pacienteLocal(id) {
    try {
      const lista = (typeof data !== 'undefined' ? data : window.data)?.pacientes;
      return Array.isArray(lista) ? lista.find((p) => String(p?.id || '') === String(id || '')) || null : null;
    } catch (_) {
      return null;
    }
  }

  function profesionalLocal(id) {
    try {
      const lista = (typeof data !== 'undefined' ? data : window.data)?.profesionales;
      return Array.isArray(lista) ? lista.find((p) => String(p?.id || '') === String(id || '')) || null : null;
    } catch (_) {
      return null;
    }
  }

  function esErrorAcceso(error) {
    const status = Number(error?.status || error?.statusCode || 0);
    const code = String(error?.code || '');
    const texto = `${error?.message || ''} ${error?.details || ''}`.toLowerCase();
    return status === 401 || status === 403 || ['42501', 'PGRST301', 'PGRST302'].includes(code)
      || texto.includes('permission denied') || texto.includes('row-level security') || texto.includes('jwt');
  }

  function mensajeError(error, fallback) {
    if (esErrorAcceso(error)) return 'Acceso denegado. Verificá la sesión y el rol backend owner/admin/secretaría.';
    return String(error?.message || fallback || 'No se pudo completar la operación.');
  }

  function desmontarInterfaz() {
    const root = estadoUI.root || (hayNavegador() ? document.getElementById('cardiolinkSolicitudesTurno') : null);
    root?.remove();
    estadoUI.root = null;
  }

  function limpiarDatos() {
    estadoUI.solicitudes = [];
  }

  function negarAcceso(error) {
    estadoUI.accesoBackend = false;
    limpiarDatos();
    if (esProduccion()) {
      estadoUI.accesoDenegadoProduccion = true;
      estadoUI.mensaje = '';
      estadoUI.tipoMensaje = '';
      desmontarInterfaz();
      return;
    }
    estadoUI.mensaje = mensajeError(error, 'La cuenta de Staging no tiene autorización para solicitudes de turno.');
    estadoUI.tipoMensaje = 'error';
    renderInterfaz();
  }

  // -----------------------------------------------------------------------
  // Autorización backend: siempre auth.uid() + RPC propio de esta tabla.
  // Nunca reutiliza cardiolink_has_finance_access() ni el rol frontend.
  // -----------------------------------------------------------------------

  async function autorizarBackend(client) {
    if (!client?.auth || typeof client.auth.getSession !== 'function' || typeof client.rpc !== 'function') {
      return { autorizado: false, motivo: 'cliente' };
    }
    const { data: datosSesion, error: errorSesion } = await client.auth.getSession();
    if (errorSesion) throw errorSesion;
    const session = datosSesion?.session || null;
    if (!session?.user) return { autorizado: false, motivo: 'sesion' };
    const { data: acceso, error } = await client.rpc(RPC_ACCESO);
    if (error) throw error;
    if (acceso !== true) return { autorizado: false, motivo: 'acceso', session };
    return { autorizado: true, motivo: '', session };
  }

  function modoPermiteMutaciones() {
    return ['staging-local', 'produccion'].includes(estadoUI.modo)
      && !!estadoUI.session?.user
      && estadoUI.accesoBackend === true
      && frontendPuedeAcceder() === true
      && (estadoUI.modo === 'staging-local' ? !!estadoUI.clientOwned : estadoUI.client === clientePrincipalAutorizado);
  }

  function exigirMutacionPermitida() {
    if (modoPermiteMutaciones()) return true;
    if (hayNavegador() && !frontendPuedeAcceder()) {
      destruirCliente();
      limpiarDatos();
      desmontarInterfaz();
      return false;
    }
    estadoUI.mensaje = esProduccion()
      ? 'La sesión principal no tiene autorización vigente para modificar solicitudes de turno.'
      : 'La sesión de Staging no tiene autorización vigente para modificar solicitudes de turno.';
    estadoUI.tipoMensaje = 'error';
    renderInterfaz();
    return false;
  }

  // Revalida sesión + RPC inmediatamente antes de cada escritura, igual que
  // el guard de mutaciones de Finanzas 5 en Producción. No alcanza con el
  // chequeo de rol frontend hecho al montar la bandeja.
  async function exigirMutacionBackend() {
    if (!exigirMutacionPermitida()) return false;
    try {
      const resultado = await autorizarBackend(estadoUI.client);
      if (resultado.autorizado && frontendPuedeAcceder()) {
        estadoUI.session = resultado.session;
        estadoUI.accesoBackend = true;
        return true;
      }
      estadoUI.accesoBackend = false;
      limpiarDatos();
      if (resultado.motivo === 'acceso') {
        estadoUI.mensaje = 'Tu cuenta ya no tiene autorización vigente para modificar solicitudes.';
        estadoUI.tipoMensaje = 'error';
        renderInterfaz();
      } else {
        desmontarInterfaz();
      }
    } catch (error) {
      estadoUI.mensaje = mensajeError(error, 'No se pudo revalidar el acceso antes de guardar.');
      estadoUI.tipoMensaje = 'error';
      renderInterfaz();
    }
    return false;
  }

  // -----------------------------------------------------------------------
  // Datos
  // -----------------------------------------------------------------------

  function prioridadOrden(solicitud) {
    // Nuevas primero; dentro de cada grupo, más recientes primero.
    return solicitud?.status === 'new' ? 0 : 1;
  }

  async function cargarSolicitudes() {
    if (!estadoUI.client || !estadoUI.accesoBackend || estadoUI.cargando) return;
    estadoUI.cargando = true;
    estadoUI.mensaje = '';
    renderInterfaz();
    try {
      const { data: filas, error } = await estadoUI.client.from(TABLA)
        .select('id,patient_id,requested_professional_id,requested_professional_name,requested_service,requested_coverage,message,contact_phone,contact_email,source,status,assigned_attention_id,revision,created_at,updated_at,managed_by,managed_at')
        .order('created_at', { ascending: false });
      if (error) throw error;
      const lista = Array.isArray(filas) ? filas.slice() : [];
      lista.sort((a, b) => prioridadOrden(a) - prioridadOrden(b) || String(b.created_at || '').localeCompare(String(a.created_at || '')));
      estadoUI.solicitudes = lista;
      estadoUI.mensaje = '';
    } catch (error) {
      if (esErrorAcceso(error)) { estadoUI.accesoBackend = false; limpiarDatos(); desmontarInterfaz(); return; }
      estadoUI.mensaje = mensajeError(error, 'No se pudieron cargar las solicitudes.');
      estadoUI.tipoMensaje = 'error';
    } finally {
      estadoUI.cargando = false;
      renderInterfaz();
    }
  }

  async function actualizarEstado(solicitud, nuevoEstado) {
    if (!(await exigirMutacionBackend())) return;
    estadoUI.cargando = true;
    renderInterfaz();
    try {
      const { data: filas, error } = await estadoUI.client.from(TABLA)
        .update({ status: nuevoEstado })
        .eq('id', solicitud.id).eq('revision', solicitud.revision)
        .select('id,revision,status');
      if (error) throw error;
      if (!Array.isArray(filas) || filas.length === 0) throw Object.assign(new Error(CONFLICT_MESSAGE), { conflict: true });
      estadoUI.mensaje = `Solicitud marcada como "${ESTADOS[nuevoEstado] || nuevoEstado}".`;
      estadoUI.tipoMensaje = 'ok';
      estadoUI.cargando = false;
      await cargarSolicitudes();
    } catch (error) {
      if (esErrorAcceso(error)) { estadoUI.accesoBackend = false; limpiarDatos(); desmontarInterfaz(); return; }
      estadoUI.mensaje = error?.conflict ? CONFLICT_MESSAGE : mensajeError(error, 'No se pudo actualizar la solicitud.');
      estadoUI.tipoMensaje = 'error';
    } finally {
      estadoUI.cargando = false;
      renderInterfaz();
    }
  }

  // -----------------------------------------------------------------------
  // Acciones de fila
  // -----------------------------------------------------------------------

  function verPaciente(solicitud) {
    try {
      if (typeof window.abrirPacienteGlobal320 === 'function') { window.abrirPacienteGlobal320(solicitud.patient_id); return; }
    } catch (_) {}
    alert('No se pudo abrir la ficha del paciente.');
  }

  function copiarTelefono(solicitud) {
    try {
      if (typeof window.copyText300 === 'function') { window.copyText300(solicitud.contact_phone, 'teléfono'); return; }
    } catch (_) {}
    try { navigator.clipboard?.writeText(String(solicitud.contact_phone || '')); } catch (_) {}
  }

  function normalizarTexto(valor) {
    return String(valor || '')
      .normalize('NFD').replace(new RegExp('[\\u0300-\\u036f]', 'g'), '')
      .trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function pacienteDisponibleLocalmente(patientId) {
    try {
      if (typeof window.todosPacientes === 'function') {
        return !!window.todosPacientes().find((p) => String(p?.id || '') === String(patientId || ''));
      }
    } catch (_) {}
    return !!pacienteLocal(patientId);
  }

  // Sólo para cuando la solicitud referencia un paciente que ya existe en
  // Supabase pero todavía no llegó a data.pacientes en este navegador (por
  // ejemplo, cargado directamente en Staging). Usa el mismo cliente activo
  // del módulo (Staging local o principal, nunca uno nuevo) y completa
  // únicamente los campos administrativos visibles del formulario de Carga.
  // No escribe en data.pacientes ni crea un paciente nuevo: patient_id se
  // conserva tal cual vino en la solicitud/columna id.
  async function hidratarPacienteRemoto(patientId) {
    if (!estadoUI.client || !patientId) return false;
    try {
      const { data: filas, error } = await estadoUI.client.from('cardiolink_pacientes')
        .select('id,nombre_completo,dni,telefono,email,fecha_nacimiento,cobertura_habitual,numero_afiliado_habitual')
        .eq('id', patientId)
        .limit(1);
      if (error) throw error;
      const fila = Array.isArray(filas) ? filas[0] : null;
      if (!fila) {
        estadoUI.mensaje = 'La solicitud referencia un paciente que no se encontró. Completá los datos manualmente.';
        estadoUI.tipoMensaje = 'info';
        renderInterfaz();
        return false;
      }
      const set = (id, valor) => { const el = document.getElementById(id); if (el && valor != null && valor !== '') el.value = valor; };
      set('pacienteId', fila.id);
      set('paciente', fila.nombre_completo);
      set('dni', fila.dni);
      set('telefono', fila.telefono);
      set('email', fila.email);
      set('fechaNacimiento', fila.fecha_nacimiento);
      if (fila.cobertura_habitual) {
        const selectObraSocial = document.getElementById('obraSocial');
        if (selectObraSocial) {
          try { window.ensureSelectOption?.(selectObraSocial, fila.cobertura_habitual); } catch (_) {}
          selectObraSocial.value = fila.cobertura_habitual;
        }
      }
      set('numeroAfiliado', fila.numero_afiliado_habitual);
      const caja = document.getElementById('pacienteSeleccionadoBox');
      if (caja) {
        caja.classList.remove('hidden');
        caja.innerHTML = `Paciente seleccionado: <strong>${escapar(fila.nombre_completo || '')}</strong> · DNI ${escapar(fila.dni || '')} · cobertura habitual ${escapar(fila.cobertura_habitual || 's/d')} <em>(cargado desde el servidor, todavía no sincronizado en este navegador)</em>`;
      }
      try { window.aplicarRegla?.(); } catch (_) {}
      return true;
    } catch (error) {
      if (esErrorAcceso(error)) return false;
      estadoUI.mensaje = mensajeError(error, 'No se pudieron completar los datos del paciente. Completalos manualmente.');
      estadoUI.tipoMensaje = 'error';
      renderInterfaz();
      return false;
    }
  }

  function seleccionarProfesionalSolicitado(solicitud) {
    const selectProfesional = document.getElementById('profesional');
    if (!selectProfesional) return false;
    const opciones = Array.from(selectProfesional.options || []);
    let coincide = null;
    if (solicitud.requested_professional_id) {
      coincide = opciones.find((o) => o.value === solicitud.requested_professional_id);
    }
    if (!coincide && solicitud.requested_professional_name) {
      const buscado = normalizarTexto(solicitud.requested_professional_name);
      coincide = opciones.find((o) => normalizarTexto(o.textContent) === buscado)
        || opciones.find((o) => normalizarTexto(o.textContent).includes(buscado) || buscado.includes(normalizarTexto(o.textContent)));
    }
    if (coincide) selectProfesional.value = coincide.value;
    // Se dispara siempre, haya o no coincidencia: garantiza que #prestacion
    // quede recién repoblado (de forma síncrona, vía actualizarPrestaciones)
    // para el profesional que haya quedado seleccionado antes de intentar
    // elegir la prestación solicitada.
    selectProfesional.dispatchEvent(new Event('change', { bubbles: true }));
    return !!coincide;
  }

  function seleccionarPrestacionSolicitada(solicitud) {
    const selectPrestacion = document.getElementById('prestacion');
    if (!selectPrestacion || !solicitud.requested_service) return;
    const buscado = normalizarTexto(solicitud.requested_service);
    const opciones = Array.from(selectPrestacion.options || []);
    const opcion = opciones.find((o) => normalizarTexto(o.textContent) === buscado)
      || opciones.find((o) => normalizarTexto(o.textContent).includes(buscado) || buscado.includes(normalizarTexto(o.textContent)));
    if (opcion) {
      selectPrestacion.value = opcion.value;
      return;
    }
    // No se crea ninguna prestación nueva: se deja la selección tal cual
    // quedó y se avisa, sin bloquear el resto de la carga.
    estadoUI.mensaje = `No se encontró una prestación equivalente a "${solicitud.requested_service}". Seleccioná la prestación manualmente.`;
    estadoUI.tipoMensaje = 'info';
    renderInterfaz();
  }

  // Cobertura de ESTA solicitud (requested_coverage), no la habitual del
  // paciente: sólo prellena #obraSocial para el turno que se está cargando,
  // nunca escribe cardiolink_pacientes.cobertura_habitual. "No sé /
  // consultar" no es una obra social real: se deja #obraSocial como esté
  // (por ejemplo, ya prellenado con la cobertura habitual del paciente) en
  // vez de forzar una opción sin sentido para facturación.
  function seleccionarCoberturaSolicitada(solicitud) {
    const cobertura = solicitud.requested_coverage;
    if (!cobertura || cobertura === 'No sé / consultar') return;
    const selectObraSocial = document.getElementById('obraSocial');
    if (!selectObraSocial) return;
    try { window.ensureSelectOption?.(selectObraSocial, cobertura); } catch (_) {}
    selectObraSocial.value = cobertura;
    try { window.aplicarRegla?.(); } catch (_) {}
  }

  // Reutiliza el flujo existente de Carga: no crea una segunda agenda, no
  // genera la atención sola y no marca la solicitud como asignada. La
  // asociación definitiva queda manual, tal como pide esta etapa.
  async function abrirCargaDeTurno(solicitud) {
    try {
      if (typeof window.showSection === 'function') window.showSection('carga');
    } catch (_) {}

    let hidratado = false;
    try {
      if (typeof window.usarPaciente === 'function' && pacienteDisponibleLocalmente(solicitud.patient_id)) {
        window.usarPaciente(solicitud.patient_id);
        hidratado = true;
      }
    } catch (_) {}
    if (!hidratado) {
      try { hidratado = await hidratarPacienteRemoto(solicitud.patient_id); } catch (_) {}
    }

    window.setTimeout(() => {
      try {
        seleccionarProfesionalSolicitado(solicitud);
        seleccionarPrestacionSolicitada(solicitud);
        seleccionarCoberturaSolicitada(solicitud);
      } catch (_) {}
    }, 60);
  }

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  function accionesParaFila(solicitud) {
    const acciones = [];
    acciones.push(['ver-paciente', 'Ver paciente']);
    acciones.push(['copiar-telefono', 'Copiar teléfono']);
    if (!['closed', 'cancelled'].includes(solicitud.status)) {
      acciones.push(['abrir-carga', 'Abrir carga de turno']);
    }
    if (solicitud.status === 'new') acciones.push(['en-gestion', 'Marcar "En gestión"']);
    if (['new', 'in_progress'].includes(solicitud.status)) acciones.push(['turno-asignado', 'Marcar "Turno asignado"']);
    if (['new', 'in_progress', 'appointment_assigned'].includes(solicitud.status)) acciones.push(['cerrar', 'Cerrar']);
    if (['new', 'in_progress'].includes(solicitud.status)) acciones.push(['cancelar', 'Cancelar']);
    return acciones;
  }

  function renderFila(solicitud) {
    const paciente = pacienteLocal(solicitud.patient_id);
    const nombrePaciente = paciente?.nombreCompleto || paciente?.paciente || 'Paciente sin ficha local';
    const dni = paciente?.dni || 's/d';
    const profesional = solicitud.requested_professional_name
      || profesionalLocal(solicitud.requested_professional_id)?.nombre
      || 'Sin preferencia';
    const acciones = accionesParaFila(solicitud).map(([accion, etiqueta]) =>
      `<button type="button" class="secondary small-btn" data-sol-turno-action="${accion}" data-id="${escapar(solicitud.id)}">${escapar(etiqueta)}</button>`
    ).join('');
    return `<tr>
      <td data-label="Fecha">${fechaVisible(solicitud.created_at)}</td>
      <td data-label="Paciente"><strong>${escapar(nombrePaciente)}</strong></td>
      <td data-label="DNI">${escapar(dni)}</td>
      <td data-label="Teléfono">${escapar(solicitud.contact_phone || 's/d')}</td>
      <td data-label="Profesional solicitado">${escapar(profesional)}</td>
      <td data-label="Prestación / motivo">${escapar(solicitud.requested_service || '')}</td>
      <td data-label="Mensaje">${solicitud.message ? escapar(solicitud.message) : '<span class="muted">—</span>'}</td>
      <td data-label="Estado"><span class="sol-turno-chip sol-turno-chip-${escapar(solicitud.status)}">${escapar(ESTADOS[solicitud.status] || solicitud.status)}</span></td>
      <td data-label="Acciones"><div class="sol-turno-acciones">${acciones}</div></td>
    </tr>`;
  }

  function renderTabla() {
    if (!estadoUI.solicitudes.length) return '<div class="sol-turno-vacio">No hay solicitudes de turno registradas todavía.</div>';
    const filas = estadoUI.solicitudes.map(renderFila).join('');
    return `<div class="sol-turno-tabla-wrap"><table class="sol-turno-tabla"><thead><tr>
      <th>Fecha</th><th>Paciente</th><th>DNI</th><th>Teléfono</th><th>Profesional solicitado</th><th>Prestación / motivo</th><th>Mensaje</th><th>Estado</th><th>Acciones</th>
    </tr></thead><tbody>${filas}</tbody></table></div>`;
  }

  function renderInterfaz() {
    const root = estadoUI.root;
    if (!root || !root.isConnected) return;
    const local = esEntornoLocal();
    const produccion = esProduccion();
    const config = local ? (estadoUI.config || leerConfigLocal()) : null;
    const host = config ? new URL(config.url).host : '';
    const mensaje = estadoUI.mensaje ? `<div class="sol-turno-aviso sol-turno-aviso-${escapar(estadoUI.tipoMensaje || 'info')}" role="status">${escapar(estadoUI.mensaje)}</div>` : '';
    const sesionEmail = estadoUI.session?.user?.email || '';
    const badge = produccion
      ? '<span class="sol-turno-production-badge">PRODUCCIÓN</span>'
      : config ? '<span class="sol-turno-staging-badge">STAGING LOCAL</span>' : '<span class="sol-turno-inactivo-badge">DESACTIVADO</span>';
    const autenticado = ((local && config) || produccion) && estadoUI.session;
    root.innerHTML = `<div class="sol-turno-barra"><div><div class="sol-turno-titulo-linea"><h3>Bandeja de solicitudes</h3>${badge}</div><p>Se cargan desde adentro de CardioLink. Nuevas primero, luego más recientes.</p></div>${config ? `<div class="sol-turno-destino"><span>Proyecto aislado</span><strong>${escapar(host)}</strong></div>` : ''}</div>
      ${mensaje}
      ${local && !config ? '<div class="sol-turno-aviso">Solicitudes de turno no está conectado a Staging en este navegador. Ver <code>docs/SOLICITUDES_TURNO_STAGING.md</code>.</div>' : ''}
      ${local && config && !estadoUI.session ? `<form id="solTurnoLogin" class="sol-turno-login"><div><strong>Sesión independiente de Staging</strong><p>Ingresá con una cuenta Auth del proyecto de Staging. La contraseña no se guarda en el módulo.</p></div><label>Email<input name="email" type="email" autocomplete="username" required></label><label>Contraseña<input name="password" type="password" autocomplete="current-password" required></label><button class="primary" type="submit">Ingresar a Staging</button></form>` : ''}
      ${local && config && estadoUI.session ? `<div class="sol-turno-sesion"><span>Sesión Staging: <strong>${escapar(sesionEmail)}</strong></span><button type="button" class="secondary" data-sol-turno-action="salir">Cerrar sesión Staging</button></div>` : ''}
      ${produccion && estadoUI.session ? `<div class="sol-turno-sesion sol-turno-sesion-produccion"><span>Sesión principal: <strong>${escapar(sesionEmail)}</strong></span><span>Operaciones protegidas por RLS</span></div>` : ''}
      ${autenticado && !estadoUI.accesoBackend ? '<div class="sol-turno-aviso">Validando acceso…</div>' : ''}
      ${autenticado && estadoUI.accesoBackend ? `<div class="sol-turno-toolbar"><button type="button" class="secondary" data-sol-turno-action="actualizar">Actualizar</button></div>${renderTabla()}` : ''}
      ${estadoUI.cargando ? '<div class="sol-turno-aviso" aria-live="polite">Actualizando…</div>' : ''}`;
    enlazarFormularioLogin();
  }

  function enlazarFormularioLogin() {
    const form = estadoUI.root?.querySelector('#solTurnoLogin');
    if (!form || form.dataset.enlazado) return;
    form.dataset.enlazado = 'true';
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const email = String(new FormData(form).get('email') || '').trim();
      const password = String(new FormData(form).get('password') || '');
      estadoUI.cargando = true;
      estadoUI.mensaje = '';
      renderInterfaz();
      try {
        const client = crearClienteStaging();
        if (!client) throw new Error('No se pudo crear el cliente de Staging.');
        const { data, error } = await client.auth.signInWithPassword({ email, password });
        if (error) throw error;
        if (estadoUI.client !== client || !frontendPuedeAcceder()) return;
        estadoUI.session = data?.session || null;
        const resultado = await autorizarBackend(client);
        if (estadoUI.client !== client || !frontendPuedeAcceder()) return;
        if (!resultado.autorizado) {
          if (resultado.motivo === 'acceso') return negarAcceso(Object.assign(new Error('La cuenta de Staging no tiene autorización de solicitudes de turno.'), { status: 403 }));
          return;
        }
        estadoUI.accesoBackend = true;
        estadoUI.cargando = false;
        await cargarSolicitudes();
      } catch (error) {
        if (esErrorAcceso(error)) return negarAcceso(error);
        estadoUI.mensaje = mensajeError(error, 'No se pudo iniciar sesión en Staging.');
        estadoUI.tipoMensaje = 'error';
      } finally {
        estadoUI.cargando = false;
        renderInterfaz();
      }
    });
  }

  function enlazarEventos(root) {
    if (root.dataset.solTurnoEnlazado) return;
    root.dataset.solTurnoEnlazado = 'true';
    root.addEventListener('click', (event) => {
      if (estadoUI.cargando) return;
      const boton = event.target.closest?.('[data-sol-turno-action]');
      if (!boton) return;
      const accion = boton.dataset.solTurnoAction;
      const solicitud = estadoUI.solicitudes.find((s) => String(s.id) === String(boton.dataset.id));
      if (accion === 'actualizar') return cargarSolicitudes();
      if (accion === 'salir') return cerrarSesionStaging();
      if (!solicitud) return;
      if (accion === 'ver-paciente') return verPaciente(solicitud);
      if (accion === 'copiar-telefono') return copiarTelefono(solicitud);
      if (accion === 'abrir-carga') return abrirCargaDeTurno(solicitud);
      if (accion === 'en-gestion') return actualizarEstado(solicitud, 'in_progress');
      if (accion === 'turno-asignado') return actualizarEstado(solicitud, 'appointment_assigned');
      if (accion === 'cerrar') return actualizarEstado(solicitud, 'closed');
      if (accion === 'cancelar') return actualizarEstado(solicitud, 'cancelled');
    });
  }

  // -----------------------------------------------------------------------
  // Montaje
  // -----------------------------------------------------------------------

  // Producción online: siempre el cliente principal inyectado por app.js.
  // Nunca corre si el entorno es local (ahí manda Staging Local).
  async function iniciarSesionPrincipalProduccion() {
    if (esEntornoLocal() || estadoUI.inicializandoCliente || estadoUI.accesoBackend
      || estadoUI.accesoDenegadoProduccion || !clientePrincipalAutorizado) return;
    estadoUI.inicializandoCliente = true;
    estadoUI.client = clientePrincipalAutorizado;
    estadoUI.clientOwned = false;
    estadoUI.modo = 'produccion';
    renderInterfaz();
    try {
      const resultado = await autorizarBackend(estadoUI.client);
      if (estadoUI.client !== clientePrincipalAutorizado || !frontendPuedeAcceder()) return;
      if (!resultado.autorizado) {
        estadoUI.session = resultado.session || null;
        estadoUI.accesoBackend = false;
        limpiarDatos();
        if (resultado.motivo === 'acceso') {
          negarAcceso(Object.assign(new Error('La sesión principal no tiene autorización de solicitudes de turno.'), { status: 403 }));
        } else {
          desmontarInterfaz();
        }
        return;
      }
      estadoUI.session = resultado.session;
      estadoUI.accesoBackend = true;
      estadoUI.inicializandoCliente = false;
      await cargarSolicitudes();
    } catch (error) {
      if (esErrorAcceso(error)) negarAcceso(error);
      else desmontarInterfaz();
    } finally {
      estadoUI.inicializandoCliente = false;
      renderInterfaz();
    }
  }

  // Staging Local: reutiliza una sesión Auth de Staging ya iniciada en este
  // navegador (persistSession queda en false, así que normalmente no hay
  // ninguna hasta que se complete el login del formulario).
  async function iniciarSesionExistente() {
    if (!esEntornoLocal()) return;
    try {
      const client = crearClienteStaging();
      if (!client) return;
      const { data, error } = await client.auth.getSession();
      if (error) throw error;
      estadoUI.session = data?.session || null;
      renderInterfaz();
      if (!estadoUI.session) return;
      const resultado = await autorizarBackend(client);
      if (estadoUI.client !== client || !frontendPuedeAcceder()) return;
      if (!resultado.autorizado) {
        if (resultado.motivo === 'acceso') negarAcceso(Object.assign(new Error('La cuenta de Staging no tiene autorización de solicitudes de turno.'), { status: 403 }));
        return;
      }
      estadoUI.accesoBackend = true;
      await cargarSolicitudes();
    } catch (error) {
      if (esErrorAcceso(error)) return negarAcceso(error);
      estadoUI.mensaje = mensajeError(error, 'No se pudo iniciar Solicitudes de turno Staging.');
      estadoUI.tipoMensaje = 'error';
      renderInterfaz();
    }
  }

  async function cerrarSesionStaging() {
    if (!esEntornoLocal()) return;
    try { await estadoUI.client?.auth?.signOut?.({ scope: 'local' }); } catch (_) {}
    limpiarDatos();
    estadoUI.session = null;
    estadoUI.accesoBackend = false;
    estadoUI.mensaje = '';
    renderInterfaz();
  }

  function montarInterfaz() {
    if (!hayNavegador()) return false;
    const local = esEntornoLocal();
    const contenedor = document.getElementById('solicitudesTurnoRoot');
    if (!contenedor) return false;
    if (!frontendPuedeAcceder() || (!local && estadoUI.accesoDenegadoProduccion)) {
      const rootExistente = document.getElementById('cardiolinkSolicitudesTurno');
      if (rootExistente || estadoUI.client) {
        destruirCliente();
        limpiarDatos();
      }
      rootExistente?.remove();
      estadoUI.root = null;
      return false;
    }
    const config = local ? leerConfigLocal() : null;
    const modo = resolverModoEjecucion({
      local,
      stagingConfigurado: !!config,
      clientePrincipalDisponible: !!clientePrincipalAutorizado
    });
    if (!local && modo === 'produccion-sin-cliente') {
      desmontarInterfaz();
      return false;
    }
    let root = document.getElementById('cardiolinkSolicitudesTurno');
    if (!root) {
      root = document.createElement('div');
      root.id = 'cardiolinkSolicitudesTurno';
      root.className = 'sol-turno-shell';
      contenedor.appendChild(root);
      enlazarEventos(root);
    }
    estadoUI.root = root;
    estadoUI.config = config;
    estadoUI.modo = modo;
    if (!local && !estadoUI.client) {
      estadoUI.client = clientePrincipalAutorizado;
      estadoUI.clientOwned = false;
    }
    renderInterfaz();
    if (local && estadoUI.config && !estadoUI.client) iniciarSesionExistente();
    if (!local && !estadoUI.accesoBackend) iniciarSesionPrincipalProduccion();
    return true;
  }

  function iniciarIntegracion() {
    if (!hayNavegador()) return;
    const intentar = () => montarInterfaz();
    document.addEventListener('click', (event) => {
      if (event.target.closest?.('.nav[data-section="solicitudesTurno"]')) window.setTimeout(intentar, 160);
    }, true);
    const observadorRol = new MutationObserver(() => window.setTimeout(intentar, 0));
    observadorRol.observe(document.body, { attributes: true, attributeFilter: ['data-rol', 'data-usuario'] });
    window.setTimeout(intentar, 900);
    window.setTimeout(intentar, 1900);
  }

  function install(rootWindow) {
    if (!rootWindow || !rootWindow.document) return;
    if (rootWindow.document.readyState === 'loading') {
      rootWindow.document.addEventListener('DOMContentLoaded', iniciarIntegracion, { once: true });
    } else {
      iniciarIntegracion();
    }
  }

  return Object.freeze({
    version: '1.1.0-fase-2b',
    estados: ESTADOS,
    conectarClientePrincipal,
    frontendPuedeAcceder,
    accionesParaFila,
    configurarStagingLocal,
    desactivarStagingLocal,
    estadoStagingLocal,
    install
  });
});
