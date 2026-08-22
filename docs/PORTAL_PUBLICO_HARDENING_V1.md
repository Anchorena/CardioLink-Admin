# CardioLink — Portal Público: Hardening V1

Estado: **código listo, sin desplegar**. No se ejecutó SQL, no se tocó
Producción ni Staging, no se creó ninguna tabla nueva. Este documento
complementa [PORTAL_PUBLICO_V1.md](PORTAL_PUBLICO_V1.md) (que describe el
flujo funcional, sin cambios en esta etapa) con lo necesario para poder
publicar el portal de forma segura.

## 1. Anti-bots / Turnstile

**Arquitectura**: Cloudflare Turnstile protege las tres acciones que tocan
datos de pacientes — `check-dni`, `registro`, `solicitud-turno` — con un
token nuevo por envío, verificado server-side.

- **Frontend** ([portal/portal.js](../portal/portal.js)): cada uno de los
  tres formularios (DNI, alta, solicitud) tiene un contenedor
  `<div data-turnstile-container>` invisible (`size: 'invisible'`, sin
  casilla ni UI — no cambia la experiencia visual). Al montarse el paso,
  `montarTurnstileSiCorresponde()` renderiza el widget con
  `execution: 'execute'` (el desafío no corre solo: hay que pedirlo). Al
  enviar el formulario, `obtenerTokenTurnstile()` ejecuta el desafío y
  devuelve una Promise con el token — **antes** de tocar `estado.cargando`/
  `render()`, porque `render()` reemplaza todo el HTML del paso (incluido
  el contenedor ya montado). El token viaja como `turnstileToken` en el
  body de cada llamada al gateway.
- **Backend** ([supabase/functions/portal-gateway/index.ts](../supabase/functions/portal-gateway/index.ts)):
  antes de despachar a `check-dni`/`registro`/`solicitud-turno`,
  `verificarTurnstile(token, ip)` llama a
  `https://challenges.cloudflare.com/turnstile/v0/siteverify` con el
  secret. Sin `success: true` se rechaza con 403. **Sin
  `TURNSTILE_SECRET_KEY` configurada, se rechaza igual (fail-closed)**: no
  hay ningún modo que deje pasar sin verificación.

**Secrets involucrados** (ninguno creado ni usado todavía):
- `TURNSTILE_SECRET_KEY` — server-side únicamente, como secret de la Edge
  Function. Nunca en el repositorio, nunca en el frontend.
- La *sitekey* (pública, no secreta, `TURNSTILE_SITEKEY_PRODUCCION_DEFAULT`
  en `portal.js`) sí puede vivir en el código — así funciona Turnstile por
  diseño.

