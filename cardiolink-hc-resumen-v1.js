/* CardioLink · Guardado clínico multidispositivo · Resumen clínico (antecedentes, alergias, medicación habitual, alertas) en cardiolink_hc_resumen.
   Módulo sin globales de la app: recibe el cliente Supabase y devuelve resultados. Node (tests) y navegador (window.cardiolinkHcResumenV1).

   REGLAS
    · Se escriben SÓLO los campos que el usuario cambió (diferencia entre lo que vio al abrir —`base`— y lo que dejó escrito —`nuevo`—). Abrir, leer o guardar sin cambios NO escribe.
    · Fusión de tres vías por campo contra una relectura fresca de la fila:
        remoto == base  → se aplica (otro dispositivo no tocó ese dato)
        remoto == nuevo → ya estaba (no se reescribe)
        otro valor      → CONFLICTO REAL: no se pisa. Se devuelve para que la persona decida («Conservar lo guardado» / «Guardar mi modificación»).
      Los campos sin conflicto se guardan igual (dos dispositivos que cambian datos distintos conservan ambos cambios, sin avisos).
    · ATOMICIDAD (sin SQL nuevo): el UPDATE va condicionado a `actualizado_en` de la fila leída (compare-and-swap en una sola sentencia). Si otra sesión escribió en medio, el UPDATE
      afecta 0 filas y se relee y se vuelve a fusionar (≤ MAX_REINTENTOS). Nunca hay SELECT seguido de UPDATE sin condición efectiva, ni upsert de la fila completa de una fila existente.
    · «Reemplazo confirmado»: `resolucion[campo] = <valor guardado que la persona vio en la pregunta>`. Sólo se pisa si el valor guardado SIGUE siendo ese; si cambió otra vez, se vuelve a preguntar.
    · «Conservar lo guardado»: `omitir = [campos]` → esos campos no se escriben ni se vuelven a preguntar en esta operación.
    · «Confirmada» sólo cuando el servidor devolvió la fila actualizada con los valores pedidos.
    · Si la fila no existe se CREA con INSERT (nunca upsert); un 23505 (otra sesión la creó a la vez) se relee y se fusiona. Un error de clave foránea (23503) se devuelve tal cual. */
