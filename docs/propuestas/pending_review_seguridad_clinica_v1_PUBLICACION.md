# Seguridad clínica V1 · Procedimiento DEFINITIVO de publicación en Production (sin p3)

Estado: **LISTO, PENDIENTE DE AUTORIZACIÓN FINAL. Nada ejecutado en Production.** Alcance: **p1, p2, 4B (A y B), cliente, asociaciones, 4C-1 y 4C-1b.** **p3 (HC RLS) queda POSTERGADO** (sus archivos se conservan, fuera de esta publicación).
4C-1 v2.6 y 4C-1b: congelados y aprobados (QA en STAGING). Production (`tupacclmhaqiahhlttyz`, verificado en solo lectura) hoy NO tiene: asociaciones, vínculo clínico paciente–profesional, `cardiolink_paciente_acceso_clinico_v1`, 4B ni políticas de HC por rol; SÍ tiene PARTE 1 y PARTE 2 del historial (RPC con hash `27fd6db7…`, SELECT directo cerrado) y las 4 políticas anteriores de imagen clínica.

## 1. p3 puede postergarse sin afectar la seguridad documental ni sus dependencias (verificado)
- **4C-1 y 4C-1b no usan las políticas de HC.** Lo único que leen de HC (`cardiolink_hc_evoluciones`) está dentro de funciones `SECURITY DEFINER` (`cardiolink_vinculo_documental_v1` y `cardiolink_paciente_acceso_clinico_v1`), que ignoran la RLS de HC: se comportan igual con las políticas abiertas actuales o con las `_v1`.
- **La dependencia real es p2, no p3:** las políticas de documentos de 4C-1 llaman a `cardiolink_paciente_acceso_clinico_v1` (p2). p2 solo agrega tablas y funciones: no cambia ningún acceso por sí sola.
- Ningún SQL ni el cliente referencian las políticas `_v1` de HC fuera de p3. 4B etapa B toca `cardiolink_atenciones`, no HC.
- Con p3 postergado, las políticas de HC quedan como hoy (`*_authenticated`, abiertas): **la exposición de HC es la actual, no una nueva**; queda pendiente cerrarla (p3) en otra publicación.

### ⚠ Lo que p3 NO evita (decisión informada, números de Production)
4C-1 también acota a los MÉDICOS en DOCUMENTOS (no en HC), por titularidad o acceso clínico. Con los datos reales, **Rogelio dejaría de ver 141 de 176 documentos** (132 de `matias` y 9 sin profesional; 100 pacientes) y vería 35 (34 propios + 1 por acceso clínico). Su acceso a la HC no cambia. Si hay pacientes «habituales» de Rogelio cuyos documentos debe seguir viendo, crear antes de 4C-1 el vínculo manual con `cardiolink_asociar_paciente_profesional_v1` (owner/admin; motivo 10-300 caracteres; hoy no tiene pantalla, se invoca por RPC). Secretaría (asociada a `matias` y `rogelio`): ve 162 de 176; no ve 14 (imágenes clínicas, «Mensaje a colega» y sin profesional), por diseño.

## 2. Archivos (en `docs/propuestas/`, prefijo `pending_review_`)
| Pieza | SQL de aplicación | Rollback |
|---|---|---|
| p1 asociaciones (Bloque 3) | `seguridad_clinica_v1_p1_asociaciones.sql` | `…_p1_asociaciones_rollback.sql` |
| p2 acceso clínico (Bloque 4: vínculo manual + predicado) | `…_p2_acceso_clinico.sql` | `…_p2_acceso_clinico_rollback.sql` |
| 4B etapa A (RPC de config) | `config_secretaria_v1_a_rpc.sql` | `…_a_rpc_rollback.sql` |
| 4B etapa B (RLS de la fila de config) | `config_secretaria_v1_b_rls.sql` | `…_b_rls_rollback.sql` |
| 4C-1 | `documentos_seguridad_4c1.sql` | `…_4c1_rollback.sql` |
| 4C-1b | `documentos_seguridad_4c1b_heredados.sql` | `…_4c1b_heredados_rollback.sql` |
| **p3 HC RLS — POSTERGADO, no se aplica** | `…_p3_hc_rls.sql` | `…_p3_hc_rls_rollback.sql` |
Checks de solo lectura (antes y después de cada paso): `seguridad_clinica_v1_produccion_checks.sql`. Ensayo reversible para Production (sin p3, solo con autorización): `…_ensayo_production.sql`. Ensayo de integración ya aprobado en STAGING: `…_ensayo_integracion.sql`.

