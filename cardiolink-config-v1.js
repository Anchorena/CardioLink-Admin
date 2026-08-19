(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document) api.install(root);
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const SECTIONS = Object.freeze([
    { id: 'profesionales', title: 'Profesionales y equipo', description: 'Perfiles, especialidades y relación operativa del equipo.' },
    { id: 'prestaciones', title: 'Prestaciones', description: 'Catálogo y prestaciones habilitadas por profesional.' },
    { id: 'coberturas', title: 'Coberturas y valores', description: 'Obras sociales, convenios, aranceles, valores y reglas existentes.' },
    { id: 'documentos', title: 'Documentos e identidad', description: 'Membrete, logo, firma y datos profesionales usados en documentos.' },
    { id: 'usuarios', title: 'Usuarios y accesos', description: 'Accesos al sistema, roles actuales y asociación con profesionales.' },
    { id: 'administracion', title: 'Administración', description: 'Parámetros administrativos existentes, sin duplicar Finanzas 5.' },
    { id: 'datos', title: 'Datos y backups', description: 'Respaldo, restauración y control cotidiano de la calidad de datos.' },
    { id: 'ayuda', title: 'Ayuda', description: 'Guías breves y acceso al centro de Instructivos.' },
    { id: 'seguridad', title: 'Mantenimiento / Seguridad', description: 'Diagnóstico y acciones sensibles reservadas a perfiles autorizados.', sensitive: true }
  ]);

  const CARD_SECTIONS = Object.freeze({
    cfgProfesionalesBasicoV1A: 'profesionales',
    cfgEspecialidades310: 'profesionales',
    cfgPerfilProfesional310: 'profesionales',
    clPrestacionesPerfil411P: 'prestaciones',
    configBloquesPrestaciones297: 'prestaciones',
    cfgPrestacionesLegacyV1A: 'prestaciones',
    cfgObrasSocialesV1A: 'coberturas',
    cfgConveniosProfesional402: 'coberturas',
    cfgValoresProfesionalV1A: 'coberturas',
    cfgReglasObraSocialV1A: 'coberturas',
    cfgConvenios3102: 'coberturas',
    cfgAranceles3102: 'coberturas',
    cfgUsuariosSistemaV1A: 'usuarios',
    cfgRoles310: 'usuarios',
    cfgFinanzas411F: 'administracion',
    cfgProduccionEstimada3102: 'administracion',
    cfgBackupDatosV1A: 'datos',
    cfgCalidadDatosV1A: 'datos',
    cfgInstalacionAppV1A: 'ayuda',
    cfgMantenimientoPacientesV1A: 'seguridad',
    cfgMantenimientoTecnicoV1A: 'seguridad',
    cfgEstadoSistemaV1A: 'seguridad',
    cfgAuditoriaResumenV1A: 'seguridad',
    cfgPreparacionHCV1A: 'seguridad'
  });

  const FALLBACK_SECTIONS = Object.freeze({
    profesionales: 'profesionales',
    prestaciones: 'prestaciones',
    coberturas: 'coberturas',
    usuarios: 'usuarios',
    administracion: 'administracion',
    mantenimiento: 'seguridad',
    sistema: 'seguridad'
  });

  const EDITOR_KINDS = Object.freeze({
    clPrestacionesPerfil411P: ['Editor principal', 'principal'],
    configBloquesPrestaciones297: ['Configuración avanzada', 'advanced'],
    cfgPrestacionesLegacyV1A: ['Compatibilidad / legado', 'legacy'],
    cfgConveniosProfesional402: ['Editor principal', 'principal'],
    cfgObrasSocialesV1A: ['Catálogo global', 'catalog'],
    cfgValoresProfesionalV1A: ['Compatibilidad / valores base', 'legacy'],
    cfgReglasObraSocialV1A: ['Compatibilidad / reglas heredadas', 'legacy'],
    cfgConvenios3102: ['Compatibilidad / legado', 'legacy'],
    cfgAranceles3102: ['Compatibilidad / legado', 'legacy'],
    cfgFinanzas411F: ['Configuración administrativa existente', 'advanced'],
    cfgProduccionEstimada3102: ['Consulta administrativa existente', 'legacy']
  });

  let activeSection = 'profesionales';
  let refreshTimer = 0;

  function classifyCard(card) {
    if (!card) return '';
    if (card.id && CARD_SECTIONS[card.id]) return CARD_SECTIONS[card.id];
    const legacyGroup = card.dataset && (card.dataset.configGroupCard || card.dataset.configGroup360);
    return FALLBACK_SECTIONS[legacyGroup] || '';
  }

  function summarizeTeam(config, includeUsers) {
    const source = config && typeof config === 'object' ? config : {};
    const specialties = new Map((source.especialidades || []).map(item => [String(item.id), item.nombre]));
    const users = Array.isArray(source.usuarios) ? source.usuarios : [];
    return (Array.isArray(source.profesionales) ? source.profesionales : [])
      .filter(professional => professional && professional.id !== 'general')
      .map(professional => {
        const specialtyNames = (professional.especialidadIds || []).map(id => specialties.get(String(id))).filter(Boolean);
        const area = specialtyNames.length ? specialtyNames.join(' · ') : (professional.area || 'Sin especialidad informada');
        const prestations = Array.isArray(professional.prestaciones) ? professional.prestaciones.filter(Boolean) : [];
        const associatedUsers = includeUsers ? users
          .filter(user => user && String(user.profesionalId || '') === String(professional.id))
          .map(user => user.nombre || user.usuario)
          .filter(Boolean) : [];
        return {
          id: String(professional.id || ''),
          name: professional.nombre || 'Profesional sin nombre',
          specialty: area,
          active: professional.activo !== false,
          prestations,
          users: associatedUsers
        };
      });
  }

  function currentData() {
    try {
      return typeof data !== 'undefined' && data ? data : null;
    } catch (_) {
      return null;
    }
  }

  function canViewUserAssociations() {
    try {
      return typeof puedeGestionarConfigAdministrativa === 'function' && puedeGestionarConfigAdministrativa();
    } catch (_) {
      return false;
    }
  }

  function makeElement(doc, tag, className, text) {
    const element = doc.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function ensureRegions(doc) {
    const grid = doc.querySelector('#config .config-grid');
    if (!grid) return null;
    grid.classList.add('config-v1a-grid');
    SECTIONS.forEach(section => {
      let region = doc.getElementById(`configV1Region-${section.id}`);
      if (!region) {
        region = makeElement(doc, 'section', `config-v1a-region${section.sensitive ? ' config-v1a-region-sensitive' : ''}`);
        region.id = `configV1Region-${section.id}`;
        region.dataset.configV1Region = section.id;
        region.dataset.configV1Generated = 'true';
        region.setAttribute('role', 'tabpanel');
        region.setAttribute('aria-labelledby', `configV1Tab-${section.id}`);
        const heading = makeElement(doc, 'header', 'config-v1a-region-heading');
        const title = makeElement(doc, 'h3', '', section.title);
        title.id = `configV1Title-${section.id}`;
        heading.append(title, makeElement(doc, 'p', 'muted', section.description));
        const body = makeElement(doc, 'div', 'config-v1a-region-grid');
        body.dataset.configV1Body = section.id;
        region.append(heading, body);
        grid.appendChild(region);
      }
    });
    return grid;
  }

  function moveKnownCards(doc, grid) {
    Object.entries(CARD_SECTIONS).forEach(([id, section]) => {
      const card = doc.getElementById(id);
      const body = doc.querySelector(`[data-config-v1-body="${section}"]`);
      if (card && body && card.parentElement !== body) body.appendChild(card);
    });

    Array.from(grid.children).forEach(card => {
      if (card.dataset.configV1Region || card.dataset.configV1Generated) return;
      const section = classifyCard(card);
      const body = section && doc.querySelector(`[data-config-v1-body="${section}"]`);
      if (body) body.appendChild(card);
    });
  }

  function applyEditorKinds(doc) {
    Object.entries(EDITOR_KINDS).forEach(([id, definition]) => {
      const card = doc.getElementById(id);
      if (!card) return;
      let badge = card.querySelector(':scope > .config-v1a-editor-kind');
      if (!badge) {
        badge = makeElement(doc, 'span', 'config-v1a-editor-kind');
        card.insertBefore(badge, card.firstChild);
      }
      badge.textContent = definition[0];
      badge.dataset.kind = definition[1];
    });
  }

  function ensureTeamSummary(doc) {
    const body = doc.querySelector('[data-config-v1-body="profesionales"]');
    if (!body) return;
    let card = doc.getElementById('configV1TeamSummary');
    if (!card) {
      card = makeElement(doc, 'div', 'config-v1a-summary-card');
      card.id = 'configV1TeamSummary';
      card.dataset.configV1Generated = 'true';
      body.prepend(card);
    }
    const showUserAssociations = canViewUserAssociations();
    const rows = summarizeTeam(currentData(), showUserAssociations);
    card.classList.toggle('without-user-access', !showUserAssociations);
    card.replaceChildren();
    const head = makeElement(doc, 'div', 'config-v1a-summary-head');
    head.append(makeElement(doc, 'h4', '', 'Vista rápida del equipo'), makeElement(doc, 'span', 'config-v1a-count', `${rows.length} profesional${rows.length === 1 ? '' : 'es'}`));
    card.appendChild(head);
    if (!rows.length) {
      card.appendChild(makeElement(doc, 'p', 'muted', 'Todavía no hay profesionales configurados.'));
      return;
    }
    const list = makeElement(doc, 'div', 'config-v1a-team-list');
    rows.forEach(row => {
      const item = makeElement(doc, 'article', 'config-v1a-team-row');
      const identity = makeElement(doc, 'div', 'config-v1a-team-identity');
      identity.append(makeElement(doc, 'strong', '', row.name), makeElement(doc, 'span', 'muted', row.specialty));
      const status = makeElement(doc, 'span', `config-v1a-status ${row.active ? 'is-active' : 'is-inactive'}`, row.active ? 'Activo' : 'Inactivo');
      const prestations = makeElement(doc, 'div', 'config-v1a-team-detail');
      prestations.append(makeElement(doc, 'small', '', 'Prestaciones'), makeElement(doc, 'span', '', row.prestations.length ? `${row.prestations.length} habilitadas` : 'Sin prestaciones habilitadas'));
      item.append(identity, status, prestations);
      if (showUserAssociations) {
        const access = makeElement(doc, 'div', 'config-v1a-team-detail');
        access.append(makeElement(doc, 'small', '', 'Usuario asociado'), makeElement(doc, 'span', '', row.users.length ? row.users.join(', ') : 'Sin acceso propio'));
        item.appendChild(access);
      }
      list.appendChild(item);
    });
    card.appendChild(list);
  }

  function ensureIdentityCard(doc) {
    const body = doc.querySelector('[data-config-v1-body="documentos"]');
    if (!body) return;
    let card = doc.getElementById('configV1IdentityCard');
    if (!card) {
      card = makeElement(doc, 'div', 'config-v1a-identity-card');
      card.id = 'configV1IdentityCard';
      card.dataset.configV1Generated = 'true';
      const context = makeElement(doc, 'div', 'config-v1a-context-note');
      const copy = makeElement(doc, 'div');
      copy.append(makeElement(doc, 'strong', '', 'Profesional seleccionado'), makeElement(doc, 'p', 'muted', 'La identidad corresponde al profesional elegido en “Perfil profesional”.'));
      const button = makeElement(doc, 'button', 'secondary', 'Cambiar profesional');
      button.type = 'button';
      button.dataset.configV1Go = 'profesionales';
      context.append(copy, button);
      const host = makeElement(doc, 'div', 'config-v1a-identity-host');
      host.dataset.configV1IdentityHost = 'true';
      card.append(context, host);
      body.appendChild(card);
    }
    const host = card.querySelector('[data-config-v1-identity-host]');
    const fields = doc.getElementById('docProfFields402');
    if (fields && host && fields.parentElement !== host) host.appendChild(fields);
    card.hidden = !fields;
  }

  function ensureUsersContext(doc) {
    const body = doc.querySelector('[data-config-v1-body="usuarios"]');
    if (!body) return;
    let note = doc.getElementById('configV1UsersContext');
    if (!note) {
      note = makeElement(doc, 'div', 'config-v1a-definition-note');
      note.id = 'configV1UsersContext';
      note.dataset.configV1Generated = 'true';
      const user = makeElement(doc, 'p');
      user.append(makeElement(doc, 'strong', '', 'Usuario = '), doc.createTextNode('acceso al sistema.'));
      const professional = makeElement(doc, 'p');
      professional.append(makeElement(doc, 'strong', '', 'Profesional = '), doc.createTextNode('persona que presta servicios.'));
      note.append(user, professional);
      body.prepend(note);
    }
  }

  function ensureSecurityNotice(doc) {
    const body = doc.querySelector('[data-config-v1-body="seguridad"]');
    if (!body) return;
    let notice = doc.getElementById('configV1SecurityNotice');
    if (!notice) {
      notice = makeElement(doc, 'div', 'config-v1a-security-notice');
      notice.id = 'configV1SecurityNotice';
      notice.dataset.configV1Generated = 'true';
      notice.append(makeElement(doc, 'strong', '', 'Zona sensible'), makeElement(doc, 'p', '', 'Revisá el alcance de cada acción antes de ejecutarla. Los permisos y confirmaciones existentes siguen vigentes.'));
      body.prepend(notice);
    }
  }

  function ensureHelp(doc) {
    const body = doc.querySelector('[data-config-v1-body="ayuda"]');
    if (!body) return;
    let card = doc.getElementById('configV1HelpCard');
    if (card) return;
    card = makeElement(doc, 'div', 'config-v1a-help-card');
    card.id = 'configV1HelpCard';
    card.dataset.configV1Generated = 'true';
    card.appendChild(makeElement(doc, 'h4', '', 'Guías rápidas'));
    const guides = [
      ['Cómo crear un profesional', 'Creá el perfil y luego completá especialidades y prestaciones habilitadas.'],
      ['Cómo configurar una prestación', 'Usá el editor principal para el catálogo y la matriz; los bloques quedan como configuración avanzada.'],
      ['Cómo configurar convenio y arancel', 'Primero habilitá el convenio para el profesional y luego cargá el valor con su vigencia.'],
      ['Usuario vs Profesional', 'El usuario inicia sesión; el profesional presta servicios y puede existir sin acceso propio.'],
      ['Backup vs Restauración', 'Exportar descarga una copia. Restaurar reemplaza la configuración y las atenciones locales con el archivo elegido.'],
      ['Firma y membrete', 'La identidad se guarda por profesional y se aplica a los documentos que ya la utilizan.']
    ];
    const list = makeElement(doc, 'div', 'config-v1a-help-list');
    guides.forEach((guide, index) => {
      const details = makeElement(doc, 'details');
      if (index === 0) details.open = true;
      details.append(makeElement(doc, 'summary', '', guide[0]), makeElement(doc, 'p', 'muted', guide[1]));
      list.appendChild(details);
    });
    const openGuide = makeElement(doc, 'button', 'secondary', 'Abrir centro de Instructivos');
    openGuide.type = 'button';
    openGuide.dataset.configV1OpenHelp = 'true';
    card.append(list, openGuide);
    body.prepend(card);
  }

  function isVisibleCard(card) {
    if (!card || card.hidden || card.classList.contains('hidden-permission')) return false;
    return !card.style || card.style.display !== 'none';
  }

  function sectionHasContent(doc, section) {
    const body = doc.querySelector(`[data-config-v1-body="${section}"]`);
    if (!body) return false;
    if (section === 'documentos') return !!doc.getElementById('docProfFields402');
    if (section === 'ayuda') return true;
    return Array.from(body.children).some(card => !card.dataset.configV1Generated && isVisibleCard(card));
  }

  function activateSection(doc, requested) {
    const availability = new Map(SECTIONS.map(section => [section.id, sectionHasContent(doc, section.id)]));
    doc.querySelectorAll('[data-config-v1-section]').forEach(button => {
      const available = availability.get(button.dataset.configV1Section) !== false;
      button.hidden = !available;
    });
    if (!availability.get(requested)) requested = SECTIONS.find(section => availability.get(section.id))?.id || 'ayuda';
    activeSection = requested;
    doc.querySelectorAll('[data-config-v1-section]').forEach(button => {
      const selected = button.dataset.configV1Section === activeSection;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-selected', String(selected));
      button.id = `configV1Tab-${button.dataset.configV1Section}`;
      button.setAttribute('role', 'tab');
    });
    doc.querySelectorAll('[data-config-v1-region]').forEach(region => {
      region.hidden = region.dataset.configV1Region !== activeSection;
      region.classList.remove('config-hidden-360');
    });
  }

  function refreshLegacyPanels(doc, section) {
    const groups = section === 'ayuda' ? ['sistema'] : section === 'datos' ? ['mantenimiento'] : section === 'seguridad' ? ['mantenimiento', 'sistema'] : [];
    groups.forEach(group => doc.querySelector(`[data-config-v1-legacy-trigger="${group}"]`)?.click());
  }

  function refresh(root) {
    const doc = root.document;
    const grid = ensureRegions(doc);
    if (!grid) return;
    moveKnownCards(doc, grid);
    applyEditorKinds(doc);
    ensureTeamSummary(doc);
    ensureIdentityCard(doc);
    ensureUsersContext(doc);
    ensureSecurityNotice(doc);
    ensureHelp(doc);
    activateSection(doc, activeSection);
    doc.querySelector('#config')?.classList.add('config-v1a-ready');
  }

  function scheduleRefresh(root, delay) {
    root.clearTimeout(refreshTimer);
    refreshTimer = root.setTimeout(() => refresh(root), Number(delay) || 0);
  }

  function installRenderAdapter(root) {
    const previous = root.renderConfig;
    if (typeof previous !== 'function' || previous.__configV1A) return;
    const wrapped = function () {
      const result = previous.apply(this, arguments);
      scheduleRefresh(root, 90);
      return result;
    };
    wrapped.__configV1A = true;
    wrapped.__configV1APrevious = previous;
    root.renderConfig = wrapped;
    try { renderConfig = wrapped; } catch (_) {}
  }

  function bindPresentation(root) {
    const doc = root.document;
    doc.addEventListener('click', event => {
      const tab = event.target.closest?.('[data-config-v1-section]');
      if (tab) {
        activateSection(doc, tab.dataset.configV1Section);
        refreshLegacyPanels(doc, tab.dataset.configV1Section);
        return;
      }
      const go = event.target.closest?.('[data-config-v1-go]');
      if (go) {
        activateSection(doc, go.dataset.configV1Go);
        doc.getElementById('cfgPerfilProfesional310')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
        return;
      }
      if (event.target.closest?.('[data-config-v1-open-help]')) {
        doc.querySelector('.nav[data-section="instructivos"]')?.click();
        return;
      }
      if (event.target.closest?.('.nav[data-section="config"]')) scheduleRefresh(root, 140);
      else if (event.target.closest?.('#config')) scheduleRefresh(root, 140);
    });
    doc.addEventListener('change', event => {
      if (event.target.closest?.('#config') || event.target.id === 'perfilActivo') scheduleRefresh(root, 140);
    });
  }

  function install(root) {
    installRenderAdapter(root);
    bindPresentation(root);
    const boot = () => {
      scheduleRefresh(root, 120);
      root.setTimeout(() => refresh(root), 900);
      root.setTimeout(() => refresh(root), 1900);
    };
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
  }

  return {
    sections: SECTIONS,
    cardSections: CARD_SECTIONS,
    editorKinds: EDITOR_KINDS,
    classifyCard,
    summarizeTeam,
    install
  };
});
