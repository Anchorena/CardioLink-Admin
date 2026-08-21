/* =====================================================================
   CardioLink — Portal Público V1 · Contenido público (contenido-publico.js)

   Estructura pública V1, centralizada acá a propósito: identidad,
   profesionales, prestaciones, modalidad, contacto y coberturas quedan en
   un único lugar para poder migrarlos después a Configuración de CardioLink
   sin rehacer portal.js ni portal/index.html.

   Regla dura: nunca se inventa un dato de marca/contacto/clínico que no
   esté confirmado en el repositorio. Todo lo que no tiene un valor real
   verificado queda como cadena vacía / array vacío, y portal.js NO renderiza
   una etiqueta para un campo vacío (evita mostrar "Teléfono: " sin nada
   después). Ver docs/PORTAL_PUBLICO_V1.md para el detalle de qué se
   encontró y qué falta aportar.
   ===================================================================== */
(function (root, factory) {
  'use strict';

  const api = factory();

  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && !root.CardioLinkContenidoPublico) root.CardioLinkContenidoPublico = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  // Nombre real de letterhead ya usado por el Admin para Matías
  // (app.js: marcaDocumento por defecto = 'Consultorio Médico RM').
  const IDENTIDAD = Object.freeze({
    nombreConsultorio: 'Consultorio Médico RM',
    descripcionBreve: 'Cardiología y Medicina Intensiva.',
    // Único asset de imagen real que existe en el repo (ícono de la PWA).
    // No es un logo/wordmark propiamente dicho: reemplazar por uno real en
    // cuanto exista (ver docs/PORTAL_PUBLICO_V1.md).
    logoUrl: '../icons/icon-512.png',
    logoAlt: 'Consultorio Médico RM',
    // Mismos colores que ya usa el Admin: --primary en styles.css,
    // theme_color/background_color en manifest.webmanifest.
    colorPrimario: '#123f56',
    colorFondo: '#f4f7f9'
  });

  // Sólo Matías: Geraldine no es profesional médica y queda excluida a
  // propósito. Datos reales tomados de app.js (usuariosDefault/defaults.profesionales
  // y las matrículas por defecto). Sin bio pública ni foto confirmadas
  // todavía: quedan vacías, no se inventan.
  const PROFESIONALES = Object.freeze([
    Object.freeze({
      nombre: 'Dr. Matías Anchorena',
      especialidad: 'Cardiología / Medicina Crítica',
      matriculaNacional: 'M.N. 115.607',
      matriculaProvincial: 'M.P. 332.578',
      descripcionBreve: '',
      fotoUrl: ''
    })
  ]);

  // Mismos nombres, en el mismo orden, que
  // supabase/functions/portal-gateway/index.ts → PRESTACIONES_PUBLICAS_V1.
  // Si se agrega/saca una prestación acá hay que actualizar las dos listas.
  // Sin descripción/duración/preparación confirmadas todavía: quedan
  // vacías a propósito (información clínica incorrecta sería peor que no
  // mostrar nada).
  const PRESTACIONES = Object.freeze([
    Object.freeze({ nombre: 'Consulta', descripcion: '', paraQueSirve: '', duracionAprox: '', preparacionPrevia: '' }),
    Object.freeze({ nombre: 'Holter 24 h', descripcion: '', paraQueSirve: '', duracionAprox: '', preparacionPrevia: '' }),
    Object.freeze({ nombre: 'MAPA', descripcion: '', paraQueSirve: '', duracionAprox: '', preparacionPrevia: '' }),
    Object.freeze({ nombre: 'Ergometría', descripcion: '', paraQueSirve: '', duracionAprox: '', preparacionPrevia: '' }),
    Object.freeze({ nombre: 'Ecocardiograma', descripcion: '', paraQueSirve: '', duracionAprox: '', preparacionPrevia: '' })
  ]);

  const MODALIDAD = Object.freeze([
    'La atención es siempre con turno.',
    'La solicitud de turno se hace online, acá mismo.',
    'Secretaría coordina la fecha y el horario, y se comunica para confirmarlo.',
    'Cuando el estudio lo requiera, te damos las indicaciones de preparación al coordinar el turno.'
  ]);

  // Sin dato real confirmado en el repo para ninguno de estos campos: se
  // dejan vacíos a propósito. portal.js no debe inventar ninguno.
  const CONTACTO = Object.freeze({
    direccion: '',
    telefono: '',
    whatsapp: '',
    instagram: '',
    email: '',
    mapaUrl: ''
  });

  // Subconjunto real de defaults.obrasSociales (app.js), más "No sé /
  // consultar" (pedido explícitamente para el portal público). Mismos
  // nombres, en el mismo orden, que
  // supabase/functions/portal-gateway/logica.js → COBERTURAS_VALIDAS.
  const COBERTURAS = Object.freeze([
    'Particular', 'OSDE', 'Swiss Medical', 'Medicus', 'Galeno', 'IOMA', 'PAMI', 'Sancor', 'Otra', 'No sé / consultar'
  ]);

  return Object.freeze({
    identidad: IDENTIDAD,
    profesionales: PROFESIONALES,
    prestaciones: PRESTACIONES,
    modalidad: MODALIDAD,
    contacto: CONTACTO,
    coberturas: COBERTURAS
  });
});
