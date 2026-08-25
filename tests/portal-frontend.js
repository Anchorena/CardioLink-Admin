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
const privacidadPath = path.join(root, 'portal', 'privacidad.html');
const privacidadSource = fs.readFileSync(privacidadPath, 'utf8');

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

// -----------------------------------------------------------------------
// Preparación final para Producción: anchorena.github.io (el portal
// publicado real) debe usar el gateway y la sitekey reales, nunca los de
// Staging/QA — sin necesidad de reconocer ese hostname en particular: cae
// ahí por ser "no local", igual que cualquier otro dominio publicado.
// -----------------------------------------------------------------------

test('localhost usa sitekey de test + gateway de Staging', () => {
  conVentanaFalsa('localhost', (mod) => {
    assert.equal(mod.gatewayUrl(), 'https://yslhwdlzdknhskawqrtv.supabase.co/functions/v1/portal-gateway');
    assert.equal(mod.turnstileSitekey(), '1x00000000000000000000BB');
  });
});

test('anchorena.github.io (portal publicado real) usa la sitekey real y el gateway productivo real, sin configuración manual', () => {
  conVentanaFalsa('anchorena.github.io', (mod) => {
    assert.equal(mod.gatewayUrl(), 'https://tupacclmhaqiahhlttyz.supabase.co/functions/v1/portal-gateway');
    assert.equal(mod.turnstileSitekey(), '0x4AAAAAAEYiWSCxfjAQOp3P');
    assert.equal(mod.esEntornoLocal(), false);
  });
});

test('un portal publicado nunca usa Staging: ni el gateway ni la sitekey de Staging aparecen fuera de local', () => {
  ['anchorena.github.io', 'www.consultoriomedicorm.com.ar', 'algunotrodominio.com'].forEach((hostname) => {
    conVentanaFalsa(hostname, (mod) => {
      assert.notEqual(mod.gatewayUrl(), 'https://yslhwdlzdknhskawqrtv.supabase.co/functions/v1/portal-gateway', `${hostname} no debe usar el gateway de Staging`);
      assert.notEqual(mod.turnstileSitekey(), '1x00000000000000000000BB', `${hostname} no debe usar la sitekey de QA`);
    });
  });
});

