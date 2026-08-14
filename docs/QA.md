# CardioLink Admin — QA mínima antes de producción

Última actualización: 2026-08-14

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
Probar como mínimo:
- dueño/admin;
- Secretaría;
- médico.

Confirmar que cada rol ve solo lo permitido.

## 5. Navegación
Recorrer:
- Dashboard
- Carga
- Agenda
- Pacientes
- HC
- Pendientes
- Caja (si corresponde)
- Estadísticas
- Configuración

## 6. Paciente actual
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

## Antes de commit
Informar:
- qué se cambió;
- qué se probó;
- qué falta probar;
- riesgo;
- rollback.
