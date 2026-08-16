# Finanzas 5 — diseño backend de egresos (Etapa 2A)

Estado: diseño preparado, **no ejecutado**. La migración propuesta es
`supabase/migrations/20260815193000_finanzas_v5_schema.sql`.

Esta etapa no cambia el frontend ni la lógica de ingresos de Finanzas 4/5. Su
único objetivo es dejar un esquema auditable para que cada egreso futuro sea
una fila independiente y no quede almacenado en `config`, `atenciones` o
`localStorage` como fuente definitiva.

## Auditoría del auth y de `baseRole` actual

La sesión sí proviene de Supabase Auth: `app.js` crea el cliente y usa
`auth.getSession()` / `signInWithPassword()`; `cardiolink-auth-guard.js` también
valida la sesión.

El permiso CardioLink, en cambio, hoy no tiene una fuente backend confiable:

- `app.js:33-38` obtiene un nombre corto desde el prefijo del email autenticado.
- `app.js:40-50` y `app.js:74-149` resuelven el perfil contra `data.usuarios`,
  aliases y heurísticas del cliente.
- `app.js:157-165` deriva `baseRole` desde `data.roles`, `u.baseRole` o `u.rol`.
- `app.js:2660-2696` crea/modifica el usuario interno en configuración y advierte
  que la cuenta de Supabase Auth debe crearse por separado.
- Los roles personalizados (`app.js:7271-7360`) también se guardan en
  configuración del frontend.

Por lo tanto, una policy que leyera `config`, el prefijo de email o metadatos
editables por el cliente sería una falsa frontera de seguridad. Tampoco se
encontró una tabla de perfiles backend ni claims confiables ya administrados
para traducir `auth.users.id` a `baseRole`.

### Puente backend mínimo

La migración propone `cardiolink_user_roles`, indexada por `auth.users.id` y con
`base_role` limitado a `owner`, `admin`, `medico` o `secretaria`.
`cardiolink_user_key` es sólo una referencia humana al identificador actual de
CardioLink; las policies **nunca** autorizan por ese texto.

La tabla:

- se crea vacía;
- tiene RLS habilitado y ninguna policy para clientes;
- revoca todos los privilegios a `anon` y `authenticated`;
- sólo debe administrarse mediante una migración u otro canal backend confiable;
- no puede ser autoadministrada por owner/admin desde el navegador, evitando
  que una cuenta eleve su propio rol.

Hasta insertar un mapeo verificado, incluso un usuario que el frontend muestre
como dueño/admin queda denegado por RLS. El rol frontend `duenio` se traduce a
`owner`; los roles personalizados se traducen a su `baseRole` real.

## Tablas propuestas

### `cardiolink_finance_categories`

Árbol editable de raíz más un único nivel de subcategorías. Un trigger valida
que una subcategoría no tenga padre y que una categoría con hijos no pueda
convertirse en subcategoría. Los cambios de jerarquía se serializan con un
advisory lock transaccional fijo para cerrar la carrera entre dos ediciones
concurrentes. Las categorías se desactivan con `active=false`; la app no recibe
permiso `DELETE`.

`system_key` identifica el catálogo inicial. Es único, sólo puede ser asignado
por una migración confiable y queda inmutable. Los clientes pueden crear
categorías personalizadas únicamente con `system_key=null`.

El seed incluye exactamente:

- PERSONAL: Secretaría, Otra Secretaría, Limpieza, Otro empleado, Colocaciones.
- ALQUILER.
- LOGÍSTICA / TRASLADOS.
- LIBRERÍA: Tóner, Papel, Resmas, Otros.
- INSUMOS MÉDICOS: Gel ecografía, Electrodos Holter, Alcohol ECG, Otros.
- CÍRCULO MÉDICO.
- SERVICIOS.
- IMPUESTOS / TASAS.
- OTROS.

