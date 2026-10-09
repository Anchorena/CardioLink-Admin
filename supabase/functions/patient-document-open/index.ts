// CardioLink Admin — Edge Function "patient-document-open" (Ajuste WhatsApp, posterior a 6E.1)
//
// NO DESPLEGADA EN PRODUCTION — sólo STAGING, para QA.
//
// Endpoint PÚBLICO (sin JWT de Supabase: quien toca el enlace desde
// WhatsApp nunca tiene sesión de CardioLink - mismo caso que
// appointment-cancellation-public). Resuelve un token opaco de
// cardiolink_document_access_links a un signed URL de Storage recién
// generado, de vida MUY corta, y redirige ahí. El enlace corto (7 días,
// ver patient-document-delivery) nunca expone ese signed URL real.
//
// Nunca distingue en la respuesta "no existe" de "expiró" de "fue
// revocado" de "el documento ya no existe": siempre el mismo mensaje
// genérico - no darle a quien abre un link viejo/ajeno ninguna pista.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const BUCKET = 'patient-documents';
// Sólo para la redirección inmediata - el enlace corto de 7 días nunca
// expone este signed URL, se genera de nuevo en cada apertura.
const EXPIRACION_SIGNED_URL_SEGUNDOS = 5 * 60;
const MENSAJE_GENERICO = 'Este enlace ya no está disponible.';

function clienteServicio() {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceRoleKey) throw new Error('Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.');
  return createClient(url, serviceRoleKey, { auth: { persistSession: false } });
}

function paginaError(mensaje) {
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CardioLink</title><style>body{font-family:Arial,Helvetica,sans-serif;background:#F4F9FC;color:#0f172a;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px;text-align:center}div{max-width:420px}h1{font-size:18px;color:#082D5B;margin:0 0 10px}p{color:#475569;line-height:1.5;margin:0}</style></head><body><div><h1>CardioLink</h1><p>${mensaje}</p></div></body></html>`;
  return new Response(html, { status: 410, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

async function hashToken(token) {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async function (req) {
  // No es una función llamada por fetch/XHR desde app.js (es un enlace
  // que el paciente toca directo desde WhatsApp) - CORS abierto no debilita
  // nada acá: la única protección real es el token.
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' } });
  }
  if (req.method !== 'GET') return paginaError(MENSAJE_GENERICO);

  try {
    const url = new URL(req.url);
    const token = (url.searchParams.get('token') || '').trim();
    if (!token || token.length < 20) return paginaError(MENSAJE_GENERICO);

    const tokenHash = await hashToken(token);
    const admin = clienteServicio();

    const { data: filas, error } = await admin
      .from('cardiolink_document_access_links')
      .select('document_id, expires_at, revoked_at')
      .eq('token_hash', tokenHash)
      .limit(1);
    if (error) throw error;
    const enlace = filas && filas.length ? filas[0] : null;
    if (!enlace) return paginaError(MENSAJE_GENERICO);
    if (enlace.revoked_at) return paginaError(MENSAJE_GENERICO);
    if (new Date(enlace.expires_at).getTime() <= Date.now()) return paginaError(MENSAJE_GENERICO);

    const { data: docs, error: docError } = await admin
      .from('cardiolink_patient_documents')
      .select('storage_path')
      .eq('id', enlace.document_id)
      .limit(1);
    if (docError) throw docError;
    const documento = docs && docs.length ? docs[0] : null;
    if (!documento) return paginaError(MENSAJE_GENERICO);

    const { data: signed, error: signedError } = await admin.storage
      .from(BUCKET)
      .createSignedUrl(documento.storage_path, EXPIRACION_SIGNED_URL_SEGUNDOS);
    if (signedError || !signed || !signed.signedUrl) return paginaError(MENSAJE_GENERICO);

    return new Response(null, { status: 302, headers: { Location: signed.signedUrl } });
  } catch (_error) {
    console.error('patient-document-open error');
    return paginaError(MENSAJE_GENERICO);
  }
});
