# CardioLink — Portal Público V1

Estado: **código listo, sin desplegar**. No se ejecutó SQL, no se tocó
Producción, no se hizo commit ni push. Este documento describe qué se
construyó, cómo probarlo localmente y qué falta para desplegarlo de verdad.

## Alcance de esta etapa

Sí:
- micrositio público mobile-first del consultorio (identidad, prestaciones,
  profesionales, modalidad de atención, contacto) con flujo de solicitud de
  turno simple: DNI → alta si hace falta → elegir prestación → enviar;
- Edge Function `portal-gateway` como único gateway hacia
  `cardiolink_pacientes` / `cardiolink_appointment_requests`;
- las solicitudes creadas por el portal aparecen en la bandeja interna
  "Solicitudes de turno" ya existente (misma tabla, sin bandeja nueva);
- contenido público (identidad/profesionales/prestaciones/modalidad/
  contacto/coberturas) centralizado en un único archivo, listo para migrar
  después a Configuración de CardioLink.

No (todavía): agenda, reserva de horarios, selección de profesional en la
solicitud, texto libre público, email, WhatsApp, OCR, pagos, catálogo
dinámico real de profesionales/prestaciones/coberturas, despliegue.

## Archivos

- `portal/index.html`, `portal/portal.css`, `portal/portal.js` — el
  micrositio, separado por completo del Admin (no comparte `app.js` ni CSS).
- `portal/contenido-publico.js` — identidad, profesionales, prestaciones,
  modalidad, contacto y coberturas, centralizados en un único lugar.
- `supabase/functions/portal-gateway/index.ts` — la Edge Function (Deno).
- `supabase/functions/portal-gateway/logica.js` — validación/normalización
  pura (ESM), sin Deno ni Supabase, importada por `index.ts`.
- `supabase/migrations/20260821150000_cardiolink_appointment_requests_requested_coverage.sql`
  — migración **propuesta, sin ejecutar** (agrega `requested_coverage`).
- `cardiolink-solicitudes-turno.js` — bandeja interna: ahora trae y prellena
  `requested_coverage` al abrir "Carga de turno".
- `tests/portal-gateway-logica.js`, `tests/portal-frontend.js`,
  `tests/solicitudes-turno-presentacion.js` — pruebas.

## Identidad y contenido real encontrado en el repo

Todo el contenido de marca del micrositio se buscó primero en el
repositorio; nada se inventó. Lo que se encontró:

- **Nombre del consultorio**: `"Consultorio Médico RM"` — es el
  `marcaDocumento` real que ya usa el Admin como membrete por defecto para
  Matías (`app.js`, `marcaDocumento = p.id==='matias' ? 'Consultorio Médico RM' : p.nombre`).
- **Colores de marca**: `#123f56` (primario) — el mismo `--primary` de
  `styles.css` y el mismo `theme_color`/`background_color` de
  `manifest.webmanifest`.
- **Logo**: no existe un logo/wordmark real en el repositorio. Se reutiliza
  `icons/icon-512.png` (el ícono de la PWA) como logo provisorio, en una
  única variable configurable (`contenido-publico.js` → `identidad.logoUrl`).
  **Falta aportar un logo real** para reemplazar ese ícono.
- **Profesional**: Dr. Matías Anchorena — especialidad, M.N. 115.607 y
  M.P. 332.578 tomados de los valores reales ya usados en `app.js`
  (`usuariosDefault`/`defaults.profesionales` y las matrículas por defecto
  del documento). **Geraldine queda excluida a propósito** (no es
  profesional médica). No existe una biografía/descripción pública ni una
  foto en el repo: esos campos quedan vacíos, no se inventaron.
- **Coberturas**: subconjunto real de `defaults.obrasSociales` (`app.js`):
  Particular, OSDE, Swiss Medical, Medicus, Galeno, IOMA, PAMI, Sancor,
  Otra — más `"No sé / consultar"`, agregada porque el pedido de esta etapa
  la exige explícitamente para el portal público (no existía en la lista
  interna).
- **Prestaciones**: sólo los nombres (Consulta, Holter 24 h, MAPA,
  Ergometría, Ecocardiograma) tienen respaldo real. **No existe ninguna
  descripción, "para qué sirve", duración ni preparación previa en el
  repositorio** para ningún estudio — esos campos quedan vacíos a propósito
  (inventar contenido clínico sería peor que no mostrar nada).
