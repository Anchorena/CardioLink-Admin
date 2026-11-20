-- ===== PRUEBAS (como cada usuario real, vía claims + SET LOCAL ROLE authenticated; todo sintético qa4p_*; el veredicto final es una EXCEPTION que revierte todo) =====
CREATE TEMP TABLE t_act(clave text PRIMARY KEY, uid uuid, prof text);
GRANT SELECT ON t_act TO authenticated;
CREATE TEMP TABLE t_res(nombre text);
GRANT ALL ON t_res TO authenticated;
CREATE TEMP TABLE t_rol_orig AS SELECT user_id, base_role, professional_id, active FROM public.cardiolink_user_roles;
DO $$
DECLARE v_tabla text; s uuid; m uuid; o uuid; p text;
BEGIN
  SELECT table_name INTO v_tabla FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('secretaria_user_id','medico_user_id','activo') GROUP BY table_name HAVING count(*) = 3;
  IF v_tabla IS NULL THEN RAISE EXCEPTION 'Faltan actores: no hay tabla de asociaciones secretaria-médico'; END IF;
  EXECUTE format($q$SELECT a.secretaria_user_id, a.medico_user_id, m.professional_id
                      FROM public.%I a
                      JOIN public.cardiolink_user_roles s ON s.user_id = a.secretaria_user_id AND s.active AND s.base_role = 'secretaria'
                      JOIN public.cardiolink_user_roles m ON m.user_id = a.medico_user_id AND m.active AND m.base_role = 'medico' AND coalesce(m.professional_id,'') <> ''
                     WHERE a.activo ORDER BY a.secretaria_user_id, a.medico_user_id LIMIT 1$q$, v_tabla) INTO s, m, p;
  SELECT user_id INTO o FROM public.cardiolink_user_roles WHERE base_role IN ('owner','admin') AND active ORDER BY base_role, user_id LIMIT 1;
  IF s IS NULL OR m IS NULL OR o IS NULL THEN RAISE EXCEPTION 'Faltan actores (secretaria asociada a un médico activo con professional_id, y owner/admin activo)'; END IF;
  INSERT INTO t_act VALUES ('sec', s, NULL), ('med1', m, p), ('own', o, NULL), ('nadie', gen_random_uuid(), NULL), ('med2', o, 'qa4p_med2');
  IF p = 'qa4p_med2' THEN RAISE EXCEPTION 'professional_id del médico real colisiona con el sintético'; END IF;
  IF EXISTS (SELECT 1 FROM public.cardiolink_pacientes WHERE id LIKE 'qa4p\_%' ESCAPE '\') OR EXISTS (SELECT 1 FROM public.cardiolink_patient_documents WHERE patient_id LIKE 'qa4p\_%' ESCAPE '\')
     OR EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id='patient-documents' AND name LIKE '%qa4p\_%' ESCAPE '\') THEN RAISE EXCEPTION 'Ya existen filas/objetos qa4p_*: se aborta'; END IF;
END $$;

-- constructor de INSERT para tablas con columnas obligatorias desconocidas (sólo se llama como postgres)
CREATE FUNCTION pg_temp.arma_insert(p_tabla text, p_val jsonb) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE c record; cols text := ''; vals text := ''; v text; k text;
BEGIN
  FOR k IN SELECT jsonb_object_keys(p_val) LOOP
    cols := cols || CASE WHEN cols = '' THEN '' ELSE ',' END || quote_ident(k);
    vals := vals || CASE WHEN vals = '' THEN '' ELSE ',' END || quote_literal(p_val ->> k);
  END LOOP;
  FOR c IN SELECT column_name, data_type FROM information_schema.columns
            WHERE table_schema='public' AND table_name=p_tabla AND is_nullable='NO' AND column_default IS NULL AND NOT (p_val ? column_name) ORDER BY ordinal_position LOOP
    IF c.data_type IN ('text','character varying','character') THEN v := quote_literal('QA SINTETICO p4');
    ELSIF c.data_type LIKE 'timestamp%' THEN v := 'now()';
    ELSIF c.data_type = 'date' THEN v := 'current_date';
    ELSIF c.data_type = 'boolean' THEN v := 'false';
    ELSIF c.data_type IN ('integer','bigint','smallint','numeric') THEN v := '0';
    ELSIF c.data_type = 'uuid' THEN v := 'gen_random_uuid()';
    ELSIF c.data_type IN ('jsonb','json') THEN v := quote_literal('{}') || '::' || c.data_type;
    ELSE RAISE EXCEPTION 'columna obligatoria % (%) sin valor sintético', c.column_name, c.data_type; END IF;
    cols := cols || ',' || quote_ident(c.column_name); vals := vals || ',' || v;
  END LOOP;
  RETURN format('INSERT INTO public.%I (%s) VALUES (%s)', p_tabla, cols, vals);
END $f$;

-- fixture como postgres: UN paciente que EXISTE y que ningún médico atendió (sin asociación, evolución ni atención)
DO $$ BEGIN
  EXECUTE pg_temp.arma_insert('cardiolink_pacientes', jsonb_build_object('id', 'qa4p_pac_nuevo'));
  IF EXISTS (SELECT 1 FROM public.cardiolink_hc_evoluciones WHERE paciente_id = 'qa4p_pac_nuevo') THEN RAISE EXCEPTION 'fixture: el paciente sintético ya tiene evoluciones'; END IF;
END $$;

-- C0 control de la causa raíz: médico sin vínculo -> acceso clínico FALSE pero padrón TRUE
DO $t$
DECLARE v_uid uuid; a boolean; p boolean;
BEGIN
  SELECT uid INTO v_uid FROM t_act WHERE clave = 'med1';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  a := public.cardiolink_paciente_acceso_clinico_v1('qa4p_pac_nuevo'); p := public.cardiolink_paciente_padron_v1('qa4p_pac_nuevo');
  EXECUTE 'RESET ROLE';
  IF a IS NOT FALSE OR p IS NOT TRUE THEN RAISE EXCEPTION 'FALLA C0: acceso_clinico=% padron=% (esperado false/true)', a, p; END IF;
  INSERT INTO t_res VALUES ('C0 causa raíz: sin vínculo el acceso clínico es false, el padrón es true');
END $t$;
DO $t$
DECLARE v_uid uuid; k text; p boolean;
BEGIN
  FOREACH k IN ARRAY ARRAY['sec','nadie'] LOOP
    SELECT uid INTO v_uid FROM t_act WHERE clave = k;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated'; p := public.cardiolink_paciente_padron_v1('qa4p_pac_nuevo'); EXECUTE 'RESET ROLE';
    IF p IS NOT FALSE THEN RAISE EXCEPTION 'FALLA C1: el padrón debe ser false para % (obtuvo %)', k, p; END IF;
  END LOOP;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', (SELECT uid FROM t_act WHERE clave='med1'), 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated'; p := public.cardiolink_paciente_padron_v1('qa4p_pac_no_existe'); EXECUTE 'RESET ROLE';
  IF p IS NOT FALSE THEN RAISE EXCEPTION 'FALLA C1: paciente inexistente debe dar false'; END IF;
  EXECUTE 'SET LOCAL ROLE anon'; PERFORM set_config('request.jwt.claims', '', true);
  BEGIN PERFORM public.cardiolink_paciente_padron_v1('qa4p_pac_nuevo'); RAISE EXCEPTION 'FALLA C1: anon ejecutó el padrón'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  EXECUTE 'RESET ROLE';
  INSERT INTO t_res VALUES ('C1 padrón: false para Secretaría, sin rol, paciente inexistente y anon');
END $t$;

DO $t$
DECLARE v_uid uuid; v_own uuid; r text := 'ok'; v_prof text; v_id uuid;
BEGIN
  SELECT uid INTO v_uid FROM t_act WHERE clave = 'med1'; SELECT uid INTO v_own FROM t_act WHERE clave = 'med1';
  v_prof := (SELECT prof FROM t_act WHERE clave='med1');
  INSERT INTO storage.objects(bucket_id, name, owner) VALUES ('patient-documents', 'documents/qa4p_pac_nuevo/qa4p_d01.pdf', v_own);
  
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, professional_id, storage_path, original_filename, mime_type)
    VALUES ('qa4p_pac_nuevo', 'Certificado', 'QA p4 d01', v_prof, 'documents/qa4p_pac_nuevo/qa4p_d01.pdf', 'qa.pdf', 'application/pdf') RETURNING id INTO v_id;
  EXCEPTION WHEN insufficient_privilege THEN r := 'rls'; END;
  EXECUTE 'RESET ROLE';
  
  IF r = 'ok' AND v_id IS NULL THEN RAISE EXCEPTION 'FALLA: el INSERT ... RETURNING no devolvió la fila (política SELECT)'; END IF;
  IF r <> 'ok' THEN RAISE EXCEPTION 'FALLA d01: Rogelio (médico sin vínculo) emite SU documento a un paciente nuevo (esperado ok, obtuvo %)', r; END IF;
  INSERT INTO t_res VALUES ('d01 Rogelio (médico sin vínculo) emite SU documento a un paciente nuevo');
