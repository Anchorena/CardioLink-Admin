# Documentos V2A · F3 — Verificación pública (cardiolink.com.ar/verificar/)

Estado: **función desplegada y probada en STAGING (2026-10-30); QA funcional y de seguridad aprobado.** Nada se tocó en Cloudflare ni en Production; la bandera del QR sigue apagada.

## 1. Diagnóstico (sólo lectura, 2026-10-29)
- `cardiolink.com.ar`: usa los nameservers de Cloudflare (`malavika`/`morgan`) pero **no tiene ningún registro A/AAAA/CNAME**: el dominio todavía no resuelve a nada.
- La app vive en `anchorena.github.io/CardioLink-Admin/` (GitHub Pages, origen `anchorena.github.io`). `portal/verificar.html` da 404 (el QR de F2 todavía no lleva a ningún lado).
- **Decisión de arquitectura:** la página pública debe tener su **propio origen**, sin la app clínica (la app guarda caché clínica en `localStorage`; un XSS en una página pública del mismo origen la expondría). Por eso el sitio vive en la carpeta aparte `verificacion-publica/` y se publica en `cardiolink.com.ar` (p. ej. Cloudflare Pages con directorio de salida `verificacion-publica`, o un repo/Pages separado), nunca junto a la app. Cloudflare Pages permite el archivo `_headers` (CSP estricta, no-store); GitHub Pages no, por eso no se recomienda para este sitio.

## 2. Qué se agregó
- `supabase/functions/document-verify/` (`index.ts` + `logica.js`): Edge Function pública (`verify_jwt = false` sólo para esta función en `supabase/config.toml`).
- `verificacion-publica/`: `verificar/` (HTML + JS + CSS sin dependencias), `_headers`, `robots.txt`.
- QR de F2 → `https://cardiolink.com.ar/verificar/?c=<código>`; la bandera `CARDIOLINK_QR_V2A` sigue **apagada por defecto**.
- Sin SQL nuevo: usa `cardiolink_verificacion_consultar_v1` (F1).

## 3. Defensas de la función (orden)
CORS por lista de orígenes → límite en memoria (barato) → **Turnstile fail-closed** (secret + siteverify con tiempo máximo + hostname autorizado obligatorio + acción opcional) → **límite persistente** (30/10 min por IP hasheada y 600/min global, vía RPC) → formato del código (22 caracteres base64url) → consulta con el HASH del código. Todo lo no verificable (formato inválido, inexistente, reservado, documento eliminado) responde **igual**. Respuesta por lista blanca: estado, tipo genérico, fecha, profesional y matrículas, huella corta. Nunca paciente ni contenido. F4 (`accion: "acceso-pdf"`) responde 501 hasta que se habilite.

## 4. Plan de despliegue EXCLUSIVO a STAGING (no usar el proyecto vinculado por defecto: es Production)
Orden y control en cada paso (cualquier fallo: detenerse y diagnosticar):
1. **SQL en el SQL Editor de STAGING** (`yslhwdlzdknhskawqrtv`; comprobar el ref en la URL): `pending_review_documentos_v2a_verificacion_limites_v1.sql` (necesita F1 ya instalado) → `..._limites_v1_tests.sql` (esperado `aprobadas=25, fallidas=0`; termina en un error intencional que revierte todo); después `..._limites_v1_checks.sql` (una consulta de sólo lectura que devuelve un JSON). Scripts finales numerados en la carpeta de notas `f3-limites-v1/`.
2. **Secrets de STAGING** (nunca en el repo): `TURNSTILE_SECRET_KEY` = la clave secreta de PRUEBA pública de Cloudflare (ver su documentación de testing; si el portal ya la tiene —se comprueba con `supabase secrets list`, que muestra la huella—, no repetir), `VERIFY_TURNSTILE_HOSTNAMES=example.com` (con la clave de prueba Cloudflare devuelve ese hostname), `VERIFY_ALLOWED_ORIGINS=http://127.0.0.1:8771`. **No** definir `VERIFY_TURNSTILE_ACTION` en STAGING (la clave de prueba no devuelve acción).
3. **Función**: `supabase functions deploy document-verify --project-ref yslhwdlzdknhskawqrtv --no-verify-jwt` (o crearla en el editor del dashboard de STAGING con `index.ts` y `logica.js`). Verificar con `supabase functions list --project-ref yslhwdlzdknhskawqrtv` y que `curl -i https://tupacclmhaqiahhlttyz.supabase.co/functions/v1/document-verify` siga dando 404 (Production sin función).
4. **QA** (sección 5) con la página local → STAGING.
Limitación de la clave de prueba: no impone el uso único del token (un segundo `siteverify` también da éxito). El rechazo del reuso (`timeout-or-duplicate`) sólo se comprueba con un sitio Turnstile REAL: antes de Production crear uno (puede ser el de STAGING, con hostname `127.0.0.1`/el de la página) y repetir esa prueba; en Production definir `VERIFY_TURNSTILE_HOSTNAMES=cardiolink.com.ar` y `VERIFY_TURNSTILE_ACTION=verificar-documento`.

