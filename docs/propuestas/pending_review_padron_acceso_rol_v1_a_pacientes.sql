-- CardioLink · Bloque 0B · Acceso al padrón sólo con rol ACTIVO · PARTE A · cardiolink_pacientes
-- BORRADOR PARA REVISIÓN. NO EJECUTAR en Production ni en STAGING sin autorización explícita. Primero el ensayo reversible (pending_review_padron_acceso_rol_v1_ensayo_reversible.sql).
-- Una sola transacción, sin DML sobre datos. Falla (y revierte todo) si el estado de partida no es exactamente el esperado. Rollback: pending_review_padron_acceso_rol_v1_a_pacientes_rollback.sql
--
-- PROBLEMA (verificado en solo lectura, 2026-11-24, en Production y en STAGING): cardiolink_pacientes tiene UNA sola política, cardiolink_pacientes_authenticated:
--   PERMISSIVE, ALL, TO authenticated, USING (true) WITH CHECK (true).
-- Cualquier sesión de Supabase Auth —aunque no tenga fila en cardiolink_user_roles, o la tenga con active=false— lee y escribe el padrón completo (1055 pacientes en Production).
-- Efecto directo sobre Gestión de Usuarios V1: desactivar una cuenta (active=false) NO le quita el padrón; sólo vencería su JWT.
--
-- CORRECCIÓN MÍNIMA. Se reemplaza esa política por una equivalente CON LA MISMA ALCANCE FUNCIONAL para el personal y cerrada para el resto:
--   cardiolink_pacientes_rol_activo_v1: PERMISSIVE, ALL, TO authenticated, USING / WITH CHECK  (SELECT cardiolink_ctx_rol_v1()) = ANY ('owner','admin','medico','secretaria').
-- cardiolink_ctx_rol_v1() (SECURITY DEFINER, search_path fijo, ya en uso por las políticas de atenciones, documentos y Storage) devuelve el base_role SÓLO si la fila de
-- cardiolink_user_roles del auth.uid() está activa; en cualquier otro caso NULL ⇒ la comparación da NULL ⇒ acceso denegado (falla cerrada).
--
-- PADRÓN COMPARTIDO PRESERVADO (decisión del Dueño): todo owner, admin, médico y Secretaría ACTIVO conserva exactamente el mismo acceso de hoy (leer, crear, actualizar/upsert y borrar);
-- no se distingue por profesional ni por asociación. No cambia ninguna otra política, ninguna función, ningún privilegio de tabla ni ningún dato.
-- NO se ven afectados: service_role (BYPASSRLS: portal-gateway, appointment-cancellation-public, patient-reminders-24h, patient-communications, patient-document-delivery);
-- las funciones SECURITY DEFINER que consultan el padrón (cardiolink_paciente_padron_v1, acceso_clinico, etc.); las comprobaciones de claves foráneas (las hace el sistema sin RLS).
-- Sí quedan sin acceso (intencionalmente): sesiones sin fila en cardiolink_user_roles y cuentas con active=false.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
DECLARE v_oid oid := to_regclass('public.cardiolink_pacientes');
        v_auth oid := (SELECT oid FROM pg_roles WHERE rolname = 'authenticated');
