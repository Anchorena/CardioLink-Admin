# CardioLink — Auditoría y backfill de `cardiolink_pacientes`

Última actualización: 2026-08-25. Estado: **auditoría cerrada (v2), migración
redactada, NADA ejecutado todavía** (ni SQL, ni deploy, ni commit).

> **v2 — reemplaza el análisis anterior (2026-08-24).** Una auditoría de
> Producción más profunda encontró que la fuente histórica real **no son**
> las filas individuales de `cardiolink_atenciones`, sino un único array
> embebido en la fila técnica de config (`payload->'config'->'pacientes'`).
> El análisis anterior, basado en atenciones sueltas, sólo llegaba a 186 DNI
> distintos — un subconjunto parcial — y su migración **nunca se ejecutó**.
> Este documento y la migración asociada se reconstruyeron desde cero sobre
> la fuente correcta. Ver sección 3 y 6.

## 1. Síntoma reportado

Un paciente ya existente en CardioLink podía ser enviado por el Portal
Público al formulario de alta ("no encontramos tu DNI"), aunque el portal
consulta correctamente `cardiolink_pacientes.dni_normalizado`
([index.ts:143-152](../supabase/functions/portal-gateway/index.ts)).

## 2. Causa raíz confirmada

No es un bug del portal. Es una brecha entre el modelo histórico de
CardioLink Admin y la tabla relacional nueva: **la mayoría de las altas de
pacientes en el Admin nunca escriben en `cardiolink_pacientes`**, sólo en
el modelo histórico local (`data.pacientes`, persistido dentro de
`cardiolink_atenciones` — ver sección 3).

Tres funciones dan de alta o editan un paciente en el Admin, y ninguna
sincronizaba a la tabla relacional (**ya corregido en esta etapa**, ver
sección 10):

| Función | Ubicación | Cuándo se dispara | ¿Escribía en `cardiolink_pacientes`? |
|---|---|---|---|
| `upsertPacienteDesdeCarga()` | [app.js:1765](../app.js) | Al guardar **cualquier turno/atención nuevo** — el camino más común de alta | ❌ Sólo `saveConfig()` |
| `guardarPacientePanel()` | [app.js:3487](../app.js) | Editar ficha desde el panel de Pacientes | ❌ Sólo `saveConfig()`+`saveAtenciones()` |
| `guardarPacienteGlobal350()` | [app.js:6205](../app.js) | Editar ficha global (incluye observaciones administrativas) | ❌ Sólo `saveConfig()`+`saveAtenciones()` |

La única función que ya escribía en `cardiolink_pacientes` es
`sincronizarPacienteCompleto410()` ([app.js:9763](../app.js)), y se dispara
**sólo** desde dos lugares dentro de Historia Clínica — acceso exclusivo
de Médico, nunca de Secretaría:

- [app.js:8263](../app.js) — al guardar una evolución clínica (`saveEvolutionHC`).
- [app.js:8282](../app.js) — al guardar el resumen clínico.

Como Secretaría (quien da de alta a la mayoría de los pacientes vía turno)
no tenía acceso a HC, un paciente sólo llegaba a `cardiolink_pacientes` si,
además, algún médico le registró una evolución alguna vez. Con 29
pacientes en la tabla relacional sobre 838 DNI históricos válidos, eso es
exactamente lo que se observa.

## 3. Estructura histórica (fuente real: `config.pacientes`)

- **`cardiolink_atenciones`**: tabla genérica `(id text, payload jsonb,
  updated_at timestamptz)`. La inmensa mayoría de las filas son turnos
  individuales serializados, pero **una única fila especial**
  (`id = '__cardiolink_config_v1'`, ver `CONFIG_ROW_ID` en
  [app.js:5092](../app.js)) guarda **todo** el objeto `data` local del
  cliente — incluido `data.pacientes`, serializado en
  `payload->'config'->'pacientes'` ([app.js:5337-5419](../app.js),
  `guardarConfigEnSupabase298()`).
