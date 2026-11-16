# Pendientes de cobro V1 — diseño y decisiones

Última actualización: 2026-11-14 · Rama `feat/pendientes-de-cobro-v1-integracion` (base `origin/main` a9968af). El respaldo del trabajo original está en `feat/pendientes-de-cobro-v1` (commit local 2e9d826, base 4c6939a).

## Qué resuelve
Distinguir prestaciones **cobradas** de **pendientes de cobro** sin contar dos
veces el mismo importe. Reglas de negocio: `docs/BUSINESS_RULES.md` (Caja).

## Cómo funciona hoy la Caja (hallazgos previos al cambio)
- `tipoCobro` y `formaPago` son etiquetas: **no** deciden cuánto entra en Caja.
  Entra `montoConsulta + montoEstudio + montoCopago` (salvo "No cobrar" a
  particulares). `montoTotal` es un campo derivado que se guarda pero no se lee
  para sumar.
- Dos cálculos independientes: `cobroEfectivoAtencion` (app.js: Listado,
  `dineroVisible`, `cajaHoy`, Dashboard, CSV) y `calcularIngresosCanonicos`
  (Finanzas V5). Ambos filtran por `a.fecha`.
- `cajaPerfil` (= profesional que atiende) separa la caja por profesional; la
  Caja general no mezcla cajas.
- Las atenciones históricas no tienen estado de cobro.

## Diseño (sin tablas ni SQL nuevos)
Campos nuevos **solo en el payload JSON** de atenciones nuevas:
`estadoCobro` (`cobrado` | `pendiente` | `sin_cobro`), `cobroPendienteEn/Por`,
`cobroConfirmadoEn/Por/PorId/PorRol`, `cobroMedioPago`, `cobroAuditoria[]`.

- **Compatibilidad**: sin `estadoCobro` ⇒ comportamiento idéntico al anterior.
  Nada recorre ni migra registros existentes (hay un test que lo verifica).
- **Regla de Caja**: `estadoCobro==='pendiente'` ⇒ aporta 0 en las dos fuentes
  (`cobroEfectivoAtencion` envuelta por `cardiolink-cobros-v1.js`; Finanzas V5
  editada en 3 líneas). La prestación sigue contando como realizada.
- **Alta**: casilla "Cobro pendiente" en la carga de turno (deshabilitada si no
  hay importe a cobrar). Todo registro nuevo queda con estado explícito.
- **Confirmación** (panel "Cobros pendientes" en Pendientes): Secretaría,
  Administrador y Dueño; elige medio (Efectivo/Transferencia/Débito/Mixto).
  Médico: solo lectura de su propia caja.
- **Idempotencia y concurrencia**: lectura fresca de la fila + `UPDATE …
  WHERE updated_at = <leído>` (mismo mecanismo B1.5 del sync). Cero filas
  afectadas ⇒ se relee; si ya está cobrada no se escribe nada. Botón
  deshabilitado y cerrojo por id contra doble clic. Si hay cambios locales sin
  sincronizar, no confirma (evita perderlos).
- **Lo que se confirma es lo que se vio** (v4.2.1): el botón lleva el importe y la caja
  (`cajaPerfil`, o `profesionalId` si falta) que Secretaría tenía a la vista. Si
  cualquiera cambió, no se confirma, no entra dinero, se refresca la copia local y
  se pide volver a confirmar (`monto_cambio` / `caja_cambio`).
- Un `42501` del backend (Secretaría no asociada) se informa como falta de
  autorización, no como error de red.

## Decisiones cerradas para V1 (2026-11-14)
1. **Fecha de atribución del dinero**: un cobro que estuvo pendiente y se confirmó
   después entra en la caja del día del **pago** (`cobroConfirmadoEn`, hora local) en
   Caja del día y en Finanzas V5; la actividad y la producción siguen en la fecha de
   la atención y los períodos históricos no cambian. El **Listado** filtra y suma por
   fecha de la atención; la fuente de verdad de Caja es Finanzas V5.
2. **Reversión de una confirmación**: queda **fuera de V1** (mejora posterior). Mientras
   tanto solo Dueño/Administrador puede corregir un cobro confirmado.
