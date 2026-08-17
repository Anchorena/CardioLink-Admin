'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const modulePath = path.join(__dirname, '..', 'cardiolink-finanzas-v5.js');
const originalSource = fs.readFileSync(modulePath, 'utf8');
const injectionMarker = '  const api = Object.freeze({';

assert.equal(
  originalSource.split(injectionMarker).length - 1,
  1,
  'El punto de instrumentación Node debe seguir siendo único'
);

// Instrumenta solamente la copia evaluada por Node. El archivo productivo y su
// API pública no se modifican ni reciben globals auxiliares de testing.
const instrumentedSource = originalSource.replace(injectionMarker, `
  globalThis.__finanzasV5SecurityTest = Object.freeze({
    normalizarUrl,
    validarClavePublica,
    asegurarDestinoIndependiente
  });

${injectionMarker}`);

const testWindow = {
  atob: (value) => Buffer.from(value, 'base64').toString('binary'),
  supabaseClient: null
};
const context = vm.createContext({
  module: { exports: {} },
  exports: {},
  window: testWindow,
  URL,
  Intl
});

vm.runInContext(instrumentedSource, context, {
  filename: 'cardiolink-finanzas-v5.js'
});

const {
  normalizarUrl,
  validarClavePublica,
  asegurarDestinoIndependiente
} = context.__finanzasV5SecurityTest;

assert.equal(
  normalizarUrl('https://STAGING.Example.COM'),
  'https://staging.example.com',
  'Normaliza protocolo y hostname'
);
assert.equal(
  normalizarUrl('https://staging.example.com/'),
  'https://staging.example.com',
  'Elimina el trailing slash al normalizar al origin'
);
assert.equal(
  normalizarUrl('https://staging.example.com/rest/v1/'),
  'https://staging.example.com',
  'Normaliza rutas de la API al destino del proyecto'
);
[
  'no-es-una-url',
  'ftp://staging.example.com',
  'https://usuario:clave@staging.example.com',
  'https://staging.example.com?key=valor',
  'https://staging.example.com#fragmento'
].forEach((url) => {
  assert.throws(() => normalizarUrl(url), `Rechaza URL inválida/no permitida: ${url}`);
});

const encodeJwtPart = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwtForRole = (role) => `${encodeJwtPart({ alg: 'HS256', typ: 'JWT' })}.${encodeJwtPart({ role })}.firma-test`;
const publishableKey = 'sb_publishable_test_frontend_123456';
const anonKey = jwtForRole('anon');

assert.equal(validarClavePublica(publishableKey), publishableKey, 'Acepta publishable key frontend');
assert.equal(validarClavePublica(anonKey), anonKey, 'Acepta JWT legacy con role anon');

function assertRejectedWithoutLeak(key, label) {
  let error;
  try {
    validarClavePublica(key);
  } catch (caught) {
    error = caught;
  }
  assert.equal(typeof error?.message, 'string', `${label}: debe rechazar la clave`);
  assert.equal(error.message.includes(key), false, `${label}: el error no debe exponer la clave completa`);
}

const fakeSecretPrefix = ['sb', 'secret'].join('_');
const fakeSecret = [fakeSecretPrefix, 'TEST_ONLY_NOT_A_REAL_KEY'].join('_');
assertRejectedWithoutLeak(fakeSecret, `Rechaza ${fakeSecretPrefix}_`);
assertRejectedWithoutLeak('service_role_valor_privado_que_no_debe_salir', 'Rechaza service_role');
assertRejectedWithoutLeak(jwtForRole('authenticated'), 'Rechaza JWT cuyo role no es anon');

testWindow.supabaseClient = { supabaseUrl: 'https://produccion.example.com' };
assert.doesNotThrow(
  () => asegurarDestinoIndependiente('https://staging.example.com'),
  'Permite un proyecto de Staging diferente de producción'
);
assert.throws(
  () => asegurarDestinoIndependiente('https://produccion.example.com'),
  /coincide con el Supabase principal/,
  'Rechaza exactamente el mismo destino'
);
assert.throws(
  () => asegurarDestinoIndependiente('https://PRODUCCION.EXAMPLE.COM/'),
  /coincide con el Supabase principal/,
  'Rechaza equivalentes con diferencias de case y trailing slash'
);

testWindow.supabaseClient = { rest: { url: 'https://PRODUCCION.EXAMPLE.COM/rest/v1/' } };
assert.throws(
  () => asegurarDestinoIndependiente('https://produccion.example.com/cualquier-ruta'),
  /coincide con el Supabase principal/,
  'Rechaza el mismo origin aunque la representación use una ruta Data API'
);

console.log('Seguridad local Finanzas 5 OK: URL, claves frontend y aislamiento de destino.');
