-- CardioLink · Seguridad clínica V1 / Bloque 4B · ROLLBACK de la ETAPA B (RLS de la fila de configuración)
-- BORRADOR PARA REVISIÓN. NO EJECUTAR sin autorización. SOLO STAGING. SIN EJECUTAR (sintaxis sin validar contra una base).
-- Restaura EXACTAMENTE el cuerpo previo de cardiolink_atencion_permitida_v2 (según docs/propuestas/pending_review_atenciones_rls_medico_v2.sql, v3.2)
-- y elimina la política restrictiva por id. No toca datos, tablas ni la fila de configuración. Las RPC de la ETAPA A quedan (revertir con …_a_rpc_rollback.sql).
-- Efecto: Secretaría vuelve a poder leer/escribir la fila completa (el estado previo, que es el que se quiere cerrar).

BEGIN;

DROP POLICY IF EXISTS cardiolink_atenciones_config_solo_admin_v1 ON public.cardiolink_atenciones;

CREATE OR REPLACE FUNCTION public.cardiolink_atencion_permitida_v2(p_payload jsonb, p_rol text, p_prof text)
 RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $f$
 SELECT CASE
   WHEN p_rol IN ('owner','admin','secretaria') THEN true
   WHEN p_rol = 'medico' THEN nullif(pg_catalog.btrim(p_prof),'') IS NOT NULL
        AND p_prof = p_payload->>'profesionalId'
        AND coalesce(p_payload->>'tipoRegistro','') NOT IN ('mensaje','config')
   ELSE false END
$f$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='cardiolink_atenciones'
              AND policyname='cardiolink_atenciones_config_solo_admin_v1') THEN
    RAISE EXCEPTION 'Verificación: la política restrictiva sigue existiendo'; END IF;
  IF public.cardiolink_atencion_permitida_v2('{"tipoRegistro":"config"}'::jsonb,'secretaria',NULL) IS NOT TRUE THEN
    RAISE EXCEPTION 'Verificación: el predicado no volvió al comportamiento previo (secretaria/config)'; END IF;
  IF public.cardiolink_atencion_permitida_v2('{"profesionalId":"x"}'::jsonb,'medico','y') IS NOT FALSE THEN
    RAISE EXCEPTION 'Verificación: el predicado del médico cambió'; END IF;
  IF has_function_privilege('anon','public.cardiolink_atencion_permitida_v2(jsonb,text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'Verificación: anon puede ejecutar el predicado'; END IF;
  RAISE NOTICE 'OK rollback etapa B: predicado previo restaurado y política restrictiva eliminada. Datos sin cambios.';
END $$;

COMMIT;
