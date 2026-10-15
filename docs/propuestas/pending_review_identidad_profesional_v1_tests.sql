-- CardioLink · Identidad profesional V1 — PRUEBAS SQL de la RPC (STAGING, con la migración YA aplicada). NO ejecutar en Production.
-- Todo corre dentro de UNA transacción que termina en ROLLBACK: no deja ningún cambio (ni siquiera sobre la config).
-- Usa las cuentas REALES de STAGING (owner, médico, secretaría) con claims JWT simulados y rol `authenticated`; no crea cuentas.
-- Si falta un rol activo (p. ej. no hay secretaría) esa prueba se informa como OMITIDA, no como fallo.
-- Resultado: una fila por prueba en la tabla temporal _res (se muestra al final) + NOTICE por prueba. Cualquier FALLA => revisar.
-- Las pruebas de formato/permiso de fondo también se corrieron en PostgreSQL real (PGlite) con un esquema mínimo; ver el informe.

BEGIN;

CREATE TEMP TABLE _res(n serial, prueba text, resultado text) ON COMMIT DROP;
GRANT ALL ON _res TO authenticated;
GRANT ALL ON SEQUENCE _res_n_seq TO authenticated;

DO $$
DECLARE
  v_owner uuid; v_med uuid; v_med_prof text; v_sec uuid; v_otro text; v_antes jsonb;
BEGIN
  SELECT user_id INTO v_owner FROM public.cardiolink_user_roles WHERE base_role='owner' AND active LIMIT 1;
  SELECT user_id, professional_id INTO v_med, v_med_prof FROM public.cardiolink_user_roles
   WHERE base_role='medico' AND active AND professional_id IN (SELECT p->>'id' FROM public.cardiolink_atenciones a,
          jsonb_array_elements(a.payload#>'{config,profesionales}') p WHERE a.id='__cardiolink_config_v1') LIMIT 1;
  SELECT user_id INTO v_sec FROM public.cardiolink_user_roles WHERE base_role='secretaria' AND active LIMIT 1;
  SELECT p->>'id' INTO v_otro FROM public.cardiolink_atenciones a, jsonb_array_elements(a.payload#>'{config,profesionales}') p
   WHERE a.id='__cardiolink_config_v1' AND p->>'id' <> coalesce(v_med_prof,'') AND p->>'id' <> 'general' LIMIT 1;
  SELECT payload INTO v_antes FROM public.cardiolink_atenciones WHERE id='__cardiolink_config_v1';
  INSERT INTO _res(prueba,resultado) VALUES ('fixtures','owner='||coalesce(v_owner::text,'-')||' medico='||coalesce(v_med::text,'-')||' prof='||coalesce(v_med_prof,'-')||' secretaria='||coalesce(v_sec::text,'-')||' otro='||coalesce(v_otro,'-'));
  PERFORM set_config('qa.owner',coalesce(v_owner::text,''),true); PERFORM set_config('qa.med',coalesce(v_med::text,''),true);
  PERFORM set_config('qa.prof',coalesce(v_med_prof,''),true); PERFORM set_config('qa.sec',coalesce(v_sec::text,''),true); PERFORM set_config('qa.otro',coalesce(v_otro,''),true);
  PERFORM set_config('qa.antes', v_antes::text, true);
END $$;

SET LOCAL ROLE authenticated;

DO $$
DECLARE
  v_owner text := current_setting('qa.owner'); v_med text := current_setting('qa.med'); v_prof text := current_setting('qa.prof');
  v_sec text := current_setting('qa.sec'); v_otro text := current_setting('qa.otro');
  r jsonb; v_msg text; v_code text; v_c jsonb;
  v_img text := 'data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA';
BEGIN
  -- 1) médico guarda SU identidad
  IF v_med<>'' THEN
    PERFORM set_config('request.jwt.claims', json_build_object('sub',v_med,'role','authenticated','email','qa@qa.local')::text, true);
    r := public.cardiolink_guardar_identidad_profesional_v1(v_prof, jsonb_build_object('telefonoDocumento','QA-1234','logoDocumentoData',v_img,'mostrarFirmaDocumento',true));
    INSERT INTO _res(prueba,resultado) VALUES ('1 médico guarda su propia identidad', CASE WHEN r->'identity'->>'telefonoDocumento'='QA-1234' AND r->'identity'->>'logoDocumentoData'=v_img THEN 'OK' ELSE 'FALLA '||r::text END);
    -- 10) config_medico_v1 devuelve su identidad propia y NO la de otros
    SELECT public.cardiolink_config_medico_v1() INTO v_c;
    INSERT INTO _res(prueba,resultado) VALUES ('10 config_medico_v1 devuelve la identidad propia',
      CASE WHEN (SELECT p->>'telefonoDocumento' FROM jsonb_array_elements(v_c->'profesionales') p WHERE p->>'id'=v_prof)='QA-1234' THEN 'OK' ELSE 'FALLA' END);
    INSERT INTO _res(prueba,resultado) VALUES ('11 config_medico_v1 NO devuelve identidad de otros profesionales',
      CASE WHEN NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_c->'profesionales') p WHERE p->>'id'<>v_prof AND (p ? 'logoDocumentoData' OR p ? 'firmaDocumentoData' OR p ? 'matriculaNacional' OR p ? 'telefonoDocumento' OR p ? 'marcaDocumento')) THEN 'OK' ELSE 'FALLA' END);
    -- 2) médico NO puede otro
    IF v_otro<>'' THEN
      BEGIN PERFORM public.cardiolink_guardar_identidad_profesional_v1(v_otro, '{"telefonoDocumento":"hack"}'::jsonb); v_msg:='SIN ERROR'; EXCEPTION WHEN OTHERS THEN v_msg:=SQLERRM; v_code:=SQLSTATE; END;
      INSERT INTO _res(prueba,resultado) VALUES ('2 médico NO puede guardar la identidad de otro profesional', CASE WHEN v_code='42501' THEN 'OK' ELSE 'FALLA '||v_msg END);
    ELSE INSERT INTO _res(prueba,resultado) VALUES ('2 médico vs otro profesional','OMITIDA (no hay otro profesional en la config)'); END IF;
    -- 8/9) vacío borra, omitida conserva
    r := public.cardiolink_guardar_identidad_profesional_v1(v_prof, '{"logoDocumentoData":""}'::jsonb);
    INSERT INTO _res(prueba,resultado) VALUES ('8 string vacío borra el logo; 9 las claves omitidas conservan su valor',
      CASE WHEN r->'identity'->>'logoDocumentoData'='' AND r->'identity'->>'telefonoDocumento'='QA-1234' THEN 'OK' ELSE 'FALLA '||r::text END);
    -- 6) clave ajena rechazada
    BEGIN PERFORM public.cardiolink_guardar_identidad_profesional_v1(v_prof, '{"prestaciones":[]}'::jsonb); v_msg:='SIN ERROR'; v_code:=''; EXCEPTION WHEN OTHERS THEN v_msg:=SQLERRM; v_code:=SQLSTATE; END;
    INSERT INTO _res(prueba,resultado) VALUES ('6 la RPC rechaza claves que no son de identidad (prestaciones)', CASE WHEN v_code='22023' THEN 'OK' ELSE 'FALLA '||v_msg END);
  ELSE INSERT INTO _res(prueba,resultado) VALUES ('1/2/8/9/10/11 médico','OMITIDA (no hay médico activo con professional_id en la config)'); END IF;

  -- 3) owner guarda identidad de cualquier profesional
  IF v_owner<>'' AND v_otro<>'' THEN
    PERFORM set_config('request.jwt.claims', json_build_object('sub',v_owner,'role','authenticated','email','qa@qa.local')::text, true);
    r := public.cardiolink_guardar_identidad_profesional_v1(v_otro, '{"telefonoDocumento":"QA-OWNER"}'::jsonb);
    INSERT INTO _res(prueba,resultado) VALUES ('3 owner guarda la identidad de otro profesional', CASE WHEN r->'identity'->>'telefonoDocumento'='QA-OWNER' THEN 'OK' ELSE 'FALLA '||r::text END);
  ELSE INSERT INTO _res(prueba,resultado) VALUES ('3 owner','OMITIDA'); END IF;

  -- 5) secretaría rechazada
  IF v_sec<>'' AND v_otro<>'' THEN
    PERFORM set_config('request.jwt.claims', json_build_object('sub',v_sec,'role','authenticated','email','qa@qa.local')::text, true);
    BEGIN PERFORM public.cardiolink_guardar_identidad_profesional_v1(v_otro, '{"telefonoDocumento":"hack"}'::jsonb); v_msg:='SIN ERROR'; v_code:=''; EXCEPTION WHEN OTHERS THEN v_msg:=SQLERRM; v_code:=SQLSTATE; END;
    INSERT INTO _res(prueba,resultado) VALUES ('5 secretaría NO puede modificar identidad', CASE WHEN v_code='42501' THEN 'OK' ELSE 'FALLA '||v_msg END);
  ELSE INSERT INTO _res(prueba,resultado) VALUES ('5 secretaría','OMITIDA (no hay secretaría activa)'); END IF;

  -- sin sesión
  PERFORM set_config('request.jwt.claims','{}',true);
  BEGIN PERFORM public.cardiolink_guardar_identidad_profesional_v1(coalesce(nullif(v_otro,''),'x'), '{}'::jsonb); v_msg:='SIN ERROR'; v_code:=''; EXCEPTION WHEN OTHERS THEN v_msg:=SQLERRM; v_code:=SQLSTATE; END;
  INSERT INTO _res(prueba,resultado) VALUES ('sin sesión (auth.uid() nulo) es rechazado', CASE WHEN v_code='28000' THEN 'OK' ELSE 'FALLA '||v_msg END);