- **Esta fila de config, y específicamente `payload->'config'->'pacientes'`,
  es la fuente maestra real de pacientes históricos** — no las atenciones
  sueltas. En Producción contiene **847** objetos de paciente.
- Cada objeto de `config.pacientes` es una ficha administrativa real
  (creada desde el panel de Pacientes), no un derivado de una atención
  puntual — de ahí que traiga campos que una atención individual no tiene:
  `sexo`, `localidad`, `dirección`, `provincia`, contacto de emergencia.
- **`pacientesDesdeAtenciones()`** ([app.js:1683](../app.js)): reconstruye
  pseudo-pacientes derivados de cada atención suelta; es una vista de UI en
  memoria (id `legacy_<clave>` si no hay `pacienteId`), nunca escribe a
  Supabase y **no es la fuente de este backfill** — se documenta acá sólo
  como contexto arquitectónico, ya que fue el punto de partida del análisis
  v1 (descartado).
- `observacionesAdministrativas` **sí existe** dentro de cada objeto de
  `config.pacientes`, pero **no se migra en esta etapa** (ver sección 4) —
  el dato queda intacto donde ya está, no se pierde ni se toca.

## 4. Campos recuperables y mapeo a columnas

Mapeo confirmado entre `config.pacientes[i]` (JSON) y
`cardiolink_pacientes` (columna real):

| Campo en `config.pacientes[i]` | Columna destino | Notas |
|---|---|---|
| `id` | — (usado sólo para decidir `id` a insertar, ver sección 6) | |
| `nombreCompleto` | `nombre_completo` | nullable, no se asume presente |
| `dni` | `dni` / `dni_normalizado` (generada) | normalizado a sólo dígitos |
| `telefono` | `telefono` | |
| `email` | `email` | |
| `fechaNacimiento` | `fecha_nacimiento` | parseo seguro, ver sección 7 |
| `sexo` | `sexo` | |
| `localidad` | `localidad` | |
| `direccion` | `direccion` | |
| `provincia` | `provincia` | |
| `coberturaHabitual` (fallback `obraSocial`/`cobertura`) | `cobertura_habitual` | alias legacy de versiones viejas del array |
| `numeroAfiliadoHabitual` | `numero_afiliado_habitual` | |
| `contactoResponsableNombre` | `contacto_responsable_nombre` | |
| `contactoResponsableRelacion` | `contacto_responsable_relacion` | |
| `contactoResponsableTelefono` | `contacto_responsable_telefono` | |
| `contactoResponsableEmail` | `contacto_responsable_email` | |
| `actualizadoEn` / `creadoEn` | — (sólo desempate entre duplicados, no se inserta) | ver sección 7 |
| `observacionesAdministrativas` | **no se migra** | columna no existe en `cardiolink_pacientes`; dato queda en `config.pacientes`, intacto |

## 5. Esquema real confirmado de `cardiolink_pacientes`

```
id                              text PK
nombre_completo                 text nullable
dni                              text nullable
telefono                        text nullable
email                            text nullable
fecha_nacimiento                date nullable
sexo                             text nullable
localidad                       text nullable
direccion                       text nullable
provincia                       text nullable
cobertura_habitual              text nullable
numero_afiliado_habitual        text nullable
contacto_responsable_nombre     text nullable
contacto_responsable_relacion   text nullable
contacto_responsable_telefono   text nullable
contacto_responsable_email      text nullable
activo                           boolean
creado_en                       timestamptz
actualizado_en                  timestamptz
dni_normalizado                 text GENERATED (sólo dígitos de `dni`)
```

`nombre_completo` es **nullable**: la migración no asume que siempre haya
nombre.

FKs reales confirmadas:

