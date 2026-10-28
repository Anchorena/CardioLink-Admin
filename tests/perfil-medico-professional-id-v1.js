'use strict';

// tests/perfil-medico-professional-id-v1.js
// perfilUsuarioActual(): un médico con identidad de backend (cardiolink_identidad_pendientes_v1) se resuelve por su professional_id aunque su login no
// coincida con ningún alias local; la comparación ignora mayúsculas/espacios; sólo vale un usuario MÉDICO ACTIVO vinculado a ese professional_id; sin
// coincidencia queda el perfil de respaldo (fail-closed). Los permisos no cambian. Ejecuta el código REAL de app.js (sin Supabase, sin red).

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
  tramo('function normalizarUsuarioTexto', '/* ===== Rol backend autoritativo'),   // usuarios, alias, perfilUsuarioActual
  tramo('function esMedicoBackendV1', '// Fail-closed: sólo owner/admin'),            // esMedicoBackendV1 + nombreVisibleBackendV1
  tramo('function esMatiasDuenio()', 'function puedeVerFacturaRogelio')                 // esMatiasDuenio, rolBaseUsuarioActual, esSecretaria/Admin/Medico
].join('\n');

function sesion(email, ident, opc) {
  opc = opc || {};
  const data = { usuarios: opc.usuarios || [], roles: [], profesionales: [{ id: 'rogelio', nombre: 'Dr. Rogelio Anchorena' }, { id: 'matias', nombre: 'Dr. Matías Anchorena' }] };
  const f = new Function('env',
    'let usuarioPerfilActual=null;' +
    'const usuarioSupabase=env.email===null?null:{id:"u1",email:env.email};' +
    'const data=env.data;' +
    'const backendPendientesIdentidadV1=env.ident;' +
    'const backendRolCargado=true;' +
    'const backendEsAdminOwner=env.adminOwner===true;' +
    'const backendTieneAccesoTurnos=env.secretaria===true;' +
    'const backendMensajeriaV1={login:"login_backend"};' +
    'const directorioMensajesV1=[];' +
    CODIGO +
    '\nreturn {perfil:perfilUsuarioActual,rolBase:rolBaseUsuarioActual,esMatiasDuenio,esMedico,esSecretaria,esAdminComun};');
  return f({ email, ident, data, adminOwner: opc.adminOwner, secretaria: opc.secretaria });
}
const medico = p => ({ role: 'medico', professional_id: p });

const casos = [];
function caso(n, f) { casos.push([n, f]); }