Los UUID del catálogo son determinísticos para que futuras integraciones puedan
referenciar categorías del sistema sin buscarlas por el texto visible.

### `cardiolink_finance_recurring_templates`

Guarda datos de precarga, vigencia mensual y día de vencimiento. Valida importe
positivo cuando existe, `due_day` entre 1 y 31 y meses normalizados al primer
día. No hay trigger, cron ni función que genere un egreso: el movimiento sólo
existirá cuando un usuario autorizado lo confirme en una etapa futura.

Una plantilla activa es única por categoría, concepto y beneficiario
normalizados con `trim` y sin distinguir mayúsculas, más `professional_id`
normalizado. Se incluye el profesional porque dos profesionales distintos
pueden necesitar legítimamente una plantilla con igual categoría, concepto y
beneficiario. Las plantillas inactivas no participan de la unicidad: se conserva
su historia y puede crearse después una nueva plantilla equivalente.

### `cardiolink_finance_expenses`

Cada movimiento real es una fila. El importe siempre es positivo y el estado
queda restringido a `pending`, `paid` o `voided`:

- `paid` exige `paid_on`;
- `pending` no admite `paid_on`;
- `voided` exige `voided_at` y `voided_by`, y luego la fila queda inmutable;
- no existe permiso ni policy `DELETE`.

Si un egreso pasa de `paid` a `voided`, el trigger conserva obligatoriamente el
`paid_on` anterior; no lo limpia ni permite reemplazarlo durante la anulación.
`voided_at` y `voided_by` registran cuándo y quién anuló, mientras el evento de
auditoría conserva los snapshots `before_data` y `after_data`. El movimiento
anulado mantiene así su trazabilidad histórica, pero los reportes financieros
activos deben excluir siempre `status='voided'`.

`source_type` admite `manual`, `recurring`, `salary_f4`, `placements_f4` y
`migration_f4`. No se crea ninguna fila de sueldo, colocación o migración en
esta etapa. Para fuentes calculadas se exige una `source_ref`; sueldo y
colocaciones también exigen `period_month`.

La identidad de origen (`source_type`, `source_ref`, plantilla, mes y snapshot)
no puede editarse: una corrección debe anular la fila y crear otra. Esto preserva
la trazabilidad de ejemplos futuros como `salary:secretaria:2026-08` o
`placements:<colocador>:<perfil>:2026-08`.

### `cardiolink_finance_audit_events`

Registro append-only con snapshot anterior/posterior y actor. Los triggers de
categorías, plantillas y egresos producen `created`, `updated`,
`status_changed` o `voided`. Un trigger adicional rechaza todo `UPDATE` o
`DELETE` del audit, incluso si se otorgaran privilegios accidentalmente.

El frontend no recibe `INSERT`, `UPDATE` ni `DELETE`: sólo owner/admin puede
leer eventos. La inserción automática usa una función `SECURITY DEFINER`
mínima, sin argumentos, con nombres calificados y `search_path` fijo. Es
necesaria para que el trigger escriba aunque el usuario no tenga permiso
directo sobre audit; se revoca su ejecución pública.

Concretamente, esa función puede insertar en
`cardiolink_finance_audit_events` bajo RLS porque se ejecuta como el owner de la
función/tabla y la tabla tiene RLS habilitado pero no `FORCE ROW LEVEL
SECURITY`; el owner omite esas policies. Esta suposición debe revisarse si en el
futuro cambia el ownership de la función o la tabla, se activa `FORCE ROW LEVEL
SECURITY` o cambian los permisos/roles usados para desplegar la migración.

## Integridad, concurrencia e índices

Las FKs de categorías y plantillas financieras usan `RESTRICT`. La relación de
roles usa `CASCADE` al borrar definitivamente una cuenta Auth. Los UUID de
actores (`created_by`, `updated_by`, `voided_by`, `actor_id`) son snapshots y no
usan FK a `auth.users`: así una purga posterior de la cuenta no puede mutar ni
bloquear el historial financiero append-only. `actor_label` conserva además la
referencia humana disponible al momento del evento.

