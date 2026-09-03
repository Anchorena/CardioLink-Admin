# Carga de Turno V1

Este bloque reorganiza visualmente la pantalla **Carga de turno/atención** (`#carga` en
`index.html`) y agrega los campos necesarios para que la atención capture, desde el
momento de la carga, la información que los próximos bloques (HC, estudios/informes,
estadísticas) van a necesitar — **sin implementar todavía esas integraciones**.

## Qué cambió

- Reordenamiento visual del formulario en 5 zonas conceptuales: Paciente → Turno/atención →
  Información para el profesional → Información administrativa → Guardar. Mismos `id`,
  mismos handlers, solo reordenados en el DOM (los bindings de `app.js` son todos por
  `id`, no por posición, así que el reorden es visual únicamente).
- Campos nuevos en `#formAtencion`:
  - `#sexo` (select: Masculino/Femenino/Otro) — dato demográfico del paciente.
  - `#edadCalculada` (input readonly) — se recalcula solo a partir de `#fechaNacimiento`,
    nunca se tipea ni se guarda como campo independiente.
  - `#derivante` (input con `<datalist id="derivantesList">`) — profesional derivante.
  - `#motivoConsulta` (input con `<datalist id="motivosList">`) — motivo de consulta/estudio.
  - `#observacionClinica` (textarea) — observación clínica relevante, separada de
    `#observaciones` (que pasó a llamarse "Observaciones administrativas" en la UI para
    dejar la distinción explícita).
- Validación nueva en `guardarAtencion()`: Sexo y Fecha de nacimiento son obligatorios
  para guardar el turno, tanto para paciente nuevo como para paciente existente con la
  ficha incompleta (no se inventan valores; si faltan, se pide completarlos).
- Catálogos nuevos y persistentes: `data.medicosDerivantes` y `data.motivosConsulta`
  (arrays de string, mismo mecanismo de persistencia que `data.obrasSociales`/
  `data.colocadores` — `saveConfig()`, sin tabla nueva de Supabase). Se completan solos:
  cualquier valor nuevo tipeado en Derivante/Motivo al guardar un turno queda agregado al
  catálogo para las próximas cargas (deduplicado con `normalizarTexto()`, ya existente).

## Dónde vive cada dato

Todo esto queda en el objeto `atencion` (el mismo array `atenciones`, sin tabla ni schema
nuevo), armado en `crearAtencionDesdeFormulario()` (`app.js`):

| Campo en `atencion` | Origen | Persiste también en `paciente`? |
|---|---|---|
| `a.sexo` | `#sexo` | Sí, `p.sexo` (mismo criterio que `a.fechaNacimiento`/`p.fechaNacimiento`) |
| `a.fechaNacimiento` | `#fechaNacimiento` | Sí (ya existía) |
| `a.derivante` | `#derivante` | No — es del episodio, no de la ficha permanente |
| `a.motivoConsulta` | `#motivoConsulta` | No — ídem |
| `a.observacionClinica` | `#observacionClinica` | No — ídem |

La edad **no se guarda** en ningún lado: se recalcula siempre a partir de
`fechaNacimiento` (en Carga de turno vía `edadDesdeFechaCarga()`, la misma idea que ya
usan `edadDesdeFecha409()` en Pacientes, `ageHC()` en Historia Clínica y
`edadPendiente383()` en Pendientes — cuatro funciones locales equivalentes, sin
refactorizar a una sola en este bloque, tal como se pidió).

## Cómo reutilizar esto en los próximos bloques (todavía NO implementado)

### A. Evolución/HC de esa atención
Cuando se abra una evolución clínica (`data.evolucionesClinicas`, módulo HC) **vinculada
a un `atencionId`**, el modal de evolución puede precargar:
- `hcMotivo` ← `atencion.motivoConsulta` (si está vacío, no si ya hay uno tipeado)
- un renglón informativo con `atencion.derivante` (derivante que originó la consulta)
- un renglón informativo con `atencion.observacionClinica`

No hace falta pedirle estos datos de nuevo al profesional: la atención ya es la fuente.

### B. Estudios/informes vinculados
Al generar/imprimir un informe de estudio (ligado a una `atencion` con
`estudioInformado`/`estudioImpreso`/etc.), el documento puede mostrar:
- Derivado por: `atencion.derivante`
- Motivo: `atencion.motivoConsulta`
- Observación clínica relevante para interpretar el estudio: `atencion.observacionClinica`

### C. Estadísticas
Con `atencion.sexo`, `atencion.derivante` y `atencion.motivoConsulta` ya en cada
registro, un futuro bloque de estadísticas puede agrupar/contar por esos tres ejes
directamente sobre `atenciones`, sin joins contra la ficha del paciente ni un catálogo
aparte — la atención es la fuente del episodio.

**Regla para cuando se implemente A/B/C:** leer estos campos desde la `atencion`
correspondiente, no duplicarlos manualmente tipeándolos de nuevo en cada módulo.
