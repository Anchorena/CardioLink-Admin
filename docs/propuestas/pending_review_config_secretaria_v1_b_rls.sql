-- CardioLink · Seguridad clínica V1 / Bloque 4B · ETAPA B (RLS): cerrar la fila de configuración completa a Secretaría
-- BORRADOR PARA REVISIÓN. NO EJECUTAR sin autorización explícita. SOLO STAGING (yslhwdlzdknhskawqrtv).
-- Rollback: pending_review_config_secretaria_v1_b_rls_rollback.sql. Pruebas: pending_review_config_secretaria_v1_tests.sql.
-- SIN EJECUTAR: sintaxis sin validar contra una base (no hay Postgres local).
--
-- ORDEN OBLIGATORIO. Aplicar SÓLO DESPUÉS de (1) la ETAPA A y (2) que el cliente de Secretaría con las RPC esté desplegado y verificado.
-- Si se aplica antes, un cliente viejo de Secretaría pierde el guardado de configuración (42501; el cliente viejo sólo hace console.warn).
--
-- QUÉ HACE (y nada más):
--   1) cardiolink_atencion_permitida_v2: la rama 'secretaria' deja de ser `true` y pasa a `tipoRegistro <> 'config'`.
--      Las 4 políticas existentes (SELECT/INSERT/UPDATE/DELETE) ya evalúan este predicado, así que Secretaría deja de poder leer, insertar,
--      modificar o borrar la fila de configuración por API directa (y de convertir otra fila en 'config'). Atenciones y mensajes: sin cambios.
--      owner/admin: igual que antes (true). médico: igual que antes (sin cambios de lógica).
--   2) Política RESTRICTIVA por id (cinturón y tirantes, independiente del contenido del payload): la fila '__cardiolink_config_v1' sólo es
--      accesible, por API, para owner/admin. Una política RESTRICTIVA se suma (AND) a las permisivas existentes; no abre nada.
-- Las RPC de la ETAPA A siguen funcionando: son SECURITY DEFINER (corren como dueño de la tabla, sin RLS).
-- No modifica datos, tablas, columnas, triggers, grants ni otras funciones. No borra nada. La fila de configuración y su contenido quedan intactos.
-- Efecto colateral aceptado: un cliente viejo de Secretaría (sin las RPC) deja de poder leer/guardar la config; ver riesgos en el informe.

BEGIN;

DO $$
DECLARE v_src text; v_esperado constant text :=
  regexp_replace($e$
 SELECT CASE
   WHEN p_rol IN ('owner','admin','secretaria') THEN true
   WHEN p_rol = 'medico' THEN nullif(pg_catalog.btrim(p_prof),'') IS NOT NULL
        AND p_prof = p_payload->>'profesionalId'
        AND coalesce(p_payload->>'tipoRegistro','') NOT IN ('mensaje','config')
   ELSE false END
$e$, '\s+', '', 'g');
  n int;
BEGIN
  IF to_regprocedure('public.cardiolink_config_administrativa_v1()') IS NULL
     OR to_regprocedure('public.cardiolink_guardar_config_administrativa_v1(jsonb,text,text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Precondición: aplicar antes la ETAPA A (RPC de configuración administrativa)'; END IF;
  IF to_regprocedure('public.cardiolink_ctx_rol_v1()') IS NULL THEN RAISE EXCEPTION 'Precondición: falta cardiolink_ctx_rol_v1()'; END IF;
  SELECT regexp_replace(prosrc, '\s+', '', 'g') INTO v_src FROM pg_proc WHERE oid = 'public.cardiolink_atencion_permitida_v2(jsonb,text,text)'::regprocedure;
  IF v_src IS DISTINCT FROM v_esperado THEN
    RAISE EXCEPTION 'Precondición: el cuerpo vigente de cardiolink_atencion_permitida_v2 no coincide con el esperado (comparar con el snapshot de la consulta 1 de la auditoría)'; END IF;
  SELECT count(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='cardiolink_atenciones'
     AND (coalesce(qual,'') ~ 'cardiolink_atencion_permitida_v2' OR coalesce(with_check,'') ~ 'cardiolink_atencion_permitida_v2');
  IF n < 4 THEN RAISE EXCEPTION 'Precondición: se esperaban 4 políticas que usen cardiolink_atencion_permitida_v2 y hay %', n; END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='cardiolink_atenciones' AND policyname='cardiolink_atenciones_config_solo_admin_v1') THEN
    RAISE EXCEPTION 'La política restrictiva ya existe: no se repite esta etapa'; END IF;
END $$;

-- ===== 1) Predicado v2 (nueva versión): Secretaría no accede a filas de configuración =====
CREATE OR REPLACE FUNCTION public.cardiolink_atencion_permitida_v2(p_payload jsonb, p_rol text, p_prof text)
 RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $f$
 SELECT CASE
   WHEN p_rol IN ('owner','admin') THEN true
   WHEN p_rol = 'secretaria' THEN coalesce(p_payload->>'tipoRegistro','') <> 'config'
   WHEN p_rol = 'medico' THEN nullif(pg_catalog.btrim(p_prof),'') IS NOT NULL
        AND p_prof = p_payload->>'profesionalId'
        AND coalesce(p_payload->>'tipoRegistro','') NOT IN ('mensaje','config')
   ELSE false END
