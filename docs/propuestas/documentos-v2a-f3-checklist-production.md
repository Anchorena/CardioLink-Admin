# Documentos V2A · F3 — Checklist mínimo para Production

Estado: **propuesta**. Nada de esto se ejecutó en Production (`tupacclmhaqiahhlttyz`). Cada paso requiere autorización explícita y se hace de a uno, con el control indicado antes de seguir. Cualquier fallo: detenerse y diagnosticar. Nunca se usa `service_role` en el frontend; los secretos no van al repo ni al chat.

## 0. Condiciones previas (todas en STAGING, ya cumplidas el 2026-10-31)
- [x] Estados vigente / reemplazado / anulado / inexistente (Chrome real, sitio Pages TEST).
- [x] Uso único del token impuesto por CardioLink: 1.er uso 200, reutilizado 403, 4 simultáneos => un solo 200, token nuevo 200 (`documentos-v2a-f3-verificacion-publica.md` §5c.1).
- [x] Límite persistente (429 desde la solicitud 31) y suite local F3 47/47.
- [ ] **503 por falla de la RPC** (límite y token): pendiente de QA real en STAGING (ver abajo). Hasta no probarlo, no pasar a Production.
- [ ] Revisión de este diff por el responsable y merge a `main` autorizado por separado.

## 1. QA pendiente en STAGING: 503 por falla de la RPC (con autorización de SQL)
Para `cardiolink_verificacion_limitar_v1(text,integer,integer)` y, por separado, para `cardiolink_verificacion_token_usar_v1(text,integer)`:
1. `revoke execute on function public.<funcion>(<args>) from service_role;`
2. Desde Chrome, con un token real y un código inexistente: esperar `503 {"ok":false,"error":"no_disponible"}` (2–3 veces, también con un código de formato inválido) y que **no** aparezcan eventos `consulta` nuevos en la bitácora.
3. `grant execute on function public.<funcion>(<args>) to service_role;`, repetir una verificación con token nuevo: 200.
4. Correr `..._checks.sql` y confirmar permisos como antes (anon/authenticated sin acceso, service_role con acceso).
Ventana de la prueba: segundos; STAGING no tiene usuarios reales.

## 2. Cloudflare (sin tocar el DNS del correo)
- [ ] Segundo widget Turnstile **propio de Production** para `cardiolink.com.ar` (distinto del de Pages TEST y del del portal). Anotar la Site Key pública; la Secret Key se carga sólo como secret.
- [ ] Proyecto Cloudflare Pages de Production **distinto** del de pruebas, con `verificacion-publica/` como raíz y Custom domain `cardiolink.com.ar` (el apex hoy no tiene A/AAAA/CNAME; MX y SPF de Email Routing y Resend no se tocan). Revisar el registro DNS que cree Cloudflare antes de aceptarlo.
- [ ] `SITEKEY_PRODUCCION` en `verificar.js` (hoy `SITEKEY_PRODUCCION_PENDIENTE`: fail-closed, el sitio responde "en configuración").
- [ ] `_headers` por host ya separa Production (connect-src Production) de `*.pages.dev` (STAGING): confirmar tras el deploy con `curl -I`.

## 3. Supabase Production (en este orden)
1. [ ] Confirmar que **F1** (tablas V2A y RPC `reservar/vincular/anular/consultar`) está instalada; si no, instalarla primero con su QA 51/51.
2. [ ] SQL del límite de tasa: instalación → pruebas (25/25, error intencional) → verificación.
3. [ ] SQL del control de tokens: instalación → pruebas (27/27, error intencional) → verificación (0 filas, RLS, permisos).
4. [ ] Secrets (nunca en el repo): `VERIFY_TURNSTILE_SECRET_KEY` (la del widget de Production), `VERIFY_TURNSTILE_HOSTNAMES=cardiolink.com.ar`, `VERIFY_TURNSTILE_ACTION=verificar-documento`, `VERIFY_ALLOWED_ORIGINS=https://cardiolink.com.ar`. Comprobar con `supabase secrets list --project-ref tupacclmhaqiahhlttyz` (sólo huellas). **No** depender de `TURNSTILE_SECRET_KEY`: la función ya no la usa.
5. [ ] Desplegar **sólo** `document-verify` con `--project-ref tupacclmhaqiahhlttyz --use-api --no-verify-jwt` desde un directorio temporal (no desde el repo: la CLI deja `supabase/.temp`). La CLI no queda vinculada: siempre `--project-ref` explícito.
6. [ ] Descargar la función desplegada y compararla con el repo (debe ser idéntica; sin `DIAG` ni logs de depuración). Las demás funciones conservan su versión.

## 4. QA mínimo en Production (sólo datos sintéticos; no se tocan certificados reales)
- [ ] `curl -i` a la función sin token: 403; con origen ajeno: sin CORS.
- [ ] Desde Chrome real en `https://cardiolink.com.ar/verificar/`: código inexistente => respuesta uniforme `no_verificable`; el mismo token no se puede reutilizar (200 / 403).
- [ ] Un certificado sintético emitido con QR (con `CARDIOLINK_QR_V2A` activada sólo en una sesión de prueba, nunca por defecto): vigente, reemplazado y anulado.
- [ ] Ningún dato del paciente en la respuesta; cabeceras `no-store`, `nosniff`, `no-referrer`, CSP estricta.
- [ ] Correo y Email Routing intactos (enviar y recibir un mensaje de prueba) y `cardiolink.com.ar` sin cambios en MX/TXT.

## 5. Reversión
- Función: redesplegar la versión anterior o eliminar `document-verify` (el QR dejaría de verificarse; los documentos y PDFs no se tocan).
- SQL: `..._tokens_v1_rollback.sql` y `..._limites_v1_rollback.sql` (la función pública es fail-closed: sin las RPC responde 503, así que redesplegar/retirar la función **antes** o junto con el rollback).
- Pages: quitar el Custom domain; el apex vuelve a quedar sin registros web.
- La bandera `CARDIOLINK_QR_V2A` sigue apagada por defecto hasta una decisión aparte.

## 6. Fuera de este checklist
F2b (QR en la impresión HTML) y F4 (acceso al PDF con PIN, hoy 501).