## 3. Orden de publicación (ejecutar → check → continuar solo si coincide)
| # | Acción | Check esperado |
|---|---|---|
| 0 | Ventana fuera de horario (DDL toma bloqueos unos segundos) y respaldo del esquema. Ensayo reversible `…_ensayo_production.sql`: debe terminar en `ENSAYO_PRODUCTION_OK` | estado inicial sin cambios |
| 1 | `p1_asociaciones.sql` | `p1_asociaciones=true` |
| 2 | `p2_acceso_clinico.sql` | `p2_acceso_clinico=true` |
| 3 | 4B etapa A (con la lista ORIGINAL de heredados: solo `constancia_atencion`, como en STAGING) | `b4b_etapa_a=true` |
| 4 | **Publicar el cliente** (PR de la rama a `main`; GitHub Pages; `sw.js` es red-primero, sin subir versión de caché). Incluye la pantalla de asociaciones habilitada para Production | la app abre y guarda configuración |
| 5 | 4B etapa B, SOLO después del paso 4 | `b4b_etapa_b=true` |
| 6 | **Asociaciones** (sección 4) con la sesión real del owner | `asociaciones_activas=2` |
| 7 | (si corresponde) vínculos manuales de Rogelio (sección 1) | — |
| 8 | `documentos_seguridad_4c1.sql` | `c4c1_politicas_restrictivas_de_6=6`, `c4c1_funciones_de_7=7`, `c4c1_trigger_de_1=1`, `politicas_imagen_clinica_anteriores_de_4=0`, `rpc_historial_con_marca_4c1=true` |
| 9 | `documentos_seguridad_4c1b_heredados.sql` (amplía la lista de 1 a 4 tipos; su precondición exige la lista original) | lista de heredados de 4 tipos |
| 10 | Humo con sesiones reales (sección 6) | ver sección 6 |
Siempre: `p3_politicas_hc_v1_de_8=0` y `hc_politicas_abiertas_de_2=2` (HC sin cambios). Si un paso falla, su transacción se revierte sola: no seguir y diagnosticar. Cada SQL aborta si el estado de partida no es el esperado.

## 4. Asociaciones en Production
Tras 4C-1 la Secretaría solo ve documentos de profesionales con asociación ACTIVA: sin asociaciones vería 0, por eso se crean ANTES (paso 6). Se hacen en Usuarios y accesos con la sesión REAL del owner (RPC `cardiolink_asociar_secretaria_medico_v1`, exige owner/admin y audita al actor real; sin SQL ni claims simulados): **Geraldine con `matias` y con `rogelio`**. Cualquier otro backend sigue cerrado en el módulo.

## 5. Rollback (orden inverso; cada uno revierte su paso y se niega si falta revertir uno previo)
`4c1b` → `4c1` → `4B etapa B` → `p2` → `p1` (y `4B etapa A` si se quiere volver al origen) → revertir el cliente con git. `p1`/`p2` destruirían filas de asociaciones/vínculos: exigen `SET LOCAL cardiolink.rollback_confirmado = 'si';` tras el `BEGIN`. El rollback de 4C-1 restaura las 4 políticas anteriores y la RPC del historial original (idéntica a la de Production). Sin p3 no hay nada que revertir en HC.

## 6. Humo mínimo con sesiones reales (paso 10)
Owner: ve todos los documentos y la pantalla de asociaciones. Secretaría: ve solo los de sus profesionales (162) y puede descargarlos; sin imágenes. Médico: ve sus documentos (35) y sus pacientes en HC como hoy; `from('cardiolink_communications')` devuelve 0 filas. Opcional recomendado, con objetos descartables en `documents/qa4c_storage/` (nunca un documento real): Secretaría intenta borrar por Storage API → el objeto permanece; médico titular y owner sí pueden (procedimiento en `…_4c1_ensayo_reversible_procedimiento.md`).

## 7. URLs firmadas y caché (sin cambiar el alcance)
Vista previa en la app: 120 s. `patient-document-open`: 5 min. Envío al paciente (`patient-document-delivery`): 24 h. Un enlace ya emitido es una capacidad al portador: sigue válido hasta vencer aunque se pierda la asociación (comportamiento previo). La descarga autenticada de Storage manda `Cache-Control: private, max-age≈1 h, must-revalidate`: un archivo ya descargado puede reabrirse desde el caché de ese navegador; el servidor responde 404 a pedidos nuevos (verificado en STAGING).

## 8. Qué se probó
Reutilizadas sin repetir: 4C-1 (25/25), 4B (62/62), asociaciones (21/21, Production habilitado) y documentos. Nuevo y aprobado: `tests/prerrequisitos-seguridad-clinica-v1.js` (8/8 + alcance sin p3) y el ensayo de integración reversible en STAGING (`ENSAYO_INTEGRACION_OK`: huella del catálogo de p1–p3 idéntica a STAGING; 4C-1 y 4C-1b aplican sobre un estado equivalente a Production). El ensayo reversible en Production (paso 0) queda para ejecutar con tu autorización.

