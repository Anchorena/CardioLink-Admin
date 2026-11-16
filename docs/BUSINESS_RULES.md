# CardioLink Admin — Reglas de negocio

Última actualización: 2026-11-14

## Permisos

### Dueño / Administrador
Tiene acceso completo a:
- administración y configuración;
- usuarios y roles;
- finanzas, Caja, sueldo y liquidaciones;
- Historia Clínica, documentos y reportes;
- backups y mantenimiento;
- prestaciones, profesionales y especialidades;
- obras sociales/prepagas, convenios, aranceles, valores particulares y
  copagos.

### Médico
Mantiene acceso a:
- pacientes y agenda según sus permisos actuales;
- Historia Clínica, resumen clínico y evoluciones;
- antecedentes, alergias, medicación y signos vitales clínicos;
- RCTA, documentos e informes clínicos.

Este acceso clínico no concede permisos administrativos o comerciales que no
le correspondan.

### Secretaría
Es un rol administrativo, operativo y comercial.

Puede:
- crear y editar turnos/atenciones, sala de espera y estados;
- crear y editar la ficha administrativa del paciente: nombre, apellido, DNI,
  fecha de nacimiento, teléfono, email, obra social/prepaga, número de afiliado
  y observaciones administrativas;
- gestionar profesionales y especialidades;
- agregar o eliminar prestaciones del catálogo y modificar la matriz de
  prestaciones habilitadas por profesional;
- agregar o eliminar obras sociales/prepagas;
- modificar convenios, aranceles, valores particulares y copagos;
- cargar pagos, bonos, autorizaciones, médico solicitante y motivo/indicación;
- registrar cobros pendientes y confirmar los de los profesionales con los que tiene
  una asociación activa (fecha, usuario y medio de pago);
- importar o restaurar backups;
- emitir constancias, certificados y órdenes médicas, por indicación de un
  profesional autorizado (uno de los médicos a los que está asociada) y con su
  membrete, sello y firma;
- subir, consultar, gestionar, descargar, imprimir y enviar los documentos del
  paciente: los anteriores, ECG, Holter, MAPA, ecocardiogramas, estudios,
  informes, laboratorios, recetas, indicaciones, aptos físicos y otros
  documentos administrativos y médicos, **solo de profesionales con los que
  tiene una asociación activa** (los documentos sin profesional identificable
  no le son visibles).

No puede:
- acceder a Historia Clínica, resumen clínico, evoluciones, antecedentes,
  alergias, medicación habitual, signos vitales almacenados en HC ni notas
  clínicas privadas;
- acceder a RCTA, ni modificar el contenido clínico de documentos médicos
  firmados (la gestión administrativa no lo autoriza);
- ver las imágenes clínicas adjuntas a evoluciones ni el «Mensaje a colega»
  (reservado a médicos);
- eliminar documentos (no autorizado todavía; solo Dueño/Administrador y Médico);
- acceder a usuarios y roles;
- acceder a Caja, producción financiera, sueldo de Secretaría o liquidaciones;
- ejecutar borrado global o reparaciones administrativas sensibles;
- modificar seguridad o autenticación.

La ficha administrativa del paciente es independiente de la Historia Clínica.
Acceder a la primera no habilita a consultar ni modificar la segunda.

### Roles personalizados
Los roles personalizados heredan permisos de `admin`, `medico` o `secretaria`
según su `baseRole`. `baseRole` es la referencia funcional de permisos.

### Alcance técnico actual
Los permisos se aplican en UI y handlers, por lo que continúan siendo controles
de frontend. Hardening 2 no modificó Supabase ni RLS. La seguridad por rol en
backend queda pendiente como evolución futura.

## Backups

### Secretaría
- puede importar y restaurar backups;
- no puede exportar un backup completo si contiene información financiera o
  clínica sensible;
- no puede ejecutar borrado global de datos.

### Dueño / Administrador
Tiene acceso completo a importación, restauración y exportación de backups, y a
las acciones de mantenimiento autorizadas.

## Caja

### Caja cobrada
Dinero efectivamente cobrado:
- particulares;
- copagos;
- señas.

### Producción a facturar
Importes esperados de:
- obras sociales;
- prepagas;
- terceros/facturación definida.

No confundir producción esperada con dinero ya cobrado.

### Pendientes de cobro
Una prestación realizada puede registrarse con **cobro pendiente**: el importe
esperado queda guardado, pero **no cuenta como Caja cobrada** hasta que
Secretaría (o Dueño/Administrador) confirme el cobro.

- Aplica solo a atenciones nuevas con importe a cobrar (particular, copago o
  ambos). Las atenciones históricas no tienen estado de cobro y no se
  recalculan: siguen contando exactamente como antes.