Los `CHECK` cubren textos obligatorios, importes, estados, fechas de pago y
anulación, meses normalizados, vigencia de plantillas, tipos/orígenes y
`revision > 0`. Los nombres de categorías activas son únicos entre hermanos.

Índices principales:

- clave de sistema y nombre activo por padre en categorías;
- vigencia, categoría e identidad funcional activa en plantillas;
- fecha, categoría/fecha, estado/fecha, fecha de pago y profesional/fecha en
  egresos;
- origen y período en egresos;
- entidad/fecha, fecha y actor/fecha en auditoría.

Un índice único parcial evita plantillas activas equivalentes mediante
`(category_id, lower(trim(concept)), lower(trim(beneficiary)),
lower(trim(professional_id)))`. Los valores opcionales nulos se normalizan a
cadena vacía. Al aplicar sólo `WHERE active`, una plantilla histórica inactiva
no impide crear su reemplazo.

Otros dos índices únicos parciales evitan movimientos vigentes duplicados:

- `(source_type, lower(source_ref))` cuando hay referencia, sin distinguir
  mayúsculas/minúsculas;
- `(recurring_template_id, period_month)` para una plantilla y mes.

Las filas anuladas quedan fuera de esos índices para permitir un reemplazo
corregido sin borrar el historial.

Cada tabla mutable tiene `revision`. El trigger impide asignarla manualmente y
la incrementa en cada actualización; también mantiene inmutables los UUID de
las entidades financieras. El CRUD futuro deberá ejecutar el update
filtrando simultáneamente por `id` **y la revisión esperada**; cero filas
actualizadas significa conflicto y obliga a recargar. La columna por sí sola no
detecta una edición obsoleta si el cliente omite ese filtro.

## RLS y grants

La función `cardiolink_has_finance_access()` comprueba exclusivamente que
`auth.uid()` tenga un registro activo con rol `owner` o `admin`. Es
`SECURITY DEFINER` para poder leer la tabla de roles cerrada, no acepta un UUID
del cliente, retorna sólo un booleano y fija `search_path`; por eso no permite
consultar ni adoptar el rol de otra cuenta.

Matriz efectiva:

| Recurso | Owner/Admin | Secretaría/Médico/No mapeado | Anon |
| --- | --- | --- | --- |
| Categorías | SELECT, INSERT, UPDATE | Sin acceso | Sin acceso |
| Egresos | SELECT, INSERT, UPDATE | Sin acceso | Sin acceso |
| Plantillas | SELECT, INSERT, UPDATE | Sin acceso | Sin acceso |
| Audit events | SELECT | Sin acceso | Sin acceso |
| Roles backend | Sin acceso cliente | Sin acceso cliente | Sin acceso |

No se concede `DELETE` sobre tablas financieras. Audit tampoco concede INSERT o
UPDATE. No se usa ni se debe exponer `service_role` en el frontend.

## Aplicación futura: orden exacto

1. Revisar y aprobar la migración; confirmar que el ambiente objetivo tiene un
   backup recuperable y probar primero en un proyecto de staging equivalente.
2. Inventariar las cuentas de `auth.users` y preparar, fuera del frontend, el
   mapeo verificado `user_id -> base_role`. No inferirlo sólo del prefijo de email.
3. Aplicar **una sola vez**
   `supabase/migrations/20260815193000_finanzas_v5_schema.sql` con el mecanismo
   normal de migraciones y un rol de despliegue confiable. El archivo abre una
   transacción; cualquier error revierte toda la etapa.
4. Antes de insertar roles, verificar tablas, FKs, constraints, índices,
   triggers, RLS, policies y grants. Confirmar que `anon` y todo usuario aún no
   mapeado reciben denegación.