- `cardiolink_hc_resumen.paciente_id` → `cardiolink_pacientes.id`
- `cardiolink_hc_evoluciones.paciente_id` → `cardiolink_pacientes.id`
- `cardiolink_appointment_requests.patient_id` → `cardiolink_pacientes.id`
  (FK real a nivel Postgres, ver
  [20260819180000_cardiolink_appointment_requests_schema.sql:27-28](../supabase/migrations/20260819180000_cardiolink_appointment_requests_schema.sql))

## 6. Reporte read-only real de Producción (v2, aportado por el dueño)

- Objetos totales en `config.pacientes`: **847**
- DNI válidos (6-9 dígitos) distintos: **838**
- Ya existentes en `cardiolink_pacientes`: **29**
- Candidatos (DNI válido, no existente todavía): **809**

### IDs históricos entre los 809 candidatos

- **803** tienen exactamente UN `id` histórico → se **preserva** ese id tal
  cual, no se genera uno nuevo → **insertables automáticamente**.
- **6** tienen MÁS DE UN `id` histórico distinto (entradas del mismo DNI
  vinculadas con el tiempo a dos `id` distintos, probablemente por una
  fusión o corrección manual incompleta) → **no se insertan
  automáticamente**. Quedan clasificados `conflicto_id_multiple`, para
  revisión manual antes de decidir qué id es el correcto.
- **0** candidatos sin ningún `id` histórico en este dataset (se mantiene
  el fallback de generación de id por si se reutiliza esta migración con
  otro dataset).
- Ningún `id` histórico colisiona con un `id` ya existente en
  `cardiolink_pacientes` (`conflicto_id_colision` esperado: 0 — se
  mantiene la verificación igual, por seguridad ante datos que cambien
  entre esta auditoría y la corrida real).

**Resultado esperado:** `cardiolink_pacientes` pasa de 29 a **~832** filas
(29 + 803).

### Fechas

Auditoría de fechas sobre el dataset real: **0** `fechaNacimiento`
inválidas encontradas. Se mantiene igualmente la función de parseo seguro
(sección 7) por seguridad y reusabilidad — el dataset puede cambiar antes
de que esta migración se ejecute.

### Duplicados del mismo DNI dentro de `config.pacientes`

847 objetos totales → 838 DNI válidos distintos implica que existen filas
duplicadas de la misma persona dentro del array (mismo DNI, más de un
objeto). El criterio de desempate: por completitud de datos (más campos
con valor real) y, en empate, por el timestamp propio del paciente
(`actualizadoEn`, con fallback a `creadoEn`) — nunca por
`cardiolink_atenciones.updated_at`, que es idéntico para los 847 pacientes
porque todos viven en la misma fila técnica de config. Ver sección 7.

## 7. Fechas y timestamps: por qué no se puede castear directo

`fechaNacimiento` histórica mal formada (ej. `19988-12-09`, año con un
dígito de más) matchea el patrón `YYYY-MM-DD` y Postgres **sí puede
castearlo como `date`** sin lanzar error (el tipo `date` admite años hasta
5874897) — un cast directo con regex simple no lo detecta como inválido.
Por eso la migración usa una función auxiliar
(`public.cardiolink_backfill_intentar_fecha`, creada y **eliminada dentro
de la misma migración** — no queda como objeto permanente) que:

1. Descarta valores vacíos o que no empiecen con `YYYY-MM-DD`.
2. Intenta el cast dentro de un bloque `BEGIN/EXCEPTION`: cualquier fecha
   con forma válida pero calendario imposible (`2023-02-30`) devuelve
   `NULL` en vez de abortar la transacción.
3. Aplica un rango razonable (`1900-01-01` a la fecha actual): descarta
   años absurdos como `19988` que un cast directo aceptaría sin error.

Si `fecha_nacimiento` no puede recuperarse de forma segura, la migración
la deja `NULL` — nunca inventa ni fuerza un valor, y nunca hace fallar el
resto del backfill por una sola fila con fecha rota. Esto no excluye al
paciente del backfill: sólo esa columna queda `NULL`.

