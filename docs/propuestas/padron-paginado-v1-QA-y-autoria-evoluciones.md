# Padrón compartido · carga paginada V1 · QA en STAGING y ajuste mínimo de AUTORÍA de evoluciones (solo documentado)

Estado: implementado en la rama `fix/padron-paginacion-v1` (PR hacia `main`, SIN merge); probado en STAGING con datos sintéticos (ya borrados). Production: sin cambios. La parte de AUTORÍA (sección 4) NO está implementada: queda aprobada como etapa independiente **p3e**.

## 1. Qué cambia (código)
- `cardiolink-carga-paginada-v1.js` (nuevo, ~150 líneas, solo lectura): lee una tabla completa por páginas con orden determinista por clave (`ORDER BY id ASC` + cursor `id > última`), aprende el tope real del servidor, reintenta la MISMA página ante errores transitorios, no reintenta errores de permiso/sesión, no entra en bucles (la clave debe avanzar; máx. 200 páginas), descarta duplicados, comparte la promesa si hay una lectura idéntica en curso y **nunca devuelve una carga parcial como completa** (`data:null` + error).
- `app.js`:
  - `cargar410` lee `cardiolink_pacientes` con el módulo. Una lectura que no se demuestre completa (`pa.completo!==true`) NO se aplica. La regla R3 de «fichas ausentes» sólo corre tras una lectura completa. Una sola lectura en curso: quien llega mientras tanto comparte el resultado (sin consultas duplicadas).
  - La carga de atenciones (`cargarAtencionesDesdeSupabase`, envoltorio R2B) usa el mismo módulo y conserva el orden `updated_at` descendente.
  - **Sin el módulo** (caché vieja) ya NO se usa una consulta que pueda truncar en silencio: se hace una consulta con conteo exacto y sólo vale si trajo TODAS las filas; si no, se trata como fallo.
  - **Padrón completo al arrancar (ajuste 1):** la configuración descargada al iniciar (owner/Secretaría) reemplazaba `data` y dejaba fuera los pacientes, resúmenes y evoluciones que sólo están en las tablas hasta el primer refresco (~30 s). Ahora, al terminar la PRIMERA carga de la sesión, se reaplica en memoria la última lectura completa (`cardiolinkClinica410.reaplicarCarga`): cero consultas, cero escrituras al servidor, sin refrescos repetitivos, y no hace nada si `data` no cambió.
  - **Fallo de la carga (ajuste 2):** no se aplica nada parcial; queda lo último confirmado. Si este equipo nunca confirmó un padrón completo (marca local por proyecto y usuario, se purga al cerrar sesión) se muestra «No se pudo completar la carga de pacientes… Reintentar» y se quita sola al completarse una carga. «Sincronizar ahora» ya no marca «sincronizado» (ni avanza «Última sincronización») si la carga de pacientes falló.
- `index.html` (tag del módulo antes de `app.js`; versión `40131-padron-paginado`), `sw.js` (misma versión), `cardiolink-cobros-v1.test.cjs` y `cardiolink-hc-resumen-v1.test.cjs` (solo el texto de la versión esperada).
- `tests/carga-paginada-v1.js` (26 pruebas: el módulo real contra un PostgREST simulado con tope de 1000 + chequeos estáticos de la integración).
- `tests/ci-suites.sh` y `.github/workflows/pruebas-node22.yml` (ver sección 5): corrida verificable con Node 22 en GitHub Actions, base vs. PR.
No se tocó: Caja/Finanzas, RLS/SQL, el guardado clínico del PR #33, resumen/evoluciones (siguen con su consulta), políticas por profesional (siguen en la RLS del servidor).

