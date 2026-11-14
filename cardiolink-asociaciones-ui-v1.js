/* CardioLink · Seguridad clínica V1 · Bloque 3 (STAGING y Production)
   Asociaciones Secretaría–Médicos. No crea cuentas Auth ni cambia RLS.
   Cargar DESPUÉS de app.js; depende del cliente y permisos existentes.
*/
(function () {
  'use strict';
  const rootId = 'cfgAsociacionesSecretariaV1';
  let cache = null;
  const el = (tag, attrs = {}, content = '') => {
    const node = document.createElement(tag);
    Object.entries(attrs).forEach(([key, value]) => {
      if (key === 'className') node.className = value;
      else if (key === 'type') node.type = value;
      else node.setAttribute(key, value);
    });
    if (content) node.textContent = content;
    return node;
  };
  function client() {
    if (typeof supabaseClient === 'undefined' || !supabaseClient ||
        typeof usuarioSupabase === 'undefined' || !usuarioSupabase ||
        typeof puedeGestionarUsuariosPermisos !== 'function' || !puedeGestionarUsuariosPermisos()) {
      throw new Error('Se requiere una sesión de dueño o administrador confirmada.');
    }
    // Fail closed: solo los dos proyectos Supabase de CardioLink (STAGING y Production), cualquiera sea la URL de la página. La autorización real (owner/admin) la valida la RPC en el servidor.
    const backendUrl = String(supabaseClient.supabaseUrl || '');
    if (!/^https:\/\/(yslhwdlzdknhskawqrtv|tupacclmhaqiahhlttyz)\.supabase\.co\/?$/i.test(backendUrl)) {
      throw new Error('Módulo habilitado únicamente para los proyectos Supabase de CardioLink (STAGING y Production). No se enviaron cambios.');
    }
    return supabaseClient;
  }
  function entorno() {
    try { return /tupacclmhaqiahhlttyz/i.test(String(supabaseClient.supabaseUrl || '')) ? 'PRODUCCIÓN' : 'STAGING'; } catch (e) { return 'STAGING'; }
  }
  function status(message, isError = false) {
    const node = document.getElementById('asociacionesEstadoV1');
    if (node) { node.textContent = message; node.style.color = isError ? '#b91c1c' : ''; }
  }
  async function rpc(name, params) {
    const { data, error } = await client().rpc(name, params || {});
    if (error) throw error;
    if (!data) throw new Error('El servidor no devolvió un resultado.');
    return data;
  }
  function displayUser(u) { return u.usuario || u.profesional_id || String(u.user_id).slice(0, 8); }
  function paint() {
    const area = document.getElementById('asociacionesEditorV1');
    if (!area || !cache) return;
    area.replaceChildren();
    const secretarias = cache.usuarios.filter(u => u.rol === 'secretaria');
    const medicos = cache.usuarios.filter(u => u.rol === 'medico' || u.rol === 'owner');
    if (!secretarias.length || !medicos.length) {
      area.append(el('p', {className: 'muted'}, 'Faltan cuentas reales de Secretaría o médicos en ' + entorno() + '.')); return;
    }
    const label = el('label', {}, 'Secretaria');
    const select = el('select', {id: 'asocSecretariaSelectV1'});
    secretarias.forEach(u => { const option = el('option', {value: u.user_id}, displayUser(u)); select.append(option); });
    const list = el('div', {id: 'asocMedicosListaV1'});
    const save = el('button', {type: 'button', className: 'primary'}, 'Guardar asociaciones');
    const refresh = () => {
      list.replaceChildren();
      const current = select.value;
      medicos.forEach(u => {
        const row = el('label', {className: 'asoc-medico-v1'});
        row.style.display = 'block'; row.style.padding = '6px 0';
        const check = el('input', {type: 'checkbox', 'data-medico-id': u.user_id});
        check.checked = cache.asociaciones.some(a => a.secretaria_user_id === current && a.medico_user_id === u.user_id && a.activo);
        row.append(check, document.createTextNode(' ' + displayUser(u))); list.append(row);
      });
    };
    select.addEventListener('change', refresh);
    save.addEventListener('click', async () => {
      const secretariaId = select.value;
      const changes = [...list.querySelectorAll('input[type=checkbox]')].map(c => {
        const doctorId = c.getAttribute('data-medico-id');
        const prev = cache.asociaciones.some(a => a.secretaria_user_id === secretariaId && a.medico_user_id === doctorId && a.activo);
        return {doctorId, next: c.checked, prev};
      }).filter(x => x.next !== x.prev);
      if (!changes.length) return status('Sin cambios para guardar.');
      if (!window.confirm('¿Confirmás ' + changes.length + ' cambio(s) de asociación en ' + entorno() + '?')) return;
      save.disabled = true; select.disabled = true; status('Guardando asociaciones…');
      try {
        for (const change of changes) {
          const result = await rpc('cardiolink_asociar_secretaria_medico_v1', {
            p_secretaria_user_id: secretariaId,
            p_medico_user_id: change.doctorId,
            p_activo: change.next
          });
          if (result.ok !== true) throw new Error('El servidor no confirmó el cambio.');
        }
        cache = await rpc('cardiolink_listar_asociaciones_v1');
        // No reaplicar cambios del cliente: siempre usar respuesta del servidor.
        paint();
        const refreshed = document.getElementById('asocSecretariaSelectV1');
        if (refreshed) { refreshed.value = secretariaId; refreshed.dispatchEvent(new Event('change')); }
        status('Asociaciones guardadas y verificadas en ' + entorno() + '.');
      } catch (error) {
        // Las operaciones son sucesivas (no una transacción): tras una falla parcial
        // se recarga el estado real desde el servidor antes de permitir reintentar.
        const failure = error.message || String(error);
        try {
          const fresh = await rpc('cardiolink_listar_asociaciones_v1');
          if (!Array.isArray(fresh.usuarios) || !Array.isArray(fresh.asociaciones)) throw new Error('Formato inesperado del servidor');
          cache = fresh;
          paint();
          const refreshed = document.getElementById('asocSecretariaSelectV1');
          if (refreshed) { refreshed.value = secretariaId; refreshed.dispatchEvent(new Event('change')); }
          status('No se completaron todas las operaciones: ' + failure + '. Se recargó el estado real del servidor; revisá y reintentá.', true);
        } catch (reloadError) {
          cache = null;
          const area = document.getElementById('asociacionesEditorV1');
          if (area) area.replaceChildren();
          status('No se completaron todas las operaciones: ' + failure + '. No se pudo recargar el estado del servidor; pulsá "Cargar asociaciones" antes de reintentar.', true);
        }
      } finally { save.disabled = false; select.disabled = false; }
    });
    area.append(label, select, el('p', {className:'muted'}, 'Marcá todos los médicos con los que trabaja la secretaria.'), list, save);
    refresh();
  }
  async function load() {
    try {
      status('Consultando asociaciones reales de ' + entorno() + '…');
      cache = await rpc('cardiolink_listar_asociaciones_v1');
      if (!Array.isArray(cache.usuarios) || !Array.isArray(cache.asociaciones)) throw new Error('Formato inesperado del servidor');
      paint(); status('Asociaciones sincronizadas.');
    } catch (error) {
      cache = null;
      const area = document.getElementById('asociacionesEditorV1');
      if (area) area.replaceChildren();
      status('No se pudieron cargar las asociaciones: ' + (error.message || String(error)), true);
    }
  }
  function mount() {
    const parent = document.getElementById('cfgUsuariosSistemaV1A');
    if (!parent || document.getElementById(rootId)) return;
    const panel = el('div', {id: rootId});
    panel.style.borderTop = '1px solid currentColor'; panel.style.marginTop = '22px'; panel.style.paddingTop = '12px';
    panel.append(el('h3', {}, 'Asociaciones Secretaría–Médicos'),
      el('p', {className:'muted'}, 'Administrá las asociaciones reales de Supabase ' + entorno() + '. Esto no crea usuarios ni modifica historias clínicas.'));
    const loadButton = el('button', {type: 'button', className: 'secondary'}, 'Cargar asociaciones');
    loadButton.addEventListener('click', load);
    panel.append(loadButton, el('p', {id:'asociacionesEstadoV1', className:'muted'}), el('div', {id:'asociacionesEditorV1'}));
    parent.append(panel);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, {once:true});
  else mount();
})();