- Al confirmar se registra fecha, usuario, rol y medio de pago
  (Efectivo, Transferencia, Débito o Mixto). Confirmar dos veces no duplica el
  cobro: la segunda confirmación no cambia nada.
- El dinero se atribuye a la caja del profesional (`cajaPerfil`). Un cobro
  confirmado después entra en la caja del día del **pago**; la actividad y la
  producción siguen en la fecha de la atención y los períodos históricos no se
  modifican.
- **Quién confirma**: Dueño/Administrador, cualquier cobro; Secretaría, solo los
  de profesionales con los que tiene una **asociación activa** (las mismas de
  documentos y Copias para facturación). Una Secretaría no asociada no puede
  confirmar, ni cambiar el estado de cobro, ni reescribir o borrar un cobro
  confirmado; sí conserva Agenda, Sala de espera, Carga y la edición asistencial
  y administrativa de las atenciones. Médico: nunca confirma.
- **A quién corresponde el cobro**: al destinatario económico, `cajaPerfil` y, si
  falta, el profesional que atiende (`profesionalId`). Pueden ser personas
  distintas: la asociación se exige contra el destinatario económico, no contra
  quien atiende.
- **Quién confirmó queda auditado con la identidad autenticada** (usuario, email y rol real de la
  sesión), no con un nombre que envíe el cliente; la fecha efectiva la valida el servidor. Esto rige
  también para Dueño/Administrador: nadie puede atribuir una confirmación a otra persona.
- Un cobro confirmado no se vuelve a confirmar ni a reescribir (solo
  Dueño/Administrador). **Revertir una confirmación equivocada no existe en V1**
  y queda como mejora posterior.
- Si el profesional (caja) o el importe de la atención cambian mientras
  Secretaría la tiene a la vista, el cobro **no se confirma**: se actualiza la
  lista y hay que volver a confirmar.
- Secretaría ve el importe de cada cobro pendiente que debe cobrar, pero no ve
  totales de Caja ni de producción. Dueño/Administrador ven además el subtotal
  pendiente por profesional.
- El Médico ve solo los cobros pendientes de su propia caja y no puede
  confirmarlos. Nadie fuera de Dueño/Administrador puede dar de alta una
  atención atribuyendo falsamente una confirmación a otra persona.
- Una atención cancelada o ausente no genera cobro pendiente visible; la seña
  se rige por su propio circuito.
- Un cobro pendiente de pago es distinto de un pendiente de bono/firma: el
  primero afecta solo a Caja; el segundo se resuelve en la bandeja de Pendientes
  (Firma / bono).

### Egresos
- sueldo Secretaría;
- colocaciones;
- otros egresos.

## Sueldo Secretaría
Valor actual de referencia: ARS 400.000 mensuales.
Debe ser configurable por fecha de vigencia.
Es un dato administrativo y no debe mostrarse al perfil Secretaría.

## Colocaciones
Holter/MAPA/ECG colocados por Secretaría generan:
- costo/egreso para la caja correspondiente;
- componente de la liquidación de Secretaría.

Regla temporal:
- colocaciones realizadas en un mes se liquidan el mes siguiente.
Ejemplo:
- julio -> se pagan en agosto;
- agosto -> se pagan en septiembre.

## Prestaciones por profesional
El catálogo es global.
Cada profesional tilda/destilda qué realiza.

Secretaría ve solo las habilitadas para el profesional seleccionado.

No borrar una prestación para desactivarla.
Destildarla mantiene el historial.

## Aranceles
Debe contemplarse:
- profesional;
- convenio/OS/prepaga;
- prestación;
- valor esperado;
- copago si corresponde;
- vigencia por fecha.

Para particulares puede existir valor específico por prestación.

## Médico solicitante / derivador
Para estudios:
- registrar profesional solicitante;
- registrar motivo/indicación;
- permitir “otro/no listado”;
- usarlo en estadísticas por período.

Las estadísticas deben poder diferenciar por prestación y profesional que realiza el estudio.

## Cancelados / ausentes
No deben contar como producción general realizada.
Deben aparecer en estadísticas específicas de cancelación/ausentismo.

Si hubo seña:
- se registra monto;
- forma de pago;
- ingresa a Caja.

## Documentos
El membrete/documento usa la identidad del profesional responsable.

Secretaría puede emitir constancias, certificados y órdenes médicas, por
indicación de un profesional autorizado y con su membrete, sello y firma: el
documento queda a nombre de un profesional con el que la Secretaría está
asociada. Puede subir, consultar, gestionar, descargar, imprimir y enviar los
documentos anteriores y también ECG, Holter, MAPA, ecocardiogramas, estudios,
informes, laboratorios, recetas, indicaciones, aptos físicos y otros documentos
administrativos y médicos. No accede a RCTA.