END $$;

RESET ROLE;

-- 7) lo único que cambió en la fila de config son claves de identidad: prestaciones/valores/especialidades idénticas
DO $$
DECLARE v_antes jsonb := current_setting('qa.antes')::jsonb; v_despues jsonb; v_a text; v_d text;
BEGIN
  SELECT payload INTO v_despues FROM public.cardiolink_atenciones WHERE id='__cardiolink_config_v1';
  SELECT jsonb_agg(jsonb_build_array(p->'id',p->'nombre',p->'area',p->'especialidadIds',p->'prestaciones',p->'valores'))::text INTO v_a FROM jsonb_array_elements(v_antes#>'{config,profesionales}') p;
  SELECT jsonb_agg(jsonb_build_array(p->'id',p->'nombre',p->'area',p->'especialidadIds',p->'prestaciones',p->'valores'))::text INTO v_d FROM jsonb_array_elements(v_despues#>'{config,profesionales}') p;
  INSERT INTO _res(prueba,resultado) VALUES ('7 prestaciones/valores/especialidades idénticas tras los guardados', CASE WHEN v_a=v_d THEN 'OK' ELSE 'FALLA' END);
  INSERT INTO _res(prueba,resultado) VALUES ('6 el resto de la config (usuarios, obras sociales, pacientes) idéntico',
    CASE WHEN (v_antes#>'{config}') - 'profesionales' = (v_despues#>'{config}') - 'profesionales' THEN 'OK' ELSE 'FALLA' END);
END $$;

SELECT n, prueba, resultado FROM _res ORDER BY n;

ROLLBACK;
