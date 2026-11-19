/* CardioLink · Persistencia V1 / R2B · Integración del motor de fusión para Dueño/Admin (y avisos de conflicto compartidos con Secretaría).
   Cargar DESPUÉS de cardiolink-config-merge-v1.js y de app.js. Si el motor no está, no hace nada y app.js sigue con el comportamiento de R1.

   Qué reemplaza (sólo Dueño/Admin con permiso real sobre la fila completa): el upsert ciego de la fila `__cardiolink_config_v1`.
   Guardado: (1) si no hay cambios reales respecto de la base cargada → NO se escribe; (2) se relee la fila y se fusiona base/local/remoto (motor de tres vías);
   (3) sin conflictos → UPDATE condicionado por `updated_at` (compare-and-swap); 0 filas = otra sesión escribió en medio (se relee y fusiona de nuevo, máximo 3 veces)
   o permiso denegado (se distingue releyendo la fila: si su versión no cambió, nadie escribió → es un rechazo de permisos); (4) con conflictos reales NO se escribe nada:
   se conserva lo local y se muestra un aviso persistente con opciones (mi valor / valor del servidor / resolver más tarde) que resuelve SÓLO los campos en conflicto,
   releyendo la versión remota antes de confirmar. Sólo se devuelve éxito cuando el servidor devolvió la fila actualizada. La base pasa a ser lo ENVIADO (no lo que
   haya en `data` después del await) y las ediciones hechas mientras el guardado estaba en vuelo se conservan. */
