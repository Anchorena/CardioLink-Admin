-- CardioLink Permisos V1 — borrador para STAGING. NO aplicado en Production.
-- Objetivo: escritura atómica de un único pendiente por RPC autorizada.
-- IMPORTANTE: antes de activarlo, restringir RLS directo de cardiolink_atenciones
-- y convertir las demás escrituras de médicos a flujos por registro.
-- Esta función por sí sola NO elimina el acceso demasiado amplio de las policies actuales.
CREATE OR REPLACE FUNCTION public.cardiolink_resolver_pendiente_v1(
  p_atencion_id text, p_tipo text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor public.cardiolink_user_roles%ROWTYPE;
  v_payload jsonb;
  v_clave text;
  v_actualizado jsonb;
  v_auditoria jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Acceso no autorizado'; END IF;
  SELECT * INTO v_actor
    FROM public.cardiolink_user_roles
   WHERE user_id = auth.uid() AND active IS TRUE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Perfil no autorizado'; END IF;
  IF p_atencion_id IS NULL OR btrim(p_atencion_id) = '' THEN
    RAISE EXCEPTION 'Atención inválida';
  END IF;
  IF p_tipo NOT IN ('firma','copia','informe','entrega','retiro','autorizacion') THEN
    RAISE EXCEPTION 'Tipo de pendiente no permitido';
  END IF;
  SELECT payload INTO v_payload
    FROM public.cardiolink_atenciones
   WHERE id = p_atencion_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Atención no encontrada'; END IF;
  IF v_actor.base_role = 'medico' AND
     (v_actor.professional_id IS NULL OR
      v_actor.professional_id IS DISTINCT FROM v_payload->>'profesionalId') THEN
    RAISE EXCEPTION 'Pendiente fuera del profesional autorizado';
  END IF;
  IF v_actor.base_role NOT IN ('owner','admin','secretaria','medico') THEN
    RAISE EXCEPTION 'Rol no autorizado';
  END IF;
  -- Replica únicamente la mutación existente de cada acción.
  v_clave := CASE p_tipo
    WHEN 'firma' THEN 'bonoFirmado'
    WHEN 'copia' THEN 'copiaImpresa'
    WHEN 'informe' THEN 'estudioInformado'
    WHEN 'entrega' THEN 'estudioImpreso'
    WHEN 'retiro' THEN 'retiradoFisico'
    WHEN 'autorizacion' THEN 'autorizacionCompleta'
  END;
  IF v_payload->>v_clave = 'true' THEN
    RAISE EXCEPTION 'Este pendiente ya figura resuelto';
  END IF;
  v_actualizado := jsonb_set(v_payload, ARRAY[v_clave], 'true'::jsonb, true);
  IF p_tipo = 'entrega' THEN
    v_actualizado := jsonb_set(v_actualizado, '{disponibleRetiro}', 'true'::jsonb, true);
  ELSIF p_tipo = 'retiro' THEN
    v_actualizado := jsonb_set(v_actualizado, '{fechaRetiroFisico}', to_jsonb(clock_timestamp()::text), true);
  END IF;
  v_auditoria := CASE WHEN jsonb_typeof(v_payload->'auditoriaPendientes')='array'
    THEN v_payload->'auditoriaPendientes' ELSE '[]'::jsonb END;
  v_auditoria := v_auditoria || jsonb_build_array(
    jsonb_build_object('tipo', p_tipo, 'accion', 'resuelto', 'fecha', clock_timestamp(),
      'usuarioId', auth.uid()::text));
  v_actualizado := jsonb_set(v_actualizado, '{auditoriaPendientes}', v_auditoria, true);
  UPDATE public.cardiolink_atenciones
     SET payload = v_actualizado, updated_at = clock_timestamp()
   WHERE id = p_atencion_id;
  RETURN v_actualizado;
END
$$;
REVOKE ALL ON FUNCTION public.cardiolink_resolver_pendiente_v1(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cardiolink_resolver_pendiente_v1(text,text) TO authenticated;
