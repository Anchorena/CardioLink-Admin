/* =====================================================================
   CardioLink · Convenios y Aranceles V2 — NÚCLEO PURO (sin DOM, sin red)
   Reutiliza el modelo existente: config.arancelesPorProfesional[profId] = lista de filas
     { id, profesionalId, obraSocial, prestacion, valor, copago, vigenteDesde, activo }
   y agrega, sin romper a los consumidores actuales, campos opcionales:
     · valor: null          → «sin informar» (0 es un valor cero EXPLÍCITO)
     · archivado: true      → «lápida»: desde esa vigencia la serie queda archivada (no se borra nada y
                              NO reaparece un valor anterior; los históricos anteriores no cambian)
     · historial: [...]     → correcciones de la misma fila (misma vigencia), con fecha y valores previos
   Identidad de una fila: profesional + convenio + prestación + vigencia (sin duplicados; reimportar
   el mismo archivo no crea nada). Los vacíos NUNCA sobrescriben un valor existente.
   El copago de esta fila es INFORMATIVO: no alimenta a Caja (Caja usa copagoDePrestacion).
   ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CardioLinkArancelesV2 = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_HISTORIAL = 20;
  var seq = 0;

  function norm(s) {
    return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  }
  function esFecha(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
    var d = new Date(s + 'T12:00:00Z');
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }
  // dd/mm/aaaa, d/m/aa, aaaa-mm-dd → aaaa-mm-dd ('' si no se puede)
  function parsearFecha(t) {
    var s = String(t == null ? '' : t).trim();
    if (!s) return '';
    var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (!m) { m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})$/); if (m) m = [m[0], (m[3].length === 2 ? '20' + m[3] : m[3]), m[2], m[1]]; }
    if (!m) return '';
    var iso = m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
    return esFecha(iso) ? iso : '';
  }

  // Formato monetario argentino: «$ 35.000», «35.000,50», «35000», «35.5» (decimal con punto), vacío/«-»/«s/i» → sin dato.
  function parsearMonto(texto) {
    if (typeof texto === 'number') return Number.isFinite(texto) && texto >= 0 ? { ok: true, vacio: false, valor: Math.round(texto * 100) / 100 } : { ok: false, error: 'número inválido' };
    var s = String(texto == null ? '' : texto).replace(/ /g, ' ').trim();
    if (s === '' || /^(-|–|—|s\/i|n\/i|sin informar|sin dato|n\/a)$/i.test(s)) return { ok: true, vacio: true, valor: null };
    s = s.replace(/^\$\s*/, '').replace(/\s*(ars|pesos)$/i, '').replace(/\s+/g, '');
    if (/^-/.test(s)) return { ok: false, error: 'no puede ser negativo' };
    if (!/^\d[\d.,]*$/.test(s)) return { ok: false, error: 'no es un importe válido («' + String(texto).trim().slice(0, 30) + '»)' };
    var n;
    if (s.indexOf(',') >= 0) {
      // la coma es el decimal; los puntos, miles (deben estar bien agrupados)
      var p = s.split(',');
      if (p.length > 2 || !/^\d{1,2}$/.test(p[1] || '0') && p[1] !== '') return { ok: false, error: 'decimales inválidos' };
      if (!/^(\d{1,3}(\.\d{3})+|\d+)$/.test(p[0])) return { ok: false, error: 'separador de miles inválido' };
      n = Number(p[0].replace(/\./g, '') + '.' + (p[1] || '0'));
    } else if (s.indexOf('.') >= 0) {
      if (/^\d{1,3}(\.\d{3})+$/.test(s)) n = Number(s.replace(/\./g, ''));          // 35.000 → miles
      else if (/^\d+\.\d{1,2}$/.test(s)) n = Number(s);                              // 35.5 / 35.50 → decimal
      else return { ok: false, error: 'separador inválido («' + s.slice(0, 30) + '»)' };
    } else n = Number(s);
    if (!Number.isFinite(n) || n < 0) return { ok: false, error: 'importe inválido' };
    return { ok: true, vacio: false, valor: Math.round(n * 100) / 100 };
  }

  // CSV / TSV (pegado desde Excel). Delimitador: tab > «;» > «,». Soporta comillas.
  function parsearTabla(texto) {
    var t = String(texto == null ? '' : texto).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    var primera = (t.split('\n').find(function (l) { return l.trim() !== ''; }) || '');
    var d = primera.indexOf('\t') >= 0 ? '\t' : (primera.indexOf(';') >= 0 ? ';' : ',');
    var filas = [], fila = [], cel = '', q = false, i, c;
    for (i = 0; i < t.length; i++) {
      c = t[i];
      if (q) { if (c === '"') { if (t[i + 1] === '"') { cel += '"'; i++; } else q = false; } else cel += c; }
      else if (c === '"' && cel === '') q = true;
      else if (c === d) { fila.push(cel); cel = ''; }
      else if (c === '\n') { fila.push(cel); filas.push(fila); fila = []; cel = ''; }
      else cel += c;
    }
    fila.push(cel); filas.push(fila);
    return filas.filter(function (f) { return f.some(function (x) { return String(x).trim() !== ''; }); })
      .map(function (f) { return f.map(function (x) { return String(x).trim(); }); });
  }

  function listaDe(config, pid) {
    var m = config && config.arancelesPorProfesional;
    return m && Array.isArray(m[pid]) ? m[pid] : [];
  }
  function filaActiva(f) { return f && f.activo !== false; }
  function mismaSerie(f, os, prest) { return norm(f.obraSocial) === norm(os) && norm(f.prestacion) === norm(prest); }
  function valorNum(f) { return f && f.valor !== null && f.valor !== undefined && f.valor !== '' && Number.isFinite(Number(f.valor)) ? Number(f.valor) : null; }

  // Fila vigente a una fecha. Desempate: gana la más reciente por vigencia y, a igual vigencia, la última de la lista.
  function vigente(config, pid, os, prest, fecha) {
    var mejor = null, idx = -1;
    listaDe(config, pid).forEach(function (f, i) {
      if (!filaActiva(f) || !mismaSerie(f, os, prest)) return;
      if (f.vigenteDesde && f.vigenteDesde > fecha) return;
      if (!mejor || String(f.vigenteDesde || '') >= String(mejor.vigenteDesde || '')) { mejor = f; idx = i; }
    });
    if (!mejor) return { fila: null, estado: 'sin_fila' };
    if (mejor.archivado) return { fila: mejor, estado: 'archivado' };
    return { fila: mejor, estado: valorNum(mejor) === null ? 'sin_informar' : 'valor' };
  }
  function filaExacta(config, pid, os, prest, vig) {
    var r = null;
    listaDe(config, pid).forEach(function (f) { if (filaActiva(f) && mismaSerie(f, os, prest) && f.vigenteDesde === vig) r = f; });
    return r;
  }
  function serie(config, pid, os, prest) {
    return listaDe(config, pid).filter(function (f) { return mismaSerie(f, os, prest); })
      .sort(function (a, b) { return String(b.vigenteDesde || '').localeCompare(String(a.vigenteDesde || '')); });
  }

  function nuevoId() { seq++; return 'arp_' + Date.now() + '_' + seq + '_' + Math.random().toString(36).slice(2, 6); }
  function clonar(x) { return JSON.parse(JSON.stringify(x)); }

  // Decide qué hacer con UN cambio {os, prest, campo:'valor'|'copago', valor:number|null, vacio?:bool} contra las filas (clonadas o reales).
  function decidir(config, pid, cambio, vig) {
    var os = cambio.os, prest = cambio.prest, campo = cambio.campo === 'copago' ? 'copago' : 'valor';
    if (cambio.vacio || cambio.valor === null || cambio.valor === undefined) return { accion: 'vacio' };            // un vacío no sobrescribe nada
    if (!Number.isFinite(cambio.valor) || cambio.valor < 0) return { accion: 'error', motivo: 'importe inválido' };
    var n = cambio.valor;
    var v = vigente(config, pid, os, prest, vig);
    var ex = filaExacta(config, pid, os, prest, vig);
    var previo = ex ? (campo === 'valor' ? valorNum(ex) : (Number.isFinite(Number(ex.copago)) && ex.copago !== null ? Number(ex.copago) : null)) : null;
    if (ex) {
      if (!ex.archivado && previo === n) return { accion: 'igual', antes: previo, despues: n };
      return { accion: 'actualiza', fila: ex, campo: campo, antes: previo, despues: n, reactiva: !!ex.archivado };
    }
    var base = v.estado === 'valor' || v.estado === 'sin_informar' ? v.fila : null;     // se arrastra el otro campo desde lo vigente (salvo lápida)
    var vigPrevio = base ? (campo === 'valor' ? valorNum(base) : (base.copago !== null && base.copago !== undefined && Number.isFinite(Number(base.copago)) ? Number(base.copago) : null)) : null;
    if (base && vigPrevio === n) return { accion: 'igual', antes: vigPrevio, despues: n };
    return { accion: 'nuevo', campo: campo, antes: vigPrevio, despues: n, base: base };
  }

  function ejecutar(config, pid, op, cambio, vig, meta) {
    var lista = (config.arancelesPorProfesional = config.arancelesPorProfesional || {})[pid] = listaDe(config, pid);
    meta = meta || {};
    var ahora = meta.ahora || new Date().toISOString();
    if (op.accion === 'actualiza') {
      var f = op.fila, h = f.historial = Array.isArray(f.historial) ? f.historial : [];
      h.push({ en: ahora, por: meta.por || '', valorAntes: f.valor === undefined ? null : f.valor, copagoAntes: f.copago === undefined ? null : f.copago, archivado: !!f.archivado, origen: meta.origen || 'grilla' });
      if (h.length > MAX_HISTORIAL) h.splice(0, h.length - MAX_HISTORIAL);
      if (op.campo === 'valor') f.valor = op.despues; else f.copago = op.despues;
      if (op.reactiva) delete f.archivado;
      f.actualizadoEn = ahora;
      return f;
    }
    if (op.accion === 'nuevo') {
      var b = op.base;
      var fila = {
        id: nuevoId(), profesionalId: pid, obraSocial: cambio.os, prestacion: cambio.prest,
        valor: op.campo === 'valor' ? op.despues : (b && valorNum(b) !== null ? valorNum(b) : null),
        copago: op.campo === 'copago' ? op.despues : (b && b.copago !== undefined && b.copago !== null && Number.isFinite(Number(b.copago)) ? Number(b.copago) : null),
        vigenteDesde: vig, activo: true, origen: meta.origen || 'grilla', creadoEn: ahora
      };
      lista.push(fila);
      return fila;
    }
    return null;
  }

  function espejoMatias(config, pid) {
    // El editor anterior mantiene arancelesConvenios como copia de los de «matias» (compatibilidad con el lector 3102).
    if (pid === 'matias') config.arancelesConvenios = clonar(listaDe(config, 'matias'));
  }

  // Simula sobre una copia (no toca config). Devuelve [{cambio, accion, antes, despues, ...}] y un resumen.
  function planificar(config, pid, cambios, vigencia) {
    if (!esFecha(vigencia)) return { ok: false, error: 'La vigencia no es una fecha válida.', items: [], resumen: {} };
    var sim = { arancelesPorProfesional: {} };
    sim.arancelesPorProfesional[pid] = clonar(listaDe(config, pid));
    var items = (cambios || []).map(function (c) {
      var vig = c.vigencia || vigencia;
      if (!esFecha(vig)) return { cambio: c, accion: 'error', motivo: 'vigencia inválida' };
      var op = decidir(sim, pid, c, vig);
      var it = { cambio: c, vigencia: vig, accion: op.accion, antes: op.antes, despues: op.despues, motivo: op.motivo, reactiva: !!op.reactiva };
      if (op.accion === 'actualiza' || op.accion === 'nuevo') ejecutar(sim, pid, op, c, vig, { origen: 'simulacion' });
      return it;
    });
    var resumen = { nuevo: 0, actualiza: 0, igual: 0, vacio: 0, error: 0 };
    items.forEach(function (i) { resumen[i.accion] = (resumen[i.accion] || 0) + 1; });
    return { ok: true, items: items, resumen: resumen };
  }

  // Aplica de verdad. Devuelve {nuevo, actualiza, igual, vacio, error}.
  function aplicar(config, pid, cambios, vigencia, meta) {
    var r = { nuevo: 0, actualiza: 0, igual: 0, vacio: 0, error: 0 };
    if (!esFecha(vigencia)) { r.error = (cambios || []).length; return r; }
    (cambios || []).forEach(function (c) {
      var vig = c.vigencia || vigencia;
      if (!esFecha(vig)) { r.error++; return; }
      var op = decidir(config, pid, c, vig);
      if (op.accion === 'actualiza' || op.accion === 'nuevo') ejecutar(config, pid, op, c, vig, meta);
      r[op.accion] = (r[op.accion] || 0) + 1;
    });
    if (r.nuevo || r.actualiza) espejoMatias(config, pid);
    return r;
  }

  // Archivar la serie (convenio + prestación) DESDE una vigencia: lápida; no borra, no toca fechas anteriores, no reactiva valores previos.
  function archivarSerie(config, pid, os, prest, vigencia, meta) {
    if (!esFecha(vigencia)) return { ok: false, error: 'La vigencia no es una fecha válida.' };
    var v = vigente(config, pid, os, prest, vigencia);
    if (v.estado === 'sin_fila') return { ok: false, error: 'No hay valores cargados para archivar.' };
    if (v.estado === 'archivado') return { ok: false, error: 'La serie ya está archivada desde ' + v.fila.vigenteDesde + '.' };
    var ahora = (meta && meta.ahora) || new Date().toISOString();
    if (filaExacta(config, pid, os, prest, vigencia)) return { ok: false, error: 'Ya hay un valor con vigencia ' + vigencia + ': archivarlo ese día ocultaría un valor que ya rigió. Elegí una fecha posterior.' };
    (config.arancelesPorProfesional = config.arancelesPorProfesional || {})[pid] = listaDe(config, pid);
    config.arancelesPorProfesional[pid].push({ id: nuevoId(), profesionalId: pid, obraSocial: v.fila.obraSocial, prestacion: v.fila.prestacion, valor: null, copago: null, vigenteDesde: vigencia, activo: true, archivado: true, origen: 'archivar', creadoEn: ahora, creadoPor: (meta && meta.por) || '' });
    espejoMatias(config, pid);
    return { ok: true };
  }

  function historial(config, pid, os) {
    return listaDe(config, pid).filter(function (f) { return norm(f.obraSocial) === norm(os); })
      .map(function (f) {
        return { id: f.id, prestacion: f.prestacion, vigenteDesde: f.vigenteDesde || '', valor: valorNum(f), copago: f.copago === undefined || f.copago === null ? null : Number(f.copago), archivado: !!f.archivado, activa: filaActiva(f), correcciones: Array.isArray(f.historial) ? f.historial.length : 0, origen: f.origen || 'legado' };
      })
      .sort(function (a, b) { return norm(a.prestacion).localeCompare(norm(b.prestacion)) || String(b.vigenteDesde).localeCompare(String(a.vigenteDesde)); });
  }

  /* ---------------------------- Importación ---------------------------- */
  var ALIAS = {
    convenio: ['convenio', 'obra social', 'cobertura', 'os', 'prepaga', 'obra social/prepaga'],
    prestacion: ['prestacion', 'estudio', 'practica'],
    valor: ['valor', 'arancel', 'monto', 'importe', 'precio'],
    copago: ['copago'],
    vigencia: ['vigencia', 'vigente desde', 'desde', 'fecha'],
    profesional: ['profesional', 'medico']
  };
  function colDe(header, clave) {
    for (var i = 0; i < header.length; i++) if (ALIAS[clave].indexOf(norm(header[i])) >= 0) return i;
    return -1;
  }

  /* opciones: { profesionales:[{id,nombre}], prestaciones:[nombres del catálogo], coberturas:[nombres], profesionalId, vigencia, campoMatriz:'valor'|'copago', crearCoberturas:bool } */
  function planificarImportacion(config, texto, op) {
    var tabla = parsearTabla(texto);
    var res = { ok: true, error: '', formato: '', filas: [], nuevasCoberturas: [], resumen: { nuevo: 0, actualiza: 0, igual: 0, vacio: 0, error: 0 } };
    if (tabla.length < 2) { res.ok = false; res.error = 'No hay datos para importar (se necesita encabezado y al menos una fila).'; return res; }
    var header = tabla[0];
    var catPrest = {}; (op.prestaciones || []).forEach(function (p) { if (!catPrest[norm(p)]) catPrest[norm(p)] = p; });
    var catCob = {}; (op.coberturas || []).forEach(function (c) { if (!catCob[norm(c)]) catCob[norm(c)] = c; });
    var profs = op.profesionales || [];
    var celdas = [];   // {linea, pid, os, prest, campo, texto, vigTxt, error}
    var iConv = colDe(header, 'convenio'), iPrest = colDe(header, 'prestacion'), iVal = colDe(header, 'valor'), iCop = colDe(header, 'copago');
    var iVig = colDe(header, 'vigencia'), iProf = colDe(header, 'profesional');
    var largo = iConv >= 0 && iPrest >= 0 && (iVal >= 0 || iCop >= 0);
    if (largo) {
      res.formato = 'lista (convenio, prestación, valor…)';
      tabla.slice(1).forEach(function (f, k) {
        var base = { linea: k + 2, os: f[iConv], prest: f[iPrest], vigTxt: iVig >= 0 ? f[iVig] : '', profTxt: iProf >= 0 ? f[iProf] : '' };
        if (iVal >= 0) celdas.push(Object.assign({ campo: 'valor', texto: f[iVal] }, base));
        if (iCop >= 0) celdas.push(Object.assign({ campo: 'copago', texto: f[iCop], gemela: iVal >= 0 }, base));
      });
    } else {
      res.formato = 'matriz (filas = convenios, columnas = prestaciones)';
      var cols = header.slice(1);
      if (!cols.length || cols.every(function (c) { return c === ''; })) { res.ok = false; res.error = 'No se reconoció el encabezado: usá «Convenio, Prestación, Valor» o una matriz con las prestaciones en la primera fila.'; return res; }
      tabla.slice(1).forEach(function (f, k) {
        cols.forEach(function (pn, j) {
          if (pn === '') return;
          celdas.push({ linea: k + 2, os: f[0], prest: pn, campo: op.campoMatriz === 'copago' ? 'copago' : 'valor', texto: f[j + 1] === undefined ? '' : f[j + 1], vigTxt: '', profTxt: '' });
        });
      });
    }
    // Resolución + planificación (por profesional, contra una copia)
    var simPorProf = {};
    var vistos = {}, lineaConError = {};
    function falla(it, c, msg) { var mv = parsearMonto(c.texto); if (mv.ok && mv.vacio) return;   // una celda vacía no genera error aunque su fila/columna sea inválida: no hay nada que aplicar
      it.accion = 'error'; it.motivo = msg; lineaConError[c.linea] = true; if (!(c.gemela && lineaConError[c.linea + '#v'])) res.filas.push(it); if (!c.gemela) lineaConError[c.linea + '#v'] = true; }
    celdas.forEach(function (c) {
      var it = { linea: c.linea, convenio: c.os, prestacion: c.prest, campo: c.campo, texto: c.texto, accion: '', motivo: '' };
      var pid = op.profesionalId;
      if (c.profTxt) {
        var p = profs.filter(function (x) { return norm(x.id) === norm(c.profTxt) || norm(x.nombre) === norm(c.profTxt); })[0];
        if (!p) { falla(it, c, 'profesional no encontrado («' + c.profTxt + '»)'); return; }
        pid = p.id;
      }
      it.pid = pid;
      var vig = c.vigTxt ? parsearFecha(c.vigTxt) : op.vigencia;
      if (!esFecha(vig)) { falla(it, c, 'vigencia inválida («' + (c.vigTxt || op.vigencia || '') + '»)'); return; }
      it.vigencia = vig;
      var os = catCob[norm(c.os)];
      if (!norm(c.os)) { falla(it, c, 'convenio vacío'); return; }
      if (!os) {
        if (!op.crearCoberturas) { falla(it, c, 'convenio inexistente en el catálogo'); return; }
        os = String(c.os).trim(); catCob[norm(os)] = os; res.nuevasCoberturas.push(os); it.nuevaCobertura = true;
      } else if (res.nuevasCoberturas.indexOf(os) >= 0) it.nuevaCobertura = true;
      var prest = catPrest[norm(c.prest)];
      if (!prest) { falla(it, c, 'prestación inexistente en el catálogo («' + c.prest + '»)'); return; }
      it.os = os; it.prest = prest;
      var m = parsearMonto(c.texto);
      if (!m.ok) { it.accion = 'error'; it.motivo = m.error; res.filas.push(it); return; }
      var clave = [pid, norm(os), norm(prest), c.campo, vig].join('|');
      if (!m.vacio && Object.prototype.hasOwnProperty.call(vistos, clave)) {
        if (vistos[clave] === m.valor) { it.accion = 'igual'; it.motivo = 'repetida en el archivo'; it.despues = m.valor; res.filas.push(it); return; }
        it.accion = 'error'; it.motivo = 'conflicto: la misma combinación aparece con otro importe'; res.filas.push(it); return;
      }
      if (!m.vacio) vistos[clave] = m.valor;
      var sim = simPorProf[pid];
      if (!sim) { sim = simPorProf[pid] = { arancelesPorProfesional: {} }; sim.arancelesPorProfesional[pid] = clonar(listaDe(config, pid)); }
      var cambio = { os: os, prest: prest, campo: c.campo, valor: m.valor, vacio: m.vacio };
      var o = decidir(sim, pid, cambio, vig);
      it.accion = o.accion; it.antes = o.antes; it.despues = o.despues; it.motivo = o.motivo || (m.vacio ? 'vacío: no se modifica' : '');
      if (o.accion === 'actualiza' || o.accion === 'nuevo') ejecutar(sim, pid, o, cambio, vig, { origen: 'simulacion' });
      it.cambio = cambio;
      res.filas.push(it);
    });
    res.filas.forEach(function (f) { res.resumen[f.accion] = (res.resumen[f.accion] || 0) + 1; });
    // las coberturas «nuevas» sólo cuentan si alguna fila aplicable las usa
    res.nuevasCoberturas = res.nuevasCoberturas.filter(function (n) { return res.filas.some(function (f) { return f.os === n && (f.accion === 'nuevo' || f.accion === 'actualiza'); }); });
    return res;
  }

  // Aplica el plan de importación (sólo filas nuevo/actualiza; las demás no tienen efecto). Agrega al catálogo las coberturas nuevas.
  function aplicarImportacion(config, plan, meta) {
    var r = { nuevo: 0, actualiza: 0, igual: 0, vacio: 0, error: 0, coberturasNuevas: 0 };
    if (!plan || !plan.ok) return r;
    var pids = {};
    plan.filas.forEach(function (f) { if (f.cambio && f.pid) { (pids[f.pid] = pids[f.pid] || []).push(f); } else if (f.accion === 'error') r.error++; });
    (plan.nuevasCoberturas || []).forEach(function (n) {
      config.obrasSociales = Array.isArray(config.obrasSociales) ? config.obrasSociales : [];
      var ya = config.obrasSociales.some(function (x) { return norm(typeof x === 'string' ? x : (x && (x.nombre || x.label))) === norm(n); });
      if (!ya) { config.obrasSociales.push(n); r.coberturasNuevas++; }
    });
    Object.keys(pids).forEach(function (pid) {
      pids[pid].forEach(function (f) {
        var op = decidir(config, pid, f.cambio, f.vigencia);
        if (op.accion === 'actualiza' || op.accion === 'nuevo') ejecutar(config, pid, op, f.cambio, f.vigencia, Object.assign({}, meta, { origen: 'importacion' }));
        r[op.accion] = (r[op.accion] || 0) + 1;
      });
      espejoMatias(config, pid);
    });
    return r;
  }

  return {
    norm: norm, esFecha: esFecha, parsearFecha: parsearFecha, parsearMonto: parsearMonto, parsearTabla: parsearTabla,
    vigente: vigente, serie: serie, filaExacta: filaExacta, historial: historial, valorNum: valorNum,
    planificar: planificar, aplicar: aplicar, archivarSerie: archivarSerie,
    planificarImportacion: planificarImportacion, aplicarImportacion: aplicarImportacion
  };
});
