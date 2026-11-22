/* CardioLink · Guardado clínico multidispositivo · EVOLUCIONES EXISTENTES (cardiolink_hc_evoluciones).
   Módulo sin globales de la app: recibe el cliente Supabase y devuelve resultados. Node (tests) y navegador (window.cardiolinkHcEvolucionV1).
   Misma regla que el resumen clínico (cardiolink-hc-resumen-v1.js), aplicada a una evolución ya guardada.

   REGLAS
    · Se escriben SÓLO los campos que la persona cambió (diferencia entre lo que vio al abrir —`base`— y lo que dejó escrito —`nuevo`—). El resto de la fila (fecha, profesional,
      creación, temperatura, adjuntos, otros campos) NO se envía: jamás se reescribe la evolución completa.
    · Fusión de tres vías por campo contra una relectura fresca de la fila:
        remoto == base  → se aplica | remoto == nuevo → ya estaba | otro valor → CONFLICTO REAL (los textos clínicos NUNCA se fusionan solos: se pregunta).
      Los campos sin conflicto se guardan igual (PC e iPad que cambian campos distintos conservan ambos cambios, sin avisos).
    · ATOMICIDAD (sin SQL nuevo): el UPDATE va condicionado a `editado_en` de la fila leída (compare-and-swap en UNA sentencia). Si otra sesión escribió en medio, afecta 0 filas y se
      relee y se vuelve a fusionar (≤ MAX_REINTENTOS). Nunca SELECT seguido de UPDATE sin condición efectiva. La marca nueva es siempre posterior a la leída.
    · El IMC es derivado: si cambia el peso o la talla se recalcula con los valores FINALES (los fusionados), nunca con los de un solo dispositivo.
    · «Reemplazo confirmado»: `resolucion[campo] = <valor guardado que la persona vio en la pregunta>`; sólo se pisa si el valor guardado SIGUE siendo ese (si cambió otra vez, se vuelve a preguntar).
      «Conservar lo guardado»: `omitir = [campos]` → no se escriben ni se vuelven a preguntar.
    · Una evolución que ya no existe en la base (eliminada desde otro dispositivo) NO se recrea: estado 'ausente'.
    · «Confirmada» sólo cuando el servidor devolvió la fila actualizada con los valores pedidos. */
