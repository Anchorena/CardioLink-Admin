// CardioLink Admin — Patient Communications V1 · Edge Function "patient-communications"
//
// NO DESPLEGADA TODAVÍA — código listo para revisión y para
// `supabase functions deploy patient-communications` cuando se decida.
//
// Único punto de escritura de public.cardiolink_communications. El cliente
// (app.js, con sesión de un usuario autenticado real) nunca escribe esa
// tabla directamente: no tiene policy de INSERT/UPDATE para eso (ver
// supabase/migrations/20260828120000_cardiolink_communications_schema.sql).
// Esta función sí, usando service_role, que vive exclusivamente acá como
// secret server-side. Nunca se envía al navegador.
//
// Tres acciones:
//   - preview:      compone {asunto, mensaje} sin escribir nada. Para la
//                    vista previa del modal "¿Notificar al paciente?".
//   - send-email:    compone el mensaje (nunca confía en texto que mande el
//                    cliente), intenta enviarlo con el proveedor
//                    configurado (Resend en V1) y registra el resultado.
//   - log-whatsapp:  compone el mensaje, valida/normaliza el teléfono y
//                    registra que se inició un envío manual (wa.me). Esta
//                    función NUNCA abre WhatsApp: eso solo puede hacerlo el
//                    navegador del usuario, con el texto que devuelve acá.
//
// Autorización: valida el JWT del usuario que llama (Authorization header
// reenviado por supabaseClient.functions.invoke, que ya lo hace solo) y
// exige que pase public.cardiolink_has_communications_access() — mismo
// patrón que cardiolink_has_appointment_requests_access() (owner/admin/
// secretaria/medico activos). Sin ese chequeo, 403.
//
// No expone datos clínicos: sólo campos administrativos del turno
// (paciente, fecha, hora, profesional, prestación) e instrucciones
// configurables por prestación.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import {
  emailValido,
  elegirPlantilla,
  armarMensaje,
  resolverDestinatarios,
  armarMensajeProfesional,
  armarMensajeProfesionalDocumento
} from '../_shared/comunicaciones-logica.js';

// -----------------------------------------------------------------------
// CORS. Mismo patrón que portal-gateway/index.ts (esOrigenLocal +
// origenesPermitidosConfigurados + corsHeadersPara): nunca "*" fijo, el
// origen permitido se arma en cada request. localhost/127.0.0.1/::1 queda
// siempre permitido (así funciona el QA local contra Staging sin agregar
// nada); el resto sale de PATIENT_COMMUNICATIONS_ALLOWED_ORIGINS (env var,
// lista separada por comas) cuando se despliegue detrás de un dominio real.
// Esta función es autenticada (JWT + rol, ver autorizar() más abajo): CORS
// acá es una capa extra, no el mecanismo de autorización - no se toca esa
// lógica en absoluto.
//
// jsonResponse/errorResponse NO conocen los headers CORS (se calculan por
// request, a partir de su Origin - una variable de módulo compartida sería
// una condición de carrera entre requests concurrentes en el mismo
// worker). En cambio, Deno.serve envuelve cada Response con conCors() justo
// antes de devolverla: evita agregar un parámetro "corsHeaders" a cada
// función de negocio (manejarPreview/manejarSendEmail/manejarLogWhatsapp),
// que hubiera significado tocar su firma sin necesidad.
const PREFIJOS_ORIGEN_LOCAL_SIEMPRE_PERMITIDO = ['http://localhost', 'http://127.0.0.1', 'http://[::1]'];

function esOrigenLocal(origen) {
  return PREFIJOS_ORIGEN_LOCAL_SIEMPRE_PERMITIDO.some((prefijo) => origen === prefijo || origen.startsWith(prefijo + ':'));
}

function origenesPermitidosConfigurados() {
  const valor = Deno.env.get('PATIENT_COMMUNICATIONS_ALLOWED_ORIGINS') || '';
  return valor.split(',').map((o) => o.trim()).filter(Boolean);
}

