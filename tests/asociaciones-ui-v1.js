'use strict';

// tests/asociaciones-ui-v1.js
// Seguridad clínica V1 / Bloque 3: cardiolink-asociaciones-ui-v1.js (Configuración → Usuarios y accesos).
// Ejecuta el código REAL del módulo con un DOM mínimo simulado y un cliente Supabase falso (sin red, sin Supabase real).
// Verifica: acceso exclusivo dueño/administrador, bloqueo contra Production, carga, asociaciones múltiples (alta y revocación),
// orden/parámetros de las RPC, falla parcial con recarga desde el servidor, errores de red y que el formulario existente no se toca.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(root, 'cardiolink-asociaciones-ui-v1.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const STAGING = 'https://yslhwdlzdknhskawqrtv.supabase.co';
const PRODUCTION = 'https://tupacclmhaqiahhlttyz.supabase.co';

// ---------- DOM mínimo ----------
class Node_ {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.style = {}; this.disabled = false; this.checked = false; this.value = ''; this.className = ''; this.textContent = ''; this.parent = null; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); if (k === 'value') this.value = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  append(...items) { items.forEach(i => { if (typeof i === 'string') i = new Text_(i); i.parent = this; this.children.push(i); }); if (this.tag === 'select' && !this.value && this.children.length) this.value = this.children[0].value; }
  replaceChildren(...items) { this.children = []; this.append(...items); }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  dispatchEvent(ev) { (this.listeners[ev.type] || []).forEach(fn => fn(ev)); }
  walk(fn) { fn(this); this.children.forEach(c => c.walk && c.walk(fn)); }
  querySelectorAll(sel) {
    const out = [];
    this.walk(n => { if (n !== this && n.matches && n.matches(sel)) out.push(n); });
    return out;
  }
  matches(sel) { if (sel === 'input[type=checkbox]') return this.tag === 'input' && this.type === 'checkbox'; return false; }
  async click() { for (const fn of (this.listeners.click || [])) await fn({ type: 'click' }); }
}
class Text_ { constructor(t) { this.textContent = t; this.tag = '#text'; } }

