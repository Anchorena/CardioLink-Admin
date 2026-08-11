/* =====================================================================
   CardioLink — Fix: "Quitar paciente actual" no debe reaparecer solo
   No modifica app.js. Actúa a nivel del DOM, después de que la app
   procesa el clic (fase de burbuja, la app usa fase de captura).
   Para revertir: quitar el <script> a este archivo en index.html.

   Qué resuelve:
   Al tocar la "×" de la barra flotante de paciente, app.js a veces
   vuelve a mostrar el mismo paciente si seguís parado en su ficha
   (Historia Clínica, etc.), porque re-detecta "cuál es el paciente
   actual" mirando la pantalla. Esto hace que la barra "no se pueda
   sacar" mientras seguís en esa ficha.

   Ahora: al tocar "×", se marca una supresión que mantiene la barra
   oculta pase lo que pase, hasta que elijas otro paciente de forma
   explícita (buscador, HC, evolución, etc.) — recién ahí se libera.
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
    // Elegir un paciente de forma explícita libera la supresión.
    const eleccionPaciente = e.target.closest(
      '[data-hc-patient],[data-hc-new],[data-open-hc],[data-patient-open4091],[data-rcta-patient4095],[data-cp-action411b="open"]'
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
