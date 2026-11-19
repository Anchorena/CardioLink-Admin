/* CardioLink · Persistencia V1 / R2D · Cola local de recuperación de operaciones NO confirmadas (una sola cola lógica).
   Objetivo: que un cambio legítimo todavía no confirmado por el servidor sobreviva a una recarga, al cierre de la pestaña o al reinicio, y se recupere por los motores de
   R2B (configuración) y R2C (atenciones), nunca por un upsert ciego ni aplicando un parche sobre el remoto.

   QUÉ SE GUARDA (mínimo imprescindible, nunca claves/tokens):
     · atención NUEVA ........ la fila completa (única copia existente) + marca `enviado` (contenido del último intento de envío, para no asumir que «existe» = «éxito»);
     · atención EXISTENTE .... SÓLO las diferencias campo a campo {antes, después} y la versión base (updated_at). Nunca la fila entera;
     · configuración (Dueño/Admin) parches por ENTIDAD y CAMPO (ver diffConfig). No se guardan documentos clínicos, evoluciones, resúmenes, importaciones ni imágenes (data:);
     · atención INCOMPLETA .... la fila (identificable pero sin cobertura/prestación/profesional): fuera de `atenciones` (Caja, producción y facturación no la ven) hasta completarla.
   NUNCA SE REENVÍA: confirmaciones de cobro (cobroConfirmado*, cobroMedioPago, cobroAuditoria) ni el paso a «cobrado»; una atención nueva con cobro ya registrado queda en REVISIÓN
   (se consulta al servidor y el usuario decide). Las correcciones económicas de cobros pendientes viajan como UN grupo (lo resuelve R2C).
   AISLAMIENTO: clave por PROYECTO Supabase + UID; sólo se lee con sesión validada del mismo uid. Varias pestañas del mismo uid: cada pestaña es dueña de sus operaciones
   (clave `<pestaña>|<id>`); las de una pestaña cerrada/inactiva (>45 s sin latido o marcada cerrada) las reclama la primera pestaña que carga.
   LÍMITE REAL: localStorage no cifra; quien tenga acceso al navegador de este equipo puede leerlo (igual que la caché de atenciones y configuración que ya existe). Esta cola sólo
   AGREGA diferencias y filas nuevas. Ver docs/QA.md (R2D).
   Este archivo contiene SÓLO la lógica pura (Node + navegador); la integración con la app está en cardiolink-outbox-glue-v1.js. */
