-- CardioLink · Pendientes médicos V1
-- MIGRACIÓN PENDIENTE DE REVISIÓN: reflejo de STAGING 2026-10-12.
-- No ejecutar sin respaldo, verificación de roles y QA de regresión.
-- Merge de Git NO instala estas funciones.
BEGIN;
CREATE OR REPLACE FUNCTION public.cardiolink_identidad_pendientes_v1()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT COALESCE((SELECT jsonb_build_object('role',base_role,'professional_id',professional_id)
                   FROM public.cardiolink_user_roles
                   WHERE user_id=auth.uid() AND active IS TRUE),'{}'::jsonb)
$function$;
REVOKE ALL ON FUNCTION public.cardiolink_identidad_pendientes_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cardiolink_identidad_pendientes_v1() TO authenticated;

CREATE OR REPLACE FUNCTION public.cardiolink_pendiente_mutar_v1(p_id text, p_tipo text, p_operacion text DEFAULT 'resolver'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_role text;v_prof text;v_payload jsonb;v_result jsonb;
  v_audit jsonb;v_last jsonb;v_prev jsonb:='{}'::jsonb;v_field text;
  v_fields text[];v_ts timestamptz:=clock_timestamp();
  v_cancel boolean;v_study boolean;v_cancelled boolean;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sesión requerida';END IF;
  SELECT base_role,professional_id INTO v_role,v_prof
   FROM public.cardiolink_user_roles WHERE user_id=auth.uid() AND active IS TRUE;
  IF NOT FOUND OR v_role NOT IN ('owner','admin','secretaria','medico') THEN
    RAISE EXCEPTION 'Rol no autorizado';
  END IF;
  IF coalesce(btrim(p_id),'')='' OR p_tipo NOT IN
    ('firma','copia','informe','entrega','retiro','autorizacion','cancelado_paciente')
    OR p_operacion NOT IN ('resolver','deshacer') THEN
    RAISE EXCEPTION 'Parámetros no válidos';
  END IF;
  SELECT payload INTO v_payload FROM public.cardiolink_atenciones
    WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Atención inexistente o inaccesible';END IF;
  IF v_role='medico' AND
    (nullif(btrim(v_prof),'') IS NULL OR v_prof IS DISTINCT FROM v_payload->>'profesionalId') THEN
    RAISE EXCEPTION 'Atención no autorizada';
  END IF;
  v_cancelled := lower(coalesce(v_payload->>'estadoTurno',v_payload->>'estado',''))='cancelado';
  v_study := (lower(coalesce(v_payload->>'prestacion','')) ~ '(holter|mapa|ecg|electro|eco|estudio|ergometr|doppler)');
  v_fields:=CASE p_tipo
    WHEN 'firma' THEN ARRAY['bonoFirmado']
    WHEN 'copia' THEN ARRAY['copiaImpresa']
    WHEN 'informe' THEN ARRAY['estudioInformado']
    WHEN 'entrega' THEN ARRAY['estudioImpreso','disponibleRetiro']
    WHEN 'retiro' THEN ARRAY['retiradoFisico','fechaRetiroFisico']
    WHEN 'autorizacion' THEN ARRAY['autorizacionCompleta']
    WHEN 'cancelado_paciente' THEN ARRAY['pendienteCancelacionResuelto',
       'pendienteCancelacionResueltoEn','pendienteCancelacionResueltoPor']
  END;
  v_audit := CASE WHEN jsonb_typeof(v_payload->'auditoriaPendientes')='array'
     THEN v_payload->'auditoriaPendientes' ELSE '[]'::jsonb END;
  v_result:=v_payload;
  IF p_operacion='resolver' THEN
    IF lower(coalesce(v_payload->>'estadoTurno',v_payload->>'estado',''))='ausente'
      THEN RAISE EXCEPTION 'Atención ausente';END IF;
    IF p_tipo='cancelado_paciente' THEN
      IF NOT(v_cancelled AND v_payload->>'canceladoPor'='Paciente (email)'
         AND coalesce(v_payload->>'pendienteCancelacionResuelto','false')='false')
      THEN RAISE EXCEPTION 'Cancelación no pendiente';END IF;
    ELSIF v_cancelled THEN RAISE EXCEPTION 'Atención cancelada';
    END IF;
    IF p_tipo='firma' AND NOT
       (coalesce((v_payload->>'bonoConsulta')::boolean,false)
        OR coalesce((v_payload->>'bonoEstudio')::boolean,false))
       THEN RAISE EXCEPTION 'Firma no requerida';END IF;
    IF p_tipo='copia' AND NOT
       (coalesce((v_payload->>'bonoEstudio')::boolean,false)
        OR coalesce((v_payload->>'requiereCopiaImpresa')::boolean,false))
       THEN RAISE EXCEPTION 'Copia no requerida';END IF;
    IF p_tipo='autorizacion' AND NOT coalesce((v_payload->>'requiereAutorizacion')::boolean,false)
       THEN RAISE EXCEPTION 'Autorización no requerida';END IF;
    IF p_tipo IN ('informe','entrega','retiro') AND NOT v_study
       THEN RAISE EXCEPTION 'Pendiente no corresponde a estudio';END IF;
    IF p_tipo='entrega' AND coalesce((v_payload->>'estudioInformado')::boolean,false)=false
       THEN RAISE EXCEPTION 'Informe aún pendiente';END IF;
    IF p_tipo='retiro' AND coalesce((v_payload->>'estudioImpreso')::boolean,false)=false
       THEN RAISE EXCEPTION 'Estudio aún no impreso';END IF;
    IF coalesce(v_payload->>v_fields[1],'false')='true'
       THEN RAISE EXCEPTION 'Ya resuelto';END IF;
    FOREACH v_field IN ARRAY v_fields LOOP
      v_prev:=v_prev||jsonb_build_object(v_field,v_payload->v_field);
    END LOOP;
    v_result:=jsonb_set(v_result,ARRAY[v_fields[1]],'true'::jsonb,true);
    IF p_tipo='entrega' THEN
      v_result:=jsonb_set(v_result,'{disponibleRetiro}','true'::jsonb,true);
    ELSIF p_tipo='retiro' THEN
      v_result:=jsonb_set(v_result,'{fechaRetiroFisico}',to_jsonb(v_ts::text),true);
    ELSIF p_tipo='cancelado_paciente' THEN
      v_result:=jsonb_set(v_result,'{pendienteCancelacionResueltoEn}',to_jsonb(v_ts::text),true);
      v_result:=jsonb_set(v_result,'{pendienteCancelacionResueltoPor}',to_jsonb(auth.uid()::text),true);
    END IF;
    v_audit:=v_audit||jsonb_build_array(jsonb_build_object('tipo',p_tipo,'accion',
      'resuelto','fecha',v_ts,'usuario',auth.uid()::text,'previous',v_prev));
  ELSE
    IF jsonb_array_length(v_audit)=0 THEN RAISE EXCEPTION 'No hay cambio que deshacer';END IF;
    v_last:=v_audit->(jsonb_array_length(v_audit)-1);
    IF v_last->>'tipo' IS DISTINCT FROM p_tipo
      OR v_last->>'accion' IS DISTINCT FROM 'resuelto'
      OR v_last->>'usuario' IS DISTINCT FROM auth.uid()::text
      OR v_last->>'fecha' IS NULL
      OR v_ts-(v_last->>'fecha')::timestamptz>interval '7 seconds'
      OR jsonb_typeof(v_last->'previous')<>'object'
    THEN RAISE EXCEPTION 'No permitido deshacer'; END IF;
    v_prev:=v_last->'previous';
    FOREACH v_field IN ARRAY v_fields LOOP
      IF v_prev ? v_field THEN
        IF v_prev->v_field IS NULL THEN v_result:=v_result-v_field;
        ELSE v_result:=jsonb_set(v_result,ARRAY[v_field],v_prev->v_field,true);END IF;
      END IF;
    END LOOP;
    v_audit:=v_audit||jsonb_build_array(jsonb_build_object('tipo',p_tipo,'accion',
      'deshecho','fecha',v_ts,'usuario',auth.uid()::text));
  END IF;
  v_result:=jsonb_set(v_result,'{auditoriaPendientes}',v_audit,true);
  UPDATE public.cardiolink_atenciones SET payload=v_result,updated_at=v_ts WHERE id=p_id;
  RETURN v_result;
END $function$;
REVOKE ALL ON FUNCTION public.cardiolink_pendiente_mutar_v1(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cardiolink_pendiente_mutar_v1(text,text,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.cardiolink_permite_atencion_v1(p_payload jsonb)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
 SELECT EXISTS (SELECT 1 FROM public.cardiolink_user_roles r
   WHERE r.user_id=auth.uid() AND r.active IS TRUE
   AND (r.base_role IN ('owner','admin','secretaria')
      OR (r.base_role='medico' AND nullif(btrim(r.professional_id),'') IS NOT NULL
          AND r.professional_id=p_payload->>'profesionalId')))
$function$;
REVOKE ALL ON FUNCTION public.cardiolink_permite_atencion_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cardiolink_permite_atencion_v1(jsonb) TO authenticated;
-- Comprobar roles y políticas preexistentes antes de ejecutar.
DROP POLICY IF EXISTS cardiolink_atenciones_select ON public.cardiolink_atenciones;
DROP POLICY IF EXISTS cardiolink_atenciones_insert ON public.cardiolink_atenciones;
DROP POLICY IF EXISTS cardiolink_atenciones_update ON public.cardiolink_atenciones;
DROP POLICY IF EXISTS cardiolink_atenciones_delete ON public.cardiolink_atenciones;
CREATE POLICY cardiolink_atenciones_select ON public.cardiolink_atenciones FOR SELECT TO authenticated USING (public.cardiolink_permite_atencion_v1(payload));
CREATE POLICY cardiolink_atenciones_insert ON public.cardiolink_atenciones FOR INSERT TO authenticated WITH CHECK (public.cardiolink_permite_atencion_v1(payload));
CREATE POLICY cardiolink_atenciones_update ON public.cardiolink_atenciones FOR UPDATE TO authenticated USING (public.cardiolink_permite_atencion_v1(payload)) WITH CHECK (public.cardiolink_permite_atencion_v1(payload));
CREATE POLICY cardiolink_atenciones_delete ON public.cardiolink_atenciones FOR DELETE TO authenticated USING (public.cardiolink_permite_atencion_v1(payload));
COMMIT;
