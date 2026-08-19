'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const modulePath = path.join(__dirname, '..', 'cardiolink-finanzas-v5.js');
const originalSource = fs.readFileSync(modulePath, 'utf8');
const injectionMarker = '  const api = Object.freeze({';

assert.equal(originalSource.split(injectionMarker).length - 1, 1, 'El punto de instrumentación debe ser único');

// Los helpers internos se exponen únicamente en esta copia evaluada por Node.
const instrumentedSource = originalSource.replace(injectionMarker, `
  globalThis.__finanzasV5ProduccionTest = Object.freeze({
    resolverModoEjecucion,
    modoPermiteMutaciones,
    autorizarYEjecutarProduccion,
    exigirMutacionBackend,
    clientePrincipalInyectado: () => clientePrincipalAutorizado,
    prepararGuardProduccion: ({ session, accesoBackend }) => {
      estadoUI.root = null;
      estadoUI.modo = 'produccion';
      estadoUI.client = clientePrincipalAutorizado;
      estadoUI.clientOwned = false;
      estadoUI.session = session || null;
      estadoUI.accesoBackend = accesoBackend === true;
      estadoUI.accesoDenegadoProduccion = false;
      estadoUI.mensaje = '';
      estadoUI.tipoMensaje = '';
    },
    renderFixtureProduccion: () => {
      estadoUI.modo = 'produccion';
      estadoUI.categorias = [{ id: 'cat', parent_id: null, name: 'Categoría', active: true }];
      estadoUI.egresos = [{ id: 'e1', expense_date: '2026-08-01', category_id: 'cat', concept: 'Prueba', amount: 1, status: 'paid', source_type: 'manual', revision: 1 }];
      estadoUI.plantillas = [{ id: 'p1', category_id: 'cat', concept: 'Plantilla', active: true, revision: 1 }];
      estadoUI.obligacionesF4 = [{ key: 'salary', title: 'Sueldo', category_id: 'cat', category_available: true, amount: 1, period_month: '2026-08-01', source_type: 'salary_f4', source_ref: 'salary_f4:secretaria:2026-08', source_snapshot: {} }];
      estadoUI.egresosObligacionesF4 = [];
      return {
        egresos: renderTablaEgresos(),
        plantillas: renderPlantillas(),
        obligaciones: renderObligacionesF4()
      };
    },
    renderShellProduccion: (rootFixture) => {
      estadoUI.root = rootFixture;
      estadoUI.modo = 'produccion';
      estadoUI.session = { user: { email: 'owner@example.com' } };
      estadoUI.accesoBackend = true;
      estadoUI.vista = 'egresos';
      estadoUI.categorias = [];
      estadoUI.egresos = [];
      estadoUI.egresosPagadosPorFechaPago = [];
      renderInterfaz();
      return rootFixture.innerHTML;
    }
  });

${injectionMarker}`);

const testWindow = {
  data: { profesionales: [] },
  frontendRole: 'owner',
  esMatiasDuenio() { return this.frontendRole === 'owner'; },
  esAdminComun() { return this.frontendRole === 'admin'; }
};
const context = vm.createContext({
  module: { exports: {} },
  exports: {},
  window: testWindow,
  URL,
  Intl
});
vm.runInContext(instrumentedSource, context, { filename: 'cardiolink-finanzas-v5.js' });

const {
  resolverModoEjecucion,
  modoPermiteMutaciones,
  autorizarYEjecutarProduccion,
  exigirMutacionBackend,
  clientePrincipalInyectado,
  prepararGuardProduccion,
  renderFixtureProduccion,
  renderShellProduccion
} = context.__finanzasV5ProduccionTest;

const contextoAutorizado = {
  tieneSesion: true,
  accesoBackend: true,
  frontendAutorizado: true,
  clienteAutorizado: true
};

assert.equal(
  resolverModoEjecucion({ local: false, clientePrincipalDisponible: true }),
  'produccion',
  'Fuera de local usa el cliente principal en Producción'
);
assert.equal(
  resolverModoEjecucion({ local: true, stagingConfigurado: true, clientePrincipalDisponible: true }),
  'staging-local',
  'Localhost conserva el cliente independiente de Staging aunque exista el principal'
);
assert.equal(
  resolverModoEjecucion({ local: true, stagingConfigurado: false, clientePrincipalDisponible: true }),
  'local-desactivado',
  'Localhost sin configuración no obtiene un bypass hacia Producción'
);
assert.equal(modoPermiteMutaciones('produccion', contextoAutorizado), true, 'Owner/Admin autorizado puede mutar en Producción');
assert.equal(modoPermiteMutaciones('staging-local', contextoAutorizado), true, 'Staging Local conserva CRUD');
['tieneSesion', 'accesoBackend', 'frontendAutorizado', 'clienteAutorizado'].forEach((propiedad) => {
  assert.equal(
    modoPermiteMutaciones('produccion', { ...contextoAutorizado, [propiedad]: false }),
    false,
    `Producción rechaza mutaciones sin ${propiedad}`
  );
});

