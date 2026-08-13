/* =====================================================================
   CardioLink — Guardia de sesión Supabase v2
   FIX MAIN 2026-08-13

   Corrección:
   app.js declara `let supabaseClient`, que en un script clásico NO crea
   automáticamente `window.supabaseClient`. La versión anterior del guard
   consultaba exclusivamente window.supabaseClient, por lo que interpretaba
   falsamente que no había sesión y bloqueaba TODA sincronización.

   Esta versión obtiene el cliente desde el binding global de app.js y deja
   window.supabaseClient solo como fallback.
   ===================================================================== */
(function () {
  if (window.__cardiolinkAuthGuardInstalledV2) return;
  window.__cardiolinkAuthGuardInstalledV2 = true;

  function obtenerClienteSupabase() {
    try {
      // `supabaseClient` viene de app.js (declarado con let).
      // Los scripts clásicos posteriores pueden leer ese binding global,
      // aunque no exista como propiedad de window.
      if (typeof supabaseClient !== 'undefined' && supabaseClient) {
        return supabaseClient;
      }
    } catch (_) {}
    return window.supabaseClient || null;
  }

  function mostrarAvisoSesion(mensaje) {
    let banner = document.getElementById('cl-session-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'cl-session-banner';
      banner.style.cssText =
        'position:fixed;left:0;right:0;top:0;z-index:99999;' +
        'background:#a13636;color:#fff;font-weight:700;' +
        'padding:10px 16px;text-align:center;font-family:Arial,sans-serif;' +
        'box-shadow:0 4px 14px rgba(0,0,0,.25)';
      document.body.appendChild(banner);
    }
    banner.textContent = mensaje;
    banner.style.display = 'block';
  }

  function ocultarAvisoSesion() {
    const banner = document.getElementById('cl-session-banner');
    if (banner) banner.style.display = 'none';
  }

  async function sesionValida() {
    try {
      const client = obtenerClienteSupabase();
      if (!client?.auth) return false;

      const { data, error } = await client.auth.getSession();
      if (error || !data?.session?.user) return false;

      // getSession normalmente administra el refresh automático.
      // Solo rechazamos si sigue devolviendo una sesión realmente expirada.
      const exp = Number(data.session.expires_at || 0);
      if (exp && (Date.now() / 1000) >= exp) {
        try {
          const refreshed = await client.auth.refreshSession();
          if (refreshed?.error || !refreshed?.data?.session?.user) return false;
        } catch (_) {
          return false;
        }
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  function pausarRefrescoAutomatico() {
    if (window.cardioLinkRefreshInterval) {
      clearInterval(window.cardioLinkRefreshInterval);
      window.cardioLinkRefreshInterval = null;
    }
  }

  function reanudarRefrescoAutomatico() {
    try {
      if (!window.cardioLinkRefreshInterval &&
          typeof iniciarRefrescoAutomatico === 'function') {
        iniciarRefrescoAutomatico();
      }
    } catch (_) {}
  }

  function envolverSync() {
    if (typeof window.sincronizarAtencionesSupabase !== 'function') return false;

    const original = window.sincronizarAtencionesSupabase;
    if (original.__clGuardedV2) return true;

    const envuelta = async function () {
      const ok = await sesionValida();

      if (!ok) {
        pausarRefrescoAutomatico();
        mostrarAvisoSesion(
          '⚠ Tu sesión venció. Los cambios no se están guardando en la nube — volvé a iniciar sesión para seguir sincronizando.'
        );
        console.warn('CardioLink: sincronización cancelada por sesión Supabase inválida.');
        return false;
      }

      ocultarAvisoSesion();
      reanudarRefrescoAutomatico();
      return original.apply(this, arguments);
    };

    envuelta.__clGuardedV2 = true;
    window.sincronizarAtencionesSupabase = envuelta;
    try { sincronizarAtencionesSupabase = envuelta; } catch (_) {}
    return true;
  }

  let intentos = 0;
  const timerInstalacion = setInterval(() => {
    intentos++;
    if (envolverSync() || intentos > 40) clearInterval(timerInstalacion);
  }, 500);

  // Escuchar cambios reales de sesión usando el cliente correcto.
  try {
    const client = obtenerClienteSupabase();
    if (client?.auth?.onAuthStateChange) {
      client.auth.onAuthStateChange((event, session) => {
        if (event === 'SIGNED_OUT') {
          pausarRefrescoAutomatico();
          mostrarAvisoSesion(
            '⚠ Tu sesión venció. Volvé a iniciar sesión para seguir guardando cambios en la nube.'
          );
        }

        if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'INITIAL_SESSION') {
          if (session?.user) {
            ocultarAvisoSesion();
            reanudarRefrescoAutomatico();
          }
        }
      });
    }
  } catch (e) {
    console.warn('CardioLink auth guard: no se pudo instalar listener de sesión.', e);
  }
})();
