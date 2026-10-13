# Bloqueantes de Pendientes médicos V1 — diagnóstico y corrección mínima propuesta

Estado: **PROPUESTA PARA REVISIÓN. Nada de esto está implementado ni aplicado.**
Rama: `feat/ui-interna-v1-v2` (base `6a245df`). Sin cambios de políticas ni migraciones.

Archivos de este paquete. Versionados para revisión: los dos `pending_review_…sql`, `staging_discovery_readonly.sql` y este documento. Los arneses de navegador (`qa-*.js`) son material local de QA simulado y **no** se versionan en este commit:
- `pending_review_atenciones_rls_medico_v2.sql` — borrador de la corrección RLS (NO ejecutar).
- `pending_review_atenciones_rls_medico_v2_tests.sql` — pruebas SQL con `BEGIN … ROLLBACK` para STAGING.
- `staging_discovery_readonly.sql` — 9 consultas de SOLO LECTURA (usuarios, destinatarios, políticas, privilegios EXECUTE, formato de professional_id, cantidad de roles).
- `pending_review_atenciones_rls_medico_v2_rollback.sql` — rollback EXACTO a las políticas previas de STAGING (permite_atencion_v1), con verificación posterior.
- `qa-bloqueante2-version-base.harness.js` + `qa-harness.js` (Supabase simulado en memoria) — pruebas de navegador del bloqueante 2.

---

## Bloqueante 1 — RLS de `cardiolink_atenciones`

### Causa raíz
`cardiolink_atenciones` es una tabla polimórfica. Guarda tres familias de filas en `payload`:

| Familia | Cómo se identifica | `profesionalId` | Quién la usa |
|---|---|---|---|
| Atención/turno | sin `tipoRegistro` o distinto de los de abajo | sí | todos |
| Configuración compartida | `id='__cardiolink_config_v1'`, `tipoRegistro='config'` | no | todos (lectura); admin/secretaría (escritura) |
| Mensaje interno | `tipoRegistro='mensaje'` | no | todos |

`cardiolink_permite_atencion_v1(payload)` autoriza al médico solo si `payload->>'profesionalId'` coincide con su `professional_id`. Para configuración y mensajes ese campo no existe, así que el médico queda **sin lectura y sin escritura** de ambos.

### Efectos reproducibles en el cliente (con la política nueva)
1. **Configuración:** el médico no lee la fila de config. En un dispositivo nuevo usa los valores por defecto (profesionales/usuarios agregados por administración no aparecen). Su escritura (`guardarConfigEnSupabase298`) falla con un `console.warn`, sin alerta.
2. **Mensajes internos, envío:** el `upsert` de un mensaje nuevo viola RLS, la sincronización devuelve `false`, muestra `alert('No se pudo sincronizar…')` y **reencola el mensaje**. Cada guardado posterior repite el alerta: un mensaje bloqueado contamina la cola del médico.
3. **Mensajes internos, lectura:** no ve los mensajes dirigidos a `todos`, `rol:medico` ni `usuario:<él>`.
4. **Marcar leído:** `leidoPor` se actualiza con la sincronización normal; con RLS el `UPDATE` afecta 0 filas y el cliente interpreta que la fila fue eliminada por otra sesión (la quita del arreglo local).

### Restricción de diseño (docs/BUSINESS_RULES.md)
La fila de config contiene `profesionales[].valores` (aranceles), `reglasOS`, `usuarios` y el directorio `pacientes`. Las reglas de negocio indican que el acceso clínico del médico **no concede permisos comerciales/administrativos** (aranceles, convenios, valores). Por eso **no conviene** abrir `SELECT` de toda la fila de config al médico.

