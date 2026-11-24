# Bloque 0B · Acceso al padrón sólo con rol activo · Procedimiento de publicación

Rama `fix/padron-acceso-rol-v1` (desde `origin/main` 247d0f6), sin commit.
Motivo: la política de `cardiolink_pacientes` era `true/true` para cualquier sesión autenticada; desactivar una cuenta no le quitaba el padrón. Es la condición previa de Gestión de Usuarios V1.

## 0. Estado (2026-11-24)
| Entorno | Estado |
|---|---|
| Local (PGlite) | `sql-qa.html` 47/47 · `ensayo-qa.html` 8/8 |
| **STAGING** (`yslhwdlzdknhskawqrtv`) | **Parte A APLICADA y QA APROBADO** (ver §6). Parte B no aplica (no hay tablas heredadas). |
| **Production** (`tupacclmhaqiahhlttyz`) | **Parte A APLICADA el 2026-11-24 (~15:20 hora AR)** y verificada a nivel base de datos (§9). Humo con sesiones reales: ver §9. Parte B **sin aplicar**. |

## 1. Qué cambia (y qué no)
| | Antes | Después |
|---|---|---|
| `cardiolink_pacientes` (1057 filas en Production) | 1 política `cardiolink_pacientes_authenticated`: ALL, `authenticated`, `true`/`true` | 1 política `cardiolink_pacientes_rol_activo_v1`: ALL, `authenticated`, `(SELECT cardiolink_ctx_rol_v1()) = ANY ('owner','admin','medico','secretaria')` |
| Owner, admin, médico, Secretaría **activos** | leen, crean, upsert, actualizan y borran | **igual** (padrón compartido, sin distinción por profesional ni asociación) |
| Cuenta con `active=false` o **sin fila** en `cardiolink_user_roles` | leen y escriben todo | nada (RLS) |
| `anon` | nada (no tiene privilegios de tabla sobre el padrón) | nada |
| `service_role` (portal-gateway, cancelación pública, recordatorios, comunicaciones, envío de documentos) | todo (BYPASSRLS) | todo (sin cambio) |
| Funciones `SECURITY DEFINER` que consultan el padrón (`cardiolink_paciente_padron_v1`, acceso clínico) y chequeos de FK | funcionan | funcionan (no dependen de la RLS del padrón) |
| Privilegios de tabla, otras políticas, funciones, datos | — | **sin cambios** |
| 5 tablas heredadas de Production (`atenciones`, `medicos`, `obras_sociales`, `pacientes`, `prestaciones`; vacías, sin uso en el código) | política `true/true` | PARTE B (opcional): misma condición de rol activo |

Un rol que no esté en la lista (p. ej. uno futuro) queda **denegado** (falla cerrada). `cardiolink_ctx_rol_v1()` ya es la base de las políticas de atenciones, documentos y Storage.

## 2. Archivos (`docs/propuestas/`, prefijo `pending_review_padron_acceso_rol_v1_`)
| Pieza | SQL | Rollback |
|---|---|---|
| A · padrón | `a_pacientes.sql` | `a_pacientes_rollback.sql` |
| B · tablas heredadas (opcional, independiente; en STAGING no hace nada) | `b_legacy.sql` | `b_legacy_rollback.sql` |
| Checks de solo lectura (antes/después) | `checks.sql` | — |
| Ensayo reversible (generado por `generar_ensayo.sh` = foto → pruebas → A → B → pruebas → rollbacks → pruebas → comparación) | `ensayo_reversible.sql` ← `ensayo_pruebas.sql` | (se revierte solo) |
| QA dirigido sobre la política ya aplicada (claims por actor, desactivación/reactivación, turno, HC) | `qa_aplicado.sql` | (se revierte solo) |
QA local: `tests/qa-padron-acceso-rol-v1/sql-qa.html` y `ensayo-qa.html`. Ver `LEEME.md` de esa carpeta.

