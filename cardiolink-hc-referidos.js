/* =====================================================================
   CardioLink — HC copias + médico solicitante/derivador + estadísticas
   v3 · 2026-08-14

   Módulo independiente:
   - NO modifica app.js.
   - NO cambia tablas Supabase.
   - El médico solicitante se guarda dentro de la narrativa de la evolución
     con el encabezado "Médico solicitante: ...", que ya sincroniza en la
     tabla cardiolink_hc_evoluciones.
   ===================================================================== */
(function () {
  'use strict';
  if (window.__cardiolinkHcReferidos411R) return;
  window.__cardiolinkHcReferidos411R = true;

  const CUSTOM_SOLICITANTES_KEY = 'cl_eco_solicitantes_custom';

  const COLEGAS_FRECUENTES = [
    'Dr. Anchorena Rogelio', 'Dr. Cabrera Horacio', 'Dr. Camilletti Jesus',
    'Dr. Garavaglia Carlos', 'Dr. Ruiz Sala Martin', 'Dr. Alonso',
    'Dr. Drago Humberto', 'Dra. Rutter', 'Dra. Mozotegui Adriana',
    'Dra. Grima Victoria', 'Dr. Moldes', 'Dr. Carpio', 'Dr. Duarte Ender',
    'Dr. Centeno Pablo', 'Dra. Benavente Ximena', 'Dr. Montiel Ernesto',
    'Dr. Canelon Roger', 'Dr. Rokos Juan Martin', 'Dra. Benavente Fernanda',
    'Dra. Arena', 'Dra. Vairo Natalia', 'Dr. Spala Jose', 'Dr. Olmedo Pablo',
    'Dra. Izzo Gabriela', 'Dra. Rodriguez Eva', 'Dra. Da Fonseca Mariangeles',
    'Dr. Monteagudo German', 'Dr. Baquerizzo Andres', 'Dr. Del Rio Leonardo',
    'Dr. Domanico Mariano', 'Dr. Bernasconi Orlando', 'Dra. Velazquez',
    'Dra. Betelu', 'Dra. Maggi Romina', 'Dr. Angulo Jason',
    'Dr. Fasah Luis', 'Dra. Piñero Lucia', 'Dr. Arfus',
    'Dra. Leon Nayrra', 'Dra. Emke Mariela'
  ];

  const ESPECIALIDADES_GENERICAS = [
    'Cardiología', 'Neumonología', 'Clínica médica', 'Pediatría',
    'Terapia intensiva', 'Infectología', 'Hematología', 'Obra social'
  ];

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'
    }[c]));
  }

  function norm(v) {
    return String(v || '').trim().toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  function digits(v) { return String(v || '').replace(/\D/g, ''); }

  function customSolicitantes() {
    try {
      const x = JSON.parse(localStorage.getItem(CUSTOM_SOLICITANTES_KEY) || '[]');
      return Array.isArray(x) ? x.filter(Boolean) : [];
    } catch (_) {
      return [];
    }
  }

  function guardarSolicitanteCustom(nombre) {
    nombre = String(nombre || '').trim();
    if (!nombre) return;
    const all = [...COLEGAS_FRECUENTES, ...customSolicitantes()];
    if (all.some(x => norm(x) === norm(nombre))) return;
    const lista = customSolicitantes();
    lista.push(nombre);
    try { localStorage.setItem(CUSTOM_SOLICITANTES_KEY, JSON.stringify(lista)); } catch (_) {}
  }

  function patientByKey(key) {
    key = String(key || '');
    if (!key) return null;
    try {
      if (typeof buscarPacientePanelPorId === 'function') {
        const p = buscarPacientePanelPorId(key);
        if (p) return p;
      }
    } catch (_) {}
    try {
      const list = (typeof data !== 'undefined' && Array.isArray(data?.pacientes)) ? data.pacientes : [];
      const dk = digits(key);
      return list.find(p =>
        String(p.id || '') === key ||
        (dk && digits(p.dni) === dk)
      ) || null;
    } catch (_) { return null; }
  }

  function currentPatient() {
    try {
      const p = window.CardioLinkPacienteActual411B?.get?.();
      if (p) return p;
    } catch (_) {}
    const bar = document.getElementById('currentPatient411B');
    const key = bar?.dataset?.patientKey411b || '';
    return patientByKey(key);
  }

  async function copyText(text, label) {
    const value = String(text || '').trim();
    if (!value || value === 's/d') {
      alert((label || 'Dato') + ' no disponible.');
      return false;
    }
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch (_) {
      try {
        const ta = document.createElement('textarea');
        ta.value = value;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch (_) {
        return false;
      }
    }
  }

  function copyButton(label, value, extraClass='secondary') {
    const disabled = !String(value || '').trim() || String(value || '').trim() === 's/d';
    return `<button type="button" class="${extraClass} cl-copy411r"
      data-cl-copy411r="${encodeURIComponent(String(value || ''))}"
      data-cl-copy-label411r="${esc(label)}" ${disabled ? 'disabled' : ''}>${esc(label)}</button>`;
  }

  function keyFromFichaActions(actions) {
    if (!actions) return '';
    return actions.querySelector('[data-new-doc406]')?.dataset.newDoc406 ||
      actions.querySelector('[data-open-hc]')?.dataset.openHc ||
      actions.querySelector('[data-rcta-patient4095]')?.dataset.rctaPatient4095 ||
      '';
  }

  function addAffiliateToGenericCopyRows() {
    document.querySelectorAll('.copy-row300').forEach(row => {
      if (row.querySelector('[data-cl-copy-affiliate411r]')) return;
      const dniBtn = [...row.querySelectorAll('button')].find(b => /copiar\s+dni/i.test(b.textContent || ''));
      if (!dniBtn) return;
      const onclick = dniBtn.getAttribute('onclick') || '';
      const m = onclick.match(/copyText300\('([^']*)'\s*,\s*'DNI'\)/i);
      const dni = m ? m[1].replace(/\\'/g, "'") : '';
      if (!dni) return;
      const p = patientByKey(dni);
      if (!p) return;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'copy-btn300';
      b.dataset.clCopyAffiliate411r = '1';
      b.dataset.clCopy411r = encodeURIComponent(String(p.numeroAfiliadoHabitual || ''));
      b.dataset.clCopyLabel411r = 'N.º de afiliado';
      b.textContent = 'Copiar afiliado';
      if (!String(p.numeroAfiliadoHabitual || '').trim()) b.disabled = true;
      row.appendChild(b);
    });
  }

  function decoratePatientFicha() {
    const actions = document.querySelector('#pacienteDetalle .paciente-ficha-actions');
    if (!actions) return;
    const key = keyFromFichaActions(actions) ||
      (() => {
        try {
          return typeof pacienteSeleccionadoPanelId !== 'undefined' ? pacienteSeleccionadoPanelId : '';
        } catch (_) { return ''; }
      })();
    const p = patientByKey(key);
    if (!p) return;

    // Si la fila de copiado ya existe, la decoración genérica se ocupa.
    addAffiliateToGenericCopyRows();

    // Respaldo para versiones donde la fila de copia no esté presente.
    if (!document.querySelector('#pacienteDetalle [data-cl-ficha-copy411r]')) {
      const row = document.createElement('div');
      row.className = 'cl-hc-copy-row411r';
      row.dataset.clFichaCopy411r = '1';
      row.innerHTML =
        copyButton('Copiar DNI', p.dni) +
        copyButton('Copiar teléfono', p.telefono) +
        copyButton('Copiar email', p.email) +
        copyButton('Copiar afiliado', p.numeroAfiliadoHabitual);
      actions.insertAdjacentElement('afterend', row);
    }
  }

  function decorateHCDetail() {
    const box = document.getElementById('hcPacienteDetalle');
    const actions = box?.querySelector('.hc-patient-actions');
    if (!actions || box.querySelector('[data-cl-hc-copy411r]')) return;
    const key = actions.querySelector('[data-hc-new]')?.dataset.hcNew || '';
    const p = patientByKey(key);
    if (!p) return;
    const row = document.createElement('div');
    row.className = 'cl-hc-copy-row411r';
    row.dataset.clHcCopy411r = '1';
    row.innerHTML =
      copyButton('Copiar DNI', p.dni) +
      copyButton('Copiar teléfono', p.telefono) +
      copyButton('Copiar email', p.email) +
      copyButton('Copiar afiliado', p.numeroAfiliadoHabitual);
    const header = box.querySelector('.hc-patient-header');
    if (header) header.insertAdjacentElement('afterend', row);
    else actions.insertAdjacentElement('afterend', row);
  }

  function decorateEvolutionCopies() {
    const modal = document.getElementById('hcEvolutionModal');
    const actions = document.getElementById('hcCopyActions409');
    if (!modal || !actions || actions.querySelector('[data-cl-evo-aff411r]')) return;

    const displayed = modal.querySelector('[data-hc-field409="affiliate"]')?.textContent?.trim() || '';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'secondary';
    b.dataset.clEvoAff411r = '1';
    b.dataset.clCopy411r = encodeURIComponent(displayed === 's/d' ? '' : displayed);
    b.dataset.clCopyLabel411r = 'N.º de afiliado';
    b.textContent = 'Copiar afiliado';
    if (!displayed || displayed === 's/d') b.disabled = true;

    const datosBtn = [...actions.querySelectorAll('button')].find(x => /copiar\s+datos/i.test(x.textContent || ''));
    actions.insertBefore(b, datosBtn || null);
  }

  function decorateFloatingActions() {
    const menu = document.getElementById('cpMenu411B');
    if (!menu || menu.querySelector('[data-cl-floating-copy411r]')) return;
    const p = currentPatient();
    if (!p) return;

    const sep = document.createElement('div');
    sep.className = 'cl-cp-separator411r';
    sep.dataset.clFloatingCopy411r = '1';
    sep.innerHTML = '<span>Copiar datos</span>';
    menu.appendChild(sep);

    [
      ['DNI', p.dni],
      ['Teléfono', p.telefono],
      ['Email', p.email],
      ['Afiliado', p.numeroAfiliadoHabitual]
    ].forEach(([label, value]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.clFloatingCopy411r = '1';
      b.dataset.clCopy411r = encodeURIComponent(String(value || ''));
      b.dataset.clCopyLabel411r = label === 'Afiliado' ? 'N.º de afiliado' : label;
      b.textContent = 'Copiar ' + label.toLowerCase();
      if (!String(value || '').trim()) b.disabled = true;
      menu.appendChild(b);
    });
  }


  /* -----------------------------------------------------------------
     CARGA DE TURNO / ATENCIÓN
     Secretaría puede registrar quién solicita el estudio y la indicación.
     Se guarda dentro del payload de la atención:
       medicoSolicitante
       motivoSolicitud
     ----------------------------------------------------------------- */
  function turnoRequesterValue() {
    const sel = document.getElementById('turnoSolicitante411R');
    if (!sel) return '';
    if (sel.value === '__otro__') {
      return String(document.getElementById('turnoSolicitanteOtro411R')?.value || '').trim();
    }
    return String(sel.value || '').trim();
  }

  function optionsSolicitanteTurno(selected='') {
    const selectedNorm = norm(selected);
    const extras = customSolicitantes();
    const all = [...COLEGAS_FRECUENTES, ...extras, ...ESPECIALIDADES_GENERICAS];
    const exists = all.some(x => norm(x) === selectedNorm);
    const opt = n => `<option value="${esc(n)}" ${norm(n) === selectedNorm ? 'selected' : ''}>${esc(n)}</option>`;
    let html = `<option value="" ${!selected ? 'selected' : ''}>No consignado</option>`;
    html += `<optgroup label="Colegas frecuentes">${COLEGAS_FRECUENTES.map(opt).join('')}</optgroup>`;
    if (extras.length) html += `<optgroup label="Agregados por vos">${extras.map(opt).join('')}</optgroup>`;
    html += `<optgroup label="Especialidades / genéricos">${ESPECIALIDADES_GENERICAS.map(opt).join('')}</optgroup>`;
    html += `<option value="__otro__" ${selected && !exists ? 'selected' : ''}>Otro / no listado</option>`;
    return html;
  }

  function injectTurnoReferralFields() {
    const form = document.getElementById('formAtencion');
    if (!form || document.getElementById('turnoReferral411R')) return;

    const prest = document.getElementById('prestacion');
    const anchor = prest?.closest('div');
    if (!anchor) return;

    const box = document.createElement('div');
    box.id = 'turnoReferral411R';
    box.className = 'full cl-turno-referral411r';
    box.innerHTML = `
      <div class="cl-turno-referral-head411r">
        <div>
          <h3>Solicitud / derivación del estudio</h3>
          <p class="muted">Opcional. Secretaría puede registrar el colega que solicita el estudio y el motivo/indicación.</p>
        </div>
      </div>
      <div class="cl-turno-referral-grid411r">
        <label>Profesional solicitante
          <select id="turnoSolicitante411R">${optionsSolicitanteTurno('')}</select>
        </label>
        <label id="turnoSolicitanteOtroWrap411R" style="display:none">
          Otro / no listado
          <input id="turnoSolicitanteOtro411R" type="text" placeholder="Nombre del profesional">
        </label>
        <label class="cl-turno-motivo411r">Motivo / indicación
          <input id="turnoMotivo411R" type="text" list="turnoMotivos411R"
            placeholder="Ej.: palpitaciones, HTA, síncope, control, prequirúrgico...">
          <datalist id="turnoMotivos411R">
            <option value="Palpitaciones">
            <option value="HTA">
            <option value="Síncope / presíncope">
            <option value="Arritmia">
            <option value="Mareos">
            <option value="Dolor torácico">
            <option value="Disnea">
            <option value="Control">
            <option value="Control de tratamiento">
            <option value="Prequirúrgico">
            <option value="Soplo">
          </datalist>
        </label>
      </div>`;

    anchor.insertAdjacentElement('afterend', box);

    const sel = document.getElementById('turnoSolicitante411R');
    const wrap = document.getElementById('turnoSolicitanteOtroWrap411R');
    sel?.addEventListener('change', () => {
      const other = sel.value === '__otro__';
      if (wrap) wrap.style.display = other ? 'block' : 'none';
      if (other) document.getElementById('turnoSolicitanteOtro411R')?.focus();
    });
  }

  function installAttentionConstructorWrapper() {
    let original = null;
    try {
      original = typeof crearAtencionDesdeFormulario === 'function'
        ? crearAtencionDesdeFormulario
        : window.crearAtencionDesdeFormulario;
    } catch (_) {
      original = window.crearAtencionDesdeFormulario;
    }
    if (typeof original !== 'function' || original.__clReferral411R) return;

    const wrapped = function () {
      const record = original.apply(this, arguments);
      if (record && typeof record === 'object') {
        const solicitante = turnoRequesterValue();
        const motivo = String(document.getElementById('turnoMotivo411R')?.value || '').trim();
        record.medicoSolicitante = solicitante;
        record.motivoSolicitud = motivo;
        if (solicitante) guardarSolicitanteCustom(solicitante);
      }
      return record;
    };
    wrapped.__clReferral411R = true;
    window.crearAtencionDesdeFormulario = wrapped;
    try { crearAtencionDesdeFormulario = wrapped; } catch (_) {}
  }

  function attentionById411R(id) {
    try {
      return (atenciones || []).find(a => String(a.id) === String(id)) || null;
    } catch (_) { return null; }
  }

  function injectEditReferralFields() {
    const modal = document.getElementById('modalEdicionAtencion');
    if (!modal || document.getElementById('m_referral411R')) return;

    let id = modal.dataset.atencionId || '';
    if (!id) {
      const save = modal.querySelector('button[onclick*="guardarEdicionModal"]');
      const oc = save?.getAttribute('onclick') || '';
      const m = oc.match(/guardarEdicionModal\(([^)]+)\)/);
      if (m) id = String(m[1] || '').replace(/['"]/g, '').trim();
    }
    const a = attentionById411R(id);
    if (!a) return;

    const selected = String(a.medicoSolicitante || '').trim();
    const formGrid = modal.querySelector('.modal-form-grid');
    const obs = document.getElementById('m_obs')?.closest('div');
    if (!formGrid || !obs) return;

    const box = document.createElement('div');
    box.id = 'm_referral411R';
    box.className = 'full cl-edit-referral411r';
    box.innerHTML = `
      <h3>Solicitud / derivación del estudio</h3>
      <div class="cl-turno-referral-grid411r">
        <label>Profesional solicitante
          <select id="m_solicitante411R">${optionsSolicitanteTurno(selected)}</select>
        </label>
        <label id="m_solicitanteOtroWrap411R" style="display:${
          selected && ![...COLEGAS_FRECUENTES,...customSolicitantes(),...ESPECIALIDADES_GENERICAS].some(x=>norm(x)===norm(selected))
            ? 'block' : 'none'
        }">
          Otro / no listado
          <input id="m_solicitanteOtro411R" type="text" value="${
            esc(selected && ![...COLEGAS_FRECUENTES,...customSolicitantes(),...ESPECIALIDADES_GENERICAS].some(x=>norm(x)===norm(selected)) ? selected : '')
          }">
        </label>
        <label class="cl-turno-motivo411r">Motivo / indicación
          <input id="m_motivoSolicitud411R" type="text" value="${esc(a.motivoSolicitud || '')}"
            placeholder="Motivo / indicación del estudio">
        </label>
      </div>`;
    formGrid.insertBefore(box, obs);

    const sel = document.getElementById('m_solicitante411R');
    const wrap = document.getElementById('m_solicitanteOtroWrap411R');
    sel?.addEventListener('change', () => {
      const other = sel.value === '__otro__';
      if (wrap) wrap.style.display = other ? 'block' : 'none';
      if (other) document.getElementById('m_solicitanteOtro411R')?.focus();
    });
  }

  function editRequesterValue411R() {
    const sel = document.getElementById('m_solicitante411R');
    if (!sel) return '';
    return sel.value === '__otro__'
      ? String(document.getElementById('m_solicitanteOtro411R')?.value || '').trim()
      : String(sel.value || '').trim();
  }

  function installEditWrapper411R() {
    let original = null;
    try {
      original = typeof guardarEdicionModal === 'function'
        ? guardarEdicionModal
        : window.guardarEdicionModal;
    } catch (_) {
      original = window.guardarEdicionModal;
    }
    if (typeof original !== 'function' || original.__clReferral411R) return;

    const wrapped = function (id) {
      const a = attentionById411R(id);
      if (a && document.getElementById('m_referral411R')) {
        const solicitante = editRequesterValue411R();
        a.medicoSolicitante = solicitante;
        a.motivoSolicitud = String(document.getElementById('m_motivoSolicitud411R')?.value || '').trim();
        if (solicitante) guardarSolicitanteCustom(solicitante);
      }
      return original.apply(this, arguments);
    };
    wrapped.__clReferral411R = true;
    window.guardarEdicionModal = wrapped;
    try { guardarEdicionModal = wrapped; } catch (_) {}
  }

  function extractRequester(text) {
    const s = String(text || '');
    const m = s.match(/^\s*M[ée]dico\s+(?:solicitante|que\s+refiere\s*\/\s*deriva\s*\/\s*solicita)\s*:\s*(.+?)\s*(?:\r?\n|$)/i);
    return m ? String(m[1] || '').trim() : '';
  }

  function stripRequesterHeader(text) {
    return String(text || '').replace(
      /^\s*M[ée]dico\s+(?:solicitante|que\s+refiere\s*\/\s*deriva\s*\/\s*solicita)\s*:\s*.+?\s*(?:\r?\n){1,2}/i,
      ''
    );
  }

  function requesterOptions(selected) {
    const extras = customSolicitantes();
    const allFrequent = COLEGAS_FRECUENTES.slice();
    const selectedNorm = norm(selected);
    const exists = [...allFrequent, ...extras, ...ESPECIALIDADES_GENERICAS]
      .some(x => norm(x) === selectedNorm);

    function opt(n) {
      return `<option value="${esc(n)}" ${norm(n) === selectedNorm ? 'selected' : ''}>${esc(n)}</option>`;
    }

    let html = `<option value="" ${!selected ? 'selected' : ''}>No consignado / sin solicitante</option>`;
    html += `<optgroup label="Colegas frecuentes">${allFrequent.map(opt).join('')}</optgroup>`;
    if (extras.length) html += `<optgroup label="Agregados por vos">${extras.map(opt).join('')}</optgroup>`;
    html += `<optgroup label="Especialidades / genéricos">${ESPECIALIDADES_GENERICAS.map(opt).join('')}</optgroup>`;
    html += `<option value="__otro__" ${selected && !exists ? 'selected' : ''}>Otro / no listado</option>`;
    return html;
  }

  function decorateRequesterField() {
    const modal = document.getElementById('hcEvolutionModal');
    if (!modal || document.getElementById('hcSolicitante411R')) return;

    const evo = document.getElementById('hcEvolucion');
    const existing = extractRequester(evo?.value || '');

    const section = document.createElement('section');
    section.className = 'cl-requester-card411r';
    section.dataset.clRequesterCard411r = '1';
    section.innerHTML = `
      <div class="cl-requester-title411r">
        <div>
          <h3>Médico que refiere / deriva / solicita</h3>
          <p class="muted">Opcional. Se utiliza también para la estadística de colegas que derivan estudios.</p>
        </div>
      </div>
      <div class="cl-requester-grid411r">
        <label>Profesional
          <select id="hcSolicitante411R">${requesterOptions(existing)}</select>
        </label>
        <label id="hcSolicitanteOtroWrap411R" style="display:${existing && ![...COLEGAS_FRECUENTES,...customSolicitantes(),...ESPECIALIDADES_GENERICAS].some(x=>norm(x)===norm(existing)) ? 'block' : 'none'}">
          Otro / no listado
          <input id="hcSolicitanteOtro411R" type="text" value="${esc(existing && ![...COLEGAS_FRECUENTES,...customSolicitantes(),...ESPECIALIDADES_GENERICAS].some(x=>norm(x)===norm(existing)) ? existing : '')}" placeholder="Nombre del profesional">
        </label>
      </div>`;

    const prev = modal.querySelector('#hcPrevSection411');
    const vitals = modal.querySelector('.hc-vitals-section410');
    const anchor = prev || vitals;
    if (anchor) anchor.insertAdjacentElement('beforebegin', section);
    else modal.querySelector('.hc-modal-card')?.appendChild(section);

    const sel = document.getElementById('hcSolicitante411R');
    const otherWrap = document.getElementById('hcSolicitanteOtroWrap411R');
    const other = document.getElementById('hcSolicitanteOtro411R');
    if (sel) {
      sel.dataset.initial411r = existing || '';
      sel.dataset.touched411r = '0';
      sel.addEventListener('change', () => {
        sel.dataset.touched411r = '1';
        const isOther = sel.value === '__otro__';
        if (otherWrap) otherWrap.style.display = isOther ? 'block' : 'none';
        if (isOther) other?.focus();
      });
    }
    other?.addEventListener('input', () => {
      if (sel) sel.dataset.touched411r = '1';
    });
  }

  function selectedRequester() {
    const sel = document.getElementById('hcSolicitante411R');
    if (!sel) return { name:'', touched:false };
    const touched = sel.dataset.touched411r === '1';
    if (sel.value === '__otro__') {
      return { name:String(document.getElementById('hcSolicitanteOtro411R')?.value || '').trim(), touched };
    }
    return { name:String(sel.value || '').trim(), touched };
  }

  function prepareEvolutionBeforeSave() {
    const evo = document.getElementById('hcEvolucion');
    if (!evo) return;
    const existingInText = extractRequester(evo.value);
    const chosen = selectedRequester();

    // Eco/Ecografía existentes ya escriben "Médico solicitante:" antes de hacer clic.
    // Si el selector todavía no fue tocado, respetar ese dato.
    if (!chosen.touched && !chosen.name && existingInText) return;

    const body = stripRequesterHeader(evo.value).trimStart();
    if (chosen.name) {
      guardarSolicitanteCustom(chosen.name);
      evo.value = `Médico solicitante: ${chosen.name}\n\n${body}`.trimEnd();
    } else if (chosen.touched) {
      evo.value = body;
    }
  }

  function studyClass(motivo) {
    const n = norm(motivo);
    if (n.includes('holter')) return 'holter';
    if (n.includes('mapa')) return 'mapa';
    if (n.includes('ecocardiograma')) return 'eco';
    if (n.includes('ecografia')) return 'usg';
    if (n.includes('electro') || n === 'ecg' || n.includes(' ecg')) return 'ecg';
    if (n.includes('consulta') && !/(holter|mapa|eco|electro|ecg)/.test(n)) return 'consulta';
    return 'otros';
  }

  function referralEvents() {
    const events = [];
    const seen = new Set();

    // Fuente principal: turnos/atenciones donde Secretaría o el profesional
    // consignó explícitamente médico solicitante.
    try {
      (atenciones || []).forEach(a => {
        const requester = String(a?.medicoSolicitante || '').trim();
        if (!requester) return;
        const estado = norm(a?.estadoTurno || '');
        if (estado === 'cancelado' || estado === 'ausente') return;
        const type = studyClass(a?.prestacion || '');
        if (type === 'consulta') return;
        const fecha = String(a?.fecha || '').slice(0,10);
        const patientKey = String(a?.pacienteId || digits(a?.dni) || norm(a?.paciente || ''));
        const key = `${patientKey}|${fecha}|${type}|${norm(requester)}`;
        if (seen.has(key)) return;
        seen.add(key);
        events.push({
          requester,
          fecha,
          profesionalId:String(a?.profesionalId || ''),
          profesionalNombre:String(a?.profesional || ''),
          motivo:String(a?.prestacion || ''),
          indicacion:String(a?.motivoSolicitud || ''),
          type,
          source:'atencion'
        });
      });
    } catch (_) {}

    // Compatibilidad con Eco/Ecografía y evoluciones antiguas que ya guardaban
    // "Médico solicitante: ..." dentro de la narrativa.
    try {
      const list = Array.isArray(data?.evolucionesClinicas) ? data.evolucionesClinicas : [];
      list.forEach(e => {
        const requester = extractRequester(e.evolucion || '');
        if (!requester) return;
        const type = studyClass(e.motivo || '');
        if (type === 'consulta') return;
        const fecha = String(e.fechaHora || e.creadoEn || '').slice(0,10);
        const patientKey = String(e.pacienteId || '');
        const key = `${patientKey}|${fecha}|${type}|${norm(requester)}`;
        if (seen.has(key)) return;
        seen.add(key);
        events.push({
          requester,
          fecha,
          profesionalId:String(e.profesionalId || ''),
          profesionalNombre:String(e.profesionalNombre || ''),
          motivo:String(e.motivo || ''),
          indicacion:'',
          type,
          source:'evolucion'
        });
      });
    } catch (_) {}

    return events;
  }


  function esConsulta411R(nombre) {
    const n = norm(nombre);
    return n.includes('consulta') && !/(holter|mapa|eco|doppler|duplex|ergometr|ecg|electro|mamograf)/.test(n);
  }

  function serviceLabel411R(nombre) {
    return String(nombre || '').trim() || 'Otros';
  }

  function prestacionesStats411R(evs, profId) {
    // Perfil seleccionado: mostrar columnas según lo tildado en su configuración,
    // aunque una prestación tenga cero estudios en el período.
    if (profId) {
      try {
        const p = (data.profesionales || []).find(x => String(x.id) === String(profId));
        const arr = Array.isArray(p?.prestaciones) ? p.prestaciones.slice() : [];
        return arr.filter(x => !esConsulta411R(x)).sort((a,b)=>String(a).localeCompare(String(b),'es'));
      } catch (_) {}
    }

    // Vista todos: mostrar solo prestaciones que realmente tuvieron derivaciones
    // en el período, para evitar decenas de columnas vacías.
    const out = [];
    const seen = new Set();
    evs.forEach(e => {
      const s = serviceLabel411R(e.motivo);
      if (esConsulta411R(s)) return;
      const k = norm(s);
      if (!k || seen.has(k)) return;
      seen.add(k);
      out.push(s);
    });
    return out.sort((a,b)=>String(a).localeCompare(String(b),'es'));
  }

  function matchesPrest411R(eventMotivo, columna) {
    const a = norm(eventMotivo), b = norm(columna);
    if (a === b) return true;
    // Compatibilidad razonable con nombres históricos.
    if (b.includes('ecocardiograma') && a.includes('ecocardiograma')) return true;
    if (b.includes('electrocardiograma') && (a.includes('electrocardiograma') || a === 'ecg')) return true;
    if (b === 'mapa' && a.includes('mapa')) return true;
    if (b.includes('holter') && a.includes('holter')) return true;
    if (b.includes('ergometr') && a.includes('ergometr')) return true;
    if ((b.includes('transcraneal') || b.includes('duplex')) && (a.includes('transcraneal') || a.includes('duplex'))) return true;
    return false;
  }

  function statsFilters() {
    const desde = document.getElementById('statsDesde')?.value || '';
    const hasta = document.getElementById('statsHasta')?.value || '';
    const prof = document.getElementById('statsProfesional')?.value || '';
    const prest = document.getElementById('statsPrestacion')?.value || '';
    return { desde, hasta, prof, prest };
  }

  function renderReferralStats() {
    const card = document.getElementById('clReferralStats411R');
    if (!card) return;
    const f = statsFilters();

    let evs = referralEvents().filter(e =>
      (!f.desde || e.fecha >= f.desde) &&
      (!f.hasta || e.fecha <= f.hasta) &&
      (!f.prof || e.profesionalId === f.prof || e.profesionalNombre === f.prof) &&
      (!f.prest || norm(e.motivo).includes(norm(f.prest)))
    );

    const columnas = prestacionesStats411R(evs, f.prof);
    const map = new Map();

    evs.forEach(e => {
      const key = e.requester;
      if (!map.has(key)) map.set(key, { name:key, total:0, by:{} });
      const x = map.get(key);
      x.total++;
      const col = columnas.find(c => matchesPrest411R(e.motivo, c)) || serviceLabel411R(e.motivo);
      x.by[col] = (x.by[col] || 0) + 1;
    });

    const rows = [...map.values()].sort((a,b) => b.total - a.total || a.name.localeCompare(b.name,'es'));
    const total = evs.length;

    const headCols = columnas.map(c => `<th>${esc(c)}</th>`).join('');
    const cuerpo = rows.length ? rows.map((r,i) => `
      <tr>
        <td><strong>${i+1}. ${esc(r.name)}</strong></td>
        <td>${r.total}</td>
        ${columnas.map(c => `<td>${r.by[c] || 0}</td>`).join('')}
        <td>${total ? Math.round(r.total*100/total) : 0}%</td>
      </tr>`).join('') :
      `<tr><td colspan="${3 + columnas.length}" class="muted">No hay estudios con médico solicitante en el período seleccionado.</td></tr>`;

    card.querySelector('[data-cl-referral-summary411r]').textContent =
      `${total} estudio(s) / derivación(es) · ${rows.length} colega(s)` +
      ((f.desde || f.hasta) ? ` · período ${f.desde || 'inicio'} a ${f.hasta || 'hoy'}` : '');

    const thead = card.querySelector('thead tr');
    if (thead) {
      thead.innerHTML = `<th>Médico solicitante</th><th>Total</th>${headCols}<th>%</th>`;
    }
    card.querySelector('tbody').innerHTML = cuerpo;
  }

  function decorateStats() {
    const sec = document.getElementById('estadisticas');
    if (!sec || document.getElementById('clReferralStats411R')) return;

    const card = document.createElement('div');
    card.id = 'clReferralStats411R';
    card.className = 'card cl-referral-stats411r';
    card.innerHTML = `
      <div class="cl-referral-stats-head411r">
        <div>
          <h3>Médicos que refieren / solicitan estudios</h3>
          <p class="muted">Ranking por período. Incluye solicitudes cargadas por Secretaría y las registradas en Eco/Ecografía. Respeta los filtros de fecha, profesional y prestación.</p>
        </div>
        <strong data-cl-referral-summary411r>0 estudios</strong>
      </div>
      <div class="cl-referral-table-wrap411r">
        <table>
          <thead>
            <tr>
              <th>Médico solicitante</th>
              <th>Total</th>
              <th>%</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>`;

    const charts = sec.querySelector('.charts-grid');
    if (charts) charts.insertAdjacentElement('beforebegin', card);
    else sec.querySelector('.estadisticas-card')?.appendChild(card);

    ['statsDesde','statsHasta','statsProfesional','statsPrestacion'].forEach(id => {
      document.getElementById(id)?.addEventListener('change', renderReferralStats);
      document.getElementById(id)?.addEventListener('input', renderReferralStats);
    });
    renderReferralStats();
  }

  let queued = false;
  function decorateAll() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      injectTurnoReferralFields();
      installAttentionConstructorWrapper();
      installEditWrapper411R();
      injectEditReferralFields();
      addAffiliateToGenericCopyRows();
      decoratePatientFicha();
      decorateHCDetail();
      decorateEvolutionCopies();
      decorateRequesterField();
      decorateFloatingActions();
      decorateStats();
      renderReferralStats();
    });
  }

  document.addEventListener('click', async e => {
    const copy = e.target.closest?.('[data-cl-copy411r]');
    if (copy) {
      e.preventDefault();
      e.stopPropagation();
      const value = decodeURIComponent(copy.dataset.clCopy411r || '');
      const label = copy.dataset.clCopyLabel411r || 'Dato';
      const ok = await copyText(value, label);
      if (ok) {
        const old = copy.textContent;
        copy.textContent = 'Copiado ✓';
        setTimeout(() => { if (copy.isConnected) copy.textContent = old; }, 900);
      }
      return;
    }

    if (e.target.closest?.('#hcGuardarEvolucion')) {
      // Captura previa al onclick original de app.js.
      prepareEvolutionBeforeSave();
      return;
    }

    if (e.target.closest?.('[data-cp-toggle411b]')) {
      setTimeout(decorateFloatingActions, 0);
    }

    if (e.target.closest?.('.nav[data-section="estadisticas"]')) {
      setTimeout(() => { decorateStats(); renderReferralStats(); }, 80);
    }

    setTimeout(decorateAll, 40);
  }, true);

  const observer = new MutationObserver(() => decorateAll());
  if (document.documentElement) {
    observer.observe(document.documentElement, { childList:true, subtree:true });
  }

  function boot() {
    decorateAll();
    setTimeout(decorateAll, 500);
    setTimeout(decorateAll, 1500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.CardioLinkReferidos411R = {
    renderStats: renderReferralStats,
    eventos: referralEvents
  };
})();

(function () {
  if (document.getElementById('cl-hc-referidos-style411r')) return;
  const s = document.createElement('style');
  s.id = 'cl-hc-referidos-style411r';
  s.textContent = `
    .cl-turno-referral411r,.cl-edit-referral411r{
      border:1px solid #d8e2eb;border-radius:14px;background:#f8fbfd;
      padding:14px 16px;margin:4px 0;
    }
    .cl-turno-referral-head411r h3,.cl-edit-referral411r h3{margin:0 0 3px}
    .cl-turno-referral-head411r p{margin:0}
    .cl-turno-referral-grid411r{
      display:grid;grid-template-columns:minmax(250px,1fr) minmax(220px,1fr) minmax(280px,1.3fr);
      gap:12px;margin-top:12px;align-items:end;
    }
    .cl-turno-referral-grid411r label{font-weight:700}
    .cl-turno-referral-grid411r select,.cl-turno-referral-grid411r input{width:100%;margin-top:5px}
    .cl-turno-motivo411r{grid-column:auto}
    .cl-hc-copy-row411r{
      display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 16px;
    }
    .cl-hc-copy-row411r button{min-height:38px}
    .cl-requester-card411r{
      border:1px solid #d7e1eb;border-radius:14px;background:#f8fbfd;
      padding:14px 16px;margin:0 0 16px;
    }
    .cl-requester-title411r h3{margin:0 0 3px}
    .cl-requester-title411r p{margin:0}
    .cl-requester-grid411r{
      display:grid;grid-template-columns:minmax(280px,1fr) minmax(220px,1fr);
      gap:12px;margin-top:12px;
    }
    .cl-requester-grid411r label{font-weight:700}
    .cl-requester-grid411r select,.cl-requester-grid411r input{width:100%;margin-top:5px}
    .cl-cp-separator411r{
      border-top:1px solid #d8e2ea;margin-top:6px;padding-top:8px;
      font-size:11px;font-weight:800;color:#6b7c8f;text-transform:uppercase;letter-spacing:.06em
    }
    .cl-cp-separator411r span{padding:0 12px}
    .cl-referral-stats411r{margin-top:16px;padding:18px}
    .cl-referral-stats-head411r{
      display:flex;justify-content:space-between;gap:16px;align-items:flex-start;margin-bottom:14px
    }
    .cl-referral-stats-head411r h3{margin:0 0 3px}
    .cl-referral-stats-head411r p{margin:0}
    .cl-referral-stats-head411r>strong{
      white-space:nowrap;background:#eef6fb;border:1px solid #d2e2ee;border-radius:999px;padding:7px 11px
    }
    .cl-referral-table-wrap411r{overflow:auto}
    .cl-referral-table-wrap411r table{width:100%;min-width:680px}
    .cl-referral-table-wrap411r th,.cl-referral-table-wrap411r td{
      padding:10px 9px;text-align:left;border-bottom:1px solid #e6edf3
    }
    .cl-referral-table-wrap411r th{font-size:11px;text-transform:uppercase;color:#607386}
    @media(max-width:1000px){
      .cl-turno-referral-grid411r{grid-template-columns:1fr 1fr}
      .cl-turno-motivo411r{grid-column:1/-1}
    }
    @media(max-width:760px){
      .cl-requester-grid411r,.cl-turno-referral-grid411r{grid-template-columns:1fr}
      .cl-turno-motivo411r{grid-column:auto}
      .cl-referral-stats-head411r{flex-direction:column}
    }
  `;
  document.head.appendChild(s);
})();
