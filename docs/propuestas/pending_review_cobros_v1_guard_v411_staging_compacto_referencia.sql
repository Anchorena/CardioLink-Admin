-- CardioLink · Pendientes de cobro V1 — REFERENCIA EXACTA del guard v4.1.1 tal como está instalado en STAGING (cuerpo COMPACTO, md5 b511fed99268c140651ee622b84fde0b).
-- Extraído de pg_proc.prosrc de STAGING (yslhwdlzdknhskawqrtv) el 2026-11-14, en modo solo lectura. Es lógicamente idéntico a
-- pending_review_cobros_v1_guard_medico.sql (v4.1.1 formateado, md5 5d9ac1d364bd571b60f5551d94903e83): sin comentarios ni espacios son iguales carácter por carácter.
-- NO ejecutar por sí solo. Es la fuente del rollback A cuando el estado previo registrado es md5_previo=b511fed99268c140651ee622b84fde0b.
-- Metadatos en STAGING antes de v4.2: LANGUAGE plpgsql, SECURITY INVOKER, VOLATILE, SET search_path = pg_catalog, public, owner postgres,
-- ACL {postgres=X/postgres, service_role=X/postgres}, sin COMMENT.
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
$function$;
