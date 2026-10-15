-- CardioLink · Identidad profesional V1 — ROLLBACK
-- BORRADOR PARA REVISIÓN. NO EJECUTAR sin autorización explícita.
-- Qué hace: elimina la RPC cardiolink_guardar_identidad_profesional_v1 y devuelve cardiolink_config_medico_v1() a la versión v3.2
-- (sin identidad documental), idéntica a la de pending_review_atenciones_rls_medico_v2.sql.
-- Qué NO toca: ningún dato. La identidad ya guardada en __cardiolink_config_v1 (payload.config.profesionales[]) se conserva intacta.
-- Efecto en el cliente: el médico vuelve a no recibir su identidad por la RPC (la guardada sigue en la config global y la ven owner/admin).

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.cardiolink_guardar_identidad_profesional_v1(text,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'No existe cardiolink_guardar_identidad_profesional_v1: no hay nada que revertir';
  END IF;
END $$;

DROP FUNCTION public.cardiolink_guardar_identidad_profesional_v1(text,jsonb);

CREATE OR REPLACE FUNCTION public.cardiolink_config_medico_v1()
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $f$
 SELECT CASE WHEN public.cardiolink_ctx_prof_v1() IS NOT NULL
 THEN jsonb_build_object(
   'profesionales', coalesce((SELECT jsonb_agg(jsonb_build_object('id',p->'id','nombre',p->'nombre','area',p->'area','prestaciones',p->'prestaciones'))
        FROM public.cardiolink_atenciones a, jsonb_array_elements(coalesce(a.payload#>'{config,profesionales}','[]'::jsonb)) p
        WHERE a.id='__cardiolink_config_v1'),'[]'::jsonb),
   'obrasSociales', coalesce((SELECT a.payload#>'{config,obrasSociales}' FROM public.cardiolink_atenciones a WHERE a.id='__cardiolink_config_v1'),'[]'::jsonb),
   'usuarioPropio', (
     SELECT jsonb_strip_nulls(jsonb_build_object(
              'id', u->>'id', 'usuario', u->>'usuario', 'nombre', u->>'nombre', 'rol', u->>'rol',
              'profesionalId', u->>'profesionalId', 'especialidad', u->>'especialidad', 'activo', u->'activo',
              -- sólo el alias que coincide con el login del propio llamador (para que el cliente se reconozca); nunca la lista
              'aliases', CASE WHEN me.l <> '' AND (me.l IN (public.cardiolink_login_cliente_v1(u->>'usuario'), public.cardiolink_login_cliente_v1(u->>'id'),
                                                          public.cardiolink_login_cliente_v1(u->>'email'))
                                                  OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(coalesce(u->'aliases','[]'::jsonb)) al
                                                             WHERE public.cardiolink_login_cliente_v1(al)=me.l))
                              THEN jsonb_build_array(me.l) END))
     FROM public.cardiolink_atenciones a,
          jsonb_array_elements(coalesce(a.payload#>'{config,usuarios}','[]'::jsonb)) u,
          (SELECT public.cardiolink_login_cliente_v1(auth.jwt()->>'email') AS l) me
     WHERE a.id='__cardiolink_config_v1'
       AND nullif(u->>'profesionalId','')=public.cardiolink_ctx_prof_v1()
       AND u->>'rol'='medico' AND coalesce(u->>'activo','true')<>'false'
     ORDER BY u->>'usuario', u->>'id' LIMIT 1),
   'mensajeria', jsonb_build_object('login',(public.cardiolink_logins_propios_v1())[1]))
 ELSE NULL END
$f$;
REVOKE ALL ON FUNCTION public.cardiolink_config_medico_v1() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cardiolink_config_medico_v1() TO authenticated;

DO $$
BEGIN
  IF to_regprocedure('public.cardiolink_guardar_identidad_profesional_v1(text,jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'La RPC de identidad sigue existiendo';
  END IF;
  IF position('logoDocumentoData' IN (SELECT prosrc FROM pg_proc WHERE oid='public.cardiolink_config_medico_v1()'::regprocedure))>0 THEN
    RAISE EXCEPTION 'cardiolink_config_medico_v1() sigue incluyendo la identidad documental';
  END IF;
END $$;

COMMIT;