function corsHeadersPara(origen) {
  const headers = {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin'
  };
  const permitido = !!origen && (esOrigenLocal(origen) || origenesPermitidosConfigurados().includes(origen));
  if (permitido) headers['Access-Control-Allow-Origin'] = origen;
  return headers;
}

// Reenvuelve una Response ya armada, agregando los headers CORS de ESA
// request puntual (sin tocar status/body). Se aplica una sola vez, justo
// antes de devolver, en Deno.serve.
function conCors(respuesta, corsHeaders) {
  const headers = new Headers(respuesta.headers);
  Object.entries(corsHeaders).forEach(([clave, valor]) => headers.set(clave, valor));
  return new Response(respuesta.body, { status: respuesta.status, headers });
}

function jsonResponse(cuerpo, status) {
  return new Response(JSON.stringify(cuerpo), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

function errorResponse(mensaje, status) {
  return jsonResponse({ ok: false, error: mensaje }, status || 400);
}

// Nunca loguea el error completo: puede traer datos reales (por ejemplo,
// el cuerpo de una respuesta de Resend con el email del paciente).
function logErrorSeguro(accion, error) {
  const codigo = error && error.code ? String(error.code) : (error && error.message ? 'ver-detalle-omitido' : 'desconocido');
  console.error('patient-communications error', accion, codigo);
}

function clienteServicio() {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceRoleKey) throw new Error('Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.');
  return createClient(url, serviceRoleKey, { auth: { persistSession: false } });
}

// Cliente atado al JWT de quien llama: auth.uid() dentro de la RPC de abajo
// resuelve al usuario real, nunca a uno que el cliente podría falsear.
function clienteComoUsuario(jwt) {
  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!url || !anonKey) throw new Error('Faltan SUPABASE_URL / SUPABASE_ANON_KEY.');
  return createClient(url, anonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } }
  });
}

async function autorizar(jwt) {
  if (!jwt) return { ok: false, uid: null };
  const comoUsuario = clienteComoUsuario(jwt);
  const { data: userData, error: userError } = await comoUsuario.auth.getUser(jwt);
  if (userError || !userData || !userData.user) return { ok: false, uid: null };
  const { data: permitido, error: rpcError } = await comoUsuario.rpc('cardiolink_has_communications_access');
  if (rpcError || !permitido) return { ok: false, uid: userData.user.id };
  return { ok: true, uid: userData.user.id };
}

async function obtenerAtencion(admin, atencionId) {
  const { data, error } = await admin
    .from('cardiolink_atenciones')
    .select('id, payload')
    .eq('id', String(atencionId))
    .limit(1);
  if (error) throw error;
  if (!data || !data.length) return null;
  return data[0].payload;
}

async function obtenerPaciente(admin, pacienteId) {
  if (!pacienteId) return null;
  const { data, error } = await admin
    .from('cardiolink_pacientes')
    .select('id, nombre_completo, email, telefono, contacto_responsable_nombre, contacto_responsable_telefono, contacto_responsable_email')
    .eq('id', String(pacienteId))
    .limit(1);
  if (error) throw error;
  return data && data.length ? data[0] : null;
}

async function obtenerDireccionConsultorio(admin) {
  const { data, error } = await admin
    .from('cardiolink_comunicaciones_config')
    .select('direccion_consultorio')
    .limit(1);
  if (error) return null;
  return data && data.length ? data[0].direccion_consultorio : null;
}

async function obtenerPlantilla(admin, prestacion) {
  const { data, error } = await admin
    .from('cardiolink_prestacion_templates')
    .select('*');
  if (error) throw error;
  return elegirPlantilla(data, prestacion);
}

// No confiar en "tipo" tal como llega del cliente: se valida contra el
// mismo enum del CHECK de cardiolink_communications antes de componer o
// insertar nada. Sin este chequeo, un tipo inválido igual quedaría
// atrapado por la base de datos (constraint), pero como un error 500 sin
// explicación en vez de un 400 claro - y ese mismo tipo ya se habría usado
// para elegir plantilla, mezclando datos de un envío que no debería existir.
const TIPOS_VALIDOS = ['confirmation', 'reminder', 'reschedule', 'cancellation', 'manual'];

