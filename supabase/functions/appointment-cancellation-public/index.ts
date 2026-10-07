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
// Bloque B4: se reutiliza EXCLUSIVAMENTE la selección de destinatario ya
// existente (resolverDestinatarios/emailValido) - misma lógica que ya usa
// patient-communications, nunca una segunda forma de elegir a quién
// escribirle. El texto de este email es propio de esta función (la
// confirmación de cancelación iniciada por el paciente es un caso distinto
// del aviso de cancelación que dispara Secretaría vía armarMensaje), así
// que no se toca ni se reutiliza armarMensaje/PLANTILLAS_RESPALDO para esto.
import { resolverDestinatarios, emailValido } from '../_shared/comunicaciones-logica.js';

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

// -----------------------------------------------------------------------
// Bloque B4: email automático de confirmación al paciente, inmediatamente
// DESPUÉS de que el UPDATE de la cancelación ya se confirmó (ver
// manejarConfirmar). Nunca se llama antes del UPDATE exitoso, y un fallo
// acá jamás debe revertir ni tocar de nuevo la cancelación ya guardada -
// por eso toda esta sección sólo registra el resultado (sent/failed) y
// nunca lanza hacia manejarConfirmar.
// -----------------------------------------------------------------------

// Mismo criterio exacto que patient-communications#obtenerPaciente (sin
// duplicar esa función entre Edge Functions distintas, mismo patrón ya
// establecido para helpers chicos de este tipo en el proyecto).
async function obtenerPacienteParaCancelacion(admin, pacienteId) {
  if (!pacienteId) return null;
  const { data, error } = await admin
    .from('cardiolink_pacientes')
    .select('id, nombre_completo, email, telefono, contacto_responsable_nombre, contacto_responsable_telefono, contacto_responsable_email')
    .eq('id', String(pacienteId))
    .limit(1);
  if (error) return null; // nunca bloquea la confirmación de cancelación por esto
  return data && data.length ? data[0] : null;
}

function formatearFechaCortaB4(fechaISO) {
  const m = String(fechaISO || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(fechaISO || '');
  return `${m[3]}/${m[2]}/${m[1]}`;
}

// Texto exacto pedido para este email - sin botón de cancelación (el turno
// ya está cancelado), sin HTML, sólo texto plano.
function armarEmailConfirmacionCancelacion(atencion) {
  const paciente = (atencion && atencion.paciente) || 'paciente';
  const fecha = atencion && atencion.fecha ? formatearFechaCortaB4(atencion.fecha) : '';
  const hora = (atencion && atencion.horaInicio) || '';
  const profesional = (atencion && atencion.profesional) || '';
  const mensaje = `Hola ${paciente}:\n\nTe confirmamos que el turno del ${fecha} a las ${hora}, con ${profesional}, fue cancelado correctamente a solicitud tuya.\n\nSi necesitás solicitar un nuevo turno o reprogramarlo, podés comunicarte por WhatsApp al número del consultorio o acercarte personalmente.\n\nMuchas gracias.\n\nCardioLink\nPlataforma integral de gestión médica`;
  return { asunto: 'Tu turno fue cancelado', mensaje };
}

// Copia local mínima de enviarConResend (mismo patrón ya usado: cada Edge
// Function que envía email tiene su propia copia chica de este helper -
// ver patient-communications/patient-reminders-24h). Sólo texto, sin html
// ni adjuntos: este email nunca lleva botón ni enlace de cancelación.
async function enviarConResend(destinatario, asunto, mensaje) {
  const apiKey = Deno.env.get('RESEND_API_KEY');
  const remitente = Deno.env.get('RESEND_FROM_EMAIL');
  if (!apiKey || !remitente) {
    return { ok: false, motivo: 'Proveedor de email no configurado.' };
  }
  try {
    const respuesta = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: remitente, to: [destinatario], subject: asunto, text: mensaje })
    });
    const cuerpo = await respuesta.json().catch(() => ({}));
    if (!respuesta.ok) {
      return { ok: false, motivo: (cuerpo && cuerpo.message) ? String(cuerpo.message).slice(0, 300) : `Resend respondió ${respuesta.status}.` };
    }
    return { ok: true, providerMessageId: cuerpo && cuerpo.id ? String(cuerpo.id) : null };
  } catch (_error) {
    return { ok: false, motivo: 'No se pudo contactar al proveedor de email.' };
  }
}

// Se llama UNA sola vez, exclusivamente desde la rama de éxito real del
// UPDATE condicionado (nunca desde la rama yaCancelado). Nunca lanza: lo
// peor que puede pasar es que no se registre nada y quede sólo el log
// seguro - la cancelación en sí ya quedó confirmada antes de llegar acá.
async function notificarCancelacionAlPaciente(admin, atencionActualizada, atencionId) {
  try {
    const paciente = await obtenerPacienteParaCancelacion(admin, atencionActualizada.pacienteId);
    const contacto = resolverDestinatarios(atencionActualizada, paciente);
    if (!emailValido(contacto.email || '')) return; // sin canal cargado: no es un error, no hay nada que enviar

    const { asunto, mensaje } = armarEmailConfirmacionCancelacion(atencionActualizada);
    const resultado = await enviarConResend(contacto.email, asunto, mensaje);

    await admin.from('cardiolink_communications').insert({
      paciente_id: contacto.pacienteId || null,
      atencion_id: atencionId,
      tipo: 'cancellation',
      canal: 'email',
      destinatario: contacto.email,
      recipient_source: contacto.emailFuente,
      recipient_name: contacto.emailNombre || null,
      subject: asunto,
      message: mensaje,
      status: resultado.ok ? 'sent' : 'failed',
      provider: 'resend',
      provider_message_id: resultado.ok ? resultado.providerMessageId : null,
      error_message: resultado.ok ? null : resultado.motivo,
      sent_at: resultado.ok ? new Date().toISOString() : null,
      // Sin usuario autenticado (función pública): mismo criterio ya
      // documentado para el proceso automático de patient-reminders-24h.
      created_by: null
    });
  } catch (error) {
    // Nunca debe afectar la respuesta de la cancelación ya confirmada -
    // ver manejarConfirmar: esta función nunca lanza hacia arriba.
    logErrorSeguro('notificar_cancelacion', error);
  }
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
      // Bloque B4: EXCLUSIVAMENTE acá, justo después del UPDATE ya
      // confirmado (nunca antes, nunca en la rama yaCancelado de arriba -
      // eso es lo que garantiza la idempotencia: un reintento sobre el
      // mismo turno ya cancelado por este canal nunca vuelve a pasar por
      // acá). Se espera (await) para que un error de red real quede
      // contenido dentro de notificarCancelacionAlPaciente - la función ya
      // no lanza nada hacia afuera, así que esto nunca puede convertir una
      // cancelación exitosa en un 500.
      await notificarCancelacionAlPaciente(admin, payloadActualizado, String(verificacion.payload.atencionId));
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
