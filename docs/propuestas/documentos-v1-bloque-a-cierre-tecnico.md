# Documentos V1 · Bloque A — cierre técnico (PARA REVISIÓN)

Estado: QA real en STAGING aprobado. **Nada de esto se ejecutó**: no hay commit, push, merge ni deploy, y Production no se tocó.
Archivo de propuesta (no se commitea salvo que se decida).

## 1. Estado verificado

| Punto | Resultado |
|---|---|
| `origin/main` | `b6e0a12` (PR #4 identidad, incluye el hotfix de logout `250146c`) |
| Rama local | `fix/evoluciones-guardado-documentos` en `d21a772` (= evoluciones `c682689` + merge de main hasta `250146c`) |
| Árbol de trabajo | rama + merge de `origin/main` (identidad) aplicado sin commit + Documentos V1 |
| Diferencia árbol de trabajo vs `origin/main` | 3 archivos: `app.js`, `cardiolink-documentos-pdf-v1.js`, `cardiolink-sync-medico-guards.test.cjs` (evoluciones + Documentos V1) |
| Código de identidad (PR #4) | intacto: el diff no quita ni cambia ninguna línea de identidad/rol |
| Instrumentación / QA en el diff | ninguna (sólo `console.warn` en manejadores de error) |
| Production y `source_payload` | **NO existe** (sonda de sólo lectura, 2026-10-14: `42703 column ... source_payload does not exist`). `source_document_id` y `source_content_hash` sí existen. |
| Código QA'd = código a commitear | `app.js` sha256 `c4bb6e7a…`, `cardiolink-documentos-pdf-v1.js` sha256 `71000d24…` (idénticos a los servidos en el QA real) |

Ensayo en un clon descartable: el merge de `origin/main` sobre la rama es automático y limpio (sin conflictos), y el resultado + los 3 commits propuestos reproducen el árbol de trabajo byte a byte (más el bump de caché).

## 2. Archivos modificados (respecto de `origin/main`)

| Archivo | Cambio |
|---|---|
| `app.js` | evoluciones confiables (ya en `c682689`); Documentos V1: guardado confirmado, huella v2, versiones, recuperación, avisos de locales, degradación sin columna; confirmación de logout compatible |
| `cardiolink-documentos-pdf-v1.js` | archivado versionado (`archivarVersionDocumentoV1`), lecturas con columnas explícitas, recuperación del payload, tolerancia a fila perdida |
| `cardiolink-sync-medico-guards.test.cjs` | 24 tests de contrato (evoluciones, logout, identidad, Documentos V1) |
| `index.html`, `sw.js` | **bump de caché** (propuesto, ver commit 4): hoy coinciden con main |

No se versionan: `docs/propuestas/` (harness, incidente_*, patch viejo), respaldos y la carpeta temporal de QA.
Los 3 `.sql` de `source_payload` y este documento quedan en `docs/propuestas/` (sin commitear, a decidir).

## 3. Rama y commits (estado real)

**Rama:** `feat/documentos-v1-bloque-a`, creada desde `origin/main` (`bbd653b`, que ya incluye los PR #4 a #7) en un worktree propio
(`~/Documents/GitHub/CardioLink-Admin-documentos-v1`). Sin upstream: no se hizo push. La rama anterior (`fix/evoluciones-guardado-documentos`,
`d21a772`), su stash y los respaldos (`~/respaldo-documentos-v1-bloque-a*`) se conservan sin cambios.

**Commits locales sobre `bbd653b`:**
1. `8a86b41` feat: Documentos V1 Bloque A — guardado confirmado en servidor, versiones y recuperación (`app.js` + `cardiolink-documentos-pdf-v1.js`, acoplados).
2. `b9aafef` test: contratos estáticos de Documentos V1 Bloque A (`cardiolink-sync-medico-guards.test.cjs`).
3. `3f7d145` chore: bump de caché (`app.js?v=40104-documentos-v1`, `cardiolink-documentos-pdf-v1.js?v=4-documentos-v1`, `CACHE` de `sw.js` = `cardiolink-v4.1.0-documentos-v1`).
4. `312769c` docs: los 3 SQL `pending_review_patient_documents_source_payload_v1*` y este documento (en `docs/propuestas/`, fuera de `supabase/migrations`).
5. `204ca2f` fix: el aviso y el archivado manual de documentos actúan sólo sobre el paciente en pantalla (`app.js` + test).

**Cambios posteriores a esos 5 commits (pendientes de commit hasta nueva autorización):**
- Huella: el N.º de afiliado entra en `hashContenidoDocumento406` sólo en órdenes con número (`afiliadoOrden406`); sin número o en otros tipos la huella no cambia. Un cambio del número genera una versión nueva en el próximo Guardar / Guardar PDF / Enviar y no reutiliza el PDF anterior.
- Aviso de versiones (`versionesDoc406`): distingue "versión eliminada" de "versión más nueva" (sólo presentación; con listado vacío o incoherente se mantiene el texto de siempre). No cambia el versionado.
- Tests de contrato: 25 existentes + 2 nuevos (27).
- Esta sección 3.

**Bump de caché:** se mantiene `40104-documentos-v1`. `main` remoto sirve `40103-orden-afiliado` y la rama no está publicada, así que ninguna build con `40104` llegó a un navegador real. Subirlo sólo si se despliega una build con `40104` antes del PR o si cambia el módulo PDF (el token `?v=4-documentos-v1` es obligatorio: sin él un navegador con caché cargaría el `app.js` nuevo con el módulo viejo).

### Verificación antes de cualquier push (no ejecutada)
```bash
cd ~/Documents/GitHub/CardioLink-Admin-documentos-v1
git status -sb                                   # árbol limpio, sin upstream
git log --oneline origin/main..HEAD              # los commits de arriba (más los que se autoricen)
git diff origin/main --stat                      # sólo app.js, módulo PDF, test, index.html, sw.js y docs/propuestas
git diff origin/main --name-only | grep -c '^supabase/'   # debe dar 0
```
El PR-B se abre desde esta rama; el orden de publicación está en la sección 4.

## 4. Orden exacto de publicación

1. **Revisión** de este documento y de los 3 `.sql` (sin ejecutar nada).
2. **Checks de sólo lectura en Production** (`..._checks.sql`, SQL Editor de Production) y comparar con STAGING: columnas `source_document_id`/`source_content_hash` presentes, RLS activa, 6 policies, `authenticated` con SELECT/INSERT/UPDATE/DELETE, `anon` sin permisos, sin triggers previos.
3. **Dry-run en Production**: el script de migración con `COMMIT` reemplazado por `ROLLBACK` (la autoprueba inserta y borra 3 filas propias por UUID dentro de la transacción).
4. **Aplicar la migración en Production** (con autorización explícita) y repetir los checks: columna `jsonb NULL`, CHECK, trigger habilitado, 0 filas con payload.
5. **PR-A (evoluciones)**: merge y publicación. No depende de la migración.
6. **PR-B (Documentos V1)**: merge y publicación **sólo después del paso 4**.
7. **Humo en Production** con un paciente ficticio o propio de prueba: guardar un documento, ver la versión y el PDF, recuperarlo tras borrar el caché local, y comprobar el aviso de locales. Confirmar que el cierre de sesión sigue protegiendo documentos.
8. **Rollback**: cliente → revertir el merge de PR-B y publicar (el cliente viejo ignora `source_payload`); base → `..._rollback.sql` (respalda los payloads antes de quitar la columna).

Si PR-B se publicara antes de la migración: las listas siguen funcionando (degradan a las columnas de siempre) y "Guardar" de documentos muestra "falta aplicar la migración source_payload", sin crear nada a medias.

## 5. Riesgos pendientes

- **Orden de despliegue**: mitigado en el cliente, pero "Guardar" quedaría bloqueado hasta aplicar la migración.
- **Migración en Production**: la autoprueba escribe y borra 3 filas de prueba en una tabla real (en una transacción que revierte si algo falla). Por eso el dry-run previo.
- **Botón "Guardarlos en el servidor"**: archiva todos los documentos sólo locales de la cuenta (no sólo los del paciente abierto), con confirmación y cantidad. Los PDF ya archivados por el flujo anterior sin contenido editable también se cuentan; archivarlos agrega una versión con payload sin pisar el PDF viejo.
- **Eliminar** una versión vigente deja como vigente a la anterior (la policy de DELETE no cambió).
- **Fusión de pacientes** no actualiza `patient_id` de los PDF archivados (limitación anterior).
- **Sin conexión**: Guardar falla con aviso conservando el texto (no queda guardado sólo local).
- **Médico editando un documento recuperado de más de 24 h**: sigue bloqueado por la regla existente `canEditDoc406`.
- **Otro dispositivo con logo/firma distintos** genera otra huella, y por lo tanto una versión nueva.
- **Filas viejas sin payload** no se pueden editar desde otro equipo (sólo ver/descargar).
- **Secretaría** no ve la sección de documentos clínicos (sin cambios).
- **Qué no cubrió el QA real**: sólo 3 de los 13 tipos (los 13 pasaron en la suite simulada), Eliminar sobre versión vigente y el cierre de sesión de punta a punta.
- **PR de evoluciones**: no pude confirmar si ya hay PR abierto para `fix/evoluciones-guardado-documentos` (sin `gh` en este entorno).
