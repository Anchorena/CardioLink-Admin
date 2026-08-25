# Portal Público — assets de marca y profesionales

Carpetas para los archivos de imagen **reales** del portal público. Nada acá
se genera con código (SVG/CSS): son archivos que hay que copiar.

## portal/assets/branding/

Del brand kit aprobado (azul petróleo `#0b2d42`/`#0e4f63` + turquesa
`#14b8c5`). Copiar el archivo real con exactamente este nombre para que
`contenido-publico.js` lo levante sin tocar código:

| Archivo a copiar | Ruta | Valor en `IDENTIDAD` (`contenido-publico.js`) |
|---|---|---|
| Isologo institucional (corazón + ECG, sin texto) | `portal/assets/branding/isologo.png` | `isologo: 'assets/branding/isologo.png'` |
| Logo horizontal (isologo + nombre + tagline) | `portal/assets/branding/logo-horizontal.svg` (o `.png`) | `logoPrincipal` |
| Logo horizontal, versión para fondo oscuro | `portal/assets/branding/logo-horizontal-oscuro.svg` | `logoOscuro` |
| Logo horizontal, versión blanca/imprimible | `portal/assets/branding/logo-horizontal-blanco.svg` | `logoClaro` |

**Decisión vigente (cierre de Portal Visual V1)**: el header institucional
resuelve con `[isologo] Consultorio Médico RM` en HTML/CSS — no hace falta
un logo horizontal maestro para cerrar esta etapa. `logoPrincipal`,
`logoOscuro` y `logoClaro` quedan **vacíos a propósito** (no son "falta
archivo", es una decisión de alcance) hasta que exista el brand kit
horizontal final / se necesiten para documentos-PDF. El logo personal de
Matías (`assets/profesionales/matias-anchorena.png`) NO se usa como marca
institucional general — sólo en su propia tarjeta de profesional.

Hasta que `isologo.png` se copie acá, sigue activo `isologo.svg` (el
fallback provisional: una interpretación propia, corazón + ECG, construida
en código — no el isologo oficial). Apenas se complete `isologo.png` y se
actualice `IDENTIDAD.isologo`, ese fallback deja de usarse.

**Prioridad de uso** (definida en `portal.js`, no hay que tocar código para
que un archivo nuevo entre en uso — sólo copiarlo acá y completar la ruta
en `contenido-publico.js`):
`logoOscuro` (en el hero, fondo oscuro) → `logoPrincipal` → `isologo`
(fallback final).

## portal/assets/profesionales/

Fotos/logos personales de cada profesional. Nombre sugerido (uno por
profesional, cualquier extensión de imagen real):

| Profesional | Foto (`fotoUrl`) | Logo personal (`logoUrl`) |
|---|---|---|
| Dr. Matías Anchorena | pendiente | ✅ `matias-anchorena.png` — cargado y activo |
| Dr. Rogelio Anchorena | pendiente | ✅ `rogelio-anchorena.png` — cargado y activo |
| Dr. Fernández Drago Humberto | pendiente | — |
| Dra. Rutter | pendiente | — |

**Matías, resuelto**: el archivo entregado para `matias-anchorena.png` es
la versión **#4 (fondo oscuro)** del brand kit — no la #2 (vertical/
apilada) pedida originalmente, pero confirmada explícitamente por el dueño
como la definitiva para este uso. El archivo real todavía trae el rótulo
del panel del mockup ("4. Versión para fondo oscuro") en la esquina —
visible en la tarjeta; para sacarlo hace falta un recorte/export limpio
del mismo archivo, no un cambio de código.

Todos van en `portal/assets/profesionales/`. Config: `fotoUrl:
'assets/profesionales/<archivo>'` / `logoUrl: 'assets/profesionales/<archivo>'`.

**Regla de render en la tarjeta** (`renderAvatarProfesional()` en
`portal.js`, genérica para cualquier profesional futuro — nada hardcodeado
por nombre):

1. Si hay `fotoUrl` → foto circular, tamaño avatar (72px, recortada con
   `object-fit: cover`). Pensado para una cara.
2. Si NO hay `fotoUrl` pero sí `logoUrl` → el logo **completo**, sin
   recortar ni deformar (`object-fit: contain`), en una caja rectangular
   propia de ancho completo con fondo neutro. Nunca se fuerza un logo con
   texto (nombre/especialidad/matrícula) dentro del círculo de foto: se
   volvería ilegible.
3. Si no hay ninguno de los dos → iniciales (avatar circular con la
   primera letra del nombre) — el fallback de siempre, nunca una foto/logo
   inventados.

Decidido: Matías y Rogelio van a usar `logoUrl` (rama 2) apenas se copien
sus archivos reales acá y se complete la ruta en `contenido-publico.js`
(ver [PORTAL_PUBLICO_VISUAL_V1.md](../../docs/PORTAL_PUBLICO_VISUAL_V1.md)
para el estado exacto). Drago Humberto y Rutter siguen sin foto ni logo
(rama 3, iniciales) hasta que se confirme alguno.

## Cómo activar un archivo real

1. Copiar el archivo con el nombre de la tabla en la carpeta indicada.
2. Completar la ruta correspondiente en `portal/contenido-publico.js`
   (`IDENTIDAD` o el objeto del profesional en `PROFESIONALES`).
3. Nada más: `portal.js` no necesita ningún cambio — ya prioriza estos
   campos en el orden de arriba.