END $t$;

DO $t$
DECLARE v_uid uuid; v_own uuid; r text := 'ok'; v_prof text; v_id uuid;
BEGIN
  SELECT uid INTO v_uid FROM t_act WHERE clave = 'med1'; SELECT uid INTO v_own FROM t_act WHERE clave = 'med1';
  v_prof := 'qa4p_med2';
  INSERT INTO storage.objects(bucket_id, name, owner) VALUES ('patient-documents', 'documents/qa4p_pac_nuevo/qa4p_d02.pdf', v_own);
  
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, professional_id, storage_path, original_filename, mime_type)
    VALUES ('qa4p_pac_nuevo', 'Certificado', 'QA p4 d02', v_prof, 'documents/qa4p_pac_nuevo/qa4p_d02.pdf', 'qa.pdf', 'application/pdf') RETURNING id INTO v_id;
  EXCEPTION WHEN insufficient_privilege THEN r := 'rls'; END;
  EXECUTE 'RESET ROLE';
  
  IF r <> 'rls' THEN RAISE EXCEPTION 'FALLA d02: médico NO puede emitir a nombre de otro profesional (esperado rls, obtuvo %)', r; END IF;
  INSERT INTO t_res VALUES ('d02 médico NO puede emitir a nombre de otro profesional');
