// CardioLink Admin — Edge Function "patient-document-delivery" (Fase 6 / Bloque 6E.1)
//
// NO DESPLEGADA EN PRODUCTION — sólo STAGING, para QA.
//
// Objetivo: enviar al paciente (o a su contacto responsable) un documento
// o estudio YA ALMACENADO en public.cardiolink_patient_documents (PDF o
// imagen clínica), por email (archivo real adjunto) y/o WhatsApp (mensaje
// + enlace temporal al mismo archivo privado). Nunca duplica el archivo:
// siempre lee el storage_path ya existente, nunca sube una copia nueva.
//
// Bloque 6D.2, punto 2 de la tarea 6E.1 ("Aislar 6E de comunicaciones ya
// aprobadas"): Edge Function NUEVA e independiente, para no modificar
// patient-communications (V1.2, ya cerrada y en Production). Reutiliza
// los MISMOS helpers puros de ../_shared/comunicaciones-logica.js
// (resolverDestinatarios, emailValido, resolverBrandingCardioLink, las
// nuevas armarMensaje*Documento de este bloque) y replica localmente (no
// se pueden importar desde otra Edge Function) el mismo patrón ya usado
// por patient-communications para: CORS, cliente service_role, cliente
// "como el usuario que llama", enviarConResend, y la resolución de cuenta
// profesional (resolverCuentaProfesional/resolverEmailAuth/
// resolverPreferenciaProfesional) - mismo código, no una lógica paralela.
//
// SEGURIDAD — diseño clave de esta función (puntos 7/11/17/24 de la
// tarea): la autorización real para leer un documento puntual (¿puede
// este usuario ver/enviar ESTE document_id?) NO se reimplementa acá como
// una segunda regla de roles. Se usa el cliente Supabase atado al JWT de
// quien llama (clienteComoUsuario) para leer tanto la fila de metadata
// como el archivo de Storage: si la RLS de 6D/6D.2/6D.3 no deja ver esa
// fila/objeto a ese usuario (por ejemplo, Secretaría contra
// document_type='Imagen clínica' o un path clinical-images/...), la
// consulta simplemente no devuelve nada - exactamente el mismo resultado
// que tendría el usuario navegando la app normalmente. Una sola fuente de
// verdad (la RLS ya auditada en 6D.3), nunca dos reglas que puedan
// divergir. El cliente service_role sólo se usa para lo que de verdad lo
// necesita: leer cardiolink_pacientes/config/cardiolink_user_roles y
// escribir cardiolink_communications (sin policy de insert para
// authenticated, a propósito - igual que patient-communications).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import {
  emailValido,
  resolverDestinatarios,
  resolverBrandingCardioLink,
  armarMensajeEnvioDocumento,
  armarMensajeWhatsappDocumentoOficial,
  armarMensajeWhatsappDocumentoGenerado,
  armarMensajeProfesionalEnvioDocumento
} from '../_shared/comunicaciones-logica.js';

const BUCKET = 'patient-documents';
const TIPO_IMAGEN_CLINICA = 'Imagen clínica';
// Bloque 6E.2 - catálogo limpio (punto 8 de la tarea: nunca "Orden PDF"/
// "Certificado generado", el document_type visible sigue siendo estos
// 3 valores exactos, iguales a los que ya usa generarPdfDocumentoGenerado406 en app.js).
const TIPOS_DOCUMENTO_GENERADO_V1 = ['Orden', 'Certificado', 'Constancia'];
// ~15MB de archivo -> ~20MB en base64 + overhead del request a Resend.
// Resend documenta un límite total de request bastante mayor, pero se fija
// este techo propio para no depender de ese límite exacto y para no
// transportar archivos enormes dentro de una función con timeout acotado.
const LIMITE_ADJUNTO_BYTES = 15 * 1024 * 1024;
const EXPIRACION_SIGNED_URL_SEGUNDOS = 24 * 60 * 60; // 24h: "razonable para uso real del paciente" (punto 6 de la tarea)

