-- CardioLink · PRUEBAS SQL de la eliminación por emisor (STAGING, con la migración YA aplicada). NO ejecutar en Production.
-- BORRADOR SIN EJECUTAR: validar sintaxis y nombres en STAGING antes de confiar en el resultado.
-- Todo corre dentro de UNA transacción que termina en ROLLBACK: no deja filas ni objetos. Usa las cuentas REALES de STAGING (owner,
-- médico, secretaría) con claims JWT simulados y rol `authenticated`; no crea cuentas. Las filas de prueba usan patient_id '__qa_delown'.
-- Si falta una cuenta activa (p. ej. no hay secretaría) esa prueba se informa como OMITIDA. Resultado: tabla temporal _res al final.

BEGIN;

CREATE TEMP TABLE _res(n serial, prueba text, resultado text) ON COMMIT DROP;
GRANT ALL ON _res TO authenticated;
GRANT ALL ON SEQUENCE _res_n_seq TO authenticated;

-- Fixtures (como postgres: auth.uid() nulo => el trigger no interviene y se pueden fijar uploaded_by/professional_id)
DO $$
DECLARE v_owner uuid; v_med uuid; v_prof text; v_sec uuid;
BEGIN
  SELECT user_id INTO v_owner FROM public.cardiolink_user_roles WHERE base_role='owner' AND active LIMIT 1;
  SELECT user_id, professional_id INTO v_med, v_prof FROM public.cardiolink_user_roles WHERE base_role='medico' AND active AND professional_id IS NOT NULL LIMIT 1;
  SELECT user_id INTO v_sec FROM public.cardiolink_user_roles WHERE base_role='secretaria' AND active LIMIT 1;
  PERFORM set_config('qa.owner', coalesce(v_owner::text,''), true); PERFORM set_config('qa.med', coalesce(v_med::text,''), true);
  PERFORM set_config('qa.prof', coalesce(v_prof,''), true);        PERFORM set_config('qa.sec', coalesce(v_sec::text,''), true);
  INSERT INTO _res(prueba,resultado) VALUES ('fixtures','owner='||coalesce(v_owner::text,'-')||' medico='||coalesce(v_med::text,'-')||' prof='||coalesce(v_prof,'-')||' secretaria='||coalesce(v_sec::text,'-'));
  IF v_owner IS NULL OR v_med IS NULL THEN RAISE EXCEPTION 'faltan cuentas owner/médico vinculadas a un profesional en STAGING'; END IF;
  INSERT INTO public.cardiolink_patient_documents(id,patient_id,document_type,title,professional_id,storage_path,original_filename,mime_type,uploaded_by) VALUES
    ('00000000-0000-4000-8000-0000000000a1','__qa_delown','Receta','QA propia por professional_id', v_prof,'documents/__qa_delown/a1.pdf','a1.pdf','application/pdf', NULL),
    ('00000000-0000-4000-8000-0000000000a2','__qa_delown','Receta','QA subida por el médico pero ATRIBUIDA a otro profesional','__qa_otro_prof','documents/__qa_delown/a2.pdf','a2.pdf','application/pdf', v_med),
    ('00000000-0000-4000-8000-0000000000a3','__qa_delown','Receta','QA AJENA (otro profesional, subida por owner)','__qa_otro_prof','documents/__qa_delown/a3.pdf','a3.pdf','application/pdf', v_owner),
    ('00000000-0000-4000-8000-0000000000a4','__qa_delown','Receta','QA sin dueño legible',NULL,'documents/__qa_delown/a4.pdf','a4.pdf','application/pdf', NULL),
    ('00000000-0000-4000-8000-0000000000a5','__qa_delown','Receta','QA propia para probar el cambio de emisor', v_prof,'documents/__qa_delown/a5.pdf','a5.pdf','application/pdf', v_med),
    ('00000000-0000-4000-8000-0000000000a7','__qa_delown','Receta','QA sin professional_id, subida por el médico',NULL,'documents/__qa_delown/a7.pdf','a7.pdf','application/pdf', v_med),
    ('00000000-0000-4000-8000-0000000000a8','__qa_delown','Receta','QA sin professional_id, subida por OTRO usuario',NULL,'documents/__qa_delown/a8.pdf','a8.pdf','application/pdf', v_owner);
  BEGIN
    INSERT INTO storage.objects(bucket_id,name,owner) VALUES
      ('patient-documents','documents/__qa_delown/a3.pdf', v_owner),
      ('patient-documents','documents/__qa_delown/a2.pdf', v_med),
      ('patient-documents','documents/__qa_delown/a7.pdf', v_med),
      ('patient-documents','documents/__qa_delown/huerfano_owner.pdf', v_owner),
      ('patient-documents','documents/__qa_delown/huerfano_med.pdf', v_med);
    PERFORM set_config('qa.storage','ok',true);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('qa.storage','no',true);
    INSERT INTO _res(prueba,resultado) VALUES ('storage fixtures','OMITIDAS ('||SQLERRM||'): las pruebas de Storage se omiten');
  END;