END $t$;

DO $t$
DECLARE v_uid uuid; v_own uuid; r text := 'ok'; v_prof text; v_id uuid;
BEGIN
  SELECT uid INTO v_uid FROM t_act WHERE clave = 'med1'; SELECT uid INTO v_own FROM t_act WHERE clave = 'own';
  v_prof := (SELECT prof FROM t_act WHERE clave='med1');
  INSERT INTO storage.objects(bucket_id, name, owner) VALUES ('patient-documents', 'documents/qa4p_pac_nuevo/qa4p_d03.pdf', v_own);
  
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, professional_id, storage_path, original_filename, mime_type)
    VALUES ('qa4p_pac_nuevo', 'Certificado', 'QA p4 d03', v_prof, 'documents/qa4p_pac_nuevo/qa4p_d03.pdf', 'qa.pdf', 'application/pdf') RETURNING id INTO v_id;
  EXCEPTION WHEN insufficient_privilege THEN r := 'rls'; END;
  EXECUTE 'RESET ROLE';
  
  IF r <> 'rls' THEN RAISE EXCEPTION 'FALLA d03: médico NO puede apoyar su fila en un archivo subido por otro usuario (esperado rls, obtuvo %)', r; END IF;
  INSERT INTO t_res VALUES ('d03 médico NO puede apoyar su fila en un archivo subido por otro usuario');
END $t$;

DO $t$
DECLARE v_uid uuid; v_own uuid; r text := 'ok'; v_prof text; v_id uuid;
BEGIN
  SELECT uid INTO v_uid FROM t_act WHERE clave = 'med1'; SELECT uid INTO v_own FROM t_act WHERE clave = 'med1';
  v_prof := (SELECT prof FROM t_act WHERE clave='med1');
  INSERT INTO storage.objects(bucket_id, name, owner) VALUES ('patient-documents', 'documents/qa4p_otro/qa4p_x.pdf', v_own);
  
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, professional_id, storage_path, original_filename, mime_type)
    VALUES ('qa4p_pac_nuevo', 'Certificado', 'QA p4 d04', v_prof, 'documents/qa4p_otro/qa4p_x.pdf', 'qa.pdf', 'application/pdf') RETURNING id INTO v_id;
  EXCEPTION WHEN insufficient_privilege THEN r := 'rls'; END;
  EXECUTE 'RESET ROLE';
  
  IF r <> 'rls' THEN RAISE EXCEPTION 'FALLA d04: médico NO puede apuntar a un archivo de la ruta de OTRO paciente (esperado rls, obtuvo %)', r; END IF;
  INSERT INTO t_res VALUES ('d04 médico NO puede apuntar a un archivo de la ruta de OTRO paciente');
END $t$;

