// CardioLink Admin — Patient Communications V1 · lógica compartida
//
// Funciones puras, sin efectos de red ni de Supabase, usadas por las dos
// Edge Functions de este módulo (patient-communications y
// patient-reminders-24h). Mismo patrón que portal-gateway/logica.js: la
// lógica de negocio vive separada del transporte HTTP, así ambas funciones
// componen el mensaje exactamente igual (una sola implementación).

// -----------------------------------------------------------------------
// Normalización de teléfono para wa.me (WhatsApp Web/App deep link).
// wa.me exige el número completo en formato internacional, solo dígitos,
// sin "+", sin espacios. Convención argentina: si viene con 0 o 15
// "locales" se limpian; si no trae código de país, se antepone 54.
// -----------------------------------------------------------------------
export function normalizarTelefonoWhatsApp(telefono, codigoPais = '54') {
  let digitos = String(telefono || '').replace(/\D/g, '');
  if (!digitos) return null;
  // 0011549... / 0054... (prefijo de discado internacional local) -> 549...
  if (digitos.startsWith('00')) digitos = digitos.slice(2);
  // Ya viene con código de país -> se respeta tal cual.
  if (digitos.startsWith(codigoPais)) {
    // nada que hacer
  } else {
    // Convención local: 0343154... / 343154... (0 y 15 opcionales) -> quitar 0 inicial y 15 de móvil.
    digitos = digitos.replace(/^0/, '');
    digitos = digitos.replace(/^(\d{2,4})15/, '$1');
    digitos = codigoPais + digitos;
  }
  // Un número real (AR) normalizado queda entre 12 y 13 dígitos (54 + área + número).
  if (digitos.length < 10 || digitos.length > 15) return null;
  return digitos;
}

