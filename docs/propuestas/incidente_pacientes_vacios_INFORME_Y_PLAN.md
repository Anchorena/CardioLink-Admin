# Incidente de integridad · 1001 fichas de pacientes sin nombre ni DNI (19/11/2026) · informe, hotfix y plan de recuperación

Estado: **diagnóstico y hotfix preparados en la rama `fix/pacientes-nombres-vacios-v1` (SIN commit, SIN merge, SIN deploy). Production: solo lectura; no se modificó nada.** Este documento no contiene datos personales: la tabla de recuperación, los respaldos y el SQL generado con nombres/DNI quedan fuera del repositorio (carpeta privada de la sesión).

## 1. Qué pasó (evidencia)
- Production, `cardiolink_pacientes`: 1055 filas; **1001 con `nombre_completo` y `dni` NULL** (también teléfono, email, etc.; solo `activo` y las marcas de tiempo quedaron). 54 filas con nombre (altas posteriores al 30/10).
- Esas 1001 filas tienen `actualizado_en` entre **2026-11-19 17:38 y ~17:46 UTC (14:38–14:46 hora Argentina)**, ≈100 filas por minuto, con milisegundos de reloj de cliente: **una escritura masiva, secuencial, hecha por una app abierta en un equipo** (no un SQL: un SQL tendría una sola marca). La fila de configuración (`__cardiolink_config_v1`) y la memoria del equipo del Dueño quedaron también con 1001 pacientes sin nombre.
- Las filas habían nacido con nombre: el backfill histórico del 26/08 (`20260824190000_cardiolink_pacientes_backfill_historico.sql`) copió `nombreCompleto` y DNI desde `config.pacientes`.
- El respaldo local del 19/11 a las 14:58 (-03) ya tenía 29 de 1030 pacientes con nombre, y el respaldo privado de las 17:50 (-03) tenía la tabla con 47/1048 con nombre y la configuración con 34/1033: **el daño es anterior al PR #32 (19/11 17:52) y al PR #35 (21/11)**.

