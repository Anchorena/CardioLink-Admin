-- CardioLink · Identidad profesional V1 — ROLLBACK de la PROTECCIÓN (sólo quita el trigger y su función)
-- BORRADOR PARA REVISIÓN. NO EJECUTAR sin autorización explícita.
-- Qué NO toca: ningún dato, ni la RPC de identidad, ni cardiolink_config_medico_v1, ni políticas, ni tablas.
-- Efecto: la identidad vuelve a poder ser reescrita por la configuración global (comportamiento anterior a la protección).

BEGIN;

DROP TRIGGER IF EXISTS cardiolink_atenciones_proteger_identidad_v1 ON public.cardiolink_atenciones;
DROP FUNCTION IF EXISTS public.cardiolink_atenciones_proteger_identidad_v1();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.cardiolink_atenciones'::regclass AND tgname='cardiolink_atenciones_proteger_identidad_v1')
     OR to_regprocedure('public.cardiolink_atenciones_proteger_identidad_v1()') IS NOT NULL THEN
    RAISE EXCEPTION 'La protección sigue existiendo';
  END IF;
END $$;

COMMIT;
