// CardioLink Admin — Patient Communications V1 · Edge Function "patient-reminders-24h"
//
// NO DESPLEGADA TODAVÍA. Pensada para ser invocada por un Cron Job de
// Supabase (pg_cron + pg_net), no por el navegador — ver
// supabase/migrations/20260828121000_cardiolink_communications_reminder_cron.sql
// (migración separada y opcional: requiere las extensiones pg_cron/pg_net y
// un secret propio en Vault, configurado fuera del repo).
//
// Corre cada 30 minutos (cadencia acoplada a la ventana de 30 minutos que
// usa el filtro de abajo: turno_ts entre ahora+24h y ahora+24h30m). Cada
// turno confirmado cae en UNA sola ventana de las dos corridas por hora, así
// que un recordatorio nunca se procesa dos veces por el simple paso del
// tiempo. Además, hay un índice único parcial en cardiolink_communications
// (atencion_id, tipo) where tipo='reminder': aunque este proceso se
// reintente o se dispare dos veces por error, el segundo INSERT para el
// mismo turno se descarta solo (on conflict do nothing), nunca duplica.
//
// Seguridad: exige un secret propio (PATIENT_REMINDERS_CRON_SECRET),
// distinto de service_role, en el header Authorization. Sin ese secret
// configurado, la función rechaza toda invocación (fail-closed) — no existe
// un modo "sin secret" que igual mande recordatorios.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { armarMensaje, elegirPlantilla, resolverDestinatarios } from '../_shared/comunicaciones-logica.js';