## 3. Orden (cada paso con autorización explícita)
1. **Read-only:** `checks.sql` en el entorno → esperado `pacientes_forma='abierta'`, `precondicion_a_ok=true`, `ctx_rol_ok=true`.
2. **Ensayo reversible** → debe terminar en `ENSAYO_0B_OK: N pruebas …` (señal de éxito; todo se revierte). Luego `checks.sql` y una foto por hash de datos/políticas/privilegios/funciones: idénticos a los previos.
3. **Aplicar A** → `checks.sql` (`pacientes_forma='rol_activo'`, `politicas_true_authenticated=[]` en STAGING) → QA con sesiones reales (§4). Si algo falla: `a_pacientes_rollback.sql`.
4. **B** sólo donde existan las tablas heredadas (Production) y por separado.
5. Recién entonces se construye Gestión de Usuarios V1 sobre `active=false`.

## 4. QA con sesiones reales (realizado en STAGING)
Copia de la app apuntada a STAGING servida en loopback (Dueño `127.0.0.1:9101`, Secretaría `localhost:9101`, Médico `127.0.0.1:9102`); cada persona inicia sesión ella misma; las pruebas son llamadas reales a PostgREST con el JWT de cada sesión. Para Production el equivalente es humo manual con las cuentas reales (§5), sin crear datos salvo un paciente de prueba que se borra.
Negativo: sólo posible con cuentas de prueba (sin fila de roles o `active=false`).

## 5. Humo en Production tras aplicar (propuesto)
Owner, Secretaría y un médico: abrir el padrón (listado y búsqueda), abrir una ficha, crear y editar un paciente de prueba (`ZZQA-0B`, DNI libre) y borrarlo, Solicitudes de turno (Secretaría/owner), abrir la HC de un paciente (médico/owner). Esperado: igual que hoy. Verificar además por SQL de solo lectura que roles y asociaciones no cambiaron.

## 6. Resultados aprobados en STAGING
- **Aplicación de A:** sin errores; checks `pacientes_forma='rol_activo'`; foto por hash antes/después: pacientes, roles (con `revision`/`updated_at`), asociaciones (2 filas, 15 eventos), 96 funciones, triggers y privilegios **idénticos**; sólo cambió la política del padrón.
- **Ensayo reversible:** `ENSAYO_0B_OK: 4 pruebas` y base idéntica después. El primer intento abortó por un defecto de la prueba (`anon` no tiene privilegios de tabla sobre el padrón → `42501` en SELECT, no "0 filas"); se corrigió la prueba y el stub local, sin dejar cambios.
- **QA dirigido con claims** (`qa_aplicado.sql`): `QA_APLICADO_OK: 5`.
- **Sesiones reales por API (PostgREST con JWT):**
  - Secretaría: listar (32), paginar, buscar por DNI/nombre, alta, edición, alta de turno.
  - Médico QA: ve el padrón compartido y el paciente de la Secretaría; abre el turno de su profesional; `padron_v1=true`; lectura de HC sin error; alta y edición.
  - Dueño: listar, buscar, alta, edición, borrado.
  - **Médico QA desactivado con su JWT ya emitido:** lista 0, búsqueda 0, alta **403 `42501`**, edición 0 filas, turno no visible, `padron_v1=false`; **reactivado:** todo vuelve. Restaurado a `active=true` (la `revision` pasó de 4 a 6; efecto inevitable del trigger de sellado).
  - Portal público (service_role): registro por QR/link `?source=qr` → paciente creado; solicitud de turno → `status=new`, `source=qr`, visible para Dueño y Secretaría, no para el médico.
- **Registro público de Auth deshabilitado en STAGING:** `signUp` → 422 `signup_disabled` sin crear cuenta; login desde cero de los tres usuarios y renovación de token OK; el portal no usa Auth.
- **Limpieza:** 0 residuos `zzqa*`, 32 pacientes, 3 roles activos, asociaciones idénticas.

