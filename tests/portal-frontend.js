'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const modulePath = path.join(root, 'portal', 'portal.js');
const moduleSource = fs.readFileSync(modulePath, 'utf8');
const indexPath = path.join(root, 'portal', 'index.html');
const indexSource = fs.readFileSync(indexPath, 'utf8');
const contenidoPath = path.join(root, 'portal', 'contenido-publico.js');
const contenidoSource = fs.readFileSync(contenidoPath, 'utf8');
const portalCssPath = path.join(root, 'portal', 'portal.css');
const portalCssSource = fs.readFileSync(portalCssPath, 'utf8');

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
// Exposición global (mismo bug/fix que ya pasó con Solicitudes de turno:
// probarlo de entrada para no repetirlo).
// -----------------------------------------------------------------------

test('el factory expone window.CardioLinkPortal con la API completa', () => {
  delete require.cache[require.resolve(modulePath)];
  const mod = require(modulePath);
  assert.equal(typeof mod.obtenerSourceDesdeUrl, 'function');
  assert.equal(typeof mod.dniClienteValido, 'function');
  assert.equal(typeof mod.soloDigitos, 'function');
  assert.equal(typeof mod.esEntornoLocal, 'function');
  assert.equal(typeof mod.gatewayUrl, 'function');
  assert.equal(typeof mod.turnstileSitekey, 'function');
  assert.equal(typeof mod.install, 'function');
  assert.match(moduleSource, /if \(root && !root\.CardioLinkPortal\) root\.CardioLinkPortal = api;/);
});

// -----------------------------------------------------------------------
// Staging Local del gateway: sólo localhost/127.0.0.1/::1 usa
// automáticamente el gateway de Staging; fuera de esos orígenes usa
// Producción (separada/configurable), nunca Staging por accidente.
// -----------------------------------------------------------------------

// Mismo truco que ya se usó para cardiolink-solicitudes-turno.js: el mock
// de window NUNCA lleva una propiedad .document (root.document, dentro del
// factory, controla si se llama a install()/render()/document.getElementById
// contra un DOM que no existe acá). hayNavegador() sigue viendo
// window/document como definidos porque se setea un global.document aparte.
function conVentanaFalsa(hostname, run) {
  delete require.cache[require.resolve(modulePath)];
  global.window = { location: { hostname, search: '' } };
  global.document = {};
  try {
    const mod = require(modulePath);
    run(mod);
  } finally {
    delete global.window;
    delete global.document;
  }
}

test('esEntornoLocal reconoce localhost, 127.0.0.1 y ::1 (con y sin corchetes)', () => {
  ['localhost', '127.0.0.1', '::1', '[::1]'].forEach((hostname) => {
    conVentanaFalsa(hostname, (mod) => {
      assert.equal(mod.esEntornoLocal(), true, `${hostname} debe ser local`);
    });
  });
});

test('esEntornoLocal es false fuera de un origen local (dominio publicado)', () => {
  ['consultoriomedicorm.com.ar', 'www.ejemplo.com', 'miconsultorio.github.io', ''].forEach((hostname) => {
    conVentanaFalsa(hostname, (mod) => {
      assert.equal(mod.esEntornoLocal(), false, `${hostname} no debe ser local`);
    });
  });
});

test('gatewayUrl usa automáticamente Staging en local, sin configuración manual', () => {
  conVentanaFalsa('localhost', (mod) => {
    assert.equal(mod.gatewayUrl(), 'https://yslhwdlzdknhskawqrtv.supabase.co/functions/v1/portal-gateway');
  });
  conVentanaFalsa('127.0.0.1', (mod) => {
    assert.equal(mod.gatewayUrl(), 'https://yslhwdlzdknhskawqrtv.supabase.co/functions/v1/portal-gateway');
  });
});

test('gatewayUrl nunca usa Staging fuera de un origen local, ni siquiera con el override seteado', () => {
  conVentanaFalsa('www.consultoriomedicorm.com.ar', (mod) => {
    assert.notEqual(mod.gatewayUrl(), 'https://yslhwdlzdknhskawqrtv.supabase.co/functions/v1/portal-gateway');
  });
});