Para desempatar entre objetos duplicados del mismo DNI (ver sección 6), la
migración usa una segunda función auxiliar del mismo estilo
(`public.cardiolink_backfill_intentar_timestamp`, también temporal) sobre
`actualizadoEn`/`creadoEn` — texto libre, mismo riesgo de formato que la
fecha de nacimiento, nunca casteado directo. Este timestamp **sólo se usa
para ordenar candidatos dentro de la migración**; nunca se inserta en
`cardiolink_pacientes` (`creado_en`/`actualizado_en` del INSERT usan
`now()`, igual que el resto de la migración).

## 8. Estrategia de backfill

Ver migración completa en
[`supabase/migrations/20260824190000_cardiolink_pacientes_backfill_historico.sql`](../supabase/migrations/20260824190000_cardiolink_pacientes_backfill_historico.sql)
(redactada, **no ejecutada**).

Resumen:

1. Lee `payload->'config'->'pacientes'` de la única fila
   `id = '__cardiolink_config_v1'` y la desanida con
   `jsonb_array_elements` — no toca ninguna otra fila de
   `cardiolink_atenciones`.
2. Filtra por DNI válido (6-9 dígitos tras normalizar).
3. Por DNI, cuenta `id` históricos distintos no vacíos → determina si se
   preserva un id existente, se genera uno nuevo, o el DNI va a
   `conflicto_id_multiple`.
4. Por DNI, elige el objeto "más completo" (más campos con dato real) y,
   en empate, el más reciente por `actualizadoEn`/`creadoEn` propios del
   paciente — de ahí salen nombre/teléfono/email/fecha de
   nacimiento/sexo/localidad/dirección/provincia/cobertura/afiliado/
   contacto de emergencia a insertar.
5. Clasifica cada DNI: `ya_existe` / `conflicto_id_multiple` /
   `conflicto_id_colision` / `candidato`.
6. Materializa la clasificación en tablas temporales (`on commit drop`, no
   persisten) y las muestra como reporte antes de insertar, con las
   categorías exactas: `total_fuente`, `dni_validos_distintos`,
   `ya_existentes`, `candidatos`, `insertables_automaticos`,
   `conflicto_id_multiple`, `conflicto_id_colision`, `fecha_invalida`.
7. Inserta **únicamente** las filas `candidato` — idempotente: correrla
   dos veces no duplica nada, porque la segunda vez todos esos DNI ya
   existen (clasifican `ya_existe`).
8. Nunca toca una fila ya existente en `cardiolink_pacientes`: no hay
   ningún `UPDATE` en la migración, sólo `INSERT` sobre DNI ausentes.

## 9. Impacto sobre HC / FKs

- Los 803 candidatos con id histórico único preservado quedan
  **exactamente** compatibles con
  `cardiolink_hc_resumen`/`cardiolink_hc_evoluciones`/
  `cardiolink_appointment_requests` si esas filas ya referenciaban ese
  `id` desde algún otro lugar — no hay nada que reconciliar ahí porque el
  id no cambia.
- Para candidatos sin id histórico (0 esperados, fallback reusable), se
  genera un id nuevo con el mismo prefijo `pac_` que ya usan tanto el
  Admin (`key410()`, [app.js:9652](../app.js)) como el gateway
  (`generarIdPaciente`, [logica.js:134](../supabase/functions/portal-gateway/logica.js)).
  Si más adelante un médico abre la HC de uno de estos pacientes, la
  próxima sincronización (`cargar410()` → `mergePaciente410()`,
  [app.js:9790](../app.js)) adopta ese id automáticamente en el cliente,
  sin duplicar — no hace falta ningún cambio de código para esa
  reconciliación, ya funciona así hoy.
- Los 6 DNI en `conflicto_id_multiple` no se tocan en absoluto: siguen
  exactamente como están hoy hasta que alguien decida a mano cuál de sus
  `id` históricos es el correcto.

## 10. Altas futuras: cómo se garantizan (ya implementado en esta etapa)

