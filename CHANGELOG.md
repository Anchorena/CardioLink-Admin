# CardioLink Admin v4.0.9.5

- Asistente para abrir RCTA con los datos del paciente preparados y copiados.
- Acceso desde Historia Clínica, ficha administrativa y evolución.
- Scroll independiente en el listado lateral de HC y en el padrón de Pacientes.
- Conserva paginación de 50 registros y encabezado fijo.

# CardioLink 4.0.9.5

- Abrir una evolución desde Agenda cambia el turno a **En consulta**, visible para Secretaría.
- Guardar una evolución vinculada cambia automáticamente el turno a **Atendido**.
- Documentos rápidos: ECG, ECG y riesgo quirúrgico, apto físico, ecografía, Holter, MAPA, radiografía, mensaje a colega e indicaciones al paciente.
- Las recetas comienzan con **R/P** y cada documento incluye un borrador editable, sin emitir conclusiones automáticas.

# CardioLink 4.0.9.5

- El nombre del paciente en Agenda abre directamente la evolución vinculada al turno.
- Padrón de Pacientes paginado de a 50 registros, con encabezado fijo en escritorio.
- Etiquetas de importación generalizadas como “otra app”.
- Caché y versión unificadas.

# CardioLink 4.0.9.5

- Corrige la apertura de la ficha al tocar el nombre en el padrón de Pacientes.
- La ficha se abre en una ventana modal y también actualiza la selección administrativa.
- Se eliminó la dependencia de `onclick` inline para nombres o claves con caracteres especiales.
- Permite abrir con clic, Enter o barra espaciadora.

# CardioLink 4.0.9.5

- Pacientes pasa a ser un padrón administrativo en tabla: nombre, DNI, edad, cobertura, teléfono y email.
- El nombre abre la ficha administrativa completa.
- Historia Clínica conserva el listado lateral y el espacio clínico a la derecha.
- Evolución con contexto visual separado para fecha, profesional y vinculación.
- Edad calculada automáticamente desde una fecha de nacimiento válida.
- Antecedentes, alergias y medicación visibles y editables dentro de la evolución.
- Edición de la ficha del paciente desde Historia Clínica o desde la evolución, sin crear duplicados.
- No se crean evoluciones vacías; los cambios exclusivos del resumen clínico se guardan sin generar una evolución.

# CardioLink 4.0.9.5

- Búsqueda completa de pacientes en HC, sin límite arbitrario de 80.
- Listado inicial alfabético con paginación.
- Coincidencia exacta y apertura puntual por DNI.
- Rediseño del panel de evolución con datos demográficos, cobertura y contacto.
- Botones de copiado rápido, WhatsApp y email.
- Motivo de consulta compacto y área principal de evolución ampliada.
- Se mantienen guardado manual, prevención de evoluciones vacías y bloqueo de edición a las 24 horas salvo Administrador.

# CardioLink 4.0.9.5

- Historia Clínica visible para todos los perfiles médicos.
- Notas internas privadas por profesional; las notas anteriores se migran al perfil Matías.
- Importador de evoluciones Medicloud accesible también desde Pacientes y con instrucciones visibles.
- Un médico común importa solo como su propio perfil; Administrador puede elegir autor.
- Preparación conceptual de integración por paciente con CardioLink Informes y EcoApp.

# CardioLink Admin v4.0.6

- Importador de evoluciones históricas exportadas desde Medicloud en `.xls`, `.xlsx` o `.csv`.
- Vinculación automática por DNI y conservación de la fecha/hora original.
- Vista previa con vinculadas, fichas mínimas nuevas, duplicadas y filas para revisar.
- Prevención de duplicados al repetir un archivo.
- Registro por lote y opción de deshacer el último lote.
- Las evoluciones importadas no crean turnos, caja ni agenda.
- Etiqueta visible “Importada desde Medicloud” en la Historia Clínica.

# CardioLink 4.0.6 HC — Evolución directa desde Agenda

- El nombre del paciente en la Agenda abre la evolución clínica vinculada al turno.
- Si la atención ya tiene una evolución, se abre esa misma evolución y no se crea un duplicado.
- Cerrar o cancelar no guarda registros vacíos.
- El guardado es explícito mediante “Guardar evolución”.
- Si hay texto sin guardar, el sistema pide confirmación antes de cerrar.
- Se mantiene el límite de edición de 24 horas; Administrador puede editar sin límite.
- Versión y caché PWA actualizadas a 4.0.6.

# CardioLink 4.0.2 HC — Identidad profesional y flujo clínico

- Encabezado profesional configurable en la Historia Clínica impresa: logo, marca, especialidades, matrículas, teléfono, email, dirección y redes.
- Estados operativos editables desde la misma prestación/evolución: informe, impresión, envío, bono/firma, copia y pago.
- Nota interna médica por paciente, visible solo para médicos/administradores y excluida de impresiones.
- Convenios y aranceles separados por profesional. La lógica Matías/Rogelio se conserva únicamente en el perfil de Matías.
- Versión y caché PWA actualizadas a 4.0.2.

## v4.0.6
- Identidad profesional editable por cada médico: marca, datos, matrículas, color, logo y firma.
- Carga de logo y firma desde archivos PNG, JPG o WebP, optimizados antes de guardar.
- Acceso rápido "Mi membrete y firma" para el profesional logueado.
- Nuevo generador de recetas, órdenes médicas y certificados desde Historia Clínica o ficha del paciente.
- Documentos vinculados al paciente y al profesional, con impresión en A4, membrete y firma.
- Edición durante 24 horas para el profesional; edición sin límite para Administrador.
- Historia Clínica impresa con firma profesional opcional.
