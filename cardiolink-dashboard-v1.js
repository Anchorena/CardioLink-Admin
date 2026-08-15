/* =====================================================================
   CardioLink Admin — Dashboard V1
   Portada operativa. Reutiliza datos, permisos y flujos existentes.
   Orden de carga: después de app.js y los módulos funcionales.
   ===================================================================== */
(function () {
  'use strict';

  if (window.CardioLinkDashboardV1) return;

  const byId = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
  const norm = (value) => String(value || '').trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  function todayValue() {
    try {
      if (typeof todayISO === 'function') return todayISO();
    } catch (_) {}
    const date = new Date();
    const offset = date.getTimezoneOffset() * 60000;
    return new Date(date - offset).toISOString().slice(0, 10);
  }

  function scopedAttentions() {
    try {
      const list = typeof atencionesPerfil === 'function' ? atencionesPerfil() : [];
      return Array.isArray(list) ? list : [];
    } catch (error) {
      console.warn('Dashboard V1: no se pudieron leer las atenciones del perfil.', error);
      return [];
    }
  }

  function attentionState(attention) {
    try {
      return typeof estadoTurno === 'function'
        ? String(estadoTurno(attention) || '').toLowerCase()
        : String(attention?.estadoTurno || attention?.estado || 'reservado').toLowerCase();
    } catch (_) {
      return String(attention?.estadoTurno || attention?.estado || 'reservado').toLowerCase();
    }
  }

  function isRealizedActivity(attention) {
    return !['ausente', 'cancelado'].includes(attentionState(attention));
  }

  function pendingItems(list) {
    const pendingFor = window.pendientesDeAtencion383;
    if (typeof pendingFor !== 'function') return [];
    return list.filter((attention) => {
      try {
        const pending = pendingFor(attention);
        return Array.isArray(pending) && pending.length > 0;
      } catch (_) { return false; }
    });
  }

  function pendingDays(attention) {
    try {
      if (typeof diasAntiguedadPendiente411C === 'function') {
        return diasAntiguedadPendiente411C(attention);
      }
    } catch (_) {}
    return null;
  }

  function patientKey(attention) {
    const dni = String(attention?.dni || '').replace(/\D/g, '');
    return String(attention?.pacienteId || dni || norm(attention?.paciente || '')).trim();
  }

  function activeProfile() {
    try {
      if (typeof perfilObj === 'function') return perfilObj() || {};
    } catch (_) {}
    return {};
  }

  function currentUser() {
    try {
      if (typeof perfilUsuarioActual === 'function') return perfilUsuarioActual() || {};
    } catch (_) {}
    return {};
  }

  function identityProfile(user, active) {
    const professionals = typeof data !== 'undefined' && Array.isArray(data?.profesionales) ? data.profesionales : [];
    return professionals.find((profile) => profile.id === user.profesionalId)
      || (active?.id && active.id !== 'general' ? active : null)
      || professionals.find((profile) => profile.id === 'matias')
      || professionals.find((profile) => profile.id !== 'general')
      || {};
  }

  function specialtiesText(user, profile) {
    const specialties = typeof data !== 'undefined' && Array.isArray(data?.especialidades) ? data.especialidades : [];
    const userIds = Array.isArray(user.especialidadIds) ? user.especialidadIds : [];
    const profileIds = Array.isArray(profile.especialidadIds) ? profile.especialidadIds : [];
    if (!user.profesionalId && user.especialidad) return user.especialidad;
    const ids = [...new Set([...userIds, ...profileIds])];
    const names = ids.map((id) => specialties.find((item) => item.id === id)?.nombre).filter(Boolean);
    return names.length ? names.join(' · ') : (user.especialidad || profile.area || profile.especialidad || 'Equipo CardioLink');
  }

  function firstName(name) {
    const clean = String(name || 'Usuario').replace(/^Dra?\.?\s+/i, '').trim();
    return clean.split(/\s+/)[0] || 'Usuario';
  }

  function greeting(name) {
    const hour = new Date().getHours();
    const prefix = hour < 12 ? 'Buenos días' : hour < 20 ? 'Buenas tardes' : 'Buenas noches';
    return `${prefix}, ${firstName(name)}`;
  }

  function todayLabel() {
    const value = new Date().toLocaleDateString('es-AR', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    });
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  function statusBadge(attention) {
    try {
      if (typeof estadoAgendaBadge === 'function') return estadoAgendaBadge(attention);
    } catch (_) {}
    const state = attentionState(attention);
    let label = state || 'Reservado';
    try {
      if (typeof nombreEstadoTurnoLabel === 'function') label = nombreEstadoTurnoLabel(state);
    } catch (_) {}
    return `<span class="agenda-status">${esc(label)}</span>`;
  }

  function summaryData() {
    const all = scopedAttentions();
    const today = todayValue();
    const todayList = all.filter((attention) => attention?.fecha === today);
    const realized = todayList.filter(isRealizedActivity);
    let activity = { consultas: 0, estudios: 0 };
    try {
      if (typeof resumen === 'function') activity = resumen(realized);
    } catch (_) {}
    const patients = new Set(realized.map(patientKey).filter(Boolean));
    const room = todayList.filter((attention) => ['sala_espera', 'en_sala', 'llego', 'en_espera'].includes(attentionState(attention))).length;
    const pending = pendingItems(all);
    const absent = todayList.filter((attention) => attentionState(attention) === 'ausente').length;
    const cancelled = todayList.filter((attention) => attentionState(attention) === 'cancelado').length;
    return {
      all,
      todayList,
      patients: patients.size,
      consultations: Number(activity.consultas || 0),
      studies: Number(activity.estudios || 0),
      room,
      pending,
      absent,
      cancelled
    };
  }

  function upcomingAppointments(todayList) {
    const now = new Date();
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    return todayList
      .filter((attention) => !['atendido', 'ausente', 'cancelado', 'reprogramado'].includes(attentionState(attention)))
      .filter((attention) => !attention.horaInicio || String(attention.horaInicio) >= currentTime)
      .sort((a, b) => String(a.horaInicio || '99:99').localeCompare(String(b.horaInicio || '99:99'))
        || String(a.paciente || '').localeCompare(String(b.paciente || ''), 'es'))
      .slice(0, 5);
  }

  function renderIdentity(user, active) {
    const profile = identityProfile(user, active);
    const logo = byId('dashboardLogoV1');
    const logoSource = profile.logoDocumentoData || profile.logoDocumento || 'icons/icon-192.png';
    if (logo) {
      logo.onerror = () => {
        if (!logo.src.endsWith('/icons/icon-192.png')) logo.src = 'icons/icon-192.png';
      };
      logo.src = logoSource;
      logo.alt = `Identidad de ${profile.marcaDocumento || profile.nombre || 'CardioLink'}`;
    }
    if (byId('dashboardMarcaV1')) byId('dashboardMarcaV1').textContent = profile.marcaDocumento || 'CardioLink Admin';
    if (byId('dashboardSaludoV1')) byId('dashboardSaludoV1').textContent = greeting(user.nombre || user.usuario);
    if (byId('dashboardUsuarioV1')) byId('dashboardUsuarioV1').textContent = user.nombre || user.usuario || 'Usuario';
    if (byId('dashboardEspecialidadesV1')) byId('dashboardEspecialidadesV1').textContent = specialtiesText(user, profile);
    if (byId('dashboardFechaV1')) {
      byId('dashboardFechaV1').dateTime = todayValue();
      byId('dashboardFechaV1').textContent = todayLabel();
    }
    if (byId('dashboardPerfilV1')) byId('dashboardPerfilV1').textContent = `Perfil activo: ${active.nombre || 'Vista general'}`;
    if (byId('dashboardResumenContextoV1')) byId('dashboardResumenContextoV1').textContent = active.area || active.nombre || 'Todos los profesionales';
  }

  function renderKpis(summary) {
    const values = {
      dashboardPacientesHoyV1: summary.patients,
      dashboardConsultasHoyV1: summary.consultations,
      dashboardEstudiosHoyV1: summary.studies,
      dashboardSalaV1: summary.room,
      dashboardPendientesV1: summary.pending.length,
      dashboardAusentesV1: summary.absent,
      dashboardCanceladosV1: summary.cancelled
    };
    Object.entries(values).forEach(([id, value]) => {
      const element = byId(id);
      if (element) element.textContent = String(value);
    });
  }

  function renderUpcoming(todayList) {
    const container = byId('dashboardProximosV1');
    if (!container) return;
    const appointments = upcomingAppointments(todayList);
    if (!appointments.length) {
      container.innerHTML = '<div class="dashboard-empty-v1"><strong>No hay próximos turnos para hoy.</strong><span>La agenda queda disponible desde los accesos rápidos.</span></div>';
      return;
    }
    container.innerHTML = appointments.map((attention) => `
      <article class="dashboard-upcoming-row-v1">
        <button type="button" class="dashboard-time-v1" data-dashboard-appointment-v1="${esc(attention.id)}" aria-label="Abrir turno de ${esc(attention.paciente || 'paciente')}">
          <time>${esc(attention.horaInicio || 's/h')}</time>
        </button>
        <button type="button" class="dashboard-patient-v1" data-dashboard-patient-v1="${esc(attention.id)}" aria-label="Abrir ficha de ${esc(attention.paciente || 'paciente')}">
          <strong>${esc(attention.paciente || 'Paciente')}</strong>
        </button>
        <span class="dashboard-service-v1">${esc(attention.prestacion || 'Sin prestación')}</span>
        <span class="dashboard-professional-v1">${esc(attention.profesional || 'Sin profesional')}</span>
        <span class="dashboard-status-v1">${statusBadge(attention)}</span>
      </article>`).join('');
  }

  function renderAlerts(summary) {
    const container = byId('dashboardAlertasV1');
    if (!container) return;
    const overdue = summary.pending.filter((attention) => {
      const days = pendingDays(attention);
      return days !== null && days > 7;
    }).length;
    const critical = summary.pending.filter((attention) => {
      const days = pendingDays(attention);
      return days !== null && days > 14;
    }).length;
    const alerts = [];
    if (summary.room) alerts.push({ action: 'waiting', tone: 'room', label: 'Pacientes esperando', value: summary.room });
    if (overdue) alerts.push({ action: 'overdue', tone: 'warning', label: 'Pendientes vencidos', value: overdue });
    if (critical) alerts.push({ action: 'overdue', tone: 'critical', label: 'Pendientes críticos', value: critical });
    container.innerHTML = alerts.length ? alerts.map((alert) => `
      <button type="button" class="dashboard-alert-v1 dashboard-alert-${alert.tone}-v1" data-dashboard-action-v1="${alert.action}">
        <span>${esc(alert.label)}</span><strong>${alert.value}</strong>
      </button>`).join('') : '<div class="dashboard-no-alerts-v1"><span>✓</span><div><strong>Sin alertas operativas</strong><small>No hay esperas ni pendientes vencidos para este perfil.</small></div></div>';
  }

  function render() {
    const dashboard = byId('dashboard');
    if (!dashboard) return;
    const user = currentUser();
    const active = activeProfile();
    const summary = summaryData();
    renderIdentity(user, active);
    renderKpis(summary);
    renderUpcoming(summary.todayList);
    renderAlerts(summary);
    const evolution = byId('dashboardNuevaEvolucionV1');
    if (evolution) {
      let allowed = false;
      try { allowed = typeof puedeAccederInformacionClinica === 'function' && puedeAccederInformacionClinica(); } catch (_) {}
      evolution.hidden = !allowed;
      evolution.classList.toggle('hidden-permission', !allowed);
    }
    const pendingAction = byId('dashboardPendientesActionV1');
    if (pendingAction) {
      let allowed = true;
      try { allowed = typeof seccionPermitida !== 'function' || seccionPermitida('pendientes383'); } catch (_) {}
      pendingAction.hidden = !allowed;
    }
  }

  function openSection(section) {
    const navigate = window.showSection || (typeof showSection === 'function' ? showSection : null);
    if (navigate) navigate(section);
  }

  function openWaitingRoom() {
    openSection('agenda');
    const date = byId('agendaFecha');
    const state = byId('agendaEstado');
    if (date && typeof todayISO === 'function') date.value = todayISO();
    if (state) state.value = 'sala_espera';
    try { if (typeof renderAgenda === 'function') renderAgenda(); } catch (_) {}
  }

  function handleDashboardClick(event) {
    const patient = event.target.closest('[data-dashboard-patient-v1]');
    if (patient) {
      const openPatient = window.abrirFichaPacienteDesdePendiente411C;
      if (typeof openPatient === 'function') openPatient(patient.dataset.dashboardPatientV1);
      else {
        const openAppointment = window.abrirAgendaModal || (typeof abrirAgendaModal === 'function' ? abrirAgendaModal : null);
        if (openAppointment) openAppointment(patient.dataset.dashboardPatientV1);
      }
      return;
    }
    const appointment = event.target.closest('[data-dashboard-appointment-v1]');
    if (appointment) {
      const open = window.abrirAgendaModal || (typeof abrirAgendaModal === 'function' ? abrirAgendaModal : null);
      if (open) open(appointment.dataset.dashboardAppointmentV1);
      return;
    }
    const action = event.target.closest('[data-dashboard-action-v1]')?.dataset.dashboardActionV1;
    if (!action) return;
    if (action === 'waiting') return openWaitingRoom();
    if (action === 'pending') return openSection('pendientes383');
    if (action === 'patients') return openSection('pacientes');
    if (action === 'agenda') return openSection('agenda');
    if (action === 'overdue') {
      if (typeof window.verPendientesVencidos411C === 'function') return window.verPendientesVencidos411C();
      return openSection('pendientes383');
    }
  }

  function bind() {
    const dashboard = byId('dashboard');
    if (!dashboard || dashboard.dataset.dashboardV1Bound === '1') return;
    dashboard.dataset.dashboardV1Bound = '1';
    dashboard.addEventListener('click', handleDashboardClick);
  }

  function boot() {
    bind();
    render();
  }

  window.CardioLinkDashboardV1 = { render };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