async function componer(admin, atencionId, tipo) {
  if (!TIPOS_VALIDOS.includes(tipo)) return { error: 'Tipo de comunicación inválido.', status: 400 };
  const atencion = await obtenerAtencion(admin, atencionId);
  if (!atencion) return { error: 'No se encontró el turno.' };
  const [template, direccionConsultorio, paciente] = await Promise.all([
    obtenerPlantilla(admin, atencion.prestacion),
    obtenerDireccionConsultorio(admin),
    obtenerPaciente(admin, atencion.pacienteId)
  ]);
  const contacto = resolverDestinatarios(atencion, paciente);
  const { asunto, mensaje } = armarMensaje({ tipo, atencion, template, direccionConsultorio });
  return { atencion, asunto, mensaje, contacto };
}

async function manejarPreview(admin, body) {
  const { atencionId, tipo } = body || {};
  if (!atencionId || !tipo) return errorResponse('Faltan atencionId/tipo.', 400);
  const r = await componer(admin, atencionId, tipo);
  if (r.error) return errorResponse(r.error, r.status || 404);
  return jsonResponse({
    ok: true,
    asunto: r.asunto,
    mensaje: r.mensaje,
    email: r.contacto.email || '',
    emailFuente: r.contacto.emailFuente,
    telefono: r.contacto.telefono || '',
    telefonoFuente: r.contacto.telefonoFuente,
    faltaEmail: !r.contacto.email,
    faltaTelefono: !r.contacto.telefono,
    sinCanales: !!r.contacto.sinCanales
  });
}

async function registrarComunicacion(admin, fila) {
  const { error } = await admin.from('cardiolink_communications').insert(fila);
  if (error) throw error;
}

