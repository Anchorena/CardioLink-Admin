/* CardioLink · Seguridad clínica V1 · Bloque 4B  (v3, tras segunda revisión técnica)
   Configuración administrativa de SECRETARÍA por RPC (nunca la fila completa __cardiolink_config_v1).
   Cargar DESPUÉS de app.js. app.js lo invoca desde cargarAtencionesDesdeSupabase (cargar) y guardarConfigEnSupabase298 (guardar).

   El control real está en Supabase (RLS + RPC SECURITY DEFINER, docs/propuestas/pending_review_config_secretaria_v1_*.sql). Este módulo:
   - SIN FALLBACK: si la RPC no existe o falla, NO se guarda la config completa por otra vía; el error se muestra (aviso rojo persistente) y los cambios
     locales quedan resguardados y recuperables (clave cardiolink_config_pendiente_v1_<uid>);
   - pide la vista administrativa (listas explícitas de claves y de campos anidados) y recuerda updated_at + vista_hash como versión base;
   - al guardar envía SÓLO claves de escritura y SÓLO campos anidados permitidos (pacientes administrativos; profesionales sin identidad documental);
     el servidor fusiona y conserva todo lo demás, y es quien decide (esto es defensa en profundidad);
   - serializa los guardados (no compite contra sí mismo) y, si hay cambios sin guardar, NO deja que una recarga pise la copia local;
   - ante conflicto o rechazo del servidor no pisa nada: resguarda la versión local, avisa y no la marca como guardada;
   - SIN VERSIÓN BASE (v3.3): un guardado que llega antes de leer la versión base (p. ej. el guardado automático de arranque) NO genera un pendiente: espera a que termine la
     carga inicial (el cargador de app.js avisa con cargaTerminada()); si la carga dejó la base, se reevalúa con la configuración ya derivada de ella y, si es idéntica
     a la del servidor, no se escribe nada. Un pendiente «sin_base» ya existente se recupera: se lee la base remota y se compara; idéntico → se elimina el pendiente
     redundante; con diferencias → se PRESERVA como conflicto (nunca se descarta ni se envía con una base inventada).
   - CAMBIO DE SESIÓN (v3): cada operación se ata al usuario que la inició. Antes de enviar se verifica que la sesión viva sea la suya (y el servidor lo
     vuelve a verificar con p_uid_esperado); si cambió o se cerró, NO se envía: el cambio queda resguardado bajo SU uid y las respuestas tardías se descartan.
   Las listas DEBEN coincidir con las del SQL (tests/config-secretaria-v1.js lo verifica). */
