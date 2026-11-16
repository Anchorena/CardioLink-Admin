-- CardioLink · Pendientes de cobro V1 — guard de cobros en backend (v4.1, DEFINITIVO PARA APROBACIÓN).
-- NO EJECUTADO en ningún proyecto. NO ejecutar sin autorización explícita. Primero STAGING (con _checks.sql antes y
-- _tests.sql después); Production sólo tras aprobar STAGING. Rollback: pending_review_cobros_v1_guard_medico_rollback.sql.
--
-- BRECHA. La RLS de cardiolink_atenciones es por FILA (cardiolink_permite_atencion_v1): un médico puede modificar el payload
-- COMPLETO de sus atenciones y borrarlas. Verificado en STAGING (2026-10-22): un médico confirmó un cobro por API directa.
--
-- QUIÉN PUEDE. owner/admin/secretaría (cardiolink_has_appointment_requests_access() = true; verificado en STAGING). Todos los
-- demás roles de la API (médico, sin rol) quedan sujetos a las reglas de abajo. Intercepta sólo current_user = authenticated/anon
-- (SECURITY INVOKER, igual que cardiolink_atenciones_proteger_identidad_v1): NO intercepta funciones SECURITY DEFINER
-- (cardiolink_pendiente_mutar_v1 y similares), service_role (Edge Functions) ni el SQL Editor.
--
-- REGLAS (a quien no puede confirmar cobros):
--  1) UPDATE: no puede cambiar el estado de cobro: estadoCobro, cobroPendienteEn/Por, cobroConfirmadoEn/Por/PorId/PorRol/PorEmail,
--     cobroMedioPago, cobroAuditoria.
--  2) UPDATE sobre un cobro YA CONFIRMADO por el flujo (la fila tiene cobroConfirmadoPorRol): tampoco puede cambiar los datos que
--     determinan el dinero y su atribución: montoConsulta, montoEstudio, montoCopago, montoTotal, tipoCobro, formaPago, noCobrar y
--     cajaPerfil; ni pasar el turno a cancelado/ausente (que sacaría el importe de Caja). NO se congelan fecha, obraSocial ni
--     coberturaAtencion: no cambian el dinero cobrado (el cobro diferido se atribuye a cobroConfirmadoEn) y así no se traba la
--     reprogramación de turnos desde Agenda.
--  3) DELETE: no puede borrar una atención con cobro pendiente o confirmado por el flujo.
--  Lo demás (ediciones clínicas, estado del turno, informes, firma/copia, observaciones, etc.) NO cambia.
--
-- ALCANCE ACOTADO. El trigger de UPDATE sólo se ejecuta si la fila trae o traía alguno de los 10 campos protegidos (WHEN completo
-- en OLD y NEW); el de DELETE, si la fila tiene cobro pendiente o cobroConfirmadoPorRol: atenciones históricas, la fila de
-- configuración y los mensajes NO ejecutan la función. Las filas "cobradas al registrar" y "sin cobro" NO quedan congeladas
-- (el médico que las crea puede seguir editándolas): sólo el cobro confirmado por Secretaría/Administración lo está.
--
-- NO CUBRE (límites del enfoque, ver docs/PENDIENTES_COBRO_V1.md): INSERT (un médico puede crear su propia atención ya cobrada:
-- indistinguible del flujo legítimo de Carga); los datos económicos de filas pendientes, cobradas al registrar o sin cobro; a
-- owner/admin/secretaría (por diseño pueden corregir; sus ediciones no generan auditoría de cobro); restaurar un backup
-- (Secretaría/Admin); service_role y SQL Editor.
-- Efecto colateral aceptado: un médico con copia local vieja que reintente subir una atención ya confirmada, o que edite sus datos
-- económicos, recibe 42501 (la interfaz de la rama ya lo evita: edición económica bloqueada y borrado con aviso).

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.cardiolink_atenciones') IS NULL THEN RAISE EXCEPTION 'Falta cardiolink_atenciones'; END IF;
  IF to_regprocedure('public.cardiolink_has_appointment_requests_access()') IS NULL THEN
    RAISE EXCEPTION 'Falta cardiolink_has_appointment_requests_access(): se usa para distinguir owner/admin/secretaria';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.cardiolink_has_appointment_requests_access()'::regprocedure) THEN
    RAISE EXCEPTION 'cardiolink_has_appointment_requests_access() debe ser SECURITY DEFINER';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.cardiolink_has_appointment_requests_access()', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated no puede ejecutar cardiolink_has_appointment_requests_access(): el guard (SECURITY INVOKER) la invoca con el rol de la API';
  END IF;
  IF to_regprocedure('public.cardiolink_atenciones_guard_cobro_v1()') IS NOT NULL THEN
    RAISE EXCEPTION 'El guard de cobros ya existe: no se repite';
  END IF;
END $$;

CREATE FUNCTION public.cardiolink_atenciones_guard_cobro_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  c_estado constant text[] := ARRAY[
    'estadoCobro', 'cobroPendienteEn', 'cobroPendientePor', 'cobroConfirmadoEn', 'cobroConfirmadoPor',
    'cobroConfirmadoPorId', 'cobroConfirmadoPorRol', 'cobroConfirmadoPorEmail', 'cobroMedioPago', 'cobroAuditoria'];
  c_economicos constant text[] := ARRAY[
    'montoConsulta', 'montoEstudio', 'montoCopago', 'montoTotal', 'tipoCobro', 'formaPago', 'noCobrar', 'cajaPerfil'];
  v_campo text;
  v_old_turno text;
  v_new_turno text;