Regla de asociación: Secretaría solo consulta, visualiza, descarga, imprime y
envía documentos de profesionales con los que tiene una asociación activa en
CardioLink. Se verifica en el servidor (listados, búsquedas, vista previa,
descargas, envíos, historial de envíos y acceso directo por API) y no depende
de filtros del cliente. Al desactivar la asociación, Secretaría pierde de
inmediato el acceso a esos documentos; los documentos sin profesional
identificable no le son visibles. Owner y admin conservan el acceso
administrativo y los médicos sus permisos actuales.

Una versión nueva de un documento (mismo identificador de documento) conserva el
paciente y el profesional del original y solo la emite ese profesional, la
Secretaría autorizada para él u owner/admin; la fecha de alta la fija el
servidor.

La gestión administrativa no autoriza modificar el contenido clínico de
documentos médicos firmados: un documento firmado (emitido) no se edita, se
emite una versión nueva; su tipo, profesional, fecha, paciente y archivo no se
modifican. La eliminación de documentos por Secretaría no está autorizada.

Se distinguen dos clases de imágenes: las imágenes de estudios independientes
(documentos del paciente, accesibles según lo anterior) y las imágenes adjuntas
a evoluciones (tipo «Imagen clínica»), que pertenecen a la Historia Clínica y
tienen acceso clínico (Dueño/Administrador y médicos), no de Secretaría.

El «Mensaje a colega» está reservado a médicos.

Médico: accede a los documentos de un paciente si es el titular del documento
(profesional responsable, o quien lo subió cuando no tiene profesional) o si está
asociado al paciente (tiene evoluciones o atenciones con él). Modifica
únicamente sus documentos; sobre los de otros profesionales solo puede
vincularlos a su atención o evolución.

Dueño/Administrador conserva acceso a documentos clínicos según sus permisos
actuales.

Trazabilidad: cada documento registra qué usuario lo emite o sube (lo fija el
servidor, no el navegador) y a nombre de qué profesional; cada envío registra
qué usuario lo envía.

Hoja de ruta (no implementado): envío de recetas, indicaciones y aptos físicos
por Secretaría (hoy sin plantilla de envío). El módulo de copias para
facturación se describe en la sección siguiente.

## Copias para facturación (V1)
Archivos PDF **independientes** de los informes clínicos, destinados a la
facturación mensual al Círculo Médico: Holter y MAPA (primera página firmada y
sellada) y Ecocardiograma (versión para facturación de EcoApp). Secretaría los
descarga e imprime uno por uno para adjuntarlos a los bonos.

- Se cargan desde Secretaría, desde el perfil médico o desde una atención (en
  ese caso se vinculan solos paciente, DNI, atención, profesional, prestación,
  obra social y fecha del estudio). Sección propia «Copias para facturación»
  (grupo Administrativo) con filtros por mes y año, profesional, obra social y
  estado; la atención muestra «Copia de facturación subida».
- Acciones: descargar, imprimir, marcar como impreso, reimprimir y eliminar con
  confirmación.
- Acceso verificado en el servidor: Dueño/Administrador todas; Médico las de su
  profesional; Secretaría las de profesionales con asociación activa (al
  desactivarla pierde el acceso al instante). Archivos en un bucket privado
  propio; sin URL pública.
- **Eliminar** (decisión por defecto): Dueño/Administrador; Médico las de su
  profesional; Secretaría sólo las que ella misma subió y mientras siga asociada.
  Eliminar una copia no toca informes clínicos ni documentos de HC.
- No se envían al portal del paciente ni por email/WhatsApp, no alteran ni
  reemplazan los documentos de la historia clínica y no se generan ni recortan
  automáticamente.
- Retención: las copias se conservan para reimprimir; no hay borrado automático
  hasta definir el plazo.
- No modifica los indicadores existentes de la atención (`copiaImpresa`,
  «Falta: copia»): son un control manual separado.

### Notas clínicas privadas (excepción absoluta)
Las notas clínicas privadas son accesibles exclusivamente por su autor, incluso
frente a otros médicos, Dueño/Administrador y otros perfiles administrativos. No
están disponibles para Secretaría. Esta excepción prevalece sobre cualquier otro
permiso de acceso. (Bloque 4C-2: pendiente de implementar; las notas hoy
guardadas en la fila de configuración deben migrarse a un almacén por autor y las
que no tengan autor verificable se conservan en cuarentena segura.)

### Envío de documentos por WhatsApp
WhatsApp no es un envío automático: CardioLink abre el chat (`wa.me`) con el
mensaje y un enlace corto al documento (vigente 7 días), y la persona debe
pulsar Enviar en WhatsApp. No adjunta el PDF y no garantiza la entrega; queda
registrado como "preparado, envío no confirmado". El email sí queda como
enviado cuando el proveedor lo acepta.