3. **Secretaría y asociaciones**: viable y resuelto desde el guard SQL, sin tocar el RLS
   general de atenciones (ver abajo).
4. **INSERT que falsifica la confirmación**: se rechaza (guard de INSERT v4.2.1).
5. **Identidad de la confirmación**: la fuente confiable es la sesión autenticada (JWT), también para owner/admin.
6. **Campos económicos de filas no confirmadas** (montos, tipoCobro, formaPago, noCobrar,
   cajaPerfil): el médico los edita en su flujo normal de Carga/Listado; no se endurecen.
   Solo se congelan al confirmarse el cobro.

## Guard SQL v4.2.1 (aplicado y probado en STAGING; NO instalado en Production)
Archivos (`docs/propuestas/`): apply `pending_review_cobros_v1_guard_v421.sql`, checks de solo lectura `..._v421_checks.sql`, tests con
`ROLLBACK` `..._v421_tests.sql` (las 28 originales + casos 14 a 66 + A1 a A22), prueba de concurrencia real de dos sesiones
`..._v421_concurrencia.py`, rollback A para STAGING `..._v421_rollback_a_staging_v411.sql` y rollback B para Production
`..._v421_rollback_b_production_sin_guard.sql`. Se conservan sin cambios los SQL históricos v4.1.1 (`..._guard_medico*.sql`, formateado) y la
referencia exacta del cuerpo compacto que estaba instalado en STAGING (`..._v411_staging_compacto_referencia.sql`). El apply reconoce SOLO esos dos
cuerpos (md5 `5d9ac1d3…` y `b511fed9…`), registra el estado previo y el md5 en el `COMMENT` de la función y aborta con cualquier otro.

La v4.2 (probada el 2026-11-14) no se publica: el QA encontró dos fallas reales, corregidas en v4.2.1:
- **A. Integridad de auditoría.** Una Secretaría asociada (y, por el atajo de owner/admin, también ellos) podía confirmar con su ID y rol correctos
  pero con el email, el nombre visible y la auditoría de otra persona. Ahora, en la transición pendiente → cobrado, `cobroConfirmadoPorId` debe ser
  `auth.uid()`, `cobroConfirmadoPorEmail` y `cobroConfirmadoPor` el email del JWT (el nombre libre ya no se acepta: la identidad visible es el email
  autenticado), el rol la categoría real (`secretaria`, u `owner`/`admin`), la fecha ±1 día de `now()`, `cobroPendienteEn/Por` intactos y
  `cobroAuditoria` = la anterior intacta + exactamente un evento `confirmado` del usuario autenticado. Una confirmación existente no reescribe su identidad
  ni su fecha por la API (tampoco owner/admin); owner/admin pueden agregar eventos de auditoría solo a su nombre y conservan la corrección de importes
  y medio de pago. El módulo envía la identidad de la sesión (`rolParaAuditoria`: `duenio` → `owner`).
- **B. Carrera INSERT/upsert.** `BEFORE INSERT` corre antes de resolver `ON CONFLICT`. Con un `EXISTS` sin bloqueo, un `DELETE` concurrente hacía esperar al
  upsert y, al liberarse, la fila se insertaba como nueva con marcas de confirmación ya "validadas" (reproducido con dos sesiones). Ahora la comprobación
  toma `FOR KEY SHARE`: un `DELETE` concurrente espera o es esperado y, si la fila desaparece, el alta se valida como nueva y se rechaza.
  Compatible con el RLS vigente (no amplía privilegios); verificado sobre la tabla real, sin deadlocks en ediciones/upserts legítimos concurrentes.

Antecedente: la RLS de `cardiolink_atenciones` es por fila, no por campo. El 2026-10-22 se
verificó en STAGING que un médico confirmó por API directa un cobro de un registro sintético
propio; de ahí el guard (v4.1.1, instalado en STAGING). Production no lo
tiene. v4.2.1 conserva todas las reglas de v4.1.1 (10 campos protegidos, triggers BEFORE
UPDATE/DELETE con el mismo `WHEN`, intercepta solo `authenticated`/`anon`, no intercepta
SECURITY DEFINER, `service_role` ni el SQL Editor) y agrega lo siguiente.