caso('1. email SIN alias de Rogelio + professional_id rogelio: se resuelve por el backend (antes caía en usr_sin_config)', () => {
  for (const email of ['rga@gmail.com', 'otro.nombre@gmail.com', 'r.anchorena@hospital.org']) {
    const s = sesion(email, medico('rogelio'));
    const u = s.perfil();
    assert.equal(u.id, 'rogelio', email);
    assert.equal(u.rol, 'medico');
    assert.equal(u.profesionalId, 'rogelio');
    assert.equal(s.rolBase(), 'medico');
    assert.equal(s.esMedico(), true);
  }
});
caso('1b. con alias correcto sigue resolviéndose igual (sin regresión)', () => {
  const u = sesion('rogelio.anchorena@cardiolink.local', medico('rogelio')).perfil();
  assert.equal(u.id, 'rogelio'); assert.equal(u.rol, 'medico');
});
caso('2. professional_id con mayúsculas y espacios: se normaliza', () => {
  for (const p of ['Rogelio', 'ROGELIO', ' rogelio ', 'Rogelio  ']) {
    const u = sesion('rga@gmail.com', medico(p)).perfil();
    assert.equal(u.id, 'rogelio', JSON.stringify(p));
    assert.equal(u.profesionalId, 'rogelio', 'conserva el id local canónico');
  }
});
caso('3. médico sin vínculo válido: fail-closed (perfil de respaldo, sin permisos nuevos)', () => {
  const inexistente = sesion('rga@gmail.com', medico('medico_inexistente')).perfil();
  assert.equal(inexistente.id, 'usr_sin_config'); assert.equal(inexistente.rol, 'sin_configurar');
  for (const p of ['', '   ', null, undefined]) {
    const u = sesion('rga@gmail.com', medico(p)).perfil();
    assert.equal(u.id, 'usr_sin_config', 'professional_id vacío: ' + JSON.stringify(p));
  }
  // vinculado pero INACTIVO
  const inactivo = sesion('x@gmail.com', medico('p_inactivo'), { usuarios: [{ id: 'm_x', usuario: 'm_x', nombre: 'Dr. X', rol: 'medico', profesionalId: 'p_inactivo', activo: false }] }).perfil();
  assert.equal(inactivo.id, 'usr_sin_config');
  // vinculado pero con rol que NO es médico
  const noMedico = sesion('x@gmail.com', medico('p_sec'), { usuarios: [{ id: 's_x', usuario: 's_x', nombre: 'Sec X', rol: 'secretaria', profesionalId: 'p_sec', activo: true }] }).perfil();
  assert.equal(noMedico.id, 'usr_sin_config');
  // vinculado, médico y activo => sí
  const ok = sesion('x@gmail.com', medico('P_ok'), { usuarios: [{ id: 'm_ok', usuario: 'm_ok', nombre: 'Dr. OK', rol: 'medico', profesionalId: 'p_ok', activo: true }] }).perfil();
  assert.equal(ok.id, 'm_ok');
});
caso('4. no hay escalada de privilegios', () => {
  // un médico del backend con professional_id "matias" NO obtiene el perfil de dueño
  const a = sesion('rga@gmail.com', medico('matias'));
  assert.ok(a.perfil().rol !== 'duenio'); assert.equal(a.perfil().id, 'usr_sin_config');
  assert.equal(a.esMatiasDuenio(), false); assert.equal(a.rolBase(), 'medico');
  // un alias de dueño en el email no sobreescribe la identidad médica del servidor
  const b = sesion('matias@cardiolink.local', medico('rogelio'));
  assert.equal(b.perfil().id, 'rogelio'); assert.equal(b.esMatiasDuenio(), false); assert.equal(b.rolBase(), 'medico');
  // médico: nunca admin ni secretaría, con cualquier perfil resuelto
  const c = sesion('rga@gmail.com', medico('rogelio'));
  assert.equal(c.esAdminComun(), false); assert.equal(c.esSecretaria(), false); assert.equal(c.esMatiasDuenio(), false);
});
caso('4b. otros roles sin cambios: secretaría y owner/admin siguen por su camino', () => {
  const sec = sesion('geraldine@cardiolink.local', null, { secretaria: true });
  assert.equal(sec.perfil().id, 'geraldine'); assert.equal(sec.rolBase(), 'secretaria');
  const duenio = sesion('matias@cardiolink.local', { role: 'owner', professional_id: 'matias' }, { adminOwner: true });
  assert.equal(duenio.perfil().id, 'matias'); assert.equal(duenio.esMatiasDuenio(), true);
  const sinBackend = sesion('rga@gmail.com', null);
  assert.equal(sinBackend.perfil().id, 'usr_sin_config');
});
caso('estático: la corrección está en perfilUsuarioActual y usa helpers de normalización', () => {
  assert.ok(app.includes('function normalizarProfesionalIdV1'));
  assert.ok(app.includes('if(!vinculado(u)) u=(data.usuarios||[]).find(vinculado)||null;'));
  assert.ok(!app.includes("if(u && String(u.profesionalId||'')!==P)"), 'la guarda vieja (u &&) ya no debe existir');
});

(async () => {
  let fallos = 0;
  for (const [n, f] of casos) {
    try { await f(); console.log('PASS ' + n); } catch (e) { fallos++; console.log('FAIL ' + n + '\n     ' + (e && e.message)); }
  }
  console.log(`\n${casos.length - fallos}/${casos.length} PASS`);
  if (fallos) process.exit(1);
})();
