# CardioLink Admin v2.9.9

Versión con configuración visual de bloques de prestaciones por perfil.

Cambios principales:
- Nueva sección en Configuración: Bloques de prestaciones por perfil.
- Permite asignar bloques como Cardiología, Diagnóstico por imágenes, Neuro vascular, Neumonología, Neuro, Kinesiología y Otras especialidades.
- Permite agregar prestaciones dentro de cada bloque.
- Un profesional nuevo puede recibir uno o varios bloques sin tocar código.
- El desplegable principal y las prestaciones adicionales respetan los bloques asignados al profesional activo.
- Mantiene las reglas, montos, agenda, mensajes y permisos ya estabilizados.

Subir/reemplazar: index.html, app.js, styles.css y README.md.
Abrir con: https://anchorena.github.io/CardioLink-Admin/?v=297


## v2.9.9
- Agrega carga pura de pacientes desde la solapa Pacientes, sin crear turno ni caja.
- Agrega importación de pacientes desde Excel/CSV exportado desde Medicloud con vista previa.
- Antiduplicado por DNI, teléfono, email o nombre + fecha de nacimiento.
- Guarda pacientes en configuración y sincroniza una fila técnica de configuración en Supabase.


## v2.9.9
- Ajuste del importador de pacientes para el .xls real de Medicloud, que viene como tabla HTML.
- Reconoce columnas: Nombre, Apellido, E-Mail, N° de Documento, Teléfono, Fecha de Nacimiento, Médico.
- Ignora 'No ingresado' como email.
- Convierte fechas con meses en inglés/abreviados, por ejemplo 7 Jul 1962.