- **Contacto**: no se encontró ningún dato real de dirección, teléfono,
  WhatsApp, Instagram o email del consultorio en todo el repositorio (sólo
  placeholders de UI o usuarios sintéticos `@cardiolink.local` para login).
  **Los 6 campos de contacto quedan vacíos**; el portal no renderiza una
  etiqueta para un campo vacío (evita mostrar "Teléfono: " sin nada
  después) y en su lugar muestra un aviso neutro.

## Flujo implementado

1. El paciente entra a `portal/index.html` (por QR, link de WhatsApp o web).
   El parámetro `?source=qr|whatsapp|web` se lee de la URL (nunca datos
   personales en la URL); si falta o es inválido, se usa `web`.
2. Ve el micrositio (hero con nombre/logo/descripción, prestaciones,
   profesionales, modalidad de atención, contacto) con el botón
   **SOLICITAR TURNO** arriba y abajo.
3. Al tocar **Solicitar turno**, entra al flujo enfocado: ingresa su DNI →
   `portal.js` llama a `check-dni`.
4. Si ya existe: sólo se muestra "Ya estás registrado en CardioLink." y se
   habilita **Solicitar turno** de nuevo (ahora dentro del flujo). No se
   devuelve ni un solo dato del paciente.
5. Si no existe: se muestra el formulario de alta (nombre, apellido, DNI,
   fecha de nacimiento, **teléfono — se pide acá, una única vez**;
   email/n° de afiliado opcionales; obra social/prepaga como **select
   cerrado**, no texto libre). Al confirmar, `portal.js` llama a `registro`,
   que crea el paciente **directo en `cardiolink_pacientes`** (la misma
   tabla del Admin: sin tabla de pre-pacientes, sin aprobación
   administrativa — por eso el QR/link también sirve sólo para sumar
   pacientes al padrón, aunque no quieran pedir turno en el momento).
   Aparece en el listado de Pacientes del Admin en cuanto ese lado sincroniza
   de nuevo contra Supabase. Al confirmarse, se muestra un paso propio: "Tu
   registro fue realizado correctamente." con dos botones, **SOLICITAR
   TURNO** y **FINALIZAR** (volver al inicio sin pedir turno).
6. El formulario de solicitud pide la **prestación** y la **cobertura para
   esta solicitud** (los dos, select cerrado — la cobertura usa la misma
   lista `COBERTURAS_VALIDAS` del alta, pero es un campo aparte: nunca
   sobrescribe `cardiolink_pacientes.cobertura_habitual`, aplica igual para
   paciente nuevo o existente). Sin selección de profesional, sin volver a
   pedir teléfono, sin texto libre. Al enviarlo, `portal.js` llama a
   `solicitud-turno` con `{ dni, prestacion, cobertura, source }`
   únicamente. Respuesta siempre fija: "Tu solicitud fue recibida. El
   consultorio se comunicará con vos para coordinar el turno." Nunca se
   muestran horarios.
7. "‹ Volver al inicio" regresa al micrositio en cualquier paso del flujo.

## Edge Function `portal-gateway`

Un único endpoint POST, con `{ action, ...datos }` en el body:

- `check-dni` → normaliza el DNI, busca por `dni_normalizado`
  (columna generada en la migración de Fase 1) y devuelve **sólo**
  `{ ok, existe: boolean }`.
- `registro` → valida (incluida la cobertura contra la lista cerrada
  `COBERTURAS_VALIDAS`), busca de nuevo por DNI (evita duplicar), y si no
  existe crea la fila en `cardiolink_pacientes` con
  `id = 'pac_' + crypto.randomUUID().replace(/-/g,'')` (mismo prefijo que ya
  usa el Admin, con una fuente de aleatoriedad criptográfica al ser un
  endpoint público sin sesión). Si el `insert` falla por `23505`
  (unique_violation en `dni_normalizado`, por una carrera contra otra
  solicitud simultánea), reutiliza el paciente que ganó la carrera en vez de
  fallar. **Nunca devuelve el id.**
