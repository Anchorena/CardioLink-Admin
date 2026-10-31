# Documentos V2A · F3 — Checklist mínimo para Production

Estado: **propuesta**. Nada de esto se ejecutó en Production (`tupacclmhaqiahhlttyz`). Cada paso requiere autorización explícita y se hace de a uno, con el control indicado antes de seguir. Cualquier fallo: detenerse y diagnosticar. Nunca se usa `service_role` en el frontend; los secretos no van al repo ni al chat.

## 0. Condiciones previas (todas en STAGING, ya cumplidas el 2026-10-31)
- [x] Estados vigente / reemplazado / anulado / inexistente (Chrome real, sitio Pages TEST).
- [x] Uso único del token impuesto por CardioLink: 1.er uso 200, reutilizado 403, 4 simultáneos => un solo 200, token nuevo 200 (`documentos-v2a-f3-verificacion-publica.md` §5c.1).
- [x] Límite persistente (429 desde la solicitud 31) y suite local F3 47/47.
- [x] **F1** (tablas V2A y RPC `reservar/vincular/anular/consultar/pin_*`) instalado en STAGING con `pending_review_documentos_v2a_verificacion_v1.sql` y probado con `..._v1_tests.sql`: 66/66 (QA informado por el responsable; los 51/51 de `documentos-v2a-f0-diseno.md` corresponden a una versión anterior de las pruebas, validada sólo en PGlite). Los archivos recuperados (instalador, pruebas y los dos checks) son byte a byte los usados (SHA-256 verificado contra la carpeta `f1-v2a-r2`). **El rollback de F1 (`..._v1_rollback.sql`) está validado únicamente en PGlite**: no se ejercitó en STAGING ni forma parte de la carpeta `f1-v2a-r2`.
- [x] **503 por falla de la RPC** (límite y token): QA aprobado en STAGING según informó el responsable (permisos de STAGING restaurados y verificados). **Falta archivar la evidencia completa** (los PASS de `qa503` de las dos rondas y los JSON de `0_estado.sql`) y reflejarlo en `documentos-v2a-f3-verificacion-publica.md` §5c.2, que todavía lo describe como pendiente.
- [ ] Revisión de este diff por el responsable y merge a `main` autorizado por separado.

## 1. QA en STAGING: 503 por falla de la RPC (con autorización de SQL) — aprobado; evidencia por archivar
Procedimiento ejecutado (referencia):
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

