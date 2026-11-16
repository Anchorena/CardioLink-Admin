-- CardioLink · Pendientes de cobro V1 — pruebas del guard (SOLO STAGING, DESPUÉS de aplicar
-- pending_review_cobros_v1_guard_medico.sql). Todo ocurre dentro de una transacción que termina en ROLLBACK:
-- no deja filas ni cambios. Usa 4 atenciones SINTÉTICAS creadas acá y usuarios reales de prueba tomados de
-- cardiolink_user_roles (un médico con professional_id, una secretaría y un owner/admin). Requiere correr como postgres
-- (SQL Editor). Resultado: tabla final con PASS/FAIL por prueba. Si alguna dice FAIL, NO aplicar en Production.
BEGIN;

CREATE TEMP TABLE qa_cobros_resultados (n serial, prueba text, esperado text, obtenido text, resultado text);

-- Ejecuta p_sql como el usuario p_uid con el rol de la API ('authenticated') y devuelve '42501', 'OK n=<filas>' u otro error.
CREATE FUNCTION pg_temp.como(p_uid uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v_n int; v_r text;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    EXECUTE p_sql;
    IF p_sql ~* '^\s*select' THEN v_r := 'OK'; ELSE GET DIAGNOSTICS v_n = ROW_COUNT; v_r := 'OK n=' || v_n; END IF;
  EXCEPTION WHEN SQLSTATE '42501' THEN v_r := '42501';
            WHEN OTHERS THEN v_r := SQLSTATE || ' ' || SQLERRM;
  END;
  EXECUTE 'RESET ROLE';
  RETURN v_r;
END $f$;

DO $t$
DECLARE
  v_med uuid; v_prof text; v_sec uuid; v_adm uuid;
  v_msg text; v_n int; v_antes jsonb; v_desp jsonb; v_ok boolean;
  c_cobro constant text := 'qa_cobro_guard_cobro';
  c_hist  constant text := 'qa_cobro_guard_hist';
  c_pend  constant text := 'qa_cobro_guard_pend';
  c_reg   constant text := 'qa_cobro_guard_registrada';
  c_cfg   constant text := '__cardiolink_config_v1';
BEGIN
  SELECT user_id, professional_id INTO v_med, v_prof FROM public.cardiolink_user_roles
   WHERE base_role = 'medico' AND active IS TRUE AND nullif(btrim(professional_id), '') IS NOT NULL LIMIT 1;
  SELECT user_id INTO v_sec FROM public.cardiolink_user_roles WHERE base_role = 'secretaria' AND active IS TRUE LIMIT 1;
  SELECT user_id INTO v_adm FROM public.cardiolink_user_roles WHERE base_role IN ('owner', 'admin') AND active IS TRUE LIMIT 1;
  IF v_med IS NULL OR v_sec IS NULL OR v_adm IS NULL THEN
    RAISE EXCEPTION 'Faltan usuarios de prueba (médico con professional_id, secretaría y owner/admin activos)';
  END IF;

  -- Datos sintéticos (como postgres: no pasan por RLS ni por el guard).
  INSERT INTO public.cardiolink_atenciones (id, payload, updated_at) VALUES
   (c_cobro, jsonb_build_object('id', c_cobro, 'paciente', 'QA COBRO guard', 'profesionalId', v_prof, 'cajaPerfil', v_prof,
      'fecha', current_date::text, 'estadoTurno', 'reservado', 'tipoCobro', 'Particular', 'formaPago', 'No aplica',
      'montoConsulta', 35000, 'estadoCobro', 'pendiente', 'cobroPendienteEn', now()::text, 'bonoConsulta', true, 'bonoFirmado', false,
      'cobroAuditoria', '[]'::jsonb), now()),
   (c_hist, jsonb_build_object('id', c_hist, 'paciente', 'QA COBRO guard historica', 'profesionalId', v_prof, 'cajaPerfil', v_prof,
      'fecha', current_date::text, 'estadoTurno', 'reservado', 'tipoCobro', 'Particular', 'formaPago', 'Efectivo', 'montoConsulta', 35000), now()),
   (c_pend, jsonb_build_object('id', c_pend, 'paciente', 'QA COBRO guard pendiente', 'profesionalId', v_prof, 'cajaPerfil', v_prof,
      'fecha', current_date::text, 'estadoTurno', 'reservado', 'tipoCobro', 'Particular', 'formaPago', 'No aplica', 'montoConsulta', 35000,
      'estadoCobro', 'pendiente', 'cobroPendienteEn', now()::text), now()),
   (c_reg, jsonb_build_object('id', c_reg, 'paciente', 'QA COBRO guard cobrada al registrar', 'profesionalId', v_prof, 'cajaPerfil', v_prof,
      'fecha', current_date::text, 'estadoTurno', 'reservado', 'tipoCobro', 'Particular', 'formaPago', 'Efectivo', 'montoConsulta', 35000,
      'estadoCobro', 'cobrado', 'cobroConfirmadoEn', now()::text, 'cobroConfirmadoPor', 'QA'), now());

  -- 1. Médico: campo ajeno al cobro en una fila con cobro -> permitido
  v_msg := pg_temp.como(v_med, format($q$UPDATE public.cardiolink_atenciones SET payload = jsonb_set(payload, '{observaciones}', '"qa"') WHERE id = %L$q$, c_cobro));
  INSERT INTO qa_cobros_resultados (prueba, esperado, obtenido, resultado) VALUES ('1 médico edita observaciones (fila con cobro)', 'OK n=1', v_msg, CASE WHEN v_msg = 'OK n=1' THEN 'PASS' ELSE 'FAIL' END);
  -- 2. Médico: actualización clínica (estado del turno) -> permitido
  v_msg := pg_temp.como(v_med, format($q$UPDATE public.cardiolink_atenciones SET payload = jsonb_set(payload, '{estadoTurno}', '"atendido"') WHERE id = %L$q$, c_cobro));
  INSERT INTO qa_cobros_resultados (prueba, esperado, obtenido, resultado) VALUES ('2 médico cambia estadoTurno (clínico)', 'OK n=1', v_msg, CASE WHEN v_msg = 'OK n=1' THEN 'PASS' ELSE 'FAIL' END);
  -- 3. Médico confirma el cobro por API -> rechazado
  v_msg := pg_temp.como(v_med, format($q$UPDATE public.cardiolink_atenciones SET payload = jsonb_set(payload, '{estadoCobro}', '"cobrado"') WHERE id = %L$q$, c_cobro));
  INSERT INTO qa_cobros_resultados (prueba, esperado, obtenido, resultado) VALUES ('3 médico cambia estadoCobro', '42501', v_msg, CASE WHEN v_msg = '42501' THEN 'PASS' ELSE 'FAIL' END);
  -- 4. Médico falsifica la auditoría / quién confirmó -> rechazado
  v_msg := pg_temp.como(v_med, format($q$UPDATE public.cardiolink_atenciones SET payload = payload || '{"cobroConfirmadoPorRol":"secretaria"}'::jsonb WHERE id = %L$q$, c_cobro));
  INSERT INTO qa_cobros_resultados (prueba, esperado, obtenido, resultado) VALUES ('4 médico escribe cobroConfirmadoPorRol', '42501', v_msg, CASE WHEN v_msg = '42501' THEN 'PASS' ELSE 'FAIL' END);
  v_msg := pg_temp.como(v_med, format($q$UPDATE public.cardiolink_atenciones SET payload = jsonb_set(payload, '{cobroAuditoria}', '[{"accion":"confirmado"}]') WHERE id = %L$q$, c_cobro));
  INSERT INTO qa_cobros_resultados (prueba, esperado, obtenido, resultado) VALUES ('5 médico escribe cobroAuditoria', '42501', v_msg, CASE WHEN v_msg = '42501' THEN 'PASS' ELSE 'FAIL' END);
  -- 6. Médico agrega campos de cobro a una atención histórica -> rechazado
  v_msg := pg_temp.como(v_med, format($q$UPDATE public.cardiolink_atenciones SET payload = payload || '{"estadoCobro":"cobrado"}'::jsonb WHERE id = %L$q$, c_hist));
  INSERT INTO qa_cobros_resultados (prueba, esperado, obtenido, resultado) VALUES ('6 médico agrega estadoCobro a fila histórica', '42501', v_msg, CASE WHEN v_msg = '42501' THEN 'PASS' ELSE 'FAIL' END);
  -- 6b. Médico agrega UN solo campo de cobro (distinto de estadoCobro) a una fila histórica -> rechazado (el WHEN cubre los 10 campos)
  v_msg := pg_temp.como(v_med, format($q$UPDATE public.cardiolink_atenciones SET payload = payload || '{"cobroConfirmadoPorRol":"secretaria"}'::jsonb WHERE id = %L$q$, c_hist));
  INSERT INTO qa_cobros_resultados (prueba, esperado, obtenido, resultado) VALUES ('6b médico agrega sólo cobroConfirmadoPorRol a fila histórica', '42501', v_msg, CASE WHEN v_msg = '42501' THEN 'PASS' ELSE 'FAIL' END);
  v_msg := pg_temp.como(v_med, format($q$UPDATE public.cardiolink_atenciones SET payload = payload || '{"cobroMedioPago":"Efectivo"}'::jsonb WHERE id = %L$q$, c_hist));
  INSERT INTO qa_cobros_resultados (prueba, esperado, obtenido, resultado) VALUES ('6c médico agrega sólo cobroMedioPago a fila histórica', '42501', v_msg, CASE WHEN v_msg = '42501' THEN 'PASS' ELSE 'FAIL' END);
  -- 7. Médico edita una atención histórica (sin campos de cobro) -> permitido; el guard ni se ejecuta
  v_msg := pg_temp.como(v_med, format($q$UPDATE public.cardiolink_atenciones SET payload = jsonb_set(payload, '{montoConsulta}', '40000') WHERE id = %L$q$, c_hist));
  INSERT INTO qa_cobros_resultados (prueba, esperado, obtenido, resultado) VALUES ('7 médico edita fila histórica (compatibilidad)', 'OK n=1', v_msg, CASE WHEN v_msg = 'OK n=1' THEN 'PASS' ELSE 'FAIL' END);
  -- 8. Informativo: el médico SÍ puede editar montos de una fila con cobro (campos económicos de base NO cubiertos)
  v_msg := pg_temp.como(v_med, format($q$UPDATE public.cardiolink_atenciones SET payload = jsonb_set(payload, '{montoConsulta}', '1') WHERE id = %L$q$, c_cobro));
  INSERT INTO qa_cobros_resultados (prueba, esperado, obtenido, resultado) VALUES ('8 médico edita montoConsulta de un cobro PENDIENTE (permitido por diseño)', 'OK n=1', v_msg, CASE WHEN v_msg = 'OK n=1' THEN 'PASS' ELSE 'FAIL' END);
  -- 9. RPC SECURITY DEFINER de pendientes médicos (resolver firma) como médico: debe EJECUTARSE bien (resultado 'OK', no 42501 ni
  --    ningún otro error), marcar la firma y conservar TODO lo demás de la fila (campos económicos y de estado de cobro incluidos).
  IF to_regprocedure('public.cardiolink_pendiente_mutar_v1(text,text,text)') IS NULL THEN
    INSERT INTO qa_cobros_resultados (prueba, esperado, obtenido, resultado) VALUES ('9 RPC cardiolink_pendiente_mutar_v1 como médico', 'OK', 'RPC inexistente', 'SKIP');
  ELSE
    SELECT payload INTO v_antes FROM public.cardiolink_atenciones WHERE id = c_cobro;
    v_msg := pg_temp.como(v_med, format($q$SELECT public.cardiolink_pendiente_mutar_v1(%L, 'firma', 'resolver')$q$, c_cobro));
    SELECT payload INTO v_desp FROM public.cardiolink_atenciones WHERE id = c_cobro;
    v_ok := v_msg = 'OK'
            AND coalesce(v_desp ->> 'bonoFirmado', '') = 'true'
            AND (v_antes - 'bonoFirmado' - 'auditoriaPendientes') = (v_desp - 'bonoFirmado' - 'auditoriaPendientes');
    INSERT INTO qa_cobros_resultados (prueba, esperado, obtenido, resultado) VALUES
      ('9 RPC cardiolink_pendiente_mutar_v1 como médico: ejecuta, marca firma y conserva económicos/cobro',
       'OK + bonoFirmado=true + resto idéntico',
       v_msg || ' / bonoFirmado=' || coalesce(v_desp ->> 'bonoFirmado', 'null')
         || ' / resto idéntico=' || ((v_antes - 'bonoFirmado' - 'auditoriaPendientes') = (v_desp - 'bonoFirmado' - 'auditoriaPendientes'))::text,
       CASE WHEN v_ok THEN 'PASS' ELSE 'FAIL' END);
  END IF;
  -- 10. Secretaría confirma -> permitido
  v_msg := pg_temp.como(v_sec, format($q$UPDATE public.cardiolink_atenciones SET payload = payload || jsonb_build_object('estadoCobro','cobrado','cobroConfirmadoEn',now()::text,'cobroConfirmadoPorRol','secretaria','cobroMedioPago','Efectivo') WHERE id = %L$q$, c_cobro));
  INSERT INTO qa_cobros_resultados (prueba, esperado, obtenido, resultado) VALUES ('10 secretaría confirma el cobro', 'OK n=1', v_msg, CASE WHEN v_msg = 'OK n=1' THEN 'PASS' ELSE 'FAIL' END);
  -- 10b. Cobro YA CONFIRMADO por el flujo: el médico no puede tocar datos económicos
  -- (el valor 77777 difiere del que dejó la prueba 8, que fue 1: un UPDATE sin cambio real no tiene nada que rechazar)
  v_msg := pg_temp.como(v_med, format($q$UPDATE public.cardiolink_atenciones SET payload = jsonb_set(payload, '{montoConsulta}', '77777') WHERE id = %L$q$, c_cobro));
  INSERT INTO qa_cobros_resultados (prueba, esperado, obtenido, resultado) VALUES ('10b médico edita montoConsulta de cobro confirmado', '42501', v_msg, CASE WHEN v_msg = '42501' THEN 'PASS' ELSE 'FAIL' END);
  v_msg := pg_temp.como(v_med, format($q$UPDATE public.cardiolink_atenciones SET payload = jsonb_set(payload, '{tipoCobro}', '"Sin cobro en caja"') WHERE id = %L$q$, c_cobro));
  INSERT INTO qa_cobros_resultados (prueba, esperado, obtenido, resultado) VALUES ('10c médico cambia tipoCobro de cobro confirmado', '42501', v_msg, CASE WHEN v_msg = '42501' THEN 'PASS' ELSE 'FAIL' END);
  v_msg := pg_temp.como(v_med, format($q$UPDATE public.cardiolink_atenciones SET payload = jsonb_set(payload, '{formaPago}', '"Mixto"') WHERE id = %L$q$, c_cobro));
  INSERT INTO qa_cobros_resultados (prueba, esperado, obtenido, resultado) VALUES ('10d médico cambia formaPago de cobro confirmado', '42501', v_msg, CASE WHEN v_msg = '42501' THEN 'PASS' ELSE 'FAIL' END);
  v_msg := pg_temp.como(v_med, format($q$UPDATE public.cardiolink_atenciones SET payload = jsonb_set(payload, '{noCobrar}', 'true') WHERE id = %L$q$, c_cobro));
  INSERT INTO qa_cobros_resultados (prueba, esperado, obtenido, resultado) VALUES ('10e médico pone noCobrar en cobro confirmado', '42501', v_msg, CASE WHEN v_msg = '42501' THEN 'PASS' ELSE 'FAIL' END);
  v_msg := pg_temp.como(v_med, format($q$UPDATE public.cardiolink_atenciones SET payload = jsonb_set(payload, '{cajaPerfil}', '"otro_profesional"') WHERE id = %L$q$, c_cobro));
  INSERT INTO qa_cobros_resultados (prueba, esperado, obtenido, resultado) VALUES ('10f médico mueve cajaPerfil de cobro confirmado', '42501', v_msg, CASE WHEN v_msg = '42501' THEN 'PASS' ELSE 'FAIL' END);
  v_msg := pg_temp.como(v_med, format($q$UPDATE public.cardiolink_atenciones SET payload = jsonb_set(payload, '{estadoTurno}', '"cancelado"') WHERE id = %L$q$, c_cobro));
  INSERT INTO qa_cobros_resultados (prueba, esperado, obtenido, resultado) VALUES ('10g médico cancela turno con cobro confirmado', '42501', v_msg, CASE WHEN v_msg = '42501' THEN 'PASS' ELSE 'FAIL' END);
  v_msg := pg_temp.como(v_med, format($q$UPDATE public.cardiolink_atenciones SET payload = jsonb_set(jsonb_set(payload, '{estadoTurno}', '"en consulta"'), '{fecha}', '"2099-01-01"') WHERE id = %L$q$, c_cobro));
  INSERT INTO qa_cobros_resultados (prueba, esperado, obtenido, resultado) VALUES ('10h médico cambia estado clínico y fecha (reprogramar) en cobro confirmado', 'OK n=1', v_msg, CASE WHEN v_msg = 'OK n=1' THEN 'PASS' ELSE 'FAIL' END);
  -- 10i. Fila cobrada AL REGISTRAR (sin confirmación del flujo): el médico que la creó la sigue editando
  v_msg := pg_temp.como(v_med, format($q$UPDATE public.cardiolink_atenciones SET payload = jsonb_set(payload, '{montoConsulta}', '40000') WHERE id = %L$q$, c_reg));
  INSERT INTO qa_cobros_resultados (prueba, esperado, obtenido, resultado) VALUES ('10i médico edita montos de fila cobrada al registrar (no congelada)', 'OK n=1', v_msg, CASE WHEN v_msg = 'OK n=1' THEN 'PASS' ELSE 'FAIL' END);
  -- 10j. DELETE
  v_msg := pg_temp.como(v_med, format($q$DELETE FROM public.cardiolink_atenciones WHERE id = %L$q$, c_pend));
  INSERT INTO qa_cobros_resultados (prueba, esperado, obtenido, resultado) VALUES ('10j médico borra atención con cobro pendiente', '42501', v_msg, CASE WHEN v_msg = '42501' THEN 'PASS' ELSE 'FAIL' END);
  v_msg := pg_temp.como(v_med, format($q$DELETE FROM public.cardiolink_atenciones WHERE id = %L$q$, c_cobro));
  INSERT INTO qa_cobros_resultados (prueba, esperado, obtenido, resultado) VALUES ('10k médico borra atención con cobro confirmado', '42501', v_msg, CASE WHEN v_msg = '42501' THEN 'PASS' ELSE 'FAIL' END);
  v_msg := pg_temp.como(v_med, format($q$DELETE FROM public.cardiolink_atenciones WHERE id = %L$q$, c_hist));
  INSERT INTO qa_cobros_resultados (prueba, esperado, obtenido, resultado) VALUES ('10l médico borra atención histórica (compatibilidad)', 'OK n=1', v_msg, CASE WHEN v_msg = 'OK n=1' THEN 'PASS' ELSE 'FAIL' END);
  v_msg := pg_temp.como(v_sec, format($q$DELETE FROM public.cardiolink_atenciones WHERE id = %L$q$, c_pend));
  INSERT INTO qa_cobros_resultados (prueba, esperado, obtenido, resultado) VALUES ('10m secretaría borra atención con cobro pendiente', 'OK n=1', v_msg, CASE WHEN v_msg = 'OK n=1' THEN 'PASS' ELSE 'FAIL' END);
  -- 10n. Secretaría corrige un dato económico de un cobro confirmado (permitido por diseño)
  v_msg := pg_temp.como(v_sec, format($q$UPDATE public.cardiolink_atenciones SET payload = jsonb_set(payload, '{montoConsulta}', '36000') WHERE id = %L$q$, c_cobro));
  INSERT INTO qa_cobros_resultados (prueba, esperado, obtenido, resultado) VALUES ('10n secretaría corrige monto de cobro confirmado', 'OK n=1', v_msg, CASE WHEN v_msg = 'OK n=1' THEN 'PASS' ELSE 'FAIL' END);
  -- 11. Owner/admin modifica campos de cobro -> permitido
  v_msg := pg_temp.como(v_adm, format($q$UPDATE public.cardiolink_atenciones SET payload = jsonb_set(payload, '{cobroMedioPago}', '"Transferencia"') WHERE id = %L$q$, c_cobro));
  INSERT INTO qa_cobros_resultados (prueba, esperado, obtenido, resultado) VALUES ('11 owner/admin modifica cobro', 'OK n=1', v_msg, CASE WHEN v_msg = 'OK n=1' THEN 'PASS' ELSE 'FAIL' END);
  -- 12. Sin rol de la API (postgres / service_role / SQL Editor) -> no interceptado
  UPDATE public.cardiolink_atenciones SET payload = jsonb_set(payload, '{estadoCobro}', '"pendiente"') WHERE id = c_cobro;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  INSERT INTO qa_cobros_resultados (prueba, esperado, obtenido, resultado) VALUES ('12 postgres/service_role no interceptado', 'n=1', 'n=' || v_n, CASE WHEN v_n = 1 THEN 'PASS' ELSE 'FAIL' END);
  -- 13. Coexistencia con el trigger de identidad: owner/admin actualiza un campo ajeno a la identidad de la config
  IF EXISTS (SELECT 1 FROM public.cardiolink_atenciones WHERE id = c_cfg) THEN
    v_msg := pg_temp.como(v_adm, format($q$UPDATE public.cardiolink_atenciones SET payload = jsonb_set(payload, '{qa_guard_cobros}', 'true') WHERE id = %L$q$, c_cfg));
    INSERT INTO qa_cobros_resultados (prueba, esperado, obtenido, resultado) VALUES ('13 fila de config (trigger de identidad) como admin', 'OK n=1', v_msg, CASE WHEN v_msg = 'OK n=1' THEN 'PASS' ELSE 'FAIL' END);
  ELSE
    INSERT INTO qa_cobros_resultados (prueba, esperado, obtenido, resultado) VALUES ('13 fila de config (trigger de identidad) como admin', 'OK n=1', 'sin fila de config', 'SKIP');
  END IF;
END
$t$;

SELECT n, prueba, esperado, obtenido, resultado FROM qa_cobros_resultados ORDER BY n;
ROLLBACK;
