-- CardioLink · Pendientes de cobro V1 — ROLLBACK A de v4.2.1: restaura EXACTAMENTE el guard v4.1.1 que había antes (STAGING).
-- NO EJECUTADO. Sólo para un proyecto cuya función guard fue reemplazada por v4.2.1 con estado_previo=v4.1.1 (marca en el COMMENT, junto con
-- md5_previo). Restaura el cuerpo previo identificado por ese md5, sin aceptar otros:
--   b511fed99268c140651ee622b84fde0b  cuerpo compacto instalado en STAGING (referencia: pending_review_cobros_v1_guard_v411_staging_compacto_referencia.sql)
--   5d9ac1d364bd571b60f5551d94903e83  cuerpo formateado del repositorio (pending_review_cobros_v1_guard_medico.sql)
-- NO usar en Production si Production partió SIN guard (usar ..._v4211_rollback_b_production_sin_guard.sql). No toca datos, políticas ni el
-- trigger de identidad. Quita el trigger de INSERT y deja los 2 triggers de v4.1.1 intactos. Metadatos restaurados: sin COMMENT (v4.1.1 no tenía),
-- SET search_path = pg_catalog, public, SECURITY INVOKER; el ACL no se altera (CREATE OR REPLACE lo conserva) y se verifica que anon/authenticated no ejecutan.
BEGIN;
DO $$
DECLARE v_cmt text; v_md5 text;
BEGIN
  IF to_regprocedure('public.cardiolink_atenciones_guard_cobro_v1()') IS NULL THEN RAISE EXCEPTION 'No existe el guard: nada que revertir'; END IF;
  v_cmt := coalesce(obj_description('public.cardiolink_atenciones_guard_cobro_v1()'::regprocedure, 'pg_proc'), '');
  IF v_cmt NOT LIKE '%[cobros-guard v4.2.1]%' THEN RAISE EXCEPTION 'La función vigente no es la v4.2.1 (comentario: %). No se revierte.', v_cmt; END IF;
  IF v_cmt NOT LIKE '%estado_previo=v4.1.1%' THEN
    RAISE EXCEPTION 'El estado previo registrado NO es v4.1.1 (%): usar el rollback B en lugar de este.', v_cmt; END IF;
  v_md5 := substring(v_cmt from 'md5_previo=([0-9a-f]{32})');
  IF v_md5 IS NULL OR v_md5 NOT IN ('5d9ac1d364bd571b60f5551d94903e83', 'b511fed99268c140651ee622b84fde0b') THEN
    RAISE EXCEPTION 'md5_previo ausente o desconocido (%): no se revierte.', v_md5; END IF;
  PERFORM set_config('cardiolink.cobros_guard_md5_rollback', v_md5, true);
END $$;

DROP TRIGGER IF EXISTS cardiolink_atenciones_guard_cobro_v1_ins ON public.cardiolink_atenciones;
DROP FUNCTION IF EXISTS public.cardiolink_atenciones_guard_cobro_ins_v1();

DO $rb$
BEGIN
  IF current_setting('cardiolink.cobros_guard_md5_rollback') = 'b511fed99268c140651ee622b84fde0b' THEN
    EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.cardiolink_atenciones_guard_cobro_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  c_estado constant text[] := ARRAY['estadoCobro','cobroPendienteEn','cobroPendientePor','cobroConfirmadoEn','cobroConfirmadoPor','cobroConfirmadoPorId','cobroConfirmadoPorRol','cobroConfirmadoPorEmail','cobroMedioPago','cobroAuditoria'];
  c_economicos constant text[] := ARRAY['montoConsulta','montoEstudio','montoCopago','montoTotal','tipoCobro','formaPago','noCobrar','cajaPerfil'];
  v_campo text;
  v_old_turno text;
  v_new_turno text;
BEGIN
  IF current_user NOT IN ('authenticated','anon') THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF coalesce(public.cardiolink_has_appointment_requests_access(),false) THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.payload ->> 'estadoCobro'='pendiente' OR OLD.payload ? 'cobroConfirmadoPorRol' THEN
      RAISE EXCEPTION 'Rol no autorizado para eliminar una atención con cobro pendiente o confirmado.' USING ERRCODE='42501';
    END IF;
    RETURN OLD;
  END IF;
  FOREACH v_campo IN ARRAY c_estado LOOP
    IF (OLD.payload -> v_campo) IS DISTINCT FROM (NEW.payload -> v_campo) THEN
      RAISE EXCEPTION 'Rol no autorizado para modificar el estado de cobro (%).',v_campo USING ERRCODE='42501';
    END IF;
  END LOOP;
  IF OLD.payload ? 'cobroConfirmadoPorRol' THEN
    FOREACH v_campo IN ARRAY c_economicos LOOP
      IF (OLD.payload -> v_campo) IS DISTINCT FROM (NEW.payload -> v_campo) THEN
        RAISE EXCEPTION 'Rol no autorizado para modificar un dato económico de un cobro confirmado (%).',v_campo USING ERRCODE='42501';
      END IF;
    END LOOP;
    v_old_turno:=lower(coalesce(OLD.payload ->> 'estadoTurno',OLD.payload ->> 'estado',''));
    v_new_turno:=lower(coalesce(NEW.payload ->> 'estadoTurno',NEW.payload ->> 'estado',''));
    IF v_new_turno IN ('cancelado','ausente') AND v_new_turno IS DISTINCT FROM v_old_turno THEN
      RAISE EXCEPTION 'Rol no autorizado para cancelar o marcar ausente una atención con cobro confirmado.' USING ERRCODE='42501';
    END IF;
  END IF;
  RETURN NEW;
END
$function$
$ddl$;
  ELSE
    EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.cardiolink_atenciones_guard_cobro_v1()
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
$function$
$ddl$;
  END IF;
END $rb$;
COMMENT ON FUNCTION public.cardiolink_atenciones_guard_cobro_v1() IS NULL;
REVOKE ALL ON FUNCTION public.cardiolink_atenciones_guard_cobro_v1() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.cardiolink_atenciones_guard_cobro_v1()'::regprocedure)) <> current_setting('cardiolink.cobros_guard_md5_rollback') THEN
    RAISE EXCEPTION 'La función restaurada no coincide con el md5_previo registrado'; END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.cardiolink_atenciones'::regclass AND NOT tgisinternal AND tgenabled = 'O'
        AND tgname IN ('cardiolink_atenciones_guard_cobro_v1', 'cardiolink_atenciones_guard_cobro_v1_del')) <> 2 THEN
    RAISE EXCEPTION 'Faltan los 2 triggers de la v4.1.1'; END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.cardiolink_atenciones'::regclass AND tgname = 'cardiolink_atenciones_guard_cobro_v1_ins')
     OR to_regprocedure('public.cardiolink_atenciones_guard_cobro_ins_v1()') IS NOT NULL THEN
    RAISE EXCEPTION 'Quedó el guard de INSERT'; END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.cardiolink_atenciones_guard_cobro_v1()'::regprocedure) THEN
    RAISE EXCEPTION 'La función debe ser SECURITY INVOKER'; END IF;
  IF has_function_privilege('anon', 'public.cardiolink_atenciones_guard_cobro_v1()', 'EXECUTE') OR has_function_privilege('authenticated', 'public.cardiolink_atenciones_guard_cobro_v1()', 'EXECUTE') THEN
    RAISE EXCEPTION 'La función no debe ser ejecutable por anon/authenticated'; END IF;
END $$;
COMMIT;
