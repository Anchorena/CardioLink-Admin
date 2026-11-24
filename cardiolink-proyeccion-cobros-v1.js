/* CardioLink · PROYECCIÓN MENSUAL DE COBROS V1 · interfaz + acceso a datos
 *
 * Módulo independiente (NO modifica app.js, ni Caja, Finanzas V5, atenciones o presentaciones). Cargar DESPUÉS de cardiolink-proyeccion-cobros-core.js y de app.js.
 * Sección «Proyección de cobros» (solo Dueño y Administración): importes ESPERADOS por mes de cobro estimado = fecha efectiva de presentación + plazo de pago de la cobertura.
 * Son importes PROYECTADOS: no son dinero cobrado y no se incorporan a Caja ni a ingresos cobrados. Solo lee presentaciones confirmadas (cardiolink_presentaciones_os_v1; la lectura no escribe nada).
 * El plazo por cobertura (30, 60, 90 o personalizado) se guarda en la configuración existente (clave plazosPagoCobertura); cambiarlo no modifica presentaciones históricas, solo recalcula la proyección.
 * Sin SQL: usa las tablas actuales. */
(function () {
  'use strict';
  if (window.CardioLinkProyeccionCobrosV1) return;
  const Core = window.CardioLinkProyeccionCobrosCoreV1;
  if (!Core) { try { console.warn('Proyección de cobros: falta el núcleo; la sección no se habilita.'); } catch (e) { /* sin consola */ } return; }

  const SECCION = 'proyeccionCobros', T_PRES = 'cardiolink_presentaciones_os_v1';

  const g = (name) => {
    try {
      switch (name) {
        case 'supabaseClient': return typeof supabaseClient !== 'undefined' ? supabaseClient : undefined;
        case 'data': return typeof data !== 'undefined' ? data : undefined;
        default: return window[name];
      }
    } catch (e) { return undefined; }
  };
  const sb = () => g('supabaseClient') || null;
  const rolEs = (fn) => { try { const f = g(fn); return typeof f === 'function' && !!f(); } catch (e) { return false; } };
  const puedeVer = () => rolEs('esMatiasDuenio') || rolEs('esAdminComun');                    // finanzas: Dueño y Administración
  const hoyIso = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const fmtFecha = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? m[3] + '/' + m[2] + '/' + m[1] : String(iso || ''); };
  const fmtMes = (ym) => { const m = /^(\d{4})-(\d{2})$/.exec(String(ym || '')); if (!m) return String(ym || ''); try { return new Date(Number(m[1]), Number(m[2]) - 1, 1, 12).toLocaleDateString('es-AR', { month: 'long', year: 'numeric' }); } catch (e) { return ym; } };
  const money = (n) => { try { return '$ ' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); } catch (e) { return '$ ' + Number(n || 0).toFixed(2); } };
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
  const plazos = () => { const d = g('data'); return (d && d[Core.CLAVE_CONFIG]) || {}; };

  // ---------------------------------------------------------------- acceso a datos (solo lectura) · intercambiable para pruebas
  const COLS_BASE = 'id,cobertura,professional_id,periodo,cantidad,total_importe,presentado_en', COLS_CIERRE = COLS_BASE + ',fecha_presentacion';
  const almacenSupabase = {
    async leerPresentaciones() {
      const cp = window.cardiolinkCargaPaginadaV1;
      if (!cp) throw new Error('Falta la lectura paginada.');
      let r = await cp.leerTodo({ sb: sb(), tabla: T_PRES, columnas: COLS_CIERRE, clave: 'id', dedup: 'proyeccion-cobros-pres' });
      if (r.error && (r.error.code === '42703' || /fecha_presentacion|does not exist/i.test(String(r.error.message || '')))) r = await cp.leerTodo({ sb: sb(), tabla: T_PRES, columnas: COLS_BASE, clave: 'id', dedup: 'proyeccion-cobros-pres-v0' });   // sin el cierre del día 25
      if (r.error) throw r.error;
      return r.data || [];
    }
  };
  let almacen = almacenSupabase;
  const noHabilitada = (e) => !!e && (e.code === '42P01' || e.code === 'PGRST205' || /does not exist|could not find the table|schema cache/i.test(String(e.message || '')));

  // ---------------------------------------------------------------- estado y pantalla
  const st = { presentaciones: [], resultado: null, cargando: false, habilitada: true, msg: null, abiertos: new Set(), agregar: '' };
  let contenedor = null;

  function recalcular() { st.resultado = Core.proyectar({ presentaciones: st.presentaciones, plazos: plazos(), hoy: hoyIso() }); }
  async function cargar() {
    if (!contenedor || st.cargando) return;
    st.cargando = true;
    try { st.presentaciones = await almacen.leerPresentaciones(); st.habilitada = true; recalcular(); }
    catch (e) { if (noHabilitada(e)) { st.habilitada = false; st.resultado = null; } else st.msg = { tipo: 'error', texto: 'No se pudo cargar: ' + String((e && e.message) || e) }; }
    finally { st.cargando = false; render(); }
  }

  const coberturasConPlazo = () => {
    const m = new Map();
    st.presentaciones.forEach((p) => { const c = String(p && p.cobertura || '').trim(); if (c && !m.has(Core.norm(c))) m.set(Core.norm(c), c); });
    Object.values(plazos()).forEach((e) => { if (e && e.cobertura && !m.has(Core.norm(e.cobertura))) m.set(Core.norm(e.cobertura), e.cobertura); });
    if (st.agregar && !m.has(Core.norm(st.agregar))) m.set(Core.norm(st.agregar), st.agregar);
    return Array.from(m.values()).sort((a, b) => a.localeCompare(b, 'es'));
  };

  async function guardarPlazo(cobertura, valor) {
    if (!puedeVer()) return;
    try { const f = g('exigirConfigComercial'); if (typeof f === 'function' && !f('Tu perfil no puede modificar plazos de pago.')) return; } catch (e) { return; }
    const d = g('data'), antes = Core.plazoDe(plazos(), cobertura), dias = valor === '' ? null : Core.validarPlazo(valor);
    if (valor !== '' && dias === null) { st.msg = { tipo: 'error', texto: 'El plazo debe ser un número entero de días entre ' + Core.PLAZO_MIN + ' y ' + Core.PLAZO_MAX + '.' }; render(); return; }
    if (antes === dias) { st.msg = { tipo: 'ok', texto: 'No hay cambios en el plazo de «' + cobertura + '».' }; render(); return; }
    if (!window.confirm('¿' + (dias === null ? 'Quitar el plazo de pago de «' + cobertura + '»' : 'Fijar en ' + dias + ' días el plazo de pago de «' + cobertura + '»') + (antes ? ' (hoy ' + antes + ' días)' : '') + '?\nSolo cambia la proyección: no se modifica ninguna presentación ni Caja.')) return;
    const r = Core.aplicarPlazo(d, cobertura, dias);
    if (!r.ok) { st.msg = { tipo: 'error', texto: r.error }; render(); return; }
    let ok = null;
    try { const p = g('persistirConfigVisibleV1'); ok = typeof p === 'function' ? await p('El plazo de pago') : null; } catch (e) { ok = false; }
    try { const s = g('programarSyncSupabase'); if (typeof s === 'function') s(); } catch (e) { /* sin efecto */ }
    st.agregar = ''; recalcular();
    st.msg = { tipo: ok === false ? 'error' : 'ok', texto: (dias === null ? 'Plazo quitado' : 'Plazo guardado') + ' para «' + cobertura + '»' + (ok === false ? '. Solo en este equipo: el servidor no lo confirmó.' : '.') };
    render();
  }

  function render() {
    if (!contenedor) return;
    contenedor.replaceChildren();
    contenedor.append(el('h2', {}, ['Proyección de cobros', el('span', { className: 'pc-proyectado', text: 'Proyectado' })]));
    contenedor.append(el('p', { className: 'pc-aviso', id: 'pcAviso', role: 'note', text: 'Estos importes son PROYECTADOS (estimados): no son dinero cobrado, no se suman a Caja ni a los ingresos efectivamente cobrados, y no concilian pagos reales. Fecha estimada de cobro = fecha efectiva de presentación + plazo de pago de la cobertura.' }));
    if (!puedeVer()) { contenedor.append(el('p', { className: 'pc-error', text: 'Esta vista es solo para el Dueño y la Administración.' })); return; }
    if (!st.habilitada) { contenedor.append(el('p', { className: 'pc-aviso', role: 'status', text: 'Las presentaciones a obras sociales todavía no están habilitadas en la base de datos: no hay nada para proyectar.' })); return; }
    if (st.msg) contenedor.append(el('p', { className: st.msg.tipo === 'ok' ? 'pc-ok' : 'pc-error', role: st.msg.tipo === 'ok' ? 'status' : 'alert', text: st.msg.texto }));
    if (st.cargando) { contenedor.append(el('p', { className: 'muted', text: 'Cargando…' })); return; }
    contenedor.append(renderPlazos());
    const r = st.resultado; if (!r) return;
    contenedor.append(el('p', { className: 'pc-total', id: 'pcTotal', text: 'Total proyectado: ' + money(r.total) + ' (proyectado) en ' + r.cantidadPresentaciones + ' presentaciones' + (r.meses.length ? ', de ' + fmtMes(r.meses[0].mes) + ' a ' + fmtMes(r.meses[r.meses.length - 1].mes) : '') + '.' }));
    if (!r.meses.length) contenedor.append(el('p', { className: 'muted', text: 'Todavía no hay presentaciones con plazo de pago configurado para proyectar.' }));
    r.meses.forEach((m) => contenedor.append(renderMes(m)));
    if (r.sinPlazo.cantidadPresentaciones) contenedor.append(renderSinPlazo(r.sinPlazo));
    if (r.invalidas.length || r.duplicadasIgnoradas) contenedor.append(el('p', { className: 'muted', text: (r.invalidas.length ? r.invalidas.length + ' presentaciones no se pudieron proyectar por datos incompletos. ' : '') + (r.duplicadasIgnoradas ? r.duplicadasIgnoradas + ' repetidas ignoradas (cada presentación cuenta una sola vez por su ID).' : '') }));
  }

  function renderPlazos() {
    const lista = coberturasConPlazo(), cat = (() => { try { return ((g('data') && g('data').obrasSociales) || []).map((x) => typeof x === 'string' ? x : (x && (x.nombre || x.label)) || '').filter(Boolean); } catch (e) { return []; } })();
    const filas = lista.map((c) => {
      const d = Core.plazoDe(plazos(), c), pre = d !== null && Core.PLAZOS_PREDEFINIDOS.indexOf(d) >= 0, custom = d !== null && !pre;
      const sel = el('select', { 'data-cobertura': c }, [el('option', { value: '', text: 'Sin plazo' }), ...Core.PLAZOS_PREDEFINIDOS.map((x) => el('option', { value: String(x), text: x + ' días', selected: d === x })), el('option', { value: 'otro', text: 'Personalizado', selected: custom })].map((o, i) => { if (i === 0 && d === null) o.selected = true; return o; }));
      const num = el('input', { type: 'number', min: String(Core.PLAZO_MIN), max: String(Core.PLAZO_MAX), step: '1', value: custom ? String(d) : '', placeholder: 'días', 'aria-label': 'Plazo personalizado en días' });
      num.style.display = custom ? '' : 'none';
      sel.addEventListener('change', () => { num.style.display = sel.value === 'otro' ? '' : 'none'; if (sel.value === 'otro') num.focus(); });
      const btn = el('button', { type: 'button', className: 'secondary', 'data-guardar': c, text: 'Guardar', onclick: () => guardarPlazo(c, sel.value === 'otro' ? (num.value.trim() === '' ? 'sin-valor' : num.value) : sel.value) });   // «Personalizado» vacío es un error, no «quitar el plazo»
      return el('div', { className: 'pc-plazo' }, [el('strong', { text: c }), sel, num, btn, el('span', { className: 'muted', text: d === null ? 'sin plazo: no se proyecta' : 'plazo actual: ' + d + ' días' })]);
    });
    const faltan = cat.filter((c) => !lista.some((x) => Core.norm(x) === Core.norm(c))).sort((a, b) => a.localeCompare(b, 'es'));
    const add = el('select', { id: 'pcAgregar' }, [el('option', { value: '', text: 'Definir plazo para otra cobertura…' })].concat(faltan.map((c) => el('option', { value: c, text: c }))));
    add.addEventListener('change', () => { if (add.value) { st.agregar = add.value; render(); } });
    return el('details', { className: 'pc-mes', id: 'pcPlazos', open: lista.some((c) => Core.plazoDe(plazos(), c) === null) || undefined }, [el('summary', { text: 'Plazo estimado de pago por cobertura' }),
      el('p', { className: 'muted', text: 'Elegí 30, 60, 90 días o un plazo personalizado. Cambiarlo solo recalcula la proyección: no modifica ninguna presentación ya registrada.' }),
      el('div', { className: 'pc-plazos' }, filas.length ? filas : [el('p', { className: 'muted', text: 'Todavía no hay coberturas con presentaciones.' })]), faltan.length ? add : null]);
  }

  function tabla(cabeceras, filas) {
    return el('table', { className: 'pc-tabla' }, [el('thead', {}, el('tr', {}, cabeceras.map(([h, num]) => el('th', { text: h, className: num ? 'pc-num' : '' })))), el('tbody', {}, filas.map((f) => el('tr', { className: f.pasada ? 'pc-pasada' : '' }, f.celdas.map((c, i) => el('td', { text: c, className: cabeceras[i][1] ? 'pc-num' : '' })))))]);
  }
  function renderMes(m) {
    const abierto = st.abiertos.has(m.mes);
    const d = el('details', { className: 'pc-mes', 'data-mes': m.mes, open: abierto || undefined, ontoggle: (ev) => { if (ev.target.open) st.abiertos.add(m.mes); else st.abiertos.delete(m.mes); } }, [
      el('summary', {}, [fmtMes(m.mes) + ' · ' + money(m.total) + ' estimado ', el('span', { className: 'pc-proyectado', text: 'Proyectado' }), ' · ' + m.cantidadPresentaciones + ' presentaciones · ' + m.cantidad + ' prestaciones'])]);
    d.append(el('h4', { text: 'Por cobertura' }), tabla([['Cobertura'], ['Plazo', 1], ['Presentaciones', 1], ['Prestaciones', 1], ['Importe estimado', 1]], m.porCobertura.map((c) => ({ celdas: [c.cobertura, c.plazo + ' días', String(c.presentaciones), String(c.cantidad), money(c.total)] }))));
    d.append(el('h4', { text: 'Por profesional facturante' }), tabla([['Profesional'], ['Presentaciones', 1], ['Prestaciones', 1], ['Importe estimado', 1]], m.porProfesional.map((p) => ({ celdas: [nombreProfesional(p.profesionalId), String(p.presentaciones), String(p.cantidad), money(p.total)] }))));
    d.append(el('h4', { text: 'Fecha estimada de ingreso' }), tabla([['Fecha estimada'], ['Cobertura'], ['Facturante'], ['Presentada el'], ['Plazo', 1], ['Prestaciones', 1], ['Importe estimado', 1]],
      m.filas.map((f) => ({ pasada: f.pasada, celdas: [fmtFecha(f.fechaCobro) + (f.pasada ? ' (ya pasó)' : ''), f.cobertura, nombreProfesional(f.profesionalId), fmtFecha(f.fechaPresentacion) + (f.origenFecha === 'registro' ? ' (fecha de registro)' : ''), f.plazo + ' días', String(f.cantidad), money(f.importe)] }))));
    if (m.filas.some((f) => f.pasada)) d.append(el('p', { className: 'muted', text: 'Las fechas marcadas «ya pasó» son estimaciones vencidas: esta versión no concilia cobros, así que no sabe si ese dinero ya ingresó.' }));
    return d;
  }
  function renderSinPlazo(s) {
    return el('details', { className: 'pc-mes', id: 'pcSinPlazo', open: true }, [el('summary', { text: 'Sin plazo configurado (no proyectado): ' + s.cantidadPresentaciones + ' presentaciones · ' + money(s.total) }),
      el('p', { className: 'muted', text: 'Estas presentaciones no entran en ningún mes porque su cobertura no tiene plazo de pago. Configuralo arriba para proyectarlas.' }),
      tabla([['Cobertura'], ['Presentaciones', 1], ['Prestaciones', 1], ['Importe', 1]], s.porCobertura.map((c) => ({ celdas: [c.cobertura, String(c.presentaciones), String(c.cantidad), money(c.total)] })))]);
  }

  // ---------------------------------------------------------------- enganches (sin tocar app.js)
  function instalar() {
    contenedor = document.getElementById(SECCION);
    const prevShow = g('showSection');
    if (typeof prevShow === 'function' && !prevShow.__proyCobrosV1) {
      const w = function (id) {
        const r = prevShow.apply(this, arguments);
        if (id === SECCION && puedeVer()) {
          contenedor = document.getElementById(SECCION);
          const t = document.getElementById('tituloBienvenida'), s = document.getElementById('subtituloPerfil');
          if (t) t.textContent = 'Proyección de cobros';
          if (s) s.textContent = 'Ingresos esperados por obra social (proyectado, no cobrado)';
          cargar();
        }
        return r;
      };
      w.__proyCobrosV1 = true; window.showSection = w;
    }
    try { const ap = g('aplicarPermisosUI'); if (typeof ap === 'function') ap(); } catch (e) { /* sin sesión todavía */ }
  }
  instalar();

  window.CardioLinkProyeccionCobrosV1 = {
    recargar: cargar,
    _usarAlmacen: (a) => { almacen = a || almacenSupabase; },        // solo pruebas / QA
    _estado: st, _test: { render, recalcular, cargar, guardarPlazo, coberturasConPlazo }
  };
})();
