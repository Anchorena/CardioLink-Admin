// CardioLink Admin — Comunicaciones V1.2, Bloque B1 · Edge Function
// "appointment-cancellation-public"
//
// NO DESPLEGADA TODAVÍA — código listo para revisión y para
// `supabase functions deploy appointment-cancellation-public` cuando se
// decida (STAGING primero, nunca Production sin aprobación explícita).
//
// Único propósito: permitir que un paciente cancele su propio turno desde
// el enlace de un email, sin ningún login de CardioLink. La autorización
// NO es un JWT de Supabase (verify_jwt=false en supabase/config.toml, ver
// esa entrada): es EXCLUSIVAMENTE el token HMAC firmado server-side por
// patient-communications al componer la confirmación (todavía no conectado
// - eso es Bloque B2), verificado acá con
// _shared/token-cancelacion.js#verificarTokenCancelacion.
//
// Función COMPLETAMENTE NUEVA y separada de portal-gateway a propósito
// (decisión de Bloque B0): portal-gateway sigue exactamente igual, sin
// redeploy, sin ninguna acción nueva, sin riesgo agregado sobre alta
// pública / solicitudes de turno ya aprobadas. Menor blast radius, QA y
// rollback independientes.
//
// Dos acciones, ambas POST:
//   - info:      valida el token, devuelve sólo los datos administrativos
//                mínimos para que la página pública muestre qué turno se
//                va a cancelar. NUNCA escribe nada en ningún caso.
//   - confirmar: vuelve a validar el token desde cero (nunca confía en que
//                "info" ya lo validó antes), relee el estado actual del
//                turno, y sólo si todo coincide ejecuta la cancelación con
//                UPDATE condicionado por updated_at (concurrencia
//                optimista) - nunca un SELECT -> modificar -> UPDATE ciego.
//
// Nunca expone: DNI, teléfono, email, HC, observaciones, datos
// financieros, pacienteId ni el payload completo de la atención - sólo
// paciente/fecha/horaInicio/prestación/profesional, lo mínimo para que el
// paciente reconozca su propio turno.
//
// Esta función NUNCA tiene (ni debe tener en el futuro) una acción para
// EMITIR tokens: sólo los verifica. Emitir un token de cancelación es
// responsabilidad exclusiva de patient-communications, que corre
// autenticado (JWT + cardiolink_has_communications_access()).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { verificarTokenCancelacion } from '../_shared/token-cancelacion.js';

// -----------------------------------------------------------------------
// CORS: mismo patrón restrictivo ya usado por portal-gateway y
// patient-communications (nunca "*"): el origen permitido sale de una env
// var propia (lista separada por comas) más localhost/127.0.0.1/::1
// siempre permitido para poder probar contra Staging desde acá. CORS es
// sólo una capa extra de higiene en el navegador - la autorización real es
// el token verificado en cada acción, nunca el origin de la request.
// -----------------------------------------------------------------------

const PREFIJOS_ORIGEN_LOCAL_SIEMPRE_PERMITIDO = ['http://localhost', 'http://127.0.0.1', 'http://[::1]'];

function esOrigenLocal(origen) {
  return PREFIJOS_ORIGEN_LOCAL_SIEMPRE_PERMITIDO.some((prefijo) => origen === prefijo || origen.startsWith(prefijo + ':'));
}

function origenesPermitidosConfigurados() {
  // Lista separada por comas: el portal público real (GitHub Pages hoy,
  // dominio propio de CardioLink cuando exista) - ver docs/PORTAL_PUBLICO_HARDENING_V1.md
  // para el mismo criterio ya aplicado a portal-gateway.
  const valor = Deno.env.get('APPOINTMENT_CANCELLATION_ALLOWED_ORIGINS') || '';
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

// `codigo` es un código LÓGICO estable para que la página pública decida
// qué mostrar (ej. "appointment_changed") - nunca un detalle técnico ni
// criptográfico. `mensaje` es siempre texto ya seguro para mostrar tal
// cual al paciente.
function errorResponse(mensaje, status, corsHeaders, codigo) {
  const cuerpo = { ok: false, error: mensaje };
  if (codigo) cuerpo.codigo = codigo;
  return jsonResponse(cuerpo, status || 400, corsHeaders);
}

function logErrorSeguro(accion, error) {
  const codigo = error && error.code ? String(error.code) : 'desconocido';
  console.error('appointment-cancellation-public error', accion, codigo);
}

function clienteAdmin() {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceRoleKey) throw new Error('Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.');
  return createClient(url, serviceRoleKey, { auth: { persistSession: false } });
}

async function verificarToken(token) {
  const secret = Deno.env.get('APPOINTMENT_CANCEL_TOKEN_SECRET');
  if (!secret) return { ok: false, motivo: 'Servicio no disponible en este momento.' };
  return verificarTokenCancelacion(token, secret);
}