test('en local, gatewayUrl ignora window.CARDIOLINK_PORTAL_GATEWAY_URL: Staging es automático, no una opción manual', () => {
  delete require.cache[require.resolve(modulePath)];
  global.window = { location: { hostname: 'localhost', search: '' }, CARDIOLINK_PORTAL_GATEWAY_URL: 'https://otra-cosa.example.com/gateway' };
  global.document = {};
  try {
    const mod = require(modulePath);
    assert.equal(mod.gatewayUrl(), 'https://yslhwdlzdknhskawqrtv.supabase.co/functions/v1/portal-gateway');
  } finally {
    delete global.window;
    delete global.document;
  }
});

test('fuera de local, el override window.CARDIOLINK_PORTAL_GATEWAY_URL sigue funcionando para Producción', () => {
  delete require.cache[require.resolve(modulePath)];
  global.window = { location: { hostname: 'www.consultoriomedicorm.com.ar', search: '' }, CARDIOLINK_PORTAL_GATEWAY_URL: 'https://real-produccion.example.com/gateway' };
  global.document = {};
  try {
    const mod = require(modulePath);
    assert.equal(mod.gatewayUrl(), 'https://real-produccion.example.com/gateway');
  } finally {
    delete global.window;
    delete global.document;
  }
});

test('turnstileSitekey usa la sitekey de test INVISIBLE de Cloudflare en local (BB, no AA que es la del widget visible), incluso con el override seteado', () => {
  conVentanaFalsa('localhost', (mod) => {
    assert.equal(mod.turnstileSitekey(), '1x00000000000000000000BB');
  });
  delete require.cache[require.resolve(modulePath)];
  global.window = { location: { hostname: 'localhost', search: '' }, CARDIOLINK_TURNSTILE_SITEKEY: 'otra-sitekey-cualquiera' };
  global.document = {};
  try {
    const mod = require(modulePath);
    assert.equal(mod.turnstileSitekey(), '1x00000000000000000000BB', 'en local, la QA sitekey es automática, no una opción manual');
  } finally {
    delete global.window;
    delete global.document;
  }
});

test('turnstileSitekey nunca usa la sitekey de QA fuera de un origen local; el override configura la de Producción', () => {
  conVentanaFalsa('www.consultoriomedicorm.com.ar', (mod) => {
    assert.notEqual(mod.turnstileSitekey(), '1x00000000000000000000BB');
  });
  delete require.cache[require.resolve(modulePath)];
  global.window = { location: { hostname: 'www.consultoriomedicorm.com.ar', search: '' }, CARDIOLINK_TURNSTILE_SITEKEY: 'sitekey-real-de-produccion' };
  global.document = {};
  try {
    const mod = require(modulePath);
    assert.equal(mod.turnstileSitekey(), 'sitekey-real-de-produccion');
  } finally {
    delete global.window;
    delete global.document;
  }
});

test('render() muestra el badge STAGING LOCAL sólo cuando esEntornoLocal() es true', () => {
  const inicio = moduleSource.indexOf('function render()');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  assert.match(cuerpo, /esEntornoLocal\(\) \? '<div class="portal-staging-badge">STAGING LOCAL<\/div>' : ''/);
});

test('gatewayUrl es la única pieza modificada: no toca el flujo DNI/alta/solicitud/cobertura/prestaciones', () => {
  const inicio = moduleSource.indexOf('function gatewayUrl');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  assert.doesNotMatch(cuerpo, /dni|cobertura|prestacion|alta|solicitud/i);
});

// -----------------------------------------------------------------------
// Turnstile: widget invisible en los tres formularios protegidos, token
// obtenido ANTES de render() (que destruye el contenedor ya montado), y
// agregado al payload de las tres llamadas al gateway. Sin cambios
// visuales: size 'invisible', sin casilla ni texto agregado a la UI.
// -----------------------------------------------------------------------