## 5. QA en STAGING (códigos sintéticos ya emitidos)
Con la función desplegada: página local (`verificacion-publica/` en `http://127.0.0.1:8771/verificar/?c=...`, que usa STAGING en local) con los códigos sintéticos emitidos en la QA de F2 (uno vigente y uno reemplazado); anulado con el RPC de anulación desde la app; códigos inválidos; sin Turnstile (403); ráfaga (429); respuesta idéntica para inexistente/no disponible; revisión de que la respuesta no contiene datos del paciente.

## 5b. Resultado del QA en STAGING (aprobado)
Estados vigente / reemplazado / anulado (este último con un certificado sintético nuevo anulado por su emisor; el motivo no se expone), código inexistente y de formato inválido con respuesta idéntica, sin Turnstile 403, CORS sin origen ajeno, método/tamaño/JSON inválido, F4 deshabilitado (501), cabeceras no-store/nosniff/no-referrer, respuesta sin datos del paciente, página real contra la función, y límite persistente (429 desde la solicitud 31 de la ventana, también con código válido). Un intento de inyección en el código lo frena el WAF de Supabase antes de la función.

## 5c. Escenarios PENDIENTES de QA real (no se pudieron probar en STAGING; sólo tienen cobertura de pruebas locales)
1. **Token de Turnstile de un solo uso.** La clave de prueba de Cloudflare devuelve éxito aun con el mismo token repetido, así que el rechazo `timeout-or-duplicate` no se observa. Cómo probarlo: crear un sitio Turnstile REAL para STAGING (hostname de la página de prueba), cargar su secret y `VERIFY_TURNSTILE_HOSTNAMES` con ese hostname, obtener un token desde la página y enviarlo dos veces con `curl`: el segundo debe dar 403. Hacerlo también en Production antes de activar la bandera (con `VERIFY_TURNSTILE_ACTION=verificar-documento`).
2. **503 cuando falla la RPC del límite persistente.** No hay forma de provocarlo en STAGING sin tocar SQL. Cómo probarlo (con autorización de SQL en STAGING): `revoke execute on function public.cardiolink_verificacion_limitar_v1(text,integer,integer) from service_role;`, comprobar que 2–3 verificaciones devuelven `503 {"ok":false,"error":"no_disponible"}` sin consultar certificados, y restaurar con `grant execute ... to service_role;` y repetir una verificación (200). Verificar con `3_verificacion.sql` que el permiso quedó como antes.

## 6. Pendiente antes de Production (no se hizo)
Crear el sitio Turnstile real y completar `SITEKEY_PRODUCCION` en `verificar.js` (hoy el sitio responde "en configuración"); DNS de `cardiolink.com.ar` en Cloudflare + proyecto Pages; instalar las tablas V2A en Production; desplegar la función allá; `VERIFY_ALLOWED_ORIGINS=https://cardiolink.com.ar`; auditar la función antes de exponerla; luego F2b (QR en la impresión HTML) y F4 (PIN).
- Límite de tasa: ahora hay límite en memoria (primera barrera) + **persistente y compartido** (SQL propuesto `..._limites_v1.sql`, sólo service_role, claves opacas, limpieza acotada). **Fail-closed:** si la RPC del límite falla o responde algo inesperado, la función responde 503 y no consulta certificados (sin fallback permisivo; el límite en memoria sólo agrega una barrera).
