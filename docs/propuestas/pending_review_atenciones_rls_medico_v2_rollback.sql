-- CardioLink · ROLLBACK de pending_review_atenciones_rls_medico_v2.sql (v3.2)
-- BORRADOR PARA REVISIÓN. NO EJECUTAR sin autorización explícita. No está en supabase/migrations.
--
-- Restaura EXACTAMENTE las políticas previas de STAGING: las 4 definidas en
-- supabase/migrations/pending_review_pendientes_medicos_v1.sql (líneas 151-154), todas basadas en
-- public.cardiolink_permite_atencion_v1(payload). NO restaura la política permisiva `USING (true)` de Production
-- (ése es otro rollback: pending_review_pendientes_medicos_v1_rollback.sql, sólo para emergencia en Production).
--
-- ANTES de aplicar la v3.2 guardar la salida de:
--   select policyname, cmd, roles, permissive, qual, with_check from pg_policies
--   where schemaname='public' and tablename='cardiolink_atenciones' order by cmd, policyname;
-- y comparar con el estado que deja este rollback (misma consulta). Si difiere, NO confiar en este archivo: usar el snapshot.
--
-- Las funciones nuevas (v3.2) NO se eliminan acá: las usa el frontend. Retirarlas sólo después de retirar el frontend
-- que las llama (lista al final, comentada).
BEGIN;

DROP POLICY IF EXISTS cardiolink_atenciones_select ON public.cardiolink_atenciones;
DROP POLICY IF EXISTS cardiolink_atenciones_insert ON public.cardiolink_atenciones;
DROP POLICY IF EXISTS cardiolink_atenciones_update ON public.cardiolink_atenciones;
DROP POLICY IF EXISTS cardiolink_atenciones_delete ON public.cardiolink_atenciones;
CREATE POLICY cardiolink_atenciones_select ON public.cardiolink_atenciones FOR SELECT TO authenticated USING (public.cardiolink_permite_atencion_v1(payload));
CREATE POLICY cardiolink_atenciones_insert ON public.cardiolink_atenciones FOR INSERT TO authenticated WITH CHECK (public.cardiolink_permite_atencion_v1(payload));
CREATE POLICY cardiolink_atenciones_update ON public.cardiolink_atenciones FOR UPDATE TO authenticated USING (public.cardiolink_permite_atencion_v1(payload)) WITH CHECK (public.cardiolink_permite_atencion_v1(payload));
CREATE POLICY cardiolink_atenciones_delete ON public.cardiolink_atenciones FOR DELETE TO authenticated USING (public.cardiolink_permite_atencion_v1(payload));

-- Verificación posterior (aborta y revierte si no quedó como antes)
DO $$
DECLARE n int; bad int;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE NOT (
           permissive='PERMISSIVE' AND roles::text[]=ARRAY['authenticated']
       AND ( (cmd IN ('SELECT','DELETE') AND qual ~ '^\(*(public\.)?cardiolink_permite_atencion_v1\(payload\)\)*$')
          OR (cmd='INSERT' AND with_check ~ '^\(*(public\.)?cardiolink_permite_atencion_v1\(payload\)\)*$')
          OR (cmd='UPDATE' AND qual ~ '^\(*(public\.)?cardiolink_permite_atencion_v1\(payload\)\)*$'
                          AND with_check ~ '^\(*(public\.)?cardiolink_permite_atencion_v1\(payload\)\)*$') )))
    INTO n, bad
  FROM pg_policies WHERE schemaname='public' AND tablename='cardiolink_atenciones';
  IF n<>4 OR bad>0 THEN RAISE EXCEPTION 'Rollback: las políticas no quedaron como las previas (n=%, distintas=%)', n, bad; END IF;
END $$;

COMMIT;

-- Retiro opcional de las funciones v3.2 (SÓLO tras retirar el frontend que las llama; ninguna política las usa ya):
-- DROP FUNCTION IF EXISTS public.cardiolink_config_medico_v1();
-- DROP FUNCTION IF EXISTS public.cardiolink_directorio_mensajes_v1();
-- DROP FUNCTION IF EXISTS public.cardiolink_mensaje_marcar_leido_v1(text);
-- DROP FUNCTION IF EXISTS public.cardiolink_mensaje_crea_medico_v1(jsonb,text[],uuid);
-- DROP FUNCTION IF EXISTS public.cardiolink_mensaje_visible_medico_v1(jsonb,text[],uuid);
-- DROP FUNCTION IF EXISTS public.cardiolink_logins_propios_v1();
-- DROP FUNCTION IF EXISTS public.cardiolink_login_seudonimo_v1(text);
-- DROP FUNCTION IF EXISTS public.cardiolink_config_usuarios_v1();
-- DROP FUNCTION IF EXISTS public.cardiolink_ctx_prof_v1();
-- DROP FUNCTION IF EXISTS public.cardiolink_ctx_rol_v1();
-- DROP FUNCTION IF EXISTS public.cardiolink_atencion_permitida_v2(jsonb,text,text);
-- DROP FUNCTION IF EXISTS public.cardiolink_login_cliente_v1(text);
-- Los mensajes y atenciones NO se tocan en ningún caso (ni la migración ni el rollback hacen DML).
