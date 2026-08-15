# CardioLink Admin — Contexto funcional

Última actualización: 2026-08-15

## Objetivo
Sistema médico propio para consultorio/polo ambulatorio con:
- turnos y agenda;
- sala de espera;
- pacientes;
- Historia Clínica y evoluciones;
- documentos médicos;
- prestaciones;
- obras sociales/prepagas;
- Caja/reportes;
- estadísticas;
- roles y permisos.

Uso principal: Windows, Mac, iPad y teléfonos.

## Roles

### Dueño / Administrador
Tiene acceso completo a administración, configuración, usuarios/roles, finanzas,
Caja, HC, documentos, reportes, backups, prestaciones, profesionales, obras
sociales/prepagas, convenios, aranceles y mantenimiento.

### Médico
Conserva acceso clínico a pacientes, Historia Clínica, evoluciones,
antecedentes, alergias, medicación, signos vitales clínicos, RCTA, documentos
e informes clínicos, y a la agenda según sus permisos actuales.

El rol Médico no adquiere por ello permisos administrativos o comerciales.

### Secretaría
Es un rol administrativo, operativo y comercial.

Puede:
- crear y editar turnos/atenciones;
- gestionar sala de espera y estados;
- editar la ficha administrativa del paciente;
- gestionar profesionales y especialidades;
- agregar o eliminar prestaciones del catálogo y modificar la matriz habilitada
  por profesional, sin borrar antecedentes históricos;
- agregar o eliminar obras sociales/prepagas y modificar convenios, aranceles,
  valores particulares y copagos;
- cargar pagos, bonos, autorizaciones, médico solicitante y motivo/indicación;
- importar o restaurar backups;
- emitir constancias administrativas cuando corresponda.

No puede:
- acceder a Historia Clínica, resumen clínico, evoluciones, antecedentes,
  alergias, medicación habitual, signos vitales almacenados dentro de HC ni
  notas privadas médicas;
- acceder a RCTA o informes clínicos, ni emitir certificados médicos;
- gestionar usuarios/roles, seguridad o autenticación;
- acceder a Caja, producción financiera, sueldo de Secretaría o liquidaciones;
- ejecutar borrado global de datos ni reparaciones administrativas sensibles;
- exportar un backup completo si contiene información financiera o clínica
  sensible.

La ficha administrativa del paciente no equivale a la Historia Clínica y no
habilita acceso a datos clínicos.

### Roles personalizados
Los roles personalizados heredan capacidades según su `baseRole`: `admin`,
`medico` o `secretaria`. `baseRole` es la referencia funcional para resolver
permisos.

## Ficha administrativa de pacientes
Datos administrativos habituales:
- nombre/apellido;
- DNI;
- fecha de nacimiento;
- edad calculada;
- teléfono;
- email;
- obra social/prepaga;
- número de afiliado;
- observaciones administrativas.

Secretaría puede crear y editar estos datos. Este acceso permanece separado de
la Historia Clínica.

Debe existir acceso rápido para copiar:
- DNI;
- teléfono;
- email;
- número de afiliado.

## Turnos / atenciones
Incluyen:
- fecha/hora;
- profesional;
- sede/consultorio;
- prestación;
- duración;
- estado;
- cobertura;
- forma de pago/copago/bono/autorización;
- observaciones;
- médico solicitante/derivador cuando corresponda;
- motivo/indicación del estudio.

Estados relevantes:
reservado, confirmado, llegó/en espera, en consulta, estudio, atendido, ausente, cancelado, reprogramado.

## Prestaciones
Catálogo global configurable.
Cada profesional debe poder tildar/destildar cuáles realiza actualmente.

Destildar una prestación:
- NO borra estudios históricos;
- solo evita ofrecerla para turnos nuevos.

Secretaría debe ver solo las prestaciones habilitadas para el profesional seleccionado.

Ejemplos actuales/futuros:
- consulta;
- ECG;
- Holter;
- MAPA;
- ecocardiograma;
- ecografía general;
- Doppler vascular;
- Doppler/Duplex transcraneal;
- ergometría;
- otras configurables.

## Historia Clínica
Debe permitir:
- resumen clínico persistente;
- antecedentes;
- alergias;
- medicación habitual;
- evoluciones fechadas;
- signos vitales y antropometría;
- evoluciones con o sin turno;
- profesional logueado;
- auditoría;
- documentos asociados.

Una evolución puede existir sin turno.

## Médico solicitante / derivador
Para estudios debe poder registrarse el colega que refiere/deriva/solicita y el motivo.

Debe poder cargarse:
- desde Secretaría al crear el turno/atención;
- desde la evolución clínica;
- desde flujos de Eco/Ecografía cuando corresponda.

Las estadísticas deben permitir ranking de médicos solicitantes por período y prestación.

## Documentos
Incluyen:
- receta/RCTA;
- orden médica;
- certificado;
- constancia;
- otros documentos clínicos.

El membrete pertenece al profesional responsable del documento, no necesariamente al usuario que lo genera.

Secretaría solo puede emitir constancias administrativas: no puede emitir
certificados médicos, RCTA ni informes clínicos. Médico y Dueño/Administrador
mantienen el acceso a documentos clínicos que corresponda a sus permisos.

## Backups
Secretaría puede importar y restaurar backups operativos, pero no exportar un
backup completo con información financiera o clínica sensible ni ejecutar un
borrado global. Dueño/Administrador conserva acceso completo.

## Seguridad actual de permisos
Los permisos actuales se aplican en la interfaz y en los handlers de la
aplicación. Siguen siendo controles de frontend: Hardening 2 no modificó
Supabase ni RLS. La autorización por rol respaldada en backend queda pendiente
como evolución futura.

## Dashboard
Debe evolucionar hacia una pantalla de bienvenida/operativa:
- identidad del profesional activo;
- pacientes del día;
- consultas;
- estudios;
- pendientes;
- ausentes/cancelados;
- accesos rápidos;
- métricas financieras solo si el rol lo permite.

No usar Dashboard para instructivos largos ni configuraciones técnicas.

## Configuración
Debe ordenarse por bloques:
1. Profesionales
2. Prestaciones por profesional
3. Valores/aranceles
4. Obras sociales/convenios
5. Membrete/documentos
6. Administración financiera
7. Instructivos

## Evolución futura
- Supabase Auth consolidado;
- seguridad backend por roles y RLS;
- multiusuario/multiconsultorio;
- PWA más robusta;
- versión comercializable;
- posible sincronización entre sedes.

### Acceso clínico delegado de solo lectura
En una fase futura, Secretaría podrá solicitar o generar una salida clínica en
PDF de solo lectura sin entrar ni navegar por la Historia Clínica y sin requerir
aprobación previa del médico.

Según lo que se implemente, podrá visualizar, generar, imprimir o enviar ese
PDF, pero no editar evoluciones ni datos clínicos. Cada acceso deberá registrar
de forma persistente paciente, usuario, rol, fecha y hora, tipo de documento y
acción realizada. Esta auditoría deberá respaldarse también con controles de
backend/RLS y no depender solo del frontend.
