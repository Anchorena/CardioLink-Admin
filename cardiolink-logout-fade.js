/* =====================================================================
   CardioLink -- Evitar el parpadeo del boton "Cerrar sesion" al cargar
   No modifica app.js. La app tiene varios ajustes internos que van
   moviendo y reposicionando ese boton uno detras de otro al cargar la
   pagina (primero aparece grande y flotante, despues se acomoda en el
   menu). Este script lo mantiene oculto con una transicion suave
   (definida en cardiolink-ui.css) hasta que ya se asento en su lugar
   final, para que no se vea el salto.
   Para revertir: quitar el <script> a este archivo en index.html.
   ===================================================================== */
(function () {
  if (window.__cardiolinkLogoutFade) return;
  window.__cardiolinkLogoutFade = true;

  function revelar() {
    var btn = document.getElementById('btnCerrarSesion');
    if (btn) btn.classList.add('cl-listo');
  }

  // Los ajustes internos de la app terminan de acomodar el boton
  // alrededor de los 1400-1800ms del arranque; esperamos un poco mas
  // para asegurarnos de revelarlo ya asentado.
  setTimeout(revelar, 2000);
})();