function jsonResponse(cuerpo, status) {
  return new Response(JSON.stringify(cuerpo), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

function clienteServicio() {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceRoleKey) throw new Error('Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.');
  return createClient(url, serviceRoleKey, { auth: { persistSession: false } });
}

function logErrorSeguro(contexto, error) {
  const codigo = error && error.code ? String(error.code) : 'desconocido';
  console.error('patient-reminders-24h error', contexto, codigo);
}

async function enviarConResend(destinatario, asunto, mensaje) {
  const apiKey = Deno.env.get('RESEND_API_KEY');
  const remitente = Deno.env.get('RESEND_FROM_EMAIL');
  if (!apiKey || !remitente) {
    return { ok: false, motivo: 'Proveedor de email no configurado (falta RESEND_API_KEY o RESEND_FROM_EMAIL).' };
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

// Candidatos: atenciones confirmadas, con fecha+horaInicio válidos, cuyo
// instante calculado cae entre ahora+24h y ahora+24h30m (ver comentario de
// cabecera). Se calcula en SQL sobre el jsonb, sin traer todo a memoria.
async function buscarCandidatos(admin) {
  const { data, error } = await admin.rpc('cardiolink_atenciones_para_recordatorio_24h');
  if (error) throw error;
  return data || [];
}

async function yaRecordado(admin, atencionId) {
  const { data, error } = await admin
    .from('cardiolink_communications')
    .select('id')
    .eq('atencion_id', String(atencionId))
    .eq('tipo', 'reminder')
    .limit(1);
  if (error) throw error;
  return !!(data && data.length);
}

async function obtenerDireccionConsultorio(admin) {
  const { data, error } = await admin.from('cardiolink_comunicaciones_config').select('direccion_consultorio').limit(1);
  if (error) return null;
  return data && data.length ? data[0].direccion_consultorio : null;
}

async function obtenerPlantillas(admin) {
  const { data, error } = await admin.from('cardiolink_prestacion_templates').select('*');
  if (error) throw error;
  return data || [];
}

// Mismo mecanismo de resolución que patient-communications (paciente ->
// contacto responsable -> ningún canal), vía la misma función compartida:
// paciente.email si existe; si no, cardiolink_pacientes.contacto_responsable_email;
// si tampoco, no se genera envío (nunca se registra "failed" por esto).
async function obtenerPaciente(admin, pacienteId) {
  if (!pacienteId) return null;
  const { data, error } = await admin
    .from('cardiolink_pacientes')
    .select('id, nombre_completo, email, telefono, contacto_responsable_nombre, contacto_responsable_telefono, contacto_responsable_email')
    .eq('id', String(pacienteId))
    .limit(1);
  if (error || !data || !data.length) return null;
  return data[0];
}

Deno.serve(async function (req) {
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'Método no permitido.' }, 405);

  const secretEsperado = Deno.env.get('PATIENT_REMINDERS_CRON_SECRET');
  const authHeader = req.headers.get('authorization') || '';
  const recibido = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7) : '';
  if (!secretEsperado || recibido !== secretEsperado) {
    return jsonResponse({ ok: false, error: 'No autorizado.' }, 403);
  }

  let admin;
  try {
    admin = clienteServicio();
  } catch (error) {
    logErrorSeguro('init', error);
    return jsonResponse({ ok: false, error: 'No se pudo inicializar el cliente de Supabase.' }, 500);
  }

  const resumen = { procesados: 0, enviados: 0, fallidos: 0, sin_email: 0, ya_recordados: 0 };

  let candidatos;
  try {
    candidatos = await buscarCandidatos(admin);
  } catch (error) {
    logErrorSeguro('buscar-candidatos', error);
    return jsonResponse({ ok: false, error: 'No se pudo buscar turnos candidatos.' }, 500);
  }

  const [direccionConsultorio, plantillas] = await Promise.all([
    obtenerDireccionConsultorio(admin),
    obtenerPlantillas(admin)
  ]);

  for (const fila of candidatos) {
    resumen.procesados++;
    const atencionId = String(fila.id);
    const atencion = fila.payload || {};
    try {
      if (await yaRecordado(admin, atencionId)) { resumen.ya_recordados++; continue; }

      const paciente = await obtenerPaciente(admin, atencion.pacienteId);
      const contacto = resolverDestinatarios(atencion, paciente);
      // Sin email (ni del paciente ni del contacto responsable): no se
      // genera ningún envío ni fila. Nunca se cuenta como fallo.
      if (!contacto.email) { resumen.sin_email++; continue; }

      const template = elegirPlantilla(plantillas, atencion.prestacion);
      const { asunto, mensaje } = armarMensaje({ tipo: 'reminder', atencion, template, direccionConsultorio });

      // Reclama el turno ANTES de llamar a Resend (no después): si dos
      // corridas se solapan (reintento, cron atrasado, ejecución manual
      // dos veces casi simultánea), la que pierde la carrera del índice
      // único (atencion_id, tipo) corta acá y nunca llega a enviar un
      // segundo email real - la comprobación previa (yaRecordado) evita el
      // trabajo de más en el caso normal, pero sólo este INSERT es la
      // garantía real contra el envío duplicado, no sólo la fila duplicada.
      const { data: filaReservada, error: insertError } = await admin
        .from('cardiolink_communications')
        .insert({
          paciente_id: contacto.pacienteId || null,
          atencion_id: atencionId,
          tipo: 'reminder',
          canal: 'email',
          destinatario: contacto.email,
          recipient_source: contacto.emailFuente,
          recipient_name: contacto.emailNombre || null,
          subject: asunto,
          message: mensaje,
          status: 'pending',
          provider: 'resend',
          provider_message_id: null,
          error_message: null,
          sent_at: null,
          created_by: null
        })
        .select('id')
        .single();
      if (insertError) {
        if (insertError.code === '23505') { resumen.ya_recordados++; continue; }
        throw insertError;
      }

      const resultado = await enviarConResend(contacto.email, asunto, mensaje);
      const { error: updateError } = await admin
        .from('cardiolink_communications')
        .update({
          status: resultado.ok ? 'sent' : 'failed',
          provider_message_id: resultado.ok ? resultado.providerMessageId : null,
          error_message: resultado.ok ? null : resultado.motivo,
          sent_at: resultado.ok ? new Date().toISOString() : null
        })
        .eq('id', filaReservada.id);
      if (updateError) throw updateError;

      if (resultado.ok) resumen.enviados++; else resumen.fallidos++;
    } catch (error) {
      resumen.fallidos++;
      logErrorSeguro('atencion:' + atencionId, error);
    }
  }

  console.log('patient-reminders-24h', JSON.stringify(resumen));
  return jsonResponse({ ok: true, resumen });
});
