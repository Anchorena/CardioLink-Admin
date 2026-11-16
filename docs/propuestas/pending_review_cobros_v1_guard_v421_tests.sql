-- CardioLink · Pendientes de cobro V1 — pruebas del guard v4.2.1 (SOLO STAGING, DESPUÉS de aplicar pending_review_cobros_v1_guard_v421.sql).
-- Todo ocurre dentro de una transacción que termina en ROLLBACK: no deja filas, asociaciones ni cambios. Usa atenciones SINTÉTICAS creadas acá y
-- usuarios reales de prueba tomados de cardiolink_user_roles (un médico con professional_id, una secretaría y un owner/admin). La secretaría de
-- prueba se asocia/desasocia al médico con la RPC real de asociaciones (como owner/admin) y se revierte con el ROLLBACK. Requiere correr como
-- postgres (SQL Editor). Contiene las 28 comprobaciones originales de v4.1.1 (numeradas 1 a 13; la 10 ahora usa la confirmación VERIFICADA de
-- v4.2.1) y los casos nuevos 14 a 66 y A1 a A22 (integridad de auditoría, v4.2.1) (asociaciones, destinatario económico, INSERT, upsert, resurrección, versión).
-- Resultado: tabla final con PASS/FAIL/SKIP por prueba + resumen. Si alguna dice FAIL, NO aplicar en Production.
-- Un 42501 cuenta como "guard" sólo si el mensaje empieza con "Rol no autorizado"; un 42501 de la RLS se informa como '42501-RLS'.
BEGIN;

CREATE TEMP TABLE qa_cobros_resultados (n serial, prueba text, esperado text, obtenido text, resultado text);

-- Ejecuta p_sql como el usuario p_uid con el rol de la API ('authenticated') y devuelve '42501', 'OK n=<filas>' u otro error.
CREATE FUNCTION pg_temp.como(p_uid uuid, p_sql text, p_con_email boolean DEFAULT true) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v_n int; v_r text;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated', 'email', CASE WHEN p_con_email THEN (SELECT email FROM auth.users WHERE id = p_uid) END)::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    EXECUTE p_sql;
    IF p_sql ~* '^\s*select' THEN v_r := 'OK'; ELSE GET DIAGNOSTICS v_n = ROW_COUNT; v_r := 'OK n=' || v_n; END IF;
  EXCEPTION WHEN SQLSTATE '42501' THEN v_r := CASE WHEN SQLERRM LIKE 'Rol no autorizado%' THEN '42501' ELSE '42501-RLS' END;
            WHEN OTHERS THEN v_r := SQLSTATE || ' ' || SQLERRM;
  END;
  EXECUTE 'RESET ROLE';
  RETURN v_r;
END $f$;

-- SQL de una confirmación pendiente -> cobrado con la forma que envía el módulo (identidad = usuario autenticado). p_extra se aplica al final para
-- fabricar variantes inválidas (p. ej. otro email, otro rol, otra auditoría). p_rol: 'secretaria' | 'owner' | 'admin'.
CREATE FUNCTION pg_temp.sql_confirmar(p_id text, p_uid uuid, p_rol text, p_extra jsonb DEFAULT '{}'::jsonb) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v_mail text;
BEGIN
  SELECT lower(email) INTO v_mail FROM auth.users WHERE id = p_uid;
  RETURN format($q$UPDATE public.cardiolink_atenciones SET payload = payload || jsonb_build_object(
      'estadoCobro','cobrado','formaPago','Efectivo','cobroMedioPago','Efectivo','cobroConfirmadoEn',now()::text,'cobroConfirmadoPor',%L,
      'cobroConfirmadoPorId',%L,'cobroConfirmadoPorRol',%L,'cobroConfirmadoPorEmail',%L,
      'cobroAuditoria', coalesce(payload->'cobroAuditoria','[]'::jsonb) || jsonb_build_array(jsonb_build_object('accion','confirmado','fecha',now()::text,'usuario',%L,'medio','Efectivo','email',%L)))
      || %L::jsonb WHERE id = %L$q$, v_mail, p_uid::text, p_rol, v_mail, v_mail, v_mail, p_extra::text, p_id);
END $f$;

-- Asocia/desasocia (activo true/false) a la secretaría con el médico usando la RPC real, como owner/admin. Devuelve 'OK' u otro resultado.
CREATE FUNCTION pg_temp.asociar(p_adm uuid, p_sec uuid, p_med uuid, p_activo boolean) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  RETURN pg_temp.como(p_adm, format('SELECT public.cardiolink_asociar_secretaria_medico_v1(%L::uuid, %L::uuid, %L::boolean)', p_sec, p_med, p_activo::text));
END $f$;

-- Registra un resultado (PASS si lo obtenido es exactamente lo esperado).
CREATE FUNCTION pg_temp.r(p_prueba text, p_esperado text, p_obtenido text) RETURNS void LANGUAGE sql AS $f$
  INSERT INTO qa_cobros_resultados (prueba, esperado, obtenido, resultado)
  VALUES (p_prueba, p_esperado, p_obtenido, CASE WHEN p_obtenido = p_esperado THEN 'PASS' ELSE 'FAIL' END)
$f$;

DO $t$
DECLARE
  v_med uuid; v_prof text; v_sec uuid; v_adm uuid;
  v_msg text; v_n int; v_antes jsonb; v_desp jsonb; v_ok boolean;
  c_cobro constant text := 'qa_cobro_guard_cobro';
  c_hist  constant text := 'qa_cobro_guard_hist';
  c_pend  constant text := 'qa_cobro_guard_pend';
  c_reg   constant text := 'qa_cobro_guard_registrada';
  c_cfg   constant text := '__cardiolink_config_v1';
  c_n     constant text := 'qa_cobro_v421_';
  v_otro  constant text := 'qa_cobro_prof_ajeno';
  v_base  jsonb;
  v_conf  jsonb;
  v_cmt   text;
