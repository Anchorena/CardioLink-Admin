/* CardioLink · Persistencia V1 · Seguridad del almacenamiento local V1 (equipo compartido, aislamiento por proyecto + UID, antigüedad y descarte explícito).

   CONFIDENCIALIDAD (qué es protección y qué no): separar claves por proyecto + uid y avisar NO protege nada: localStorage no está cifrado y cualquiera con acceso al navegador lo lee.
   La protección real de este módulo es el SELLADO AL CIERRE (equipo compartido): al cerrar sesión con datos sin sincronizar, todo lo sensible del usuario (cola, respaldos y caché) se cifra
   con AES-GCM-256 usando una clave derivada (PBKDF2-SHA256, 600 000 iteraciones, sal aleatoria por paquete) de la CONTRASEÑA del usuario, que NUNCA se guarda: ni la contraseña ni la clave
   quedan en ningún almacenamiento (sólo la clave derivada, no extraíble, en la memoria de la pestaña mientras dura la sesión). El paquete cifrado va a IndexedDB; el texto plano se borra
   sólo DESPUÉS de verificar que el paquete se descifra y coincide. Otro usuario del equipo sólo ve un paquete opaco. Si no se puede sellar, NO se cierra dejando datos legibles: el usuario
   debe sincronizar o descartar (nunca se pierde nada en silencio). Mientras la sesión está activa los datos están en claro, como en cualquier aplicación web.
   Límites: si el usuario cambia su contraseña antes de volver a entrar, el paquete no se puede abrir (se informa y se puede descartar); no protege frente a malware ni frente a alguien
   con la sesión abierta; el modo «equipo personal» (desactivado el compartido) conserva todo en claro, como antes, y lo advierte.

   QUÉ HACE
     · Claves `<base>:<proyecto>:<uid>` para rechazos, eliminadas, mensajes no enviados, colas de Secretaría (config pendiente/conflicto), documentos y atenciones nuevas.
     · Migración por usuario SOLO de lo verificable: una clave heredada `<base>_<uid>` o un elemento con `uid` propio de la lista global pasa a la clave nueva únicamente para el uid de la sesión actual.
       Los datos de claves globales sin dueño (mensajes sin uid, elementos de otro uid) NO se atribuyen al usuario actual: quedan donde están y se informan.
     · «Equipo compartido» (activado por defecto): al cerrar sesión con pendientes: sincronizar, SELLAR con la contraseña (protección real) o descartar con confirmación. Nunca queda texto plano
       legible en un equipo compartido: el cierre automático sella con la clave de la sesión o, si no la tiene, BLOQUEA la sesión (pide la contraseña) hasta poder sincronizar.
     · Aviso a los 30 días SIN borrado automático; descarte explícito con confirmación y alcance limitado al usuario de la sesión.
   Este archivo contiene la lógica con almacenamiento inyectable (Node + navegador) y la interfaz mínima (panel, diálogo de cierre y avisos). */
