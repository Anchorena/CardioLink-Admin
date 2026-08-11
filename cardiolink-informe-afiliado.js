/* =====================================================================
   CardioLink -- Sumar N de afiliado a los documentos impresos
   No modifica app.js. Intercepta window.open (API del navegador, no de
   la app) para detectar cuando se abre una ventana de impresion de un
   documento clinico, y le agrega el N de afiliado del paciente, que la
   app hoy no incluye ahi (solo muestra DNI y cobertura).
   Aplica a TODOS los documentos: recetas, ordenes, certificados,
   ecografias, etc., porque todos pasan por la misma funcion de
   impresion interna de la app.
   Para revertir: quitar el <script> a este archivo en index.html.
   ===================================================================== */
(function () {
  if (window.__cardiolinkAfiliadoPatch) return;
  window.__cardiolinkAfiliadoPatch = true;

  function buscarPacientePorDni(dniLimpio) {
    try {
      var lista = (typeof data !== 'undefined' && data && Array.isArray(data.pacientes))
        ? data.pacientes
        : (window.data && Array.isArray(window.data.pacientes) ? window.data.pacientes : []);
      return lista.find(function (p) {
        return String(p.dni || '').replace(/\D/g, '') === dniLimpio;
      }) || null;
    } catch (e) { return null; }
  }

  function agregarAfiliado(ventana) {
    try {
      var meta = ventana.document && ventana.document.querySelector('.patient-box .meta');
      if (!meta) return;
      var texto = meta.textContent || '';
      if (texto.indexOf('afiliado') !== -1) return; // ya se agrego una vez
      var m = /DNI\s*([\d.]+)/.exec(texto);
      if (!m) return;
      var dniLimpio = m[1].replace(/\D/g, '');
      var pac = buscarPacientePorDni(dniLimpio);
      if (pac && pac.numeroAfiliadoHabitual) {
        meta.textContent = texto + ' \u00b7 N\u00b0 de afiliado ' + pac.numeroAfiliadoHabitual;
      }
    } catch (e) {}
  }

  var openOriginal = window.open;
  window.open = function () {
    var w = openOriginal.apply(window, arguments);
    if (w) {
      // setTimeout 0: deja que la app termine de escribir el documento
      // (document.write/close, que corren justo despues del open())
      // antes de leer y tocar su contenido.
      setTimeout(function () { agregarAfiliado(w); }, 0);
    }
    return w;
  };
})();