DO $t$
DECLARE v_uid uuid; v_own uuid; r text := 'ok'; v_prof text; v_id uuid;
BEGIN
  SELECT uid INTO v_uid FROM t_act WHERE clave = 'med1'; SELECT uid INTO v_own FROM t_act WHERE clave = 'med1';
  v_prof := (SELECT prof FROM t_act WHERE clave='med1');
  INSERT INTO storage.objects(bucket_id, name, owner) VALUES ('patient-documents', 'documents/qa4p_pac_no_existe/qa4p_d05.pdf', v_own);
  
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, professional_id, storage_path, original_filename, mime_type)
    VALUES ('qa4p_pac_no_existe', 'Certificado', 'QA p4 d05', v_prof, 'documents/qa4p_pac_no_existe/qa4p_d05.pdf', 'qa.pdf', 'application/pdf') RETURNING id INTO v_id;
  EXCEPTION WHEN insufficient_privilege THEN r := 'rls'; END;
  EXECUTE 'RESET ROLE';
  
  IF r <> 'rls' THEN RAISE EXCEPTION 'FALLA d05: médico NO puede insertar sobre un paciente que no existe (esperado rls, obtuvo %)', r; END IF;
  INSERT INTO t_res VALUES ('d05 médico NO puede insertar sobre un paciente que no existe');
END $t$;

DO $t$
DECLARE v_uid uuid; v_own uuid; r text := 'ok'; v_prof text; v_id uuid;
BEGIN
  SELECT uid INTO v_uid FROM t_act WHERE clave = 'sec'; SELECT uid INTO v_own FROM t_act WHERE clave = 'sec';
  v_prof := (SELECT prof FROM t_act WHERE clave='med1');
  INSERT INTO storage.objects(bucket_id, name, owner) VALUES ('patient-documents', 'documents/qa4p_pac_nuevo/qa4p_d06.pdf', v_own);
  
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, professional_id, storage_path, original_filename, mime_type)
    VALUES ('qa4p_pac_nuevo', 'Certificado', 'QA p4 d06', v_prof, 'documents/qa4p_pac_nuevo/qa4p_d06.pdf', 'qa.pdf', 'application/pdf') RETURNING id INTO v_id;
  EXCEPTION WHEN insufficient_privilege THEN r := 'rls'; END;
  EXECUTE 'RESET ROLE';
  
  IF r = 'ok' AND v_id IS NULL THEN RAISE EXCEPTION 'FALLA: el INSERT ... RETURNING no devolvió la fila (política SELECT)'; END IF;
  IF r <> 'ok' THEN RAISE EXCEPTION 'FALLA d06: Secretaría asociada emite a nombre del profesional AUTORIZADO (esperado ok, obtuvo %)', r; END IF;
  INSERT INTO t_res VALUES ('d06 Secretaría asociada emite a nombre del profesional AUTORIZADO');
END $t$;

DO $t$
DECLARE v_uid uuid; v_own uuid; r text := 'ok'; v_prof text; v_id uuid;
BEGIN
  SELECT uid INTO v_uid FROM t_act WHERE clave = 'sec'; SELECT uid INTO v_own FROM t_act WHERE clave = 'sec';
  v_prof := 'qa4p_med2';
  INSERT INTO storage.objects(bucket_id, name, owner) VALUES ('patient-documents', 'documents/qa4p_pac_nuevo/qa4p_d07.pdf', v_own);
  
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, professional_id, storage_path, original_filename, mime_type)
    VALUES ('qa4p_pac_nuevo', 'Certificado', 'QA p4 d07', v_prof, 'documents/qa4p_pac_nuevo/qa4p_d07.pdf', 'qa.pdf', 'application/pdf') RETURNING id INTO v_id;
  EXCEPTION WHEN insufficient_privilege THEN r := 'rls'; END;
  EXECUTE 'RESET ROLE';
  
  IF r <> 'rls' THEN RAISE EXCEPTION 'FALLA d07: Secretaría NO emite a nombre de un profesional no autorizado (esperado rls, obtuvo %)', r; END IF;
  INSERT INTO t_res VALUES ('d07 Secretaría NO emite a nombre de un profesional no autorizado');
END $t$;