- `solicitud-turno` → valida la prestación contra el catálogo cerrado
  `PRESTACIONES_PUBLICAS_V1` y la cobertura contra `COBERTURAS_VALIDAS`
  (obligatoria, mismo select cerrado del alta pero campo aparte), resuelve
  el paciente internamente por DNI (nunca confía en un id que mande el
  cliente), y **toma el teléfono del registro guardado en
  `cardiolink_pacientes`** (nunca de un input del formulario de solicitud —
  el teléfono ya no viaja en ese request). Si el paciente no tiene teléfono
  guardado, rechaza con un mensaje claro en vez de crear una solicitud sin
  forma de contactarlo. `requested_professional_id` y
  `requested_professional_name` siempre quedan `null` (la asignación de
  profesional se hace después, dentro de CardioLink Admin); `message`
  siempre queda `null` (sin texto libre público). Si ya hay una solicitud
  `new` del mismo paciente en los últimos 2 minutos no crea una segunda
  (protección básica contra doble envío). Crea la fila en
  `cardiolink_appointment_requests` con `status: 'new'`, el `source`
  recibido (`qr`/`whatsapp`/`web`) y `requested_coverage` con la cobertura
  de esta solicitud puntual — **nunca escribe ni sobrescribe**
  `cardiolink_pacientes.cobertura_habitual`.

### Columna nueva: `requested_coverage` (propuesta, sin ejecutar)

`cardiolink_appointment_requests` no tenía ningún campo para esto. Se
propuso (sin ejecutar) la migración
`supabase/migrations/20260821150000_cardiolink_appointment_requests_requested_coverage.sql`:
`alter table ... add column requested_coverage text null` (nullable: las
solicitudes creadas antes de este cambio no la tienen, y no corresponde
inventarla) más un `check` de "no vacía si no es null" — sin `check` de
enum fijo, mismo criterio que `requested_service`, para no necesitar otra
migración cada vez que el catálogo de coberturas cambie.

### Bandeja interna: "Abrir carga de turno" prellena la cobertura

`cardiolink-solicitudes-turno.js` ahora trae `requested_coverage` en el
`select` de `cargarSolicitudes()` y, al abrir "Carga de turno", una nueva
`seleccionarCoberturaSolicitada(solicitud)` prellena `#obraSocial` con esa
cobertura (agregándola al select si hiciera falta, igual que ya hace
`hidratarPacienteRemoto` con la cobertura habitual). Si la cobertura de la
solicitud es `"No sé / consultar"` no se fuerza nada: no es una obra social
real, así que `#obraSocial` queda como esté (por ejemplo, ya prellenado con
la cobertura habitual del paciente) en vez de forzar una opción sin sentido
para facturación. Nunca se toca `cardiolink_pacientes.cobertura_habitual`.

`service_role` vive únicamente como `Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')`
dentro de la Edge Function — nunca en `portal/`, nunca en el repositorio.
Como `service_role` bypasea RLS por diseño de Supabase, **no fue necesario
modificar ninguna policy existente** de `cardiolink_pacientes` ni de
`cardiolink_appointment_requests`.

`PRESTACIONES_PUBLICAS_V1` (en `index.ts`) y `COBERTURAS_VALIDAS` (en
`logica.js`) deben coincidir siempre, en nombre y orden, con las mismas
listas de `portal/contenido-publico.js` — hay comentarios marcando esa
dependencia y un test que cruza ambos archivos para detectar que se
desincronicen.

## Seguridad

- Validación server-side autoritativa en `logica.js` (límites de longitud,
  DNI 6–9 dígitos, email con formato básico, fecha `YYYY-MM-DD`, campos
  obligatorios, cobertura contra lista cerrada) — la validación en
  `portal.js` es sólo para UX, nunca la frontera real.
- El portal nunca importa el SDK de Supabase ni tiene ninguna clave: sólo
  hace `fetch()` contra la URL de la Edge Function.
- Ningún campo oculto del navegador se usa como identidad: `solicitud-turno`
  siempre resuelve el paciente (y su teléfono) por DNI en el servidor.
- Logs mínimos: sólo la acción (`check-dni`/`registro`/`solicitud-turno`),
  nunca DNI, nombre, teléfono ni email.

## Preparado para comunicaciones futuras (sin implementar)

`manejarSolicitud` en `index.ts` es el único punto donde se confirma la
creación de una solicitud; cuando se implemente el envío de email/WhatsApp al
confirmar un turno, ese disparo se agrega ahí (o en un webhook posterior que
reaccione a un cambio de `status`), sin tocar el portal ni el flujo de alta.

## Cómo probar localmente (sin desplegar nada)

1. Servir `portal/` con un servidor estático simple, por ejemplo:
   ```bash
   python3 -m http.server 4174 --directory portal
   ```
2. Abrir `http://127.0.0.1:4174/?source=qr`. Ya se debería ver el
   micrositio completo (hero con "Consultorio Médico RM", prestaciones,
   profesional, modalidad, aviso de contacto pendiente) sin llamar a la
   Edge Function todavía.