(function (raiz, fabrica) {
  'use strict';
  var api = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.cardiolinkOutboxPuroV1 = api;
})(typeof self !== 'undefined' ? self : this, function (raiz) {
  'use strict';
  var VERSION = 'r2d-1', DIAS_AVISO = 30, LATIDO_MS = 45000, PREFIJO = 'cardiolink_outbox_r2d_v1:';

  // ================= utilidades puras =================
  function estable(v) {
    if (v === null || typeof v !== 'object') { var s = JSON.stringify(v); return s === undefined ? 'null' : s; }
    if (Array.isArray(v)) return '[' + v.map(estable).join(',') + ']';
    return '{' + Object.keys(v).filter(function (k) { return v[k] !== undefined && typeof v[k] !== 'function'; }).sort().map(function (k) { return JSON.stringify(k) + ':' + estable(v[k]); }).join(',') + '}';
  }
  function clonar(o) { return o === undefined ? undefined : JSON.parse(JSON.stringify(o)); }
  function tiene(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined; }
  function igual(a, b) { return estable(a) === estable(b); }
  function esObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function esDataUrlGrande(v) { return typeof v === 'string' && v.indexOf('data:') === 0 && v.length > 2048; }

  // ---------- atenciones ----------
  // Campos que JAMÁS entran en la cola de recuperación: la confirmación de un cobro y su auditoría sólo se escriben por el camino especializado de cobros (consulta fresca + CAS).
  var COBRO_EXCLUIDOS = ['cobroConfirmadoEn', 'cobroConfirmadoPor', 'cobroConfirmadoPorId', 'cobroConfirmadoPorRol', 'cobroConfirmadoPorEmail', 'cobroMedioPago', 'cobroAuditoria'];
  function diffAtencion(base, local) {
    var cambios = {}, excluidos = [], claves = {};
    Object.keys(base || {}).forEach(function (k) { claves[k] = 1; }); Object.keys(local || {}).forEach(function (k) { claves[k] = 1; });
    Object.keys(claves).forEach(function (k) {
      var hb = tiene(base, k), hl = tiene(local, k);
      if (hb === hl && (!hb || igual(base[k], local[k]))) return;
      if (COBRO_EXCLUIDOS.indexOf(k) >= 0) { excluidos.push(k); return; }
      if (k === 'estadoCobro' && hl && local[k] === 'cobrado' && !(hb && base[k] === 'cobrado')) { excluidos.push(k); return; }   // el paso a «cobrado» no se reenvía
      if (esDataUrlGrande(local[k]) || esDataUrlGrande(base && base[k])) { excluidos.push(k); return; }
      var c = {}; if (hb) c.a = base[k]; else c.aa = 1; if (hl) c.d = local[k]; else c.da = 1;
      cambios[k] = c;
    });
    return { cambios: cambios, excluidos: excluidos };
  }
  // lado 'a' (antes) | 'd' (después): reconstruye la atención aplicando los cambios sobre `payload`.
  function aplicarAtencion(payload, cambios, lado) {
    var o = clonar(payload) || {};
    Object.keys(cambios || {}).forEach(function (k) {
      var c = cambios[k], ausente = lado === 'a' ? c.aa : c.da;
      if (ausente) delete o[k]; else o[k] = clonar(lado === 'a' ? c.a : c.d);
    });
    return o;
  }
  // ¿Es una fila identificable pero incompleta (la vía que hoy se descarta en silencio)?
  function identificable(a) {
    if (!a || typeof a !== 'object') return false;
    var inval = function (v) { var s = String(v == null ? '' : v).trim().toLowerCase(); return s === '' || s === 'undefined' || s === 'null' || s === 'nan'; };
    var pac = !inval(a.paciente), dni = !inval(a.dni) && /\d{5,}/.test(String(a.dni).replace(/\D/g, ''));
    return pac || dni;
  }
  function conCobroRegistrado(a) { return !!a && (a.estadoCobro === 'cobrado' || COBRO_EXCLUIDOS.some(function (k) { return k !== 'cobroAuditoria' && tiene(a, k) && a[k] !== ''; })); }

  // ---------- configuración (Dueño/Admin): parches por entidad y campo ----------
  var CFG_EXCLUIDAS = ['documentosClinicos', 'evolucionesClinicas', 'resumenesClinicos', 'importacionesMedicloudEvoluciones'];
  var CFG_INDEXADAS = { pacientes: 'id', profesionales: 'id', usuarios: 'id', roles: 'id', especialidades: 'id', destinosFacturacion: 'id', plantillasPedidos: 'id', movimientosFinancieros411C: 'id', arancelesConvenios: 'id', conveniosFacturacion: 'obraSocial' };
  var CFG_MAPAS = { arancelesPorProfesional: 'id', conveniosPorProfesional: 'obraSocial' };
  var CFG_CONJUNTOS = ['obrasSociales', 'motivosConsulta', 'colocadores', 'catalogoPrestaciones411P'];
  function sinImagenes(e) { var o = {}, quitado = false; Object.keys(e).forEach(function (k) { if (esDataUrlGrande(e[k])) quitado = true; else o[k] = e[k]; }); return { ent: o, quitado: quitado }; }
  function mapaPorId(lista, campo) {
    if (!Array.isArray(lista)) return null;
    var m = {}, orden = [];
    for (var i = 0; i < lista.length; i++) {
      var e = lista[i]; if (!esObj(e) || !tiene(e, campo) || e[campo] === '' || e[campo] === null) return null;
      var id = String(e[campo]); if (Object.prototype.hasOwnProperty.call(m, id)) return null;
      m[id] = e; orden.push(id);
    }
    return m;
  }
  function diffLista(ruta, campo, b, l, ops, noProt) {
    if (igual(b, l)) return;
    var mb = b === undefined ? {} : mapaPorId(b, campo), ml = l === undefined ? {} : mapaPorId(l, campo);
    if (mb === null || ml === null || (b !== undefined && !Array.isArray(b)) || (l !== undefined && !Array.isArray(l))) {   // sin identidad inequívoca: la lista entera como valor
      ops.push(valOp(ruta, b, l, noProt)); return;
    }
    Object.keys(Object.assign({}, mb, ml)).forEach(function (id) {
      var eb = mb[id], el = ml[id];
      if (eb && el) {
        if (igual(eb, el)) return;
        var campos = {}, ks = {}; Object.keys(eb).forEach(function (k) { ks[k] = 1; }); Object.keys(el).forEach(function (k) { ks[k] = 1; });
        Object.keys(ks).forEach(function (k) {
          var hb = tiene(eb, k), hl = tiene(el, k); if (hb === hl && (!hb || igual(eb[k], el[k]))) return;
          if (esDataUrlGrande(el[k]) || esDataUrlGrande(eb[k])) { noProt.push(ruta.join('.') + '[' + id + '].' + k); return; }
          var c = {}; if (hb) c.a = eb[k]; else c.aa = 1; if (hl) c.d = el[k]; else c.da = 1; campos[k] = c;
        });
        if (Object.keys(campos).length) ops.push({ t: 'mod', ruta: ruta, campo: campo, id: id, campos: campos });
      } else if (el) { var s = sinImagenes(el); if (s.quitado) noProt.push(ruta.join('.') + '[' + id + '] (imágenes)'); ops.push({ t: 'add', ruta: ruta, campo: campo, id: id, e: s.ent }); }
      else { var s2 = sinImagenes(eb); ops.push({ t: 'del', ruta: ruta, campo: campo, id: id, e: s2.ent }); }
    });
  }
  function valOp(ruta, b, l, noProt) {
    if (esDataUrlGrande(l) || esDataUrlGrande(b)) { noProt.push(ruta.join('.')); return { t: 'val', ruta: ruta, aa: 1, da: 1 }; }
    var o = { t: 'val', ruta: ruta }; if (b === undefined) o.aa = 1; else o.a = b; if (l === undefined) o.da = 1; else o.d = l; return o;
  }
  function diffConfig(base, local) {
    var ops = [], noProt = []; base = base || {}; local = local || {};
    var claves = {}; Object.keys(base).forEach(function (k) { claves[k] = 1; }); Object.keys(local).forEach(function (k) { claves[k] = 1; });
    Object.keys(claves).forEach(function (k) {
      var b = base[k], l = local[k]; if (igual(b, l) && tiene(base, k) === tiene(local, k)) return;
      if (CFG_EXCLUIDAS.indexOf(k) >= 0) { noProt.push(k); return; }
      if (CFG_INDEXADAS[k]) { diffLista([k], CFG_INDEXADAS[k], b, l, ops, noProt); return; }
      if (CFG_MAPAS[k]) {
        var sub = {}; Object.keys(esObj(b) ? b : {}).forEach(function (s) { sub[s] = 1; }); Object.keys(esObj(l) ? l : {}).forEach(function (s) { sub[s] = 1; });
        if ((b !== undefined && !esObj(b)) || (l !== undefined && !esObj(l))) { ops.push(valOp([k], b, l, noProt)); return; }
        Object.keys(sub).forEach(function (s) { diffLista([k, s], CFG_MAPAS[k], b && b[s], l && l[s], ops, noProt); });
        return;
      }
      if (CFG_CONJUNTOS.indexOf(k) >= 0 && Array.isArray(b || []) && Array.isArray(l || []) && (b || []).every(function (x) { return typeof x === 'string'; }) && (l || []).every(function (x) { return typeof x === 'string'; })) {
        var sb = b || [], sl = l || [];
        ops.push({ t: 'set', ruta: [k], add: sl.filter(function (x) { return sb.indexOf(x) < 0; }), del: sb.filter(function (x) { return sl.indexOf(x) < 0; }), aa: b === undefined ? 1 : 0, da: l === undefined ? 1 : 0 });
        return;
      }
      if (esObj(b) && esObj(l)) {                                                     // objeto genérico: una subclave por vez (no se guarda el objeto entero)
        var sk = {}; Object.keys(b).forEach(function (s) { sk[s] = 1; }); Object.keys(l).forEach(function (s) { sk[s] = 1; });
        Object.keys(sk).forEach(function (s) { if (igual(b[s], l[s]) && tiene(b, s) === tiene(l, s)) return; ops.push(valOp([k, s], b[s], l[s], noProt)); });
        return;
      }
      ops.push(valOp([k], b, l, noProt));
    });
    return { ops: ops.filter(function (o) { return !(o.t === 'val' && o.aa && o.da && !('a' in o) && !('d' in o)); }), noProtegido: noProt };
  }
  function contenedor(cfg, ruta, crear) {
    var o = cfg;
    for (var i = 0; i < ruta.length - 1; i++) { if (!esObj(o[ruta[i]])) { if (!crear) return null; o[ruta[i]] = {}; } o = o[ruta[i]]; }
    return o;
  }
  function aplicarConfig(cfg, ops, lado) {
    var c = clonar(cfg) || {};
    (ops || []).forEach(function (op) {
      var padre = contenedor(c, op.ruta, true), k = op.ruta[op.ruta.length - 1];
      if (op.t === 'val') { var ausente = lado === 'a' ? op.aa : op.da; if (ausente) delete padre[k]; else if (lado === 'a' ? ('a' in op) : ('d' in op)) padre[k] = clonar(lado === 'a' ? op.a : op.d); return; }
      if (op.t === 'set') {
        var ausenteS = lado === 'a' ? op.aa : op.da; if (ausenteS) { delete padre[k]; return; }
        var lista = Array.isArray(padre[k]) ? padre[k] : (padre[k] = []);
        var agregar = lado === 'd' ? op.add : op.del, quitar = lado === 'd' ? op.del : op.add;
        quitar.forEach(function (x) { var i = lista.indexOf(x); if (i >= 0) lista.splice(i, 1); });
        agregar.forEach(function (x) { if (lista.indexOf(x) < 0) lista.push(x); });
        return;
      }
      var lst = Array.isArray(padre[k]) ? padre[k] : (padre[k] = []);
      var idx = -1; for (var i = 0; i < lst.length; i++) { if (esObj(lst[i]) && String(lst[i][op.campo]) === op.id) { idx = i; break; } }
      var debe = op.t === 'add' ? lado === 'd' : op.t === 'del' ? lado === 'a' : true;
      if (op.t === 'mod') {
        if (idx < 0) return;
        Object.keys(op.campos).forEach(function (f) { var cc = op.campos[f], aus = lado === 'a' ? cc.aa : cc.da; if (aus) delete lst[idx][f]; else lst[idx][f] = clonar(lado === 'a' ? cc.a : cc.d); });
        return;
      }
      if (debe && idx < 0) lst.push(clonar(op.e)); else if (!debe && idx >= 0) lst.splice(idx, 1);
    });
    return c;
  }

  // ================= cola persistente (almacenamiento inyectable) =================
  function claveCola(proyecto, uid) { return PREFIJO + String(proyecto || 'sin-proyecto') + ':' + String(uid || ''); }
  function vacia() { return { v: 1, tabs: {}, ops: {} }; }
  // Lee la cola. Datos dañados: NO se pisan; se conserva el texto crudo en una clave aparte y se informa.
  function abrir(almacen, clave) {
    var crudo = null;
    try { crudo = almacen.getItem(clave); } catch (e) { return { estado: vacia(), error: 'almacenamiento_no_disponible' }; }
    if (crudo == null) return { estado: vacia() };
    try {
      var e = JSON.parse(crudo);
      if (!e || e.v !== 1 || !esObj(e.ops)) throw new Error('formato');
      e.tabs = esObj(e.tabs) ? e.tabs : {};
      return { estado: e };
    } catch (err) {
      var dañada = clave + ':danada';
      try { if (almacen.getItem(dañada) == null) almacen.setItem(dañada, crudo); } catch (e2) { /* sin espacio: queda el original */ }
      return { estado: vacia(), dañada: true, conservada: (function () { try { return almacen.getItem(dañada) != null; } catch (e3) { return false; } })() };
    }
  }
  function escribir(almacen, clave, estado) {
    var txt = JSON.stringify(estado);
    try {
      almacen.setItem(clave, txt);
      if (almacen.getItem(clave) !== txt) return { ok: false, error: 'verificacion' };      // escritura que no quedó (no se informa como protegida)
      return { ok: true, bytes: txt.length };
    } catch (e) { return { ok: false, error: (e && (e.name || e.message)) || 'escritura' }; }
  }
  function esHuerfana(estado, op, tabId, ahora) {
    if (op.tab === tabId) return false;
    var t = estado.tabs[op.tab];
    return !t || t.cerrada === true || (ahora - t.ts) > LATIDO_MS;
  }
  function antiguedadDias(op, ahora) { return Math.floor((ahora - Date.parse(op.ts || 0)) / 86400000); }

  return {
    VERSION: VERSION, estable: estable, diffAtencion: diffAtencion, aplicarAtencion: aplicarAtencion, identificable: identificable, conCobroRegistrado: conCobroRegistrado,
    diffConfig: diffConfig, aplicarConfig: aplicarConfig, claveCola: claveCola, vacia: vacia, abrir: abrir, escribir: escribir, esHuerfana: esHuerfana, antiguedadDias: antiguedadDias,
    COBRO_EXCLUIDOS: COBRO_EXCLUIDOS, LATIDO_MS: LATIDO_MS, DIAS_AVISO: DIAS_AVISO
  };
});
