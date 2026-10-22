-- CardioLink · PRUEBAS SQL del historial documental seguro (STAGING). NO ejecutar en Production.
-- BORRADOR SIN EJECUTAR. Ejecutar con la PARTE 1 aplicada (y, para las pruebas 12-14, también la PARTE 2). Si la PARTE 2 no está aplicada,
-- esas pruebas se informan como PENDIENTE (no como falla) y la prueba 12 mide cuánto expone hoy la lectura directa.
-- Todo corre dentro de UNA transacción que termina en ROLLBACK: no deja filas. Usa las cuentas REALES de STAGING (owner, médico vinculado a un
-- profesional, secretaría, y un segundo médico si existe) con claims JWT simulados y rol `authenticated`; no crea cuentas.
-- Las filas de prueba usan patient_id '__qa_hist' y ids fijos. Resultado: tabla temporal _res al final (OK / FALLA / PENDIENTE / OMITIDA).

BEGIN;

CREATE TEMP TABLE _res(n serial, prueba text, resultado text) ON COMMIT DROP;
GRANT ALL ON _res TO authenticated, anon;
GRANT ALL ON SEQUENCE _res_n_seq TO authenticated, anon;

-- Fixtures (como postgres: auth.uid() nulo => el trigger de emisor no interviene y se fijan uploaded_by/professional_id)
DO $$
DECLARE v_owner uuid; v_med uuid; v_prof text; v_sec uuid; v_med2 uuid;
BEGIN
  SELECT user_id INTO v_owner FROM public.cardiolink_user_roles WHERE base_role='owner' AND active LIMIT 1;
  SELECT user_id, professional_id INTO v_med, v_prof FROM public.cardiolink_user_roles WHERE base_role='medico' AND active AND professional_id IS NOT NULL LIMIT 1;
  SELECT user_id INTO v_sec FROM public.cardiolink_user_roles WHERE base_role='secretaria' AND active LIMIT 1;
  SELECT user_id INTO v_med2 FROM public.cardiolink_user_roles WHERE base_role='medico' AND active AND user_id <> v_med LIMIT 1;
  PERFORM set_config('qa.owner', coalesce(v_owner::text,''), true); PERFORM set_config('qa.med', coalesce(v_med::text,''), true);
  PERFORM set_config('qa.prof', coalesce(v_prof,''), true);        PERFORM set_config('qa.sec', coalesce(v_sec::text,''), true);
  PERFORM set_config('qa.med2', coalesce(v_med2::text,''), true);
  INSERT INTO _res(prueba,resultado) VALUES ('fixtures','owner='||coalesce(v_owner::text,'-')||' medico='||coalesce(v_med::text,'-')||' prof='||coalesce(v_prof,'-')||' secretaria='||coalesce(v_sec::text,'-')||' medico2='||coalesce(v_med2::text,'-'));
  IF v_owner IS NULL OR v_med IS NULL THEN RAISE EXCEPTION 'faltan cuentas owner/médico vinculadas a un profesional en STAGING'; END IF;

  -- Documentos: h1 propio por professional_id; h2 de OTRO profesional (subido por owner); h3 sin professional_id subido por el médico;
  --             h4 sin professional_id subido por owner; h5 de OTRO profesional pero subido por el médico (la subida NO alcanza)
  INSERT INTO public.cardiolink_patient_documents(id,patient_id,document_type,title,professional_id,storage_path,original_filename,mime_type,uploaded_by) VALUES
    ('00000000-0000-4000-8000-0000000000b1','__qa_hist','Orden','QA hist propio por professional_id', v_prof,'documents/__qa_hist/b1.pdf','b1.pdf','application/pdf', v_owner),
    ('00000000-0000-4000-8000-0000000000b2','__qa_hist','Orden','QA hist de OTRO profesional','__qa_otro_prof','documents/__qa_hist/b2.pdf','b2.pdf','application/pdf', v_owner),
    ('00000000-0000-4000-8000-0000000000b3','__qa_hist','Orden','QA hist sin professional_id, subido por el médico',NULL,'documents/__qa_hist/b3.pdf','b3.pdf','application/pdf', v_med),
    ('00000000-0000-4000-8000-0000000000b4','__qa_hist','Orden','QA hist sin professional_id, subido por owner',NULL,'documents/__qa_hist/b4.pdf','b4.pdf','application/pdf', v_owner),
    ('00000000-0000-4000-8000-0000000000b5','__qa_hist','Orden','QA hist de OTRO profesional subido por el médico','__qa_otro_prof','documents/__qa_hist/b5.pdf','b5.pdf','application/pdf', v_med);

  -- Comunicaciones (como service_role/postgres): un envío por documento, uno huérfano, uno automático, y filas de OTROS tipos que NO deben salir
  INSERT INTO public.cardiolink_communications(id,paciente_id,tipo,canal,destinatario,recipient_name,recipient_source,subject,message,status,sent_at,created_by,document_id) VALUES
    ('00000000-0000-4000-8000-0000000000c1',NULL,'document_delivery','whatsapp','qa-destino-1','QA Uno','patient',NULL,'SECRETO-QA-1','manual_started',now(),v_med,'00000000-0000-4000-8000-0000000000b1'),
    ('00000000-0000-4000-8000-0000000000c2',NULL,'document_delivery','email','qa2@example.invalid','QA Dos','patient','ASUNTO-QA-2','SECRETO-QA-2','sent',now(),v_owner,'00000000-0000-4000-8000-0000000000b2'),
    ('00000000-0000-4000-8000-0000000000c3',NULL,'document_delivery','whatsapp','qa-destino-3','QA Tres','patient',NULL,'SECRETO-QA-3','manual_started',now(),NULL,'00000000-0000-4000-8000-0000000000b3'),
    ('00000000-0000-4000-8000-0000000000c4',NULL,'document_delivery','email','qa4@example.invalid','QA Cuatro','patient','ASUNTO-QA-4','SECRETO-QA-4','failed',NULL,v_owner,'00000000-0000-4000-8000-0000000000b4'),
    ('00000000-0000-4000-8000-0000000000c5',NULL,'document_delivery','whatsapp','qa-destino-5','QA Cinco','patient',NULL,'SECRETO-QA-5','manual_started',now(),v_med,'00000000-0000-4000-8000-0000000000b5'),
    ('00000000-0000-4000-8000-0000000000c6',NULL,'document_delivery','whatsapp','qa-destino-6','QA Seis','patient',NULL,'SECRETO-QA-6','manual_started',now(),v_owner,'00000000-0000-4000-8000-0000000000ff'),
    ('00000000-0000-4000-8000-0000000000c7',NULL,'manual','whatsapp','qa-destino-7','QA Siete','patient',NULL,'SECRETO-QA-7','manual_started',now(),v_med,'00000000-0000-4000-8000-0000000000b1');
  UPDATE public.cardiolink_communications SET error_message='QA fallo simulado' WHERE id='00000000-0000-4000-8000-0000000000c4';
