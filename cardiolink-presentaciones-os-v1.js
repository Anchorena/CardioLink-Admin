/* CardioLink · FACTURACIÓN MENSUAL V1 · Bloque 1 · PRESENTACIONES A OBRAS SOCIALES · interfaz + acceso a datos
 *
 * Módulo independiente (NO modifica app.js, ni cardiolink_atenciones, ni su sincronización, ni Caja/Colocaciones/Finanzas). Cargar DESPUÉS de cardiolink-presentaciones-os-core.js y de app.js.
 * Sección «Presentaciones a obras sociales» (grupo Administrativo): prepara sola la lista de prestaciones realizadas, facturables y todavía no presentadas (las del mes y las de meses anteriores),
 * permite dejar afuera excepciones sin tildar una por una y confirma el lote UNA sola vez. Registra fecha, usuario e importe presentado; la fecha de producción no se toca.
 * Lo anterior al inicio del control (01/12/2026) NO se da por facturado: no se ofrece solo, pero se puede incorporar a mano como EXCEPCIÓN (p. ej. bonos pendientes de presentación), con motivo y su fecha original.
 *
 * Persistencia (docs/propuestas/pending_review_facturacion_presentaciones_v1.sql, NO aplicada todavía): tablas cardiolink_presentaciones_os_v1 / _items_v1 / _control_v1 y RPC
 * cardiolink_presentacion_os_confirmar_v1 / _control_v1. Sin esas tablas la sección avisa que la función todavía no está habilitada y no ofrece ninguna acción.
 * CIERRE DEL CÍRCULO MÉDICO (SQL docs/propuestas/pending_review_presentaciones_os_cierre_25_v1.sql): corte habitual el 25 (período = del 26 del mes anterior al 25 del mes), corte editable, fecha EFECTIVA de presentación elegida por quien confirma y
 * tres fechas siempre separadas (atención / período / presentación). Sin ese SQL la pantalla funciona como antes. Lo pendiente de períodos anteriores sigue apareciendo solo. Nunca duplica (índice único por atención).
 * La autorización REAL vive en el servidor (RLS por profesional + asociaciones de Secretaría + RPC). Lo que decide la pantalla solo evita ofrecer lo que el servidor rechazaría. */