test('los tres formularios protegidos tienen un contenedor de Turnstile, invisible y sin texto visible agregado', () => {
  assert.equal((moduleSource.match(/data-turnstile-container/g) || []).length, 3);
  assert.match(moduleSource, /<div id="turnstileDni" data-turnstile-container><\/div>/);
  assert.match(moduleSource, /<div id="turnstileAlta" data-turnstile-container><\/div>/);
  assert.match(moduleSource, /<div id="turnstileSolicitud" data-turnstile-container><\/div>/);
});

test('el widget se monta como invisible y con ejecución manual (no dispara el desafío solo al montar)', () => {
  const inicio = moduleSource.indexOf('function montarTurnstileSiCorresponde');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  assert.match(cuerpo, /window\.turnstile\.render\(contenedor, \{/, 'el widget se renderiza explícitamente, no por auto-init');
  assert.match(cuerpo, /sitekey: turnstileSitekey\(\)/);
  assert.match(cuerpo, /size: 'invisible'/);
  assert.match(cuerpo, /execution: 'execute'/);
});

test('ningún contenedor de Turnstile usa la clase cf-turnstile: el render es siempre explícito, nunca por auto-init de Cloudflare', () => {
  assert.doesNotMatch(moduleSource, /cf-turnstile/);
});

test('obtenerTokenTurnstile resetea el widget al resolver (con token o con error): nunca reutiliza el mismo token', () => {
  const inicio = moduleSource.indexOf('function obtenerTokenTurnstile');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  const posFinalizarDef = cuerpo.indexOf('const finalizar = (fn, valor) => {');
  const posReset = cuerpo.indexOf('window.turnstile.reset(widgetId)');
  const posFnLlamado = cuerpo.indexOf('fn(valor);');
  assert.notEqual(posFinalizarDef, -1);
  assert.notEqual(posReset, -1);
  assert.notEqual(posFnLlamado, -1);
  assert.ok(posFinalizarDef < posReset && posReset < posFnLlamado, 'reset() corre dentro de finalizar(), antes de resolver/rechazar la promesa');
  // finalizar() es el único callback pasado tanto a execute() como al
  // timeout: se usa para las tres rutas de salida (token, error-callback,
  // timeout), así que las tres resetean el widget.
  assert.match(cuerpo, /callback: \(token\) => finalizar\(resolve, token\)/);
  assert.match(cuerpo, /'error-callback': \(\) => finalizar\(reject,/);
  assert.match(cuerpo, /window\.setTimeout\(\(\) => finalizar\(reject,/);
});

test('el contenedor de Turnstile no depende de display:none: portal.css lo deja en el layout normal', () => {
  assert.match(portalCssSource, /\[data-turnstile-container\]/);
  const inicio = portalCssSource.indexOf('[data-turnstile-container]');
  const cuerpo = portalCssSource.slice(inicio, portalCssSource.indexOf('}', inicio));
  assert.doesNotMatch(cuerpo, /display:\s*none/);
  assert.doesNotMatch(cuerpo, /visibility:\s*hidden/);
});

test('el token se pide ANTES de estado.cargando/render() en los tres submit, porque render() destruye el contenedor ya montado', () => {
  [
    ['async function onSubmitDni', 'estado.cargando = true'],
    ['async function onSubmitAlta', 'estado.cargando = true'],
    ['async function onSubmitSolicitud', 'estado.cargando = true']
  ].forEach(([marcadorFuncion, marcadorCargando]) => {
    const inicio = moduleSource.indexOf(marcadorFuncion);
    assert.notEqual(inicio, -1, `existe ${marcadorFuncion}`);
    const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
    const posToken = cuerpo.indexOf('await obtenerTokenTurnstile()');
    const posCargando = cuerpo.indexOf(marcadorCargando);
    assert.notEqual(posToken, -1, `${marcadorFuncion} pide el token`);
    assert.notEqual(posCargando, -1);
    assert.ok(posToken < posCargando, `${marcadorFuncion}: el token se pide antes de estado.cargando`);
  });
});

test('el token viaja en el payload de check-dni, registro y solicitud-turno', () => {
  const inicioDni = moduleSource.indexOf('async function onSubmitDni');
  const cuerpoDni = moduleSource.slice(inicioDni, moduleSource.indexOf('\n  }', inicioDni));
  assert.match(cuerpoDni, /consultarDni\(estado\.dni, turnstileToken\)/);

  const inicioAlta = moduleSource.indexOf('async function onSubmitAlta');
  const cuerpoAlta = moduleSource.slice(inicioAlta, moduleSource.indexOf('\n  }', inicioAlta));
  assert.match(cuerpoAlta, /turnstileToken\n?\s*\};/, 'el objeto datos del alta incluye turnstileToken');

  const inicioSolicitud = moduleSource.indexOf('async function onSubmitSolicitud');
  const cuerpoSolicitud = moduleSource.slice(inicioSolicitud, moduleSource.indexOf('\n  }', inicioSolicitud));
  assert.match(cuerpoSolicitud, /turnstileToken\n?\s*\};/, 'el objeto datos de la solicitud incluye turnstileToken');
});

test('sin Turnstile cargado, obtenerTokenTurnstile rechaza con un mensaje claro en vez de dejar pasar el envío', () => {
  const inicio = moduleSource.indexOf('function obtenerTokenTurnstile');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  assert.match(cuerpo, /if \(!turnstileDisponible\(\) \|\| turnstileWidget\.widgetId === null\)/);
  assert.match(cuerpo, /reject\(new Error\('No se pudo cargar la verificación anti-bots/);
});

test('el script de Turnstile se carga en portal/index.html antes de portal.js', () => {
  assert.match(indexSource, /<script src="https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js" async defer><\/script>/);
  const posTurnstile = indexSource.indexOf('challenges.cloudflare.com/turnstile');
  const posPortalJs = indexSource.indexOf('<script src="portal.js');
  assert.ok(posTurnstile < posPortalJs);
});

// -----------------------------------------------------------------------
// obtenerSourceDesdeUrl: ?source=qr|whatsapp|web, con qr/whatsapp/web como
// únicas fuentes válidas y "web" como default seguro.
// -----------------------------------------------------------------------

test('obtenerSourceDesdeUrl reconoce qr, whatsapp y web', () => {
  const mod = require(modulePath);
  assert.equal(mod.obtenerSourceDesdeUrl('?source=qr'), 'qr');
  assert.equal(mod.obtenerSourceDesdeUrl('?source=whatsapp'), 'whatsapp');
  assert.equal(mod.obtenerSourceDesdeUrl('?source=web'), 'web');
});

test('obtenerSourceDesdeUrl es tolerante a mayúsculas y cae en "web" ante cualquier otro valor o ausencia', () => {
  const mod = require(modulePath);
  assert.equal(mod.obtenerSourceDesdeUrl('?source=QR'), 'qr');
  assert.equal(mod.obtenerSourceDesdeUrl('?source=algo-inventado'), 'web');
  assert.equal(mod.obtenerSourceDesdeUrl(''), 'web');
  assert.equal(mod.obtenerSourceDesdeUrl(undefined), 'web');
  assert.equal(mod.obtenerSourceDesdeUrl('no es ni siquiera un query string'), 'web');
});

test('obtenerSourceDesdeUrl nunca conserva datos personales: sólo lee el parámetro source', () => {
  const mod = require(modulePath);
  // Un DNI o teléfono puesto por error en la URL no debe filtrarse a ningún
  // lado ni influir en el resultado: sólo importa "source".
  assert.equal(mod.obtenerSourceDesdeUrl('?source=qr&dni=12345678&telefono=1122334455'), 'qr');
});

// -----------------------------------------------------------------------
// dniClienteValido / soloDigitos: validación liviana de UX, no autoritativa.
// -----------------------------------------------------------------------

test('soloDigitos deja sólo dígitos', () => {
  const mod = require(modulePath);
  assert.equal(mod.soloDigitos('12.345.678'), '12345678');
  assert.equal(mod.soloDigitos('  40123456  '), '40123456');
  assert.equal(mod.soloDigitos(null), '');
});

test('dniClienteValido exige entre 6 y 9 dígitos, ignorando puntos/espacios', () => {
  const mod = require(modulePath);
  assert.equal(mod.dniClienteValido('12345678'), true);
  assert.equal(mod.dniClienteValido('12.345.678'), true);
  assert.equal(mod.dniClienteValido('123'), false);
  assert.equal(mod.dniClienteValido('1234567890'), false);
  assert.equal(mod.dniClienteValido(''), false);
});

// -----------------------------------------------------------------------
// Estructura: el portal nunca toca Supabase directamente, nunca referencia
// service_role, no crea atención, y el flujo no muestra agenda/horarios.
// -----------------------------------------------------------------------

test('portal.js nunca llama a Supabase directamente: sólo fetch() contra el gateway', () => {
  assert.doesNotMatch(moduleSource, /createClient|supabase-js|\.from\(['"]cardiolink_/);
  assert.match(moduleSource, /fetch\(gatewayUrl\(\)/);
});

test('portal.js nunca referencia service_role ni ninguna clave', () => {
  assert.doesNotMatch(moduleSource, /service_role/i);
  assert.doesNotMatch(moduleSource, /eyJ[A-Za-z0-9_-]{20,}/);
});

test('el flujo de la solicitud de turno nunca muestra horarios/agenda ni crea una atención', () => {
  // No se prohíbe la palabra "horario" (el texto legítimamente dice "no se
  // reserva horario todavía"): se prohíben elementos reales de selección de
  // franja horaria/calendario.
  assert.doesNotMatch(moduleSource, /type="time"/);
  assert.doesNotMatch(moduleSource, /horariosDisponibles|franjaHoraria|calendario/);
  // El único input type="date" de todo el portal es fecha de nacimiento del
  // alta, no un selector de turno/horario.
  assert.equal((moduleSource.match(/type="date"/g) || []).length, 1);
  assert.match(moduleSource, /name="fechaNacimiento" type="date"/);
  assert.match(moduleSource, /No se reserva horario todavía/);
  assert.doesNotMatch(moduleSource, /cardiolink_atenciones|crearAtencionDesdeFormulario|guardarAtencion\s*\(/);
  assert.doesNotMatch(moduleSource, /appointment_assigned/);
});

test('la pantalla de paciente existente no expone datos personales, sólo el mensaje fijo', () => {
  const inicio = moduleSource.indexOf('function renderPasoYaRegistrado');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  assert.match(cuerpo, /Ya estás registrado en CardioLink\./);
  assert.doesNotMatch(cuerpo, /estado\.(nombre|telefono|email|dni|cobertura)/);
});

test('el formulario de alta pide exactamente los campos pedidos, el teléfono es obligatorio y la cobertura es un select cerrado (no texto libre)', () => {
  const inicio = moduleSource.indexOf('function renderPasoAlta(');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  ['nombre', 'apellido', 'dni', 'fechaNacimiento', 'telefono', 'email', 'coberturaHabitual', 'numeroAfiliado'].forEach((campo) => {
    assert.ok(cuerpo.includes(`name="${campo}"`), `incluye el campo ${campo}`);
  });
  assert.match(cuerpo, /name="nombre" maxlength="80" required/);
  assert.match(cuerpo, /name="telefono" type="tel" maxlength="30" required/, 'el teléfono se pide una única vez, acá');
  assert.match(cuerpo, /name="email" type="email" maxlength="200">/, 'email es opcional (sin required)');
  assert.match(cuerpo, /<select name="coberturaHabitual" required>/, 'cobertura es un select cerrado y obligatorio, no un input de texto libre');
  assert.doesNotMatch(cuerpo, /<input name="coberturaHabitual"/, 'la cobertura ya no es un input de texto libre');
  assert.match(cuerpo, /name="numeroAfiliado" maxlength="60">/, 'n° de afiliado es opcional (sin required)');
  assert.match(cuerpo, /coberturas\.map/, 'las opciones de cobertura vienen del contenido público, no están tipeadas a mano acá');
});

test('el formulario de solicitud de turno pide prestación y cobertura (ambos select cerrados): sin profesional, sin teléfono, sin mensaje, sin agenda', () => {
  const inicio = moduleSource.indexOf('function renderPasoSolicitud');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  assert.match(cuerpo, /<select name="prestacion" required>/);
  assert.match(cuerpo, /<select name="cobertura" required>/, 'la cobertura de la solicitud es un select cerrado y obligatorio');
  assert.doesNotMatch(cuerpo, /<input name="cobertura"/, 'la cobertura de la solicitud nunca es texto libre');
  assert.doesNotMatch(cuerpo, /name="profesionalId"/, 'no hay selección de profesional en la solicitud');
  assert.doesNotMatch(cuerpo, /name="telefono"/, 'el teléfono no se vuelve a pedir en la solicitud');
  assert.doesNotMatch(cuerpo, /name="mensaje"|<textarea/, 'sin texto libre en la solicitud');
  assert.match(cuerpo, /prestaciones\.map/, 'las opciones de prestación vienen del contenido público, no están tipeadas a mano acá');
  assert.match(cuerpo, /coberturas\.map/, 'las opciones de cobertura vienen del contenido público, no están tipeadas a mano acá');
  assert.match(cuerpo, /Cobertura para esta solicitud/, 'la etiqueta deja claro que es la cobertura de esta solicitud, no la habitual del paciente');
});

test('onSubmitSolicitud envía dni, prestación, cobertura y source: nunca teléfono, profesional ni mensaje', () => {
  const inicio = moduleSource.indexOf('async function onSubmitSolicitud');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  assert.match(cuerpo, /dni: estado\.dni/);
  assert.match(cuerpo, /prestacion: datosForm\.get\('prestacion'\)/);
  assert.match(cuerpo, /cobertura: datosForm\.get\('cobertura'\)/);
  assert.match(cuerpo, /source: estado\.source/);
  assert.doesNotMatch(cuerpo, /telefono|profesionalId|profesionalNombre|mensaje/i);
});

test('el paso alta-exitosa muestra el mensaje pedido y los botones SOLICITAR TURNO / FINALIZAR, sin exponer datos personales', () => {
  const inicio = moduleSource.indexOf('function renderPasoAltaExitosa');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  assert.match(cuerpo, /Tu registro fue realizado correctamente\./);
  assert.match(cuerpo, /data-portal-accion="ir-solicitud"/);
  assert.match(cuerpo, /data-portal-accion="finalizar"/);
  assert.doesNotMatch(cuerpo, /estado\.(nombre|telefono|email|dni|cobertura)/, 'no expone datos personales');
});

test('renderPaso enruta el nuevo paso alta-exitosa', () => {
  const inicio = moduleSource.indexOf('function renderPaso()');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  assert.match(cuerpo, /if \(estado\.paso === 'alta-exitosa'\) return renderPasoAltaExitosa\(\);/);
});

test('onSubmitAlta pasa al paso alta-exitosa tras un alta exitosa (ya no reutiliza ya-registrado)', () => {
  const inicio = moduleSource.indexOf('async function onSubmitAlta');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  assert.match(cuerpo, /estado\.paso = 'alta-exitosa';/);
  assert.doesNotMatch(cuerpo, /estado\.paso = 'ya-registrado';/, 'el alta exitosa ya no reutiliza la pantalla de paciente existente');
});

test('irASolicitud salta directo a "solicitud" tanto desde ya-registrado como desde alta-exitosa (paciente existente continúa a solicitud, sin re-pedir datos)', () => {
  const inicio = moduleSource.indexOf('function irASolicitud');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  assert.match(cuerpo, /\['ya-registrado', 'alta-exitosa'\]\.includes\(estado\.paso\)/);
});

test('el botón FINALIZAR vuelve al inicio sin pasar por solicitar turno (alta sin solicitar turno es un camino válido)', () => {
  const inicio = moduleSource.indexOf('function enlazarEventos');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  assert.match(cuerpo, /\[data-portal-accion="volver-inicio"\], \[data-portal-accion="finalizar"\]/);
  assert.match(cuerpo, /addEventListener\('click', volverAlInicio\)/);
});

test('la cobertura de la solicitud y la cobertura habitual del alta son campos distintos, nunca se confunden', () => {
  const inicioAlta = moduleSource.indexOf('function renderPasoAlta(');
  const cuerpoAlta = moduleSource.slice(inicioAlta, moduleSource.indexOf('\n  }', inicioAlta));
  assert.ok(cuerpoAlta.includes('name="coberturaHabitual"'), 'el alta pide coberturaHabitual');
  assert.ok(!cuerpoAlta.includes('name="cobertura"'), 'el alta no tiene también un campo "cobertura" de solicitud');

  const inicioSolicitud = moduleSource.indexOf('function renderPasoSolicitud');
  const cuerpoSolicitud = moduleSource.slice(inicioSolicitud, moduleSource.indexOf('\n  }', inicioSolicitud));
  assert.ok(cuerpoSolicitud.includes('name="cobertura"'), 'la solicitud pide cobertura');
  assert.ok(!cuerpoSolicitud.includes('coberturaHabitual'), 'la solicitud no toca coberturaHabitual');
});

// -----------------------------------------------------------------------
// contenido-publico.js: estructura centralizada, sin datos inventados.
// -----------------------------------------------------------------------

test('contenido-publico.js expone window.CardioLinkContenidoPublico con las 6 áreas centralizadas', () => {
  delete require.cache[require.resolve(contenidoPath)];
  const contenido = require(contenidoPath);
  ['identidad', 'profesionales', 'prestaciones', 'modalidad', 'contacto', 'coberturas'].forEach((clave) => {
    assert.ok(clave in contenido, `expone ${clave}`);
  });
  assert.match(contenidoSource, /if \(root && !root\.CardioLinkContenidoPublico\) root\.CardioLinkContenidoPublico = api;/);
});

test('la identidad usa el nombre real ya usado por el Admin (marcaDocumento de Matías en app.js), no uno inventado', () => {
  const contenido = require(contenidoPath);
  assert.equal(contenido.identidad.nombreConsultorio, 'Consultorio Médico RM');
  const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.match(appSource, /'Consultorio Médico RM'/, 'ese nombre existe de verdad en app.js, no se inventó para el portal');
});

test('los colores de marca son los mismos que ya usa el Admin (styles.css/manifest), no colores inventados', () => {
  const contenido = require(contenidoPath);
  assert.equal(contenido.identidad.colorPrimario, '#123f56');
  const manifestSource = fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8');
  assert.match(manifestSource, /"theme_color":\s*"#123f56"/);
  assert.match(moduleSource + fs.readFileSync(path.join(root, 'portal', 'portal.css'), 'utf8'), /#123f56/);
});

test('el logo reutiliza el único asset de imagen real del repo (icons/icon-512.png): no se referencia ningún archivo inexistente', () => {
  const contenido = require(contenidoPath);
  assert.equal(contenido.identidad.logoUrl, '../icons/icon-512.png');
  const rutaLogo = path.join(root, 'icons', 'icon-512.png');
  assert.ok(fs.existsSync(rutaLogo), 'el archivo referenciado como logo existe de verdad en el repo');
});

test('Geraldine no aparece en la sección de profesionales del portal (no es profesional médica)', () => {
  const contenido = require(contenidoPath);
  assert.equal(contenido.profesionales.length, 1);
  // No se prohíbe la palabra en comentarios (hay uno que documenta por qué
  // se excluye): se prohíbe que aparezca como dato dentro de PROFESIONALES.
  assert.ok(contenido.profesionales.every((p) => !/geraldine/i.test(p.nombre)));
  assert.equal(contenido.profesionales[0].nombre, 'Dr. Matías Anchorena');
});

test('los datos de contacto sin confirmar en el repo quedan vacíos: nada de teléfono/dirección/email/redes inventado', () => {
  const contenido = require(contenidoPath);
  ['direccion', 'telefono', 'whatsapp', 'instagram', 'email', 'mapaUrl'].forEach((campo) => {
    assert.equal(contenido.contacto[campo], '', `${campo} debe quedar vacío: no hay dato real confirmado en el repo`);
  });
});

test('las prestaciones públicas no tienen descripción/duración/preparación inventadas (sin ese dato real en el repo)', () => {
  const contenido = require(contenidoPath);
  contenido.prestaciones.forEach((p) => {
    ['descripcion', 'paraQueSirve', 'duracionAprox', 'preparacionPrevia'].forEach((campo) => {
      assert.equal(p[campo], '', `${p.nombre}.${campo} debe quedar vacío: no hay contenido clínico real confirmado`);
    });
  });
});

test('las coberturas incluyen al menos Particular y "No sé / consultar", tomadas de defaults.obrasSociales real de app.js', () => {
  const contenido = require(contenidoPath);
  assert.ok(contenido.coberturas.includes('Particular'));
  assert.ok(contenido.coberturas.includes('No sé / consultar'));
  const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  contenido.coberturas.filter((c) => c !== 'No sé / consultar').forEach((c) => {
    assert.match(appSource, new RegExp(`'${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`), `${c} existe de verdad en defaults.obrasSociales`);
  });
});

// -----------------------------------------------------------------------
// Landing / micrositio: secciones A-F pedidas.
// -----------------------------------------------------------------------

test('renderLanding compone las 6 secciones pedidas: hero, prestaciones, profesionales, modalidad, contacto y CTA final', () => {
  const inicio = moduleSource.indexOf('function renderLanding');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  ['renderHero', 'renderPrestacionesPublicas', 'renderProfesionalesPublicos', 'renderModalidad', 'renderContacto', 'renderCtaFinal'].forEach((fn) => {
    assert.ok(cuerpo.includes(fn), `renderLanding incluye ${fn}`);
  });
});

test('el hero tiene logo, nombre, descripción y el botón SOLICITAR TURNO', () => {
  const inicio = moduleSource.indexOf('function renderHero');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  assert.match(cuerpo, /identidad\.nombreConsultorio/);
  assert.match(cuerpo, /identidad\.descripcionBreve/);
  assert.match(cuerpo, /SOLICITAR TURNO/);
  assert.match(cuerpo, /data-portal-accion="ir-solicitud"/);
});

test('la sección de profesionales es informativa: no hay ningún <select>/<input> para elegir profesional', () => {
  const inicio = moduleSource.indexOf('function renderProfesionalesPublicos');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  assert.doesNotMatch(cuerpo, /<select|<input|<form/);
});

test('renderContacto no muestra una etiqueta vacía por cada campo sin dato: filtra por valor antes de listar', () => {
  const inicio = moduleSource.indexOf('function renderContacto');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  assert.match(cuerpo, /\.filter\(\(\[, valor\]\) => !!valor\)/);
  assert.match(cuerpo, /se van a completar próximamente/);
});

test('landing y flujo comparten el mismo botón SOLICITAR TURNO por data-attribute, enlazado con querySelectorAll', () => {
  assert.match(moduleSource, /document\.querySelectorAll\('\[data-portal-accion="ir-solicitud"\]'\)/);
});

// -----------------------------------------------------------------------
// index.html: mobile-first mínimo, sin datos personales embebidos.
// -----------------------------------------------------------------------

test('portal/index.html es una página separada del Admin, mobile-first, sin datos embebidos, y carga el contenido antes que portal.js', () => {
  assert.match(indexSource, /width=device-width, initial-scale=1/);
  assert.match(indexSource, /<link rel="stylesheet" href="portal\.css/);
  assert.match(indexSource, /<script src="portal\.js/);
  assert.match(indexSource, /<script src="contenido-publico\.js/);
  assert.doesNotMatch(indexSource, /index\.html(?!.*portal)/, 'no referencia al index.html del Admin');
  assert.doesNotMatch(indexSource, /app\.js|cardiolink-solicitudes-turno|cardiolink-finanzas/);
  const posContenido = indexSource.indexOf('<script src="contenido-publico.js');
  const posPortal = indexSource.indexOf('<script src="portal.js');
  assert.ok(posContenido >= 0 && posContenido < posPortal, 'contenido-publico.js se carga antes que portal.js');
});

console.log('Portal público — frontend: OK');