// ---------------------------------------------------------------------------
// CORS - mismo patrón exacto que patient-communications/index.ts (ver ahí
// el comentario completo). Env var propia para no acoplar el despliegue de
// una función con el de la otra.
// ---------------------------------------------------------------------------
const PREFIJOS_ORIGEN_LOCAL_SIEMPRE_PERMITIDO = ['http://localhost', 'http://127.0.0.1', 'http://[::1]'];

function esOrigenLocal(origen) {
  return PREFIJOS_ORIGEN_LOCAL_SIEMPRE_PERMITIDO.some((prefijo) => origen === prefijo || origen.startsWith(prefijo + ':'));
}
function origenesPermitidosConfigurados() {
  const valor = Deno.env.get('PATIENT_DOCUMENT_DELIVERY_ALLOWED_ORIGINS') || '';
  return valor.split(',').map((o) => o.trim()).filter(Boolean);
}
function corsHeadersPara(origen, requestedHeaders) {
  const headers = {
    'Access-Control-Allow-Headers': requestedHeaders || 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin, Access-Control-Request-Headers'
  };
  const permitido = !!origen && (esOrigenLocal(origen) || origenesPermitidosConfigurados().includes(origen));
  if (permitido) headers['Access-Control-Allow-Origin'] = origen;
  return headers;
}
function conCors(respuesta, corsHeaders) {
  const headers = new Headers(respuesta.headers);
  Object.entries(corsHeaders).forEach(([clave, valor]) => headers.set(clave, valor));
  return new Response(respuesta.body, { status: respuesta.status, headers });
}
// Bug QA real: emoji (📎/🙌 - fuera del plano básico, 4 bytes UTF-8 cada
// uno) llegaban como � en WhatsApp. El cuerpo en sí ya viaja en UTF-8
// (un string pasado a Response() se codifica en UTF-8 siempre, por spec),
// pero el Content-Type sin "charset" deja esa decisión implícita para
// cualquier intermediario entre esta función y el navegador (gateway/CDN)
// - se declara explícito para no depender de ningún valor por defecto.
function jsonResponse(cuerpo, status) {
  return new Response(JSON.stringify(cuerpo), { status: status || 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
function errorResponse(mensaje, status) {
  return jsonResponse({ ok: false, error: mensaje }, status || 400);
}
// Nunca loguea el error completo: puede traer datos reales (cuerpo de
// Resend, mensajes de Postgres con valores, etc.).
function logErrorSeguro(accion, error) {
  const codigo = error && error.code ? String(error.code) : (error && error.message ? 'ver-detalle-omitido' : 'desconocido');
  console.error('patient-document-delivery error', accion, codigo);
}

function clienteServicio() {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceRoleKey) throw new Error('Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.');
  return createClient(url, serviceRoleKey, { auth: { persistSession: false } });
}
function clienteComoUsuario(jwt) {
  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!url || !anonKey) throw new Error('Faltan SUPABASE_URL / SUPABASE_ANON_KEY.');
  return createClient(url, anonKey, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${jwt}` } } });
}

async function autenticar(jwt) {
  if (!jwt) return { ok: false, uid: null };
  const comoUsuario = clienteComoUsuario(jwt);
  const { data, error } = await comoUsuario.auth.getUser(jwt);
  if (error || !data || !data.user) return { ok: false, uid: null };
  return { ok: true, uid: data.user.id, comoUsuario };
}

// ---------------------------------------------------------------------------
// Documento: la única verificación de autorización real de esta función
// (ver nota de seguridad al principio del archivo). Usa el cliente del
// USUARIO, nunca el de servicio, para que la RLS de cardiolink_patient_documents
// decida - exactamente igual que si el usuario lo pidiera desde la app.
// ---------------------------------------------------------------------------
async function obtenerDocumentoAutorizado(comoUsuario, documentId) {
  const { data, error } = await comoUsuario
    .from('cardiolink_patient_documents')
    .select('*')
    .eq('id', String(documentId))
    .limit(1);
  if (error) throw error;
  return data && data.length ? data[0] : null;
}

// Igual que obtenerDocumentoAutorizado: descarga con el cliente del
// usuario, así la RLS de storage.objects (clinical-images/... bloqueado
// para Secretaría desde 6D.3) decide exactamente igual que en la app.
async function descargarArchivoAutorizado(comoUsuario, path) {
  const { data, error } = await comoUsuario.storage.from(BUCKET).download(path);
  if (error) throw error;
  return await data.arrayBuffer();
}

async function signedUrlAutorizada(comoUsuario, path, segundos) {
  const { data, error } = await comoUsuario.storage.from(BUCKET).createSignedUrl(path, segundos);
  if (error || !data || !data.signedUrl) return null;
  return data.signedUrl;
}

// paciente_id de cardiolink_patient_documents NO tiene FK (deliberado,
// 6D: admite pacientes "legacy" sin fila en cardiolink_pacientes) así que,
// igual que patient-communications, se vuelve a resolver/validar contra
// cardiolink_pacientes antes de usarlo como paciente_id (FK real) en
// cardiolink_communications - nunca un id sin validar.
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

const CONFIG_ROW_ID = '__cardiolink_config_v1';
async function obtenerConfig(admin) {
  const { data, error } = await admin.from('cardiolink_atenciones').select('payload').eq('id', CONFIG_ROW_ID).limit(1);
  if (error) throw error;
  return (data && data.length && data[0].payload && data[0].payload.config) || null;
}

// Mismo criterio que resolverProfesionalDelTurno (patient-communications):
// data.profesionales[] vive en el mismo blob de config, no hay tabla
// relacional de profesionales. Sin professional_id en el documento o sin
// match en el catálogo -> null (el caller ya sabe degradar, ver plantilla
// "si no hay profesional asociado" en armarMensajeWhatsappDocumentoOficial).
function resolverProfesionalDocumentoV1(config, doc) {
  const profesionalId = doc && doc.professional_id;
  if (!config || !Array.isArray(config.profesionales) || !profesionalId) return null;
  return config.profesionales.find((p) => p && String(p.id) === String(profesionalId)) || null;
}

// ---------------------------------------------------------------------------
// Ajuste WhatsApp (posterior a 6E.1) - enlace corto propio de CardioLink.
// Token opaco de 32 bytes random (nunca basado en datos del documento/
// paciente - no hay nada que decodificar). Se guarda sólo su hash
// (cardiolink_document_access_links.token_hash); el token en texto plano
// sale de esta función una sola vez, para armar la URL, y nunca se
// vuelve a leer/persistir en ningún lado.
// ---------------------------------------------------------------------------
function generarTokenOpacoV1() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function hashTokenV1(token) {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
const DURACION_ENLACE_CORTO_MS = 7 * 24 * 60 * 60 * 1000; // 7 días (punto 3 de la tarea)
async function crearEnlaceCortoV1(admin, documentId, uid, channel) {
  const token = generarTokenOpacoV1();
  const tokenHash = await hashTokenV1(token);
  const expiresAt = new Date(Date.now() + DURACION_ENLACE_CORTO_MS).toISOString();
  const { error } = await admin.from('cardiolink_document_access_links').insert({
    token_hash: tokenHash,
    document_id: documentId,
    expires_at: expiresAt,
    created_by: uid || null,
    channel
  });
  if (error) throw error;
  return { token, expiresAt };
}
// Punto 6 de la tarea: mientras PATIENT_DOCUMENT_OPEN_BASE_URL no esté
// configurada con el dominio corto real (cardiolink.com.ar) y su routing
// /d/:token hacia patient-document-open, se usa la URL directa de esa
// Edge Function pública - sigue siendo un enlace corto propio (nunca el
// signed URL de Storage), sólo que más largo de lo definitivo. Para
// activar el formato final en Production falta: (1) configurar esta env
// var con "https://cardiolink.com.ar" y (2) un routing real que reescriba
// cardiolink.com.ar/d/:token hacia esta función con ?token=:token.
function resolverUrlCortaV1(token) {
  const base = String(Deno.env.get('PATIENT_DOCUMENT_OPEN_BASE_URL') || '').trim();
  if (/^https?:\/\//i.test(base)) return `${base.replace(/\/+$/, '')}/d/${token}`;
  const supabaseUrl = String(Deno.env.get('SUPABASE_URL') || '').replace(/\/+$/, '');
  return `${supabaseUrl}/functions/v1/patient-document-open?token=${token}`;
}

async function registrarComunicacion(admin, fila) {
  const { error } = await admin.from('cardiolink_communications').insert(fila);
  if (error) throw error;
}

// Idempotencia (punto 13 de la tarea): mismo documento + mismo canal +
// mismo destinatario dentro de una ventana corta = no reenviar. Ventana
// deliberadamente corta (60s: alcanza doble click/reintento de red) para
// no impedir un reenvío intencional más tarde.
async function envioRecienteExiste(admin, documentId, canal, destinatario) {
  const haceUnMinuto = new Date(Date.now() - 60 * 1000).toISOString();
  const { data, error } = await admin
    .from('cardiolink_communications')
    .select('id')
    .eq('tipo', 'document_delivery')
    .eq('document_id', String(documentId))
    .eq('canal', canal)
    .eq('destinatario', destinatario)
    .gte('created_at', haceUnMinuto)
    .limit(1);
  if (error) throw error;
  return !!(data && data.length);
}

// Mismo patrón de Resend que patient-communications/index.ts (ver ahí el
// comentario completo sobre `attachments`, formato REST snake_case).
async function enviarConResend(destinatario, asunto, mensaje, attachments) {
  const apiKey = Deno.env.get('RESEND_API_KEY');
  const remitente = Deno.env.get('RESEND_FROM_EMAIL');
  if (!apiKey || !remitente) {
    return { ok: false, motivo: 'Proveedor de email no configurado (falta RESEND_API_KEY o RESEND_FROM_EMAIL en la Edge Function).' };
  }
  try {
    const cuerpoEmail = { from: remitente, to: [destinatario], subject: asunto, text: mensaje };
    if (Array.isArray(attachments) && attachments.length) cuerpoEmail.attachments = attachments;
    const respuesta = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpoEmail)
    });
    const cuerpo = await respuesta.json().catch(() => ({}));
    if (!respuesta.ok) return { ok: false, motivo: (cuerpo && cuerpo.message) ? String(cuerpo.message).slice(0, 300) : `Resend respondió ${respuesta.status}.` };
    return { ok: true, providerMessageId: cuerpo && cuerpo.id ? String(cuerpo.id) : null };
  } catch (_error) {
    return { ok: false, motivo: 'No se pudo contactar al proveedor de email.' };
  }
}

function arrayBufferABase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Resolución de cuenta/email/preferencia del profesional - copia exacta
// (mismo criterio, mismas tablas) de patient-communications/index.ts. No
// se puede importar entre Edge Functions, así que se replica acá en vez
// de modificar esa función ya aprobada (punto 2 de la tarea).
// ---------------------------------------------------------------------------
async function resolverCuentaProfesional(admin, profesionalId) {
  const { data, error } = await admin.from('cardiolink_user_roles').select('user_id').ilike('professional_id', profesionalId).eq('active', true).limit(1);
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
  const { data, error } = await admin.from('cardiolink_professional_notification_preferences').select('email_enabled, email_override').eq('professional_id', String(profesionalId)).limit(1);
  if (error) throw error;
  return data && data.length ? data[0] : { email_enabled: true, email_override: null };
}

// Punto 11 de la tarea: el aviso automático al profesional sólo aplica
// "cuando SECRETARÍA envía" (punto 9) - un médico/owner/admin enviando su
// propio documento no necesita auto-notificarse. Mismo chequeo server-side
// que esSecretariaActiva() en patient-communications (nunca confiar en que
// el cliente ya filtró esto).
async function esSecretariaActiva(admin, uid) {
  if (!uid) return false;
  const { data, error } = await admin.from('cardiolink_user_roles').select('base_role').eq('user_id', uid).eq('active', true).eq('base_role', 'secretaria').limit(1);
  if (error) throw error;
  return !!(data && data.length);
}

// Punto 9/10/Q de la tarea: nunca revierte ni bloquea el envío al
// paciente (ya se hizo y ya se registró antes de llamar a esto). Sin
// professional_id -> no hay a quién avisar (punto 10, "no inventar un
// destinatario"). Idempotencia propia de 2 minutos, mismo patrón que
// manejarNotifyProfessionalDocument en patient-communications.
async function intentarAvisoProfesional(admin, doc, pacienteNombre, uid, canal) {
  if (!doc.professional_id) return { enviado: false, motivo: 'sin_profesional' };
  if (!(await esSecretariaActiva(admin, uid))) return { enviado: false, motivo: 'no_aplica' };
  const userIdProfesional = await resolverCuentaProfesional(admin, String(doc.professional_id));
  if (!userIdProfesional) return { enviado: false, motivo: 'sin_cuenta' };
  if (userIdProfesional === uid) return { enviado: false, motivo: 'auto' };
  const preferencia = await resolverPreferenciaProfesional(admin, String(doc.professional_id));
  if (preferencia.email_enabled === false) return { enviado: false, motivo: 'desactivado' };
  let email = '';
  if (emailValido(preferencia.email_override || '')) email = preferencia.email_override;
  else email = await resolverEmailAuth(admin, userIdProfesional);
  if (!emailValido(email)) return { enviado: false, motivo: 'sin_email' };

  const hace2Minutos = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const { data: recientes, error: recientesError } = await admin
    .from('cardiolink_communications')
    .select('id')
    .eq('tipo', 'document')
    .eq('recipient_source', 'professional')
    .eq('destinatario', email)
    .eq('document_id', String(doc.id))
    .gte('created_at', hace2Minutos)
    .limit(1);
  if (recientesError) throw recientesError;
  if (Array.isArray(recientes) && recientes.length) return { enviado: false, motivo: 'duplicado' };

  const { asunto, mensaje } = armarMensajeProfesionalEnvioDocumento({
    pacienteNombre: pacienteNombre || '',
    tipoDocumento: doc.document_type,
    titulo: doc.title,
    fechaDocumento: doc.document_date,
    canal,
    generadoPor: 'Secretaría'
  });
  const resultado = await enviarConResend(email, asunto, mensaje);

  // paciente_id null a propósito, mismo criterio que
  // manejarNotifyProfessionalDocument: el nombre va en el texto, no se
  // valida/inserta un id de paciente en esta fila de aviso profesional.
  await registrarComunicacion(admin, {
    paciente_id: null,
    atencion_id: null,
    document_id: String(doc.id),
    tipo: 'document',
    canal: 'email',
    destinatario: email,
    recipient_source: 'professional',
    recipient_name: null,
    subject: asunto,
    message: mensaje,
    status: resultado.ok ? 'sent' : 'failed',
    provider: 'resend',
    provider_message_id: resultado.ok ? resultado.providerMessageId : null,
    error_message: resultado.ok ? null : resultado.motivo,
    sent_at: resultado.ok ? new Date().toISOString() : null,
    created_by: uid
  });
  return { enviado: resultado.ok, motivo: resultado.ok ? null : resultado.motivo };
}

// ---------------------------------------------------------------------------
// Acciones
// ---------------------------------------------------------------------------
async function manejarSendEmail(admin, comoUsuario, body, uid) {
  const { documentId } = body || {};
  if (!documentId) return errorResponse('Falta documentId.', 400);

  const doc = await obtenerDocumentoAutorizado(comoUsuario, documentId);
  // Mensaje deliberadamente genérico: no distingue "no existe" de "existe
  // pero RLS lo bloqueó" (Secretaría + Imagen clínica, por ejemplo) - esa
  // distinción no debe filtrarse hacia afuera.
  if (!doc) return errorResponse('Documento no encontrado o sin acceso.', 404);

  const paciente = await obtenerPaciente(admin, doc.patient_id);
  const contacto = resolverDestinatarios(null, paciente);
  if (!contacto.email) return errorResponse('El paciente no tiene email registrado.', 409);

  if (await envioRecienteExiste(admin, documentId, 'email', contacto.email)) {
    return jsonResponse({ ok: true, duplicado: true });
  }

  const config = await obtenerConfig(admin);
  const branding = resolverBrandingCardioLink(config);
  const nombreDestinatario = contacto.emailNombre || (paciente && paciente.nombre_completo) || '';
  const { asunto, mensaje } = armarMensajeEnvioDocumento({
    nombreDestinatario,
    tipoDocumento: doc.document_type,
    titulo: doc.title,
    fechaDocumento: doc.document_date,
    brandingNombre: branding.nombre
  });

  // Adjunto real cuando es seguro/compatible (punto 5 de la tarea). Si el
  // archivo excede el límite propio o falla la descarga, se documenta en
  // la respuesta (adjuntoReal:false) y se ofrece en su lugar un enlace
  // temporal (nunca una URL pública permanente) dentro del cuerpo.
  let attachments = [];
  let adjuntoReal = false;
  let mensajeConEnlaceAlternativo = null;
  if (doc.size_bytes && doc.size_bytes <= LIMITE_ADJUNTO_BYTES) {
    try {
      const archivo = await descargarArchivoAutorizado(comoUsuario, doc.storage_path);
      attachments = [{ content: arrayBufferABase64(archivo), filename: doc.original_filename || 'documento', content_type: doc.mime_type || 'application/octet-stream' }];
      adjuntoReal = true;
    } catch (_error) {
      adjuntoReal = false;
    }
  }
  if (!adjuntoReal) {
    const url = await signedUrlAutorizada(comoUsuario, doc.storage_path, EXPIRACION_SIGNED_URL_SEGUNDOS);
    if (url) mensajeConEnlaceAlternativo = `${mensaje}\n\nEl archivo no se pudo adjuntar directamente a este email. Podés verlo acá (enlace temporal, válido 24 horas): ${url}`;
  }

  const resultado = await enviarConResend(contacto.email, asunto, mensajeConEnlaceAlternativo || mensaje, attachments);

  await registrarComunicacion(admin, {
    paciente_id: (paciente && paciente.id) || null,
    atencion_id: null,
    document_id: String(documentId),
    tipo: 'document_delivery',
    canal: 'email',
    destinatario: contacto.email,
    recipient_source: contacto.emailFuente,
    recipient_name: contacto.emailNombre || null,
    subject: asunto,
    // Nunca el enlace firmado real en el registro permanente (punto 8 de
    // la tarea): si hubo enlace alternativo, se guarda el mensaje SIN él.
    message: mensaje,
    status: resultado.ok ? 'sent' : 'failed',
    provider: 'resend',
    provider_message_id: resultado.ok ? resultado.providerMessageId : null,
    error_message: resultado.ok ? null : resultado.motivo,
    sent_at: resultado.ok ? new Date().toISOString() : null,
    created_by: uid
  });

  let avisoProfesional = { enviado: false, motivo: 'no_intentado' };
  if (resultado.ok) {
    try {
      avisoProfesional = await intentarAvisoProfesional(admin, doc, (paciente && paciente.nombre_completo) || '', uid, 'email');
    } catch (error) {
      logErrorSeguro('aviso-profesional-email', error);
      avisoProfesional = { enviado: false, motivo: 'error_interno' };
    }
  }

  return jsonResponse({ ok: true, enviado: resultado.ok, motivo: resultado.ok ? null : resultado.motivo, adjuntoReal, avisoProfesional });
}

async function manejarPrepareWhatsapp(admin, comoUsuario, body, uid) {
  const { documentId } = body || {};
  if (!documentId) return errorResponse('Falta documentId.', 400);

  const doc = await obtenerDocumentoAutorizado(comoUsuario, documentId);
  if (!doc) return errorResponse('Documento no encontrado o sin acceso.', 404);

  const paciente = await obtenerPaciente(admin, doc.patient_id);
  const contacto = resolverDestinatarios(null, paciente);
  if (!contacto.telefono) return errorResponse('No hay número de WhatsApp disponible.', 409);

  if (await envioRecienteExiste(admin, documentId, 'whatsapp', contacto.telefono)) {
    return jsonResponse({ ok: true, duplicado: true });
  }

  // Ajuste WhatsApp (posterior a 6E.1): ya NO se manda el signed URL crudo
  // de Storage. Se crea un enlace corto propio (cardiolink_document_access_links,
  // 7 días) y ESE es el único link que entra al mensaje - el signed URL
  // real se genera recién cuando alguien lo abre (patient-document-open),
  // de vida mucho más corta. El mensaje que se persiste en
  // cardiolink_communications es exactamente el mismo que se envía: ya es
  // seguro, no hay ningún token de Storage adentro.
  let enlaceCorto;
  try {
    const { token } = await crearEnlaceCortoV1(admin, doc.id, uid, 'whatsapp');
    enlaceCorto = resolverUrlCortaV1(token);
  } catch (error) {
    logErrorSeguro('crear-enlace-corto', error);
    return errorResponse('No se pudo generar el enlace del documento.', 500);
  }

  const config = await obtenerConfig(admin);
  const profesional = resolverProfesionalDocumentoV1(config, doc);
  const nombreDestinatario = contacto.telefonoNombre || (paciente && paciente.nombre_completo) || '';
  // Bloque 6E.2 - Orden/Certificado/Constancia (generados desde
  // CardioLink) usan su propia plantilla (punto 15 de la tarea: "NO usar
  // la plantilla clínica de 'estudio' literalmente para un certificado").
  // Cualquier otro document_type (Estudio/Informe/Imagen clínica/etc.,
  // 6E.1) sigue exactamente igual que antes de este bloque.
  const esDocumentoGenerado = TIPOS_DOCUMENTO_GENERADO_V1.includes(doc.document_type);
  const mensaje = esDocumentoGenerado
    ? armarMensajeWhatsappDocumentoGenerado({
        nombreDestinatario,
        tipoDocumento: doc.document_type,
        profesionalNombre: (profesional && profesional.nombre) || null,
        enlaceCorto
      })
    : armarMensajeWhatsappDocumentoOficial({
        nombreDestinatario,
        estudio: doc.title || doc.document_type,
        profesionalNombre: (profesional && profesional.nombre) || null,
        enlaceCorto
      });

  await registrarComunicacion(admin, {
    paciente_id: (paciente && paciente.id) || null,
    atencion_id: null,
    document_id: String(documentId),
    tipo: 'document_delivery',
    canal: 'whatsapp',
    destinatario: contacto.telefono,
    recipient_source: contacto.telefonoFuente,
    recipient_name: contacto.telefonoNombre || null,
    subject: null,
    message: mensaje,
    status: 'manual_started',
    provider: null,
    provider_message_id: null,
    error_message: null,
    sent_at: new Date().toISOString(),
    created_by: uid
  });

  let avisoProfesional = { enviado: false, motivo: 'no_intentado' };
  try {
    avisoProfesional = await intentarAvisoProfesional(admin, doc, (paciente && paciente.nombre_completo) || '', uid, 'whatsapp');
  } catch (error) {
    logErrorSeguro('aviso-profesional-whatsapp', error);
    avisoProfesional = { enviado: false, motivo: 'error_interno' };
  }

  return jsonResponse({ ok: true, telefono: contacto.telefono, mensaje, expiraEnDias: 7, avisoProfesional });
}

Deno.serve(async function (req) {
  const corsHeaders = corsHeadersPara(req.headers.get('origin') || '', req.headers.get('access-control-request-headers') || '');
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== 'POST') return conCors(errorResponse('Método no permitido.', 405), corsHeaders);

  let body;
  try {
    body = await req.json();
  } catch (_error) {
    return conCors(errorResponse('Cuerpo inválido.', 400), corsHeaders);
  }

  const accion = String((body && body.action) || '');
  console.log('patient-document-delivery', accion);

  const authHeader = req.headers.get('authorization') || '';
  const jwt = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7) : '';
  const auth = await autenticar(jwt);
  if (!auth.ok) return conCors(errorResponse('No autorizado.', 403), corsHeaders);

  try {
    const admin = clienteServicio();
    let respuesta;
    if (accion === 'send-email') respuesta = await manejarSendEmail(admin, auth.comoUsuario, body, auth.uid);
    else if (accion === 'prepare-whatsapp') respuesta = await manejarPrepareWhatsapp(admin, auth.comoUsuario, body, auth.uid);
    else respuesta = errorResponse('Acción no reconocida.', 400);
    return conCors(respuesta, corsHeaders);
  } catch (error) {
    logErrorSeguro(accion, error);
    return conCors(errorResponse('No se pudo completar la operación. Probá de nuevo en un momento.', 500), corsHeaders);
  }
});