Se agregó una función nueva y más acotada,
`sincronizarFichaPacienteBasica410()` ([app.js:9750](../app.js)), en vez de
reutilizar `sincronizarPacienteCompleto410()` directamente: esta última
también escribe en `cardiolink_hc_resumen`/`cardiolink_hc_evoluciones`, y
los 3 puntos de alta nuevos son alcanzables por Secretaría — no conviene
arriesgar una escritura a tablas clínicas desde un flujo no clínico, sin
importar qué datos pueda tener cacheados localmente esa sesión.
`sincronizarFichaPacienteBasica410()` sólo hace upsert en
`cardiolink_pacientes`, nunca toca las tablas de HC.

```js
try{
  window.cardiolinkClinica410?.sincronizarFichaBasica?.(p)
    ?.catch?.(e=>console.warn('No se pudo sincronizar la capa clínica relacional:',e));
}catch(e){
  console.warn('No se pudo sincronizar la capa clínica relacional:',e);
}
```

Aplicado en los 3 puntos de alta/edición identificados:

- [app.js:1796](../app.js) `upsertPacienteDesdeCarga()` — cubre "nuevo
  turno con paciente nuevo", el camino más común.
- [app.js:3549](../app.js) `guardarPacientePanel()`.
- [app.js:6246](../app.js) `guardarPacienteGlobal350()`.

Los 2 puntos preexistentes de HC ([app.js:8263](../app.js)
`saveEvolutionHC`, [app.js:8282](../app.js) resumen clínico) **no se
modificaron**: siguen llamando a `sincronizarPacienteCompleto410()`, que
es correcto ahí porque esos flujos son exclusivos de Médico y sí necesitan
sincronizar HC además de la ficha.

### Manejo de errores async confirmado

`sincronizarPacienteCompleto410()` y `sincronizarFichaPacienteBasica410()`
son funciones `async` cuyo **cuerpo entero** está envuelto en
`try/catch` que nunca relanza — cualquier error (de red, de Supabase, de
RLS) se captura y la función resuelve `false`, nunca rechaza. Por eso las 5
llamadas totales (3 nuevas + 2 preexistentes de HC) son seguras aunque no
todas usen `await`/`.catch()` explícito: la promesa que devuelven no puede
rechazar. Aun así, los 3 puntos nuevos se escribieron con
`?.catch?.(...)` encadenado, por consistencia y como defensa adicional si
en el futuro se relaja ese try/catch interno.

`listo410()` ([app.js:9636](../app.js)) no exige ningún rol específico —
sólo `supabaseClient && usuarioSupabase && data` — así que
`sincronizarFichaPacienteBasica410()` es utilizable por Secretaría bajo el
RLS actual, sin depender de tener Historia Clínica abierta:
`resumenLocal410()`/`evolucionesLocal410()` (usadas sólo por la variante
"completa", no por la básica) leen directamente de `data.resumenesClinicos`
/`data.evolucionesClinicas` en memoria, sin ningún estado de "panel HC
abierto" de por medio.

**RLS a nivel POLICY — confirmado en Producción (2026-08-25):** el dueño
verificó directamente `pg_policies` de `cardiolink_pacientes`. Existe:

```
policy: cardiolink_pacientes_authenticated
role:   authenticated
cmd:    ALL
qual:       true
with_check: true
```

Es decir, cualquier sesión `authenticated` (Secretaría incluida) tiene
permiso real de `INSERT`/`UPDATE`/`UPSERT` sobre `cardiolink_pacientes` —
no sólo grants de tabla, sino la policy en sí sin restricción por rol. Esto
cierra el punto que quedaba pendiente: `sincronizarFichaPacienteBasica410()`
es utilizable por Secretaría bajo el RLS actual, confirmado de punta a
punta (código + policy real). Sigue valiendo la observación de
`docs/ARCHITECTURE.md`: la autorización por rol respaldada en backend
"queda pendiente como evolución futura" — hoy la única barrera real es la
sesión de Supabase autenticada, no el rol Secretaría/Médico/Dueño (`qual:
true` no distingue roles de negocio, sólo exige estar autenticado).

