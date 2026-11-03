-- CardioLink · Documentos V2A / F3 — ROLLBACK del control de uso único de tokens. NO EJECUTAR sin autorización explícita.
-- Quita sólo la tabla y la función de pending_review_documentos_v2a_verificacion_tokens_v1.sql (no hay datos que conservar: son hashes efímeros de tokens ya vencidos).
-- ATENCIÓN: la Edge Function document-verify (con este control) es FAIL-CLOSED: sin la RPC responde 503 a TODAS las verificaciones. Antes de (o junto con) este rollback
-- hay que redesplegar la versión anterior de la función, o aceptar que la verificación pública quede fuera de servicio. No afecta a F1, al límite de tasa ni a los documentos.
begin;
drop function if exists public.cardiolink_verificacion_token_usar_v1(text, integer);
drop table if exists public.cardiolink_verificacion_tokens_usados;
commit;