END $$;

SET LOCAL ROLE authenticated;

DO $$
DECLARE
  v_owner text := current_setting('qa.owner'); v_med text := current_setting('qa.med'); v_sec text := current_setting('qa.sec'); v_med2 text := current_setting('qa.med2');
  todos text[] := ARRAY['00000000-0000-4000-8000-0000000000b1','00000000-0000-4000-8000-0000000000b2','00000000-0000-4000-8000-0000000000b3','00000000-0000-4000-8000-0000000000b4','00000000-0000-4000-8000-0000000000b5','00000000-0000-4000-8000-0000000000ff'];
  n int; ids text; v_code text; leer_restringido boolean := to_regprocedure('public.cardiolink_has_communications_read_access()') IS NOT NULL;
BEGIN
  -- ===== MÉDICO =====
  PERFORM set_config('request.jwt.claims', json_build_object('sub',v_med,'role','authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_med, true);

  SELECT string_agg(right(document_id,2), ',' ORDER BY document_id) INTO ids FROM public.cardiolink_historial_envios_documento_v1(todos);
  INSERT INTO _res(prueba,resultado) VALUES ('1 médico: sólo ve envíos de SUS documentos (b1 por professional_id, b3 sin professional_id subido por él)', CASE WHEN ids='b1,b3' THEN 'OK' ELSE 'FALLA (ve: '||coalesce(ids,'nada')||')' END);

  SELECT count(*) INTO n FROM public.cardiolink_historial_envios_documento_v1(ARRAY['00000000-0000-4000-8000-0000000000b2','00000000-0000-4000-8000-0000000000b4','00000000-0000-4000-8000-0000000000b5','00000000-0000-4000-8000-0000000000ff']);
  INSERT INTO _res(prueba,resultado) VALUES ('2 médico pidiendo ids ajenos / sin dueño / huérfano / atribuido a otro aunque lo subió él: 0 filas', CASE WHEN n=0 THEN 'OK' ELSE 'FALLA (filas='||n||')' END);

  SELECT count(*) INTO n FROM public.cardiolink_historial_envios_documento_v1(ARRAY['00000000-0000-4000-8000-0000000000b1']) WHERE canal='whatsapp' AND status='manual_started' AND creado_por_mi AND NOT automatico;
  INSERT INTO _res(prueba,resultado) VALUES ('3 banderas: creado_por_mi verdadero y no automático para su propio envío', CASE WHEN n=1 THEN 'OK' ELSE 'FALLA' END);
  SELECT count(*) INTO n FROM public.cardiolink_historial_envios_documento_v1(ARRAY['00000000-0000-4000-8000-0000000000b3']) WHERE automatico AND NOT creado_por_mi;
  INSERT INTO _res(prueba,resultado) VALUES ('4 banderas: envío sin created_by sale como automático', CASE WHEN n=1 THEN 'OK' ELSE 'FALLA' END);

  SELECT count(*) INTO n FROM public.cardiolink_historial_envios_documento_v1(ARRAY['00000000-0000-4000-8000-0000000000b1']) WHERE id='00000000-0000-4000-8000-0000000000c7';
  INSERT INTO _res(prueba,resultado) VALUES ('5 sólo tipo document_delivery: una fila de otro tipo con el mismo document_id NO sale', CASE WHEN n=0 THEN 'OK' ELSE 'FALLA' END);

  SELECT count(*) INTO n FROM pg_proc p WHERE p.proname='cardiolink_historial_envios_documento_v1' AND pg_get_function_result(p.oid) ~* '\y(message|subject|provider_message_id)\y';
  INSERT INTO _res(prueba,resultado) VALUES ('6 la función no devuelve message, subject ni provider_message_id', CASE WHEN n=0 THEN 'OK' ELSE 'FALLA' END);

  SELECT count(*) INTO n FROM public.cardiolink_historial_envios_documento_v1(NULL);
  INSERT INTO _res(prueba,resultado) VALUES ('7a ids nulos: vacío', CASE WHEN n=0 THEN 'OK' ELSE 'FALLA' END);
  SELECT count(*) INTO n FROM public.cardiolink_historial_envios_documento_v1(ARRAY[]::text[]);
  INSERT INTO _res(prueba,resultado) VALUES ('7b lista vacía: vacío', CASE WHEN n=0 THEN 'OK' ELSE 'FALLA' END);
  SELECT count(*) INTO n FROM public.cardiolink_historial_envios_documento_v1((SELECT array_agg('00000000-0000-4000-8000-0000000000b1'::text) FROM generate_series(1,501)));
  INSERT INTO _res(prueba,resultado) VALUES ('7c más de 500 ids: vacío (tope)', CASE WHEN n=0 THEN 'OK' ELSE 'FALLA' END);

  BEGIN INSERT INTO public.cardiolink_communications(tipo,canal,destinatario,message,status,sent_at) VALUES ('manual','whatsapp','x','y','manual_started',now());
    INSERT INTO _res(prueba,resultado) VALUES ('8 médico NO puede insertar en communications', 'FALLA (insertó)');
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE;
    INSERT INTO _res(prueba,resultado) VALUES ('8 médico NO puede insertar en communications', CASE WHEN v_code IN ('42501') THEN 'OK' ELSE 'FALLA ('||v_code||')' END); END;

  -- Lectura directa de la tabla por el médico: tras la PARTE 2 debe ser 0
  SELECT count(*) INTO n FROM public.cardiolink_communications WHERE paciente_id IS NULL AND id::text LIKE '00000000-0000-4000-8000-0000000000c%';
  IF leer_restringido THEN
    INSERT INTO _res(prueba,resultado) VALUES ('12 [PARTE 2] médico: lectura directa de communications = 0 filas', CASE WHEN n=0 THEN 'OK' ELSE 'FALLA (lee '||n||')' END);
  ELSE
    INSERT INTO _res(prueba,resultado) VALUES ('12 [PARTE 2 sin aplicar] médico: lectura directa HOY expone filas', 'PENDIENTE: lee '||n||' de 7 filas de prueba (incluye message)');
  END IF;

  -- ===== SEGUNDO MÉDICO (si existe): no ve lo del primero =====
  IF v_med2 <> '' THEN
    PERFORM set_config('request.jwt.claims', json_build_object('sub',v_med2,'role','authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_med2, true);
    SELECT count(*) INTO n FROM public.cardiolink_historial_envios_documento_v1(todos) WHERE document_id IN ('00000000-0000-4000-8000-0000000000b1','00000000-0000-4000-8000-0000000000b3');
    INSERT INTO _res(prueba,resultado) VALUES ('9 segundo médico: no ve los envíos del primero (por professional_id ni por uploaded_by)', CASE WHEN n=0 THEN 'OK' ELSE 'FALLA (ve '||n||')' END);
  ELSE
    INSERT INTO _res(prueba,resultado) VALUES ('9 segundo médico', 'OMITIDA: no hay un segundo médico activo');
  END IF;

  -- ===== OWNER =====
  PERFORM set_config('request.jwt.claims', json_build_object('sub',v_owner,'role','authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_owner, true);
  SELECT count(*) INTO n FROM public.cardiolink_historial_envios_documento_v1(todos);
  INSERT INTO _res(prueba,resultado) VALUES ('10 owner: ve todos los envíos pedidos (6, incluido el de un documento ya eliminado)', CASE WHEN n=6 THEN 'OK' ELSE 'FALLA (ve '||n||')' END);
  SELECT count(*) INTO n FROM public.cardiolink_communications WHERE id::text LIKE '00000000-0000-4000-8000-0000000000c%';
  INSERT INTO _res(prueba,resultado) VALUES ('10b owner: sigue leyendo la tabla directa (7 filas de prueba)', CASE WHEN n=7 THEN 'OK' ELSE 'FALLA (lee '||n||')' END);

  -- ===== SECRETARÍA =====
  IF v_sec <> '' THEN
    PERFORM set_config('request.jwt.claims', json_build_object('sub',v_sec,'role','authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_sec, true);
    SELECT count(*) INTO n FROM public.cardiolink_historial_envios_documento_v1(todos);
    INSERT INTO _res(prueba,resultado) VALUES ('11 secretaría: ve todos los envíos pedidos (acceso operativo)', CASE WHEN n=6 THEN 'OK' ELSE 'FALLA (ve '||n||')' END);
    SELECT count(*) INTO n FROM public.cardiolink_communications WHERE id::text LIKE '00000000-0000-4000-8000-0000000000c%';
    INSERT INTO _res(prueba,resultado) VALUES ('11b secretaría: sigue leyendo la tabla directa (acceso operativo intacto)', CASE WHEN n=7 THEN 'OK' ELSE 'FALLA (lee '||n||')' END);
  ELSE
    INSERT INTO _res(prueba,resultado) VALUES ('11 secretaría', 'OMITIDA: no hay una secretaría activa');
  END IF;

  -- ===== CUENTA SIN ROL / INACTIVA =====
  PERFORM set_config('request.jwt.claims', json_build_object('sub','11111111-1111-4111-8111-111111111111','role','authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
  SELECT count(*) INTO n FROM public.cardiolink_historial_envios_documento_v1(todos);
  INSERT INTO _res(prueba,resultado) VALUES ('13 usuario autenticado sin rol activo: 0 filas', CASE WHEN n=0 THEN 'OK' ELSE 'FALLA (ve '||n||')' END);
  SELECT count(*) INTO n FROM public.cardiolink_communications WHERE id::text LIKE '00000000-0000-4000-8000-0000000000c%';
  INSERT INTO _res(prueba,resultado) VALUES ('13b usuario autenticado sin rol activo: lectura directa 0 filas', CASE WHEN n=0 THEN 'OK' ELSE 'FALLA (lee '||n||')' END);
END $$;

-- ===== ANON: sin permiso de ejecución =====
RESET ROLE;
SET LOCAL ROLE anon;
DO $$
DECLARE v_code text;
BEGIN
  BEGIN PERFORM * FROM public.cardiolink_historial_envios_documento_v1(ARRAY['00000000-0000-4000-8000-0000000000b1']);
    INSERT INTO _res(prueba,resultado) VALUES ('14 anon NO puede ejecutar la función', 'FALLA (ejecutó)');
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE;
    INSERT INTO _res(prueba,resultado) VALUES ('14 anon NO puede ejecutar la función', CASE WHEN v_code='42501' THEN 'OK' ELSE 'FALLA ('||v_code||')' END); END;
END $$;

RESET ROLE;
SELECT n, prueba, resultado FROM _res ORDER BY n;

ROLLBACK;
