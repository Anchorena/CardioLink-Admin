/* =====================================================================
   CardioLink -- Ajustes a los documentos impresos (PDF)
   No modifica app.js. Intercepta window.open (API del navegador, no de
   la app) para detectar cuando se abre una ventana de impresion de un
   documento clinico, y le hace tres ajustes:
   1) Agrega el N de afiliado del paciente (la app solo mostraba DNI
      y cobertura).
   2) Evita que la firma quede sola en una segunda pagina casi en
      blanco cuando el contenido es corto.
   3) Agrega un boton para cerrar la ventana (no tenia forma de
      cerrarse, sobre todo un problema en iPhone).
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

  // Evita que quede una segunda pagina casi en blanco con solo la
  // firma: la plantilla original le da una altura minima fija al
  // cuerpo del texto, y con contenidos cortos eso empuja la firma de
  // mas. Sacamos esa altura minima para que la firma quede pegada al
  // contenido real.
  function corregirSaltoDePagina(ventana) {
    try {
      var cuerpo = ventana.document && ventana.document.querySelector('main.body');
      if (cuerpo) cuerpo.style.minHeight = '0';
    } catch (e) {}
  }

  // La ventana de impresion no tenia forma de cerrarse: en iPhone
  // dejaba a la persona sin poder volver a la app. Se agrega un boton
  // que solo aparece en pantalla (no en el papel/PDF impreso).
  function agregarBotonCerrar(ventana) {
    try {
      var doc = ventana.document;
      if (!doc || doc.getElementById('cl-cerrar-ventana')) return;
      var estilo = doc.createElement('style');
      estilo.textContent = '@media print{#cl-cerrar-ventana{display:none}}';
      doc.head.appendChild(estilo);
      var boton = doc.createElement('button');
      boton.id = 'cl-cerrar-ventana';
      boton.type = 'button';
      boton.textContent = '\u2715 Cerrar';
      boton.style.cssText =
        'position:fixed;top:12px;right:12px;z-index:99999;' +
        'background:#123f56;color:#fff;border:none;border-radius:10px;' +
        'padding:10px 16px;font-weight:800;font-size:15px;cursor:pointer;' +
        'box-shadow:0 4px 14px rgba(0,0,0,.25);font-family:Arial,sans-serif';
      boton.onclick = function () { ventana.close(); };
      doc.body.appendChild(boton);
    } catch (e) {}
  }

  var openOriginal = window.open;
  window.open = function () {
    var w = openOriginal.apply(window, arguments);
    if (w) {
      // setTimeout 0: deja que la app termine de escribir el documento
      // (document.write/close, que corren justo despues del open())
      // antes de leer y tocar su contenido.
      setTimeout(function () {
        agregarAfiliado(w);
        corregirSaltoDePagina(w);
        agregarBotonCerrar(w);
      }, 0);
    }
    return w;
  };
})();