$f$;
-- CREATE OR REPLACE conserva los GRANT existentes (EXECUTE sólo para authenticated, no anon).

-- ===== 2) Política RESTRICTIVA por id =====
CREATE POLICY cardiolink_atenciones_config_solo_admin_v1 ON public.cardiolink_atenciones
  AS RESTRICTIVE FOR ALL TO authenticated
  USING      (id <> '__cardiolink_config_v1' OR (SELECT public.cardiolink_ctx_rol_v1()) IN ('owner','admin'))
  WITH CHECK (id <> '__cardiolink_config_v1' OR (SELECT public.cardiolink_ctx_rol_v1()) IN ('owner','admin'));

-- ===== 3) Postcondiciones =====
DO $$
BEGIN
  IF public.cardiolink_atencion_permitida_v2('{"tipoRegistro":"config"}'::jsonb,'secretaria',NULL) IS NOT FALSE THEN RAISE EXCEPTION 'FALLA: secretaria aún accede a config'; END IF;
  IF public.cardiolink_atencion_permitida_v2('{"tipoRegistro":"config"}'::jsonb,'owner',NULL)      IS NOT TRUE  THEN RAISE EXCEPTION 'FALLA: owner perdió acceso a config'; END IF;
  IF public.cardiolink_atencion_permitida_v2('{"tipoRegistro":"config"}'::jsonb,'admin',NULL)      IS NOT TRUE  THEN RAISE EXCEPTION 'FALLA: admin perdió acceso a config'; END IF;
  IF public.cardiolink_atencion_permitida_v2('{"id":"1","profesionalId":"x"}'::jsonb,'secretaria',NULL) IS NOT TRUE THEN RAISE EXCEPTION 'FALLA: secretaria perdió las atenciones'; END IF;
  IF public.cardiolink_atencion_permitida_v2('{"tipoRegistro":"mensaje"}'::jsonb,'secretaria',NULL) IS NOT TRUE THEN RAISE EXCEPTION 'FALLA: secretaria perdió los mensajes'; END IF;
  IF public.cardiolink_atencion_permitida_v2('{"profesionalId":"x"}'::jsonb,'medico','x') IS NOT TRUE THEN RAISE EXCEPTION 'FALLA: médico perdió sus atenciones'; END IF;
  IF public.cardiolink_atencion_permitida_v2('{"profesionalId":"x"}'::jsonb,'medico','y') IS NOT FALSE THEN RAISE EXCEPTION 'FALLA: médico ve atenciones ajenas'; END IF;
  IF public.cardiolink_atencion_permitida_v2('{"tipoRegistro":"config","profesionalId":"x"}'::jsonb,'medico','x') IS NOT FALSE THEN RAISE EXCEPTION 'FALLA: médico accede a config'; END IF;
  IF public.cardiolink_atencion_permitida_v2('{}'::jsonb,'otro','x') IS NOT FALSE THEN RAISE EXCEPTION 'FALLA: rol desconocido con acceso'; END IF;
  IF has_function_privilege('anon','public.cardiolink_atencion_permitida_v2(jsonb,text,text)','EXECUTE') THEN RAISE EXCEPTION 'FALLA: anon puede ejecutar el predicado'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='cardiolink_atenciones'
                  AND policyname='cardiolink_atenciones_config_solo_admin_v1' AND permissive='RESTRICTIVE') THEN
    RAISE EXCEPTION 'FALLA: no existe la política restrictiva'; END IF;
  RAISE NOTICE 'OK ETAPA B: Secretaría sin acceso directo a la fila de configuración; owner/admin/médico/atenciones/mensajes sin cambios.';
END $$;

COMMIT;
