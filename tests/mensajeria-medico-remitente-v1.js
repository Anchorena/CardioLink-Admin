'use strict';

// tests/mensajeria-medico-remitente-v1.js
// Mensajería interna del MÉDICO: (1) el remitente es exclusivamente backendMensajeriaV1.login (verificado por el servidor); (2) sin identidad verificada no se
// encola nada y el texto queda en el cuadro; (3) al recuperar pendientes antiguos incompatibles NO se reenvían: se resguardan (texto, destino, fecha) y se avisa
// una sola vez, sin alert(); los mensajes válidos y el resto de los roles no cambian. Ejecuta el código REAL de app.js con localStorage/DOM simulados.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
function tramo(desde, hasta) {
  const i = app.indexOf(desde), j = app.indexOf(hasta, i + 1);
  assert.ok(i >= 0 && j > i, 'no se encontró el tramo: ' + desde);
  return app.slice(i, j);
}
const CODIGO = [
  tramo('function normalizarUsuarioTexto', 'function userKeys'),
  tramo('const DESTINO_MENSAJE_VALIDO_V1', '// ===== Documentos clínicos locales sin respaldo'),
  tramo('function enviarMensajeInterno', 'function renderMensajes')
].join('\n');

function montar(cfg) {
  const log = { alerts: [], sync: [], banners: 0, limpiado: 0, store: {} };
  Object.assign(log.store, cfg.store || {});
  const localStorage = { getItem: k => (k in log.store ? log.store[k] : null), setItem: (k, v) => { log.store[k] = String(v); }, removeItem: k => { delete log.store[k]; } };
  const uid = 'uid_rogelio';
  const ident = cfg.ident === undefined ? { role: 'medico', professional_id: 'rogelio' } : cfg.ident;
  const env = {
    log, localStorage, uid,
    usuarioSupabase: cfg.local ? null : { id: uid, email: 'rga@gmail.com' },
    backendPendientesIdentidadV1: ident,
    backendMensajeriaV1: cfg.login === undefined ? { login: 'rogelio.anchorena' } : (cfg.login ? { login: cfg.login } : null),
    rolBase: cfg.rolBase || 'medico',
    perfil: cfg.perfil || { id: 'rogelio', usuario: 'rogelio', nombre: 'Dr. Rogelio Anchorena', rol: 'medico', profesionalId: 'rogelio' },
    atenciones: (cfg.atenciones || []).slice(),
    syncConfirma: cfg.syncConfirma !== false,
    texto: cfg.texto === undefined ? 'hola colega' : cfg.texto,
    destinoSel: cfg.destinoSel || 'usuario:matias'
  };
  const f = new Function('env',
    'const {log,localStorage,usuarioSupabase,backendPendientesIdentidadV1,backendMensajeriaV1}=env;' +
    "const OUTBOX_NUEVAS_KEY_V1='cardiolink_nuevas_pendientes_v1_';const storageAtenciones='atenciones_k';" +
    'let atenciones=env.atenciones;' +
    'const alert=m=>log.alerts.push(String(m));' +
    'function esMedicoBackendV1(){return backendPendientesIdentidadV1&&backendPendientesIdentidadV1.role==="medico";}' +
    'function nombreVisibleBackendV1(){return "Dr. Rogelio Anchorena";}' +
    'function rolBaseUsuarioActual(){return env.rolBase;}' +
    'function perfilUsuarioActual(){return env.perfil;}' +
    'function $(id){return id==="msgTexto"?{value:env.texto}:(id==="msgDestino"?{value:env.destinoSel}:null);}' +
    'function todayISO(){return "2026-10-28";}' +
    'function selloAuditoriaCreacion(m){m.creadoPor=m.creadoPor||"sello";}' +
    'function saveAtenciones(){}function renderMensajes(){}function actualizarNotificacionMensajes(){}' +
    'function limpiarMensajeInterno(){log.limpiado++;}' +
    'let confirmadas=new Set();' +
    'async function sincronizarAtencionesSupabase(){log.sync.push(atenciones.filter(a=>!a.__conf).map(a=>a.id));if(env.syncConfirma)atenciones.forEach(a=>{a.__conf=true;});return true;}' +
    'const window={filasNuevasPendientes298:()=>atenciones.filter(a=>!a.__conf)};' +
    'const document={getElementById:id=>id==="avisoMensajesNoReenviadosV1"&&env.bannerOn?{}:null,createElement:()=>({style:{},setAttribute(){},querySelector:()=>({}),remove(){}}),body:{appendChild(){log.banners++;env.bannerOn=true;}}};' +
    CODIGO +
    '\nreturn {enviarMensajeInterno,recuperarNuevasPendientesV1,mensajePendienteCompatibleV1,atenciones:()=>atenciones};');
  const api = f(env);
  return { api, env, log };
}
const msg = o => Object.assign({ id: 'msg_1', tipoRegistro: 'mensaje', texto: 'texto viejo', destino: 'usuario:matias', deUsuario: 'rogelio.anchorena', creadoUid: 'uid_rogelio', creadoEn: '2026-10-20T10:00:00.000Z', fecha: '2026-10-20' }, o);
const outbox = rows => ({ ['cardiolink_nuevas_pendientes_v1_uid_rogelio']: JSON.stringify({ rows, fecha: 'x' }) });
const KEY = 'cardiolink_nuevas_pendientes_v1_uid_rogelio';
const BK = 'cardiolink_mensajes_no_enviados_v1';