END $$;

SET LOCAL ROLE authenticated;

DO $$
DECLARE
  v_owner text := current_setting('qa.owner'); v_med text := current_setting('qa.med'); v_prof text := current_setting('qa.prof'); v_sec text := current_setting('qa.sec');
  n int; v_msg text; v_code text; v_up uuid;
BEGIN
  -- ===== MÉDICO =====
  PERFORM set_config('request.jwt.claims', json_build_object('sub',v_med,'role','authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_med, true);

  DELETE FROM public.cardiolink_patient_documents WHERE id='00000000-0000-4000-8000-0000000000a1'; GET DIAGNOSTICS n = ROW_COUNT;
  INSERT INTO _res(prueba,resultado) VALUES ('1 médico borra una fila con SU professional_id', CASE WHEN n=1 THEN 'OK' ELSE 'FALLA (borradas='||n||')' END);
  DELETE FROM public.cardiolink_patient_documents WHERE id='00000000-0000-4000-8000-0000000000a2'; GET DIAGNOSTICS n = ROW_COUNT;
  INSERT INTO _res(prueba,resultado) VALUES ('2 médico que SUBIÓ un documento atribuido a OTRO profesional: DELETE DENEGADO', CASE WHEN n=0 THEN 'OK' ELSE 'FALLA (borradas='||n||')' END);
  DELETE FROM public.cardiolink_patient_documents WHERE id='00000000-0000-4000-8000-0000000000a7'; GET DIAGNOSTICS n = ROW_COUNT;
  INSERT INTO _res(prueba,resultado) VALUES ('2b professional_id NULL y subido por el médico (uploaded_by confirmado): SÍ puede borrar', CASE WHEN n=1 THEN 'OK' ELSE 'FALLA (borradas='||n||')' END);
  DELETE FROM public.cardiolink_patient_documents WHERE id='00000000-0000-4000-8000-0000000000a8'; GET DIAGNOSTICS n = ROW_COUNT;
  INSERT INTO _res(prueba,resultado) VALUES ('2c professional_id NULL y subido por OTRO usuario: DELETE DENEGADO', CASE WHEN n=0 THEN 'OK' ELSE 'FALLA (borradas='||n||')' END);
  DELETE FROM public.cardiolink_patient_documents WHERE id='00000000-0000-4000-8000-0000000000a3'; GET DIAGNOSTICS n = ROW_COUNT;
  INSERT INTO _res(prueba,resultado) VALUES ('3 médico NO puede borrar la fila de OTRO profesional', CASE WHEN n=0 THEN 'OK' ELSE 'FALLA (borradas='||n||')' END);
  DELETE FROM public.cardiolink_patient_documents WHERE id='00000000-0000-4000-8000-0000000000a4'; GET DIAGNOSTICS n = ROW_COUNT;
  INSERT INTO _res(prueba,resultado) VALUES ('4 médico NO puede borrar una fila sin dueño legible (sólo owner/admin)', CASE WHEN n=0 THEN 'OK' ELSE 'FALLA (borradas='||n||')' END);

  -- cambio de emisor/creador: bloqueado (sobre la fila ajena y sobre la propia)
  BEGIN UPDATE public.cardiolink_patient_documents SET professional_id=v_prof WHERE id='00000000-0000-4000-8000-0000000000a3'; v_msg:='SIN ERROR'; v_code:='';
  EXCEPTION WHEN OTHERS THEN v_msg:=SQLERRM; v_code:=SQLSTATE; END;
  INSERT INTO _res(prueba,resultado) VALUES ('5 médico NO puede ponerse como emisor de una fila ajena', CASE WHEN v_code='42501' THEN 'OK' ELSE 'FALLA '||v_msg END);
  BEGIN UPDATE public.cardiolink_patient_documents SET uploaded_by=v_med::uuid WHERE id='00000000-0000-4000-8000-0000000000a3'; v_msg:='SIN ERROR'; v_code:='';
  EXCEPTION WHEN OTHERS THEN v_msg:=SQLERRM; v_code:=SQLSTATE; END;
  INSERT INTO _res(prueba,resultado) VALUES ('6 médico NO puede ponerse como creador de una fila ajena', CASE WHEN v_code='42501' THEN 'OK' ELSE 'FALLA '||v_msg END);
  BEGIN UPDATE public.cardiolink_patient_documents SET professional_id='__qa_otro_prof' WHERE id='00000000-0000-4000-8000-0000000000a5'; v_msg:='SIN ERROR'; v_code:='';
  EXCEPTION WHEN OTHERS THEN v_msg:=SQLERRM; v_code:=SQLSTATE; END;
  INSERT INTO _res(prueba,resultado) VALUES ('7 médico NO puede reasignar ni su propia fila a otro profesional', CASE WHEN v_code='42501' THEN 'OK' ELSE 'FALLA '||v_msg END);

  -- uploaded_by no se confía en el navegador
  INSERT INTO public.cardiolink_patient_documents(id,patient_id,document_type,title,professional_id,storage_path,original_filename,mime_type,uploaded_by)
  VALUES ('00000000-0000-4000-8000-0000000000a6','__qa_delown','Receta','QA uploaded_by falsificado',v_prof,'documents/__qa_delown/a6.pdf','a6.pdf','application/pdf', v_owner::uuid);
  SELECT uploaded_by INTO v_up FROM public.cardiolink_patient_documents WHERE id='00000000-0000-4000-8000-0000000000a6';
  INSERT INTO _res(prueba,resultado) VALUES ('8 INSERT con uploaded_by falsificado: el servidor lo fija en el usuario real', CASE WHEN v_up=v_med::uuid THEN 'OK' ELSE 'FALLA (uploaded_by='||coalesce(v_up::text,'null')||')' END);

  -- Storage
  IF current_setting('qa.storage')='ok' THEN
    DELETE FROM storage.objects WHERE bucket_id='patient-documents' AND name='documents/__qa_delown/a3.pdf'; GET DIAGNOSTICS n = ROW_COUNT;
    INSERT INTO _res(prueba,resultado) VALUES ('9 médico NO puede borrar el PDF de una fila de OTRO profesional', CASE WHEN n=0 THEN 'OK' ELSE 'FALLA (borrados='||n||')' END);
    DELETE FROM storage.objects WHERE bucket_id='patient-documents' AND name='documents/__qa_delown/huerfano_owner.pdf'; GET DIAGNOSTICS n = ROW_COUNT;
    INSERT INTO _res(prueba,resultado) VALUES ('10 médico NO puede borrar un objeto huérfano subido por otro usuario', CASE WHEN n=0 THEN 'OK' ELSE 'FALLA (borrados='||n||')' END);
    DELETE FROM storage.objects WHERE bucket_id='patient-documents' AND name='documents/__qa_delown/a2.pdf'; GET DIAGNOSTICS n = ROW_COUNT;
    INSERT INTO _res(prueba,resultado) VALUES ('11 médico NO puede borrar el PDF que subió él si la fila está atribuida a OTRO profesional', CASE WHEN n=0 THEN 'OK' ELSE 'FALLA (borrados='||n||')' END);
    DELETE FROM storage.objects WHERE bucket_id='patient-documents' AND name='documents/__qa_delown/a7.pdf'; GET DIAGNOSTICS n = ROW_COUNT;
    INSERT INTO _res(prueba,resultado) VALUES ('11b médico SÍ puede borrar el PDF de una fila sin professional_id subida por él', CASE WHEN n=1 THEN 'OK' ELSE 'FALLA (borrados='||n||')' END);
    DELETE FROM storage.objects WHERE bucket_id='patient-documents' AND name='documents/__qa_delown/huerfano_med.pdf'; GET DIAGNOSTICS n = ROW_COUNT;
    INSERT INTO _res(prueba,resultado) VALUES ('11c médico SÍ puede borrar un objeto huérfano que subió él', CASE WHEN n=1 THEN 'OK' ELSE 'FALLA (borrados='||n||')' END);
  END IF;

  -- ===== SECRETARÍA =====
  IF v_sec<>'' THEN
    PERFORM set_config('request.jwt.claims', json_build_object('sub',v_sec,'role','authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_sec, true);
    DELETE FROM public.cardiolink_patient_documents WHERE id='00000000-0000-4000-8000-0000000000a5'; GET DIAGNOSTICS n = ROW_COUNT;
    INSERT INTO _res(prueba,resultado) VALUES ('12 secretaría NO puede borrar (como antes)', CASE WHEN n=0 THEN 'OK' ELSE 'FALLA (borradas='||n||')' END);
  ELSE INSERT INTO _res(prueba,resultado) VALUES ('12 secretaría','OMITIDA (no hay secretaría activa)'); END IF;

  -- ===== OWNER =====
  PERFORM set_config('request.jwt.claims', json_build_object('sub',v_owner,'role','authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_owner, true);
  DELETE FROM public.cardiolink_patient_documents WHERE id='00000000-0000-4000-8000-0000000000a3'; GET DIAGNOSTICS n = ROW_COUNT;
  INSERT INTO _res(prueba,resultado) VALUES ('13 owner borra la fila de cualquier profesional', CASE WHEN n=1 THEN 'OK' ELSE 'FALLA (borradas='||n||')' END);
  DELETE FROM public.cardiolink_patient_documents WHERE id='00000000-0000-4000-8000-0000000000a4'; GET DIAGNOSTICS n = ROW_COUNT;
  INSERT INTO _res(prueba,resultado) VALUES ('14 owner borra una fila sin dueño legible', CASE WHEN n=1 THEN 'OK' ELSE 'FALLA (borradas='||n||')' END);
  BEGIN UPDATE public.cardiolink_patient_documents SET professional_id='__qa_otro_prof' WHERE id='00000000-0000-4000-8000-0000000000a5'; v_msg:='OK';
  EXCEPTION WHEN OTHERS THEN v_msg:='FALLA '||SQLERRM; END;
  INSERT INTO _res(prueba,resultado) VALUES ('15 owner SÍ puede cambiar professional_id', v_msg);
  IF current_setting('qa.storage')='ok' THEN
    DELETE FROM storage.objects WHERE bucket_id='patient-documents' AND name='documents/__qa_delown/a3.pdf'; GET DIAGNOSTICS n = ROW_COUNT;
    INSERT INTO _res(prueba,resultado) VALUES ('16 owner borra el PDF de cualquier profesional', CASE WHEN n=1 THEN 'OK' ELSE 'FALLA (borrados='||n||')' END);
    DELETE FROM storage.objects WHERE bucket_id='patient-documents' AND name='documents/__qa_delown/huerfano_owner.pdf'; GET DIAGNOSTICS n = ROW_COUNT;
    INSERT INTO _res(prueba,resultado) VALUES ('17 owner borra un objeto huérfano', CASE WHEN n=1 THEN 'OK' ELSE 'FALLA (borrados='||n||')' END);
  END IF;
END $$;

SELECT n, prueba, resultado FROM _res ORDER BY n;

ROLLBACK;
