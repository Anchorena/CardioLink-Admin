/* =====================================================================
   CardioLink — Correcciones de la barra flotante "Paciente actual"
   No modifica app.js. Actúa a nivel del DOM, después de que la app
   procesa el clic (fase de burbuja, la app usa fase de captura).
   Para revertir: quitar el <script> a este archivo en index.html.
 
   Qué resuelve:
   1) Al tocar la "×", app.js a veces vuelve a mostrar el mismo
      paciente, en cualquier pantalla (no solo Historia Clínica),
      porque además de la sesión guardada, también mira una variable
      global (pacienteSeleccionadoPanelId) que queda pegada en el
      último paciente visto en la lista de "Pacientes" y nunca se
      resetea sola. Ahora se limpia esa variable también, no solo la
      sesión guardada.
   2) La barra solo aparecía al abrir un paciente desde Historia
      Clínica. Al elegirlo desde la lista de "Pacientes" o desde el
      buscador global, la clave no llegaba conectada — ahora también
      se activa desde esos dos lugares.
   ===================================================================== */
(function () {
  if (window.__cardiolinkClearFixInstalled) return;
  window.__cardiolinkClearFixInstalled = true;
 
  const FLAG = 'cl_patient_cleared_411b';
 
  function suprimido() {
    try { return sessionStorage.getItem(FLAG) === '1'; } catch (_) { return false; }
  }
  function suprimir() {
    try { sessionStorage.setItem(FLAG, '1'); } catch (_) {}
  }
  function liberar() {
    try { sessionStorage.removeItem(FLAG); } catch (_) {}
  }
  function ocultarBarra() {
    const bar = document.getElementById('currentPatient411B');
    if (bar && !bar.classList.contains('hidden')) {
      bar.classList.add('hidden');
    }
  }
  // Causa raíz encontrada: además de la sesión guardada, app.js
  // también "adivina" el paciente actual mirando esta variable, que
  // queda pegada en el paciente que se vio último en la lista de
  // Pacientes y nunca se resetea sola al navegar a otra pantalla.
  // Por eso el cartel podía reaparecer en cualquier lado (Carga de
  // turno, Historia Clínica, etc.) sin importar qué se hiciera con
  // la sesión guardada.
  function limpiarSeleccionPanel() {
    try {
      if (typeof pacienteSeleccionadoPanelId !== 'undefined') pacienteSeleccionadoPanelId = '';
      if (typeof window.pacienteSeleccionadoPanelId !== 'undefined') window.pacienteSeleccionadoPanelId = '';
    } catch (_) {}
  }
 
  // Corre en fase de burbuja: después de que app.js (que escucha en
  // fase de captura) ya procesó el clic y decidió si mostrar la barra.
  document.addEventListener('click', function (e) {
    const btnQuitar = e.target.closest('[data-cp-action411b="clear"]');
    if (btnQuitar) {
      suprimir();
      limpiarSeleccionPanel();
      requestAnimationFrame(ocultarBarra);
      setTimeout(ocultarBarra, 60);
      return;
    }
 
    // Selección desde la lista de "Pacientes": la clave viaja codificada
    // (encodeURIComponent) y app.js no la conecta con la barra flotante.
    const filaPacientes = e.target.closest('[data-patient-open4091]');
    if (filaPacientes) {
      liberar();
      try {
        const key = decodeURIComponent(filaPacientes.dataset.patientOpen4091 || '');
        if (key && window.CardioLinkPacienteActual411B?.set) {
          window.CardioLinkPacienteActual411B.set(key);
        }
      } catch (_) {}
      return;
    }
 
    // Selección desde el buscador global (arriba a la derecha).
    const filaBusqueda = e.target.closest('[data-patient-id]');
    if (filaBusqueda && filaBusqueda.closest('#resultadosGlobal360')) {
      liberar();
      try {
        const key = filaBusqueda.dataset.patientId || '';
        if (key && window.CardioLinkPacienteActual411B?.set) {
          window.CardioLinkPacienteActual411B.set(key);
        }
      } catch (_) {}
      return;
    }
 
    // Otras formas de elegir un paciente de forma explícita: liberan
    // la supresión aunque ya tengan su propio camino para mostrarse.
    const eleccionPaciente = e.target.closest(
      '[data-hc-patient],[data-hc-new],[data-open-hc],[data-rcta-patient4095],[data-cp-action411b="open"]'
    );
    if (eleccionPaciente) liberar();
  }, false);
 
  // Si algo (auto-refresco, re-render, etc.) intenta reaparecer la
  // barra mientras está suprimida, la volvemos a ocultar al toque, y
  // también volvemos a limpiar la variable que la resucita.
  const observer = new MutationObserver(() => {
    if (suprimido()) { limpiarSeleccionPanel(); ocultarBarra(); }
  });
  (function esperarBarra() {
    const bar = document.getElementById('currentPatient411B');
    if (bar) {
      observer.observe(bar, { attributes: true, attributeFilter: ['class'] });
      if (suprimido()) ocultarBarra();
    } else {
      setTimeout(esperarBarra, 400);
    }
  })();
})();