# CardioLink Admin — QA mínima antes de producción

Última actualización: 2026-08-15

## Regla
No considerar estable un cambio solo porque “abre”.
Probar persistencia, permisos y navegación.

## 1. Sintaxis
Para cada `.js` modificado:
- ejecutar `node --check archivo.js`.

## 2. Login / sesión
- iniciar sesión;
- confirmar usuario/rol visible;
- verificar que no aparezca falso aviso de sesión vencida.

## 3. Supabase / persistencia
Crear UN dato de prueba:
- paciente o atención;
- esperar sincronización;
- cerrar sesión;
- volver a entrar;
- confirmar que sigue existiendo.

Si el cambio toca HC:
- crear evolución;
- cerrar/reabrir;
- confirmar persistencia.

## 4. Roles
### Secretaría
- crear y editar la ficha administrativa del paciente;
- confirmar que HC, RCTA y Certificado están bloqueados;
- confirmar que Constancia administrativa está disponible;
- gestionar prestaciones por profesional, obras sociales/prepagas, convenios,
  aranceles, valores particulares y copagos;
- confirmar que importar/restaurar backup está disponible;
- confirmar que exportar un backup completo sensible y ejecutar borrado global
  están bloqueados;
- confirmar que Caja, producción financiera, sueldo, liquidaciones y
  usuarios/roles están bloqueados.

### Médico
- confirmar acceso a pacientes, HC, evoluciones, RCTA y documentos clínicos;
- confirmar que no obtiene permisos administrativos o comerciales adicionales.

### Dueño / Administrador
- confirmar acceso completo a administración, configuración, usuarios/roles,
  finanzas, Caja, HC, documentos, reportes, backups y mantenimiento.

### Roles personalizados
- probar al menos un rol basado en `admin`, uno en `medico` y uno en
  `secretaria`;
- confirmar que cada uno hereda capacidades y restricciones de su `baseRole`.

## 5. Navegación
Recorrer:
- Dashboard
- Carga
- Agenda
- Pacientes
- HC (solo con un rol permitido)
- Pendientes
- Caja (solo con un rol permitido)
- Estadísticas
- Configuración

## 6. Paciente actual
Con Médico o Dueño/Administrador:
- seleccionar paciente;
- abrir HC;
- evolucionar;
- usar Acciones;
- cerrar paciente;
- seleccionar otro;
- confirmar que no reaparece el anterior.

## 7. Finanzas
Si se toca Caja:
- particular;
- copago;
- OS/prepaga;
- sueldo Secretaría;
- colocaciones;
- filtro por período;
- perfil correcto.

Si se toca Pendientes de cobro:
- atención histórica (sin estado de cobro): su importe no cambia en Caja;
- atención nueva con "Cobro pendiente": 0 en Caja del día, Listado y Finanzas;
- confirmar con Secretaría: entra una sola vez, en la caja del profesional
  correcto y con el medio elegido (fecha/usuario/medio quedan registrados);
- doble clic y segunda sesión confirmando lo mismo: no se duplica;
- Médico: ve solo los pendientes de su caja y no puede confirmar;
- Secretaría: confirma sin ver totales de Caja.
- Secretaría asociada al profesional confirma; no asociada no confirma (mensaje de falta de autorización) pero sigue operando Agenda/Sala/Carga;
- si cambia la caja (profesional) o el importe mientras se ve el cobro: no confirma y pide volver a confirmar;
- cobro "No cobrar" y cobro pendiente de bono/firma siguen diferenciados del pendiente de pago;
- procedimiento completo de STAGING: `docs/PENDIENTES_COBRO_V1_QA_STAGING.md`.

## 8. Prestaciones
Si se toca configuración:
- cambiar profesional;
- confirmar que cambia la lista de prestaciones;
- destildar/tildar;
- confirmar que no borra historial.

## 9. PWA / caché
Si se cambia `index.html`, `sw.js` o módulos:
- probar recarga forzada;
- confirmar versión publicada;
- revisar que el Service Worker no sirva código viejo.

## 10. Responsive
Probar al menos:
- desktop;
- ancho tipo iPad;
- ancho tipo teléfono si el cambio es visual.

## 11. Copias para facturación (si se toca el módulo)
Con Secretaría asociada, Médico y Dueño/Administrador:
- subir un PDF desde una atención de Holter/MAPA/Eco: se vinculan solos los datos
  y la atención muestra «Copia de facturación subida»;
- subir desde la sección sin atención;
- filtros (mes, profesional, obra social, estado), descargar, imprimir, marcar
  impreso, reimprimir y eliminar con confirmación;
- Secretaría no ve copias de médicos no asociados; al desactivar la asociación
  pierde el acceso; Médico sólo las suyas;
- eliminar una copia no toca el informe clínico ni documentos de HC; el paciente
  no ve nada en el portal.
Suite estática: `node tests/copias-facturacion-v1.js`.

## Antes de commit
Informar:
- qué se cambió;
- qué se probó;
- qué falta probar;
- riesgo;
- rollback.
