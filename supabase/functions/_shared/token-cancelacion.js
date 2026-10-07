// CardioLink Admin — Comunicaciones V1.2, Bloque B1 · token de cancelación
//
// Funciones puras (sin red, sin Supabase), usadas por dos Edge Functions
// distintas: patient-communications firma el token al componer el email de
// confirmación (todavía no conectado - eso es Bloque B2);
// appointment-cancellation-public lo verifica al recibir "info"/"confirmar".
// Mismo patrón que _shared/comunicaciones-logica.js: lógica compartida
// separada del transporte HTTP, una sola implementación para ambas.
//
// Sólo Web Crypto nativo de Deno (crypto.subtle) - sin librerías externas,
// sin dependencia de ningún paquete de JWT.
//
// El secret (APPOINTMENT_CANCEL_TOKEN_SECRET) NUNCA se lee ni se referencia
// acá: este archivo recibe el secret ya resuelto como parámetro - quien lo
// llama (la Edge Function) es responsable de leerlo de Deno.env, nunca del
// cliente, nunca de un query string, nunca del repositorio.

const CODIFICADOR = new TextEncoder();
const DECODIFICADOR = new TextDecoder();

// Margen fijo: el enlace sigue siendo válido hasta 24h DESPUÉS de la
// fecha+hora programada del turno - no una expiración arbitraria (ej. "90
// días"), sino atada al propio turno. Un turno reprogramado lejos en el
// futuro sigue teniendo su enlace vigente hasta bien pasada esa fecha
// nueva (ver Bloque B0: el chequeo de fecha/horaInicio contra el snapshot
// del token corta aparte cualquier intento de usar un link viejo sobre un
// turno reprogramado, independientemente de esta expiración).
const MARGEN_EXPIRACION_SEGUNDOS = 24 * 60 * 60;

function base64UrlEncode(bytes) {
  let binario = '';
  bytes.forEach((b) => { binario += String.fromCharCode(b); });
  return btoa(binario).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(texto) {
  const base64 = String(texto || '').replace(/-/g, '+').replace(/_/g, '/');
  const relleno = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binario = atob(relleno);
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
  return bytes;
}

async function importarClaveHmac(secret) {
  if (!secret || typeof secret !== 'string') throw new Error('Falta el secret de firma.');
  return crypto.subtle.importKey(
    'raw',
    CODIFICADOR.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

// Argentina es UTC-3 fijo, sin horario de verano desde 2009 (mismo criterio
// exacto que la función SQL cardiolink_intentar_datetime_turno, ver
// supabase/migrations/20260828120000_..._communications_schema.sql): un
// instante "hora local Argentina" X se representa en UTC como X + 3 horas.
// Devuelve epoch ms en UTC, o null si fecha/horaInicio no tienen forma
// válida (nunca lanza, nunca "adivina" un valor por defecto).
function timestampTurnoArgentinaMs(fecha, horaInicio) {
  const mFecha = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(fecha || ''));
  const mHora = /^(\d{2}):(\d{2})$/.exec(String(horaInicio || ''));
  if (!mFecha || !mHora) return null;
  const anio = Number(mFecha[1]);
  const mes = Number(mFecha[2]);
  const dia = Number(mFecha[3]);
  const hora = Number(mHora[1]);
  const minuto = Number(mHora[2]);
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31 || hora > 23 || minuto > 59) return null;
  const ms = Date.UTC(anio, mes - 1, dia, hora + 3, minuto, 0, 0);
  return Number.isFinite(ms) ? ms : null;
}

function formatoFechaValido(fecha) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(fecha || ''));
}

function formatoHoraValido(hora) {
  return /^\d{2}:\d{2}$/.test(String(hora || ''));
}