(function () {
  'use strict';
  if (window.cardiolinkConfigR2B) return;
  var M = window.cardiolinkConfigMergeV1;
  if (!M) { try { console.warn('R2B: falta el motor de fusión; se mantiene el comportamiento de R1.'); } catch (e) { /* sin consola */ } return; }

  var ID_FILA = '__cardiolink_config_v1', MAX_REINTENTOS = 3, ID_PANEL = 'cardiolinkConflictosConfigV1', ID_INSIGNIA = 'cardiolinkConflictosConfigInsigniaV1';
  var base = null, ver = null, neutro = null, uidBase = null;       // base = config CRUDA del servidor (última cargada/confirmada); ver = su updated_at; neutro = normalizar(base)
  var cola = Promise.resolve();
  var conflictos = [], proveedor = null;             // conflictos sin resolver y quién sabe resolverlos
  var contadores = { escrituras: 0, sinCambios: 0, conflictos: 0, reintentos: 0, permisoDenegado: 0, fusiones: 0 };

  function clonar(x) { return M.clonar(x); }
  function normalizar(x) { return normalizarConfigCritica(clonar(x)); }
  function esDueno() { try { return !!usuarioSupabase && backendRolCargado === true && !esMedicoBackendV1() && configCompletaPermitidaV1(); } catch (e) { return false; } }
  function activo() { return esDueno(); }
  // Semilla en memoria de horariosProfesionales.matias (agenda-v1): NO es un cambio del usuario y no debe persistirse por un guardado ajeno. El motor ve el local SIN ella y,
  // si `data` se reemplaza (fusión/adopción), se repone la MISMA referencia mientras el servidor no tenga un horario real.
  function semilla() { try { return typeof window.cardiolinkAgendaSemillaV1 === 'function' ? window.cardiolinkAgendaSemillaV1() : null; } catch (e) { return null; } }
  function localParaMotor(baseObj) {
    var c = clonar(data), s = semilla();
    if (s && c.horariosProfesionales && typeof c.horariosProfesionales === 'object') {
      delete c.horariosProfesionales.matias;
      if (!Object.keys(c.horariosProfesionales).length && !(baseObj && baseObj.horariosProfesionales !== undefined)) delete c.horariosProfesionales;
    }
    return c;
  }
  function reponerSemilla(s) {
    if (!s) return;
    try {
      if (!data.horariosProfesionales || typeof data.horariosProfesionales !== 'object') data.horariosProfesionales = {};
      if (!data.horariosProfesionales.matias) data.horariosProfesionales.matias = s;
    } catch (e) { /* sin semilla */ }
  }
  function persistirLocal() { try { localStorage.setItem(storageConfig, JSON.stringify(data)); } catch (e) { /* sin almacenamiento */ } }

  function registrarBase(config, updatedAt) {
    if (!config || typeof config !== 'object') return false;
    base = clonar(config); ver = updatedAt || null; neutro = normalizar(base); uidBase = (typeof usuarioSupabase !== 'undefined' && usuarioSupabase) ? String(usuarioSupabase.id) : null;
    return true;
  }
  function baseVigente() { var u = (typeof usuarioSupabase !== 'undefined' && usuarioSupabase) ? String(usuarioSupabase.id) : null; return !!base && !!ver && uidBase === u; }
  function reemplazarData(nuevo) {
    try { if (typeof respaldarIdentidadesLocalesPreviasV1 === 'function') respaldarIdentidadesLocalesPreviasV1(data, nuevo); } catch (e) { console.warn(e); }
    var s = semilla(); data = nuevo; reponerSemilla(s); persistirLocal();
  }
  function limpiar() { base = null; ver = null; neutro = null; uidBase = null; conflictos = []; proveedor = null; ocultarPanel(); ocultarInsignia(); }

  // ---------- acceso a la fila (sólo Dueño/Admin; la RLS ya lo restringe) ----------
  async function leerFila() {
    var r = await supabaseClient.from('cardiolink_atenciones').select('payload,updated_at').eq('id', ID_FILA).limit(1);
    if (r.error) return { ok: false, error: r.error };
    var f = Array.isArray(r.data) ? r.data[0] : r.data;
    if (!f || !f.payload || !f.payload.config) return { ok: false, error: { message: 'la fila de configuración no existe o está vacía' } };
    return { ok: true, config: f.payload.config, payload: f.payload, updated_at: f.updated_at };
  }

  // Tras un guardado/fusión: el estado local pasa a incluir lo que el servidor tiene. Sólo se REEMPLAZA `data` si hay algo nuevo del servidor; las ediciones
  // hechas mientras el guardado estaba en vuelo (data distinto de lo enviado) se vuelven a aplicar sobre el nuevo estado.
  function adoptar(localEnviado, nuevoRemotoCrudo) {
    var nuevoLocal = normalizar(nuevoRemotoCrudo);
    if (M.iguales(nuevoLocal, localEnviado)) return false;                       // el servidor quedó igual a lo que ya había localmente: no se toca `data`
    if (M.iguales(localParaMotor(base), localEnviado)) { reemplazarData(nuevoLocal); return true; }
    var m = M.fusionar(localEnviado, localParaMotor(base), nuevoLocal);                  // ediciones durante el vuelo + novedades del servidor
    reemplazarData(m.config); return true;
  }

  // ---------- guardado (Dueño/Admin) ----------
  async function ejecutar(uid, resoluciones) {
    if (!activo()) return false;
    if (!baseVigente()) { avisoTransitorio('Todavía no se leyó la configuración del servidor: el guardado queda pendiente.'); return false; }
    var intentos = 0;
    for (;;) {
      var localSnap = localParaMotor(base);
      if (!M.hayCambiosLocales(base, localSnap, { neutro: neutro })) { contadores.sinCambios++; return true; }       // nada que escribir
      if (!(await sesionVivaCoincideV1(uid))) { console.warn('Configuración: la sesión cambió o se cerró; no se guarda con otras credenciales.'); return false; }
      var fila = await leerFila();
      if (!fila.ok) { console.warn('R2B: no se pudo leer la configuración del servidor:', fila.error && fila.error.message); return false; }
      var m = M.fusionar(base, localSnap, fila.config, { neutro: neutro, resoluciones: resoluciones || {} });
      if (!m.ok) { contadores.conflictos++; presentarConflictos(m.conflictos, proveedorDueno()); return false; }
      contadores.fusiones++;
      if (M.iguales(m.config, fila.config)) {                                    // el servidor ya tiene todo lo local: nada que escribir
        registrarBase(fila.config, fila.updated_at); adoptar(localSnap, fila.config); descartarConflictos(); contadores.sinCambios++; return true;
      }
      var ahora = new Date().toISOString();
      var payload = Object.assign({}, fila.payload, { config: m.config, updatedAt: ahora });
      var r = await supabaseClient.from('cardiolink_atenciones').update({ payload: payload, updated_at: ahora }).eq('id', ID_FILA).eq('updated_at', fila.updated_at).select('id,updated_at');
      if (r.error) {
        console.warn('No se pudo guardar config/pacientes en Supabase:', r.error.message);
        if (esRechazoIdentidadArchivoLlenoV1(r.error)) mostrarAvisoConfigRechazadaV1(r.error);
        else if (r.error.code === '42501') { contadores.permisoDenegado++; avisoPermiso(); }
        return false;
      }
      var filas = Array.isArray(r.data) ? r.data : (r.data ? [r.data] : []);
      if (filas.length === 1) {                                                  // CONFIRMADO por el servidor
        contadores.escrituras++;
        try { quitarAvisoConfigRechazadaV1(); var ausente = document.getElementById('avisoR2BNoCargadoV1'); if (ausente) ausente.remove(); } catch (e) { /* sin aviso previo */ }
        registrarBase(m.config, filas[0].updated_at || ahora);                   // la base es lo ENVIADO
        adoptar(localSnap, m.config); descartarConflictos();
        return true;
      }
      // 0 filas: ¿permiso o concurrencia? Si la versión de la fila NO cambió, nadie escribió en medio: el servidor rechazó el UPDATE por permisos.
      var chk = await leerFila();
      if (chk.ok && chk.updated_at === fila.updated_at) { contadores.permisoDenegado++; avisoPermiso(); return false; }
      intentos++; contadores.reintentos++;
      if (intentos >= MAX_REINTENTOS) {
        avisoTransitorio('La configuración cambió varias veces mientras se guardaba (otra sesión escribe a la vez). Tus cambios siguen en este equipo y se reintentan.');
        return false;
      }
    }
  }
  function guardarDueno(uid, resoluciones) {
    var t = cola.then(function () { return ejecutar(uid, resoluciones); });
    cola = t.catch(function () { return false; });
    return t.catch(function (e) { console.warn('R2B: error inesperado al guardar la configuración:', e); return false; });
  }
  function proveedorDueno() {
    return { origen: 'dueno', resolver: function (res) { return guardarDueno(usuarioSupabase.id, res).then(function (ok) { return { ok: ok, conflictos: conflictos.slice() }; }); } };
  }

  // ---------- refresco (carga periódica) ----------
  // fila: {config (cruda), updated_at}. Devuelve 'primera' | 'sin_novedad' | 'aplicado' | 'fusionado' | 'conflicto'. `data` ya queda actualizado cuando corresponde.
  function reconciliar(fila) {
    if (!fila || !fila.config) return 'sin_novedad';
    if (!baseVigente()) { registrarBase(fila.config, fila.updated_at); return 'primera'; }
    if (M.iguales(fila.config, base)) { ver = fila.updated_at || ver; return 'sin_novedad'; }
    var hayLocales = M.hayCambiosLocales(base, localParaMotor(base), { neutro: neutro });
    if (!hayLocales) {
      registrarBase(fila.config, fila.updated_at); reemplazarData(normalizar(fila.config)); descartarConflictos(); return 'aplicado';
    }
    var m = M.fusionar(base, localParaMotor(base), fila.config, { neutro: neutro });
    if (!m.ok) { contadores.conflictos++; presentarConflictos(m.conflictos, proveedorDueno()); return 'conflicto'; }
    contadores.fusiones++;
    registrarBase(fila.config, fila.updated_at); reemplazarData(normalizar(m.config)); descartarConflictos();
    return 'fusionado';
  }
  function hayPendientePorGuardar() { return baseVigente() && M.hayCambiosLocales(base, localParaMotor(base), { neutro: neutro }); }

  // ---------- avisos ----------
  function crear(tag, estilo, texto) { var e = document.createElement(tag); if (estilo) e.style.cssText = estilo; if (texto != null) e.textContent = texto; return e; }
  function avisoTransitorio(texto) {
    try {
      if (!document.body) return;
      var d = document.getElementById('cardiolinkAvisoConfigV1');
      if (!d) { d = crear('div', 'position:fixed;left:12px;right:12px;bottom:12px;z-index:99997;background:#fef3c7;color:#78350f;border:1px solid #f59e0b;border-radius:12px;padding:12px 14px;font:600 14px/1.4 system-ui,Arial,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.2)'); d.id = 'cardiolinkAvisoConfigV1'; d.setAttribute('role', 'alert'); document.body.appendChild(d); }
      d.textContent = texto; clearTimeout(d._t); d._t = setTimeout(function () { d.remove(); }, 12000);
    } catch (e) { /* sin UI */ }
  }
  function avisoPermiso() { avisoTransitorio('El servidor rechazó guardar la configuración: tu usuario no tiene permiso para modificarla. Los cambios quedaron sólo en este equipo.'); }

  // ---------- conflictos: aviso persistente comprensible ----------
  var TEXTO_TIPO = {
    campo: 'Se cambió el mismo dato en las dos sesiones.',
    identidad: 'Se creó el mismo elemento en las dos sesiones con contenido distinto.',
    eliminacion_vs_modificacion: 'Una sesión eliminó este elemento y la otra lo modificó.',
    bloque: 'Se cambió la misma lista en las dos sesiones.',
    clave_duplicada: 'La lista tiene elementos repetidos y no se puede fusionar sola.',
    clave_ambigua: 'La lista tiene elementos sin identificador claro o con nombres casi iguales y no se puede fusionar sola.'
  };
  function nombreEntidad(c) {
    try {
      var t = c.tokens || [], clave = t[1];
      var lista = { pacientes: 'pacientes', profesionales: 'profesionales', usuarios: 'usuarios' }[t[0]];
      if (lista && clave != null && Array.isArray(data[lista])) { var e = data[lista].find(function (x) { return String(x && x.id) === String(clave); }); var n = e && (e.nombreCompleto || e.nombre); if (n) return String(n); }
    } catch (e) { /* sin nombre */ }
    return '';
  }
  function etiqueta(c) {
    var t = (c.tokens || []).slice(), n = nombreEntidad(c);
    return t.join(' › ') + (n ? ' (' + n + ')' : '');
  }
  function valorTexto(v, ausente) {
    if (ausente || v === undefined) return '(no existe / eliminado)';
    if (v === null) return '(vacío: null)';
    if (typeof v === 'string') return v === '' ? '(texto vacío)' : '«' + (v.length > 80 ? v.slice(0, 77) + '…' : v) + '»';
    if (Array.isArray(v)) return '(lista de ' + v.length + ' elemento' + (v.length === 1 ? '' : 's') + ')';
    if (typeof v === 'object') return '(elemento con ' + Object.keys(v).length + ' campos)';
    return String(v);
  }
  function ocultarPanel() { try { var p = document.getElementById(ID_PANEL); if (p) p.remove(); } catch (e) { /* sin UI */ } }
  function ocultarInsignia() { try { var p = document.getElementById(ID_INSIGNIA); if (p) p.remove(); } catch (e) { /* sin UI */ } }
  function descartarConflictos() { conflictos = []; proveedor = null; ocultarPanel(); ocultarInsignia(); }
  function insignia() {
    try {
      if (!document.body || document.getElementById(ID_INSIGNIA)) return;
      var b = crear('button', 'position:fixed;right:12px;bottom:12px;z-index:99996;background:#b45309;color:#fff;border:0;border-radius:999px;padding:10px 16px;font:700 14px system-ui,Arial,sans-serif;cursor:pointer;box-shadow:0 6px 24px rgba(0,0,0,.3)', 'Configuración: ' + conflictos.length + ' conflicto' + (conflictos.length === 1 ? '' : 's') + ' sin resolver');
      b.id = ID_INSIGNIA; b.type = 'button'; b.addEventListener('click', function () { ocultarInsignia(); dibujarPanel(); }); document.body.appendChild(b);
    } catch (e) { /* sin UI */ }
  }
  function firmaConflictos(l) { return JSON.stringify(l.map(function (c) { return [c.ruta, c.tipo, c.local, c.remoto, c.localAusente, c.remotoAusente]; })); }
  function presentarConflictos(lista, prov) {
    var igual = conflictos.length > 0 && firmaConflictos(lista) === firmaConflictos(conflictos);
    conflictos = lista.slice(); proveedor = prov;
    if (igual) return;                                   // los mismos conflictos de siempre: no se vuelve a abrir el aviso (si el usuario lo cerró queda la insignia)
    dibujarPanel();
  }
  function dibujarPanel() {
    try {
      if (!document.body) return;
      ocultarPanel(); ocultarInsignia();
      var elegidas = {};
      var p = crear('div', 'position:fixed;left:12px;right:12px;bottom:12px;max-height:70vh;overflow:auto;z-index:99996;background:#fff7ed;color:#7c2d12;border:2px solid #ea580c;border-radius:12px;padding:14px 16px;font:14px/1.45 system-ui,Arial,sans-serif;box-shadow:0 10px 32px rgba(0,0,0,.35)');
      p.id = ID_PANEL; p.setAttribute('role', 'alertdialog');
      p.appendChild(crear('div', 'font-weight:800;font-size:15px;margin-bottom:4px', 'La configuración tiene ' + conflictos.length + ' conflicto' + (conflictos.length === 1 ? '' : 's') + ' con otra sesión'));
      p.appendChild(crear('div', 'margin-bottom:10px', 'Tus otros cambios y los de la otra sesión se conservan. Sólo hay que elegir qué valor queda en lo que sigue. Nada se guardó todavía.'));
      var estado = crear('div', 'margin:8px 0;font-weight:700');
      conflictos.forEach(function (c) {
        var fila = crear('div', 'border:1px solid #fdba74;border-radius:8px;padding:8px 10px;margin:6px 0;background:#fff');
        fila.appendChild(crear('div', 'font-weight:700', etiqueta(c)));
        fila.appendChild(crear('div', 'font-size:12px;color:#9a3412;margin-bottom:4px', TEXTO_TIPO[c.tipo] || 'Conflicto.'));
        var op = crear('div', 'display:flex;gap:14px;flex-wrap:wrap');
        [['local', 'Mi valor: ' + valorTexto(c.local, c.localAusente)], ['remoto', 'Valor del servidor: ' + valorTexto(c.remoto, c.remotoAusente)]].forEach(function (o) {
          var l = crear('label', 'display:flex;gap:6px;align-items:center;cursor:pointer'); var r = document.createElement('input'); r.type = 'radio'; r.name = 'cfgConf_' + c.ruta; r.value = o[0];
          r.addEventListener('change', function () { elegidas[c.ruta] = o[0]; }); l.appendChild(r); l.appendChild(crear('span', '', o[1])); op.appendChild(l);
        });
        fila.appendChild(op); p.appendChild(fila);
      });
      p.appendChild(estado);
      var barra = crear('div', 'display:flex;gap:8px;flex-wrap:wrap;margin-top:8px');
      function btn(texto, fn, principal) { var b = crear('button', 'padding:8px 14px;border-radius:8px;border:1px solid #c2410c;font-weight:700;cursor:pointer;' + (principal ? 'background:#c2410c;color:#fff' : 'background:#fff;color:#9a3412'), texto); b.type = 'button'; b.addEventListener('click', fn); barra.appendChild(b); return b; }
      async function aplicar(res) {
        if (!Object.keys(res).length) { estado.textContent = 'Elegí un valor para al menos un conflicto.'; return; }
        estado.textContent = 'Releyendo la versión del servidor y guardando…';
        var r = null; try { r = await proveedor.resolver(res); } catch (e) { console.warn(e); }
        if (r && r.ok) { estado.textContent = ''; ocultarPanel(); avisoTransitorio('Conflictos resueltos y guardados en el servidor.'); return; }
        if (conflictos.length) { dibujarPanel(); } else { estado.textContent = 'No se pudo confirmar el guardado en el servidor. Tus cambios siguen en este equipo.'; }
      }
      btn('Conservar lo elegido', function () { aplicar(Object.assign({}, elegidas)); }, true);
      btn('Conservar mis valores', function () { var r = {}; conflictos.forEach(function (c) { r[c.ruta] = 'local'; }); aplicar(r); });
      btn('Conservar los del servidor', function () { var r = {}; conflictos.forEach(function (c) { r[c.ruta] = 'remoto'; }); aplicar(r); });
      btn('Cancelar (resolver más tarde)', function () { ocultarPanel(); insignia(); });
      p.appendChild(barra); document.body.appendChild(p);
    } catch (e) { console.warn('R2B: no se pudo mostrar el aviso de conflictos:', e); }
  }

  // ---------- panel genérico de conflictos (R2C lo reutiliza para atenciones) ----------
  // cfg: { id, idInsignia, titulo, intro, avisos:[{texto, boton?, alBoton?}], items:[{clave, titulo, detalle, tipoTexto, localTexto, remotoTexto, opciones:{local,remoto}, etiquetaLocal, etiquetaRemoto}],
  //        onResolver(res) -> Promise<{ok, pendientes}>, textoInsignia }.  res = { clave: 'local'|'remoto' }.
  var panelesGenericos = {};
  function quitarPanelGenerico(cfg) { try { var a = document.getElementById(cfg.id), b = document.getElementById(cfg.idInsignia); if (a) a.remove(); if (b) b.remove(); } catch (e) { /* sin UI */ } }
  function insigniaGenerica(cfg, items, avisos) {
    try {
      if (!document.body || document.getElementById(cfg.idInsignia)) return;
      var n = items.length + avisos.length;
      var b = crear('button', 'position:fixed;right:12px;bottom:' + (document.getElementById(ID_INSIGNIA) ? '60px' : '12px') + ';z-index:99996;background:#b45309;color:#fff;border:0;border-radius:999px;padding:10px 16px;font:700 14px system-ui,Arial,sans-serif;cursor:pointer;box-shadow:0 6px 24px rgba(0,0,0,.3)', cfg.textoInsignia(items.length, avisos.length));
      b.id = cfg.idInsignia; b.type = 'button'; b.addEventListener('click', function () { var x = document.getElementById(cfg.idInsignia); if (x) x.remove(); mostrarPanelGenerico(cfg); }); document.body.appendChild(b);
    } catch (e) { /* sin UI */ }
  }
  function mostrarPanelGenerico(cfg, soloInsignia) {
    try {
      if (!document.body) return;
      var items = (cfg.items || []).slice(), avisos = (cfg.avisos || []).slice();
      quitarPanelGenerico(cfg);
      if (!items.length && !avisos.length) return;
      panelesGenericos[cfg.id] = cfg;
      if (soloInsignia || document.getElementById(ID_PANEL)) { insigniaGenerica(cfg, items, avisos); return; }   // si el panel de configuración está abierto no se superponen
      var elegidas = {};
      var p = crear('div', 'position:fixed;left:12px;right:12px;bottom:12px;max-height:70vh;overflow:auto;z-index:99996;background:#fff7ed;color:#7c2d12;border:2px solid #ea580c;border-radius:12px;padding:14px 16px;font:14px/1.45 system-ui,Arial,sans-serif;box-shadow:0 10px 32px rgba(0,0,0,.35)');
      p.id = cfg.id; p.setAttribute('role', 'alertdialog');
      p.appendChild(crear('div', 'font-weight:800;font-size:15px;margin-bottom:4px', cfg.titulo(items.length, avisos.length)));
      if (cfg.intro && items.length) p.appendChild(crear('div', 'margin-bottom:10px', cfg.intro));
      avisos.forEach(function (a) {
        var f = crear('div', 'border:1px solid #fbbf24;background:#fffbeb;border-radius:8px;padding:8px 10px;margin:6px 0;display:flex;gap:10px;align-items:center;flex-wrap:wrap');
        f.appendChild(crear('span', 'flex:1 1 260px', a.texto));
        if (a.boton) { var bb = crear('button', 'padding:6px 12px;border-radius:8px;border:1px solid #92400e;background:#fff;color:#92400e;font-weight:700;cursor:pointer', a.boton); bb.type = 'button'; bb.addEventListener('click', function () { try { a.alBoton && a.alBoton(); } catch (e) { console.warn(e); } mostrarPanelGenerico(cfg); }); f.appendChild(bb); }
        p.appendChild(f);
      });
      var estado = crear('div', 'margin:8px 0;font-weight:700');
      items.forEach(function (c) {
        var fila = crear('div', 'border:1px solid #fdba74;border-radius:8px;padding:8px 10px;margin:6px 0;background:#fff');
        fila.appendChild(crear('div', 'font-weight:700', c.titulo));
        if (c.detalle) fila.appendChild(crear('div', 'font-size:12px;color:#6b7280', c.detalle));
        fila.appendChild(crear('div', 'font-size:12px;color:#9a3412;margin-bottom:4px', c.tipoTexto || 'Conflicto.'));
        var op = crear('div', 'display:flex;gap:14px;flex-wrap:wrap');
        [['local', c.etiquetaLocal || 'Mi valor', c.localTexto, c.opciones && c.opciones.local], ['remoto', c.etiquetaRemoto || 'Valor del servidor', c.remotoTexto, c.opciones && c.opciones.remoto]].forEach(function (o) {
          if (!o[3]) return;
          var l = crear('label', 'display:flex;gap:6px;align-items:center;cursor:pointer'); var r = document.createElement('input'); r.type = 'radio'; r.name = cfg.id + '_' + c.clave; r.value = o[0];
          r.addEventListener('change', function () { elegidas[c.clave] = o[0]; }); l.appendChild(r); l.appendChild(crear('span', '', o[1] + ': ' + o[2])); op.appendChild(l);
        });
        if (c.nota) fila.appendChild(crear('div', 'font-size:12px;color:#7c2d12;font-style:italic', c.nota));
        fila.appendChild(op); p.appendChild(fila);
      });
      p.appendChild(estado);
      var barra = crear('div', 'display:flex;gap:8px;flex-wrap:wrap;margin-top:8px');
      function btn(texto, fn, principal) { var b = crear('button', 'padding:8px 14px;border-radius:8px;border:1px solid #c2410c;font-weight:700;cursor:pointer;' + (principal ? 'background:#c2410c;color:#fff' : 'background:#fff;color:#9a3412'), texto); b.type = 'button'; b.addEventListener('click', fn); barra.appendChild(b); return b; }
      async function aplicar(res) {
        if (!Object.keys(res).length) { estado.textContent = 'Elegí un valor para al menos un conflicto.'; return; }
        estado.textContent = 'Releyendo la versión del servidor y guardando…';
        var r = null; try { r = await cfg.onResolver(res); } catch (e) { console.warn(e); }
        var c2 = cfg.actual ? cfg.actual() : null;
        if (c2) { cfg.items = c2.items; cfg.avisos = c2.avisos; }
        if (r && r.ok && !(cfg.items || []).length) { quitarPanelGenerico(cfg); mostrarPanelGenerico(cfg); if (cfg.avisoFinal) avisoTransitorio(cfg.avisoFinal); return; }
        if ((cfg.items || []).length || (cfg.avisos || []).length) { mostrarPanelGenerico(cfg); } else { estado.textContent = 'No se pudo confirmar el guardado en el servidor. Tus cambios siguen en este equipo.'; }
      }
      function elegirTodo(lado) { var r = {}; items.forEach(function (c) { var o = c.opciones || {}; if (lado === 'local' ? o.local : o.remoto) r[c.clave] = lado; else if (lado === 'local' && o.remoto) r[c.clave] = 'remoto'; }); return r; }
      if (items.length) {
        btn('Conservar lo elegido', function () { aplicar(Object.assign({}, elegidas)); }, true);
        btn('Conservar mis valores', function () { aplicar(elegirTodo('local')); });
        btn('Conservar los del servidor', function () { aplicar(elegirTodo('remoto')); });
      }
      btn(items.length ? 'Cancelar (resolver más tarde)' : 'Cerrar', function () { quitarPanelGenerico(cfg); if (items.length || avisos.length) insigniaGenerica(cfg, items, avisos); });
      p.appendChild(barra); document.body.appendChild(p);
    } catch (e) { console.warn('R2C: no se pudo mostrar el aviso de conflictos:', e); }
  }

  window.cardiolinkConfigR2B = {
    activo: activo, registrarBase: registrarBase, reconciliar: reconciliar, guardarDueno: guardarDueno, hayPendientePorGuardar: hayPendientePorGuardar,
    localSinSemilla: localParaMotor, semilla: semilla, reponerSemilla: reponerSemilla,
    presentarConflictos: presentarConflictos, descartarConflictos: descartarConflictos, adoptar: adoptar, limpiar: limpiar,
    baseActual: function () { return base ? clonar(base) : null; }, neutroActual: function () { return neutro ? clonar(neutro) : null; }, versionBase: function () { return ver; },
    instalarRecuperacion: function (baseCruda, versionBase, localCfg) { if (!registrarBase(baseCruda, versionBase)) return false; reemplazarData(normalizar(localCfg)); return true; },
    abrirPanel: function () { if (conflictos.length) dibujarPanel(); },
    panelGenerico: mostrarPanelGenerico, quitarPanelGenerico: quitarPanelGenerico, avisoTransitorio: avisoTransitorio,
    conflictos: function () { return conflictos.slice(); },
    estado: function () { return { base: !!base, version: ver, conflictos: conflictos.length, contadores: Object.assign({}, contadores) }; },
    VERSION: 'r2b-integracion-1'
  };
})();
