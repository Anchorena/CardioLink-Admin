-- CardioLink · Seguridad clínica V1 · p3c · AJUSTE 1 · INTEGRIDAD DE EVOLUCIONES (protección mínima en base de datos). Aprobado por el Dueño (2026-11-20).
-- ESTADO: PREPARADO PARA REVISIÓN. NO EJECUTAR en Production sin autorización explícita. Una sola transacción, sin DML sobre datos. Rollback: …_p3c_integridad_evoluciones_rollback.sql
-- Requiere p3c aplicada (o el delta) y cardiolink_ctx_rol_v1().
--
-- HUECO CERRADO: la política de UPDATE de evoluciones permite al médico editar sus evoluciones y valida (WITH CHECK) que sigan siendo suyas, pero NO impedía cambiar paciente_id a OTRO paciente existente
-- (el ensayo lo demuestra antes de aplicar este trigger). Un trigger BEFORE UPDATE congela la identidad de la fila:
--   · id y paciente_id: inmutables para cualquier sesión de usuario (owner/admin incluidos). Una evolución mal cargada se corrige borrándola y creándola de nuevo, o con mantenimiento por SQL.
--   · profesional_id: sólo owner/admin pueden cambiarlo (permiso existente); cualquier otro rol recibe 42501 (defensa en profundidad: las políticas RLS ya lo impedían al médico).
--   · Mantenimiento por SQL Editor/postgres/service_role (sin sesión de usuario: auth.uid() nulo) no se ve afectado (backfills, correcciones administrativas).
-- COMPATIBILIDAD PR #33: el guardado multidispositivo sólo actualiza campos de contenido + editado_en/editado_por; el upsert de reintento (ON CONFLICT (id)) reenvía el MISMO paciente_id y profesional_id. Ninguno cambia id/paciente_id/profesional_id.
BEGIN;
DO $$
BEGIN
  IF to_regclass('public.cardiolink_hc_evoluciones') IS NULL OR to_regprocedure('public.cardiolink_ctx_rol_v1()') IS NULL THEN RAISE EXCEPTION 'Precondición: faltan cardiolink_hc_evoluciones / cardiolink_ctx_rol_v1()'; END IF;
  IF (SELECT qual FROM pg_policies WHERE schemaname='public' AND policyname='cardiolink_hc_evoluciones_select_v1') IS NULL OR (SELECT qual FROM pg_policies WHERE schemaname='public' AND policyname='cardiolink_hc_evoluciones_select_v1') NOT LIKE '%cardiolink_paciente_padron_v1%' THEN
    RAISE EXCEPTION 'Precondición: aplicar antes p3c (o su delta)'; END IF;
  IF to_regprocedure('public.cardiolink_hc_evolucion_inmutables_v1()') IS NOT NULL OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.cardiolink_hc_evoluciones'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'Precondición: ya existe la función/trigger de integridad u otro trigger sobre cardiolink_hc_evoluciones (¿ya aplicado?)'; END IF;
END $$;

CREATE FUNCTION public.cardiolink_hc_evolucion_inmutables_v1()
 RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $f$
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;   -- sin sesión de usuario = mantenimiento (SQL Editor / postgres / service_role)
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.paciente_id IS DISTINCT FROM OLD.paciente_id THEN
    RAISE EXCEPTION 'Una evolución no puede cambiar de paciente' USING ERRCODE = '42501';
  END IF;
  IF NEW.profesional_id IS DISTINCT FROM OLD.profesional_id AND coalesce(public.cardiolink_ctx_rol_v1(), '') NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'No se puede transferir la evolución a otro profesional' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $f$;
REVOKE ALL ON FUNCTION public.cardiolink_hc_evolucion_inmutables_v1() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.cardiolink_hc_evolucion_inmutables_v1() IS 'Seguridad clínica V1 p3c: id y paciente_id de una evolución son inmutables para sesiones de usuario; profesional_id sólo lo cambia owner/admin. SECURITY INVOKER; mantenimiento sin sesión no se ve afectado.';

CREATE TRIGGER cardiolink_hc_evoluciones_inmutables_v1
  BEFORE UPDATE ON public.cardiolink_hc_evoluciones
  FOR EACH ROW EXECUTE FUNCTION public.cardiolink_hc_evolucion_inmutables_v1();

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.cardiolink_hc_evoluciones'::regclass AND NOT tgisinternal AND tgname='cardiolink_hc_evoluciones_inmutables_v1' AND tgenabled='O') <> 1 THEN RAISE EXCEPTION 'Postcondición: el trigger no quedó habilitado'; END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid='public.cardiolink_hc_evolucion_inmutables_v1()'::regprocedure) THEN RAISE EXCEPTION 'Postcondición: la función del trigger no debe ser SECURITY DEFINER'; END IF;
END $$;
COMMIT;