### Revisión v3 con datos verificados en STAGING (yslhwdl…)
Hallazgos: el médico backend `professional_id = medico_qa_staging` **no existe en `config.usuarios`** (no hay correspondencia 1 a 1); no hay mensajes históricos ni con `creadoUid`; todas las políticas de `cardiolink_atenciones` delegan en `cardiolink_permite_atencion_v1(payload)`.
Consecuencias de diseño:
- **Identidad de mensajería = backend**: `auth.uid()` + `professional_id`. Si hay usuarios configurados vinculados por `profesionalId`, sus logins (compatibles con históricos `usuario:<login>`/`deUsuario`); si no hay ninguno, un **login seudónimo = el propio `professional_id`** (prefijo `prof_` ante colisión). Nunca el prefijo del email.
- **Directorio** (`cardiolink_directorio_mensajes_v1`): usuarios activos de la config **más** los médicos del backend sin usuario vinculado (nombre desde `config.profesionales` o "Médico <id>"). Devuelve solo `{destino, nombre, rol}`. Disponible para todos los roles de forma **aditiva**, para que Secretaría/owner puedan dirigir mensajes a médicos que no están en la config.
- **Config saneada** (`cardiolink_config_medico_v1`): agrega `mensajeria.login`; `usuarioPropio` puede ser `null`.
- Cliente: el perfil local del médico sin usuario configurado toma el login de backend; no se muestra ningún identificador (las etiquetas son nombres).
- El médico **no puede borrar mensajes** (RLS lo impide): el botón "Borrar" se oculta para el médico.
Archivos actualizados: borrador SQL (v3.2), pruebas SQL, rollback, `qa-bloqueante1-mensajes.harness.js` (QA simulado con dos identidades de médico, secretaría y owner).

### Revisión v3.2 (correcciones pedidas tras la revisión de ChatGPT sobre v3.1)
| # | Observación | Resolución en v3.2 |
|---|---|---|
| 1 | `config_medico` devolvía el objeto `usuarioPropio` completo | JSON construido **campo a campo**: `id, usuario, nombre, rol, profesionalId, especialidad, activo` y, como máximo, **un** alias: el login del propio llamador (para que el cliente se reconozca). Sin `email`, `rolId`, `soloMatias`, lista de aliases ni otros. Sólo entradas con `rol='medico'` activas. Compatibilidad con `app.js` comprobada en simulación: el cliente deriva `rolId` de `rol` y reconoce al médico por identidad de backend aun sin entrada de config |
| 2 | Identidad médica | Una sola función `cardiolink_ctx_prof_v1()`: sesión (`auth.uid()` no nulo) + rol médico **activo** + `professional_id` válido (`^[A-Za-z0-9_.-]{1,64}$`). Si falla algo: `config_medico` = NULL, `logins_propios` = `{}`, sin mensajes. Directorio y marcar-leído también exigen sesión/rol activo |
| 3 | QA entre médicos con un único médico en STAGING | Ver "Estrategia de QA real" más abajo |
| 4a | UPDATE/DELETE de mensajes por médicos | Las 4 políticas usan el predicado `cardiolink_atencion_permitida_v2`; para el médico **excluye** `tipoRegistro` `mensaje`/`config`. UPDATE/DELETE sólo por ese predicado ⇒ el médico no modifica ni borra mensajes ni config, y tampoco puede reconvertir una atención propia en mensaje |
| 4b | **Hallazgo propio, más grave que lo pedido** | En v3.1 un médico podía **insertar una "atención" propia con `tipoRegistro='mensaje'`** y así falsificar un mensaje (`deUsuario:'matias'`, `destino:'todos'`) saltándose `creadoUid`. Corregido en v3.2 y cubierto por 2 pruebas SQL (insert falsificado y reconversión por UPDATE) |
| 4c | Directorio | Sólo `{destino,nombre,rol}`; sin emails, alias, ids ni `profesionalId`; requiere sesión y rol activo. Prueba SQL verifica claves y ausencia de `@` |
| 4d | Nombres de funciones y GRANT | En Supabase `REVOKE … FROM PUBLIC` **no** quita el EXECUTE por defecto de `anon`/`authenticated`. v3.2 revoca de `PUBLIC, anon` en todo y además de `authenticated` en los helpers internos (`config_usuarios`, `login_seudonimo`: antes eran ejecutables por anon y leían la config). Las funciones que las políticas evalúan como `authenticated` conservan el GRANT. Prueba SQL con `has_function_privilege` y consulta 7 del discovery. Nota: las funciones de la migración de Pendientes (`identidad_pendientes_v1`, `pendiente_mutar_v1`, `permite_atencion_v1`) usan sólo `REVOKE … FROM PUBLIC`; conviene el mismo endurecimiento (no se tocó ese archivo) |
| 4e | Aislamiento de atenciones entre profesionales | Predicado v2 exige `profesionalId = mi professional_id`; pruebas A/B recíprocas |
| 4f | Históricos conservados | La migración y el rollback no hacen DML. Precondición/postcondición comparan la cantidad de mensajes antes/después y abortan si cambia |
| 4g | Rollback = políticas previas de STAGING | Nuevo `…_rollback.sql`: restaura las 4 políticas **exactamente** como en `pending_review_pendientes_medicos_v1.sql` (todas con `permite_atencion_v1(payload)`), y verifica el resultado. Distinto del rollback de Production (`USING (true)`). La v3.2 además **aborta si las políticas actuales no son las esperadas** (precondición). Pendiente: comparar con el snapshot real de `pg_policies` antes de aplicar |
Riesgo nuevo de v3.2: el formato exigido a `professional_id` deja sin acceso a un médico cuyo id tenga espacios/acentos. Consulta 8 del discovery lo detecta antes de aplicar.