## 2. QA (STAGING, datos sintéticos `qa3e_*`; 1136 pacientes, 1270 atenciones; cuentas owner / médico / Secretaría / médico sin Secretaría)
App REAL (index.html con la URL de STAGING) en el navegador integrado, sesiones sintéticas; «antes» = app.js de main actual.
| Caso | Antes (main) | Después |
|---|---|---|
| A. >1100 pacientes | 1000 | **1136** (sin repetidos) |
| B. mismo padrón owner / médico / Secretaría / médico solo, **al iniciar** | distinto por perfil (main: 1000) | **1136 los cuatro a los ~1,2–1,6 s del arranque** (owner, Secretaría, Rogelio, médico solo; PC e iPad idénticos) |
| B2. carrera de arranque (config. remota más nueva que la local y llegando después de la capa relacional) | owner: 1136 → **32** pacientes durante ~38 s, hasta el refresco | reaplicación en memoria a los ~3 s, sin bajón visible, **0 consultas extra, 0 escrituras** |
| C. creado por Rogelio → Matías y Secretaría | no | **sí** |
| D. creado por Matías → Rogelio | no | **sí** |
| E. creado por Secretaría → ambos médicos | no | **sí** |
| F. médico sin Secretaría crea y encuentra el suyo | no (ni el propio) | **sí** |
| G. paciente editado hoy sigue apareciendo | desaparece | **aparece** |
| H. >1100 atenciones con RLS | owner 999, Rogelio 1000 (998 propias) | owner **1268**, Rogelio **1102** (1100 propias + 2), médico solo 42 (40 propias), cada uno sólo lo suyo |
| I. escrituras por leer | — | pacientes/HC/atenciones: **0**; sólo la fila de configuración del owner (igual que main) |
| J. PC/iPad (2.ª sesión, otro origen) y recarga | — | mismos 1136 pacientes, 10 evoluciones, 1102 atenciones; 0 duplicados; misma huella |
| K. PR #33 (módulos reales) | — | editar propia confirmada; base vieja → conflicto; campo distinto → ambos; editar la de Matías → error (RLS p3c); resumen crear/actualizar OK |
| Error de la página 2 (dispositivo SIN copia completa) | — | 3 intentos, `data.pacientes` = 0 (no 1000), aviso simple con «Reintentar»; al reintentar: 1136 y el aviso desaparece |
| Error de la página 2 (dispositivo CON copia completa) | — | se mantienen los 1136 confirmados, sin aviso, se reintenta en el refresco |
| Módulo de paginación ausente | silenciosamente 1000 | `cargar410` devuelve false, sin aplicar parciales (con copia: sin aviso; sin copia: aviso); atenciones: error claro, lista intacta |
| «Sincronizar ahora» con falla de pacientes | marcaba sincronizado | mensaje claro; «Última sincronización» no avanza; al recuperarse sí |
| Escrituras automáticas (contadores `pg_stat`) tras médico, médico solo y segundo equipo | — | pacientes/HC/atenciones/roles: **0** inserts, updates y deletes; la fila de configuración no cambió |
Rendimiento (STAGING, mismo dataset, tres arranques por versión, con mucha variación de red y de CPU): pacientes (2 páginas) 1,1–2,1 s y atenciones (2 páginas) 1,8–2,7 s con esta versión; la versión anterior de esta rama (sin los ajustes) midió 1,1–2,2 s y 1,1–2,3 s; `main` (1 página, 1000 filas) ≈ 0,36 s y ≈ 0,56 s. Los ajustes no agregan consultas: 2 pedidos de pacientes y 2 de atenciones por arranque. Con menos de 1000 filas: 1 sola consulta (+ conteo en la misma).