## 11. Seguridad

Sin cambios en el portal. `manejarCheckDni`
([index.ts:169-174](../supabase/functions/portal-gateway/index.ts))
sigue devolviendo sólo `{ok, existe}`, nunca PII. El backfill sólo
completa datos que el gateway ya consultaba correctamente — no se
implementó ningún fallback del portal hacia `cardiolink_atenciones`, tal
como se pidió explícitamente evitar.

## 12. Staging no es espejo completo de Producción

Verificado 2026-08-25: Staging **no tiene** la tabla `cardiolink_atenciones`
en absoluto. Como la fuente real del backfill es
`cardiolink_atenciones.payload->'config'->'pacientes'` (fila
`__cardiolink_config_v1`, ver sección 3), la migración **no se puede
correr contra Staging con datos reales todavía** — falta la estructura de
origen, no sólo los datos.

Regla dura para todo lo que sigue: **nunca copiar PII de Producción a
Staging** para llenar ese hueco. La verificación de esta migración en
Staging se hace exclusivamente con datos sintéticos (sección 13).

## 13. Estrategia de QA con datos sintéticos

Objetivo: probar la lógica SQL de la migración (dedup, preservación de id,
exclusión de conflictos, manejo de fechas, idempotencia, resumen) sin
tocar Producción y sin mover PII real a Staging.

### 13.1 Fixture

Un solo `INSERT` sintético en `cardiolink_atenciones` (Staging), simulando
la fila `id='__cardiolink_config_v1'` con `payload->config->pacientes`
conteniendo objetos inventados (nombres/DNI ficticios, ningún dato real de
paciente), más algunas filas sintéticas pre-existentes en
`cardiolink_pacientes` para los casos que necesitan estado previo. Casos
cubiertos (uno o más objetos por caso):

| Caso | Qué prueba |
|---|---|
| Paciente histórico nuevo, un único `id` | Camino feliz: preserva el id, se inserta |
| DNI que ya existe en `cardiolink_pacientes` | Se clasifica `ya_existe`, no se toca ni se duplica |
| Dos filas históricas, mismo DNI + mismo `id` | Dedup colapsa a una sola fila, sin conflicto |
| Dos filas históricas, mismo DNI + `id` distintos | `conflicto_id_multiple`, excluido del INSERT |
| `id` histórico que coincide con el `id` de OTRO paciente ya en `cardiolink_pacientes` (DNI distinto) | `conflicto_id_colision`, excluido del INSERT |
| `fechaNacimiento` válida (`1988-05-12`) | Se inserta tal cual |
| `fechaNacimiento` inválida (`19988-12-09`) | Queda `NULL`, no aborta el backfill, cuenta en `fecha_invalida` |
| Campos incompletos (sólo DNI + id, sin nombre/teléfono/etc.) | Se inserta igual (`nombre_completo` nullable) |
| Cobertura + n° de afiliado presentes | Mapeo `coberturaHabitual`/`numeroAfiliadoHabitual` correcto |
| Contacto responsable presente (nombre/relación/teléfono/email) | Mapeo `contactoResponsable*` correcto |
| Dos filas históricas mismo DNI, completitud/fecha distinta | El ranking por completitud + `actualizadoEn` elige la fila correcta |

Todos los DNI sintéticos usan un rango claramente no real (ej. prefijo
`000000` + secuencial) para que sea imposible confundirlos con datos de
Producción, y los nombres son literalmente `"Paciente QA N"`.

### 13.2 Cómo probar el SQL en Staging sin PII

1. En Staging, crear primero la tabla `cardiolink_atenciones` con el mismo
   esquema que Producción (`id text primary key, payload jsonb,
   updated_at timestamptz`) — no existe ahí todavía (sección 12). Esto es
   un cambio de estructura en Staging, no en Producción; de todos modos
   requiere aprobación explícita antes de aplicarse, igual que cualquier
   otro cambio de esquema.
