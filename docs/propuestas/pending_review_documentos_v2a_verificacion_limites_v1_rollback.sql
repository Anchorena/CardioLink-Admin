-- CardioLink · Documentos V2A / F3 — ROLLBACK del límite de tasa persistente. NO EJECUTAR sin autorización explícita.
-- Quita sólo la tabla y la función de pending_review_documentos_v2a_verificacion_limites_v1.sql (no hay datos que conservar: son contadores efímeros).
-- ATENCIÓN: la Edge Function document-verify es FAIL-CLOSED respecto de este límite: sin la RPC responde 503 a TODAS las verificaciones. Por eso, antes de (o junto con)
-- este rollback hay que retirar/revertir la función desplegada, o aceptar que la verificación pública quede fuera de servicio. No afecta a F1 ni a los documentos.
begin;
drop function if exists public.cardiolink_verificacion_limitar_v1(text, integer, integer);
drop table if exists public.cardiolink_verificacion_limites;
commit;
