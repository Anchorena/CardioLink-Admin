// CardioLink · Documentos V2A / F3 — Edge Function PÚBLICA de verificación de autenticidad (verify_jwt = false, ver supabase/config.toml).
// Recibe el código del QR (POST, nunca en la URL), lo hashea y consulta cardiolink_verificacion_consultar_v1 con service_role. Devuelve SOLO: estado
// (vigente / reemplazado / anulado), tipo genérico, fecha de emisión, profesional y matrículas y una huella corta. Nunca datos del paciente ni del contenido.
// Códigos inválidos / inexistentes / no disponibles => la MISMA respuesta. Protección: Turnstile fail-closed antes de tocar la base, CORS por lista de
// orígenes, límite de tasa (mejor esfuerzo) y bitácora con IP hasheada (la escribe la propia RPC).
// Secrets (ninguno en el repo): VERIFY_TURNSTILE_SECRET_KEY (widget propio de esta verificación; OBLIGATORIO y sin fallback: nunca se usa TURNSTILE_SECRET_KEY, la del portal), VERIFY_TURNSTILE_HOSTNAMES (OBLIGATORIO: hostnames autorizados del widget,
// separados por comas; sin lista no se acepta ningún token), VERIFY_TURNSTILE_ACTION (opcional: acción esperada), VERIFY_ALLOWED_ORIGINS (CORS; localhost siempre
// permitido para pruebas), VERIFY_IP_SALT (opcional: por defecto se deriva del service role).
// Límite de tasa: en memoria (barato, primera barrera) + PERSISTENTE y compartido entre instancias vía cardiolink_verificacion_limitar_v1 (SQL propuesto aparte).
// Si la RPC del límite persistente falla => 503 sin consultar certificados (fail-closed; el límite en memoria es sólo una barrera adicional, nunca un reemplazo).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { validarCodigo, RESPUESTA_NO_VERIFICABLE, construirRespuesta, clasificarUA, limpiarIp, crearLimitador, listaDesdeEnv, evaluarTurnstile } from './logica.js';

const CONFIG_ROW_ID = '__cardiolink_config_v1';
const MAX_BODY_BYTES = 2048;
const limitePorIp = crearLimitador({ max: 30, ventanaMs: 10 * 60 * 1000 });
const limiteGlobal = crearLimitador({ max: 600, ventanaMs: 60 * 1000 });

const PREFIJOS_ORIGEN_LOCAL = ['http://localhost', 'http://127.0.0.1', 'http://[::1]'];
function esOrigenLocal(origen) {
  return PREFIJOS_ORIGEN_LOCAL.some((p) => origen === p || origen.startsWith(p + ':'));
}
function origenesPermitidos() {
  return (Deno.env.get('VERIFY_ALLOWED_ORIGINS') || '').split(',').map((o) => o.trim()).filter(Boolean);
}
function cabeceras(origen) {
  const h = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin'
  };
  if (origen && (esOrigenLocal(origen) || origenesPermitidos().includes(origen))) h['Access-Control-Allow-Origin'] = origen;
  return h;
}
function responder(cuerpo, status, origen) {
  return new Response(JSON.stringify(cuerpo), { status, headers: cabeceras(origen) });
}

async function sha256Hex(texto) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Turnstile: obligatorio y fail-closed (sin secret, sin hostnames autorizados, sin token válido, con otro hostname/acción o ante cualquier error no se consulta nada).
async function verificarTurnstile(token, ip) {
  const secret = Deno.env.get('VERIFY_TURNSTILE_SECRET_KEY');   // sólo el secret propio de la verificación: sin fallback a otro widget ni a una clave de prueba
  if (!secret || typeof token !== 'string' || !token || token.length > 2048) return false;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const cuerpo = new URLSearchParams();
    cuerpo.append('secret', secret);
    cuerpo.append('response', token);
    if (ip) cuerpo.append('remoteip', ip);
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: cuerpo, signal: ctl.signal });
    const j = await r.json();
    return evaluarTurnstile(j, { hostnames: listaDesdeEnv(Deno.env.get('VERIFY_TURNSTILE_HOSTNAMES')), accion: (Deno.env.get('VERIFY_TURNSTILE_ACTION') || '').trim() }).ok;
  } catch (_e) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Uso ÚNICO del token, impuesto por CardioLink: en STAGING (2026-10-31) Siteverify aceptó dos veces el mismo token real. Sólo viaja el SHA-256 del token; la
// RPC (INSERT .. ON CONFLICT DO NOTHING) decide atómicamente quién llegó primero. true = primer uso; false = ya usado; null = falla => FAIL-CLOSED (503).
async function consumirToken(admin, tokenHash) {
  try {
    const { data, error } = await admin.rpc('cardiolink_verificacion_token_usar_v1', { p_token_hash: tokenHash, p_ttl_seg: 600 });
    if (error || typeof data !== 'boolean') return null;
    return data;
  } catch (_e) {
    return null;
  }
}