DO $t$
DECLARE v_uid uuid; v_own uuid; r text := 'ok'; v_prof text; v_id uuid;
BEGIN
  SELECT uid INTO v_uid FROM t_act WHERE clave = 'sec'; SELECT uid INTO v_own FROM t_act WHERE clave = 'sec';
  v_prof := (SELECT prof FROM t_act WHERE clave='med1');
  INSERT INTO storage.objects(bucket_id, name, owner) VALUES ('patient-documents', 'documents/qa4p_pac_nuevo/qa4p_d08.pdf', v_own);
  
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, professional_id, storage_path, original_filename, mime_type)
    VALUES ('qa4p_pac_nuevo', 'Imagen clínica', 'QA p4 d08', v_prof, 'documents/qa4p_pac_nuevo/qa4p_d08.pdf', 'qa.pdf', 'application/pdf') RETURNING id INTO v_id;
  EXCEPTION WHEN insufficient_privilege THEN r := 'rls'; END;
  EXECUTE 'RESET ROLE';
  
  IF r <> 'rls' THEN RAISE EXCEPTION 'FALLA d08: Secretaría NO sube 'Imagen clínica' (esperado rls, obtuvo %)', r; END IF;
  INSERT INTO t_res VALUES ('d08 Secretaría NO sube 'Imagen clínica'');
END $t$;

DO $t$
DECLARE v_uid uuid; v_own uuid; r text := 'ok'; v_prof text; v_id uuid;
BEGIN
  SELECT uid INTO v_uid FROM t_act WHERE clave = 'med1'; SELECT uid INTO v_own FROM t_act WHERE clave = 'med1';
  v_prof := (SELECT prof FROM t_act WHERE clave='med1');
  INSERT INTO storage.objects(bucket_id, name, owner) VALUES ('patient-documents', 'documents/qa4p_pac_nuevo/qa4p_d09.pdf', v_own);
  UPDATE public.cardiolink_user_roles SET active = false WHERE user_id = v_uid;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, professional_id, storage_path, original_filename, mime_type)
    VALUES ('qa4p_pac_nuevo', 'Certificado', 'QA p4 d09', v_prof, 'documents/qa4p_pac_nuevo/qa4p_d09.pdf', 'qa.pdf', 'application/pdf') RETURNING id INTO v_id;
  EXCEPTION WHEN insufficient_privilege THEN r := 'rls'; END;
  EXECUTE 'RESET ROLE';
  UPDATE public.cardiolink_user_roles SET active = true WHERE user_id = v_uid;
  IF r <> 'rls' THEN RAISE EXCEPTION 'FALLA d09: médico INACTIVO queda bloqueado (esperado rls, obtuvo %)', r; END IF;
  INSERT INTO t_res VALUES ('d09 médico INACTIVO queda bloqueado');
END $t$;

DO $t$
DECLARE v_uid uuid; v_own uuid; r text := 'ok'; v_prof text; v_id uuid;
BEGIN
  SELECT uid INTO v_uid FROM t_act WHERE clave = 'nadie'; SELECT uid INTO v_own FROM t_act WHERE clave = 'nadie';
  v_prof := (SELECT prof FROM t_act WHERE clave='med1');
  INSERT INTO storage.objects(bucket_id, name, owner) VALUES ('patient-documents', 'documents/qa4p_pac_nuevo/qa4p_d10.pdf', v_own);
  
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, professional_id, storage_path, original_filename, mime_type)
    VALUES ('qa4p_pac_nuevo', 'Certificado', 'QA p4 d10', v_prof, 'documents/qa4p_pac_nuevo/qa4p_d10.pdf', 'qa.pdf', 'application/pdf') RETURNING id INTO v_id;
  EXCEPTION WHEN insufficient_privilege THEN r := 'rls'; END;
  EXECUTE 'RESET ROLE';
  
  IF r <> 'rls' THEN RAISE EXCEPTION 'FALLA d10: usuario sin rol queda bloqueado (esperado rls, obtuvo %)', r; END IF;
  INSERT INTO t_res VALUES ('d10 usuario sin rol queda bloqueado');
END $t$;

