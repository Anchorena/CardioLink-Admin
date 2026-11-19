/* =====================================================================
   CardioLink · Convenios y Aranceles V2 — Paso 1 (interfaz)
   Grilla editable de aranceles (filas = convenios, columnas = prestaciones) por profesional y vigencia,
   guardado conjunto, importación masiva con vista previa e historial de valores.
   · Reutiliza la configuración existente (config.arancelesPorProfesional / conveniosPorProfesional): sin SQL.
   · El copago de la grilla es INFORMATIVO. Caja sigue usando copagoDePrestacion (Valores del profesional).
   · No toca Caja ni Finanzas. No cambia reglas, destinos ni facturantes de los convenios.
   · Corrige el recálculo de snapshots al editar una atención (arancelId, arancelVigencia, valorArancelEstimado).
   Núcleo puro y probado: cardiolink-aranceles-v2-core.js
   ===================================================================== */
(function () {
  'use strict';
  var C = window.CardioLinkArancelesV2;
  if (!C) { console.warn('Aranceles V2: núcleo no disponible.'); return; }
  var norm = C.norm;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]; }); };
  var SEP = '\u0001';

  /* ===================== 1) Snapshots de atenciones ===================== */
  // Una edición administrativa o clínica NO recalcula arancelId / arancelVigencia / valorArancelEstimado / destino estimado.
  // Sólo se recalculan si en esa edición cambió explícitamente la cobertura, la prestación o el profesional, y nunca con un cobro confirmado.
  var ctxEdicion = null;
  function snapshotNulo(a) {
    // Valor «sin informar» o serie archivada: no es un arancel cero. El snapshot queda vacío (sin informar).
    try {
      if (!a || !a.arancelId) return;
      var lista = (typeof data !== 'undefined' && data.arancelesPorProfesional && data.arancelesPorProfesional[a.profesionalId || 'matias']) || [];
      var f = lista.filter(function (x) { return x && x.id === a.arancelId; })[0];
      if (f && (f.archivado || C.valorNum(f) === null)) { a.valorArancelEstimado = null; a.arancelId = ''; a.arancelVigencia = ''; }
    } catch (e) { /* sin efecto */ }
  }
  function instalarSnapshot() {
    var orig = window.aplicarArancelSnapshot3102Final;
    if (typeof orig !== 'function' || orig.__arV2) return;
    var w = function (a, forzar) {
      if (forzar !== true) { var r0 = orig.apply(this, arguments); snapshotNulo(a); return r0; }   // alta de atención
      var c = ctxEdicion;
      if (!c || !a || String(a.id) !== c.id) return a;                    // sin contexto de edición reconocido: no se recalcula
      if (a.estadoCobro === 'cobrado') return a;                          // cobro confirmado: intocable
      var igual = norm(a.obraSocial) === c.os && norm(a.prestacion) === c.prest && String(a.profesionalId || '') === c.prof;
      if (igual) return a;                                                // edición común: el snapshot histórico queda como está
      var r = orig.apply(this, arguments);                                // cambió cobertura/prestación/profesional: recálculo explícito
      snapshotNulo(a);
      return r;
    };
    w.__arV2 = true;
    window.aplicarArancelSnapshot3102Final = w;
  }
  function instalarEdicion() {
    var orig = window.guardarEdicionModal;
    if (typeof orig !== 'function' || orig.__arV2) return;
    var w = function (id) {
      var lista = typeof atenciones !== 'undefined' ? atenciones : [];
      var a = lista.filter(function (x) { return String(x.id) === String(id); })[0];
      ctxEdicion = a ? { id: String(a.id), os: norm(a.obraSocial), prest: norm(a.prestacion), prof: String(a.profesionalId || '') } : null;
      var r;
      try { r = orig.apply(this, arguments); } catch (e) { ctxEdicion = null; throw e; }
      if (r && typeof r.then === 'function') return r.then(function (x) { ctxEdicion = null; return x; }, function (e) { ctxEdicion = null; throw e; });
      ctxEdicion = null;
      return r;
    };
    w.__arV2 = true;
    window.guardarEdicionModal = w;
    try { guardarEdicionModal = w; } catch (e) { /* ya resuelto por window */ }
  }

  /* ===================== 2) Datos de la grilla ===================== */
  var S = { pid: '', vig: '', buscar: '', filtro: 'activos', modo: 'valor', sucios: {}, extra: [], msg: null };

  function cfg() { try { return typeof data !== 'undefined' ? data : null; } catch (e) { return null; } }
  function puede() { try { return typeof puedeGestionarConfigComercial === 'function' && puedeGestionarConfigComercial(); } catch (e) { return false; } }
  function hoy() { try { return typeof todayISO === 'function' ? todayISO() : new Date().toISOString().slice(0, 10); } catch (e) { return new Date().toISOString().slice(0, 10); } }
  function fmtFecha(f) { var m = String(f || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? m[3] + '/' + m[2] + '/' + m[1] : (f || 's/f'); }
  function fmtNum(n) { var x = Number(n); return x.toLocaleString('es-AR', { minimumFractionDigits: Number.isInteger(x) ? 0 : 2, maximumFractionDigits: 2 }); }
  function fmtMonto(n) { return n === null || n === undefined || !Number.isFinite(Number(n)) ? '—' : '$ ' + fmtNum(n); }
  function profesionales() { var d = cfg(); return ((d && d.profesionales) || []).filter(function (p) { return p && p.id !== 'general' && p.activo !== false; }); }
  function profDe(pid) { return profesionales().filter(function (p) { return p.id === pid; })[0] || null; }
  function nombreOS(x) { return typeof x === 'string' ? x : (x && (x.nombre || x.label)) || ''; }
  function coberturas() {
    var d = cfg(), m = {}, out = [];
    function add(n) { n = String(n || '').trim(); if (n && !m[norm(n)]) { m[norm(n)] = 1; out.push(n); } }
    ((d && d.obrasSociales) || []).forEach(function (x) { add(nombreOS(x)); });
    Object.keys((d && d.conveniosPorProfesional) || {}).forEach(function (k) { ((d.conveniosPorProfesional[k]) || []).forEach(function (c) { add(c && c.obraSocial); }); });
    Object.keys((d && d.arancelesPorProfesional) || {}).forEach(function (k) { ((d.arancelesPorProfesional[k]) || []).forEach(function (f) { add(f && f.obraSocial); }); });
    return out.sort(function (a, b) { return a.localeCompare(b, 'es'); });
  }
  function catalogoPrestaciones() {
    var d = cfg(), m = {}, out = [];
    function add(n) { n = String(n || '').trim(); if (n && !m[norm(n)]) { m[norm(n)] = 1; out.push(n); } }
    profesionales().forEach(function (p) { (p.prestaciones || []).forEach(add); });
    Object.keys((d && d.arancelesPorProfesional) || {}).forEach(function (k) { ((d.arancelesPorProfesional[k]) || []).forEach(function (f) { add(f && f.prestacion); }); });
    return out;
  }
  function columnas(pid) {
    var d = cfg(), p = profDe(pid), m = {}, out = [];
    function add(n, hab) { n = String(n || '').trim(); if (!n) return; if (m[norm(n)]) return; m[norm(n)] = 1; out.push({ nombre: n, habilitada: hab }); }
    ((p && p.prestaciones) || []).forEach(function (n) { add(n, true); });
    (((d && d.arancelesPorProfesional) || {})[pid] || []).forEach(function (f) { if (f && f.activo !== false) add(f.prestacion, false); });
    S.extra.forEach(function (n) { add(n, false); });
    return out;
  }
  function convenioDe(pid, os) {
    var d = cfg(), arr = ((d && d.conveniosPorProfesional) || {})[pid];
    return Array.isArray(arr) ? arr.filter(function (c) { return c && norm(c.obraSocial) === norm(os); })[0] || null : null;
  }
  function estadoConvenio(pid, os) { var c = convenioDe(pid, os); return !c ? 'sin' : (c.activo === false ? 'archivado' : 'habilitado'); }
  function usuario() { try { var u = typeof perfilUsuarioActual === 'function' ? (perfilUsuarioActual() || {}) : {}; return u.email || u.nombre || u.id || ''; } catch (e) { return ''; } }

  /* ===================== 3) Interfaz ===================== */
  var CSS = '#cfgArancelesV2 .ar2-top{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin:10px 0}' +
    '#cfgArancelesV2 .ar2-top label{display:flex;flex-direction:column;gap:3px;font-size:12px;color:#475569;min-width:130px}' +
    '#cfgArancelesV2 .ar2-top select,#cfgArancelesV2 .ar2-top input{padding:7px 8px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px}' +
    '#cfgArancelesV2 .ar2-conceptos{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:8px;margin:8px 0}' +
    '#cfgArancelesV2 .ar2-conc{border:1px solid #cbd5e1;border-radius:10px;padding:8px 10px;font-size:13px;background:#f8fafc}' +
    '#cfgArancelesV2 .ar2-conc.on{border-color:#0f766e;background:#ecfdf5}#cfgArancelesV2 .ar2-conc.on.cop{border-color:#b45309;background:#fffbeb}' +
    '#cfgArancelesV2 .ar2-aviso{padding:8px 10px;border-radius:8px;background:#fffbeb;border:1px solid #fcd34d;color:#78350f;font-size:13px;margin:6px 0}' +
    '#cfgArancelesV2 .ar2-msg{padding:8px 10px;border-radius:8px;font-size:13px;margin:6px 0;border:1px solid #94a3b8;background:#f1f5f9}' +
    '#cfgArancelesV2 .ar2-msg.ok{border-color:#16a34a;background:#f0fdf4;color:#14532d}#cfgArancelesV2 .ar2-msg.err{border-color:#dc2626;background:#fef2f2;color:#7f1d1d}' +
    '#cfgArancelesV2 .ar2-scroll{overflow:auto;max-height:68vh;border:1px solid #e2e8f0;border-radius:10px}' +
    '#cfgArancelesV2 table.ar2-tabla{border-collapse:separate;border-spacing:0;font-size:13px;width:max-content;min-width:100%}' +
    '#cfgArancelesV2 .ar2-tabla th,#cfgArancelesV2 .ar2-tabla td{padding:3px 4px;border-bottom:1px solid #eef2f7;background:#fff;white-space:nowrap}' +
    '#cfgArancelesV2 .ar2-tabla thead th{position:sticky;top:0;z-index:2;background:#f1f5f9;font-weight:600;text-align:center;max-width:130px;white-space:normal;line-height:1.15}' +
    '#cfgArancelesV2 .ar2-sticky{position:sticky;left:0;z-index:1;text-align:left;min-width:150px;background:#fff!important;border-right:1px solid #e2e8f0}' +
    '#cfgArancelesV2 thead .ar2-sticky{z-index:3;background:#f1f5f9!important}' +
    '#cfgArancelesV2 .ar2-cel{width:92px;padding:6px 6px;border:1px solid #e2e8f0;border-radius:6px;text-align:right;font-size:13px;background:#fff}' +
    '#cfgArancelesV2 .ar2-cel.sin{background:#f8fafc}#cfgArancelesV2 .ar2-cel.arch{background:#f1f5f9;color:#94a3b8;text-decoration:line-through}' +
    '#cfgArancelesV2 .ar2-cel.sucio{border-color:#0f766e;background:#ecfdf5;font-weight:600}#cfgArancelesV2 .ar2-cel.cop.sucio{border-color:#b45309;background:#fffbeb}' +
    '#cfgArancelesV2 .ar2-cel.mal{border-color:#dc2626;background:#fef2f2}' +
    '#cfgArancelesV2 .ar2-badge{font-size:11px;padding:1px 6px;border-radius:999px;border:1px solid #cbd5e1;color:#475569;margin-left:4px}' +
    '#cfgArancelesV2 .ar2-badge.h{border-color:#16a34a;color:#166534}#cfgArancelesV2 .ar2-badge.a{border-color:#94a3b8;color:#64748b}' +
    '#cfgArancelesV2 .ar2-nh{font-size:10px;color:#b45309;display:block}' +
    '#cfgArancelesV2 .ar2-acc{text-align:left}#cfgArancelesV2 .ar2-acc button{font-size:12px;padding:4px 8px;margin-right:4px}' +
    '#ar2Modal{position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:9999;display:flex;align-items:center;justify-content:center;padding:12px}' +
    '#ar2Modal .ar2-box{background:#fff;border-radius:12px;max-width:980px;width:100%;max-height:92vh;overflow:auto;padding:16px;box-shadow:0 10px 40px rgba(0,0,0,.3)}' +
    '#ar2Modal textarea{width:100%;min-height:130px;font-family:ui-monospace,Menlo,monospace;font-size:12px;border:1px solid #cbd5e1;border-radius:8px;padding:8px}' +
    '#ar2Modal table{border-collapse:collapse;width:100%;font-size:12px}#ar2Modal td,#ar2Modal th{border-bottom:1px solid #e2e8f0;padding:4px 6px;text-align:left}' +
    '#ar2Modal .ar2-row{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin:8px 0}#ar2Modal .ar2-row label{display:flex;flex-direction:column;gap:3px;font-size:12px;color:#475569}' +
    '#ar2Modal .e{color:#b91c1c}#ar2Modal .n{color:#166534;font-weight:600}#ar2Modal .u{color:#0f766e}#ar2Modal .g{color:#64748b}';

  function aviso(tipo, texto) { S.msg = texto ? { tipo: tipo, texto: texto } : null; var el = $('ar2Msg'); if (el) { el.className = 'ar2-msg' + (tipo ? ' ' + tipo : ''); el.textContent = texto || ''; el.style.display = texto ? '' : 'none'; } }
  function nSucios() { return Object.keys(S.sucios).length; }
  function actualizarContador() {
    var n = nSucios(), b = $('ar2Guardar'), d = $('ar2Descartar'), c = $('ar2Cont');
    if (c) c.textContent = n ? (n + ' celda' + (n === 1 ? '' : 's') + ' con cambios sin guardar') : 'Sin cambios pendientes';
    if (b) b.disabled = !n; if (d) d.disabled = !n;
  }

  function armar(card) {
    card.innerHTML =
      '<h3>Aranceles por convenio y prestación <span class="ar2-badge h">Editor principal</span></h3>' +
      '<p class="muted">Elegí profesional y vigencia, editá las celdas y guardá todo junto. Celda vacía = sin informar (no se borra ni se pisa un valor existente); <strong>0</strong> = valor cero explícito.</p>' +
      '<div class="ar2-conceptos">' +
      '<div class="ar2-conc" id="ar2ConcArancel"><strong>Arancel de convenio</strong><br>Lo que paga la cobertura por la prestación. Base de la producción a facturar.</div>' +
      '<div class="ar2-conc cop" id="ar2ConcCopago"><strong>Copago informativo</strong><br>Referencia. <u>No cambia lo que cobra Caja</u>: ese copago se configura en «Valores del profesional».</div></div>' +
      '<div class="ar2-top">' +
      '<label>Profesional<select id="ar2Prof"></select></label>' +
      '<label>Vigencia (desde)<input type="date" id="ar2Vig"></label>' +
      '<label>Editar<select id="ar2Modo"><option value="valor">Arancel de convenio</option><option value="copago">Copago informativo</option></select></label>' +
      '<label>Buscar convenio<input type="search" id="ar2Buscar" placeholder="Ej.: OSDE"></label>' +
      '<label>Mostrar<select id="ar2Filtro"><option value="activos">Activos (habilitados y sin configurar)</option><option value="archivados">Archivados</option><option value="todos">Todos</option></select></label>' +
      '<label>Agregar columna<select id="ar2Col"></select></label>' +
      '</div>' +
      '<div class="ar2-top"><button class="primary" id="ar2Guardar" type="button" disabled>Guardar cambios</button><button class="secondary" id="ar2Descartar" type="button" disabled>Descartar</button>' +
      '<button class="secondary" id="ar2Importar" type="button">Importar (CSV / pegar desde Excel)</button><button class="secondary" id="ar2Nuevo" type="button">+ Convenio</button><span class="muted" id="ar2Cont"></span></div>' +
      '<div id="ar2Aviso"></div><div id="ar2Msg" class="ar2-msg" style="display:none"></div>' +
      '<div class="ar2-scroll"><table class="ar2-tabla"><thead id="ar2Head"></thead><tbody id="ar2Body"></tbody></table></div>' +
      '<p class="muted" style="margin-top:6px">Los valores ya aplicados a atenciones no cambian: cada atención guarda el arancel con el que se registró. Una corrección en la misma vigencia queda en el historial; un valor nuevo con otra vigencia agrega una fila sin tocar las anteriores.</p>';
    var st = document.createElement('style'); st.id = 'ar2Style'; st.textContent = CSS; if (!$('ar2Style')) document.head.appendChild(st);
    S.vig = S.vig || hoy();
    $('ar2Vig').value = S.vig;
  }

  function render() {
    var card = $('cfgArancelesV2'), d = cfg();
    if (!card || !d || !$('ar2Prof')) return;
    var ps = profesionales();
    if (!S.pid || !ps.some(function (p) { return p.id === S.pid; })) S.pid = (ps[0] && ps[0].id) || '';
    $('ar2Prof').innerHTML = ps.map(function (p) { return '<option value="' + esc(p.id) + '"' + (p.id === S.pid ? ' selected' : '') + '>' + esc(p.nombre) + '</option>'; }).join('');
    $('ar2Modo').value = S.modo; $('ar2Filtro').value = S.filtro; $('ar2Vig').value = S.vig; $('ar2Buscar').value = S.buscar;
    $('ar2ConcArancel').classList.toggle('on', S.modo === 'valor'); $('ar2ConcCopago').classList.toggle('on', S.modo === 'copago');
    $('ar2Aviso').innerHTML = S.modo === 'copago' ? '<div class="ar2-aviso"><strong>Estás editando el COPAGO INFORMATIVO.</strong> No modifica lo que cobra Caja ni el arancel del convenio.</div>' : '';
    var cols = columnas(S.pid);
    var enCols = {}; cols.forEach(function (c) { enCols[norm(c.nombre)] = 1; });
    $('ar2Col').innerHTML = '<option value="">+ Prestación del catálogo…</option>' + catalogoPrestaciones().filter(function (n) { return !enCols[norm(n)]; }).map(function (n) { return '<option value="' + esc(n) + '">' + esc(n) + '</option>'; }).join('');
    $('ar2Head').innerHTML = '<tr><th class="ar2-sticky">Convenio</th>' + cols.map(function (c) { return '<th title="' + esc(c.habilitada ? 'Prestación habilitada para este profesional' : 'Prestación no habilitada hoy para este profesional (sólo valores)') + '">' + esc(c.nombre) + (c.habilitada ? '' : '<span class="ar2-nh">no habilitada</span>') + '</th>'; }).join('') + '<th>Acciones</th></tr>';
    var q = norm(S.buscar);
    var filas = coberturas().filter(function (os) {
      var e = estadoConvenio(S.pid, os);
      if (S.filtro === 'activos' && e === 'archivado') return false;
      if (S.filtro === 'archivados' && e !== 'archivado') return false;
      return !q || norm(os).indexOf(q) >= 0;
    });
    var campoCop = S.modo === 'copago';
    $('ar2Body').innerHTML = filas.map(function (os) {
      var e = estadoConvenio(S.pid, os);
      var badge = e === 'habilitado' ? '<span class="ar2-badge h">Habilitado</span>' : (e === 'archivado' ? '<span class="ar2-badge a">Archivado</span>' : '<span class="ar2-badge">Sin configurar</span>');
      var celdas = cols.map(function (c) {
        var v = C.vigente(d, S.pid, os, c.nombre, S.vig), txt = '', cls = 'ar2-cel' + (campoCop ? ' cop' : ''), tip = '';
        var k = os + SEP + c.nombre, sucio = Object.prototype.hasOwnProperty.call(S.sucios, k);
        if (v.estado === 'valor' || v.estado === 'sin_informar') {
          var n = campoCop ? (v.fila.copago === null || v.fila.copago === undefined || v.fila.copago === '' ? null : Number(v.fila.copago)) : C.valorNum(v.fila);
          txt = n === null || !Number.isFinite(n) ? '' : fmtNum(n);
          if (txt === '') cls += ' sin';
          tip = 'Vigente desde ' + fmtFecha(v.fila.vigenteDesde);
        } else if (v.estado === 'archivado') { cls += ' arch'; tip = 'Archivado desde ' + fmtFecha(v.fila.vigenteDesde) + '. Cargá un valor nuevo para reactivarlo.'; }
        else { cls += ' sin'; tip = 'Sin informar'; }
        if (sucio) { cls += ' sucio'; txt = S.sucios[k]; }
        return '<td><input class="' + cls + '" inputmode="decimal" autocomplete="off" placeholder="—" data-os="' + esc(os) + '" data-prest="' + esc(c.nombre) + '" data-orig="' + esc(sucio ? '' : txt) + '" title="' + esc(tip) + '" value="' + esc(txt) + '"></td>';
      }).join('');
      var acc = '<button type="button" class="secondary" data-ar2="hist" data-os="' + esc(os) + '">Historial</button>' +
        (e === 'archivado' ? '<button type="button" class="secondary" data-ar2="rest" data-os="' + esc(os) + '">Restaurar</button>' : '<button type="button" class="secondary" data-ar2="arch" data-os="' + esc(os) + '">Archivar</button>');
      return '<tr data-os="' + esc(os) + '"><th class="ar2-sticky">' + esc(os) + badge + '</th>' + celdas + '<td class="ar2-acc">' + acc + '</td></tr>';
    }).join('') || '<tr><td colspan="' + (cols.length + 2) + '" class="muted" style="padding:14px">No hay convenios para mostrar con este filtro.</td></tr>';
    // texto original de cada celda (para detectar «volvió a su valor»)
    Array.prototype.forEach.call(document.querySelectorAll('#ar2Body .ar2-cel'), function (inp) {
      var k = inp.dataset.os + SEP + inp.dataset.prest;
      if (!Object.prototype.hasOwnProperty.call(S.sucios, k)) inp.dataset.orig = inp.value;
      else inp.dataset.orig = origDe(inp.dataset.os, inp.dataset.prest);
    });
    actualizarContador();
  }
  function origDe(os, prest) {
    var d = cfg(), v = C.vigente(d, S.pid, os, prest, S.vig);
    if (v.estado !== 'valor' && v.estado !== 'sin_informar') return '';
    var n = S.modo === 'copago' ? (v.fila.copago === null || v.fila.copago === undefined || v.fila.copago === '' ? null : Number(v.fila.copago)) : C.valorNum(v.fila);
    return n === null || !Number.isFinite(n) ? '' : fmtNum(n);
  }

  /* ---- guardado conjunto ---- */
  async function guardar() {
    if (typeof exigirConfigComercial === 'function' && !exigirConfigComercial('Tu perfil no puede modificar aranceles.')) return;
    var cambios = [], errores = [];
    Object.keys(S.sucios).forEach(function (k) {
      var p = k.split(SEP), m = C.parsearMonto(S.sucios[k]);
      if (!m.ok) { errores.push(p[0] + ' · ' + p[1] + ': ' + m.error); return; }
      cambios.push({ os: p[0], prest: p[1], campo: S.modo, valor: m.valor, vacio: m.vacio });
    });
    if (errores.length) { aviso('err', 'Revisá estas celdas antes de guardar — ' + errores.slice(0, 6).join(' | ') + (errores.length > 6 ? ' … (+' + (errores.length - 6) + ')' : '')); marcarMalas(); return; }
    if (!C.esFecha(S.vig)) { aviso('err', 'Elegí una vigencia válida.'); return; }
    var plan = C.planificar(cfg(), S.pid, cambios, S.vig), r = plan.resumen;
    if (!(r.nuevo + r.actualiza)) { aviso('', 'No hay cambios para guardar: ' + (r.igual ? r.igual + ' celda(s) ya tenían ese valor. ' : '') + (r.vacio ? r.vacio + ' vacía(s) no modifican nada.' : '')); S.sucios = {}; render(); return; }
    var p = profDe(S.pid);
    var txt = 'Guardar ' + (S.modo === 'copago' ? 'COPAGOS INFORMATIVOS' : 'ARANCELES') + ' de ' + (p ? p.nombre : S.pid) + ' con vigencia desde ' + fmtFecha(S.vig) + ':\n' +
      '· ' + r.nuevo + ' valor(es) nuevo(s)\n· ' + r.actualiza + ' corrección(es) de una fila de la misma vigencia (queda historial)\n' +
      (r.igual ? '· ' + r.igual + ' sin cambios\n' : '') + (r.vacio ? '· ' + r.vacio + ' vacía(s): no se modifican\n' : '') +
      '\nLas atenciones ya registradas conservan su arancel.';
    if (!window.confirm(txt)) return;
    var res = C.aplicar(cfg(), S.pid, cambios, S.vig, { por: usuario() });
    var ok = null;
    try { ok = typeof persistirConfigVisibleV1 === 'function' ? await persistirConfigVisibleV1('Los aranceles') : null; } catch (e) { ok = false; }
    try { if (typeof programarSyncSupabase === 'function') programarSyncSupabase(); } catch (e) { /* sin efecto */ }
    S.sucios = {}; render();
    aviso(ok === false ? 'err' : 'ok', (ok === false ? 'Cambios aplicados SOLO en este equipo (el servidor no los confirmó). ' : 'Guardado. ') + res.nuevo + ' nuevo(s), ' + res.actualiza + ' corregido(s).');
  }
  function marcarMalas() {
    Array.prototype.forEach.call(document.querySelectorAll('#ar2Body .ar2-cel.sucio'), function (inp) {
      var k = inp.dataset.os + SEP + inp.dataset.prest; var m = C.parsearMonto(S.sucios[k]); inp.classList.toggle('mal', !m.ok);
    });
  }

  /* ---- convenios: archivar / restaurar / nuevo ---- */
  function setConvenioActivo(pid, os, activo) {
    var d = cfg(); if (!d) return;
    d.conveniosPorProfesional = d.conveniosPorProfesional && typeof d.conveniosPorProfesional === 'object' ? d.conveniosPorProfesional : {};
    var arr = Array.isArray(d.conveniosPorProfesional[pid]) ? d.conveniosPorProfesional[pid] : (d.conveniosPorProfesional[pid] = []);
    var c = arr.filter(function (x) { return x && norm(x.obraSocial) === norm(os); })[0];
    if (!c) { var own = (profDe(pid) || {}).nombre || pid; c = { obraSocial: os, activo: activo, regla: 'SIN_REGLA', destinoConsulta: own, destinoEstudio: own, facturadorConsulta: own, facturadorEstudio: own, bonoConsulta: false, bonoEstudio: false, firmaRequerida: false, copiaRequerida: false, incluirFacturaRogelio: false }; arr.push(c); }
    else c.activo = activo;     // sólo el estado: reglas, destinos y facturantes quedan como están
    if (pid === 'matias') d.conveniosFacturacion = JSON.parse(JSON.stringify(arr));
  }
  async function cambiarConvenio(os, activo) {
    if (typeof exigirConfigComercial === 'function' && !exigirConfigComercial('Tu perfil no puede modificar convenios.')) return;
    var p = profDe(S.pid);
    var msg = activo ? '¿Restaurar «' + os + '» para ' + (p ? p.nombre : S.pid) + '? Vuelve a aplicarse en nuevas atenciones.' : '¿Archivar «' + os + '» para ' + (p ? p.nombre : S.pid) + '?\nNo se borra nada: sus valores históricos y las atenciones ya registradas quedan como están; sólo deja de ofrecerse en nuevas atenciones.';
    if (!window.confirm(msg)) return;
    setConvenioActivo(S.pid, os, activo);
    var ok = null; try { ok = await persistirConfigVisibleV1(activo ? 'La restauración del convenio' : 'El archivado del convenio'); } catch (e) { ok = false; }
    try { if (typeof programarSyncSupabase === 'function') programarSyncSupabase(); } catch (e) { /* sin efecto */ }
    render(); aviso(ok === false ? 'err' : 'ok', (activo ? 'Convenio restaurado: ' : 'Convenio archivado: ') + os + (ok === false ? ' (sólo en este equipo: el servidor no lo confirmó).' : '.'));
  }
  async function nuevoConvenio() {
    if (typeof exigirConfigComercial === 'function' && !exigirConfigComercial('Tu perfil no puede crear convenios.')) return;
    var n = window.prompt('Nombre del nuevo convenio / obra social / prepaga:'); n = String(n || '').trim(); if (!n) return;
    if (coberturas().some(function (x) { return norm(x) === norm(n); })) { aviso('err', 'Ya existe un convenio llamado «' + n + '».'); return; }
    var d = cfg(); d.obrasSociales = Array.isArray(d.obrasSociales) ? d.obrasSociales : []; d.obrasSociales.push(n);
    var ok = null; try { ok = await persistirConfigVisibleV1('El convenio nuevo'); } catch (e) { ok = false; }
    try { if (typeof programarSyncSupabase === 'function') programarSyncSupabase(); } catch (e) { /* sin efecto */ }
    S.buscar = n; render(); aviso(ok === false ? 'err' : 'ok', 'Convenio «' + n + '» agregado al catálogo. Falta habilitarlo y definir sus reglas en el editor de convenios, si corresponde.');
  }

  /* ---- ventanas: historial e importación ---- */
  function cerrarModal() { var m = $('ar2Modal'); if (m) m.remove(); }
  function abrirModal(html) { cerrarModal(); var m = document.createElement('div'); m.id = 'ar2Modal'; m.innerHTML = '<div class="ar2-box">' + html + '</div>'; document.body.appendChild(m); m.addEventListener('click', function (e) { if (e.target === m) cerrarModal(); }); return m; }

  function verHistorial(os) {
    var d = cfg(), h = C.historial(d, S.pid, os), p = profDe(S.pid);
    var vigentes = {}; columnas(S.pid).forEach(function (c) { var v = C.vigente(d, S.pid, os, c.nombre, S.vig); if (v.fila) vigentes[v.fila.id] = v.estado; });
    var series = {}; h.forEach(function (x) { series[x.prestacion] = 1; });
    var filas = h.map(function (x) {
      var est = x.archivado ? 'Archivado' : (x.activa ? (vigentes[x.id] ? 'Vigente a ' + fmtFecha(S.vig) : 'Anterior / posterior') : 'Desactivada (legado)');
      return '<tr><td>' + esc(x.prestacion) + '</td><td>' + fmtFecha(x.vigenteDesde) + '</td><td>' + (x.valor === null ? '<span class="g">sin informar</span>' : '$ ' + fmtNum(x.valor)) + '</td><td>' + (x.copago === null || !Number.isFinite(x.copago) ? '<span class="g">—</span>' : '$ ' + fmtNum(x.copago)) + '</td><td>' + est + '</td><td>' + (x.correcciones ? x.correcciones + ' corrección(es)' : '') + '</td><td class="g">' + esc(x.origen) + '</td></tr>';
    }).join('') || '<tr><td colspan="7" class="g">Este convenio no tiene valores cargados para este profesional.</td></tr>';
    var arch = Object.keys(series).filter(function (n) { var v = C.vigente(d, S.pid, os, n, S.vig); return v.estado === 'valor' || v.estado === 'sin_informar'; })
      .map(function (n) { return '<button type="button" class="secondary" data-ar2="archSerie" data-os="' + esc(os) + '" data-prest="' + esc(n) + '">Archivar «' + esc(n) + '» desde ' + fmtFecha(S.vig) + '</button>'; }).join(' ');
    abrirModal('<h3>Historial de valores · ' + esc(os) + '</h3><p class="muted">' + esc(p ? p.nombre : S.pid) + '. Las filas no se borran. Archivar una prestación desde una fecha no altera lo anterior ni reactiva valores viejos.</p>' +
      '<table><thead><tr><th>Prestación</th><th>Vigente desde</th><th>Arancel</th><th>Copago informativo</th><th>Estado</th><th>Historial</th><th>Origen</th></tr></thead><tbody>' + filas + '</tbody></table>' +
      (arch ? '<div class="ar2-row">' + arch + '</div>' : '') + '<div class="ar2-row"><button type="button" class="primary" data-ar2="cerrar">Cerrar</button></div>');
  }
  async function archivarSerie(os, prest) {
    if (typeof exigirConfigComercial === 'function' && !exigirConfigComercial('Tu perfil no puede archivar aranceles.')) return;
    if (!window.confirm('¿Archivar «' + prest + '» de «' + os + '» desde ' + fmtFecha(S.vig) + '?\nNo se borra nada y los valores anteriores a esa fecha no cambian.')) return;
    var r = C.archivarSerie(cfg(), S.pid, os, prest, S.vig, { por: usuario() });
    if (!r.ok) { window.alert(r.error); return; }
    var ok = null; try { ok = await persistirConfigVisibleV1('El archivado del arancel'); } catch (e) { ok = false; }
    try { if (typeof programarSyncSupabase === 'function') programarSyncSupabase(); } catch (e) { /* sin efecto */ }
    cerrarModal(); render(); aviso(ok === false ? 'err' : 'ok', 'Serie archivada desde ' + fmtFecha(S.vig) + (ok === false ? ' (sólo en este equipo: el servidor no lo confirmó).' : '.'));
  }

  var PLAN = null;
  function abrirImportar() {
    PLAN = null;
    var p = profDe(S.pid);
    abrirModal('<h3>Importar aranceles</h3>' +
      '<p class="muted">Profesional: <strong>' + esc(p ? p.nombre : S.pid) + '</strong>. Pegá la tabla desde Excel o cargá un CSV. Dos formatos: <strong>matriz</strong> (primera fila = prestaciones, primera columna = convenios) o <strong>lista</strong> (columnas: convenio, prestación, valor; opcionales: copago, vigencia, profesional). Admite importes como «$ 35.000,50».</p>' +
      '<div class="ar2-row"><label>Archivo CSV<input type="file" id="ar2Archivo" accept=".csv,.tsv,.txt,text/csv,text/plain"></label>' +
      '<label>Vigencia por defecto<input type="date" id="ar2ImpVig" value="' + esc(S.vig) + '"></label>' +
      '<label>En formato matriz, importar como<select id="ar2ImpModo"><option value="valor">Arancel de convenio</option><option value="copago">Copago informativo</option></select></label>' +
      '<label style="flex-direction:row;align-items:center;gap:6px"><input type="checkbox" id="ar2ImpNuevos"> Crear convenios que no estén en el catálogo</label></div>' +
      '<textarea id="ar2ImpTxt" placeholder="Convenio&#9;Consulta&#9;Holter&#10;IOMA&#9;$ 35.000&#9;60.000"></textarea>' +
      '<div class="ar2-row"><button class="secondary" type="button" data-ar2="impPrev">Vista previa</button><button class="primary" type="button" id="ar2ImpOk" data-ar2="impOk" disabled>Confirmar importación</button><button class="secondary" type="button" data-ar2="cerrar">Cancelar</button></div>' +
      '<div id="ar2ImpRes"></div>');
    $('ar2ImpModo').value = S.modo;
    $('ar2Archivo').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0]; if (!f) return;
      var fr = new FileReader();
      fr.onload = function () {
        var buf = fr.result, t;
        try { t = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (x) { try { t = new TextDecoder('windows-1252').decode(buf); } catch (y) { t = ''; } }
        $('ar2ImpTxt').value = t; PLAN = null; $('ar2ImpOk').disabled = true; $('ar2ImpRes').innerHTML = '<p class="muted">Archivo «' + esc(f.name) + '» cargado. Presioná «Vista previa».</p>';
      };
      fr.readAsArrayBuffer(f);
    });
  }
  function vistaPrevia() {
    var d = cfg(), txt = $('ar2ImpTxt').value, vig = $('ar2ImpVig').value;
    if (!C.esFecha(vig)) { $('ar2ImpRes').innerHTML = '<p class="e">Elegí una vigencia válida.</p>'; return; }
    PLAN = C.planificarImportacion(d, txt, {
      profesionales: profesionales().map(function (p) { return { id: p.id, nombre: p.nombre }; }), prestaciones: catalogoPrestaciones(), coberturas: coberturas(),
      profesionalId: S.pid, vigencia: vig, campoMatriz: $('ar2ImpModo').value, crearCoberturas: $('ar2ImpNuevos').checked
    });
    if (!PLAN.ok) { $('ar2ImpRes').innerHTML = '<p class="e">' + esc(PLAN.error) + '</p>'; $('ar2ImpOk').disabled = true; return; }
    var r = PLAN.resumen, aplicables = r.nuevo + r.actualiza;
    var rotulo = { nuevo: '<span class="n">Nuevo</span>', actualiza: '<span class="u">Corrige</span>', igual: '<span class="g">Igual</span>', vacio: '<span class="g">Vacío</span>', error: '<span class="e">Error</span>' };
    var filas = PLAN.filas.slice(0, 400).map(function (f) {
      return '<tr><td>' + f.linea + '</td><td>' + esc(f.os || f.convenio) + (f.nuevaCobertura ? ' <span class="n">(nuevo convenio)</span>' : '') + '</td><td>' + esc(f.prest || f.prestacion) + '</td><td>' + (f.campo === 'copago' ? 'copago' : 'arancel') + '</td><td>' + esc(f.texto) + '</td><td>' + (f.accion === 'actualiza' ? fmtMonto(f.antes) + ' → ' + fmtMonto(f.despues) : (f.despues !== undefined && f.despues !== null ? fmtMonto(f.despues) : '')) + '</td><td>' + fmtFecha(f.vigencia) + '</td><td>' + rotulo[f.accion] + ' <span class="g">' + esc(f.motivo || '') + '</span></td></tr>';
    }).join('');
    $('ar2ImpRes').innerHTML = '<p><strong>Formato:</strong> ' + esc(PLAN.formato) + '. <span class="n">' + r.nuevo + ' nuevos</span> · <span class="u">' + r.actualiza + ' correcciones</span> · ' + r.igual + ' iguales · ' + r.vacio + ' vacías (no se modifican) · <span class="e">' + r.error + ' con error (se omiten)</span>' + (PLAN.nuevasCoberturas.length ? ' · convenios nuevos: ' + esc(PLAN.nuevasCoberturas.join(', ')) : '') + '</p>' +
      '<div style="max-height:40vh;overflow:auto"><table><thead><tr><th>Línea</th><th>Convenio</th><th>Prestación</th><th>Campo</th><th>Texto</th><th>Valor</th><th>Vigencia</th><th>Resultado</th></tr></thead><tbody>' + filas + '</tbody></table></div>' +
      (PLAN.filas.length > 400 ? '<p class="muted">Se muestran las primeras 400 filas; la importación aplica todas.</p>' : '');
    $('ar2ImpOk').disabled = !aplicables; $('ar2ImpOk').textContent = aplicables ? 'Confirmar importación (' + aplicables + ' cambios)' : 'Nada para importar';
  }
  async function confirmarImportacion() {
    if (!PLAN || !PLAN.ok) return;
    if (typeof exigirConfigComercial === 'function' && !exigirConfigComercial('Tu perfil no puede modificar aranceles.')) return;
    var r = PLAN.resumen, p = profDe(S.pid);
    if (!window.confirm('Importar en ' + (p ? p.nombre : S.pid) + ': ' + r.nuevo + ' nuevo(s) y ' + r.actualiza + ' corrección(es)' + (r.error ? '. ' + r.error + ' fila(s) con error se omiten' : '') + '.\n¿Confirmar?')) return;
    var res = C.aplicarImportacion(cfg(), PLAN, { por: usuario() });
    var ok = null; try { ok = await persistirConfigVisibleV1('La importación de aranceles'); } catch (e) { ok = false; }
    try { if (typeof programarSyncSupabase === 'function') programarSyncSupabase(); } catch (e) { /* sin efecto */ }
    PLAN = null; cerrarModal(); S.sucios = {}; render();
    aviso(ok === false ? 'err' : 'ok', (ok === false ? 'Importado SOLO en este equipo (el servidor no lo confirmó). ' : 'Importación guardada. ') + res.nuevo + ' nuevo(s), ' + res.actualiza + ' corregido(s)' + (res.coberturasNuevas ? ', ' + res.coberturasNuevas + ' convenio(s) nuevo(s) en el catálogo' : '') + '.');
  }

  /* ---- eventos ---- */
  function descartarPendientes() { if (!nSucios()) return true; if (!window.confirm('Hay ' + nSucios() + ' celda(s) con cambios sin guardar. ¿Descartarlas?')) return false; S.sucios = {}; return true; }
  document.addEventListener('input', function (e) {
    var t = e.target; if (!t || !t.classList || !t.classList.contains('ar2-cel') || !t.closest('#cfgArancelesV2')) return;
    var k = t.dataset.os + SEP + t.dataset.prest, orig = t.dataset.orig || '';
    if (t.value.trim() === orig.trim()) { delete S.sucios[k]; t.classList.remove('sucio', 'mal'); }
    else { S.sucios[k] = t.value; t.classList.add('sucio'); t.classList.toggle('mal', !C.parsearMonto(t.value).ok); }
    actualizarContador();
  });
  document.addEventListener('keydown', function (e) {
    var t = e.target; if (!t || !t.classList || !t.classList.contains('ar2-cel')) return;
    var dy = e.key === 'Enter' || e.key === 'ArrowDown' ? 1 : (e.key === 'ArrowUp' ? -1 : 0);
    if (!dy) return;
    var tr = t.closest('tr'), idx = Array.prototype.indexOf.call(tr.children, t.closest('td')), sig = dy > 0 ? tr.nextElementSibling : tr.previousElementSibling;
    var cel = sig && sig.children[idx] && sig.children[idx].querySelector('.ar2-cel');
    if (cel) { e.preventDefault(); cel.focus(); cel.select(); }
  });
  document.addEventListener('change', function (e) {
    var id = e.target && e.target.id;
    if (!e.target.closest || !e.target.closest('#cfgArancelesV2')) return;
    if (id === 'ar2Prof') { if (!descartarPendientes()) { e.target.value = S.pid; return; } S.pid = e.target.value; S.extra = []; render(); }
    else if (id === 'ar2Modo') { if (!descartarPendientes()) { e.target.value = S.modo; return; } S.modo = e.target.value; render(); }
    else if (id === 'ar2Vig') { if (C.esFecha(e.target.value)) { S.vig = e.target.value; render(); } }
    else if (id === 'ar2Filtro') { S.filtro = e.target.value; render(); }
    else if (id === 'ar2Col') { if (e.target.value) { S.extra.push(e.target.value); render(); } }
  });
  document.addEventListener('input', function (e) { if (e.target && e.target.id === 'ar2Buscar') { S.buscar = e.target.value; var pos = e.target.selectionStart; render(); var b = $('ar2Buscar'); if (b) { b.focus(); try { b.setSelectionRange(pos, pos); } catch (x) { /* sin efecto */ } } } });
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-ar2],#ar2Guardar,#ar2Descartar,#ar2Importar,#ar2Nuevo') : null;
    if (!b) return;
    var a = b.dataset.ar2 || b.id;
    if (a === 'ar2Guardar') guardar();
    else if (a === 'ar2Descartar') { if (window.confirm('¿Descartar los cambios sin guardar?')) { S.sucios = {}; render(); aviso('', ''); } }
    else if (a === 'ar2Importar') abrirImportar();
    else if (a === 'ar2Nuevo') nuevoConvenio();
    else if (a === 'hist') verHistorial(b.dataset.os);
    else if (a === 'arch') cambiarConvenio(b.dataset.os, false);
    else if (a === 'rest') cambiarConvenio(b.dataset.os, true);
    else if (a === 'archSerie') archivarSerie(b.dataset.os, b.dataset.prest);
    else if (a === 'cerrar') cerrarModal();
    else if (a === 'impPrev') vistaPrevia();
    else if (a === 'impOk') confirmarImportacion();
  });

  /* ---- integración con Configuración ---- */
  function ocultarEditorViejo() {
    // El alta de aranceles del editor anterior convertía vacíos en 0 y borraba filas físicamente: se reemplaza por esta grilla (los datos son los mismos).
    ['billArancelHelp404', 'billArancelList402'].forEach(function (id) { var el = $(id); if (el) el.style.display = 'none'; });
    var ed = document.querySelector('#cfgConveniosProfesional402 .arancel-editor-prof-404'); if (ed) ed.style.display = 'none';
    var th = document.querySelector('#cfgConveniosProfesional402 .arancel-table-head-404'); if (th) th.style.display = 'none';
    var h4 = $('billArancelHelp404') && $('billArancelHelp404').previousElementSibling;
    if (h4 && h4.tagName === 'H4' && !h4.dataset.ar2) { h4.dataset.ar2 = '1'; h4.textContent = 'Aranceles: se editan en la grilla «Aranceles por convenio y prestación» (más arriba)'; }
  }
  function inyectar() {
    var grid = document.querySelector('#config .config-grid');
    if (!puede()) { var x = $('cfgArancelesV2'); if (x) x.remove(); return; }
    var card = $('cfgArancelesV2');
    if (!card) {
      if (!grid) return;
      card = document.createElement('div'); card.id = 'cfgArancelesV2'; card.className = 'config-smart-card-310 full-config-card';
      card.dataset.configGroupCard = 'coberturas'; card.dataset.configAccess = 'commercial';
      var ref = $('cfgConveniosProfesional402'); if (ref && ref.parentNode === grid) grid.insertBefore(card, ref); else grid.appendChild(card);
      armar(card);
    }
    ocultarEditorViejo();
    if (!nSucios()) render();
  }
  function envolverRenderConfig() {
    var old = window.renderConfig;
    if (typeof old !== 'function' || old.__arV2) return;
    var w = function () { var r = old.apply(this, arguments); setTimeout(function () { try { inyectar(); } catch (e) { console.warn('Aranceles V2:', e); } }, 0); return r; };
    w.__arV2 = true; window.renderConfig = w; try { renderConfig = w; } catch (e) { /* ya resuelto por window */ }
  }
  function boot() {
    instalarSnapshot(); instalarEdicion(); envolverRenderConfig();
    try { inyectar(); } catch (e) { console.warn('Aranceles V2:', e); }
    setTimeout(function () { try { instalarSnapshot(); instalarEdicion(); envolverRenderConfig(); inyectar(); } catch (e) { /* sin efecto */ } }, 1500);
  }
  window.CardioLinkArancelesV2UI = { estado: S, render: render, inyectar: inyectar };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
