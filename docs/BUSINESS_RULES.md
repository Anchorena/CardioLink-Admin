# CardioLink Admin — Reglas de negocio

Última actualización: 2026-08-14

## Permisos

### Administración
Puede ver:
- Caja/reportes;
- sueldo Secretaría;
- liquidaciones;
- configuraciones financieras;
- convenios/aranceles;
- reportes sensibles.

### Secretaría
No debe ver:
- sueldo;
- liquidación de Secretaría;
- movimientos financieros administrativos sensibles.

Sí puede cargar:
- pagos/copagos;
- cobertura;
- bono/autorización;
- médico solicitante;
- motivo del estudio.

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
Si Secretaría emite un documento, debe elegir o respetar el profesional responsable.