### Asociaciones (alternativa elegida)
- Reutiliza `cardiolink_secretaria_autorizada_prof_v1(text)` (asociaciones activas de
  Seguridad clínica V1, la misma que usan documentos y Copias para facturación) y
  `cardiolink_has_finance_access()` (owner/admin). No crea tablas, funciones de permisos ni
  políticas, y **no modifica el RLS de `cardiolink_atenciones`**: el RLS sigue permitiendo
  a toda Secretaría operar atenciones (Agenda, Sala de espera, Carga), como hoy.
- **Qué campo autoriza**: el destinatario económico = `cajaPerfil` y, si falta, `profesionalId`
  (mismo criterio que `app.js`). `profesionalId` (quien atiende) y `cajaPerfil` pueden diferir;
  el dinero va a `cajaPerfil`, así que contra esa persona se exige la asociación. Se evalúa el
  valor almacenado (OLD) y, si la escritura lo cambia, también el nuevo (NEW). Sin destinatario
  o sin coincidencia con un `professional_id`: ninguna Secretaría lo autoriza (solo owner/admin).
- Resultado: owner/admin, global; Secretaría asociada, confirma/corrige/borra los cobros de ese
  destinatario; Secretaría no asociada, médico y rol desconocido, mismas restricciones de v4.1.1.
  Las operaciones asistenciales y administrativas (observaciones, estado del turno, reprogramar,
  montos de un cobro pendiente, altas) conservan el comportamiento actual. Cambio de
  comportamiento: una Secretaría no asociada ya no puede borrar una atención con cobro
  pendiente/confirmado ni cancelarla si el cobro está confirmado.
- Confirmación verificada: en `pendiente -> cobrado` por Secretaría se exige
  `cobroConfirmadoPorId = auth.uid()`, `cobroConfirmadoPorRol = 'secretaria'` y
  `cobroConfirmadoEn` dentro de ±1 día de `now()`. Un cobro ya confirmado no se reescribe
  (anula la doble confirmación por API directa); solo owner/admin pueden corregir importes y medio de pago.

### INSERT y upsert
- Trigger `BEFORE INSERT` para todo rol de la API que no sea owner/admin. El alta nueva solo puede
  tener las formas del alta: sin campos de cobro, `sin_cobro` ("No cobrar"), `pendiente` o `cobrado`
  al registrar. Se rechazan `cobroConfirmadoPorId/Rol/Email`, `cobrado` con `cobroPendiente*`,
  datos de confirmación en una fila no cobrada, auditoría con otra acción y estados desconocidos.
- `BEFORE INSERT` corre **antes** de resolver `ON CONFLICT`. Si la fila ya existe (upsert de
  sincronización) el INSERT pasa y decide el trigger de UPDATE (compara OLD con NEW): el upsert no
  puede cambiar el estado de cobro ni los datos económicos congelados. Una fila eliminada y luego
  reinsertada con marcas de confirmación se rechaza porque ya no existe.

## Riesgos residuales reales
- Un médico puede reinsertar una atención propia ya cobrada con la forma legítima del alta
  ("cobrada al registrar"): es indistinguible del alta real y no suma dinero que el alta normal no
  pueda sumar. Su `cobroConfirmadoPor` y la auditoría de ALTA (`cobrado_al_registrar`) son etiquetas informativas;
  la identidad verificada es la de la confirmación posterior (`cobroConfirmadoPorId` + email autenticado).
- Owner/admin pueden insertar o restaurar filas con confirmación (restauración de backup) sin que se valide su contenido; el backend distingue
  la categoría (owner/admin vs Secretaría) pero no owner de admin (se aceptan ambos como rol).
