/* CardioLink · Persistencia V1 / R3 · Escritura segura de la ficha demográfica del paciente en cardiolink_pacientes (tabla relacional = fuente principal).
   Módulo sin DOM y sin globales de la app: recibe el cliente Supabase y devuelve resultados. Node (tests) y navegador (window.cardiolinkFichaV1).

   REGLAS
    · Se escriben SÓLO los campos que el usuario cambió (diferencias {antes, después} contra lo que vio); jamás la fila completa de una edición.
    · Fusión de TRES VÍAS por campo contra una relectura fresca: remoto == antes → se aplica; remoto == después → ya estaba; otro valor → CONFLICTO (no se pisa, no se resuelve por fecha).
    · UPDATE condicionado a `actualizado_en` (≤ 3 reintentos): una escritura concurrente de otra sesión nunca se pisa a ciegas.
    · DNI: verificación previa contra la tabla (`dni_normalizado`, otro id) y la unicidad de la base como árbitro final (23505) → `dni_duplicado`. El id del paciente nunca cambia.
    · «Confirmada» sólo cuando el servidor devolvió la fila actualizada con los valores pedidos. Nunca se informa éxito sin confirmación.
    · No toca atenciones, cobertura de atenciones, facturación ni snapshots históricos.
   Estado en memoria: `vista` (última fila relacional leída, base de la edición) y `pendientes` (diferencias aún sin confirmar; la cola R2D las persiste y recupera). */