const casos = [];
function caso(n, f) { casos.push([n, f]); }

caso('1. médico: el remitente es SIEMPRE backendMensajeriaV1.login (aunque el perfil local diga otro usuario)', () => {
  const m = montar({ login: 'rogelio.anchorena' });   // perfil local: usuario "rogelio" ≠ login verificado
  m.api.enviarMensajeInterno();
  const enc = m.api.atenciones();
  assert.equal(enc.length, 1);
  assert.equal(enc[0].deUsuario, 'rogelio.anchorena');
  assert.equal(enc[0].creadoUsuario, 'rogelio.anchorena');
  assert.equal(enc[0].creadoUid, 'uid_rogelio');
  assert.equal(m.log.limpiado, 1);
  assert.equal(m.log.alerts.length, 0);
});
caso('2. médico sin login verificado (identidad de backend sin mensajería): no se encola y el texto queda en el cuadro', () => {
  const m = montar({ login: null });
  m.api.enviarMensajeInterno();
  assert.equal(m.api.atenciones().length, 0);
  assert.equal(m.log.limpiado, 0, 'no se limpia el cuadro de mensaje');
  assert.ok(/identidad de mensajería no está verificada/.test(m.log.alerts[0]));
});
caso('3. médico sin identidad de backend (RPC caída/sin migrar): tampoco se encola', () => {
  const m = montar({ ident: null, login: null, rolBase: 'medico' });
  m.api.enviarMensajeInterno();
  assert.equal(m.api.atenciones().length, 0);
  assert.equal(m.log.limpiado, 0);
});
caso('4. Secretaría y dueño: comportamiento sin cambios (login local, se encola)', () => {
  const sec = montar({ ident: null, login: null, rolBase: 'secretaria', perfil: { id: 'geraldine', usuario: 'geraldine', nombre: 'Geraldine', rol: 'secretaria' } });
  sec.api.enviarMensajeInterno();
  assert.equal(sec.api.atenciones().length, 1); assert.equal(sec.api.atenciones()[0].deUsuario, 'geraldine'); assert.equal(sec.log.alerts.length, 0);
  const duenio = montar({ ident: { role: 'owner', professional_id: 'matias' }, login: null, rolBase: 'duenio', perfil: { id: 'matias', usuario: 'matias', nombre: 'Dr. Matías Anchorena', rol: 'duenio' } });
  duenio.api.enviarMensajeInterno();
  assert.equal(duenio.api.atenciones().length, 1); assert.equal(duenio.api.atenciones()[0].deUsuario, 'matias');
});
caso('5. modo local (sin sesión Supabase): sin cambios', () => {
  const m = montar({ local: true, ident: null, login: null, rolBase: 'medico' });
  m.api.enviarMensajeInterno();
  assert.equal(m.api.atenciones().length, 1);
});
caso('6. compatibilidad del pendiente: remitente propio + creadoUid propio + destino válido', () => {
  const m = montar({});
  const c = m.api.mensajePendienteCompatibleV1;
  assert.equal(c(msg({})), true);
  for (const d of ['todos', 'rol:secretaria', 'rol:medico', 'usuario:matias', 'usuario:dr.x_1-2']) assert.equal(c(msg({ destino: d })), true, d);
  assert.equal(c(msg({ deUsuario: 'rga' })), false, 'remitente = prefijo de email');
  assert.equal(c(msg({ deUsuario: 'rogelio' })), false, 'remitente = login local distinto del verificado');
  assert.equal(c(msg({ creadoUid: 'otro_uid' })), false, 'creado por otro uid');
  assert.equal(c(msg({ creadoUid: undefined })), false, 'sin creadoUid');
  for (const d of ['rol:admin', 'usuario:Matias', 'usuario:', 'cualquier']) assert.equal(c(msg({ destino: d })), false, d);
  assert.equal(c({ id: 'a1', paciente: 'X' }), true, 'una atención común no se toca');
});
caso('7. recuperar: el válido y las atenciones se reenvían; el incompatible NO, y su texto/destino/fecha quedan resguardados', async () => {
  const bueno = msg({ id: 'msg_ok', texto: 'valido', destino: 'rol:secretaria' });
  const malo = msg({ id: 'msg_mal', texto: 'texto del mensaje viejo', destino: 'usuario:matias', deUsuario: 'rga', creadoEn: '2026-10-19T08:30:00.000Z' });
  const atencion = { id: 'att_1', paciente: 'Paciente QA' };
  const m = montar({ store: outbox([bueno, malo, atencion]) });
  await m.api.recuperarNuevasPendientesV1();
  assert.equal(JSON.stringify(m.log.sync), JSON.stringify([['msg_ok', 'att_1']]), 'sólo se envían los compatibles');
  const bk = JSON.parse(m.log.store[BK]);
  assert.equal(bk.length, 1);
  assert.equal(bk[0].texto, 'texto del mensaje viejo'); assert.equal(bk[0].destino, 'usuario:matias'); assert.equal(bk[0].fecha, '2026-10-19T08:30:00.000Z'); assert.equal(bk[0].id, 'msg_mal');
  assert.ok(!(KEY in m.log.store), 'la cola de respaldo se limpia al confirmar');
  assert.equal(m.log.alerts.length, 0, 'sin alert()');
  assert.equal(m.log.banners, 1, 'un solo aviso no bloqueante');
});
caso('8. recuperar solo incompatibles: nada se reenvía, sin alert, cola limpia', async () => {
  const m = montar({ store: outbox([msg({ id: 'm1', deUsuario: 'rga' }), msg({ id: 'm2', destino: 'rol:admin' })]) });
  await m.api.recuperarNuevasPendientesV1();
  assert.equal(m.log.sync.length, 0);
  assert.equal(JSON.parse(m.log.store[BK]).length, 2);
  assert.ok(!(KEY in m.log.store));
  assert.equal(m.log.alerts.length, 0); assert.equal(m.log.banners, 1);
});
caso('9. sin alertas repetidas: si la cola se conserva (el servidor no confirmó), los incompatibles ya no vuelven', async () => {
  const bueno = msg({ id: 'msg_ok' }), malo = msg({ id: 'msg_mal', deUsuario: 'rga' });
  const m1 = montar({ store: outbox([bueno, malo]), syncConfirma: false });
  await m1.api.recuperarNuevasPendientesV1();
  const q = JSON.parse(m1.log.store[KEY]).rows.map(r => r.id);
  assert.equal(JSON.stringify(q), JSON.stringify(['msg_ok']), 'la cola conserva sólo el válido pendiente');
  // próximo inicio: misma cola reescrita
  const m2 = montar({ store: { [KEY]: m1.log.store[KEY], [BK]: m1.log.store[BK] } });
  await m2.api.recuperarNuevasPendientesV1();
  assert.equal(m2.log.banners, 0, 'ya no hay aviso');
  assert.equal(JSON.parse(m2.log.store[BK]).length, 1, 'el respaldo no se duplica');
});
caso('10. el respaldo no duplica el mismo mensaje y no pisa respaldos previos', async () => {
  const previo = [{ id: 'msg_prev', texto: 'anterior', destino: 'todos', fecha: '2026-10-01' }];
  const m = montar({ store: Object.assign(outbox([msg({ id: 'msg_mal', deUsuario: 'rga' })]), { [BK]: JSON.stringify(previo) }) });
  await m.api.recuperarNuevasPendientesV1();
  const bk = JSON.parse(m.log.store[BK]);
  assert.equal(bk.length, 2); assert.equal(bk[0].id, 'msg_prev'); assert.equal(bk[1].id, 'msg_mal');
});
caso('11. Secretaría: pendientes antiguos se reenvían como siempre (sin filtro)', async () => {
  const m = montar({ ident: null, login: null, rolBase: 'secretaria', store: outbox([msg({ id: 'm_sec', deUsuario: 'geraldine', destino: 'rol:admin', creadoUid: undefined })]) });
  await m.api.recuperarNuevasPendientesV1();
  assert.equal(JSON.stringify(m.log.sync), JSON.stringify([['m_sec']]));
  assert.ok(!(BK in m.log.store)); assert.equal(m.log.banners, 0);
});
caso('estático: el aviso de pendientes no usa alert() y descartarMensajesRechazados298 sigue existiendo', () => {
  const rec = tramo('function avisarMensajesNoReenviadosV1', 'async function recuperarNuevasPendientesV1');
  assert.ok(!/\balert\(/.test(rec));
  assert.ok(app.includes('function descartarMensajesRechazados298'));
});

(async () => {
  let fallos = 0;
  for (const [n, f] of casos) {
    try { await f(); console.log('PASS ' + n); } catch (e) { fallos++; console.log('FAIL ' + n + '\n     ' + (e && e.message)); }
  }
  console.log(`\n${casos.length - fallos}/${casos.length} PASS`);
  if (fallos) process.exit(1);
})();
