// CardioLink Admin — Portal Público V1 · Edge Function "portal-gateway"
//
// Único gateway público hacia cardiolink_pacientes / cardiolink_appointment_requests.
// El portal público (portal/portal.js) nunca toca Supabase directamente: sólo
// llama a esta función. NO DESPLEGADA TODAVÍA — código listo para revisión y
// para `supabase functions deploy portal-gateway` cuando se decida.
//
// service_role vive exclusivamente acá, como secret server-side (variable de
// entorno SUPABASE_SERVICE_ROLE_KEY de la Edge Function). Nunca se envía al
// navegador ni se referencia desde portal/.
//
// Esta función nunca devuelve patient_id, nombre, teléfono, email, cobertura,
// fecha de nacimiento, HC ni turnos anteriores al llamador. Sólo booleanos
// (existe / ok / error) y, cuando corresponde, un mensaje de error genérico.
//
// No modifica las policies actuales de cardiolink_pacientes ni de ninguna
// otra tabla: usa service_role, que ya bypasea RLS por diseño de Supabase.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import {
  validarDni,
  validarAlta,
  validarSolicitud,
  construirNombreCompleto,
  generarIdPaciente
} from './logica.js';

// -----------------------------------------------------------------------
// CORS: nunca queda fijo en "*" en Producción. El origen permitido se
// arma en cada request a partir de PORTAL_ALLOWED_ORIGINS (env var, lista
// separada por comas, con el/los dominio(s) publicados reales) más,
// siempre, cualquier origen localhost/127.0.0.1/::1 (para poder probar
// contra Staging desde acá, en cualquier puerto). Si el origen de la
// request no queda permitido, no se devuelve Access-Control-Allow-Origin:
// el navegador bloquea la respuesta del lado del cliente.
// -----------------------------------------------------------------------

const PREFIJOS_ORIGEN_LOCAL_SIEMPRE_PERMITIDO = ['http://localhost', 'http://127.0.0.1', 'http://[::1]'];

function esOrigenLocal(origen) {
  return PREFIJOS_ORIGEN_LOCAL_SIEMPRE_PERMITIDO.some((prefijo) => origen === prefijo || origen.startsWith(prefijo + ':'));
}

function origenesPermitidosConfigurados() {
  const valor = Deno.env.get('PORTAL_ALLOWED_ORIGINS') || '';
  return valor.split(',').map((o) => o.trim()).filter(Boolean);
}

function corsHeadersPara(origen) {
  const headers = {
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin'
  };
  const permitido = !!origen && (esOrigenLocal(origen) || origenesPermitidosConfigurados().includes(origen));
  if (permitido) headers['Access-Control-Allow-Origin'] = origen;
  return headers;
}

function jsonResponse(cuerpo, status, corsHeaders) {
  return new Response(JSON.stringify(cuerpo), {
    status: status || 200,
    headers: Object.assign({}, corsHeaders, { 'Content-Type': 'application/json' })
  });
}

function errorResponse(mensaje, status, corsHeaders) {
  return jsonResponse({ ok: false, error: mensaje }, status || 400, corsHeaders);
}

// -----------------------------------------------------------------------
// Turnstile: verificación server-side obligatoria para check-dni, registro
// y solicitud-turno. El secret vive únicamente acá, como
// Deno.env.get('TURNSTILE_SECRET_KEY') — nunca en el frontend ni en el
// repositorio. Sin secret configurado se rechaza (fail-closed): no existe
// un modo "sin Turnstile" válido para estas tres acciones.
//
// Modo QA aislado en Staging: configurar TURNSTILE_SECRET_KEY en el
// proyecto de Staging con la clave secreta de test pública que documenta
// Cloudflare ("always passes": 1x0000000000000000000000000000000AA —
// https://developers.cloudflare.com/turnstile/troubleshooting/testing/),
// emparejada con la sitekey pública equivalente que ya usa portal.js en
// local. Producción usa la clave secreta real de un sitio Turnstile
// registrado. El código de verificación es el mismo en los dos casos: lo
// que cambia es sólo la env var, nunca una rama de código que salte la
// verificación.
// -----------------------------------------------------------------------

async function verificarTurnstile(token, ip) {
  const secret = Deno.env.get('TURNSTILE_SECRET_KEY');
  if (!secret) return { ok: false, motivo: 'sin-configurar' };
  if (!token || typeof token !== 'string' || token.length > 2048) return { ok: false, motivo: 'token-invalido' };

  try {
    const cuerpo = new URLSearchParams();
    cuerpo.append('secret', secret);
    cuerpo.append('response', token);
    if (ip) cuerpo.append('remoteip', ip);
    const respuesta = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: cuerpo
    });
    const resultado = await respuesta.json();
    return { ok: !!(resultado && resultado.success === true), motivo: resultado && resultado.success ? '' : 'rechazado' };
  } catch (_error) {
    return { ok: false, motivo: 'error-verificacion' };
  }
}

