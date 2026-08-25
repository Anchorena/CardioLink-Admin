/* =====================================================================
   CardioLink — Portal Público (contenido-publico.js)

   Estructura pública, centralizada acá a propósito: identidad,
   profesionales, prestaciones, especialidades complementarias,
   equipamiento, modalidad, contacto y coberturas quedan en un único
   lugar para poder migrarlos después a Configuración de CardioLink sin
   rehacer portal.js ni portal/index.html. Nada de esto se hardcodea
   disperso por portal.js/HTML: cada sección lee de acá.

   Regla dura: nunca se inventa un dato de marca/contacto/clínico que no
   esté confirmado en el repositorio (o entregado directamente por el
   dueño del consultorio, como el mail de contacto). Todo lo que no tiene
   un valor real verificado queda como cadena vacía / array vacío, y
   portal.js NO renderiza una etiqueta para un campo vacío (evita mostrar
   "Teléfono: " sin nada después). Ver docs/PORTAL_PUBLICO_V1.md para el
   detalle de qué se encontró y qué falta aportar.
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
  //
  // logoPrincipal/logoOscuro/logoClaro/isologo son los ÚNICOS lugares que
  // definen el logo: cambiar sólo acá (nunca en portal.js/HTML) alcanza
  // para reemplazarlo en toda la página. Ver portal/assets/README.md para
  // el nombre de archivo y la carpeta exactos donde copiar cada uno.
  //
  // Decisión de cierre de Portal Visual V1: el logo horizontal maestro
  // (isologo + nombre + tagline) todavía no existe como archivo — el
  // header institucional resuelve con isologo + nombre en HTML/CSS
  // (ver renderHeader() en portal.js), así que logoPrincipal/logoOscuro/
  // logoClaro quedan vacíos A PROPÓSITO (no es "falta archivo", es alcance
  // acordado) hasta que exista ese brand kit horizontal final o se
  // necesiten para documentos/PDF. `isologo` sí tiene el archivo real del
  // brand kit aprobado (corazón + ECG, sin texto).
  // descripcionBreve institucional: representa al conjunto del centro, no a
  // un solo profesional — por eso NO dice "Medicina Intensiva" acá (esa
  // combinación es el perfil personal del Dr. Matías, ver su
  // descripcionBreve propia más abajo en PROFESIONALES).
  const IDENTIDAD = Object.freeze({
    nombreConsultorio: 'Consultorio Médico RM',
    descripcionBreve: 'Cardiología · Estudios cardiológicos · Clínica Médica · Diagnóstico por Imágenes y otras especialidades',
    // Logo horizontal completo (isologo + nombre + tagline). Pendiente:
    // archivo real del brand kit no entregado todavía.
    logoPrincipal: '',
    // Versión del logo horizontal preparada para fondos oscuros (se usaría
    // en el hero, que tiene fondo petróleo oscuro). Pendiente.
    logoOscuro: '',
    // Versión blanca/imprimible, reservada para uso futuro en documentos
    // (membrete, informes en PDF) — no se usa en el portal web todavía.
    // Pendiente.
    logoClaro: '',
    // Isologo real del brand kit aprobado (corazón + ECG, sin texto) —
    // reemplaza al fallback provisional que se usaba antes
    // (assets/branding/isologo.svg, una interpretación propia en código).
    isologo: 'assets/branding/isologo.png',
    logoAlt: 'Consultorio Médico RM',
    // Paleta del brand kit aprobado para el portal (azul petróleo +
    // turquesa: #0b2d42 / #0e4f63 / #14b8c5), en la misma familia que el
    // Admin (styles.css --primary: #123f56) pero con identidad propia —
    // ver portal.css :root y docs/PORTAL_PUBLICO_VISUAL_V1.md. El Admin no
    // se tocó.
    colorPrimario: '#0e4f63',
    colorFondo: '#f4f7f9'
  });

  // Profesionales del portal. Cada uno tiene su propia configuración de
  // prestaciones/matrícula/horarios — a propósito NUNCA una referencia
  // compartida a otro profesional, aunque el valor real coincida: así,
  // si mañana un dato deja de coincidir, es un cambio de una sola línea
  // en el objeto correspondiente, sin tocar a nadie más.
  //
  // Geraldine no es profesional médica y queda excluida a propósito.
  //
  // "Drago" en app.js tiene DOS registros reales distintos
  // (humberto_drago y lucas_drago). Por ahora sólo se confirmó a Fernández
  // Drago Humberto para el portal — "Drago Lucas" NO se muestra todavía:
  // agregarlo sin una confirmación explícita sería asumir que cualquier
  // "Drago" encontrado en app.js pertenece al staff público, que es
  // justamente lo que se pidió no hacer.
  const PROFESIONALES = Object.freeze([
    Object.freeze({
      nombre: 'Dr. Matías Anchorena',
      especialidad: 'Cardiología / Medicina Crítica',
      matriculaNacional: 'M.N. 115.607',
      matriculaProvincial: 'M.P. 332.578',
      // Esta combinación ("Medicina Intensiva y Cardiología") es el perfil
      // personal de Matías — a diferencia de la descripción institucional
      // de arriba (IDENTIDAD.descripcionBreve), que representa al conjunto
      // del centro y no menciona Medicina Intensiva.
      descripcionBreve: 'Medicina Intensiva y Cardiología.',
      fotoUrl: '',
      // Logo personal real de Matías (versión "fondo oscuro" del brand
      // kit, confirmada directamente por el dueño — no la vertical/
      // apilada pedida originalmente, pero sí la aprobada al final). Sin
      // foto todavía: la tarjeta lo muestra completo, sin recortar, en su
      // propia caja — ver renderAvatarProfesional() en portal.js.
      logoUrl: 'assets/profesionales/matias-anchorena.png',
      diasAtencion: '',
      horarios: '',
      // Único profesional con turnos programados por ahora: ver
      // modalidadAtencion. mensajeModalidad queda vacío porque, con
      // "con_turno", portal.js nunca arma/usa el texto de modalidad — ese
      // texto es sólo para "orden_llegada"/"mixta".
      modalidadAtencion: 'con_turno',
      mensajeModalidad: '',
      // Todos visibles hoy: visibleEnPortal existe para poder ocultar a
      // futuro un profesional puntual sin borrar su configuración (por
      // ejemplo, licencia temporal) — ver el filtro en
      // renderProfesionalesPublicos (portal.js).
      visibleEnPortal: true,
      // app.js: defaults.profesionales (id:'matias').prestaciones
      prestaciones: ['Consulta', 'Electrocardiograma', 'ECG', 'Ecocardiograma Doppler', 'Holter', 'MAPA']
    }),
    Object.freeze({
      nombre: 'Dr. Rogelio Anchorena',
      especialidad: 'Cardiología',
      matriculaNacional: '',
      matriculaProvincial: '',
      descripcionBreve: '',
      fotoUrl: '',
      // Logo personal real de Rogelio (sin foto todavía): la tarjeta lo
      // muestra completo, sin recortar, en su propia caja — ver
      // renderAvatarProfesional() en portal.js.
      logoUrl: 'assets/profesionales/rogelio-anchorena.png',
      // Confirmados directamente por el dueño del consultorio.
      diasAtencion: 'lunes a viernes',
      horarios: '14:30 a 19:30',
      // Atiende por orden de llegada (confirmado directamente por el dueño
      // del consultorio, no inventado): el portal NO le ofrece "Solicitar
      // turno" mientras este valor sea 'orden_llegada' — ver
      // etiquetaModalidad() en portal.js. Cambiar sólo este valor a
      // 'con_turno' el día que corresponda alcanza para habilitarle el
      // flujo de turno, sin tocar portal.js ni el HTML.
      modalidadAtencion: 'orden_llegada',
      mensajeModalidad: '',
      visibleEnPortal: true,
      // Confirmado directamente por el dueño del consultorio: NO copiado
      // del de Matías (antes sí lo estaba, por error — Rogelio no comparte
      // automáticamente las prestaciones de Matías). Sin Ecocardiograma ni
      // Ergometría.
      //
      // DISCREPANCIA CON app.js (documentada, no resuelta acá): el registro
      // de facturación de Rogelio en app.js (defaults.profesionales,
      // id:'rogelio') todavía lista 6 prestaciones, incluida
      // 'Ecocardiograma Doppler' — este dato de acá lo pisa a propósito
      // para el portal público porque es lo que el dueño confirmó
      // directamente como real. app.js NO se tocó (fuera del alcance de
      // esta tarea): si esa lista de facturación está desactualizada,
      // corregirla ahí es un cambio aparte, autorizado explícitamente.
      prestaciones: ['Consulta', 'Electrocardiograma', 'Holter', 'MAPA']
    }),
    Object.freeze({
      nombre: 'Dr. Fernández Drago Humberto',
      especialidad: 'Diagnóstico por Imágenes',
      matriculaNacional: '',
      matriculaProvincial: '',
      descripcionBreve: '',
      fotoUrl: '',
      // Logo/isotipo personal del profesional (si lo tuviera, distinto de
      // la foto) — pendiente en los 4 hoy. Prioridad de uso en la tarjeta:
      // fotoUrl → logoUrl → iniciales (ver portal/assets/README.md).
      logoUrl: '',
      // Confirmados directamente por el dueño del consultorio.
      diasAtencion: 'martes y viernes',
      horarios: '09:00 a 15:00',
      modalidadAtencion: 'orden_llegada',
      mensajeModalidad: '',
      visibleEnPortal: true,
      // app.js: defaults.profesionales (id:'humberto_drago').prestaciones
      prestaciones: ['Ecografía abdominal', 'Ecografía renal', 'Ecografía tiroidea', 'Ecografía mamaria', 'Doppler arterial', 'Doppler venoso', 'Mamografía']
    }),
    // Confirmada como parte del staff público. Sin embargo, en todo el
    // repo su único registro real es el nombre 'Dra. Rutter' dentro de
    // COLEGAS_FRECUENTES (cardiolink-hc-referidos.js /
    // cardiolink-eco-informe.js) — una lista de médicos externos que
    // derivan pacientes, sin especialidad/matrícula/prestaciones propias
    // cargadas ahí. Ninguno de esos campos está respaldado por
    // configuración real todavía: quedan vacíos a propósito (no
    // inventados) hasta que se confirmen. La tarjeta lo muestra con un
    // aviso discreto en vez de campos vacíos o inventados.
    Object.freeze({
      nombre: 'Dra. Rutter',
      especialidad: '',
      matriculaNacional: '',
      matriculaProvincial: '',
      descripcionBreve: '',
      fotoUrl: '',
      // Logo/isotipo personal del profesional (si lo tuviera, distinto de
      // la foto) — pendiente en los 4 hoy. Prioridad de uso en la tarjeta:
      // fotoUrl → logoUrl → iniciales (ver portal/assets/README.md).
      logoUrl: '',
      // Todavía desconocidos — a propósito vacíos, NO inventados. Mientras
      // sigan así, portal.js no le ofrece el botón "Ver días y horarios"
      // (no tiene sentido llevar a un paciente a un paso sin información
      // real): la tarjeta muestra "Horarios próximamente" en su lugar. Ver
      // etiquetaModalidad() en portal.js.
      diasAtencion: '',
      horarios: '',
      // Modalidad confirmada directamente por el dueño del consultorio (a
      // diferencia de especialidad/matrícula/prestaciones, que siguen sin
      // confirmar): por eso esto NO queda vacío como el resto de sus
      // campos.
      modalidadAtencion: 'orden_llegada',
      mensajeModalidad: '',
      // NO publicada todavía (decisión explícita del dueño): no quiere una
      // tarjeta incompleta sólo con "Horarios próximamente". Queda
      // configurada acá con el resto de sus datos reales confirmados
      // (nombre, modalidad), lista para activarse el día que se confirmen
      // días/horarios — sólo hay que pasar este valor a `true`. Pensado
      // para migrar a un toggle real en Configuración → Portal Público →
      // Profesionales, sin tocar código.
      visibleEnPortal: false,
      prestaciones: []
    })
  ]);

  // Catálogo público de prestaciones seleccionables en la solicitud de
  // turno. Mismos nombres, en el mismo orden, que
  // supabase/functions/portal-gateway/index.ts → PRESTACIONES_PUBLICAS_V1.
  //
  // "Ergometría" se sacó de acá (pedido explícito: no debe aparecer en
  // cards/contenido público/selects/solicitud pública, y de hecho ningún
  // profesional real la tiene en su lista de prestaciones en app.js). El
  // backend (index.ts) NO se tocó en esta tarea — sigue aceptando
  // 'Ergometría' como valor válido si alguien la mandara directo a la API
  // sin pasar por este select. Es una inconsistencia menor y conocida,
  // pendiente de un cambio de backend autorizado aparte; ver el reporte de
  // esta tarea y tests/portal-gateway-logica.js.
  const PRESTACIONES = Object.freeze([
    Object.freeze({ nombre: 'Consulta', descripcion: '', paraQueSirve: '', duracionAprox: '', preparacionPrevia: '' }),
    Object.freeze({ nombre: 'Holter 24 h', descripcion: '', paraQueSirve: '', duracionAprox: '', preparacionPrevia: '' }),
    Object.freeze({ nombre: 'MAPA', descripcion: '', paraQueSirve: '', duracionAprox: '', preparacionPrevia: '' }),
    Object.freeze({ nombre: 'Ecocardiograma', descripcion: '', paraQueSirve: '', duracionAprox: '', preparacionPrevia: '' })
  ]);

  // Especialidades complementarias: sin profesional nombrado (no hay uno
  // real confirmado en el repo para Diabetología/Nutrición ni Psiquiatría).
  // Diagnóstico por imágenes SÍ reutiliza las prestaciones reales de los
  // Drago (arriba), como pide la tarea.
  const ESPECIALIDADES_COMPLEMENTARIAS = Object.freeze({
    descripcion: 'Además contamos con otras especialidades para completar la atención de manera integral y multidisciplinaria.',
    items: Object.freeze([
      Object.freeze({ nombre: 'Diabetología y Nutrición', detalle: '', prestaciones: [] }),
      Object.freeze({
        nombre: 'Diagnóstico por imágenes',
        detalle: '',
        // Unión de las prestaciones reales de los dos Drago (arriba).
        prestaciones: ['Ecografía abdominal', 'Ecografía renal', 'Ecografía tiroidea', 'Ecografía mamaria', 'Doppler arterial', 'Doppler venoso', 'Mamografía']
      }),
      Object.freeze({ nombre: 'Psiquiatría', detalle: '', prestaciones: [] }),
      Object.freeze({ nombre: 'Próximamente más especialidades', detalle: '', prestaciones: [] })
    ])
  });

  // Equipamiento: sin marca/modelo real confirmado en ningún lado del repo
  // (se buscó explícitamente) — se muestra sólo el tipo de estudio que el
  // consultorio puede realizar con equipamiento propio, sin inventar
  // fabricante/modelo. "detalle" queda listo para completar cuando haya un
  // dato real (marca, modelo, año, etc.).
  const EQUIPAMIENTO = Object.freeze({
    descripcion: 'Equipos disponibles en el consultorio para estudios complementarios.',
    items: Object.freeze([
      Object.freeze({ estudio: 'Ecocardiografía', detalle: '' }),
      Object.freeze({ estudio: 'Holter', detalle: '' }),
      Object.freeze({ estudio: 'MAPA', detalle: '' }),
      Object.freeze({ estudio: 'ECG', detalle: '' })
    ])
  });

  // Genérico y sin nombrar a nadie a propósito: cada profesional tiene su
  // propia modalidadAtencion (ver PROFESIONALES arriba), que su propia
  // tarjeta ya muestra. Esta lista no puede decir "la atención es siempre
  // con turno" porque no siempre lo es.
  const MODALIDAD = Object.freeze([
    'Cada profesional tiene su propia modalidad de atención: con turno o por orden de llegada.',
    'La modalidad de cada profesional está indicada en su propia tarjeta, en la sección "Profesionales".',
    'Cuando la atención es con turno, la solicitud se hace online, acá mismo.',
    'Secretaría coordina la fecha y el horario, y se comunica para confirmarlo.',
    'Cuando el estudio lo requiera, te damos las indicaciones de preparación al coordinar el turno.'
  ]);

  // Preparado visual/arquitectónicamente para un futuro apartado de
  // resultados propios (sin descarga ni autenticación todavía: portal.js
  // sólo muestra un aviso "Próximamente", nada funcional).
  const ESTUDIOS_PACIENTE = Object.freeze({
    titulo: 'Mis estudios',
    descripcion: 'Próximamente vas a poder descargar tus informes desde acá.',
    disponible: false
  });

  // drm.anchorena@gmail.com: mail real entregado directamente para esta
  // etapa (no estaba en el repo; no es un dato inventado, es el dato real
  // aportado). El resto de los campos de contacto sigue sin confirmar en
  // el repo y queda vacío a propósito.
  const CONTACTO = Object.freeze({
    direccion: '',
    telefono: '',
    whatsapp: '',
    instagram: '',
    email: 'drm.anchorena@gmail.com',
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
    especialidadesComplementarias: ESPECIALIDADES_COMPLEMENTARIAS,
    equipamiento: EQUIPAMIENTO,
    modalidad: MODALIDAD,
    estudiosPaciente: ESTUDIOS_PACIENTE,
    contacto: CONTACTO,
    coberturas: COBERTURAS
  });
});
