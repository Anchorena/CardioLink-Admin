'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const modulePath = path.join(root, 'cardiolink-solicitudes-turno.js');
const moduleSource = fs.readFileSync(modulePath, 'utf8');
const sqlPath = path.join(root, 'supabase', 'migrations', '20260819180000_cardiolink_appointment_requests_schema.sql');
const sqlSource = fs.readFileSync(sqlPath, 'utf8');
const indexSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

function test(name, run) {
  try {
    run();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

// -----------------------------------------------------------------------
// Migración: estados válidos, sin DELETE, id + revision, permisos propios
// -----------------------------------------------------------------------

test('la migración restringe status al enum de 5 estados', () => {
  assert.match(sqlSource, /status in \('new', 'in_progress', 'appointment_assigned', 'closed', 'cancelled'\)/);
});

test('la migración no otorga ni define ningún DELETE', () => {
  assert.doesNotMatch(sqlSource, /grant[^;]*delete/i);
  assert.doesNotMatch(sqlSource, /for delete/i);
  assert.doesNotMatch(sqlSource, /^\s*drop table\s+public\.cardiolink_appointment_requests/im);
});

test('la migración controla revision por trigger, no por el cliente', () => {
  assert.match(sqlSource, /revision must not be changed directly/);
  assert.match(sqlSource, /new\.revision := old\.revision \+ 1/);
});

test('la autorización de solicitudes es propia: usa auth.uid() y no reutiliza Finanzas 5', () => {
  assert.match(sqlSource, /create function public\.cardiolink_has_appointment_requests_access/);
  assert.match(sqlSource, /where user_role\.user_id = auth\.uid\(\)/);
  assert.doesNotMatch(sqlSource, /cardiolink_has_finance_access/);
  assert.match(sqlSource, /base_role in \('owner', 'admin', 'secretaria'\)/);
});

test('anon queda sin privilegios directos y RLS está habilitado', () => {
  assert.match(sqlSource, /alter table public\.cardiolink_appointment_requests enable row level security/);
  assert.match(sqlSource, /revoke all privileges on table public\.cardiolink_appointment_requests\s*\n\s*from public, anon, authenticated/);
  assert.doesNotMatch(sqlSource, /grant[^;]*to anon/i);
});

test('patient_id referencia a cardiolink_pacientes sin tocar esa tabla', () => {
  assert.match(sqlSource, /references public\.cardiolink_pacientes \(id\)/);
  assert.doesNotMatch(sqlSource, /alter table public\.cardiolink_pacientes/);
});

test('no hardcodea UUID de personas dentro de la migración', () => {
  assert.doesNotMatch(sqlSource, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
});

// -----------------------------------------------------------------------
// Módulo JS: permisos, alcance, integración con Carga
// -----------------------------------------------------------------------

test('expone los 5 estados con las mismas etiquetas del enum backend', () => {
  const mod = require(modulePath);
  assert.deepEqual(Object.keys(mod.estados), ['new', 'in_progress', 'appointment_assigned', 'closed', 'cancelled']);
});

test('el módulo nunca hace DELETE ni toca Finanzas 5/HC', () => {
  assert.doesNotMatch(moduleSource, /\.delete\s*\(/);
  assert.doesNotMatch(moduleSource, /\.rpc\(\s*['"]cardiolink_has_finance_access['"]\s*\)/);
  assert.doesNotMatch(moduleSource, /cardiolink_finance_/);
  assert.doesNotMatch(moduleSource, /abrirModalEdicion|renderDetailHC|hcPacienteDetalle|guardarEvolucionHC/);
  assert.doesNotMatch(moduleSource, /sessionStorage/);
});

// -----------------------------------------------------------------------
// Staging Local (Fase 2B): mismo patrón de seguridad que Finanzas 5
// -----------------------------------------------------------------------

// -----------------------------------------------------------------------
// Exposición global: window.CardioLinkSolicitudesTurno debe existir
// (bug de Fase 2B/QA: el factory nunca lo asignaba, sólo exportaba a
// module.exports y llamaba a install(), por eso la consola veía undefined)
// -----------------------------------------------------------------------

test('el factory expone window.CardioLinkSolicitudesTurno con la API completa', () => {
  delete require.cache[require.resolve(modulePath)];
  const ventana = {}; // sin .document: no dispara install()/MutationObserver
  global.window = ventana;
  global.document = {};
  try {
    const mod = require(modulePath);
    assert.equal(typeof ventana.CardioLinkSolicitudesTurno, 'object');
    assert.notEqual(ventana.CardioLinkSolicitudesTurno, null);
    assert.equal(ventana.CardioLinkSolicitudesTurno, mod, 'window.CardioLinkSolicitudesTurno es la misma API que module.exports');
    ['configurarStagingLocal', 'estadoStagingLocal', 'desactivarStagingLocal', 'conectarClientePrincipal'].forEach((metodo) => {
      assert.equal(typeof ventana.CardioLinkSolicitudesTurno[metodo], 'function', `expone ${metodo}`);
    });
  } finally {
    delete global.window;
    delete global.document;
  }
});

test('no sobreescribe un window.CardioLinkSolicitudesTurno ya existente (guarda contra doble carga)', () => {
  delete require.cache[require.resolve(modulePath)];
  const centinela = { yaExistia: true };
  global.window = { CardioLinkSolicitudesTurno: centinela };
  global.document = {};
  try {
    require(modulePath);
    assert.equal(global.window.CardioLinkSolicitudesTurno, centinela);
  } finally {
    delete global.window;
    delete global.document;
  }
});

test('la línea de exposición global usa exactamente el nombre que app.js espera', () => {
  assert.match(moduleSource, /if \(root && !root\.CardioLinkSolicitudesTurno\) root\.CardioLinkSolicitudesTurno = api;/);
});

test('Staging Local: mismo patrón de seguridad que Finanzas 5, sesión sin persistir', () => {
  assert.match(moduleSource, /persistSession:\s*false/);
  assert.match(moduleSource, /detectSessionInUrl:\s*false/);
  assert.match(moduleSource, /autoRefreshToken:\s*true/);
  assert.match(moduleSource, /sb_secret_/);
  assert.match(moduleSource, /service\[_-\]\?role/);
  assert.match(moduleSource, /window\.location\.protocol === 'file:'/);
  assert.match(moduleSource, /'localhost', '127\.0\.0\.1', '::1', '\[::1\]'/);
});

test('Staging Local usa claves de localStorage propias, distintas de Finanzas 5', () => {
  assert.match(moduleSource, /cardiolink_solicitudes_turno_staging_config_v1/);
  assert.match(moduleSource, /cardiolink_solicitudes_turno_staging_auth_v1/);
  const finanzasPath = path.join(root, 'cardiolink-finanzas-v5.js');
  const finanzasSource = fs.readFileSync(finanzasPath, 'utf8');
  assert.doesNotMatch(finanzasSource, /cardiolink_solicitudes_turno_staging/);
  assert.doesNotMatch(moduleSource, /cardiolink_finanzas_v5_staging/);
});

test('producción online nunca usa Staging: iniciarSesionPrincipalProduccion se aborta en entorno local', () => {
  const inicio = moduleSource.indexOf('async function iniciarSesionPrincipalProduccion');
  assert.notEqual(inicio, -1, 'existe iniciarSesionPrincipalProduccion');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  assert.match(cuerpo, /if \(esEntornoLocal\(\)/);
});

test('conectarClientePrincipal no compite con Staging: sólo dispara montaje fuera de entorno local', () => {
  assert.match(moduleSource, /if \(hayNavegador\(\) && !esEntornoLocal\(\) && document\.readyState !== 'loading'\)/);
});

function crearVentanaLocalStaging(overrides = {}) {
  const storage = new Map();
  return Object.assign({
    location: { protocol: 'http:', hostname: 'localhost' },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k)
    },
    atob: (b64) => Buffer.from(b64, 'base64').toString('binary'),
    esMatiasDuenio: () => true,
    esAdminComun: () => false,
    esSecretaria: () => false
  }, overrides);
}

test('estadoStagingLocal fuera de un origen local no expone nada activo', () => {
  delete require.cache[require.resolve(modulePath)];
  const mod = require(modulePath);
  const estado = mod.estadoStagingLocal();
  assert.deepEqual(estado, { local: false, activa: false, entorno: null, url: null, autenticada: false, accesoBackend: false });
});

test('configurarStagingLocal exige un origen local antes de tocar localStorage', () => {
  delete require.cache[require.resolve(modulePath)];
  const mod = require(modulePath);
  assert.throws(() => mod.configurarStagingLocal({ url: 'https://staging-project.supabase.co', publishableKey: 'sb_publishable_test' }),
    /sólo puede activarse desde localhost/);
});

test('configurarStagingLocal rechaza claves secret/service_role y acepta una publishable key', () => {
  global.window = crearVentanaLocalStaging();
  global.document = {};
  try {
    delete require.cache[require.resolve(modulePath)];
    const mod = require(modulePath);
    assert.throws(() => mod.configurarStagingLocal({ url: 'https://staging-project.supabase.co', publishableKey: 'sb_secret_test' }),
      /rechaza claves secret\/service_role/);
    assert.throws(() => mod.configurarStagingLocal({ url: 'https://staging-project.supabase.co', publishableKey: 'algo-service_role-algo' }),
      /rechaza claves secret\/service_role/);
    assert.throws(() => mod.configurarStagingLocal({ url: 'https://staging-project.supabase.co', publishableKey: '' }),
      /Falta la publishable key/);

    const resultado = mod.configurarStagingLocal({ url: 'https://staging-project.supabase.co', publishableKey: 'sb_publishable_test123' });
    assert.equal(resultado.activa, true);
    assert.equal(resultado.entorno, 'staging');
    assert.equal(resultado.url, 'https://staging-project.supabase.co');

    const estado = mod.estadoStagingLocal();
    assert.equal(estado.local, true);
    assert.equal(estado.activa, true);
    assert.equal(estado.entorno, 'staging');
    assert.equal(estado.url, 'https://staging-project.supabase.co');
    assert.equal(estado.autenticada, false);
    assert.equal(estado.accesoBackend, false);
  } finally {
    delete global.window;
    delete global.document;
  }
});

test('configurarStagingLocal rechaza una URL igual a la del cliente principal', () => {
  global.window = crearVentanaLocalStaging();
  global.document = {};
  try {
    delete require.cache[require.resolve(modulePath)];
    const mod = require(modulePath);
    const clientePrincipal = {
      auth: { getSession: async () => ({}) }, rpc: async () => ({}), from: () => ({}),
      supabaseUrl: 'https://staging-project.supabase.co'
    };
    assert.equal(mod.conectarClientePrincipal(clientePrincipal), true);
    assert.throws(() => mod.configurarStagingLocal({ url: 'https://staging-project.supabase.co', publishableKey: 'sb_publishable_test' }),
      /sólo admite un proyecto de Staging independiente/);
  } finally {
    delete global.window;
    delete global.document;
  }
});

test('desactivarStagingLocal limpia ambas claves de localStorage y destruye el cliente', () => {
  const inicio = moduleSource.indexOf('async function desactivarStagingLocal');
  assert.notEqual(inicio, -1, 'existe desactivarStagingLocal');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  assert.match(cuerpo, /localStorage\.removeItem\(CONFIG_STORAGE_KEY\)/);
  assert.match(cuerpo, /localStorage\.removeItem\(AUTH_STORAGE_KEY\)/);
  assert.match(cuerpo, /destruirCliente\(\)/);
  assert.match(cuerpo, /limpiarDatos\(\)/);
});

test('cada UPDATE filtra por id y revision esperada', () => {
  const inicio = moduleSource.indexOf('async function actualizarEstado');
  assert.notEqual(inicio, -1, 'existe actualizarEstado');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  assert.match(cuerpo, /\.eq\('id', solicitud\.id\)\.eq\('revision', solicitud\.revision\)/);
  assert.match(cuerpo, /filas\.length === 0/, 'reconoce 0 filas como conflicto de concurrencia, no como éxito silencioso');
});

test('toda mutación revalida el backend antes de escribir (exigirMutacionBackend)', () => {
  const inicio = moduleSource.indexOf('async function actualizarEstado');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  assert.match(cuerpo, /await exigirMutacionBackend\(\)/);
});

test('frontendPuedeAcceder depende de los roles existentes, sin lógica nueva', () => {
  assert.doesNotMatch(moduleSource, /baseRole\s*[:=]/);
  assert.doesNotMatch(moduleSource, /\brolId\b/);
  assert.match(moduleSource, /esMatiasDuenio\?\.\(\) \|\| window\.esAdminComun\?\.\(\) \|\| window\.esSecretaria\?\.\(\)/);
});

test('frontendPuedeAcceder autoriza owner/admin/secretaria y niega otros roles', () => {
  const globalWindow = {
    esMatiasDuenio: () => false,
    esAdminComun: () => false,
    esSecretaria: () => false
  };
  global.window = globalWindow;
  global.document = { readyState: 'complete', addEventListener: () => {} };
  delete require.cache[require.resolve(modulePath)];
  const mod = require(modulePath);

  globalWindow.esMatiasDuenio = () => true;
  assert.equal(mod.frontendPuedeAcceder(), true, 'owner autorizado');
  globalWindow.esMatiasDuenio = () => false;
  globalWindow.esAdminComun = () => true;
  assert.equal(mod.frontendPuedeAcceder(), true, 'admin autorizado');
  globalWindow.esAdminComun = () => false;
  globalWindow.esSecretaria = () => true;
  assert.equal(mod.frontendPuedeAcceder(), true, 'secretaría autorizada');
  globalWindow.esSecretaria = () => false;
  assert.equal(mod.frontendPuedeAcceder(), false, 'un rol médico/no reconocido queda afuera');

  delete global.window;
  delete global.document;
});

test('conectarClientePrincipal exige forma de cliente válida y no admite un segundo cliente', () => {
  delete require.cache[require.resolve(modulePath)];
  const mod = require(modulePath);
  const clienteInvalido = {};
  assert.equal(mod.conectarClientePrincipal(clienteInvalido), false);
  const clienteValido = { auth: { getSession: async () => ({}) }, rpc: async () => ({}), from: () => ({}) };
  assert.equal(mod.conectarClientePrincipal(clienteValido), true);
  assert.equal(mod.conectarClientePrincipal(clienteValido), false, 'no permite reconectar/reemplazar el cliente');
});

test('accionesParaFila no ofrece mutaciones sobre solicitudes cerradas o canceladas', () => {
  delete require.cache[require.resolve(modulePath)];
  const mod = require(modulePath);
  const bloqueadas = ['en-gestion', 'turno-asignado', 'cerrar', 'cancelar'];
  ['closed', 'cancelled'].forEach((status) => {
    const acciones = mod.accionesParaFila({ status }).map(([accion]) => accion);
    bloqueadas.forEach((accion) => assert.equal(acciones.includes(accion), false, `${status} no debería ofrecer ${accion}`));
    assert.ok(acciones.includes('ver-paciente'), `${status} conserva Ver paciente`);
    assert.ok(acciones.includes('copiar-telefono'), `${status} conserva Copiar teléfono`);
  });
  assert.deepEqual(mod.accionesParaFila({ status: 'new' }).map(([accion]) => accion),
    ['ver-paciente', 'copiar-telefono', 'abrir-carga', 'en-gestion', 'turno-asignado', 'cerrar', 'cancelar']);
});

// Bloque completo desde el primer helper (normalizarTexto) hasta el cierre
// de abrirCargaDeTurno: cubre hidratación remota, matching de profesional y
// prestación, y la función que los orquesta.
function bloqueIntegracionCarga() {
  const inicio = moduleSource.indexOf('function normalizarTexto');
  const finMarcador = moduleSource.indexOf('function abrirCargaDeTurno');
  const finAbrirCarga = moduleSource.indexOf('\n  }', finMarcador);
  assert.notEqual(inicio, -1, 'existe normalizarTexto');
  assert.notEqual(finMarcador, -1, 'existe abrirCargaDeTurno');
  return moduleSource.slice(inicio, finAbrirCarga);
}

test('abrirCargaDeTurno reutiliza showSection y no crea una atención ni marca "asignado"', () => {
  const inicio = moduleSource.indexOf('async function abrirCargaDeTurno');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  assert.match(cuerpo, /window\.showSection\('carga'\)/);
  assert.match(cuerpo, /window\.usarPaciente\(solicitud\.patient_id\)/);
  assert.doesNotMatch(cuerpo, /\.insert\s*\(/);
  assert.doesNotMatch(cuerpo, /crearAtencionDesdeFormulario|guardarAtencion\s*\(/);
  assert.doesNotMatch(cuerpo, /appointment_assigned/);
});

test('abrirCargaDeTurno intenta el paciente local primero y sólo llama a Supabase si no lo encuentra', () => {
  const inicio = moduleSource.indexOf('async function abrirCargaDeTurno');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  assert.match(cuerpo, /pacienteDisponibleLocalmente\(solicitud\.patient_id\)/);
  const posLocal = cuerpo.indexOf('pacienteDisponibleLocalmente');
  const posRemoto = cuerpo.indexOf('hidratarPacienteRemoto');
  assert.notEqual(posRemoto, -1, 'existe el fallback remoto');
  assert.ok(posLocal < posRemoto, 'el chequeo local ocurre antes que el fallback remoto');
  assert.match(cuerpo, /if \(!hidratado\)/, 'el fallback remoto sólo corre si el local no encontró nada');
});

test('hidratarPacienteRemoto usa el mismo cliente del módulo, filtra por id y conserva patient_id', () => {
  const inicio = moduleSource.indexOf('async function hidratarPacienteRemoto');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  assert.match(cuerpo, /estadoUI\.client\.from\('cardiolink_pacientes'\)/, 'usa el cliente activo del módulo, no uno nuevo');
  assert.doesNotMatch(cuerpo, /createClient/, 'no crea un cliente nuevo');
  assert.match(cuerpo, /\.eq\('id', patientId\)/);
  assert.match(cuerpo, /set\('pacienteId', fila\.id\)/, 'conserva el id devuelto por Supabase para el mismo patient_id consultado');
  ['nombre_completo', 'dni', 'telefono', 'email', 'fecha_nacimiento', 'cobertura_habitual', 'numero_afiliado_habitual'].forEach((columna) => {
    assert.ok(cuerpo.includes(columna), `selecciona/usa la columna ${columna}`);
  });
  assert.doesNotMatch(cuerpo, /cardiolink_hc_/, 'no toca tablas de HC');
});

test('hidratarPacienteRemoto completa los 7 campos administrativos pedidos', () => {
  const inicio = moduleSource.indexOf('async function hidratarPacienteRemoto');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  assert.match(cuerpo, /set\('paciente', fila\.nombre_completo\)/);
  assert.match(cuerpo, /set\('dni', fila\.dni\)/);
  assert.match(cuerpo, /set\('telefono', fila\.telefono\)/);
  assert.match(cuerpo, /set\('email', fila\.email\)/);
  assert.match(cuerpo, /set\('fechaNacimiento', fila\.fecha_nacimiento\)/);
  assert.match(cuerpo, /selectObraSocial\.value = fila\.cobertura_habitual/);
  assert.match(cuerpo, /set\('numeroAfiliado', fila\.numero_afiliado_habitual\)/);
});

test('seleccionarProfesionalSolicitado matchea por id o por nombre normalizado sin depender de que el id exista (regresión del gate original)', () => {
  const inicio = moduleSource.indexOf('function seleccionarProfesionalSolicitado');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  // La regresión original exigía requested_professional_id truthy para
  // intentar SIQUIERA el fallback por nombre. Ahora deben ser dos chequeos
  // independientes, no uno anidado dentro del otro.
  assert.doesNotMatch(cuerpo, /if \(selectProfesional && solicitud\.requested_professional_id\)/);
  assert.match(cuerpo, /if \(solicitud\.requested_professional_id\)/);
  assert.match(cuerpo, /if \(!coincide && solicitud\.requested_professional_name\)/);
  assert.match(cuerpo, /normalizarTexto\(solicitud\.requested_professional_name\)/);
  // El 'change' debe dispararse siempre (haya o no coincidencia), para que
  // #prestacion quede repoblado antes de intentar seleccionar la prestación.
  const posIf = cuerpo.indexOf('if (coincide) selectProfesional.value');
  assert.notEqual(posIf, -1);
  const posDispatch = cuerpo.indexOf('selectProfesional.dispatchEvent', posIf);
  assert.notEqual(posDispatch, -1);
  const entreMedio = cuerpo.slice(posIf, posDispatch);
  // Ninguna llave abierta entre el if(coincide) de una sola línea (sin
  // bloque) y el dispatchEvent: prueba que éste corre incondicionalmente,
  // no anidado dentro de un bloque abierto por ese if.
  assert.doesNotMatch(entreMedio, /\{/, 'dispatchEvent no debe quedar dentro de ningún bloque abierto por if(coincide)');
});

test('abrirCargaDeTurno selecciona el profesional antes que la prestación, en ese orden', () => {
  const inicio = moduleSource.indexOf('async function abrirCargaDeTurno');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  const posProfesional = cuerpo.indexOf('seleccionarProfesionalSolicitado(solicitud)');
  const posPrestacion = cuerpo.indexOf('seleccionarPrestacionSolicitada(solicitud)');
  assert.notEqual(posProfesional, -1);
  assert.notEqual(posPrestacion, -1);
  assert.ok(posProfesional < posPrestacion, 'el profesional se resuelve antes que la prestación, para que #prestacion ya esté repoblado (Holter, etc.)');
});

test('seleccionarPrestacionSolicitada normaliza el texto, no crea prestaciones nuevas y avisa sin fallar si no matchea', () => {
  const inicio = moduleSource.indexOf('function seleccionarPrestacionSolicitada');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  assert.match(cuerpo, /normalizarTexto\(solicitud\.requested_service\)/);
  assert.match(cuerpo, /normalizarTexto\(o\.textContent\)/);
  assert.doesNotMatch(cuerpo, /createElement|\.options\.push|\.appendChild/, 'nunca crea una opción nueva');
  assert.match(cuerpo, /estadoUI\.mensaje = /, 'muestra un aviso cuando no encuentra coincidencia');
  assert.doesNotMatch(cuerpo, /throw /, 'no falla: sólo avisa y sigue');
});

test('normalizarTexto ignora mayúsculas/minúsculas y acentos (coincidencia tolerante)', () => {
  const inicio = moduleSource.indexOf('function normalizarTexto');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  assert.match(cuerpo, /\.toLowerCase\(\)/);
  assert.match(cuerpo, /normalize\('NFD'\)/);
});

test('el bloque de integración Solicitud -> Carga no crea atención ni marca appointment_assigned', () => {
  const cuerpo = bloqueIntegracionCarga();
  assert.doesNotMatch(cuerpo, /\.insert\s*\(/);
  assert.doesNotMatch(cuerpo, /crearAtencionDesdeFormulario|guardarAtencion\s*\(/);
  assert.doesNotMatch(cuerpo, /appointment_assigned/);
  assert.doesNotMatch(cuerpo, /createClient/, 'no crea ningún cliente Supabase nuevo, sólo usa estadoUI.client');
});

// -----------------------------------------------------------------------
// Integración mínima
// -----------------------------------------------------------------------

test('index.html sólo agrega nav/sección/carga de script y css, sin duplicados', () => {
  assert.equal((indexSource.match(/data-section="solicitudesTurno"/g) || []).length, 1);
  assert.equal((indexSource.match(/id="solicitudesTurno"/g) || []).length, 1);
  assert.equal(indexSource.match(/cardiolink-solicitudes-turno\.js/g)?.length, 1);
  assert.equal(indexSource.match(/cardiolink-solicitudes-turno\.css/g)?.length, 1);
  const scriptAt = indexSource.indexOf('<script src="cardiolink-solicitudes-turno.js');
  const appAt = indexSource.indexOf('<script src="app.js');
  assert.ok(scriptAt >= 0 && scriptAt < appAt, 'se carga antes que app.js, igual que Finanzas 5');
});

test('app.js sólo agrega el conector y el permiso de sección, sin lógica nueva', () => {
  assert.equal((appSource.match(/CardioLinkSolicitudesTurno\?\.conectarClientePrincipal\?\./g) || []).length, 1);
  assert.match(appSource, /'solicitudesTurno'/);
});

console.log('Solicitudes de turno — presentación/backend: OK');