## 2. Causa probable (reproducida)
Versión en producción ese día (PR #31, commit `350abc0`): al cargar la capa relacional, `reconciliarCarga` calculaba `empujar` para cada ficha donde «la copia local cambió y la tabla no cambió desde la última marca de sincronización» y `reintentarFichas410` enviaba esos cambios **uno por uno** (UPDATE condicionado). Si la copia local de un paciente estaba vacía (ficha «cáscara» creada al fusionar) pero las marcas de sincronización (`cardiolink_ficha_sync_v1:*`) seguían en el equipo, **el valor vacío se interpretaba como edición y se empujaba a la tabla**.
- **Reproducción en STAGING** (app real, build de `350abc0`, datos sintéticos): con un equipo del Dueño cuya configuración reemplazó la copia local después de fusionar la tabla (carrera de arranque ya conocida), **al primer refresco (~34 s) empezaron los PATCH a `cardiolink_pacientes` a ~121 por minuto**, dejando fichas sin nombre (143 → 183 antes de frenarlo). Firma idéntica a la de Production (~100/min, secuencial).
- Qué dejó la copia local vacía en el equipo real el 19/11 no está probado (hay dos candidatos: la carrera de arranque y el aislamiento/sellado de caché local del mismo PR #31); el mecanismo que convirtió ese vacío en escritura masiva **sí está probado**.
- **PR #32 (19/11 17:52) eliminó ese camino** (`empujar` ya no existe: «leer o refrescar nunca escribe»). Pero dejó una regla de lectura que **propaga** el daño: «la tabla manda, también los datos vaciados» → todo equipo que abre la app adopta los vacíos de la tabla y los guarda en la configuración. Reproducido en STAGING con `main` actual: tabla vaciada → 1100 → **0** nombres en memoria y caché local, sin escrituras.
- Además existe un camino de escritura puntual (`asegurarPacienteSinConflictoDni410`, `sincronizarPacienteCompleto410` y dos upsert más) que arma la fila completa desde la ficha local: con la ficha local vacía escribe `nombre_completo = 'Paciente sin nombre'` (texto sustituto de la interfaz). Reproducido en STAGING con `main`.

## 3. Respaldos realmente disponibles
- **Supabase Production: Plan Free, sin respaldos ni PITR** (panel Database → Backups: «Free Plan does not include project backups»; la API `backups list` devuelve vacío). No hay nada que restaurar desde Supabase; pasar a Pro daría respaldos solo hacia adelante. (Aviso aparte: el panel muestra «Organization exceeded its quota… projects will be restricted from 18 Dec 2026».)
- **Respaldos de la app en la Mac del Dueño** (exportaciones JSON): 29/10/2026 14:49 (995 pacientes, todos con nombre, 988 con DNI), 09/09/2026 (884), 19/11 14:58 (ya vaciado, 29 con nombre) y 20/05 (sin pacientes). Respaldo privado «pre-fichas-estables» del 19/11 17:50 (ya vaciado).
- Foto de evidencia tomada hoy desde Production (solo lectura): tabla completa y fila de configuración, con SHA-256, en la carpeta privada.

## 4. Fichas recuperables (por ID estable) — de las 1001
| Clase | Fichas | Criterio |
|---|---:|---|
| Confirmadas, cruce con fuente viva independiente | 288 | respaldo por ID + atención (`pacienteId`) y/o copias de facturación coinciden; o atención/copias solas sin conflicto |
| Confirmadas, solo respaldos de la app (29/10 y/o 09/09) | 705 | mismo ID y mismo nombre en los respaldos; sin otra fuente que lo contradiga |
| **Total listas para restaurar** | **993** | de las cuales **991** se pueden aplicar ya (2 tienen un DNI que hoy pertenece a otra ficha: índice único) |
| Requieren decisión humana | 8 | 4 con nombres discordantes entre fuentes, 2 con DNI discordante, 2 «posibles» (solo destinatario de mensajes o nombre de archivo) |
| Sin ninguna fuente | **0** | |
Campos adicionales completables desde el respaldo del 29/10 (solo donde hoy están vacíos): teléfono 894, fecha de nacimiento 877, email 337, sexo 325, cobertura 320, afiliado 203, provincia 110, localidad 43, dirección 3. 12 fichas no están en ningún respaldo (posteriores al 29/10): 10 se recuperan por turnos/copias de facturación y 2 quedan como «posibles» (solo destinatario de mensajes). 688 de las 1001 no tienen ninguna otra actividad registrada en el servidor (ni turnos, ni mensajes, ni copias): **para esas el único origen son los respaldos locales** (pacientes migrados desde Medicloud sin uso posterior).
La ficha que originó el reclamo está entre las confirmadas (dos respaldos).
Límites honestos: los respaldos son del 29/10 (y 09/09): una corrección legítima hecha entre el 29/10 y el 19/11 sobre nombre/DNI de un paciente **sin** turnos recientes no puede detectarse (se verifica por muestreo). Nada se inventa: lo que no tiene fuente quedaría vacío y se informa.

## 5. Hotfix mínimo (en rama, sin commit)
Archivos: `cardiolink-pacientes-ficha-v1.js`, `app.js`, `index.html`/`sw.js` (versión `40132-identidad-protegida`, módulo `fe-2`), dos `*.test.cjs` (solo versión y entorno de prueba), `tests/identidad-protegida-v1.js` (12 pruebas).
1. **No se adopta un vaciado de nombre/DNI** que venga de la tabla cuando la copia local los tiene (`reconciliarCarga` lo informa aparte). **Corrección legítima sí pasa:** si el lote trae menos de 10 fichas así (`UMBRAL_VACIADO410`) se adoptan; con 10 o más (vaciado masivo) se bloquean TODOS y se muestra un único aviso simple. El resto de los campos sigue a la tabla como siempre; la forma del resultado no cambia salvo cuando hay un vaciado bloqueado.
2. **Ningún upsert de fila completa pisa** un nombre/DNI ya guardado con NULL ni con el texto «Paciente sin nombre» (se omiten esas columnas del upsert; la edición explícita de la ficha sigue por el camino de diferencias).
3. **El reintento de fichas no envía un lote de vaciados** de nombre/DNI (≥ umbral).
4. No agrega escrituras ni consultas: el conteo se hace en memoria.
**Probado en STAGING con la app real** (datos sintéticos): arranque normal (1100 con nombre, 0 escrituras); tabla vaciada masivamente → **1100 nombres conservados** en memoria y caché (con `main`: 0), 0 escrituras a pacientes, aviso visible; 3 vaciados puntuales (< umbral) → se adoptan, sin aviso; upsert con ficha local vacía → el nombre en la tabla **se conserva** (con `main` se pisaba con «Paciente sin nombre»). Node 22.23.5: **46 suites, sin fallas nuevas respecto de `main`** (11 preexistentes, las mismas).
Pendiente decidir: confirmar el umbral (10), y el texto del aviso. No resuelve por sí solo la tabla ya vaciada: por eso va ANTES de restaurar (si no, los equipos con datos viejos seguirían adoptando vacíos hasta que se restaure).

## 6. Plan de restauración selectiva (reversible; NADA ejecutado)
Generador sin datos personales: `incidente_pacientes_vacios_generar_sql.py` → escribe `restauracion_ensayo.sql` (termina SIEMPRE en error controlado + ROLLBACK), `restauracion_aplicar.sql` (COMMIT), `rollback.sql` y `comparacion_antes_despues.csv`. Con los datos reales ya generó **991 filas** (carpeta privada).
**Ensayado en STAGING con datos sintéticos**: ensayo (1090 filas se restaurarían, no cambió nada), aplicar (1090 restauradas, DNI/teléfono/fecha completados), **rollback (volvió exactamente al estado «antes», incluida `actualizado_en`)** y **aborto por precondición** (una fila corregida a mano en el medio → «ABORTA: 1 filas ya no están vacías», sin cambios).
Garantías: una transacción; `TEMP TABLE` (sin cambios de esquema, RLS ni permisos); precondiciones que abortan (ids inexistentes, fila ya no vacía, choque con el índice único de DNI, DNI repetido en el lote); solo filas con nombre y DNI NULL; por columna `COALESCE` (nunca pisa un dato existente); no toca turnos, evoluciones, resúmenes, documentos, comunicaciones ni la fila de configuración; `actualizado_en = now()` para que los equipos adopten el cambio; verifica el conteo exacto antes de confirmar.
Orden propuesto (cada paso con autorización específica):
1. Publicar el hotfix (PR aparte, con Node 22 y QA) — frena la propagación.
2. Antes de abrir la app en otros equipos: exportar/preservar su caché local (no borrarla).
3. Revisar la muestra de verificación (50 fichas al azar contra la fuente) y decidir las 10 fichas dudosas.
4. Ensayo reversible en Production (transacción con ROLLBACK) fuera de horario; revisar el informe.
5. Aplicar (COMMIT) y verificar: antes/después por ID, 0 fichas pisadas, conteos.
6. Reabrir la app del Dueño: adopta los nombres; la configuración se vuelve a guardar con ellos. Verificar con Rogelio y Geraldine.
7. Rollback disponible mientras no haya ediciones posteriores sobre esas filas (el rollback solo toca filas que conservan el nombre restaurado).

## 7. Riesgos y no recuperable
- **No se pueden recuperar** (hoy): cambios legítimos de nombre/DNI entre el 29/10 y el 19/11 de pacientes sin turnos/copias recientes; las 2 fichas posteriores al 29/10 que solo tienen mensajes como fuente (quedan «posibles», a confirmar con el Dueño). Datos de contacto (teléfono, etc.) de pacientes sin respaldo del 29/10.
- 705 fichas dependen solo de los respaldos (misma línea de origen: son dos fechas de la misma app, no fuentes independientes). Mitigación: muestreo contra los turnos y verificación por el Dueño.
- Equipos con la versión sin hotfix que abran la app antes de publicarlo seguirán adoptando vacíos en su copia local y guardando la configuración vacía (ya ocurrió en la del Dueño). No se pierde más información del servidor, pero se pierde la copia local: por eso conviene exportar antes.
- El umbral fijo (10) es una decisión de producto; un vaciado masivo legítimo (p. ej. depuración) quedaría bloqueado y requeriría una vía administrativa explícita.
- La causa exacta que vació la copia local del equipo el 19/11 sigue sin probarse (ver sección 2).

## 8. Hallazgos fuera del alcance de este hotfix (NO corregidos aquí)
- `cardiolink-config-concurrencia-v1.js` (`aceptarFichasEnBase`, línea 58): `var set = {}; ids.forEach(...), n = 0;` asigna una variable no declarada y lanza `ReferenceError: n is not defined` (modo estricto) en cada carga; el error se captura y se registra, pero la configuración no recibe el aviso de «fichas adoptadas, no son ediciones». Preexistente (viene del PR #32). Corrección propuesta de una línea (`var set = {}, n = 0;`), a tratar en un PR aparte.
