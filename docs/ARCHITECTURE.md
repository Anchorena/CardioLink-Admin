# CardioLink Admin — Arquitectura técnica

Última actualización: 2026-08-14

## Stack
- HTML
- CSS
- JavaScript clásico
- Supabase
- GitHub Pages
- PWA / Service Worker

## Principio de evolución
La aplicación nació con mucha lógica concentrada en `app.js`.
La estrategia actual es modularizar progresivamente, sin refactor masivo.

### Regla
No partir `app.js` completo de una vez.
Extraer o agregar módulos cuando exista una razón funcional concreta.

## Archivos principales

### `index.html`
Carga la aplicación y módulos auxiliares.
El orden de `<script>` importa.

### `app.js`
Núcleo histórico de la aplicación.
Área de alto riesgo por cantidad de dependencias globales.

### `styles.css`
Estilos principales.

### `sw.js`
Service Worker / caché PWA.
Un bug de caché puede hacer que producción ejecute archivos viejos.

### Módulos auxiliares
Pueden existir, entre otros:
- `cardiolink-auth-guard.js`
- `cardiolink-clear-patient-fix.js`
- `cardiolink-hc-referidos.js`
- `cardiolink-prestaciones-perfil.js`
- `cardiolink-dashboard-v1.js`

`cardiolink-dashboard-v1.js` se carga al final de los scripts de `index.html`.
Renderiza únicamente la portada y reutiliza los bindings ya inicializados por
`app.js` para perfiles, agenda, Pendientes y acciones rápidas. Sus estilos están
aislados en `cardiolink-dashboard-v1.css`.

Antes de crear otro módulo:
1. revisar los existentes;
2. verificar si ya interceptan la misma función;
3. evitar wrappers encadenados innecesarios.

## Supabase

### Operativo
La tabla histórica principal de atenciones usa un esquema de payload JSON:
- id
- payload
- updated_at

La sincronización estable debe ser `upsert`-first.
No hacer estrategias tipo “delete all + reinsert” desde cliente.

### HC relacional
Existen tablas relacionales para:
- pacientes;
- resumen clínico;
- evoluciones clínicas.

La app debe conservar compatibilidad entre la capa operativa histórica y la HC relacional.

## Sesión / sincronización
El login y la sincronización son áreas críticas.

Hubo un bug previo donde un guard de sesión consultaba `window.supabaseClient`
mientras `app.js` declaraba el cliente con `let supabaseClient`.
Resultado: la app mostraba sesión vencida y bloqueaba escrituras aunque el login funcionaba.

Regla:
- inspeccionar el binding real del cliente Supabase antes de envolver sync;
- no asumir que variables globales con `let` son propiedades de `window`;
- probar siempre persistencia después de cerrar/reabrir sesión.

## Estado local
CardioLink usa almacenamiento del navegador para parte de la operación/configuración.
No borrar caché/localStorage cuando existe una recuperación pendiente.

Claves históricamente relevantes pueden incluir:
- `cardiolink_atenciones_v25`
- `cardiolink_config_v25`

Antes de modificar almacenamiento:
- identificar claves reales del repo actual;
- hacer backup/export;
- no sobreescribir datos sin estrategia de merge.

## PWA / caché
Cuando se cambia un módulo:
- usar cache-busting/versionado si corresponde;
- verificar que GitHub Pages publique la versión nueva;
- probar recarga forzada;
- revisar `sw.js` si el navegador sirve código anterior.

## Estrategia de módulos
Preferir módulos con responsabilidad clara:
- auth/sesión
- pacientes
- HC
- documentos
- prestaciones
- finanzas
- UI

Evitar:
- múltiples módulos reescribiendo la misma función global;
- MutationObservers globales sin necesidad;
- wrappers no documentados;
- dependencias implícitas por orden de carga.

## Producción
`main` debe considerarse producción.
Para cambios funcionales:
- branch corta o commit controlado;
- probar antes de merge/push a producción;
- mantener rollback simple.
