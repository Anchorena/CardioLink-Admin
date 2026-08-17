/* =====================================================================
   CardioLink Admin — Finanzas 5 · Etapa 3A
   Proveedor canónico de ingresos + CRUD local de egresos contra Staging.

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

  // -----------------------------------------------------------------------
  // Etapa 3A: cliente de Staging aislado y disponible exclusivamente en local
  // -----------------------------------------------------------------------

  const CONFIG_STORAGE_KEY = 'cardiolink_finanzas_v5_staging_config_v1';
  const AUTH_STORAGE_KEY = 'cardiolink_finanzas_v5_staging_auth_v1';
  const CONFLICT_MESSAGE = 'Este egreso fue modificado desde otra sesión. Actualizá la información antes de volver a guardar.';
  const PAGE_SIZE = 1000;
  const TABLAS = Object.freeze({
    categorias: 'cardiolink_finance_categories',
    egresos: 'cardiolink_finance_expenses',
    auditoria: 'cardiolink_finance_audit_events'
  });
  const estadoUI = {
    client: null,
    authSubscription: null,
    config: null,
    session: null,
    accesoBackend: false,
    categorias: [],
    egresos: [],
    egresosPagadosPorFechaPago: [],
    auditoria: [],
    cargando: false,
    mensaje: '',
    tipoMensaje: '',
    vista: 'egresos',
    edicion: null,
    root: null
  };

  const hayNavegador = () => typeof window !== 'undefined' && typeof document !== 'undefined';

  function esEntornoLocal() {
    if (!hayNavegador()) return false;
    if (window.location.protocol === 'file:') return true;
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(window.location.hostname);
  }

  function frontendPuedeAcceder() {
    if (!hayNavegador()) return false;
    try {
      return !!(window.esMatiasDuenio?.() || window.esAdminComun?.());
    } catch (error) {
      return false;
    }
  }

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
    } catch (error) {
      return '';
    }
  }

  function validarClavePublica(valor) {
    const clave = String(valor || '').trim();
    if (!clave) throw new Error('Falta la publishable key de Staging.');
    if (/^sb_secret_/i.test(clave) || /service[_-]?role/i.test(clave)) {
      throw new Error('Finanzas 5 rechaza claves secret/service_role. Usá únicamente la publishable key de Staging.');
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
    } catch (error) {
      return null;
    }
  }

  function asegurarDestinoIndependiente(url) {
    const clientePrincipal = typeof supabaseClient !== 'undefined' ? supabaseClient : window.supabaseClient;
    const urlPrincipal = clientePrincipal?.supabaseUrl || clientePrincipal?.rest?.url?.replace(/\/rest\/v1\/?$/, '') || '';
    if (urlPrincipal && normalizarUrl(urlPrincipal) === normalizarUrl(url)) {
      throw new Error('La URL configurada coincide con el Supabase principal. Finanzas 5 sólo admite un proyecto de Staging independiente.');
    }
  }

  function configurarStagingLocal(opciones = {}) {
    if (!esEntornoLocal()) throw new Error('La configuración de Finanzas 5 sólo puede activarse desde localhost, 127.0.0.1 o file:.');
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
    try { await estadoUI.client?.auth?.signOut?.({ scope: 'local' }); } catch (error) {}
    window.localStorage.removeItem(CONFIG_STORAGE_KEY);
    window.localStorage.removeItem(AUTH_STORAGE_KEY);
    destruirCliente();
    limpiarDatosFinancieros();
    estadoUI.config = null;
    estadoUI.mensaje = 'Finanzas 5 Staging quedó desactivado en este navegador.';
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
    try { estadoUI.authSubscription?.unsubscribe?.(); } catch (error) {}
    try { estadoUI.client?.auth?.stopAutoRefresh?.(); } catch (error) {}
    estadoUI.authSubscription = null;
    estadoUI.client = null;
    estadoUI.session = null;
    estadoUI.accesoBackend = false;
  }

  function limpiarDatosFinancieros() {
    estadoUI.categorias = [];
    estadoUI.egresos = [];
    estadoUI.egresosPagadosPorFechaPago = [];
    estadoUI.auditoria = [];
    estadoUI.edicion = null;
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
        // La sesión owner de Staging no sobrevive una recarga ni puede quedar
        // disponible para otro rol frontend que use después este navegador.
        persistSession: false,
        autoRefreshToken: true,
        detectSessionInUrl: false
      }
    });
    const suscripcion = estadoUI.client.auth.onAuthStateChange((_evento, session) => {
      if (!frontendPuedeAcceder()) return;
      estadoUI.session = session || null;
      if (!session) {
        estadoUI.accesoBackend = false;
        limpiarDatosFinancieros();
        renderInterfaz();
      }
    });
    estadoUI.authSubscription = suscripcion?.data?.subscription || null;
    return estadoUI.client;
  }

  function esErrorAcceso(error) {
    const status = Number(error?.status || error?.statusCode || 0);
    const code = String(error?.code || '');
    const texto = `${error?.message || ''} ${error?.details || ''}`.toLowerCase();
    return status === 401 || status === 403 || ['42501', 'PGRST301', 'PGRST302'].includes(code)
      || texto.includes('permission denied') || texto.includes('row-level security') || texto.includes('jwt');
  }

  function mensajeError(error, fallback) {
    if (esErrorAcceso(error)) return 'Acceso denegado por Finanzas 5 en Staging. Verificá la sesión y el rol backend owner/admin.';
    return String(error?.message || fallback || 'No se pudo completar la operación.');
  }

  function negarAcceso(error) {
    estadoUI.accesoBackend = false;
    limpiarDatosFinancieros();
    estadoUI.mensaje = mensajeError(error, 'La cuenta de Staging no tiene acceso financiero.');
    estadoUI.tipoMensaje = 'error';
    renderInterfaz();
  }

  function fechasDelMes(desplazamiento = 0) {
    const ahora = new Date();
    const inicio = new Date(ahora.getFullYear(), ahora.getMonth() + desplazamiento, 1, 12);
    const fin = desplazamiento === 0
      ? ahora
      : new Date(ahora.getFullYear(), ahora.getMonth() + desplazamiento + 1, 0, 12);
    return { desde: fechaISO(inicio), hasta: fechaISO(fin) };
  }

  function fechaISO(fecha = new Date()) {
    const y = fecha.getFullYear();
    const m = String(fecha.getMonth() + 1).padStart(2, '0');
    const d = String(fecha.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function filtrosActuales() {
    const iniciales = fechasDelMes(0);
    return {
      desde: estadoUI.root?.querySelector('#finV5Desde')?.value || iniciales.desde,
      hasta: estadoUI.root?.querySelector('#finV5Hasta')?.value || iniciales.hasta,
      perfil: estadoUI.root?.querySelector('#finV5Profesional')?.value || ''
    };
  }

  function sumar(filas) {
    return (filas || []).reduce((total, fila) => total + numero(fila?.amount), 0);
  }

  function calcularResumenEgresos({ ingresos, egresos = [], egresosPagadosPorFechaPago = [] } = {}) {
    const vigentes = egresos.filter((item) => item?.status !== 'voided');
    const pagados = vigentes.filter((item) => item.status === 'paid');
    const pendientes = vigentes.filter((item) => item.status === 'pending');
    const caja = numero(ingresos?.cajaCobrada?.total);
    const aFacturar = numero(ingresos?.produccionAFacturar?.total);
    const ingresosOperativos = numero(ingresos?.ingresosOperativosEstimados?.total);
    const totalPagados = sumar(pagados);
    const totalPendientes = sumar(pendientes);
    const totalOperativos = totalPagados + totalPendientes;
    const pagosDeCaja = sumar((egresosPagadosPorFechaPago || []).filter((item) => item?.status === 'paid'));
    return {
      cajaCobrada: caja,
      produccionAFacturar: aFacturar,
      ingresosOperativosEstimados: ingresosOperativos,
      egresosPagados: totalPagados,
      egresosPendientes: totalPendientes,
      resultadoOperativoEstimado: ingresosOperativos - totalOperativos,
      resultadoCaja: caja - pagosDeCaja,
      egresosOperativos: totalOperativos,
      egresosPagadosPorFechaPago: pagosDeCaja
    };
  }

  async function consultarPaginas(crearConsulta) {
    const filas = [];
    for (let desde = 0; ; desde += PAGE_SIZE) {
      const { data, error } = await crearConsulta().range(desde, desde + PAGE_SIZE - 1);
      if (error) throw error;
      const pagina = Array.isArray(data) ? data : [];
      filas.push(...pagina);
      if (pagina.length < PAGE_SIZE) break;
    }
    return filas;
  }

  async function comprobarAccesoBackend() {
    const client = crearClienteStaging();
    if (!client || !estadoUI.session) return false;
    const { data, error } = await client.rpc('cardiolink_has_finance_access');
    if (error) throw error;
    if (data !== true) {
      const denegado = new Error('La cuenta autenticada no tiene finance_access en Staging.');
      denegado.status = 403;
      throw denegado;
    }
    estadoUI.accesoBackend = true;
    return true;
  }

  function aplicarFiltroProfesional(consulta, perfil) {
    return perfil ? consulta.eq('professional_id', perfil) : consulta;
  }

  async function cargarDatos() {
    if (!estadoUI.client || !estadoUI.session || !estadoUI.accesoBackend || estadoUI.cargando) return;
    const client = estadoUI.client;
    const filtros = filtrosActuales();
    if (!filtros.desde || !filtros.hasta || filtros.desde > filtros.hasta) {
      estadoUI.mensaje = 'Revisá el rango de fechas: “Desde” no puede ser posterior a “Hasta”.';
      estadoUI.tipoMensaje = 'error';
      renderInterfaz();
      return;
    }
    estadoUI.cargando = true;
    estadoUI.mensaje = '';
    renderInterfaz();
    try {
      const [categorias, egresos, egresosPagados] = await Promise.all([
        consultarPaginas(() => client.from(TABLAS.categorias)
          .select('id,parent_id,system_key,name,active,sort_order,revision')
          .order('sort_order', { ascending: true }).order('name', { ascending: true })),
        consultarPaginas(() => aplicarFiltroProfesional(client.from(TABLAS.egresos)
          .select('id,expense_date,category_id,concept,amount,beneficiary,payment_method,notes,professional_id,receipt_reference,status,paid_on,source_type,created_at,updated_at,voided_at,created_by,updated_by,voided_by,revision')
          .gte('expense_date', filtros.desde).lte('expense_date', filtros.hasta)
          .order('expense_date', { ascending: false }).order('created_at', { ascending: false }), filtros.perfil)),
        consultarPaginas(() => aplicarFiltroProfesional(client.from(TABLAS.egresos)
          .select('id,amount,status,paid_on,professional_id')
          .eq('status', 'paid').gte('paid_on', filtros.desde).lte('paid_on', filtros.hasta)
          .order('paid_on', { ascending: false }), filtros.perfil))
      ]);
      if (estadoUI.client !== client || !frontendPuedeAcceder()) return;
      estadoUI.categorias = categorias;
      estadoUI.egresos = egresos;
      estadoUI.egresosPagadosPorFechaPago = egresosPagados;
      estadoUI.mensaje = '';
    } catch (error) {
      if (esErrorAcceso(error)) return negarAcceso(error);
      estadoUI.mensaje = mensajeError(error, 'No se pudieron cargar los egresos.');
      estadoUI.tipoMensaje = 'error';
    } finally {
      estadoUI.cargando = false;
      renderInterfaz();
    }
  }

  async function cargarAuditoria() {
    if (!estadoUI.client || !estadoUI.session || !estadoUI.accesoBackend || estadoUI.cargando) return;
    const client = estadoUI.client;
    estadoUI.cargando = true;
    estadoUI.mensaje = '';
    renderInterfaz();
    try {
      const { data, error } = await client.from(TABLAS.auditoria)
        .select('id,entity_type,entity_id,action,before_data,after_data,actor_id,actor_label,created_at')
        .order('created_at', { ascending: false }).limit(300);
      if (error) throw error;
      if (estadoUI.client !== client || !frontendPuedeAcceder()) return;
      estadoUI.auditoria = Array.isArray(data) ? data : [];
    } catch (error) {
      if (esErrorAcceso(error)) return negarAcceso(error);
      estadoUI.mensaje = mensajeError(error, 'No se pudo cargar el historial.');
      estadoUI.tipoMensaje = 'error';
    } finally {
      estadoUI.cargando = false;
      renderInterfaz();
    }
  }

  function perfilesDisponibles() {
    const datosApp = typeof data !== 'undefined' ? data : window.data;
    const lista = Array.isArray(datosApp?.profesionales) ? datosApp.profesionales : [];
    return lista.filter((item) => item && item.id && item.id !== 'general');
  }

  function escapar(valor) {
    return String(valor ?? '').replace(/[&<>"']/g, (caracter) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[caracter]);
  }

  function dinero(valor) {
    return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 2 }).format(numero(valor));
  }

  function fechaVisible(valor, conHora = false) {
    if (!valor) return '—';
    const fecha = conHora ? new Date(valor) : new Date(`${valor}T12:00:00`);
    if (Number.isNaN(fecha.getTime())) return escapar(valor);
    return fecha.toLocaleString('es-AR', conHora
      ? { dateStyle: 'short', timeStyle: 'short' }
      : { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  function nombreProfesional(id) {
    if (!id) return 'General';
    return perfilesDisponibles().find((item) => String(item.id) === String(id))?.nombre || id;
  }

  function categoriaPorId(id) {
    return estadoUI.categorias.find((item) => item.id === id) || null;
  }

  function rutaCategoria(id) {
    const categoria = categoriaPorId(id);
    if (!categoria) return 'Categoría no disponible';
    const padre = categoria.parent_id ? categoriaPorId(categoria.parent_id) : null;
    return padre ? `${padre.name} / ${categoria.name}` : categoria.name;
  }

  function opcionesProfesional(seleccionado = '') {
    return `<option value="">General / sin asignar</option>${perfilesDisponibles().map((item) =>
      `<option value="${escapar(item.id)}"${String(item.id) === String(seleccionado) ? ' selected' : ''}>${escapar(item.nombre)}</option>`
    ).join('')}`;
  }

  function estadoEtiqueta(status) {
    return ({ pending: 'Pendiente', paid: 'Pagado', voided: 'Anulado' })[status] || status;
  }

  function ingresosActuales() {
    const filtros = filtrosActuales();
    try {
      return obtenerIngresos({ desde: filtros.desde, hasta: filtros.hasta, perfil: filtros.perfil });
    } catch (error) {
      return null;
    }
  }

  function renderResumen() {
    const ingresos = ingresosActuales();
    if (!ingresos) return '<div class="fin-v5-aviso fin-v5-aviso-error">El proveedor canónico de ingresos todavía no está disponible para este perfil.</div>';
    const resumen = calcularResumenEgresos({
      ingresos,
      egresos: estadoUI.egresos,
      egresosPagadosPorFechaPago: estadoUI.egresosPagadosPorFechaPago
    });
    const tarjetas = [
      ['Caja cobrada', resumen.cajaCobrada, 'Ingresos efectivamente cobrados del proveedor canónico.'],
      ['Producción a facturar', resumen.produccionAFacturar, 'OS/prepagas y terceros estimados.'],
      ['Ingresos operativos estimados', resumen.ingresosOperativosEstimados, 'Caja cobrada + producción a facturar.'],
      ['Egresos pagados', resumen.egresosPagados, 'Egresos pagados cuya fecha del egreso está en el período.'],
      ['Egresos pendientes', resumen.egresosPendientes, 'Egresos pendientes cuya fecha del egreso está en el período.'],
      ['Resultado operativo estimado', resumen.resultadoOperativoEstimado, 'Ingresos operativos estimados − egresos no anulados del período.'],
      ['Resultado de caja', resumen.resultadoCaja, 'Caja cobrada − egresos pagados según paid_on en el período.']
    ];
    return `<div class="fin-v5-resumen">${tarjetas.map(([titulo, valor, nota], indice) =>
      `<article class="fin-v5-kpi ${indice > 4 && valor < 0 ? 'es-negativo' : ''}"><span>${escapar(titulo)}</span><strong>${dinero(valor)}</strong><small>${escapar(nota)}</small></article>`
    ).join('')}</div>`;
  }

  function renderTablaEgresos() {
    if (!estadoUI.egresos.length) return '<div class="fin-v5-vacio">No hay egresos registrados para los filtros elegidos.</div>';
    const filas = estadoUI.egresos.map((item) => {
      const anulado = item.status === 'voided';
      return `<tr class="fin-v5-fila fin-v5-estado-${escapar(item.status)}">
        <td data-label="Fecha">${fechaVisible(item.expense_date)}</td>
        <td data-label="Categoría">${escapar(rutaCategoria(item.category_id))}</td>
        <td data-label="Concepto"><strong>${escapar(item.concept)}</strong>${item.receipt_reference ? `<small>Comprobante: ${escapar(item.receipt_reference)}</small>` : ''}</td>
        <td data-label="Beneficiario">${escapar(item.beneficiary || '—')}</td>
        <td data-label="Estado"><span class="fin-v5-chip fin-v5-chip-${escapar(item.status)}">${escapar(estadoEtiqueta(item.status))}</span>${item.paid_on ? `<small>Pago: ${fechaVisible(item.paid_on)}</small>` : ''}</td>
        <td data-label="Profesional">${escapar(nombreProfesional(item.professional_id))}</td>
        <td data-label="Monto" class="fin-v5-monto">${dinero(item.amount)}</td>
        <td data-label="Acciones" class="fin-v5-acciones">${anulado
          ? '<span class="fin-v5-inmutable">Sin edición</span>'
          : `<button type="button" class="secondary small-btn" data-fin-v5-action="editar" data-id="${escapar(item.id)}">Editar</button><button type="button" class="small-btn fin-v5-btn-anular" data-fin-v5-action="anular" data-id="${escapar(item.id)}">Anular</button>`}</td>
      </tr>`;
    }).join('');
    return `<div class="fin-v5-tabla-wrap"><table class="fin-v5-tabla"><thead><tr><th>Fecha</th><th>Categoría / subcategoría</th><th>Concepto</th><th>Beneficiario</th><th>Estado</th><th>Profesional</th><th>Monto</th><th>Acciones</th></tr></thead><tbody>${filas}</tbody></table></div>`;
  }

  function descripcionAuditoria(evento) {
    const datos = evento.after_data || evento.before_data || {};
    const accion = ({ created: 'Creó', updated: 'Editó', status_changed: 'Cambió el estado de', voided: 'Anuló' })[evento.action] || evento.action;
    const entidad = ({ expense: 'egreso', category: 'categoría', recurring_template: 'plantilla' })[evento.entity_type] || evento.entity_type;
    const concepto = datos.concept || datos.name || 'Sin concepto';
    const monto = datos.amount != null ? dinero(datos.amount) : '';
    return { accion, entidad, concepto, monto };
  }

  function renderAuditoria() {
    if (!estadoUI.auditoria.length) return '<div class="fin-v5-vacio">No hay eventos de auditoría disponibles.</div>';
    return `<div class="fin-v5-historial">${estadoUI.auditoria.map((evento) => {
      const detalle = descripcionAuditoria(evento);
      return `<article><div><strong>${escapar(detalle.accion)} ${escapar(detalle.entidad)}</strong><span>${escapar(detalle.concepto)}</span></div><div class="fin-v5-historial-meta">${detalle.monto ? `<strong>${detalle.monto}</strong>` : ''}<span>${fechaVisible(evento.created_at, true)}</span><span>${escapar(evento.actor_label || evento.actor_id || 'Actor no identificado')}</span></div></article>`;
    }).join('')}</div>`;
  }

  function renderFiltros() {
    const filtros = filtrosActuales();
    return `<div class="fin-v5-filtros">
      <div class="fin-v5-atajos" role="group" aria-label="Períodos rápidos"><button type="button" class="secondary" data-fin-v5-periodo="hoy">Hoy</button><button type="button" class="secondary" data-fin-v5-periodo="actual">Mes actual</button><button type="button" class="secondary" data-fin-v5-periodo="anterior">Mes anterior</button><button type="button" class="secondary" data-fin-v5-periodo="personalizado">Personalizado</button></div>
      <label>Desde<input id="finV5Desde" type="date" value="${escapar(filtros.desde)}"></label>
      <label>Hasta<input id="finV5Hasta" type="date" value="${escapar(filtros.hasta)}"></label>
      <label>Profesional<select id="finV5Profesional"><option value="">Todos</option>${perfilesDisponibles().map((item) => `<option value="${escapar(item.id)}"${String(item.id) === filtros.perfil ? ' selected' : ''}>${escapar(item.nombre)}</option>`).join('')}</select></label>
      <button type="button" class="primary" data-fin-v5-action="aplicar">Aplicar filtros</button>
    </div>`;
  }

  function renderContenidoAutenticado() {
    return `${renderFiltros()}
      <div class="fin-v5-barra"><div class="fin-v5-tabs" role="tablist"><button type="button" class="${estadoUI.vista === 'egresos' ? 'activo' : ''}" data-fin-v5-vista="egresos">Egresos</button><button type="button" class="${estadoUI.vista === 'historial' ? 'activo' : ''}" data-fin-v5-vista="historial">Historial</button></div><div><button type="button" class="secondary" data-fin-v5-action="actualizar">Actualizar</button><button type="button" class="primary" data-fin-v5-action="nuevo">Nuevo egreso</button></div></div>
      ${estadoUI.vista === 'egresos' ? `${renderResumen()}${renderTablaEgresos()}` : renderAuditoria()}`;
  }

  function renderInterfaz() {
    const root = estadoUI.root;
    if (!root || !root.isConnected) return;
    const config = estadoUI.config || leerConfigLocal();
    const host = config ? new URL(config.url).host : '';
    const mensaje = estadoUI.mensaje ? `<div class="fin-v5-aviso fin-v5-aviso-${escapar(estadoUI.tipoMensaje || 'info')}" role="status">${escapar(estadoUI.mensaje)}</div>` : '';
    const sesionEmail = estadoUI.session?.user?.email || '';
    root.innerHTML = `<div class="fin-v5-encabezado"><div><div class="fin-v5-titulo-linea"><h2>Finanzas 5</h2>${config ? '<span class="fin-v5-staging-badge">STAGING LOCAL</span>' : '<span class="fin-v5-inactivo-badge">DESACTIVADO</span>'}</div><p>Ingresos canónicos de Finanzas 4 y egresos auditables de Finanzas 5.</p></div>${config ? `<div class="fin-v5-destino"><span>Proyecto aislado</span><strong>${escapar(host)}</strong></div>` : ''}</div>
      ${mensaje}
      ${!config ? '<div class="fin-v5-desactivado"><strong>Finanzas 5 no está conectado.</strong><p>No se creó ningún cliente ni se realizó ninguna consulta. La activación local está documentada en <code>docs/FINANZAS_V5_STAGING.md</code>.</p></div>' : ''}
      ${config && !estadoUI.session ? `<form id="finV5Login" class="fin-v5-login"><div><strong>Sesión independiente de Staging</strong><p>Ingresá con una cuenta Auth del proyecto de Staging. La contraseña no se guarda en el módulo.</p></div><label>Email<input name="email" type="email" autocomplete="username" required></label><label>Contraseña<input name="password" type="password" autocomplete="current-password" required></label><button class="primary" type="submit">Ingresar a Staging</button></form>` : ''}
      ${config && estadoUI.session ? `<div class="fin-v5-sesion"><span>Sesión Staging: <strong>${escapar(sesionEmail)}</strong></span><button type="button" class="secondary" data-fin-v5-action="salir">Cerrar sesión Staging</button></div>` : ''}
      ${config && estadoUI.session && !estadoUI.accesoBackend && !estadoUI.mensaje ? `<div class="fin-v5-desactivado"><strong>Validando acceso financiero backend…</strong></div>` : ''}
      ${config && estadoUI.session && estadoUI.accesoBackend ? renderContenidoAutenticado() : ''}
      ${estadoUI.cargando ? '<div class="fin-v5-cargando" aria-live="polite">Actualizando Finanzas 5…</div>' : ''}
      <dialog id="finV5Dialog" class="fin-v5-dialog"></dialog>`;
    enlazarFormularioLogin();
  }

  function montarInterfaz() {
    if (!hayNavegador() || !esEntornoLocal()) return false;
    const caja = document.getElementById('caja');
    if (!caja) return false;
    if (!frontendPuedeAcceder()) {
      const rootExistente = document.getElementById('cardiolinkFinanzasV5');
      if (rootExistente || estadoUI.client) {
        destruirCliente();
        limpiarDatosFinancieros();
      }
      rootExistente?.remove();
      estadoUI.root = null;
      return false;
    }
    let root = document.getElementById('cardiolinkFinanzasV5');
    if (!root) {
      root = document.createElement('section');
      root.id = 'cardiolinkFinanzasV5';
      root.className = 'card cardiolink-finanzas-v5';
      caja.appendChild(root);
      enlazarEventos(root);
    }
    estadoUI.root = root;
    estadoUI.config = leerConfigLocal();
    renderInterfaz();
    if (estadoUI.config && !estadoUI.client) iniciarSesionExistente();
    return true;
  }

  async function iniciarSesionExistente() {
    try {
      const client = crearClienteStaging();
      if (!client) return;
      const { data, error } = await client.auth.getSession();
      if (error) throw error;
      estadoUI.session = data?.session || null;
      renderInterfaz();
      if (estadoUI.session) {
        await comprobarAccesoBackend();
        await cargarDatos();
      }
    } catch (error) {
      if (esErrorAcceso(error)) return negarAcceso(error);
      estadoUI.mensaje = mensajeError(error, 'No se pudo iniciar Finanzas 5 Staging.');
      estadoUI.tipoMensaje = 'error';
      renderInterfaz();
    }
  }

  function enlazarFormularioLogin() {
    const form = estadoUI.root?.querySelector('#finV5Login');
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
        const { data, error } = await client.auth.signInWithPassword({ email, password });
        if (error) throw error;
        if (estadoUI.client !== client || !frontendPuedeAcceder()) return;
        estadoUI.session = data?.session || null;
        await comprobarAccesoBackend();
        estadoUI.cargando = false;
        await cargarDatos();
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

  function aplicarPeriodo(periodo) {
    let fechas = fechasDelMes(0);
    if (periodo === 'hoy') fechas = { desde: fechaISO(), hasta: fechaISO() };
    if (periodo === 'anterior') fechas = fechasDelMes(-1);
    if (periodo === 'personalizado') {
      estadoUI.root?.querySelector('#finV5Desde')?.focus();
      return;
    }
    const desde = estadoUI.root?.querySelector('#finV5Desde');
    const hasta = estadoUI.root?.querySelector('#finV5Hasta');
    if (desde) desde.value = fechas.desde;
    if (hasta) hasta.value = fechas.hasta;
    cargarDatos();
  }

  function categoriasFormulario(item) {
    const actual = item ? categoriaPorId(item.category_id) : null;
    const idRaizActual = actual?.parent_id || actual?.id || '';
    const raices = estadoUI.categorias.filter((categoria) => !categoria.parent_id && (categoria.active || categoria.id === idRaizActual));
    return { actual, idRaizActual, raices };
  }

  function opcionesSubcategorias(idRaiz, seleccionado = '') {
    const opciones = estadoUI.categorias.filter((categoria) => categoria.parent_id === idRaiz && (categoria.active || categoria.id === seleccionado));
    return `<option value="">Sin subcategoría</option>${opciones.map((categoria) => `<option value="${escapar(categoria.id)}"${categoria.id === seleccionado ? ' selected' : ''}>${escapar(categoria.name)}${categoria.active ? '' : ' (inactiva)'}</option>`).join('')}`;
  }

  function abrirFormulario(item = null) {
    if (item?.status === 'voided') {
      estadoUI.mensaje = 'Los egresos anulados son inmutables y no se pueden editar.';
      estadoUI.tipoMensaje = 'error';
      renderInterfaz();
      return;
    }
    const dialog = estadoUI.root?.querySelector('#finV5Dialog');
    if (!dialog) return;
    estadoUI.edicion = item ? { id: item.id, revision: item.revision } : null;
    const categorias = categoriasFormulario(item);
    const status = item?.status || 'pending';
    dialog.innerHTML = `<form id="finV5ExpenseForm" method="dialog" class="fin-v5-form"><div class="fin-v5-form-head"><div><h3>${item ? 'Editar egreso' : 'Nuevo egreso'}</h3><p>${item ? `Revisión ${escapar(item.revision)}` : 'Origen manual · el backend registra autor y revisión.'}</p></div><button type="button" class="fin-v5-cerrar" data-fin-v5-action="cerrar" aria-label="Cerrar">×</button></div>
      <div class="fin-v5-form-grid">
        <label>Fecha del egreso<input name="expense_date" type="date" value="${escapar(item?.expense_date || fechaISO())}" required></label>
        <label>Categoría<select name="category_root" required><option value="">Elegir…</option>${categorias.raices.map((categoria) => `<option value="${escapar(categoria.id)}"${categoria.id === categorias.idRaizActual ? ' selected' : ''}>${escapar(categoria.name)}${categoria.active ? '' : ' (inactiva)'}</option>`).join('')}</select></label>
        <label>Subcategoría<select name="category_child">${opcionesSubcategorias(categorias.idRaizActual, categorias.actual?.parent_id ? categorias.actual.id : '')}</select></label>
        <label class="fin-v5-span-2">Concepto<input name="concept" maxlength="240" value="${escapar(item?.concept || '')}" required></label>
        <label>Monto<input name="amount" type="number" min="0.01" step="0.01" value="${item?.amount != null ? escapar(item.amount) : ''}" required></label>
        <label>Beneficiario (opcional)<input name="beneficiary" maxlength="240" value="${escapar(item?.beneficiary || '')}"></label>
        <label>Forma de pago (opcional)<select name="payment_method"><option value="">Sin informar</option>${['Efectivo', 'Transferencia', 'Débito', 'Crédito', 'Otro'].map((valor) => `<option value="${valor}"${item?.payment_method === valor ? ' selected' : ''}>${valor}</option>`).join('')}</select></label>
        <label>Estado<select name="status"><option value="pending"${status === 'pending' ? ' selected' : ''}>Pendiente</option><option value="paid"${status === 'paid' ? ' selected' : ''}>Pagado</option></select></label>
        <label>Fecha de pago<input name="paid_on" type="date" value="${escapar(item?.paid_on || '')}"${status === 'paid' ? ' required' : ' disabled'}></label>
        <label>Profesional (opcional)<select name="professional_id">${opcionesProfesional(item?.professional_id || '')}</select></label>
        <label>Referencia de comprobante (opcional)<input name="receipt_reference" maxlength="240" value="${escapar(item?.receipt_reference || '')}"></label>
        <label class="fin-v5-span-2">Notas (opcional)<textarea name="notes" rows="3" maxlength="2000">${escapar(item?.notes || '')}</textarea></label>
      </div><div class="fin-v5-form-actions"><button type="button" class="secondary" data-fin-v5-action="cerrar">Cancelar</button><button type="submit" class="primary">${item ? 'Guardar cambios' : 'Crear egreso'}</button></div></form>`;
    const form = dialog.querySelector('#finV5ExpenseForm');
    form.querySelector('[name="category_root"]').addEventListener('change', (event) => {
      form.querySelector('[name="category_child"]').innerHTML = opcionesSubcategorias(event.target.value, '');
    });
    form.querySelector('[name="status"]').addEventListener('change', (event) => {
      const paidOn = form.querySelector('[name="paid_on"]');
      const pagado = event.target.value === 'paid';
      paidOn.disabled = !pagado;
      paidOn.required = pagado;
      if (!pagado) paidOn.value = '';
      if (pagado && !paidOn.value) paidOn.value = fechaISO();
    });
    form.addEventListener('submit', guardarFormulario);
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }

  function cerrarFormulario() {
    const dialog = estadoUI.root?.querySelector('#finV5Dialog');
    if (!dialog) return;
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
    estadoUI.edicion = null;
  }

  function textoONull(valor) {
    const texto = String(valor || '').trim();
    return texto || null;
  }

  async function guardarFormulario(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const valores = new FormData(form);
    const status = String(valores.get('status') || 'pending');
    const paidOn = String(valores.get('paid_on') || '');
    const categoryId = String(valores.get('category_child') || valores.get('category_root') || '');
    const amount = Number(valores.get('amount'));
    if (!categoryId || !(amount > 0) || (status === 'paid' && !paidOn)) {
      estadoUI.mensaje = 'Completá categoría, monto y fecha de pago cuando el estado sea Pagado.';
      estadoUI.tipoMensaje = 'error';
      renderInterfaz();
      return;
    }
    const payload = {
      expense_date: String(valores.get('expense_date') || ''),
      category_id: categoryId,
      concept: String(valores.get('concept') || '').trim(),
      amount,
      beneficiary: textoONull(valores.get('beneficiary')),
      payment_method: textoONull(valores.get('payment_method')),
      status,
      paid_on: status === 'paid' ? paidOn : null,
      professional_id: textoONull(valores.get('professional_id')),
      receipt_reference: textoONull(valores.get('receipt_reference')),
      notes: textoONull(valores.get('notes'))
    };
    estadoUI.cargando = true;
    renderInterfaz();
    try {
      if (estadoUI.edicion) {
        const { data, error } = await estadoUI.client.from(TABLAS.egresos).update(payload)
          .eq('id', estadoUI.edicion.id).eq('revision', estadoUI.edicion.revision).select('id,revision');
        if (error) throw error;
        if (!Array.isArray(data) || data.length === 0) throw Object.assign(new Error(CONFLICT_MESSAGE), { conflict: true });
        estadoUI.mensaje = 'Egreso actualizado correctamente.';
      } else {
        const { error } = await estadoUI.client.from(TABLAS.egresos)
          .insert({ ...payload, source_type: 'manual' }).select('id,revision').single();
        if (error) throw error;
        estadoUI.mensaje = 'Egreso creado correctamente.';
      }
      estadoUI.tipoMensaje = 'ok';
      cerrarFormulario();
      estadoUI.cargando = false;
      await cargarDatos();
    } catch (error) {
      if (esErrorAcceso(error)) return negarAcceso(error);
      estadoUI.mensaje = error?.conflict ? CONFLICT_MESSAGE : mensajeError(error, 'No se pudo guardar el egreso.');
      estadoUI.tipoMensaje = 'error';
    } finally {
      estadoUI.cargando = false;
      renderInterfaz();
    }
  }

  async function anularEgreso(item) {
    if (!item || item.status === 'voided') return;
    if (!window.confirm(`¿Anular el egreso “${item.concept}” por ${dinero(item.amount)}?\n\nLa anulación es permanente, conserva la fecha de pago histórica y queda auditada.`)) return;
    estadoUI.cargando = true;
    estadoUI.mensaje = '';
    renderInterfaz();
    try {
      const { data, error } = await estadoUI.client.from(TABLAS.egresos)
        .update({ status: 'voided' }).eq('id', item.id).eq('revision', item.revision).select('id,revision,status,paid_on,voided_at,voided_by');
      if (error) throw error;
      if (!Array.isArray(data) || data.length === 0) throw Object.assign(new Error(CONFLICT_MESSAGE), { conflict: true });
      estadoUI.mensaje = 'Egreso anulado. Se preservó su trazabilidad histórica.';
      estadoUI.tipoMensaje = 'ok';
      estadoUI.cargando = false;
      await cargarDatos();
    } catch (error) {
      if (esErrorAcceso(error)) return negarAcceso(error);
      estadoUI.mensaje = error?.conflict ? CONFLICT_MESSAGE : mensajeError(error, 'No se pudo anular el egreso.');
      estadoUI.tipoMensaje = 'error';
    } finally {
      estadoUI.cargando = false;
      renderInterfaz();
    }
  }

  function enlazarEventos(root) {
    if (root.dataset.finV5Enlazado) return;
    root.dataset.finV5Enlazado = 'true';
    root.addEventListener('click', async (event) => {
      if (estadoUI.cargando) return;
      const periodo = event.target.closest?.('[data-fin-v5-periodo]')?.dataset.finV5Periodo;
      if (periodo) return aplicarPeriodo(periodo);
      const vista = event.target.closest?.('[data-fin-v5-vista]')?.dataset.finV5Vista;
      if (vista) {
        estadoUI.vista = vista;
        renderInterfaz();
        if (vista === 'historial') cargarAuditoria();
        return;
      }
      const boton = event.target.closest?.('[data-fin-v5-action]');
      if (!boton) return;
      const accion = boton.dataset.finV5Action;
      if (accion === 'aplicar' || accion === 'actualizar') return estadoUI.vista === 'historial' ? cargarAuditoria() : cargarDatos();
      if (accion === 'nuevo') return abrirFormulario();
      if (accion === 'cerrar') return cerrarFormulario();
      if (accion === 'editar') return abrirFormulario(estadoUI.egresos.find((item) => item.id === boton.dataset.id));
      if (accion === 'anular') return anularEgreso(estadoUI.egresos.find((item) => item.id === boton.dataset.id));
      if (accion === 'salir') {
        estadoUI.cargando = true;
        renderInterfaz();
        try { await estadoUI.client.auth.signOut({ scope: 'local' }); } finally {
          estadoUI.session = null;
          estadoUI.accesoBackend = false;
          estadoUI.cargando = false;
          limpiarDatosFinancieros();
          renderInterfaz();
        }
      }
    });
  }

  function iniciarIntegracionLocal() {
    if (!hayNavegador() || !esEntornoLocal()) return;
    const intentar = () => montarInterfaz();
    document.addEventListener('click', (event) => {
      if (event.target.closest?.('.nav[data-section="caja"]')) window.setTimeout(intentar, 160);
    }, true);
    const observadorRol = new MutationObserver(() => window.setTimeout(intentar, 0));
    observadorRol.observe(document.body, { attributes: true, attributeFilter: ['data-rol', 'data-usuario'] });
    window.setTimeout(intentar, 800);
    window.setTimeout(intentar, 1800);
  }

  const api = Object.freeze({
    version: '5.0.0-etapa-3a',
    calcularIngresosCanonicos,
    calcularResumenEgresos,
    conectarProveedor,
    puedeAcceder,
    obtenerIngresos,
    diagnostico,
    configurarStagingLocal,
    desactivarStagingLocal,
    estadoStagingLocal,
    refrescarInterfaz: montarInterfaz,
    CONFLICT_MESSAGE
  });

  if (hayNavegador()) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciarIntegracionLocal, { once: true });
    else iniciarIntegracionLocal();
  }

  return api;
});
