-- CardioLink · Bloque 0B · ROLLBACK de la PARTE A (cardiolink_pacientes)
-- ATENCIÓN: restaura la política ABIERTA original (USING true / WITH CHECK true): cualquier sesión autenticada, con o sin rol activo, vuelve a leer y escribir el padrón.
-- Usar sólo si la política nueva bloquea un flujo legítimo que no se pudo corregir de otra forma. Una sola transacción; falla si el estado no es el esperado.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $$
DECLARE v_oid oid := to_regclass('public.cardiolink_pacientes');
BEGIN
  IF v_oid IS NULL THEN RAISE EXCEPTION 'Precondición: falta public.cardiolink_pacientes'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = v_oid AND polname = 'cardiolink_pacientes_rol_activo_v1') THEN RAISE EXCEPTION 'La PARTE A no está aplicada: nada que revertir'; END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = v_oid AND polname = 'cardiolink_pacientes_authenticated') THEN RAISE EXCEPTION 'Precondición: ya existe cardiolink_pacientes_authenticated (estado inesperado)'; END IF;
  IF (SELECT count(*) FROM pg_policy WHERE polrelid = v_oid) <> 1 THEN RAISE EXCEPTION 'Precondición: se esperaba exactamente 1 política en cardiolink_pacientes'; END IF;
END $$;

CREATE POLICY cardiolink_pacientes_authenticated ON public.cardiolink_pacientes AS PERMISSIVE FOR ALL TO authenticated USING (true) WITH CHECK (true);
DROP POLICY cardiolink_pacientes_rol_activo_v1 ON public.cardiolink_pacientes;

DO $$
DECLARE v_oid oid := 'public.cardiolink_pacientes'::regclass;
BEGIN
  IF (SELECT count(*) FROM pg_policy WHERE polrelid = v_oid) <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = v_oid AND polname = 'cardiolink_pacientes_authenticated' AND polpermissive AND polcmd = '*'
                      AND polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname = 'authenticated')]::oid[] AND pg_get_expr(polqual, polrelid) = 'true' AND pg_get_expr(polwithcheck, polrelid) = 'true') THEN
    RAISE EXCEPTION 'Postcondición: no se restauró la política original'; END IF;
END $$;
COMMIT;
