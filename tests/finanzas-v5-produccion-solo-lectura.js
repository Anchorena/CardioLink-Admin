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
    autorizarYEjecutarLecturaProduccion,
    clientePrincipalInyectado: () => clientePrincipalAutorizado,
    renderFixtureSoloLectura: () => {
      estadoUI.modo = 'produccion-solo-lectura';
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
      estadoUI.modo = 'produccion-solo-lectura';
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

const testWindow = { data: { profesionales: [] } };
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
  autorizarYEjecutarLecturaProduccion,
  clientePrincipalInyectado,
  renderFixtureSoloLectura,
  renderShellProduccion
} = context.__finanzasV5ProduccionTest;

assert.equal(
  resolverModoEjecucion({ local: false, clientePrincipalDisponible: true }),
  'produccion-solo-lectura',
  'Fuera de local usa el cliente principal en modo solo lectura'
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
assert.equal(modoPermiteMutaciones('produccion-solo-lectura'), false, 'Producción bloquea mutaciones');
assert.equal(modoPermiteMutaciones('staging-local'), true, 'Staging Local conserva CRUD');

const clienteInyectado = {
  marker: 'principal',
  auth: { getSession: async () => ({ data: { session: null }, error: null }) },
  rpc: async () => ({ data: false, error: null }),
  from: () => ({})
};
assert.equal(context.module.exports.conectarClientePrincipal(clienteInyectado), true, 'Acepta el cliente principal válido');
assert.equal(clientePrincipalInyectado().marker, 'principal', 'Conserva exactamente el cliente inyectado por app.js');
assert.equal(context.module.exports.conectarClientePrincipal({}), false, 'No permite reemplazar el cliente principal');

const markupSoloLectura = renderFixtureSoloLectura();
Object.entries(markupSoloLectura).forEach(([vista, markup]) => {
  assert.match(markup, /Solo lectura/, `${vista}: comunica el modo solo lectura`);
  assert.doesNotMatch(markup, /data-fin-v5-action="(?:editar|anular|editar-plantilla|desactivar-plantilla|registrar-recurrente|registrar-obligacion)"/,
    `${vista}: no renderiza acciones mutantes`);
});
assert.match(originalSource, /PRODUCCIÓN · SOLO LECTURA/, 'La UI identifica inequívocamente Producción solo lectura');
assert.match(originalSource, /produccion && estadoUI\.session \? `<div class="fin-v5-sesion/, 'Producción muestra sólo la sesión principal');

testWindow.location = { protocol: 'https:', hostname: 'app.example.com' };
context.document = { getElementById: () => null };
const shellProduccion = renderShellProduccion({
  isConnected: true,
  innerHTML: '',
  querySelector: () => null
});
assert.match(shellProduccion, /PRODUCCIÓN · SOLO LECTURA/);
assert.match(shellProduccion, /Sesión principal:/);
assert.doesNotMatch(shellProduccion, /STAGING LOCAL|finV5Login|FINANZAS_V5_STAGING/, 'Producción no muestra login ni configuración de Staging');

async function probarAutorizacionBackend() {
  let rpcDenegado = 0;
  let lecturasDenegadas = 0;
  const clienteDenegado = {
    auth: { getSession: async () => ({ data: { session: { user: { id: 'secretaria' } } }, error: null }) },
    rpc: async (nombre) => {
      rpcDenegado += 1;
      assert.equal(nombre, 'cardiolink_has_finance_access');
      return { data: false, error: null };
    }
  };
  const denegado = await autorizarYEjecutarLecturaProduccion(clienteDenegado, async () => {
    lecturasDenegadas += 1;
  });
  assert.equal(denegado.autorizado, false, 'finance_access=false deniega la carga');
  assert.equal(denegado.motivo, 'acceso');
  assert.equal(rpcDenegado, 1, 'Evalúa el RPC una vez');
  assert.equal(lecturasDenegadas, 0, 'No ejecuta lecturas de tablas si el RPC devuelve false');

  let rpcSinSesion = 0;
  let lecturasSinSesion = 0;
  const sinSesion = await autorizarYEjecutarLecturaProduccion({
    auth: { getSession: async () => ({ data: { session: null }, error: null }) },
    rpc: async () => { rpcSinSesion += 1; return { data: true, error: null }; }
  }, async () => { lecturasSinSesion += 1; });
  assert.equal(sinSesion.motivo, 'sesion');
  assert.equal(rpcSinSesion, 0, 'Sin sesión principal no llama siquiera al RPC');
  assert.equal(lecturasSinSesion, 0, 'Sin sesión no carga tablas');

  let lecturasAutorizadas = 0;
  const clienteOwner = {
    auth: { getSession: async () => ({ data: { session: { user: { id: 'owner' } } }, error: null }) },
    rpc: async () => ({ data: true, error: null })
  };
  const autorizado = await autorizarYEjecutarLecturaProduccion(clienteOwner, async (session) => {
    assert.equal(session.user.id, 'owner');
    lecturasAutorizadas += 1;
  });
  assert.equal(autorizado.autorizado, true, 'finance_access=true habilita las lecturas');
  assert.equal(lecturasAutorizadas, 1, 'Ejecuta la carga sólo después de autorizar');
}

function cuerpoInicial(nombre) {
  const inicio = originalSource.search(new RegExp(`(?:async )?function ${nombre}\\(`));
  assert.notEqual(inicio, -1, `Existe ${nombre}`);
  return originalSource.slice(inicio, inicio + 220);
}

[
  'abrirFormulario',
  'abrirFormularioPlantilla',
  'guardarPlantilla',
  'desactivarPlantilla',
  'abrirGeneracionRecurrente',
  'guardarEgresoRecurrente',
  'abrirRegistroObligacion',
  'guardarObligacion',
  'guardarFormulario',
  'anularEgreso'
].forEach((nombre) => {
  assert.match(cuerpoInicial(nombre), /exigirMutacionPermitida\(\)/, `${nombre} rechaza ejecución en solo lectura`);
});

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

probarAutorizacionBackend()
  .then(() => console.log('Producción solo lectura Finanzas 5 OK: cliente principal, RPC previo, lecturas y mutaciones.'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