## 3. Supabase Production (en este orden; cada SQL se corre a mano en el SQL Editor de Production, comprobando el ref `tupacclmhaqiahhlttyz` en la URL)
Dependencias: cada paso exige el anterior. F2 (cliente) llama a `reservar` y `vincular` (F1, rol `authenticated`); F3 (función pública) llama a `consultar` (F1), al límite persistente y al control de tokens (sólo `service_role`). Los SQL del límite y de los tokens abortan solos si falta F1. Ninguno de estos SQL va a `supabase/migrations` (`supabase db push` no debe poder aplicarlos por accidente). Todo vive en `docs/propuestas/` con el prefijo `pending_review_documentos_v2a_verificacion_`.
1. [ ] **Prerrequisitos de F1 (sólo lectura).** Correr `..._v1_checks_antes.sql` y revisar el JSON: `columnas_documentos` con `source_content_hash`, `source_payload` y `source_document_id`; `triggers_documentos` habilitados; `funciones_acceso` = las 2 funciones con `definer=true`; `roles_activos` y `medicos_con_professional_id` coherentes; `rls_documentos=true`; y **`tablas_v2a_existentes` y `funciones_v2a_existentes` = null** (F1 todavía no instalada). F1 se niega a instalarse (y no deja nada a medias) si falta `cardiolink_patient_documents`, la columna `source_payload` (la aporta `pending_review_patient_documents_source_payload_v1.sql`), el trigger `cardiolink_patient_documents_guard_version` habilitado, las 2 funciones de acceso a documentos clínicos o `cardiolink_user_roles`. Si algo falta, detenerse: son requisitos aparte, con su propia autorización.
2. [ ] **F1 — instalación.** `pending_review_documentos_v2a_verificacion_v1.sql` (una sola transacción; su cabecera sugiere antes un ensayo con el `COMMIT` final cambiado por `ROLLBACK`). Crea sólo 2 tablas, 1 secuencia, 2 funciones de guarda con sus triggers y 7 funciones (reservar, vincular, anular, consultar, pin_set, pin_intento y un auxiliar de titularidad); no modifica `cardiolink_patient_documents` ni Storage.
3. [ ] **F1 — verificación posterior (sólo lectura).** `..._v1_checks_despues.sql`: 2 tablas con RLS activa, `privilegios_tablas_cliente = []`, `reservar/vincular/anular` ejecutables por `authenticated` y no por `anon`, `consultar/pin_set/pin_intento` sólo por `service_role`, 2 triggers de inmutabilidad, secuencias sin acceso del cliente, `filas` en 0 y `documentos_de_prueba_residuales = 0`.
4. [ ] **F1 — QA transaccional (opcional en Production, sólo con autorización explícita aparte).** `..._v1_tests.sql` (66/66 en STAGING; termina en un error intencional "RESULTADO V2A" que revierte todo). Usa usuarios existentes sólo para fijar `auth.uid()` y filas de documentos con `patient_id '__qa_v2a__'` dentro de la transacción: como Production es el sistema real, decidir antes si se corre ahí o si basta con el paso 3 más el QA del apartado 4. Si se corre, repetir el paso 3 después (residuales = 0).
5. [ ] SQL del límite de tasa: instalación → pruebas (25/25, error intencional) → verificación.
6. [ ] SQL del control de tokens: instalación → pruebas (27/27, error intencional) → verificación (0 filas, RLS, permisos).
7. [ ] Secrets (nunca en el repo): `VERIFY_TURNSTILE_SECRET_KEY` (la del widget de Production), `VERIFY_TURNSTILE_HOSTNAMES=cardiolink.com.ar`, `VERIFY_TURNSTILE_ACTION=verificar-documento`, `VERIFY_ALLOWED_ORIGINS=https://cardiolink.com.ar`. Comprobar con `supabase secrets list --project-ref tupacclmhaqiahhlttyz` (sólo huellas). **No** depender de `TURNSTILE_SECRET_KEY`: la función ya no la usa.
8. [ ] Desplegar **sólo** `document-verify` con `--project-ref tupacclmhaqiahhlttyz --use-api --no-verify-jwt` desde un directorio temporal (no desde el repo: la CLI deja `supabase/.temp`). La CLI no queda vinculada: siempre `--project-ref` explícito.
9. [ ] Descargar la función desplegada y compararla con el repo (debe ser idéntica; sin `DIAG` ni logs de depuración). Las demás funciones conservan su versión.

## 4. QA mínimo en Production (sólo datos sintéticos; no se tocan certificados reales)
- [ ] `curl -i` a la función sin token: 403; con origen ajeno: sin CORS.
- [ ] Desde Chrome real en `https://cardiolink.com.ar/verificar/`: código inexistente => respuesta uniforme `no_verificable`; el mismo token no se puede reutilizar (200 / 403).
- [ ] Un certificado sintético emitido con QR (con `CARDIOLINK_QR_V2A` activada sólo en una sesión de prueba, nunca por defecto): vigente, reemplazado y anulado.
- [ ] Ningún dato del paciente en la respuesta; cabeceras `no-store`, `nosniff`, `no-referrer`, CSP estricta.
- [ ] Correo y Email Routing intactos (enviar y recibir un mensaje de prueba) y `cardiolink.com.ar` sin cambios en MX/TXT.

## 5. Reversión
- Función: redesplegar la versión anterior o eliminar `document-verify` (el QR dejaría de verificarse; los documentos y PDFs no se tocan).
- SQL, en este orden: `..._tokens_v1_rollback.sql`, `..._limites_v1_rollback.sql` y, sólo si hay que retirar todo V2A, `..._verificacion_v1_rollback.sql` (F1: quita únicamente lo que creó, sin tocar `cardiolink_patient_documents` ni Storage; los QR ya emitidos dejan de verificar). El rollback de F1 **aborta si hay verificaciones emitidas** salvo que se confirme con `select set_config('cardiolink.rollback_v2a_force', 'si', true);` en la misma transacción, y antes hay que exportar ambas tablas con `..._v1_checks_despues.sql`. La función pública es fail-closed: sin las RPC responde 503, así que redesplegar/retirar la función **antes** o junto con el rollback.
- Pages: quitar el Custom domain; el apex vuelve a quedar sin registros web.
- La bandera `CARDIOLINK_QR_V2A` sigue apagada por defecto hasta una decisión aparte.

## 6. Fuera de este checklist
F2b (QR en la impresión HTML) y F4 (acceso al PDF con PIN, hoy 501).