let sesionPrincipal = { user: { id: 'owner' } };
let accesoRpc = true;
let llamadasRpc = 0;
const clienteInyectado = {
  marker: 'principal',
  auth: { getSession: async () => ({ data: { session: sesionPrincipal }, error: null }) },
  rpc: async (nombre) => {
    llamadasRpc += 1;
    assert.equal(nombre, 'cardiolink_has_finance_access');
    return { data: accesoRpc, error: null };
  },
  from: () => ({})
};
assert.equal(context.module.exports.conectarClientePrincipal(clienteInyectado), true, 'Acepta el cliente principal válido');
assert.equal(clientePrincipalInyectado().marker, 'principal', 'Conserva exactamente el cliente inyectado por app.js');
assert.equal(context.module.exports.conectarClientePrincipal({}), false, 'No permite reemplazar el cliente principal');

const markupProduccion = renderFixtureProduccion();
assert.match(markupProduccion.egresos, /data-fin-v5-action="editar"/);
assert.match(markupProduccion.egresos, /data-fin-v5-action="anular"/);
assert.match(markupProduccion.plantillas, /data-fin-v5-action="registrar-recurrente"/);
assert.match(markupProduccion.plantillas, /data-fin-v5-action="editar-plantilla"/);
assert.match(markupProduccion.plantillas, /data-fin-v5-action="desactivar-plantilla"/);
assert.match(markupProduccion.obligaciones, /data-fin-v5-action="registrar-obligacion"/);

testWindow.location = { protocol: 'https:', hostname: 'app.example.com' };
context.document = { getElementById: () => null };
const shellProduccion = renderShellProduccion({
  isConnected: true,
  innerHTML: '',
  querySelector: () => null
});
assert.match(shellProduccion, />PRODUCCIÓN</);
assert.doesNotMatch(shellProduccion, /PRODUCCIÓN · SOLO LECTURA/);
assert.match(shellProduccion, /Sesión principal:/);
assert.match(shellProduccion, /data-fin-v5-action="nuevo"/, 'Producción muestra Nuevo egreso');
assert.doesNotMatch(shellProduccion, /STAGING LOCAL|finV5Login|FINANZAS_V5_STAGING/, 'Producción no muestra login ni configuración de Staging');

async function probarAutorizacionBackend() {
  let operacionesDenegadas = 0;
  const denegado = await autorizarYEjecutarProduccion({
    auth: { getSession: async () => ({ data: { session: { user: { id: 'secretaria' } } }, error: null }) },
    rpc: async () => ({ data: false, error: null })
  }, async () => { operacionesDenegadas += 1; });
  assert.equal(denegado.autorizado, false, 'finance_access=false deniega la operación');
  assert.equal(denegado.motivo, 'acceso');
  assert.equal(operacionesDenegadas, 0, 'No ejecuta la operación si el RPC devuelve false');

  let rpcSinSesion = 0;
  const sinSesion = await autorizarYEjecutarProduccion({
    auth: { getSession: async () => ({ data: { session: null }, error: null }) },
    rpc: async () => { rpcSinSesion += 1; return { data: true, error: null }; }
  });
  assert.equal(sinSesion.motivo, 'sesion');
  assert.equal(rpcSinSesion, 0, 'Sin sesión principal no llama siquiera al RPC');

  let operacionesAutorizadas = 0;
  const autorizado = await autorizarYEjecutarProduccion({
    auth: { getSession: async () => ({ data: { session: { user: { id: 'owner' } } }, error: null }) },
    rpc: async () => ({ data: true, error: null })
  }, async () => { operacionesAutorizadas += 1; });
  assert.equal(autorizado.autorizado, true, 'finance_access=true habilita la operación');
  assert.equal(operacionesAutorizadas, 1, 'Ejecuta la operación sólo después de autorizar');
}

