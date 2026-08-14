/* =====================================================================
   CardioLink — Prestaciones habilitadas por profesional
   v1 · 2026-08-14

   Usa la estructura existente:
     data.profesionales[].prestaciones

   Objetivo:
   - Catálogo global de prestaciones.
   - Cada profesional tilda/destilda qué realiza actualmente.
   - Secretaría ve automáticamente solo las prestaciones habilitadas
     para el profesional seleccionado.
   - No borra historial cuando una prestación se deshabilita.
   ===================================================================== */
(function () {
  'use strict';
  if (window.__cardiolinkPrestacionesPerfil411P) return;
  window.__cardiolinkPrestacionesPerfil411P = true;

  const SEED = [
    'Consulta',
    'Electrocardiograma',
    'Ecocardiograma Doppler',
    'Holter',
    'MAPA',
    'Ergometría',
    'Doppler / Duplex transcraneal',
    'Doppler carotídeo',
    'Doppler arterial',
    'Doppler venoso',
    'Ecografía abdominal',
    'Ecografía renal',
    'Ecografía tiroidea',
    'Ecografía mamaria',
    'Ecografía general',
    'Mamografía'
  ];

  const $p = id => document.getElementById(id);

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'
    }[c]));
  }

  function norm(v) {
    return String(v || '').trim().toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  function puedeConfigurar() {
    try {
      if (typeof esMatiasDuenio === 'function' && esMatiasDuenio()) return true;
      if (typeof esAdminComun === 'function' && esAdminComun()) return true;
    } catch (_) {}
    return false;
  }

  function asegurarCatalogo() {
    try {
      if (!data || typeof data !== 'object') return [];
      if (!Array.isArray(data.catalogoPrestaciones411P)) data.catalogoPrestaciones411P = [];
      const actuales = (data.profesionales || []).flatMap(p => Array.isArray(p.prestaciones) ? p.prestaciones : []);
      const union = [...data.catalogoPrestaciones411P, ...actuales, ...SEED]
        .map(x => String(x || '').trim()).filter(Boolean);
      const uniq = [];
      const seen = new Set();
      union.forEach(x => {
        const k = norm(x);
        if (!k || seen.has(k)) return;
        seen.add(k);
        uniq.push(x);
      });
      uniq.sort((a,b) => a.localeCompare(b,'es'));
      data.catalogoPrestaciones411P = uniq;
      return uniq;
    } catch (_) {
      return SEED.slice();
    }
  }

  function guardar() {
    try { if (typeof saveConfig === 'function') saveConfig(); } catch (_) {}
    try { if (typeof refreshSelects === 'function') refreshSelects(); } catch (_) {}
    try { actualizarPrestacionesSeguro(); } catch (_) {}
    try { renderMatriz(); } catch (_) {}
  }

  function estudiosDe(p) {
    return Array.isArray(p?.prestaciones) ? p.prestaciones : [];
  }

  function activa(p, prest) {
    return estudiosDe(p).some(x => norm(x) === norm(prest));
  }

  function setActiva(profId, prest, on) {
    const p = (data.profesionales || []).find(x => String(x.id) === String(profId));
    if (!p) return;
    p.prestaciones = Array.isArray(p.prestaciones) ? p.prestaciones.slice() : [];
    const key = norm(prest);

    if (on) {
      if (!p.prestaciones.some(x => norm(x) === key)) p.prestaciones.push(prest);
    } else {
      p.prestaciones = p.prestaciones.filter(x => norm(x) !== key);
    }
    guardar();
  }

  function actualizarPrestacionesSeguro() {
    const profSel = $p('profesional');
    const prestSel = $p('prestacion');
    if (!profSel || !prestSel) return;

    const p = (data.profesionales || []).find(x => String(x.id) === String(profSel.value));
    const items = p && Array.isArray(p.prestaciones) ? p.prestaciones.slice() : [];
    const anterior = prestSel.value;

    prestSel.innerHTML = '';
    if (!items.length) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = 'Sin prestaciones habilitadas para este profesional';
      prestSel.appendChild(o);
      prestSel.disabled = true;
    } else {
      prestSel.disabled = false;
      items.sort((a,b)=>String(a).localeCompare(String(b),'es')).forEach(x => {
        const o = document.createElement('option');
        o.value = x;
        o.textContent = x;
        prestSel.appendChild(o);
      });
      if (items.some(x => x === anterior)) prestSel.value = anterior;
    }

    // Prestaciones adicionales: ocultar/deshabilitar las que este perfil no realiza.
    document.querySelectorAll('.extra-prestacion').forEach(ch => {
      const nombre = ch.dataset.prestacion || '';
      const habilitada = !!p && activa(p, nombre);
      const label = ch.closest('label');
      ch.disabled = !habilitada || nombre === prestSel.value;
      if (!habilitada) ch.checked = false;
      if (label) label.style.display = habilitada ? '' : 'none';
    });

    try { if (typeof aplicarRegla === 'function' && prestSel.value) aplicarRegla(); } catch (_) {}
  }

  function injectConfigCard() {
    const grid = document.querySelector('#config .config-grid');
    if (!grid || !puedeConfigurar()) {
      $p('clPrestacionesPerfil411P')?.remove();
      return;
    }
    asegurarCatalogo();

    let card = $p('clPrestacionesPerfil411P');
    if (!card) {
      card = document.createElement('div');
      card.id = 'clPrestacionesPerfil411P';
      card.className = 'cl-prest-card411p';
      card.dataset.configGroupCard = 'prestaciones';
      card.innerHTML = `
        <div class="cl-prest-head411p">
          <div>
            <h3>Prestaciones habilitadas por profesional</h3>
            <p class="muted">
              Tildá lo que realiza actualmente cada profesional. Destildar no borra estudios previos:
              solamente deja de ofrecer esa prestación para turnos nuevos.
            </p>
          </div>
        </div>
        <div class="cl-prest-add411p">
          <input id="clNuevaPrest411P" type="text" placeholder="Nueva prestación futura o actual">
          <button id="clAddPrest411P" type="button" class="primary">Agregar al catálogo</button>
        </div>
        <div id="clPrestMatrixWrap411P" class="cl-prest-matrix-wrap411p"></div>`;
      const oldPrest = [...grid.children].find(x => x.querySelector?.('#listaPrestaciones'));
      if (oldPrest) oldPrest.insertAdjacentElement('afterend', card);
      else grid.appendChild(card);

      card.addEventListener('click', e => {
        const add = e.target.closest('#clAddPrest411P');
        if (add) {
          const inp = $p('clNuevaPrest411P');
          const nombre = String(inp?.value || '').trim();
          if (!nombre) return;
          const cat = asegurarCatalogo();
          if (!cat.some(x => norm(x) === norm(nombre))) data.catalogoPrestaciones411P.push(nombre);
          if (inp) inp.value = '';
          guardar();
          return;
        }

        const del = e.target.closest('[data-cl-del-prest411p]');
        if (del) {
          const nombre = decodeURIComponent(del.dataset.clDelPrest411p || '');
          const usada = (data.profesionales || []).some(p => activa(p, nombre));
          if (usada) {
            alert('Esta prestación está habilitada en al menos un profesional. Destildala primero antes de quitarla del catálogo.');
            return;
          }
          if (!confirm(`Quitar "${nombre}" del catálogo? No afecta estudios históricos.`)) return;
          data.catalogoPrestaciones411P = asegurarCatalogo().filter(x => norm(x) !== norm(nombre));
          try { if (typeof saveConfig === 'function') saveConfig(); } catch (_) {}
          renderMatriz();
          return;
        }
      });

      card.addEventListener('change', e => {
        const ch = e.target.closest('[data-cl-prof-prest411p]');
        if (!ch) return;
        const [pid, enc] = String(ch.dataset.clProfPrest411p || '').split('|');
        const prest = decodeURIComponent(enc || '');
        setActiva(pid, prest, !!ch.checked);
      });
    }

    renderMatriz();
  }

  function renderMatriz() {
    const wrap = $p('clPrestMatrixWrap411P');
    if (!wrap || !puedeConfigurar()) return;

    const catalogo = asegurarCatalogo();
    const profs = (data.profesionales || []).filter(p => p.id !== 'general');

    const head = profs.map(p => `<th title="${esc(p.nombre)}">${esc(p.nombre)}</th>`).join('');
    const rows = catalogo.map(prest => {
      const checks = profs.map(p => `
        <td>
          <label class="cl-matrix-check411p" title="${esc(p.nombre)} · ${esc(prest)}">
            <input type="checkbox"
              data-cl-prof-prest411p="${esc(p.id)}|${encodeURIComponent(prest)}"
              ${activa(p, prest) ? 'checked' : ''}>
            <span></span>
          </label>
        </td>`).join('');

      const usada = profs.some(p => activa(p, prest));
      return `<tr>
        <th class="cl-prest-name411p">
          <span>${esc(prest)}</span>
          ${usada ? '' : `<button type="button" class="cl-prest-del411p" data-cl-del-prest411p="${encodeURIComponent(prest)}" title="Quitar del catálogo">×</button>`}
        </th>
        ${checks}
      </tr>`;
    }).join('');

    wrap.innerHTML = `
      <table class="cl-prest-matrix411p">
        <thead><tr><th>Prestación</th>${head}</tr></thead>
        <tbody>${rows || '<tr><td>Sin prestaciones configuradas.</td></tr>'}</tbody>
      </table>`;
  }

  function installPrestWrapper() {
    let original;
    try { original = actualizarPrestaciones; } catch (_) { original = window.actualizarPrestaciones; }
    if (typeof original !== 'function' || original.__clPerfil411P) return;

    const wrapped = function () {
      actualizarPrestacionesSeguro();
    };
    wrapped.__clPerfil411P = true;
    window.actualizarPrestaciones = wrapped;
    try { actualizarPrestaciones = wrapped; } catch (_) {}
  }

  function installHooks() {
    const prof = $p('profesional');
    if (prof && !prof.dataset.clPerfil411P) {
      prof.dataset.clPerfil411P = '1';
      prof.addEventListener('change', () => setTimeout(actualizarPrestacionesSeguro, 0));
    }

    // El renderConfig original sigue funcionando; este módulo agrega la matriz después.
    let rc;
    try { rc = renderConfig; } catch (_) { rc = window.renderConfig; }
    if (typeof rc === 'function' && !rc.__clPerfil411P) {
      const wrapped = function () {
        const r = rc.apply(this, arguments);
        setTimeout(injectConfigCard, 0);
        return r;
      };
      wrapped.__clPerfil411P = true;
      window.renderConfig = wrapped;
      try { renderConfig = wrapped; } catch (_) {}
    }
  }

  function boot() {
    asegurarCatalogo();
    installPrestWrapper();
    installHooks();
    injectConfigCard();
    actualizarPrestacionesSeguro();
    setTimeout(() => {
      injectConfigCard();
      actualizarPrestacionesSeguro();
    }, 700);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.CardioLinkPrestacionesPerfil411P = {
    catalogo: asegurarCatalogo,
    render: renderMatriz,
    actualizarCarga: actualizarPrestacionesSeguro
  };
})();