5. Insertar los mapeos verificados en `cardiolink_user_roles` mediante el canal
   backend confiable. Este paso es deliberadamente independiente y no está en
   la migración.
6. Probar con cuentas reales de cada rol: owner/admin pueden las operaciones
   declaradas; secretaria/médico no pueden leer ni mutar nada financiero.
7. Probar concurrencia con dos revisiones iguales, duplicados de source y
   plantilla/mes, transiciones de estado, anulación, audit append-only e intento
   de DELETE.
8. Recién después implementar el CRUD frontend, siempre filtrando updates por
   `id + revision`. Mantener sincronizado el rol backend cuando se cambie el rol
   de un usuario en CardioLink, hasta que el backend sea la fuente canónica.

## Rollback propuesto

Antes de tener datos reales, el rollback puede ejecutarse en una transacción y
en este orden: eliminar `cardiolink_finance_audit_events`,
`cardiolink_finance_expenses`, `cardiolink_finance_recurring_templates` y
`cardiolink_finance_categories`; eliminar `cardiolink_has_finance_access()`;
eliminar `cardiolink_user_roles`; finalmente eliminar las funciones de triggers
de esta migración. Al eliminar tablas también desaparecen sus policies y
triggers.

Guion propuesto para ese caso, sujeto a revisión antes de ejecutarlo:

```sql
begin;
drop table if exists public.cardiolink_finance_audit_events;
drop table if exists public.cardiolink_finance_expenses;
drop table if exists public.cardiolink_finance_recurring_templates;
drop table if exists public.cardiolink_finance_categories;
drop function if exists public.cardiolink_has_finance_access();
drop table if exists public.cardiolink_user_roles;
drop function if exists public.cardiolink_finance_write_audit_event();
drop function if exists public.cardiolink_finance_prevent_audit_mutation();
drop function if exists public.cardiolink_finance_enforce_expense_lifecycle();
drop function if exists public.cardiolink_finance_protect_system_key();
drop function if exists public.cardiolink_finance_enforce_category_hierarchy();
drop function if exists public.cardiolink_finance_stamp_row();
commit;
```

No usa `CASCADE`: si una etapa futura ya creó dependencias, el rollback debe
detenerse en lugar de borrarlas implícitamente.

El índice `cardiolink_finance_recurring_active_identity_uq` pertenece a
`cardiolink_finance_recurring_templates` y se elimina automáticamente cuando el
rollback elimina esa tabla; no requiere un `DROP INDEX` separado.

Después de registrar datos reales, no se debe hacer un rollback destructivo sin
exportación y aprobación explícita. La reversión segura del frontend sería dejar
el esquema y sus datos intactos, retirar el acceso a la funcionalidad y preparar
una migración posterior. Borrar o recrear tablas perdería movimientos y
auditoría.

## Riesgos pendientes

- El alta, baja o cambio de roles requiere una operación backend sincronizada;
  cambiar sólo `data.roles`/`data.usuarios` no cambia RLS.
- Los cambios de `cardiolink_user_roles` no entran en el audit financiero de
  movimientos; deben hacerse por un canal backend con log administrativo.
- Hasta completar el mapeo de `auth.users.id`, la denegación por defecto también
  bloquea a dueño/admin; es intencional.
- El trigger serializa y limita la profundidad del árbol, pero cambios masivos
  de estructura igualmente deben probarse en staging.
- `professional_id` conserva identificadores textuales actuales y no tiene FK
  porque hoy no existe una tabla backend canónica de profesionales.
- Los UUID determinísticos del seed deben considerarse parte estable del
  contrato y no reutilizarse.
- Los índices únicos excluyen anulados: permiten un reemplazo corregido, por lo
  que los reportes futuros deben excluir `status='voided'` de sus totales.

La migración es deliberadamente de una sola ejecución, no un script de
reconciliación. Supabase debe registrar que ya fue aplicada; no debe volver a
ejecutarse manualmente sobre un esquema parcial.
