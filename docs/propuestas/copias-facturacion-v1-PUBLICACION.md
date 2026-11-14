# Copias para facturación V1 · Preparación de publicación

Rama: `feat/copias-facturacion-v1` (desde `main` = Production `bb850bf`). **Sin commit, push, merge ni deploy.** SQL aplicado y QA real hecho en **STAGING** (2026-11-14); **Production sin tocar**.

## 1. Qué incluye
| Pieza | Archivo |
|---|---|
| SQL (tabla, bucket privado `billing-copies`, autorización, RPC de impresión) | `docs/propuestas/pending_review_copias_facturacion_v1.sql` |
| Rollback | `…_rollback.sql` (aborta si hay copias/archivos salvo confirmación; no borra el bucket por SQL) |
| Checks de solo lectura (antes/después) | `…_checks.sql` |
| Módulo de cliente + estilos | `cardiolink-copias-facturacion-v1.js` / `.css` |
| Cableado | `index.html` (+5 líneas: botón en «Administrativo», sección, CSS, script) |
| Pruebas | `tests/copias-facturacion-v1.js` (estática, 12) · `tests/qa-copias-facturacion-v1/` (PostgreSQL real 36 + UI 66) |
| Docs | `BUSINESS_RULES.md`, `CARDIOLINK_CONTEXT.md`, `ARCHITECTURE.md`, `QA.md` |

**No se modificó:** `app.js`, `sw.js`, Supabase existente (ninguna tabla, función, política ni bucket previo), 4C-1, `patient_documents`, HC, portal, Edge Functions. El SQL no está en `supabase/migrations` a propósito (`db push` no debe aplicarlo por accidente).

## 2. Diseño (mínimo compatible)
- Bucket propio `billing-copies` (privado, PDF, 10 MB, ruta `{uuid}.pdf`): las políticas restrictivas de 4C-1 filtran por bucket y no interfieren; las nuevas son permisivas y acotadas a ese bucket. No hay URL pública: descarga autenticada.
- Tabla `cardiolink_copias_facturacion` (tipo Holter/MAPA/Ecocardiograma, paciente, DNI, atención, profesional, prestación, obra social, fecha del estudio, estado de impresión). RLS con **una sola función de acceso** reutilizada por tabla, Storage y RPC.
- Autorización con lo ya publicado: owner/admin todo; médico su `professional_id` (`cardiolink_ctx_prof_v1`); Secretaría asociaciones activas (`cardiolink_secretaria_autorizada_prof_v1`). Sin UPDATE directo: marcar impreso/reimprimir por RPC `SECURITY DEFINER`.
- El servidor fija autor, fechas y estado inicial; la identidad de la copia es inmutable (trigger).
- Cliente por envoltura (`seccionPermitida`, `showSection`, `abrirAgendaModal`, `renderTabla`): sin tocar `app.js`; sin escribir atenciones.

## 3. Decisiones tomadas por defecto (cambiables, avisar)
1. **Eliminar:** owner/admin; médico las de su profesional; **Secretaría sólo las que ella misma subió** y mientras siga asociada. Se cambia en una sola función SQL (`cardiolink_copia_facturacion_puede_eliminar_v1`). Nota: `BUSINESS_RULES.md` dice que Secretaría no elimina *documentos*; se interpretó que una copia administrativa de facturación no es un documento clínico. Si se prefiere que Secretaría no elimine, es un cambio de una línea.
2. **Duplicados:** se permite más de una copia por atención (se avisa al subir otra del mismo tipo).
3. **Impresión:** «Imprimir» abre el diálogo y **no** marca como impreso; «Marcar impreso» y «Reimprimir» (suma una impresión) son acciones explícitas. En iPad/iPhone se abre el PDF en una pestaña (el iframe imprime en blanco en Safari iOS).
4. **Vínculo con la atención (`attention_id`):** el servidor lo valida (`cardiolink_copia_facturacion_vinculo_v1`, sólo lectura de `cardiolink_atenciones`): debe existir y ser del mismo paciente (id, o mismo DNI) y profesional; si no corresponde → error `CF002`; si todavía no está sincronizada → `CF001` y el cliente ofrece «Cargar sin vincular a la atención» (explícito). Sin ese vínculo la copia igual es válida, pero no aparece como «Copia de facturación subida» en la atención.
5. El indicador existente `copiaImpresa` / «Falta: copia» de la atención **no se toca** (control manual distinto). Integrarlos sería un cambio aparte.

## 4. Orden de publicación (cada paso con autorización)
| # | Acción | Verificación |
|---|---|---|
| 1 | **STAGING:** `…_checks.sql` (ANTES) | `dependencias_ok=true`, `copias_tabla=false`, `restrictivas_storage_sin_bucket=0` |
| 2 | **STAGING:** `pending_review_copias_facturacion_v1.sql` | termina sin error (sus postcondiciones validan) |
| 3 | **STAGING:** `…_checks.sql` (DESPUÉS) | `copias_politicas_tabla=3`, `copias_politicas_storage=3`, `copias_funciones=7`, `copias_trigger=1`, `authenticated_sin_update=true`, `anon_sin_tabla=true`, `anon_sin_rpc=true`, bucket privado |
| 4 | **STAGING:** humo con rama publicada o servida localmente con 3 usuarios reales (sección 5) | todo OK |
| 5 | **Production:** `…_checks.sql` (ANTES) y, fuera de horario, el SQL | idem 1–3 |
| 6 | **Production:** publicar el cliente (PR a `main`; Pages; `sw.js` es red-primero) | menú «Copias para facturación» visible según rol |
| 7 | **Production:** humo con los 3 usuarios (sección 5) | todo OK |