(function () {
  if (document.getElementById('cl-prestaciones-perfil-style411p')) return;
  const s = document.createElement('style');
  s.id = 'cl-prestaciones-perfil-style411p';
  s.textContent = `
    .cl-prest-card411p{
      grid-column:1/-1;
      border:1px solid #d9e3ec;border-radius:14px;background:#fbfdff;padding:16px;
    }
    .cl-prest-card411p h3{margin:0 0 4px}
    .cl-prest-card411p p{margin:0}
    .cl-prest-add411p{display:flex;gap:10px;margin:14px 0}
    .cl-prest-add411p input{flex:1}
    .cl-prest-matrix-wrap411p{overflow:auto;border:1px solid #e0e8ef;border-radius:12px;background:#fff}
    .cl-prest-matrix411p{width:max-content;min-width:100%;border-collapse:separate;border-spacing:0}
    .cl-prest-matrix411p th,.cl-prest-matrix411p td{
      padding:9px 10px;border-bottom:1px solid #edf2f6;border-right:1px solid #edf2f6;
      text-align:center;white-space:nowrap;
    }
    .cl-prest-matrix411p thead th{
      position:sticky;top:0;z-index:3;background:#eef5fa;font-size:11px;
    }
    .cl-prest-matrix411p thead th:first-child,
    .cl-prest-name411p{
      position:sticky;left:0;z-index:2;text-align:left!important;background:#f8fbfd!important;
    }
    .cl-prest-matrix411p thead th:first-child{z-index:4;background:#eaf3f8!important}
    .cl-prest-name411p{min-width:220px;display:flex;justify-content:space-between;gap:8px;align-items:center}
    .cl-prest-del411p{
      border:0;background:transparent;color:#9a3412;font-size:18px;line-height:1;cursor:pointer
    }
    .cl-matrix-check411p{display:inline-grid;place-items:center;margin:0}
    .cl-matrix-check411p input{width:18px;height:18px;cursor:pointer}
    @media(max-width:760px){
      .cl-prest-add411p{flex-direction:column}
      .cl-prest-name411p{min-width:185px}
    }
  `;
  document.head.appendChild(s);
})();
