# Finanzas 5 — conexión local a CardioLink Staging

Estado: Etapa 3A. Esta conexión existe sólo para probar el frontend local contra
el esquema ya validado de CardioLink Staging. No cambia el cliente Supabase
principal ni habilita Finanzas 5 en el sitio publicado.

En `index.html`, la biblioteca pública de Supabase se carga primero,
`cardiolink-finanzas-v5.js` se carga después y `app.js` queda a continuación.
Ese orden permite que `app.js` conecte una sola vez el proveedor canónico de
ingresos sin que el módulo de Finanzas 5 redefina lógica ni funciones globales.

## Barreras de seguridad

- El módulo sólo se monta en `localhost`, `127.0.0.1`, `::1` o `file:`.
- Fuera de esos orígenes no crea el cliente de Finanzas 5 ni consulta sus tablas.
- Sin configuración explícita tampoco crea un cliente ni intenta conectarse.
- El cliente es independiente del `supabaseClient` de producción. Su sesión
  Auth no se persiste: vive sólo en memoria y se detiene si el perfil frontend
  deja de ser Dueño/Admin.
- La URL configurada debe pertenecer a un proyecto diferente del cliente
  principal. El módulo rechaza una coincidencia.
- Sólo admite una Supabase **publishable key** (`sb_publishable_...`) o una clave
  JWT legacy cuyo rol sea `anon`. Rechaza claves `sb_secret_`, `service_role` y
  cualquier JWT con otro rol.
- La publishable key y la URL no se incluyen en el repositorio. Se guardan en el
  `localStorage` del navegador local. Por eso no fue necesario agregar un archivo
  a `.gitignore`.
- La contraseña se entrega directamente a Supabase Auth y no se guarda en la
  configuración del módulo.
- Después del login, el frontend exige que
  `cardiolink_has_finance_access()` retorne `true`. RLS sigue siendo la frontera
  efectiva para tablas y auditoría.

## Obtener URL y clave pública de Staging

Primero seleccionar explícitamente el proyecto **CardioLink Staging** en
Supabase Dashboard. No copiar valores desde el proyecto de producción.

### A. Project URL

En la interfaz actual de Supabase:

1. Abrir **Integrations → Data API** en la barra lateral del proyecto Staging.
2. Copiar **Project URL** / **API URL**, con formato
   `https://PROJECT-REF.supabase.co`.
3. No copiar el connection string de Postgres ni una URL de Database.

