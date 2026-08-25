# CardioLink — Portal Público: Visual V1

Estado: **sin desplegar**. No se ejecutó SQL, no se tocó Supabase/backend/
gateway/Turnstile. Sólo estética, contenido y configurabilidad del portal
público. Complementa [PORTAL_PUBLICO_V1.md](PORTAL_PUBLICO_V1.md) y
[PORTAL_PUBLICO_HARDENING_V1.md](PORTAL_PUBLICO_HARDENING_V1.md).

## Corrección de criterio (post-revisión del dueño, antes del commit)

La primera versión de esta etapa había excluido a **Rutter** (por no tener
respaldo en el repo más allá de aparecer como colega externa) e incluido a
**los dos Drago** (Humberto y Lucas, ambos con registro real en app.js). El
dueño del consultorio corrigió el criterio directamente:

- **Rutter SÍ es parte del staff público** — confirmado directamente, no
  inferido del repo. Se agregó a `PROFESIONALES`, pero **sin inventar**
  especialidad/matrícula/prestaciones/horarios/bio/foto: esos campos
  quedan vacíos hasta que se confirmen, y la tarjeta muestra un aviso
  discreto ("Más información, próximamente.") en vez de campos vacíos.
- **"Drago Lucas" se sacó** del portal: tener un registro real en app.js no
  alcanza para asumir que pertenece al staff público sin una confirmación
  explícita — exactamente el mismo criterio que ya se había aplicado (bien)
  a Rutter, ahora aplicado también a este caso. Sólo queda **Fernández
  Drago Humberto**, que si estaba confirmado.

## Profesionales (4, tras la corrección)

| Profesional | Especialidad | Prestaciones | Matrícula | Modalidad | Días / horario |
|---|---|---|---|---|---|
| Dr. Matías Anchorena | Cardiología / Medicina Crítica | Consulta, Electrocardiograma, ECG, Ecocardiograma Doppler, Holter, MAPA (app.js) | M.N. 115.607 / M.P. 332.578 | Con turno | — (no aplica: coordina Secretaría) |
| Dr. Rogelio Anchorena | Cardiología | Consulta, Electrocardiograma, Holter, MAPA (confirmado directamente por el dueño — ver nota) | — sin dato en el repo | Orden de llegada | Lunes a viernes, 14:30 a 19:30 |
| Dr. Fernández Drago Humberto | Diagnóstico por Imágenes | Ecografía abdominal, renal, tiroidea, mamaria; Doppler arterial/venoso; Mamografía (app.js) | — sin dato en el repo | Orden de llegada | Martes y viernes, 09:00 a 15:00 |
| Dra. Rutter | — sin confirmar | — sin confirmar | — sin confirmar | Orden de llegada (confirmada) | — sin confirmar todavía (**NO publicada**, `visibleEnPortal: false` — ver más abajo) |

**Nota sobre Rogelio**: sus prestaciones públicas (Consulta, Electrocardiograma,
Holter, MAPA) fueron confirmadas directamente por el dueño del consultorio,
**pisando** el dato anterior que se había copiado de su propio registro en
`app.js` (`defaults.profesionales`, `id:'rogelio'`). Ese registro de
`app.js` sigue listando 6 prestaciones (incluida "Ecocardiograma Doppler")
— es un dato de **facturación interna** que no se tocó (fuera de alcance),
y hoy diverge del dato público real confirmado acá. Si ese registro de
`app.js` está desactualizado, corregirlo es un cambio aparte, autorizado
explícitamente.

Cada profesional tiene su propio objeto de configuración (nunca una
referencia compartida), así que corregir cualquiera de estos datos después
es un cambio de una sola línea, sin afectar a los demás.

## Modalidad de atención por profesional

Cada profesional tiene `modalidadAtencion` (`'con_turno'` | `'orden_llegada'`
| `'mixta'`), `diasAtencion`, `horarios`, `mensajeModalidad` y
`visibleEnPortal` — todo configurable en `contenido-publico.js`, nada
hardcodeado por nombre en `portal.js`. El comportamiento sale sólo de estos
valores (`etiquetaModalidad()`/`lineasModalidad()` en `portal.js`, sin
ningún if/comparación por nombre de profesional):