El SQL es aditivo e invisible hasta que sale el cliente. Si el cliente saliera antes que el SQL, la sección muestra «falta aplicar el SQL» y Agenda/Listado no cambian (nunca rompe). Prerrequisitos en Production (ya publicados): `cardiolink_ctx_rol_v1`, `cardiolink_ctx_prof_v1`, `cardiolink_secretaria_autorizada_prof_v1`, asociaciones.

## 5. Humo manual (3 usuarios reales)
- **Secretaría asociada:** subir Holter desde una atención (se autocompletan datos; la atención muestra «Copia de facturación subida»); subir una Eco/MAPA desde la sección; filtrar; descargar; imprimir; marcar impreso; reimprimir; eliminar la propia (con confirmación). No ve copias de médicos no asociados; no ve «Eliminar» en lo subido por otros.
- **Médico:** ve y carga sólo las suyas; puede eliminarlas.
- **Owner/admin:** ve todas; elimina cualquiera.
- Desactivar temporalmente la asociación de la Secretaría: pierde de inmediato la lista y las descargas (reactivar al terminar).
- Verificar que el paciente no ve nada en el portal y que informes/HC quedan intactos tras eliminar una copia.
- Probar impresión real en la impresora de Secretaría y en iPad.

## 6. Rollback
- Cliente: revertir el commit (o quitar las 5 líneas de `index.html`); el SQL queda inerte.
- SQL: `…_rollback.sql` (si hay copias/archivos, ver su cabecera: exportar/confirmar y `SET cardiolink.copias_rollback_forzar = 'si';` en la misma ejecución). El bucket vacío y privado se elimina aparte desde Storage si hace falta.

## 7. Pendientes conscientes (fuera de alcance de V1)
Plazo de retención y borrado automático; envío por email; generación/recorte automático; PDF mensual combinado; facturación electrónica; p3 y 4C-2; integración con `copiaImpresa`.

## 8. Resultado del QA real en STAGING (CardioLink Staging, ref `yslhwdl…`)
Aplicado con el SQL Editor; checks ANTES/DESPUÉS correctos (tabla+RLS, 3+3 políticas, 7 funciones, trigger, bucket privado PDF, sin UPDATE ni `anon`, 0 restrictivas sin bucket). Cliente servido localmente (copia fuera del repo con URL/clave de STAGING) con sesiones reales de owner, médico (`medico_qa_staging`) y Secretaría; pacientes/atenciones/PDF ficticios «QA COPIAS».
- **Owner:** subida desde la atención (datos autocompletados, «Copia de facturación subida») y desde el módulo; filtros mes/profesional/obra social/estado; descarga (`%PDF`); imprimir, marcar impreso y reimprimir (×2); UPDATE directo denegado.
- **Vínculo:** atención de otro paciente/profesional → `CF002`; no sincronizada → `CF001`; en ambos casos sin archivo ni fila huérfanos.
- **Médico:** ve sólo lo suyo (no la Eco de `matias`), no ve atenciones ajenas, no puede cargar para otro profesional, elimina las de su profesional (aun subidas por el owner).
- **Secretaría asociada:** ve sólo su médico asociado; no carga ni ve `matias`; imprime/marca/descarga lo del médico asociado; «Eliminar» sólo en lo que ella subió (borrado de lo ajeno por API: 0 filas y 0 objetos); con la **asociación desactivada** pierde al instante filas, archivos, lista de autorizados y RPC.
- **Documentos clínicos intactos:** `cardiolink_patient_documents` y `cardiolink_hc_evoluciones` sin cambios antes/después; eliminar copias no tocó nada.
- **Hallazgo corregido:** si el profesional de la atención no figura en la configuración local (caso del médico QA), el owner no podía elegirlo → ahora se ofrece solo; el nombre del profesional se toma de la atención.
- **Limpieza:** archivos (panel de Storage), 3 copias y 4 atenciones ficticias borrados; asociaciones restauradas a inactivas (estado original); 0 pacientes QA. Quedó el marcador vacío `.emptyFolderPlaceholder` del panel (inofensivo; el rollback lo ignora).

## 9. Qué NO está validado
- **Impresión física** (diálogo real, impresora de Secretaría, iPad): en el QA se verificó que «Imprimir» abre el flujo y que el estado se registra, pero el diálogo se sustituyó por un contador → **falta tu verificación manual**.
- Production: nada aplicado ni verificado todavía (sólo los checks de solo lectura previstos).

## 10. Pasos para Production (cada uno con tu autorización)
1. `…_checks.sql` ANTES en Production (esperado: `dependencias_ok=true`, `atenciones_ok=true`, `copias_tabla=false`, `restrictivas_storage_sin_bucket=0`).
2. SQL de aplicación en el SQL Editor de Production, fuera de horario (aditivo; invisible hasta publicar el cliente).
3. `…_checks.sql` DESPUÉS (valores de la sección 4, paso 3).
4. Commit en la rama (sin los archivos p4/p4b, `PUBLICACION.md` de seguridad ni `supabase/.temp/`), PR a `main` y publicación (Pages; `sw.js` red-primero).
5. Humo en Production con los tres usuarios reales y un paciente real de prueba controlado (o ficticio), y limpieza.
Rollback: sección 6.