## Corrección P0 «padrón compartido» (p4 / p4b) — 2026-11-14
- Producción tras publicar 4C-1: la política `cardiolink_patient_documents_insert_4c1` exigía `cardiolink_paciente_acceso_clinico_v1` al médico, lo que impedía emitir el primer documento a un paciente no atendido. Decisión del Dueño: el padrón de pacientes es compartido por los médicos activos.
- **p4** (`…_p4_padron_compartido.sql`, rollback incluido): función `cardiolink_paciente_padron_v1` + `ALTER POLICY` del INSERT de documentos. Es lo único necesario en Production hoy. Ensayo reversible: `…_p4_ensayo_reversible.sql` (se regenera con `…_p4_generar_ensayo.sh`).
- **p4b** (`…_p4b_hc_padron.sql`, rollback incluido): sólo donde p3 ya está aplicada (STAGING). **No publicar p3 en Production sin p4b inmediatamente después**, o los médicos no podrán crear su primera evolución de un paciente.

## Cierre de RLS de Historia Clínica — p3c «HC compartida» (2026-11-20)
- **Procedimiento exacto, checklist y recuperación: `pending_review_seguridad_clinica_v1_p3c_PUBLICACION.md`.**
- **Decisión del Dueño (D1–D4):** HC compartida entre profesionales activos autorizados (opción B), sin vínculos por paciente; evoluciones: todos consultan, cada médico escribe/edita/elimina solo las suyas (sin suplantar `profesional_id`); resumen clínico compartido (DELETE solo owner/admin); Secretaría, cuentas sin rol, inactivas y anon: sin acceso; la cuenta `hum…` sigue SIN rol.
- **Reemplaza a p3 + p4b en Production.** NO aplicar `p3_hc_rls.sql` solo (Rogelio vería 2 de 204 pacientes con HC). p4 ya está aplicada en Production; p4b queda obsoleto (p3c incluye su efecto).
- **Archivos (prefijo `pending_review_seguridad_clinica_v1_`):**
  | Pieza | SQL | Rollback |
  |---|---|---|
  | p3c (Production: de políticas abiertas a HC compartida) | `p3c_hc_compartida.sql` | `p3c_hc_compartida_rollback.sql` |
  | Delta para bases con p3 (STAGING) | `p3c_delta_staging.sql` | `p3c_delta_staging_rollback.sql` (vuelve a p3 exacta) |
  | Integridad de evoluciones (ajuste 1: `id`/`paciente_id` inmutables; `profesional_id` sólo owner/admin) | `p3c_integridad_evoluciones.sql` | `p3c_integridad_evoluciones_rollback.sql` |
  | Privilegios de tabla (D5 APROBADA: anon nada; authenticated sin TRUNCATE/REFERENCES/TRIGGER) | `p3c_grants_hc.sql` | `p3c_grants_hc_rollback.sql` |
  | Ensayo reversible (generado) | `p3c_ensayo_reversible.sql` ← `p3c_generar_ensayo.sh` + `p3c_ensayo_pruebas.sql` | (todo se revierte solo) |
  | Checks de solo lectura | `p3c_checks.sql` | — |
- **Orden en Production (cuando haya autorización):** 0) `p3c_checks.sql` (esperado `forma_hc='abierta'`, `precondicion_p3c_ok=true`, `trigger_integridad=false`, `grants_endurecidos=false`); 1) ensayo reversible (debe terminar en `ENSAYO_P3C_OK`); 2) ventana fuera de horario; 3) `p3c_hc_compartida.sql`; 4) `p3c_integridad_evoluciones.sql`; 5) `p3c_grants_hc.sql` (cada una es su propia transacción con precondiciones); 6) `p3c_checks.sql` (esperado `forma_hc='p3c_compartida'`, `hc_politicas_v1=8`, `hc_politicas_abiertas=0`, `trigger_integridad=true`, `grants_endurecidos=true`); 7) humo con sesión real de owner y de Rogelio (consultar una evolución de Matías; no se ofrece editarla; guardar una propia) y de Secretaría (HC bloqueada). Rollback en orden inverso: grants → integridad → p3c.
- **Estado:** probado en STAGING (ensayo reversible 119/119 desde p3, p3c y desde «abiertas + p4»; sesiones reales 69/69 con trigger y privilegios aplicados). Production: solo lectura (simulación: Rogelio y Matías alcanzarían 273/273 evoluciones y 126/126 resúmenes; Secretaría y cuenta sin rol, 0). **Nada aplicado en Production.**
- **Pendiente de decisión (ajuste 2, NO implementado):** límite de edición de 24 h también en el backend (ver informe).