- **`con_turno`** (hoy sólo Matías): la tarjeta muestra el badge "Turnos
  programados"; el flujo de "Solicitar turno" (hero) sigue igual que antes
  de esta tarea — DNI → alta/ya-registrado → elegir prestación/cobertura.
  Matías sigue siendo el único profesional para el que el portal genera una
  solicitud de turno.
- **`orden_llegada`** (hoy Rogelio, Drago Humberto y Rutter): la tarjeta
  muestra el badge "Atención por orden de llegada". Si `diasAtencion` y
  `horarios` ya están confirmados (Rogelio: lunes a viernes de 14:30 a
  19:30; Drago Humberto: martes y viernes de 09:00 a 15:00), muestra el
  botón "Ver días y horarios" (nunca "Solicitar turno"); si no (Rutter,
  hoy), muestra "Horarios próximamente" en vez de un botón que llevaría a
  un paso sin información real. El botón entra al mismo paso de DNI (mismo
  formulario, mismo Turnstile, mismo gateway) pero el destino final es
  distinto: si el DNI no existe, permite registrarse normalmente y
  después muestra el mensaje de modalidad; si el DNI ya existe, muestra el
  mensaje directamente, sin pedirle que se registre de nuevo. El mensaje
  final es siempre "Atención por orden de llegada." + día/horario (o
  "Horarios próximamente." si no están confirmados) + "No necesitás
  solicitar turno previamente." — **nunca** dice que el consultorio va a
  contactar para coordinar (esa modalidad no coordina turno; esa frase sólo
  aplica al flujo `con_turno`, que sí coordina).
- **`mixta`**: implementada (mismo esquema que `orden_llegada`: badge propio
  + botón condicionado a tener día/horario) pero sin ningún profesional
  real usándola todavía — no hay dato de la práctica que la ejercite hoy.

`visibleEnPortal` (booleano, hoy `true` en los 4) permite ocultar a futuro
un profesional puntual (por ejemplo, licencia temporal) sin borrar su
configuración ni tocar `portal.js` — ya tiene el filtro real implementado
en `renderProfesionalesPublicos`, sólo falta usarlo el día que haga falta.

Cambiar `modalidadAtencion` de un profesional (por ejemplo, pasar a Rogelio
de `'orden_llegada'` a `'con_turno'` el día que corresponda) alcanza para
que su tarjeta y su flujo se adapten solos — verificado en el navegador
monkeypatcheando el contenido en tiempo de ejecución, sin tocar
`portal.js` ni el HTML.

## Ergometría — divergencia frontend/backend, documentada

Se sacó `'Ergometría'` de `portal/contenido-publico.js` (cards, especialidades,
select de la solicitud). El backend (`supabase/functions/portal-gateway/index.ts`
→ `PRESTACIONES_PUBLICAS_V1`) **no se tocó**, por la restricción explícita de
esta tarea ("no modificar backend/gateway"), así que sigue aceptando
`'Ergometría'` si alguien la mandara directo a la API sin pasar por el
select. No es un problema de seguridad (nadie puede seleccionarla desde la
UI), pero es una inconsistencia real y documentada — ver
`tests/portal-gateway-logica.js` (dos tests nuevos la verifican
explícitamente) y el punto 10 de "Qué falta" más abajo.

## Estructura configurable creada

Todo centralizado en `portal/contenido-publico.js` (nada hardcodeado en
`portal.js`/HTML), con 3 áreas nuevas:

- `PROFESIONALES` — ahora 4 objetos (antes 1), cada uno con
  `prestaciones` (array), `diasAtencion`/`horarios` (nuevos, vacíos).
- `ESPECIALIDADES_COMPLEMENTARIAS` — `{ descripcion, items: [{ nombre,
  detalle, prestaciones }] }`. "Diagnóstico por imágenes" reutiliza el
  array real de prestaciones de Drago (mismo array, no una copia separada
  que se pueda desincronizar).
- `EQUIPAMIENTO` — `{ descripcion, items: [{ estudio, detalle }] }`. Sin
  marca/modelo (no existe ese dato en el repo): sólo el tipo de estudio
  real (Ecocardiografía, Holter, MAPA, ECG).
