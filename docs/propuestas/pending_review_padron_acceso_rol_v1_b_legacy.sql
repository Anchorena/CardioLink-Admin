-- CardioLink · Bloque 0B · Acceso sólo con rol ACTIVO · PARTE B · cinco tablas heredadas (atenciones, medicos, obras_sociales, pacientes, prestaciones)
-- BORRADOR PARA REVISIÓN. NO EJECUTAR sin autorización explícita. INDEPENDIENTE de la PARTE A (se puede aplicar antes, después o nunca). Una sola transacción, sin DML.
-- Rollback: pending_review_padron_acceso_rol_v1_b_legacy_rollback.sql
--
-- ESTADO VERIFICADO (solo lectura, 2026-11-24): existen SÓLO en Production (STAGING no las tiene). Las cinco están VACÍAS (0 filas), sin triggers, sin vistas dependientes, sin publicaciones;
-- ningún archivo del repo las consulta (el cliente usa cardiolink_atenciones y cardiolink_pacientes; las Edge Functions usan service_role). Cada una tiene RLS activada y UNA política
-- "Usuarios logueados pueden usar <tabla>": PERMISSIVE, ALL, TO authenticated, USING (true) WITH CHECK (true). Además atenciones.paciente_id tiene una FK hacia la tabla heredada pacientes.
-- Cualquier sesión autenticada (con o sin rol activo) puede escribir en ellas.
--
-- CORRECCIÓN MÍNIMA: cada política abierta se reemplaza por <tabla>_rol_activo_v1 con la MISMA condición que cardiolink_pacientes_rol_activo_v1 (rol ACTIVO owner/admin/medico/secretaria).
-- Para el personal activo el comportamiento no cambia en absoluto (hoy nadie las usa). No se borran tablas, filas ni políticas de ninguna otra tabla.
-- ALTERNATIVA (no elegida): quitar la política y dejar las tablas sin acceso para authenticated. Es más estricta, pero cambia el contrato de tablas que podrían tener algún cliente antiguo; se puede adoptar después.
-- Si en la base no existe ninguna de las cinco tablas (STAGING), el script no hace nada y lo avisa.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
DECLARE
  v_map text[][] := ARRAY[['atenciones', 'Usuarios logueados pueden usar atenciones'],
                          ['medicos', 'Usuarios logueados pueden usar medicos'],
                          ['obras_sociales', 'Usuarios logueados pueden usar obras sociales'],
                          ['pacientes', 'Usuarios logueados pueden usar pacientes'],
                          ['prestaciones', 'Usuarios logueados pueden usar prestaciones']];
  v_auth oid := (SELECT oid FROM pg_roles WHERE rolname = 'authenticated');
  v_oid oid; v_t text; v_old text; v_new text; i int; n int := 0;
BEGIN
  IF to_regprocedure('public.cardiolink_ctx_rol_v1()') IS NULL THEN RAISE EXCEPTION 'Precondición: falta public.cardiolink_ctx_rol_v1()'; END IF;
  IF NOT has_function_privilege('authenticated', 'public.cardiolink_ctx_rol_v1()', 'EXECUTE') THEN RAISE EXCEPTION 'Precondición: authenticated no puede ejecutar cardiolink_ctx_rol_v1()'; END IF;
  -- 1) verificación de TODAS las tablas antes de tocar ninguna
  FOR i IN 1 .. array_length(v_map, 1) LOOP
    v_t := v_map[i][1]; v_old := v_map[i][2]; v_new := v_t || '_rol_activo_v1'; v_oid := to_regclass(format('public.%I', v_t));
    CONTINUE WHEN v_oid IS NULL;
    n := n + 1;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_oid) THEN RAISE EXCEPTION 'Precondición: RLS apagada en %', v_t; END IF;
    IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = v_oid AND polname = v_new) THEN RAISE EXCEPTION 'La PARTE B ya está aplicada (%): no se repite', v_t; END IF;
    IF (SELECT count(*) FROM pg_policy WHERE polrelid = v_oid) <> 1 THEN RAISE EXCEPTION 'Precondición: % debe tener exactamente 1 política', v_t; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = v_oid AND polname = v_old AND polpermissive AND polcmd = '*' AND polroles = ARRAY[v_auth]::oid[]
                      AND pg_get_expr(polqual, polrelid) = 'true' AND pg_get_expr(polwithcheck, polrelid) = 'true') THEN
      RAISE EXCEPTION 'Precondición: la política de % no es la esperada (%): el estado difiere', v_t, v_old; END IF;
  END LOOP;
  IF n = 0 THEN RAISE NOTICE 'PARTE B: no existe ninguna tabla heredada en esta base; no se hace nada.'; RETURN; END IF;
  -- 2) aplicar (la política nueva se crea antes de quitar la anterior, en la misma transacción)
  FOR i IN 1 .. array_length(v_map, 1) LOOP
    v_t := v_map[i][1]; v_old := v_map[i][2]; v_new := v_t || '_rol_activo_v1'; v_oid := to_regclass(format('public.%I', v_t));
    CONTINUE WHEN v_oid IS NULL;
    EXECUTE format($p$CREATE POLICY %I ON public.%I AS PERMISSIVE FOR ALL TO authenticated
                      USING ((SELECT public.cardiolink_ctx_rol_v1()) = ANY (ARRAY['owner', 'admin', 'medico', 'secretaria']))
                      WITH CHECK ((SELECT public.cardiolink_ctx_rol_v1()) = ANY (ARRAY['owner', 'admin', 'medico', 'secretaria']))$p$, v_new, v_t);
    EXECUTE format('DROP POLICY %I ON public.%I', v_old, v_t);
  END LOOP;
  -- 3) postcondiciones
  FOR i IN 1 .. array_length(v_map, 1) LOOP
    v_t := v_map[i][1]; v_new := v_t || '_rol_activo_v1'; v_oid := to_regclass(format('public.%I', v_t));
    CONTINUE WHEN v_oid IS NULL;
    IF (SELECT count(*) FROM pg_policy WHERE polrelid = v_oid) <> 1
       OR NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = v_oid AND polname = v_new AND polpermissive AND polcmd = '*' AND polroles = ARRAY[v_auth]::oid[]
                        AND pg_get_expr(polqual, polrelid) LIKE '%cardiolink_ctx_rol_v1%' AND pg_get_expr(polwithcheck, polrelid) LIKE '%cardiolink_ctx_rol_v1%'
                        AND pg_get_expr(polqual, polrelid) <> 'true' AND pg_get_expr(polwithcheck, polrelid) <> 'true') THEN
      RAISE EXCEPTION 'Postcondición: la política de % no quedó como se esperaba', v_t; END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_oid) OR (SELECT relforcerowsecurity FROM pg_class WHERE oid = v_oid) THEN RAISE EXCEPTION 'Postcondición: RLS de % debe quedar activa y no forzada', v_t; END IF;
  END LOOP;
END $$;
COMMIT;