La misma Project URL también aparece en el diálogo **Connect** del proyecto.
Supabase documenta la ubicación actual del Data API en
[Data REST API](https://supabase.com/docs/guides/api).

### B. Publishable key

1. Abrir **Settings → API Keys** en el proyecto Staging.
2. En **Publishable and secret API keys**, copiar la **Publishable key** para
   cliente, normalmente con prefijo `sb_publishable_`.
3. Si el proyecto conserva sólo claves legacy, abrir **Legacy API Keys** y
   copiar exclusivamente la clave **anon**.

Para el navegador usar siempre `publishable` o, como compatibilidad legacy,
`anon`. **No copiar ni usar Secret key, `sb_secret_` o `service_role`**: tienen
privilegios backend y no pertenecen a este flujo. La distinción y las pantallas
actuales están descriptas en
[Understanding API keys](https://supabase.com/docs/guides/getting-started/api-keys).

No pegar ninguno de estos valores en archivos del repositorio, documentación,
issues o capturas. La configuración se ingresa únicamente en la consola del
navegador local mediante el comando de la sección siguiente.

## Bootstrap backend requerido

Antes de abrir la pantalla, la cuenta Auth del Owner de Staging debe existir en
`cardiolink_user_roles` con:

- `user_id` igual al UUID real de `auth.users` en Staging;
- `base_role = 'owner'`;
- `active = true`.

Si falta ese mapeo, `cardiolink_has_finance_access()` debe devolver `false` y el
frontend no puede corregirlo. La preparación y validación backend se realiza por
el canal confiable ya definido. Consultar
[FINANZAS_V5.md](FINANZAS_V5.md) para la secuencia completa de aplicación,
bootstrap de roles y pruebas RLS antes de continuar.

## Activación

1. Levantar esta carpeta con un servidor local. Por ejemplo:

   ```bash
   python3 -m http.server 4173 --bind 127.0.0.1
   ```

2. Abrir `http://127.0.0.1:4173/` e iniciar sesión normalmente en CardioLink con
   un perfil frontend Dueño/Admin. Finanzas 5 no se muestra a Secretaría ni
   Médico.

3. En la consola del navegador local, ejecutar reemplazando ambos marcadores por
   los valores públicos del proyecto CardioLink Staging:

   ```js
   CardioLinkFinanzasV5.configurarStagingLocal({
     url: 'https://PROJECT-REF.supabase.co',
     publishableKey: 'sb_publishable_REEMPLAZAR'
   });
   ```

   Para un proyecto que todavía use la clave pública legacy, `publishableKey`
   puede recibir la clave `anon` JWT. Nunca usar `service_role`.

4. Recargar la página y abrir **Caja / reportes**. La sección debe mostrar, de
   forma inequívoca, la insignia naranja **STAGING LOCAL** y el host del proyecto.

5. Iniciar la sesión independiente dentro de Finanzas 5 con el OWNER de
   Staging. Esta sesión no reemplaza ni reutiliza la sesión Supabase principal y
   debe iniciarse nuevamente después de recargar la página.

El estado puede verificarse sin revelar la clave:

```js
CardioLinkFinanzasV5.estadoStagingLocal()
```

La respuesta muestra únicamente si la conexión está activa, URL, estado de
sesión y resultado del permiso backend.

## Prueba RLS con Secretaría y Médico

Para esta prueba, CardioLink local debe permanecer iniciado con un perfil
frontend **Dueño/Admin**. Ese rol es necesario solamente para que la sección
Finanzas 5 quede montada.

Dentro del login independiente de **Finanzas 5 Staging**:

1. cerrar cualquier sesión Staging anterior;
2. ingresar con la cuenta Auth de Staging mapeada como `secretaria`;
3. comprobar que el login Auth puede completarse pero el RPC financiero deniega
   el acceso, se muestra el error claro y no aparece ningún resumen/listado;
4. cerrar esa sesión y repetir con la cuenta mapeada como `medico`.

Esto prueba el backend RLS y el mapeo de `cardiolink_user_roles`; no reemplaza la
prueba separada de visibilidad frontend iniciando la app principal con cada rol.

## Verificar que no se escribió en producción

Antes y después de crear un egreso de prueba:

1. confirmar la insignia naranja **STAGING LOCAL**;
2. comparar el host mostrado en **Proyecto aislado** con la Project URL copiada
   desde CardioLink Staging;
3. abrir DevTools → **Network**, filtrar por `cardiolink_finance` y confirmar que
   las requests a `cardiolink_finance_expenses`, categorías, auditoría y al RPC
   `cardiolink_has_finance_access` apuntan al host de Staging;
4. recordar que la app principal puede efectuar sus requests normales contra
   producción: la comprobación debe concentrarse en las requests financieras
   anteriores;
5. opcionalmente, abrir en modo lectura **Table Editor →
   cardiolink_finance_expenses** del proyecto de producción y buscar el concepto
   único usado en QA. No debe existir allí.

No se necesita pedir, copiar ni ingresar ninguna credencial de producción para
los pasos 1 a 4.

## Concurrencia: QA manual obligatorio

El reconocimiento de un `UPDATE`/anulación que devuelve cero filas está
acoplado a la respuesta de Supabase y no tiene un helper puro independiente.
Para evitar un mock artificial del CRUD, este caso continúa como prueba manual:

1. abrir el mismo egreso no anulado en dos pestañas locales e iniciar la sesión
   Staging independiente en ambas;
2. guardar una edición en la primera pestaña para incrementar `revision`;
3. intentar guardar desde la segunda con la revisión anterior;
4. confirmar que no sobrescribe y muestra exactamente: “Este egreso fue
   modificado desde otra sesión. Actualizá la información antes de volver a
   guardar.”;
5. repetir dejando una anulación con revisión obsoleta y confirmar el mismo
   rechazo.

## Desactivación

Desde la consola del mismo origen local:

```js
await CardioLinkFinanzasV5.desactivarStagingLocal()
```

Esto cierra la sesión local de Staging, elimina la configuración del
`localStorage`, destruye el cliente aislado y limpia los datos financieros de la
vista. Al recargar, Finanzas 5 vuelve a **DESACTIVADO** y no realiza consultas.

Si se cambia entre `localhost` y `127.0.0.1`, recordar que cada host tiene un
`localStorage` distinto y debe activarse/desactivarse por separado.

## Qué debe verse en una prueba válida

- insignia **STAGING LOCAL** y host correcto antes de ingresar;
- cuenta Auth de Staging visible después del login;
- acceso completo sólo si el RPC backend confirma owner/admin;
- mensaje claro y ninguna lista/resumen parcial ante 401/403 o permiso falso;
- Caja de Finanzas 4 intacta, arriba de la nueva sección;
- egresos anulados visibles, fuera de los totales y sin acciones de edición;
- historial legible, sin exponer los snapshots JSON crudos.

## Despliegue publicado

No hay pasos de activación para producción en esta etapa. Aunque estos archivos
se publiquen, el guard de origen local hace que Finanzas 5 no se monte, no cree
su cliente y no consulte `cardiolink_finance_*` fuera del entorno local.