function makeEnv(opts) {
  opts = opts || {};
  const root_ = new Node_('body');
  const byId = {};
  const doc = {
    readyState: 'complete',
    createElement: tag => new Node_(tag),
    createTextNode: t => new Text_(t),
    addEventListener() {},
    getElementById: id => { let f = null; root_.walk(n => { if (n.id === id) f = n; }); return f; },
  };
  const host = new Node_('div'); host.setAttribute('id', 'cfgUsuariosSistemaV1A');
  const existingForm = new Node_('input'); existingForm.setAttribute('id', 'usrNombre'); host.append(existingForm);
  if (opts.sinHost !== true) root_.append(host);

  const llamadas = [];
  const servidor = JSON.parse(JSON.stringify(opts.servidor || {
    usuarios: [
      { user_id: 's1', usuario: 'xime', rol: 'secretaria', profesional_id: null },
      { user_id: 's2', usuario: 'ana', rol: 'secretaria', profesional_id: null },
      { user_id: 'm1', usuario: 'rogelio', rol: 'medico', profesional_id: 'rogelio' },
      { user_id: 'm2', usuario: 'humberto', rol: 'medico', profesional_id: 'humberto' },
      { user_id: 'o1', usuario: 'matias', rol: 'owner', profesional_id: 'matias' },
    ],
    asociaciones: [{ secretaria_user_id: 's1', medico_user_id: 'm1', activo: true }],
  }));
  const hooks = { falloEnAsociar: null, falloEnListar: false, listarSinFormato: false, asociarOkFalse: false };
  const supabaseClient = {
    supabaseUrl: opts.url || STAGING,
    async rpc(name, params) {
      llamadas.push({ name, params });
      if (name === 'cardiolink_listar_asociaciones_v1') {
        if (hooks.falloEnListar) return { data: null, error: { message: 'Failed to fetch' } };
        if (hooks.listarSinFormato) return { data: { usuarios: null }, error: null };
        return { data: JSON.parse(JSON.stringify(servidor)), error: null };
      }
      if (name === 'cardiolink_asociar_secretaria_medico_v1') {
        const nth = llamadas.filter(l => l.name === name).length;
        if (hooks.falloEnAsociar === nth) return { data: null, error: { message: 'Failed to fetch' } };
        if (hooks.asociarOkFalse) return { data: { ok: false }, error: null };
        const a = servidor.asociaciones.find(x => x.secretaria_user_id === params.p_secretaria_user_id && x.medico_user_id === params.p_medico_user_id);
        if (a) a.activo = params.p_activo; else servidor.asociaciones.push({ secretaria_user_id: params.p_secretaria_user_id, medico_user_id: params.p_medico_user_id, activo: params.p_activo });
        return { data: { ok: true, activo: params.p_activo }, error: null };
      }
      return { data: null, error: { message: 'rpc desconocida' } };
    },
  };
  const win = { confirm: () => opts.confirmar !== false };
  const g = {
    document: doc, window: win, Event: function (type) { this.type = type; },
    supabaseClient: opts.sinCliente ? null : supabaseClient,
    usuarioSupabase: opts.sinSesion ? null : { id: 'u' },
    puedeGestionarUsuariosPermisos: () => opts.puedeGestionar !== false,
  };
  const f = new Function('document', 'window', 'Event', 'supabaseClient', 'usuarioSupabase', 'puedeGestionarUsuariosPermisos', SRC);
  f(g.document, g.window, g.Event, g.supabaseClient, g.usuarioSupabase, g.puedeGestionarUsuariosPermisos);
  return { doc, host, existingForm, llamadas, servidor, hooks, win };
}

const buscar = (env, id) => env.doc.getElementById(id);
const estado = env => buscar(env, 'asociacionesEstadoV1').textContent;
const botonCargar = env => buscar(env, 'cfgAsociacionesSecretariaV1').children.find(c => c.tag === 'button');
const botonGuardar = env => buscar(env, 'asociacionesEditorV1').children.find(c => c.tag === 'button');
const checks = env => buscar(env, 'asocMedicosListaV1').querySelectorAll('input[type=checkbox]');
const checkDe = (env, id) => checks(env).find(c => c.getAttribute('data-medico-id') === id);
const rpcsAsociar = env => env.llamadas.filter(l => l.name === 'cardiolink_asociar_secretaria_medico_v1');

const pruebas = [];
const prueba = (nombre, fn) => pruebas.push({ nombre, fn });

prueba('integración: index.html carga el módulo después de app.js y conserva el formulario de usuarios', () => {
  const iApp = INDEX.indexOf('<script src="app.js');
  const iMod = INDEX.indexOf('<script src="cardiolink-asociaciones-ui-v1.js');
  assert.ok(iApp > 0 && iMod > iApp, 'el módulo debe cargarse después de app.js');
  assert.equal(INDEX.split('cardiolink-asociaciones-ui-v1.js').length - 1, 1, 'una sola referencia al módulo');
  for (const id of ['usrNombre', 'usrUsuario', 'usrRol', 'usrProfesionalId', 'usrEspecialidad', 'btnAddUsuarioSistema', 'listaUsuariosSistema'])
    assert.ok(INDEX.includes('id="' + id + '"'), 'se conserva #' + id);
});

prueba('montaje: agrega el panel dentro de #cfgUsuariosSistemaV1A sin tocar el formulario existente', () => {
  const env = makeEnv();
  assert.ok(buscar(env, 'cfgAsociacionesSecretariaV1'));
  assert.equal(buscar(env, 'cfgAsociacionesSecretariaV1').parent, env.host);
  assert.equal(env.host.children[0], env.existingForm);
  assert.equal(env.llamadas.length, 0, 'no hace llamadas de red al montar');
});