## 7. Verificaciones de solo lectura en Production (2026-11-24)
- **Estado de partida:** `pacientes_forma='abierta'`, precondición OK, `ctx_rol_ok=true` (mismo hash que STAGING), RLS activa y no forzada, 1057 pacientes, 3 roles, 2 asociaciones activas, 5 tablas heredadas con política abierta y 0 filas.
- **Cuenta de Auth sin rol:** la del usuario legacy `humberto` (Dr. Humberto Fernández Drago; médico, profesional `humberto_drago`; correo de acceso de dominio interno `.local`). Creada 09/07/2026, último ingreso 21/09/2026, sin sesiones ni tokens, ninguna tabla la referencia por uuid. Sin rol no accede a nada protegido desde 4C-1 (14/11); la Parte A le quita el padrón, lo único que conserva. **Se mantiene sin cambios** (darle rol es parte de Gestión de Usuarios). La cuenta sigue pudiendo iniciar sesión.
- **Registro público de Auth:** estaba habilitado en ambos proyectos (cualquiera con un correo real podía crear una cuenta autenticada con acceso al padrón). **Deshabilitado manualmente** en STAGING y en Production; verificado por `/auth/v1/settings` (`disable_signup=true`, proveedor Email activo).
- **`jwt_expiry` de Production = 28000 s (~7,8 h)** (`supabase config pull --dry-run`; STAGING usa 3600). Después de desactivar una cuenta su token sigue vivo ese tiempo; la RLS corta el acceso de inmediato, pero Gestión de Usuarios deberá bloquear la renovación en Auth.
- El SQL de A es **el mismo archivo** que se aplicó en STAGING (sin referencias a proyectos; la sección A del ensayo es idéntica).
- **Ensayo reversible de A en Production (2026-11-24, ~15:16 hora AR, ventana de poco uso: 0 consultas activas, 0 escrituras en atenciones/pacientes y 0 sesiones de Auth en los 30 min previos):** `ENSAYO_0B_OK: 4 pruebas`. Se ejecutó una **variante solo-A** derivada del ensayo generado (sin PARTE B ni su rollback; no toca las tablas heredadas ni dentro de la transacción), validada antes en PGlite (4 pruebas, ambos escenarios). Foto por hash antes/después **idéntica** (pacientes, roles con `revision`/`updated_at`, asociaciones y eventos, 65 políticas, privilegios, 95 funciones, triggers); `checks.sql` igual que antes (`abierta`, 5 heredadas `abierta`, 1057 pacientes); 0 filas `qa0b_*`; cuenta de Humberto sin cambios.

## 8. Impacto conocido y riesgos
- Cualquier sesión cuyo rol no se pueda resolver en el servidor queda sin padrón (la app ya muestra el aviso de rol no confirmado). Es el comportamiento deseado (falla cerrada).
- Bloqueo breve de la tabla al ejecutar `CREATE/DROP POLICY` (`lock_timeout = 5s`: si no obtiene el bloqueo, falla y no cambia nada). El ensayo reversible mantiene ese bloqueo hasta su rollback (segundos): hacerlo en una ventana de poco uso.
- **Rollback = reabrir el padrón** (ver cabecera de `a_pacientes_rollback.sql`).
- No cerrar sesión de una copia de QA con `auth.signOut()` directo: la app queda con el bloqueo "Por seguridad, ingresá tu contraseña" (verifica con el token ya borrado). Usar el botón de la app.
- Observación fuera de alcance (no se cambia): hoy cualquier rol activo puede **borrar** pacientes (la política es ALL). Candidato a un endurecimiento posterior (p. ej. sólo owner/admin), con decisión del Dueño.
- Observación: `anon` tiene todos los privilegios de tabla en varias tablas de Production (con RLS y sin política para `anon` = sin acceso efectivo). No se toca aquí.

