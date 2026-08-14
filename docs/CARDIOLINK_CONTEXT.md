# CardioLink Admin — Contexto funcional

Última actualización: 2026-08-14

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
Puede configurar profesionales, prestaciones, convenios, aranceles, parámetros financieros, reportes y permisos.

### Médico
Puede ver agenda, pacientes, HC, evoluciones, documentos y acciones clínicas según su perfil.

### Secretaría
Puede cargar/editar turnos, confirmar llegada, manejar sala de espera, cobertura, pagos/bonos/autorizaciones y asignar profesional.
No debe ver información financiera administrativa sensible como sueldo/liquidación interna.

## Pacientes
Datos habituales:
- nombre/apellido;
- DNI;
- fecha de nacimiento;
- edad calculada;
- teléfono;
- email;
- obra social/prepaga;
- número de afiliado;
- observaciones administrativas.

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
Incluyen, según permisos:
- receta/RCTA;
- orden médica;
- certificado;
- constancia;
- otros documentos clínicos.

El membrete pertenece al profesional responsable del documento, no necesariamente al usuario que lo genera.

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
- RLS;
- multiusuario/multiconsultorio;
- PWA más robusta;
- versión comercializable;
- posible sincronización entre sedes.