BEGIN
  IF v_oid IS NULL THEN RAISE EXCEPTION 'Precondición: falta public.cardiolink_pacientes'; END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_oid) THEN RAISE EXCEPTION 'Precondición: RLS apagada en cardiolink_pacientes (no es el estado esperado)'; END IF;
  IF to_regprocedure('public.cardiolink_ctx_rol_v1()') IS NULL THEN RAISE EXCEPTION 'Precondición: falta public.cardiolink_ctx_rol_v1()'; END IF;
  IF NOT (SELECT prosecdef AND coalesce(proconfig::text, '') LIKE '%search_path=pg_catalog, public%' FROM pg_proc WHERE oid = to_regprocedure('public.cardiolink_ctx_rol_v1()')) THEN
    RAISE EXCEPTION 'Precondición: cardiolink_ctx_rol_v1() debe ser SECURITY DEFINER con search_path fijo'; END IF;
  IF NOT has_function_privilege('authenticated', 'public.cardiolink_ctx_rol_v1()', 'EXECUTE') OR has_function_privilege('anon', 'public.cardiolink_ctx_rol_v1()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Precondición: privilegios de cardiolink_ctx_rol_v1() (authenticated sí, anon no)'; END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = v_oid AND polname = 'cardiolink_pacientes_rol_activo_v1') THEN RAISE EXCEPTION 'La PARTE A ya está aplicada: no se repite'; END IF;
  IF (SELECT count(*) FROM pg_policy WHERE polrelid = v_oid) <> 1 THEN RAISE EXCEPTION 'Precondición: cardiolink_pacientes debe tener exactamente 1 política (tiene %)', (SELECT count(*) FROM pg_policy WHERE polrelid = v_oid); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = v_oid AND polname = 'cardiolink_pacientes_authenticated' AND polpermissive AND polcmd = '*'
                    AND polroles = ARRAY[v_auth]::oid[] AND pg_get_expr(polqual, polrelid) = 'true' AND pg_get_expr(polwithcheck, polrelid) = 'true') THEN
    RAISE EXCEPTION 'Precondición: la política de cardiolink_pacientes no es la esperada (cardiolink_pacientes_authenticated, PERMISSIVE, ALL, authenticated, true/true): el estado difiere'; END IF;
END $$;

-- Se crea la nueva ANTES de quitar la anterior, dentro de la misma transacción: ninguna otra sesión llega a ver un estado intermedio.
CREATE POLICY cardiolink_pacientes_rol_activo_v1 ON public.cardiolink_pacientes
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((SELECT public.cardiolink_ctx_rol_v1()) = ANY (ARRAY['owner', 'admin', 'medico', 'secretaria']))
  WITH CHECK ((SELECT public.cardiolink_ctx_rol_v1()) = ANY (ARRAY['owner', 'admin', 'medico', 'secretaria']));
COMMENT ON POLICY cardiolink_pacientes_rol_activo_v1 ON public.cardiolink_pacientes IS 'Bloque 0B: padrón compartido por todo el personal con rol ACTIVO (owner/admin/medico/secretaria). Sin fila en cardiolink_user_roles o con active=false: sin acceso. Reemplaza a cardiolink_pacientes_authenticated (true/true).';
DROP POLICY cardiolink_pacientes_authenticated ON public.cardiolink_pacientes;

-- Postcondiciones
DO $$
DECLARE v_oid oid := 'public.cardiolink_pacientes'::regclass; q text; w text;
BEGIN
  IF (SELECT count(*) FROM pg_policy WHERE polrelid = v_oid) <> 1 THEN RAISE EXCEPTION 'Postcondición: debe quedar exactamente 1 política en cardiolink_pacientes'; END IF;
  SELECT pg_get_expr(polqual, polrelid), pg_get_expr(polwithcheck, polrelid) INTO q, w FROM pg_policy
   WHERE polrelid = v_oid AND polname = 'cardiolink_pacientes_rol_activo_v1' AND polpermissive AND polcmd = '*' AND polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname = 'authenticated')]::oid[];
  IF q IS NULL THEN RAISE EXCEPTION 'Postcondición: la política nueva no quedó PERMISSIVE / ALL / authenticated'; END IF;
  IF q = 'true' OR w = 'true' OR q NOT LIKE '%cardiolink_ctx_rol_v1%' OR w NOT LIKE '%cardiolink_ctx_rol_v1%' THEN RAISE EXCEPTION 'Postcondición: la política no depende del rol activo'; END IF;
  IF q NOT LIKE '%owner%' OR q NOT LIKE '%admin%' OR q NOT LIKE '%medico%' OR q NOT LIKE '%secretaria%' THEN RAISE EXCEPTION 'Postcondición: falta alguno de los cuatro roles en la política'; END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_oid) OR (SELECT relforcerowsecurity FROM pg_class WHERE oid = v_oid) THEN RAISE EXCEPTION 'Postcondición: RLS debe quedar activada y NO forzada (service_role y las funciones SECURITY DEFINER dependen de ello)'; END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = v_oid AND polname = 'cardiolink_pacientes_authenticated') THEN RAISE EXCEPTION 'Postcondición: sigue existiendo la política abierta'; END IF;
END $$;
COMMIT;