(function (raiz, fabrica) {
  'use strict';
  var api = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.cardiolinkHcResumenV1 = api;
})(typeof self !== 'undefined' ? self : this, function (raiz) {
  'use strict';
  var TABLA = 'cardiolink_hc_resumen', MAX_REINTENTOS = 4;
  // [campo de la app, columna, etiqueta para la persona]
  var CAMPOS = [['antecedentes', 'antecedentes', 'Antecedentes'], ['alergias', 'alergias', 'Alergias'], ['medicacion', 'medicacion_habitual', 'Medicación habitual'], ['alertas', 'alertas', 'Alertas clínicas']];
  var POR_CAMPO = {}; CAMPOS.forEach(function (c) { POR_CAMPO[c[0]] = c; });

  function norm(v) { return String(v == null ? '' : v).trim(); }
  function esPermiso(e) { return !!e && (e.code === '42501' || /row-level security|permission denied/i.test(String(e.message || ''))); }
  function desdeFila(f) { var o = {}; CAMPOS.forEach(function (c) { o[c[0]] = f ? String(f[c[1]] == null ? '' : f[c[1]]) : ''; }); return o; }
  // Campos que la persona cambió respecto de lo que vio al abrir: { campo: {a, d} }
  function diferencias(base, nuevo) {
    var o = {}; base = base || {}; nuevo = nuevo || {};
    CAMPOS.forEach(function (c) { var k = c[0]; if (k in nuevo && norm(base[k]) !== norm(nuevo[k])) o[k] = { a: norm(base[k]), d: norm(nuevo[k]) }; });
    return o;
  }
  // Fusión de tres vías de UNA fila remota: { aplicar:{campo:valor}, ya:[campo], conflictos:[{campo,etiqueta,remoto,mio}] }
  function planificar(cambios, remoto, resolucion, omitir) {
    var r = desdeFila(remoto), plan = { aplicar: {}, ya: [], conflictos: [], omitidos: [] }; resolucion = resolucion || {}; omitir = omitir || [];
    Object.keys(cambios).forEach(function (k) {
      var c = cambios[k], rv = norm(r[k]);
      if (omitir.indexOf(k) >= 0) plan.omitidos.push(k);
      else if (rv === c.a) plan.aplicar[k] = c.d;
      else if (rv === c.d) plan.ya.push(k);
      else if (k in resolucion && norm(resolucion[k]) === rv) plan.aplicar[k] = c.d;   // reemplazo confirmado sobre EL MISMO valor que se mostró
      else plan.conflictos.push({ campo: k, etiqueta: POR_CAMPO[k][2], remoto: r[k], mio: c.d });
    });
    return plan;
  }
  function filaCompleta(id, nuevo, usuario, ts) {
    var f = { paciente_id: String(id), actualizado_en: ts, actualizado_por: usuario || '' };
    CAMPOS.forEach(function (c) { f[c[1]] = norm(nuevo[c[0]]); });
    return f;
  }
  function siguienteMarca(ahora, previa) {   // siempre distinta y posterior a la marca leída (aunque el reloj del equipo esté atrasado)
    var t = ahora(); if (previa != null) { var a = Date.parse(t), b = Date.parse(previa); if (isFinite(b) && (!isFinite(a) || a <= b)) t = new Date(b + 1).toISOString(); }
    return t;
  }

  // opc: { sb, id, base, nuevo, usuario, ahora, resolucion, omitir }
  // Devuelve { estado:'sin_cambios' }
  //        | { estado:'confirmado', fila, aplicados[], ya[], omitidos[], conflictos:[] , creada? }
  //        | { estado:'conflicto', fila, aplicados[], ya[], omitidos[], conflictos:[{campo,etiqueta,remoto,mio}] }   (lo que no tiene conflicto YA quedó guardado)
  //        | { estado:'error', error, permiso, transitorio, reintentosAgotados? }
  async function guardarResumen(opc) {
    var sb = opc.sb, id = String(opc.id), ahora = opc.ahora || function () { return new Date().toISOString(); };
    var cambios = diferencias(opc.base, opc.nuevo);
    if (!Object.keys(cambios).length) return { estado: 'sin_cambios' };
    var intento = 0;
    while (intento < MAX_REINTENTOS) {
      intento++;
      var lec = await sb.from(TABLA).select('*').eq('paciente_id', id).limit(1);
      if (lec.error) return { estado: 'error', error: lec.error, permiso: esPermiso(lec.error), transitorio: !esPermiso(lec.error) };
      var fila = Array.isArray(lec.data) ? lec.data[0] : lec.data;
      if (!fila) {                                                          // todavía no hay resumen de este paciente: se crea (INSERT, nunca upsert)
        var omit = opc.omitir || [], completo = {}; CAMPOS.forEach(function (c) { completo[c[0]] = omit.indexOf(c[0]) >= 0 ? '' : opc.nuevo[c[0]]; });
        var ins = await sb.from(TABLA).insert([filaCompleta(id, completo, opc.usuario, ahora())]).select('*');
        if (ins.error) {
          if (ins.error.code === '23505') continue;                         // otra sesión lo creó a la vez: se relee y se fusiona
          return { estado: 'error', error: ins.error, permiso: esPermiso(ins.error), transitorio: !esPermiso(ins.error) };
        }
        var creada = Array.isArray(ins.data) ? ins.data[0] : ins.data;
        if (!creada) return { estado: 'error', error: { message: 'El servidor no devolvió el resumen creado.' }, transitorio: true };
        return { estado: 'confirmado', fila: creada, aplicados: Object.keys(cambios).filter(function (k) { return omit.indexOf(k) < 0; }), ya: [], omitidos: omit.slice(), conflictos: [], creada: true };
      }
      var plan = planificar(cambios, fila, opc.resolucion, opc.omitir), cols = {};
      Object.keys(plan.aplicar).forEach(function (k) { cols[POR_CAMPO[k][1]] = plan.aplicar[k]; });
      if (!Object.keys(cols).length) {
        return { estado: plan.conflictos.length ? 'conflicto' : 'confirmado', fila: fila, aplicados: [], ya: plan.ya, omitidos: plan.omitidos, conflictos: plan.conflictos, sinEscritura: true };
      }
      cols.actualizado_en = siguienteMarca(ahora, fila.actualizado_en); cols.actualizado_por = opc.usuario || '';
      var q = sb.from(TABLA).update(cols).eq('paciente_id', id);
      q = (fila.actualizado_en == null) ? q.is('actualizado_en', null) : q.eq('actualizado_en', fila.actualizado_en);   // compare-and-swap: una sola sentencia atómica
      var up = await q.select('*');
      if (up.error) return { estado: 'error', error: up.error, permiso: esPermiso(up.error), transitorio: !esPermiso(up.error) };
      var filas = Array.isArray(up.data) ? up.data : (up.data ? [up.data] : []);
      if (!filas.length) continue;                                          // otra sesión escribió entre la lectura y el UPDATE: se relee y se vuelve a fusionar
      var conf = filas[0], visto = desdeFila(conf), ok = true;
      Object.keys(plan.aplicar).forEach(function (k) { if (norm(visto[k]) !== norm(plan.aplicar[k])) ok = false; });
      if (!ok) return { estado: 'error', error: { message: 'El servidor respondió, pero los valores guardados no coinciden con lo pedido.' }, transitorio: true };
      return { estado: plan.conflictos.length ? 'conflicto' : 'confirmado', fila: conf, aplicados: Object.keys(plan.aplicar), ya: plan.ya, omitidos: plan.omitidos, conflictos: plan.conflictos };
    }
    return { estado: 'error', error: { message: 'El resumen cambió varias veces mientras se guardaba (otro dispositivo escribe a la vez).' }, transitorio: true, reintentosAgotados: true };
  }

  // ---------- pregunta única (sólo navegador) ----------
  // Devuelve una promesa: 'mio' (Guardar mi modificación) | 'conservar' (Conservar lo guardado). Nunca elige sola. Sin términos técnicos.
  function preguntarReemplazo(conflictos) {
    var doc = raiz && raiz.document; if (!doc || !doc.body) return Promise.resolve('conservar');
    return new Promise(function (resolver) {
      var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
      var tx = function (s) { s = String(s == null ? '' : s).trim(); return s ? esc(s.length > 400 ? s.slice(0, 400) + '…' : s) : '<i>(vacío)</i>'; };
      var d = doc.createElement('div'); d.id = 'hcConfirmarReemplazoV1'; d.setAttribute('role', 'alertdialog'); d.setAttribute('aria-modal', 'true');
      d.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.6);z-index:100002;display:flex;align-items:center;justify-content:center;padding:16px';
      var lista = conflictos.map(function (c) {
        return '<div style="margin:10px 0;padding:10px;border:1px solid #e2e8f0;border-radius:10px"><b>' + esc(c.etiqueta) + '</b>'
          + '<div style="margin-top:4px"><span style="color:#475569">Guardado:</span> ' + tx(c.remoto) + '</div>'
          + '<div style="margin-top:4px"><span style="color:#475569">Tu modificación:</span> ' + tx(c.mio) + '</div></div>';
      }).join('');
      d.innerHTML = '<div style="background:#fff;color:#0f172a;border-radius:14px;max-width:520px;width:100%;max-height:88vh;overflow:auto;padding:20px;font:14px/1.45 system-ui,sans-serif;box-shadow:0 20px 60px rgba(0,0,0,.4)">'
        + '<h3 style="margin:0 0 6px">Este dato fue actualizado desde otro dispositivo.</h3>' + lista + '<p style="margin:8px 0 12px;font-weight:600">¿Querés guardar tu modificación?</p>'
        + '<div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" data-r="conservar" style="border:0;border-radius:10px;padding:10px 14px;font-weight:700;cursor:pointer;background:#0f766e;color:#fff">Conservar lo guardado</button>'
        + '<button type="button" data-r="mio" style="border:0;border-radius:10px;padding:10px 14px;font-weight:700;cursor:pointer;background:#e2e8f0;color:#0f172a">Guardar mi modificación</button></div></div>';
      d.addEventListener('click', function (ev) { var b = ev.target && ev.target.closest && ev.target.closest('button[data-r]'); if (!b) return; var r = b.getAttribute('data-r'); d.remove(); resolver(r); });
      doc.body.appendChild(d); try { d.querySelector('button[data-r="conservar"]').focus(); } catch (e) { /* sin foco */ }
    });
  }


  // ---------- avisos dentro del formulario abierto (sólo navegador) ----------
  function etiquetasDe(campos) { return (campos || []).map(function (k) { return POR_CAMPO[k] ? POR_CAMPO[k][2] : k; }); }
  // tipo: 'info' (se conservó lo guardado; el texto de la persona sigue escrito) | 'error'. No cierra el formulario ni toca lo escrito.
  function avisar(contenedor, texto, tipo) {
    try {
      if (!contenedor) return; var doc = contenedor.ownerDocument, b = contenedor.querySelector('#hcAvisoResumenV1');
      if (!b) { b = doc.createElement('div'); b.id = 'hcAvisoResumenV1'; var acciones = contenedor.querySelector('.hc-modal-actions'); if (acciones && acciones.parentNode) acciones.parentNode.insertBefore(b, acciones); else contenedor.appendChild(b); }
      b.setAttribute('role', tipo === 'error' ? 'alert' : 'status');
      b.style.cssText = 'margin:8px 0;padding:10px 12px;border-radius:10px;font-weight:700;font-size:13px;line-height:1.35;' + (tipo === 'error' ? 'background:#fee2e2;color:#7f1d1d;border:1px solid #fca5a5' : 'background:#ecfeff;color:#134e4a;border:1px solid #99f6e4');
      b.textContent = texto; try { b.scrollIntoView({ block: 'nearest' }); } catch (e) { /* sin scroll */ }
    } catch (e) { /* sin interfaz */ }
  }
  function quitarAviso(contenedor) { try { var b = contenedor && contenedor.querySelector('#hcAvisoResumenV1'); if (b) b.remove(); } catch (e) { /* */ } }
  function avisarConservado(contenedor, campos) {
    var et = etiquetasDe(campos).join(', ');
    avisar(contenedor, 'Se conservó lo que ya estaba guardado' + (et ? ' en: ' + et : '') + '. Tu texto sigue escrito acá por si querés usarlo; cuando termines, cerrá esta ventana.', 'info');
  }

  return { CAMPOS: CAMPOS, MAX_REINTENTOS: MAX_REINTENTOS, norm: norm, desdeFila: desdeFila, diferencias: diferencias, planificar: planificar, guardarResumen: guardarResumen, preguntarReemplazo: preguntarReemplazo, etiquetasDe: etiquetasDe, avisar: avisar, quitarAviso: quitarAviso, avisarConservado: avisarConservado };
});
