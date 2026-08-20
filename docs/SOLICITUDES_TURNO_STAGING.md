# Solicitudes de turno — conexión local a CardioLink Staging

Estado: Fase 2B. Esta conexión existe sólo para probar la bandeja interna de
Solicitudes de turno en el frontend local contra el esquema ya validado de
`cardiolink_appointment_requests` en CardioLink Staging. No cambia el cliente
Supabase principal ni habilita nada nuevo en el sitio publicado.

En `index.html`, la biblioteca pública de Supabase se carga primero,
`cardiolink-finanzas-v5.js` y `cardiolink-solicitudes-turno.js` se cargan
después (en ese orden) y `app.js` queda a continuación. `app.js` conecta el
cliente principal una sola vez a cada módulo; ninguno de los dos redefine
funciones globales existentes.

## Barreras de seguridad

Mismo patrón que Finanzas 5 (ver [FINANZAS_V5_STAGING.md](FINANZAS_V5_STAGING.md)),
aplicado de forma independiente a este módulo:

- El módulo sólo activa Staging Local en `localhost`, `127.0.0.1`, `::1` o
  `file:`. Fuera de esos orígenes ignora cualquier configuración guardada y
  usa siempre el cliente principal de producción.
- Sin `configurarStagingLocal()` explícito, tampoco crea un cliente ni
  intenta conectarse: la sección queda en estado **DESACTIVADO**.
- El cliente de Staging es independiente del `supabaseClient` de producción.
  Su sesión Auth no se persiste: vive sólo en memoria de esa pestaña y se
  detiene si el perfil frontend deja de ser Owner/Admin/Secretaría.
- La URL configurada debe pertenecer a un proyecto diferente del cliente
  principal; el módulo rechaza una coincidencia.
- Sólo admite una Supabase **publishable key** (`sb_publishable_...`) o una
  clave JWT legacy cuyo rol sea `anon`. Rechaza `sb_secret_`, `service_role`
  y cualquier JWT con otro rol.
- La publishable key y la URL se guardan únicamente en el `localStorage` del
  navegador local, bajo una clave propia
  (`cardiolink_solicitudes_turno_staging_config_v1`), distinta de la de
  Finanzas 5. Nunca se escriben en el repositorio.
- Después del login, el frontend exige que
  `cardiolink_has_appointment_requests_access()` retorne `true`. Esta función
  es propia de esta tabla y **no reutiliza** `cardiolink_has_finance_access()`;
  RLS sigue siendo la frontera efectiva.
- Producción online (el sitio publicado) sigue usando exclusivamente el
  cliente principal inyectado por `app.js`; la ruta de Staging queda inerte
  ahí.

## Obtener URL y clave pública de Staging

