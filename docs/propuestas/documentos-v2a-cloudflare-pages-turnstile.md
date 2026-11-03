# Documentos V2A · Publicación en Cloudflare Pages + Turnstile (guía)

Estado: **preparado; nada se publicó ni se cambió en Cloudflare, DNS ni secretos.** El sitio es la carpeta `verificacion-publica/` (estática, sin la app clínica).

## 1. DNS de cardiolink.com.ar (revisado en sólo lectura, 2026-10-30)
- Zona en Cloudflare (`malavika`/`morgan`). **El apex no tiene A/AAAA/CNAME**: está libre para el sitio.
- Correo entrante: **Cloudflare Email Routing** (MX `route1/2/3.mx.cloudflare.net` + SPF TXT en el apex). Envío con **Resend**: `send`, `resend._domainkey`, `_dmarc`. **Nada de esto se toca.**
- Asociar el dominio desde el proyecto de Pages (Custom domains) crea sólo un CNAME del apex (Cloudflare lo "aplana" y convive con MX/TXT); no modifica registros de correo.

## 2. Qué cambió en el código (sin deploy)
- La página elige el entorno por hostname con lista cerrada: `cardiolink.com.ar` → Production; `*.pages.dev` → **STAGING**; `localhost` → STAGING; cualquier otro host queda fuera de servicio. Sigue fail-closed mientras las sitekeys sean `*_PENDIENTE`.
- `_headers` define CSP y cabeceras **por host** (sin regla genérica: las reglas que coinciden se suman y dos CSP bloquearían la conexión): Production sólo habla con la API de Production; el sitio de pruebas sólo con la de STAGING.
- La función `document-verify` usa su propio `VERIFY_TURNSTILE_SECRET_KEY` (sin fallback: si falta, responde 403; el secret del portal `TURNSTILE_SECRET_KEY` no se usa nunca): así el widget de verificación no pisa el de `portal-gateway`. **Requiere re-desplegar la función en STAGING (autorización pendiente).**

## 3. Pasos manuales (sitio de pruebas)
1. **Pages (sin Node ni Git):** Cloudflare → *Workers & Pages* → *Create* → *Pages* → *Upload assets* → nombre `cardiolink-verificacion-test` (queda en `https://cardiolink-verificacion-test.pages.dev`) → subir el ZIP `verificacion-publica-pages.zip` (la carpeta, con `_headers` en la raíz) → *Deploy*.
2. **Turnstile:** *Turnstile* → *Add widget* → nombre "CardioLink verificación (pruebas)"; hostname `cardiolink-verificacion-test.pages.dev`; modo **Invisible**. Copiar la **Site Key** (pública) y la **Secret Key** (privada: no pegarla en el chat).
3. **Site Key:** pasarla a Claude (es pública): se coloca en `SITEKEY_PRUEBAS_PAGES` y se regenera el ZIP para volver a subirlo.
4. **STAGING (con autorización, en tu terminal; el secret se escribe ahí):**
   ```
   supabase secrets set --project-ref yslhwdlzdknhskawqrtv VERIFY_TURNSTILE_SECRET_KEY=<SECRET_KEY> VERIFY_TURNSTILE_HOSTNAMES=cardiolink-verificacion-test.pages.dev VERIFY_TURNSTILE_ACTION=verificar-documento VERIFY_ALLOWED_ORIGINS=https://cardiolink-verificacion-test.pages.dev
   supabase functions deploy document-verify --project-ref yslhwdlzdknhskawqrtv --no-verify-jwt --use-api
   ```
   (Siempre con `--project-ref` de STAGING.) CORS hoy: el origen `*.pages.dev` NO está permitido en STAGING (verificado); sin `VERIFY_ALLOWED_ORIGINS` el navegador bloquea la respuesta.
5. **Pruebas:** abrir `https://cardiolink-verificacion-test.pages.dev/verificar/?c=<código sintético>` (vigente / reemplazado / anulado); el escenario de "token de un solo uso" ya quedó verificado en STAGING (ver `documentos-v2a-f3-verificacion-publica.md` §5c.1) con el widget real (enviar el mismo token dos veces: el segundo debe dar 403).

## 4. Producción (más adelante, con autorización aparte)
- Segundo widget Turnstile para `cardiolink.com.ar` → su Site Key en `SITEKEY_PRODUCCION`; en Production: función desplegada, `VERIFY_TURNSTILE_SECRET_KEY`, `VERIFY_TURNSTILE_HOSTNAMES=cardiolink.com.ar`, `VERIFY_TURNSTILE_ACTION=verificar-documento`, `VERIFY_ALLOWED_ORIGINS=https://cardiolink.com.ar`, tablas V2A y límite instalados.
- Proyecto de Pages **distinto** del de pruebas (p. ej. `cardiolink-verificacion`) con *Custom domains* → `cardiolink.com.ar`; el QR ya apunta a `https://cardiolink.com.ar/verificar/`. Verificar antes que el apex siga sin A/AAAA/CNAME y que MX/TXT/Resend queden intactos.
- No activar `CARDIOLINK_QR_V2A` hasta que todo lo anterior esté verificado.