(function () {
  'use strict';
  if (window.cardiolinkConfigSecretariaV1) return;

  // CLAVES_LECTURA_INICIO
  const CLAVES_LECTURA = [
    'profesionales', 'especialidades', 'obrasSociales', 'reglasOS', 'pacientes', 'usuarios', 'roles', 'colocadores',
    'medicosDerivantes', 'motivosConsulta', 'bloquesPrestaciones', 'bloquesPrestacionesLabels', 'horariosProfesionales',
    'arancelesPorProfesional', 'conveniosPorProfesional', 'conveniosFacturacion', 'arancelesConvenios', 'plantillasPedidos',
    'duracionesPrestacion', 'catalogoPrestaciones411P', 'destinosFacturacion', 'brandingCardioLink', 'auditoriaPacientes',
    'migracionesCardioLink', 'documentosClinicos'
  ];
  // CLAVES_LECTURA_FIN
  // CLAVES_ESCRITURA_INICIO
  const CLAVES_ESCRITURA = [
    'profesionales', 'especialidades', 'obrasSociales', 'reglasOS', 'pacientes', 'colocadores',
    'medicosDerivantes', 'motivosConsulta', 'bloquesPrestaciones', 'bloquesPrestacionesLabels', 'horariosProfesionales',
    'arancelesPorProfesional', 'conveniosPorProfesional', 'conveniosFacturacion', 'arancelesConvenios', 'plantillasPedidos',
    'duracionesPrestacion', 'catalogoPrestaciones411P', 'destinosFacturacion', 'auditoriaPacientes'
  ];
  // CLAVES_ESCRITURA_FIN
  // CAMPOS_IDENTIDAD_INICIO
  const CAMPOS_IDENTIDAD = [
    'marcaDocumento', 'logoDocumento', 'logoDocumentoData', 'firmaDocumentoData', 'matriculaNacional', 'matriculaProvincial',
    'telefonoDocumento', 'emailDocumento', 'direccionDocumento', 'redesDocumento', 'colorDocumento', 'mostrarFirmaDocumento'
  ];
  // CAMPOS_IDENTIDAD_FIN
  // CAMPOS_PACIENTE_INICIO
  const CAMPOS_PACIENTE = [
    'id', 'nombreCompleto', 'dni', 'sexo', 'telefono', 'email', 'fechaNacimiento', 'localidad', 'direccion', 'provincia',
    'coberturaHabitual', 'numeroAfiliadoHabitual', 'historialCoberturas', 'contactoResponsableNombre', 'contactoResponsableRelacion',
    'contactoResponsableTelefono', 'contactoResponsableEmail', 'observacionesAdministrativas', 'estado', 'fusionadoCon', 'fusionadoEn',
    'fusionadoPor', 'creadoEn', 'creadoPor', 'actualizadoEn', 'actualizadoPor', 'creadoPorImportacionLote'
  ];
  // CAMPOS_PACIENTE_FIN
  // CAMPOS_PROFESIONAL_INICIO
  const CAMPOS_PROFESIONAL_ADMIN = ['id', 'nombre', 'area', 'prestaciones', 'valores', 'especialidadIds', 'bloquesPrestaciones', 'activo'];
  // CAMPOS_PROFESIONAL_FIN
  // TIPOS_DOC_INICIO
  const TIPOS_DOC_LECTURA = ['constancia_atencion', 'certificado', 'reposo_laboral', 'orden'];
  // TIPOS_DOC_FIN

  // Dos ranuras por usuario: PENDIENTE (reintentable; una recarga no la pisa) y CONFLICTO (conflicto/rechazo; se conserva hasta que el usuario la descargue o descarte).
  const CLAVE_PENDIENTE = 'cardiolink_config_pendiente_v1_';
  const CLAVE_CONFLICTO = 'cardiolink_config_conflicto_v1_';
  const ID_AVISO = 'cardiolinkConfigSecretariaAviso';

  // R2B: proyección de ESCRITURA (sólo claves autorizadas) de la última vista confirmada/cargada: es la «base» de la fusión de tres vías (motor cardiolink-config-merge-v1.js).
  let baseVista = null, ultimaCarga = null;
  function motor() { return (typeof window !== 'undefined' && window.cardiolinkConfigMergeV1) ? window.cardiolinkConfigMergeV1 : null; }
  function neutroSec(b) {
    try { return sanear(normalizarConfigCritica(JSON.parse(JSON.stringify(b))), CLAVES_ESCRITURA, true); } catch (e) { return undefined; }
  }
  // R2B: el local que ve el motor excluye la semilla en memoria de horariosProfesionales (agenda-v1), que no debe persistirse por un guardado ajeno.
  function r2b() { return (typeof window !== 'undefined' && window.cardiolinkConfigR2B) ? window.cardiolinkConfigR2B : null; }
  function localEsc() {
    if (typeof data === 'undefined' || !data) return {};
    const rr = r2b();
    const fuente = (rr && rr.localSinSemilla) ? rr.localSinSemilla(baseVista) : data;
    return sanear(fuente, CLAVES_ESCRITURA, true);
  }
  function conSemilla(fn) { const rr = r2b(); const s = rr && rr.semilla ? rr.semilla() : null; fn(); if (s && rr.reponerSemilla) rr.reponerSemilla(s); }
  let base = { updatedAt: null, hash: null, uid: null };   // versión administrativa recibida / confirmada por el servidor, atada al usuario que la leyó
  // estado: 'ok' | 'pendiente' (reintentable: red, RPC ausente, sin versión base) | 'rechazo' (el servidor rechazó el contenido) | 'conflicto'
  let estado = 'ok';
  let cola = Promise.resolve();
  let restauradoPara = null;                    // uid para el que ya se leyó el resguardo
  let ultimoAviso = '';
  const avisados = {};
  // Cambio de sesión (v3): true cuando la sesión del navegador dejó de ser la del usuario de esta pantalla (cierre de sesión, otro usuario en otra pestaña).
  // Mientras sea true NINGUNA operación sale hacia el servidor desde este módulo; lo pendiente queda resguardado bajo el uid de quien lo inició.
  let sesionCambiada = false;
  // v3.3: carga inicial / versión base. `vistaServidor` = vista de escritura del servidor al leer la base (para saber si algo difiere).
  const ESPERA_BASE_MS = 30000;
  let vistaServidor = null;
  let cargaTerminadaUid = null;
  const esperando = [];
  let vigilando = false;

  function cliente() { return (typeof supabaseClient !== 'undefined' && supabaseClient) ? supabaseClient : null; }
  function sesion() { return (typeof usuarioSupabase !== 'undefined' && usuarioSupabase) ? usuarioSupabase : null; }
  function uid() { const s = sesion(); return s ? String(s.id) : 'anon'; }
  function mismaSesion(u) { return !sesionCambiada && !!sesion() && uid() === String(u); }
  // Id del usuario de la sesión VIVA de supabase-js (la que firmará la próxima llamada) o null. Fail-closed: sin poder confirmarlo no se envía nada.
  async function sesionVivaId(c) {
    try {
      if (!c || !c.auth || typeof c.auth.getSession !== 'function') return null;
      const r = await c.auth.getSession();
      const s = r && r.data && r.data.session;
      return s && s.user && s.user.id != null ? String(s.user.id) : null;
    } catch (e) { return null; }
  }
  async function sesionVigente(c, u) { return mismaSesion(u) && (await sesionVivaId(c)) === String(u) && mismaSesion(u); }
  function vigilarSesion(c) {
    if (vigilando || !c || !c.auth || typeof c.auth.onAuthStateChange !== 'function') return;
    vigilando = true;
    try {
      c.auth.onAuthStateChange(function (evento, ses) {
        const u = ses && ses.user && ses.user.id != null ? String(ses.user.id) : null;
        const actual = sesion() ? uid() : null;
        if (evento === 'SIGNED_OUT' || (u && actual && u !== actual)) sesionCambiada = true;
        else if (evento === 'SIGNED_IN' && u && actual && u === actual) sesionCambiada = false;
      });
    } catch (e) { vigilando = false; }
  }

  // Mismas condiciones con las que app.js resuelve el rol 'secretaria' (rolBaseUsuarioActual); el servidor igual exige rol activo = secretaria.
  function aplica() {
    try {
      return !!cliente() && !!sesion() &&
        backendRolCargado === true && backendEsAdminOwner !== true && backendTieneAccesoTurnos === true && !esMedicoBackendV1();
    } catch (e) { return false; }
  }

  function rpcAusente(error) {
    const msg = String((error && (error.message || error.details)) || '');
    return !!error && (error.code === 'PGRST202' || error.code === '42883' || /could not find the function|schema cache|does not exist/i.test(msg));
  }

  // ---------- saneamiento (defensa en profundidad; el servidor decide) ----------
  function soloCampos(obj, campos) {
    const out = {};
    campos.forEach(function (k) { if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] !== undefined) out[k] = obj[k]; });
    return out;
  }
  function filtrarLista(lista, campos) {
    return (Array.isArray(lista) ? lista : []).filter(function (e) { return e && typeof e === 'object' && !Array.isArray(e); })
      .map(function (e) { return soloCampos(e, campos); });
  }
  function sanearClave(k, valor, paraEscribir) {
    if (k === 'pacientes' && Array.isArray(valor)) return filtrarLista(valor, CAMPOS_PACIENTE);
    if (k === 'profesionales' && Array.isArray(valor)) {
      return filtrarLista(valor, paraEscribir ? CAMPOS_PROFESIONAL_ADMIN : CAMPOS_PROFESIONAL_ADMIN.concat(CAMPOS_IDENTIDAD));
    }
    if (k === 'documentosClinicos' && Array.isArray(valor)) {
      return valor.filter(function (d) { return d && typeof d === 'object' && TIPOS_DOC_LECTURA.indexOf(d.tipo) >= 0; });
    }
    return valor;
  }
  function sanear(obj, claves, paraEscribir) {
    const out = {};
    if (!obj || typeof obj !== 'object') return out;
    claves.forEach(function (k) {
      if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] !== undefined && obj[k] !== null) out[k] = sanearClave(k, obj[k], paraEscribir);
    });
    return out;
  }

  // Serialización estable (claves ordenadas) para comparar contenidos.
  function estable(v) {
    if (Array.isArray(v)) return '[' + v.map(estable).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + estable(v[k]); }).join(',') + '}';
    return JSON.stringify(v === undefined ? null : v);
  }
  function vistaEscritura(cfg) { return estable(sanear(cfg, CLAVES_ESCRITURA, true)); }

  // ---------- aviso visible persistente + resguardo recuperable ----------
  function boton(texto, fn) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = texto;
    b.style.cssText = 'margin-left:8px;padding:4px 10px;border-radius:6px;border:1px solid #fff;background:transparent;color:#fff;font-weight:700;cursor:pointer';
    b.addEventListener('click', fn);
    return b;
  }
  function mostrarAviso(texto, acciones) {
    ultimoAviso = texto;
    try {
      if (typeof document === 'undefined' || !document.body) return;
      let d = document.getElementById(ID_AVISO);
      if (!d) {
        d = document.createElement('div'); d.id = ID_AVISO;
        d.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99998;background:#a13636;color:#fff;padding:10px 16px;font:700 14px Arial,sans-serif;text-align:center;box-shadow:0 -4px 14px rgba(0,0,0,.25)';
        document.body.appendChild(d);
      }
      d.textContent = texto;
      (acciones || []).forEach(function (a) { d.appendChild(boton(a[0], a[1])); });
      d.style.display = 'block';
    } catch (e) { /* sin UI */ }
  }
  function ocultarAviso() {
    ultimoAviso = '';
    try { const d = (typeof document !== 'undefined') ? document.getElementById(ID_AVISO) : null; if (d) d.style.display = 'none'; } catch (e) { /* sin UI */ }
  }
  // Los resguardos están atados al usuario que inició la operación (u), nunca al que esté activo cuando se resuelva: un cambio de sesión no los mezcla.
  function claveDe(tipo, u) {
    const base = tipo === 'pendiente' ? CLAVE_PENDIENTE : CLAVE_CONFLICTO, id = (u == null ? uid() : String(u));
    // Seguridad local V1: clave por PROYECTO + UID (<base>:<proyecto>:<uid>). Sin el módulo (o sin uid) se usa la clave heredada <base>_<uid>. No es confidencialidad (localStorage no está cifrado).
    try { const S = (typeof window !== 'undefined') ? window.cardiolinkSeguridadLocalV1 : null; if (S && id) return S.clave(base.replace(/_$/, ''), id); } catch (e) { /* clave heredada */ }
    return base + id;
  }
  function leerResguardo(tipo, u) {
    try { return JSON.parse(localStorage.getItem(claveDe(tipo, u)) || 'null'); } catch (e) { return null; }
  }
  function resguardar(tipo, motivo, cfg, u, baseUsada) {
    try {
      localStorage.setItem(claveDe(tipo, u), JSON.stringify({ fecha: new Date().toISOString(), tipo: tipo, motivo: motivo, base: baseUsada || base, config: cfg }));
      return true;
    } catch (e) { console.warn('No se pudo resguardar la configuración local:', e); return false; }
  }
  function limpiarResguardo(tipo, u) { try { localStorage.removeItem(claveDe(tipo, u)); } catch (e) { /* sin almacenamiento */ } }
  function descartarResguardo() { limpiarResguardo('conflicto'); if (estado !== 'pendiente') { estado = 'ok'; ocultarAviso(); } }
  function descargarResguardo() {
    try {
      const r = leerResguardo('pendiente') || leerResguardo('conflicto'); if (!r) return false;
      const blob = new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'cardiolink-config-resguardo.json';
      document.body.appendChild(a); a.click(); a.remove();
      return true;
    } catch (e) { return false; }
  }

  // Texto del aviso para una versión local resguardada como conflicto: el caso «sin versión base con diferencias» se explica aparte.
  function textoConflicto(c) {
    if (c && c.motivo === 'sin_base_con_diferencias') {
      return 'Hay cambios de configuración guardados SOLO en este equipo, sin versión base verificable, que difieren del servidor. Están resguardados (no se enviaron ni se descartaron) y se cargó la versión del servidor. Descargá la copia para revisarla y descartala cuando ya no la necesites.';
    }
    return 'Hay una versión local de la configuración resguardada que no se guardó (conflicto o rechazo anterior).';
  }
  function avisoPendiente(texto) {
    mostrarAviso(texto + ' Los cambios de configuración recientes siguen SOLO en este equipo, aunque la pantalla haya confirmado el guardado.',
      [['Reintentar', function () { reintentar(); }], ['Descargar copia', descargarResguardo]]);
  }
  function avisoDescartable(texto) {
    mostrarAviso(texto, [['Descargar copia', descargarResguardo], ['Descartar', descartarResguardo]]);
  }

  // Un fallo de guardado: la versión local queda resguardada (bajo el usuario que inició la operación) y el estado impide que una recarga la pise (salvo conflicto/rechazo).
  function fallo(tipo, motivo, texto, cfg, u, baseUsada) {
    resguardar(tipo, motivo, cfg, u, baseUsada);
    if (u != null && uid() !== String(u)) return false;   // la pantalla ya es de otro usuario: no se toca su estado ni su aviso
    estado = tipo;                      // 'pendiente' | 'rechazo'
    if (tipo === 'pendiente') avisoPendiente(texto); else avisoDescartable(texto + ' Tu versión quedó resguardada en este equipo.');
    return false;
  }
  // La sesión cambió o se cerró antes de enviar: NADA se envía. El cambio queda resguardado para el usuario que lo inició.
  function abortarPorSesion(u, cfg, baseUsada) {
    resguardar('pendiente', 'sesion_distinta', cfg, u, baseUsada);
    if (uid() === String(u)) {
      estado = 'pendiente';
      mostrarAviso('La sesión cambió o se cerró mientras se guardaba la configuración: el cambio NO se envió al servidor y quedó resguardado en este equipo. ' +
        'Recargá la página e iniciá sesión con tu usuario.', [['Descargar copia', descargarResguardo]]);
    }
    return false;
  }

  function restaurarResguardo() {
    const u = uid();
    if (restauradoPara === u) return;
    if (restauradoPara !== null) { estado = 'ok'; base = { updatedAt: null, hash: null, uid: u }; ocultarAviso(); }   // otro usuario: no se arrastra nada del anterior
    restauradoPara = u;
    const p = leerResguardo('pendiente', u);
    if (p) {
      estado = 'pendiente';
      if (p.base && p.base.updatedAt) base = p.base;   // se reintenta contra la versión sobre la que se editó, no contra la actual
      avisoPendiente('Hay cambios de configuración sin sincronizar de una sesión anterior.');
      return;
    }
    const c = leerResguardo('conflicto', u);
    if (c) {
      estado = c.tipo === 'conflicto' ? 'conflicto' : 'rechazo';
      avisoDescartable(c.motivo === 'sin_base_con_diferencias' ? textoConflicto(c)
        : 'Hay una versión local de la configuración resguardada (' + (c.tipo === 'conflicto' ? 'conflicto con otro equipo' : 'rechazada por el servidor') + ').');
    }
  }

  // ---------- carga ----------
  // Devuelve {config} | {config:null} (sin fila) | {retenido:true} (hay cambios locales sin guardar: no se pisan) | {error}. Nunca la fila completa.
  // Si la sesión cambió mientras se esperaba la respuesta, la respuesta se DESCARTA (podría ser de otro usuario).
  // v3.3: un pendiente SIN versión base (sin_base) no bloquea la carga: se recupera la base remota y se compara con lo pendiente (ver resolverSinBase).
  async function cargar() {
    const c = cliente();
    if (!c) return { error: 'sin cliente' };
    const u = uid();
    vigilarSesion(c);
    restaurarResguardo();
    let pend = null;
    if (estado === 'pendiente') {
      pend = leerResguardo('pendiente', u);
      if (!pend || (pend.base && pend.base.updatedAt)) return { retenido: true };   // con su base original (o sólo en memoria): se reintenta contra ella, no se relee
    }
    if (!(await sesionVigente(c, u))) {
      mostrarAviso('La sesión cambió o se cerró: no se cargó la configuración. Recargá la página e iniciá sesión con tu usuario.');
      return { error: 'sesion_distinta' };
    }
    try {
      const res = await c.rpc('cardiolink_config_administrativa_v1');
      if (!mismaSesion(u)) return { error: 'sesion_distinta' };
      if (res.error) {
        const texto = rpcAusente(res.error)
          ? 'El servidor no tiene habilitada la configuración administrativa. Se usa la copia de este equipo y NO se podrán guardar cambios de configuración hasta que se habilite.'
          : 'No se pudo cargar la configuración del servidor (' + (res.error.message || res.error.code || 'error') + '). Se usa la copia de este equipo.';
        mostrarAviso(texto, [['Reintentar', function () { cargarYAplicar(); }]]);
        return pend ? { retenido: true } : { error: res.error.message || String(res.error) };
      }
      const r = res.data;
      if (!r || r.ok !== true) { mostrarAviso('Respuesta inesperada del servidor al cargar la configuración. Se usa la copia de este equipo.'); return pend ? { retenido: true } : { error: 'respuesta inesperada del servidor' }; }
      if (r.config === null || r.config === undefined) return pend ? { retenido: true } : { config: null };
      // R2B: la base sólo AVANZA si no hay cambios locales sin guardar; con cambios pendientes se conserva la base sobre la que se editó (la fusión la usa).
      const vistaEsc = clonar(sanear(r.config, CLAVES_ESCRITURA, true)), metaNueva = { updatedAt: r.updated_at || null, hash: r.vista_hash || null, uid: u };
      let avanzo = true; const mo = motor();
      if (mo && baseVista && !pend) { try { avanzo = !mo.hayCambiosLocales(baseVista, localEsc(), { neutro: neutroSec(baseVista) }); } catch (e) { avanzo = true; } }
      ultimaCarga = { meta: metaNueva, vistaEsc: vistaEsc, avanzo: avanzo };
      if (avanzo) { base = metaNueva; baseVista = vistaEsc; }
      vistaServidor = vistaEscritura(r.config);
      let sinBase = null;
      if (pend) {
        sinBase = resolverSinBase(u, pend);
        if (sinBase === 'no_resuelto') return { retenido: true };
      } else if (estado === 'ok') ocultarAviso();
      const out = { config: sanear(r.config, CLAVES_LECTURA, false), meta: metaNueva, vistaEsc: vistaEsc, avanzo: avanzo };   // aunque el servidor mande más, se descarta
      if (sinBase) out.sinBase = sinBase;
      return out;
    } catch (e) {
      console.warn('Error de red al cargar la configuración administrativa:', e);
      mostrarAviso('Sin conexión con el servidor: no se pudo cargar la configuración. Se usa la copia de este equipo.');
      return pend ? { retenido: true } : { error: String((e && e.message) || e) };
    }
  }
  // Pendiente SIN versión base: ya se leyó la base remota. Idéntico al servidor → se elimina el pendiente redundante. Con diferencias → se PRESERVA como conflicto
  // (se escribe primero el conflicto; sólo si quedó escrito se retira el pendiente) y se pide resolución; nunca se envía ni se descarta.
  function resolverSinBase(u, pend) {
    const cfgPend = pend && pend.config;
    if (!cfgPend || typeof cfgPend !== 'object') { limpiarResguardo('pendiente', u); estado = leerResguardo('conflicto', u) ? 'conflicto' : 'ok'; if (estado === 'ok') ocultarAviso(); return 'identico'; }
    if (vistaEscritura(cfgPend) === vistaServidor) {
      limpiarResguardo('pendiente', u);
      const cp = leerResguardo('conflicto', u);
      if (cp) { estado = 'conflicto'; avisoDescartable(textoConflicto(cp)); }
      else { estado = 'ok'; ocultarAviso(); }
      return 'identico';
    }
    try {
      const previo = leerResguardo('conflicto', u);
      const nuevo = { fecha: new Date().toISOString(), tipo: 'conflicto', motivo: 'sin_base_con_diferencias', base: null, config: cfgPend, pendienteOriginal: { fecha: pend.fecha, motivo: pend.motivo } };
      if (previo) nuevo.anteriores = (previo.anteriores || []).concat([{ fecha: previo.fecha, motivo: previo.motivo, config: previo.config }]);
      localStorage.setItem(claveDe('conflicto', u), JSON.stringify(nuevo));
    } catch (e) {
      console.warn('No se pudo resguardar como conflicto el pendiente sin versión base; se conserva el pendiente:', e);
      avisoPendiente('Hay cambios de configuración sin sincronizar que difieren del servidor y no se pudieron resguardar aparte.');
      return 'no_resuelto';
    }
    limpiarResguardo('pendiente', u);
    estado = 'conflicto';
    avisoDescartable(textoConflicto({ motivo: 'sin_base_con_diferencias' }));
    return 'diferencias';
  }
  // El cargador (app.js) avisa que terminó la carga inicial de este usuario (con o sin éxito): libera a los guardados que esperaban la versión base.
  function cargaTerminada() {
    cargaTerminadaUid = uid();
    esperando.splice(0).forEach(function (f) { f(); });
  }
  // true = tras la carga inicial hay versión base de ESTE usuario; false = no la hay (la carga falló) o venció la espera.
  function esperarBase(u) {
    return new Promise(function (res) {
      const ok = function () { return base.updatedAt && String(base.uid) === String(u) ? true : false; };
      if (cargaTerminadaUid === String(u)) { res(ok()); return; }
      let hecho = false;
      const fin = function () { if (hecho) return; hecho = true; res(ok()); };
      esperando.push(fin);
      if (typeof setTimeout === 'function') setTimeout(fin, ESPERA_BASE_MS);
    });
  }
  // Recarga manual desde el aviso: si trae configuración la aplica a `data` con la misma normalización de app.js.
  async function cargarYAplicar() {
    const r = await cargar();
    if (r && r.config && typeof normalizarConfigCritica === 'function') {
      try { data = normalizarConfigCritica(r.config); localStorage.setItem(storageConfig, JSON.stringify(data)); } catch (e) { console.warn(e); }
    }
    return r;
  }

  // ---------- guardado ----------
  // cfg: instantánea ya saneada (tomada en el momento de iniciar la operación); u: usuario que la inició; b: versión base explícita (reintento) o null.
  async function ejecutarGuardar(cfg, b, u, intento) {
    intento = intento || 0;
    const c = cliente();
    if (!c) return false;
    vigilarSesion(c);
    let baseUsada = b || base;
    // 1) La operación pertenece a `u`. Si la sesión viva ya no es la suya, NO se envía (ni se envía con las credenciales de otro).
    if (!(await sesionVigente(c, u))) return abortarPorSesion(u, cfg, baseUsada);
    // 1b) v3.3: sin versión base todavía (p. ej. guardado automático de arranque): NO se genera un pendiente; se espera a que termine la carga inicial. Una base sólo
    //     sirve para una configuración DERIVADA de ella: si la carga la dejó, se reevalúa con la configuración actual (ya cargada del servidor) y, si es idéntica a la
    //     del servidor, no hay nada que guardar. Si la carga no dejó base, se sigue con el fallo visible de abajo.
    if (!b && (!baseUsada.updatedAt || (baseUsada.uid && String(baseUsada.uid) !== String(u)))) {
      const listo = await esperarBase(u);
      if (!(await sesionVigente(c, u))) return abortarPorSesion(u, cfg, baseUsada);
      if (listo) {
        baseUsada = base;
        const actual = (typeof data !== 'undefined' && data) ? data : null;
        if (actual) cfg = clonar(sanear(actual, CLAVES_ESCRITURA, true));
        if (vistaServidor !== null && estable(cfg) === vistaServidor) return true;   // el servidor ya tiene exactamente esto
      } else { baseUsada = base; }
    }
    if (!baseUsada.updatedAt || (baseUsada.uid && String(baseUsada.uid) !== String(u))) {
      return fallo('pendiente', 'sin_base', 'No se pudo guardar la configuración: todavía no se leyó la versión del servidor. Recargá la aplicación.', cfg, u, baseUsada);
    }
    // R2B: sin cambios reales respecto de la base confirmada no se llama a la RPC (cero escrituras innecesarias).
    const mo0 = motor();
    if (mo0 && baseVista && !b && intento === 0 && baseUsada.updatedAt === base.updatedAt) {
      try { if (!mo0.hayCambiosLocales(baseVista, cfg, { neutro: neutroSec(baseVista) })) return true; } catch (e) { /* se guarda normalmente */ }
    }
    let res;
    try {
      // p_uid_esperado: el servidor también verifica que el token que firma la llamada sea el de `u` (cierra la ventana entre la comprobación y el envío).
      res = await c.rpc('cardiolink_guardar_config_administrativa_v1',
        { p_config: cfg, p_base_updated_at: baseUsada.updatedAt, p_base_hash: baseUsada.hash, p_uid_esperado: u });
    } catch (e) {
      console.warn('Error de red al guardar la configuración administrativa:', e);
      return fallo('pendiente', 'red', 'Sin conexión con el servidor: la configuración NO se guardó.', cfg, u, baseUsada);
    }
    const aun = uid() === String(u);
    if (res.error) {
      const msg = res.error.message || res.error.code || 'error';
      console.warn('No se pudo guardar la configuración administrativa:', msg);
      if (res.error.hint === 'SESION_DISTINTA') return abortarPorSesion(u, cfg, baseUsada);
      if (rpcAusente(res.error)) return fallo('pendiente', 'sin_rpc', 'El servidor no tiene habilitado el guardado de configuración administrativa: NO se guardó.', cfg, u, baseUsada);
      if (res.error.code === '42501' || res.error.code === '22023') return fallo('rechazo', 'rechazado: ' + msg, 'El servidor rechazó el cambio de configuración: ' + msg + '.', cfg, u, baseUsada);
      return fallo('pendiente', 'error: ' + msg, 'No se pudo guardar la configuración (' + msg + ').', cfg, u, baseUsada);
    }
    const r = res.data;
    if (r && r.conflict === true) {
      // R2B: antes de dar por conflicto, se relee la vista, se fusiona por entidad y campo y se reintenta (máx. 3). Sólo los choques reales llegan al usuario.
      const fus = await fusionarYReintentar(cfg, baseUsada, u, intento, null);
      if (fus !== null) return fus;
      resguardar('conflicto', 'conflicto', cfg, u, baseUsada);
      if (aun) {
        estado = 'conflicto';
        avisoDescartable('La configuración fue modificada desde otro equipo o usuario, por eso NO se guardó tu último cambio. Tu versión quedó resguardada en este equipo. Recargá la aplicación para continuar con la versión actual y repetí el cambio.');
      }
      return false;
    }
    if (!r || r.ok !== true) return fallo('pendiente', 'respuesta_inesperada', 'Respuesta inesperada del servidor: la configuración NO se confirmó.', cfg, u, baseUsada);
    limpiarResguardo('pendiente', u);
    if (aun) {
      base = { updatedAt: r.updated_at || base.updatedAt, hash: r.vista_hash || base.hash, uid: u };
      baseVista = clonar(cfg);                       // R2B: la base es lo ENVIADO
      const cg = leerResguardo('conflicto', u);
      if (cg) { estado = 'conflicto'; avisoDescartable(textoConflicto(cg)); }
      else { estado = 'ok'; ocultarAviso(); }
    }
    return true;
  }
  // ---------- R2B: fusión de tres vías ante un conflicto de la RPC ----------
  async function leerVistaRemota() {
    const c = cliente(); if (!c) return null;
    const res = await c.rpc('cardiolink_config_administrativa_v1');
    if (res.error || !res.data || res.data.ok !== true || !res.data.config) return null;
    return { meta: { updatedAt: res.data.updated_at || null, hash: res.data.vista_hash || null }, vista: res.data.config, vistaEsc: clonar(sanear(res.data.config, CLAVES_ESCRITURA, true)) };
  }
  // Tras guardar una fusión: lo que otra sesión aportó entra en `data` (sólo claves autorizadas); las ediciones hechas durante el guardado se conservan.
  function adoptarEnData(localEnviado, enviado) {
    const mo = motor(); if (!mo || typeof data === 'undefined' || !data) return;
    if (mo.iguales(enviado, localEnviado)) return;
    const m = mo.fusionar(localEnviado, localEsc(), enviado);
    const nuevo = Object.assign({}, data);
    CLAVES_ESCRITURA.forEach(function (k) { if (m.config && Object.prototype.hasOwnProperty.call(m.config, k)) nuevo[k] = m.config[k]; });
    try { conSemilla(function () { data = nuevo; }); localStorage.setItem(storageConfig, JSON.stringify(data)); } catch (e) { /* sin almacenamiento */ }
  }
  // null = no aplica (sin motor / sin base): se sigue con el flujo anterior. true/false = resultado final del guardado.
  async function fusionarYReintentar(cfg, baseUsada, u, intento, resoluciones) {
    const mo = motor();
    if (!mo || !baseVista || !base.updatedAt || (intento === 0 && baseUsada.updatedAt !== base.updatedAt) || intento >= 3) return null;
    const rem = await leerVistaRemota();
    if (!rem) return null;
    const m = mo.fusionar(baseVista, cfg, rem.vistaEsc, { neutro: neutroSec(baseVista), resoluciones: resoluciones || {} });
    if (!m.ok) {
      resguardar('conflicto', 'conflicto_fusion', cfg, u, baseUsada);
      estado = 'conflicto';
      const ui = window.cardiolinkConfigR2B;
      if (ui && ui.presentarConflictos) { ocultarAviso(); ui.presentarConflictos(m.conflictos, { origen: 'secretaria', resolver: function (res) { return resolverConflictos(u, res); } }); return false; }
      return null;
    }
    // sin choques reales: se reintenta con la fusión y la versión del servidor recién leída. La base local (base/baseVista) NO avanza hasta que el servidor confirme.
    const ok = await ejecutarGuardar(clonar(m.config), { updatedAt: rem.meta.updatedAt, hash: rem.meta.hash, uid: u }, u, intento + 1);
    if (ok === true) { adoptarEnData(cfg, m.config); limpiarResguardo('conflicto', u); if (estado === 'conflicto') { estado = 'ok'; ocultarAviso(); } const ui = window.cardiolinkConfigR2B; if (ui && ui.descartarConflictos) ui.descartarConflictos(); }
    return ok;
  }
  // El usuario eligió cómo resolver sólo los campos en conflicto: se RELEE el servidor y se vuelve a fusionar antes de confirmar.
  function resolverConflictos(u, resoluciones) {
    const t = cola.then(async function () {
      if (!(await sesionVigente(cliente(), u))) return { ok: false };
      const base0 = base;
      const ok = await fusionarYReintentar(clonar(localEsc()), { updatedAt: base0.updatedAt, hash: base0.hash }, u, 0, resoluciones);
      return { ok: ok === true };
    });
    cola = t.catch(function () { return false; });
    return t;
  }
  // R2B: refresco con la vista ya cargada por cargar(): reconcilia por entidad y campo. 'aplicar' = sin cambios locales (el llamador aplica la vista);
  // 'fusionado' = `data` ya quedó fusionada y hay que guardarla; 'conflicto' = se conserva lo local y se muestra el aviso.
  function reconciliar(carga) {
    const mo = motor();
    if (!mo || !carga || !carga.vistaEsc) return 'aplicar';
    if (carga.avanzo) return 'aplicar';
    const local = localEsc(), neutro = neutroSec(baseVista);
    if (mo.iguales(carga.vistaEsc, baseVista)) { base = { updatedAt: carga.meta.updatedAt, hash: carga.meta.hash, uid: carga.meta.uid }; return 'sin_novedad'; }
    const m = mo.fusionar(baseVista, local, carga.vistaEsc, { neutro: neutro });
    if (!m.ok) {
      const u = uid(), ui = window.cardiolinkConfigR2B;
      if (ui && ui.presentarConflictos) ui.presentarConflictos(m.conflictos, { origen: 'secretaria', resolver: function (res) { return resolverConflictos(u, res); } });
      return 'conflicto';
    }
    base = { updatedAt: carga.meta.updatedAt, hash: carga.meta.hash, uid: carga.meta.uid }; baseVista = carga.vistaEsc;
    const nuevo = Object.assign(clonar(carga.config || {}), m.config);
    try { conSemilla(function () { data = normalizarConfigCritica(nuevo); }); localStorage.setItem(storageConfig, JSON.stringify(data)); } catch (e) { console.warn(e); }
    const ui2 = window.cardiolinkConfigR2B; if (ui2 && ui2.descartarConflictos) ui2.descartarConflictos();
    return 'fusionado';
  }
  function hayPendientePorGuardar() { const mo = motor(); try { return !!(mo && baseVista && mo.hayCambiosLocales(baseVista, localEsc(), { neutro: neutroSec(baseVista) })); } catch (e) { return false; } }
  function clonar(o) { try { return JSON.parse(JSON.stringify(o)); } catch (e) { return {}; } }
  // true = el servidor confirmó el guardado; false = NO se guardó (siempre con aviso visible y resguardo). Nunca null: no hay camino alternativo.
  // La instantánea y el usuario se fijan AHORA (al iniciar la operación), no cuando le toque el turno en la cola.
  function guardar(datos) {
    if (!cliente() || !sesion()) return Promise.resolve(false);
    const u = uid(), cfg = clonar(sanear(datos, CLAVES_ESCRITURA, true));
    const t = cola.then(function () { return ejecutarGuardar(cfg, null, u); });
    cola = t.catch(function () { return false; });
    return t.catch(function (e) { console.warn(e); return fallo('pendiente', 'excepcion', 'Error inesperado al guardar la configuración.', cfg, u, base); });
  }
  // Reintento manual de lo resguardado (contra la versión base original: si el servidor cambió, el resultado es conflicto, nunca un pisado ciego).
  // Sólo reintenta lo resguardado POR el usuario actual (las ranuras están atadas al uid) y sólo si la sesión viva sigue siendo la suya.
  function reintentar() {
    if (!cliente() || !sesion()) return Promise.resolve(false);
    const u = uid(), r = leerResguardo('pendiente', u);
    const origen = (typeof data !== 'undefined' && data) ? data : (r && r.config) || {};
    const b = (estado === 'pendiente' && r && r.base && r.base.updatedAt) ? r.base : base;
    // v3.3: sin versión base NO se inventa una: se recupera la base remota y se compara (idéntico → se elimina el pendiente; diferencias → se preserva como conflicto).
    if (!b.updatedAt) { return cargarYAplicar().then(function (x) { return !!(x && x.config) && estado === 'ok'; }); }
    const cfg = clonar(sanear(origen, CLAVES_ESCRITURA, true));
    const t = cola.then(function () { return ejecutarGuardar(cfg, b, u); });
    cola = t.catch(function () { return false; });
    return t;
  }

  window.cardiolinkConfigSecretariaV1 = {
    aplica: aplica,
    cargar: cargar,
    guardar: guardar,
    cargaTerminada: cargaTerminada,
    reintentar: reintentar,
    reconciliar: reconciliar,
    hayPendientePorGuardar: hayPendientePorGuardar,
    descartarResguardo: descartarResguardo,
    descargarResguardo: descargarResguardo,
    estado: function () { return estado; },
    ultimoAviso: function () { return ultimoAviso; },
    _listas: {
      lectura: CLAVES_LECTURA.slice(), escritura: CLAVES_ESCRITURA.slice(), identidad: CAMPOS_IDENTIDAD.slice(),
      paciente: CAMPOS_PACIENTE.slice(), profesionalAdmin: CAMPOS_PROFESIONAL_ADMIN.slice(), tiposDoc: TIPOS_DOC_LECTURA.slice()
    }
  };
})();