// Nunca loguea el error completo (error.message/details puede traer datos
// reales — por ejemplo, un unique_violation de Postgres incluye el valor
// duplicado en el texto). Sólo el código de error, si existe.
function logErrorSeguro(accion, error) {
  const codigo = error && error.code ? String(error.code) : 'desconocido';
  console.error('portal-gateway error', accion, codigo);
}

// La solicitud de turno ya no permite elegir profesional (se asigna después
// dentro de CardioLink Admin) ni pide teléfono (se resuelve server-side
// desde el paciente): sólo queda prestación, validada contra este catálogo
// cerrado. Mismos nombres, en el mismo orden, que
// portal/contenido-publico.js → prestaciones (un test cruza ambos archivos
// para detectar que se desincronicen). Aislado acá a propósito para poder
// reemplazarlo después por una consulta real a la configuración de
// CardioLink, sin tocar el resto del gateway.
const PRESTACIONES_PUBLICAS_V1 = Object.freeze([
  'Consulta',
  'Holter 24 h',
  'MAPA',
  'Ergometría',
  'Ecocardiograma'
]);

function clienteAdmin() {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceRoleKey) {
    throw new Error('Faltan las variables de entorno SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.');
  }
  return createClient(url, serviceRoleKey, { auth: { persistSession: false } });
}

async function buscarPacientePorDni(admin, dniNormalizado) {
  const resultado = await admin
    .from('cardiolink_pacientes')
    .select('id')
    .eq('dni_normalizado', dniNormalizado)
    .limit(1);
  if (resultado.error) throw resultado.error;
  const filas = resultado.data;
  return Array.isArray(filas) && filas.length ? filas[0].id : null;
}

// Sólo para solicitud-turno: además del id, trae el teléfono ya guardado en
// el alta. Ninguna otra acción del gateway necesita el teléfono, así que
// ninguna otra selecciona esa columna (menor exposición por código, aunque
// service_role igual pueda leerla).
async function buscarPacienteParaSolicitud(admin, dniNormalizado) {
  const resultado = await admin
    .from('cardiolink_pacientes')
    .select('id, telefono')
    .eq('dni_normalizado', dniNormalizado)
    .limit(1);
  if (resultado.error) throw resultado.error;
  const filas = resultado.data;
  return Array.isArray(filas) && filas.length ? filas[0] : null;
}

async function manejarCheckDni(admin, body, corsHeaders) {
  const resultado = validarDni(body ? body.dni : null);
  if (!resultado.valido) return errorResponse(resultado.error, 400, corsHeaders);
  const existente = await buscarPacientePorDni(admin, resultado.dni);
  return jsonResponse({ ok: true, existe: !!existente }, 200, corsHeaders);
}

async function manejarRegistro(admin, body, corsHeaders) {
  const validacion = validarAlta(body);
  if (!validacion.valido) return errorResponse(validacion.errores.join(' '), 400, corsHeaders);
  const datos = validacion.datos;

  const existente = await buscarPacientePorDni(admin, datos.dni);
  if (existente) {
    // Ya existía (registrado antes, o alguien ganó una carrera contra este
    // mismo alta): no se crea un paciente nuevo, no se devuelve el id.
    return jsonResponse({ ok: true, existente: true }, 200, corsHeaders);
  }

  const fila = {
    id: generarIdPaciente(function () { return crypto.randomUUID(); }),
    nombre_completo: construirNombreCompleto(datos.nombre, datos.apellido),
    dni: datos.dni,
    telefono: datos.telefono,
    email: datos.email || null,
    fecha_nacimiento: datos.fechaNacimiento,
    sexo: null,
    localidad: null,
    direccion: null,
    provincia: null,
    cobertura_habitual: datos.coberturaHabitual || null,
    numero_afiliado_habitual: datos.numeroAfiliado || null,
    contacto_responsable_nombre: null,
    contacto_responsable_relacion: null,
    contacto_responsable_telefono: null,
    contacto_responsable_email: null,
    activo: true,
    actualizado_en: new Date().toISOString()
  };

  const insercion = await admin.from('cardiolink_pacientes').insert(fila);
  if (insercion.error) {
    // 23505 = unique_violation en dni_normalizado: carrera contra otra
    // solicitud simultánea con el mismo DNI. No es un error real: se
    // reutiliza el paciente que ganó la carrera, sin crear uno duplicado.
    if (insercion.error.code === '23505') {
      const idExistente = await buscarPacientePorDni(admin, datos.dni);
      if (idExistente) return jsonResponse({ ok: true, existente: true }, 200, corsHeaders);
    }
    throw insercion.error;
  }

  return jsonResponse({ ok: true, existente: false }, 200, corsHeaders);
}