prueba('montaje: sin contenedor no falla ni crea nada', () => {
  const env = makeEnv({ sinHost: true });
  assert.equal(buscar(env, 'cfgAsociacionesSecretariaV1'), null);
});

prueba('acceso exclusivo: sin permisos de dueño/administrador no se llama a ninguna RPC', async () => {
  const env = makeEnv({ puedeGestionar: false });
  await botonCargar(env).click();
  assert.equal(env.llamadas.length, 0);
  assert.match(estado(env), /dueño o administrador/);
});

prueba('acceso exclusivo: sin sesión Supabase o sin cliente se bloquea', async () => {
  for (const o of [{ sinSesion: true }, { sinCliente: true }]) {
    const env = makeEnv(o);
    await botonCargar(env).click();
    assert.equal(env.llamadas.length, 0);
    assert.match(estado(env), /dueño o administrador/);
  }
});

prueba('Backend: sólo los dos proyectos de CardioLink; cualquier otra URL → fail-closed, sin RPC', async () => {
  for (const url of ['https://otro.supabase.co', STAGING + '.evil.com', PRODUCTION + '.evil.com', 'http://yslhwdlzdknhskawqrtv.supabase.co', 'http://tupacclmhaqiahhlttyz.supabase.co', 'https://evil.com/' + PRODUCTION]) {
    const env = makeEnv({ url });
    await botonCargar(env).click();
    assert.equal(env.llamadas.length, 0, url);
    assert.match(estado(env), /únicamente para los proyectos Supabase de CardioLink/, url);
  }
});

prueba('Production habilitado (v1.1): carga por la RPC, etiqueta de entorno PRODUCCIÓN y exige sesión owner/admin', async () => {
  for (const url of [PRODUCTION, PRODUCTION + '/']) {
    const env = makeEnv({ url });
    await botonCargar(env).click();
    assert.deepEqual(env.llamadas.map(l => l.name), ['cardiolink_listar_asociaciones_v1'], url);
    assert.match(estado(env), /sincronizadas/, url);
  }
  const env = makeEnv({ url: PRODUCTION, sinSesion: true });
  await botonCargar(env).click();
  assert.equal(env.llamadas.length, 0);
  assert.match(estado(env), /dueño o administrador/);
  const src = fs.readFileSync(require('node:path').join(__dirname, '..', 'cardiolink-asociaciones-ui-v1.js'), 'utf8');
  assert.ok(/'PRODUCCIÓN'/.test(src) && !/service_role/.test(src), 'etiqueta de entorno y sin service_role');
});

prueba('carga: lista usuarios y marca las asociaciones activas del servidor', async () => {
  const env = makeEnv();
  await botonCargar(env).click();
  assert.deepEqual(env.llamadas.map(l => l.name), ['cardiolink_listar_asociaciones_v1']);
  assert.equal(checks(env).length, 3, 'médicos + owner');
  assert.equal(checkDe(env, 'm1').checked, true);
  assert.equal(checkDe(env, 'm2').checked, false);
  assert.equal(checkDe(env, 'o1').checked, false);
  assert.match(estado(env), /sincronizadas/);
});

prueba('carga: sin secretarias o sin médicos muestra aviso y no ofrece guardar', async () => {
  const env = makeEnv({ servidor: { usuarios: [{ user_id: 'm1', usuario: 'r', rol: 'medico' }], asociaciones: [] } });
  await botonCargar(env).click();
  assert.equal(buscar(env, 'asocSecretariaSelectV1'), null);
});