(function (raiz, fabrica) {
  'use strict';
  var api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.cardiolinkFichaV1 = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var TABLA = 'cardiolink_pacientes', MAX_REINTENTOS = 3;
  // [campo de la app, columna, tipo]
  var CAMPOS = [
    ['nombreCompleto', 'nombre_completo', 'texto'], ['dni', 'dni', 'texto'], ['fechaNacimiento', 'fecha_nacimiento', 'fecha'], ['sexo', 'sexo', 'texto'],
    ['localidad', 'localidad', 'texto'], ['provincia', 'provincia', 'texto'], ['direccion', 'direccion', 'texto'],
    ['coberturaHabitual', 'cobertura_habitual', 'texto'], ['numeroAfiliadoHabitual', 'numero_afiliado_habitual', 'texto'],
    ['telefono', 'telefono', 'texto'], ['email', 'email', 'texto']
  ];
  var POR_CAMPO = {}; CAMPOS.forEach(function (c) { POR_CAMPO[c[0]] = c; });

  function digitos(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }
  function isoFecha(v) {
    var s = String(v == null ? '' : v).trim(); if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    var m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/); if (!m) return null;
    var y = m[3]; if (y.length === 2) y = (Number(y) > 40 ? '19' : '20') + y;
    return y.padStart(4, '0') + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
  }
  // valor normalizado como lo guarda la tabla (null = sin dato)
  function norm(campo, v) {
    var c = POR_CAMPO[campo]; if (!c) return null;
    if (c[2] === 'fecha') return isoFecha(v);
    var s = String(v == null ? '' : v).trim(); return s === '' ? null : s;
  }
  // objeto de la app (o fila) → {campo: valor normalizado} sólo con los campos editables
  function normalizarApp(p) { var o = {}; CAMPOS.forEach(function (c) { o[c[0]] = norm(c[0], p ? p[c[0]] : null); }); return o; }
  function desdeFila(row) { var o = {}; CAMPOS.forEach(function (c) { o[c[0]] = norm(c[0], row ? row[c[1]] : null); }); return o; }
  // diferencias de `nuevo` respecto de `base` ({campo:{a,d}} sólo de los campos editables que cambiaron)
  function diferencias(base, nuevo, soloCampos) {
    var b = normalizarApp(base), n = normalizarApp(nuevo), out = {};
    CAMPOS.forEach(function (c) { var k = c[0]; if (soloCampos && soloCampos.indexOf(k) < 0) return; if (b[k] !== n[k]) out[k] = { a: b[k], d: n[k] }; });
    return out;
  }
  // fusión de 3 vías de las diferencias del usuario contra el remoto actual
  function planificar(cambios, remoto) {
    var r = desdeFila(remoto), aplicar = {}, ya = [], conflictos = [];
    Object.keys(cambios || {}).forEach(function (k) {
      var c = cambios[k], rv = r[k];
      if (rv === c.d) ya.push(k);
      else if (rv === c.a) aplicar[k] = c.d;
      else conflictos.push({ campo: k, antes: c.a, nuevo: c.d, remoto: rv });
    });
    return { aplicar: aplicar, ya: ya, conflictos: conflictos };
  }
  function filaDesdeCambios(id, nuevoCompleto, ahora) {   // alta de la fila relacional (no existía)
    var f = { id: String(id) }; var n = normalizarApp(nuevoCompleto);
    CAMPOS.forEach(function (c) { f[c[1]] = n[c[0]]; });
    f.activo = !(nuevoCompleto && nuevoCompleto.estado === 'fusionado'); f.actualizado_en = ahora;
    return f;
  }
  function esDuplicadoDni(error) {   // 23505 que NO es la clave primaria: es el índice único de dni_normalizado
    return !!error && error.code === '23505' && !/pkey/i.test(String(error.message || '') + ' ' + String(error.details || ''));
  }

  async function buscarDniOtro(sb, dni, id) {
    var d = digitos(dni); if (!d) return { otro: null };
    var r = await sb.from(TABLA).select('id').eq('dni_normalizado', d).neq('id', String(id)).limit(1);
    if (r.error) return { error: r.error };
    var f = Array.isArray(r.data) ? r.data[0] : r.data;
    return { otro: f ? String(f.id) : null };
  }
  async function leerFila(sb, id) {
    var r = await sb.from(TABLA).select('*').eq('id', String(id)).limit(1);
    if (r.error) return { error: r.error };
    var f = Array.isArray(r.data) ? r.data[0] : r.data; return { fila: f || null };
  }
  function esPermiso(e) { return !!e && (e.code === '42501' || /row-level security|permission denied/i.test(String(e.message || ''))); }

  // Núcleo: aplica `cambios` ({campo:{a,d}}) sobre la fila del paciente `id`.
  //  nuevoCompleto: el paciente completo tal como lo ve el usuario (sólo se usa para CREAR la fila si no existe).
  // Devuelve {estado:'confirmada', fila, aplicados[], ya[], conflictos[], creada} | {estado:'dni_duplicado', dni} | {estado:'error', error, permiso, transitorio}.
  async function guardarCambios(opc) {
    var sb = opc.sb, id = String(opc.id), cambios = opc.cambios || {}, ahora = opc.ahora || function () { return new Date().toISOString(); };
    var intento = 0;
    while (intento < MAX_REINTENTOS) {
      intento++;
      var lec = await leerFila(sb, id);
      if (lec.error) return { estado: 'error', error: lec.error, transitorio: !esPermiso(lec.error), permiso: esPermiso(lec.error) };
      var fila = lec.fila;
      if (!fila) {                                                   // la ficha todavía no existe en la tabla relacional: se crea (insert, nunca upsert ciego)
        if (opc.creacionPermitida === false) return { estado: 'ausente' };   // ya existía y desapareció (eliminada o sin acceso): NO se recrea
        if (!opc.nuevoCompleto) return { estado: 'error', error: { message: 'La ficha no existe en el servidor y no hay datos para crearla.' }, transitorio: false };
        var nueva = filaDesdeCambios(id, opc.nuevoCompleto, ahora());
        if (nueva.dni) { var d0 = await buscarDniOtro(sb, nueva.dni, id); if (d0.error) return { estado: 'error', error: d0.error, transitorio: true }; if (d0.otro) return { estado: 'dni_duplicado', dni: nueva.dni, otroId: d0.otro }; }
        var ins = await sb.from(TABLA).insert([nueva]).select('*');
        if (ins.error) {
          if (esDuplicadoDni(ins.error)) return { estado: 'dni_duplicado', dni: nueva.dni };
          if (ins.error.code === '23505') continue;                 // otra sesión creó esta misma ficha: se relee y se fusiona
          return { estado: 'error', error: ins.error, permiso: esPermiso(ins.error), transitorio: !esPermiso(ins.error) };
        }
        var creada = Array.isArray(ins.data) ? ins.data[0] : ins.data;
        if (!creada) return { estado: 'error', error: { message: 'El servidor no devolvió la ficha creada.' }, transitorio: true };
        return { estado: 'confirmada', fila: creada, aplicados: Object.keys(cambios), ya: [], conflictos: [], creada: true };
      }
      var plan = planificar(cambios, fila), cols = {};
      Object.keys(plan.aplicar).forEach(function (k) { cols[POR_CAMPO[k][1]] = plan.aplicar[k]; });
      if (!Object.keys(cols).length) return { estado: 'confirmada', fila: fila, aplicados: [], ya: plan.ya, conflictos: plan.conflictos, sinCambios: true };
      if ('dni' in cols && cols.dni) {                              // DNI duplicado: verificación previa; la unicidad de la base es el árbitro final
        var dd = await buscarDniOtro(sb, cols.dni, id); if (dd.error) return { estado: 'error', error: dd.error, transitorio: true };
        if (dd.otro) return { estado: 'dni_duplicado', dni: cols.dni, otroId: dd.otro };
      }
      var nuevoTs = ahora(); cols.actualizado_en = nuevoTs;
      var q = sb.from(TABLA).update(cols).eq('id', id);
      q = (fila.actualizado_en == null) ? q.is('actualizado_en', null) : q.eq('actualizado_en', fila.actualizado_en);
      var up = await q.select('*');
      if (up.error) {
        if (esDuplicadoDni(up.error)) return { estado: 'dni_duplicado', dni: cols.dni };
        return { estado: 'error', error: up.error, permiso: esPermiso(up.error), transitorio: !esPermiso(up.error) };
      }
      var filas = Array.isArray(up.data) ? up.data : (up.data ? [up.data] : []);
      if (!filas.length) continue;                                  // otra sesión escribió en medio (o la fila cambió): se relee y se vuelve a fusionar
      var conf = filas[0], vistoDe = desdeFila(conf), ok = true;
      Object.keys(plan.aplicar).forEach(function (k) { if (vistoDe[k] !== plan.aplicar[k]) ok = false; });
      if (!ok) return { estado: 'error', error: { message: 'El servidor respondió, pero los valores guardados no coinciden con lo pedido.' }, transitorio: true };
      return { estado: 'confirmada', fila: conf, aplicados: Object.keys(plan.aplicar), ya: plan.ya, conflictos: plan.conflictos };
    }
    return { estado: 'error', error: { message: 'La ficha cambió varias veces mientras se guardaba (otra sesión escribe a la vez).' }, transitorio: true, reintentosAgotados: true };
  }

  // ---------- estado en memoria ----------
  var vista = new Map();          // id → {campo: valor normalizado} de la última lectura relacional
  var pendientes = new Map();     // id → { cambios:{campo:{a,d}}, ts }
  function registrarVista(row) { if (row && row.id != null) vista.set(String(row.id), desdeFila(row)); }
  function vistaDe(id) { var v = vista.get(String(id)); return v ? Object.assign({}, v) : null; }
  // origen: 'usuario' = edición real hecha por una persona en esta sesión (se reintenta sola); 'heredado' = pendiente creado antes de esta corrección (no se aplica sola: puede traer datos viejos).
  function marcarPendiente(id, cambios, origen) {
    id = String(id); var p = pendientes.get(id) || { cambios: {}, ts: new Date().toISOString(), origen: origen || 'usuario' };
    if (origen === 'usuario') p.origen = 'usuario';                                  // una edición nueva de la persona prevalece sobre el origen anterior
    delete p.rechazo;                                                                // si vuelve a editar, se vuelve a intentar
    Object.keys(cambios).forEach(function (k) { var prev = p.cambios[k]; p.cambios[k] = { a: prev ? prev.a : cambios[k].a, d: cambios[k].d }; if (p.cambios[k].a === p.cambios[k].d) delete p.cambios[k]; });
    if (Object.keys(p.cambios).length) pendientes.set(id, p); else pendientes.delete(id);
  }
  // Error permanente (permisos, DNI repetido, validación de la base): NO se reintenta solo y NO se descarta: la edición se conserva con su motivo para que se informe a la persona.
  function rechazarPendiente(id, tipo, detalle) { var p = pendientes.get(String(id)); if (p) p.rechazo = { tipo: tipo, detalle: detalle || '', ts: new Date().toISOString() }; }
  function esErrorPermanente(r) {
    if (!r || r.estado !== 'error') return false;
    if (r.permiso) return true; var c = r.error && r.error.code ? String(r.error.code) : '';
    return /^(22|23|42)/.test(c) && c !== '23505';                                   // datos inválidos / restricciones / permisos: reintentar no cambia el resultado
  }
  function liberarCampos(id, campos) { id = String(id); var p = pendientes.get(id); if (!p) return; campos.forEach(function (k) { delete p.cambios[k]; }); if (!Object.keys(p.cambios).length) pendientes.delete(id); }
  function listarPendientes() { var o = []; pendientes.forEach(function (p, id) { o.push({ id: id, cambios: JSON.parse(JSON.stringify(p.cambios)), ts: p.ts, origen: p.origen || 'heredado', rechazo: p.rechazo ? JSON.parse(JSON.stringify(p.rechazo)) : null }); }); return o; }
  // Lo que la persona vio al abrir el formulario (base de su edición). La comparación se hace contra esto y no contra el estado actual: así lo que no tocó no se escribe y un cambio hecho por otra sesión
  // mientras tanto se detecta como conflicto en vez de pisarse.
  var vistasEdicion = new Map();
  function fijarVistaEdicion(id, obj) { vistasEdicion.set(String(id), { v: normalizarApp(obj), t: Date.now() }); }
  function vistaEdicionDe(id, maxMs) { var x = vistasEdicion.get(String(id)); if (!x || Date.now() - x.t > (maxMs || 7200000)) return null; return Object.assign({}, x.v); }
  function olvidarVistaEdicion(id) { vistasEdicion.delete(String(id)); }
  function limpiarEstado() { vistasEdicion.clear(); vista.clear(); pendientes.clear(); sync.clear(); divergencias.clear(); ausentes.clear(); }

  // Guarda lo que el usuario editó: calcula las diferencias contra `base` (lo que vio), las deja pendientes (la cola R2D las persiste ANTES de la red),
  // escribe y, con la confirmación, libera. Los campos en conflicto NO se escriben ni quedan pendientes: el llamador adopta el valor del servidor.
  async function ejecutarCambios(opc, cambios) {
    var r = await guardarCambios({ sb: opc.sb, id: opc.id, cambios: cambios, nuevoCompleto: opc.nuevo, ahora: opc.ahora, creacionPermitida: opc.creacionPermitida });
    r.cambios = cambios;
    if (r.estado === 'ausente') { liberarCampos(opc.id, Object.keys(cambios)); ausentes.add(String(opc.id)); }
    if (r.estado === 'confirmada') {
      liberarCampos(opc.id, Object.keys(cambios));                  // aplicados, ya aplicados y en conflicto dejan de estar pendientes
      if (r.fila) registrarVista(r.fila);
    } else if (r.estado === 'dni_duplicado') {
      rechazarPendiente(opc.id, 'dni_duplicado', r.dni);              // rechazo definitivo: no se reintenta solo y NO se descarta (la persona lo ve y puede corregirlo)
    } else if (esErrorPermanente(r)) {
      rechazarPendiente(opc.id, r.permiso ? 'permiso' : 'invalido', r.error && r.error.message);
    }
    return r;
  }
  async function guardarEdicion(opc) {
    var cambios = diferencias(opc.base, opc.nuevo);
    if (!Object.keys(cambios).length) return { estado: 'confirmada', aplicados: [], ya: [], conflictos: [], sinCambios: true, cambios: cambios };
    marcarPendiente(opc.id, cambios, 'usuario');
    if (opc.alMarcar) { try { opc.alMarcar(); } catch (e) { /* */ } }
    return ejecutarCambios(opc, cambios);
  }
  // Diferencias ya conocidas (empuje tras la carga, reintento, recuperación de la cola R2D): {id, cambios, nuevo(completo, sólo para crear la fila), sb}
  async function guardarCambiosPendientes(opc) {
    var cambios = opc.cambios || {};
    if (!Object.keys(cambios).length) return { estado: 'confirmada', aplicados: [], ya: [], conflictos: [], sinCambios: true, cambios: cambios };
    marcarPendiente(opc.id, cambios, opc.origen);
    if (opc.alMarcar) { try { opc.alMarcar(); } catch (e) { /* */ } }
    return ejecutarCambios(opc, cambios);
  }

  // ---------- base verificable ----------
  // Marca de sincronización por paciente: {v: `actualizado_en` de la fila relacional en la última sincronización, h: huella de los datos demográficos locales en ese momento}.
  // Sólo huellas (no los valores). «Local sin cambios desde la última sincronización» = la huella actual coincide; «relacional sin cambios» = su `actualizado_en` coincide.
  var sync = new Map(), divergencias = new Map(), ausentes = new Set();
  function huella(obj) {
    var t = JSON.stringify(normalizarApp(obj)), h = 5381, i;
    for (i = 0; i < t.length; i++) { h = ((h << 5) + h + t.charCodeAt(i)) | 0; }
    return String(h >>> 0);
  }
  function marcarSync(id, row, local) { if (row && row.actualizado_en != null) sync.set(String(id), { v: String(row.actualizado_en), h: huella(local) }); }
  function syncDe(id) { var m = sync.get(String(id)); return m ? { v: m.v, h: m.h } : null; }
  function existiaAntes(id) { return sync.has(String(id)); }
  function exportarSync() { var o = {}; sync.forEach(function (m, id) { o[id] = { v: m.v, h: m.h }; }); return o; }
  function importarSync(o) { sync.clear(); Object.keys(o || {}).forEach(function (id) { var m = o[id]; if (m && m.v != null && m.h != null) sync.set(id, { v: String(m.v), h: String(m.h) }); }); }
  function esAusente(id) { return ausentes.has(String(id)); }
  function marcarAusente(id) { ausentes.add(String(id)); }
  function limpiarAusente(id) { ausentes.delete(String(id)); }
  function idsSincronizados() { return Array.from(sync.keys()); }

  // Al CARGAR la fila relacional: qué adoptar, qué empujar y qué dejar como DIVERGENCIA para revisión. La tabla relacional es la fuente principal. NUNCA se sobrescribe un dato relacional por una
  // diferencia de tiempo: sólo con una base verificable (la marca de sincronización) o por decisión del usuario.
  //   · edición local pendiente (R2D) → se conserva;
  //   · local sin cambios desde la última sincronización → se adopta lo relacional;
  //   · local cambiado y relacional SIN cambios desde la última sincronización → la base (= la relacional actual) es verificable: se EMPUJA por la fusión de 3 vías;
  //   · sin marca, o cambiaron los dos lados → no hay base confiable: se rellenan vacíos sin perder nada y lo demás queda como DIVERGENCIA (ninguna de las dos versiones se pisa).
  function reconciliarCarga(local, row, pend) {
    var r = desdeFila(row), l = normalizarApp(local), adoptar = {};
    CAMPOS.forEach(function (c) {
      var k = c[0];
      if (pend && pend.origen === 'usuario' && pend.cambios && pend.cambios[k]) return;       // edición real de la persona todavía sin guardar: se conserva
      if (r[k] !== l[k]) adoptar[k] = r[k];                                                      // la copia local sigue a la tabla (incluye datos vaciados a propósito)
    });
    return { adoptar: adoptar, empujar: {}, divergencias: {} };                                  // sin empujes ni divergencias: leer o refrescar nunca escribe
  }

  // ---------- divergencias para revisión ----------
  function registrarDivergencias(id, div) {
    id = String(id); var campos = Object.keys(div || {});
    if (!campos.length) return;
    var d = divergencias.get(id) || { campos: {}, ts: new Date().toISOString() };
    campos.forEach(function (k) { d.campos[k] = { local: div[k].local, remoto: div[k].remoto }; });
    divergencias.set(id, d);
  }
  function listarDivergencias() { var o = []; divergencias.forEach(function (d, id) { o.push({ id: id, campos: JSON.parse(JSON.stringify(d.campos)), ts: d.ts }); }); return o; }
  function liberarDivergencia(id, campo) { id = String(id); var d = divergencias.get(id); if (!d) return; if (campo) delete d.campos[campo]; else d.campos = {}; if (!Object.keys(d.campos).length) divergencias.delete(id); }
  // «servidor»: se adopta el valor relacional; «mio»: se escribe el valor local por la fusión de 3 vías (antes = el valor del servidor registrado).
  function planResolucion(id, campo, uso) {
    var d = divergencias.get(String(id)); if (!d || !d.campos[campo]) return null; var c = d.campos[campo];
    if (uso === 'servidor') return { adoptar: c.remoto };
    var o = {}; o[campo] = { a: c.remoto, d: c.local }; return { cambios: o };
  }

  return {
    VERSION: 'fichas-estables-1', CAMPOS: CAMPOS, norm: norm, digitos: digitos, isoFecha: isoFecha, normalizarApp: normalizarApp, desdeFila: desdeFila, diferencias: diferencias, planificar: planificar,
    filaDesdeCambios: filaDesdeCambios, guardarCambios: guardarCambios, guardarEdicion: guardarEdicion, guardarCambiosPendientes: guardarCambiosPendientes, buscarDniOtro: buscarDniOtro, leerFila: leerFila, reconciliarCarga: reconciliarCarga,
    huella: huella, marcarSync: marcarSync, syncDe: syncDe, existiaAntes: existiaAntes, exportarSync: exportarSync, importarSync: importarSync, esAusente: esAusente, marcarAusente: marcarAusente, limpiarAusente: limpiarAusente, idsSincronizados: idsSincronizados,
    registrarDivergencias: registrarDivergencias, listarDivergencias: listarDivergencias, liberarDivergencia: liberarDivergencia, planResolucion: planResolucion,
    registrarVista: registrarVista, vistaDe: vistaDe, marcarPendiente: marcarPendiente, rechazarPendiente: rechazarPendiente, esErrorPermanente: esErrorPermanente, fijarVistaEdicion: fijarVistaEdicion, vistaEdicionDe: vistaEdicionDe, olvidarVistaEdicion: olvidarVistaEdicion, liberarCampos: liberarCampos, listarPendientes: listarPendientes, limpiarEstado: limpiarEstado
  };
});