async function enviarConResend(destinatario, asunto, mensaje) {
  const apiKey = Deno.env.get('RESEND_API_KEY');
  const remitente = Deno.env.get('RESEND_FROM_EMAIL');
  if (!apiKey || !remitente) {
    return { ok: false, motivo: 'Proveedor de email no configurado (falta RESEND_API_KEY o RESEND_FROM_EMAIL en la Edge Function).' };
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

async function manejarSendEmail(admin, body, uid) {
  const { atencionId, tipo } = body || {};
  if (!atencionId || !tipo) return errorResponse('Faltan atencionId/tipo.', 400);
  const r = await componer(admin, atencionId, tipo);
  if (r.error) return errorResponse(r.error, r.status || 404);
  // Ausencia de canal no es un error del envío: ni del paciente ni del
  // contacto responsable hay un email válido cargado. No se registra
  // "failed" - simplemente no hay nada que enviar.
  if (!emailValido(r.contacto.email || '')) {
    return errorResponse('Ni el paciente ni su contacto responsable tienen un email válido cargado.', 409);
  }

  const resultado = await enviarConResend(r.contacto.email, r.asunto, r.mensaje);
  const fila = {
    paciente_id: r.contacto.pacienteId || null,
    atencion_id: String(atencionId),
    tipo,
    canal: 'email',
    destinatario: r.contacto.email,
    recipient_source: r.contacto.emailFuente,
    recipient_name: r.contacto.emailNombre || null,
    subject: r.asunto,
    message: r.mensaje,
    status: resultado.ok ? 'sent' : 'failed',
    provider: 'resend',
    provider_message_id: resultado.ok ? resultado.providerMessageId : null,
    error_message: resultado.ok ? null : resultado.motivo,
    sent_at: resultado.ok ? new Date().toISOString() : null,
    created_by: uid
  };
  try {
    await registrarComunicacion(admin, fila);
  } catch (error) {
    // tipo=reminder tiene un índice único parcial (atencion_id, tipo) para
    // evitar duplicados: una violación acá significa que ya se había
    // registrado antes, no es un error real del envío.
    if (error && error.code === '23505') {
      return jsonResponse({ ok: true, duplicado: true });
    }
    throw error;
  }

  if (!resultado.ok) return errorResponse(resultado.motivo, 502);
  return jsonResponse({ ok: true, providerMessageId: resultado.providerMessageId });
}

// -----------------------------------------------------------------------
// Aviso automático al profesional asignado. Circuito distinto de
// preview/send-email/log-whatsapp (esas son para el paciente, siempre a
// pedido explícito de Secretaría vía el modal "¿Notificar al paciente?").
// Este no pregunta nada: se dispara solo desde app.js al crear/confirmar/
// reprogramar/cancelar un turno, y nunca debe impedir esas acciones - por
// eso nunca lanza un error "duro" salvo fallas genuinas de Supabase: la
// ausencia de canal, la autonotificación y el aviso desactivado son casos
// normales que responden ok:true, omitido:true (nunca bloquean nada del
// lado del cliente, que además ignora el resultado con fire-and-forget).
// -----------------------------------------------------------------------

const EVENTOS_PROFESIONAL_VALIDOS = ['assignment', 'confirmation', 'reschedule', 'cancellation'];

// professional_id (columna nueva de cardiolink_user_roles, ver
// 20260829090000_...sql) - NO cardiolink_user_key, que ya representa la
// identidad/email real usada por CardioLink en producción y no debe
// reutilizarse como vínculo profesional.
async function resolverCuentaProfesional(admin, profesionalId) {
  const { data, error } = await admin
    .from('cardiolink_user_roles')
    .select('user_id')
    .ilike('professional_id', profesionalId)
    .eq('active', true)
    .limit(1);
  if (error) throw error;
  return data && data.length ? data[0].user_id : null;
}

async function resolverEmailAuth(admin, userId) {
  if (!userId) return '';
  try {
    const { data, error } = await admin.auth.admin.getUserById(userId);
    if (error || !data || !data.user) return '';
    return data.user.email || '';
  } catch (_error) {
    return '';
  }
}

async function resolverPreferenciaProfesional(admin, profesionalId) {
  const { data, error } = await admin
    .from('cardiolink_professional_notification_preferences')
    .select('email_enabled, email_override')
    .eq('professional_id', String(profesionalId))
    .limit(1);
  if (error) throw error;
  // Sin fila = valores por defecto: avisos activados, sin override.
  return data && data.length ? data[0] : { email_enabled: true, email_override: null };
}

async function manejarNotifyProfessional(admin, body, uid) {
  const { atencionId, evento } = body || {};
  if (!atencionId || !EVENTOS_PROFESIONAL_VALIDOS.includes(evento)) {
    return jsonResponse({ ok: true, omitido: true, motivo: 'entrada_invalida' });
  }

  const atencion = await obtenerAtencion(admin, atencionId);
  if (!atencion || !atencion.profesionalId) {
    return jsonResponse({ ok: true, omitido: true, motivo: 'sin_profesional' });
  }
  const profesionalId = String(atencion.profesionalId);

  const userIdProfesional = await resolverCuentaProfesional(admin, profesionalId);

  // Anti-autonotificación: si quien dispara la acción ES el mismo
  // profesional destinatario, no se envía nada.
  if (userIdProfesional && uid && userIdProfesional === uid) {
    return jsonResponse({ ok: true, omitido: true, motivo: 'auto' });
  }

  const preferencia = await resolverPreferenciaProfesional(admin, profesionalId);
  if (preferencia.email_enabled === false) {
    return jsonResponse({ ok: true, omitido: true, motivo: 'desactivado' });
  }

  let email = '';
  if (emailValido(preferencia.email_override || '')) email = preferencia.email_override;
  else email = await resolverEmailAuth(admin, userIdProfesional);
  // Sin email resoluble (ni override ni cuenta Auth vinculada): no es un
  // error, simplemente no hay nada que enviar.
  if (!emailValido(email)) return jsonResponse({ ok: true, omitido: true, motivo: 'sin_email' });

  // Idempotencia razonable (atencion_id + evento + destinatario) con una
  // ventana corta: mismo patrón que ya usa portal-gateway/index.ts
  // (manejarSolicitud) para protección contra reintentos/doble disparo.
  // No usa el índice único de reminders (ese es exclusivo de tipo='reminder'
  // y un turno puede reprogramarse/confirmarse más de una vez de verdad).
  const hace2Minutos = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const { data: recientes, error: recientesError } = await admin
    .from('cardiolink_communications')
    .select('id')
    .eq('atencion_id', String(atencionId))
    .eq('tipo', evento)
    .eq('recipient_source', 'professional')
    .eq('destinatario', email)
    .gte('created_at', hace2Minutos)
    .limit(1);
  if (recientesError) throw recientesError;
  if (Array.isArray(recientes) && recientes.length) return jsonResponse({ ok: true, duplicado: true });

  const { asunto, mensaje } = armarMensajeProfesional({ evento, atencion });
  const resultado = await enviarConResend(email, asunto, mensaje);

  // paciente_id validado igual que en send-email/log-whatsapp: solo si
  // cardiolink_pacientes realmente tiene esa fila (ver resolverDestinatarios()
  // en _shared/comunicaciones-logica.js para el mismo criterio del lado paciente).
  const paciente = await obtenerPaciente(admin, atencion.pacienteId);

  await registrarComunicacion(admin, {
    paciente_id: (paciente && paciente.id) || null,
    atencion_id: String(atencionId),
    tipo: evento,
    canal: 'email',
    destinatario: email,
    recipient_source: 'professional',
    recipient_name: atencion.profesional || null,
    subject: asunto,
    message: mensaje,
    status: resultado.ok ? 'sent' : 'failed',
    provider: 'resend',
    provider_message_id: resultado.ok ? resultado.providerMessageId : null,
    error_message: resultado.ok ? null : resultado.motivo,
    sent_at: resultado.ok ? new Date().toISOString() : null,
    created_by: uid
  });

  return jsonResponse({ ok: true, enviado: resultado.ok });
}

// -----------------------------------------------------------------------
// Aviso automático al profesional cuando Secretaría genera un certificado
// u orden médica EN SU NOMBRE (Comunicaciones V1, cierre). Mismo circuito
// que manejarNotifyProfessional (nunca pregunta nada, nunca lanza un error
// "duro" salvo fallas genuinas de Supabase, siempre responde ok:true con
// omitido/duplicado en los casos normales) pero SIN buscar una atención:
// los documentos clínicos no tienen atencionId (viven en el config jsonb
// de app.js, no en cardiolink_atenciones), así que toda la información ya
// llega resuelta desde el cliente en el body. Nunca recibe ni reenvía el
// contenido del documento (título/cuerpo/indicaciones/diagnóstico): eso
// nunca sale de app.js. A diferencia de manejarNotifyProfessional, ADEMÁS
// verifica server-side que quien llama sea efectivamente Secretaría
// (esSecretariaActiva): que el propio documento se haya podido crear no
// prueba el rol de quien invoca esta acción puntual - ver esSecretariaActiva
// más abajo.
// -----------------------------------------------------------------------

const TIPOS_DOCUMENTO_VALIDOS = ['constancia_atencion', 'certificado', 'orden'];

// El cliente (app.js) ya filtra por isSecretary406() antes de invocar esta
// acción, pero eso corre en el navegador: no es una autorización real, es
// sólo UX. Acá se repite la validación server-side, contra la misma tabla
// que ya usa autorizar()/cardiolink_has_communications_access() (ver
// 20260815193000_finanzas_v5_schema.sql) - sin esto, cualquier sesión
// autenticada con acceso a esta Edge Function (ej. un médico) podría
// invocar notify-professional-document directamente y generar avisos en
// nombre de Secretaría.
async function esSecretariaActiva(admin, uid) {
  if (!uid) return false;
  const { data, error } = await admin
    .from('cardiolink_user_roles')
    .select('base_role')
    .eq('user_id', uid)
    .eq('active', true)
    .eq('base_role', 'secretaria')
    .limit(1);
  if (error) throw error;
  return !!(data && data.length);
}

async function manejarNotifyProfessionalDocument(admin, body, uid) {
  const { profesionalId, profesionalNombre, pacienteNombre, tipoDocumento, fechaHora, generadoPor, documentoId } = body || {};
  // profesionalId/documentoId/tipoDocumento se validan ANTES que el rol a
  // propósito: cualquier entrada incompleta es inválida sin importar quién
  // la mande, misma respuesta segura (ok:true, omitido:true) en todos los
  // casos - no hay forma de distinguir desde afuera cuál falló. documentoId
  // es obligatorio acá (a diferencia de otros campos informativos): sin él
  // no hay document_id real para guardar, y la idempotencia de abajo deja
  // de tener sentido - fail-safe: no se registra nada con document_id null.
  if (!profesionalId || !documentoId || !TIPOS_DOCUMENTO_VALIDOS.includes(tipoDocumento)) {
    return jsonResponse({ ok: true, omitido: true, motivo: 'entrada_invalida' });
  }
  if (!(await esSecretariaActiva(admin, uid))) {
    return jsonResponse({ ok: true, omitido: true, motivo: 'rol_no_autorizado' });
  }

  const userIdProfesional = await resolverCuentaProfesional(admin, String(profesionalId));

  // Anti-autonotificación: mismo chequeo que manejarNotifyProfessional
  // (caso límite: la cuenta que generó el documento está vinculada como
  // el propio profesional destinatario).
  if (userIdProfesional && uid && userIdProfesional === uid) {
    return jsonResponse({ ok: true, omitido: true, motivo: 'auto' });
  }

  const preferencia = await resolverPreferenciaProfesional(admin, String(profesionalId));
  if (preferencia.email_enabled === false) {
    return jsonResponse({ ok: true, omitido: true, motivo: 'desactivado' });
  }

  let email = '';
  if (emailValido(preferencia.email_override || '')) email = preferencia.email_override;
  else email = await resolverEmailAuth(admin, userIdProfesional);
  if (!emailValido(email)) return jsonResponse({ ok: true, omitido: true, motivo: 'sin_email' });

  // Idempotencia razonable, mismo patrón de ventana de 2 minutos que
  // manejarNotifyProfessional, pero correlacionando por document_id (columna
  // propia, agregada por 20260904120000_..._document_notifications.sql) en
  // vez de atencion_id: un documento clínico no es una atención/turno y no
  // debe mezclarse con esa columna. atencion_id queda null para tipo=document
  // siempre. document_id es obligatorio en esta acción (ver validación de
  // entrada más arriba): no hay rama "sin referencia" - dos documentos
  // distintos nunca deben poder compartir una búsqueda por document_id is
  // null dentro de la ventana.
  const referencia = String(documentoId);
  const hace2Minutos = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const { data: recientes, error: recientesError } = await admin
    .from('cardiolink_communications')
    .select('id')
    .eq('tipo', 'document')
    .eq('recipient_source', 'professional')
    .eq('destinatario', email)
    .eq('document_id', referencia)
    .gte('created_at', hace2Minutos)
    .limit(1);
  if (recientesError) throw recientesError;
  if (Array.isArray(recientes) && recientes.length) return jsonResponse({ ok: true, duplicado: true });

  const { asunto, mensaje } = armarMensajeProfesionalDocumento({
    tipoDocumento,
    pacienteNombre: pacienteNombre || '',
    fechaHora: fechaHora || '',
    generadoPor: generadoPor || ''
  });
  const resultado = await enviarConResend(email, asunto, mensaje);

  // paciente_id queda null a propósito: el cliente sólo manda un nombre de
  // paciente en texto libre (pacienteNombre), no un id validado contra
  // cardiolink_pacientes - insertar un id sin validar arriesgaría violar
  // la FK de esa columna. El nombre del paciente ya queda en el mensaje.
  // atencion_id también queda null a propósito: un documento clínico no es
  // una atención/turno. La referencia al documento va en document_id.
  await registrarComunicacion(admin, {
    paciente_id: null,
    atencion_id: null,
    document_id: referencia,
    tipo: 'document',
    canal: 'email',
    destinatario: email,
    recipient_source: 'professional',
    recipient_name: profesionalNombre || null,
    subject: asunto,
    message: mensaje,
    status: resultado.ok ? 'sent' : 'failed',
    provider: 'resend',
    provider_message_id: resultado.ok ? resultado.providerMessageId : null,
    error_message: resultado.ok ? null : resultado.motivo,
    sent_at: resultado.ok ? new Date().toISOString() : null,
    created_by: uid
  });

  return jsonResponse({ ok: true, enviado: resultado.ok });
}

async function manejarLogWhatsapp(admin, body, uid) {
  const { atencionId, tipo } = body || {};
  if (!atencionId || !tipo) return errorResponse('Faltan atencionId/tipo.', 400);
  const r = await componer(admin, atencionId, tipo);
  if (r.error) return errorResponse(r.error, r.status || 404);
  const telefono = r.contacto.telefono || '';
  // Ausencia de canal no es un error: ni el paciente ni su contacto
  // responsable tienen un teléfono válido cargado.
  if (!telefono) return errorResponse('Ni el paciente ni su contacto responsable tienen un teléfono válido cargado.', 409);

  await registrarComunicacion(admin, {
    paciente_id: r.contacto.pacienteId || null,
    atencion_id: String(atencionId),
    tipo,
    canal: 'whatsapp',
    destinatario: telefono,
    recipient_source: r.contacto.telefonoFuente,
    recipient_name: r.contacto.telefonoNombre || null,
    subject: null,
    message: r.mensaje,
    status: 'manual_started',
    provider: null,
    provider_message_id: null,
    error_message: null,
    sent_at: new Date().toISOString(),
    created_by: uid
  });

  return jsonResponse({ ok: true, telefono, mensaje: r.mensaje });
}

Deno.serve(async function (req) {
  const corsHeaders = corsHeadersPara(req.headers.get('origin') || '');

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== 'POST') return conCors(errorResponse('Método no permitido.', 405), corsHeaders);

  let body;
  try {
    body = await req.json();
  } catch (_error) {
    return conCors(errorResponse('Cuerpo inválido.', 400), corsHeaders);
  }

  const accion = String(body && body.action || '');
  console.log('patient-communications', accion);

  const authHeader = req.headers.get('authorization') || '';
  const jwt = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7) : '';
  const auth = await autorizar(jwt);
  if (!auth.ok) return conCors(errorResponse('No autorizado.', 403), corsHeaders);

  try {
    const admin = clienteServicio();
    let respuesta;
    if (accion === 'preview') respuesta = await manejarPreview(admin, body);
    else if (accion === 'send-email') respuesta = await manejarSendEmail(admin, body, auth.uid);
    else if (accion === 'log-whatsapp') respuesta = await manejarLogWhatsapp(admin, body, auth.uid);
    else if (accion === 'notify-professional') respuesta = await manejarNotifyProfessional(admin, body, auth.uid);
    else if (accion === 'notify-professional-document') respuesta = await manejarNotifyProfessionalDocument(admin, body, auth.uid);
    else respuesta = errorResponse('Acción no reconocida.', 400);
    return conCors(respuesta, corsHeaders);
  } catch (error) {
    logErrorSeguro(accion, error);
    return conCors(errorResponse('No se pudo completar la operación. Probá de nuevo en un momento.', 500), corsHeaders);
  }
});