- La carrera INSERT/upsert contra un `DELETE` concurrente quedó corregida (FOR KEY SHARE) y verificada con dos sesiones.
- **Caso 12b (resuelto, `app.js`)**: al reabrir la app con la sesión restaurada y una caché local (`localStorage`) vieja, `boot402` → `persist402` → `programarSyncSupabase()`
  armaba un temporizador de 700 ms que disparaba `sincronizarAtencionesSupabase(false)` mientras la primera lectura remota seguía en vuelo. Sin versión remota
  conocida (`baselineVersionAtenciones298` vacío) todas las filas de la caché se trataban como "nuevas" y se subían con un upsert ciego (`app.js`, rama `nuevas298`).
  No era `forzar=true` (esa rama solo corre con el remoto vacío). Con v4.1.1 eso podía retrasar momentáneamente una confirmación; con v4.2.1 el guard rechazaba
  la fila (42501) y, al ser un upsert atómico, todo el lote ("No se pudo sincronizar con Supabase"). Corrección mínima: `let cargandoDesdeNube = true;` (la
  sincronización de atenciones queda bloqueada hasta completar la primera carga remota y fijar el baseline); las cargas posteriores y el bootstrap
  `forzar=true` (que lo pone en `false` de forma explícita) no cambian. Verificado en STAGING (QA 12b: A a T) y con un test de contrato.
- **Mejora posterior (no incluida en esta intervención)**: la limpieza de registros corruptos (`app.js`, carga con `corruptosEliminados>0`) llama a
  `sincronizarAtencionesSupabase(false)` ANTES de fijar el baseline de contenido, por lo que todas las filas aparecen como modificadas y se reescriben con un
  `PATCH` condicionado por `updated_at` (mismo contenido, `updated_at` nuevo). En STAGING (3 filas corruptas) son ~68 escrituras por carga de owner/admin que
  cambian el `updated_at` de filas sin cambios reales y pueden provocar conflictos espurios en otras sesiones. Es seguro para los datos (la condición protege) pero
  innecesario; corregir fijando el baseline antes de esa llamada.
- Una copia local vieja que reintente subir una fila ya confirmada (médico, o Secretaría) recibe
  `42501` en esa fila; el sync debe refrescarla. No se pisa la confirmación.
- Restaurar un backup con filas confirmadas ya borradas falla cerrado para Secretaría: hacerlo con
  owner/admin o service_role.
- Atenciones con destinatario económico sin `professional_id` coincidente solo las confirma
  owner/admin (consulta 7 de los checks).
- Si no existen asociaciones activas, ninguna Secretaría confirma hasta que Administración las cree.
- El SQL v4.2.1 se validó ejecutándolo en el PostgreSQL real de STAGING (suite SQL, concurrencia de dos sesiones, API real y navegador); no hay
  Postgres local. Production todavía no lo tiene: antes de instalarlo hay que correr sus checks de solo lectura (`estado_inferido` = `sin_guard`).
- Un conflicto de escritura entre sesiones descarta la edición local y gana la remota (política
  vigente del sync); la confirmación se vuelve a leer y reintenta.
- Atenciones creadas fuera del formulario de carga (Agenda/portal) no tienen `estadoCobro` y se tratan
  como históricas. Una atención pendiente que luego se cancela deja de mostrarse como cobro pendiente.

## Mejoras posteriores (no incluidas en V1; sin cambios de código en esta publicación)
1. **Reescritura innecesaria durante la limpieza de registros corruptos** (`app.js`): la sincronización de limpieza corre antes de fijar el baseline de contenido y
   reescribe con `PATCH` condicionados las filas sin cambios reales (cambia su `updated_at`). Corregir fijando el baseline antes de esa llamada.
2. **Protección adicional ante colisiones de IDs**: las filas "nuevas" del cliente se suben con upsert; una colisión de id con una fila remota existente la sobrescribiría.
   Opción: insertar solo nuevos (`ignoreDuplicates`) y tratar las filas ignoradas como conflicto (el guard ya protege los campos de cobro).
3. **Riesgo de concurrencia no confirmado** (aceptado el 2026-11-16): una edición de otro admin/owner podría perderse con varias sesiones de administración abiertas a la vez. Una comparación A/B
   dirigida (código anterior y actual a 12b) no lo reprodujo; si ocurriera, el cliente adopta la versión remota y muestra un aviso no bloqueante. Sin evidencia de pérdida de datos de cobro.
