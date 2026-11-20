# Seguridad clínica V1 · p3c «HC compartida» · PROCEDIMIENTO DE PUBLICACIÓN EN PRODUCTION

Estado: **LISTO PARA REVISIÓN. NADA EJECUTADO EN PRODUCTION.** Este documento no autoriza ninguna ejecución: el ensayo reversible y la aplicación requieren, cada uno, autorización específica del Dueño.
Proyecto Production: `tupacclmhaqiahhlttyz` («CardioLink Admin»). STAGING: `yslhwdlzdknhskawqrtv`. **Siempre pasar `--project-ref` explícito**: la CLI sin él apunta a Production.

## 1. Qué se publica (decisiones aprobadas)
- **D1/D2** HC compartida entre profesionales activos autorizados (owner/admin/médico con rol activo y `professional_id` válido). Evoluciones: todos consultan; cada médico crea, edita y borra solo las suyas; sin suplantar `profesional_id`. Resumen clínico: todos consultan y actualizan; solo owner/admin lo borran. Secretaría, cuentas sin rol, inactivas y anon: sin acceso.
- **Ajuste 1** (trigger): una evolución no puede cambiar de paciente (`id`/`paciente_id` inmutables para sesiones de usuario); `profesional_id` solo lo reasigna owner/admin.
- **D5** (privilegios): `anon` sin nada; `authenticated` exactamente SELECT/INSERT/UPDATE/DELETE (sin TRUNCATE/REFERENCES/TRIGGER).
- **Cuenta `hum…`**: sigue SIN rol (D3). No se crea ni asigna nada.

## 2. Archivos exactos (en `docs/propuestas/`, prefijo `pending_review_seguridad_clinica_v1_`)
Los SHA-256 de esta tabla son los de la rama del PR; verificar con `shasum -a 256 <archivo>` antes de pegar nada.

| # | Uso | Archivo | Rollback / recuperación |
|---|---|---|---|
| 1 | p3c: HC compartida (políticas) | `p3c_hc_compartida.sql` (`8f17d21df47ce604…`) | `p3c_hc_compartida_rollback.sql` (`92095f600cc1ad0a…`) |
| 2 | Integridad de evoluciones (trigger) | `p3c_integridad_evoluciones.sql` (`d584a670d98714a9…`) | `p3c_integridad_evoluciones_rollback.sql` (`d7742248e6e817bd…`) |
| 3 | Privilegios de tabla (D5) | `p3c_grants_hc.sql` (`2b0807930437b4f0…`) | `p3c_grants_hc_rollback.sql` (`435e5963657075a8…`) |
| 4 | Ensayo reversible (generado) | `p3c_ensayo_reversible.sql` (`084937949d8b4c11…`) | (se revierte solo) |
| 5 | Generador del ensayo + pruebas | `p3c_generar_ensayo.sh` (`d88a611bb2b062fa…`) · `p3c_ensayo_pruebas.sql` (`dd6eeae0499ddc7e…`) | — |
| 6 | Checks de solo lectura | `p3c_checks.sql` (`f5e1c13a45790209…`) | — |
| 7 | Huella de estado (solo lectura) | `p3c_huella.sql` (`c1fe175af646854d…`) | — |

**Solo para Production:** los tres SQL de aplicación (filas 1–3), el ensayo reversible, los checks y la huella. **No usar en Production:** `p3c_delta_staging*` (para bases que ya tienen p3; STAGING), `p3_hc_rls*` (p3 sola dejaría a Rogelio con 2 de 204 pacientes con HC), `p4b_*` (obsoleto). `p4_*` ya está aplicada en Production (se versiona como historial y para el ensayo).

## 3. Ensayo reversible en Production (requiere AUTORIZACIÓN ESPECÍFICA)
**Qué hace:** en una sola transacción aplica p3c → integridad → privilegios sobre Production, ejecuta 119 pruebas con cuentas/pacientes sintéticos `qa3c_*`, verifica los tres rollbacks y la equivalencia del delta, y **termina SIEMPRE con una excepción** (`ENSAYO_P3C_OK` o `FALLA …`) que revierte todo. El script no contiene `COMMIT`.
**Garantías verificadas (STAGING, 2026-11-20):** `huella_total` idéntica antes y después en 5 casos: éxito, falla inyectada a mitad (con p3c+grants+integridad ya aplicados en la transacción), falla inyectada al final, error de sintaxis (el servidor rechaza todo antes de ejecutar) y falla de una prueba. **Guarda de transacción:** si el cliente ejecutara cada sentencia por separado (autocommit), el script aborta en su segunda sentencia, antes de cambiar nada.
**Efectos laterales revisados (Production, solo lectura):** sin triggers en `auth.users`, `cardiolink_pacientes` ni HC (solo `cardiolink_user_roles_90_stamp`, que se revierte con la transacción); sin `pg_net`/`pg_cron`; ninguna tabla `cardiolink*` ni `auth` en la publicación Realtime; los cambios DDL se notifican a PostgREST solo al confirmar (el ensayo nunca confirma).
**Bloqueos y duración:** ~5 s en STAGING. Mientras corre toma bloqueos exclusivos sobre las dos tablas de HC: las lecturas/escrituras de HC esperan hasta que termina (el rol `authenticated` tiene `statement_timeout=8s`). **Ejecutar fuera de horario o sin atención.**