### Estrategia de QA real con dos identidades ficticias (PROPUESTA — nada se ejecuta sin autorización)
Estado verificado: un único médico backend (`professional_id = medico_qa_staging`). Ninguna cuenta ni dato se crea hasta que se autorice.
**Nivel 1 — SQL transaccional, sin cuentas persistentes (recomendado primero).** El script de pruebas crea **dentro de la transacción** una identidad ficticia B (`auth.users` + `cardiolink_user_roles`, `professional_id = qa_tmp_medico_b`) y un médico con `professional_id` inválido, impersona con claims JWT (`SET LOCAL ROLE authenticated`) y termina en `ROLLBACK`. Verificación posterior: `select count(*) from cardiolink_user_roles where professional_id like 'qa_tmp_%'` y `… from auth.users where email like 'qa-tmp-%'` deben dar 0. Riesgo: si `auth.users` exige columnas o dispara triggers, el INSERT falla y la transacción aborta sin cambios; en ese caso pasar al nivel 3.
**Nivel 2 — App autenticada con las cuentas reales de STAGING** (médico QA, Secretaría, owner): mensajería A→Secretaría, Secretaría→médico QA (vía directorio), marcar leído, "Enviados", config saneada, escritura de config sólo por Secretaría, envío sin alerta ni cola bloqueada, atenciones del médico QA aisladas. No usa pacientes reales: sólo registros marcados "QA" creados para la prueba.
**Nivel 3 — Segunda cuenta ficticia persistente (sólo con autorización explícita).** (a) Crear en el panel de Authentication un usuario con email ficticio de tu control y contraseña que definís vos (no la manejo yo). (b) `insert into cardiolink_user_roles(user_id, base_role, active, professional_id) values ('<uuid>','medico',true,'qa_medico_b');` (c) Sin usuario en `config.usuarios` (identidad por seudónimo), para que sea un caso distinto del médico QA. (d) Ejecutar los mismos flujos del nivel 2 con ambos médicos en navegadores separados y atenciones "QA" para cada uno. (e) **Limpieza:** `delete from cardiolink_atenciones where id like '__qa_%' or payload->>'paciente' like 'QA %'` (revisar antes con un SELECT), `delete from cardiolink_user_roles where professional_id='qa_medico_b'`, y eliminar el usuario desde el panel. Registrar el snapshot de políticas antes y después.
Orden: discovery de solo lectura → snapshot → aplicar v3.2 en STAGING → nivel 1 → nivel 2 → (si se autoriza) nivel 3 → decisión sobre Production. Nada de esto toca Production.

### Revisión de seguridad y rendimiento del SQL v3.1 (previa a STAGING)
Cambios respecto de v3 por esta revisión:
- **Rendimiento:** v3 releía la fila de config (con `pacientes`) hasta 3 veces por mensaje evaluado. v3.1 calcula mis logins y mi uid **una vez por consulta** (`(SELECT …)` → InitPlan) y los pasa a predicados **puros** (`IMMUTABLE`, sin `SET` ni `SECURITY DEFINER`, sin subconsultas → inlinables). Un no-médico sale de `logins_propios` sin tocar la config.
- **Múltiples logins:** `leido` agrega **todos** los logins del médico (antes sólo el primero) para que cualquier usuario que resuelva el cliente figure como leído. `usuarioPropio` se elige de forma determinista (`ORDER BY usuario, id`).
- **Pruebas SQL:** corrigen dos fallos de mi borrador anterior (la función de claims leía `auth.users` bajo `authenticated`; fixtures insertados tras bajar de privilegios) y agregan: escritura/borrado directos denegados, mensaje sin `creadoUid` denegado, aislamiento recíproco A/B, no-médico sin config saneada, y el caso de un médico con 2 logins (config modificada dentro de la transacción y revertida).
Riesgos que quedan (a decidir/verificar):
1. **Los logins no son inmutables:** si la config agrega un usuario cuyo login coincide con el `professional_id` de un médico sin usuario vinculado, ese médico pasa a `prof_<id>` y los mensajes dirigidos al seudónimo anterior dejan de entregarse. Mitigación: no crear usuarios de config con login igual al `professional_id` de un médico sin vincular.
2. **Dispositivo compartido (preexistente, no causado por esto):** la config y las atenciones cacheadas en `localStorage` por una sesión privilegiada siguen disponibles para el siguiente usuario del mismo navegador (se vio en el QA: 1 paciente y 6 usuarios con email). Conviene limpiar `storageConfig`/`storageAtenciones` al cerrar sesión o al detectar otro `auth.uid()`.
3. **El directorio expone el `destino` interno** (login o `professional_id` del seudónimo) en el DOM del selector; no se muestra como texto, pero no es un secreto frente a un usuario técnico. Es consecuencia de la decisión de usar identificadores estables.
4. **`cardiolink_permite_atencion_v1`** (ya propuesta en la migración de Pendientes) ejecuta un `EXISTS` sobre `cardiolink_user_roles` por fila; con tablas grandes conviene `(SELECT …)`/InitPlan también ahí. Medir con `EXPLAIN (ANALYZE, BUFFERS)` en STAGING antes y después (sección 4 del archivo de pruebas).
5. **Sin validar:** ninguno de los dos SQL se ejecutó; nombres de funciones/columnas, `GRANT`s sobre la tabla para `authenticated` y el comportamiento de `INSERT … ON CONFLICT` bajo RLS deben comprobarse en STAGING.

