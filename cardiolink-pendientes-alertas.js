/* =====================================================================
   CardioLink — Semáforo de antigüedad en "Pendientes"
   No modifica app.js: envuelve renderPendientes383 (ya expuesta en
   window) y, después de cada render, colorea las tarjetas según hace
   cuántos días está pendiente cada atención.
   Para revertir: quitar el <script> a este archivo en index.html.

   Criterio de color (ajustable más abajo, ALERTA_DIAS / CRITICO_DIAS):
     - Menos de 7 días: sin marca (normal).
     - 7 a 9 días: borde ámbar (alerta).
     - 10 días o más: borde rojo (crítico).
   ===================================================================== */
(function () {
  if (window.__cardiolinkPendientesAlertas) return;
  window.__cardiolinkPendientesAlertas = true;

  const ALERTA_DIAS = 7;
  const CRITICO_DIAS = 10;

  function obtenerAtenciones() {
    try {
      if (Array.isArray(window.atenciones)) return window.atenciones;
    } catch (_) {}
    try {
      // eslint-disable-next-line no-undef
      if (typeof atenciones !== 'undefined' && Array.isArray(atenciones)) return atenciones;
    } catch (_) {}
    return [];
  }

  function diasDesde(fechaISO) {
    if (!fechaISO) return null;
    const f = new Date(fechaISO + 'T00:00:00');
    if (isNaN(f.getTime())) return null;
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
    return Math.floor((hoy - f) / 86400000);
  }

  function nivelAlerta(dias) {
    if (dias === null || dias < ALERTA_DIAS) return '';
    if (dias >= CRITICO_DIAS) return 'cl-pend-critico';
    return 'cl-pend-alerta';
  }

  function aplicarColores() {
    const lista = obtenerAtenciones();
    document.querySelectorAll('.pend-card383').forEach((card) => {
      card.classList.remove('cl-pend-alerta', 'cl-pend-critico');
      const btn = card.querySelector('[onclick^="abrirFichaPacienteDesdePendiente411C"]');
      if (!btn) return;
      const m = /abrirFichaPacienteDesdePendiente411C\('([^']*)'\)/.exec(btn.getAttribute('onclick') || '');
      if (!m) return;
      const a = lista.find((x) => String(x.id) === m[1]);
      if (!a) return;
      const dias = diasDesde(a.fecha);
      const nivel = nivelAlerta(dias);
      if (nivel) card.classList.add(nivel);
      if (dias !== null) card.title = `Pendiente hace ${dias} día(s)`;
    });
  }

  function envolverRender() {
    if (typeof window.renderPendientes383 !== 'function') return false;
    const original = window.renderPendientes383;
    if (original.__clWrapped) return true;
    const nueva = function () {
      const r = original.apply(this, arguments);
      setTimeout(aplicarColores, 0);
      return r;
    };
    nueva.__clWrapped = true;
    window.renderPendientes383 = nueva;
    return true;
  }

  let intentos = 0;
  const t = setInterval(() => {
    intentos++;
    if (envolverRender() || intentos > 40) clearInterval(t);
  }, 500);

  // Por si la sección "Pendientes" ya está visible en pantalla.
  setTimeout(aplicarColores, 800);
})();