DO $t$
DECLARE v_uid uuid; v_own uuid; r text := 'ok'; v_prof text; v_id uuid;
BEGIN
  SELECT uid INTO v_uid FROM t_act WHERE clave = 'own'; SELECT uid INTO v_own FROM t_act WHERE clave = 'own';
  v_prof := NULL;
  INSERT INTO storage.objects(bucket_id, name, owner) VALUES ('patient-documents', 'documents/qa4p_pac_nuevo/qa4p_d11.pdf', v_own);
  
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, professional_id, storage_path, original_filename, mime_type)
    VALUES ('qa4p_pac_nuevo', 'Certificado', 'QA p4 d11', v_prof, 'documents/qa4p_pac_nuevo/qa4p_d11.pdf', 'qa.pdf', 'application/pdf') RETURNING id INTO v_id;
  EXCEPTION WHEN insufficient_privilege THEN r := 'rls'; END;
  EXECUTE 'RESET ROLE';
  
  IF r = 'ok' AND v_id IS NULL THEN RAISE EXCEPTION 'FALLA: el INSERT ... RETURNING no devolvió la fila (política SELECT)'; END IF;
  IF r <> 'ok' THEN RAISE EXCEPTION 'FALLA d11: Dueño sigue emitiendo (esperado ok, obtuvo %)', r; END IF;
  INSERT INTO t_res VALUES ('d11 Dueño sigue emitiendo');
END $t$;

-- el Dueño pasa TEMPORALMENTE a médico 'qa4p_med2' (se revierte con la transacción) para probar a un segundo médico sin vínculos
UPDATE public.cardiolink_user_roles SET base_role = 'medico', professional_id = 'qa4p_med2' WHERE user_id = (SELECT uid FROM t_act WHERE clave = 'own');

DO $t$
DECLARE v_uid uuid; v_own uuid; r text := 'ok'; v_prof text; v_id uuid;
BEGIN
  SELECT uid INTO v_uid FROM t_act WHERE clave = 'med2'; SELECT uid INTO v_own FROM t_act WHERE clave = 'med2';
  v_prof := (SELECT prof FROM t_act WHERE clave='med2');
  INSERT INTO storage.objects(bucket_id, name, owner) VALUES ('patient-documents', 'documents/qa4p_pac_nuevo/qa4p_d12.pdf', v_own);
  
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, professional_id, storage_path, original_filename, mime_type)
    VALUES ('qa4p_pac_nuevo', 'Orden', 'QA p4 d12', v_prof, 'documents/qa4p_pac_nuevo/qa4p_d12.pdf', 'qa.pdf', 'application/pdf') RETURNING id INTO v_id;
  EXCEPTION WHEN insufficient_privilege THEN r := 'rls'; END;
  EXECUTE 'RESET ROLE';
  
  IF r = 'ok' AND v_id IS NULL THEN RAISE EXCEPTION 'FALLA: el INSERT ... RETURNING no devolvió la fila (política SELECT)'; END IF;
  IF r <> 'ok' THEN RAISE EXCEPTION 'FALLA d12: Matías (médico 2) emite SU documento al MISMO paciente (esperado ok, obtuvo %)', r; END IF;
  INSERT INTO t_res VALUES ('d12 Matías (médico 2) emite SU documento al MISMO paciente');
END $t$;

DO $t$
DECLARE v_uid uuid; v_own uuid; r text := 'ok'; v_prof text; v_id uuid;
BEGIN
  SELECT uid INTO v_uid FROM t_act WHERE clave = 'med2'; SELECT uid INTO v_own FROM t_act WHERE clave = 'med2';
  v_prof := (SELECT prof FROM t_act WHERE clave='med1');
  INSERT INTO storage.objects(bucket_id, name, owner) VALUES ('patient-documents', 'documents/qa4p_pac_nuevo/qa4p_d13.pdf', v_own);
  
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, professional_id, storage_path, original_filename, mime_type)
    VALUES ('qa4p_pac_nuevo', 'Orden', 'QA p4 d13', v_prof, 'documents/qa4p_pac_nuevo/qa4p_d13.pdf', 'qa.pdf', 'application/pdf') RETURNING id INTO v_id;
  EXCEPTION WHEN insufficient_privilege THEN r := 'rls'; END;
  EXECUTE 'RESET ROLE';
  
  IF r <> 'rls' THEN RAISE EXCEPTION 'FALLA d13: médico 2 NO emite a nombre del médico 1 (esperado rls, obtuvo %)', r; END IF;
  INSERT INTO t_res VALUES ('d13 médico 2 NO emite a nombre del médico 1');
END $t$;

