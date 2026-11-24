-- CardioLink · Bloque 0B · ROLLBACK de la PARTE B (tablas heredadas)
-- ATENCIÓN: restaura las políticas ABIERTAS originales (true/true) en las tablas heredadas que tengan la política *_rol_activo_v1. Una sola transacción; no toca datos.
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
  FOR i IN 1 .. array_length(v_map, 1) LOOP
    v_t := v_map[i][1]; v_old := v_map[i][2]; v_new := v_t || '_rol_activo_v1'; v_oid := to_regclass(format('public.%I', v_t));
    CONTINUE WHEN v_oid IS NULL;
    IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = v_oid AND polname = v_new) THEN RAISE EXCEPTION 'La PARTE B no está aplicada en %: nada que revertir', v_t; END IF;
    IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = v_oid AND polname = v_old) OR (SELECT count(*) FROM pg_policy WHERE polrelid = v_oid) <> 1 THEN RAISE EXCEPTION 'Precondición: estado inesperado de las políticas de %', v_t; END IF;
    n := n + 1;
  END LOOP;
  IF n = 0 THEN RAISE NOTICE 'PARTE B: no existe ninguna tabla heredada en esta base; no se hace nada.'; RETURN; END IF;
  FOR i IN 1 .. array_length(v_map, 1) LOOP
    v_t := v_map[i][1]; v_old := v_map[i][2]; v_new := v_t || '_rol_activo_v1'; v_oid := to_regclass(format('public.%I', v_t));
    CONTINUE WHEN v_oid IS NULL;
    EXECUTE format('CREATE POLICY %I ON public.%I AS PERMISSIVE FOR ALL TO authenticated USING (true) WITH CHECK (true)', v_old, v_t);
    EXECUTE format('DROP POLICY %I ON public.%I', v_new, v_t);
    IF (SELECT count(*) FROM pg_policy WHERE polrelid = v_oid) <> 1
       OR NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = v_oid AND polname = v_old AND polpermissive AND polcmd = '*' AND polroles = ARRAY[v_auth]::oid[]
                        AND pg_get_expr(polqual, polrelid) = 'true' AND pg_get_expr(polwithcheck, polrelid) = 'true') THEN
      RAISE EXCEPTION 'Postcondición: no se restauró la política original de %', v_t; END IF;
  END LOOP;
END $$;
COMMIT;