async function manejarSolicitud(admin, body, corsHeaders) {
  const validacion = validarSolicitud(body);
  if (!validacion.valido) return errorResponse(validacion.errores.join(' '), 400, corsHeaders);
  const datos = validacion.datos;

  if (!PRESTACIONES_PUBLICAS_V1.includes(datos.prestacion)) {
    return errorResponse('La prestación seleccionada no es válida.', 400, corsHeaders);
  }

  // El teléfono nunca viaja en la solicitud (se pidió una única vez en el
  // alta): se resuelve acá, server-side, desde el paciente ya guardado.
  // Tampoco se acepta un patient_id del cliente: siempre se busca por DNI.
  const paciente = await buscarPacienteParaSolicitud(admin, datos.dni);
  if (!paciente) {
    return errorResponse('No encontramos tu registro. Volvé a darte de alta antes de solicitar un turno.', 404, corsHeaders);
  }
  if (!paciente.telefono) {
    return errorResponse('Tu registro no tiene un teléfono guardado. Contactá al consultorio directamente.', 409, corsHeaders);
  }

  // Protección básica contra envíos repetidos (doble tap, reintento de red):
  // si ya hay una solicitud 'new' muy reciente del mismo paciente, no se crea
  // una segunda; se responde como si se hubiera creado.
  const haceDosMinutos = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const recientes = await admin
    .from('cardiolink_appointment_requests')
    .select('id')
    .eq('patient_id', paciente.id)
    .eq('status', 'new')
    .gte('created_at', haceDosMinutos)
    .limit(1);
  if (recientes.error) throw recientes.error;
  if (Array.isArray(recientes.data) && recientes.data.length) {
    return jsonResponse({ ok: true, duplicada: true }, 200, corsHeaders);
  }

  const insercion = await admin.from('cardiolink_appointment_requests').insert({
    patient_id: paciente.id,
    // Sin selección de profesional en el portal: la asignación queda para
    // después, dentro de CardioLink Admin.
    requested_professional_id: null,
    requested_professional_name: null,
    requested_service: datos.prestacion,
    // Cobertura de ESTA solicitud puntual, nunca la habitual del paciente:
    // nunca se toca cardiolink_pacientes.cobertura_habitual acá.
    requested_coverage: datos.cobertura,
    // Sin texto libre público.
    message: null,
    contact_phone: paciente.telefono,
    contact_email: null,
    source: datos.source,
    status: 'new'
  });
  if (insercion.error) throw insercion.error;

  return jsonResponse({ ok: true, duplicada: false }, 200, corsHeaders);
}

// Acciones protegidas por Turnstile: las tres únicas que escriben o
// consultan datos de pacientes. "catalogo"/contenido público estático no
// existe como acción de este gateway (vive en portal/contenido-publico.js,
// sin red), así que no hay ninguna otra acción que proteger acá.
const ACCIONES_PROTEGIDAS_TURNSTILE = ['check-dni', 'registro', 'solicitud-turno'];

Deno.serve(async function (req) {
  const origen = req.headers.get('origin') || '';
  const corsHeaders = corsHeadersPara(origen);

  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return errorResponse('Método no permitido.', 405, corsHeaders);

  let body;
  try {
    body = await req.json();
  } catch (_error) {
    return errorResponse('Cuerpo inválido.', 400, corsHeaders);
  }

  const accion = String(body && body.action || '');
  // Log mínimo, sin PII: nunca DNI, nombre, teléfono, email ni mensaje.
  console.log('portal-gateway', accion);

  if (ACCIONES_PROTEGIDAS_TURNSTILE.includes(accion)) {
    const ip = req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || '';
    const verificacion = await verificarTurnstile(body && body.turnstileToken, ip);
    if (!verificacion.ok) {
      return errorResponse('No se pudo verificar que sos una persona. Probá de nuevo.', 403, corsHeaders);
    }
  }

  try {
    const admin = clienteAdmin();
    if (accion === 'check-dni') return await manejarCheckDni(admin, body, corsHeaders);
    if (accion === 'registro') return await manejarRegistro(admin, body, corsHeaders);
    if (accion === 'solicitud-turno') return await manejarSolicitud(admin, body, corsHeaders);
    return errorResponse('Acción no reconocida.', 400, corsHeaders);
  } catch (error) {
    logErrorSeguro(accion, error);
    return errorResponse('No se pudo completar la operación. Probá de nuevo en un momento.', 500, corsHeaders);
  }
});
