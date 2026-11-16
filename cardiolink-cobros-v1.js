/* =====================================================================
   CardioLink Admin — Pendientes de cobro V1

   Diferencia prestaciones cobradas de prestaciones con cobro pendiente, sin
   tablas nuevas: el estado vive en el payload JSON de cardiolink_atenciones.

   Campos (solo en atenciones nuevas; las históricas NO los tienen y siguen
   contando exactamente como antes):
     estadoCobro        'cobrado' | 'pendiente' | 'sin_cobro'
     cobroPendienteEn / cobroPendientePor
     cobroConfirmadoEn / cobroConfirmadoPor / cobroConfirmadoPorId /
     cobroConfirmadoPorRol / cobroConfirmadoPorEmail / cobroMedioPago
     cobroAuditoria     [{accion, fecha, usuario, medio?}]

   Regla de Caja: una atención con estadoCobro==='pendiente' sigue siendo una
   prestación realizada, pero su importe NO es dinero cobrado (cobroEfectivo-
   Atencion devuelve 0 y Finanzas V5 lo excluye). Al confirmarse pasa a
   'cobrado' y cuenta una sola vez, con la fecha de la atención y el medio de
   pago confirmado. La separación económica sigue siendo cajaPerfil.

   Orden de carga: DESPUÉS de app.js (envuelve funciones globales de app.js).
   Lógica pura exportada para los tests de contrato (.test.cjs).
   ===================================================================== */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CardioLinkCobrosV1 = api;
  if (typeof document !== 'undefined' && root === (typeof window !== 'undefined' ? window : null)) {
    api.instalar(root);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ESTADO = Object.freeze({ COBRADO: 'cobrado', PENDIENTE: 'pendiente', SIN_COBRO: 'sin_cobro' });
  const MEDIOS = Object.freeze(['Efectivo', 'Transferencia', 'Débito', 'Mixto']);
  const ROLES_CONFIRMAN = Object.freeze(['secretaria', 'admin', 'duenio', 'owner']);
  const ROLES_VEN_TOTALES = Object.freeze(['admin', 'duenio', 'owner']);
  const SIN_COBRO_TIPOS = Object.freeze(['sin cobro en caja', 'no cobrar']);

  const limpio = (v) => (typeof v === 'string' ? v.trim() : '');
  const numero = (v) => Number(v || 0);
  const estadoTurnoDe = (a) => String(a?.estadoTurno || a?.estado || '').toLowerCase();
  const esMensaje = (a) => !!a && a.tipoRegistro === 'mensaje';

  // 'historico' = atención sin estadoCobro (anterior a este módulo).
  function estadoCobroDe(a) {
    const e = a && typeof a === 'object' ? a.estadoCobro : '';
    return e === ESTADO.COBRADO || e === ESTADO.PENDIENTE || e === ESTADO.SIN_COBRO ? e : 'historico';
  }

  // Importe esperado de la atención (lo que hay que cobrar), igual criterio
  // que cobroEfectivoAtencion de app.js: "No cobrar" a particulares vale 0.
  function montoEsperado(a) {
    if (!a || typeof a !== 'object') return 0;
    const sinCobro = a.noCobrar === true && limpio(a.obraSocial || a.coberturaAtencion).toLowerCase() === 'particular';
    if (sinCobro) return 0;
    return numero(a.montoConsulta) + numero(a.montoEstudio) + numero(a.montoCopago);
  }

  // ¿El cobro de esta atención está pendiente y la atención sigue vigente?
  // (cancelada/ausente: la seña se rige por su propio circuito).
  function esCobroPendiente(a) {
    if (!a || typeof a !== 'object' || esMensaje(a)) return false;
    if (a.estadoCobro !== ESTADO.PENDIENTE) return false;
    return !['cancelado', 'ausente'].includes(estadoTurnoDe(a));
  }

  // Fecha (AAAA-MM-DD, hora local) en que entró el dinero: la de la
  // confirmación cuando el cobro estuvo pendiente; si no, la de la atención.
  // Misma regla que fechaCobroAtencion de cardiolink-finanzas-v5.js (un test
  // verifica que coinciden). No toca los períodos históricos: sin
  // cobroPendienteEn + cobroConfirmadoEn devuelve siempre a.fecha.
  function fechaCobroAtencion(a) {
    if (!a || a.estadoCobro !== ESTADO.COBRADO || !a.cobroPendienteEn || !a.cobroConfirmadoEn) return a ? a.fecha : '';
    const d = new Date(a.cobroConfirmadoEn);
    if (Number.isNaN(d.getTime())) return a.fecha;
    const dos = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`;
  }

  // Aplica la regla de Caja sobre el resultado de cobroEfectivoAtencion.
  function cobroEfectivoSegunEstado(a, base) {
    if (a && a.estadoCobro === ESTADO.PENDIENTE) return { particular: 0, copago: 0, total: 0 };
    return base;
  }

  // Estado de cobro explícito para una atención NUEVA (recién armada por el
  // formulario). Muta y devuelve la misma atención.
  function asignarEstadoCobroNuevo(a, opciones = {}) {
    if (!a || typeof a !== 'object') return a;
    const ahora = opciones.ahora || new Date().toISOString();
    const usuario = limpio(opciones.usuario) || 'usuario';
    const tipo = limpio(a.tipoCobro).toLowerCase();
    const cobrable = a.noCobrar !== true && !SIN_COBRO_TIPOS.includes(tipo) && montoEsperado(a) > 0;
    if (!cobrable) {
      a.estadoCobro = ESTADO.SIN_COBRO;
      return a;
    }
    if (opciones.pendiente === true) {
      a.estadoCobro = ESTADO.PENDIENTE;
      a.formaPago = 'No aplica';
      a.cobroPendienteEn = ahora;
      a.cobroPendientePor = usuario;
      a.cobroAuditoria = [{ accion: 'pendiente', fecha: ahora, usuario }];
      return a;
    }
    a.estadoCobro = ESTADO.COBRADO;
    a.cobroConfirmadoEn = ahora;
    a.cobroConfirmadoPor = usuario;
    a.cobroMedioPago = limpio(a.formaPago) || 'No aplica';
    a.cobroAuditoria = [{ accion: 'cobrado_al_registrar', fecha: ahora, usuario, medio: a.cobroMedioPago }];
    return a;
  }

  function rolPuedeConfirmarCobro(rolBase) {
    return ROLES_CONFIRMAN.includes(limpio(rolBase).toLowerCase());
  }

  function rolVeTotalesPorProfesional(rolBase) {
    return ROLES_VEN_TOTALES.includes(limpio(rolBase).toLowerCase());
  }

  // Quién ve un cobro pendiente: admin/dueño/secretaría todos; el médico solo
  // los de su propia caja (cajaPerfil, o profesionalId si no tiene).
  function puedeVerCobroPendiente(rolBase, profesionalIdMedico, a) {
    const rol = limpio(rolBase).toLowerCase();
    if (rolPuedeConfirmarCobro(rol)) return true;
    if (rol !== 'medico') return false;
    const pid = limpio(profesionalIdMedico);
    return pid !== '' && pid === limpio(a?.cajaPerfil || a?.profesionalId);
  }

  // Rol que se registra en la auditoría de la confirmación: 'duenio' (nombre interno del perfil) se guarda como 'owner'; el backend
  // sólo acepta 'secretaria' (Secretaría), 'owner' o 'admin'.
  function rolParaAuditoria(rolBase) {
    const r = limpio(rolBase).toLowerCase();
    return r === 'duenio' ? 'owner' : r;
  }

  // Transición pendiente -> cobrado, pura e idempotente. Nunca muta `payload`.
  //  - ya cobrado: { ok:true, yaConfirmado:true, payload } sin cambios;
  //  - no pendiente / medio inválido / atención no vigente: { ok:false, codigo }.
  function confirmarCobro(payload, opciones = {}) {
    if (!payload || typeof payload !== 'object') return { ok: false, codigo: 'inexistente' };
    const estado = estadoCobroDe(payload);
    if (estado === ESTADO.COBRADO && payload.cobroConfirmadoEn) {
      return { ok: true, yaConfirmado: true, payload };
    }
    if (estado !== ESTADO.PENDIENTE) return { ok: false, codigo: 'no_pendiente' };
    if (['cancelado', 'ausente'].includes(estadoTurnoDe(payload))) return { ok: false, codigo: 'atencion_no_vigente' };
    const medio = limpio(opciones.medio);
    if (!MEDIOS.includes(medio)) return { ok: false, codigo: 'medio_invalido' };
    // Lo que se confirma es lo que la persona vio: si el destinatario económico
    // (cajaPerfil) cambió, el dinero iría a otra caja: no se confirma.
    if (opciones.cajaVista !== undefined && opciones.cajaVista !== null
        && limpio(String(opciones.cajaVista)) !== cajaDe(payload)) {
      return { ok: false, codigo: 'caja_cambio' };
    }
    // Lo que se confirma es lo que la persona vio: si el importe cambió desde
    // que se mostró el pendiente (p. ej. lo editó el profesional), no se confirma.
    if (opciones.montoVisto !== undefined && opciones.montoVisto !== null
        && numero(opciones.montoVisto) !== montoEsperado(payload)) {
      return { ok: false, codigo: 'monto_cambio' };
    }
    const ahora = opciones.ahora || new Date().toISOString();
    const usuario = limpio(opciones.usuario) || 'usuario';
    const auditoria = Array.isArray(payload.cobroAuditoria) ? payload.cobroAuditoria.slice() : [];
    auditoria.push({ accion: 'confirmado', fecha: ahora, usuario, medio, email: limpio(opciones.email) || undefined });
    const nuevo = Object.assign({}, payload, {
      estadoCobro: ESTADO.COBRADO,
      formaPago: medio,
      cobroMedioPago: medio,
      cobroConfirmadoEn: ahora,
      cobroConfirmadoPor: usuario,
      cobroConfirmadoPorId: limpio(opciones.usuarioId) || undefined,
      cobroConfirmadoPorRol: limpio(opciones.rol) || undefined,
      cobroConfirmadoPorEmail: limpio(opciones.email) || undefined,
      cobroAuditoria: auditoria
    });
    ['cobroConfirmadoPorId', 'cobroConfirmadoPorRol', 'cobroConfirmadoPorEmail'].forEach((k) => {
      if (nuevo[k] === undefined) delete nuevo[k];
    });
    return { ok: true, yaConfirmado: false, payload: nuevo };
  }

  // Reglas espejo del guard SQL propuesto (docs/propuestas/pending_review_cobros_v1_guard_medico.sql):
  // quien no puede confirmar cobros no edita los datos económicos de un cobro ya confirmado por el
  // flujo ni borra un cobro pendiente o confirmado. La interfaz lo evita antes de que el backend rechace.
  const cobroConfirmadoPorFlujo = (a) => !!a && typeof a === 'object' && limpio(a.cobroConfirmadoPorRol) !== '';
  function edicionEconomicaBloqueada(rolBase, a) {
    return !rolPuedeConfirmarCobro(rolBase) && cobroConfirmadoPorFlujo(a);
  }
  function borradoBloqueado(rolBase, a) {
    return !rolPuedeConfirmarCobro(rolBase) && !!a && (a.estadoCobro === ESTADO.PENDIENTE || cobroConfirmadoPorFlujo(a));
  }

  // Destinatario económico de la atención: el mismo criterio que app.js
  // (dineroVisible) y que el guard SQL v4.2: cajaPerfil y, si falta, profesionalId.
  const cajaDe = (a) => limpio(a?.cajaPerfil || a?.profesionalId);

  // Agrupa por caja económica: [{ id, items, total }] ordenado por id.
  function agruparPorCaja(lista) {
    const grupos = new Map();
    (Array.isArray(lista) ? lista : []).forEach((a) => {
      const id = cajaDe(a) || 'sin_asignar';
      if (!grupos.has(id)) grupos.set(id, { id, items: [], total: 0 });
      const g = grupos.get(id);
      g.items.push(a);
      g.total += montoEsperado(a);
    });
    return Array.from(grupos.values()).sort((x, y) => x.id.localeCompare(y.id));
  }

  const MENSAJES = Object.freeze({
    inexistente: 'La atención ya no existe.',
    no_pendiente: 'Esta atención no tiene un cobro pendiente.',
    atencion_no_vigente: 'La atención está cancelada o ausente.',
    medio_invalido: 'Elegí un medio de pago.',
    sin_permiso: 'Tu perfil no puede confirmar cobros.',
    en_curso: 'Ya se está confirmando este cobro.',
    monto_cambio: 'El importe cambió desde que se mostró. Se actualizó la lista: revisalo y confirmá de nuevo.',
    caja_cambio: 'La atención cambió: ahora corresponde a otra caja (profesional). Se actualizó la lista: revisala y confirmá de nuevo.',
    sin_autorizacion: 'No estás autorizada/o a confirmar el cobro de este profesional (asociación Secretaría–Médico). Consultá con Administración.',
    sync_pendiente: 'Hay cambios sin sincronizar. Esperá unos segundos y reintentá.',
    conflicto: 'Otra sesión modificó la atención a la vez. Se actualizó la lista: revisá y reintentá.',
    error_red: 'No se pudo confirmar el cobro. Revisá la conexión y reintentá.'
  });

  /* ------------------------- integración con app.js ------------------------- */
  function instalar(w) {
    const doc = w.document;
    const $id = (id) => doc.getElementById(id);
    const enCurso = new Set();
    let ultimoMensaje = '';

    const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
      (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
    const dinero = (n) => (typeof w.money === 'function' ? w.money(n) : '$' + Number(n || 0).toLocaleString('es-AR'));
    const rolActual = () => { try { return w.rolBaseUsuarioActual(); } catch (e) { return ''; } };
    const medicoPid = () => { try { return w.profesionalIdUsuarioActual(); } catch (e) { return ''; } };
    const usuarioNombre = () => { try { const u = w.perfilUsuarioActual(); return u?.nombre || u?.usuario || 'usuario'; } catch (e) { return 'usuario'; } };
    const uid = () => sesionSupabase()?.id || '';
    // `let`/`const` de app.js (atenciones, data, supabaseClient...) no son
    // propiedades de window: se leen por su nombre, protegidos con try.
    const listaAtenciones = () => { try { return Array.isArray(atenciones) ? atenciones : []; } catch (e) { return []; } };
    const clienteSupabase = () => { try { return typeof supabaseClient !== 'undefined' ? supabaseClient : null; } catch (e) { return null; } };
    const sesionSupabase = () => { try { return typeof usuarioSupabase !== 'undefined' ? usuarioSupabase : null; } catch (e) { return null; } };
    const nombreCaja = (id) => {
      try { return (data?.profesionales || []).find((p) => p.id === id)?.nombre || id; } catch (e) { return id; }
    };

    // Estilos propios y acotados (no se toca styles.css).
    if (!$id('cobrosV1Estilos')) {
      const estilo = doc.createElement('style');
      estilo.id = 'cobrosV1Estilos';
      estilo.textContent = [
        '.cobros-panel-v1{margin:0 0 16px}',
        '.cobros-head-v1 h3{margin:0 0 4px}',
        '.cobros-count-v1{display:inline-block;min-width:22px;padding:0 8px;border-radius:999px;background:rgba(200,60,60,.15);font-size:.8em;text-align:center}',
        '.cobros-msg-v1{margin:8px 0;padding:8px 10px;border-radius:8px;background:rgba(80,120,200,.12)}',
        '.cobro-grupo-v1{margin:10px 0;padding:8px 10px;border:1px solid rgba(128,128,128,.35);border-radius:10px}',
        '.cobro-grupo-v1 h4{margin:0 0 6px}',
        '.cobro-row-v1{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:8px 12px;align-items:center;padding:6px 0;border-top:1px solid rgba(128,128,128,.2)}',
        '.cobro-main-v1 small{display:block;opacity:.75}',
        '.cobro-monto-v1{font-weight:600;white-space:nowrap}',
        '.cobro-accion-v1{display:flex;gap:6px;align-items:center;flex-wrap:wrap}',
        '@media (max-width:640px){.cobro-row-v1{grid-template-columns:1fr auto}.cobro-accion-v1{grid-column:1/-1}}',
        '#cobroPendienteBox small{display:block;margin-top:4px}',
        '#cobroPendienteBox.is-disabled{opacity:.55}'
      ].join('');
      doc.head.appendChild(estilo);
    }

    // 1) Regla de Caja: cobroEfectivoAtencion es la única función de app.js
    //    que decide cuánto dinero cobrado aporta una atención.
    if (typeof w.cobroEfectivoAtencion === 'function' && !w.cobroEfectivoAtencion.__cobrosV1) {
      const original = w.cobroEfectivoAtencion;
      const envuelta = function (a) { return cobroEfectivoSegunEstado(a, original.apply(this, arguments)); };
      envuelta.__cobrosV1 = true;
      w.cobroEfectivoAtencion = envuelta;
    }

    // 2) Estado de cobro explícito en toda atención nueva del formulario.
    if (typeof w.crearAtencionDesdeFormulario === 'function' && !w.crearAtencionDesdeFormulario.__cobrosV1) {
      const original = w.crearAtencionDesdeFormulario;
      const envuelta = function () {
        const registro = original.apply(this, arguments);
        const check = $id('cobroPendiente');
        asignarEstadoCobroNuevo(registro, { pendiente: !!(check && check.checked && !check.disabled), usuario: usuarioNombre() });
        return registro;
      };
      envuelta.__cobrosV1 = true;
      w.crearAtencionDesdeFormulario = envuelta;
    }

    // 2b) Caja del día: un cobro confirmado hoy suma hoy aunque la prestación
    //     sea de otra fecha (cajaHoy filtra por a.fecha === hoy).
    if (typeof w.cajaHoy === 'function' && !w.cajaHoy.__cobrosV1) {
      const original = w.cajaHoy;
      const envuelta = function (datos) {
        const base = datos === undefined
          ? (typeof w.atencionesOperativas === 'function' ? w.atencionesOperativas() : listaAtenciones())
          : (Array.isArray(datos) ? datos : []);
        const hoy = typeof w.todayISO === 'function' ? w.todayISO() : '';
        const ids = new Set(base.map((a) => a && String(a.id)));
        const completa = typeof w.atencionesOperativas === 'function' ? w.atencionesOperativas() : listaAtenciones();
        const pagadasHoy = completa.filter((a) => a && !ids.has(String(a.id)) && a.fecha !== hoy && fechaCobroAtencion(a) === hoy);
        const lista = base.concat(pagadasHoy).map((a) => {
          const f = a ? fechaCobroAtencion(a) : '';
          return a && f !== a.fecha ? Object.assign({}, a, { fecha: f }) : a;
        });
        return original.call(this, lista);
      };
      envuelta.__cobrosV1 = true;
      w.cajaHoy = envuelta;
    }

    // 3) Etiqueta en el estado de cada fila del listado.
    if (typeof w.estadoHTML === 'function' && !w.estadoHTML.__cobrosV1) {
      const original = w.estadoHTML;
      const envuelta = function (a) {
        const html = original.apply(this, arguments);
        return esCobroPendiente(a) ? html + '<span class="badge bad informe-badge" title="El importe no entra en Caja hasta confirmar el cobro">Cobro pendiente</span>' : html;
      };
      envuelta.__cobrosV1 = true;
      w.estadoHTML = envuelta;
    }

    // 3b) Quien no confirma cobros (médico): no edita los datos económicos de un cobro ya
    //     confirmado por el flujo ni borra un cobro pendiente/confirmado (espejo del guard SQL).
    const buscar = (id) => listaAtenciones().find((x) => x && String(x.id) === String(id));
    if (typeof w.abrirModalEdicion === 'function' && !w.abrirModalEdicion.__cobrosV1) {
      const original = w.abrirModalEdicion;
      const envuelta = function (id) {
        const r = original.apply(this, arguments);
        if (edicionEconomicaBloqueada(rolActual(), buscar(id))) {
          ['m_tipoCobro', 'm_formaPago', 'm_noCobrar', 'm_particular', 'm_copago'].forEach((c) => {
            const campo = $id(c);
            if (campo) campo.disabled = true;
          });
          const tarjeta = doc.querySelector('#modalEdicionAtencion .modal-edit-header');
          if (tarjeta && !doc.getElementById('cobroBloqueadoAviso')) {
            const aviso = doc.createElement('p');
            aviso.id = 'cobroBloqueadoAviso';
            aviso.className = 'muted';
            aviso.textContent = 'El cobro ya fue confirmado por Secretaría: los datos económicos no se pueden modificar desde este perfil.';
            tarjeta.appendChild(aviso);
          }
        }
        return r;
      };
      envuelta.__cobrosV1 = true;
      w.abrirModalEdicion = envuelta;
    }
    if (typeof w.eliminarAtencion === 'function' && !w.eliminarAtencion.__cobrosV1) {
      const original = w.eliminarAtencion;
      const envuelta = function (id) {
        if (borradoBloqueado(rolActual(), buscar(id))) {
          w.alert('Esta atención tiene un cobro pendiente o confirmado: la elimina Secretaría o Administración.');
          return undefined;
        }
        return original.apply(this, arguments);
      };
      envuelta.__cobrosV1 = true;
      w.eliminarAtencion = envuelta;
    }

    // 4) Casilla "Cobro pendiente" del formulario de carga.
    function sincronizarCasilla() {
      const check = $id('cobroPendiente');
      if (!check) return;
      const tipo = limpio($id('tipoCobro')?.value).toLowerCase();
      const noCobrar = !!$id('noCobrar')?.checked;
      const aplica = !noCobrar && !SIN_COBRO_TIPOS.includes(tipo);
      check.disabled = !aplica;
      if (!aplica) check.checked = false;
      $id('cobroPendienteBox')?.classList.toggle('is-disabled', !aplica);
    }
    ['tipoCobro', 'noCobrar', 'obraSocial', 'prestacion'].forEach((id) => {
      $id(id)?.addEventListener('change', sincronizarCasilla);
      $id(id)?.addEventListener('input', sincronizarCasilla);
    });
    $id('formAtencion')?.addEventListener('reset', () => setTimeout(sincronizarCasilla, 0));
    sincronizarCasilla();

    // 5) Persistencia de la confirmación (sin SQL nuevo): lectura fresca de la
    //    fila + UPDATE condicionado por updated_at (mismo mecanismo B1.5 que
    //    el sync normal). Si otra sesión ya la confirmó, no se escribe nada.
    function adoptar(id, payload, version) {
      const lista = listaAtenciones();
      const pos = lista.findIndex((x) => x && String(x.id) === String(id));
      if (pos >= 0) lista[pos] = payload;
      try { w.confirmarVersionRemotaAtencion298?.(id, payload, version, !version); } catch (e) { /* sin baseline */ }
      try { w.localStorage.setItem(storageAtenciones, JSON.stringify(lista)); } catch (e) { /* sin storage */ }
    }

    // Identidad de la confirmación = la de la sesión autenticada (v4.2.1): el guard SQL exige que id, email y el nombre
    // visible coincidan con el JWT; un nombre libre del perfil ya no se acepta como identidad auditada.
    function contextoConfirmacion(medio, montoVisto, cajaVista) {
      const email = limpio(sesionSupabase()?.email || '');
      return { medio, montoVisto, cajaVista, usuario: email || usuarioNombre(), usuarioId: uid(), rol: rolParaAuditoria(rolActual()), email };
    }

    async function confirmarCobroPersistido(id, medio, montoVisto, cajaVista) {
      const idStr = String(id);
      if (!rolPuedeConfirmarCobro(rolActual())) return { ok: false, codigo: 'sin_permiso' };
      if (enCurso.has(idStr)) return { ok: false, codigo: 'en_curso' };
      enCurso.add(idStr);
      try {
        const sb = clienteSupabase();
        if (!sb || !sesionSupabase()) {
          // Modo local sin sesión Supabase: misma transición, guardado local.
          const local = listaAtenciones().find((x) => x && String(x.id) === idStr);
          const r = confirmarCobro(local, contextoConfirmacion(medio, montoVisto, cajaVista));
          if (r.ok && !r.yaConfirmado) { adoptar(idStr, r.payload, null); w.saveAtenciones?.(); }
          return r;
        }
        // Una fila local con cambios sin subir se perdería al adoptar la remota.
        if (w.hayPendientesSync298?.()) {
          try { await w.sincronizarAtencionesSupabase?.(false); } catch (e) { /* se informa abajo */ }
          if (w.hayPendientesSync298?.()) return { ok: false, codigo: 'sync_pendiente' };
        }
        for (let intento = 0; intento < 2; intento += 1) {
          const lectura = await sb.from('cardiolink_atenciones').select('id,payload,updated_at').eq('id', idStr).limit(1);
          if (lectura.error) return { ok: false, codigo: 'error_red', detalle: lectura.error.message };
          const fila = Array.isArray(lectura.data) ? lectura.data[0] : lectura.data;
          if (!fila || !fila.payload) return { ok: false, codigo: 'inexistente' };
          const r = confirmarCobro(fila.payload, contextoConfirmacion(medio, montoVisto, cajaVista));
          if (!r.ok || r.yaConfirmado) { adoptar(idStr, fila.payload, fila.updated_at); return r; }
          const escritura = await sb.from('cardiolink_atenciones')
            .update({ payload: r.payload, updated_at: new Date().toISOString() })
            .eq('id', idStr).eq('updated_at', fila.updated_at)
            .select('id, updated_at');
          // 42501: el guard SQL v4.2 rechaza la escritura (Secretaría no asociada al profesional, rol sin permiso).
          if (escritura.error) {
            if (escritura.error.code === '42501') return { ok: false, codigo: 'sin_autorizacion' };
            return { ok: false, codigo: 'error_red', detalle: escritura.error.message };
          }
          if (Array.isArray(escritura.data) && escritura.data.length > 0) {
            adoptar(idStr, r.payload, escritura.data[0].updated_at);
            return r;
          }
          // 0 filas: otra sesión escribió entre la lectura y el UPDATE. Se
          // vuelve a leer: si ya está cobrada, queda idempotente.
        }
        return { ok: false, codigo: 'conflicto' };
      } finally {
        enCurso.delete(idStr);
      }
    }

    // 6) Panel "Cobros pendientes" dentro de Pendientes.
    function pendientesVisibles() {
      const lista = typeof w.atencionesOperativas === 'function' ? w.atencionesOperativas() : listaAtenciones();
      const rol = rolActual();
      const pid = medicoPid();
      return lista.filter((a) => esCobroPendiente(a) && puedeVerCobroPendiente(rol, pid, a));
    }

    function renderPanel() {
      const box = $id('cobrosPendientesPanelV1');
      if (!box) return;
      const lista = pendientesVisibles();
      const puedeConfirmar = rolPuedeConfirmarCobro(rolActual());
      const verTotales = rolVeTotalesPorProfesional(rolActual());
      const aviso = ultimoMensaje ? `<p class="cobros-msg-v1" role="status">${esc(ultimoMensaje)}</p>` : '';
      if (!lista.length) {
        box.innerHTML = `<div class="cobros-head-v1"><h3>Cobros pendientes <span class="cobros-count-v1">0</span></h3></div>${aviso}<p class="muted">No hay cobros pendientes.</p>`;
        return;
      }
      const grupos = agruparPorCaja(lista).map((g) => {
        const filas = g.items.slice().sort((x, y) => String(x.fecha || '').localeCompare(String(y.fecha || ''))).map((a) => {
          const id = esc(a.id);
          const accion = puedeConfirmar
            ? `<select data-cobro-medio="${id}" aria-label="Medio de pago">${MEDIOS.map((m) => `<option>${esc(m)}</option>`).join('')}</select>
               <button type="button" data-cobro-confirmar="${id}" data-cobro-monto="${montoEsperado(a)}" data-cobro-caja="${esc(cajaDe(a))}">Confirmar cobro</button>`
            : '<span class="muted">Lo confirma Secretaría</span>';
          const fecha = typeof w.formatFecha === 'function' ? w.formatFecha(a.fecha) : a.fecha;
          return `<div class="cobro-row-v1"><div class="cobro-main-v1"><strong>${esc(a.paciente || 'Paciente')}</strong>
            <small>${esc(fecha || '')}${a.horaInicio ? ' · ' + esc(a.horaInicio) : ''} · ${esc(a.prestacion || '')} · ${esc(a.obraSocial || '')}</small></div>
            <div class="cobro-monto-v1">${dinero(montoEsperado(a))}</div><div class="cobro-accion-v1">${accion}</div></div>`;
        }).join('');
        const total = verTotales ? ` · ${dinero(g.total)}` : '';
        return `<section class="cobro-grupo-v1"><h4>${esc(nombreCaja(g.id))} · ${g.items.length}${total}</h4>${filas}</section>`;
      }).join('');
      box.innerHTML = `<div class="cobros-head-v1"><h3>Cobros pendientes <span class="cobros-count-v1">${lista.length}</span></h3>
        <p class="muted">Prestaciones realizadas cuyo importe todavía no entró en Caja. Al confirmar se registra fecha, usuario y medio de pago.</p></div>${aviso}${grupos}`;
    }

    async function alConfirmar(boton) {
      const id = boton.getAttribute('data-cobro-confirmar');
      const select = Array.from(doc.querySelectorAll('[data-cobro-medio]')).find((s) => s.getAttribute('data-cobro-medio') === id);
      const medio = select ? select.value : '';
      boton.disabled = true;
      boton.textContent = 'Confirmando…';
      if (select) select.disabled = true;
      let r;
      try { r = await confirmarCobroPersistido(id, medio, Number(boton.getAttribute('data-cobro-monto')), boton.getAttribute('data-cobro-caja')); } catch (e) { r = { ok: false, codigo: 'error_red', detalle: e?.message }; }
      if (r.ok) {
        ultimoMensaje = r.yaConfirmado
          ? 'Ese cobro ya estaba confirmado por otra sesión: no se registró de nuevo.'
          : 'Cobro confirmado: ' + (r.payload?.paciente || 'paciente') + ' · ' + medio + '.';
      } else {
        ultimoMensaje = (MENSAJES[r.codigo] || 'No se pudo confirmar el cobro.') + (r.detalle ? ' (' + r.detalle + ')' : '');
      }
      renderPanel();
      try { w.renderTabla?.(); w.renderStats?.(); } catch (e) { /* vistas no montadas */ }
    }

    $id('cobrosPendientesPanelV1')?.addEventListener('click', (ev) => {
      const boton = ev.target?.closest?.('[data-cobro-confirmar]');
      if (boton && !boton.disabled) alConfirmar(boton);
    });

    const visible = () => !!$id('pendientes383')?.classList.contains('visible');
    if (typeof w.showSection === 'function' && !w.showSection.__cobrosV1) {
      const original = w.showSection;
      const envuelta = function (id) {
        const r = original.apply(this, arguments);
        if (id === 'pendientes383') { ultimoMensaje = ''; renderPanel(); }
        return r;
      };
      envuelta.__cobrosV1 = true;
      w.showSection = envuelta;
    }
    // El refresco automático (30 s) repinta el listado: se aprovecha para
    // mantener actualizado el panel cuando está a la vista.
    if (typeof w.renderTabla === 'function' && !w.renderTabla.__cobrosV1) {
      const original = w.renderTabla;
      const envuelta = function () {
        const r = original.apply(this, arguments);
        if (visible()) renderPanel();
        return r;
      };
      envuelta.__cobrosV1 = true;
      w.renderTabla = envuelta;
    }
    renderPanel();

    w.CardioLinkCobrosV1Panel = Object.freeze({ renderPanel, confirmarCobroPersistido, pendientesVisibles });
  }

  return Object.freeze({
    ESTADO, MEDIOS, MENSAJES,
    estadoCobroDe, montoEsperado, esCobroPendiente, fechaCobroAtencion, cobroEfectivoSegunEstado,
    asignarEstadoCobroNuevo, rolPuedeConfirmarCobro, rolVeTotalesPorProfesional,
    puedeVerCobroPendiente, confirmarCobro, edicionEconomicaBloqueada, borradoBloqueado, agruparPorCaja, cajaDe, rolParaAuditoria, instalar
  });
});