// cardiolink_atenciones guarda, además de las atenciones reales, UNA fila
// técnica de configuración completa de app.js (id fijo, payload
// {tipoRegistro:'config', config:{...profesionales, especialidades,
// TODO lo demás...}} - ver guardarConfigEnSupabase298() en app.js). Esta
// función pública JAMÁS debe poder leer ni, mucho menos, escribir esa fila
// - ni por accidente de un token corrupto/forjado (imposible sin el
// secret, pero se valida igual, en profundidad) ni por ningún otro camino.
const ID_FILA_CONFIG = '__cardiolink_config_v1';

// Un payload real de atención SIEMPRE tiene fecha/horaInicio (son
// obligatorios en el flujo de carga de turno de app.js); el de
// configuración nunca los tiene y en cambio trae tipoRegistro==='config'.
// Se valida EXPLÍCITAMENTE antes de operar - no alcanza con que
// coincideFechaHora() falle "por las dudas" más abajo: acá se corta de
// raíz con un motivo claro, sin llegar siquiera a comparar contra el
// token.
function esPayloadDeAtencion(payload) {
  return !!payload && typeof payload === 'object'
    && payload.tipoRegistro !== 'config'
    && typeof payload.fecha === 'string'
    && typeof payload.horaInicio === 'string';
}

// Trae payload + updated_at JUNTOS, en la misma lectura - updated_at es la
// base de la actualización condicionada de más abajo (concurrencia
// optimista): nunca se separa la lectura de la que se usa para el UPDATE.
// Nunca opera sobre ID_FILA_CONFIG ni sobre ninguna fila cuyo payload no
// tenga forma de atención real (ver esPayloadDeAtencion) - devuelve null
// en ambos casos, exactamente como "no se encontró el turno".
async function obtenerAtencionConVersion(admin, atencionId) {
  const idLimpio = String(atencionId || '');
  if (!idLimpio || idLimpio === ID_FILA_CONFIG) return null;
  const { data, error } = await admin
    .from('cardiolink_atenciones')
    .select('id, payload, updated_at')
    .eq('id', idLimpio)
    .limit(1);
  if (error) throw error;
  if (!data || !data.length) return null;
  const fila = data[0];
  if (!esPayloadDeAtencion(fila.payload)) return null;
  return fila;
}

function coincideFechaHora(atencion, payloadToken) {
  return String(atencion.fecha || '') === String(payloadToken.fecha || '')
    && String(atencion.horaInicio || '') === String(payloadToken.horaInicio || '');
}

const MENSAJE_TURNO_MODIFICADO = 'Este turno fue modificado después de enviarse este mensaje. Comunicate con el consultorio o revisá la información actualizada.';

// Estados sobre los que esta acción pública nunca debe poder actuar (ya
// sucedieron o ya se resolvieron de otra forma) - mismo vocabulario que
// ESTADOS_AGENDA en app.js, sin duplicar esa lógica, sólo los dos estados
// relevantes para decidir "esto ya no es cancelable desde acá".
const ESTADOS_NO_CANCELABLES = ['atendido', 'ausente'];

async function manejarInfo(admin, body, corsHeaders) {
  const verificacion = await verificarToken(body && body.token);
  if (!verificacion.ok) return errorResponse('No se pudo validar el enlace.', 400, corsHeaders, 'invalid_token');

  const fila = await obtenerAtencionConVersion(admin, verificacion.payload.atencionId);
  if (!fila || !fila.payload) return errorResponse('No se encontró el turno.', 404, corsHeaders, 'not_found');
  const atencion = fila.payload;

  if (!coincideFechaHora(atencion, verificacion.payload)) {
    return errorResponse(MENSAJE_TURNO_MODIFICADO, 409, corsHeaders, 'appointment_changed');
  }

  const estadoActual = String(atencion.estadoTurno || '');
  const cancelable = estadoActual !== 'cancelado' && !ESTADOS_NO_CANCELABLES.includes(estadoActual);

  // Sólo campos administrativos mínimos - nunca DNI/teléfono/email/HC/
  // observaciones/datos financieros/pacienteId/payload completo.
  return jsonResponse({
    ok: true,
    paciente: atencion.paciente || '',
    fecha: atencion.fecha || '',
    horaInicio: atencion.horaInicio || '',
    prestacion: atencion.prestacion || '',
    profesional: atencion.profesional || '',
    yaCancelado: estadoActual === 'cancelado',
    cancelable
  }, 200, corsHeaders);
}

const MOTIVO_MAX_LARGO = 300;

function limpiarMotivo(valor) {
  if (typeof valor !== 'string') return '';
  // Texto plano únicamente: se recortan saltos de línea/tabs a espacio y
  // se trunca a un largo razonable - nunca se interpreta como HTML en
  // ningún punto de este flujo (ni acá, ni al guardarlo, ni al mostrarlo
  // luego en el pendiente de Secretaría, que renderiza texto, no HTML).
  return valor.replace(/[\r\n\t]+/g, ' ').trim().slice(0, MOTIVO_MAX_LARGO);
}