Igual que en Finanzas 5: seleccionar el proyecto **CardioLink Staging** en
Supabase Dashboard (nunca el de producción) y copiar la **Project URL** y la
**Publishable key** (o `anon` legacy). Ver el detalle paso a paso en
[FINANZAS_V5_STAGING.md § Obtener URL y clave pública de Staging](FINANZAS_V5_STAGING.md#obtener-url-y-clave-pública-de-staging).
No pegar ninguno de estos valores en archivos del repositorio.

## Bootstrap backend requerido

Las cuentas Auth de Staging para Owner, Admin y Secretaría deben existir en
`cardiolink_user_roles` (la misma tabla que usa Finanzas 5) con:

- `user_id` igual al UUID real de `auth.users` en Staging;
- `base_role` en `owner`, `admin` o `secretaria`;
- `active = true`.

Si esas cuentas ya están mapeadas para probar Finanzas 5 en el mismo
Staging, ya cumplen este requisito (misma tabla). La diferencia es que
`cardiolink_has_appointment_requests_access()` también acepta
`secretaria`, mientras que la función de Finanzas 5 no. Una cuenta mapeada
como `medico` debe seguir sin acceso: ni al RPC de esta tabla ni a las
policies de `cardiolink_appointment_requests`.

## Paciente de prueba (obligatorio, sólo en Staging)

`cardiolink_appointment_requests.patient_id` tiene una FK a
`cardiolink_pacientes(id)`. Antes de crear una solicitud ficticia hace falta
un paciente igual de ficticio, creado **exclusivamente en Staging**, nunca en
Producción.

En el **SQL Editor de Supabase Staging** (nunca en Producción):

```sql
-- Crear (sólo en Staging)
insert into public.cardiolink_pacientes
  (id, nombre_completo, dni, telefono, activo, actualizado_en)
values
  ('TEST-SOL-TURNO-PACIENTE-1', 'TEST QA Solicitudes de turno', 'TEST00000001', '3410000000', true, now());
```

```sql
-- Eliminar después de la QA (sólo en Staging)
delete from public.cardiolink_appointment_requests where patient_id = 'TEST-SOL-TURNO-PACIENTE-1';
delete from public.cardiolink_pacientes where id = 'TEST-SOL-TURNO-PACIENTE-1';
```

El prefijo `TEST-` en el `id` y el nombre `TEST QA Solicitudes de turno`
hacen que la fila sea inconfundible en cualquier listado de pacientes de
Staging mientras dure la prueba.

## Solicitud de turno ficticia

La bandeja de esta fase sólo **consume** solicitudes (no tiene un formulario
de alta: en producción llegarán desde un origen externo en una fase
posterior). Para la QA local, cargar la fila ficticia directamente en
**Staging**, también desde el SQL Editor:

```sql
-- Crear (sólo en Staging)
insert into public.cardiolink_appointment_requests
  (patient_id, requested_service, contact_phone, message, source)
values
  ('TEST-SOL-TURNO-PACIENTE-1', 'Consulta de prueba QA', '3410000000', 'Solicitud ficticia para QA de Fase 2B.', 'direct');
```

La fila queda con `status = 'new'`, `revision = 1` y `managed_by`/`managed_at`
en `null` por los valores por defecto y el trigger de la migración. El
`delete` de la sección anterior también la elimina al terminar.

## Activación

1. Levantar esta carpeta con un servidor local, por ejemplo:

   ```bash
   python3 -m http.server 4173 --bind 127.0.0.1
   ```

2. Abrir `http://127.0.0.1:4173/` e iniciar sesión normalmente en CardioLink
   con un perfil frontend Owner, Admin o Secretaría (Médico no ve la
   sección).

3. En la consola del navegador local:

   ```js
   CardioLinkSolicitudesTurno.configurarStagingLocal({
     url: 'https://PROJECT-REF.supabase.co',
     publishableKey: 'sb_publishable_REEMPLAZAR'
   });
   ```

4. Recargar la página y abrir **Solicitudes de turno**. Debe mostrarse la
   insignia naranja **STAGING LOCAL** y el host del proyecto en **Proyecto
   aislado**.

5. Completar el formulario **Sesión independiente de Staging** con la cuenta
   Auth de Staging correspondiente al rol que se está probando. Esta sesión
   no reemplaza la sesión principal de CardioLink y no sobrevive una
   recarga.

Estado sin revelar la clave:

```js
CardioLinkSolicitudesTurno.estadoStagingLocal()
```

## QA — Owner

1. Con Staging Local activo y logueado como Owner de Staging, entrar a
   **Solicitudes de turno**.
2. Confirmar que la bandeja muestra la solicitud ficticia (fecha, paciente
   `TEST QA Solicitudes de turno`, DNI `TEST00000001`, teléfono, prestación,
   mensaje, estado **Nueva**).
3. Pulsar **Marcar "En gestión"** y confirmar que el estado pasa a **En
   gestión** sin recargar manualmente.
4. Pulsar **Abrir carga de turno** y confirmar:
   - se abre la sección **Carga** con el paciente de prueba ya cargado
     (mismo flujo que "Nueva atención" desde la ficha del paciente);
   - no se crea ninguna atención automáticamente (no hay ningún guardado
     disparado por este botón);
   - la solicitud sigue en **En gestión**, no pasa a **Turno asignado** por
     sí sola.

## QA — Secretaría

1. Repetir el login independiente de Staging con la cuenta Auth mapeada como
   `secretaria` (mismo host, misma pestaña o una nueva; sólo cambia el perfil
   frontend CardioLink a Secretaría para que la sección esté visible).
2. Confirmar que ve la bandeja igual que Owner.
3. Confirmar que puede cambiar estados (por ejemplo, dejar la solicitud en
   **Turno asignado** o **Cerrada**) y abrir **Carga de turno**.
4. Confirmar que Secretaría **no** gana acceso a HC ni a Finanzas 5: esta
   fase no modifica `seccionPermitida` para esos módulos, sólo agregó
   `'solicitudesTurno'` al arreglo ya existente de Secretaría.

## QA — Médico

1. Iniciar CardioLink con un perfil frontend Médico.
2. Confirmar que **no aparece** el botón de nav "Solicitudes de turno" ni la
   sección en pantalla.
3. Confirmar el rechazo de backend, no sólo el de UI: en la consola del
   navegador, con el perfil Médico activo,

   ```js
   await CardioLinkSolicitudesTurno.frontendPuedeAcceder() // false
   ```

   y, si se fuerza el montaje manipulando el DOM o el estado de rol
   (simulando manipulación de UI), la llamada real al RPC
   `cardiolink_has_appointment_requests_access()` en Staging debe devolver
   `false` para esa cuenta, y `RLS` debe rechazar cualquier `select` directo
   a `cardiolink_appointment_requests` con esa sesión. Esto se puede
   confirmar iniciando sesión Staging con una cuenta mapeada como `medico`
   dentro del formulario de Solicitudes de turno (forzando temporalmente el
   perfil frontend a Owner/Admin sólo para que la sección quede montada, tal
   como documenta Finanzas 5 para esta misma prueba): el login Auth se
   completa, pero el RPC deniega el acceso y no aparece ningún listado.

## Concurrencia

1. Con la solicitud ficticia en estado **Nueva**, abrir dos pestañas locales
   e iniciar la sesión Staging independiente (Owner o Secretaría) en ambas.
2. En la primera pestaña, pulsar **Marcar "En gestión"** (esto incrementa
   `revision` en el backend).
3. En la segunda pestaña, sin refrescar la lista, pulsar cualquier acción de
   cambio de estado sobre la misma fila (por ejemplo **Cerrar**).
4. Confirmar que el `update` de la segunda pestaña no sobrescribe: la
   condición `.eq('id', ...).eq('revision', ...)` no encuentra la fila con
   la `revision` vieja, se detectan 0 filas afectadas y se muestra
   exactamente: "Esta solicitud fue modificada desde otra sesión. Actualizá
   la lista antes de volver a guardar."
5. Actualizar la lista en la segunda pestaña y confirmar que ahora sí puede
   operar sobre el estado real y vigente.

## Verificar que no se escribió en producción

1. Confirmar la insignia naranja **STAGING LOCAL** y el host mostrado en
   **Proyecto aislado** contra la Project URL copiada desde CardioLink
   Staging.
2. Abrir DevTools → **Network**, filtrar por `cardiolink_appointment_requests`
   y por el RPC `cardiolink_has_appointment_requests_access`, y confirmar que
   todas esas requests apuntan al host de Staging.
3. La app principal sigue haciendo sus requests normales contra producción;
   la comprobación debe concentrarse sólo en las requests de esta tabla.
4. Opcionalmente, abrir en modo lectura **Table Editor →
   cardiolink_appointment_requests** del proyecto de producción y confirmar
   que no existe ninguna fila con el paciente `TEST-SOL-TURNO-PACIENTE-1`.

## Desactivación

Desde la consola del mismo origen local:

```js
await CardioLinkSolicitudesTurno.desactivarStagingLocal()
```

Esto cierra la sesión local de Staging, elimina la configuración del
`localStorage`, destruye el cliente aislado y limpia los datos de la vista.
Al recargar, la sección vuelve a **DESACTIVADO** y no realiza consultas.

También cerrar sesión sin desactivar la configuración (útil para pasar de
una cuenta de prueba a otra dentro del mismo rol de QA) con el botón
**Cerrar sesión Staging** dentro de la bandeja.

Si se cambia entre `localhost` y `127.0.0.1`, recordar que cada host tiene un
`localStorage` distinto y debe activarse/desactivarse por separado.

## Limpieza de datos ficticios

No olvidar correr, sólo en Staging, el `delete` de la sección **Paciente de
prueba** al terminar la QA. No queda ningún paso automático que lo haga por
la sección misma: la bandeja no expone una acción de borrado (por diseño, no
hay DELETE desde el cliente en ningún flujo de esta tabla).