2. Insertar únicamente la fila sintética `__cardiolink_config_v1` (fixture
   de 13.1) — nunca un dump ni una copia parcial de la fila real de
   Producción.
3. Insertar las 1-2 filas sintéticas de `cardiolink_pacientes` necesarias
   para los casos `ya_existe` y `conflicto_id_colision`.
4. Correr la migración completa tal cual está redactada, pero cambiando el
   `commit;` final por `rollback;` en una primera pasada (dry run) para
   revisar el reporte sin insertar nada.
5. Confirmar el reporte contra los resultados esperados por caso (tabla de
   13.1), con `commit;` recién en una segunda corrida ya verificada.
6. Volver a correr la migración completa una segunda vez (con commit) para
   confirmar idempotencia: el segundo reporte debe mostrar todos los DNI
   sintéticos como `ya_existe`, cero nuevos `insertables_automaticos`.

### 13.3 Qué sería temporal y qué quedaría persistente

- **Persistente en Staging** (si se decide avanzar): la tabla
  `cardiolink_atenciones` en sí — es estructura, no dato, y hace falta para
  cualquier prueba futura de este flujo, no sólo esta.
- **Temporal, sólo para la corrida de QA**: la fila sintética
  `__cardiolink_config_v1` y las filas sintéticas de `cardiolink_pacientes`
  usadas como fixture — se borran con un script de limpieza dedicado
  después de validar (13.4), no quedan como dato de prueba permanente
  mezclado con datos reales de Staging.
- **Nunca persistente en ningún lado**: PII de Producción. El fixture es
  100% inventado desde el día uno.

### 13.4 Plan de rollback / limpieza

- Durante la prueba: usar `rollback;` en vez de `commit;` para las pasadas
  de sólo-reporte (paso 4 de 13.2) — no deja rastro.
- Después de validar con `commit;`: un script de limpieza dedicado que
  hace `DELETE` explícito por el rango de DNI sintético (prefijo
  `000000`) tanto en `cardiolink_pacientes` como en la fila
  `__cardiolink_config_v1` de `cardiolink_atenciones` — nunca un `DELETE`
  sin filtro ni un `TRUNCATE`.
- Si se creó la tabla `cardiolink_atenciones` en Staging sólo para esta
  prueba y se decide no mantenerla, un `DROP TABLE` explícito la revierte
  — pero dado que es útil para pruebas futuras del mismo flujo, lo más
  razonable es dejarla vacía en vez de borrarla, a menos que el dueño
  prefiera lo contrario.
- Ninguno de estos scripts toca Producción bajo ninguna circunstancia: usan
  una connection string de Staging explícita, igual que ya hace
  `cardiolink-finanzas-v5.js` para su propio aislamiento de destino
  ([tests/finanzas-v5-seguridad-local.js](../tests/finanzas-v5-seguridad-local.js)).

## 14. Pendiente / fuera de alcance de esta etapa

- Los 6 DNI en `conflicto_id_multiple`: decidir a mano cuál `id` es el
  correcto para cada uno (o si corresponde fusionar).
- `observacionesAdministrativas`: no se migra en esta fase (columna no
  existe en `cardiolink_pacientes`); el dato permanece intacto en
  `config.pacientes`.
- Importación en lote (`confirmarImportPacientes298()`,
  [app.js:5320](../app.js)): no se le agregó el hook de sincronización en
  esta etapa — sincronizar uno por uno en un loop podría ser lento para
  importaciones grandes; necesitaría una versión batch, evaluada aparte.
- Crear el fixture SQL real (sección 13.1) y correrlo en Staging: sigue
  pendiente de aprobación explícita, nada de esto se ejecutó todavía.
- Crear la tabla `cardiolink_atenciones` en Staging (sección 13.2, paso 1):
  cambio de estructura, pendiente de aprobación explícita.