export function emailValido(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

// -----------------------------------------------------------------------
// Resolución de destinatario por canal, con prioridad:
//   1) el paciente mismo (snapshot de la atención, o si falta ahí, la
//      ficha canónica cardiolink_pacientes);
//   2) si el paciente no tiene ese canal, el contacto responsable/familiar
//      de su ficha (cardiolink_pacientes.contacto_responsable_*);
//   3) si tampoco existe, ese canal directamente no se ofrece (nunca se
//      registra como fallo: la ausencia de canal no es un error).
// Cada canal se resuelve de forma INDEPENDIENTE: el email puede venir del
// paciente mientras el teléfono viene del responsable, o viceversa - no es
// "todo del paciente o todo del responsable".
// `paciente` es la fila de cardiolink_pacientes (puede ser null si no hay
// pacienteId o no se encontró); `atencion` es el payload de la atención.
// -----------------------------------------------------------------------
export function resolverDestinatarios(atencion, paciente) {
  const nombrePaciente = (atencion && atencion.paciente) || (paciente && paciente.nombre_completo) || '';
  const nombreResponsable = (paciente && paciente.contacto_responsable_nombre) || '';

  const emailPaciente = (atencion && atencion.email) || (paciente && paciente.email) || '';
  const emailResponsable = (paciente && paciente.contacto_responsable_email) || '';
  let email = '', emailFuente = null;
  if (emailValido(emailPaciente)) { email = emailPaciente; emailFuente = 'patient'; }
  else if (emailValido(emailResponsable)) { email = emailResponsable; emailFuente = 'responsible_contact'; }

  const telefonoPacienteNorm = normalizarTelefonoWhatsApp((atencion && atencion.telefono) || (paciente && paciente.telefono) || '');
  const telefonoResponsableNorm = normalizarTelefonoWhatsApp((paciente && paciente.contacto_responsable_telefono) || '');
  let telefono = '', telefonoFuente = null;
  if (telefonoPacienteNorm) { telefono = telefonoPacienteNorm; telefonoFuente = 'patient'; }
  else if (telefonoResponsableNorm) { telefono = telefonoResponsableNorm; telefonoFuente = 'responsible_contact'; }

  return {
    // OJO: nunca usar atencion.pacienteId acá como respaldo. Ese valor es
    // el snapshot que quedó en la atención al momento de la carga y puede
    // no existir en cardiolink_pacientes (ej.: alta que chocó contra un
    // DNI ya existente y dejó un pacienteId huérfano en la atención,
    // ver auditoría aparte). paciente es el resultado de una consulta real
    // a cardiolink_pacientes (obtenerPaciente() en cada Edge Function): si
    // no encontró fila, paciente es null y acá se devuelve '' - nunca un
    // id sin validar, para no romper la FK de cardiolink_communications.paciente_id
    // al insertar el registro de la comunicación.
    pacienteId: (paciente && paciente.id) || '',
    email,
    emailFuente,
    emailNombre: emailFuente === 'patient' ? nombrePaciente : (emailFuente === 'responsible_contact' ? nombreResponsable : ''),
    telefono,
    telefonoFuente,
    telefonoNombre: telefonoFuente === 'patient' ? nombrePaciente : (telefonoFuente === 'responsible_contact' ? nombreResponsable : ''),
    sinCanales: !email && !telefono
  };
}

// -----------------------------------------------------------------------
// Normaliza el nombre de una prestación para buscar su plantilla:
// minúsculas, sin acentos, sin espacios de más. "Ecocardiograma Doppler"
// y "ecocardiograma  doppler" resuelven a la misma clave.
// -----------------------------------------------------------------------
export function normalizarPrestacion(prestacion) {
  return String(prestacion || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Reemplazo simple de tokens {{token}}. Un token sin valor conocido se
// reemplaza por cadena vacía (nunca deja "{{x}}" literal en un mensaje que
// puede llegar a leer el paciente).
export function renderPlantilla(texto, variables) {
  return String(texto || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, clave) => {
    const valor = variables ? variables[clave] : undefined;
    return valor === undefined || valor === null ? '' : String(valor);
  });
}

// Plantillas de respaldo si no hay ninguna fila configurada para la
// prestación ni fila "_default": mismo tono/contenido que
// app.js textoWsTurno350() (v3.4), la única fuente de texto por
// prestación que ya existía en el proyecto antes de este módulo.
export const PLANTILLAS_RESPALDO = Object.freeze({
  confirmacion: 'Hola {{paciente}}. Confirmamos su turno para {{prestacion}} el {{fecha}}{{hora}} con {{profesional}}.{{direccion}} {{instrucciones}}',
  recordatorio: 'Hola {{paciente}}. Le recordamos su turno para {{prestacion}} el {{fecha}}{{hora}} con {{profesional}}.{{direccion}} {{instrucciones}}',
  reprogramacion: 'Hola {{paciente}}. Su turno para {{prestacion}} fue reprogramado para el {{fecha}}{{hora}} con {{profesional}}.{{direccion}} {{instrucciones}}',
  cancelacion: 'Hola {{paciente}}. Su turno para {{prestacion}} del {{fecha}}{{hora}} fue cancelado. Ante cualquier consulta, comuníquese con el consultorio.'
});

export const ASUNTO_RESPALDO = Object.freeze({
  confirmation: 'Confirmación de turno — CardioLink',
  reminder: 'Recordatorio de turno — CardioLink',
  reschedule: 'Turno reprogramado — CardioLink',
  cancellation: 'Turno cancelado — CardioLink'
});

const CAMPO_PLANTILLA_POR_TIPO = Object.freeze({
  confirmation: 'plantilla_confirmacion',
  reminder: 'plantilla_recordatorio',
  reschedule: 'plantilla_reprogramacion',
  cancellation: 'plantilla_cancelacion'
});

const CLAVE_RESPALDO_POR_TIPO = Object.freeze({
  confirmation: 'confirmacion',
  reminder: 'recordatorio',
  reschedule: 'reprogramacion',
  cancellation: 'cancelacion'
});

// Elige la fila de plantilla más específica: prestación exacta normalizada,
// si no existe cae a la fila '_default'. `filas` es el resultado crudo de
// select * from cardiolink_prestacion_templates.
export function elegirPlantilla(filas, prestacion) {
  const clave = normalizarPrestacion(prestacion);
  const lista = Array.isArray(filas) ? filas : [];
  return lista.find((f) => f.prestacion_normalizada === clave && f.activo !== false)
    || lista.find((f) => f.prestacion_normalizada === '_default' && f.activo !== false)
    || null;
}

// Arma {asunto, mensaje} para un tipo de comunicación a partir de la
// atención (snapshot tal como quedó guardada), la plantilla elegida
// (puede ser null: se usa el respaldo) y la dirección del consultorio
// (puede ser null/"": el token queda vacío).
export function armarMensaje({ tipo, atencion, template, direccionConsultorio }) {
  const claveRespaldo = CLAVE_RESPALDO_POR_TIPO[tipo] || 'confirmacion';
  const campoPlantilla = CAMPO_PLANTILLA_POR_TIPO[tipo];
  const textoBase = (template && campoPlantilla && template[campoPlantilla])
    ? template[campoPlantilla]
    : PLANTILLAS_RESPALDO[claveRespaldo];
  const asuntoBase = (template && template.asunto_email) ? template.asunto_email : ASUNTO_RESPALDO[tipo] || ASUNTO_RESPALDO.confirmation;
  const instrucciones = (template && template.instrucciones_paciente) ? String(template.instrucciones_paciente).trim() : '';

  const variables = {
    paciente: atencion && atencion.paciente ? atencion.paciente : 'paciente',
    fecha: atencion && atencion.fecha ? formatearFechaCorta(atencion.fecha) : '',
    hora: atencion && atencion.horaInicio ? ` a las ${atencion.horaInicio} hs` : '',
    profesional: atencion && atencion.profesional ? atencion.profesional : '',
    prestacion: atencion && atencion.prestacion ? atencion.prestacion : 'turno',
    direccion: direccionConsultorio ? ` Dirección: ${direccionConsultorio}.` : '',
    instrucciones: instrucciones ? instrucciones : ''
  };

  return {
    asunto: renderPlantilla(asuntoBase, variables),
    mensaje: renderPlantilla(textoBase, variables).replace(/\s+/g, ' ').trim()
  };
}

function formatearFechaCorta(fechaISO) {
  const m = String(fechaISO || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(fechaISO || '');
  return `${m[3]}/${m[2]}/${m[1]}`;
}

// -----------------------------------------------------------------------
// Comunicaciones V1.2, Bloque A — versión HTML del email al paciente.
// Función NUEVA y AISLADA: armarMensaje() (texto plano, de arriba) no se
// toca ni se reemplaza - sigue siendo la única fuente de texto para
// WhatsApp y el fallback `text` del email. Esta función sólo arma un
// `html` adicional para el mismo envío, con los MISMOS datos/variables
// que ya resuelve armarMensaje() (paciente/fecha/hora/profesional/
// prestacion/direccion/instrucciones) - no reformula ni agrega ningún
// dato nuevo, sólo lo presenta con identidad visual.
//
// Compatibilidad de email: tabla + estilos inline (nada de <style> en
// <head> ni CSS externo, que Outlook/Gmail suelen ignorar o recortar),
// sin JavaScript, ancho fijo con max-width para verse bien tanto en
// clientes de escritorio como en el celular. Todo el texto dinámico se
// escapa (escaparHtml) antes de insertarse - paciente/profesional/
// prestación pueden venir de datos cargados por Secretaría, nunca deben
// interpretarse como HTML.
//
// Logo: URL pública HTTPS estable, ya usada y auditada en runtime (200 OK)
// para este mismo bloque - es el isologo real de portal/ (Portal Público
// V1), servido por GitHub Pages, el mismo hosting donde ya vive el resto
// de la app. Nunca localhost/blob/ruta relativa/base64 gigante.
// -----------------------------------------------------------------------

// -----------------------------------------------------------------------
// Branding de CardioLink (Comunicaciones V1.2, Bloque A - ajuste final):
// identidad de LA PLATAFORMA (nombre/logo/colores) - NO la identidad del
// profesional (nombre/color/especialidades/matrícula/logo propio siguen
// resolviéndose exactamente igual que antes, sin tocar). Único lugar con
// los defaults reales: cambiar el logo, el nombre o los colores de
// CardioLink en el futuro es tocar ÚNICAMENTE este objeto (o, más
// adelante, escribir config.brandingCardioLink) - nunca el HTML del
// email ni patient-communications/index.ts.
// -----------------------------------------------------------------------
const BRANDING_CARDIOLINK_DEFECTO = Object.freeze({
  nombre: 'CardioLink',
  logoUrl: 'https://anchorena.github.io/CardioLink-Admin/portal/assets/branding/isologo.png',
  // Color oficial ya usado en el resto de la app (ej. printDocument406 en
  // app.js usa este mismo valor como color por defecto de documentos).
  colorPrimario: '#174b5c',
  // Acento secundario YA existente en este mismo template (el borde del
  // bloque de instrucciones) - no es un color nuevo, sólo se centraliza.
  colorSecundario: '#0f9f93'
});

function colorHexValido(color) {
  return /^#[0-9a-f]{6}$/i.test(String(color || '')) ? color : null;
}

// `config` es el mismo blob de configuración de app.js (payload.config de
// la fila '__cardiolink_config_v1' de cardiolink_atenciones - el mismo
// que ya se lee para resolver el profesional del turno, ver
// obtenerConfig() en patient-communications/index.ts). No existe hoy
// ninguna sección de branding propio ahí: se deja preparado leyendo
// primero config?.brandingCardioLink (objeto opcional, todavía sin
// escritor en app.js ni UI - no hace falta ninguna migración para esto,
// es JSON libre) y cayendo campo por campo a BRANDING_CARDIOLINK_DEFECTO.
// El día que exista esa sección (parcial o completa), esta función ya la
// respeta sin que haga falta tocar ninguna otra línea de este bloque.
export function resolverBrandingCardioLink(config) {
  const propio = (config && config.brandingCardioLink) || {};
  return {
    nombre: (typeof propio.nombre === 'string' && propio.nombre.trim()) || BRANDING_CARDIOLINK_DEFECTO.nombre,
    logoUrl: (typeof propio.logoUrl === 'string' && propio.logoUrl.trim()) || BRANDING_CARDIOLINK_DEFECTO.logoUrl,
    colorPrimario: colorHexValido(propio.colorPrimario) || BRANDING_CARDIOLINK_DEFECTO.colorPrimario,
    colorSecundario: colorHexValido(propio.colorSecundario) || BRANDING_CARDIOLINK_DEFECTO.colorSecundario
  };
}

const TITULOS_EMAIL_TURNO = Object.freeze({
  confirmation: 'Tu turno está confirmado',
  reminder: 'Recordatorio de tu turno',
  reschedule: 'Tu turno fue reprogramado',
  cancellation: 'Tu turno fue cancelado',
  manual: 'Información de tu turno'
});

function escaparHtml(valor) {
  return String(valor == null ? '' : valor).replace(/[&<>"']/g, (caracter) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[caracter]));
}

// Mismo criterio de validación que ya usa app.js (printDocument406) para
// colorDocumento antes de insertarlo en un <style>/atributo - nunca se
// vuelca un valor sin sanitizar a HTML. Si no hay color configurado o el
// valor guardado no matchea (dato viejo/corrupto), se usa el color
// estándar de CardioLink - nunca se deja sin color ni se usa el valor
// crudo sin validar.
// Mismo comportamiento exacto que antes de centralizar el branding: si el
// profesional no tiene un color válido configurado, cae al color primario
// de CardioLink - sólo que ahora ese valor de respaldo sale del único
// lugar centralizado (BRANDING_CARDIOLINK_DEFECTO), no de una constante
// aparte duplicada.
function colorProfesionalValido(color) {
  return colorHexValido(color) || BRANDING_CARDIOLINK_DEFECTO.colorPrimario;
}

// Mismo cálculo exacto que specialities406() en app.js (especialidadIds
// cruzado contra data.especialidades[], con fallback a area/especialidad
// sueltos) - no se reinventa el criterio, sólo se replica en el lado
// server porque acá no existe la función de app.js.
function especialidadesProfesional(profesional, especialidades) {
  const ids = Array.isArray(profesional && profesional.especialidadIds) ? profesional.especialidadIds : [];
  const catalogo = Array.isArray(especialidades) ? especialidades : [];
  const nombres = ids.map((id) => {
    const e = catalogo.find((x) => x && x.id === id);
    return e && e.nombre;
  }).filter(Boolean);
  if (nombres.length) return nombres.join(' · ');
  return (profesional && (profesional.area || profesional.especialidad)) || '';
}

// Logo del profesional para EMAIL, revisión: un <img src="data:..."> no es
// confiable en email (Gmail y varios otros clientes bloquean o recortan
// data URIs por política antispam) - PERO logoDocumentoData (base64) es
// exactamente donde vive el logo cuando un profesional lo sube desde
// CardioLink (compressImage406 en app.js), así que ignorarlo por completo
// dejaría a la mayoría de los profesionales sin su logo real en el email.
// Solución: en vez de insertar el data URI en el HTML, se envía como
// ADJUNTO inline por Content-ID (CID) a Resend - el HTML sólo referencia
// "cid:professional-logo", nunca el base64 crudo. Esto sí es soportado de
// forma estable por los clientes de correo (es la misma técnica que usan
// las firmas de email corporativas con logo incrustado).
//
// logoDocumento (campo de texto libre, ver app.js:9302) sigue aceptándose
// como <img> remoto normal SÓLO si es una URL https:// real (nunca la
// ruta relativa por defecto 'icons/icon-192.png') - se probó y funciona
// igual que el logo de CardioLink, sin necesitar CID.
const MIME_LOGO_PERMITIDOS = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);
// ~1.5MB decodificados: generoso para un logo, muy por debajo del límite
// real de Resend (40MB por email, TODOS los adjuntos ya codificados en
// Base64) - un logo de este tamaño nunca arriesga ese límite ni infla el
// email de forma notoria.
const LOGO_BASE64_MAX_BYTES = 1500000;

function extensionParaMimeLogo(mime) {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  return 'png';
}

// Valida ESTRICTAMENTE la forma de un data URI de imagen antes de tratarlo
// como adjunto: sólo los 3 MIME esperados (nunca SVG - puede contener
// <script>/<foreignObject> - ni ningún otro tipo, nunca HTML), sólo
// caracteres válidos de Base64, y un límite de tamaño razonable (calculado
// sobre el LARGO del string, sin decodificar nada primero). Cualquier cosa
// que no matchee devuelve null - el caller trata null exactamente igual
// que "no hay logo": nunca lanza, nunca bloquea el envío del email.
function procesarLogoBase64(dataUri) {
  const valor = String(dataUri || '');
  const match = valor.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/i);
  if (!match) return null;
  const mime = match[1].toLowerCase();
  const base64 = match[2];
  if (!MIME_LOGO_PERMITIDOS.includes(mime)) return null;
  const bytesAproximados = Math.floor((base64.length * 3) / 4);
  if (bytesAproximados <= 0 || bytesAproximados > LOGO_BASE64_MAX_BYTES) return null;
  return { mime, base64, extension: extensionParaMimeLogo(mime) };
}

function logoProfesionalUrlHttps(profesional) {
  const valor = String((profesional && profesional.logoDocumento) || '').trim();
  return /^https:\/\//i.test(valor) ? valor : '';
}

// Resuelve CÓMO mostrar el logo del profesional, en el orden pedido
// explícitamente: A) base64 válido -> CID (agrega el adjunto a la lista
// `attachments` que recibe por referencia); B) sin base64 pero con URL
// https:// -> <img> remoto normal (NO se sube a CID: ver nota de robustez
// en armarHtmlEmailTurno); C) ninguno de los dos -> '' (sin imagen, texto
// solamente). Nunca lanza una excepción por un dato mal formado.
// QA en STAGING (Gmail real) confirmó que el JSON REST de Resend
// (https://api.resend.com/emails, el endpoint que llama enviarConResend
// via fetch() directo - NO el SDK oficial de Node) espera los campos de
// adjunto en snake_case (`content_type`, `content_id`), no en camelCase
// (`contentType`/`contentId`, que sí son los nombres del SDK). Con
// camelCase, Resend no reconocía el content_id: el logo llegaba como
// adjunto suelto descargable en vez de incrustarse en el <img
// src="cid:...">  del HTML. `content`/`filename` no cambian: esos sí
// coinciden en ambas convenciones.
function resolverLogoProfesional(profesional, attachments) {
  if (!profesional) return '';
  const procesado = procesarLogoBase64(profesional.logoDocumentoData);
  if (procesado) {
    attachments.push({
      content: procesado.base64,
      filename: `professional-logo.${procesado.extension}`,
      content_type: procesado.mime,
      content_id: 'professional-logo'
    });
    return 'cid:professional-logo';
  }
  return logoProfesionalUrlHttps(profesional);
}

// Devuelve { html, attachments }. `attachments` sigue el formato REST de
// Resend (content/filename/content_type/content_id) - vacío
// (`[]`) cuando no hay ningún logo en base64 válido, así el caller
// (manejarSendEmail) puede omitir por completo la clave `attachments` del
// body cuando no hace falta, sin ninguna rama especial acá.
export function armarHtmlEmailTurno({ tipo, atencion, template, direccionConsultorio, profesional, especialidades, config }) {
  // Única fuente de identidad de CardioLink para todo este template: ni
  // el logo, ni el nombre, ni los colores de la plataforma están sueltos
  // en ningún otro lado de esta función - todo sale de `branding`.
  const branding = resolverBrandingCardioLink(config);
  const titulo = TITULOS_EMAIL_TURNO[tipo] || TITULOS_EMAIL_TURNO.manual;
  const paciente = escaparHtml((atencion && atencion.paciente) || 'paciente');
  const prestacion = escaparHtml((atencion && atencion.prestacion) || 'turno');
  const fecha = escaparHtml(atencion && atencion.fecha ? formatearFechaCorta(atencion.fecha) : '');
  const hora = escaparHtml(atencion && atencion.horaInicio ? `${atencion.horaInicio} hs` : '');
  const direccion = direccionConsultorio ? escaparHtml(direccionConsultorio) : '';
  const instrucciones = (template && template.instrucciones_paciente)
    ? escaparHtml(String(template.instrucciones_paciente).trim())
    : '';

  // Identidad del profesional: SIEMPRE la del professional_id real del
  // turno (atencion.profesionalId, ya resuelto por el caller antes de
  // llamar acá - esta función nunca infiere quién es el profesional).
  // Degradación seria: sin profesional resuelto, se usa el nombre suelto
  // que ya traía la atención (atencion.profesional, snapshot de texto) y
  // no se muestra ningún bloque de marca/especialidad/matrícula - nunca
  // se rompe el email por falta de datos de un profesional.
  const nombreProfesional = escaparHtml((profesional && profesional.nombre) || (atencion && atencion.profesional) || '');
  const colorProfesional = colorProfesionalValido(profesional && profesional.colorDocumento);
  const especialidadesTexto = profesional ? escaparHtml(especialidadesProfesional(profesional, especialidades)) : '';
  const matriculas = profesional
    ? [profesional.matriculaNacional, profesional.matriculaProvincial].filter(Boolean).map(escaparHtml).join(' · ')
    : '';
  const attachments = [];
  const logoProfesional = resolverLogoProfesional(profesional, attachments);

  const filaDireccion = direccion
    ? `<tr><td colspan="2" style="padding:4px 0;color:#475569;font-size:14px;font-family:Arial,Helvetica,sans-serif;">📍 ${direccion}</td></tr>`
    : '';
  const bloqueInstrucciones = instrucciones
    ? `<tr><td colspan="2" style="padding-top:18px;">
        <div style="background-color:#f0f9fb;border-left:4px solid ${branding.colorSecundario};border-radius:6px;padding:14px 16px;color:#0f172a;font-size:15px;line-height:1.5;font-family:Arial,Helvetica,sans-serif;">
          <strong style="display:block;margin-bottom:4px;color:${branding.colorSecundario};">Instrucciones</strong>${instrucciones}
        </div>
      </td></tr>`
    : '';

  // Tarjeta de identidad del profesional: fondo SIEMPRE claro (#ffffff),
  // texto SIEMPRE oscuro para contraste - el color del profesional se usa
  // únicamente como acento (borde izquierdo + nombre), nunca como fondo
  // completo, tal como se pidió explícitamente. Si no hay ningún dato de
  // profesional resuelto, este bloque completo no se renderiza (sin nombre
  // vacío, sin tarjeta fantasma).
  const bloqueProfesional = nombreProfesional
    ? `<tr><td style="padding:0 24px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border:1px solid #e2e8f0;border-left:4px solid ${colorProfesional};border-radius:8px;">
          <tr>
            ${logoProfesional ? `<td width="96" style="padding:14px 0 14px 14px;"><img src="${escaparHtml(logoProfesional)}" width="80" height="80" alt="" style="display:block;border:0;border-radius:6px;object-fit:contain;"></td>` : ''}
            <td style="padding:14px 16px;">
              <div style="font-size:18px;font-weight:bold;color:${colorProfesional};font-family:Arial,Helvetica,sans-serif;">${nombreProfesional}</div>
              ${especialidadesTexto ? `<div style="font-size:15px;color:#475569;margin-top:2px;font-family:Arial,Helvetica,sans-serif;">${especialidadesTexto}</div>` : ''}
              ${matriculas ? `<div style="font-size:13px;color:#94a3b8;margin-top:2px;font-family:Arial,Helvetica,sans-serif;">${matriculas}</div>` : ''}
            </td>
          </tr>
        </table>
      </td></tr>
      <tr><td style="height:18px;line-height:18px;font-size:1px;">&nbsp;</td></tr>`
    : '';

  // Tabla anidada (patrón estándar de email HTML): máxima compatibilidad
  // con Outlook (que usa el motor de render de Word, no un navegador real)
  // y clientes que recortan <style>. Ancho fijo 480px con max-width para
  // que en el celular ocupe el 100% del viewport sin desbordar.
  //
  // Logo CardioLink: se mantiene como <img> remoto normal (NO como
  // adjunto CID vía `path`), a propósito. Un adjunto por `path` exige que
  // Resend descargue esa URL en el momento de enviar CADA email - si
  // GitHub Pages tuviera una caída puntual, eso arriesgaría el envío
  // COMPLETO del correo (texto incluido) por un problema puramente de
  // logo. Un <img src="https://…"> normal, en cambio, sólo puede fallar
  // en mostrarse a sí mismo (icono roto/oculto hasta "mostrar imágenes"),
  // nunca impide que el resto del email llegue - la opción más robusta
  // para "el branding nunca debe impedir el envío", ya cumplida y
  // verificada (200 OK) desde la primera versión de este bloque.
  const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escaparHtml(titulo)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f1f5f9;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f1f5f9;padding:24px 0;font-family:Arial,Helvetica,sans-serif;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;">
<tr><td align="center" style="background-color:${branding.colorPrimario};padding:24px 20px;">
<img src="${escaparHtml(branding.logoUrl)}" width="56" height="56" alt="${escaparHtml(branding.nombre)}" style="display:block;border:0;border-radius:8px;margin:0 auto;">
<div style="color:#ffffff;font-size:18px;font-weight:bold;margin-top:8px;font-family:Arial,Helvetica,sans-serif;">${escaparHtml(branding.nombre)}</div>
</td></tr>
<tr><td style="padding:24px 24px 0 24px;">
<h1 style="margin:0 0 18px 0;font-size:22px;color:${branding.colorPrimario};text-align:center;font-family:Arial,Helvetica,sans-serif;">${escaparHtml(titulo)}</h1>
</td></tr>
${bloqueProfesional}
<tr><td style="padding:0 24px 8px 24px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:15px;color:#0f172a;font-family:Arial,Helvetica,sans-serif;">
<tr><td style="padding:4px 0;width:110px;color:#64748b;">Paciente</td><td style="padding:4px 0;font-weight:bold;">${paciente}</td></tr>
<tr><td style="padding:4px 0;color:#64748b;">Fecha</td><td style="padding:4px 0;font-weight:bold;">${fecha}</td></tr>
<tr><td style="padding:4px 0;color:#64748b;">Hora</td><td style="padding:4px 0;font-weight:bold;">${hora}</td></tr>
<tr><td style="padding:4px 0;color:#64748b;">Prestación</td><td style="padding:4px 0;font-weight:bold;">${prestacion}</td></tr>
${filaDireccion}
${bloqueInstrucciones}
</table>
</td></tr>
<tr><td style="padding:20px 24px 24px 24px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:11px;text-align:center;font-family:Arial,Helvetica,sans-serif;">
Este es un mensaje automático de ${escaparHtml(branding.nombre)}. Ante cualquier consulta, comunicate con el consultorio.
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  return { html, attachments };
}

// -----------------------------------------------------------------------
// Aviso automático al profesional asignado (circuito distinto del de
// paciente: sin plantillas configurables por prestación, formato fijo
// solo con datos administrativos - nunca HC, evoluciones ni observaciones
// clínicas). "evento" es el mismo vocabulario que la columna tipo de
// cardiolink_communications, más 'assignment' (turno nuevo asignado, no
// existe como tipo para el paciente).
// -----------------------------------------------------------------------
const EVENTOS_PROFESIONAL = Object.freeze({
  assignment: { titulo: 'Nuevo turno asignado', asunto: 'Nuevo turno asignado — CardioLink' },
  confirmation: { titulo: 'Turno confirmado', asunto: 'Turno confirmado — CardioLink' },
  reschedule: { titulo: 'Turno reprogramado', asunto: 'Turno reprogramado — CardioLink' },
  cancellation: { titulo: 'Turno cancelado', asunto: 'Turno cancelado — CardioLink' }
});

export function armarMensajeProfesional({ evento, atencion }) {
  const def = EVENTOS_PROFESIONAL[evento] || EVENTOS_PROFESIONAL.assignment;
  const lineas = [
    def.titulo,
    '',
    `Paciente: ${(atencion && atencion.paciente) || ''}`,
    `Fecha: ${atencion && atencion.fecha ? formatearFechaCorta(atencion.fecha) : ''}`,
    `Hora: ${(atencion && atencion.horaInicio) || ''}`,
    `Prestación: ${(atencion && atencion.prestacion) || ''}`,
    `Cobertura: ${(atencion && (atencion.obraSocial || atencion.coberturaAtencion)) || ''}`
  ];
  return { asunto: def.asunto, mensaje: lineas.join('\n') };
}

// -----------------------------------------------------------------------
// Aviso automático al profesional cuando Secretaría genera un certificado
// u orden médica EN SU NOMBRE (Comunicaciones V1, cierre). Circuito
// hermano de armarMensajeProfesional: mismo formato fijo, solo datos
// administrativos - nunca el contenido del documento, ni título, ni
// indicaciones, ni diagnóstico. Los documentos clínicos
// (data.documentosClinicos) no tienen atencionId ni fila propia en
// Supabase (viven en el config jsonb sincronizado), así que a diferencia
// de armarMensajeProfesional no recibe una "atencion": recibe los campos
// ya resueltos del lado del cliente.
// -----------------------------------------------------------------------
const TIPOS_DOCUMENTO_LABEL = Object.freeze({
  certificado: 'Certificado médico',
  orden: 'Orden médica'
});

function formatearFechaHoraCorta(fechaISO) {
  try {
    const fecha = new Date(fechaISO);
    if (Number.isNaN(fecha.getTime())) return String(fechaISO || '');
    return new Intl.DateTimeFormat('es-AR', {
      timeZone: 'America/Argentina/Buenos_Aires',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(fecha);
  } catch (_error) {
    return String(fechaISO || '');
  }
}

export function armarMensajeProfesionalDocumento({ tipoDocumento, pacienteNombre, fechaHora, generadoPor }) {
  const etiquetaTipo = TIPOS_DOCUMENTO_LABEL[tipoDocumento] || 'Documento clínico';
  const lineas = [
    `Nuevo documento generado en tu nombre: ${etiquetaTipo}`,
    '',
    `Paciente: ${pacienteNombre || ''}`,
    `Tipo de documento: ${etiquetaTipo}`,
    `Fecha: ${fechaHora ? formatearFechaHoraCorta(fechaHora) : ''}`,
    `Generado por: ${generadoPor || 'Secretaría'}`
  ];
  return {
    asunto: `Nuevo documento generado — ${etiquetaTipo} — CardioLink`,
    mensaje: lineas.join('\n')
  };
}
