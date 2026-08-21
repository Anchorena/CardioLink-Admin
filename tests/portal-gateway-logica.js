'use strict';

// tests/portal-gateway-logica.js
// supabase/functions/portal-gateway/logica.js es un módulo ESM puro (sin
// Deno ni Supabase) pensado para importarse desde la Edge Function real. Este
// entorno no tiene Deno ni Node disponibles para ejecutar JavaScript de
// verdad (confirmado repetidas veces en esta sesión), así que estas pruebas
// son estáticas: aserciones cuidadosas sobre el código fuente, no ejecución.
// La sintaxis del archivo sí se validó con un parser real (esprima, vía
// `parseModule`, con `?.`/`??` neutralizados porque ese parser no los
// soporta) — ver el reporte de esta tarea.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const logicaPath = path.join(root, 'supabase', 'functions', 'portal-gateway', 'logica.js');
const gatewayPath = path.join(root, 'supabase', 'functions', 'portal-gateway', 'index.ts');
const logicaSource = fs.readFileSync(logicaPath, 'utf8');
const gatewaySource = fs.readFileSync(gatewayPath, 'utf8');

function test(name, run) {
  try {
    run();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

function cuerpoDe(fuente, nombreFuncion) {
  const inicio = fuente.indexOf(`function ${nombreFuncion}`);
  assert.notEqual(inicio, -1, `existe function ${nombreFuncion}`);
  const fin = fuente.indexOf('\n}', inicio);
  assert.notEqual(fin, -1, `${nombreFuncion} tiene cierre en columna 0`);
  return fuente.slice(inicio, fin);
}

// -----------------------------------------------------------------------
// logica.js: es un módulo ESM real (no CommonJS), tal como necesita Deno.
// -----------------------------------------------------------------------

test('logica.js es un módulo ESM puro, sin dependencias de Deno/Supabase', () => {
  assert.match(logicaSource, /^export function normalizarDni/m);
  assert.match(logicaSource, /^export function validarAlta/m);
  assert.match(logicaSource, /^export function validarSolicitud/m);
  assert.match(logicaSource, /^export function construirNombreCompleto/m);
  assert.match(logicaSource, /^export function generarIdPaciente/m);
  assert.doesNotMatch(logicaSource, /module\.exports/);
  assert.doesNotMatch(logicaSource, /\bDeno\./);
  assert.doesNotMatch(logicaSource, /createClient|supabase-js/);
});

test('normalizarDni deja sólo dígitos', () => {
  const cuerpo = cuerpoDe(logicaSource, 'normalizarDni');
  assert.match(cuerpo, /replace\(\/\\D\/g, ''\)/);
});

test('validarDni exige entre 6 y 9 dígitos (LIMITES.dniMinDigitos/dniMaxDigitos)', () => {
  assert.match(logicaSource, /dniMinDigitos: 6/);
  assert.match(logicaSource, /dniMaxDigitos: 9/);
  const cuerpo = cuerpoDe(logicaSource, 'validarDni');
  assert.match(cuerpo, /dni\.length < LIMITES\.dniMinDigitos \|\| dni\.length > LIMITES\.dniMaxDigitos/);
});

test('fuenteValida sólo acepta qr/whatsapp/web y por defecto cae en web', () => {
  assert.match(logicaSource, /FUENTES_VALIDAS = Object\.freeze\(\['qr', 'whatsapp', 'web'\]\)/);
  const cuerpo = cuerpoDe(logicaSource, 'fuenteValida');
  assert.match(cuerpo, /FUENTES_VALIDAS\.includes\(v\) \? v : 'web'/);
});

test('validarAlta exige nombre, apellido, DNI válido, fecha de nacimiento y teléfono; email es opcional pero se valida si viene', () => {
  const cuerpo = cuerpoDe(logicaSource, 'validarAlta');
  assert.match(cuerpo, /if \(!dniResultado\.valido\) errores\.push/);
  assert.match(cuerpo, /if \(!nombre\) errores\.push\('Falta el nombre\.'\)/);
  assert.match(cuerpo, /if \(!apellido\) errores\.push\('Falta el apellido\.'\)/);
  assert.match(cuerpo, /if \(!\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/\.test\(fechaNacimiento\)\) errores\.push/);
  assert.match(cuerpo, /if \(!telefono\) errores\.push\('Falta el teléfono\.'\)/);
  assert.match(cuerpo, /if \(email && !\/\^\[\^\\s@\]\+@\[\^\\s@\]\+\\\.\[\^\\s@\]\+\$\/\.test\(email\)\)/);
  assert.doesNotMatch(cuerpo, /if \(!email\) errores\.push/, 'el email nunca es obligatorio');
  assert.match(cuerpo, /if \(errores\.length\) return \{ valido: false, errores \}/);
});

test('validarAlta nunca acepta ni devuelve un id de paciente', () => {
  const cuerpo = cuerpoDe(logicaSource, 'validarAlta');
  assert.doesNotMatch(cuerpo, /input\??\.\s*id\b/);
  assert.doesNotMatch(cuerpo, /\bpatient_id\b/);
});

test('construirNombreCompleto arma "Apellido Nombre" recortado y sin dobles espacios', () => {
  const cuerpo = cuerpoDe(logicaSource, 'construirNombreCompleto');
  assert.match(cuerpo, /\$\{texto\(apellido, LIMITES\.apellido\)\} \$\{texto\(nombre, LIMITES\.nombre\)\}/);
  assert.match(cuerpo, /\.trim\(\)\.replace\(\/\\s\+\/g, ' '\)/);
});

test('validarSolicitud exige DNI válido, prestación y cobertura de la solicitud; nunca acepta patient_id del cliente', () => {
  const cuerpo = cuerpoDe(logicaSource, 'validarSolicitud');
  assert.match(cuerpo, /if \(!dniResultado\.valido\) errores\.push/);
  assert.match(cuerpo, /if \(!prestacion\) errores\.push\('Falta la prestación\.'\)/);
  assert.match(cuerpo, /if \(!COBERTURAS_VALIDAS\.includes\(cobertura\)\) errores\.push\('Elegí una cobertura válida para esta solicitud\.'\)/);
  assert.doesNotMatch(cuerpo, /\bpatient_id\b/);
  assert.match(cuerpo, /const source = fuenteValida\(input\?\.source\)/);
  assert.match(cuerpo, /datos: \{ dni: dniResultado\.dni, prestacion, cobertura, source \}/);
});

test('la cobertura de la solicitud usa la MISMA lista cerrada COBERTURAS_VALIDAS que el alta (una sola lista, no dos)', () => {
  const inicioAlta = logicaSource.indexOf('export function validarAlta');
  const inicioSolicitud = logicaSource.indexOf('export function validarSolicitud');
  const cuerpoAlta = logicaSource.slice(inicioAlta, logicaSource.indexOf('\n}', inicioAlta));
  const cuerpoSolicitud = logicaSource.slice(inicioSolicitud, logicaSource.indexOf('\n}', inicioSolicitud));
  assert.match(cuerpoAlta, /COBERTURAS_VALIDAS\.includes\(coberturaHabitual\)/);
  assert.match(cuerpoSolicitud, /COBERTURAS_VALIDAS\.includes\(cobertura\)/);
  // No hay una segunda constante tipo COBERTURAS_SOLICITUD/COBERTURAS_TURNO.
  assert.doesNotMatch(logicaSource, /COBERTURAS_SOLICITUD|COBERTURAS_TURNO/);
});

test('validarSolicitud ya no pide ni acepta teléfono, profesional ni mensaje', () => {
  const cuerpo = cuerpoDe(logicaSource, 'validarSolicitud');
  assert.doesNotMatch(cuerpo, /telefono/);
  assert.doesNotMatch(cuerpo, /profesionalId|profesionalNombre/);
  assert.doesNotMatch(cuerpo, /mensaje/);
});

test('validarAlta exige una cobertura de la lista cerrada COBERTURAS_VALIDAS (select, no texto libre)', () => {
  assert.match(logicaSource, /COBERTURAS_VALIDAS = Object\.freeze\(\[\s*'Particular', 'OSDE', 'Swiss Medical', 'Medicus', 'Galeno', 'IOMA', 'PAMI', 'Sancor', 'Otra', 'No sé \/ consultar'\s*\]\)/);
  assert.match(logicaSource, /'Particular'/);
  assert.match(logicaSource, /'No sé \/ consultar'/);
  const cuerpo = cuerpoDe(logicaSource, 'validarAlta');
  assert.match(cuerpo, /if \(!COBERTURAS_VALIDAS\.includes\(coberturaHabitual\)\) errores\.push\('Elegí una cobertura válida\.'\)/);
});

test('generarIdPaciente usa el prefijo pac_ y exige una fuente de aleatoriedad criptográfica', () => {
  const cuerpo = cuerpoDe(logicaSource, 'generarIdPaciente');
  assert.match(cuerpo, /'pac_' \+ String\(fuente\(\)\)\.replace\(\/-\/g, ''\)/);
  assert.match(cuerpo, /Se requiere una fuente de aleatoriedad criptográfica/);
});

// -----------------------------------------------------------------------
// La Edge Function en sí (index.ts): flujo, PII, service_role, no-atención.
// -----------------------------------------------------------------------

test('index.ts guarda service_role sólo como variable de entorno server-side, nunca como literal', () => {
  assert.match(gatewaySource, /Deno\.env\.get\('SUPABASE_SERVICE_ROLE_KEY'\)/);
  assert.doesNotMatch(gatewaySource, /service_role.{0,40}['"]ey[A-Za-z0-9_-]{10,}/, 'no hay ninguna clave literal de service_role');
  assert.doesNotMatch(gatewaySource, /eyJ[A-Za-z0-9_-]{20,}/, 'no hay ningún JWT/clave hardcodeado');
});

test('check-dni nunca devuelve datos del paciente: sólo { ok, existe }', () => {
  const cuerpo = cuerpoDe(gatewaySource, 'manejarCheckDni');
  assert.match(cuerpo, /jsonResponse\(\{ ok: true, existe: !!existente \}\)/);
  assert.doesNotMatch(cuerpo, /nombre_completo|telefono|email|cobertura_habitual|fecha_nacimiento|patientId|patient_id/i);
});

test('el registro busca por DNI antes de insertar y reutiliza el paciente existente ante duplicado/carrera (código 23505)', () => {
  const cuerpo = cuerpoDe(gatewaySource, 'manejarRegistro');
  const posBusqueda = cuerpo.indexOf('buscarPacientePorDni');
  const posInsert = cuerpo.indexOf(".from('cardiolink_pacientes').insert(fila)");
  assert.notEqual(posBusqueda, -1);
  assert.notEqual(posInsert, -1);
  assert.ok(posBusqueda < posInsert, 'se busca el paciente por DNI antes de insertar uno nuevo');
  assert.match(cuerpo, /insercion\.error\.code === '23505'/);
  assert.match(cuerpo, /jsonResponse\(\{ ok: true, existente: true \}\)/);
});

test('el alta crea el paciente directo en cardiolink_pacientes, sin tabla de pre-pacientes ni aprobación administrativa', () => {
  const cuerpo = cuerpoDe(gatewaySource, 'manejarRegistro');
  // La única tabla de pacientes que toca este flujo es la real: aparece en
  // el listado de Pacientes del Admin porque es la misma tabla, sin
  // sincronizar ni duplicar un modelo aparte.
  assert.match(cuerpo, /\.from\('cardiolink_pacientes'\)\.insert\(fila\)/);
  assert.doesNotMatch(gatewaySource, /pre[-_]?pacientes|pacientes_pendientes|solicitudes_alta|pending_patients/i);
  // No hay ningún paso de aprobación/revisión entre validar y crear: el
  // insert corre en la misma llamada, sin marcar un estado "pendiente".
  assert.doesNotMatch(cuerpo, /pendiente|aprobacion|aprobación|requiere_revision/i);
});

test('el alta nunca devuelve el id del paciente creado', () => {
  const cuerpo = cuerpoDe(gatewaySource, 'manejarRegistro');
  assert.doesNotMatch(cuerpo, /jsonResponse\(\{[^}]*\bid\b[^}]*\}\)/);
});

test('la solicitud de turno crea una fila en cardiolink_appointment_requests con status new, source y la cobertura de la solicitud', () => {
  const cuerpo = cuerpoDe(gatewaySource, 'manejarSolicitud');
  assert.match(cuerpo, /\.from\('cardiolink_appointment_requests'\)\.insert\(\{/);
  assert.match(cuerpo, /status: 'new'/);
  assert.match(cuerpo, /source: datos\.source/);
  assert.match(cuerpo, /patient_id: paciente\.id/);
  assert.match(cuerpo, /requested_coverage: datos\.cobertura/);
});

test('la cobertura de la solicitud nunca sobrescribe cardiolink_pacientes.cobertura_habitual: manejarSolicitud no escribe en cardiolink_pacientes', () => {
  const cuerpo = cuerpoDe(gatewaySource, 'manejarSolicitud');
  assert.doesNotMatch(cuerpo, /\.from\('cardiolink_pacientes'\)\.(update|insert)/);
  assert.doesNotMatch(cuerpo, /cobertura_habitual/);
});

test('la solicitud de turno resuelve el paciente por DNI en el servidor, nunca confía en un id del cliente', () => {
  const cuerpo = cuerpoDe(gatewaySource, 'manejarSolicitud');
  assert.match(cuerpo, /const paciente = await buscarPacienteParaSolicitud\(admin, datos\.dni\)/);
  assert.doesNotMatch(cuerpo, /body\.patient_id|body\.patientId|datos\.patientId/);
});

test('la solicitud de turno nunca pide teléfono al cliente: lo resuelve desde el paciente ya guardado', () => {
  const cuerpo = cuerpoDe(gatewaySource, 'manejarSolicitud');
  assert.match(cuerpo, /contact_phone: paciente\.telefono/);
  assert.doesNotMatch(cuerpo, /datos\.telefono|body\.telefono/);
  assert.match(cuerpo, /if \(!paciente\.telefono\)/, 'rechaza con un mensaje claro si el paciente no tiene teléfono guardado');
});

test('buscarPacienteParaSolicitud trae id y teléfono desde cardiolink_pacientes por dni_normalizado', () => {
  const cuerpo = cuerpoDe(gatewaySource, 'buscarPacienteParaSolicitud');
  assert.match(cuerpo, /\.from\('cardiolink_pacientes'\)/);
  assert.match(cuerpo, /\.select\('id, telefono'\)/);
  assert.match(cuerpo, /\.eq\('dni_normalizado', dniNormalizado\)/);
});

test('la solicitud de turno nunca permite elegir profesional: siempre queda null', () => {
  const cuerpo = cuerpoDe(gatewaySource, 'manejarSolicitud');
  assert.match(cuerpo, /requested_professional_id: null/);
  assert.match(cuerpo, /requested_professional_name: null/);
  assert.doesNotMatch(cuerpo, /datos\.profesionalId|datos\.profesionalNombre|body\.profesionalId/);
});

test('la solicitud de turno nunca acepta texto libre público: message siempre null', () => {
  const cuerpo = cuerpoDe(gatewaySource, 'manejarSolicitud');
  assert.match(cuerpo, /message: null/);
  assert.doesNotMatch(cuerpo, /datos\.mensaje|body\.mensaje/);
});

test('la prestación de la solicitud se valida contra un catálogo cerrado (select/tabulado, no texto libre)', () => {
  const cuerpo = cuerpoDe(gatewaySource, 'manejarSolicitud');
  assert.match(cuerpo, /if \(!PRESTACIONES_PUBLICAS_V1\.includes\(datos\.prestacion\)\)/);
});

test('la solicitud de turno tiene una protección básica anti doble-envío (ventana de 2 minutos por paciente)', () => {
  const cuerpo = cuerpoDe(gatewaySource, 'manejarSolicitud');
  assert.match(cuerpo, /Date\.now\(\) - 2 \* 60 \* 1000/);
  assert.match(cuerpo, /\.eq\('status', 'new'\)/);
  assert.match(cuerpo, /duplicada: true/);
});

test('el gateway nunca crea una atención ni marca appointment_assigned', () => {
  assert.doesNotMatch(gatewaySource, /cardiolink_atenciones/);
  assert.doesNotMatch(gatewaySource, /crearAtencionDesdeFormulario|guardarAtencion\s*\(/);
  assert.doesNotMatch(gatewaySource, /appointment_assigned/);
  assert.doesNotMatch(logicaSource, /cardiolink_atenciones|appointment_assigned/);
});

test('el catálogo de prestaciones públicas V1 está aislado y coincide exactamente con portal/contenido-publico.js', () => {
  assert.match(gatewaySource, /PRESTACIONES_PUBLICAS_V1 = Object\.freeze\(\[/);
  assert.doesNotMatch(gatewaySource, /arancel|configFinanzas|cardiolink_finance/i);
  const contenidoPath = path.join(root, 'portal', 'contenido-publico.js');
  const contenidoSource = fs.readFileSync(contenidoPath, 'utf8');
  const extraerLista = (fuente, marcador) => {
    const inicio = fuente.indexOf(marcador);
    assert.notEqual(inicio, -1, `existe ${marcador}`);
    const finLista = fuente.indexOf(']', inicio);
    const bloque = fuente.slice(inicio, finLista);
    return Array.from(bloque.matchAll(/'([^']+)'/g)).map((m) => m[1]);
  };
  const nombresGateway = extraerLista(gatewaySource, 'PRESTACIONES_PUBLICAS_V1 = Object.freeze([');
  // Sólo el bloque de PRESTACIONES: contenido-publico.js también tiene
  // "nombre: '...'" dentro de PROFESIONALES, que no debe mezclarse acá.
  const inicioPrestaciones = contenidoSource.indexOf('const PRESTACIONES = Object.freeze([');
  assert.notEqual(inicioPrestaciones, -1, 'existe PRESTACIONES en contenido-publico.js');
  const finPrestaciones = contenidoSource.indexOf(']);', inicioPrestaciones);
  const bloquePrestaciones = contenidoSource.slice(inicioPrestaciones, finPrestaciones);
  const nombresContenido = Array.from(bloquePrestaciones.matchAll(/nombre: '([^']+)'/g)).map((m) => m[1]);
  assert.deepEqual(nombresGateway, nombresContenido, 'las prestaciones del gateway y del contenido público deben coincidir en nombre y orden');
});

test('COBERTURAS_VALIDAS (logica.js) coincide exactamente con portal/contenido-publico.js → coberturas', () => {
  const contenidoPath = path.join(root, 'portal', 'contenido-publico.js');
  const contenidoSource = fs.readFileSync(contenidoPath, 'utf8');
  const extraerPlana = (fuente, marcador, cierre) => {
    const inicio = fuente.indexOf(marcador);
    assert.notEqual(inicio, -1, `existe ${marcador}`);
    const fin = fuente.indexOf(cierre, inicio);
    const bloque = fuente.slice(inicio, fin);
    return Array.from(bloque.matchAll(/'([^']+)'/g)).map((m) => m[1]);
  };
  const coberturasLogica = extraerPlana(logicaSource, 'COBERTURAS_VALIDAS = Object.freeze([', ']);');
  const coberturasContenido = extraerPlana(contenidoSource, 'const COBERTURAS = Object.freeze([', ']);');
  assert.deepEqual(coberturasLogica, coberturasContenido, 'las coberturas del backend y del contenido público deben coincidir en nombre y orden');
  assert.ok(coberturasLogica.includes('Particular'));
  assert.ok(coberturasLogica.includes('No sé / consultar'));
});

test('el gateway sólo usa service_role: no expone anon/publishable a este archivo (no lo necesita, bypasea RLS por su cuenta)', () => {
  assert.doesNotMatch(gatewaySource, /publishableKey|anonKey|SUPABASE_ANON_KEY/);
});

console.log('Portal público — lógica del gateway: OK');