prueba('asociaciones múltiples: una secretaria con varios médicos guarda cada alta con p_activo=true', async () => {
  const env = makeEnv();
  await botonCargar(env).click();
  checkDe(env, 'm2').checked = true; checkDe(env, 'o1').checked = true;
  await botonGuardar(env).click();
  const r = rpcsAsociar(env);
  assert.equal(r.length, 2);
  assert.deepEqual(r.map(x => x.params), [
    { p_secretaria_user_id: 's1', p_medico_user_id: 'm2', p_activo: true },
    { p_secretaria_user_id: 's1', p_medico_user_id: 'o1', p_activo: true },
  ]);
  assert.equal(env.llamadas[env.llamadas.length - 1].name, 'cardiolink_listar_asociaciones_v1', 'relee del servidor al terminar');
  assert.ok(checkDe(env, 'm1').checked && checkDe(env, 'm2').checked && checkDe(env, 'o1').checked);
  assert.match(estado(env), /guardadas y verificadas/);
});

prueba('revocación: desmarcar envía p_activo=false y solo del cambio', async () => {
  const env = makeEnv();
  await botonCargar(env).click();
  checkDe(env, 'm1').checked = false;
  await botonGuardar(env).click();
  const r = rpcsAsociar(env);
  assert.deepEqual(r.map(x => x.params), [{ p_secretaria_user_id: 's1', p_medico_user_id: 'm1', p_activo: false }]);
  assert.equal(checkDe(env, 'm1').checked, false);
  assert.equal(env.servidor.asociaciones[0].activo, false);
});

prueba('sin cambios: no llama a la RPC ni pide confirmación', async () => {
  const env = makeEnv();
  let pidio = false; env.win.confirm = () => { pidio = true; return true; };
  await botonCargar(env).click();
  await botonGuardar(env).click();
  assert.equal(rpcsAsociar(env).length, 0);
  assert.equal(pidio, false);
  assert.match(estado(env), /Sin cambios/);
});

prueba('confirmación rechazada: no se envía nada', async () => {
  const env = makeEnv({ confirmar: false });
  await botonCargar(env).click();
  checkDe(env, 'm2').checked = true;
  await botonGuardar(env).click();
  assert.equal(rpcsAsociar(env).length, 0);
});

prueba('una secretaria no pisa las asociaciones de otra', async () => {
  const env = makeEnv();
  await botonCargar(env).click();
  const sel = buscar(env, 'asocSecretariaSelectV1');
  sel.value = 's2'; sel.dispatchEvent({ type: 'change' });
  assert.equal(checkDe(env, 'm1').checked, false, 's2 no hereda a m1 de s1');
  checkDe(env, 'm2').checked = true;
  await botonGuardar(env).click();
  assert.deepEqual(rpcsAsociar(env).map(x => x.params.p_secretaria_user_id), ['s2']);
  assert.equal(env.servidor.asociaciones.find(a => a.secretaria_user_id === 's1' && a.medico_user_id === 'm1').activo, true);
});

prueba('falla parcial: tras la 2ª RPC fallida se recarga el estado real del servidor', async () => {
  const env = makeEnv();
  await botonCargar(env).click();
  checkDe(env, 'm2').checked = true; checkDe(env, 'o1').checked = true; checkDe(env, 'm1').checked = false;
  env.hooks.falloEnAsociar = 2;
  await botonGuardar(env).click();
  const nombres = env.llamadas.map(l => l.name);
  assert.equal(nombres[nombres.length - 1], 'cardiolink_listar_asociaciones_v1', 'recarga desde el servidor');
  assert.equal(rpcsAsociar(env).length, 2, 'se detiene en la falla: no continúa con las siguientes');
  // La UI refleja lo que realmente quedó en el servidor (m1 sí se aplicó; m2/o1 no), no lo que el usuario había marcado.
  assert.equal(checkDe(env, 'm1').checked, false);
  assert.equal(checkDe(env, 'm2').checked, false);
  assert.equal(checkDe(env, 'o1').checked, false);
  assert.match(estado(env), /Se recargó el estado real del servidor/);
  assert.match(estado(env), /Failed to fetch/);
});