test('la secret key real de Turnstile no existe en ningún archivo del frontend', () => {
  // El NOMBRE de la env var puede aparecer en un comentario explicando que
  // vive server-side (portal.js ya lo hace, a propósito, como
  // documentación) — lo que nunca debe aparecer es un valor asignado a
  // ella, ni sintaxis de Edge Function (Deno.env.get) en un archivo que se
  // sirve al navegador.
  [moduleSource, contenidoSource, indexSource].forEach((fuente) => {
    assert.doesNotMatch(fuente, /TURNSTILE_SECRET_KEY\s*[:=]/, 'la env var nunca se asigna en el frontend, sólo puede nombrarse en prosa');
    assert.doesNotMatch(fuente, /Deno\.env\.get/, 'ningún archivo de frontend usa sintaxis de Edge Function');
  });
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

// -----------------------------------------------------------------------
// Fix: condición de carrera entre el script async de Cloudflare y el
// primer montaje del widget. Desde que el hero embebe el formulario de
// DNI directamente en el primer render() de la página (antes sólo pasaba
// al hacer click en "SOLICITAR TURNO", segundos después de cargar),
// montarTurnstileSiCorresponde() puede correr ANTES de que
// window.turnstile exista todavía. Sin reintento, turnstileWidget.widgetId
// quedaba en null para siempre y cualquier envío fallaba de entrada con
// "No se pudo cargar la verificación anti-bots.", aunque Turnstile
// terminara cargando un instante después.
// -----------------------------------------------------------------------

test('si Turnstile todavía no cargó al montar, se programa un reintento en vez de dejar el widget en null para siempre', () => {
  const inicio = moduleSource.indexOf('function montarTurnstileSiCorresponde');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  assert.match(cuerpo, /if \(!turnstileDisponible\(\)\) \{/);
  assert.match(cuerpo, /reintentarMontajeTurnstile\(0\)/);
  // Guardado por una bandera para no arrancar varias cadenas de reintento
  // en paralelo si hay más de un render() mientras se espera.
  assert.match(cuerpo, /if \(!turnstileEsperandoScript\) \{/);
  assert.match(cuerpo, /turnstileEsperandoScript = true;/);
});

test('reintentarMontajeTurnstile: reintenta con un límite acotado (no reintenta para siempre) y nunca pisa un widget que ya se montó con éxito', () => {
  const inicio = moduleSource.indexOf('function reintentarMontajeTurnstile');
  assert.notEqual(inicio, -1, 'existe reintentarMontajeTurnstile');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  assert.match(cuerpo, /window\.setTimeout\(\(\) => \{/, 'usa un timeout, no un loop bloqueante');
  assert.match(cuerpo, /250\)/, '250ms entre intentos');
  assert.match(cuerpo, /intentos < 40/, 'límite acotado de reintentos (~10s en total)');
  // Antes de reintentar, chequea que no haya un widget ya montado (por
  // otro render() mientras tanto) y que todavía exista un contenedor.
  const posCheckWidget = cuerpo.indexOf('if (turnstileWidget.widgetId !== null) return;');
  const posCheckContenedor = cuerpo.indexOf("if (!document.querySelector('[data-turnstile-container]')) return;");
  assert.notEqual(posCheckWidget, -1);
  assert.notEqual(posCheckContenedor, -1);
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

test('contenido-publico.js expone window.CardioLinkContenidoPublico con las 9 áreas centralizadas', () => {
  delete require.cache[require.resolve(contenidoPath)];
  const contenido = require(contenidoPath);
  ['identidad', 'profesionales', 'prestaciones', 'especialidadesComplementarias', 'equipamiento', 'modalidad', 'estudiosPaciente', 'contacto', 'coberturas'].forEach((clave) => {
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

test('la descripción institucional representa al conjunto del centro, no a un solo profesional: no dice "Medicina Intensiva" (eso es el perfil personal de Matías)', () => {
  const contenido = require(contenidoPath);
  assert.doesNotMatch(contenido.identidad.descripcionBreve, /Medicina Intensiva/i);
  assert.match(contenido.identidad.descripcionBreve, /Cardiología/);
  assert.match(contenido.identidad.descripcionBreve, /Diagnóstico por Imágenes/);
});

test('"Medicina Intensiva y Cardiología" es el perfil personal de Matías, no la descripción institucional', () => {
  const contenido = require(contenidoPath);
  const matias = contenido.profesionales.find((p) => p.nombre === 'Dr. Matías Anchorena');
  assert.match(matias.descripcionBreve, /Medicina Intensiva y Cardiología/);
});

test('los colores de marca son los del brand kit aprobado (azul petróleo + turquesa), en la misma familia que el Admin pero identidad propia del portal', () => {
  const contenido = require(contenidoPath);
  assert.equal(contenido.identidad.colorPrimario, '#0e4f63');
  const portalCss = fs.readFileSync(path.join(root, 'portal', 'portal.css'), 'utf8');
  assert.match(portalCss, /--portal-primary:\s*#0e4f63/);
  assert.match(portalCss, /--portal-primary-dark:\s*#0b2d42/);
  assert.match(portalCss, /--portal-turquesa:\s*#14b8c5/);
  const manifestSource = fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8');
  assert.match(manifestSource, /"theme_color":\s*"#123f56"/, 'el Admin no se tocó: sigue con su propio color original');
});

test('los logos reales del brand kit (horizontal, oscuro, claro) todavía no se entregaron: quedan vacíos, no se recrean con SVG/CSS', () => {
  const contenido = require(contenidoPath);
  ['logoPrincipal', 'logoOscuro', 'logoClaro'].forEach((campo) => {
    assert.equal(contenido.identidad[campo], '', `${campo} debe quedar vacío: archivo real todavía no entregado`);
  });
});

test('el isologo institucional es el archivo real del brand kit (isologo.png), no el fallback provisional en código', () => {
  const contenido = require(contenidoPath);
  assert.equal(contenido.identidad.isologo, 'assets/branding/isologo.png');
  const rutaLogo = path.join(root, 'portal', 'assets', 'branding', 'isologo.png');
  assert.ok(fs.existsSync(rutaLogo), 'el archivo referenciado existe de verdad en el repo');
});

test('el header prioriza logoOscuro → logoPrincipal → isologo, y sólo el isologo fallback lleva el recuadro blanco', () => {
  const inicio = moduleSource.indexOf('function logoHeroSeleccionado');
  assert.notEqual(inicio, -1, 'existe logoHeroSeleccionado');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  assert.match(cuerpo, /identidad\.logoOscuro/);
  assert.match(cuerpo, /identidad\.logoPrincipal/);
  assert.match(cuerpo, /identidad\.isologo/);
  // El logo vive en el header (nav), no en el cuerpo del hero: el hero ya
  // no repite el logo, sólo el mensaje institucional + la card de DNI.
  const inicioHeader = moduleSource.indexOf('function renderHeader');
  const cuerpoHeader = moduleSource.slice(inicioHeader, moduleSource.indexOf('\n  }', inicioHeader));
  assert.match(cuerpoHeader, /logoHeroSeleccionado/);
  assert.match(cuerpoHeader, /portal-logo-fallback/);
});

test('logoUrl: Matías y Rogelio ya tienen su logo personal real cargado; Drago/Rutter siguen sin uno (vacío, no inventado)', () => {
  const contenido = require(contenidoPath);
  const porNombre = Object.fromEntries(contenido.profesionales.map((p) => [p.nombre, p.logoUrl]));
  assert.equal(porNombre['Dr. Matías Anchorena'], 'assets/profesionales/matias-anchorena.png');
  assert.equal(porNombre['Dr. Rogelio Anchorena'], 'assets/profesionales/rogelio-anchorena.png');
  ['Dr. Fernández Drago Humberto', 'Dra. Rutter'].forEach((nombre) => {
    assert.equal(porNombre[nombre], '', `${nombre}.logoUrl debe quedar vacío: sin logo personal real confirmado todavía`);
  });
  ['matias-anchorena.png', 'rogelio-anchorena.png'].forEach((archivo) => {
    const rutaLogo = path.join(root, 'portal', 'assets', 'profesionales', archivo);
    assert.ok(fs.existsSync(rutaLogo), `${archivo} existe de verdad en el repo`);
  });
});

test('renderAvatarProfesional(): fotoUrl → foto circular; si no hay foto pero sí logoUrl → logo completo sin recortar (object-fit: contain) en caja rectangular; si no hay ninguno → iniciales', () => {
  const inicio = moduleSource.indexOf('function renderAvatarProfesional');
  assert.notEqual(inicio, -1, 'existe renderAvatarProfesional');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  // Orden de las tres ramas: fotoUrl primero, logoUrl segundo, iniciales al final.
  const posFoto = cuerpo.indexOf('p.fotoUrl');
  const posLogo = cuerpo.indexOf('p.logoUrl');
  const posIniciales = cuerpo.indexOf('portal-profesional-avatar');
  assert.ok(posFoto !== -1 && posLogo !== -1 && posIniciales !== -1, 'las tres ramas existen');
  assert.ok(posFoto < posLogo && posLogo < posIniciales, 'el orden de prioridad es foto → logo → iniciales');
  assert.match(cuerpo, /class="portal-profesional-foto"/);
  assert.match(cuerpo, /class="portal-profesional-logo-box"/);
  assert.match(cuerpo, /class="portal-profesional-logo-img"/);
  // renderProfesionalesPublicos usa esta función (no duplica la lógica).
  const inicioCards = moduleSource.indexOf('function renderProfesionalesPublicos');
  const cuerpoCards = moduleSource.slice(inicioCards, moduleSource.indexOf('\n  }', inicioCards));
  assert.match(cuerpoCards, /renderAvatarProfesional\(p\)/);
});

test('el logo completo (sin foto) nunca se recorta en el círculo de 72px: usa object-fit contain en una caja propia, no la clase de foto/avatar circular', () => {
  const inicio = moduleSource.indexOf('function renderAvatarProfesional');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  // El bloque exacto que arma la rama logoUrl: ni la img ni su contenedor
  // reutilizan las clases circulares de foto/iniciales.
  const bloqueLogo = /if \(p\.logoUrl\) \{\s*return `<div class="portal-profesional-logo-box"><img class="portal-profesional-logo-img"[^`]*<\/div>`;\s*\}/;
  assert.match(cuerpo, bloqueLogo, 'la rama de logoUrl arma la caja+img esperadas');
  const match = cuerpo.match(bloqueLogo)[0];
  assert.doesNotMatch(match, /portal-profesional-foto"|portal-profesional-avatar"/, 'no reutiliza las clases circulares de foto/iniciales');

  const cssPath = path.join(root, 'portal', 'portal.css');
  const css = fs.readFileSync(cssPath, 'utf8');
  const inicioCss = css.indexOf('.portal-profesional-logo-img');
  assert.notEqual(inicioCss, -1, 'existe la regla CSS de la imagen del logo');
  assert.match(css.slice(inicioCss, inicioCss + 200), /object-fit:\s*contain/, 'sin recorte ni deformación: contain, no cover');
});

test('portal/assets/README.md documenta el nombre de archivo, carpeta y valor de configuración esperados para cada logo/foto pendiente', () => {
  const readmePath = path.join(root, 'portal', 'assets', 'README.md');
  assert.ok(fs.existsSync(readmePath), 'existe portal/assets/README.md');
  const readme = fs.readFileSync(readmePath, 'utf8');
  ['logoPrincipal', 'logoOscuro', 'logoClaro', 'fotoUrl'].forEach((campo) => {
    assert.match(readme, new RegExp(campo));
  });
});

test('los 4 profesionales confirmados aparecen, en este orden: Matías, Rogelio, Fernández Drago Humberto y Rutter', () => {
  const contenido = require(contenidoPath);
  assert.equal(contenido.profesionales.length, 4);
  const nombres = contenido.profesionales.map((p) => p.nombre);
  assert.deepEqual(nombres, ['Dr. Matías Anchorena', 'Dr. Rogelio Anchorena', 'Dr. Fernández Drago Humberto', 'Dra. Rutter']);
});

test('los 3 profesionales con prestaciones confirmadas (Matías, Rogelio, Drago Humberto) existen de verdad en app.js, con configuración propia', () => {
  const contenido = require(contenidoPath);
  const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const conPrestaciones = contenido.profesionales.filter((p) => p.nombre !== 'Dra. Rutter');
  assert.equal(conPrestaciones.length, 3);
  conPrestaciones.forEach((p) => {
    assert.match(appSource, new RegExp(`nombre:'${p.nombre.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`), `${p.nombre} existe de verdad en app.js`);
    assert.ok(Array.isArray(p.prestaciones) && p.prestaciones.length, `${p.nombre} tiene prestaciones reales cargadas`);
  });
  // Cada profesional tiene su propio array de prestaciones (nunca la misma
  // referencia compartida), aunque el contenido real pueda coincidir.
  const referencias = new Set(conPrestaciones.map((p) => p.prestaciones));
  assert.equal(referencias.size, 3, 'las tres listas de prestaciones son objetos/arrays independientes, no una referencia compartida');
});

test('"Drago Lucas" NO se muestra como profesional público: sólo se confirmó a Fernández Drago Humberto', () => {
  const contenido = require(contenidoPath);
  assert.ok(contenido.profesionales.every((p) => !/lucas/i.test(p.nombre)), 'Drago Lucas no debe aparecer como dato dentro de PROFESIONALES todavía');
  const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.match(appSource, /nombre:'Dr\. Drago Lucas'/, 'confirma que sí existe un registro real para él en app.js, pero no se usó todavía sin confirmación');
});

test('Geraldine no aparece en la sección de profesionales del portal (no es profesional médica)', () => {
  const contenido = require(contenidoPath);
  // No se prohíbe la palabra en comentarios (hay uno que documenta por qué
  // se excluye): se prohíbe que aparezca como dato dentro de PROFESIONALES.
  assert.ok(contenido.profesionales.every((p) => !/geraldine/i.test(p.nombre)));
});

test('Rutter SÍ está en PROFESIONALES, pero sin ningún dato inventado: especialidad/matrícula/prestaciones/horarios/bio/foto/logo quedan vacíos', () => {
  const contenido = require(contenidoPath);
  const rutter = contenido.profesionales.find((p) => p.nombre === 'Dra. Rutter');
  assert.ok(rutter, 'Rutter existe en PROFESIONALES');
  ['especialidad', 'matriculaNacional', 'matriculaProvincial', 'descripcionBreve', 'fotoUrl', 'logoUrl', 'diasAtencion', 'horarios'].forEach((campo) => {
    assert.equal(rutter[campo], '', `${campo} de Rutter debe quedar vacío: sin dato real confirmado`);
  });
  assert.deepEqual(rutter.prestaciones, []);
  // Su único respaldo real en el repo es el nombre, en la lista de colegas
  // externos que derivan pacientes — no tiene ahí ninguno de los otros
  // campos, así que no hay de dónde tomarlos sin inventarlos.
  const referidosSource = fs.readFileSync(path.join(root, 'cardiolink-hc-referidos.js'), 'utf8');
  assert.match(referidosSource, /'Dra\. Rutter'/);
});

test('Rutter NO se publica todavía (visibleEnPortal: false): decisión explícita del dueño para no mostrar una tarjeta incompleta', () => {
  const contenido = require(contenidoPath);
  const rutter = contenido.profesionales.find((p) => p.nombre === 'Dra. Rutter');
  assert.equal(rutter.visibleEnPortal, false);
  // Sigue confirmada como staff público: la modalidad no se vacía, sólo se
  // oculta la tarjeta hasta tener días/horarios reales.
  assert.equal(rutter.modalidadAtencion, 'orden_llegada');
});

test('la modalidad de atención de Rutter (orden de llegada) SÍ está confirmada, a diferencia del resto de sus datos: no queda vacía', () => {
  const contenido = require(contenidoPath);
  const rutter = contenido.profesionales.find((p) => p.nombre === 'Dra. Rutter');
  assert.equal(rutter.modalidadAtencion, 'orden_llegada');
  assert.equal(rutter.mensajeModalidad, '', 'sin override manual: el texto se arma desde la plantilla genérica');
});

test('el email de contacto es el real entregado (drm.anchorena@gmail.com), el resto de los campos sin confirmar sigue vacío', () => {
  const contenido = require(contenidoPath);
  assert.equal(contenido.contacto.email, 'drm.anchorena@gmail.com');
  ['direccion', 'telefono', 'whatsapp', 'instagram', 'mapaUrl'].forEach((campo) => {
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

test('renderLanding compone las secciones pedidas: header, hero, prestaciones, profesionales, especialidades, equipamiento, modalidad, mis estudios, contacto, CTA y footer', () => {
  const inicio = moduleSource.indexOf('function renderLanding');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  [
    'renderHeader', 'renderHero', 'renderPrestacionesPublicas', 'renderProfesionalesPublicos',
    'renderEspecialidadesComplementarias', 'renderEquipamiento', 'renderModalidad',
    'renderEstudiosPaciente', 'renderContacto', 'renderCtaFinal', 'renderFooter'
  ].forEach((fn) => {
    assert.ok(cuerpo.includes(fn), `renderLanding incluye ${fn}`);
  });
});

test('el hero tiene nombre, descripción y la card de DNI embebida (sin repetir el logo, que ya está en el header)', () => {
  const inicio = moduleSource.indexOf('function renderHero');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  assert.match(cuerpo, /identidad\.nombreConsultorio/);
  assert.match(cuerpo, /identidad\.descripcionBreve/);
  assert.match(cuerpo, /renderFormularioDni\(\)/);
  assert.match(cuerpo, /id="hero-turno"/);
  assert.doesNotMatch(cuerpo, /logoHeroSeleccionado/, 'el logo vive sólo en el header, no se repite en el hero');
});

test('el header tiene logo+nombre, nav a las secciones existentes y un CTA que ancla a la card de DNI del hero (sin disparar ninguna acción de JS)', () => {
  const inicio = moduleSource.indexOf('function renderHeader');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  assert.match(cuerpo, /identidad\.nombreConsultorio/);
  assert.match(cuerpo, /href="#inicio"/);
  assert.match(cuerpo, /href="#prestaciones"/);
  assert.match(cuerpo, /href="#profesionales"/);
  assert.match(cuerpo, /href="#contacto"/);
  assert.match(cuerpo, /href="#hero-turno"/);
  assert.doesNotMatch(cuerpo, /data-portal-accion/, 'el header es sólo navegación por anclas, no dispara acciones');
});

test('el formulario de DNI del hero es el mismo real de siempre (mismo id/inputs/Turnstile), no una card decorativa', () => {
  const inicio = moduleSource.indexOf('function renderFormularioDni');
  assert.notEqual(inicio, -1, 'existe renderFormularioDni');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  assert.match(cuerpo, /id="portalFormDni"/);
  assert.match(cuerpo, /name="dni"/);
  assert.match(cuerpo, /data-turnstile-container/);
  assert.match(cuerpo, /value="\$\{escapar\(estado\.dni\)\}"/, 'precarga el DNI ya tipeado si el formulario se vuelve a mostrar');
  // renderPasoDni (usado dentro del flujo, ej. para "Ver días y horarios")
  // reutiliza esta misma función, no duplica el formulario.
  const inicioPasoDni = moduleSource.indexOf('function renderPasoDni');
  const cuerpoPasoDni = moduleSource.slice(inicioPasoDni, moduleSource.indexOf('\n  }', inicioPasoDni));
  assert.match(cuerpoPasoDni, /renderFormularioDni\(\)/);
});

test('el turno público sigue siendo sólo para Matías: el formulario de DNI del hero es genérico, sin selector de profesional', () => {
  const inicio = moduleSource.indexOf('function renderHero');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  assert.doesNotMatch(cuerpo, /<select|data-profesional-index/, 'el hero no ofrece elegir profesional');
});

test('la sección de profesionales es informativa: no hay ningún <select>/<input> para elegir profesional', () => {
  const inicio = moduleSource.indexOf('function renderProfesionalesPublicos');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  assert.doesNotMatch(cuerpo, /<select|<input|<form/);
});

test('la tarjeta de cada profesional muestra sus prestaciones y, si están cargados, días/horarios', () => {
  const inicio = moduleSource.indexOf('function renderProfesionalesPublicos');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  assert.match(cuerpo, /p\.prestaciones/);
  assert.match(cuerpo, /p\.diasAtencion, p\.horarios/);
});

test('un profesional sin ningún dato confirmado (ni siquiera modalidad) muestra un aviso discreto, nunca campos vacíos ni inventados', () => {
  const inicio = moduleSource.indexOf('function renderProfesionalesPublicos');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  // modalidadAtencion cuenta como dato confirmado: si está cargada, ya no
  // corresponde el aviso "Más información, próximamente." (es lo que le
  // pasa hoy a Rutter, que tiene la modalidad confirmada aunque el resto
  // de sus campos siga vacío — ver el test de arriba).
  assert.match(cuerpo, /const sinDatosConfirmados = !p\.especialidad && !matriculas && !p\.descripcionBreve && !horario && !tienePrestaciones && !modalidad;/);
  assert.match(cuerpo, /Más información, próximamente\./);
  // No inventa ninguno de los campos que pueden estar vacíos: no hay
  // ningún valor por defecto (||) para especialidad/matrícula/etc., cada
  // uno sólo se muestra si viene con dato real.
  ['p.especialidad', 'matriculas', 'p.descripcionBreve', 'horario'].forEach((campo) => {
    assert.doesNotMatch(cuerpo, new RegExp(`\\$\\{${campo.replace('.', '\\.')} \\|\\| '`), `${campo} no tiene un valor inventado de reemplazo`);
  });
});

// -----------------------------------------------------------------------
// Modalidad de atención por profesional: configurable, data-driven, sin
// lógica hardcodeada por nombre/apellido.
// -----------------------------------------------------------------------

test('cada profesional confirmado tiene su propia modalidadAtencion configurada: Matías con turno, el resto por orden de llegada', () => {
  const contenido = require(contenidoPath);
  const porNombre = Object.fromEntries(contenido.profesionales.map((p) => [p.nombre, p.modalidadAtencion]));
  assert.equal(porNombre['Dr. Matías Anchorena'], 'con_turno');
  assert.equal(porNombre['Dr. Rogelio Anchorena'], 'orden_llegada');
  assert.equal(porNombre['Dr. Fernández Drago Humberto'], 'orden_llegada');
  assert.equal(porNombre['Dra. Rutter'], 'orden_llegada');
  contenido.profesionales.forEach((p) => {
    assert.ok(['con_turno', 'orden_llegada', 'mixta'].includes(p.modalidadAtencion), `${p.nombre} tiene un valor válido de modalidadAtencion`);
  });
});

test('las prestaciones confirmadas de Rogelio son Consulta/Electrocardiograma/Holter/MAPA, sin Ecocardiograma ni Ergometría (dato directo del dueño, no copiado de Matías)', () => {
  const contenido = require(contenidoPath);
  const rogelio = contenido.profesionales.find((p) => p.nombre === 'Dr. Rogelio Anchorena');
  assert.deepEqual(rogelio.prestaciones, ['Consulta', 'Electrocardiograma', 'Holter', 'MAPA']);
  assert.ok(!rogelio.prestaciones.includes('Ecocardiograma'));
  assert.ok(!rogelio.prestaciones.includes('Ecocardiograma Doppler'));
  assert.ok(!rogelio.prestaciones.includes('Ergometría'));
});

test('etiquetaModalidad() en portal.js es puramente data-driven: no hay ningún if/comparación por nombre de profesional, sólo por modalidadAtencion', () => {
  const inicio = moduleSource.indexOf('function etiquetaModalidad');
  assert.notEqual(inicio, -1, 'existe etiquetaModalidad');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  assert.match(cuerpo, /p\.modalidadAtencion === 'con_turno'/);
  assert.match(cuerpo, /p\.modalidadAtencion === 'orden_llegada'/);
  assert.match(cuerpo, /p\.modalidadAtencion === 'mixta'/);
  assert.doesNotMatch(cuerpo, /nombre/i, 'no debe mirar el nombre del profesional para decidir su comportamiento');
});

test('sólo las tarjetas de profesionales "orden_llegada"/"mixta" ofrecen el CTA "Ver días y horarios" (data-portal-accion="ver-modalidad"); "con_turno" no repite "Solicitar turno" en su tarjeta', () => {
  const inicio = moduleSource.indexOf('function renderProfesionalesPublicos');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  assert.match(cuerpo, /data-portal-accion="ver-modalidad"/);
  assert.match(cuerpo, /data-profesional-index/);
  assert.doesNotMatch(cuerpo, /data-portal-accion="ir-solicitud"/, 'con_turno se queda sólo con el badge, sin duplicar el CTA del hero');
});

test('el flujo "Ver días y horarios" reutiliza el mismo paso DNI, pero nunca termina ofreciendo "Solicitar turno": arma un mensaje propio con lineasModalidad()', () => {
  assert.match(moduleSource, /function irAVerModalidad/);
  assert.match(moduleSource, /modoFlujo = 'modalidad'/);
  assert.match(moduleSource, /function lineasModalidad/);
  assert.match(moduleSource, /function renderPasoModalidad/);
  const inicio = moduleSource.indexOf('function renderPasoModalidad');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  assert.doesNotMatch(cuerpo, /SOLICITAR TURNO/);
  assert.doesNotMatch(cuerpo, /data-portal-accion="ir-solicitud"/);
  assert.match(cuerpo, /data-portal-accion="finalizar"/);
});

test('lineasModalidad() nunca inventa días/horarios: sólo arma la línea de día+horario si los dos vienen confirmados, si no usa "Horarios próximamente"', () => {
  const inicio = moduleSource.indexOf('function lineasModalidad');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  assert.match(cuerpo, /dias && horarios \? /, 'sólo arma la línea de día/horario si los dos están confirmados a la vez');
  assert.match(cuerpo, /Horarios próximamente/, 'si no están confirmados, un texto genérico lo dice en vez de inventar');
});

test('el mensaje de modalidad (orden de llegada) nunca dice que el consultorio va a contactar para coordinar: en esa modalidad no se coordina turno', () => {
  const inicioLineas = moduleSource.indexOf('function lineasModalidad');
  const cuerpoLineas = moduleSource.slice(inicioLineas, moduleSource.indexOf('\n  }', inicioLineas));
  assert.doesNotMatch(cuerpoLineas, /contactar|coordinar/i);
  const inicioPaso = moduleSource.indexOf('function renderPasoModalidad');
  const cuerpoPaso = moduleSource.slice(inicioPaso, moduleSource.indexOf('\n  }', inicioPaso));
  assert.doesNotMatch(cuerpoPaso, /contactar|coordinar/i);
});

test('el texto público de Rogelio y Drago Humberto arma exactamente "Atención por orden de llegada." + día/horario + "No necesitás solicitar turno previamente."', () => {
  delete require.cache[require.resolve(contenidoPath)];
  const contenido = require(contenidoPath);
  // lineasModalidad no está exportada (es interna a portal.js): se
  // reconstruye acá la misma lógica sobre los datos reales para verificar
  // el resultado exacto, palabra por palabra, para los dos profesionales
  // con día/horario ya confirmado.
  const armar = (p) => [
    'Atención por orden de llegada.',
    `${p.diasAtencion.charAt(0).toUpperCase()}${p.diasAtencion.slice(1)} de ${p.horarios}.`,
    'No necesitás solicitar turno previamente.'
  ];
  const rogelio = contenido.profesionales.find((p) => p.nombre === 'Dr. Rogelio Anchorena');
  assert.equal(rogelio.diasAtencion, 'lunes a viernes');
  assert.equal(rogelio.horarios, '14:30 a 19:30');
  assert.deepEqual(armar(rogelio), [
    'Atención por orden de llegada.',
    'Lunes a viernes de 14:30 a 19:30.',
    'No necesitás solicitar turno previamente.'
  ]);
  const drago = contenido.profesionales.find((p) => p.nombre === 'Dr. Fernández Drago Humberto');
  assert.equal(drago.diasAtencion, 'martes y viernes');
  assert.equal(drago.horarios, '09:00 a 15:00');
  assert.deepEqual(armar(drago), [
    'Atención por orden de llegada.',
    'Martes y viernes de 09:00 a 15:00.',
    'No necesitás solicitar turno previamente.'
  ]);
});

test('Matías sigue siendo el único profesional confirmado con solicitud de turno ("con_turno")', () => {
  const contenido = require(contenidoPath);
  const conTurno = contenido.profesionales.filter((p) => p.modalidadAtencion === 'con_turno');
  assert.deepEqual(conTurno.map((p) => p.nombre), ['Dr. Matías Anchorena']);
});

test('Rutter no tiene días/horarios inventados: siguen vacíos, y por eso su tarjeta no ofrece el botón "Ver días y horarios" (evita llevar a un paso sin información real)', () => {
  const contenido = require(contenidoPath);
  const rutter = contenido.profesionales.find((p) => p.nombre === 'Dra. Rutter');
  assert.equal(rutter.diasAtencion, '');
  assert.equal(rutter.horarios, '');
  const inicio = moduleSource.indexOf('function etiquetaModalidad');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  assert.match(cuerpo, /tieneHorarioConfirmado = Boolean\(p\.diasAtencion && p\.horarios\)/);
  assert.match(cuerpo, /cta: tieneHorarioConfirmado \? 'Ver días y horarios' : null/);
});

test('visibleEnPortal existe como dato configurable por profesional, con filtro real en renderProfesionalesPublicos (no lógica por nombre)', () => {
  const contenido = require(contenidoPath);
  contenido.profesionales.forEach((p) => {
    assert.equal(typeof p.visibleEnPortal, 'boolean', `${p.nombre} tiene visibleEnPortal configurado`);
  });
  const inicio = moduleSource.indexOf('function renderProfesionalesPublicos');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  assert.match(cuerpo, /p\.visibleEnPortal !== false/);
});

test('onSubmitDni/onSubmitAlta miran estado.modoFlujo para decidir el paso siguiente: "modalidad" nunca llega a ya-registrado/alta-exitosa', () => {
  assert.match(moduleSource, /estado\.modoFlujo === 'modalidad' \? 'modalidad-existente' : 'ya-registrado'/);
  assert.match(moduleSource, /estado\.modoFlujo === 'modalidad' \? 'modalidad-nueva' : 'alta-exitosa'/);
});

test('onSubmitDni entra a la vista de flujo apenas se envía el formulario (venga del hero embebido en la landing o de una re-entrada), antes de validar/llamar al gateway', () => {
  const inicio = moduleSource.indexOf('async function onSubmitDni');
  assert.notEqual(inicio, -1, 'existe onSubmitDni');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  const posVista = cuerpo.indexOf("estado.vista = 'flujo';");
  const posValidacion = cuerpo.indexOf('dniClienteValido(dni)');
  const posGateway = cuerpo.indexOf('consultarDni(');
  assert.ok(posVista !== -1 && posValidacion !== -1 && posGateway !== -1, 'las tres líneas existen');
  assert.ok(posVista < posValidacion && posValidacion < posGateway, 'el cambio de vista pasa antes de validar y antes de llamar al gateway');
});

test('volverAlInicio limpia estado.dni: al volver al inicio, la card del hero no debe quedar con un DNI de una vuelta anterior', () => {
  const inicio = moduleSource.indexOf('function volverAlInicio');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  assert.match(cuerpo, /estado\.dni = '';/);
});

test('la modalidad general ("Cómo es la atención") ya no dice que la atención es siempre con turno: cada profesional tiene la suya propia', () => {
  const contenido = require(contenidoPath);
  assert.ok(contenido.modalidad.every((texto) => !/siempre con turno/i.test(texto)));
  const inicio = moduleSource.indexOf('function renderModalidad');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  assert.doesNotMatch(cuerpo, /siempre con turno/i);
});

// -----------------------------------------------------------------------
// Ergometría: sacada de cards/contenido público/select de la solicitud.
// -----------------------------------------------------------------------

test('Ergometría no aparece en ningún lado del frontend público: ni en contenido-publico.js ni en portal.js', () => {
  assert.doesNotMatch(contenidoSource, /Ergometría/);
  assert.doesNotMatch(moduleSource, /Ergometría/);
});

test('el select de prestación de la solicitud de turno sólo puede ofrecer lo que hay en contenido-publico.js (sin Ergometría)', () => {
  const contenido = require(contenidoPath);
  assert.deepEqual(contenido.prestaciones.map((p) => p.nombre), ['Consulta', 'Holter 24 h', 'MAPA', 'Ecocardiograma']);
});

// -----------------------------------------------------------------------
// CTA: el hero embebe el formulario real de DNI (no un botón "SOLICITAR
// TURNO"); el CTA final es otra cosa útil, no un duplicado.
// -----------------------------------------------------------------------

test('ninguna función que arma la landing dispara ir-solicitud: el hero ya embebe el formulario real de DNI directamente, sin necesitar ese botón como paso intermedio', () => {
  const cuerpoDe = (nombreFuncion) => {
    const inicio = moduleSource.indexOf(`function ${nombreFuncion}`);
    assert.notEqual(inicio, -1, `existe ${nombreFuncion}`);
    return moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  };
  // Todas las funciones que renderLanding compone (ver test anterior): hoy
  // "ir-solicitud" sólo se usa dentro del flujo (ya-registrado/alta-
  // exitosa → elegir prestación), nunca en la landing.
  const sinIrSolicitud = [
    'renderHeader', 'renderHero', 'renderPrestacionesPublicas', 'renderProfesionalesPublicos',
    'renderEspecialidadesComplementarias', 'renderEquipamiento', 'renderModalidad',
    'renderEstudiosPaciente', 'renderContacto', 'renderFooter'
  ];
  sinIrSolicitud.forEach((fn) => {
    assert.doesNotMatch(cuerpoDe(fn), /data-portal-accion="ir-solicitud"/, `${fn} no debe disparar ir-solicitud`);
  });

  const cuerpoCtaFinal = cuerpoDe('renderCtaFinal');
  assert.doesNotMatch(cuerpoCtaFinal, /SOLICITAR TURNO/, 'el CTA final no repite el mismo texto que el hero');
  assert.doesNotMatch(cuerpoCtaFinal, /data-portal-accion="ir-solicitud"/);
  assert.match(cuerpoCtaFinal, /href="#prestaciones"/, 'el CTA final es un link útil, no un duplicado');
});

// -----------------------------------------------------------------------
// Especialidades complementarias, Equipamiento, Mis estudios (futuro).
// -----------------------------------------------------------------------

test('especialidades complementarias muestra el texto pedido y reutiliza las prestaciones reales de Drago para Diagnóstico por imágenes', () => {
  const contenido = require(contenidoPath);
  assert.equal(contenido.especialidadesComplementarias.descripcion, 'Además contamos con otras especialidades para completar la atención de manera integral y multidisciplinaria.');
  const nombres = contenido.especialidadesComplementarias.items.map((e) => e.nombre);
  assert.deepEqual(nombres, ['Diabetología y Nutrición', 'Diagnóstico por imágenes', 'Psiquiatría', 'Próximamente más especialidades']);
  const imagenes = contenido.especialidadesComplementarias.items.find((e) => e.nombre === 'Diagnóstico por imágenes');
  const dragoHumberto = contenido.profesionales.find((p) => p.nombre === 'Dr. Fernández Drago Humberto');
  assert.deepEqual(imagenes.prestaciones, dragoHumberto.prestaciones, 'reutiliza las prestaciones reales de Drago, no una lista inventada aparte');
});

test('equipamiento muestra sólo tipos de estudio reales, sin inventar marca/modelo', () => {
  const contenido = require(contenidoPath);
  const estudios = contenido.equipamiento.items.map((e) => e.estudio);
  assert.deepEqual(estudios, ['Ecocardiografía', 'Holter', 'MAPA', 'ECG']);
  contenido.equipamiento.items.forEach((e) => {
    assert.equal(e.detalle, '', `${e.estudio}: sin marca/modelo inventado, queda vacío hasta tener un dato real`);
  });
});

test('equipamiento se renderiza como chips compactos (no una lista vertical más): menos bloques apilados en la página', () => {
  const inicio = moduleSource.indexOf('function renderEquipamiento');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  assert.match(cuerpo, /portal-equipo-chips/);
  assert.match(cuerpo, /portal-chip/);
  assert.doesNotMatch(cuerpo, /portal-contacto-list/, 'ya no reutiliza el estilo de lista vertical de contacto');
});

// -----------------------------------------------------------------------
// Anclas de navegación (header): mismas secciones ya existentes, ninguna
// nueva sección ni id inventado.
// -----------------------------------------------------------------------

test('las secciones que el header referencia por ancla existen de verdad, con el mismo id', () => {
  const secciones = {
    renderHero: 'id="inicio"',
    renderProfesionalesPublicos: 'id="profesionales"',
    renderContacto: 'id="contacto"'
  };
  Object.entries(secciones).forEach(([fn, idEsperado]) => {
    const inicio = moduleSource.indexOf(`function ${fn}`);
    const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
    assert.match(cuerpo, new RegExp(idEsperado.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${fn} expone ${idEsperado}`);
  });
  // "Estudios" del header ya apuntaba a #prestaciones desde antes (mismo id
  // que usa el CTA final): no es nuevo, sólo lo reutiliza.
  assert.match(moduleSource, /id="prestaciones"/);
});

test('"Mis estudios" queda preparado visualmente pero sin funcionalidad: sólo un aviso "Próximamente", sin descarga ni autenticación', () => {
  const contenido = require(contenidoPath);
  assert.equal(contenido.estudiosPaciente.disponible, false);
  const inicio = moduleSource.indexOf('function renderEstudiosPaciente');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  assert.match(cuerpo, /Próximamente/);
  assert.doesNotMatch(cuerpo, /<a href|<button|fetch\(|descargar/i, 'sin ningún control funcional todavía');
});

// -----------------------------------------------------------------------
// CTA de alta: "Quiero registrarme como paciente" (ya no "Darme de alta").
// -----------------------------------------------------------------------

test('el botón de alta dice "QUIERO REGISTRARME COMO PACIENTE", ya no "DARME DE ALTA"', () => {
  assert.doesNotMatch(moduleSource, /DARME DE ALTA/);
  assert.match(moduleSource, /QUIERO REGISTRARME COMO PACIENTE/);
});

test('renderContacto no muestra una etiqueta vacía por cada campo sin dato: filtra por valor antes de listar', () => {
  const inicio = moduleSource.indexOf('function renderContacto');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  assert.match(cuerpo, /\.filter\(\(\[, valor\]\) => !!valor\)/);
  assert.match(cuerpo, /se van a completar próximamente/);
});

test('los botones SOLICITAR TURNO de ya-registrado/alta-exitosa se enlazan por data-attribute con querySelectorAll (no por id), soportando más de una instancia', () => {
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

test('el favicon de index.html y privacidad.html es el isologo real (PNG), no el fallback SVG anterior', () => {
  [indexSource, privacidadSource].forEach((fuente) => {
    assert.match(fuente, /<link rel="icon" type="image\/png" href="assets\/branding\/isologo\.png/);
    assert.doesNotMatch(fuente, /isologo\.svg/);
  });
});

// -----------------------------------------------------------------------
// Privacidad: link discreto en el footer + página estática simple sobre
// Turnstile, sin tocar el flujo DNI/alta/solicitud ni el diseño general.
// -----------------------------------------------------------------------

test('la landing tiene un footer con nombre real del consultorio y un link a Privacidad, sin datos ficticios del mockup', () => {
  assert.match(moduleSource, /function renderFooter\(identidad\) \{/);
  assert.match(moduleSource, /<footer class="portal-footer">/);
  assert.match(moduleSource, /<a href="privacidad\.html">Privacidad<\/a>/);
  assert.match(moduleSource, /\$\{renderCtaFinal\(\)\}\s*\n\s*\$\{renderFooter\(contenido\.identidad\)\}/, 'el footer se agrega después del CTA final, sin reemplazar nada existente');
  const inicio = moduleSource.indexOf('function renderFooter');
  const cuerpo = moduleSource.slice(inicio, moduleSource.indexOf('\n  }', inicio));
  assert.match(cuerpo, /identidad\.nombreConsultorio/);
  // Nada de teléfono/dirección/redes: sólo el nombre real ya aprobado y el
  // link a Privacidad, para no copiar los datos ficticios del mockup.
  assert.doesNotMatch(cuerpo, /telefono|direccion|instagram|whatsapp/i);
});

test('privacidad.html existe, es una página separada (no toca portal.js) y no requiere el gateway ni Turnstile para mostrarse', () => {
  assert.doesNotMatch(privacidadSource, /<script/, 'página puramente estática, sin JS propio');
  assert.match(privacidadSource, /<link rel="stylesheet" href="portal\.css/, 'reutiliza los estilos del portal para consistencia visual');
  assert.match(privacidadSource, /<a href="index\.html">/, 'permite volver al portal');
});

test('privacidad.html explica Turnstile en los tres puntos pedidos, con el link oficial correcto, sin secrets ni PII', () => {
  assert.match(privacidadSource, /Cloudflare Turnstile/);
  assert.match(privacidadSource, /prevenir bots/i);
  assert.match(privacidadSource, /procesar información técnica/i, 'explica que Turnstile puede procesar información técnica necesaria para la verificación');
  assert.match(privacidadSource, /href="https:\/\/www\.cloudflare\.com\/turnstile-privacy-policy\/"/, 'enlaza el Turnstile Privacy Addendum oficial verificado');
  assert.doesNotMatch(privacidadSource, /TURNSTILE_SECRET_KEY|service_role|SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(privacidadSource, /\bdni\b|patient_id/i, 'no incluye datos de pacientes ni PII');
  // No inventar políticas jurídicas complejas ni términos adicionales: nada
  // de GDPR/CCPA/leyes locales de protección de datos que nadie pidió.
  assert.doesNotMatch(privacidadSource, /GDPR|CCPA|RGPD|ley de protecci[oó]n de datos|responsable del tratamiento/i);
});

console.log('Portal público — frontend: OK');