**Modo QA aislado** (localhost/Staging): Cloudflare documenta públicamente
[claves de test](https://developers.cloudflare.com/turnstile/troubleshooting/testing/)
que no son secretas ni exclusivas de este proyecto:
- sitekey `1x00000000000000000000BB` ("always passes", **widget invisible**
  — el widget implementado acá usa `size: 'invisible'`, así que corresponde
  esta sitekey y no `1x00000000000000000000AA`, que es la de test del
  widget visible con casilla) — ya hardcodeada en `portal.js`, se usa
  automáticamente en local vía `esEntornoLocal()` (el mismo criterio que ya
  decide el gateway de Staging).
- secret `1x0000000000000000000000000000000AA` (par "always passes",
  válido para cualquier sitekey de test) — se configura como
  `TURNSTILE_SECRET_KEY` en el proyecto de **Staging** al desplegar, nunca
  en Producción.

El código de verificación es idéntico en los dos ambientes: lo único que
cambia es el valor de la env var. No hay una rama de código tipo "si es
QA, saltear Turnstile" — eso sería un backdoor si algún día esa condición
se evalúa mal en Producción.

## 2. Enumeración de DNI

`check-dni` nunca devolvió PII (sólo `{ ok, existe }`) — sin cambios ahí.
Lo nuevo en esta etapa: Turnstile (arriba) encarece el abuso automatizado
por request, y la propuesta de rate limit (abajo) lo limita por IP/tiempo.
Los dos son complementarios: Turnstile filtra bots; el rate limit acota a
un humano (o un bot que resuelva Turnstile) que insista.

## 3. Rate limit — propuesta, sin crear infraestructura

No se creó ninguna tabla ni servicio. Propuesta mínima para cuando se
decida implementarla:

**Opción recomendada — tabla propia, reutilizando el mismo `service_role`
que ya usa el gateway (sin infraestructura nueva):**

```sql
-- PROPUESTA, NO EJECUTAR. Ejemplo de forma, no una migración final.
create table public.cardiolink_portal_rate_limit (
  clave text primary key,              -- '<accion>:<ip>', ej. 'check-dni:203.0.113.5'
  ventana_inicio timestamptz not null,
  intentos integer not null default 1
);
alter table public.cardiolink_portal_rate_limit enable row level security;
-- Sin policies para authenticated/anon: sólo service_role la toca (bypasea RLS).
```

Lógica en el gateway (pseudocódigo, no implementado): por cada acción
protegida, `clave = accion + ':' + ip` (IP desde `cf-connecting-ip`, ya
disponible — ver Turnstile arriba); upsert: si no hay fila o
`ventana_inicio` es más vieja que la ventana elegida (por ejemplo 10
minutos), reiniciar (`ventana_inicio = now(), intentos = 1`); si no,
incrementar `intentos`. Si `intentos` supera el límite (por ejemplo 20 por
IP por acción cada 10 minutos), responder 429 sin tocar
`cardiolink_pacientes` ni `cardiolink_appointment_requests`.

**Alternativas**, mencionadas pero no elegidas para esta propuesta mínima:
- **Deno KV** (si está habilitado en el proyecto): mismo conteo por
  ventana, sin tabla de Postgres, con expiración nativa (`expireIn`) — más
  simple de mantener, pero depende de una feature que hay que confirmar
  que esté disponible en el plan del proyecto.
- **Cloudflare** como primera línea, si el dominio público queda detrás de
  Cloudflare (WAF / rate limiting rules a nivel de borde, antes de que la
  request llegue a la Edge Function) — complementario, no reemplaza la
  protección en la función.

Ninguna de estas tres se implementó: es una decisión de infraestructura
pendiente, documentada para cuando se decida.

## 4. Producción vs Staging

Sin cambios de comportamiento — se reconfirma lo que ya hacía
`esEntornoLocal()`/`gatewayUrl()` en `portal.js` (Fase Staging Local
anterior): `localhost`/`127.0.0.1`/`::1` usan automáticamente el gateway
de Staging, cualquier otro origen usa la URL de Producción configurada.
Lo nuevo en esta etapa es que la MISMA función `esEntornoLocal()` ahora
también decide la sitekey de Turnstile (QA vs Producción), con el mismo
criterio — un solo lugar decide "¿estoy en local?", no dos.

## 5. CORS

**Antes**: `Access-Control-Allow-Origin: '*'` fijo (cualquier sitio podía
llamar al gateway).

**Ahora** ([index.ts](../supabase/functions/portal-gateway/index.ts)):
`corsHeadersPara(origen)` calcula el header en cada request. Se permite si
el `Origin` de la request es:
- un origen local (`http://localhost`, `http://127.0.0.1`, `http://[::1]`,
  con cualquier puerto) — **siempre**, en cualquier ambiente, para poder
  probar contra Staging desde acá;
- o está en `PORTAL_ALLOWED_ORIGINS` (env var nueva, lista separada por
  comas con el/los dominios publicados reales — todavía sin configurar,
  no hay dominio real publicado).

Si el origen no está permitido, la respuesta no lleva
`Access-Control-Allow-Origin`: el navegador la bloquea del lado del
cliente. `Vary: Origin` para que no se cachee una respuesta CORS para el
origen equivocado.

**Pendiente antes de Producción**: configurar `PORTAL_ALLOWED_ORIGINS` con
el dominio real del portal publicado.

## 6. Logs y errores

- `console.log('portal-gateway', accion)` — sin cambios, ya era sólo el
  nombre de la acción.
- `console.error(...)` — **corregido**: antes logueaba `error.message`
  completo, que para un error de Postgres (por ejemplo un
  `unique_violation` de `dni_normalizado`) puede incluir el valor real del
  campo duplicado en el texto del mensaje. Ahora `logErrorSeguro(accion,
  error)` sólo loguea el **código** de error (`error.code`, ej. `'23505'`
  o `'desconocido'`), nunca el mensaje ni los detalles.
- Las respuestas de error al cliente siguen siendo genéricas
  (`errorResponse(...)`), salvo los mensajes de validación de
  `logica.js`, que son textos fijos sin datos del usuario ("Falta el
  nombre.", "DNI inválido.", etc. — nunca interpolan el valor ingresado).

## 7. Protecciones existentes — confirmadas, sin cambios de código

- **Doble envío no duplica solicitud**: ventana de 2 minutos por
  `patient_id` + `status = 'new'` en `manejarSolicitud` — intacta.
- **Carrera de alta no duplica DNI**: `unique_violation` (23505) en
  `dni_normalizado` reutiliza el paciente existente en vez de fallar —
  intacta.
- **Frontend no puede enviar `patient_id`**: `validarAlta`/`validarSolicitud`
  nunca aceptan ese campo; el paciente siempre se resuelve server-side por
  DNI — intacta.
- **Profesional público deshabilitado**: `requested_professional_id`/
  `requested_professional_name` quedan `null` siempre en
  `manejarSolicitud` — intacta.
- **Comentarios deshabilitados**: `message` queda `null` siempre — intacta.
- **Prestación y cobertura, catálogos cerrados**: `PRESTACIONES_PUBLICAS_V1`
  (validada en `index.ts`) y `COBERTURAS_VALIDAS` (validada en
  `logica.js`) — intactas.
- **Teléfono resuelto server-side**: `buscarPacienteParaSolicitud` trae el
  teléfono ya guardado en el alta; `validarSolicitud` ya no acepta un
  campo teléfono — intacta.

## Archivos modificados en esta etapa

- [portal/portal.js](../portal/portal.js) — Turnstile frontend (sitekey,
  montaje del widget invisible, obtención de token, token agregado a las
  tres llamadas al gateway). Flujo DNI/alta/solicitud/cobertura/
  prestaciones sin cambios.
- [portal/index.html](../portal/index.html) — script de Turnstile
  (`challenges.cloudflare.com/turnstile/v0/api.js`, `async defer`),
  cache-buster de `portal.js` a `?v=3`.
- [supabase/functions/portal-gateway/index.ts](../supabase/functions/portal-gateway/index.ts)
  — verificación Turnstile server-side, CORS por origen configurable, log
  de errores sin PII. **No desplegado.**
- Tests: [tests/portal-frontend.js](../tests/portal-frontend.js),
  [tests/portal-gateway-logica.js](../tests/portal-gateway-logica.js).
- Este documento (nuevo).

**Sin cambios** en `portal/contenido-publico.js`,
`supabase/functions/portal-gateway/logica.js`, ninguna migración,
`cardiolink-solicitudes-turno.js`, ni nada del Admin/HC/Finanzas.

## Cómo hacer QA en Staging (una vez desplegado)

1. Desplegar `portal-gateway` a Staging con
   `TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA` (clave de
   test pública de Cloudflare, no la real) y sin `PORTAL_ALLOWED_ORIGINS`
   (localhost ya queda permitido siempre).
2. Servir `portal/` local (`python3 -m http.server 4174 --directory
   portal`), abrir `http://127.0.0.1:4174/`.
3. Completar el flujo DNI → alta o solicitud. La sitekey de test invisible
   `1x00000000000000000000BB` siempre aprueba: el token debería viajar
   igual y la Edge Function debería aceptarlo (par de claves de test
   emparejado).
4. Confirmar en DevTools → Network que la respuesta de OPTIONS/POST trae
   `Access-Control-Allow-Origin` con el origen local exacto (no `*`).
5. Probar con un token vacío/inventado (por ejemplo, llamando al gateway
   directo con `curl`/Postman sin pasar por el widget) y confirmar que
   responde 403 "No se pudo verificar que sos una persona."
6. Repetir toda la secuencia de QA ya documentada en
   [PORTAL_PUBLICO_V1.md](PORTAL_PUBLICO_V1.md) (DNI nuevo/existente,
   dedup de doble envío, etc.) para confirmar que el flujo funcional no
   cambió.

## Qué falta antes de Producción

1. Registrar un sitio real en Cloudflare Turnstile, obtener sitekey +
   secret reales; configurar `CARDIOLINK_TURNSTILE_SITEKEY` (o reemplazar
   `TURNSTILE_SITEKEY_PRODUCCION_DEFAULT`) y `TURNSTILE_SECRET_KEY` (real)
   como secret de la Edge Function de Producción.
2. Decidir e implementar el rate limit (sección 3) — sigue pendiente,
   documentado pero no construido.
3. Configurar `PORTAL_ALLOWED_ORIGINS` con el dominio real publicado.
4. Todo lo que ya listaba [PORTAL_PUBLICO_V1.md](PORTAL_PUBLICO_V1.md):
   revisar `index.ts` con Deno/TypeScript real (este entorno no los
   tiene), confirmar columnas reales de `cardiolink_pacientes`, aplicar
   (con aprobación) la migración pendiente de `requested_coverage`,
   `supabase functions deploy`, reemplazar `GATEWAY_URL_PRODUCCION_DEFAULT`.
5. QA manual completo en Staging con Turnstile real (no las claves de
   test) antes del primer despliegue a Producción.

## Tests y validación en este entorno

Igual que en las etapas anteriores: sin `node`/`deno`/TypeScript
disponibles acá. Sintaxis re-validada con `esprima` (instalado sólo para
este chequeo) sobre los archivos JS/TS tocados. `git diff --check` sin
errores. Cada aserción nueva se verificó manualmente contra el código
fuente.
