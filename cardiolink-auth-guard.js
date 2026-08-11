/* =====================================================================
   CardioLink — Guardia de sesión Supabase
   No modifica la lógica clínica/financiera de app.js: envuelve (wrap)
   las funciones existentes, igual que ya hace el propio app.js con sus
   parches internos (ej. guardarConfigEnSupabase298).
   Para revertir: quitar el <script> a este archivo en index.html.

   Qué resuelve:
   1) Si la sesión de Supabase vence y no se puede renovar, hoy la app
      sigue intentando sincronizar en silencio cada 30s, y en el peor
      caso interpreta "no llegaron datos" como "no hay nada en la nube,
      subo lo local" — arriesgado con datos de pacientes reales.
   2) Ahora: se detecta la sesión inválida ANTES de sincronizar, se
      pausa el refresco automático, y se muestra un aviso visible y
      persistente (no un alert() que se puede cerrar sin leer) pidiendo
      volver a iniciar sesión.
   ===================================================================== */
(function () {
  if (window.__cardiolinkAuthGuardInstalled) return;
  window.__cardiolinkAuthGuardInstalled = true;

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
      if (!window.supabaseClient) return false;
      const { data, error } = await window.supabaseClient.auth.getSession();
      if (error || !data?.session) return false;
      const exp = data.session.expires_at; // segundos epoch
      if (exp && Date.now() / 1000 > exp) return false;
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

  // Envuelve sincronizarAtencionesSupabase: si la sesión no es válida,
  // no intenta escribir — avisa y corta, en vez de fallar en silencio
  // contra las políticas de seguridad de Supabase.
  function envolverSync() {
    if (typeof window.sincronizarAtencionesSupabase !== 'function') return false;
    const original = window.sincronizarAtencionesSupabase;
    if (original.__clGuarded) return true;
    const envuelta = async function (forzar) {
      const ok = await sesionValida();
      if (!ok) {
        pausarRefrescoAutomatico();
        mostrarAvisoSesion('⚠ Tu sesión venció. Los cambios no se están guardando en la nube — volvé a iniciar sesión para seguir sincronizando.');
        console.warn('CardioLink: sincronización cancelada, sesión inválida o vencida.');
        return false;
      }
      ocultarAvisoSesion();
      return original.apply(this, arguments);
    };
    envuelta.__clGuarded = true;
    window.sincronizarAtencionesSupabase = envuelta;
    try { sincronizarAtencionesSupabase = envuelta; } catch (_) {}
    return true;
  }

  // Reintenta envolver hasta que la función exista (app.js la define
  // de forma diferida en varias etapas de carga).
  let intentos = 0;
  const t = setInterval(() => {
    intentos++;
    if (envolverSync() || intentos > 40) clearInterval(t);
  }, 500);

  // Si Supabase avisa que la sesión se cerró (por ejemplo, por un
  // refresh token vencido), pausamos el refresco y avisamos ya mismo,
  // en vez de esperar al próximo intento fallido de sincronización.
  if (window.supabaseClient?.auth?.onAuthStateChange) {
    window.supabaseClient.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT' || event === 'TOKEN_REFRESH_FAILED') {
        pausarRefrescoAutomatico();
        mostrarAvisoSesion('⚠ Tu sesión venció. Volvé a iniciar sesión para seguir guardando cambios en la nube.');
      }
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        ocultarAvisoSesion();
      }
    });
  }
})();