- `ESTUDIOS_PACIENTE` — `{ titulo, descripcion, disponible: false }`,
  preparado para el futuro "Mis estudios / Descargar informes" sin
  implementar nada todavía.
- `CONTACTO.email` — `'drm.anchorena@gmail.com'` (dato real entregado
  directamente para esta etapa, no encontrado en el repo antes).
- `IDENTIDAD.logoUrl` sigue siendo el único lugar que define el logo:
  cambiarlo ahí alcanza para reemplazarlo en toda la página.

## Brand kit aprobado — aplicación (post visual V1)

El dueño aprobó un brand kit de referencia (mockup) para "Dr Matías
Anchorena": paleta azul petróleo + turquesa (`#0b2d42 #0e4f63 #14b8c5
#6fd0da #e6f4f6`), tipografías sugeridas (Cinzel SemiBold para títulos,
Montserrat para cuerpo), y un set de piezas (logo horizontal, logo
vertical, isologo, versión sobre fondo oscuro, versión blanca/imprimible,
membrete, receta, encabezado de informe, avatar).

Aplicado en esta etapa:

- **Paleta**: `portal.css` adoptó la paleta real del brand kit
  (`--portal-primary: #0e4f63`, `--portal-primary-dark: #0b2d42`,
  `--portal-turquesa: #14b8c5`, más los claros/soft derivados). Se quitó el
  acento "cálido" (coral/terracota) que se había inventado en un paso
  anterior de este mismo trabajo, antes de tener el brand kit real — ya no
  correspondía una vez confirmada la identidad oficial (sólo petróleo +
  turquesa, sin acento aparte). El Admin (`styles.css`, `manifest.webmanifest`,
  `--primary: #123f56`) no se tocó: sigue con su color original, en la
  misma familia de azules pero sin ser idéntico.
- **Isologo**: se creó `portal/isologo.svg` (corazón + línea de ECG, con el
  degradé petróleo→turquesa del brand kit) como interpretación propia y
  simple del concepto de isologo del mockup — no una extracción literal del
  archivo de diseño (el mockup es una referencia visual, no un asset
  exportado). Se usa como favicon de `index.html`/`privacidad.html` y como
  logo del hero (`IDENTIDAD.logoUrl = 'isologo.svg'`), reemplazando el
  placeholder anterior (`../icons/icon-512.png`, el ícono de la PWA del
  Admin).
- **Pendiente real**: el "logo horizontal" completo del brand kit (isologo +
  nombre + tagline con tipografía propia, ej. la "A" estilizada con trazo de
  ECG) usa un diseño gráfico específico que no se puede reproducir
  fielmente a partir de un mockup — sigue pendiente el archivo exportado
  real (PNG/SVG) para reemplazar el isologo como logo principal. Las
  versiones oscura/blanca/imprimible del brand kit también quedan
  pendientes de archivo real para uso futuro en PDFs/documentos.
- **Datos NO copiados del mockup**: el brand board del mockup incluye datos
  de contacto ficticios de ejemplo (teléfono, email, web, dirección) — a
  propósito no se usó ninguno; `CONTACTO` sigue con únicamente el email real
  ya confirmado (`drm.anchorena@gmail.com`).

## Cambios visuales

- Hero: gradiente azul petróleo (claro→oscuro) con un detalle circular
  cálido muy sutil detrás del logo, tipografía más grande, sombra en el
  logo y en el botón.
- Cards: sombra suave + elevación al pasar el mouse (desktop), radios más
  grandes, tipografía con más peso.
- Encabezados de sección: barra vertical cálida a la izquierda (jerarquía
  visual, sin depender sólo del tamaño de fuente).
- Chips (`.portal-chip`) nuevos para mostrar prestaciones por profesional/
  especialidad de forma compacta.
- Desktop: `#portalRoot` pasa de 560px fijos a un layout de hasta 880px con
  grillas de hasta 3 columnas (antes quedaba angosto también en pantallas
  grandes).
- CTA final: ya no repite "SOLICITAR TURNO" — ahora es un link secundario
  "Conocé nuestras prestaciones" que baja a la sección de prestaciones
  (ancla `#prestaciones`, sin tocar el estado del flujo).
- Botón de alta: "DARME DE ALTA" → "QUIERO REGISTRARME COMO PACIENTE".