(function (raiz, fabrica) {
  'use strict';
  var api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.cardiolinkHcEvolucionV1 = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var TABLA = 'cardiolink_hc_evoluciones', MAX_REINTENTOS = 4;
  // [campo de la app, columna, etiqueta, tipo]
  var CAMPOS = [
    ['motivo', 'motivo', 'Motivo de consulta', 'texto'], ['evolucion', 'evolucion', 'Evolución', 'texto'], ['diagnostico', 'diagnostico', 'Diagnóstico', 'texto'], ['conducta', 'conducta', 'Conducta', 'texto'],
    ['pesoKg', 'peso_kg', 'Peso', 'num'], ['tallaCm', 'talla_cm', 'Talla', 'num'], ['taSistolica', 'ta_sistolica', 'Tensión sistólica', 'num'], ['taDiastolica', 'ta_diastolica', 'Tensión diastólica', 'num'],
    ['frecuenciaCardiaca', 'frecuencia_cardiaca', 'Frecuencia cardíaca', 'num'], ['sato2', 'sato2', 'Saturación', 'num']
  ];
  var POR_CAMPO = {}; CAMPOS.forEach(function (c) { POR_CAMPO[c[0]] = c; });

  function esPermiso(e) { return !!e && (e.code === '42501' || /row-level security|permission denied/i.test(String(e.message || ''))); }
  // Normalización para COMPARAR (no para guardar): texto recortado; número como Number o null (vacío = null); '' y null son lo mismo.
  function norm(campo, v) {
    var t = POR_CAMPO[campo] ? POR_CAMPO[campo][3] : 'texto';
    if (t === 'num') { if (v === null || v === undefined || v === '') return null; var n = Number(String(v).replace(',', '.')); return isFinite(n) ? n : null; }
    return String(v == null ? '' : v).trim();
  }
  function iguales(campo, a, b) { var x = norm(campo, a), y = norm(campo, b); if (typeof x === 'number' && typeof y === 'number') return Math.abs(x - y) <= 1e-8; return x === y; }
  function paraGuardar(campo, v) { var n = norm(campo, v); return (n === '' ? null : n); }    // vacío → null (igual que el guardado anterior)
  function desdeFila(f) { var o = {}; CAMPOS.forEach(function (c) { o[c[0]] = f ? f[c[1]] : null; }); return o; }
  function mostrar(campo, v) { var n = norm(campo, v); return n === null ? '' : String(n); }

  // Campos que la persona cambió: { campo: {a, d} } (sólo los presentes en `nuevo`)
  function diferencias(base, nuevo) {
    var o = {}; base = base || {}; nuevo = nuevo || {};
    CAMPOS.forEach(function (c) { var k = c[0]; if (k in nuevo && !iguales(k, base[k], nuevo[k])) o[k] = { a: base[k], d: nuevo[k] }; });
    return o;
  }
  function planificar(cambios, remoto, resolucion, omitir) {
    var plan = { aplicar: {}, ya: [], conflictos: [], omitidos: [] }; resolucion = resolucion || {}; omitir = omitir || [];
    Object.keys(cambios).forEach(function (k) {
      var c = cambios[k], rv = remoto[POR_CAMPO[k][1]];
      if (omitir.indexOf(k) >= 0) plan.omitidos.push(k);
      else if (iguales(k, rv, c.a)) plan.aplicar[k] = c.d;
      else if (iguales(k, rv, c.d)) plan.ya.push(k);
      else if (k in resolucion && iguales(k, resolucion[k], rv)) plan.aplicar[k] = c.d;
      else plan.conflictos.push({ campo: k, etiqueta: POR_CAMPO[k][2], remoto: mostrar(k, rv), mio: mostrar(k, c.d) });
    });
    return plan;
  }
  function siguienteMarca(ahora, previa) {
    var t = ahora(); if (previa != null) { var a = Date.parse(t), b = Date.parse(previa); if (isFinite(b) && (!isFinite(a) || a <= b)) t = new Date(b + 1).toISOString(); }
    return t;
  }

  // opc: { sb, id, base, nuevo, usuario, ahora, resolucion, omitir, imc(peso,talla) }
  // Devuelve { estado:'sin_cambios' } | { estado:'confirmado', fila, aplicados[], ya[], omitidos[], conflictos:[] } | { estado:'conflicto', fila, ..., conflictos:[{campo,etiqueta,remoto,mio}] }
  //        | { estado:'ausente' } | { estado:'error', error, permiso, transitorio, reintentosAgotados? }
  async function guardarEvolucion(opc) {
    var sb = opc.sb, id = String(opc.id), ahora = opc.ahora || function () { return new Date().toISOString(); };
    var cambios = diferencias(opc.base, opc.nuevo);
    if (!Object.keys(cambios).length) return { estado: 'sin_cambios' };
    var intento = 0;
    while (intento < MAX_REINTENTOS) {
      intento++;
      var lec = await sb.from(TABLA).select('*').eq('id', id).limit(1);
      if (lec.error) return { estado: 'error', error: lec.error, permiso: esPermiso(lec.error), transitorio: !esPermiso(lec.error) };
      var fila = Array.isArray(lec.data) ? lec.data[0] : lec.data;
      if (!fila) return { estado: 'ausente' };
      var plan = planificar(cambios, fila, opc.resolucion, opc.omitir), cols = {};
      Object.keys(plan.aplicar).forEach(function (k) { cols[POR_CAMPO[k][1]] = paraGuardar(k, plan.aplicar[k]); });
      if (!Object.keys(cols).length) return { estado: plan.conflictos.length ? 'conflicto' : 'confirmado', fila: fila, aplicados: [], ya: plan.ya, omitidos: plan.omitidos, conflictos: plan.conflictos, sinEscritura: true };
      if (('peso_kg' in cols || 'talla_cm' in cols) && typeof opc.imc === 'function') {           // IMC derivado de los valores FINALES (fusionados)
        var peso = 'peso_kg' in cols ? cols.peso_kg : fila.peso_kg, talla = 'talla_cm' in cols ? cols.talla_cm : fila.talla_cm;
        cols.imc = opc.imc(peso, talla);
      }
      cols.editado_en = siguienteMarca(ahora, fila.editado_en); cols.editado_por = opc.usuario || '';
      var q = sb.from(TABLA).update(cols).eq('id', id);
      q = (fila.editado_en == null) ? q.is('editado_en', null) : q.eq('editado_en', fila.editado_en);   // compare-and-swap: una sola sentencia atómica
      var up = await q.select('*');
      if (up.error) return { estado: 'error', error: up.error, permiso: esPermiso(up.error), transitorio: !esPermiso(up.error) };
      var filas = Array.isArray(up.data) ? up.data : (up.data ? [up.data] : []);
      if (!filas.length) continue;                                          // otra sesión escribió entre la lectura y el UPDATE (o la evolución desapareció): se relee y se vuelve a fusionar
      var conf = filas[0], ok = true;
      Object.keys(plan.aplicar).forEach(function (k) { if (!iguales(k, conf[POR_CAMPO[k][1]], paraGuardar(k, plan.aplicar[k]))) ok = false; });
      if (!ok) return { estado: 'error', error: { message: 'El servidor respondió, pero los valores guardados no coinciden con lo pedido.' }, transitorio: true };
      return { estado: plan.conflictos.length ? 'conflicto' : 'confirmado', fila: conf, aplicados: Object.keys(plan.aplicar), ya: plan.ya, omitidos: plan.omitidos, conflictos: plan.conflictos };
    }
    return { estado: 'error', error: { message: 'La evolución cambió varias veces mientras se guardaba (otro dispositivo escribe a la vez).' }, transitorio: true, reintentosAgotados: true };
  }

  return { CAMPOS: CAMPOS, MAX_REINTENTOS: MAX_REINTENTOS, norm: norm, desdeFila: desdeFila, diferencias: diferencias, planificar: planificar, guardarEvolucion: guardarEvolucion };
});
