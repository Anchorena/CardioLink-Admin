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
