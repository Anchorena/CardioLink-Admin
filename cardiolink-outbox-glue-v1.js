/* CardioLink · Persistencia V1 / R2D · Integración de la cola de recuperación con la app (sólo navegador).
   Lógica pura y formato de almacenamiento: cardiolink-outbox-v1.js. app.js entrega las bases (viven en su clausura) por conectar({...}).
   - registrar(): foto DECLARATIVA de lo no confirmado (se llama antes del sync, después de cada sync, por temporizador, al ocultar la página y al cerrarla; ninguna es la única).
   - recuperar(ctx): tras la PRIMERA carga, reconstruye base/local de cada operación y la instala; la fusión la hacen R2C (atenciones) y R2B (configuración) por su camino normal
     (la versión base original hace fallar el UPDATE condicionado → se relee y se fusiona en 3 vías: un cambio remoto en el mismo campo es CONFLICTO, nunca se pisa).
   - Una operación sólo sale de la cola cuando el servidor la confirmó (la base de contenido llegó a coincidir), ya estaba aplicada, o el usuario autorizado la descartó.
   Sin este módulo la app se comporta como en R2C (la cola no se borra: queda en localStorage y se recupera al restaurar el módulo). */
(function () {
  'use strict';
  var P = window.cardiolinkOutboxPuroV1;
  if (!P || window.cardiolinkOutboxR2D) return;
  var SENTINELA = '1970-01-01T00:00:00.000Z';   // versión que nunca coincide: fuerza el camino de relectura y fusión
  var ID_INSIGNIA = 'cardiolinkOutboxInsigniaV1', ID_PANEL = 'cardiolinkOutboxPanelV1';
  var puente = null, tabId = null, clave = null, estadoCola = null, errorCola = null;
  var especiales = new Map();       // clave → operación que no deriva de una fila sucia (incompleta, revisión, ambigua, no autorizada, eliminada remota)
  var limpiados = new Set();        // ids cuyo último intento NO llegó al servidor (fallo de red limpio o rechazo definitivo): se ignora la marca guardada
  var enviados = new Map();         // id → contenido (estable) del último intento de envío de una atención nueva
  var proteccion = { ok: true, error: null, dañada: false };
  var ultimaFirma = '', ultimoLatido = 0, recuperada = false, estadoUI = { abierto: false };

  function ahora() { return Date.now(); }
  function iso() { return new Date().toISOString(); }
  function clonar(o) { return o === undefined ? undefined : JSON.parse(JSON.stringify(o)); }
  function miTab() {
    if (tabId) return tabId;
    try { tabId = sessionStorage.getItem('cardiolink_outbox_tab_v1'); if (!tabId) { tabId = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); sessionStorage.setItem('cardiolink_outbox_tab_v1', tabId); } }
    catch (e) { tabId = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
    return tabId;
  }
  function listo() { try { return !!puente && puente.listo() && !!puente.uid(); } catch (e) { return false; } }
  function nombreAtencion(a) { a = a || {}; return (a.paciente || a.pacienteNombre || 'paciente sin nombre') + (a.fecha ? ' · ' + a.fecha : '') + (a.horaInicio ? ' ' + a.horaInicio : ''); }

  // ---------- derivación de las operaciones propias ----------
  function derivarPropias(st) {
    var propias = {}, t = miTab(), cuando = iso();
    (puente.atenciones() || []).forEach(function (a) {
      if (!a || a.id == null || String(a.id) === '__cardiolink_config_v1') return;
      var id = String(a.id), key = t + '|a:' + id, prev = st.ops[key], op;
      if (puente.esConfirmada(id)) {
        var baseStr = puente.base(id); if (baseStr === undefined) return;
        if (P.estable(a) === baseStr) { enviados.delete(id); return; }                          // sin cambios: confirmada
        var base; try { base = JSON.parse(baseStr); } catch (e) { return; }
        var d = P.diffAtencion(base, a); if (!Object.keys(d.cambios).length) return;
        op = { k: 'mod', id: id, baseVer: puente.version(id), cambios: d.cambios };
      } else {
        op = { k: 'nueva', id: id, row: clonar(a) };
        var env = enviados.get(id) || (!limpiados.has(id) && prev && prev.k === 'nueva' && prev.enviado);
        if (env) op.enviado = env;
      }
      op.rol = puente.rol(); op.ts = (prev && prev.ts) || cuando; op.tab = t;
      propias[key] = op;
    });
    var cfg = null; try { cfg = puente.configPendiente(); } catch (e) { cfg = null; }
    if (cfg && cfg.ops && cfg.ops.length) { var kc = t + '|c', pc = st.ops[kc]; propias[kc] = { k: 'config', baseVer: cfg.baseVer, ops: cfg.ops, noProt: cfg.noProt || [], rol: puente.rol(), ts: (pc && pc.ts) || cuando, tab: t }; }
    // R3: fichas demográficas del paciente editadas y todavía sin confirmar en cardiolink_pacientes (sólo diferencias {antes, después} y la versión de lo que se vio)
    var fichas = []; try { fichas = puente.fichasPendientes ? puente.fichasPendientes() : []; } catch (e) { fichas = []; }
    fichas.forEach(function (f) {
      if (!f || !f.cambios || !Object.keys(f.cambios).length) return;
      var kf = t + '|f:' + f.id, pf = st.ops[kf];
      propias[kf] = { k: 'ficha', id: String(f.id), cambios: f.cambios, rol: puente.rol(), ts: (pf && pf.ts) || f.ts || cuando, tab: t };
    });
    // R3: divergencias de la ficha del paciente (sin base confiable: se conservan los DOS valores hasta que el usuario decida)
    var divs = []; try { divs = puente.divergencias ? puente.divergencias() : []; } catch (e) { divs = []; }
    divs.forEach(function (d) {
      if (!d || !d.campos || !Object.keys(d.campos).length) return;
      var kd = t + '|d:' + d.id, pd = st.ops[kd];
      propias[kd] = { k: 'divergencia', id: String(d.id), campos: d.campos, rol: puente.rol(), ts: (pd && pd.ts) || d.ts || cuando, tab: t };
    });
    especiales.forEach(function (op, key) { if (!propias[key]) { op.tab = t; propias[key] = op; } });
    return propias;
  }

  // ---------- persistencia ----------
  function registrar(opciones) {
    opciones = opciones || {};
    if (!(opciones.forzar ? (!!puente && !!puente.uid()) : listo())) return false;
    try {
      var uid = puente.uid(); clave = P.claveCola(puente.proyecto(), uid);
      var ab = P.abrir(localStorage, clave); var st = ab.estado; errorCola = ab.error || null;
      if (ab.dañada) proteccion.dañada = true;
      var t = miTab(), n = ahora();
      (opciones.eliminar || []).forEach(function (k) { delete st.ops[k]; });
      var propias = derivarPropias(st);
      var otras = {}; Object.keys(st.ops).forEach(function (k) { if (st.ops[k].tab !== t) otras[k] = st.ops[k]; });
      var nuevo = Object.assign({}, otras, propias);
      var cambia = P.estable(nuevo) !== P.estable(st.ops) || (opciones.eliminar || []).length > 0;
      var latido = (n - ultimoLatido) > 15000 || (st.tabs[t] && st.tabs[t].cerrada);
      if (cambia || latido || opciones.cerrada) {
        st.ops = nuevo; st.tabs[t] = { ts: n, cerrada: opciones.cerrada === true };
        Object.keys(st.tabs).forEach(function (k) { if (n - st.tabs[k].ts > 7 * 86400000) delete st.tabs[k]; });
        var w = P.escribir(localStorage, clave, st);
        proteccion.ok = w.ok || (Object.keys(propias).length === 0); proteccion.error = w.ok ? null : w.error; if (w.ok) ultimoLatido = n;
        if (!w.ok && !Object.keys(propias).length) proteccion.ok = true;
        if (w.ok && w.bytes > 1500000) proteccion.grande = true; else proteccion.grande = false;
      }
      estadoCola = st; pintar();
      return proteccion.ok;
    } catch (e) { console.warn('R2D: no se pudo registrar la cola de recuperación:', e); proteccion.ok = false; proteccion.error = String(e && e.message || e); pintar(); return false; }
  }

  // ---------- recuperación (tras la PRIMERA carga) ----------
  function completaMinima(row) { try { return !puente.esCorrupta(row); } catch (e) { return true; } }
  function recuperar(ctx) {
    var res = { recuperadas: 0, confirmadas: 0, retenidas: 0, descartadas: 0 };
    if (!puente || !puente.uid() || recuperada) return res;
    recuperada = true;
    try {
      clave = P.claveCola(puente.proyecto(), puente.uid());
      var ab = P.abrir(localStorage, clave), st = ab.estado; if (ab.dañada) proteccion.dañada = true;
      var t = miTab(), n = ahora(), reclamar = [], remotas = ctx.remotas || new Map();
      Object.keys(st.ops).forEach(function (k) { var op = st.ops[k]; if (op.tab === t || P.esHuerfana(st, op, t, n)) reclamar.push(k); });
      reclamar.sort(function (a, b) { return Date.parse(st.ops[a].ts || 0) - Date.parse(st.ops[b].ts || 0); });
      var propiosEsp = [];
      reclamar.forEach(function (k) {
        var op = st.ops[k];
        try {
          if (op.k === 'incompleta' || op.k === 'revision' || op.k === 'ambigua' || op.k === 'eliminada_remota' || op.k === 'no_autorizada') { especiales.set(t + '|a:' + (op.id || 'x'), Object.assign({}, op, { tab: t })); res.retenidas++; return; }
          if (op.k === 'nueva') return recuperarNueva(op, remotas, res);
          if (op.k === 'mod') return recuperarMod(op, remotas, res);
          if (op.k === 'config') return recuperarConfig(op, ctx.cfgRemota, res);
          if (op.k === 'divergencia') { puente.recuperarDivergencia && puente.recuperarDivergencia(op); res.recuperadas++; return; }
          if (op.k === 'ficha') { puente.recuperarFicha && puente.recuperarFicha(op); res.recuperadas++; return; }   // R3: se reaplica y se reintenta por el camino seguro (3 vías)
        } catch (e) { console.warn('R2D: no se pudo recuperar una operación (se conserva):', e); especiales.set(t + '|x:' + k, Object.assign({}, op, { tab: t, k: 'no_autorizada', motivo: 'No se pudo recuperar automáticamente: ' + (e && e.message || e) })); res.retenidas++; }
      });
      registrar({ eliminar: reclamar, forzar: true });        // en UNA escritura: las reclamadas salen y las derivadas entran (si la escritura falla, las originales quedan)
    } catch (e) { console.warn('R2D: error en la recuperación:', e); }
    pintar();
    return res;
  }
  function instalar(op, id, local, baseStr, version, res) { puente.instalarFila(id, local, baseStr, version); res.recuperadas++; }
  function recuperarNueva(op, remotas, res) {
    var row = op.row, id = String(op.id), t = miTab();
    if (row && row.tipoRegistro === 'mensaje' && puente.mensajeCompatible && !puente.mensajeCompatible(row)) { puente.resguardarMensaje(row); res.descartadas++; return; }
    var rem = remotas.get(id), existe = (puente.atenciones() || []).some(function (a) { return a && String(a.id) === id; });
    if (!rem) {
      if (existe) { res.recuperadas++; return; }                                  // ya está (p. ej. la recuperó la cola anterior)
      if (P.conCobroRegistrado(row)) { especiales.set(t + '|a:' + id, { k: 'revision', id: id, row: row, ts: op.ts, rol: op.rol, desc: nombreAtencion(row), motivo: 'Atención con cobro ya registrado: no se reenvía sola. Verificá si el servidor la tiene.' }); res.retenidas++; return; }
      if (op.enviado) { especiales.set(t + '|a:' + id, { k: 'ambigua', id: id, row: row, enviado: op.enviado, ts: op.ts, rol: op.rol, desc: nombreAtencion(row), motivo: 'Se intentó enviar y el servidor no la tiene: puede no haber llegado o haber sido eliminada. No se recrea sola.' }); res.retenidas++; return; }
      if (!completaMinima(row)) {
        if (P.identificable(row)) { especiales.set(t + '|a:' + id, { k: 'incompleta', id: id, row: row, ts: op.ts, rol: op.rol, desc: nombreAtencion(row) }); res.retenidas++; }
        else res.descartadas++;                                                    // fila sin ninguna identidad: no hay nada que recuperar
        return;
      }
      puente.agregarNueva(row); res.recuperadas++; return;                        // el sync normal la envía (alta nueva)
    }
    var remStr = P.estable(rem.payload), rowStr = P.estable(row);
    if (remStr === rowStr) { res.confirmadas++; return; }                          // el servidor ya tiene exactamente esto
    if (op.enviado && remStr === op.enviado) { instalar(op, id, row, op.enviado, rem.updated_at, res); return; }   // lo enviado quedó confirmado; sólo faltan ediciones posteriores
    instalar(op, id, row, op.enviado || '{}', SENTINELA, res);                    // el servidor tiene OTRO contenido: base conocida (o vacía) + versión que fuerza la fusión de R2C
  }
  function recuperarMod(op, remotas, res) {
    var id = String(op.id), rem = remotas.get(id), t = miTab();
    if (!rem) { especiales.set(t + '|a:' + id, { k: 'eliminada_remota', id: id, cambios: op.cambios, baseVer: op.baseVer, ts: op.ts, rol: op.rol, desc: op.desc || id, motivo: 'La atención ya no existe en el servidor (eliminada o sin acceso). No se recrea.' }); res.retenidas++; return; }
    var local = P.aplicarAtencion(rem.payload, op.cambios, 'd'), base = P.aplicarAtencion(rem.payload, op.cambios, 'a');
    if (P.estable(local) === P.estable(rem.payload)) { res.confirmadas++; return; }   // ya aplicada (respuesta perdida)
    var mismaVersion = Date.parse(op.baseVer) === Date.parse(rem.updated_at);
    if (mismaVersion) instalar(op, id, local, P.estable(rem.payload), rem.updated_at, res);
    else instalar(op, id, local, P.estable(base), op.baseVer || SENTINELA, res);   // el servidor cambió: el UPDATE condicionado falla y R2C fusiona en 3 vías
  }
  function recuperarConfig(op, cfgRemota, res) {
    var t = miTab();
    if (!cfgRemota || !cfgRemota.config || !puente.configPermitida()) { especiales.set(t + '|c', Object.assign({}, op, { tab: t, k: 'no_autorizada', motivo: 'Cambios de configuración pendientes: este usuario ya no puede escribir la configuración completa.' })); res.retenidas++; return; }
    var local = P.aplicarConfig(cfgRemota.config, op.ops, 'd'), base = P.aplicarConfig(cfgRemota.config, op.ops, 'a');
    if (P.estable(local) === P.estable(cfgRemota.config)) { res.confirmadas++; return; }
    var misma = Date.parse(op.baseVer) === Date.parse(cfgRemota.updated_at);
    puente.instalarConfig(misma ? cfgRemota.config : base, misma ? cfgRemota.updated_at : (op.baseVer || SENTINELA), local); res.recuperadas++;
  }

  // ---------- acciones del usuario ----------
  function marcarEnvio(pares) { (pares || []).forEach(function (p) { enviados.set(String(p[0]), p[1]); limpiados.delete(String(p[0])); }); registrar(); }
  function limpiarEnvio(ids) { (ids || []).forEach(function (id) { if (id == null) return; enviados.delete(String(id)); limpiados.add(String(id)); }); registrar(); }
  function cuarentena(a) {                // true = la fila salió de `atenciones` y quedó como INCOMPLETA (nunca se descarta una fila identificable)
    try {
      if (!listo() || !a || a.id == null || a.tipoRegistro === 'mensaje') return false;
      var id = String(a.id); if (puente.esConfirmada(id) || !P.identificable(a)) return false;
      especiales.set(miTab() + '|a:' + id, { k: 'incompleta', id: id, row: clonar(a), ts: iso(), rol: puente.rol(), desc: nombreAtencion(a) });
      registrar(); return true;
    } catch (e) { return false; }
  }
  function descartar(key) {
    var op = especiales.get(key) || (estadoCola && estadoCola.ops[key]); if (!op) return;
    if (!window.confirm('¿Descartar este cambio pendiente?\n\n' + (((op.k === 'ficha' || op.k === 'divergencia') && puente.fichaDesc ? puente.fichaDesc(op.id) : op.desc) || 'Cambios de configuración') + '\n\nSe pierde para siempre: no se podrá recuperar.')) return;
    try {
      if (op.k === 'mod') { puente.revertirFila(op.id); try { window.cardiolinkAtencionesR2C && window.cardiolinkAtencionesR2C.liberar(op.id); } catch (e) { /* */ } }
      else if (op.k === 'nueva') { puente.quitarLocal(op.id); enviados.delete(String(op.id)); try { window.cardiolinkAtencionesR2C && window.cardiolinkAtencionesR2C.liberar(op.id); } catch (e) { /* */ } }
      else if (op.k === 'config') { puente.descartarConfig(op.ops); }
      else if (op.k === 'ficha') { puente.descartarFicha(op.id); }
      else if (op.k === 'divergencia') { Object.keys(op.campos).forEach(function (c) { puente.resolverDivergencia(op.id, c, 'servidor'); }); }   // descartar = quedarse con el valor del servidor (decisión explícita)
      especiales.delete(key);
    } catch (e) { console.warn('R2D: no se pudo descartar:', e); }
    registrar({ eliminar: [key] }); try { if (window.cardiolinkAtencionesR2C) window.cardiolinkAtencionesR2C.mostrar(); } catch (e) { /* */ }
  }
  async function reenviar(key) {   // revisión / ambigua: el usuario decide DESPUÉS de ver el estado del servidor
    var op = especiales.get(key); if (!op || !op.row) return;
    var id = String(op.id), estado = await puente.consultarServidor(id);
    if (estado && estado.error) { aviso('No se pudo consultar al servidor: ' + estado.error + '. No se reenvió nada.'); return; }
    if (estado && estado.existe) {
      if (P.estable(estado.payload) === P.estable(op.row)) { especiales.delete(key); registrar({ eliminar: [key] }); aviso('El servidor ya tiene esta atención: no hace falta reenviarla.'); return; }
      puente.instalarFila(id, op.row, op.enviado || '{}', SENTINELA);            // existe con otro contenido: R2C fusiona y muestra el conflicto
      especiales.delete(key); registrar({ eliminar: [key] }); aviso('El servidor tiene otra versión: se fusionará o quedará como conflicto.'); puente.sincronizarYa(); return;
    }
    if (!window.confirm('El servidor NO tiene esta atención.\n\n' + (op.desc || '') + '\n\n¿La enviás ahora? (Se vuelve a crear.)')) return;
    puente.agregarNueva(op.row); especiales.delete(key); registrar({ eliminar: [key] }); puente.sincronizarYa();
  }
  function completar(key, valores) {
    var op = especiales.get(key); if (!op || op.k !== 'incompleta') return { ok: false, error: 'No encontrada.' };
    var row = clonar(op.row);
    if (valores.cobertura) { row.obraSocial = valores.cobertura; row.coberturaAtencion = valores.cobertura; }
    if (valores.prestacion) row.prestacion = valores.prestacion;
    if (valores.profesionalId) { row.profesionalId = valores.profesionalId; row.profesional = valores.profesional || row.profesional; }
    if (!completaMinima(row)) return { ok: false, error: 'Todavía faltan datos obligatorios (cobertura, prestación y profesional).' };
    puente.agregarNueva(row); especiales.delete(key); registrar({ eliminar: [key] }); puente.sincronizarYa();
    return { ok: true };
  }

  // ---------- resumen e interfaz ----------
  function resumen() {
    var items = [], st = estadoCola || { ops: {} }, t = miTab(), n = ahora();
    var r2c = {}; try { r2c = window.cardiolinkAtencionesR2C ? window.cardiolinkAtencionesR2C.estado().retenidas : {}; } catch (e) { r2c = {}; }
    var cfgConf = 0; try { cfgConf = window.cardiolinkConfigR2B ? window.cardiolinkConfigR2B.conflictos().length : 0; } catch (e) { cfgConf = 0; }
    Object.keys(st.ops).forEach(function (key) {
      var op = st.ops[key]; if (op.tab !== t) return;
      var tipo = 'pendiente', det = '';
      if (op.k === 'mod') { det = 'Campos: ' + Object.keys(op.cambios).slice(0, 6).join(', '); var rt = r2c[op.id]; if (rt) tipo = /^rechazo/.test(rt) ? 'rechazada' : 'conflicto'; }
      else if (op.k === 'nueva') { det = 'Atención nueva sin confirmar'; var rt2 = r2c[op.id]; if (rt2) tipo = /^rechazo/.test(rt2) ? 'rechazada' : 'conflicto'; }
      else if (op.k === 'config') { det = 'Configuración: ' + op.ops.length + ' cambio' + (op.ops.length === 1 ? '' : 's') + (op.noProt && op.noProt.length ? ' (no protegidos: ' + op.noProt.slice(0, 3).join(', ') + ')' : ''); if (cfgConf) tipo = 'conflicto'; }
      else if (op.k === 'divergencia') { tipo = 'revision'; det = 'Diferencias sin base confiable (se conservan las dos versiones): ' + Object.keys(op.campos).map(function (c) { return c + ' — tuyo «' + (op.campos[c].local == null ? 'vacío' : op.campos[c].local) + '» / servidor «' + (op.campos[c].remoto == null ? 'vacío' : op.campos[c].remoto) + '»'; }).join('; '); }
      else if (op.k === 'ficha') { det = 'Datos del paciente: ' + Object.keys(op.cambios).join(', ') + ' (sin confirmar en el servidor)'; }
      else if (op.k === 'incompleta') { tipo = 'incompleta'; det = 'Faltan cobertura, prestación o profesional. No entra en Caja ni facturación.'; }
      else if (op.k === 'revision') { tipo = 'revision'; det = op.motivo; }
      else if (op.k === 'ambigua') { tipo = 'revision'; det = op.motivo; }
      else if (op.k === 'eliminada_remota') { tipo = 'conflicto'; det = op.motivo + ' Campos: ' + Object.keys(op.cambios || {}).slice(0, 5).join(', '); }
      else if (op.k === 'no_autorizada') { tipo = 'rechazada'; det = op.motivo || 'No autorizada.'; }
      var viva = op.id != null ? (puente.atenciones() || []).find(function (a) { return a && String(a.id) === String(op.id); }) : null;
      items.push({ key: key, op: op, tipo: tipo, det: det, desc: op.desc || ((op.k === 'ficha' || op.k === 'divergencia') && puente.fichaDesc ? puente.fichaDesc(op.id) : viva ? nombreAtencion(viva) : (op.row ? nombreAtencion(op.row) : (op.k === 'config' ? 'Configuración' : String(op.id || '')))), dias: P.antiguedadDias(op, n) });
    });
    Object.keys(r2c).forEach(function (id) {   // conflictos de R2C sin operación propia (p. ej. atención eliminada en otra sesión): se muestran igual
      if (!/^eliminada/.test(r2c[id])) return;
      if (items.some(function (i) { return String(i.op.id) === id; })) return;
      items.push({ key: 'r2c|' + id, op: { k: 'eliminada_r2c', id: id }, tipo: 'conflicto', det: 'Otra sesión eliminó esta atención y tenías cambios. Se resuelve en el aviso de turnos.', desc: 'Atención ' + id, dias: 0 });
    });
    return items;
  }
  function aviso(texto) { try { if (window.cardiolinkConfigR2B && window.cardiolinkConfigR2B.avisoTransitorio) window.cardiolinkConfigR2B.avisoTransitorio(texto); else alert(texto); } catch (e) { /* */ } }
  function crear(tag, css, txt) { var e = document.createElement(tag); if (css) e.style.cssText = css; if (txt != null) e.textContent = txt; return e; }
  function pintar() {
    try {
      if (!document.body) return;
      var items = resumen(), sinProtec = !proteccion.ok, malo = items.some(function (i) { return i.tipo === 'conflicto' || i.tipo === 'rechazada' || i.tipo === 'revision'; }) || sinProtec;
      var firma = JSON.stringify([items.map(function (i) { return [i.key, i.tipo, i.dias >= P.DIAS_AVISO]; }), proteccion.ok, proteccion.dañada, estadoUI.abierto]);
      if (firma === ultimaFirma) return; ultimaFirma = firma;
      var ins = document.getElementById(ID_INSIGNIA), panel = document.getElementById(ID_PANEL);
      if (!items.length && !sinProtec && !proteccion.dañada) { if (ins) ins.remove(); if (panel) panel.remove(); return; }
      if (!ins) { ins = crear('button', ''); ins.id = ID_INSIGNIA; ins.type = 'button'; ins.addEventListener('click', function () { estadoUI.abierto = !estadoUI.abierto; ultimaFirma = ''; pintar(); }); document.body.appendChild(ins); }
      ins.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:99995;border:0;border-radius:999px;padding:8px 14px;font:700 13px system-ui,Arial,sans-serif;cursor:pointer;box-shadow:0 4px 18px rgba(0,0,0,.25);color:#fff;background:' + (malo ? '#b91c1c' : '#b45309');
      var n = items.length; ins.textContent = sinProtec ? '⚠ ' + n + ' cambio' + (n === 1 ? '' : 's') + ' SIN protección local' : n + ' cambio' + (n === 1 ? '' : 's') + ' pendiente' + (n === 1 ? '' : 's') + ' de sincronización';
      if (panel) panel.remove();
      if (!estadoUI.abierto) return;
      panel = crear('div', 'position:fixed;left:12px;bottom:56px;z-index:99995;max-width:min(560px,calc(100vw - 24px));max-height:60vh;overflow:auto;background:#fff;color:#1f2937;border:2px solid ' + (malo ? '#b91c1c' : '#b45309') + ';border-radius:12px;padding:12px 14px;font:13px/1.4 system-ui,Arial,sans-serif;box-shadow:0 10px 32px rgba(0,0,0,.35)');
      panel.id = ID_PANEL; panel.setAttribute('role', 'dialog');
      panel.appendChild(crear('div', 'font-weight:800;margin-bottom:6px', 'Cambios pendientes de sincronización'));
      if (sinProtec) panel.appendChild(crear('div', 'background:#fee2e2;border:1px solid #b91c1c;border-radius:8px;padding:6px 8px;margin:6px 0;font-weight:700', '⚠ Estos cambios NO están protegidos contra una recarga: no se pudo guardar la copia local (' + (proteccion.error || 'almacenamiento lleno o no disponible') + '). Evitá cerrar o recargar hasta que se sincronicen.'));
      if (proteccion.dañada) panel.appendChild(crear('div', 'background:#fef3c7;border:1px solid #f59e0b;border-radius:8px;padding:6px 8px;margin:6px 0', 'La cola local guardada estaba dañada; se conservó una copia aparte sin borrarla y se empezó una nueva.'));
      if (proteccion.grande) panel.appendChild(crear('div', 'margin:6px 0;color:#92400e', 'La cola local es grande: sincronizá pronto para no agotar el almacenamiento del equipo.'));
      if (items.some(function (i) { return i.dias >= P.DIAS_AVISO; })) panel.appendChild(crear('div', 'background:#fef3c7;border:1px solid #f59e0b;border-radius:8px;padding:6px 8px;margin:6px 0;font-weight:700', 'Hay cambios con más de ' + P.DIAS_AVISO + ' días sin sincronizar. No se borran solos: revisá si siguen vigentes.'));
      var ROT = { pendiente: 'Pendiente', conflicto: 'Conflicto', rechazada: 'Rechazada', incompleta: 'Incompleta', revision: 'Requiere revisión' };
      items.forEach(function (it) {
        var f = crear('div', 'border:1px solid #e5e7eb;border-radius:8px;padding:6px 8px;margin:6px 0');
        var cab = crear('div', 'display:flex;gap:8px;align-items:baseline;flex-wrap:wrap');
        cab.appendChild(crear('span', 'font-size:11px;font-weight:800;border-radius:6px;padding:1px 6px;color:#fff;background:' + ({ pendiente: '#b45309', conflicto: '#b91c1c', rechazada: '#7f1d1d', incompleta: '#4338ca', revision: '#9a3412' }[it.tipo] || '#555'), ROT[it.tipo] || it.tipo));
        cab.appendChild(crear('strong', '', it.desc)); cab.appendChild(crear('span', 'color:#6b7280;font-size:12px', it.dias >= 1 ? 'hace ' + it.dias + ' día' + (it.dias === 1 ? '' : 's') : 'hoy'));
        f.appendChild(cab); if (it.det) f.appendChild(crear('div', 'color:#4b5563;font-size:12px', it.det));
        var acc = crear('div', 'display:flex;gap:6px;flex-wrap:wrap;margin-top:4px');
        function b(txt, fn, peligro) { var x = crear('button', 'padding:4px 10px;border-radius:7px;border:1px solid ' + (peligro ? '#b91c1c' : '#9ca3af') + ';background:#fff;color:' + (peligro ? '#b91c1c' : '#111') + ';font-weight:700;cursor:pointer', txt); x.type = 'button'; x.addEventListener('click', fn); acc.appendChild(x); }
        if (it.tipo === 'pendiente') b('Reintentar', function () { puente.sincronizarYa(); if (it.op.k === 'config') puente.guardarConfigYa(); if (it.op.k === 'ficha') puente.reintentarFichas(); });
        if (it.tipo === 'conflicto') b('Resolver conflicto', function () { try { if (it.op.k === 'config') window.cardiolinkConfigR2B.abrirPanel(); else window.cardiolinkAtencionesR2C.abrirPanel(); } catch (e) { console.warn(e); } });
        if (it.tipo === 'rechazada' && it.op.k !== 'config' && it.op.k !== 'no_autorizada') b('Reintentar', function () { try { window.cardiolinkAtencionesR2C.liberar(it.op.id); puente.sincronizarYa(); } catch (e) { console.warn(e); } });
        if (it.tipo === 'rechazada' && it.op.k === 'no_autorizada') b('Reintentar', function () { aviso('Se vuelve a validar al iniciar sesión.'); });
        if (it.op.k === 'divergencia') Object.keys(it.op.campos).forEach(function (c) { b('Usar el del servidor (' + c + ')', function () { puente.resolverDivergencia(it.op.id, c, 'servidor'); }); b('Usar el mío (' + c + ')', function () { puente.resolverDivergencia(it.op.id, c, 'mio'); }); });
        if (it.op.k === 'incompleta') b('Completar', function () { mostrarCompletar(it, f); });
        if (it.op.k === 'revision' || it.op.k === 'ambigua') b('Revisar y reenviar', function () { reenviar(it.key); });
        if (it.op.k !== 'eliminada_r2c' && it.op.k !== 'divergencia') b('Descartar', function () { descartar(it.key); }, true);
        f.appendChild(acc); panel.appendChild(f);
      });
      var pie = crear('div', 'margin-top:6px;font-size:11px;color:#6b7280', 'Se guardan sólo diferencias y filas nuevas, en este equipo y para este usuario. No es un respaldo cifrado: en un equipo compartido cerrá sesión y descartá lo que no quieras dejar.');
      panel.appendChild(pie); document.body.appendChild(panel);
    } catch (e) { console.warn('R2D: no se pudo mostrar la cola:', e); }
  }
  function mostrarCompletar(it, contenedor) {
    var r = it.op.row || {}, form = crear('div', 'margin-top:6px;border-top:1px dashed #d1d5db;padding-top:6px'), vals = {};
    function campo(etq, id, valor) { var l = crear('label', 'display:block;margin:3px 0', etq + ' '); var i = document.createElement('input'); i.type = 'text'; i.value = valor || ''; i.style.cssText = 'width:60%;padding:3px 6px'; i.addEventListener('input', function () { vals[id] = i.value.trim(); }); l.appendChild(i); form.appendChild(l); vals[id] = (valor || '').trim(); }
    campo('Cobertura / obra social:', 'cobertura', r.obraSocial || r.coberturaAtencion); campo('Prestación:', 'prestacion', r.prestacion);
    var sel = document.createElement('select'); sel.style.cssText = 'padding:3px 6px'; var o0 = document.createElement('option'); o0.value = ''; o0.textContent = '(elegir profesional)'; sel.appendChild(o0);
    (puente.profesionales() || []).forEach(function (p) { var o = document.createElement('option'); o.value = p.id; o.textContent = p.nombre || p.id; if (String(p.id) === String(r.profesionalId)) o.selected = true; sel.appendChild(o); });
    var lp = crear('label', 'display:block;margin:3px 0', 'Profesional: '); lp.appendChild(sel); form.appendChild(lp);
    var msg = crear('div', 'color:#b91c1c;font-weight:700'); form.appendChild(msg);
    var ok = crear('button', 'padding:4px 10px;border-radius:7px;border:1px solid #166534;background:#166534;color:#fff;font-weight:700;cursor:pointer', 'Guardar y enviar'); ok.type = 'button';
    ok.addEventListener('click', function () { var p = (puente.profesionales() || []).find(function (x) { return String(x.id) === sel.value; }); var res = completar(it.key, { cobertura: vals.cobertura, prestacion: vals.prestacion, profesionalId: sel.value, profesional: p && p.nombre }); if (!res.ok) msg.textContent = res.error; });
    form.appendChild(ok); contenedor.appendChild(form);
  }

  function hayPendientes() { return resumen().length > 0; }
  function idsGestionados() { var s = new Set(); especiales.forEach(function (op) { if (op.id != null) s.add(String(op.id)); }); return s; }
  function conectar(p) {
    puente = p; miTab();
    var t = function () { try { registrar(); } catch (e) { /* */ } };
    setInterval(t, 4000);
    document.addEventListener('visibilitychange', function () { if (document.hidden) t(); });
    // Aviso del navegador SÓLO cuando hay cambios que no se pudieron proteger localmente (cuota/almacenamiento): es un complemento, no la protección.
    window.addEventListener('beforeunload', function (ev) { try { if (!proteccion.ok && resumen().length) { ev.preventDefault(); ev.returnValue = ''; return ''; } } catch (e) { /* */ } });
    window.addEventListener('pagehide', function () { try { registrar({ cerrada: true }); } catch (e) { /* */ } });
    window.addEventListener('storage', function (ev) { if (ev && ev.key && ev.key.indexOf('cardiolink_outbox_r2d_v1:') === 0) { try { var ab = P.abrir(localStorage, clave || ev.key); estadoCola = ab.estado; ultimaFirma = ''; pintar(); } catch (e) { /* */ } } });
  }
  window.cardiolinkOutboxR2D = {
    conectar: conectar, registrar: registrar, recuperar: recuperar, marcarEnvio: marcarEnvio, limpiarEnvio: limpiarEnvio, cuarentena: cuarentena, hayPendientes: hayPendientes, idsGestionados: idsGestionados,
    protegido: function () { return proteccion.ok; }, sinProteccion: function () { return proteccion.ok ? 0 : resumen().length; }, resumen: function () { return resumen().map(function (i) { return { key: i.key, k: i.op.k, tipo: i.tipo, id: i.op.id || null, dias: i.dias }; }); },
    completar: completar, descartar: descartar, reenviar: reenviar, estado: function () { return { proteccion: Object.assign({}, proteccion), tab: tabId, especiales: Array.from(especiales.keys()), clave: clave, items: resumen().length }; },
    abrir: function () { estadoUI.abierto = true; ultimaFirma = ''; pintar(); }, SENTINELA: SENTINELA, VERSION: P.VERSION
  };
})();