// Límite PERSISTENTE y compartido entre instancias (tabla cardiolink_verificacion_limites vía RPC). Devuelve true/false, o null si la RPC falla o responde
// algo inesperado. FAIL-CLOSED: ante null el llamador responde 503 y NO consulta certificados (sin límite verificable no se atiende; no hay fallback permisivo).
async function limitarPersistente(admin, clave, max, ventanaSeg) {
  try {
    const { data, error } = await admin.rpc('cardiolink_verificacion_limitar_v1', { p_clave: clave, p_max: max, p_ventana_seg: ventanaSeg });
    if (error || typeof data !== 'boolean') return null;
    return data;
  } catch (_e) {
    return null;
  }
}

function clienteServicio() {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.');
  return createClient(url, key, { auth: { persistSession: false } });
}

Deno.serve(async function (req) {
  const origen = req.headers.get('origin') || '';
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cabeceras(origen) });
  if (req.method !== 'POST') return responder({ ok: false, error: 'metodo' }, 405, origen);

  try {
    const texto = await req.text();
    if (texto.length > MAX_BODY_BYTES) return responder({ ok: false, error: 'solicitud' }, 413, origen);
    let body = null;
    try { body = JSON.parse(texto); } catch (_e) { body = null; }
    if (!body || typeof body !== 'object') return responder({ ok: false, error: 'solicitud' }, 400, origen);

    // F4 (acceso al PDF completo con PIN): todavía no habilitado. Respuesta fija, sin tocar la base.
    if (body.accion === 'acceso-pdf') return responder({ ok: false, error: 'no_habilitado' }, 501, origen);

    const ip = limpiarIp(req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || '');
    const sal = Deno.env.get('VERIFY_IP_SALT') || (await sha256Hex('verify-ip:' + (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '')));
    const ipHash = ip ? (await sha256Hex(sal + ':' + ip)).slice(0, 32) : null;

    if (!limiteGlobal.permitir('global') || !limitePorIp.permitir(ipHash || 'sin-ip')) return responder({ ok: false, error: 'demasiados_intentos' }, 429, origen);

    // Turnstile ANTES de cualquier consulta: sin desafío resuelto no hay forma de probar códigos.
    if (!(await verificarTurnstile(body.turnstileToken, ip))) return responder({ ok: false, error: 'verificacion_humana' }, 403, origen);

    // Uso único del token: un token ya consumido (aunque Siteverify lo acepte) se rechaza igual que uno inválido; si no se puede comprobar, 503 y no se consulta nada.
    const admin = clienteServicio();
    const tokenNuevo = await consumirToken(admin, await sha256Hex(body.turnstileToken));
    if (tokenNuevo === null) return responder({ ok: false, error: 'no_disponible' }, 503, origen);
    if (tokenNuevo === false) return responder({ ok: false, error: 'verificacion_humana' }, 403, origen);

    // Límite persistente (sólo para quien ya resolvió Turnstile: los bots sin desafío no escriben en la base). Cuenta también los códigos inválidos.
    const limiteIp = await limitarPersistente(admin, 'ip:' + (ipHash || 'sin-ip'), 30, 600);
    if (limiteIp === null) return responder({ ok: false, error: 'no_disponible' }, 503, origen);            // fail-closed: no se consulta nada
    if (limiteIp === false) return responder({ ok: false, error: 'demasiados_intentos' }, 429, origen);
    const limiteGlobalDb = await limitarPersistente(admin, 'global', 600, 60);
    if (limiteGlobalDb === null) return responder({ ok: false, error: 'no_disponible' }, 503, origen);
    if (limiteGlobalDb === false) return responder({ ok: false, error: 'demasiados_intentos' }, 429, origen);

    // Formato inválido => misma respuesta que un código inexistente (y sin consultar la base).
    if (!validarCodigo(body.codigo)) return responder(RESPUESTA_NO_VERIFICABLE, 200, origen);

    const { data: rpc, error } = await admin.rpc('cardiolink_verificacion_consultar_v1', {
      p_code_hash: await sha256Hex(body.codigo), p_ip_hash: ipHash, p_ua_class: clasificarUA(req.headers.get('user-agent'))
    });
    if (error) throw error;   // falla de infraestructura: igual para cualquier código

    let config = null;
    if (rpc && rpc.encontrado === true) {
      try {
        const { data } = await admin.from('cardiolink_atenciones').select('payload').eq('id', CONFIG_ROW_ID).limit(1);
        config = (data && data.length && data[0].payload && data[0].payload.config) || null;
      } catch (_e) { config = null; }   // sin config se verifica igual, sin datos del profesional
    }
    return responder(construirRespuesta(rpc, config), 200, origen);
  } catch (_error) {
    console.error('document-verify error');
    return responder({ ok: false, error: 'no_disponible' }, 503, origen);
  }
});