async function manejarConfirmar(admin, body, corsHeaders) {
  const verificacion = await verificarToken(body && body.token);
  if (!verificacion.ok) return errorResponse('No se pudo validar el enlace.', 400, corsHeaders, 'invalid_token');

  const motivo = limpiarMotivo(body && body.motivo);

  // Hasta 2 intentos: el segundo sólo se usa si el primer UPDATE
  // condicionado no matcheó ninguna fila (alguien más escribió esta MISMA
  // atención justo en el medio) - nunca se reintenta ciego con el mismo
  // updated_at viejo, se relee todo desde cero y se reevalúa.
  for (let intento = 0; intento < 2; intento++) {
    const fila = await obtenerAtencionConVersion(admin, verificacion.payload.atencionId);
    if (!fila || !fila.payload) return errorResponse('No se encontró el turno.', 404, corsHeaders, 'not_found');
    const atencion = fila.payload;

    if (!coincideFechaHora(atencion, verificacion.payload)) {
      return errorResponse(MENSAJE_TURNO_MODIFICADO, 409, corsHeaders, 'appointment_changed');
    }

    const estadoActual = String(atencion.estadoTurno || '');

    // Idempotencia: ya cancelado por ESTE mismo canal -> éxito sin tocar
    // timestamps, sin cambiar motivo, sin reabrir el pendiente.
    if (estadoActual === 'cancelado' && atencion.canceladoPor === 'Paciente (email)') {
      return jsonResponse({ ok: true, yaCancelado: true }, 200, corsHeaders);
    }
    // Ya cancelado por otro origen (Secretaría/profesional/otro canal):
    // nunca se pisa canceladoPor ni motivoCancelacion ya existentes.
    if (estadoActual === 'cancelado') {
      return errorResponse('Este turno ya no está disponible para esta acción.', 409, corsHeaders, 'already_cancelled_elsewhere');
    }
    if (ESTADOS_NO_CANCELABLES.includes(estadoActual)) {
      return errorResponse('Este turno ya no puede cancelarse desde este enlace.', 409, corsHeaders, 'not_cancellable');
    }

    const ahora = new Date().toISOString();
    // Se conserva TODO el payload existente (Object.assign sobre una copia)
    // y se cambia únicamente lo que corresponde a esta cancelación - nunca
    // se toca seña (seniaPagada/seniaMonto/seniaFormaPago/seniaRegistradaEn):
    // Secretaría la revisa al resolver el pendiente (Bloque B3).
    const payloadActualizado = Object.assign({}, atencion, {
      estadoTurno: 'cancelado',
      motivoCancelacion: motivo || 'Cancelado por el paciente',
      canceladoEn: ahora,
      canceladoPor: 'Paciente (email)',
      estadoTurnoEditadoPor: 'Paciente (email)',
      estadoTurnoEditadoEn: ahora,
      // Explícito siempre en `false` en una cancelación nueva: si este
      // mismo atencionId ya había tenido un pendiente de cancelación
      // resuelto antes (reprogramado y vuelto a cancelar más adelante,
      // por ejemplo), un `true` viejo ocultaría esta cancelación nueva del
      // lado de Secretaría (Bloque B3).
      pendienteCancelacionResuelto: false
    });

    // Concurrencia optimista real (no SELECT -> modificar -> UPDATE
    // ciego): el UPDATE sólo aplica si updated_at sigue siendo el mismo
    // que se acaba de leer. select('id') después del update devuelve las
    // filas realmente afectadas - un array vacío significa que la
    // condición no matcheó ninguna fila (alguien más escribió esta
    // atención en el medio), nunca que hubo un error.
    const { data: actualizadas, error: updateError } = await admin
      .from('cardiolink_atenciones')
      .update({ payload: payloadActualizado, updated_at: ahora })
      .eq('id', String(verificacion.payload.atencionId))
      .eq('updated_at', fila.updated_at)
      .select('id');
    if (updateError) throw updateError;

    if (Array.isArray(actualizadas) && actualizadas.length) {
      return jsonResponse({ ok: true, cancelado: true }, 200, corsHeaders);
    }
    // 0 filas actualizadas: concurrencia real. El for reintenta UNA vez
    // más, releyendo todo desde cero (no reutiliza `fila`/`atencion` de
    // este intento).
  }

  return errorResponse('No se pudo confirmar la cancelación por un cambio simultáneo. Volvé a intentar en unos segundos.', 409, corsHeaders, 'concurrent_conflict');
}

Deno.serve(async function (req) {
  const corsHeaders = corsHeadersPara(req.headers.get('origin') || '');

  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return errorResponse('Método no permitido.', 405, corsHeaders);

  let body;
  try {
    body = await req.json();
  } catch (_error) {
    return errorResponse('Cuerpo inválido.', 400, corsHeaders);
  }

  const accion = String(body && body.action || '');
  // Log mínimo, sin PII: nunca el token, nunca datos del paciente.
  console.log('appointment-cancellation-public', accion);

  try {
    const admin = clienteAdmin();
    if (accion === 'info') return await manejarInfo(admin, body, corsHeaders);
    if (accion === 'confirmar') return await manejarConfirmar(admin, body, corsHeaders);
    return errorResponse('Acción no reconocida.', 400, corsHeaders);
  } catch (error) {
    logErrorSeguro(accion, error);
    return errorResponse('No se pudo completar la operación. Probá de nuevo en un momento.', 500, corsHeaders);
  }
});