Verificado visualmente en el navegador (servidor local, ver más abajo),
incluida la corrección de profesionales: hero, prestaciones (sin
Ergometría), Matías/Rogelio/Drago Humberto con sus chips de prestaciones,
Rutter con su aviso "Más información, próximamente." (sin campos vacíos ni
inventados), "Drago Lucas" ausente, especialidades complementarias,
equipamiento, modalidad,
"Mis estudios" (aviso Próximamente), contacto (con el email real), CTA
final y footer — todo renderiza correctamente; el flujo DNI → alta/
ya-registrado se probó y sigue funcionando igual que antes.

## Qué falta aportar (no inventado, pendiente)

1. **Logo/wordmark real** — pendiente, no se cierra esta fase todavía: la
   fase sigue abierta a la espera del logo real (avisado explícitamente).
   `identidad.logoUrl` es el único lugar a cambiar cuando llegue.
2. **Rutter**: especialidad, matrícula, prestaciones, días/horarios, bio y
   foto — ninguno confirmado todavía (su modalidad de atención sí, ver
   arriba).
3. **Matías/Rogelio/Drago Humberto**: bio breve y foto de cada uno;
   matrícula de Rogelio y de Drago Humberto (Matías ya tiene la suya real).
   Días/horarios de Rogelio y Drago Humberto ya están confirmados (ver
   tabla arriba); **días/horarios de Rutter siguen sin confirmar** — es lo
   único que falta para que su tarjeta pase de "Horarios próximamente" al
   botón "Ver días y horarios" con su día/horario real — ver "Modalidad de
   atención por profesional" arriba.
4. Datos reales para Diabetología y Nutrición, y para Psiquiatría (hoy sin
   profesional nombrado ni prestaciones, por falta de dato real).
5. Marca/modelo del equipamiento, si se quiere mostrar ese nivel de detalle.
6. Resto de contacto: dirección, teléfono, WhatsApp, Instagram, mapa.
7. Decisión de diseño/implementación futura para "Mis estudios" (login de
   paciente, backend de informes) — hoy sólo un aviso, sin funcionalidad.
8. Backend: alinear `PRESTACIONES_PUBLICAS_V1` (quitar Ergometría) en un
   cambio de backend autorizado aparte — **pendiente separado**, documentado
   acá y con dos tests dedicados en `tests/portal-gateway-logica.js` que
   confirman la divergencia (frontend sin Ergometría, backend sin tocar).
9. Si en algún momento se confirma que "Drago Lucas" también atiende
   pacientes del consultorio, agregarlo con sus datos reales (matrícula,
   bio, foto, días/horarios) — su registro en `app.js` ya existe
   (`defaults.profesionales`, `id:'lucas_drago'`), sólo falta la
   confirmación explícita para usarlo acá.
10. **Backend, modalidad por profesional**: no hizo falta ningún cambio de
    backend para esto. El gateway (`portal-gateway`) ya no permite elegir
    profesional en ninguna acción (`check-dni`, `registro`,
    `solicitud-turno` son las tres profesional-agnósticas — ver
    `index.ts`/`logica.js`, y los dos tests de
    `tests/portal-gateway-logica.js` que lo confirman), así que tanto el
    flujo "con_turno" (reutiliza `check-dni`/`registro`/`solicitud-turno`
    tal cual ya existían) como el flujo "orden_llegada" (sólo usa
    `check-dni`/`registro`, nunca `solicitud-turno`) funcionan enteramente
    con el backend actual, sin tocarlo. Si en el futuro se necesitara que
    el propio backend supiera "para qué profesional" es una solicitud (por
    ejemplo, para que Secretaría vea el profesional elegido en el panel de
    solicitudes), eso sí requeriría un cambio de backend — pendiente
    separado, no implementado acá.

## Cómo probar en localhost