### Corrección mínima propuesta v2 (decisiones confirmadas; sin abrir acceso a atenciones ajenas)
**Atenciones: sin cambios.** El médico sigue viendo, creando, editando y borrando solo las que tienen su `professionalId`.

**Identificación (sin asumir login = prefijo del email).** El cliente hoy resuelve "quién soy" con heurísticas sobre email/alias/`inferirUsuarioPorLogin`. En el servidor se usa un vínculo estable: `cardiolink_user_roles.professional_id` ↔ `config.usuarios[].profesionalId` (el mismo vínculo que ya usa `cardiolink_identidad_pendientes_v1`). Función `cardiolink_logins_propios_v1()` = logins (normalizados como `usuarioLoginCorto`) de los usuarios activos vinculados a mi `professional_id`. **A confirmar con `staging_discovery_readonly.sql`, consulta 3** (que cada médico tenga exactamente 1 usuario configurado por `professional_id`).

**Mensajes (policy de lectura para médico):** `todos`, `rol:medico`, `usuario:<alguno de mis logins>`, los que escribí (`creadoUid = auth.uid()`), y los **históricos** sin `creadoUid` cuyo `deUsuario` coincide con mis logins. Nunca `rol:secretaria` ni `usuario:<otro>`. Un mensaje con `creadoUid` de otro y `deUsuario` mío **no** se muestra (anti-falsificación).
**Alta:** solo mensajes con `creadoUid = auth.uid()` y destinos válidos. **Update/delete:** no; marcar leído por `cardiolink_mensaje_marcar_leido_v1(p_id)`.
**Históricos:** no se borran, migran ni reescriben. Los que no cumplan ninguna regla no se muestran (y por lo tanto tampoco en "Enviados").

**Directorio del médico:** `cardiolink_directorio_mensajes_v1()` devuelve solo `{destino, nombre, rol}` por usuario activo. Sin emails, alias, ids ni `profesionalId`. El `destino` (`usuario:<login>`) es el identificador interno estable para entregar y **no se muestra** (la etiqueta es el nombre).

**Configuración clínica saneada:** `cardiolink_config_medico_v1()` devuelve `profesionales[{id,nombre,area,prestaciones}]`, `obrasSociales` y **solo el usuario propio** (`usuarioPropio`, necesario para que el cliente resuelva su perfil sin depender de defaults). Sin aranceles, `reglasOS`, pacientes ni otros usuarios. La fila de config no se abre al médico y el médico nunca la escribe.

**Cliente (mínimo, a implementar después de confirmar el mapeo):**
1. Solo rol médico: cargar `cardiolink_config_medico_v1()` y mezclar `usuarioPropio` y profesionales/obras sociales en `data`; cargar el directorio y usarlo para el selector de destinatarios y `nombreDestinoMensaje`.
2. `guardarConfigEnSupabase298`: no escribir si `!sincronizacionMasivaPermitidaV1()`.
3. Mensaje nuevo: agregar `creadoUid = usuarioSupabase.id`.
4. `marcarMensajesVisiblesLeidos` (médico): RPC en lugar de `saveAtenciones()`.
5. Todo con degradación segura: si una RPC no existe (migración sin aplicar), el comportamiento actual no empeora.