## 3. Riesgos residuales
1. ~~Arranque~~ **Resuelto en esta rama** (ver sección 1: reaplicación de la última lectura completa tras la primera carga de configuración). Queda un costo de arranque mayor que en `main` por leer más filas (dos páginas), inherente a tener un padrón de más de 1000.
2. El tope exacto de Production («Max rows») no se pudo leer; el módulo no depende de él (aprende el corte). Verificación opcional en consola: `(async()=>{const r=await supabaseClient.from('cardiolink_pacientes').select('id',{count:'exact'});console.log(r.data.length,r.count)})()`.
3. La regla R3 (fichas eliminadas del servidor dejan de listarse) ahora SÍ corre en Production (antes se omitía con ≥1000 filas); es el comportamiento diseñado en el PR #32.
4. Resumen y evoluciones siguen sin paginar (126 y 274 filas; llegarían a 1000 en ~8-10 meses): el módulo ya sirve para extenderlo.
5. 28 pacientes sólo figuran en turnos (sin fila en `cardiolink_pacientes`): reconciliación posterior, sin backfill ni duplicados.
6. Secretaría lee todas las atenciones (la RLS no limita por asociación): preexistente, fuera de alcance.
7. No hay Node en esta Mac: las 26 pruebas nuevas corrieron con JavaScriptCore; las suites existentes (`*.test.cjs` y `tests/*.js`) se corren con Node 22 en GitHub Actions (sección 5).
8. El owner puede editar evoluciones de otros profesionales (política p3c vigente): se corrige con la etapa p3e (sección 4); no es una regresión de esta rama.

## 4. AUTORÍA de evoluciones (regla confirmada) — ajuste mínimo de interfaz y RLS, SOLO DOCUMENTADO
Regla: todos los médicos autorizados leen toda la HC; cada profesional crea, edita y borra SÓLO las suyas; Matías (owner) no edita las de Rogelio y viceversa. Hoy: owner/admin editan y borran cualquier evolución (políticas p3c, trigger de integridad y la interfaz).
- **Interfaz (app.js, función `canEditHC` y `puedeEliminarEvolucionHC`):** quitar el atajo de owner/admin (`adminHC()`): editar/borrar sólo si `e.profesionalId === profesionalHC().id` (y la ventana de 24 h sigue siendo del cliente hasta decidir p3d). Para evoluciones ajenas se muestra sólo lectura. Opcional: mapear el rechazo de la base a un mensaje claro (hoy el guardado del PR #33 reintenta 4 veces y dice «cambió varias veces»).
- **RLS (nuevo SQL, p3e):** (a) función `cardiolink_ctx_prof_autor_v1()` = `professional_id` del usuario con rol activo owner/admin/médico (la actual `cardiolink_ctx_prof_v1` sólo lo da a médicos y la usan otros módulos: no se toca); (b) políticas INSERT/UPDATE/DELETE de `cardiolink_hc_evoluciones`: `padrón AND lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_autor_v1()))` para todos los roles; (c) trigger de integridad: `profesional_id` inmutable también para owner/admin; (d) las correcciones administrativas excepcionales quedan por SQL (el trigger no afecta sesiones sin usuario) o, más adelante, por una función auditada con trazabilidad. El resumen clínico no cambia (DELETE sólo owner/admin).
- **A confirmar antes:** que ningún flujo del owner inserte evoluciones a nombre de otro profesional (la importación desde Medicloud no tiene lotes registrados). Ensayo y rollback propios, como p3c.

## 5. Pruebas con Node 22 (GitHub Actions)
No hay Node en la Mac de desarrollo, así que la corrida verificable es `.github/workflows/pruebas-node22.yml` (disparo: PR hacia `main` y manual). Usa `tests/ci-suites.sh`:
- Corre TODAS las suites (`*.test.cjs` de la raíz con `node --test`, y `tests/*.js` con `node`) sobre `main` (la base) y sobre el PR, y compara por nombre de prueba: sólo falla ante una falla NUEVA. Las preexistentes (p. ej. las dos aserciones de QR descritas en `tests/LEEME-TESTS.md`) se listan como «preexistentes», sin ocultarlas ni modificarlas.
- Sin secretos, sin red, sin Supabase, `permissions: contents: read`; no despliega ni toca Production. Los registros completos se guardan como artefacto.