```bash
python3 -m http.server 4176
```
Abrir `http://127.0.0.1:4176/portal/` (sirve desde la raíz del repo o desde
`portal/` indistintamente: `isologo.svg` es local a la carpeta del portal).
Debe verse el badge **STAGING LOCAL**, el hero en azul petróleo con el
isologo (corazón + ECG) y su descripción institucional sin "Medicina
Intensiva", y 4 profesionales: Matías con el badge "Turnos programados"
(sin botón propio, el hero ya alcanza); Rogelio ("lunes a viernes · 14:30 a
19:30") y Drago Humberto ("martes y viernes · 09:00 a 15:00") con el badge
"Atención por orden de llegada" + botón "Ver días y horarios"; Rutter con
el mismo badge pero sin botón — muestra "Horarios próximamente" en su
lugar (sus días/horarios todavía no están confirmados). Las secciones
nuevas con acentos turquesa, y "Conocé nuestras prestaciones" en vez de un
segundo "SOLICITAR TURNO".

Para probar la modalidad: click en "SOLICITAR TURNO" (hero) con cualquier
DNI de prueba → sigue el flujo de siempre (alta/ya-registrado → elegir
prestación, y ahí sí se comunica que Secretaría va a contactar para
coordinar). Click en "Ver días y horarios" de Rogelio/Drago → mismo paso de
DNI, pero nunca ofrece "Solicitar turno" ni menciona que lo van a
contactar para coordinar (esa modalidad no coordina turno): si el DNI no
existe, permite registrarse y cierra con "Atención por orden de llegada." +
el día/horario real + "No necesitás solicitar turno previamente."; si ya
existe, muestra el mismo mensaje directamente. El resto del flujo de
DNI/alta/solicitud sigue igual que antes de esta tarea.

## Ajustes post-aprobación: Rutter no publicada + assets de marca reales

Dos correcciones puntuales sobre la lógica ya aprobada:

- **Rutter — `visibleEnPortal: false`**: decisión explícita del dueño para
  no publicar una tarjeta incompleta con sólo "Horarios próximamente".
  Rutter sigue totalmente configurada (nombre, modalidad confirmada) y
  lista para activarse con un solo cambio de valor
  (`visibleEnPortal: true`) apenas se confirmen sus días/horarios — sin
  tocar código. `renderProfesionalesPublicos()` ya filtra por este campo
  para los 4 profesionales, así que cualquiera de ellos puede ocultarse/
  mostrarse de la misma forma en el futuro.
- **Logos/fotos reales, estructura preparada**: se creó
  `portal/assets/branding/` y `portal/assets/profesionales/` (con un
  `README.md` que documenta nombre de archivo, carpeta y valor de
  configuración exacto para cada logo/foto pendiente). `IDENTIDAD` pasa de
  un único `logoUrl` a `logoPrincipal`/`logoOscuro`/`logoClaro`/`isologo`
  (los tres primeros vacíos: archivos reales todavía no entregados).
  `isologo.svg` se movió a `assets/branding/isologo.svg` — sigue siendo el
  mismo fallback provisional de siempre (corazón + ECG en código), nunca el
  isologo real. El hero prioriza `logoOscuro` → `logoPrincipal` →
  `isologo`; sólo el fallback lleva el recuadro blanco
  (`.portal-logo-fallback` en CSS), porque un logo real pensado para fondo
  oscuro no lo necesita. Cada profesional suma `logoUrl` (logo personal,
  vacío en los 4 hoy); la tarjeta prioriza `fotoUrl` → `logoUrl` →
  iniciales. Ver [portal/assets/README.md](../portal/assets/README.md)
  para el detalle completo de qué archivo copiar y dónde.

## Rediseño de composición: header + hero en dos columnas

A partir de un mockup de referencia (aportado por el dueño, con datos
ficticios que **no se copiaron** — sólo se tomó la composición/estética),
se reestructuró el header y el hero. Mantiene la paleta petróleo/turquesa y
toda la lógica funcional/modalidad ya aprobada; sólo cambia la
composición visual.

- **Header nuevo** (`renderHeader()`): logo + nombre a la izquierda, nav
  ("Inicio", "Estudios", "Profesionales", "Información" — anclas a
  secciones que ya existían, ninguna nueva) y un CTA "Solicitar turno" que
  ancla a la card de DNI del hero (`href="#hero-turno"`, sin JS propio).
  Comparte tono oscuro con el hero (sin costura visible entre los dos).
  Nav oculta debajo de 1040px (tablet/mobile): sólo logo + CTA, para que
  quepan sin desbordar (se ajustó el breakpoint después de detectar que a
  768px el CTA quedaba cortado).
- **Hero en dos columnas** (`renderHero()` + `.portal-hero-grid`, ≥900px):
  izquierda con el mensaje institucional, 3 "beneficios" (íconos + texto
  genérico, no clínico — sin inventar claims de calidad/tecnología: sólo
  describen el sistema real de modalidad/especialidades/solicitud online
  ya aprobado) y una caja "¿Cómo funciona?"; derecha con la card blanca de
  DNI. En mobile se apila en el mismo orden del DOM: mensaje → beneficios →
  cómo funciona → card de DNI → resto de la página — sin CSS de
  reordenamiento.
- **La card de DNI es el formulario real, embebido** (`renderFormularioDni()`,
  reutilizado también por `renderPasoDni()` dentro del flujo): no es una
  maqueta decorativa. Al enviarlo, `onSubmitDni()` pasa `estado.vista` a
  `'flujo'` de entrada (antes de validar/llamar al gateway), así que
  loading/error/resultado siempre aparecen en el mismo contenedor de
  siempre (`renderFlujo()`), sin duplicar esa UI en el hero. El botón
  "SOLICITAR TURNO" del hero (con `data-portal-accion="ir-solicitud"`) se
  eliminó — ya no hace falta como paso intermedio —, pero
  `irASolicitud()`/`ir-solicitud` siguen existiendo para "ya-registrado" y
  "alta-exitosa" (saltar directo a elegir prestación), sin cambios de
  comportamiento ahí. Los turnos públicos siguen siendo sólo para Matías:
  el formulario sigue siendo el mismo genérico de siempre, sin selector de
  profesional.
- **`#portalRoot`** pasa de 880px a 1120px de ancho máximo en desktop
  (≥860px) — mejor aprovechamiento horizontal en toda la página, no sólo
  el hero.
- **Equipamiento** ahora se muestra como chips (`.portal-equipo-chips`) en
  vez de una lista vertical — mismo dato, menos altura, menos sensación de
  bloques apilados.
- **Footer** con fondo petróleo oscuro y el nombre real del consultorio;
  sigue sin teléfono/dirección/redes (esos datos del mockup son ficticios,
  no se copiaron — sólo el email real ya confirmado sigue en Contacto).

Verificado en el navegador: desktop (1280px), tablet (768px, tras corregir
el breakpoint del nav) y mobile (375px) — sin scroll horizontal en
ninguno. Flujo funcional reprobado end-to-end después del rediseño:
Matías (DNI nuevo → alta → SOLICITAR TURNO/FINALIZAR) y Rogelio (DNI
existente vía "Ver días y horarios" → mensaje de modalidad exacto, sin
mención de coordinar) — ambos iguales a como funcionaban antes de tocar el
CSS/HTML.

## Branding real: isologo + logo de Rogelio activados

Cierre de branding de Portal Visual V1 (layout/flujos sin tocar, según lo
pedido):

- **Regla de render por profesional** (`renderAvatarProfesional()`,
  genérica, sin ifs por nombre): `fotoUrl` → foto circular (72px, `cover`)
  → si no hay foto pero sí `logoUrl` → el logo **completo**, sin recortar
  ni deformar (`object-fit: contain`), en una caja rectangular de ancho
  completo con fondo neutro → si no hay ninguno, iniciales. Se agregó
  porque un logo con texto (nombre/especialidad/matrícula) se vuelve
  ilegible forzado dentro del círculo de foto de 72px.
- **`IDENTIDAD.isologo`** activado: `assets/branding/isologo.png` (el
  archivo real del brand kit, corazón + ECG sin texto) — reemplaza al
  fallback provisional (`isologo.svg`, construido en código). El header
  institucional lo usa junto con "Consultorio Médico RM" en HTML/CSS; no
  hace falta el logo horizontal maestro para cerrar esta etapa —
  `logoPrincipal`/`logoOscuro`/`logoClaro` quedan vacíos a propósito
  (decisión de alcance, documentada en `portal/assets/README.md`).
- **Bug encontrado y corregido en la misma pasada**: `.portal-header-logo`
  usaba `object-fit: cover`, pensado para el isologo SVG (cuadrado). El
  isologo PNG real es más alto que ancho (234×354) — con `cover` se
  recortaba. Se cambió a `object-fit: contain` (la caja ya tiene fondo
  blanco propio, así que el espacio libre alrededor no se nota).
- **`PROFESIONALES[Rogelio].logoUrl`** activado:
  `assets/profesionales/rogelio-anchorena.png` (su logo personal real,
  fondo oscuro propio, usado tal cual — no se reinterpretó ni recortó).
  Verificado en el navegador (desktop y mobile): se ve completo, legible,
  sin deformación.
- **Matías, resuelto**: el archivo `matias-anchorena.png` es la versión
  **#4 (fondo oscuro)** del brand kit — no la #2 (vertical/apilada) pedida
  originalmente, pero confirmada explícitamente por el dueño como la
  definitiva para este uso, igual tratamiento que la de Rogelio (logo
  completo, sin recortar, en su propia caja).
  `PROFESIONALES[Matías].logoUrl = 'assets/profesionales/matias-anchorena.png'`
  activo. **Actualización**: el dueño reemplazó `isologo.png` y
  `matias-anchorena.png` por exports limpios (fondo transparente, sin el
  rótulo del panel del mockup que traían las primeras versions) —
  confirmado visualmente ampliando ambos archivos a 300-400px en el
  navegador. Branding real cerrado: isologo, logo de Matías y logo de
  Rogelio, todos limpios.
- **Favicon** actualizado en `index.html`/`privacidad.html` a
  `assets/branding/isologo.png` (`type="image/png"`, antes apuntaba al
  `.svg` fallback).

## Bug encontrado y corregido: condición de carrera en Turnstile

Reportado por el dueño probando en su propio navegador (no reproducible de
entrada en el sandbox de pruebas, que carga todo desde caché local sin
latencia real): al ingresar el DNI aparecía "No se pudo cargar la
verificación anti-bots." de forma consistente.

**Causa raíz**: el script de Cloudflare se carga con `async` en
`index.html` — no bloquea el resto de la página, y puede terminar de
cargar en cualquier momento respecto al resto de los scripts.
`montarTurnstileSiCorresponde()` (`portal.js`) se llama al final de cada
`render()` y, si `window.turnstile` todavía no existe en ese momento, se
rendía: dejaba `turnstileWidget.widgetId` en `null` **para siempre**, sin
reintentar. Antes del rediseño del hero esto no importaba — el primer
contenedor de Turnstile recién aparecía cuando el usuario hacía click en
"SOLICITAR TURNO", segundos después de cargar la página, tiempo de sobra
para que el script ya hubiera cargado. Con el hero nuevo, el formulario de
DNI (con su contenedor de Turnstile) se renderiza en el primerísimo
`render()` de la página — compitiendo de verdad contra la carga async del
script, y perdiendo esa carrera con más facilidad cuanto mayor la latencia
real de red (por eso no se reproducía fácil en el sandbox, con todo
cacheado localmente).

**Corrección** (`portal/portal.js`, `montarTurnstileSiCorresponde()` +
nueva función `reintentarMontajeTurnstile()`): si Turnstile no está
disponible al montar, en vez de rendirse se programa un reintento cada
250ms, hasta 40 intentos (~10s de margen). Cada reintento vuelve a
consultar el contenedor vigente en el DOM (nunca uno viejo) y aborta solo
si mientras tanto otro `render()` ya montó un widget con éxito
(`turnstileWidget.widgetId !== null`), evitando montajes duplicados. No se
tocó el gateway, los secrets, la sitekey ni ningún bypass — es
exclusivamente un fix de timing en el frontend.

**Verificado el fix de verdad** (no sólo el camino feliz): se simuló la
condición de carrera borrando `window.turnstile` antes de un envío
(reproduciendo el contenedor vacío, sin widget, igual que el bug
reportado) y luego restaurándolo — el reintento lo detectó y montó el
widget solo, sin recargar la página. Con el fix confirmado, se volvió a
correr el flujo completo: Matías (DNI nuevo → alta → solicitud → enviado)
y Rogelio (DNI nuevo → alta → orden de llegada con día/horario exacto),
"Volver al inicio" entre medio para confirmar que el widget se remonta
cada vez, en desktop y mobile.
