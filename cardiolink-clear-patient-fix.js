/* =====================================================================
   CardioLink — Correcciones de la barra flotante "Paciente actual"
   No modifica app.js. Actúa a nivel del DOM, después de que la app
   procesa el clic (fase de burbuja, la app usa fase de captura).
   Para revertir: quitar el <script> a este archivo en index.html.

   Qué resuelve:
   1) Al tocar la "×", app.js a veces vuelve a mostrar el mismo
      paciente si seguís parado en su ficha (Historia Clínica), porque
      re-detecta "cuál es el paciente actual" mirando la pantalla.
      Ahora se marca una supresión que mantiene la barra oculta hasta
      que elijas otro paciente de forma explícita.
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

  // Corre en fase de burbuja: después de que app.js (que escucha en
  // fase de captura) ya procesó el clic y decidió si mostrar la barra.
  document.addEventListener('click', function (e) {
    const btnQuitar = e.target.closest('[data-cp-action411b="clear"]');
    if (btnQuitar) {
      suprimir();
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
  // barra mientras está suprimida, la volvemos a ocultar al toque.
  const observer = new MutationObserver(() => {
    if (suprimido()) ocultarBarra();
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
