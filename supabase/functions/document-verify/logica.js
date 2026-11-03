// CardioLink · Documentos V2A / F3 — lógica PURA de la verificación pública (sin Deno ni Supabase: se prueba aparte).
// Principio: la respuesta pública se arma campo por campo (lista blanca); nada del paciente ni del contenido entra jamás.

export const CODIGO_RE = /^[A-Za-z0-9_-]{22}$/;   // 128 bits en base64url sin relleno

export function validarCodigo(valor) {
  return typeof valor === 'string' && CODIGO_RE.test(valor);
}

// Respuesta ÚNICA para: código con formato inválido, inexistente, reservado sin emitir, documento eliminado o cualquier dato no verificable.
export const RESPUESTA_NO_VERIFICABLE = Object.freeze({ ok: true, resultado: 'no_verificable' });

const ETIQUETAS_TIPO = Object.freeze({ certificado: 'Certificado médico', constancia: 'Constancia de atención', orden: 'Orden médica' });
const ESTADOS_PUBLICOS = Object.freeze(['vigente', 'reemplazado', 'anulado']);
const FIRMAS = Object.freeze(['sin_firma_digital', 'firmado_pades', 'firmado_externo']);

export function etiquetaTipo(tipo) {
  return Object.prototype.hasOwnProperty.call(ETIQUETAS_TIPO, tipo) ? ETIQUETAS_TIPO[tipo] : null;
}

export function normalizarId(valor) {
  return String(valor == null ? '' : valor).trim().replace(/\s+/g, ' ').toLowerCase();
}

// config = fila de configuración del consultorio (profesionales con matrícula). Comparación sin mayúsculas ni espacios, como el resto de V2A.
export function resolverProfesional(config, professionalId) {
  const id = normalizarId(professionalId);
  if (!id || !config || !Array.isArray(config.profesionales)) return null;
  return config.profesionales.find((p) => p && normalizarId(p.id) === id) || null;
}

function texto(valor, limite) {
  return String(valor == null ? '' : valor).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limite);
}

export function construirRespuesta(rpc, config) {
  if (!rpc || rpc.encontrado !== true) return RESPUESTA_NO_VERIFICABLE;
  if (!ESTADOS_PUBLICOS.includes(rpc.estado)) return RESPUESTA_NO_VERIFICABLE;   // no_disponible y cualquier otro valor
  const tipo = etiquetaTipo(rpc.tipo);
  if (!tipo) return RESPUESTA_NO_VERIFICABLE;
  const prof = resolverProfesional(config, rpc.professional_id);
  const matriculas = prof ? [prof.matriculaNacional, prof.matriculaProvincial].map((m) => texto(m, 40)).filter(Boolean) : [];
  return {
    ok: true,
    resultado: 'verificado',
    estado: rpc.estado,
    tipo,
    emitido: /^\d{4}-\d{2}-\d{2}$/.test(String(rpc.emitido || '')) ? String(rpc.emitido) : null,
    profesional: prof ? { nombre: texto(prof.nombre, 120), especialidad: texto(prof.area, 80), matriculas } : null,
    huella: /^[0-9a-f]{12}$/.test(String(rpc.huella || '')) ? String(rpc.huella) : null,
    firma: FIRMAS.includes(rpc.firma) ? rpc.firma : 'sin_firma_digital',
    // F4: el documento completo se entrega sólo con un PIN temporal que recibe el titular; todavía no está habilitado.
    acceso_pdf: { disponible: false, requiere: 'pin' }
  };
}

export function clasificarUA(ua) {
  const u = String(ua || '').toLowerCase();
  if (!u) return 'otro';
  if (/bot|crawl|spider|curl|wget|python|httpclient|scrapy/.test(u)) return 'automatizado';
  if (/mobile|android|iphone|ipad/.test(u)) return 'movil';
  return 'escritorio';
}

export function limpiarIp(valor) {
  const primera = String(valor || '').split(',')[0].trim();
  return /^[0-9a-fA-F:.]{3,45}$/.test(primera) ? primera : '';
}

// Limitador de tasa en memoria (mejor esfuerzo: por instancia de la función). ahora() inyectable para pruebas.
export function crearLimitador({ max, ventanaMs, maxClaves = 5000, ahora = () => Date.now() }) {
  const mapa = new Map();
  return {
    permitir(clave) {
      const t = ahora();
      if (mapa.size > maxClaves) { for (const [k, v] of mapa) { if (t - v.inicio > ventanaMs) mapa.delete(k); } if (mapa.size > maxClaves) mapa.clear(); }
      const e = mapa.get(clave);
      if (!e || t - e.inicio > ventanaMs) { mapa.set(clave, { inicio: t, n: 1 }); return true; }
      e.n += 1;
      return e.n <= max;
    }
  };
}

// Siteverify de Turnstile (pura): éxito + hostname AUTORIZADO (lista obligatoria) + acción esperada (si se configura). Cloudflare ya invalida cada token tras el
// primer uso (un segundo siteverify devuelve success=false con "timeout-or-duplicate"), así que un token capturado no se puede reutilizar.
export function listaDesdeEnv(valor) {
  return String(valor || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
}
export function evaluarTurnstile(respuesta, { hostnames, accion }) {
  if (!respuesta || respuesta.success !== true) return { ok: false, motivo: 'rechazado' };
  const permitidos = Array.isArray(hostnames) ? hostnames : [];
  if (!permitidos.length) return { ok: false, motivo: 'sin_hostnames_configurados' };            // fail-closed: sin lista no se acepta ningún token
  if (!permitidos.includes(String(respuesta.hostname || '').toLowerCase())) return { ok: false, motivo: 'hostname' };
  if (accion && String(respuesta.action || '') !== accion) return { ok: false, motivo: 'accion' };
  return { ok: true, motivo: null };
}
