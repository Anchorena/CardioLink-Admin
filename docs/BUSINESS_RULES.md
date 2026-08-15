# CardioLink Admin — Reglas de negocio

Última actualización: 2026-08-15

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
- importar o restaurar backups;
- emitir constancias administrativas cuando corresponda.

No puede:
- acceder a Historia Clínica, resumen clínico, evoluciones, antecedentes,
  alergias, medicación habitual, signos vitales almacenados en HC ni notas
  privadas médicas;
- acceder a RCTA o informes clínicos, ni emitir certificados médicos;
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

Secretaría puede emitir constancias administrativas cuando corresponda. No
puede emitir certificados médicos, RCTA ni informes clínicos.

Médico y Dueño/Administrador conservan acceso a documentos clínicos según sus
permisos actuales.