BEGIN
  SELECT user_id, professional_id INTO v_med, v_prof FROM public.cardiolink_user_roles
   WHERE base_role = 'medico' AND active IS TRUE AND nullif(btrim(professional_id), '') IS NOT NULL LIMIT 1;
  SELECT user_id INTO v_sec FROM public.cardiolink_user_roles WHERE base_role = 'secretaria' AND active IS TRUE LIMIT 1;
  SELECT user_id INTO v_adm FROM public.cardiolink_user_roles WHERE base_role IN ('owner', 'admin') AND active IS TRUE LIMIT 1;
  IF v_med IS NULL OR v_sec IS NULL OR v_adm IS NULL THEN
    RAISE EXCEPTION 'Faltan usuarios de prueba (médico con professional_id, secretaría y owner/admin activos)';
  END IF;

  -- v4.2.1: la secretaría de prueba queda ASOCIADA al médico de prueba (se revierte con el ROLLBACK final).
  v_msg := pg_temp.asociar(v_adm, v_sec, v_med, true);
  IF v_msg <> 'OK' THEN RAISE EXCEPTION 'No se pudo asociar la secretaría de prueba al médico de prueba (%). Revisar cardiolink_asociar_secretaria_medico_v1.', v_msg; END IF;

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
  v_msg := pg_temp.como(v_sec, pg_temp.sql_confirmar(c_cobro, v_sec, 'secretaria'));
  INSERT INTO qa_cobros_resultados (prueba, esperado, obtenido, resultado) VALUES ('10 secretaría ASOCIADA confirma el cobro (identidad y fecha verificadas)', 'OK n=1', v_msg, CASE WHEN v_msg = 'OK n=1' THEN 'PASS' ELSE 'FAIL' END);
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
  INSERT INTO qa_cobros_resultados (prueba, esperado, obtenido, resultado) VALUES ('10m secretaría asociada borra atención con cobro pendiente', 'OK n=1', v_msg, CASE WHEN v_msg = 'OK n=1' THEN 'PASS' ELSE 'FAIL' END);
  -- 10n. Secretaría corrige un dato económico de un cobro confirmado (permitido por diseño)
  v_msg := pg_temp.como(v_sec, format($q$UPDATE public.cardiolink_atenciones SET payload = jsonb_set(payload, '{montoConsulta}', '36000') WHERE id = %L$q$, c_cobro));
  INSERT INTO qa_cobros_resultados (prueba, esperado, obtenido, resultado) VALUES ('10n secretaría asociada corrige monto de cobro confirmado', 'OK n=1', v_msg, CASE WHEN v_msg = 'OK n=1' THEN 'PASS' ELSE 'FAIL' END);
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

  -- ================= v4.2.1: casos nuevos (fixtures propios, creados como postgres) =================
  v_base := jsonb_build_object('paciente', 'QA COBRO v42', 'profesionalId', v_prof, 'cajaPerfil', v_prof, 'fecha', current_date::text,
                               'estadoTurno', 'reservado', 'tipoCobro', 'Particular', 'formaPago', 'No aplica', 'montoConsulta', 35000);
  v_conf := jsonb_build_object('estadoCobro', 'cobrado', 'formaPago', 'Efectivo', 'cobroMedioPago', 'Efectivo', 'cobroPendienteEn', now()::text,
                               'cobroConfirmadoEn', now()::text, 'cobroConfirmadoPor', 'QA', 'cobroConfirmadoPorId', v_sec::text,
                               'cobroConfirmadoPorRol', 'secretaria', 'cobroAuditoria', '[{"accion":"pendiente"},{"accion":"confirmado"}]'::jsonb);
  INSERT INTO public.cardiolink_atenciones (id, payload, updated_at) VALUES
   (c_n || 'pend1',     v_base || jsonb_build_object('id', c_n || 'pend1', 'estadoCobro', 'pendiente', 'cobroPendienteEn', now()::text, 'cobroAuditoria', '[{"accion":"pendiente"}]'::jsonb), now()),
   (c_n || 'pend2',     v_base || jsonb_build_object('id', c_n || 'pend2', 'estadoCobro', 'pendiente', 'cobroPendienteEn', now()::text, 'cobroAuditoria', '[{"accion":"pendiente"}]'::jsonb), now()),
   (c_n || 'pend3',     v_base || jsonb_build_object('id', c_n || 'pend3', 'estadoCobro', 'pendiente', 'cobroPendienteEn', now()::text, 'cobroAuditoria', '[{"accion":"pendiente"}]'::jsonb), now()),
   (c_n || 'pend_caja', v_base || jsonb_build_object('id', c_n || 'pend_caja', 'cajaPerfil', v_otro, 'estadoCobro', 'pendiente', 'cobroPendienteEn', now()::text, 'cobroAuditoria', '[{"accion":"pendiente"}]'::jsonb), now()),
   (c_n || 'pend_dest', v_base || jsonb_build_object('id', c_n || 'pend_dest', 'estadoCobro', 'pendiente', 'cobroPendienteEn', now()::text, 'cobroAuditoria', '[{"accion":"pendiente"}]'::jsonb), now()),
   (c_n || 'pend_sola', v_base - 'cajaPerfil' || jsonb_build_object('id', c_n || 'pend_sola', 'estadoCobro', 'pendiente', 'cobroPendienteEn', now()::text, 'cobroAuditoria', '[{"accion":"pendiente"}]'::jsonb), now()),
   (c_n || 'conf1',     v_base || v_conf || jsonb_build_object('id', c_n || 'conf1'), now()),
   (c_n || 'conf2',     v_base || v_conf || jsonb_build_object('id', c_n || 'conf2'), now()),
   (c_n || 'conf3',     v_base || v_conf || jsonb_build_object('id', c_n || 'conf3'), now());

  -- --- Secretaría ASOCIADA: confirmación verificada y destinatario económico ---
  v_msg := pg_temp.como(v_sec, pg_temp.sql_confirmar(c_n || 'pend1', v_sec, 'secretaria'));
  PERFORM pg_temp.r('14 asociada confirma un pendiente con identidad, email, fecha y auditoría verificados', 'OK n=1', v_msg);
  v_msg := pg_temp.como(v_sec, format($q$UPDATE public.cardiolink_atenciones SET payload = payload || '{"cobroMedioPago":"Transferencia","formaPago":"Transferencia"}'::jsonb WHERE id = %L$q$, c_n || 'pend1'));
  PERFORM pg_temp.r('15 asociada NO puede reconfirmar/reescribir un cobro ya confirmado (doble confirmación por API)', '42501', v_msg);
  v_msg := pg_temp.como(v_adm, format($q$UPDATE public.cardiolink_atenciones SET payload = payload || '{"cobroMedioPago":"Transferencia"}'::jsonb WHERE id = %L$q$, c_n || 'pend1'));
  PERFORM pg_temp.r('16 owner/admin sí puede corregir el medio de pago de un cobro confirmado (no es identidad)', 'OK n=1', v_msg);
  v_msg := pg_temp.como(v_sec, pg_temp.sql_confirmar(c_n || 'pend2', v_sec, 'secretaria', jsonb_build_object('cobroConfirmadoPorId', v_med::text)));
  PERFORM pg_temp.r('17 asociada confirma atribuyéndola a OTRO usuario (cobroConfirmadoPorId ajeno)', '42501', v_msg);
  v_msg := pg_temp.como(v_sec, pg_temp.sql_confirmar(c_n || 'pend2', v_sec, 'owner'));
  PERFORM pg_temp.r('18 asociada confirma con cobroConfirmadoPorRol falso (owner)', '42501', v_msg);
  v_msg := pg_temp.como(v_sec, pg_temp.sql_confirmar(c_n || 'pend2', v_sec, 'secretaria', jsonb_build_object('cobroConfirmadoEn', (now() + interval '3 days')::text)));
  PERFORM pg_temp.r('19a asociada confirma con fecha efectiva forjada a futuro (+3 días)', '42501', v_msg);
  v_msg := pg_temp.como(v_sec, pg_temp.sql_confirmar(c_n || 'pend2', v_sec, 'secretaria', jsonb_build_object('cobroConfirmadoEn', (now() - interval '3 days')::text)));
  PERFORM pg_temp.r('19b asociada confirma con fecha efectiva forjada a pasado (-3 días)', '42501', v_msg);
  v_msg := pg_temp.como(v_sec, pg_temp.sql_confirmar(c_n || 'pend2', v_sec, 'secretaria', '{"cobroConfirmadoEn":"no-es-fecha"}'::jsonb));
  PERFORM pg_temp.r('19c asociada confirma con fecha inválida', '42501', v_msg);
  v_msg := pg_temp.como(v_sec, pg_temp.sql_confirmar(c_n || 'pend2', v_sec, 'secretaria', '{"cobroConfirmadoPorId":null}'::jsonb));
  PERFORM pg_temp.r('20 asociada confirma sin cobroConfirmadoPorId', '42501', v_msg);
  v_msg := pg_temp.como(v_sec, pg_temp.sql_confirmar(c_n || 'pend_caja', v_sec, 'secretaria'));
  PERFORM pg_temp.r('21 asociada al profesional que ATIENDE pero NO al destinatario económico (cajaPerfil ajeno): no confirma', '42501', v_msg);
  v_msg := pg_temp.como(v_sec, pg_temp.sql_confirmar(c_n || 'pend_dest', v_sec, 'secretaria', jsonb_build_object('cajaPerfil', v_otro)));
  PERFORM pg_temp.r('22 asociada confirma redirigiendo el dinero a una caja ajena (cajaPerfil nuevo no autorizado)', '42501', v_msg);
  v_msg := pg_temp.como(v_sec, pg_temp.sql_confirmar(c_n || 'pend_sola', v_sec, 'secretaria'));
  PERFORM pg_temp.r('23 destinatario = profesionalId cuando falta cajaPerfil: la asociada confirma', 'OK n=1', v_msg);
  v_msg := pg_temp.como(v_adm, pg_temp.sql_confirmar(c_n || 'pend_caja', v_adm, (SELECT base_role FROM public.cardiolink_user_roles WHERE user_id = v_adm)));
  PERFORM pg_temp.r('24 owner/admin confirma el cobro de cualquier destinatario económico con su identidad verificada', 'OK n=1', v_msg);

  -- --- A (v4.2.1): INTEGRIDAD DE AUDITORÍA. La identidad sale del JWT; nada de lo que aporta el cliente puede atribuir la confirmación a otro ---
  INSERT INTO public.cardiolink_atenciones (id, payload, updated_at) VALUES
   (c_n || 'aud1', v_base || jsonb_build_object('id', c_n || 'aud1', 'estadoCobro', 'pendiente', 'cobroPendienteEn', now()::text, 'cobroPendientePor', 'qa', 'cobroAuditoria', '[{"accion":"pendiente","usuario":"qa"}]'::jsonb), now()),
   (c_n || 'aud2', v_base || jsonb_build_object('id', c_n || 'aud2', 'estadoCobro', 'pendiente', 'cobroPendienteEn', now()::text, 'cobroPendientePor', 'qa', 'cobroAuditoria', '[{"accion":"pendiente","usuario":"qa"}]'::jsonb), now());
  v_msg := pg_temp.como(v_sec, pg_temp.sql_confirmar(c_n || 'aud1', v_sec, 'secretaria', '{"cobroConfirmadoPorEmail":"otra.persona@falso.test"}'::jsonb));
  PERFORM pg_temp.r('A1 asociada confirma con el EMAIL de otra persona', '42501', v_msg);
  v_msg := pg_temp.como(v_sec, pg_temp.sql_confirmar(c_n || 'aud1', v_sec, 'secretaria', '{"cobroConfirmadoPor":"Dra. Persona Falsa"}'::jsonb));
  PERFORM pg_temp.r('A2 asociada confirma con el NOMBRE visible de otra persona (cobroConfirmadoPor)', '42501', v_msg);
  v_msg := pg_temp.como(v_sec, pg_temp.sql_confirmar(c_n || 'aud1', v_sec, 'secretaria', '{"cobroAuditoria":[{"accion":"pendiente","usuario":"qa"},{"accion":"confirmado","usuario":"Dra. Persona Falsa","email":"otra.persona@falso.test"}]}'::jsonb));
  PERFORM pg_temp.r('A3 asociada agrega un evento de auditoría atribuido a otra persona', '42501', v_msg);
  v_msg := pg_temp.como(v_sec, pg_temp.sql_confirmar(c_n || 'aud1', v_sec, 'secretaria', '{"cobroAuditoria":[{"accion":"confirmado","usuario":"x"}]}'::jsonb));
  PERFORM pg_temp.r('A4 asociada REEMPLAZA la auditoría previa del pendiente', '42501', v_msg);
  v_msg := pg_temp.como(v_sec, pg_temp.sql_confirmar(c_n || 'aud1', v_sec, 'secretaria', jsonb_build_object('cobroAuditoria', jsonb_build_array(jsonb_build_object('accion','pendiente','usuario','qa'), jsonb_build_object('accion','confirmado','usuario',(SELECT lower(email) FROM auth.users WHERE id = v_sec),'email',(SELECT lower(email) FROM auth.users WHERE id = v_sec)), jsonb_build_object('accion','confirmado','usuario',(SELECT lower(email) FROM auth.users WHERE id = v_sec),'email',(SELECT lower(email) FROM auth.users WHERE id = v_sec))))));
  PERFORM pg_temp.r('A5 asociada agrega DOS eventos de confirmación', '42501', v_msg);
  v_msg := pg_temp.como(v_sec, pg_temp.sql_confirmar(c_n || 'aud1', v_sec, 'secretaria', '{"cobroPendientePor":"otra persona"}'::jsonb));
  PERFORM pg_temp.r('A6 asociada reescribe cobroPendientePor (registro del pendiente original) al confirmar', '42501', v_msg);
  v_msg := pg_temp.como(v_sec, pg_temp.sql_confirmar(c_n || 'aud1', v_sec, 'secretaria', '{"cobroPendienteEn":"2000-01-01T00:00:00Z"}'::jsonb));
  PERFORM pg_temp.r('A7 asociada reescribe cobroPendienteEn al confirmar', '42501', v_msg);
  v_msg := pg_temp.como(v_sec, pg_temp.sql_confirmar(c_n || 'aud1', v_sec, 'secretaria', '{"cobroConfirmadoPorEmail":"x@y"}'::jsonb), false);
  PERFORM pg_temp.r('A8 confirmación con un token SIN claim de email (no hay fuente autenticada del email)', '42501', v_msg);
  v_msg := pg_temp.como(v_sec, pg_temp.sql_confirmar(c_n || 'aud1', v_sec, 'admin'));
  PERFORM pg_temp.r('A9 Secretaría confirma declarando rol admin', '42501', v_msg);
  v_msg := pg_temp.como(v_adm, pg_temp.sql_confirmar(c_n || 'aud1', v_adm, 'secretaria'));
  PERFORM pg_temp.r('A10 owner/admin confirma declarando rol secretaria', '42501', v_msg);
  v_msg := pg_temp.como(v_adm, pg_temp.sql_confirmar(c_n || 'aud1', v_adm, (SELECT base_role FROM public.cardiolink_user_roles WHERE user_id = v_adm), jsonb_build_object('cobroConfirmadoPorId', v_sec::text)));
  PERFORM pg_temp.r('A11 owner/admin confirma atribuyéndola a la Secretaría (PorId ajeno)', '42501', v_msg);
  v_msg := pg_temp.como(v_adm, pg_temp.sql_confirmar(c_n || 'aud1', v_adm, (SELECT base_role FROM public.cardiolink_user_roles WHERE user_id = v_adm), '{"cobroConfirmadoPorEmail":"secretaria@falso.test"}'::jsonb));
  PERFORM pg_temp.r('A12 owner/admin confirma con el email de otra persona', '42501', v_msg);
  v_msg := pg_temp.como(v_adm, pg_temp.sql_confirmar(c_n || 'aud1', v_adm, (SELECT base_role FROM public.cardiolink_user_roles WHERE user_id = v_adm), '{"cobroConfirmadoPor":"Secretaria Geraldine"}'::jsonb));
  PERFORM pg_temp.r('A13 owner/admin confirma con el nombre de otra persona', '42501', v_msg);
  v_msg := pg_temp.como(v_sec, pg_temp.sql_confirmar(c_n || 'aud1', v_sec, 'secretaria'));
  PERFORM pg_temp.r('A14 (control) la confirmación válida de la asociada sobre el mismo pendiente', 'OK n=1', v_msg);
  v_msg := pg_temp.como(v_adm, format($q$UPDATE public.cardiolink_atenciones SET payload = payload || jsonb_build_object('cobroConfirmadoPorId', %L) WHERE id = %L$q$, v_adm::text, c_n || 'aud1'));
  PERFORM pg_temp.r('A15 owner/admin reescribe quién confirmó una confirmación ya hecha (PorId)', '42501', v_msg);
  v_msg := pg_temp.como(v_adm, format($q$UPDATE public.cardiolink_atenciones SET payload = payload || '{"cobroConfirmadoPorEmail":"otro@falso.test"}'::jsonb WHERE id = %L$q$, c_n || 'aud1'));
  PERFORM pg_temp.r('A16 owner/admin reescribe el email de una confirmación ya hecha', '42501', v_msg);
  v_msg := pg_temp.como(v_adm, format($q$UPDATE public.cardiolink_atenciones SET payload = payload || '{"cobroConfirmadoEn":"2020-01-01T00:00:00Z"}'::jsonb WHERE id = %L$q$, c_n || 'aud1'));
  PERFORM pg_temp.r('A17 owner/admin reescribe la fecha efectiva de una confirmación ya hecha', '42501', v_msg);
  v_msg := pg_temp.como(v_adm, format($q$UPDATE public.cardiolink_atenciones SET payload = jsonb_set(payload, '{cobroAuditoria}', '[]') WHERE id = %L$q$, c_n || 'aud1'));
  PERFORM pg_temp.r('A18 owner/admin borra la auditoría de una confirmación', '42501', v_msg);
  v_msg := pg_temp.como(v_adm, format($q$UPDATE public.cardiolink_atenciones SET payload = jsonb_set(payload, '{cobroAuditoria}', (payload->'cobroAuditoria') || '[{"accion":"corregido","usuario":"otra@falso.test","email":"otra@falso.test"}]'::jsonb) WHERE id = %L$q$, c_n || 'aud1'));
  PERFORM pg_temp.r('A19 owner/admin agrega un evento de auditoría atribuido a otra persona', '42501', v_msg);
  v_msg := pg_temp.como(v_adm, format($q$UPDATE public.cardiolink_atenciones SET payload = jsonb_set(payload, '{cobroAuditoria}', (payload->'cobroAuditoria') || jsonb_build_array(jsonb_build_object('accion','corregido','usuario',lower(%L),'email',lower(%L)))) WHERE id = %L$q$, (SELECT email FROM auth.users WHERE id = v_adm), (SELECT email FROM auth.users WHERE id = v_adm), c_n || 'aud1'));
  PERFORM pg_temp.r('A20 owner/admin agrega un evento de auditoría a su propio nombre (permitido)', 'OK n=1', v_msg);
  v_msg := pg_temp.como(v_sec, format($q$UPDATE public.cardiolink_atenciones SET payload = jsonb_set(payload, '{cobroAuditoria}', (payload->'cobroAuditoria') || '[{"accion":"x"}]'::jsonb) WHERE id = %L$q$, c_n || 'aud1'));
  PERFORM pg_temp.r('A21 la Secretaría asociada no agrega eventos a un cobro confirmado', '42501', v_msg);
  v_msg := pg_temp.como(v_med, format($q$INSERT INTO public.cardiolink_atenciones (id, payload, updated_at) VALUES (%L, %L::jsonb, now())$q$, c_n || 'aud_alta',
           (v_base || jsonb_build_object('id', c_n || 'aud_alta', 'formaPago', 'Efectivo', 'estadoCobro', 'cobrado', 'cobroConfirmadoEn', now()::text, 'cobroConfirmadoPor', 'Secretaria Geraldine', 'cobroMedioPago', 'Efectivo', 'cobroAuditoria', '[{"accion":"cobrado_al_registrar","usuario":"Secretaria Geraldine"}]'::jsonb))::text));
  PERFORM pg_temp.r('A22 (control, residual documentado) el alta "cobrada al registrar" del médico es una etiqueta: no es identidad verificada', 'OK n=1', v_msg);

  -- --- Secretaría NO asociada (se desactiva la asociación; efecto inmediato) ---
  v_msg := pg_temp.asociar(v_adm, v_sec, v_med, false);
  PERFORM pg_temp.r('25 desasociar a la secretaría (RPC real)', 'OK', v_msg);
  v_msg := pg_temp.como(v_sec, format($q$UPDATE public.cardiolink_atenciones SET payload = payload || jsonb_build_object('estadoCobro','cobrado','formaPago','Efectivo','cobroMedioPago','Efectivo','cobroConfirmadoEn',now()::text,'cobroConfirmadoPorId',%L,'cobroConfirmadoPorRol','secretaria') WHERE id = %L$q$, v_sec::text, c_n || 'pend2'));
  PERFORM pg_temp.r('26 NO asociada intenta confirmar (identidad y fecha correctas)', '42501', v_msg);
  v_msg := pg_temp.como(v_sec, format($q$UPDATE public.cardiolink_atenciones SET payload = jsonb_set(payload, '{estadoCobro}', '"sin_cobro"') WHERE id = %L$q$, c_n || 'pend2'));
  PERFORM pg_temp.r('27 NO asociada cambia el estado de cobro', '42501', v_msg);
  v_msg := pg_temp.como(v_sec, format($q$UPDATE public.cardiolink_atenciones SET payload = jsonb_set(payload, '{cobroAuditoria}', '[]') WHERE id = %L$q$, c_n || 'pend2'));
  PERFORM pg_temp.r('28 NO asociada borra la auditoría de cobro', '42501', v_msg);
  v_msg := pg_temp.como(v_sec, format($q$UPDATE public.cardiolink_atenciones SET payload = jsonb_set(payload, '{observaciones}', '"qa"') WHERE id = %L$q$, c_n || 'pend2'));
  PERFORM pg_temp.r('29 NO asociada edita observaciones de una fila con cobro (operación administrativa conservada)', 'OK n=1', v_msg);
  v_msg := pg_temp.como(v_sec, format($q$UPDATE public.cardiolink_atenciones SET payload = jsonb_set(payload, '{estadoTurno}', '"en sala"') WHERE id = %L$q$, c_n || 'pend2'));
  PERFORM pg_temp.r('30 NO asociada cambia el estado del turno (sala de espera conservada)', 'OK n=1', v_msg);
  v_msg := pg_temp.como(v_sec, format($q$UPDATE public.cardiolink_atenciones SET payload = jsonb_set(payload, '{fecha}', '"2099-01-01"') WHERE id = %L$q$, c_n || 'pend2'));
  PERFORM pg_temp.r('31 NO asociada reprograma la fecha (agenda conservada)', 'OK n=1', v_msg);
  v_msg := pg_temp.como(v_sec, format($q$UPDATE public.cardiolink_atenciones SET payload = jsonb_set(payload, '{montoConsulta}', '36000') WHERE id = %L$q$, c_n || 'pend2'));
  PERFORM pg_temp.r('32 NO asociada edita el monto de un cobro PENDIENTE (igual que el médico: no congelado)', 'OK n=1', v_msg);
  v_msg := pg_temp.como(v_sec, format($q$UPDATE public.cardiolink_atenciones SET payload = jsonb_set(payload, '{montoConsulta}', '99999') WHERE id = %L$q$, c_n || 'conf1'));
  PERFORM pg_temp.r('33 NO asociada edita el monto de un cobro CONFIRMADO', '42501', v_msg);
  v_msg := pg_temp.como(v_sec, format($q$UPDATE public.cardiolink_atenciones SET payload = jsonb_set(payload, '{estadoTurno}', '"cancelado"') WHERE id = %L$q$, c_n || 'conf1'));
  PERFORM pg_temp.r('34 NO asociada cancela un turno con cobro confirmado', '42501', v_msg);
  v_msg := pg_temp.como(v_sec, format($q$DELETE FROM public.cardiolink_atenciones WHERE id = %L$q$, c_n || 'pend3'));
  PERFORM pg_temp.r('35 NO asociada borra una atención con cobro pendiente', '42501', v_msg);
  v_msg := pg_temp.como(v_sec, format($q$DELETE FROM public.cardiolink_atenciones WHERE id = %L$q$, c_n || 'conf1'));
  PERFORM pg_temp.r('36 NO asociada borra una atención con cobro confirmado', '42501', v_msg);
  v_msg := pg_temp.como(v_sec, format($q$INSERT INTO public.cardiolink_atenciones (id, payload, updated_at) VALUES (%L, %L::jsonb, now())$q$, c_n || 'ins_sec_pend',
           (v_base || jsonb_build_object('id', c_n || 'ins_sec_pend', 'estadoCobro', 'pendiente', 'cobroPendienteEn', now()::text, 'cobroPendientePor', 'QA', 'cobroAuditoria', '[{"accion":"pendiente"}]'::jsonb))::text));
  PERFORM pg_temp.r('37 NO asociada da de alta una atención con cobro pendiente (Carga conservada)', 'OK n=1', v_msg);
  v_msg := pg_temp.como(v_sec, format($q$INSERT INTO public.cardiolink_atenciones (id, payload, updated_at) VALUES (%L, %L::jsonb, now())$q$, c_n || 'ins_sec_cobr',
           (v_base || jsonb_build_object('id', c_n || 'ins_sec_cobr', 'formaPago', 'Efectivo', 'estadoCobro', 'cobrado', 'cobroConfirmadoEn', now()::text, 'cobroConfirmadoPor', 'QA', 'cobroMedioPago', 'Efectivo', 'cobroAuditoria', '[{"accion":"cobrado_al_registrar"}]'::jsonb))::text));
  PERFORM pg_temp.r('38 NO asociada da de alta una atención ya cobrada al registrar (Carga conservada)', 'OK n=1', v_msg);
  v_msg := pg_temp.como(v_sec, format($q$INSERT INTO public.cardiolink_atenciones (id, payload, updated_at) VALUES (%L, %L::jsonb, now())$q$, c_n || 'ins_sec_forja',
           (v_base || jsonb_build_object('id', c_n || 'ins_sec_forja', 'formaPago', 'Efectivo', 'estadoCobro', 'cobrado', 'cobroConfirmadoEn', now()::text, 'cobroConfirmadoPorId', v_adm::text, 'cobroConfirmadoPorRol', 'owner'))::text));
  PERFORM pg_temp.r('39 NO asociada inserta con confirmación atribuida a otro (PorId/PorRol)', '42501', v_msg);
  v_msg := pg_temp.como(v_sec, format($q$INSERT INTO public.cardiolink_atenciones (id, payload, updated_at) VALUES (%L, %L::jsonb, now())$q$, c_n || 'ins_sec_nc',
           (v_base || jsonb_build_object('id', c_n || 'ins_sec_nc', 'tipoCobro', 'No cobrar', 'noCobrar', true, 'estadoCobro', 'sin_cobro'))::text));
  PERFORM pg_temp.r('40 NO asociada da de alta una atención "No cobrar" (sin_cobro)', 'OK n=1', v_msg);
  v_msg := pg_temp.asociar(v_adm, v_sec, v_med, true);
  PERFORM pg_temp.r('41 reasociar a la secretaría', 'OK', v_msg);
  v_msg := pg_temp.como(v_sec, format($q$DELETE FROM public.cardiolink_atenciones WHERE id = %L$q$, c_n || 'conf1'));
  PERFORM pg_temp.r('42 asociada borra una atención con cobro confirmado (permitido por diseño)', 'OK n=1', v_msg);

  -- --- INSERT del médico (falsificación de auditoría) ---
  v_msg := pg_temp.como(v_med, format($q$INSERT INTO public.cardiolink_atenciones (id, payload, updated_at) VALUES (%L, %L::jsonb, now())$q$, c_n || 'ins_med_pend',
           (v_base || jsonb_build_object('id', c_n || 'ins_med_pend', 'estadoCobro', 'pendiente', 'cobroPendienteEn', now()::text, 'cobroPendientePor', 'QA', 'cobroAuditoria', '[{"accion":"pendiente"}]'::jsonb))::text));
  PERFORM pg_temp.r('43 médico da de alta una atención con cobro pendiente (legítimo)', 'OK n=1', v_msg);
  v_msg := pg_temp.como(v_med, format($q$INSERT INTO public.cardiolink_atenciones (id, payload, updated_at) VALUES (%L, %L::jsonb, now())$q$, c_n || 'ins_med_cobr',
           (v_base || jsonb_build_object('id', c_n || 'ins_med_cobr', 'formaPago', 'Efectivo', 'estadoCobro', 'cobrado', 'cobroConfirmadoEn', now()::text, 'cobroConfirmadoPor', 'QA', 'cobroMedioPago', 'Efectivo', 'cobroAuditoria', '[{"accion":"cobrado_al_registrar"}]'::jsonb))::text));
  PERFORM pg_temp.r('44 médico da de alta una atención ya cobrada al registrar (legítimo)', 'OK n=1', v_msg);
  v_msg := pg_temp.como(v_med, format($q$INSERT INTO public.cardiolink_atenciones (id, payload, updated_at) VALUES (%L, %L::jsonb, now())$q$, c_n || 'ins_med_sc',
           (v_base || jsonb_build_object('id', c_n || 'ins_med_sc', 'tipoCobro', 'No cobrar', 'noCobrar', true, 'estadoCobro', 'sin_cobro'))::text));
  PERFORM pg_temp.r('45 médico da de alta una atención "No cobrar" (sin_cobro)', 'OK n=1', v_msg);
  v_msg := pg_temp.como(v_med, format($q$INSERT INTO public.cardiolink_atenciones (id, payload, updated_at) VALUES (%L, %L::jsonb, now())$q$, c_n || 'ins_med_hist',
           (v_base || jsonb_build_object('id', c_n || 'ins_med_hist', 'formaPago', 'Efectivo'))::text));
  PERFORM pg_temp.r('46 médico da de alta una atención sin campos de cobro (compatibilidad con atenciones históricas)', 'OK n=1', v_msg);
  v_msg := pg_temp.como(v_med, format($q$INSERT INTO public.cardiolink_atenciones (id, payload, updated_at) VALUES (%L, %L::jsonb, now())$q$, c_n || 'ins_med_rol',
           (v_base || jsonb_build_object('id', c_n || 'ins_med_rol', 'estadoCobro', 'cobrado', 'cobroConfirmadoEn', now()::text, 'cobroConfirmadoPorRol', 'secretaria'))::text));
  PERFORM pg_temp.r('47 médico inserta atribuyendo la confirmación a Secretaría (cobroConfirmadoPorRol)', '42501', v_msg);
  v_msg := pg_temp.como(v_med, format($q$INSERT INTO public.cardiolink_atenciones (id, payload, updated_at) VALUES (%L, %L::jsonb, now())$q$, c_n || 'ins_med_id',
           (v_base || jsonb_build_object('id', c_n || 'ins_med_id', 'estadoCobro', 'cobrado', 'cobroConfirmadoEn', now()::text, 'cobroConfirmadoPorId', v_sec::text))::text));
  PERFORM pg_temp.r('48 médico inserta con cobroConfirmadoPorId de una Secretaría', '42501', v_msg);
  v_msg := pg_temp.como(v_med, format($q$INSERT INTO public.cardiolink_atenciones (id, payload, updated_at) VALUES (%L, %L::jsonb, now())$q$, c_n || 'ins_med_mail',
           (v_base || jsonb_build_object('id', c_n || 'ins_med_mail', 'estadoCobro', 'cobrado', 'cobroConfirmadoEn', now()::text, 'cobroConfirmadoPorEmail', 'secretaria@qa.test'))::text));
  PERFORM pg_temp.r('49 médico inserta con cobroConfirmadoPorEmail', '42501', v_msg);
  v_msg := pg_temp.como(v_med, format($q$INSERT INTO public.cardiolink_atenciones (id, payload, updated_at) VALUES (%L, %L::jsonb, now())$q$, c_n || 'ins_med_simul',
           (v_base || jsonb_build_object('id', c_n || 'ins_med_simul', 'estadoCobro', 'cobrado', 'cobroPendienteEn', now()::text, 'cobroConfirmadoEn', (now() + interval '9 days')::text, 'cobroMedioPago', 'Efectivo'))::text));
  PERFORM pg_temp.r('50 médico inserta un "cobrado" con cobroPendienteEn (simula confirmación diferida con fecha efectiva elegida)', '42501', v_msg);
  v_msg := pg_temp.como(v_med, format($q$INSERT INTO public.cardiolink_atenciones (id, payload, updated_at) VALUES (%L, %L::jsonb, now())$q$, c_n || 'ins_med_aud',
           (v_base || jsonb_build_object('id', c_n || 'ins_med_aud', 'estadoCobro', 'cobrado', 'cobroConfirmadoEn', now()::text, 'cobroAuditoria', '[{"accion":"confirmado","usuario":"Secretaria"}]'::jsonb))::text));
  PERFORM pg_temp.r('51 médico inserta una auditoría con acción "confirmado"', '42501', v_msg);
  v_msg := pg_temp.como(v_med, format($q$INSERT INTO public.cardiolink_atenciones (id, payload, updated_at) VALUES (%L, %L::jsonb, now())$q$, c_n || 'ins_med_pc',
           (v_base || jsonb_build_object('id', c_n || 'ins_med_pc', 'estadoCobro', 'pendiente', 'cobroPendienteEn', now()::text, 'cobroConfirmadoEn', now()::text))::text));
  PERFORM pg_temp.r('52 médico inserta un pendiente que ya trae datos de confirmación', '42501', v_msg);
  v_msg := pg_temp.como(v_med, format($q$INSERT INTO public.cardiolink_atenciones (id, payload, updated_at) VALUES (%L, %L::jsonb, now())$q$, c_n || 'ins_med_est',
           (v_base || jsonb_build_object('id', c_n || 'ins_med_est', 'estadoCobro', 'confirmado_por_secretaria'))::text));
  PERFORM pg_temp.r('53 médico inserta un estadoCobro desconocido', '42501', v_msg);
  v_msg := pg_temp.como(v_med, format($q$INSERT INTO public.cardiolink_atenciones (id, payload, updated_at) VALUES (%L, %L::jsonb, now())$q$, c_n || 'ins_med_arr',
           (v_base || jsonb_build_object('id', c_n || 'ins_med_arr', 'estadoCobro', 'cobrado', 'cobroConfirmadoEn', now()::text, 'cobroAuditoria', '"confirmado"'::jsonb))::text));
  PERFORM pg_temp.r('54 médico inserta una auditoría con formato inválido (no es lista)', '42501', v_msg);

  -- --- UPSERT de sincronización (BEFORE INSERT corre antes de resolver ON CONFLICT) ---
  SELECT payload INTO v_antes FROM public.cardiolink_atenciones WHERE id = c_n || 'conf2';
  v_msg := pg_temp.como(v_med, format($q$INSERT INTO public.cardiolink_atenciones (id, payload, updated_at) VALUES (%L, %L::jsonb, now()) ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at$q$, c_n || 'conf2', v_antes::text));
  PERFORM pg_temp.r('55 upsert legítimo del médico sobre su fila ya confirmada, sin cambios (copia sincronizada)', 'OK n=1', v_msg);
  v_msg := pg_temp.como(v_med, format($q$INSERT INTO public.cardiolink_atenciones (id, payload, updated_at) VALUES (%L, %L::jsonb, now()) ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at$q$, c_n || 'conf2', (v_antes || '{"observaciones":"edición clínica"}'::jsonb)::text));
  PERFORM pg_temp.r('56 upsert del médico sobre fila confirmada con una edición no financiera', 'OK n=1', v_msg);
  v_msg := pg_temp.como(v_med, format($q$INSERT INTO public.cardiolink_atenciones (id, payload, updated_at) VALUES (%L, %L::jsonb, now()) ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at$q$, c_n || 'conf2', (v_antes || '{"estadoCobro":"pendiente"}'::jsonb)::text));
  PERFORM pg_temp.r('57 upsert del médico que intenta REVERTIR el estado de una fila confirmada (copia vieja)', '42501', v_msg);
  v_msg := pg_temp.como(v_med, format($q$INSERT INTO public.cardiolink_atenciones (id, payload, updated_at) VALUES (%L, %L::jsonb, now()) ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at$q$, c_n || 'conf2', (v_antes || '{"montoConsulta":1}'::jsonb)::text));
  PERFORM pg_temp.r('58 upsert del médico que cambia el importe de una fila confirmada', '42501', v_msg);
  v_msg := pg_temp.como(v_med, format($q$INSERT INTO public.cardiolink_atenciones (id, payload, updated_at) VALUES (%L, %L::jsonb, now()) ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at$q$, c_n || 'pend3',
           (v_base || jsonb_build_object('id', c_n || 'pend3', 'estadoCobro', 'cobrado', 'cobroConfirmadoEn', now()::text, 'cobroConfirmadoPorId', v_sec::text, 'cobroConfirmadoPorRol', 'secretaria', 'cobroPendienteEn', now()::text))::text));
  PERFORM pg_temp.r('59 upsert del médico sobre una fila PENDIENTE existente que intenta marcarla confirmada por Secretaría', '42501', v_msg);

  -- --- Resurrección de una confirmación eliminada ---
  DELETE FROM public.cardiolink_atenciones WHERE id = c_n || 'conf3'; -- como postgres (equivale a una baja de Administración)
  v_msg := pg_temp.como(v_med, format($q$INSERT INTO public.cardiolink_atenciones (id, payload, updated_at) VALUES (%L, %L::jsonb, now()) ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload$q$, c_n || 'conf3', (v_base || v_conf || jsonb_build_object('id', c_n || 'conf3'))::text));
  PERFORM pg_temp.r('60 médico reinserta (vía upsert) la fila confirmada eliminada con sus marcas de confirmación', '42501', v_msg);
  -- Control documentado: una "cobrada al registrar" nueva es indistinguible de un alta legítima y no suma dinero que el alta normal no pueda sumar.
  v_msg := pg_temp.como(v_med, format($q$INSERT INTO public.cardiolink_atenciones (id, payload, updated_at) VALUES (%L, %L::jsonb, now())$q$, c_n || 'conf3',
           (v_base || jsonb_build_object('id', c_n || 'conf3', 'formaPago', 'Efectivo', 'estadoCobro', 'cobrado', 'cobroConfirmadoEn', now()::text, 'cobroMedioPago', 'Efectivo', 'cobroAuditoria', '[{"accion":"cobrado_al_registrar"}]'::jsonb))::text));
  PERFORM pg_temp.r('61 (control) el mismo id reinsertado como alta "cobrada al registrar" es una alta nueva y legítima (riesgo residual documentado)', 'OK n=1', v_msg);

  -- --- owner/admin y rol sin API ---
  v_msg := pg_temp.como(v_adm, format($q$INSERT INTO public.cardiolink_atenciones (id, payload, updated_at) VALUES (%L, %L::jsonb, now())$q$, c_n || 'ins_adm',
           (v_base || v_conf || jsonb_build_object('id', c_n || 'ins_adm'))::text));
  PERFORM pg_temp.r('62 owner/admin inserta una fila con confirmación (restauración de backup por Administración)', 'OK n=1', v_msg);
  INSERT INTO public.cardiolink_atenciones (id, payload, updated_at) VALUES (c_n || 'ins_pg', v_base || v_conf || jsonb_build_object('id', c_n || 'ins_pg'), now());
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM pg_temp.r('63 postgres/service_role no interceptado en INSERT', 'n=1', 'n=' || v_n);

  -- --- Versión instalada y propiedades de seguridad ---
  v_cmt := coalesce(obj_description('public.cardiolink_atenciones_guard_cobro_v1()'::regprocedure, 'pg_proc'), '');
  PERFORM pg_temp.r('64 la función guard está marcada [cobros-guard v4.2.1] con estado_previo registrado', 'true',
    ((v_cmt LIKE '%[cobros-guard v4.2.1]%') AND (v_cmt LIKE '%estado_previo=sin_guard%' OR v_cmt LIKE '%estado_previo=v4.1.1%'))::text);
  PERFORM pg_temp.r('65 hay exactamente 3 triggers del guard habilitados', '3',
    (SELECT count(*)::text FROM pg_trigger WHERE tgrelid = 'public.cardiolink_atenciones'::regclass AND NOT tgisinternal AND tgenabled = 'O'
        AND tgname IN ('cardiolink_atenciones_guard_cobro_v1', 'cardiolink_atenciones_guard_cobro_v1_del', 'cardiolink_atenciones_guard_cobro_v1_ins')));
  PERFORM pg_temp.r('66 las dos funciones son SECURITY INVOKER y no ejecutables por anon/authenticated', 'true',
    (NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid IN ('public.cardiolink_atenciones_guard_cobro_v1()'::regprocedure, 'public.cardiolink_atenciones_guard_cobro_ins_v1()'::regprocedure) AND prosecdef)
     AND NOT has_function_privilege('anon', 'public.cardiolink_atenciones_guard_cobro_ins_v1()', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.cardiolink_atenciones_guard_cobro_ins_v1()', 'EXECUTE'))::text);
END
$t$;

SELECT n, prueba, esperado, obtenido, resultado FROM qa_cobros_resultados ORDER BY n;
SELECT resultado, count(*) AS cantidad FROM qa_cobros_resultados GROUP BY resultado ORDER BY resultado;
ROLLBACK;