### Orden y dependencias
No se implementa el cliente hasta ver los resultados de `staging_discovery_readonly.sql`: si el vínculo `professional_id` ↔ usuario configurado no es 1 a 1 (o los históricos usan logins que no existen en la config), el diseño de identificación cambia.

### Pruebas dirigidas
SQL (`…_tests.sql`, STAGING, `BEGIN … ROLLBACK`): lectura/escritura del médico A y B; destino propio vs. ajeno; histórico propio visible, histórico ajeno y remitente falsificado ocultos; directorio solo `destino/nombre/rol` y sin `@`; config saneada sin `usuarios`/`pacientes`/`reglasOS`/`valores`; RPC de leído solo sobre mensajes visibles; secretaría y owner/admin con acceso total.
Cliente (al implementar, simuladas): médico envía mensaje sin alerta ni reencolado; selector sin datos sensibles; config por RPC y nunca escritura de la fila; RPC ausente no rompe; secretaría/owner sin cambios.

---

## Bloqueante 2 — Versión base tras la RPC de pendientes

### Causa raíz
`actualizarPendienteMedicoV1` reemplaza `atenciones[pos]` con el payload que devuelve `cardiolink_pendiente_mutar_v1` y no actualiza los dos baselines del módulo de sincronización: el de **contenido** (`baselineAtenciones298`) y el de **versión remota** (`baselineVersionAtenciones298`, el `updated_at`). Además la RPC solo devuelve el payload, no el nuevo `updated_at`.

Consecuencia (reproducida, rojas T1–T4 abajo): la fila queda "sucia" aunque no se editó; la primera edición posterior hace `UPDATE … eq('updated_at', versión_vieja)`, afecta 0 filas, se interpreta como cambio de otra sesión, **se descarta la edición del médico** y aparece el aviso falso "modificado desde otra sesión".

### Corrección mínima propuesta (solo cliente, sin tocar la RPC ni el esquema)
1. En el módulo de sincronización (donde viven los baselines) exponer `window.confirmarVersionRemotaAtencion298(id, payload, updatedAt)`, que fija ambos baselines para esa fila.
2. En `actualizarPendienteMedicoV1`, después de la RPC: releer **esa fila** (`select payload, updated_at where id`), y usarla como verdad:
   - Si el payload releído coincide con el que devolvió la RPC: `atenciones[pos]=releído.payload` y `confirmarVersionRemotaAtencion298(id, payload, updated_at)`.
   - Si difiere (otra sesión escribió entre la RPC y la lectura): se adopta el releído completo y sus baselines; **no** se sobrescribe nada.
   - Si la relectura falla: se fija solo el baseline de **contenido** al payload de la RPC (la fila no queda sucia) y se deja la versión como estaba; una edición posterior sigue protegida por el conflicto (comportamiento actual, acotado). Nunca se borra el baseline de versión, para no convertir la fila en "nueva" y provocar un `upsert` ciego.
3. Cubre `resolver` y `deshacer` porque ambos usan la misma función.

Costo: una lectura adicional por acción. No hay migración.

### Pruebas dirigidas (`qa-bloqueante2-version-base.harness.js`, simuladas)
Estado actual del código (rojo = reproduce el bloqueante):
- T1 tras la RPC un sync normal no reenvía la fila (0 UPDATE) — **ROJO** (1 UPDATE)
- T2 la edición posterior llega al remoto y conserva la resolución — **ROJO** (se pierde la edición)
- T3 sin falso aviso "modificado desde otra sesión" — **ROJO**
- T4 deshacer + edición posterior se guarda — **ROJO**
- T5 un cambio remoto posterior a la RPC no se pisa — verde (red de seguridad que debe seguir verde)

Se agregarán al implementar: T6 relectura difiere del payload de la RPC (se adopta el remoto), T7 relectura falla (sin `upsert` ciego, fila limpia), T8 el rol no médico no cambia.

---

## Orden sugerido
1. Aprobar decisiones del bloqueante 1 y la corrección del bloqueante 2.
2. Implementar el bloqueante 2 (solo cliente) y el cliente del bloqueante 1; verificar en simulación.
3. Aplicar el SQL del bloqueante 1 **primero en STAGING**, con snapshot de `pg_policies`, y ejecutar las pruebas SQL.
4. Recién entonces QA autenticado en STAGING con médico, secretaría y owner reales.
