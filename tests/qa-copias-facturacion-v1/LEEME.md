# QA reproducible · Copias para facturación V1

Dos páginas de prueba que se abren en un navegador (sin Node, sin credenciales, sin tocar Supabase):

| Página | Qué prueba | Resultado esperado |
|---|---|---|
| `sql-qa.html` | El SQL real (`docs/propuestas/pending_review_copias_facturacion_v1*.sql`) ejecutado en **PostgreSQL real** (PGlite, desde jsDelivr) sobre stubs mínimos de Supabase (`stubs.sql`: `auth.uid()`, `storage`, roles, `cardiolink_user_roles`, asociaciones, funciones `ctx_*` y de asociación de 4C-1). Matriz de permisos owner/admin/médico/Secretaría asociada/no asociada/anon, asociación desactivada, Storage, RPC de impresión, eliminación, trigger de inmutabilidad, rollback y ciclo apply→rollback→apply. | `36/36 OK` |
| `ui-qa.html` | El módulo real `cardiolink-copias-facturacion-v1.js` contra los globales simulados de `app.js` y un cliente Supabase en memoria: permisos de sección, subida (validaciones, vinculación automática, errores), descarga, imprimir, marcar impreso, reimprimir, filtros, estado en Agenda y Listado, eliminar con confirmación, roles. | `67/67 OK` |

```bash
cd <raíz del repo>
python3 -m http.server 8766
# abrir http://127.0.0.1:8766/tests/qa-copias-facturacion-v1/sql-qa.html
# abrir http://127.0.0.1:8766/tests/qa-copias-facturacion-v1/ui-qa.html
```
(el resultado queda también en `window.__results` / `window.__R`; si el navegador cachea la página, recargar sin caché).

## Límites (qué NO prueba)
- Los stubs imitan a Supabase; la validación definitiva del SQL es el ensayo en **STAGING** (`pending_review_copias_facturacion_v1_checks.sql` antes y después, más el humo con los tres usuarios reales).
- `ui-qa.html` simula el cliente Supabase: no prueba la RLS (eso lo hace `sql-qa.html`) ni la impresión física (el diálogo de impresión se sustituye por un contador).
- Suite estática adicional (Node ≥ 18): `node tests/copias-facturacion-v1.js`.