async function probarGuardMutaciones() {
  testWindow.frontendRole = 'owner';
  sesionPrincipal = { user: { id: 'owner' } };
  accesoRpc = true;
  llamadasRpc = 0;
  prepararGuardProduccion({ session: sesionPrincipal, accesoBackend: true });
  assert.equal(await exigirMutacionBackend(), true, 'Owner revalida sesión y backend antes de mutar');
  assert.equal(llamadasRpc, 1, 'Owner autorizado revalida el RPC');

  testWindow.frontendRole = 'admin';
  sesionPrincipal = { user: { id: 'admin' } };
  llamadasRpc = 0;
  prepararGuardProduccion({ session: sesionPrincipal, accesoBackend: true });
  assert.equal(await exigirMutacionBackend(), true, 'Admin revalida sesión y backend antes de mutar');
  assert.equal(llamadasRpc, 1, 'Admin autorizado revalida el RPC');

  testWindow.frontendRole = 'secretaria';
  llamadasRpc = 0;
  prepararGuardProduccion({ session: { user: { id: 'secretaria' } }, accesoBackend: true });
  assert.equal(await exigirMutacionBackend(), false, 'Manipular la UI no evita el guard frontend');
  assert.equal(llamadasRpc, 0, 'El rol frontend no autorizado se frena antes del RPC');

  testWindow.frontendRole = 'owner';
  accesoRpc = false;
  llamadasRpc = 0;
  prepararGuardProduccion({ session: { user: { id: 'owner' } }, accesoBackend: true });
  assert.equal(await exigirMutacionBackend(), false, 'Un permiso backend revocado bloquea la mutación');
  assert.equal(llamadasRpc, 1, 'La mutación revalida el permiso backend vigente');
}

function cuerpoFuncion(nombre) {
  const inicio = originalSource.search(new RegExp(`(?:async )?function ${nombre}\\(`));
  assert.notEqual(inicio, -1, `Existe ${nombre}`);
  const resto = originalSource.slice(inicio + 1);
  const siguiente = resto.search(/\n  (?:async )?function [A-Za-z0-9_]+\(/);
  return originalSource.slice(inicio, siguiente === -1 ? originalSource.length : inicio + 1 + siguiente);
}

['abrirFormulario', 'abrirFormularioPlantilla', 'abrirGeneracionRecurrente', 'abrirRegistroObligacion']
  .forEach((nombre) => assert.match(cuerpoFuncion(nombre), /exigirMutacionPermitida\(\)/, `${nombre} exige contexto autorizado`));
['guardarPlantilla', 'desactivarPlantilla', 'guardarEgresoRecurrente', 'guardarObligacion', 'guardarFormulario', 'anularEgreso']
  .forEach((nombre) => assert.match(cuerpoFuncion(nombre), /await exigirMutacionBackend\(\)/, `${nombre} revalida sesión + RPC antes de escribir`));
['guardarPlantilla', 'desactivarPlantilla', 'guardarFormulario', 'anularEgreso']
  .forEach((nombre) => assert.match(cuerpoFuncion(nombre), /\.eq\('revision'/, `${nombre} mantiene concurrencia id + revision`));

assert.doesNotMatch(originalSource, /\.delete\s*\(/, 'Finanzas 5 no ejecuta DELETE');
assert.match(originalSource, /consultarDuplicadoActivo/, 'Mantiene la prevención de duplicados');

const indiceCrearStaging = originalSource.indexOf('function crearClienteStaging');
const indiceCreateClient = originalSource.indexOf('window.supabase.createClient');
const finCrearStaging = originalSource.indexOf('function esErrorAcceso', indiceCrearStaging);
assert.ok(indiceCrearStaging >= 0 && indiceCreateClient > indiceCrearStaging && indiceCreateClient < finCrearStaging,
  'El único createClient del módulo permanece encerrado en crearClienteStaging');
assert.match(originalSource.slice(indiceCrearStaging, finCrearStaging), /if \(!esEntornoLocal\(\)/,
  'crearClienteStaging rechaza cualquier entorno publicado');
assert.equal(originalSource.split('window.supabase.createClient').length - 1, 1, 'No se agregó un segundo createClient');
assert.doesNotMatch(originalSource, /https:\/\/[^\s'"`]+\.supabase\.co/i, 'El módulo no hardcodea una URL Supabase');
assert.doesNotMatch(originalSource, /sb_(?:publishable|secret)_[A-Za-z0-9_-]{20,}/i, 'El módulo no contiene una key literal');

Promise.all([probarAutorizacionBackend(), probarGuardMutaciones()])
  .then(() => console.log('Producción Finanzas 5 OK: CRUD autorizado, RPC previo, RLS, revisión y bloqueo sin bypass.'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