(function () {
  'use strict';
  if (window.CardioLinkPresentacionesV1) return;
  const Core = window.CardioLinkPresentacionesCoreV1;
  if (!Core) { try { console.warn('Presentaciones a obras sociales: falta el núcleo; la sección no se habilita.'); } catch (e) { /* sin consola */ } return; }

  const SECCION = 'presentacionesOS';
  const T_ITEMS = 'cardiolink_presentaciones_os_items_v1', T_PRES = 'cardiolink_presentaciones_os_v1', T_CONTROL = 'cardiolink_presentaciones_os_control_v1', T_DELEG = 'cardiolink_presentaciones_os_delegaciones_v1';

  // ---------------------------------------------------------------- utilidades
  const g = (name) => {
    try {
      switch (name) {
        case 'supabaseClient': return typeof supabaseClient !== 'undefined' ? supabaseClient : undefined;
        case 'usuarioSupabase': return typeof usuarioSupabase !== 'undefined' ? usuarioSupabase : undefined;
        case 'data': return typeof data !== 'undefined' ? data : undefined;
        case 'atenciones': return typeof atenciones !== 'undefined' ? atenciones : undefined;
        default: return window[name];
      }
    } catch (e) { return undefined; }
  };
  const sb = () => g('supabaseClient') || null;
  const usuarioId = () => { const u = g('usuarioSupabase'); return u && u.id ? String(u.id) : ''; };
  const rolEs = (fn) => { try { const f = g(fn); return typeof f === 'function' && !!f(); } catch (e) { return false; } };
  const esOwnerAdmin = () => rolEs('esMatiasDuenio') || rolEs('esAdminComun');
  const esMedicoRol = () => rolEs('esMedico');
  const esSecretariaRol = () => rolEs('esSecretaria');
  const puedeVer = () => esOwnerAdmin() || esMedicoRol() || esSecretariaRol();
  const puedeConfirmar = () => esOwnerAdmin() || esSecretariaRol();                       // el médico solo mira
  const norm = Core.norm;
  const hoyIso = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const fmtFecha = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? m[3] + '/' + m[2] + '/' + m[1] : String(iso || ''); };
  const fmtMes = (ym) => { const m = /^(\d{4})-(\d{2})$/.exec(String(ym || '')); if (!m) return String(ym || ''); try { return new Date(Number(m[1]), Number(m[2]) - 1, 1, 12).toLocaleDateString('es-AR', { month: 'long', year: 'numeric' }); } catch (e) { return ym; } };
  const money = (n) => { try { return '$ ' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); } catch (e) { return '$ ' + Number(n || 0).toFixed(2); } };
  const fmtFechaHora = (ts) => { try { return new Date(ts).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }); } catch (e) { return String(ts || ''); } };
  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (v == null || v === false) return;
      if (k === 'className') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    });
    [].concat(children == null ? [] : children).forEach((c) => { if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c))); });
    return n;
  }
  const profesionales = () => { try { const d = g('data'); return ((d && d.profesionales) || []).filter((p) => p && p.id && p.id !== 'general'); } catch (e) { return []; } };
  const nombreProfesional = (id) => { const p = profesionales().find((x) => String(x.id) === String(id)); return (p && p.nombre) || String(id || ''); };

  // ---------------------------------------------------------------- reglas de negocio ya existentes (idénticas a Finanzas V5; app.js no las expone)
  // Arancel a PRESENTAR: solo el FIJADO en la atención (arancelId + valorArancelEstimado > 0), el mismo criterio que exige el servidor (PR412). Particular/PAMI = 0.
  // Sin arancel fijado no hay importe: la prestación queda en «sin arancel» (incidencias pendientes) y no se calcula ninguno por tabla ni se carga a mano.
  function arancelDe(a) {
    if (['particular', 'pami'].includes(norm(a.obraSocial))) return 0;
    const v = Number(a.valorArancelEstimado);
    return (String(a.arancelId || '').trim() && Number.isFinite(v) && v > 0) ? v : 0;
  }
  // isFacturaOtro411C: la facturación la hace otro profesional/destino.
  function esFacturaTercero(a, pid) {
    if (!a || !pid) return false;
    if (pid === 'matias') { try { const f = g('esRegistroFacturaRogelio'); return typeof f === 'function' && !!f(a); } catch (e) { return false; } }
    const d = g('data'), prof = ((d && d.profesionales) || []).find((p) => p.id === pid), destino = String(a.destinoFacturacionEstimado || a.prestacionA || '');
    return !!(destino && prof && norm(destino) !== norm(prof.nombre) && norm(destino) !== 'no aplica');
  }

  // Profesionales autorizados de Secretaría (RPC existente de Seguridad clínica V1); null = no se pudo consultar (el servidor decide).
  let autorizados = { uid: null, lista: null };
  async function profesionalesAutorizados() {
    if (!esSecretariaRol()) return null;
    try {
      const uid = usuarioId();
      if (autorizados.uid === uid && Array.isArray(autorizados.lista)) return autorizados.lista;
      const { data: lista, error } = await sb().rpc('cardiolink_profesionales_autorizados_secretaria_v1');
      if (error || !Array.isArray(lista)) return null;
      autorizados = { uid, lista: lista.map(String) };
      return autorizados.lista;
    } catch (e) { return null; }
  }
  async function profesionalesPermitidos() {
    if (esOwnerAdmin()) return null;                                          // todos
    if (esSecretariaRol()) { const l = await profesionalesAutorizados(); return l || []; }
    if (esMedicoRol()) { try { const f = g('profesionalIdUsuarioActual'); const id = typeof f === 'function' ? String(f() || '') : ''; return id ? [id] : []; } catch (e) { return []; } }   // mismo criterio que Copias para facturación
    return [];
  }

  // ---------------------------------------------------------------- acceso a datos (Supabase) · intercambiable para pruebas
  async function leerTodoItems() {
    const cp = window.cardiolinkCargaPaginadaV1;
    if (cp) { const r = await cp.leerTodo({ sb: sb(), tabla: T_ITEMS, columnas: 'id,atencion_id', clave: 'id', dedup: 'presentaciones-items' }); if (r.error) throw r.error; return r.data || []; }
    const r = await sb().from(T_ITEMS).select('id,atencion_id', { count: 'exact' });
    if (r.error) throw r.error;
    if (typeof r.count !== 'number' || (r.data || []).length < r.count) throw new Error('Lectura incompleta de las prestaciones presentadas.');
    return r.data || [];
  }
  const almacenSupabase = {
    async leerControl() { const r = await sb().from(T_CONTROL).select('fecha_inicio').maybeSingle(); if (r.error) throw r.error; return r.data ? r.data.fecha_inicio : null; },
    // Delegaciones de facturación (SQL complementario _terceros). null = la base todavía no las tiene: la pantalla funciona como en la V1 (lo que factura otro queda aparte).
    async leerDelegaciones() { const r = await sb().from(T_DELEG).select('realiza_professional_id,destino_norm,facturante_professional_id,activa'); if (r.error) { if (noHabilitada(r.error)) return null; throw r.error; } return r.data || []; },
    async guardarControl(fecha) { const r = await sb().rpc('cardiolink_presentacion_os_control_v1', { p_fecha: fecha }); if (r.error) throw r.error; return r.data; },
    async leerPresentados() { return (await leerTodoItems()).map((x) => String(x.atencion_id)); },
    // Cierre del Círculo (SQL _cierre_25): columnas fecha_corte / fecha_presentacion. Sin ellas la pantalla funciona como antes (cierre = último día del mes, sin fecha de presentación elegida).
    async cierreDisponible() { const r = await sb().from(T_PRES).select('fecha_corte,fecha_presentacion').limit(1); if (r.error) { if (r.error.code === '42703' || /fecha_corte|fecha_presentacion|does not exist/i.test(String(r.error.message || ''))) return false; throw r.error; } return true; },
    async leerHistorial(conCierre) { const r = await sb().from(T_PRES).select('id,cobertura,professional_id,periodo,cantidad,total_importe,presentado_en,presentado_por_email,presentado_por_rol' + (conCierre ? ',fecha_corte,fecha_presentacion' : '')).order('presentado_en', { ascending: false }).limit(60); if (r.error) throw r.error; return r.data || []; },
    async confirmar(payload) { const r = await sb().rpc('cardiolink_presentacion_os_confirmar_v1', payload); if (r.error) throw r.error; return r.data; }
  };
  let almacen = almacenSupabase;
  const noHabilitada = (e) => !!e && (e.code === '42P01' || e.code === 'PGRST205' || /does not exist|could not find the table|schema cache/i.test(String(e.message || '')));

  // ---------------------------------------------------------------- estado y pantalla
  const st = { mes: hoyIso().slice(0, 7), corte: '', fechaPres: '', cierre: false, cobertura: '', profesional: '', control: undefined, presentados: [], historial: [], delegaciones: null, permitidos: null, resultado: null, extras: new Map(), ant: { desdeFecha: '', hastaFecha: '', texto: '', motivo: '', res: null, abierto: false, msg: '' }, reglas: { meses: new Set(), prestaciones: new Set(), pacientes: new Set(), ids: new Set() }, abierto: '', cargando: false, habilitada: true, msg: '' };
  let contenedor = null;

  let proveedorAtenciones = null;                                  // solo QA: lista sintética en lugar de las atenciones reales
  function atencionesLocales() { const a = proveedorAtenciones ? proveedorAtenciones() : g('atenciones'); return Array.isArray(a) ? a : []; }
  // Opciones comunes de clasificación. Con delegaciones cargadas (SQL complementario aplicado) el facturante sale de la delegación explícita; sin ellas, comportamiento V1.
  function opcionesClasificar(extra) {
    const o = Object.assign({ atenciones: atencionesLocales(), presentados: st.presentados, desde: st.control, cobertura: st.cobertura || undefined, profesionales: st.permitidos, obtenerArancel: arancelDe, esFacturaTercero, incluirTerceros: false }, extra || {});
    if (Array.isArray(st.delegaciones)) o.facturanteDe = Core.crearResolvedorFacturante(st.delegaciones);
    return o;
  }
  function recalcular() {
    if (!st.control) { st.resultado = null; return; }
    st.resultado = Core.calcularPendientes(opcionesClasificar(Object.assign({ hastaMes: st.mes }, st.cierre ? { hastaFecha: corteEfectivo() } : {})));
  }
  // Cierre del Círculo: corte habitual el 25 del mes seleccionado; se puede cambiar a mano (dentro del mes). La fecha de presentación es otra cosa: por defecto hoy.
  const corteEfectivo = () => (st.corte && Core.esFechaExacta(st.corte) && st.corte.slice(0, 7) === st.mes) ? st.corte : Core.corteHabitual(st.mes);
  const presentacionEfectiva = () => (st.fechaPres && Core.esFechaExacta(st.fechaPres)) ? st.fechaPres : hoyIso();
  async function cargar() {
    if (!contenedor || st.cargando) return;
    st.cargando = true; st.msg = '';
    try {
      st.permitidos = await profesionalesPermitidos();
      st.control = await almacen.leerControl();
      st.presentados = st.control ? await almacen.leerPresentados() : [];
      st.cierre = typeof almacen.cierreDisponible === 'function' ? !!(await almacen.cierreDisponible()) : false;
      if (!st.cierre) { st.corte = ''; st.fechaPres = ''; }
      st.historial = await almacen.leerHistorial(st.cierre);
      st.delegaciones = typeof almacen.leerDelegaciones === 'function' ? await almacen.leerDelegaciones() : null;
      st.habilitada = true;
      const ya = new Set(st.presentados.map(String));
      Array.from(st.extras.keys()).forEach((id) => { if (ya.has(id)) st.extras.delete(id); });          // lo que otra persona ya presentó sale de las excepciones
      st.ant.res = null;
      recalcular();
    } catch (e) {
      if (noHabilitada(e)) { st.habilitada = false; st.resultado = null; } else { st.msg = 'No se pudo cargar: ' + String((e && e.message) || e); }
    } finally { st.cargando = false; render(); }
  }

  function render() {
    if (!contenedor) return;
    contenedor.replaceChildren();
    contenedor.append(el('h2', { text: 'Presentaciones a obras sociales' }),
      el('p', { className: 'muted', text: 'Prestaciones realizadas y facturables que todavía no se presentaron (las del mes y las de meses anteriores). La fecha de producción no cambia.' }));
    if (!st.habilitada) { contenedor.append(el('p', { className: 'pres-os-aviso', role: 'status', text: 'Esta función todavía no está habilitada en la base de datos. No hay nada para hacer por ahora.' })); return; }
    if (st.msg) contenedor.append(el('p', { className: 'pres-os-error', role: 'alert', text: st.msg }));
    if (st.cargando) { contenedor.append(el('p', { className: 'muted', text: 'Cargando…' })); return; }

    // Control: desde qué fecha se controlan las presentaciones
    const ctl = el('div', { className: 'pres-os-control' });
    if (!st.control) {
      ctl.append(el('p', { className: 'pres-os-aviso', role: 'status', text: esOwnerAdmin() ? 'Definí desde qué fecha arranca la lista automática de presentaciones. Después se arman las listas solas (lo anterior se puede incorporar como excepción).' : 'El Dueño o un Administrador debe definir desde qué fecha se controlan las presentaciones.' }));
    } else ctl.append(el('span', { text: 'La lista automática arranca el ' + fmtFecha(st.control) + '. Lo anterior se puede incorporar como excepción. ' }));
    if (esOwnerAdmin()) {
      const inF = el('input', { type: 'date', id: 'presOsControl', value: st.control || '' });
      ctl.append(inF, el('button', { type: 'button', className: 'secondary', text: st.control ? 'Cambiar fecha' : 'Guardar fecha', onclick: async () => {
        if (!inF.value) return;
        if (st.control && !confirm('Vas a cambiar la fecha de inicio del control a ' + fmtFecha(inF.value) + '. No modifica nada ya presentado; solo cambia qué prestaciones se ofrecen. ¿Seguir?')) return;
        try { await almacen.guardarControl(inF.value); await cargar(); } catch (e) { st.msg = Core.mapearError(e).texto; render(); }
      } }));
    }
    contenedor.append(ctl);
    if (!st.control) return;

    // Filtros
    const inMes = el('input', { type: 'month', id: 'presOsMes', value: st.mes });
    inMes.addEventListener('change', () => { if (Core.esMes(inMes.value)) { st.mes = inMes.value; st.corte = ''; limpiarReglas(); recalcular(); render(); } });
    const coberturas = Array.from(new Set(atencionesLocales().map(Core.coberturaDe).filter((c) => c && !['particular', 'pami'].includes(norm(c))))).sort((a, b) => a.localeCompare(b, 'es'));
    const selCob = el('select', { id: 'presOsCobertura' }, [el('option', { value: '', text: 'Todas las coberturas' })].concat(coberturas.map((c) => el('option', { value: c, text: c, selected: c === st.cobertura }))));
    selCob.addEventListener('change', () => { st.cobertura = selCob.value; limpiarReglas(); recalcular(); render(); });
    const filtros = [el('label', {}, ['Mes de presentación ', inMes]), el('label', {}, ['Cobertura ', selCob])];
    if (st.cierre) {
      const inCorte = el('input', { type: 'date', id: 'presOsCorte', value: corteEfectivo(), min: st.mes + '-01', max: Core.finDeMes(st.mes) });
      inCorte.addEventListener('change', () => { st.corte = inCorte.value && Core.esFechaExacta(inCorte.value) && inCorte.value.slice(0, 7) === st.mes ? inCorte.value : ''; limpiarReglas(); recalcular(); render(); });
      const inPres = el('input', { type: 'date', id: 'presOsFechaPres', value: presentacionEfectiva(), max: hoyIso() });
      inPres.addEventListener('change', () => { st.fechaPres = inPres.value || ''; render(); });
      filtros.push(el('label', {}, ['Fecha de corte ', inCorte]), el('label', {}, ['Fecha efectiva de presentación ', inPres]));
      if (st.corte && st.corte !== Core.corteHabitual(st.mes)) filtros.push(el('button', { type: 'button', className: 'secondary', id: 'presOsCorteHabitual', text: 'Volver al corte habitual (25)', onclick: () => { st.corte = ''; limpiarReglas(); recalcular(); render(); } }));
    }
    contenedor.append(el('div', { className: 'pres-os-filtros' }, filtros));

    const r = st.resultado;
    if (!r) return;
    if (st.cierre && r.periodo) {
      const manual = r.periodo.corte !== r.periodo.corteHabitual;
      contenedor.append(el('p', { className: 'muted', id: 'presOsPeriodo', text: 'Período de ' + fmtMes(st.mes) + ': del ' + fmtFecha(r.periodo.desde) + ' al ' + fmtFecha(r.periodo.corte) + ' inclusive' + (manual ? ' (corte manual; el habitual es el ' + fmtFecha(r.periodo.corteHabitual) + ')' : ' (cierre habitual el 25)') + '. Se suman las pendientes de períodos anteriores' + (r.anteriores ? ' (' + r.anteriores + ' en esta lista)' : '') + ' hasta que se presenten.' + (r.yaPresentadas ? ' Ya presentadas (no se ofrecen): ' + r.yaPresentadas + '.' : '') }));
    } else contenedor.append(el('p', { className: 'muted', text: 'Incluye todo lo realizado hasta el último día de ' + fmtMes(st.mes) + ' que no figura como presentado.' + (r.yaPresentadas ? ' Ya presentadas (no se ofrecen): ' + r.yaPresentadas + '.' : '') }));
    contenedor.append(...avisosAparte(r));
    contenedor.append(...renderResumen(r));
    contenedor.append(renderHistorial());
  }

  function avisosAparte(r) {
    const out = [];
    if (r.sinArancel.length) out.push(el('details', { className: 'pres-os-aparte' }, [el('summary', { text: r.sinArancel.length + ' prestaciones sin arancel válido fijado (incidencias pendientes: no se pueden presentar hasta que tengan arancel)' }),
      ...r.sinArancel.slice(0, 80).map((x) => el('div', { text: fmtFecha(x.fecha) + ' · ' + x.cobertura + ' · ' + x.prestacion + ' · ' + nombreProfesional(x.profesionalId) }))]));
    if (r.terceros.length && !Array.isArray(st.delegaciones)) out.push(el('details', { className: 'pres-os-aparte' }, [el('summary', { text: r.terceros.length + ' prestaciones que factura otro profesional (no se incluyen en este lote)' }),
      ...r.terceros.slice(0, 80).map((x) => el('div', { text: fmtFecha(x.fecha) + ' · ' + x.cobertura + ' · ' + x.prestacion + ' · ' + nombreProfesional(x.profesionalId) }))]));
    if (r.terceros.length && Array.isArray(st.delegaciones)) {
      const deleg = r.terceros.filter((x) => x.delegada), sinDef = r.terceros.filter((x) => !x.delegada);
      if (deleg.length) out.push(el('details', { className: 'pres-os-aparte', id: 'presOsDelegadas' }, [el('summary', { text: deleg.length + ' prestaciones realizadas por ' + [...new Set(deleg.map((x) => nombreProfesional(x.realizadoPor)))].join(', ') + ' que presenta otro profesional (solo informativo: las presenta su facturante)' }),
        ...deleg.slice(0, 80).map((x) => el('div', { text: fmtFecha(x.fecha) + ' · ' + x.cobertura + ' · ' + x.prestacion + ' · realizó ' + nombreProfesional(x.realizadoPor) + ' · lo presenta ' + nombreProfesional(x.facturante) }))]));
      if (sinDef.length) out.push(el('details', { className: 'pres-os-aparte', id: 'presOsSinFacturante' }, [el('summary', { text: sinDef.length + ' prestaciones que factura otro profesional sin facturante definido (incidencias: no se presentan hasta que el Dueño cargue la delegación)' }),
        ...sinDef.slice(0, 80).map((x) => el('div', { text: fmtFecha(x.fecha) + ' · ' + x.cobertura + ' · ' + x.prestacion + ' · ' + nombreProfesional(x.realizadoPor || x.profesionalId) }))]));
    }
    return out;
  }

  function limpiarReglas() { st.reglas = { meses: new Set(), prestaciones: new Set(), pacientes: new Set(), ids: new Set() }; }
  function aplicar() { return Core.aplicarExclusiones(st.resultado.listos, st.reglas); }

  function renderResumen(r) {
    const { incluidos: auto, excluidos } = aplicar();
    const extras = Array.from(st.extras.values());
    const incluidos = auto.concat(extras);
    const lotes = Core.armarLotes(incluidos);
    const total = Core.redondear(incluidos.reduce((s, x) => s + x.importe, 0));
    const out = [];
    if (!r.listos.length) out.push(el('p', { className: 'pres-os-vacio', text: 'No hay prestaciones pendientes de presentar para este período.' }));
    else {
      // Excepciones por regla (sin tildar de a una)
      const meses = r.resumenPorMes.map((m) => el('label', { className: 'pres-os-chip' }, [el('input', { type: 'checkbox', checked: !st.reglas.meses.has(m.mes), 'data-mes': m.mes,
        onchange: (ev) => { if (ev.target.checked) st.reglas.meses.delete(m.mes); else st.reglas.meses.add(m.mes); render(); } }), ' ' + fmtMes(m.mes) + ' · ' + m.cantidad + ' · ' + money(m.total)]));
      out.push(el('div', { className: 'pres-os-meses' }, [el('strong', { text: 'Incluir por mes' }), ...meses]));
      const prests = Array.from(new Set(r.listos.map((x) => x.prestacion))).sort((a, b) => a.localeCompare(b, 'es'));
      const selPrest = el('select', { id: 'presOsExcPrest' }, [el('option', { value: '', text: 'Dejar afuera una prestación…' })].concat(prests.map((p) => el('option', { value: p, text: p }))));
      selPrest.addEventListener('change', () => { if (selPrest.value) { st.reglas.prestaciones.add(selPrest.value); render(); } });
      const inPac = el('input', { type: 'search', id: 'presOsExcPac', placeholder: 'Dejar afuera a un paciente (apellido)…', autocomplete: 'off' });
      inPac.addEventListener('change', () => { const v = inPac.value.trim(); if (v) { st.reglas.pacientes.add(v); render(); } });
      const reglasActivas = [...Array.from(st.reglas.prestaciones).map((p) => ['prestaciones', p, 'Prestación: ' + p]), ...Array.from(st.reglas.pacientes).map((p) => ['pacientes', p, 'Paciente: ' + p])];
      out.push(el('div', { className: 'pres-os-excepciones' }, [selPrest, inPac, ...reglasActivas.map(([k, v, t]) => el('button', { type: 'button', className: 'secondary pres-os-regla', text: t + ' ✕', onclick: () => { st.reglas[k].delete(v); render(); } }))]));
    }

    // Incorporación EXCEPCIONAL de prestaciones anteriores al inicio del control (p. ej. bonos pendientes de presentación)
    if (puedeConfirmar()) out.push(renderAnteriores());

    // Lotes (cobertura + profesional)
    out.push(el('div', { className: 'pres-os-lotes' }, lotes.map((l) => { const ne = l.items.filter((x) => x.excepcional).length, nd = l.items.filter((x) => x.delegada).length; return el('div', { className: 'pres-os-lote' }, [
      el('strong', { text: l.cobertura }), ' · Factura ' + nombreProfesional(l.profesionalId) + ' · ' + l.cantidad + ' prestaciones · ' + money(l.total) + (st.cierre && l.anteriores && l.anteriores.cantidad ? ' (del período ' + l.delPeriodo.cantidad + ' · ' + money(l.delPeriodo.total) + '; de períodos anteriores ' + l.anteriores.cantidad + ' · ' + money(l.anteriores.total) + ')' : '') + (nd ? ' · ' + nd + ' realizadas por otro profesional' : '') + (ne ? ' · ' + ne + ' anteriores al inicio del control (excepción)' : '')]); })));
    // Detalle con excepción puntual (solo para las pocas que se quieran dejar afuera)
    if (r.listos.length) {
      const hayDeleg = r.listos.some((x) => x.delegada);
      const det = el('details', { className: 'pres-os-detalle' }, [el('summary', { text: 'Ver el detalle y dejar afuera alguna en particular (' + r.listos.length + ')' }),
        el('table', { className: 'pres-os-tabla' }, [el('thead', {}, el('tr', {}, ['Fecha', ...(st.cierre ? ['Período'] : []), 'Cobertura', 'Prestación', 'Paciente', hayDeleg ? 'Factura' : 'Profesional', ...(hayDeleg ? ['Realizó'] : []), 'Importe', 'Dejar afuera'].map((h) => el('th', { text: h })))),
          el('tbody', {}, r.listos.slice(0, 400).map((x) => el('tr', { className: (st.reglas.ids.has(x.id) || st.reglas.meses.has(x.mes) || excluidos.indexOf(x) >= 0) ? 'pres-os-fuera' : '' }, [
            el('td', { text: fmtFecha(x.fecha) }), ...(st.cierre ? [el('td', { text: x.anterior ? 'Anterior' : 'Del período' })] : []), el('td', { text: x.cobertura }), el('td', { text: x.prestacion }), el('td', { text: x.paciente }), el('td', { text: nombreProfesional(x.profesionalId) }), ...(hayDeleg ? [el('td', { text: x.delegada ? nombreProfesional(x.realizadoPor) : '' })] : []), el('td', { text: money(x.importe) }),
            el('td', {}, el('input', { type: 'checkbox', checked: st.reglas.ids.has(x.id), 'data-id': x.id, onchange: (ev) => { if (ev.target.checked) st.reglas.ids.add(x.id); else st.reglas.ids.delete(x.id); render(); } }))])))])]);
      out.push(det);
      if (r.listos.length > 400) out.push(el('p', { className: 'muted', text: 'Se muestran las primeras 400 en el detalle; el lote incluye todas las que no dejaste afuera.' }));
    }

    out.push(el('p', { className: 'pres-os-total', text: 'Se presentarán ' + incluidos.length + ' prestaciones por ' + money(total) + (extras.length ? ' (' + extras.length + ' anteriores al inicio del control, incorporadas como excepción)' : '') + (excluidos.length ? ' · quedan afuera ' + excluidos.length + ' (siguen pendientes para el próximo lote)' : '') + '.' }));
    if (puedeConfirmar()) {
      const btn = el('button', { type: 'button', className: 'primary', id: 'presOsConfirmar', text: 'Confirmar presentación', disabled: !incluidos.length });
      btn.addEventListener('click', () => confirmar(lotes, incluidos, total, btn));
      out.push(btn);
    } else out.push(el('p', { className: 'muted', text: 'Solo lectura: la presentación la confirman Secretaría (de sus médicos asociados), Administración o el Dueño.' }));
    return out;
  }

  // ---- excepciones: prestaciones ANTERIORES al inicio del control. Nunca se ofrecen solas ni se dan por presentadas; se buscan acotando y se suman a mano, con motivo.
  function buscarAnteriores() {
    const a = st.ant; a.msg = ''; a.abierto = true;
    if (!a.desdeFecha && !a.hastaFecha && !a.texto.trim()) { a.res = null; a.msg = 'Acotá la búsqueda por fechas o por paciente/prestación.'; return; }
    a.res = Core.calcularAnteriores(opcionesClasificar({ desdeFecha: a.desdeFecha || undefined, hastaFecha: a.hastaFecha || undefined, texto: a.texto.trim() || undefined }));
  }
  function agregarExcepcionales(filas) {
    const a = st.ant, motivo = a.motivo.trim(); a.abierto = true;
    if (!motivo) { a.msg = 'Indicá el motivo (por ejemplo: bono pendiente de presentación).'; render(); return; }
    Core.marcarExcepcionales(filas.filter((x) => !st.extras.has(x.id)), motivo).forEach((x) => st.extras.set(x.id, x));
    a.msg = ''; render();
  }
  function renderAnteriores() {
    const a = st.ant;
    const campo = (k, props) => { const i = el('input', Object.assign({ value: a[k] }, props)); i.addEventListener('change', () => { a[k] = i.value; }); return i; };
    const bus = el('button', { type: 'button', className: 'secondary', id: 'presOsAntBuscar', text: 'Buscar', onclick: () => { buscarAnteriores(); render(); } });
    const cuerpo = [
      el('p', { className: 'muted', text: 'Lo anterior al ' + fmtFecha(st.control) + ' no se da por presentado ni por facturado: no se ofrece solo. Si hay bonos pendientes de presentación, buscá esas prestaciones y sumalas como excepción. Conservan su fecha original de producción y no se pueden presentar dos veces.' }),
      el('div', { className: 'pres-os-filtros' }, [el('label', {}, ['Desde ', campo('desdeFecha', { type: 'date', id: 'presOsAntDesde' })]), el('label', {}, ['Hasta ', campo('hastaFecha', { type: 'date', id: 'presOsAntHasta' })]),
        el('label', {}, ['Paciente o prestación ', campo('texto', { type: 'search', id: 'presOsAntTexto', autocomplete: 'off' })]),
        el('label', {}, ['Motivo ', campo('motivo', { type: 'text', id: 'presOsAntMotivo', placeholder: 'Bono pendiente de presentación' })]), bus])];
    if (a.msg) cuerpo.push(el('p', { className: 'pres-os-error', role: 'alert', text: a.msg }));
    const res = a.res;
    if (res) {
      const cand = res.listos.filter((x) => !st.extras.has(x.id));
      if (!cand.length) cuerpo.push(el('p', { className: 'muted', text: 'No hay prestaciones anteriores pendientes con esos filtros.' + (res.sinArancel.length ? ' (' + res.sinArancel.length + ' sin arancel válido fijado, no se pueden presentar.)' : '') }));
      else {
        cuerpo.push(el('button', { type: 'button', className: 'secondary', id: 'presOsAntTodas', text: 'Agregar las ' + cand.length + ' encontradas', onclick: () => agregarExcepcionales(cand) }));
        cuerpo.push(el('table', { className: 'pres-os-tabla' }, [el('thead', {}, el('tr', {}, ['Fecha', 'Cobertura', 'Prestación', 'Paciente', 'Profesional', 'Importe', 'Agregar'].map((h) => el('th', { text: h })))),
          el('tbody', {}, cand.slice(0, 200).map((x) => el('tr', {}, [el('td', { text: fmtFecha(x.fecha) }), el('td', { text: x.cobertura }), el('td', { text: x.prestacion }), el('td', { text: x.paciente }), el('td', { text: nombreProfesional(x.profesionalId) }), el('td', { text: money(x.importe) }),
            el('td', {}, el('button', { type: 'button', className: 'secondary', 'data-id': x.id, text: 'Agregar', onclick: () => agregarExcepcionales([x]) }))])))]));
        if (cand.length > 200) cuerpo.push(el('p', { className: 'muted', text: 'Se muestran las primeras 200; acotá más la búsqueda o usá «Agregar las ' + cand.length + ' encontradas».' }));
      }
    }
    const extras = Array.from(st.extras.values());
    if (extras.length) cuerpo.push(el('div', { className: 'pres-os-meses' }, [el('strong', { text: 'Incorporadas como excepción (' + extras.length + ')' }),
      ...extras.slice(0, 60).map((x) => el('button', { type: 'button', className: 'secondary pres-os-regla', 'data-extra': x.id, text: fmtFecha(x.fecha) + ' · ' + x.prestacion + ' · ' + x.paciente + ' ✕', onclick: () => { st.extras.delete(x.id); render(); } })),
      extras.length > 60 ? el('span', { className: 'muted', text: ' … y ' + (extras.length - 60) + ' más' }) : null,
      el('button', { type: 'button', className: 'secondary', id: 'presOsAntQuitar', text: 'Quitar todas', onclick: () => { st.extras.clear(); render(); } })]));
    return el('details', { className: 'pres-os-anteriores', id: 'presOsAnteriores', open: a.abierto || extras.length > 0, ontoggle: (ev) => { a.abierto = ev.target.open; } },
      [el('summary', { text: 'Incorporar prestaciones anteriores al ' + fmtFecha(st.control) + ' (excepción, por ejemplo bonos pendientes)' + (extras.length ? ' · ' + extras.length + ' agregadas' : '') })].concat(cuerpo));
  }

  let confirmando = false;
  async function confirmar(lotes, incluidos, total, btn) {
    if (confirmando || !puedeConfirmar() || !incluidos.length) return;
    const errores = Core.validarLotes(lotes, st.presentados, st.control);
    if (errores.length) { st.msg = errores[0]; render(); return; }
    let cierre = null;
    if (st.cierre) {
      const ultima = incluidos.reduce((m, x) => (x.fecha > m ? x.fecha : m), '');
      cierre = { corte: corteEfectivo(), presentacion: presentacionEfectiva() };
      const eCierre = Core.validarCierre({ periodo: st.mes, corte: cierre.corte, presentacion: cierre.presentacion, hoy: hoyIso(), ultimaAtencion: ultima });
      if (eCierre.length) { st.msg = eCierre[0]; render(); return; }
    }
    if (!confirm('Vas a presentar ' + incluidos.length + ' prestaciones por ' + money(total) + ' (' + lotes.length + ' lote/s)' + (incluidos.some((x) => x.excepcional) ? ', incluidas ' + incluidos.filter((x) => x.excepcional).length + ' anteriores al inicio del control como excepción' : '') + '. ' + (cierre ? 'Período de ' + fmtMes(st.mes) + ' con corte el ' + fmtFecha(cierre.corte) + '; fecha de presentación ' + fmtFecha(cierre.presentacion) + '. Quedan registradas con tu usuario' : 'Quedan registradas con tu usuario y la fecha de hoy') + ' y no se pueden volver a presentar. ¿Confirmar?')) return;
    confirmando = true; btn.disabled = true; btn.textContent = 'Confirmando…';
    try {
      const res = await almacen.confirmar(Core.payloadConfirmar(st.mes, lotes, cierre));
      st.msg = ''; limpiarReglas(); st.extras.clear();
      await cargar();
      contenedor.prepend(el('p', { className: 'pres-os-ok', role: 'status', text: '✓ Presentación confirmada: ' + (res && res.items != null ? res.items : incluidos.length) + ' prestaciones por ' + money(res && res.total != null ? res.total : total) + '.' }));
    } catch (e) {
      const m = Core.mapearError(e);
      st.msg = m.texto;
      if (m.tipo === 'duplicada' || m.tipo === 'cambio' || m.tipo === 'arancel') { try { await cargar(); st.msg = m.texto; render(); } catch (e2) { render(); } } else render();
    } finally { confirmando = false; }
  }

  function renderHistorial() {
    const filas = st.historial || [];
    return el('details', { className: 'pres-os-historial' }, [el('summary', { text: 'Presentaciones registradas (' + filas.length + ')' }),
      filas.length ? el('table', { className: 'pres-os-tabla' }, [el('thead', {}, el('tr', {}, [st.cierre ? 'Presentada el' : 'Fecha', 'Período', ...(st.cierre ? ['Corte'] : []), 'Cobertura', 'Profesional', 'Prestaciones', 'Importe', 'Quién'].map((h) => el('th', { text: h })))),
        el('tbody', {}, filas.map((f) => el('tr', {}, [el('td', { text: st.cierre && f.fecha_presentacion ? fmtFecha(f.fecha_presentacion) : fmtFechaHora(f.presentado_en) }), el('td', { text: fmtMes(f.periodo) }), ...(st.cierre ? [el('td', { text: f.fecha_corte ? fmtFecha(f.fecha_corte) : '—' })] : []), el('td', { text: f.cobertura }), el('td', { text: nombreProfesional(f.professional_id) }),
          el('td', { text: String(f.cantidad) }), el('td', { text: money(f.total_importe) }), el('td', { text: f.presentado_por_email || '' })])))]) : el('p', { className: 'muted', text: 'Todavía no hay presentaciones registradas.' })]);
  }

  // ---------------------------------------------------------------- enganches (sin tocar app.js)
  function instalar() {
    contenedor = document.getElementById(SECCION);
    const prevPermitida = g('seccionPermitida');
    if (typeof prevPermitida === 'function' && !prevPermitida.__presOsV1) {
      const w = function (section) { if (section === SECCION) return puedeVer(); return prevPermitida.apply(this, arguments); };
      w.__presOsV1 = true; window.seccionPermitida = w;
    }
    const prevShow = g('showSection');
    if (typeof prevShow === 'function' && !prevShow.__presOsV1) {
      const w = function (id) {
        const r = prevShow.apply(this, arguments);
        if (id === SECCION && puedeVer()) {
          contenedor = document.getElementById(SECCION);
          const t = document.getElementById('tituloBienvenida'), s = document.getElementById('subtituloPerfil');
          if (t) t.textContent = 'Presentaciones a obras sociales';
          if (s) s.textContent = 'Prestaciones realizadas y facturables, listas para presentar';
          cargar();
        }
        return r;
      };
      w.__presOsV1 = true; window.showSection = w;
    }
    try { const ap = g('aplicarPermisosUI'); if (typeof ap === 'function') ap(); } catch (e) { /* sin sesión todavía */ }
  }
  instalar();

  window.CardioLinkPresentacionesV1 = {
    recargar: cargar,
    // Solo para pruebas y QA sin base de datos: reemplaza el acceso a datos por uno en memoria.
    _usarAlmacen: (a) => { almacen = a || almacenSupabase; },
    _usarAtenciones: (fn) => { proveedorAtenciones = typeof fn === 'function' ? fn : null; },
    _estado: st, _test: { arancelDe, esFacturaTercero, opcionesClasificar, render, recalcular, cargar, buscarAnteriores }
  };
})();