BEGIN
  -- Sólo escrituras con rol de la API. SECURITY DEFINER de terceros, service_role y SQL Editor no se interceptan.
  IF current_user NOT IN ('authenticated', 'anon') THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  -- owner / admin / secretaría: pueden registrar, confirmar y corregir cobros.
  IF coalesce(public.cardiolink_has_appointment_requests_access(), false) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.payload ->> 'estadoCobro' = 'pendiente' OR OLD.payload ? 'cobroConfirmadoPorRol' THEN
      RAISE EXCEPTION 'Rol no autorizado para eliminar una atención con cobro pendiente o confirmado.' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE (1): estado de cobro
  FOREACH v_campo IN ARRAY c_estado LOOP
    IF (OLD.payload -> v_campo) IS DISTINCT FROM (NEW.payload -> v_campo) THEN
      RAISE EXCEPTION 'Rol no autorizado para modificar el estado de cobro (%).', v_campo USING ERRCODE = '42501';
    END IF;
  END LOOP;

  -- UPDATE (2): cobro ya confirmado por el flujo -> datos económicos congelados
  IF OLD.payload ? 'cobroConfirmadoPorRol' THEN
    FOREACH v_campo IN ARRAY c_economicos LOOP
      IF (OLD.payload -> v_campo) IS DISTINCT FROM (NEW.payload -> v_campo) THEN
        RAISE EXCEPTION 'Rol no autorizado para modificar un dato económico de un cobro confirmado (%).', v_campo USING ERRCODE = '42501';
      END IF;
    END LOOP;
    v_old_turno := lower(coalesce(OLD.payload ->> 'estadoTurno', OLD.payload ->> 'estado', ''));
    v_new_turno := lower(coalesce(NEW.payload ->> 'estadoTurno', NEW.payload ->> 'estado', ''));
    IF v_new_turno IN ('cancelado', 'ausente') AND v_new_turno IS DISTINCT FROM v_old_turno THEN
      RAISE EXCEPTION 'Rol no autorizado para cancelar o marcar ausente una atención con cobro confirmado.' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.cardiolink_atenciones_guard_cobro_v1() FROM PUBLIC, anon, authenticated;

-- El WHEN usa EXACTAMENTE los 10 campos protegidos (c_estado de la función), tanto en OLD como en NEW: si la fila no tenía ni
-- trae ninguno de ellos (atenciones históricas, config, mensajes), el trigger no se ejecuta. Mantener sincronizadas ambas listas.
CREATE TRIGGER cardiolink_atenciones_guard_cobro_v1
  BEFORE UPDATE ON public.cardiolink_atenciones
  FOR EACH ROW
  WHEN (jsonb_exists_any(OLD.payload, ARRAY['estadoCobro', 'cobroPendienteEn', 'cobroPendientePor', 'cobroConfirmadoEn', 'cobroConfirmadoPor',
                              'cobroConfirmadoPorId', 'cobroConfirmadoPorRol', 'cobroConfirmadoPorEmail', 'cobroMedioPago', 'cobroAuditoria'])
        OR jsonb_exists_any(NEW.payload, ARRAY['estadoCobro', 'cobroPendienteEn', 'cobroPendientePor', 'cobroConfirmadoEn', 'cobroConfirmadoPor',
                              'cobroConfirmadoPorId', 'cobroConfirmadoPorRol', 'cobroConfirmadoPorEmail', 'cobroMedioPago', 'cobroAuditoria']))
  EXECUTE FUNCTION public.cardiolink_atenciones_guard_cobro_v1();

CREATE TRIGGER cardiolink_atenciones_guard_cobro_v1_del
  BEFORE DELETE ON public.cardiolink_atenciones
  FOR EACH ROW
  WHEN (OLD.payload ->> 'estadoCobro' = 'pendiente' OR jsonb_exists(OLD.payload, 'cobroConfirmadoPorRol'))
  EXECUTE FUNCTION public.cardiolink_atenciones_guard_cobro_v1();

-- Verificación posterior (aborta y revierte todo si algo no quedó como se espera).
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.cardiolink_atenciones'::regclass AND NOT tgisinternal
        AND tgname IN ('cardiolink_atenciones_guard_cobro_v1', 'cardiolink_atenciones_guard_cobro_v1_del') AND tgenabled = 'O') <> 2 THEN
    RAISE EXCEPTION 'Los triggers de cobros no quedaron habilitados';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.cardiolink_atenciones_guard_cobro_v1()'::regprocedure) THEN
    RAISE EXCEPTION 'La función del trigger no puede ser SECURITY DEFINER (current_user dejaría de identificar al rol de la API)';
  END IF;
  IF has_function_privilege('anon', 'public.cardiolink_atenciones_guard_cobro_v1()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.cardiolink_atenciones_guard_cobro_v1()', 'EXECUTE') THEN
    RAISE EXCEPTION 'La función del trigger no debe ser ejecutable por anon/authenticated';
  END IF;
END $$;

COMMIT;
