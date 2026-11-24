# QA reproducible · Bloque 0B · Acceso al padrón sólo con rol activo

Dos páginas (sin Node, sin credenciales, sin tocar Supabase). Usan PostgreSQL real (PGlite desde jsDelivr) sobre `stubs.sql`, que replica el estado de Production verificado en solo lectura el 2026-11-24 (política abierta, privilegios, `cardiolink_ctx_rol_v1` y `cardiolink_paciente_padron_v1` con sus definiciones reales) y, en el escenario "Production", las 5 tablas heredadas (`stubs_legacy.sql`).

| Página | Qué prueba | Esperado |
|---|---|---|
| `sql-qa.html` | Los SQL reales A/B y sus rollbacks: precondiciones (aborta sin cambiar nada), matriz de acceso antes/después por actor (owner, admin, médico con y sin `professional_id`, Secretaría, inactivos, cuenta sin fila, anon, service_role) con leer / upsert / actualizar / borrar; padrón compartido; FK; funciones `SECURITY DEFINER`; nada más cambia; InitPlan; rollback exacto; ciclos apply→rollback→apply. Dos escenarios: Production (con heredadas) y STAGING (sin ellas). | 47/47 OK |
| `ensayo-qa.html` | El `ensayo_reversible.sql` GENERADO (el que se pegaría en el SQL Editor) ejecutado sobre los mismos stubs: termina en `ENSAYO_0B_OK`, deja la base como estaba, y falla si A ya estaba aplicada o si la política nueva es defectuosa. | 8/8 OK |

```bash
cd <raíz del repo>
python3 -m http.server 8767 --bind 127.0.0.1
# abrir http://127.0.0.1:8767/tests/qa-padron-acceso-rol-v1/sql-qa.html
# abrir http://127.0.0.1:8767/tests/qa-padron-acceso-rol-v1/ensayo-qa.html
```
(el resultado queda también en `window.__results`; si el navegador cachea la página, recargar sin caché.)

## Límites
- Los stubs imitan a Supabase: la validación definitiva es el ensayo reversible y el humo con sesiones reales en STAGING (ver `docs/propuestas/pending_review_padron_acceso_rol_v1_PUBLICACION.md`).
- No prueban la app (cliente): el humo con sesiones reales cubre padrón, ficha, upsert, Solicitudes de turno, HC y documentos.
- Si se cambia `docs/propuestas/pending_review_padron_acceso_rol_v1_ensayo_pruebas.sql` o los SQL de A/B, regenerar el ensayo: `sh docs/propuestas/pending_review_padron_acceso_rol_v1_generar_ensayo.sh`.
