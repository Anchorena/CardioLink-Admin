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