// Firma un token de cancelación NUEVO. `exp` se calcula acá mismo, en
// runtime, a partir de fecha/horaInicio recibidos - nunca se acepta un
// `exp` externo como parámetro (evitaría que el propio proceso de firma
// pudiera emitir un token con vencimiento arbitrario).
//
// Devuelve { ok:true, token } o { ok:false, motivo } - nunca lanza.
export async function crearTokenCancelacion({ atencionId, fecha, horaInicio }, secret) {
  const idLimpio = String(atencionId || '').trim();
  if (!idLimpio) return { ok: false, motivo: 'atencionId inválido.' };
  if (!formatoFechaValido(fecha)) return { ok: false, motivo: 'fecha inválida.' };
  if (!formatoHoraValido(horaInicio)) return { ok: false, motivo: 'horaInicio inválido.' };

  const turnoMs = timestampTurnoArgentinaMs(fecha, horaInicio);
  if (turnoMs === null) return { ok: false, motivo: 'fecha/horaInicio inválidos.' };

  const exp = Math.floor(turnoMs / 1000) + MARGEN_EXPIRACION_SEGUNDOS;
  const ahoraSegundos = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(exp) || exp <= ahoraSegundos) {
    // El turno ya pasó hace más del margen permitido en el momento mismo de
    // componer el email (envío muy demorado, o turno ya vencido) - no tiene
    // sentido emitir un enlace que nace expirado.
    return { ok: false, motivo: 'El turno ya venció; no corresponde emitir un enlace de cancelación.' };
  }

  let claveHmac;
  try {
    claveHmac = await importarClaveHmac(secret);
  } catch (_error) {
    return { ok: false, motivo: 'No se pudo firmar el token.' };
  }

  const payload = { atencionId: idLimpio, purpose: 'cancellation', fecha, horaInicio, exp };
  const payloadB64 = base64UrlEncode(CODIFICADOR.encode(JSON.stringify(payload)));

  let firmaBuffer;
  try {
    firmaBuffer = await crypto.subtle.sign('HMAC', claveHmac, CODIFICADOR.encode(payloadB64));
  } catch (_error) {
    return { ok: false, motivo: 'No se pudo firmar el token.' };
  }
  const firmaB64 = base64UrlEncode(new Uint8Array(firmaBuffer));

  return { ok: true, token: `${payloadB64}.${firmaB64}` };
}

// Verifica un token de cancelación. Orden exacto: 1) forma (2 partes no
// vacías), 2) firma (crypto.subtle.verify - nunca comparación manual de
// strings, evita timing attacks triviales), 3) recién ahí se confía en el
// contenido: se parsea el JSON y se revalida CADA campo de nuevo (purpose,
// atencionId, fecha, horaInicio, exp) - un payload que pasó la firma pero
// tiene una forma corrupta/vieja igual se rechaza. Nunca lanza; cualquier
// error devuelve { ok:false, motivo } genérico, nunca detalle criptográfico
// (no distingue "firma inválida" de "formato inválido" en el mensaje, para
// no darle a un atacante información sobre por qué falló exactamente).
export async function verificarTokenCancelacion(token, secret) {
  const MOTIVO_GENERICO = 'No se pudo validar el enlace.';
  const partes = String(token || '').split('.');
  if (partes.length !== 2 || !partes[0] || !partes[1]) return { ok: false, motivo: MOTIVO_GENERICO };
  const [payloadB64, firmaB64] = partes;

  let claveHmac;
  try {
    claveHmac = await importarClaveHmac(secret);
  } catch (_error) {
    return { ok: false, motivo: 'Servicio no disponible en este momento.' };
  }

  let firmaValida = false;
  try {
    const firmaBytes = base64UrlDecode(firmaB64);
    firmaValida = await crypto.subtle.verify('HMAC', claveHmac, firmaBytes, CODIFICADOR.encode(payloadB64));
  } catch (_error) {
    firmaValida = false;
  }
  if (!firmaValida) return { ok: false, motivo: MOTIVO_GENERICO };

  let payload;
  try {
    const jsonBytes = base64UrlDecode(payloadB64);
    payload = JSON.parse(DECODIFICADOR.decode(jsonBytes));
  } catch (_error) {
    return { ok: false, motivo: MOTIVO_GENERICO };
  }
  if (!payload || typeof payload !== 'object') return { ok: false, motivo: MOTIVO_GENERICO };
  if (payload.purpose !== 'cancellation') return { ok: false, motivo: MOTIVO_GENERICO };

  const atencionId = String(payload.atencionId || '').trim();
  if (!atencionId) return { ok: false, motivo: MOTIVO_GENERICO };
  if (!formatoFechaValido(payload.fecha)) return { ok: false, motivo: MOTIVO_GENERICO };
  if (!formatoHoraValido(payload.horaInicio)) return { ok: false, motivo: MOTIVO_GENERICO };
  if (!Number.isFinite(payload.exp) || !Number.isInteger(payload.exp)) return { ok: false, motivo: MOTIVO_GENERICO };

  const ahoraSegundos = Math.floor(Date.now() / 1000);
  if (payload.exp <= ahoraSegundos) return { ok: false, motivo: 'Este enlace venció.' };

  return {
    ok: true,
    payload: {
      atencionId,
      purpose: 'cancellation',
      fecha: payload.fecha,
      horaInicio: payload.horaInicio,
      exp: payload.exp
    }
  };
}
