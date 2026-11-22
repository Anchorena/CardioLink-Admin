# Cómo correr las pruebas con Node real

## Árbol reproducible (recomendado)
Las suites leen archivos del repositorio (app.js, módulos, `index.html`, migraciones, Edge Functions, `docs/propuestas`, `verificacion-publica`, `portal`…). El ZIP v2.2 trae el árbol completo en `arbol-reproducible/` con las credenciales de `app.js` REDACTADAS. Para regenerarlo desde un checkout propio: `sh tests/preparar-arbol-reproducible.sh /ruta/nueva` (sin red ni instalación; redacta la URL y la clave publishable de Supabase de `app.js`). Después: `cd arbol-reproducible/tests && node run-bloque4c1.js`.

Requisito único: **Node ≥ 18** (previsto: **Node 22**, que es con el que se ejecutarán). **No hay dependencias de npm**: las suites sólo usan módulos nativos (`node:assert`, `node:fs`, `node:path`, `node:vm`). No hace falta `npm install` ni lockfile.

```bash
cd tests
node run-bloque4c1.js              # todas: 4C-1, 4B (62), Bloque 3 (20), las dos suites de QR y las de documentos
node run-bloque4c1.js --solo 4c1   # solo el Bloque 4C-1 (25 pruebas estáticas, incluidas 4C-1b, la regla de asociación activa y las versiones)
node run-bloque4c1.js --solo qr    # las dos suites de QR
node run-bloque4c1.js --detalle    # además imprime la salida completa de cada suite
# o con npm (sin instalar nada): npm run test:bloque4c1 · test:4c1 · test:4b · test:bloque3 · test:qr · test:documentos
```
Cada suite también corre sola: `node documentos-seguridad-4c1.js`.

## Qué esperar
- 4C-1: 25/25 · 4B: 62/62 · Bloque 3: 20/20 · documentos-pdf-imagenes 8/8 · guardar-imprimir-enviar 15/15 · sesión-vencida 11/11 · fecha-hora 11/11 · reposo-laboral 7/7.
- **Las dos suites de QR tienen UNA falla conocida cada una (preexistente, NO es del Bloque 4C-1):**
  - `documentos-qr-v2a-f2.js` (17/18): «estático: QR sólo si el archivado lo pide…» afirma `!/CARDIOLINK_QR_V2A\s*=\s*true/.test(…indexHtml)`; `index.html` línea 1120 la activa a propósito desde el commit `72fd56b` (QR habilitado en Production).
  - `documentos-verificacion-publica-v2a-f3.js` (46/47): «página: entorno por hostname con LISTA CERRADA…» espera `SITEKEY_PRODUCCION_PENDIENTE`; `verificacion-publica/verificar/verificar.js` tiene la Site Key real desde el commit `48be71c`.
  Son aserciones desactualizadas respecto de activaciones intencionales. El corredor las informa siempre como «CONOCIDA» y NO las oculta ni las modifica; cualquier otra falla en esas suites hace fallar el corredor. Corrección sugerida (no aplicada, no es parte de este bloque): en la primera, aceptar `window.CARDIOLINK_QR_V2A = true` en `index.html` y seguir exigiendo que ningún JS lo fije; en la segunda, esperar `0x4AAAAAAF0AxYzaP58oXCMy`.
- Si Node mostrara fallas distintas de esas dos, no son del bloque: avisar con la salida de `--detalle`.

## Lo que estas pruebas NO hacen
Los SQL (`docs/propuestas/pending_review_documentos_seguridad_4c1*.sql`) **no se ejecutan acá**: las pruebas JS son revisión estática. Su validación real es el ensayo reversible en STAGING (`…_ensayo_reversible.sql`).

- Seguridad clínica V1 · publicación (sin p3): `node prerrequisitos-seguridad-clinica-v1.js` (9 pruebas estáticas: p1/p2/p3, rollback, ensayos, alcance sin p3).

## Corrida automática con Node 22 (GitHub Actions)
`docs/propuestas/pruebas-node22.workflow.yml` (copiarlo a `.github/workflows/` para activarlo) corre TODAS las suites (`*.test.cjs` de la raíz y `tests/*.js`) sobre `main` y sobre el PR con `sh tests/ci-suites.sh`, y falla sólo ante fallas NUEVAS (las preexistentes se informan como tales). Sin secretos ni red. Local: `sh tests/ci-suites.sh run /tmp/head.tsv` y `sh tests/ci-suites.sh comparar base.tsv head.tsv`.