Pasos:
1. Confirmar entorno (nombre y ref `tupacclmhaqiahhlttyz` en la URL del Dashboard o `--project-ref` en la CLI) y que no hay atención en curso.
2. `p3c_checks.sql` → esperado: `forma_hc='abierta'`, `precondicion_p3c_ok=true`, `trigger_integridad=false`, `grants_endurecidos=false`, `padron_fn=true`, `p4_insert_docs_padron=true`.
3. `p3c_huella.sql` → anotar `huella_total` (**H0**) y `cuentas_y_roles` (hoy `4,3`).
4. Ejecutar `p3c_ensayo_reversible.sql` completo.
   - SQL Editor de Production: pegar el archivo entero y ejecutar (si el pegado es grande, copiarlo con `pbcopy` y pegar con Cmd+V). **El resultado correcto aparece como error rojo:** `ENSAYO_P3C_OK: 119 pruebas pasaron; …`.
   - CLI: `supabase db query --linked --project-ref tupacclmhaqiahhlttyz -f <ruta absoluta>/pending_review_seguridad_clinica_v1_p3c_ensayo_reversible.sql`.
   - Cualquier otro mensaje (`FALLA …`) = una prueba no pasó: **detenerse y reportar**; no se persistió nada.
5. Repetir `p3c_huella.sql` → `huella_total` debe ser **igual a H0** y `cuentas_y_roles` igual. Repetir `p3c_checks.sql` → idéntico al paso 2. `SELECT count(*) FROM auth.users WHERE email LIKE 'qa3c\_%' ESCAPE '\'` → 0.
6. Si la pantalla se cierra o hay timeout durante el ensayo: la transacción se aborta con la sesión. Repetir el paso 5; si hubiera una sesión «idle in transaction» colgada (`SELECT pid, state, left(query,60) FROM pg_stat_activity WHERE state LIKE 'idle in transaction%'`), no terminarla sin avisar.

## 4. Aplicación (después del ensayo; requiere OTRA autorización)
Ventana fuera de horario. Cada archivo es su propia transacción con precondiciones: si una falla, se revierte sola y **no se continúa**.
1. `p3c_checks.sql` y `p3c_huella.sql` (estado base).
2. `p3c_hc_compartida.sql`.
3. `p3c_integridad_evoluciones.sql`.
4. `p3c_grants_hc.sql`.
5. `p3c_checks.sql` → esperado: `forma_hc='p3c_compartida'`, `hc_politicas_v1=8`, `hc_politicas_abiertas=0`, `hc_politicas_total=8`, `trigger_integridad=true`, `triggers_sobre_hc=1`, `grants_endurecidos=true`, `anon_select_evol=false`, `anon_truncate_evol=false`, `auth_truncate_evol=false`, `funciones_secdef_que_leen_hc_ejecutables_por_anon=0`.
6. Humo con sesiones reales (sin cargar datos reales nuevos): Dueño y Rogelio abren HC de un paciente atendido por Matías y consultan sus evoluciones; Rogelio no ve «Editar» en la de Matías (UI) y puede crear/guardar una propia si la agenda lo requiere; Secretaría: HC bloqueada y su ficha administrativa funciona; en PC e iPad el mismo médico guarda sin errores. (`select` directo de Secretaría a las tablas de HC → 0 filas.)

## 5. Recuperación (rollbacks) — orden inverso, cada uno en su transacción
| Si hay que deshacer | Archivo | Efecto | Probado |
|---|---|---|---|
| privilegios (D5) | `p3c_grants_hc_rollback.sql` | devuelve todos los privilegios de tabla a anon y authenticated (estado previo de Production; la RLS sigue siendo la barrera) | en el ensayo (T10) |
| integridad | `p3c_integridad_evoluciones_rollback.sql` | elimina el trigger y su función; reaparece el hueco de traslado entre pacientes | en el ensayo (T11) |
| p3c | `p3c_hc_compartida_rollback.sql` | restaura las 2 políticas abiertas (**reabre la brecha**: usar solo para una publicación fallida) | en el ensayo (R1: idéntico al estado previo) |
Orden: grants → integridad → p3c. Cada rollback se niega (precondición) si falta revertir uno posterior. Si un SQL de aplicación falla a mitad, su transacción se revierte sola y el estado queda como estaba (verificar con `p3c_huella.sql`).

## 6. Fuera de este PR (se mantienen separados)
- **p3d** — límite de edición de 24 h en el backend: solo informado; requiere decisión y un cambio de mensaje en el cliente.
- **Política abierta de `cardiolink_pacientes`** — hallazgo documentado; otra etapa.
- **Rotación de la clave service_role legada de STAGING** — procedimiento fuera del repositorio; no se tocan credenciales de Production.

## 7. Checklist de publicación
- [ ] PR revisado (SQL, ensayo, rollbacks, docs) y SHA-256 de la tabla verificados contra los archivos locales.
- [ ] Autorización específica para el ensayo en Production.
- [ ] Fuera de horario; entorno verificado (`tupacclmhaqiahhlttyz`).
- [ ] `p3c_checks` y `p3c_huella` (H0) registrados.
- [ ] Ensayo: `ENSAYO_P3C_OK: 119 …`; `huella_total` = H0; `checks` idénticos; 0 cuentas `qa3c_*`.
- [ ] Autorización específica para aplicar.
- [ ] `p3c_hc_compartida.sql` → `p3c_integridad_evoluciones.sql` → `p3c_grants_hc.sql` (cada uno OK antes del siguiente).
- [ ] `p3c_checks` final con los valores esperados (paso 5 de §4).
- [ ] Humo con sesiones reales (Dueño, Rogelio, Secretaría; PC e iPad).
- [ ] Rollbacks a mano (los tres archivos) durante toda la ventana.
- [ ] Merge del PR y actualización de `docs/` solo después de aplicar y verificar.