3. Tocar **Solicitar turno**: cualquier envío del flujo (DNI, alta,
   solicitud) va a fallar contra `GATEWAY_URL_DEFAULT`
   (`https://REEMPLAZAR-PROJECT-REF.functions.supabase.co/portal-gateway`,
   un placeholder que no existe). Para probar el flujo completo contra
   Staging una vez que la función esté desplegada ahí, pegar en la consola
   del navegador antes de interactuar con el formulario:
   ```js
   window.CARDIOLINK_PORTAL_GATEWAY_URL = 'https://STAGING-REF.functions.supabase.co/portal-gateway';
   ```
4. Revisar `tests/portal-gateway-logica.js` y `tests/portal-frontend.js`
   para la cobertura de casos (ver más abajo — no se pudieron ejecutar en
   este entorno).

## Qué falta para desplegar

1. Revisar `supabase/functions/portal-gateway/index.ts` con un compilador
   TypeScript / el CLI de Supabase real (este entorno no tiene Deno ni
   TypeScript disponibles: sólo se validó como sintaxis JavaScript plana,
   ver más abajo).
2. Confirmar el nombre/tipo exacto de todas las columnas de
   `cardiolink_pacientes` contra el esquema real (no hay una migración
   `create table` en este repo para esa tabla; el mapeo usado acá replica el
   que ya usa `app.js` en `pacienteRow410`, pero conviene una verificación
   final antes de desplegar).
3. `supabase functions deploy portal-gateway` + configurar
   `SUPABASE_SERVICE_ROLE_KEY` como secret de la función (nunca en el
   repositorio).
4. Reemplazar `GATEWAY_URL_DEFAULT` en `portal/portal.js` por la URL real.
5. Decidir hosting de `portal/` (puede ser el mismo GitHub Pages, en una
   ruta separada del Admin) y generar los QR una vez que la URL final esté
   fija.
6. **Aportar un logo real** (reemplazar `identidad.logoUrl` en
   `contenido-publico.js`, hoy apuntando al ícono de la PWA).
7. **Completar los datos de contacto reales** (dirección, teléfono,
   WhatsApp, Instagram, email, mapa) en `contenido-publico.js` →
   `CONTACTO` — hoy están vacíos a propósito.
8. Decidir y redactar contenido real de prestaciones (para qué sirve,
   duración, preparación previa) y, si se quiere, una bio corta del
   profesional — hoy esos campos están vacíos a propósito.
9. Reemplazar `PRESTACIONES_PUBLICAS_V1`/`COBERTURAS_VALIDAS` (estáticos)
   por una fuente dinámica cuando se decida exponerla con seguridad desde
   Configuración de CardioLink.
10. QA manual end-to-end contra Staging: DNI nuevo, DNI existente, teléfono
    resuelto correctamente en la solicitud, error de red, doble envío, y
    confirmar en la bandeja "Solicitudes de turno" que la solicitud aparece
    con `requested_professional_id/name` en `null`, `message` en `null`,
    el `source` correcto y `status: 'new'`.

## Tests y validación en este entorno

Este entorno no tiene `node`, `deno` ni un compilador TypeScript
disponibles (confirmado repetidas veces en esta sesión). Para no reportar
resultados de ejecución fabricados:

- La sintaxis de los archivos JS/TS se validó con un parser real
  (`esprima`, instalado localmente con `pip3 install --user esprima` sólo
  para esta verificación) — `index.ts` y `logica.js` se escribieron a
  propósito sin ningún tipo de TypeScript (sin anotaciones de tipo), así que
  pudieron parsearse igual que JavaScript plano/ESM. `esprima` no soporta
  `?.`/`??`, así que se neutralizaron temporalmente sólo para el chequeo de
  sintaxis (nunca se tocaron los archivos reales).
- `tests/portal-gateway-logica.js` y `tests/portal-frontend.js` son en su
  mayoría pruebas estáticas (aserciones sobre el código fuente), más varias
  pruebas de `portal-frontend.js` que sí serían ejecutables de verdad con
  `require()` si hubiera Node disponible (los helpers exportados de
  `portal.js` y `contenido-publico.js` son CommonJS-compatibles vía el mismo
  patrón UMD que ya usa el resto del Admin). No se pudieron correr en este
  entorno; cada aserción se verificó manualmente contra el código fuente
  línea por línea, incluyendo un cruce automático (por texto) entre las
  listas de prestaciones del gateway y de `contenido-publico.js` para
  detectar que se desincronicen.
- `git diff --check` se ejecutó sobre el árbol de trabajo: sin errores.