## 9. Aplicación de la Parte A en Production (2026-11-24)
- **Previos:** `project-ref` explícito `tupacclmhaqiahhlttyz` (confirmado también por los datos: 1057 pacientes, tablas heredadas presentes). Ventana de poco uso (15:18 hora AR: 0 consultas activas, 0 escrituras en atenciones/pacientes en 60 min, 0 sesiones de Auth en 30 min). `checks.sql` = `abierta`, precondición OK, `ctx_rol_ok`; foto por hash idéntica a la posterior al ensayo.
- **SQL:** `a_pacientes.sql`, SHA-256 `cea2499db47bfccde2b1b3ac1766e34a60f0391a491ce802e992729d77741522`, **el mismo archivo** (sin modificaciones desde las 13:14, antes de aplicarlo en STAGING) que pasó el QA de STAGING. Se aplicó **sólo la Parte A**, en una transacción, sin errores.
- **Checks posteriores:** `pacientes_forma='rol_activo'`, RLS activa y no forzada, 1057 pacientes, privilegios de la tabla iguales; las 5 tablas heredadas siguen `abierta` (Parte B sin aplicar; son las únicas políticas abiertas que quedan).
- **Integridad (foto por hash antes/después):** pacientes (1057), roles (3, con `revision`/`updated_at`), asociaciones (2) y eventos (2), 95 funciones, triggers, privilegios de tablas y 65 políticas (mismo número): **idénticos**; sólo cambió la política del padrón (`cardiolink_pacientes_authenticated` → `cardiolink_pacientes_rol_activo_v1`).
- **Registro público de Auth:** `disable_signup=true`, proveedor Email activo (verificado tras aplicar).
- **Humberto:** sin cambios (sin rol, sin bloqueo).
- **Humo en Production con sesiones reales (sólo lectura, 2026-11-24 ~15:30 hora AR):** la app sin modificar (servida en loopback con la configuración de Production) con los tres usuarios reales, que iniciaron sesión ellos mismos; llamadas reales a PostgREST con el JWT de cada sesión, informando sólo cantidades.
  - **Dueño (owner):** listado 1057 pacientes, página de 10, búsqueda por DNI de un paciente existente (1), apertura de ficha (1), lectura de atenciones (673), `padron_v1=true`.
  - **Secretaría:** listado 1057, página, búsqueda por DNI (1), ficha (1), atenciones (672), documentos (206), Solicitudes de turno (2).
  - **Médico autorizado (`rogelio`):** listado 1057, página, búsqueda por DNI (1), `padron_v1=true`, HC resumen (126) y evoluciones (274) legibles, atenciones propias (12).
  - Sin errores 403/`42501` de política en las consolas (sólo el registro del Service Worker local y un intento de login con contraseña mal escrita, seguido del correcto). No se crearon datos de prueba.
  - Foto por hash posterior al humo **idéntica** a la posterior a la aplicación (pacientes, roles, asociaciones, políticas, privilegios, funciones, triggers). Sesiones cerradas con el botón de la app; servidores locales detenidos.

## 10. Pendiente (no forma parte de este cierre)
- **Parte B (tablas heredadas de Production): PENDIENTE, SIN APLICAR.** `atenciones`, `medicos`, `obras_sociales`, `pacientes` y `prestaciones` (vacías, sin uso en el código) conservan su política `true/true` para cualquier sesión autenticada; son las únicas políticas abiertas que quedan en `public`. Archivos listos: `b_legacy.sql` y `b_legacy_rollback.sql` (independientes de A; la Parte B ya está probada en PGlite y dentro del ensayo generado, pero **no se aplicó en ningún entorno real**). Para aplicarla: `checks.sql` (esperado `legacy_forma` = 5 `abierta`), ensayo reversible incluyendo B en Production con autorización expresa, aplicación y `checks.sql` (esperado 5 `rol_activo`).
- **Cuenta de Humberto sin rol:** darle un rol y `professional_id` es parte de Gestión de Usuarios V1 (Bloque 1).
- **Borrado de pacientes por cualquier rol activo:** endurecimiento posterior, con decisión del Dueño.
- **`jwt_expiry` de Production (~7,8 h):** relevante para el bloqueo de renovación al desactivar cuentas (Bloque 1).
