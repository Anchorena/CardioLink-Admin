/* CardioLink · Persistencia V1 / R2C · Concurrencia de ATENCIONES individuales (Supabase cardiolink_atenciones).
   Reemplaza la regla anterior «si otra sesión cambió la fila, se adopta la remota y se descartan los cambios locales» por:
     base (contenido que esta sesión cargó/confirmó) / local (su copia con cambios) / remoto (fila actual del servidor)  →  fusión por grupos (cardiolink-atenciones-merge-v1.js)
     + UPDATE condicionado a updated_at (máx. 3 reintentos) + confirmación con el updated_at devuelto por el servidor.
   Sin SQL: usa la misma tabla, RLS y guard v4.2.1 que ya existen (un rechazo del servidor se informa, no se evade). Sin upsert ciego: una fila existente jamás se recrea.
   Orden de carga: DESPUÉS de app.js, de cardiolink-atenciones-merge-v1.js y de cardiolink-config-concurrencia-v1.js (reutiliza su panel de conflictos).
   app.js lo conecta con conectar({...}) (las líneas base viven en una clausura de app.js). Si este módulo no carga, app.js CONSERVA los cambios locales y avisa (nunca los descarta). */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.cardiolinkAtencionesR2C) return;
  var F = window.cardiolinkAtencionesMergeV1;
  var MAX_REINTENTOS = 3, ID_PANEL = 'cardiolinkConflictosAtencionesV1', ID_INSIGNIA = 'cardiolinkConflictosAtencionesInsigniaV1';
  var K_RECHAZOS = 'cardiolink_atenciones_rechazos_v1', K_ELIMINADAS = 'cardiolink_atenciones_eliminadas_remotas_v1';
  var puente = null;
  var retenidas = new Map();      // id → { tipo:'conflicto'|'rechazo'|'eliminada', contenido, conflictos[], remoto:{payload,updated_at}, local, mensaje }
  var colas = new Map();          // id → promesa en curso (una sola operación por atención a la vez)
  var contadores = { fusiones: 0, conflictos: 0, rechazos: 0, reintentos: 0, eliminadas: 0 };

  function clonar(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function estable(o) { return puente && puente.estable ? puente.estable(o) : JSON.stringify(o); }
  function ahora() { return new Date().toISOString(); }
  function uid() { try { return String(usuarioSupabase && usuarioSupabase.id || ''); } catch (e) { return ''; } }
  function leerJSON(k) { try { var v = JSON.parse(localStorage.getItem(k) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
  function escribirJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  function esErrorPermiso(e) { return !!e && (e.code === '42501' || /row-level security|permission denied|Rol no autorizado/i.test(String(e.message || ''))); }
  function nombreAtencion(a) { a = a || {}; return (a.paciente || a.pacienteNombre || 'paciente sin nombre') + ' · ' + (a.fecha || 's/fecha') + (a.horaInicio ? ' ' + a.horaInicio : ''); }
  function ctxFusion(res) { var u = puente && puente.usuario ? puente.usuario() : ''; return { rol: puente.rol(), usuario: u, ahora: ahora(), resoluciones: res || {} }; }

  // ---------- recuperación local de lo rechazado (sólo los campos rechazados; nunca copias completas salvo eliminación remota) ----------
  function guardarRechazos(id, atencion, rechazos) {
    if (!rechazos || !rechazos.length) return;
    var lista = leerJSON(K_RECHAZOS);
    rechazos.forEach(function (r) {
      lista.push({ id: String(id), uid: uid(), ts: ahora(), atencion: nombreAtencion(atencion), grupo: r.grupo, campos: r.campos, valores: r.valoresLocales, motivo: r.motivo, visto: false });
    });
    escribirJSON(K_RECHAZOS, lista.slice(-100));
    contadores.rechazos += rechazos.length;
  }
  function rechazosNoVistos() { var u = uid(); return leerJSON(K_RECHAZOS).filter(function (r) { return r && r.uid === u && !r.visto; }); }
  function marcarRechazosVistos() { var u = uid(); escribirJSON(K_RECHAZOS, leerJSON(K_RECHAZOS).map(function (r) { if (r && r.uid === u) r.visto = true; return r; })); }
  function persistirEliminadas() {
    var lista = leerJSON(K_ELIMINADAS).filter(function (x) { return x && x.uid !== uid(); });
    retenidas.forEach(function (v, id) { if (v.tipo === 'eliminada') lista.push({ id: id, uid: uid(), ts: v.ts, local: v.local, base: v.baseCampos }); });
    escribirJSON(K_ELIMINADAS, lista.slice(-50));
  }

  // ---------- estado retenido ----------
  function retener(id, v) { v.ts = v.ts || ahora(); retenidas.set(String(id), v); if (v.tipo === 'eliminada') persistirEliminadas(); mostrar(); }
  function liberar(id) { var t = retenidas.get(String(id)); retenidas.delete(String(id)); if (t && t.tipo === 'eliminada') persistirEliminadas(); mostrar(); }
  // ¿Esta fila NO debe enviarse ahora? (conflicto sin resolver, eliminación remota pendiente o rechazo del servidor con el mismo contenido)
  function retenida(id, contenidoActual) {
    var v = retenidas.get(String(id)); if (!v) return false;
    if (v.tipo === 'rechazo') { if (contenidoActual !== undefined && contenidoActual !== v.contenido) { retenidas.delete(String(id)); mostrar(); return false; } return true; }
    return true;
  }
  function hayRetenidas() { return retenidas.size > 0; }

  // ---------- lectura / escritura ----------
  async function leerRemoto(id) {
    var r = await puente.supabase().from('cardiolink_atenciones').select('id,payload,updated_at').eq('id', String(id)).limit(1);
    if (r.error) return { error: r.error };
    var f = Array.isArray(r.data) ? r.data[0] : r.data;
    return { fila: f && f.payload ? f : null };
  }

  // Aplica en la sesión una versión ya confirmada por el servidor, conservando ediciones hechas mientras se guardaba.
  function aplicarConfirmada(id, enviadoStr, confirmado, version) {
    var actual = puente.actual(id);
    if (!actual) { puente.fijarBase(id, confirmado, version); return { editadaEnVuelo: false }; }
    if (estable(actual) === enviadoStr) { puente.reemplazar(id, confirmado); puente.fijarBase(id, confirmado, version); return { editadaEnVuelo: false }; }
    // se editó mientras se guardaba: la edición se rebasa sobre lo confirmado (base = lo enviado); si choca, queda como conflicto para resolver
    var base = JSON.parse(enviadoStr);
    var m2 = F.fusionarAtencion(base, actual, confirmado, ctxFusion());
    puente.fijarBase(id, confirmado, version);
    if (m2.ok) { puente.reemplazar(id, m2.payload); return { editadaEnVuelo: true }; }
    retener(id, { tipo: 'conflicto', contenido: estable(actual), conflictos: m2.conflictos, remoto: { payload: clonar(confirmado), updated_at: version }, mensaje: 'Editaste este turno mientras se guardaba.' });
    return { editadaEnVuelo: true, conflicto: true };
  }

  // Núcleo: relee, fusiona y guarda con UPDATE condicionado. Devuelve {estado, ...}.
  async function reconciliarFilaInterno(id, opciones) {
    opciones = opciones || {};
    id = String(id);
    if (id === '__cardiolink_config_v1') return { estado: 'error_transitorio', error: new Error('La fila de configuración no se gestiona como atención.') };   // nunca toca la config
    var intento = 0;
    while (intento < MAX_REINTENTOS) {
      intento++; if (intento > 1) contadores.reintentos++;
      var local = clonar(puente.actual(id));
      if (!local) { liberar(id); return { estado: 'sin_local' }; }
      var enviadoStr = estable(local);
      var rem = await leerRemoto(id);
      if (rem.error) return { estado: 'error_transitorio', error: rem.error };
      if (!rem.fila) return tratarEliminada(id, local);
      var baseStr = puente.base(id), base = {};
      try { if (baseStr) base = JSON.parse(baseStr); } catch (e) { base = {}; }
      var m = F.fusionarAtencion(base, local, rem.fila.payload, ctxFusion(opciones.resoluciones));
      if (!m.ok) {
        contadores.conflictos++;
        puente.fijarVersion(id, rem.fila.updated_at);                       // la próxima resolución parte de esta versión del servidor; el contenido-base no cambia (sigue figurando como modificada)
        retener(id, { tipo: 'conflicto', contenido: enviadoStr, conflictos: m.conflictos, remoto: { payload: clonar(rem.fila.payload), updated_at: rem.fila.updated_at }, local: local, rechazos: m.rechazos });
        if (m.rechazos.length) guardarRechazos(id, local, m.rechazos);
        return { estado: 'conflicto', conflictos: m.conflictos };
      }
      if (m.rechazos.length) guardarRechazos(id, local, m.rechazos);
      var destino = m.payload, version = rem.fila.updated_at;
      if (estable(destino) !== estable(rem.fila.payload)) {
        var nuevaVersion = ahora();
        var u = await puente.supabase().from('cardiolink_atenciones').update({ payload: destino, updated_at: nuevaVersion }).eq('id', id).eq('updated_at', rem.fila.updated_at).select('id, updated_at');
        if (u.error) {
          if (esErrorPermiso(u.error)) return rechazoDelServidor(id, local, u.error);
          return { estado: 'error_transitorio', error: u.error };
        }
        if (!Array.isArray(u.data) || !u.data.length) continue;           // otra sesión cambió la fila entre la lectura y la escritura: se relee y se vuelve a fusionar
        version = u.data[0].updated_at || nuevaVersion;
      }
      liberar(id);
      var ap = aplicarConfirmada(id, enviadoStr, destino, version);
      if (m.camposLocales.length && m.camposRemotos.length) contadores.fusiones++;
      return { estado: 'confirmada', rechazos: m.rechazos, fusionada: !!(m.camposLocales.length && m.camposRemotos.length), editadaEnVuelo: ap.editadaEnVuelo, version: version };
    }
    return { estado: 'reintentos_agotados' };
  }
  function reconciliarFila(id, opciones) {
    id = String(id);
    var previa = colas.get(id) || Promise.resolve();
    var t = previa.catch(function () { /* */ }).then(function () { return reconciliarFilaInterno(id, opciones); });
    colas.set(id, t.catch(function () { /* */ }));
    return t;
  }

  function rechazoDelServidor(id, local, error) {
    retener(id, { tipo: 'rechazo', contenido: estable(local), mensaje: String(error.message || 'El servidor rechazó el cambio por permisos.'), local: null });
    guardarRechazos(id, local, [{ grupo: 'servidor', campos: ['(atención completa)'], valoresLocales: {}, motivo: 'El servidor rechazó guardar este cambio: ' + String(error.message || 'sin permiso') + ' Quedó en este equipo y no se reintenta hasta que lo edites de nuevo.' }]);
    contadores.rechazos++;
    return { estado: 'rechazada', error: error };
  }
  // Un error de UPDATE/INSERT de la primera tentativa (hecha por app.js): permisos/guard → se retiene sin reintento infinito; otro → transitorio.
  function manejarErrorFila(id, atencion, error) {
    if (esErrorPermiso(error)) { rechazoDelServidor(String(id), atencion, error); return 'rechazada'; }
    return 'transitoria';
  }

  function tratarEliminada(id, local) {
    var baseStr = puente.base(id), base = {}; try { if (baseStr) base = JSON.parse(baseStr); } catch (e) { base = {}; }
    contadores.eliminadas++;
    puente.quitarLocal(id);                                                   // nunca se recrea sola: sale de la agenda local y de ambos baselines
    retener(id, { tipo: 'eliminada', contenido: estable(local), local: clonar(local), baseCampos: null, conflictos: [{ clave: 'eliminada', tipo: 'eliminacion_vs_modificacion', grupo: 'Atención eliminada en otra sesión', atencionId: id, campos: ['(atención completa)'], opciones: { local: !!(puente.puedeRecrear && puente.puedeRecrear()), remoto: true }, localTexto: 'restaurar mi versión (se vuelve a crear)', remotoTexto: 'aceptar la eliminación (mis cambios quedan guardados como respaldo)' }] });
    return { estado: 'eliminada_remota' };
  }

  // ---------- resolución desde el panel ----------
  async function resolver(res) {
    var porId = {};
    Object.keys(res).forEach(function (k) { var i = k.indexOf('|'); var id = k.slice(0, i), clave = k.slice(i + 1); (porId[id] = porId[id] || {})[clave] = res[k]; });
    var ok = true;
    for (var id of Object.keys(porId)) {
      var v = retenidas.get(id); if (!v) continue;
      var r = porId[id];
      if (v.tipo === 'eliminada') {
        if (r.eliminada === 'local') {
          try { puente.restaurar(id, clonar(v.local)); liberar(id); try { puente.guardar(); } catch (e) { /* se reintenta en el próximo ciclo */ } } catch (e) { ok = false; console.warn(e); }
        } else if (r.eliminada === 'remoto') {
          guardarRechazos(id, v.local, [{ grupo: 'eliminada', campos: ['(cambios locales de la atención)'], valoresLocales: { atencion: nombreAtencion(v.local) }, motivo: 'Aceptaste la eliminación hecha en otra sesión; tus cambios locales se conservaron como respaldo en este equipo.' }]);
          liberar(id);
        }
        continue;
      }
      var res2 = {}; Object.keys(r).forEach(function (c) { res2[c] = r[c]; });
      // las resoluciones se aplican sobre una RELECTURA del servidor
      var out = await reconciliarFila(id, { resoluciones: res2 });
      if (out.estado !== 'confirmada') ok = false;
      else try { puente.alConfirmar && puente.alConfirmar(id); } catch (e) { /* */ }
    }
    mostrar();
    return { ok: ok && retenidas.size === 0 };
  }

  // ---------- panel (reutiliza el de R2B) ----------
  var TEXTO_TIPO = {
    campo: 'Se cambió el mismo dato en las dos sesiones.', financiero: 'Los datos económicos (importes, forma de pago, caja) cambiaron distinto en las dos sesiones; se resuelven juntos.',
    estado: 'El estado del turno cambió de forma incompatible en las dos sesiones. No se resuelve por fecha de edición.', identidad: 'Cambió el paciente, el profesional o la pertenencia del turno: no se fusiona sola.',
    agenda: 'La fecha u horario cambió distinto en las dos sesiones.', pendiente: 'Este pendiente quedó distinto en las dos sesiones.', eliminacion_vs_modificacion: 'Otra sesión eliminó esta atención y vos la modificaste. No se vuelve a crear sola.',
    bloque: 'Se cambió la misma lista en las dos sesiones.'
  };
  function datosPanel() {
    var items = [], avisos = [];
    retenidas.forEach(function (v, id) {
      if (v.tipo === 'rechazo') return;                 // se informa con el registro de recuperación (rechazosNoVistos)
      var ref = v.local || puente.actual(id) || (v.remoto && v.remoto.payload);
      (v.conflictos || []).forEach(function (c) {
        items.push({ clave: id + '|' + c.clave, titulo: 'Atención: ' + nombreAtencion(ref), detalle: c.grupo + ' · paciente: ' + ((ref && ref.paciente) || '—') + ' · fecha: ' + ((ref && ref.fecha) || '—') + ' · ID ' + id,
          tipoTexto: TEXTO_TIPO[c.tipo] || 'Conflicto.', localTexto: c.localTexto, remotoTexto: c.remotoTexto, opciones: c.opciones || { local: true, remoto: true },
          nota: (c.tipo === 'estado' && !(c.opciones || {}).local) ? 'El paciente canceló este turno: esa cancelación no se revierte desde acá.' : (v.mensaje || undefined) });
      });
    });
    rechazosNoVistos().forEach(function (r) { avisos.push({ texto: r.atencion + ' — ' + r.motivo + ' (Valores que no se aplicaron: ' + JSON.stringify(r.valores) + ')', boton: 'Entendido', alBoton: function () { marcarRechazosVistos(); } }); });
    return { items: items, avisos: avisos };
  }
  var cfgPanel = {
    id: ID_PANEL, idInsignia: ID_INSIGNIA,
    titulo: function (n, a) { return n ? 'Turnos con ' + n + ' conflicto' + (n === 1 ? '' : 's') + ' con otra sesión' : 'Avisos sobre cambios en turnos'; },
    intro: 'Tus otros cambios y los de la otra sesión se conservan. Sólo hay que elegir qué valor queda en lo que sigue. Nada se pisa ni se descarta sin avisarte.',
    textoInsignia: function (n, a) { return 'Turnos: ' + (n ? n + ' conflicto' + (n === 1 ? '' : 's') : a + ' aviso' + (a === 1 ? '' : 's')) + ' sin resolver'; },
    items: [], avisos: [], onResolver: function (res) { return resolver(res); }, actual: datosPanel, avisoFinal: 'Conflictos de turnos resueltos y guardados en el servidor.'
  };
  var ultimaFirma = '';
  function mostrar() {
    try {
      var d = datosPanel(); cfgPanel.items = d.items; cfgPanel.avisos = d.avisos;
      var R = window.cardiolinkConfigR2B;
      if (!R || !R.panelGenerico) return;
      var firma = JSON.stringify([d.items.map(function (i) { return i.clave + i.localTexto + i.remotoTexto; }), d.avisos.map(function (a) { return a.texto; })]);
      if (!d.items.length && !d.avisos.length) { ultimaFirma = ''; R.quitarPanelGenerico(cfgPanel); return; }
      if (firma === ultimaFirma) return;           // mismos avisos de siempre: no se reabre el panel (si se cerró queda la insignia)
      ultimaFirma = firma; R.panelGenerico(cfgPanel);
    } catch (e) { console.warn('R2C: no se pudo mostrar el aviso de turnos:', e); }
  }

  function conectar(p) {
    puente = p;
    var u = uid();
    leerJSON(K_ELIMINADAS).forEach(function (x) {   // eliminaciones remotas pendientes de decidir que sobrevivieron a una recarga
      if (!x || x.uid !== u || retenidas.has(String(x.id))) return;
      retenidas.set(String(x.id), { tipo: 'eliminada', contenido: estable(x.local), local: x.local, ts: x.ts, conflictos: [{ clave: 'eliminada', tipo: 'eliminacion_vs_modificacion', grupo: 'Atención eliminada en otra sesión', atencionId: String(x.id), campos: ['(atención completa)'], opciones: { local: !!(p.puedeRecrear && p.puedeRecrear()), remoto: true }, localTexto: 'restaurar mi versión (se vuelve a crear)', remotoTexto: 'aceptar la eliminación (mis cambios quedan guardados como respaldo)' }] });
    });
    mostrar();
  }

  window.cardiolinkAtencionesR2C = {
    conectar: conectar, activo: function () { return !!puente && !!F; }, reconciliarFila: reconciliarFila, manejarErrorFila: manejarErrorFila, retenida: retenida, hayRetenidas: hayRetenidas,
    liberar: liberar, mostrar: mostrar, resolver: resolver, retenidasIds: function () { return Array.from(retenidas.keys()); },
    estado: function () { var o = {}; retenidas.forEach(function (v, id) { o[id] = v.tipo + (v.conflictos ? ':' + v.conflictos.length : ''); }); return { retenidas: o, contadores: Object.assign({}, contadores), rechazosNoVistos: rechazosNoVistos().length }; },
    _recuperacion: function () { return { rechazos: leerJSON(K_RECHAZOS), eliminadas: leerJSON(K_ELIMINADAS) }; },
    MAX_REINTENTOS: MAX_REINTENTOS, VERSION: 'r2c-1'
  };
})();