-- aislamiento entre médicos: nadie ve, edita ni borra documentos del otro
DO $t$
DECLARE u1 uuid; u2 uuid; us uuid; n1 int; n2 int; nu int; nd int; ns1 int; ns2 int;
BEGIN
  SELECT uid INTO u1 FROM t_act WHERE clave='med1'; SELECT uid INTO u2 FROM t_act WHERE clave='med2'; SELECT uid INTO us FROM t_act WHERE clave='sec';
  -- médico 2
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO n2 FROM public.cardiolink_patient_documents WHERE patient_id='qa4p_pac_nuevo' AND professional_id='qa4p_med2';
  SELECT count(*) INTO n1 FROM public.cardiolink_patient_documents WHERE patient_id='qa4p_pac_nuevo' AND professional_id=(SELECT prof FROM t_act WHERE clave='med1');
  UPDATE public.cardiolink_patient_documents SET title='QA hack' WHERE patient_id='qa4p_pac_nuevo' AND professional_id=(SELECT prof FROM t_act WHERE clave='med1'); GET DIAGNOSTICS nu = ROW_COUNT;
  DELETE FROM public.cardiolink_patient_documents WHERE patient_id='qa4p_pac_nuevo' AND professional_id=(SELECT prof FROM t_act WHERE clave='med1'); GET DIAGNOSTICS nd = ROW_COUNT;
  EXECUTE 'RESET ROLE';
  IF n2 <> 1 OR n1 <> 0 OR nu <> 0 OR nd <> 0 THEN RAISE EXCEPTION 'FALLA A1: médico 2 ve propios=% ajenos=% edita=% borra=% (esperado 1/0/0/0)', n2, n1, nu, nd; END IF;
  -- médico 1 no ve el de médico 2
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO n2 FROM public.cardiolink_patient_documents WHERE patient_id='qa4p_pac_nuevo' AND professional_id='qa4p_med2';
  SELECT count(*) INTO n1 FROM public.cardiolink_patient_documents WHERE patient_id='qa4p_pac_nuevo' AND professional_id=(SELECT prof FROM t_act WHERE clave='med1');
  EXECUTE 'RESET ROLE';
  IF n2 <> 0 OR n1 < 1 THEN RAISE EXCEPTION 'FALLA A2: médico 1 ve ajenos=% propios=%', n2, n1; END IF;
  -- Secretaría: ve el documento del profesional autorizado, no el del no autorizado
  PERFORM set_config('request.jwt.claims', json_build_object('sub', us, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO ns1 FROM public.cardiolink_patient_documents WHERE patient_id='qa4p_pac_nuevo' AND professional_id=(SELECT prof FROM t_act WHERE clave='med1');
  SELECT count(*) INTO ns2 FROM public.cardiolink_patient_documents WHERE patient_id='qa4p_pac_nuevo' AND professional_id='qa4p_med2';
  EXECUTE 'RESET ROLE';
  IF ns1 < 1 OR ns2 <> 0 THEN RAISE EXCEPTION 'FALLA A3: Secretaría ve autorizado=% no autorizado=% (esperado >=1 / 0)', ns1, ns2; END IF;
  INSERT INTO t_res VALUES ('A1-A3 aislamiento: nadie ve/edita/borra documentos del otro médico; Secretaría conserva su asociación');
END $t$;

-- ===== HC (sólo si p3 está aplicada: STAGING) =====
DO $t$
DECLARE u1 uuid; u2 uuid; us uuid; p1 text; hay boolean; sql1 text; sql2 text; sqlr text; sqlx text; e1 text; e2 text; r text; nu int; nd int; n int;
BEGIN
  SELECT hay_p3 INTO hay FROM t_flags; IF NOT hay THEN INSERT INTO t_res VALUES ('H* omitidas: p3 no está aplicada en esta base'); RETURN; END IF;
  SELECT uid, prof INTO u1, p1 FROM t_act WHERE clave='med1'; SELECT uid INTO u2 FROM t_act WHERE clave='med2'; SELECT uid INTO us FROM t_act WHERE clave='sec';
  sql1 := pg_temp.arma_insert('cardiolink_hc_evoluciones', jsonb_build_object('paciente_id','qa4p_pac_nuevo','profesional_id', p1)) || ' RETURNING id::text';
  sqlx := pg_temp.arma_insert('cardiolink_hc_evoluciones', jsonb_build_object('paciente_id','qa4p_pac_nuevo','profesional_id', 'qa4p_med2')) || ' RETURNING id::text';
  sql2 := pg_temp.arma_insert('cardiolink_hc_evoluciones', jsonb_build_object('paciente_id','qa4p_pac_nuevo','profesional_id', 'qa4p_med2')) || ' RETURNING id::text';
  sqlr := pg_temp.arma_insert('cardiolink_hc_resumen', jsonb_build_object('paciente_id','qa4p_pac_nuevo'));
  -- H1: médico 1 crea su PRIMERA evolución (con RETURNING) en un paciente que nunca atendió
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  EXECUTE sql1 INTO e1;
  -- H2: no puede crear evoluciones con el profesional_id de otro
  BEGIN EXECUTE sqlx INTO r; RAISE EXCEPTION 'FALLA H2: el médico 1 insertó con el profesional_id de otro'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  -- H6: resumen compartido (D1): crea y lee
  EXECUTE sqlr;
  SELECT count(*) INTO n FROM public.cardiolink_hc_resumen WHERE paciente_id='qa4p_pac_nuevo';
  EXECUTE 'RESET ROLE';
  IF e1 IS NULL THEN RAISE EXCEPTION 'FALLA H1: no se obtuvo el id de la evolución'; END IF;
  IF n <> 1 THEN RAISE EXCEPTION 'FALLA H6: el médico no lee el resumen que creó (%)', n; END IF;
  -- H3: médico 2 crea la suya sobre el mismo paciente
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  EXECUTE sql2 INTO e2;
  SELECT count(*) INTO n FROM public.cardiolink_hc_resumen WHERE paciente_id='qa4p_pac_nuevo';
  -- H4: no puede editar ni borrar la del otro
  UPDATE public.cardiolink_hc_evoluciones SET profesional_id = profesional_id WHERE id::text = e1; GET DIAGNOSTICS nu = ROW_COUNT;
  DELETE FROM public.cardiolink_hc_evoluciones WHERE id::text = e1; GET DIAGNOSTICS nd = ROW_COUNT;
  EXECUTE 'RESET ROLE';
  IF e2 IS NULL THEN RAISE EXCEPTION 'FALLA H3: médico 2 no pudo crear su evolución'; END IF;
  IF n <> 1 THEN RAISE EXCEPTION 'FALLA H6b: médico 2 no lee el resumen compartido (%)', n; END IF;
  IF nu <> 0 OR nd <> 0 THEN RAISE EXCEPTION 'FALLA H4: médico 2 editó=% borró=% la evolución del médico 1', nu, nd; END IF;
  -- H4b: el médico 1 tampoco sobre la de 2; y cada uno SÍ edita la propia
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  UPDATE public.cardiolink_hc_evoluciones SET profesional_id = profesional_id WHERE id::text = e2; GET DIAGNOSTICS nu = ROW_COUNT;
  DELETE FROM public.cardiolink_hc_evoluciones WHERE id::text = e2; GET DIAGNOSTICS nd = ROW_COUNT;
  UPDATE public.cardiolink_hc_evoluciones SET profesional_id = profesional_id WHERE id::text = e1; GET DIAGNOSTICS n = ROW_COUNT;
  EXECUTE 'RESET ROLE';
  IF nu <> 0 OR nd <> 0 OR n <> 1 THEN RAISE EXCEPTION 'FALLA H4b: médico 1 sobre la de 2 editó=% borró=%; sobre la propia=% (esperado 0/0/1)', nu, nd, n; END IF;
  -- H7: Secretaría sin acceso a HC (lectura y escritura)
  PERFORM set_config('request.jwt.claims', json_build_object('sub', us, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO n FROM public.cardiolink_hc_evoluciones WHERE paciente_id='qa4p_pac_nuevo';
  nu := n; SELECT count(*) INTO n FROM public.cardiolink_hc_resumen WHERE paciente_id='qa4p_pac_nuevo';
  BEGIN EXECUTE sql1 INTO r; RAISE EXCEPTION 'FALLA H7: Secretaría insertó una evolución'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  EXECUTE 'RESET ROLE';
  IF nu <> 0 OR n <> 0 THEN RAISE EXCEPTION 'FALLA H7: Secretaría ve evoluciones=% resumen=%', nu, n; END IF;
  -- H8: sin rol no inserta
  PERFORM set_config('request.jwt.claims', json_build_object('sub', (SELECT uid FROM t_act WHERE clave='nadie'), 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN EXECUTE sql1 INTO r; RAISE EXCEPTION 'FALLA H8: un usuario sin rol insertó una evolución'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  EXECUTE 'RESET ROLE';
  INSERT INTO t_res VALUES ('H1-H8 HC: primera evolución sin vínculo, autoría (insertar/editar/borrar), resumen compartido, Secretaría y sin rol bloqueados');
END $t$;