prueba('falla parcial + recarga también falla: vacía el editor y exige recargar manualmente', async () => {
  const env = makeEnv();
  await botonCargar(env).click();
  checkDe(env, 'm2').checked = true;
  env.hooks.falloEnAsociar = 1; env.hooks.falloEnListar = true;
  await botonGuardar(env).click();
  assert.equal(buscar(env, 'asociacionesEditorV1').children.length, 0, 'sin editor con estado desactualizado');
  assert.match(estado(env), /Cargar asociaciones/);
});

prueba('la RPC responde ok:false → se trata como error y se recarga', async () => {
  const env = makeEnv();
  await botonCargar(env).click();
  checkDe(env, 'm2').checked = true;
  env.hooks.asociarOkFalse = true;
  await botonGuardar(env).click();
  assert.match(estado(env), /no confirmó/);
  assert.equal(checkDe(env, 'm2').checked, false);
});

prueba('error de red al cargar: mensaje de error, sin editor y sin cambios', async () => {
  const env = makeEnv();
  env.hooks.falloEnListar = true;
  await botonCargar(env).click();
  assert.match(estado(env), /No se pudieron cargar las asociaciones: Failed to fetch/);
  assert.equal(buscar(env, 'asociacionesEditorV1').children.length, 0);
  assert.equal(rpcsAsociar(env).length, 0);
});

prueba('respuesta con formato inesperado se rechaza', async () => {
  const env = makeEnv();
  env.hooks.listarSinFormato = true;
  await botonCargar(env).click();
  assert.match(estado(env), /Formato inesperado/);
});

prueba('recarga de la página: el estado sale del servidor (módulo sin persistencia local)', async () => {
  assert.ok(!/localStorage|sessionStorage|indexedDB/.test(SRC), 'el módulo no guarda estado en el navegador');
  const env = makeEnv();
  await botonCargar(env).click();
  checkDe(env, 'm2').checked = true;
  await botonGuardar(env).click();
  const env2 = makeEnv({ servidor: env.servidor }); // "página nueva" contra el mismo servidor
  await botonCargar(env2).click();
  assert.ok(checkDe(env2, 'm1').checked && checkDe(env2, 'm2').checked);
});

prueba('alcance: el módulo solo usa las dos RPC autorizadas y no toca tablas, RLS ni Auth', () => {
  const usadas = [...SRC.matchAll(/rpc\('([a-z0-9_]+)'/g)].map(m => m[1]);
  assert.deepEqual([...new Set(usadas)].sort(), ['cardiolink_asociar_secretaria_medico_v1', 'cardiolink_listar_asociaciones_v1']);
  assert.ok(!/\.from\(|\.auth\.|signUp|admin\.|service_role|localStorage/.test(SRC));
  // v1.1: sólo los dos proyectos de CardioLink (STAGING y Production), cada uno en la expresión del candado y en la etiqueta de entorno; ningún otro ref de Supabase
  const linea = SRC.split('\n').find(l => /supabase\\\.co/.test(l) && !/^\s*\/\//.test(l)) || '';
  const refs = [...new Set(linea.match(/[a-z0-9]{20}/g) || [])].sort();
  assert.deepEqual(refs, ['tupacclmhaqiahhlttyz', 'yslhwdlzdknhskawqrtv'].sort(), 'solo STAGING y Production');
  assert.ok(!/https:\/\/[a-z0-9]{20}\.supabase\.co/.test(SRC.replace(/\/\*[\s\S]*?\*\//g, '')), 'sin URL completa de backend (solo el candado por expresión regular)');
});

(async () => {
  let fallas = 0;
  for (const p of pruebas) {
    try { await p.fn(); console.log('PASS  ' + p.nombre); }
    catch (e) { fallas++; console.log('FAIL  ' + p.nombre + '\n      ' + (e && e.message || e)); }
  }
  console.log('\n' + (pruebas.length - fallas) + '/' + pruebas.length + ' pruebas OK');
  if (fallas) process.exitCode = 1;
})();