(function (raiz, fabrica) {
  'use strict';
  var api = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    raiz.cardiolinkSeguridadLocalPuroV1 = api;
    try { raiz.cardiolinkSeguridadLocalV1 = api.conectarNavegador(raiz); } catch (e) { if (raiz.console) raiz.console.warn('Seguridad local V1 no disponible:', e); }
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var VERSION = 'sl-1', DIAS_AVISO = 30, MS_DIA = 86400000;
  var PREF_COLA = 'cardiolink_outbox_r2d_v1:', PREF_APARTADO = 'cardiolink_apartado_', PREF_CIERRE = 'cardiolink_cierre_estado_v1:', K_COMPARTIDO = 'cardiolink_equipo_compartido_v1';
  var CATEGORIAS = [
    { id: 'rechazos', base: 'cardiolink_atenciones_rechazos_v1', forma: 'lista_global', fecha: 'ts', etiqueta: 'Valores rechazados por el servidor' },
    { id: 'eliminadas', base: 'cardiolink_atenciones_eliminadas_remotas_v1', forma: 'lista_global', fecha: 'ts', etiqueta: 'Copias de atenciones eliminadas en otra sesión' },
    { id: 'mensajes', base: 'cardiolink_mensajes_no_enviados_v1', forma: 'lista_sin_dueno', fecha: 'fecha', etiqueta: 'Mensajes no enviados' },
    { id: 'cfg_pendiente', base: 'cardiolink_config_pendiente_v1', forma: 'objeto_uid', fecha: 'fecha', etiqueta: 'Configuración de Secretaría sin confirmar' },
    { id: 'cfg_conflicto', base: 'cardiolink_config_conflicto_v1', forma: 'objeto_uid', fecha: 'fecha', etiqueta: 'Configuración de Secretaría en conflicto' },
    { id: 'docs', base: 'cardiolink_docs_pendientes_v1', forma: 'objeto_uid', fecha: 'fecha', etiqueta: 'Documentos clínicos sin respaldo confirmado' },
    { id: 'nuevas', base: 'cardiolink_nuevas_pendientes_v1', forma: 'objeto_uid', fecha: 'fecha', etiqueta: 'Atenciones nuevas sin confirmar (respaldo)' }
  ];

  function estable(v) {
    if (v === null || typeof v !== 'object') { var s = JSON.stringify(v); return s === undefined ? 'null' : s; }
    if (Array.isArray(v)) return '[' + v.map(estable).join(',') + ']';
    return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + estable(v[k]); }).join(',') + '}';
  }
  function esc(v) { return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function parsear(txt) { if (txt == null) return null; try { return JSON.parse(txt); } catch (e) { return undefined; } }   // undefined = ilegible (no se toca)
  function masAntigua(fechas, ahora) {
    var min = null; fechas.forEach(function (f) { var t = Date.parse(f || ''); if (!isNaN(t) && (min === null || t < min)) min = t; });
    return min === null ? null : { fecha: new Date(min).toISOString(), dias: Math.floor((ahora - min) / MS_DIA) };
  }

  // env: { almacen:{getItem,setItem,removeItem,key,length}, proyecto():string, uid():string, ahora():ms }
  function crear(env) {
    var A = env.almacen;
    function ahora() { return env.ahora ? env.ahora() : Date.now(); }
    function proyecto() { try { return String(env.proyecto() || 'sin-proyecto'); } catch (e) { return 'sin-proyecto'; } }
    function get(k) { try { return A.getItem(k); } catch (e) { return null; } }
    function set(k, v) { try { A.setItem(k, v); return A.getItem(k) === v; } catch (e) { return false; } }
    function del(k) { try { A.removeItem(k); } catch (e) { /* sin almacenamiento */ } }
    function todasLasClaves() { var o = []; try { for (var i = 0; i < A.length; i++) { var k = A.key(i); if (k != null) o.push(k); } } catch (e) { /* */ } return o; }
    function clave(base, uid) { return base + ':' + proyecto() + ':' + String(uid || ''); }
    function viejaClave(base, uid) { return base + '_' + String(uid || ''); }
    function categoria(id) { for (var i = 0; i < CATEGORIAS.length; i++) if (CATEGORIAS[i].id === id) return CATEGORIAS[i]; return null; }

    // ---------- equipo compartido ----------
    function equipoCompartido() { return get(K_COMPARTIDO) !== '0'; }          // por defecto (equipo nuevo o sin ajuste) está ACTIVADO
    function fijarEquipoCompartido(si) { return set(K_COMPARTIDO, si ? '1' : '0'); }

    // ---------- migración por usuario (sólo lo verificable) ----------
    function migrarUsuario(uid) {
      var inf = { migradas: [], duplicadas: [], conservadas: [], ilegibles: [], sinDueno: contarSinDueno(uid) };
      if (!uid) return inf;
      CATEGORIAS.forEach(function (c) {
        if (c.forma === 'objeto_uid') {
          var viejo = viejaClave(c.base, uid), nuevo = clave(c.base, uid), v = get(viejo);
          if (v === null) return;
          var n = get(nuevo);
          if (n === null) { if (set(nuevo, v)) { del(viejo); inf.migradas.push(c.id); } else inf.conservadas.push(c.id); }   // si no se pudo escribir, el original NO se toca
          else if (n === v) { del(viejo); inf.duplicadas.push(c.id); }
          else inf.conservadas.push(c.id);                                                                                // dos versiones distintas: no se pisa ni se mezcla
        } else if (c.forma === 'lista_global') {
          var crudo = get(c.base); if (crudo === null) return;
          var lista = parsear(crudo); if (!Array.isArray(lista)) { inf.ilegibles.push(c.id); return; }
          var mios = [], resto = [];
          lista.forEach(function (it) { if (it && it.uid != null && String(it.uid) === String(uid)) mios.push(it); else resto.push(it); });
          if (!mios.length) return;
          var kn = clave(c.base, uid), crudoN = get(kn), prev = crudoN === null ? [] : parsear(crudoN);
          if (!Array.isArray(prev)) { inf.ilegibles.push(c.id); return; }                                                 // clave nueva dañada: no se pisa
          var vistos = {}; prev.forEach(function (x) { vistos[estable(x)] = 1; });
          var salida = prev.slice(); mios.forEach(function (x) { var s = estable(x); if (!vistos[s]) { vistos[s] = 1; salida.push(x); } });
          if (set(kn, JSON.stringify(salida))) { if (resto.length) set(c.base, JSON.stringify(resto)); else del(c.base); inf.migradas.push(c.id); }
          else inf.conservadas.push(c.id);
        }
      });
      return inf;
    }
    // Datos que NO se pueden atribuir al usuario actual: mensajes de la clave global (sin uid) y elementos globales sin uid o de OTRO uid.
    function contarSinDueno(uid) {
      var sin = 0, deOtros = 0, m = parsear(get('cardiolink_mensajes_no_enviados_v1'));
      if (Array.isArray(m)) sin += m.length;
      ['cardiolink_atenciones_rechazos_v1', 'cardiolink_atenciones_eliminadas_remotas_v1'].forEach(function (b) {
        var l = parsear(get(b)); if (!Array.isArray(l)) return;
        l.forEach(function (it) { if (!it || it.uid == null || it.uid === '') sin++; else if (!uid || String(it.uid) !== String(uid)) deOtros++; });
      });
      return { sinDueno: sin, deOtrosUsuarios: deOtros };
    }

    // ---------- inventario, antigüedad y descarte (alcance: el uid indicado) ----------
    function contenido(c, crudo) {
      var v = parsear(crudo); if (v === undefined) return { n: 1, fechas: [], ilegible: true };
      if (Array.isArray(v)) return { n: v.length, fechas: v.map(function (x) { return x && x[c.fecha]; }) };
      if (v && typeof v === 'object') { var n = Array.isArray(v.docs) ? v.docs.length : Array.isArray(v.rows) ? v.rows.length : 1; return { n: n, fechas: [v[c.fecha]] }; }
      return { n: 1, fechas: [] };
    }
    function inventario(uid) {
      var out = [], t = ahora(), p = proyecto();
      CATEGORIAS.forEach(function (c) {
        var claves = [clave(c.base, uid)]; if (c.forma === 'objeto_uid') claves.push(viejaClave(c.base, uid));
        var n = 0, fechas = [], ilegible = false;
        claves.forEach(function (k) { var crudo = get(k); if (crudo === null) return; var r = contenido(c, crudo); n += r.n; fechas = fechas.concat(r.fechas); if (r.ilegible) ilegible = true; });
        if (c.forma === 'lista_global') { var l = parsear(get(c.base)); if (Array.isArray(l)) l.forEach(function (it) { if (it && it.uid != null && String(it.uid) === String(uid)) { n++; fechas.push(it[c.fecha]); } }); }
        if (n) { var a = masAntigua(fechas, t); out.push({ id: c.id, etiqueta: c.etiqueta, n: n, masAntigua: a && a.fecha, dias: a ? a.dias : null, ilegible: ilegible, descartable: true }); }
      });
      var cola = parsear(get(PREF_COLA + p + ':' + uid));
      if (cola && cola.ops) { var ops = Object.keys(cola.ops); if (ops.length) { var a2 = masAntigua(ops.map(function (k) { return cola.ops[k] && cola.ops[k].ts; }), t); out.push({ id: 'cola', etiqueta: 'Cambios sin sincronizar (cola de recuperación)', n: ops.length, masAntigua: a2 && a2.fecha, dias: a2 ? a2.dias : null, descartable: false }); } }
      var ap = todasLasClaves().filter(function (k) { return k.indexOf(PREF_APARTADO + uid + '__') === 0; });
      if (ap.length) out.push({ id: 'apartado', etiqueta: 'Copias locales apartadas de una sesión anterior', n: ap.length, masAntigua: null, dias: null, descartable: true });
      return out;
    }
    function avisos(uid, dias) { var d = dias == null ? DIAS_AVISO : dias; return inventario(uid).filter(function (i) { return i.dias != null && i.dias >= d; }); }
    // Descarte EXPLÍCITO (la confirmación la pide la interfaz). Sólo toca lo del uid indicado; la cola activa de R2D se descarta por operación en su propio panel.
    function descartar(uid, ids) {
      var res = {}, lista = ids && ids.length ? ids : null;
      function quiere(id) { return !lista || lista.indexOf(id) >= 0; }
      CATEGORIAS.forEach(function (c) {
        if (!quiere(c.id)) return; var q = 0;
        [clave(c.base, uid)].concat(c.forma === 'objeto_uid' ? [viejaClave(c.base, uid)] : []).forEach(function (k) { var crudo = get(k); if (crudo !== null) { q += contenido(c, crudo).n; del(k); } });
        if (c.forma === 'lista_global') {
          var l = parsear(get(c.base));
          if (Array.isArray(l)) { var resto = l.filter(function (it) { return !(it && it.uid != null && String(it.uid) === String(uid)); }); q += l.length - resto.length; if (resto.length !== l.length) { if (resto.length) set(c.base, JSON.stringify(resto)); else del(c.base); } }
        }
        if (q) res[c.id] = q;
      });
      if (quiere('apartado')) { var q2 = 0; todasLasClaves().forEach(function (k) { if (k.indexOf(PREF_APARTADO + uid + '__') === 0) { del(k); q2++; } }); if (q2) res.apartado = q2; }
      return res;
    }
    // Sólo lo que NO tiene dueño verificable (mensajes de la clave global, elementos globales sin uid). Nunca toca elementos con uid de otro usuario.
    function descartarSinDueno() {
      var q = 0, m = parsear(get('cardiolink_mensajes_no_enviados_v1')); if (Array.isArray(m)) { q += m.length; del('cardiolink_mensajes_no_enviados_v1'); }
      ['cardiolink_atenciones_rechazos_v1', 'cardiolink_atenciones_eliminadas_remotas_v1'].forEach(function (b) {
        var l = parsear(get(b)); if (!Array.isArray(l)) return;
        var resto = l.filter(function (it) { return it && it.uid != null && it.uid !== ''; }); q += l.length - resto.length;
        if (resto.length !== l.length) { if (resto.length) set(b, JSON.stringify(resto)); else del(b); }
      });
      return q;
    }

    // ---------- estado de cierre de sesión (para declarar la verdad en la pantalla de ingreso) ----------
    function claveCierre(uid) { return PREF_CIERRE + proyecto() + ':' + uid; }
    function registrarCierre(uid, est) { if (!uid) return false; return set(claveCierre(uid), JSON.stringify({ ts: new Date(ahora()).toISOString(), pendientes: est && est.pendientes || 0, protegido: !!(est && est.protegido), sellado: !!(est && est.sellado), auto: !!(est && est.auto) })); }
    function leerCierre(uid) { var v = parsear(get(claveCierre(uid))); return v && typeof v === 'object' ? v : null; }
    function limpiarCierre(uid) { del(claveCierre(uid)); }
    function cierresConPendientes(exceptoUid) {
      var pref = PREF_CIERRE + proyecto() + ':', o = [];
      todasLasClaves().forEach(function (k) { if (k.indexOf(pref) !== 0) return; var uid = k.slice(pref.length), v = parsear(get(k)); if (uid === String(exceptoUid || '') || !v || !(v.pendientes > 0)) return; o.push({ uid: uid, pendientes: v.pendientes, ts: v.ts, auto: !!v.auto, protegido: !!v.protegido, sellado: !!v.sellado }); });
      return o;
    }
    // Copias completas apartadas de OTROS usuarios cuyo último cierre confirmó 0 pendientes: ya no hacen falta y dejan datos de otra persona en reposo.
    function purgarApartadosSinPendientes(uidActual) {
      var q = 0;
      todasLasClaves().forEach(function (k) {
        if (k.indexOf(PREF_APARTADO) !== 0) return; var resto = k.slice(PREF_APARTADO.length), i = resto.indexOf('__'); if (i < 0) return;
        var dueno = resto.slice(0, i); if (dueno === String(uidActual || '')) return;
        var c = leerCierre(dueno); if (c && c.pendientes === 0) { del(k); q++; }
      });
      return q;
    }
    // Al cerrar sesión sin pendientes (modo compartido): los rechazos ya vistos por el usuario no hace falta conservarlos.
    function purgarSincronizadas(uid) {
      var k = clave('cardiolink_atenciones_rechazos_v1', uid), l = parsear(get(k)), q = 0;
      if (Array.isArray(l)) { var resto = l.filter(function (r) { return !(r && r.visto === true); }); q = l.length - resto.length; if (q) { if (resto.length) set(k, JSON.stringify(resto)); else del(k); } }
      return { rechazosVistos: q, apartados: purgarApartadosSinPendientes(uid) };
    }
    // Descarte total del usuario al cerrar sesión por decisión explícita (la caché completa y la cola se pasan desde la app).
    function descartarTodoUsuario(uid, clavesExtra) {
      var r = descartar(uid, null); (clavesExtra || []).forEach(function (k) { del(k); });
      var kc = PREF_COLA + proyecto() + ':' + uid; var cola = parsear(get(kc)); r.cola = cola && cola.ops ? Object.keys(cola.ops).length : 0; del(kc); del(kc + ':danada'); limpiarCierre(uid);
      return r;
    }


    // ---------- sellado con contraseña (AES-GCM; clave derivada con PBKDF2; nada de esto se guarda) ----------
    var C = env.crypto || null, enc = env.TextEncoder ? new env.TextEncoder() : null, dec = env.TextDecoder ? new env.TextDecoder() : null, material = null;
    var ITER = env.iteraciones || 600000, PREF_SELLO = 'cardiolink_sellado_v1:';
    function webcryptoDisponible() { return !!(C && C.subtle && C.getRandomValues && enc && dec && env.sellos && env.btoa && env.atob); }
    function b64(buf) { var u = new Uint8Array(buf), s = '', n = 0x8000; for (var i = 0; i < u.length; i += n) s += String.fromCharCode.apply(null, u.subarray(i, i + n)); return env.btoa(s); }
    function deb64(t) { var s = env.atob(t), u = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
    function importarMaterial(pw) { return C.subtle.importKey('raw', enc.encode(String(pw)), 'PBKDF2', false, ['deriveKey']); }      // no extraíble
    function derivar(mat, sal, it) { return C.subtle.deriveKey({ name: 'PBKDF2', salt: sal, iterations: it, hash: 'SHA-256' }, mat, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); }
    function aadDe(uid) { return enc.encode('cardiolink-sellado-v1|' + proyecto() + '|' + uid); }
    function cifrar(mat, texto, uid) {
      var sal = C.getRandomValues(new Uint8Array(16)), iv = C.getRandomValues(new Uint8Array(12));
      return derivar(mat, sal, ITER).then(function (k) { return C.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: aadDe(uid) }, k, enc.encode(texto)); })
        .then(function (ct) { return { v: 1, kdf: 'PBKDF2-SHA256', it: ITER, salt: b64(sal), iv: b64(iv), ct: b64(ct) }; });
    }
    function descifrar(mat, sobre, uid) {
      if (!sobre || sobre.v !== 1 || sobre.kdf !== 'PBKDF2-SHA256') return Promise.reject(new Error('formato'));
      return derivar(mat, deb64(sobre.salt), sobre.it).then(function (k) { return C.subtle.decrypt({ name: 'AES-GCM', iv: deb64(sobre.iv), additionalData: aadDe(uid) }, k, deb64(sobre.ct)); }).then(function (b) { return dec.decode(b); });
    }
    function prefijoSello(uid) { return PREF_SELLO + proyecto() + ':' + uid + ':'; }
    function recordarPassword(pw) { if (!webcryptoDisponible() || !pw) return Promise.resolve(false); return importarMaterial(pw).then(function (m) { material = m; if (env.alValidar) env.alValidar(); return true; }, function () { return false; }); }
    function hayMaterial() { return !!material; }
    function olvidarMaterial() { material = null; }
    function clavesSensibles(uid, extra) {
      var o = [];
      CATEGORIAS.forEach(function (c) { o.push(clave(c.base, uid)); if (c.forma === 'objeto_uid') o.push(viejaClave(c.base, uid)); });
      var kc = PREF_COLA + proyecto() + ':' + uid; o.push(kc); o.push(kc + ':danada');
      (extra || []).forEach(function (k) { if (o.indexOf(k) < 0) o.push(k); });
      return o;
    }
    // Sella todo lo sensible del usuario. El texto plano se borra SÓLO tras verificar que el paquete se descifra y coincide.
    function sellarUsuario(uid, mat, extra, meta) {
      if (!webcryptoDisponible()) return Promise.resolve({ ok: false, error: 'sin_webcrypto' });
      if (!mat) return Promise.resolve({ ok: false, error: 'sin_clave' });
      var ks = clavesSensibles(uid, extra), mapa = {}, n = 0;
      ks.forEach(function (k) { var v = get(k); if (v !== null) { mapa[k] = v; n++; } });
      if (!n) return Promise.resolve({ ok: true, n: 0 });
      var texto = JSON.stringify({ v: 1, ts: new Date(ahora()).toISOString(), claves: mapa, meta: { noProt: (meta && meta.noProt || []).slice(0, 50) } }), id = prefijoSello(uid) + new Date(ahora()).toISOString();
      return cifrar(mat, texto, uid).then(function (sobre) {
        return env.sellos.put(id, JSON.stringify(sobre)).then(function (ok) {
          if (!ok) return { ok: false, error: 'almacenamiento' };
          return env.sellos.get(id).then(function (raw) { return descifrar(mat, JSON.parse(raw), uid); }).then(function (vuelta) {
            if (vuelta !== texto) return env.sellos.del(id).then(function () { return { ok: false, error: 'verificacion' }; });
            Object.keys(mapa).forEach(del);                                  // recién ahora se retira el texto plano
            return { ok: true, n: n, id: id };
          });
        });
      }).catch(function (e) { return { ok: false, error: String(e && (e.message || e.name) || e) }; });
    }
    // Sólo se restauran las claves de PENDIENTES (cola R2D y respaldos por usuario). Las cachés completas (configuración, atenciones, valores, marca de sincronización, dueño de la caché) se recargan del
    // servidor al ingresar y la app ya creó las suyas: restaurarlas pisaría o chocaría con lo recién cargado, y sus pendientes viajan en la cola. Se sellan para no dejar texto plano.
    function esClavePendiente(k) {
      if (k.indexOf(PREF_COLA) === 0) return true;
      for (var i = 0; i < CATEGORIAS.length; i++) if (k.indexOf(CATEGORIAS[i].base) === 0) return true;
      return false;
    }
    // Una clave existente SIN contenido útil (cola sin operaciones, respaldo sin documentos/filas, lista vacía) no es un conflicto: no hay nada que perder al restaurar sobre ella.
    function sinContenido(txt) {
      var v = parsear(txt); if (v === undefined || v === null) return false;
      if (Array.isArray(v)) return v.length === 0;
      if (v && typeof v === 'object') {
        if (v.ops && typeof v.ops === 'object') return Object.keys(v.ops).length === 0;
        if (Array.isArray(v.docs)) return v.docs.length === 0;
        if (Array.isArray(v.rows)) return v.rows.length === 0;
      }
      return false;
    }
    var K_DUENO = 'cardiolink_cache_owner_v1';
    // ¿La cola sellada dice que hay cambios de configuración que NO viajan en ella (claves clínicas, imágenes)? Entonces la caché de configuración es la ÚNICA copia: se restaura (no se descarta).
    function colaConCambiosNoProtegidos(claves) {
      var out = [];
      Object.keys(claves || {}).forEach(function (k) {
        if (k.indexOf(PREF_COLA) !== 0 || /:danada$/.test(k)) return; var q = parsear(claves[k]); if (!q || !q.ops) return;
        Object.keys(q.ops).forEach(function (o) { var op = q.ops[o]; if (op && op.k === 'config' && op.noProt && op.noProt.length) out = out.concat(op.noProt); });
      });
      return out;
    }
    // Diagnóstico para el diálogo de cierre: cambios de configuración que sólo existen en la caché (no en la cola).
    function noProtegidosEnCola(uid) { var v = get(PREF_COLA + proyecto() + ':' + uid), m = {}; if (v !== null) m[PREF_COLA + proyecto() + ':' + uid] = v; return colaConCambiosNoProtegidos(m); }
    // RECUPERACIÓN CLÍNICA. Restaurar la caché completa NO recupera nada: al cargar, la app vuelve a poner lo del servidor en las claves clínicas (no se diferencian como cambios locales). Por eso la parte
    // clínica de la caché sellada se compara con lo cargado del servidor y se OFRECE al usuario (aplicar / descartar / después). Nada se aplica ni se pierde solo: el paquete se conserva hasta que decida.
    var CLINICAS = ['resumenesClinicos', 'documentosClinicos', 'evolucionesClinicas'];
    function tiempo(v) { var t = Date.parse(v || ''); return isNaN(t) ? 0 : t; }
    // Puro: qué de lo sellado (config) no está en lo vivo. Resúmenes por paciente: agregar si falta, actualizar sólo si lo sellado es MÁS reciente. Documentos y evoluciones por id: sólo los que faltan.
    function planRecuperacionClinica(sellada, viva) {
      var ops = [], omitidos = 0; sellada = sellada || {}; viva = viva || {};
      var rs = sellada.resumenesClinicos, rv = viva.resumenesClinicos || {};
      if (rs && typeof rs === 'object') Object.keys(rs).forEach(function (k) {
        var a = rs[k], b = rv[k]; if (!a || estable(a) === estable(b)) return;
        if (!b) ops.push({ tipo: 'resumen', accion: 'agregar', clave: k, valor: a });
        else if (tiempo(a.actualizadoEn) > tiempo(b.actualizadoEn)) ops.push({ tipo: 'resumen', accion: 'actualizar', clave: k, valor: a });
        else omitidos++;                                                                                          // el servidor tiene algo igual o más reciente: no se pisa
      });
      [['documentosClinicos', 'documento'], ['evolucionesClinicas', 'evolucion']].forEach(function (par) {
        var ls = sellada[par[0]], lv = viva[par[0]]; if (!Array.isArray(ls)) return; var ids = {}; (Array.isArray(lv) ? lv : []).forEach(function (x) { if (x && x.id != null) ids[String(x.id)] = 1; });
        ls.forEach(function (x) { if (x && x.id != null && !ids[String(x.id)]) ops.push({ tipo: par[1], accion: 'agregar', clave: String(x.id), valor: x }); });
      });
      return { ops: ops, omitidos: omitidos };
    }
    function aplicarRecuperacionClinica(viva, ops) {
      ops.forEach(function (o) {
        if (o.tipo === 'resumen') { if (!viva.resumenesClinicos || typeof viva.resumenesClinicos !== 'object') viva.resumenesClinicos = {}; viva.resumenesClinicos[o.clave] = o.valor; }
        else { var k = o.tipo === 'documento' ? 'documentosClinicos' : 'evolucionesClinicas'; if (!Array.isArray(viva[k])) viva[k] = []; if (!viva[k].some(function (x) { return x && String(x.id) === o.clave; })) viva[k].push(o.valor); }
      });
      return viva;
    }
    function liberarPaquete(id) { return env.sellos ? env.sellos.del(id) : Promise.resolve(false); }
    // Abre los paquetes sellados del usuario con la clave de ESTA sesión. Restaura las claves de pendientes ausentes (o sin contenido) y, SÓLO si la cola declara cambios no protegidos, también las cachés:
    // sin dueño de caché vigente → directo (y el usuario pasa a ser dueño); con otro dueño → como caché apartada de este uid (la app la restaura al aislar); con caché viva del mismo uid → no se pisa
    // y el paquete se CONSERVA. Un paquete que no se abre (otra contraseña) queda intacto.
    function abrirSellados(uid, mat) {
      var res = { restauradas: 0, paquetes: 0, noAbiertos: 0, conflictos: 0, omitidas: 0, cachesRestauradas: 0, recuperaciones: [] };
      if (!webcryptoDisponible() || !mat) return Promise.resolve(res);
      return env.sellos.keys(prefijoSello(uid)).then(function (ids) {
        ids = ids.slice().sort().reverse();
        return ids.reduce(function (p, id) {
          return p.then(function () {
            return env.sellos.get(id).then(function (raw) { return descifrar(mat, JSON.parse(raw), uid); }).then(function (texto) {
              var obj = JSON.parse(texto), ok = true, recuperacion = null, conCache = (obj.meta && obj.meta.noProt && obj.meta.noProt.length > 0) || colaConCambiosNoProtegidos(obj.claves).length > 0;
              Object.keys(obj.claves || {}).forEach(function (k) {
                if (!esClavePendiente(k)) {
                  if (conCache && env.claveConfig && k === env.claveConfig() && !recuperacion) recuperacion = obj.claves[k];   // sólo su parte clínica, y de forma explícita
                  else res.omitidas++;                                                                         // las demás cachés se recargan del servidor
                  return;
                }
                var actual = get(k); if (actual === null || (actual !== obj.claves[k] && sinContenido(actual))) { if (set(k, obj.claves[k])) res.restauradas++; else ok = false; } else if (actual !== obj.claves[k]) { res.conflictos++; ok = false; } });
              if (recuperacion) { res.recuperaciones.push({ id: id, config: recuperacion, noProt: (obj.meta && obj.meta.noProt) || [] }); return; }   // el paquete se conserva hasta que el usuario decida
              if (ok) { res.paquetes++; return env.sellos.del(id); }
            }, function () { res.noAbiertos++; });
          });
        }, Promise.resolve());
      }).then(function () { return res; }, function () { return res; });
    }
    // Retira del almacenamiento en claro todo lo sensible del usuario (después de sellar o descartar: evita que una escritura tardía lo recree).
    function purgarClaves(uid, extra) { clavesSensibles(uid, extra).forEach(del); }
    // Datos heredados sin dueño verificable: se pueden poner en CUSTODIA cifrada con la contraseña del usuario que lo decide (no se le atribuye el contenido; sólo la custodia) o descartar. Sin
    // decisión quedan en claro (se declara). La custodia usa otro prefijo: nunca se restaura sola al ingresar.
    var PREF_LEGADO = PREF_SELLO + 'legado:';
    function recolectarSinDueno() {
      var o = { mensajes: null, rechazos: null, eliminadas: null, n: 0 };
      var m = parsear(get('cardiolink_mensajes_no_enviados_v1')); if (Array.isArray(m) && m.length) { o.mensajes = m; o.n += m.length; }
      [['rechazos', 'cardiolink_atenciones_rechazos_v1'], ['eliminadas', 'cardiolink_atenciones_eliminadas_remotas_v1']].forEach(function (par) {
        var l = parsear(get(par[1])); if (!Array.isArray(l)) return; var sin = l.filter(function (it) { return !it || it.uid == null || it.uid === ''; }); if (sin.length) { o[par[0]] = sin; o.n += sin.length; }
      });
      return o;
    }
    function sellarSinDueno(mat) {
      if (!webcryptoDisponible()) return Promise.resolve({ ok: false, error: 'sin_webcrypto' }); if (!mat) return Promise.resolve({ ok: false, error: 'sin_clave' });
      var c = recolectarSinDueno(); if (!c.n) return Promise.resolve({ ok: true, n: 0 });
      var texto = JSON.stringify({ v: 1, tipo: 'legado_sin_dueno', ts: new Date(ahora()).toISOString(), mensajes: c.mensajes, rechazos: c.rechazos, eliminadas: c.eliminadas }), id = PREF_LEGADO + new Date(ahora()).toISOString();
      return cifrar(mat, texto, 'legado').then(function (sobre) {
        return env.sellos.put(id, JSON.stringify(sobre)).then(function (ok) {
          if (!ok) return { ok: false, error: 'almacenamiento' };
          return env.sellos.get(id).then(function (raw) { return descifrar(mat, JSON.parse(raw), 'legado'); }).then(function (vuelta) {
            if (vuelta !== texto) return env.sellos.del(id).then(function () { return { ok: false, error: 'verificacion' }; });
            if (c.mensajes) del('cardiolink_mensajes_no_enviados_v1');                                // recién ahora se retira lo que no tenía dueño
            [['rechazos', 'cardiolink_atenciones_rechazos_v1'], ['eliminadas', 'cardiolink_atenciones_eliminadas_remotas_v1']].forEach(function (par) {
              if (!c[par[0]]) return; var l = parsear(get(par[1])); if (!Array.isArray(l)) return; var resto = l.filter(function (it) { return it && it.uid != null && it.uid !== ''; }); if (resto.length) set(par[1], JSON.stringify(resto)); else del(par[1]);
            });
            return { ok: true, n: c.n, id: id };
          });
        });
      }).catch(function (e) { return { ok: false, error: String(e && (e.message || e.name) || e) }; });
    }
    // Datos heredados que pertenecen a OTROS usuarios (clave heredada `<base>_<uid>`, elementos con `uid` ajeno de las listas globales, copias apartadas de otro uid o de dueño desconocido). No se
    // pueden cifrar con la contraseña de su dueño: un owner/admin puede ponerlos en CUSTODIA cifrada con la SUYA para que no queden legibles. No se descartan (alcance de descarte = el propio usuario): el
    // custodio los puede ver o DEVOLVER (vuelven a su clave heredada, en claro, y su dueño los migra al ingresar).
    function recolectarAjenos(uidActual) {
      var o = { claves: {}, listas: {}, n: 0 }, me = String(uidActual || '');
      todasLasClaves().forEach(function (k) {
        CATEGORIAS.forEach(function (c) { if (c.forma !== 'objeto_uid' || k.indexOf(c.base + '_') !== 0) return; var uid = k.slice(c.base.length + 1); if (uid && uid !== me && k.indexOf(':') < 0) { var v = get(k); if (v !== null) { o.claves[k] = v; o.n++; } } });
        if (k.indexOf(PREF_APARTADO) === 0) { var resto = k.slice(PREF_APARTADO.length), i = resto.indexOf('__'); if (i > 0 && resto.slice(0, i) !== me) { var v2 = get(k); if (v2 !== null) { o.claves[k] = v2; o.n++; } } }
      });
      ['cardiolink_atenciones_rechazos_v1', 'cardiolink_atenciones_eliminadas_remotas_v1'].forEach(function (b) {
        var l = parsear(get(b)); if (!Array.isArray(l)) return; var aj = l.filter(function (it) { return it && it.uid != null && it.uid !== '' && String(it.uid) !== me; }); if (aj.length) { o.listas[b] = aj; o.n += aj.length; }
      });
      return o;
    }
    function sellarAjenos(uidActual, mat) {
      if (!webcryptoDisponible()) return Promise.resolve({ ok: false, error: 'sin_webcrypto' }); if (!mat) return Promise.resolve({ ok: false, error: 'sin_clave' });
      var c = recolectarAjenos(uidActual); if (!c.n) return Promise.resolve({ ok: true, n: 0 });
      var texto = JSON.stringify({ v: 1, tipo: 'legado_ajeno', ts: new Date(ahora()).toISOString(), claves: c.claves, listas: c.listas }), id = PREF_LEGADO + 'ajeno:' + new Date(ahora()).toISOString();
      return cifrar(mat, texto, 'legado').then(function (sobre) {
        return env.sellos.put(id, JSON.stringify(sobre)).then(function (ok) {
          if (!ok) return { ok: false, error: 'almacenamiento' };
          return env.sellos.get(id).then(function (raw) { return descifrar(mat, JSON.parse(raw), 'legado'); }).then(function (vuelta) {
            if (vuelta !== texto) return env.sellos.del(id).then(function () { return { ok: false, error: 'verificacion' }; });
            Object.keys(c.claves).forEach(del);
            Object.keys(c.listas).forEach(function (b) { var l = parsear(get(b)); if (!Array.isArray(l)) return; var resto = l.filter(function (it) { return !(it && it.uid != null && it.uid !== '' && String(it.uid) !== String(uidActual || '')); }); if (resto.length) set(b, JSON.stringify(resto)); else del(b); });
            return { ok: true, n: c.n, id: id };
          });
        });
      }).catch(function (e) { return { ok: false, error: String(e && (e.message || e.name) || e) }; });
    }
    // Devuelve lo custodiado a su lugar heredado (en claro) sólo donde no hay nada distinto; el paquete se retira recién tras devolverlo todo.
    function devolverAjenos(mat) {
      return leerCustodia(mat).then(function (pk) {
        var res = { devueltas: 0, conflictos: 0 };
        return pk.filter(function (x) { return x.datos && x.datos.tipo === 'legado_ajeno'; }).reduce(function (p, x) {
          return p.then(function () {
            var ok = true;
            Object.keys(x.datos.claves || {}).forEach(function (k) { var a = get(k); if (a === null || a === x.datos.claves[k]) { if (a === null && !set(k, x.datos.claves[k])) ok = false; else res.devueltas++; } else { res.conflictos++; ok = false; } });
            Object.keys(x.datos.listas || {}).forEach(function (b) { var l = parsear(get(b)); l = Array.isArray(l) ? l : []; var vistos = {}; l.forEach(function (it) { vistos[estable(it)] = 1; }); var sal = l.slice(); x.datos.listas[b].forEach(function (it) { if (!vistos[estable(it)]) sal.push(it); }); if (!set(b, JSON.stringify(sal))) ok = false; else res.devueltas += x.datos.listas[b].length; });
            if (ok) return env.sellos.del(x.id);
          });
        }, Promise.resolve()).then(function () { return res; });
      });
    }
    // Paquetes en custodia que ESTA clave puede abrir (los de otra contraseña se ignoran: son opacos).
    function leerCustodia(mat) {
      if (!webcryptoDisponible() || !mat) return Promise.resolve([]);
      return env.sellos.keys(PREF_LEGADO).then(function (ids) {
        return ids.reduce(function (p, id) { return p.then(function (acc) { return env.sellos.get(id).then(function (raw) { return descifrar(mat, JSON.parse(raw), 'legado'); }).then(function (t) { acc.push({ id: id, datos: JSON.parse(t) }); return acc; }, function () { return acc; }); }); }, Promise.resolve([]));
      }, function () { return []; });
    }
    function descartarCustodia(mat) { return leerCustodia(mat).then(function (l) { var sd = l.filter(function (x) { return !(x.datos && x.datos.tipo === 'legado_ajeno'); }); return Promise.all(sd.map(function (x) { return env.sellos.del(x.id); })).then(function () { return sd.length; }); }); }   // lo de otros usuarios NO se descarta: se devuelve
    function contarCustodia() { return env.sellos ? env.sellos.keys(PREF_LEGADO).then(function (k) { return k.length; }, function () { return 0; }) : Promise.resolve(0); }
    function contarSellados(uid) { return env.sellos ? env.sellos.keys(prefijoSello(uid)).then(function (k) { return k.length; }, function () { return 0; }) : Promise.resolve(0); }
    function descartarSellados(uid) { if (!env.sellos) return Promise.resolve(0); return env.sellos.keys(prefijoSello(uid)).then(function (ks) { return Promise.all(ks.map(function (k) { return env.sellos.del(k); })).then(function () { return ks.length; }); }, function () { return 0; }); }

    return {
      CLINICAS: CLINICAS, planRecuperacionClinica: planRecuperacionClinica, aplicarRecuperacionClinica: aplicarRecuperacionClinica, liberarPaquete: liberarPaquete,
      recolectarAjenos: recolectarAjenos, sellarAjenos: sellarAjenos, devolverAjenos: devolverAjenos, recolectarSinDueno: recolectarSinDueno, sellarSinDueno: sellarSinDueno, leerCustodia: leerCustodia, descartarCustodia: descartarCustodia, contarCustodia: contarCustodia,
      noProtegidosEnCola: noProtegidosEnCola, purgarClaves: purgarClaves, sellarUsuario: sellarUsuario, abrirSellados: abrirSellados, contarSellados: contarSellados, descartarSellados: descartarSellados, recordarPassword: recordarPassword, hayMaterial: hayMaterial, olvidarMaterial: olvidarMaterial, _materialSesion: function () { return material; },
      esAdminSesion: function () { try { return !!(env.esAdmin && env.esAdmin()); } catch (e) { return false; } }, webcryptoDisponible: webcryptoDisponible, materialDe: function (pw) { return importarMaterial(pw); }, clavesSensibles: clavesSensibles, prefijoSello: prefijoSello,
      VERSION: VERSION, DIAS_AVISO: DIAS_AVISO, CATEGORIAS: CATEGORIAS, clave: clave, viejaClave: viejaClave, proyecto: proyecto, equipoCompartido: equipoCompartido, fijarEquipoCompartido: fijarEquipoCompartido,
      migrarUsuario: migrarUsuario, contarSinDueno: contarSinDueno, inventario: inventario, avisos: avisos, descartar: descartar, descartarSinDueno: descartarSinDueno,
      registrarCierre: registrarCierre, leerCierre: leerCierre, limpiarCierre: limpiarCierre, cierresConPendientes: cierresConPendientes, purgarApartadosSinPendientes: purgarApartadosSinPendientes,
      purgarSincronizadas: purgarSincronizadas, descartarTodoUsuario: descartarTodoUsuario, categoria: categoria
    };
  }

  // Paquetes sellados (ya cifrados): IndexedDB (cuota mucho mayor que localStorage); sin IndexedDB, localStorage con prefijo.
  function almacenSellos(w) {
    if (w.indexedDB) {
      var dbp = null;
      var abrir = function () { if (!dbp) dbp = new Promise(function (res, rej) { var r = w.indexedDB.open('cardiolink_sellado_v1', 1); r.onupgradeneeded = function () { r.result.createObjectStore('s'); }; r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); return dbp; };
      var tx = function (modo, fn) { return abrir().then(function (db) { return new Promise(function (res, rej) { var t = db.transaction('s', modo), rq = fn(t.objectStore('s')); t.oncomplete = function () { res(rq && rq.result); }; t.onerror = t.onabort = function () { rej(t.error); }; }); }); };
      return {
        get: function (k) { return tx('readonly', function (s) { return s.get(k); }).then(function (v) { return v == null ? null : v; }); },
        put: function (k, v) { return tx('readwrite', function (s) { return s.put(v, k); }).then(function () { return true; }, function () { return false; }); },
        del: function (k) { return tx('readwrite', function (s) { return s.delete(k); }).then(function () { return true; }, function () { return false; }); },
        keys: function (pref) { return tx('readonly', function (s) { return s.getAllKeys(); }).then(function (ks) { return ks.filter(function (k) { return String(k).indexOf(pref) === 0; }); }); }
      };
    }
    var L = w.localStorage;
    return {
      get: function (k) { try { return Promise.resolve(L.getItem('sl:' + k)); } catch (e) { return Promise.resolve(null); } },
      put: function (k, v) { try { L.setItem('sl:' + k, v); return Promise.resolve(L.getItem('sl:' + k) === v); } catch (e) { return Promise.resolve(false); } },
      del: function (k) { try { L.removeItem('sl:' + k); } catch (e) { /* */ } return Promise.resolve(true); },
      keys: function (pref) { var o = []; try { for (var i = 0; i < L.length; i++) { var k = L.key(i); if (k && k.indexOf('sl:' + pref) === 0) o.push(k.slice(3)); } } catch (e) { /* */ } return Promise.resolve(o); }
    };
  }

  // ================= navegador: entorno real + interfaz mínima =================
  function conectarNavegador(w) {
    var S = crear({
      esAdmin: function () { try { return typeof backendEsAdminOwner !== 'undefined' && backendEsAdminOwner === true; } catch (e) { return false; } },
      claveConfig: function () { try { return typeof storageConfig !== 'undefined' ? storageConfig : 'cardiolink_config_v25'; } catch (e) { return 'cardiolink_config_v25'; } },
      alValidar: function () { try { w.sessionStorage.setItem('cardiolink_sesion_validada', '1'); } catch (e) { /* */ } },
      crypto: w.crypto, TextEncoder: w.TextEncoder, TextDecoder: w.TextDecoder, btoa: w.btoa && w.btoa.bind(w), atob: w.atob && w.atob.bind(w), sellos: almacenSellos(w),
      almacen: w.localStorage,
      proyecto: function () { try { return new URL(w.SUPABASE_URL || (typeof SUPABASE_URL !== 'undefined' ? SUPABASE_URL : '')).hostname.split('.')[0]; } catch (e) { return 'sin-proyecto'; } },
      uid: function () { try { return String(typeof usuarioSupabase !== 'undefined' && usuarioSupabase && usuarioSupabase.id || ''); } catch (e) { return ''; } }
    });
    var doc = w.document;
    function uidActual() { try { return String(typeof usuarioSupabase !== 'undefined' && usuarioSupabase && usuarioSupabase.id || ''); } catch (e) { return ''; } }
    var ESTILO = 'position:fixed;inset:0;background:rgba(15,23,42,.6);z-index:100000;display:flex;align-items:center;justify-content:center;padding:16px;';
    var CAJA = 'background:#fff;color:#0f172a;border-radius:14px;max-width:560px;width:100%;max-height:88vh;overflow:auto;padding:20px;font:14px/1.45 system-ui,sans-serif;box-shadow:0 20px 60px rgba(0,0,0,.4);';
    var BTN = 'border:0;border-radius:10px;padding:10px 14px;font-weight:700;cursor:pointer;margin:4px 6px 0 0;';
    function modal(html) { var d = doc.createElement('div'); d.setAttribute('data-sl-modal', '1'); d.style.cssText = ESTILO; d.innerHTML = '<div style="' + CAJA + '">' + html + '</div>'; doc.body.appendChild(d); return d; }

    // Diálogo de cierre con cambios sin confirmar (equipo compartido). Devuelve 'reintentar' | 'proteger' | 'descartar' | 'cancelar'. NO existe «conservar en claro»: en un equipo compartido
    // los datos clínicos sin sincronizar no pueden quedar legibles para otra persona. Nunca descarta por sí solo.
    function elegirCierre(info) {
      return new Promise(function (resolve) {
        var n = info.n || 0, sin = info.sinProteger || 0, puede = S.webcryptoDisponible() && !info.sinClave, admin = S.esAdminSesion();
        var m = modal('<h3 style="margin:0 0 8px">Hay cambios sin guardar de la sesión anterior</h3>'
          + '<p>' + (info.sinClave ? 'Esa persona dejó cambios que todavía no se enviaron. Para no perderlos, esperá a que vuelva a ingresar o reintentá guardarlos ahora.' : 'Quedan cambios sin guardar. Reintentá guardarlos ahora.') + '</p>'
          + (sin ? '<p style="color:#b91c1c;font-weight:700">Algunos cambios no se pudieron conservar en este equipo y se perderían si cerrás ahora.</p>' : '')
          + '<button data-r="reintentar" style="' + BTN + 'background:#2563eb;color:#fff">Reintentar guardar</button>'
          + (admin ? '<button data-r="descartar" style="' + BTN + 'background:#b91c1c;color:#fff">Descartar (administración)</button>' : '')
          + '<button data-r="cancelar" style="' + BTN + 'background:#e2e8f0">Volver</button>');
        m.addEventListener('click', function (ev) {
          var b = ev.target && ev.target.closest && ev.target.closest('button[data-r]'); if (!b) return;
          var r = b.getAttribute('data-r');
          if (r === 'descartar' && !w.confirm('Se descartan PARA SIEMPRE los ' + n + ' cambio' + (n === 1 ? '' : 's') + ' sin sincronizar de ESTE usuario en este equipo (y su copia local). No se puede deshacer. ¿Confirmás?')) return;
          m.remove(); resolve(r);
        });
      });
    }
    // Pide la contraseña en un cuadro propio (no queda en ningún almacenamiento). Devuelve la contraseña o null.
    function pedirPassword(texto, error) {
      return new Promise(function (resolve) {
        var m = modal('<h3 style="margin:0 0 8px">Contraseña</h3><p style="margin:0 0 8px">' + esc(texto) + '</p>' + (error ? '<p style="color:#b91c1c;margin:0 0 8px">' + esc(error) + '</p>' : '')
          + '<input id="slPw" type="password" autocomplete="current-password" style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #94a3b8;border-radius:8px;font-size:15px">'
          + '<div style="margin-top:10px"><button data-ok style="' + BTN + 'background:#0f766e;color:#fff">Aceptar</button><button data-no style="' + BTN + 'background:#e2e8f0">Cancelar</button></div>');
        var inp = m.querySelector('#slPw'); w.setTimeout(function () { inp.focus(); }, 50);
        function fin(v) { m.remove(); resolve(v); }
        m.addEventListener('click', function (ev) { var t = ev.target; if (t && t.hasAttribute) { if (t.hasAttribute('data-ok')) fin(inp.value || null); else if (t.hasAttribute('data-no')) fin(null); } });
        inp.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') fin(inp.value || null); });
      });
    }
    // Reautentica al MISMO usuario con la contraseña ingresada (evita sellar con una contraseña mal escrita, que dejaría los datos inaccesibles).
    function verificarPassword(pw, emailForzado) {
      try {
        var email = emailForzado || (typeof usuarioSupabase !== 'undefined' && usuarioSupabase && usuarioSupabase.email);
        if (!email || typeof supabaseClient === 'undefined' || !supabaseClient) return Promise.resolve('red');
        return supabaseClient.auth.signInWithPassword({ email: email, password: pw }).then(function (r) {
          if (!r.error) return 'ok';
          return (r.error.status === 400 || /invalid login/i.test(String(r.error.message || ''))) ? 'mala' : 'red';     // 400 = credenciales; otro error (red, 5xx) = no verificable
        }, function () { return 'red'; });
      } catch (e) { return Promise.resolve('red'); }
    }
    // Cierre manual. Si el ingreso fue con contraseña, la clave de la sesión ya está verificada y se usa directamente (funciona sin conexión). Si la sesión se reanudó sin contraseña, se pide y se
    // VERIFICA reautenticando (3 intentos); sin conexión no se puede verificar y se exige escribirla dos veces iguales (una contraseña mal escrita dejaría el paquete inaccesible).
    // {ok:true} sólo si el paquete quedó verificado y el texto plano se retiró.
    function sellarConPassword(extra, meta) {
      var uid = uidActual();
      if (S.hayMaterial()) return S.sellarUsuario(uid, S._materialSesion(), extra, meta);
      function sellar(pw) { return S.materialDe(pw).then(function (mat) { return S.recordarPassword(pw).then(function () { return S.sellarUsuario(uid, mat, extra, meta); }); }); }
      function intento(k, error) {
        if (k >= 3) return Promise.resolve({ ok: false, error: 'contraseña' });
        return pedirPassword('Ingresá tu contraseña para sellar los cambios sin sincronizar de este equipo. La contraseña no se guarda.', error).then(function (pw) {
          if (pw == null) return { ok: false, error: 'cancelado' };
          return verificarPassword(pw).then(function (v) {
            if (v === 'ok') return sellar(pw);
            if (v === 'mala') return intento(k + 1, 'Contraseña incorrecta.');
            return pedirPassword('Sin conexión: no se puede verificar la contraseña. Escribila de nuevo para confirmar. Si la escribís mal, estos cambios no se podrán abrir (podrás descartarlos).').then(function (pw2) {
              if (pw2 == null) return { ok: false, error: 'cancelado' };
              if (pw2 !== pw) return intento(k + 1, 'No coinciden. Probá de nuevo.');
              return sellar(pw);
            });
          });
        });
      }
      return intento(0, '');
    }
    // Cierre automático: sella con la clave de esta sesión (si el ingreso fue con contraseña). Sin clave devuelve {ok:false,error:'sin_clave'}.
    function sellarConSesion(extra, meta) { return S.hayMaterial() ? S.sellarUsuario(uidActual(), S._materialSesion(), extra, meta) : Promise.resolve({ ok: false, error: 'sin_clave' }); }
    // Sesión bloqueada (autologout sin clave y con pendientes que no se pudieron sincronizar): la pantalla pide la contraseña; mientras tanto la app reintenta sincronizar.
    var bloqueo = null;
    function emailDelToken() { try { for (var i = 0; i < w.localStorage.length; i++) { var k = w.localStorage.key(i); if (/^sb-.*-auth-token$/.test(k)) { var t = JSON.parse(w.localStorage.getItem(k)); var e = t && (t.user && t.user.email || t.currentSession && t.currentSession.user && t.currentSession.user.email); if (e) return e; } } } catch (e) { /* */ } return ''; }
    function hayTokenLocal() { try { for (var i = 0; i < w.localStorage.length; i++) if (/^sb-.*-auth-token$/.test(w.localStorage.key(i))) return true; } catch (e) { /* */ } return false; }
    function marcarSesionValidada() { try { w.sessionStorage.setItem('cardiolink_sesion_validada', '1'); } catch (e) { /* */ } }
    // BLOQUEO DE INTERFAZ (NO es protección criptográfica: los datos siguen en el almacenamiento y quien abra las herramientas del navegador los lee). Impide el uso de la app por la interfaz hasta
    // reingresar la contraseña. Opciones: {titulo, texto, cerrar:true → botón «Cerrar esa sesión» (no sella: no hay contraseña)}.
    function bloquearSesion(alResolver, op) {
      op = op || {};
      if (bloqueo) return; try { w.sessionStorage.setItem('cardiolink_bloqueo_v1', '1'); } catch (e) { /* */ }
      var m = modal('<h3 style="margin:0 0 8px">' + esc(op.titulo || 'Por seguridad, ingresá tu contraseña') + '</h3><p>' + esc(op.texto || 'Pasó un rato sin actividad y quedan cambios sin guardar. Ingresá tu contraseña para seguir. Se siguen guardando solos y, cuando termine, la sesión se cierra sola.') + '</p>'
        + '<input id="slPwB" type="password" autocomplete="current-password" style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #94a3b8;border-radius:8px;font-size:15px"><p id="slPwBE" style="color:#b91c1c;margin:6px 0 0"></p>'
        + ''
        + '<div style="margin-top:10px"><button data-ok style="' + BTN + 'background:#0f766e;color:#fff">Desbloquear</button>' + (op.cerrar ? '<button data-cerrar style="' + BTN + 'background:#e2e8f0">Cerrar esa sesión</button>' : '') + '</div>');
      m.style.zIndex = 100001; m.style.background = 'rgba(15,23,42,.97)'; bloqueo = m;
      var inp = m.querySelector('#slPwB'), er = m.querySelector('#slPwBE');
      function intentar() { var pw = inp.value; if (!pw) return; verificarPassword(pw, emailDelToken()).then(function (v) { if (v !== 'ok') { er.textContent = v === 'mala' ? 'Contraseña incorrecta.' : 'Sin conexión: no se puede verificar. Reintentá cuando haya red.'; return; } S.recordarPassword(pw).then(function () { marcarSesionValidada(); try { w.sessionStorage.removeItem('cardiolink_bloqueo_v1'); } catch (e) { /* */ } m.remove(); bloqueo = null; if (alResolver) alResolver(); }); }); }
      m.addEventListener('click', function (ev) {
        var t = ev.target; if (!t || !t.hasAttribute) return;
        if (t.hasAttribute('data-ok')) intentar();
        else if (t.hasAttribute('data-cerrar')) {
          // Se cierra por el camino SEGURO de la app: sincroniza con esa sesión y purga; si quedan cambios sin sincronizar NO se cierra dejándolos legibles: reintentar o descartar (explícito).
          if (typeof w.cerrarSesionAjenaV1 === 'function') { m.style.display = 'none'; Promise.resolve(w.cerrarSesionAjenaV1()).then(function (r) { if (r !== 'cerrada') m.style.display = ''; }, function () { m.style.display = ''; }); }
          else er.textContent = 'No se pudo iniciar el cierre seguro: recargá la página.';
        }
      });
      inp.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') intentar(); });
      w.setTimeout(function () { inp.focus(); }, 50);
    }
    function desbloquear() { try { w.sessionStorage.removeItem('cardiolink_bloqueo_v1'); } catch (e) { /* */ } if (bloqueo) { bloqueo.remove(); bloqueo = null; } }
    function bloqueada() { return !!bloqueo || (function () { try { return w.sessionStorage.getItem('cardiolink_bloqueo_v1') === '1'; } catch (e) { return false; } })(); }

    function panel() {
      var uid = uidActual();
      Promise.all([uid ? S.contarSellados(uid) : Promise.resolve(0), S.hayMaterial() ? S.leerCustodia(S._materialSesion()) : Promise.resolve([])]).then(function (r) { pintarPanel(r[0], r[1]); });
    }
    function pintarPanel(nSellados, custodia) {
      custodia = custodia || [];
      var uid = uidActual(), inv = uid ? S.inventario(uid) : [], sd = S.contarSinDueno(uid), cierres = S.cierresConPendientes(uid);
      if (nSellados) inv.push({ id: 'sellados', etiqueta: 'Paquetes cifrados con tu contraseña (no abiertos)', n: nSellados, dias: null, descartable: true });
      var filas = inv.length ? inv.map(function (i) {
        return '<tr><td style="padding:4px 8px 4px 0">' + esc(i.etiqueta) + '</td><td style="padding:4px 8px"><b>' + i.n + '</b></td><td style="padding:4px 8px;color:' + (i.dias != null && i.dias >= DIAS_AVISO ? '#b91c1c' : '#475569') + '">'
          + (i.dias == null ? '—' : i.dias + ' día' + (i.dias === 1 ? '' : 's') + (i.dias >= DIAS_AVISO ? ' ⚠' : '')) + '</td><td>' + (i.descartable ? '<button data-d="' + i.id + '" style="' + BTN + 'background:#fee2e2;color:#991b1b;padding:4px 8px;margin:0">Descartar</button>' : '<span style="color:#64748b;font-size:12px">se gestiona en «Pendientes de sincronización»</span>') + '</td></tr>';
      }).join('') : '<tr><td colspan="4" style="padding:8px 0;color:#475569">No hay datos locales pendientes de este usuario en este equipo.</td></tr>';
      var m = modal('<h3 style="margin:0 0 6px">Datos locales de este equipo</h3>'
        + '<label style="display:flex;gap:8px;align-items:flex-start;margin:8px 0"><input type="checkbox" id="slCompartido" ' + (S.equipoCompartido() ? 'checked' : '') + ' style="margin-top:3px"><span><b>Equipo compartido</b> (recomendado). Al cerrar sesión con cambios sin sincronizar los <b>sella con tu contraseña</b> (cifrado) o los descarta: nunca quedan legibles para otra persona.</span></label>'
        + '<p style="background:#fef3c7;border-radius:8px;padding:8px;margin:8px 0;font-size:13px"><b>Qué protege y qué no:</b> el cifrado con tu contraseña protege lo que queda <b>tras cerrar sesión</b>. Mientras la sesión está abierta los datos están en claro, y con «Equipo compartido» desactivado todo queda <b>sin cifrar</b> al cerrar. Separar por usuario no es protección.</p>'
        + '<table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="text-align:left;color:#64748b"><th>Dato</th><th>Cantidad</th><th>Antigüedad</th><th></th></tr></thead><tbody>' + filas + '</tbody></table>'
        + (sd.sinDueno || sd.deOtrosUsuarios || cierres.length ? '<p style="font-size:13px;margin:10px 0 4px"><b>Datos de otras sesiones:</b> ' + (sd.sinDueno ? sd.sinDueno + ' registro' + (sd.sinDueno === 1 ? '' : 's') + ' heredado' + (sd.sinDueno === 1 ? '' : 's') + ' sin dueño verificable (no se atribuyen a tu usuario). ' : '') + (sd.deOtrosUsuarios ? sd.deOtrosUsuarios + ' de otros usuarios de este equipo (no se pueden descartar desde tu sesión). ' : '') + (cierres.length ? cierres.length + ' usuario' + (cierres.length === 1 ? '' : 's') + ' dejó cambios sin sincronizar.' : '') + '</p>' + (sd.sinDueno ? '<button data-sc="1" style="' + BTN + 'background:#0f766e;color:#fff;padding:4px 8px;margin:0 6px 0 0">Sellar en mi custodia</button><button data-sd="1" style="' + BTN + 'background:#fee2e2;color:#991b1b;padding:4px 8px;margin:0">Descartar los heredados sin dueño</button><p style="font-size:12px;color:#475569;margin:4px 0 0">Sin decisión quedan en claro en este navegador. «Sellar» los cifra con tu contraseña (custodia: no se te atribuye el contenido).</p>' : '') : '')
        + (S.esAdminSesion() && w.cardiolinkOutboxR2D && w.cardiolinkOutboxR2D.tecnicos && w.cardiolinkOutboxR2D.tecnicos() ? '<p style="font-size:13px;margin:10px 0 4px"><b>Restos de versiones anteriores: ' + w.cardiolinkOutboxR2D.tecnicos() + '.</b> Están protegidos y NO se aplican solos (pueden traer datos viejos).</p><button data-rr="1" style="' + BTN + 'background:#e2e8f0;padding:4px 8px;margin:0">Revisar</button>' : '')
        + (S.esAdminSesion() && S.recolectarAjenos(uid).n ? '<p style="font-size:13px;margin:10px 0 4px"><b>Heredados de OTROS usuarios en claro: ' + S.recolectarAjenos(uid).n + '.</b> Sólo ellos pueden cifrarlos con su contraseña (al ingresar). Como owner/admin podés ponerlos en tu custodia cifrada para que no queden legibles: NO se descartan; los podés ver o devolver.</p><button data-sa="1" style="' + BTN + 'background:#0f766e;color:#fff;padding:4px 8px;margin:0">Sellar heredados de otros en mi custodia</button>' : '')
        + (custodia.length ? '<p style="font-size:13px;margin:10px 0 4px"><b>Tenés ' + custodia.length + ' paquete' + (custodia.length === 1 ? '' : 's') + ' heredado' + (custodia.length === 1 ? '' : 's') + ' en custodia cifrada.</b></p><button data-cv="1" style="' + BTN + 'background:#e2e8f0;padding:4px 8px;margin:0 6px 0 0">Ver</button><button data-cr="1" style="' + BTN + 'background:#e2e8f0;padding:4px 8px;margin:0 6px 0 0">Devolver los de otros usuarios</button><button data-cd="1" style="' + BTN + 'background:#fee2e2;color:#991b1b;padding:4px 8px;margin:0">Descartar los sin dueño</button>' : '')
        + '<div style="margin-top:14px"><button data-c="1" style="' + BTN + 'background:#e2e8f0">Cerrar</button></div>');
      m.addEventListener('click', function (ev) {
        var t = ev.target; if (!t || !t.closest) return;
        if (t.closest('[data-c]')) { m.remove(); return; }
        var b = t.closest('button[data-d]');
        if (b) { var id = b.getAttribute('data-d'), it = inv.filter(function (x) { return x.id === id; })[0]; if (!w.confirm('¿Descartar «' + (it ? it.etiqueta : id) + '» (' + (it ? it.n : '?') + ')? Sólo afecta a TU usuario en este equipo y no se puede deshacer.')) return; (id === 'sellados' ? S.descartarSellados(uid) : Promise.resolve(S.descartar(uid, [id]))).then(function () { m.remove(); panel(); }); return; }
        if (t.closest('button[data-sc]')) { if (!S.hayMaterial()) { w.alert('Para sellar necesitás haber ingresado con tu contraseña en esta pestaña.'); return; } if (!w.confirm('Se cifran con TU contraseña ' + sd.sinDueno + ' registro(s) heredados sin dueño verificable. No se te atribuye su contenido: quedan en custodia, ilegibles para otros usuarios, y podés verlos o descartarlos desde este panel. ¿Sellar?')) return; S.sellarSinDueno(S._materialSesion()).then(function (r) { if (!r.ok) w.alert('No se pudo sellar (' + r.error + '). Los datos NO se tocaron.'); m.remove(); panel(); }); return; }
        if (t.closest('button[data-rr]')) { m.remove(); try { w.cardiolinkOutboxR2D.verRecuperacion(); } catch (e) { /* */ } return; }
        if (t.closest('button[data-sa]')) { if (!S.hayMaterial()) { w.alert('Para sellar necesitás haber ingresado con tu contraseña en esta pestaña.'); return; } if (!w.confirm('Se cifran con TU contraseña ' + S.recolectarAjenos(uid).n + ' dato(s) heredado(s) de OTROS usuarios. Esos usuarios dejarán de recuperarlos solos al ingresar hasta que los devuelvas. No se descartan. ¿Sellar?')) return; S.sellarAjenos(uid, S._materialSesion()).then(function (r) { if (!r.ok) w.alert('No se pudo sellar (' + r.error + '). Nada se tocó.'); m.remove(); panel(); }); return; }
        if (t.closest('button[data-cr]')) { S.devolverAjenos(S._materialSesion()).then(function (r) { w.alert('Devueltos: ' + r.devueltas + (r.conflictos ? '. Con conflicto (se conservaron en custodia): ' + r.conflictos : '') + '. Quedan en claro hasta que su dueño ingrese.'); m.remove(); panel(); }); return; }
        if (t.closest('button[data-cv]')) { var tx = custodia.map(function (c) { return (c.datos.tipo === 'legado_ajeno' ? ['De otros usuarios: ' + Object.keys(c.datos.claves || {}).map(function (k) { return k.replace(/^(.{0,60}).*$/, '$1'); }).join(', ')] : []).concat((c.datos.mensajes || []).map(function (x) { return 'Mensaje: ' + (x.texto || ''); })).concat((c.datos.rechazos || []).map(function (x) { return 'Rechazo: ' + JSON.stringify(x); }), (c.datos.eliminadas || []).map(function (x) { return 'Eliminada: ' + JSON.stringify(x).slice(0, 300); })).join('\n'); }).join('\n---\n'); modal('<h3 style="margin:0 0 8px">Datos heredados en custodia</h3><pre style="white-space:pre-wrap;font-size:12px;max-height:50vh;overflow:auto">' + esc(tx) + '</pre><button data-c="1" style="' + BTN + 'background:#e2e8f0">Cerrar</button>').addEventListener('click', function (e2) { if (e2.target && e2.target.hasAttribute && e2.target.hasAttribute('data-c')) e2.currentTarget.remove(); }); return; }
        if (t.closest('button[data-cd]')) { if (!w.confirm('Se descartan PARA SIEMPRE los paquetes en tu custodia que NO tienen dueño. Los de otros usuarios no se tocan (se devuelven). No se puede deshacer. ¿Confirmás?')) return; S.descartarCustodia(S._materialSesion()).then(function () { m.remove(); panel(); }); return; }
        if (t.closest('button[data-sd]')) { if (!w.confirm('Se descartan los datos heredados SIN dueño verificable (' + sd.sinDueno + '). Pueden pertenecer a cualquier usuario de este equipo. Los datos con dueño de otro usuario no se tocan. ¿Confirmás?')) return; S.descartarSinDueno(); m.remove(); panel(); return; }
      });
      m.addEventListener('change', function (ev) {
        if (ev.target && ev.target.id === 'slCompartido') {
          if (!ev.target.checked && !w.confirm('Desactivar «Equipo compartido»: al cerrar sesión los cambios sin sincronizar quedarán SIN CIFRAR y legibles en este navegador. Usalo sólo si este equipo es exclusivamente tuyo. ¿Desactivar?')) { ev.target.checked = true; return; }
          S.fijarEquipoCompartido(ev.target.checked);
        }
      });
    }

    function pintarAviso(id, html, estilo) { try { var d = doc.getElementById(id); if (!d) { d = doc.createElement('div'); d.id = id; } d.style.cssText = estilo; d.innerHTML = html; return d; } catch (e) { return null; } }
    // Pantalla de ingreso: declara lo que este equipo conserva de otras sesiones (no simula protección).
    function avisoIngreso() {
      try {
        var pw = doc.getElementById('loginPassword'); if (!pw || !pw.parentElement) return;
        var c = S.cierresConPendientes(''), sd = S.contarSinDueno('');
        var nS = c.filter(function (x) { return x.sellado; }).reduce(function (a, x) { return a + x.pendientes; }, 0), n = c.filter(function (x) { return !x.sellado; }).reduce(function (a, x) { return a + x.pendientes; }, 0);
        if (!n && !nS) return;
        var d = pintarAviso('slAvisoIngreso', 'Hay cambios sin guardar de una sesión anterior en este equipo. Se envían cuando esa persona vuelva a ingresar.' + (n ? ' Si este equipo es compartido, avisale a la administración.' : ''), 'margin-top:10px;padding:8px 10px;border-radius:8px;background:#fef3c7;color:#78350f;font-size:12px;line-height:1.4');
        if (d && !d.parentElement) pw.parentElement.appendChild(d);
      } catch (e) { /* sin interfaz */ }
    }
    function avisoAntiguedad(uid) {
      try {
        var a = S.avisos(uid, DIAS_AVISO); var prev = doc.getElementById('slAvisoAntiguedad'); if (prev) prev.remove(); if (!a.length) return;
        var d = pintarAviso('slAvisoAntiguedad', 'Hay datos locales de este equipo con más de ' + DIAS_AVISO + ' días sin resolver (' + a.map(function (x) { return esc(x.etiqueta) + ': ' + x.n; }).join('; ') + '). No se borran solos. <button type="button" style="margin-left:8px;border:0;border-radius:8px;padding:4px 8px;font-weight:700;cursor:pointer">Revisar</button> <button type="button" data-x style="border:0;background:transparent;cursor:pointer;font-weight:700">✕</button>', 'position:fixed;left:12px;bottom:12px;max-width:420px;z-index:99990;padding:10px 12px;border-radius:10px;background:#fef3c7;color:#78350f;font:13px/1.4 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25)');
        d.querySelectorAll('button')[0].onclick = function () { d.remove(); panel(); }; d.querySelector('[data-x]').onclick = function () { d.remove(); };
        doc.body.appendChild(d);
      } catch (e) { /* sin interfaz */ }
    }
    function agregarEnlace() {
      try {
        if (doc.getElementById('slEnlacePanel')) return true; if (!S.esAdminSesion()) return false; var b = doc.getElementById('btnCerrarSesion'); if (!b || !b.parentElement) return false;
        var l = doc.createElement('button'); l.id = 'slEnlacePanel'; l.type = 'button'; l.textContent = 'Datos de este equipo'; l.style.cssText = 'display:block;margin-top:6px;background:transparent;border:0;color:inherit;opacity:.75;text-decoration:underline;cursor:pointer;font-size:12px;padding:2px 0';
        l.onclick = panel; b.insertAdjacentElement('afterend', l); return true;
      } catch (e) { return false; }
    }
    // Recuperación clínica explícita: espera a que la app termine la PRIMERA carga del servidor (si no, la carga pisaría lo aplicado), compara y ofrece. Nada se aplica ni se descarta solo.
    function ofrecerRecuperacion(recs) {
      var intentos = 0;
      (function esperar() {
        var cargado = false; try { cargado = !!(w.cardiolinkPersistenciaR1 && w.cardiolinkPersistenciaR1.estado().primeraCarga); } catch (e) { /* */ }
        if (!cargado && ++intentos < 90) { w.setTimeout(esperar, 1000); return; }
        recs.forEach(function (r) {
          var sellada = null; try { sellada = JSON.parse(r.config); } catch (e) { /* ilegible: el paquete se conserva */ }
          if (!sellada) return;
          var viva = typeof data !== 'undefined' ? data : null; if (!viva) return;
          var plan = S.planRecuperacionClinica(sellada, viva), imagenes = (r.noProt || []).filter(function (x) { return S.CLINICAS.indexOf(String(x)) < 0; });
          if (!plan.ops.length && !imagenes.length) { S.liberarPaquete(r.id); return; }                      // el servidor ya tiene todo lo clínico
          var det = plan.ops.slice(0, 8).map(function (o) { return esc(o.tipo + ' ' + o.accion + ': ' + o.clave); }).join('<br>') + (plan.ops.length > 8 ? '<br>… y ' + (plan.ops.length - 8) + ' más' : '');
          var mm = modal('<h3 style="margin:0 0 8px">Cambios clínicos recuperados sin sincronizar</h3><p>Se recuperaron del paquete cifrado cambios que el servidor <b>no tiene</b>:</p><div style="font-size:12px;background:#f1f5f9;border-radius:8px;padding:8px;max-height:28vh;overflow:auto">' + (det || 'Ninguno aplicable automáticamente.') + '</div>'
            + (plan.omitidos ? '<p style="font-size:12px">' + plan.omitidos + ' resumen(es) con una versión igual o más reciente en el servidor: no se pisan.</p>' : '')
            + (imagenes.length ? '<p style="font-size:12px;color:#b91c1c">' + imagenes.length + ' cambio(s) de imágenes u otros datos no se pueden aplicar automáticamente: el paquete cifrado se conserva hasta que lo descartes desde «Datos de este equipo».</p>' : '')
            + (plan.ops.length ? '<button data-ap style="' + BTN + 'background:#0f766e;color:#fff">Aplicar y guardar</button>' : '') + '<button data-de style="' + BTN + 'background:#fee2e2;color:#991b1b">Descartar (se pierden)</button><button data-dp style="' + BTN + 'background:#e2e8f0">Decidir después</button>');
          mm.addEventListener('click', function (ev) {
            var t = ev.target; if (!t || !t.hasAttribute) return;
            if (t.hasAttribute('data-dp')) { mm.remove(); return; }
            if (t.hasAttribute('data-de')) { if (!w.confirm('Se descartan PARA SIEMPRE los cambios clínicos recuperados. ¿Confirmás?')) return; S.liberarPaquete(r.id); mm.remove(); return; }
            if (t.hasAttribute('data-ap')) {
              S.aplicarRecuperacionClinica(viva, plan.ops);
              try { if (typeof saveConfig === 'function') saveConfig(); } catch (e) { /* */ }
              Promise.resolve(typeof w.guardarConfigEnSupabase298 === 'function' ? w.guardarConfigEnSupabase298() : false).then(function (ok) {
                if (ok === false) { w.alert('Se aplicaron en este equipo pero NO se pudieron confirmar en el servidor. El paquete cifrado se conserva: reintentá más tarde.'); return; }
                if (!imagenes.length) S.liberarPaquete(r.id); mm.remove();
              }, function () { w.alert('No se pudo guardar en el servidor. El paquete cifrado se conserva.'); });
            }
          });
        });
      })();
    }
    // Al iniciar sesión con uid validado: abre los paquetes sellados con la clave de ESTA sesión (si la contraseña es la misma), migra lo verificable, retira apartados sin pendientes y avisa por antigüedad.
    function alIniciarSesion(uid) {
      if (!uid) return Promise.resolve(null);
      var inf = { sellados: { restauradas: 0, paquetes: 0, noAbiertos: 0, conflictos: 0, omitidas: 0, cachesRestauradas: 0, recuperaciones: [] } };
      var abrir = S.hayMaterial() ? S.abrirSellados(uid, S._materialSesion()) : Promise.resolve(inf.sellados);
      return abrir.then(function (r) {
        inf.sellados = r; if (r.recuperaciones && r.recuperaciones.length) ofrecerRecuperacion(r.recuperaciones);
        try { Object.assign(inf, S.migrarUsuario(uid)); S.purgarApartadosSinPendientes(uid); if (!r.noAbiertos && !r.conflictos) S.limpiarCierre(uid); } catch (e) { if (w.console) w.console.warn('Seguridad local: migración no disponible:', e); }
        try { if (S.esAdminSesion()) avisoAntiguedad(uid); } catch (e) { /* */ }
        try { if (S.esAdminSesion() && S.equipoCompartido() && S.hayMaterial() && w.sessionStorage.getItem('sl_sd_visto') !== '1') { var nSD = S.recolectarSinDueno().n, nAJ = S.esAdminSesion() ? S.recolectarAjenos(uid).n : 0; if (nSD || nAJ) { w.sessionStorage.setItem('sl_sd_visto', '1'); w.setTimeout(function () { var mm = modal('<h3 style="margin:0 0 8px">Datos heredados sin cifrar en este equipo</h3><p>Hay ' + (nSD ? nSD + ' dato(s) <b>sin dueño verificable</b>' : '') + (nSD && nAJ ? ' y ' : '') + (nAJ ? nAJ + ' de <b>otros usuarios</b>' : '') + ' (de versiones anteriores) guardados <b>en claro</b>: otra persona con acceso a este navegador podría leerlos. Se pueden poner en tu custodia cifrada con tu contraseña desde «Datos de este equipo» (no se descartan solos ni se te atribuye su contenido).</p><button data-ab style="' + BTN + 'background:#0f766e;color:#fff">Abrir «Datos de este equipo»</button><button data-lt style="' + BTN + 'background:#e2e8f0">Más tarde</button>'); mm.addEventListener('click', function (ev) { var t = ev.target; if (t && t.hasAttribute) { if (t.hasAttribute('data-ab')) { mm.remove(); panel(); } else if (t.hasAttribute('data-lt')) mm.remove(); } }); }, 5000); } } } catch (e) { /* */ }
        if (r.noAbiertos) { try { w.alert('Quedaron cambios sin guardar de tu sesión anterior que no se pudieron recuperar, porque la contraseña cambió. Avisale a la administración.'); } catch (e) { /* */ } }
        return inf;
      }, function () { return inf; });
    }
    if (doc) {
      var intentos = 0, t = w.setInterval(function () { if (agregarEnlace() || ++intentos > 120) w.clearInterval(t); }, 1000);
      doc.addEventListener('DOMContentLoaded', avisoIngreso); if (doc.readyState !== 'loading') w.setTimeout(avisoIngreso, 300);
      try { if (S.equipoCompartido() && hayTokenLocal()) w.setTimeout(function () { bloquearSesion(function () { try { if (typeof reiniciarTemporizadorInactividad === 'function') reiniciarTemporizadorInactividad(); } catch (e) { /* */ } }, { titulo: 'Por seguridad, ingresá tu contraseña', texto: 'Hay una sesión abierta en este equipo. Para continuar ingresá tu contraseña. Si no sos esa persona, cerrá esa sesión.', cerrar: true }); }, 300); else if (w.sessionStorage.getItem('cardiolink_bloqueo_v1') === '1') w.setTimeout(function () { bloquearSesion(function () { try { if (typeof reiniciarTemporizadorInactividad === 'function') reiniciarTemporizadorInactividad(); } catch (e) { /* */ } }); }, 400); } catch (e) { /* */ }
    }
    return Object.assign({}, S, { elegirCierre: elegirCierre, abrirPanel: panel, alIniciarSesion: alIniciarSesion, avisoIngreso: avisoIngreso, sellarConPassword: sellarConPassword, sellarConSesion: sellarConSesion, bloquearSesion: bloquearSesion, desbloquear: desbloquear, bloqueada: bloqueada, pedirPassword: pedirPassword });
  }

  return { VERSION: VERSION, CATEGORIAS: CATEGORIAS, DIAS_AVISO: DIAS_AVISO, crear: crear, conectarNavegador: conectarNavegador, estable: estable };
});
