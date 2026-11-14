-- Bloque 4C-1 · Pruebas SQL TRANSACCIONALES de la seguridad documental. SOLO STAGING, con pending_review_documentos_seguridad_4c1.sql YA aplicado. NO ejecutar en Production.
-- Todo corre dentro de UNA transacción que termina en ROLLBACK: pacientes, evoluciones, atenciones, documentos, objetos y los cambios temporales de rol son sintéticos (qa4c_*) y desaparecen.
-- Actores: 1 secretaria con asociación ACTIVA a un usuario con professional_id (rol 'medico') y 1 owner/admin. Un segundo médico "sin asociaciones" se simula convirtiendo TEMPORALMENTE a la
-- secretaria en médico, y al Dueño como profesional convirtiendo TEMPORALMENTE al médico asociado en 'owner', siempre dentro de la transacción. El acceso médico-paciente lo decide la función
-- EXISTENTE cardiolink_paciente_acceso_clinico_v1 (los tres pacientes sintéticos existen en cardiolink_pacientes; no se prueba la rama «asociación manual» porque su tabla no está en el repo).
-- SIN EJECUTAR (sintaxis sin validar). Cualquier falla lanza una excepción y aborta; ninguna prueba se omite.

BEGIN;

CREATE TEMP TABLE t_actores(sec uuid, med uuid, own uuid, prof text);
GRANT SELECT ON t_actores TO authenticated;
CREATE TEMP TABLE t_rol_orig AS SELECT user_id, base_role, professional_id FROM public.cardiolink_user_roles;
CREATE TEMP TABLE t_res(nombre text, resultado text);
GRANT ALL ON t_res TO authenticated, anon;
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
  INSERT INTO t_actores VALUES (s, m, o, p);
  IF EXISTS (SELECT 1 FROM public.cardiolink_patient_documents WHERE patient_id LIKE 'qa4c\_%' ESCAPE '\') OR EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id='patient-documents' AND name LIKE '%qa4c\_%' ESCAPE '\')
     OR EXISTS (SELECT 1 FROM public.cardiolink_atenciones WHERE id LIKE '\_\_t\_qa4c%' ESCAPE '\') OR EXISTS (SELECT 1 FROM public.cardiolink_pacientes WHERE id LIKE 'qa4c\_%' ESCAPE '\') THEN
    RAISE EXCEPTION 'Ya existen filas/objetos qa4c_*: se aborta sin tocar nada'; END IF;
END $$;
CREATE OR REPLACE FUNCTION pg_temp.claims(p_uid uuid) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true) $$;
-- "subir" un archivo a Storage como el usuario actual (el cliente sube el PDF ANTES de insertar la fila)
CREATE OR REPLACE FUNCTION pg_temp.obj(p_name text, p_owner uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO storage.objects(bucket_id, name, owner) VALUES ('patient-documents', p_name, p_owner) $$;

-- ===== 0) Estado instalado =====
DO $$ BEGIN
  IF (SELECT count(*) FROM pg_policies WHERE permissive='RESTRICTIVE' AND policyname IN ('cardiolink_patient_documents_select_4c1','cardiolink_patient_documents_insert_4c1','cardiolink_patient_documents_update_4c1',
        'cardiolink_patient_documents_storage_select_4c1','cardiolink_patient_documents_storage_insert_4c1')) <> 5 THEN RAISE EXCEPTION 'FALLA 0a: faltan las políticas del Bloque 4C-1 (¿aplicado?)'; END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE policyname IN ('cardiolink_patient_documents_select_no_img_secretaria','cardiolink_clinical_images_storage_select_no_secretaria')) THEN RAISE EXCEPTION 'FALLA 0b: siguen las políticas de lista negra'; END IF;
  IF public.cardiolink_tipos_documento_secretaria_v1() IS DISTINCT FROM ARRAY['Constancia','Orden','Certificado','Estudio','Informe','Laboratorio','ECG','ECG y riesgo quirúrgico','Holter','MAPA','Ecocardiograma','Ecografía','Radiografía','Receta','Indicaciones','Apto físico','Otro'] THEN
    RAISE EXCEPTION 'FALLA 0c: la lista de tipos no es la esperada'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.cardiolink_patient_documents'::regclass AND tgname='cardiolink_patient_documents_inmutables_4c1' AND NOT tgisinternal) THEN RAISE EXCEPTION 'FALLA 0d: falta el trigger de inmutables'; END IF;
  IF has_function_privilege('anon','public.cardiolink_objeto_asignable_v1(text,text)','EXECUTE') OR has_function_privilege('anon','public.cardiolink_secretaria_autorizada_prof_v1(text)','EXECUTE') THEN RAISE EXCEPTION 'FALLA 0e: anon ejecuta las funciones'; END IF;
  IF to_regprocedure('public.cardiolink_medico_atiende_paciente_v1(text)') IS NOT NULL THEN RAISE EXCEPTION 'FALLA 0f: no debe existir una segunda función de asociación'; END IF;
  IF to_regprocedure('public.cardiolink_vinculo_documental_v1(text,text,text,boolean)') IS NULL
     OR has_function_privilege('authenticated','public.cardiolink_vinculo_documental_v1(text,text,text,boolean)','EXECUTE') OR has_function_privilege('anon','public.cardiolink_vinculo_documental_v1(text,text,text,boolean)','EXECUTE') THEN
    RAISE EXCEPTION 'FALLA 0g: el validador de vínculos debe existir y no ser ejecutable por los clientes'; END IF;
  INSERT INTO t_res VALUES ('00 políticas restrictivas, trigger, lista de tipos, privilegios y reutilización de la función de acceso clínico existente', 'OK');
END $$;

-- ===== 1) Fixture sintético (como postgres; sin sesión: el trigger de autor no interviene) =====
-- Paciente A: evoluciones del profesional del médico (evolución propia). B: atención del médico (atención propia). C: atención de OTRO profesional (sin acceso del médico). Los tres EXISTEN como pacientes.
DO $$
DECLARE a record; cols text; vals text; c record; v text; pid text;
BEGIN
  SELECT * INTO a FROM t_actores;
  FOREACH pid IN ARRAY ARRAY['qa4c_pac_a','qa4c_pac_b','qa4c_pac_c','qa4c_pac_d'] LOOP
    cols := 'id'; vals := quote_literal(pid);
    FOR c IN SELECT column_name, data_type FROM information_schema.columns
              WHERE table_schema='public' AND table_name='cardiolink_pacientes' AND is_nullable='NO' AND column_default IS NULL AND column_name <> 'id' ORDER BY ordinal_position LOOP
      cols := cols || ',' || quote_ident(c.column_name);
      IF c.data_type IN ('text','character varying','character') THEN v := quote_literal('QA SINTETICO ' || pid);
      ELSIF c.data_type LIKE 'timestamp%' THEN v := 'now()';
      ELSIF c.data_type = 'date' THEN v := 'current_date';
      ELSIF c.data_type = 'boolean' THEN v := 'false';
      ELSIF c.data_type IN ('integer','bigint','smallint','numeric') THEN v := '0';
      ELSIF c.data_type = 'uuid' THEN v := 'gen_random_uuid()';
      ELSIF c.data_type IN ('jsonb','json') THEN v := quote_literal('{}') || '::' || c.data_type;
      ELSE RAISE EXCEPTION 'Fixture 4C-1: columna obligatoria % de tipo % sin valor sintético definido', c.column_name, c.data_type;
      END IF;
      vals := vals || ',' || v;
    END LOOP;
    EXECUTE format('INSERT INTO public.cardiolink_pacientes(%s) VALUES (%s)', cols, vals);
  END LOOP;
  -- evoluciones: a/a2 propias del paciente A; b propia pero del paciente B; x del paciente A pero de OTRO profesional; c del paciente C y de otro profesional
  INSERT INTO public.cardiolink_hc_evoluciones(id, paciente_id, profesional_id) VALUES ('qa4c_evo_a', 'qa4c_pac_a', a.prof), ('qa4c_evo_a2', 'qa4c_pac_a', a.prof),
    ('qa4c_evo_b', 'qa4c_pac_b', a.prof), ('qa4c_evo_x', 'qa4c_pac_a', 'qa4c_prof_otro'), ('qa4c_evo_c', 'qa4c_pac_c', 'qa4c_prof_otro');
  -- atenciones: a (propia, paciente A), b (propia, paciente B), c (de otro profesional, paciente C), x (de otro profesional, paciente A)
  INSERT INTO public.cardiolink_atenciones(id, payload, updated_at) VALUES
    ('__t_qa4c_a', jsonb_build_object('id','__t_qa4c_a','profesionalId',a.prof,'pacienteId','qa4c_pac_a'), now()),
    ('__t_qa4c_b', jsonb_build_object('id','__t_qa4c_b','profesionalId',a.prof,'pacienteId','qa4c_pac_b'), now()),
    ('__t_qa4c_c', jsonb_build_object('id','__t_qa4c_c','profesionalId','qa4c_prof_otro','pacienteId','qa4c_pac_c'), now()),
    ('__t_qa4c_x', jsonb_build_object('id','__t_qa4c_x','profesionalId','qa4c_prof_otro','pacienteId','qa4c_pac_a'), now());
  -- 12 documentos. 'cert' es un documento EMITIDO/firmado (source_payload + source_document_id) del profesional del médico, cargado por la secretaria. 'ecg' es un PDF subido a mano (sin payload).
  INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, professional_id, uploaded_by, source_document_id, source_payload) VALUES
    ('qa4c_pac_a','Informe',         'QA4C a informe',  'documents/qa4c_pac_a/informe.pdf',     'f.pdf','application/pdf','qa4c_prof_otro', a.own, NULL, NULL),
    ('qa4c_pac_a','Imagen clínica',  'QA4C a imagen',   'clinical-images/qa4c_pac_a/img.jpg',   'f.jpg','image/jpeg',     'qa4c_prof_otro', a.own, NULL, NULL),
    ('qa4c_pac_a','Mensaje a colega','QA4C a mensaje',  'documents/qa4c_pac_a/msg.pdf',         'f.pdf','application/pdf','qa4c_prof_otro', a.own, NULL, NULL),
    ('qa4c_pac_a','ECG',             'QA4C a ecg',      'qa4c_pac_a/ecg_manual.pdf',            'f.pdf','application/pdf','qa4c_prof_otro', a.own, NULL, NULL),
    ('qa4c_pac_a','Certificado',     'QA4C a cert',     'documents/qa4c_pac_a/cert.pdf',        'f.pdf','application/pdf', a.prof,          a.sec, 'qa4c_doc1', '{"v":2}'::jsonb),
    ('qa4c_pac_a','Estudio',         'QA4C a estudio',  'documents/qa4c_pac_a/estudio_sec.pdf', 'f.pdf','application/pdf', a.prof,          a.sec, NULL, NULL),
    ('qa4c_pac_a','Mensaje a colega','QA4C a msgsec',   'documents/qa4c_pac_a/msg_sec.pdf',     'f.pdf','application/pdf','qa4c_prof_otro', a.own, NULL, NULL),
    ('qa4c_pac_b','Holter',          'QA4C b holter',   'documents/qa4c_pac_b/holter.pdf',      'f.pdf','application/pdf', a.prof,          a.med, NULL, NULL),
    ('qa4c_pac_c','Informe',         'QA4C c informe',  'documents/qa4c_pac_c/informe_c.pdf',   'f.pdf','application/pdf','qa4c_prof_otro', a.own, NULL, NULL),
    ('qa4c_pac_c','Receta',          'QA4C c receta',   'documents/qa4c_pac_c/receta_c.pdf',    'f.pdf','application/pdf','qa4c_prof_otro', a.own, NULL, NULL),
    ('qa4c_pac_c','Estudio',         'QA4C c propio',   'documents/qa4c_pac_c/propio_med.pdf',  'f.pdf','application/pdf', a.prof,          a.med, NULL, NULL),
    ('qa4c_pac_d','Informe',         'QA4C d informe',  'documents/qa4c_pac_d/informe_d.pdf',   'f.pdf','application/pdf','qa4c_prof_otro', a.own, NULL, NULL),
    ('qa4c_pac_a','ECG',             'QA4C a ecg2',     'qa4c_pac_a/ecg2.pdf',                  'f.pdf','application/pdf', a.prof,          a.own, NULL, NULL),
    ('qa4c_pac_a','Informe',         'QA4C a informe2', 'documents/qa4c_pac_a/informe2.pdf',    'f.pdf','application/pdf', a.prof,          a.own, NULL, NULL),
    ('qa4c_pac_c','Receta',          'QA4C c receta2',  'documents/qa4c_pac_c/receta2.pdf',     'f.pdf','application/pdf', a.prof,          a.own, NULL, NULL),
    ('qa4c_pac_a','ECG',             'QA4C a sinprof',  'documents/qa4c_pac_a/sinprof.pdf',     'f.pdf','application/pdf', NULL,            a.own, 'qa4c_doc_nulo', '{"v":2}'::jsonb),
    ('qa4c_pac_a','Certificado',     'QA4C a cert otro','documents/qa4c_pac_a/cert_otro.pdf',   'f.pdf','application/pdf','qa4c_prof_otro', a.own, 'qa4c_doc_otro', '{"v":2}'::jsonb);
  -- 20 objetos: uno por fila (el de 'msgsec' lo sube la secretaria) + 3 huérfanos: uno ajeno, uno ajeno bajo clinical-images/ y uno de la secretaria SUBIDO HACE 2 HORAS (fuera de la ventana de 1 hora)
  INSERT INTO storage.objects(bucket_id, name, owner)
    SELECT 'patient-documents', storage_path, CASE WHEN title = 'QA4C a msgsec' THEN a.sec ELSE a.own END FROM public.cardiolink_patient_documents WHERE patient_id LIKE 'qa4c\_%' ESCAPE '\';
  INSERT INTO storage.objects(bucket_id, name, owner) VALUES ('patient-documents', 'documents/qa4c_pac_a/huerfano.pdf', a.own), ('patient-documents', 'clinical-images/qa4c_pac_a/huerfano_img.jpg', a.own);
  INSERT INTO storage.objects(bucket_id, name, owner, created_at) VALUES ('patient-documents', 'documents/qa4c_pac_a/viejo_sec.pdf', a.sec, now() - interval '2 hours');
  IF (SELECT count(*) FROM public.cardiolink_patient_documents WHERE patient_id LIKE 'qa4c\_%' ESCAPE '\') <> 17 OR (SELECT count(*) FROM storage.objects WHERE name LIKE '%qa4c\_pac%' ESCAPE '\') <> 20 THEN
    RAISE EXCEPTION 'Fixture 4C-1: no quedó creado (17 filas / 20 objetos)'; END IF;
END $$;

-- ===== 2) VISIBILIDAD por rol (antes de cualquier escritura de prueba) =====
SET LOCAL ROLE authenticated;
DO $$ DECLARE a record; n int; BEGIN
  SELECT * INTO a FROM t_actores;
  -- Secretaría (v2.2): sólo tipos de la lista, ruta fuera de clinical-images/ Y profesional de su asociación ACTIVA (7 de 17); nada de imagen clínica ni 'Mensaje a colega'; 8 objetos (ni huérfanos ajenos, ni el propio fuera de ventana, ni el de una fila cerrada)
  PERFORM pg_temp.claims(a.sec);
  SELECT count(*) INTO n FROM public.cardiolink_patient_documents WHERE patient_id LIKE 'qa4c\_%' ESCAPE '\';
  IF n <> 7 THEN RAISE EXCEPTION 'FALLA 2.1: Secretaría ve % filas qa4c (esperadas 7: sólo las de su profesional asociado)', n; END IF;
  SELECT count(*) INTO n FROM public.cardiolink_patient_documents WHERE patient_id LIKE 'qa4c\_%' ESCAPE '\' AND (document_type IN ('Imagen clínica','Mensaje a colega') OR storage_path LIKE 'clinical-images/%');
  IF n <> 0 THEN RAISE EXCEPTION 'FALLA 2.1b: Secretaría ve % filas de imagen clínica o mensajes entre colegas', n; END IF;
  SELECT count(*) INTO n FROM public.cardiolink_patient_documents WHERE patient_id LIKE 'qa4c\_%' ESCAPE '\' AND document_type IN ('ECG','Holter','Informe','Receta','Certificado','Estudio');
  IF n <> 7 THEN RAISE EXCEPTION 'FALLA 2.1c: Secretaría no ve ECG, Holter, informes, recetas, certificados o estudios de su profesional (%)', n; END IF;
  SELECT count(*) INTO n FROM public.cardiolink_patient_documents WHERE patient_id LIKE 'qa4c\_%' ESCAPE '\' AND professional_id IS DISTINCT FROM a.prof;
  IF n <> 0 THEN RAISE EXCEPTION 'FALLA 2.1d: Secretaría ve % documentos de otros profesionales o sin profesional identificable', n; END IF;
  SELECT count(*) INTO n FROM storage.objects WHERE bucket_id='patient-documents' AND name LIKE '%qa4c\_pac%' ESCAPE '\';
  IF n <> 7 THEN RAISE EXCEPTION 'FALLA 2.2: Secretaría ve % objetos qa4c (esperados 7)', n; END IF;
  -- Médico: titular (5,6,8,11,12,13,14) + acceso clínico al paciente A (evolución) y B (atención) = 14; NO ve el paciente C ajeno (informe y receta) ni el D
  PERFORM pg_temp.claims(a.med);
  SELECT count(*) INTO n FROM public.cardiolink_patient_documents WHERE patient_id LIKE 'qa4c\_%' ESCAPE '\';
  IF n <> 14 THEN RAISE EXCEPTION 'FALLA 2.3: el médico ve % filas qa4c (esperadas 14)', n; END IF;
  SELECT count(*) INTO n FROM public.cardiolink_patient_documents WHERE title IN ('QA4C c informe','QA4C c receta');
  IF n <> 0 THEN RAISE EXCEPTION 'FALLA 2.3b: el médico ve documentos de un paciente al que no tiene acceso clínico (%)', n; END IF;
  SELECT count(*) INTO n FROM public.cardiolink_patient_documents WHERE title IN ('QA4C a imagen','QA4C a mensaje','QA4C c propio');
  IF n <> 3 THEN RAISE EXCEPTION 'FALLA 2.3c: el médico no ve la imagen clínica / el mensaje a colega del paciente con acceso ni su propio documento (%)', n; END IF;
  SELECT count(*) INTO n FROM storage.objects WHERE bucket_id='patient-documents' AND name LIKE '%qa4c\_pac%' ESCAPE '\';
  IF n <> 14 THEN RAISE EXCEPTION 'FALLA 2.4: el médico ve % objetos qa4c (esperados 14: sólo los de filas visibles)', n; END IF;
  -- Owner/admin: todo (17 filas, 20 objetos)
  PERFORM pg_temp.claims(a.own);
  SELECT count(*) INTO n FROM public.cardiolink_patient_documents WHERE patient_id LIKE 'qa4c\_%' ESCAPE '\';
  IF n <> 17 THEN RAISE EXCEPTION 'FALLA 2.5: owner/admin ve % filas (esperadas 17)', n; END IF;
  SELECT count(*) INTO n FROM storage.objects WHERE bucket_id='patient-documents' AND name LIKE '%qa4c\_pac%' ESCAPE '\';
  IF n <> 20 THEN RAISE EXCEPTION 'FALLA 2.5b: owner/admin ve % objetos (esperados 20)', n; END IF;
  INSERT INTO t_res VALUES ('10 visibilidad: Secretaría (ECG/Holter/informes/recetas de su profesional asociado sí; imagen clínica, mensaje a colega, otros profesionales y sin profesional no), médico (titular o acceso clínico), owner/admin (todo); Storage idéntico', 'OK');
END $$;

-- ===== 3) SECRETARÍA: escrituras (cada alta sube ANTES el archivo, como el cliente) =====
DO $$ DECLARE a record; ok boolean; t text; i int := 0; n int; BEGIN
  SELECT * INTO a FROM t_actores; PERFORM pg_temp.claims(a.sec);
  PERFORM pg_temp.obj('documents/qa4c_pac_a/' || x || '.pdf', a.sec) FROM unnest(ARRAY['nueva','nuevo_c','apto','receta','indic','autoria','r1','r2','r5','intento1','intento2','intento3','intento4','intento5','intento6','intento7']) x;
  PERFORM pg_temp.obj('qa4c_pac_a/nuevo_holter.pdf', a.sec);
  -- 3.1 emitir/subir tipos permitidos a nombre de un profesional AUTORIZADO (el de su asociación); incluye subida manual sin prefijo y recetas, indicaciones y apto físico
  INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, professional_id) VALUES
    ('qa4c_pac_a','Constancia',  'QA4C nuevo 1','documents/qa4c_pac_a/nueva.pdf',   'n.pdf','application/pdf', a.prof),
    ('qa4c_pac_a','Certificado', 'QA4C nuevo 2','documents/qa4c_pac_a/nuevo_c.pdf', 'n.pdf','application/pdf', a.prof),
    ('qa4c_pac_a','Holter',      'QA4C nuevo 3','qa4c_pac_a/nuevo_holter.pdf',      'n.pdf','application/pdf', a.prof),
    ('qa4c_pac_a','Apto físico', 'QA4C nuevo 4','documents/qa4c_pac_a/apto.pdf',    'n.pdf','application/pdf', a.prof),
    ('qa4c_pac_a','Receta',      'QA4C nuevo 5','documents/qa4c_pac_a/receta.pdf',  'n.pdf','application/pdf', a.prof),
    ('qa4c_pac_a','Indicaciones','QA4C nuevo 6','documents/qa4c_pac_a/indic.pdf',   'n.pdf','application/pdf', a.prof);
  -- 3.2 TRAZABILIDAD: aunque el cliente mande otro uploaded_by, el servidor registra a la Secretaría
  INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, professional_id, uploaded_by)
    VALUES ('qa4c_pac_a','Orden','QA4C autoria','documents/qa4c_pac_a/autoria.pdf','a.pdf','application/pdf', a.prof, a.own);
  SELECT count(*) INTO n FROM public.cardiolink_patient_documents WHERE title LIKE 'QA4C nuevo %' OR title = 'QA4C autoria';
  IF n <> 7 THEN RAISE EXCEPTION 'FALLA 3.1: no se crearon los 7 documentos permitidos (%)', n; END IF;
  SELECT count(*) INTO n FROM public.cardiolink_patient_documents WHERE (title LIKE 'QA4C nuevo %' OR title = 'QA4C autoria') AND uploaded_by IS DISTINCT FROM a.sec;
  IF n <> 0 THEN RAISE EXCEPTION 'FALLA 3.2: % documentos no quedaron registrados a nombre de la Secretaría que los creó', n; END IF;
  -- 3.3 rechazos (42501) con el archivo YA subido (para que el motivo sea el de la regla probada): sin profesional, profesional NO asociado, tipos cerrados, variantes, clinical-images y vínculo a evolución
  ok := false; BEGIN INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type)
      VALUES ('qa4c_pac_a','Constancia','QA4C r1','documents/qa4c_pac_a/r1.pdf','r.pdf','application/pdf'); ok := true; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 3.3a: Secretaría emitió un documento SIN profesional'; END IF;
  ok := false; BEGIN INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, professional_id)
      VALUES ('qa4c_pac_a','Constancia','QA4C r2','documents/qa4c_pac_a/r2.pdf','r.pdf','application/pdf','qa4c_prof_no_asociado'); ok := true; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 3.3b: Secretaría emitió a nombre de un profesional con el que NO está asociada'; END IF;
  FOREACH t IN ARRAY ARRAY['Mensaje a colega','Imagen clínica','constancia','Constancia ','CONSTANCIA','','Tipo nuevo'] LOOP
    i := i + 1; ok := false;
    BEGIN INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, professional_id)
            VALUES ('qa4c_pac_a', t, 'QA4C intento', 'documents/qa4c_pac_a/intento' || i || '.pdf', 'i.pdf', 'application/pdf', a.prof); ok := true;
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    IF ok THEN RAISE EXCEPTION 'FALLA 3.3c: Secretaría pudo crear un documento de tipo [%]', t; END IF;
  END LOOP;
  ok := false; BEGIN INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, professional_id)
      VALUES ('qa4c_pac_a','Estudio','QA4C r4','clinical-images/qa4c_pac_a/r4.jpg','r.jpg','image/jpeg', a.prof); ok := true; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 3.3d: Secretaría registró una fila sobre una ruta de clinical-images/'; END IF;
  ok := false; BEGIN INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, professional_id, evolution_id)
      VALUES ('qa4c_pac_a','Estudio','QA4C r5','documents/qa4c_pac_a/r5.pdf','r.pdf','application/pdf', a.prof, 'qa4c_evo_a'); ok := true; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 3.3e: Secretaría creó un documento vinculado a una evolución'; END IF;
  INSERT INTO t_res VALUES ('20 Secretaría: emite/sube tipos permitidos con profesional autorizado (autoría estampada por el servidor); rechazada sin profesional, con profesional ajeno, tipos cerrados, variantes, clinical-images y vínculo a evolución', 'OK');
END $$;

DO $$ DECLARE a record; ok boolean; n int; msg text; ctx text; v_bloq boolean := false; BEGIN
  SELECT * INTO a FROM t_actores; PERFORM pg_temp.claims(a.sec);
  -- 3.4 SUBIDA ADMINISTRATIVA LEGÍTIMA: el archivo propio recién subido (con y sin prefijo documents/) es visible aunque aún no tenga fila; luego entra la fila
  PERFORM pg_temp.obj('documents/qa4c_pac_a/subida.pdf', a.sec); PERFORM pg_temp.obj('qa4c_pac_a/subida_manual.pdf', a.sec);
  SELECT count(*) INTO n FROM storage.objects WHERE bucket_id='patient-documents' AND name IN ('documents/qa4c_pac_a/subida.pdf','qa4c_pac_a/subida_manual.pdf');
  IF n <> 2 THEN RAISE EXCEPTION 'FALLA 3.4a: Secretaría no ve los archivos que acaba de subir (%)', n; END IF;
  INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, professional_id) VALUES
    ('qa4c_pac_a','Estudio','QA4C subida','documents/qa4c_pac_a/subida.pdf','s.pdf','application/pdf', a.prof),
    ('qa4c_pac_a','ECG','QA4C subida manual','qa4c_pac_a/subida_manual.pdf','e.pdf','application/pdf', a.prof);
  SELECT count(*) INTO n FROM storage.objects WHERE bucket_id='patient-documents' AND name IN ('documents/qa4c_pac_a/subida.pdf','qa4c_pac_a/subida_manual.pdf');
  IF n <> 2 THEN RAISE EXCEPTION 'FALLA 3.4b: con la fila creada Secretaría dejó de ver sus archivos (%)', n; END IF;
  -- 3.5 subir a clinical-images/ se rechaza
  ok := false; BEGIN PERFORM pg_temp.obj('clinical-images/qa4c_pac_a/x.jpg', a.sec); ok := true; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 3.5: Secretaría subió a clinical-images/'; END IF;
  -- 3.6 sin UPDATE ni DELETE (0 filas), en la tabla y en Storage
  UPDATE public.cardiolink_patient_documents SET title = 'MODIFICADO' WHERE patient_id LIKE 'qa4c\_%' ESCAPE '\'; GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FALLA 3.6a: Secretaría modificó % documentos', n; END IF;
  DELETE FROM public.cardiolink_patient_documents WHERE patient_id LIKE 'qa4c\_%' ESCAPE '\'; GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FALLA 3.6b: Secretaría borró % documentos', n; END IF;
  -- 3.6c (v2.5) DELETE directo sobre storage.objects. Supabase lo bloquea para TODOS los roles con el trigger de plataforma storage.protect_delete (ERRCODE 42501, salvo que la Storage API fije
  --      storage.allow_delete_query = 'true'): falla ANTES de que intervenga la RLS. Ese bloqueo NO demuestra que la RLS impida a Secretaría borrar mediante la Storage API: eso se verifica en el QA funcional
  --      (objeto descartable + sesión de Secretaría + control positivo; ver el procedimiento). Acá se acepta SOLO ese bloqueo de plataforma, verificado por SQLSTATE 42501 + mensaje exacto + CONTEXT
  --      storage.protect_delete() + trigger habilitado sobre storage.objects; cualquier otra excepción se relanza. Sin desactivar triggers ni fijar storage.allow_delete_query.
  BEGIN
    DELETE FROM storage.objects WHERE bucket_id='patient-documents' AND name LIKE '%qa4c\_pac%' ESCAPE '\'; GET DIAGNOSTICS n = ROW_COUNT;
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT, ctx = PG_EXCEPTION_CONTEXT;
    IF msg LIKE 'Direct deletion from storage tables is not allowed%' AND ctx LIKE '%storage.protect_delete()%'
       AND EXISTS (SELECT 1 FROM pg_trigger tg JOIN pg_proc pr ON pr.oid = tg.tgfoid JOIN pg_namespace ns ON ns.oid = pr.pronamespace
                    WHERE tg.tgrelid = 'storage.objects'::regclass AND NOT tg.tgisinternal AND tg.tgenabled <> 'D' AND ns.nspname = 'storage' AND pr.proname = 'protect_delete') THEN
      v_bloq := true; n := 0;
    ELSE
      RAISE;  -- no es el bloqueo de plataforma: se informa tal cual
    END IF;
  END;
  IF n <> 0 THEN RAISE EXCEPTION 'FALLA 3.6c: Secretaría borró % objetos de Storage', n; END IF;
  -- 3.6d predicado EFECTIVO de las políticas DELETE/ALL permisivas de storage.objects para authenticated (también las de rol public): sólo cardiolink_patient_documents_storage_delete, y su predicado depende de
  --      cardiolink_can_delete_clinical_document (titularidad: owner/admin, o médico titular); no hay otra política permisiva que pueda habilitar a Secretaría ni referencias a su rol.
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND permissive = 'PERMISSIVE' AND cmd IN ('DELETE', 'ALL') AND roles && ARRAY['authenticated', 'public']::name[]) <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'cardiolink_patient_documents_storage_delete' AND permissive = 'PERMISSIVE' AND cmd = 'DELETE'
                       AND qual LIKE '%cardiolink_can_delete_clinical_document(%' AND qual NOT ILIKE '%secretaria%') THEN
    RAISE EXCEPTION 'FALLA 3.6d: las políticas DELETE/ALL permisivas de storage.objects para authenticated no son exactamente cardiolink_patient_documents_storage_delete (titularidad)'; END IF;
  -- 3.6e Secretaría NO cumple el predicado de titularidad (ni con fila ni sin fila, ni siendo la autora del objeto) y los controles positivos autorizados sí lo cumplen (médico titular y owner)
  IF public.cardiolink_can_delete_clinical_document(a.prof, a.sec) OR public.cardiolink_can_delete_clinical_document(NULL, a.sec) OR public.cardiolink_can_delete_clinical_document(a.prof, NULL) THEN
    RAISE EXCEPTION 'FALLA 3.6e: el predicado de titularidad de DELETE habilita a Secretaría'; END IF;
  PERFORM pg_temp.claims(a.med);
  IF NOT (public.cardiolink_can_delete_clinical_document(a.prof, NULL) AND public.cardiolink_can_delete_clinical_document(NULL, a.med)) THEN
    RAISE EXCEPTION 'FALLA 3.6f: control positivo: el médico titular debería cumplir el predicado de DELETE'; END IF;
  IF public.cardiolink_can_delete_clinical_document('qa4c_prof_otro', NULL) OR public.cardiolink_can_delete_clinical_document(NULL, a.own) THEN
    RAISE EXCEPTION 'FALLA 3.6g: el médico cumple el predicado sobre un documento ajeno'; END IF;
  PERFORM pg_temp.claims(a.own);
  IF NOT (public.cardiolink_can_delete_clinical_document('qa4c_prof_otro', NULL) AND public.cardiolink_can_delete_clinical_document(NULL, NULL)) THEN
    RAISE EXCEPTION 'FALLA 3.6h: control positivo: owner/admin debería cumplir el predicado de DELETE'; END IF;
  PERFORM pg_temp.claims(a.sec);
  INSERT INTO t_res VALUES ('21 Secretaría Storage: subida administrativa con y sin prefijo (archivo propio visible antes y después de la fila), clinical-images/ rechazado, sin UPDATE ni DELETE en la tabla; DELETE directo de Storage BLOQUEADO POR LA PLATAFORMA (no prueba la RLS; predicado efectivo verificado; REQUIERE verificación posterior por Storage API)', 'OK');
END $$;

-- ===== 3b) STORAGE: reutilización de ruta ajena, asociación falsa y acceso directo a objetos restringidos (como Secretaría) =====
DO $$ DECLARE a record; ok boolean; n int; r text; BEGIN
  SELECT * INTO a FROM t_actores; PERFORM pg_temp.claims(a.sec);
  -- 3b.1 una fila NO puede apuntar al archivo de otro: huérfano ajeno, huérfano ajeno bajo clinical-images/, archivo de una fila restringida (unique o 42501) y archivo inexistente
  FOREACH r IN ARRAY ARRAY['documents/qa4c_pac_a/huerfano.pdf','clinical-images/qa4c_pac_a/huerfano_img.jpg','documents/qa4c_pac_a/msg.pdf','documents/qa4c_pac_a/msg_sec.pdf','documents/qa4c_pac_a/no_existe.pdf'] LOOP
    ok := false;
    BEGIN INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, professional_id)
            VALUES ('qa4c_pac_a','Estudio','QA4C ajena', r, 'x.pdf', 'application/pdf', a.prof); ok := true;
    EXCEPTION WHEN insufficient_privilege OR unique_violation THEN NULL; END;
    IF ok THEN RAISE EXCEPTION 'FALLA 3b.1: Secretaría creó una fila sobre la ruta ajena o inexistente [%]', r; END IF;
  END LOOP;
  -- 3b.2 archivo PROPIO de otro paciente: no se puede asociar al paciente equivocado (asociación falsa); sí a su paciente
  PERFORM pg_temp.obj('documents/qa4c_pac_c/propio_sec.pdf', a.sec);
  ok := false;
  BEGIN INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, professional_id)
          VALUES ('qa4c_pac_a','Estudio','QA4C falsa','documents/qa4c_pac_c/propio_sec.pdf','x.pdf','application/pdf', a.prof); ok := true; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 3b.2a: se asoció un archivo del paciente C al paciente A'; END IF;
  INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, professional_id)
    VALUES ('qa4c_pac_c','Estudio','QA4C legítima C','documents/qa4c_pac_c/propio_sec.pdf','x.pdf','application/pdf', a.prof);
  -- 3b.3 archivo propio FUERA de la ventana de 1 hora (viejo_sec): ni se ve ni se puede asociar
  SELECT count(*) INTO n FROM storage.objects WHERE name = 'documents/qa4c_pac_a/viejo_sec.pdf';
  IF n <> 0 THEN RAISE EXCEPTION 'FALLA 3b.3a: Secretaría ve su archivo propio fuera de la ventana de 1 hora'; END IF;
  ok := false;
  BEGIN INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, professional_id)
          VALUES ('qa4c_pac_a','Estudio','QA4C vieja','documents/qa4c_pac_a/viejo_sec.pdf','x.pdf','application/pdf', a.prof); ok := true; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 3b.3b: se asoció un archivo propio de hace más de 1 hora'; END IF;
  -- 3b.4 ACCESO DIRECTO a objetos restringidos (por nombre exacto): imagen clínica, mensaje a colega (fila cerrada), huérfanos ajenos
  SELECT count(*) INTO n FROM storage.objects WHERE bucket_id='patient-documents' AND name IN ('clinical-images/qa4c_pac_a/img.jpg','documents/qa4c_pac_a/msg.pdf','documents/qa4c_pac_a/msg_sec.pdf',
        'documents/qa4c_pac_a/huerfano.pdf','clinical-images/qa4c_pac_a/huerfano_img.jpg');
  IF n <> 0 THEN RAISE EXCEPTION 'FALLA 3b.4: Secretaría accede directamente a % objeto(s) restringido(s)', n; END IF;
  INSERT INTO t_res VALUES ('22 Storage: ninguna fila puede apuntar a una ruta ajena, inexistente, vieja o de otro paciente; objetos restringidos inaccesibles por nombre exacto; la subida legítima del propio archivo sí entra', 'OK');
END $$;

-- ===== 3c) DUEÑO COMO PROFESIONAL: Secretaría emite a nombre de un profesional de ROL owner si tiene la asociación (el rol del profesional no bloquea) =====
RESET ROLE;
UPDATE public.cardiolink_user_roles SET base_role = 'owner' WHERE user_id = (SELECT med FROM t_actores);
SET LOCAL ROLE authenticated;
DO $$ DECLARE a record; n int; BEGIN
  SELECT * INTO a FROM t_actores; PERFORM pg_temp.claims(a.sec);
  PERFORM pg_temp.obj('documents/qa4c_pac_a/a_nombre_dueno.pdf', a.sec);
  INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, professional_id)
    VALUES ('qa4c_pac_a','Certificado','QA4C a nombre del dueño','documents/qa4c_pac_a/a_nombre_dueno.pdf','d.pdf','application/pdf', a.prof);
  SELECT count(*) INTO n FROM public.cardiolink_patient_documents WHERE title = 'QA4C a nombre del dueño' AND professional_id = a.prof AND uploaded_by = a.sec;
  IF n <> 1 THEN RAISE EXCEPTION 'FALLA 3c.1: Secretaría no pudo emitir a nombre de un profesional con rol owner asociado a ella (%)', n; END IF;
  IF a.prof <> ALL (public.cardiolink_profesionales_autorizados_secretaria_v1()) THEN RAISE EXCEPTION 'FALLA 3c.2: el profesional owner no figura entre los autorizados de la Secretaría'; END IF;
  INSERT INTO t_res VALUES ('23 Dueño como profesional: Secretaría emite a nombre de un profesional con rol owner cuando tiene la asociación correspondiente', 'OK');
END $$;
RESET ROLE;
UPDATE public.cardiolink_user_roles u SET base_role = o.base_role, professional_id = o.professional_id FROM t_rol_orig o WHERE u.user_id = o.user_id AND u.user_id = (SELECT med FROM t_actores);
SET LOCAL ROLE authenticated;

-- ===== 3d) SECRETARÍA SÓLO VE LO DE PROFESIONALES CON ASOCIACIÓN ACTIVA (listados, búsquedas, vista previa/descarga = Storage, envíos = Edge Function con el JWT, API directa, historial de envíos); al desactivar la asociación lo pierde AL INSTANTE =====
RESET ROLE;
CREATE TEMP TABLE t_ids AS SELECT title, id FROM public.cardiolink_patient_documents WHERE patient_id LIKE 'qa4c\_%' ESCAPE '\';
GRANT SELECT ON t_ids TO authenticated;
-- historial de envíos sintético (como postgres): de un documento de SU profesional, de uno de OTRO profesional, de uno SIN profesional, y un aviso sin documento
INSERT INTO public.cardiolink_communications(tipo, canal, destinatario, subject, message, status, sent_at, document_id)
  SELECT 'document_delivery', 'email', 'qa4c-destinatario', 'qa4c', 'qa4c envio ' || title, 'sent', now(), id::text FROM t_ids WHERE title IN ('QA4C a cert', 'QA4C a informe', 'QA4C a sinprof');
INSERT INTO public.cardiolink_communications(tipo, canal, destinatario, subject, message, status, sent_at) VALUES ('manual', 'email', 'qa4c-destinatario', 'qa4c', 'qa4c sin documento', 'sent', now());
DO $$ DECLARE v_tabla text; BEGIN
  SELECT table_name INTO v_tabla FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('secretaria_user_id','medico_user_id','activo') GROUP BY table_name HAVING count(*) = 3;
  EXECUTE format('CREATE TEMP TABLE t_asoc_orig AS SELECT secretaria_user_id, medico_user_id, activo FROM public.%I', v_tabla);
END $$;
SET LOCAL ROLE authenticated;
DO $$ DECLARE a record; n int; m int; r text; BEGIN
  SELECT * INTO a FROM t_actores; PERFORM pg_temp.claims(a.sec);
  -- 3d.1 listados / búsquedas / API directa por id: lo de profesionales AJENOS o SIN profesional no existe para ella; lo de su profesional asociado sí
  SELECT count(*) INTO n FROM public.cardiolink_patient_documents WHERE id IN (SELECT id FROM t_ids WHERE title IN ('QA4C a informe','QA4C a ecg','QA4C c informe','QA4C c receta','QA4C d informe','QA4C a sinprof','QA4C a cert otro'));
  IF n <> 0 THEN RAISE EXCEPTION 'FALLA 3d.1: Secretaría ve % documentos de profesionales sin asociación o sin profesional identificable', n; END IF;
  SELECT count(*) INTO n FROM public.cardiolink_patient_documents WHERE id IN (SELECT id FROM t_ids WHERE title IN ('QA4C a cert','QA4C a estudio','QA4C b holter'));
  IF n <> 3 THEN RAISE EXCEPTION 'FALLA 3d.2: Secretaría no ve los documentos de su profesional asociado (%)', n; END IF;
  SELECT count(*) INTO n FROM public.cardiolink_patient_documents WHERE document_type = 'ECG' AND patient_id LIKE 'qa4c\_%' ESCAPE '\' AND professional_id IS NULL;
  IF n <> 0 THEN RAISE EXCEPTION 'FALLA 3d.3: Secretaría ve documentos sin profesional identificable (%)', n; END IF;
  -- 3d.4 vista previa / descarga (URL firmada = SELECT sobre el objeto) y envío (la Edge Function descarga con el JWT): objetos ajenos o sin profesional inaccesibles por nombre exacto
  FOREACH r IN ARRAY ARRAY['documents/qa4c_pac_a/informe.pdf','qa4c_pac_a/ecg_manual.pdf','documents/qa4c_pac_c/informe_c.pdf','documents/qa4c_pac_c/receta_c.pdf','documents/qa4c_pac_a/sinprof.pdf','documents/qa4c_pac_a/cert_otro.pdf','documents/qa4c_pac_d/informe_d.pdf'] LOOP
    SELECT count(*) INTO n FROM storage.objects WHERE bucket_id = 'patient-documents' AND name = r;
    IF n <> 0 THEN RAISE EXCEPTION 'FALLA 3d.4: Secretaría accede al objeto de un profesional sin asociación [%]', r; END IF;
  END LOOP;
  SELECT count(*) INTO n FROM storage.objects WHERE bucket_id = 'patient-documents' AND name IN ('documents/qa4c_pac_a/cert.pdf','documents/qa4c_pac_a/estudio_sec.pdf','documents/qa4c_pac_b/holter.pdf');
  IF n <> 3 THEN RAISE EXCEPTION 'FALLA 3d.5: Secretaría no accede a los objetos de su profesional asociado (%)', n; END IF;
  -- 3d.6 historial de envíos: sólo el de documentos que ve (más los avisos sin documento)
  SELECT count(*) INTO n FROM public.cardiolink_communications WHERE message LIKE 'qa4c%';
  IF n <> 2 THEN RAISE EXCEPTION 'FALLA 3d.6: Secretaría ve % filas del historial (esperadas 2: el envío de su documento y el aviso sin documento)', n; END IF;
  -- (v2.6) el médico NO lee la tabla de comunicaciones por SELECT directo (la política SELECT de cardiolink_communications es sólo owner/admin/secretaria: PARTE 2 del historial, ya aplicada en STAGING);
  --        su historial autorizado lo recibe por la RPC cardiolink_historial_envios_documento_v1: sólo el envío de SU documento ('QA4C a cert', de su profesional), no los de otros profesionales ni el del documento sin profesional.
  PERFORM pg_temp.claims(a.med);
  SELECT count(*) INTO n FROM public.cardiolink_communications WHERE message LIKE 'qa4c%';
  IF n <> 0 THEN RAISE EXCEPTION 'FALLA 3d.7: el médico lee % filas del historial por SELECT directo (esperadas 0: la tabla es sólo owner/admin/secretaria)', n; END IF;
  SELECT count(*), count(*) FILTER (WHERE r.document_id = (SELECT id::text FROM t_ids WHERE title = 'QA4C a cert')) INTO n, m
    FROM public.cardiolink_historial_envios_documento_v1((SELECT array_agg(id::text) FROM t_ids WHERE title IN ('QA4C a cert', 'QA4C a informe', 'QA4C a sinprof'))) r;
  IF n <> 1 OR m <> 1 THEN RAISE EXCEPTION 'FALLA 3d.7b: el médico debe recibir por la RPC sólo el historial de su documento (filas %, de su documento %)', n, m; END IF;
  -- owner/admin conservan el historial completo por la tabla (4 filas)
  PERFORM pg_temp.claims(a.own);
  SELECT count(*) INTO n FROM public.cardiolink_communications WHERE message LIKE 'qa4c%';
  IF n <> 4 THEN RAISE EXCEPTION 'FALLA 3d.8: owner/admin dejó de ver el historial (% de 4)', n; END IF;
END $$;
-- 3d.9 DESACTIVAR la asociación (como postgres, mismo instante): Secretaría pierde TODO de inmediato (tabla, Storage, historial, altas)
RESET ROLE;
DO $$ DECLARE v_tabla text; BEGIN
  SELECT table_name INTO v_tabla FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('secretaria_user_id','medico_user_id','activo') GROUP BY table_name HAVING count(*) = 3;
  EXECUTE format('UPDATE public.%I SET activo = false WHERE secretaria_user_id = $1', v_tabla) USING (SELECT sec FROM t_actores);
END $$;
SET LOCAL ROLE authenticated;
DO $$ DECLARE a record; n int; ok boolean; BEGIN
  SELECT * INTO a FROM t_actores; PERFORM pg_temp.claims(a.sec);
  SELECT count(*) INTO n FROM public.cardiolink_patient_documents WHERE patient_id LIKE 'qa4c\_%' ESCAPE '\';
  IF n <> 0 THEN RAISE EXCEPTION 'FALLA 3d.9: desactivada la asociación Secretaría sigue viendo % documentos', n; END IF;
  SELECT count(*) INTO n FROM storage.objects WHERE bucket_id = 'patient-documents' AND name IN ('documents/qa4c_pac_a/cert.pdf','documents/qa4c_pac_a/estudio_sec.pdf','documents/qa4c_pac_b/holter.pdf');
  IF n <> 0 THEN RAISE EXCEPTION 'FALLA 3d.10: desactivada la asociación Secretaría sigue accediendo a % objetos', n; END IF;
  SELECT count(*) INTO n FROM public.cardiolink_communications WHERE message LIKE 'qa4c%';
  IF n <> 1 THEN RAISE EXCEPTION 'FALLA 3d.11: desactivada la asociación Secretaría ve % filas del historial (esperada 1: el aviso sin documento)', n; END IF;
  PERFORM pg_temp.obj('documents/qa4c_pac_a/sin_asoc.pdf', a.sec);
  ok := false; BEGIN INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, professional_id)
      VALUES ('qa4c_pac_a','Estudio','QA4C sin asociacion','documents/qa4c_pac_a/sin_asoc.pdf','s.pdf','application/pdf', a.prof); ok := true; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 3d.12: desactivada la asociación Secretaría pudo emitir a nombre de ese profesional'; END IF;
END $$;
-- 3d.13 REACTIVAR (restaurando el estado original de las asociaciones): vuelve el acceso, también al instante
RESET ROLE;
DO $$ DECLARE v_tabla text; BEGIN
  SELECT table_name INTO v_tabla FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('secretaria_user_id','medico_user_id','activo') GROUP BY table_name HAVING count(*) = 3;
  EXECUTE format('UPDATE public.%I a SET activo = o.activo FROM t_asoc_orig o WHERE a.secretaria_user_id = o.secretaria_user_id AND a.medico_user_id = o.medico_user_id', v_tabla);
END $$;
SET LOCAL ROLE authenticated;
DO $$ DECLARE a record; n int; BEGIN
  SELECT * INTO a FROM t_actores; PERFORM pg_temp.claims(a.sec);
  SELECT count(*) INTO n FROM public.cardiolink_patient_documents WHERE id IN (SELECT id FROM t_ids WHERE title IN ('QA4C a cert','QA4C a estudio','QA4C b holter'));
  IF n <> 3 THEN RAISE EXCEPTION 'FALLA 3d.13: reactivada la asociación Secretaría no recuperó el acceso (%)', n; END IF;
  INSERT INTO t_res VALUES ('24 Secretaría sólo accede a documentos de profesionales con asociación ACTIVA (tabla, Storage, API directa, historial de envíos); sin profesional o de otro profesional no existen; al desactivar la asociación lo pierde al instante y al reactivarla lo recupera', 'OK');
END $$;

-- ===== 4) MÉDICO con acceso clínico: escrituras, titularidad y contenido firmado =====
DO $$ DECLARE a record; ok boolean; n int; BEGIN
  SELECT * INTO a FROM t_actores; PERFORM pg_temp.claims(a.med);
  PERFORM pg_temp.obj('documents/qa4c_pac_a/med_nuevo.pdf', a.med); PERFORM pg_temp.obj('qa4c_pac_b/med_manual.pdf', a.med);
  PERFORM pg_temp.obj('documents/qa4c_pac_c/r1.pdf', a.med); PERFORM pg_temp.obj('documents/qa4c_pac_a/med_r2.pdf', a.med);
  -- 4.1 altas: paciente con acceso clínico a nombre propio, o sin profesional; imagen clínica a clinical-images/ (visible como archivo propio hasta que tenga fila)
  INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, professional_id) VALUES
    ('qa4c_pac_a','Informe','QA4C med 1','documents/qa4c_pac_a/med_nuevo.pdf','m.pdf','application/pdf', a.prof);
  INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type) VALUES
    ('qa4c_pac_b','Estudio','QA4C med 2','qa4c_pac_b/med_manual.pdf','m.pdf','application/pdf');
  PERFORM pg_temp.obj('clinical-images/qa4c_pac_a/med.jpg', a.med);
  SELECT count(*) INTO n FROM storage.objects WHERE name = 'clinical-images/qa4c_pac_a/med.jpg';
  IF n <> 1 THEN RAISE EXCEPTION 'FALLA 4.1: el médico no ve la imagen clínica que acaba de subir'; END IF;
  SELECT count(*) INTO n FROM public.cardiolink_patient_documents WHERE title IN ('QA4C med 1','QA4C med 2') AND uploaded_by IS DISTINCT FROM a.med;
  IF n <> 0 THEN RAISE EXCEPTION 'FALLA 4.1b: la autoría de los documentos del médico no quedó a su nombre'; END IF;
  -- 4.2 rechazos: paciente sin acceso clínico; profesional ajeno; archivo AJENO (huérfano de otro; archivo de otro con fila) y archivo del paciente equivocado
  ok := false; BEGIN INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, professional_id)
      VALUES ('qa4c_pac_c','Informe','QA4C med r1','documents/qa4c_pac_c/r1.pdf','r.pdf','application/pdf', a.prof); ok := true; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 4.2a: el médico subió un documento a un paciente sin acceso clínico'; END IF;
  ok := false; BEGIN INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, professional_id)
      VALUES ('qa4c_pac_a','Informe','QA4C med r2','documents/qa4c_pac_a/med_r2.pdf','r.pdf','application/pdf','qa4c_prof_otro'); ok := true; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 4.2b: el médico creó un documento a nombre de otro profesional'; END IF;
  ok := false; BEGIN INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, professional_id)
      VALUES ('qa4c_pac_a','Informe','QA4C med r3','documents/qa4c_pac_a/huerfano.pdf','r.pdf','application/pdf', a.prof); ok := true; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 4.2c: el médico creó una fila sobre el archivo huérfano de otro usuario'; END IF;
  ok := false; BEGIN INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, professional_id)
      VALUES ('qa4c_pac_a','Informe','QA4C med r4','documents/qa4c_pac_a/subida.pdf','r.pdf','application/pdf', a.prof); ok := true; EXCEPTION WHEN insufficient_privilege OR unique_violation THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 4.2d: el médico creó una fila sobre el archivo (con fila) de otro usuario'; END IF;
  ok := false; BEGIN INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, professional_id)
      VALUES ('qa4c_pac_b','Informe','QA4C med r5','documents/qa4c_pac_a/med_r2.pdf','r.pdf','application/pdf', a.prof); ok := true; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 4.2e: el médico asoció un archivo del paciente A a una fila del paciente B'; END IF;
  INSERT INTO t_res VALUES ('30 médico: altas a nombre propio con acceso clínico (autoría del servidor); rechazado sin acceso clínico, a nombre de otro, sobre archivos ajenos y con archivo de otro paciente', 'OK');
END $$;

DO $$ DECLARE a record; ok boolean; n int; BEGIN
  SELECT * INTO a FROM t_actores; PERFORM pg_temp.claims(a.med);
  -- 4.3 titular (fila 'a estudio', profesional = el suyo): puede retitular; NO puede cambiar paciente, archivo, tipo, autor ni "firmar" una fila subida a mano
  UPDATE public.cardiolink_patient_documents SET title = 'QA4C a estudio (retitulado)', description = 'nota' WHERE title = 'QA4C a estudio'; GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'FALLA 4.3a: el titular no pudo retitular su documento (%)', n; END IF;
  ok := false; BEGIN UPDATE public.cardiolink_patient_documents SET document_type = 'Informe' WHERE title = 'QA4C a estudio (retitulado)'; ok := true; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 4.3b: el médico cambió el tipo de un documento'; END IF;
  ok := false; BEGIN UPDATE public.cardiolink_patient_documents SET patient_id = 'qa4c_pac_b' WHERE title = 'QA4C a estudio (retitulado)'; ok := true; EXCEPTION WHEN insufficient_privilege OR raise_exception THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 4.3c: el médico reasignó un documento a otro paciente'; END IF;
  ok := false; BEGIN UPDATE public.cardiolink_patient_documents SET storage_path = 'documents/qa4c_pac_a/otro.pdf' WHERE title = 'QA4C a estudio (retitulado)'; ok := true; EXCEPTION WHEN insufficient_privilege OR raise_exception THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 4.3d: el médico cambió el archivo al que apunta un documento'; END IF;
  ok := false; BEGIN UPDATE public.cardiolink_patient_documents SET uploaded_by = a.own WHERE title = 'QA4C a estudio (retitulado)'; ok := true; EXCEPTION WHEN insufficient_privilege OR raise_exception THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 4.3e: el médico reasignó la autoría de un documento'; END IF;
  ok := false; BEGIN UPDATE public.cardiolink_patient_documents SET source_payload = '{"v":2}'::jsonb, source_document_id = 'qa4c_falso' WHERE title = 'QA4C a estudio (retitulado)'; ok := true; EXCEPTION WHEN insufficient_privilege OR raise_exception THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 4.3f: el médico "firmó" a posteriori un PDF subido a mano'; END IF;
  ok := false; BEGIN UPDATE public.cardiolink_patient_documents SET original_filename = 'otro.pdf', size_bytes = 1, mime_type = 'application/x-otro' WHERE title = 'QA4C a estudio (retitulado)'; ok := true; EXCEPTION WHEN insufficient_privilege OR raise_exception THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 4.3g: el médico cambió nombre, tamaño o tipo MIME del archivo'; END IF;
  -- 4.4 con acceso clínico pero NO titular (informe de otro profesional): no puede retitular, pero SÍ vincularlo a la atención/evolución (único UPDATE que hace la app)
  ok := false; BEGIN UPDATE public.cardiolink_patient_documents SET title = 'MODIFICADO POR OTRO' WHERE title = 'QA4C a informe'; ok := true; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 4.4a: el médico retituló el documento de otro profesional'; END IF;
  UPDATE public.cardiolink_patient_documents SET evolution_id = 'qa4c_evo_a2', attention_id = '__t_qa4c_a' WHERE title = 'QA4C a informe'; GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'FALLA 4.4b: el médico con acceso clínico no pudo vincular el estudio a su evolución (%)', n; END IF;
  UPDATE public.cardiolink_patient_documents SET evolution_id = NULL, attention_id = NULL WHERE title = 'QA4C a informe'; GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'FALLA 4.4c: el médico con acceso clínico no pudo desvincular el estudio (%)', n; END IF;
  -- 4.5 paciente SIN acceso clínico: UPDATE/DELETE afectan 0 filas (ni siquiera lo ve)
  UPDATE public.cardiolink_patient_documents SET attention_id = 'qa4c_att' WHERE title = 'QA4C c informe'; GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FALLA 4.5a: el médico actualizó un documento de un paciente sin acceso clínico (%)', n; END IF;
  DELETE FROM public.cardiolink_patient_documents WHERE title IN ('QA4C c informe','QA4C a informe'); GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FALLA 4.5b: el médico borró documentos que no son suyos (%)', n; END IF;
  -- 4.6 CONTENIDO FIRMADO ('a cert', emitido, del profesional del médico): ni el titular cambia tipo, profesional ni fecha; sí puede retitular
  ok := false; BEGIN UPDATE public.cardiolink_patient_documents SET document_type = 'Orden' WHERE title = 'QA4C a cert'; ok := true; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 4.6a: se cambió el tipo de un documento emitido'; END IF;
  ok := false; BEGIN UPDATE public.cardiolink_patient_documents SET document_date = current_date - 30 WHERE title = 'QA4C a cert'; ok := true; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 4.6b: se cambió la fecha de un documento emitido'; END IF;
  ok := false; BEGIN UPDATE public.cardiolink_patient_documents SET source_payload = '{"v":2,"x":1}'::jsonb WHERE title = 'QA4C a cert'; ok := true; EXCEPTION WHEN insufficient_privilege OR raise_exception THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 4.6c: se reescribió el contenido de un documento emitido'; END IF;
  INSERT INTO t_res VALUES ('31 médico: titular retitula pero no cambia paciente/archivo/tipo/autor ni firma a posteriori; con acceso clínico sólo vincula atención/evolución; sin acceso 0 filas; documento emitido inmutable', 'OK');
END $$;

-- ===== 4b) VÍNCULOS con la atención / evolución: destino existente, del MISMO paciente y (médicos) PROPIO; desvincular =====
DO $$ DECLARE a record; ok boolean; n int; BEGIN
  SELECT * INTO a FROM t_actores;
  -- ---- como MÉDICO (profesional del fixture) ----
  PERFORM pg_temp.claims(a.med);
  -- 4b.1 vínculo LEGÍTIMO: evolución y atención propias del MISMO paciente (documento ajeno del paciente A, al que el médico tiene acceso clínico)
  UPDATE public.cardiolink_patient_documents SET evolution_id = 'qa4c_evo_a', attention_id = '__t_qa4c_a' WHERE title = 'QA4C a informe'; GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'FALLA 4b.1: el vínculo legítimo (evolución y atención propias, mismo paciente) fue rechazado (%)', n; END IF;
  -- 4b.2 DESVINCULACIÓN legítima de un vínculo propio
  UPDATE public.cardiolink_patient_documents SET evolution_id = NULL, attention_id = NULL WHERE title = 'QA4C a informe'; GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'FALLA 4b.2: no se pudo desvincular un vínculo propio (%)', n; END IF;
  -- 4b.3 vínculo hacia OTRO PACIENTE: evolución propia pero del paciente B / atención propia del paciente B
  ok := false; BEGIN UPDATE public.cardiolink_patient_documents SET evolution_id = 'qa4c_evo_b' WHERE title = 'QA4C a informe'; ok := true; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 4b.3a: se vinculó el documento del paciente A a una evolución del paciente B'; END IF;
  ok := false; BEGIN UPDATE public.cardiolink_patient_documents SET attention_id = '__t_qa4c_b' WHERE title = 'QA4C a informe'; ok := true; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 4b.3b: se vinculó el documento del paciente A a una atención del paciente B'; END IF;
  -- 4b.4 vínculo hacia EVOLUCIÓN / ATENCIÓN AJENA (mismo paciente, otro profesional) y hacia destinos inexistentes
  ok := false; BEGIN UPDATE public.cardiolink_patient_documents SET evolution_id = 'qa4c_evo_x' WHERE title = 'QA4C a informe'; ok := true; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 4b.4a: el médico vinculó un documento a la evolución de OTRO profesional'; END IF;
  ok := false; BEGIN UPDATE public.cardiolink_patient_documents SET attention_id = '__t_qa4c_x' WHERE title = 'QA4C a informe'; ok := true; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 4b.4b: el médico vinculó un documento a la atención de OTRO profesional'; END IF;
  ok := false; BEGIN UPDATE public.cardiolink_patient_documents SET evolution_id = 'qa4c_evo_inexistente' WHERE title = 'QA4C a informe'; ok := true; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 4b.4c: se vinculó a una evolución inexistente'; END IF;
  ok := false; BEGIN UPDATE public.cardiolink_patient_documents SET attention_id = 'qa4c_att_inexistente' WHERE title = 'QA4C a informe'; ok := true; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 4b.4d: se vinculó a una atención inexistente'; END IF;
  -- 4b.5 ALTA con vínculo: propio y del mismo paciente entra; ajeno, de otro paciente o inexistente se rechaza
  PERFORM pg_temp.obj('documents/qa4c_pac_a/vinc1.pdf', a.med); PERFORM pg_temp.obj('documents/qa4c_pac_a/vinc2.pdf', a.med); PERFORM pg_temp.obj('documents/qa4c_pac_a/vinc3.pdf', a.med); PERFORM pg_temp.obj('documents/qa4c_pac_a/vinc4.pdf', a.med);
  INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, professional_id, evolution_id, attention_id)
    VALUES ('qa4c_pac_a','Estudio','QA4C vinc ok','documents/qa4c_pac_a/vinc1.pdf','v.pdf','application/pdf', a.prof, 'qa4c_evo_a', '__t_qa4c_a');
  ok := false; BEGIN INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, professional_id, evolution_id)
      VALUES ('qa4c_pac_a','Estudio','QA4C vinc ajena','documents/qa4c_pac_a/vinc2.pdf','v.pdf','application/pdf', a.prof, 'qa4c_evo_x'); ok := true; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 4b.5a: se creó un documento vinculado a la evolución de otro profesional'; END IF;
  ok := false; BEGIN INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, professional_id, evolution_id)
      VALUES ('qa4c_pac_a','Estudio','QA4C vinc otro paciente','documents/qa4c_pac_a/vinc3.pdf','v.pdf','application/pdf', a.prof, 'qa4c_evo_b'); ok := true; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 4b.5b: se creó un documento vinculado a la evolución de otro paciente'; END IF;
  ok := false; BEGIN INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, professional_id, attention_id)
      VALUES ('qa4c_pac_a','Estudio','QA4C vinc atencion inexistente','documents/qa4c_pac_a/vinc4.pdf','v.pdf','application/pdf', a.prof, 'qa4c_att_inexistente'); ok := true; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 4b.5c: se creó un documento vinculado a una atención inexistente'; END IF;
  -- ---- como OWNER/ADMIN: existencia y mismo paciente (sin exigir que sea propio) ----
  PERFORM pg_temp.claims(a.own);
  UPDATE public.cardiolink_patient_documents SET evolution_id = 'qa4c_evo_x' WHERE title IN ('QA4C a ecg','QA4C a estudio (retitulado)'); GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 2 THEN RAISE EXCEPTION 'FALLA 4b.6a: owner/admin no pudo vincular a la evolución de otro profesional del MISMO paciente (%)', n; END IF;
  ok := false; BEGIN UPDATE public.cardiolink_patient_documents SET evolution_id = 'qa4c_evo_c' WHERE title = 'QA4C a ecg'; ok := true; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 4b.6b: owner/admin vinculó a una evolución de OTRO paciente'; END IF;
  ok := false; BEGIN UPDATE public.cardiolink_patient_documents SET attention_id = 'qa4c_att_inexistente' WHERE title = 'QA4C a ecg'; ok := true; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 4b.6c: owner/admin vinculó a una atención inexistente'; END IF;
  -- ---- de nuevo MÉDICO: un vínculo AJENO ('a ecg', de otro profesional, no titular) no se suelta ni se reemplaza; el titular ('a estudio') sí puede soltar el suyo ----
  PERFORM pg_temp.claims(a.med);
  ok := false; BEGIN UPDATE public.cardiolink_patient_documents SET evolution_id = NULL WHERE title = 'QA4C a ecg'; ok := true; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 4b.7a: un médico no titular soltó el vínculo de otro profesional'; END IF;
  ok := false; BEGIN UPDATE public.cardiolink_patient_documents SET evolution_id = 'qa4c_evo_a' WHERE title = 'QA4C a ecg'; ok := true; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 4b.7b: un médico no titular reemplazó el vínculo de otro profesional'; END IF;
  UPDATE public.cardiolink_patient_documents SET evolution_id = NULL WHERE title = 'QA4C a estudio (retitulado)'; GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'FALLA 4b.7c: el titular no pudo soltar un vínculo (%)', n; END IF;
  -- ---- como SECRETARÍA: no vincula evolución (política); puede asociar una atención VÁLIDA del mismo paciente, no la de otro paciente ----
  PERFORM pg_temp.claims(a.sec);
  PERFORM pg_temp.obj('documents/qa4c_pac_a/vinc5.pdf', a.sec); PERFORM pg_temp.obj('documents/qa4c_pac_a/vinc6.pdf', a.sec); PERFORM pg_temp.obj('documents/qa4c_pac_a/vinc7.pdf', a.sec);
  INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, professional_id, attention_id)
    VALUES ('qa4c_pac_a','Estudio','QA4C sec vinc ok','documents/qa4c_pac_a/vinc5.pdf','v.pdf','application/pdf', a.prof, '__t_qa4c_a');
  ok := false; BEGIN INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, professional_id, attention_id)
      VALUES ('qa4c_pac_a','Estudio','QA4C sec vinc otro paciente','documents/qa4c_pac_a/vinc6.pdf','v.pdf','application/pdf', a.prof, '__t_qa4c_b'); ok := true; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 4b.8a: Secretaría vinculó un documento a la atención de otro paciente'; END IF;
  ok := false; BEGIN INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, professional_id, evolution_id)
      VALUES ('qa4c_pac_a','Estudio','QA4C sec vinc evolucion','documents/qa4c_pac_a/vinc7.pdf','v.pdf','application/pdf', a.prof, 'qa4c_evo_a'); ok := true; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 4b.8b: Secretaría vinculó un documento a una evolución'; END IF;
  INSERT INTO t_res VALUES ('32 vínculos documentales: legítimo, desvinculación, otro paciente, evolución/atención ajena e inexistente (médico), owner/admin (mismo paciente), vínculo ajeno protegido, Secretaría', 'OK');
END $$;

-- ===== 4c) ASOCIACIÓN MANUAL paciente-médico con la tabla REAL cardiolink_paciente_profesionales_v1 (el paciente D no tiene evoluciones ni atenciones) =====
RESET ROLE;
DO $$
DECLARE a record; c record; v text; cols text; vals text; col_pac text; col_prof text; col_user text; col_act text; todas text;
BEGIN
  SELECT * INTO a FROM t_actores;
  IF to_regclass('public.cardiolink_paciente_profesionales_v1') IS NULL THEN RAISE EXCEPTION 'FALLA 4c.0: no existe la tabla de asociación manual cardiolink_paciente_profesionales_v1'; END IF;
  SELECT string_agg(column_name || ':' || data_type, ', ' ORDER BY ordinal_position) INTO todas FROM information_schema.columns WHERE table_schema='public' AND table_name='cardiolink_paciente_profesionales_v1';
  SELECT column_name INTO col_pac  FROM information_schema.columns WHERE table_schema='public' AND table_name='cardiolink_paciente_profesionales_v1' AND column_name IN ('paciente_id','patient_id') LIMIT 1;
  SELECT column_name INTO col_prof FROM information_schema.columns WHERE table_schema='public' AND table_name='cardiolink_paciente_profesionales_v1' AND column_name IN ('profesional_id','professional_id') LIMIT 1;
  SELECT column_name INTO col_user FROM information_schema.columns WHERE table_schema='public' AND table_name='cardiolink_paciente_profesionales_v1' AND column_name IN ('medico_user_id','profesional_user_id','user_id') LIMIT 1;
  SELECT column_name INTO col_act  FROM information_schema.columns WHERE table_schema='public' AND table_name='cardiolink_paciente_profesionales_v1' AND column_name IN ('activo','active','vigente') AND data_type = 'boolean' LIMIT 1;
  IF col_pac IS NULL OR (col_prof IS NULL AND col_user IS NULL) THEN
    RAISE EXCEPTION 'FALLA 4c.0b: no se pudieron identificar las columnas paciente/profesional de cardiolink_paciente_profesionales_v1 (columnas reales: %). Ajustar el mapeo de esta prueba', todas; END IF;
  cols := quote_ident(col_pac); vals := quote_literal('qa4c_pac_d');
  IF col_prof IS NOT NULL THEN cols := cols || ',' || quote_ident(col_prof); vals := vals || ',' || quote_literal(a.prof); END IF;
  IF col_user IS NOT NULL THEN cols := cols || ',' || quote_ident(col_user); vals := vals || ',' || quote_literal(a.med::text) || '::uuid'; END IF;
  IF col_act  IS NOT NULL THEN cols := cols || ',' || quote_ident(col_act);  vals := vals || ',true'; END IF;
  FOR c IN SELECT column_name, data_type FROM information_schema.columns
            WHERE table_schema='public' AND table_name='cardiolink_paciente_profesionales_v1' AND is_nullable='NO' AND column_default IS NULL
              AND column_name NOT IN (col_pac, coalesce(col_prof,''), coalesce(col_user,''), coalesce(col_act,'')) ORDER BY ordinal_position LOOP
    cols := cols || ',' || quote_ident(c.column_name);
    IF c.data_type IN ('text','character varying','character') THEN v := quote_literal('QA4C asociacion sintetica de prueba');
    ELSIF c.data_type LIKE 'timestamp%' THEN v := 'now()';
    ELSIF c.data_type = 'date' THEN v := 'current_date';
    ELSIF c.data_type = 'boolean' THEN v := 'true';
    ELSIF c.data_type IN ('integer','bigint','smallint','numeric') THEN v := '0';
    ELSIF c.data_type = 'uuid' THEN v := CASE WHEN c.column_name ~ '(user|_by|por)' THEN quote_literal(a.own::text) || '::uuid' ELSE 'gen_random_uuid()' END;
    ELSIF c.data_type IN ('jsonb','json') THEN v := quote_literal('{}') || '::' || c.data_type;
    ELSE RAISE EXCEPTION 'FALLA 4c.0c: columna obligatoria % (%) de cardiolink_paciente_profesionales_v1 sin valor sintético definido (columnas reales: %)', c.column_name, c.data_type, todas;
    END IF;
    vals := vals || ',' || v;
  END LOOP;
  CREATE TEMP TABLE IF NOT EXISTS t_asoc(col_pac text, col_act text);
  DELETE FROM t_asoc; INSERT INTO t_asoc VALUES (col_pac, col_act);
  -- sin asociación: el médico NO ve el documento del paciente D
  SET LOCAL ROLE authenticated; PERFORM pg_temp.claims(a.med);
  IF (SELECT count(*) FROM public.cardiolink_patient_documents WHERE title = 'QA4C d informe') <> 0 THEN RAISE EXCEPTION 'FALLA 4c.1: el médico ve un documento de un paciente sin asociación ni atención ni evolución'; END IF;
  IF (SELECT count(*) FROM storage.objects WHERE name = 'documents/qa4c_pac_d/informe_d.pdf') <> 0 THEN RAISE EXCEPTION 'FALLA 4c.1b: el médico ve el archivo de un paciente sin asociación'; END IF;
  RESET ROLE;
  -- se crea la asociación manual ACTIVA con la tabla real
  EXECUTE format('INSERT INTO public.cardiolink_paciente_profesionales_v1(%s) VALUES (%s)', cols, vals);
  SET LOCAL ROLE authenticated; PERFORM pg_temp.claims(a.med);
  IF (SELECT count(*) FROM public.cardiolink_patient_documents WHERE title = 'QA4C d informe') <> 1 THEN RAISE EXCEPTION 'FALLA 4c.2: con la asociación manual activa el médico no ve el documento del paciente'; END IF;
  IF (SELECT count(*) FROM storage.objects WHERE name = 'documents/qa4c_pac_d/informe_d.pdf') <> 1 THEN RAISE EXCEPTION 'FALLA 4c.2b: con la asociación manual activa el médico no ve el archivo'; END IF;
  PERFORM pg_temp.obj('documents/qa4c_pac_d/med_d.pdf', a.med);
  INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, professional_id)
    VALUES ('qa4c_pac_d','Estudio','QA4C d med','documents/qa4c_pac_d/med_d.pdf','m.pdf','application/pdf', a.prof);
  RESET ROLE;
END $$;
-- se desactiva la asociación (columna booleana si existe; si no, se borra la fila de prueba) y el acceso desaparece
DO $$
DECLARE a record; t record; ok boolean;
BEGIN
  SELECT * INTO a FROM t_actores; SELECT * INTO t FROM t_asoc;
  IF t.col_act IS NOT NULL THEN EXECUTE format('UPDATE public.cardiolink_paciente_profesionales_v1 SET %I = false WHERE %I = %L', t.col_act, t.col_pac, 'qa4c_pac_d');
  ELSE EXECUTE format('DELETE FROM public.cardiolink_paciente_profesionales_v1 WHERE %I = %L', t.col_pac, 'qa4c_pac_d'); END IF;
  SET LOCAL ROLE authenticated; PERFORM pg_temp.claims(a.med);
  IF (SELECT count(*) FROM public.cardiolink_patient_documents WHERE title = 'QA4C d informe') <> 0 THEN RAISE EXCEPTION 'FALLA 4c.3: desactivada la asociación manual el médico sigue viendo el documento ajeno'; END IF;
  IF (SELECT count(*) FROM public.cardiolink_patient_documents WHERE title = 'QA4C d med') <> 1 THEN RAISE EXCEPTION 'FALLA 4c.3b: el médico dejó de ver su PROPIO documento (titularidad)'; END IF;
  PERFORM pg_temp.obj('documents/qa4c_pac_d/med_d2.pdf', a.med);
  ok := false; BEGIN INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, professional_id)
      VALUES ('qa4c_pac_d','Estudio','QA4C d med r','documents/qa4c_pac_d/med_d2.pdf','m.pdf','application/pdf', a.prof); ok := true; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 4c.4: desactivada la asociación manual el médico pudo subir un documento al paciente'; END IF;
  INSERT INTO t_res VALUES ('33 asociación manual (tabla real cardiolink_paciente_profesionales_v1): sin asociación no hay acceso; con la asociación activa ve y sube; desactivada vuelve a no tener acceso (conserva lo propio)', 'OK');
  RESET ROLE;
END $$;
SET LOCAL ROLE authenticated;

-- ===== 5) OWNER/ADMIN =====
DO $$ DECLARE a record; ok boolean; n int; BEGIN
  SELECT * INTO a FROM t_actores; PERFORM pg_temp.claims(a.own);
  INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, professional_id) VALUES
    ('qa4c_pac_c','Imagen clínica','QA4C own 1','clinical-images/qa4c_pac_c/own.jpg','o.jpg','image/jpeg','qa4c_prof_otro'),
    ('qa4c_pac_c','Mensaje a colega','QA4C own 2','documents/qa4c_pac_c/own.pdf','o.pdf','application/pdf','qa4c_prof_otro');
  PERFORM pg_temp.obj('clinical-images/qa4c_pac_c/own_obj.jpg', a.own);
  UPDATE public.cardiolink_patient_documents SET title = 'QA4C a ecg (admin)' WHERE title = 'QA4C a ecg'; GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'FALLA 5.1: owner/admin no pudo retitular (%)', n; END IF;
  UPDATE public.cardiolink_patient_documents SET document_type = 'Estudio' WHERE title = 'QA4C a ecg (admin)'; GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'FALLA 5.2: owner/admin no pudo corregir el tipo de un documento NO emitido (%)', n; END IF;
  ok := false; BEGIN UPDATE public.cardiolink_patient_documents SET document_type = 'Orden' WHERE title = 'QA4C a cert'; ok := true; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 5.3a: owner/admin cambió el tipo de un documento emitido'; END IF;
  ok := false; BEGIN UPDATE public.cardiolink_patient_documents SET professional_id = 'qa4c_prof_otro' WHERE title = 'QA4C a cert'; ok := true; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 5.3b: owner/admin cambió el profesional de un documento emitido'; END IF;
  -- 5.4 la IDENTIDAD del archivo y del autor es inmutable también para owner/admin, y también en los PDF subidos a mano
  ok := false; BEGIN UPDATE public.cardiolink_patient_documents SET patient_id = 'qa4c_pac_c' WHERE title = 'QA4C a cert'; ok := true; EXCEPTION WHEN insufficient_privilege OR raise_exception THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 5.4a: owner/admin reasignó un documento emitido a otro paciente'; END IF;
  ok := false; BEGIN UPDATE public.cardiolink_patient_documents SET patient_id = 'qa4c_pac_c' WHERE title = 'QA4C a ecg (admin)'; ok := true; EXCEPTION WHEN insufficient_privilege OR raise_exception THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 5.4b: owner/admin reasignó un PDF subido a mano a otro paciente'; END IF;
  ok := false; BEGIN UPDATE public.cardiolink_patient_documents SET storage_path = 'documents/qa4c_pac_a/otro.pdf' WHERE title = 'QA4C a ecg (admin)'; ok := true; EXCEPTION WHEN insufficient_privilege OR raise_exception THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 5.4c: owner/admin cambió el archivo de un PDF subido a mano'; END IF;
  ok := false; BEGIN UPDATE public.cardiolink_patient_documents SET uploaded_by = a.med WHERE title = 'QA4C a ecg (admin)'; ok := true; EXCEPTION WHEN insufficient_privilege OR raise_exception THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 5.4d: owner/admin reasignó la autoría'; END IF;
  ok := false; BEGIN UPDATE public.cardiolink_patient_documents SET mime_type = 'application/x-otro', size_bytes = 5 WHERE title = 'QA4C a ecg (admin)'; ok := true; EXCEPTION WHEN insufficient_privilege OR raise_exception THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 5.4e: owner/admin cambió el tipo MIME o el tamaño del archivo'; END IF;
  ok := false; BEGIN UPDATE public.cardiolink_patient_documents SET source_payload = '{"v":2}'::jsonb, source_document_id = 'qa4c_falso2', source_content_hash = 'h' WHERE title = 'QA4C a ecg (admin)'; ok := true; EXCEPTION WHEN insufficient_privilege OR raise_exception THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 5.4f: owner/admin "firmó" a posteriori un PDF subido a mano'; END IF;
  -- 5.5 las VERSIONES NUEVAS siguen siendo posibles: una edición del documento emitido es una fila NUEVA (mismo source_document_id, otro hash, otro archivo)
  INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, professional_id, source_document_id, source_content_hash, source_payload)
    VALUES ('qa4c_pac_a','Certificado','QA4C a cert v2','documents/qa4c_pac_a/cert_v2.pdf','f.pdf','application/pdf', a.prof, 'qa4c_doc1', 'hash2', '{"v":2,"rev":2}'::jsonb);
  SELECT count(*) INTO n FROM public.cardiolink_patient_documents WHERE source_document_id = 'qa4c_doc1';
  IF n <> 2 THEN RAISE EXCEPTION 'FALLA 5.5: no se pudo emitir la versión nueva de un documento (%)', n; END IF;
  INSERT INTO t_res VALUES ('40 owner/admin: sin regresión (crea cualquier tipo, retitula, corrige tipo de lo no emitido, emite versiones nuevas) y la identidad del archivo/autor y lo emitido son inmutables también para ellos', 'OK');
END $$;

-- ===== 5b) NUEVAS VERSIONES (source_document_id): conservan paciente y profesional de la familia y las crea quien está autorizado para ese profesional; el servidor fija created_at =====
DO $$ DECLARE a record; ok boolean; n int; t timestamptz; ult text; BEGIN
  SELECT * INTO a FROM t_actores;
  -- ---- como SECRETARÍA (autorizada para el profesional del médico) ----
  PERFORM pg_temp.claims(a.sec);
  PERFORM pg_temp.obj('documents/qa4c_pac_a/ver_sec.pdf', a.sec); PERFORM pg_temp.obj('documents/qa4c_pac_c/ver_c.pdf', a.sec); PERFORM pg_temp.obj('documents/qa4c_pac_a/ver_otro.pdf', a.sec);
  PERFORM pg_temp.obj('documents/qa4c_pac_a/ver_nueva.pdf', a.sec); PERFORM pg_temp.obj('documents/qa4c_pac_a/ver_nueva2.pdf', a.sec);
  INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, professional_id, source_document_id, source_payload)
    VALUES ('qa4c_pac_a','Certificado','QA4C ver sec','documents/qa4c_pac_a/ver_sec.pdf','v.pdf','application/pdf', a.prof, 'qa4c_doc1', '{"v":2,"rev":3}'::jsonb);
  ok := false; BEGIN INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, professional_id, source_document_id, source_payload)
      VALUES ('qa4c_pac_c','Certificado','QA4C ver otro paciente','documents/qa4c_pac_c/ver_c.pdf','v.pdf','application/pdf', a.prof, 'qa4c_doc1', '{"v":2}'::jsonb); ok := true; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 5b.1: se creó una versión de un documento en OTRO paciente'; END IF;
  -- reclamar la familia de un documento de OTRO profesional con un profesional que ella sí tiene autorizado
  ok := false; BEGIN INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, professional_id, source_document_id, source_payload)
      VALUES ('qa4c_pac_a','Certificado','QA4C ver ajena','documents/qa4c_pac_a/ver_otro.pdf','v.pdf','application/pdf', a.prof, 'qa4c_doc_otro', '{"v":2}'::jsonb); ok := true; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 5b.2: Secretaría emitió una versión nueva del documento de OTRO profesional reclamando su source_document_id'; END IF;
  -- el servidor fija created_at: ni futuro (para ser "la vigente" para siempre) ni pasado
  INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, professional_id, source_document_id, source_payload, created_at)
    VALUES ('qa4c_pac_a','Certificado','QA4C fecha futura','documents/qa4c_pac_a/ver_nueva.pdf','v.pdf','application/pdf', a.prof, 'qa4c_doc_nueva', '{"v":2}'::jsonb, '2999-01-01T00:00:00Z');
  INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, professional_id, source_document_id, source_payload, created_at)
    VALUES ('qa4c_pac_a','Certificado','QA4C fecha pasada','documents/qa4c_pac_a/ver_nueva2.pdf','v.pdf','application/pdf', a.prof, 'qa4c_doc_nueva2', '{"v":2}'::jsonb, '2000-01-01T00:00:00Z');
  SELECT count(*) INTO n FROM public.cardiolink_patient_documents WHERE title IN ('QA4C fecha futura','QA4C fecha pasada') AND created_at BETWEEN now() - interval '1 hour' AND now() + interval '1 hour';
  IF n <> 2 THEN RAISE EXCEPTION 'FALLA 5b.3: el cliente pudo fijar created_at (% de 2 quedaron con la hora del servidor)', n; END IF;
  -- ---- como MÉDICO ----
  PERFORM pg_temp.claims(a.med);
  PERFORM pg_temp.obj('documents/qa4c_pac_a/ver_med.pdf', a.med); PERFORM pg_temp.obj('documents/qa4c_pac_a/ver_med2.pdf', a.med); PERFORM pg_temp.obj('documents/qa4c_pac_a/ver_med3.pdf', a.med); PERFORM pg_temp.obj('documents/qa4c_pac_a/ver_med4.pdf', a.med); PERFORM pg_temp.obj('documents/qa4c_pac_a/ver_med5.pdf', a.med);
  INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, professional_id, source_document_id, source_payload)
    VALUES ('qa4c_pac_a','Certificado','QA4C ver med','documents/qa4c_pac_a/ver_med.pdf','v.pdf','application/pdf', a.prof, 'qa4c_doc1', '{"v":2,"rev":4}'::jsonb);
  ok := false; BEGIN INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, professional_id, source_document_id, source_payload)
      VALUES ('qa4c_pac_a','Certificado','QA4C ver med ajena','documents/qa4c_pac_a/ver_med2.pdf','v.pdf','application/pdf', a.prof, 'qa4c_doc_otro', '{"v":2}'::jsonb); ok := true; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 5b.4: el médico emitió una versión del documento de OTRO profesional con su propio profesional'; END IF;
  ok := false; BEGIN INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, source_document_id, source_payload)
      VALUES ('qa4c_pac_a','Certificado','QA4C ver med sin prof','documents/qa4c_pac_a/ver_med3.pdf','v.pdf','application/pdf', 'qa4c_doc_otro', '{"v":2}'::jsonb); ok := true; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 5b.5: el médico emitió una versión del documento de otro profesional dejando el profesional vacío'; END IF;
  ok := false; BEGIN INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, source_document_id, source_payload)
      VALUES ('qa4c_pac_a','ECG','QA4C ver med familia sin prof','documents/qa4c_pac_a/ver_med4.pdf','v.pdf','application/pdf', 'qa4c_doc_nulo', '{"v":2}'::jsonb); ok := true; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 5b.6: un médico extendió una familia SIN profesional (sólo owner/admin pueden)'; END IF;
  ok := false; BEGIN INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, professional_id, source_document_id, source_payload)
      VALUES ('qa4c_pac_a','ECG','QA4C ver med familia sin prof 2','documents/qa4c_pac_a/ver_med5.pdf','v.pdf','application/pdf', a.prof, 'qa4c_doc_nulo', '{"v":2}'::jsonb); ok := true; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 5b.7: un médico asignó su profesional a una familia que no lo tenía'; END IF;
  -- ---- como OWNER/ADMIN: puede extender cualquier familia, pero NO cambia su paciente ni su profesional ----
  PERFORM pg_temp.claims(a.own);
  INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, source_document_id, source_payload)
    VALUES ('qa4c_pac_a','ECG','QA4C ver own familia sin prof','documents/qa4c_pac_a/ver_own1.pdf','v.pdf','application/pdf', 'qa4c_doc_nulo', '{"v":2,"rev":2}'::jsonb);
  INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, professional_id, source_document_id, source_payload)
    VALUES ('qa4c_pac_a','Certificado','QA4C ver own otro','documents/qa4c_pac_a/ver_own2.pdf','v.pdf','application/pdf', 'qa4c_prof_otro', 'qa4c_doc_otro', '{"v":2,"rev":2}'::jsonb);
  ok := false; BEGIN INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, professional_id, source_document_id, source_payload)
      VALUES ('qa4c_pac_a','Certificado','QA4C ver own cambia prof','documents/qa4c_pac_a/ver_own3.pdf','v.pdf','application/pdf', 'qa4c_prof_otro', 'qa4c_doc1', '{"v":2}'::jsonb); ok := true; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 5b.8: owner/admin cambió el profesional de una familia de versiones'; END IF;
  ok := false; BEGIN INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, professional_id, source_document_id, source_payload)
      VALUES ('qa4c_pac_c','Certificado','QA4C ver own cambia paciente','documents/qa4c_pac_c/ver_own4.pdf','v.pdf','application/pdf', a.prof, 'qa4c_doc1', '{"v":2}'::jsonb); ok := true; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 5b.9: owner/admin cambió el paciente de una familia de versiones'; END IF;
  -- la versión VIGENTE (la más reciente por source_document_id) es la última emitida por un autorizado: 'QA4C ver med' (la secretaria la había precedido)
  SELECT title INTO ult FROM public.cardiolink_patient_documents WHERE source_document_id = 'qa4c_doc1' ORDER BY created_at DESC LIMIT 1;
  IF ult IS DISTINCT FROM 'QA4C ver med' THEN RAISE EXCEPTION 'FALLA 5b.10: la versión vigente es [%] y debía ser la última emitida por un autorizado', ult; END IF;
  INSERT INTO t_res VALUES ('34 nuevas versiones (source_document_id): sólo con el paciente y el profesional de la familia y por el profesional, su Secretaría autorizada u owner/admin; familia ajena o sin profesional rechazada; created_at fijado por el servidor', 'OK');
END $$;

-- ===== 6) Médico SIN acceso clínico (la secretaria convertida TEMPORALMENTE en médico 'qa4c_prof_b' dentro de la transacción) =====
RESET ROLE;
UPDATE public.cardiolink_user_roles SET base_role = 'medico', professional_id = 'qa4c_prof_b' WHERE user_id = (SELECT sec FROM t_actores);
SET LOCAL ROLE authenticated;
DO $$ DECLARE a record; ok boolean; n int; BEGIN
  SELECT * INTO a FROM t_actores; PERFORM pg_temp.claims(a.sec);
  SELECT count(*) INTO n FROM public.cardiolink_patient_documents WHERE patient_id LIKE 'qa4c\_%' ESCAPE '\';
  IF n <> 0 THEN RAISE EXCEPTION 'FALLA 6.1: un médico sin acceso clínico ve % documentos (esperados 0)', n; END IF;
  SELECT count(*) INTO n FROM storage.objects WHERE bucket_id='patient-documents' AND name LIKE '%qa4c\_pac%' ESCAPE '\' AND owner IS DISTINCT FROM a.sec;
  IF n <> 0 THEN RAISE EXCEPTION 'FALLA 6.2: un médico sin acceso clínico ve % objetos de otros usuarios (esperados 0; sólo puede ver sus propios archivos recién subidos sin fila)', n; END IF;
  PERFORM pg_temp.obj('documents/qa4c_pac_a/b1.pdf', a.sec);
  ok := false; BEGIN INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, professional_id)
      VALUES ('qa4c_pac_a','Informe','QA4C b r1','documents/qa4c_pac_a/b1.pdf','b.pdf','application/pdf','qa4c_prof_b'); ok := true; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 6.3: un médico sin acceso clínico subió un documento a un paciente ajeno'; END IF;
  UPDATE public.cardiolink_patient_documents SET attention_id = 'x' WHERE patient_id LIKE 'qa4c\_%' ESCAPE '\'; GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FALLA 6.4: un médico sin acceso clínico actualizó % documentos', n; END IF;
  INSERT INTO t_res VALUES ('50 médico sin acceso clínico: no ve, no sube y no actualiza documentos ni archivos de pacientes ajenos', 'OK');
END $$;
RESET ROLE;
UPDATE public.cardiolink_user_roles u SET base_role = o.base_role, professional_id = o.professional_id FROM t_rol_orig o WHERE u.user_id = o.user_id AND u.user_id = (SELECT sec FROM t_actores);

-- ===== 7) anon y usuario sin rol =====
SET LOCAL ROLE anon;
DO $$ DECLARE ok boolean; BEGIN
  ok := false; BEGIN PERFORM count(*) FROM public.cardiolink_patient_documents; ok := true; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF ok THEN RAISE EXCEPTION 'FALLA 7a: anon lee la tabla de documentos'; END IF;
  INSERT INTO t_res VALUES ('60 anon sin acceso a la tabla de documentos', 'OK');
END $$;
RESET ROLE;
SET LOCAL ROLE authenticated;
DO $$ DECLARE n int; BEGIN
  PERFORM pg_temp.claims('00000000-0000-0000-0000-000000000000'::uuid);
  SELECT count(*) INTO n FROM public.cardiolink_patient_documents WHERE patient_id LIKE 'qa4c\_%' ESCAPE '\';
  IF n <> 0 THEN RAISE EXCEPTION 'FALLA 7b: un usuario sin rol ve % documentos', n; END IF;
  SELECT count(*) INTO n FROM storage.objects WHERE bucket_id='patient-documents' AND name LIKE '%qa4c\_pac%' ESCAPE '\';
  IF n <> 0 THEN RAISE EXCEPTION 'FALLA 7c: un usuario sin rol ve % objetos', n; END IF;
  INSERT INTO t_res VALUES ('61 usuario autenticado sin rol: 0 documentos y 0 archivos', 'OK');
END $$;

-- ===== 7b) HISTORIAL DE ENVÍOS POR FUNCIÓN (v2.3): cardiolink_historial_envios_documento_v1 es SECURITY DEFINER, así que la RLS no interviene y la autorización de Secretaría está en la propia función.
--          Fixture propio e independiente de las pruebas anteriores (documentos 'QA4C rpc rN' del paciente A, todos con un envío 'document_delivery'):
--            r1 Certificado y r2 ECG de SU profesional asociado (permitidos) · r3 Informe y r4 Informe de OTRO profesional (r4 subido por el médico) · r5 Informe SIN profesional subido por el médico · r6 Informe SIN profesional subido por otro
--            r7 'Imagen clínica', r8 'Mensaje a colega' y r9 ECG bajo clinical-images/, los tres con su profesional asociado (tipo/ruta cerrados) · un envío huérfano (documento inexistente) · un envío de OTRO tipo sobre r1 =====
RESET ROLE;
CREATE TEMP TABLE t_rpc(clave text, id uuid);
GRANT SELECT ON t_rpc TO authenticated;
DO $$ DECLARE a record; BEGIN
  SELECT * INTO a FROM t_actores;
  PERFORM set_config('request.jwt.claims', '', true);  -- (v2.6) fixture SIN sesión: con claims remanentes el trigger de autor pisaría uploaded_by con ese uid
  INSERT INTO public.cardiolink_patient_documents(patient_id, document_type, title, storage_path, original_filename, mime_type, professional_id, uploaded_by) VALUES
    ('qa4c_pac_a', 'Certificado',      'QA4C rpc r1', 'documents/qa4c_pac_a/rpc_r1.pdf',      'f.pdf', 'application/pdf', a.prof,           a.sec),
    ('qa4c_pac_a', 'ECG',              'QA4C rpc r2', 'documents/qa4c_pac_a/rpc_r2.pdf',      'f.pdf', 'application/pdf', a.prof,           a.med),
    ('qa4c_pac_a', 'Informe',          'QA4C rpc r3', 'documents/qa4c_pac_a/rpc_r3.pdf',      'f.pdf', 'application/pdf', 'qa4c_prof_otro', a.own),
    ('qa4c_pac_a', 'Informe',          'QA4C rpc r4', 'documents/qa4c_pac_a/rpc_r4.pdf',      'f.pdf', 'application/pdf', 'qa4c_prof_otro', a.med),
    ('qa4c_pac_a', 'Informe',          'QA4C rpc r5', 'documents/qa4c_pac_a/rpc_r5.pdf',      'f.pdf', 'application/pdf', NULL,             a.med),
    ('qa4c_pac_a', 'Informe',          'QA4C rpc r6', 'documents/qa4c_pac_a/rpc_r6.pdf',      'f.pdf', 'application/pdf', NULL,             a.own),
    ('qa4c_pac_a', 'Imagen clínica',   'QA4C rpc r7', 'clinical-images/qa4c_pac_a/rpc_r7.jpg','f.jpg', 'image/jpeg',      a.prof,           a.own),
    ('qa4c_pac_a', 'Mensaje a colega', 'QA4C rpc r8', 'documents/qa4c_pac_a/rpc_r8.pdf',      'f.pdf', 'application/pdf', a.prof,           a.med),
    ('qa4c_pac_a', 'ECG',              'QA4C rpc r9', 'clinical-images/qa4c_pac_a/rpc_r9.jpg','f.jpg', 'image/jpeg',      a.prof,           a.own);
  INSERT INTO t_rpc SELECT right(title, 2), id FROM public.cardiolink_patient_documents WHERE title LIKE 'QA4C rpc r%';
  IF (SELECT count(*) FROM t_rpc) <> 9 THEN RAISE EXCEPTION 'Fixture 7b: no quedaron los 9 documentos'; END IF;
  INSERT INTO public.cardiolink_communications(tipo, canal, destinatario, recipient_name, recipient_source, message, status, sent_at, created_by, document_id)
    SELECT 'document_delivery', 'whatsapp', 'qa4c-rpc', 'QA4C', 'patient', 'qa4c rpc ' || clave, 'manual_started', now(),
           CASE clave WHEN 'r1' THEN a.med WHEN 'r2' THEN NULL ELSE a.own END, id::text FROM t_rpc;
  INSERT INTO public.cardiolink_communications(tipo, canal, destinatario, recipient_name, recipient_source, message, status, sent_at, created_by, document_id) VALUES
    ('document_delivery', 'whatsapp', 'qa4c-rpc', 'QA4C', 'patient', 'qa4c rpc huerfano', 'manual_started', now(), a.own, '00000000-0000-4000-8000-0000000000ee');
  INSERT INTO public.cardiolink_communications(tipo, canal, destinatario, recipient_name, recipient_source, message, status, sent_at, created_by, document_id)
    SELECT 'manual', 'whatsapp', 'qa4c-rpc', 'QA4C', 'patient', 'qa4c rpc otro tipo r1', 'manual_started', now(), a.own, id::text FROM t_rpc WHERE clave = 'r1';
END $$;
-- claves de los documentos a los que pertenecen los envíos que devuelve la función ('huerfano' = documento inexistente)
CREATE OR REPLACE FUNCTION pg_temp.hist(p_ids text[]) RETURNS text[] LANGUAGE sql AS $$
  SELECT coalesce(array_agg(DISTINCT coalesce(t.clave, 'huerfano')), ARRAY[]::text[])
    FROM public.cardiolink_historial_envios_documento_v1(p_ids) r LEFT JOIN t_rpc t ON t.id::text = r.document_id $$;
CREATE OR REPLACE FUNCTION pg_temp.ids_rpc(VARIADIC p_claves text[]) RETURNS text[] LANGUAGE sql AS $$
  SELECT array_agg(id::text) FROM t_rpc WHERE clave = ANY (p_claves) $$;
CREATE OR REPLACE FUNCTION pg_temp.todos_rpc() RETURNS text[] LANGUAGE sql AS $$
  SELECT array_agg(id::text) || ARRAY['00000000-0000-4000-8000-0000000000ee']::text[] FROM t_rpc $$;
CREATE OR REPLACE FUNCTION pg_temp.mismo(a text[], b text[]) RETURNS boolean LANGUAGE sql AS $$ SELECT a @> b AND b @> a $$;

-- 25) Secretaría consulta el historial de documentos de SU profesional asociado (tipo permitido): lo recibe
SET LOCAL ROLE authenticated;
DO $$ DECLARE a record; n int; BEGIN
  SELECT * INTO a FROM t_actores; PERFORM pg_temp.claims(a.sec);
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.cardiolink_historial_envios_documento_v1(text[])'::regprocedure) THEN RAISE EXCEPTION 'FALLA 25.0: la función debe ser SECURITY DEFINER (esta prueba valida la autorización escrita en la función)'; END IF;
  IF NOT pg_temp.mismo(pg_temp.hist(pg_temp.ids_rpc('r1', 'r2')), ARRAY['r1', 'r2']) THEN RAISE EXCEPTION 'FALLA 25.1: Secretaría no recibe el historial de los documentos de su profesional asociado (%)', pg_temp.hist(pg_temp.ids_rpc('r1', 'r2')); END IF;
  SELECT count(*) INTO n FROM public.cardiolink_historial_envios_documento_v1(pg_temp.ids_rpc('r1'));
  IF n <> 1 THEN RAISE EXCEPTION 'FALLA 25.2: el historial de r1 debe tener 1 fila (el envío de otro tipo no cuenta); tiene %', n; END IF;
  SELECT count(*) INTO n FROM public.cardiolink_historial_envios_documento_v1(pg_temp.ids_rpc('r1')) WHERE NOT creado_por_mi AND NOT automatico AND canal = 'whatsapp' AND status = 'manual_started';
  IF n <> 1 THEN RAISE EXCEPTION 'FALLA 25.3: banderas/columnas de r1 inesperadas'; END IF;
  SELECT count(*) INTO n FROM public.cardiolink_historial_envios_documento_v1(pg_temp.ids_rpc('r2')) WHERE automatico AND NOT creado_por_mi;
  IF n <> 1 THEN RAISE EXCEPTION 'FALLA 25.4: un envío sin created_by debe salir como automático'; END IF;
  INSERT INTO t_res VALUES ('25 historial por función: Secretaría consulta el historial de documentos de su profesional asociado (tipo permitido); solo document_delivery y banderas correctas', 'OK');
END $$;

-- 26) Secretaría pide documentos AJENOS: otro profesional, sin profesional, tipo/ruta cerrados con su profesional, documento inexistente, listas inválidas: nada
DO $$ DECLARE a record; n int; BEGIN
  SELECT * INTO a FROM t_actores; PERFORM pg_temp.claims(a.sec);
  SELECT count(*) INTO n FROM public.cardiolink_historial_envios_documento_v1(pg_temp.ids_rpc('r3', 'r4', 'r5', 'r6'));
  IF n <> 0 THEN RAISE EXCEPTION 'FALLA 26.1: Secretaría recibe % filas del historial de documentos de otro profesional o sin profesional (aunque los haya subido el médico)', n; END IF;
  SELECT count(*) INTO n FROM public.cardiolink_historial_envios_documento_v1(pg_temp.ids_rpc('r7', 'r8', 'r9'));
  IF n <> 0 THEN RAISE EXCEPTION 'FALLA 26.2: Secretaría recibe % filas del historial de Imagen clínica, Mensaje a colega o archivos bajo clinical-images/ de su propio profesional', n; END IF;
  SELECT count(*) INTO n FROM public.cardiolink_historial_envios_documento_v1(ARRAY['00000000-0000-4000-8000-0000000000ee']);
  IF n <> 0 THEN RAISE EXCEPTION 'FALLA 26.3: Secretaría recibe el historial de un documento inexistente (%)', n; END IF;
  IF NOT pg_temp.mismo(pg_temp.hist(pg_temp.todos_rpc()), ARRAY['r1', 'r2']) THEN RAISE EXCEPTION 'FALLA 26.4: pidiendo todos los ids, Secretaría debe recibir SOLO r1 y r2 (recibe %)', pg_temp.hist(pg_temp.todos_rpc()); END IF;
  IF NOT pg_temp.mismo(pg_temp.hist(pg_temp.ids_rpc('r1', 'r3', 'r5', 'r7')), ARRAY['r1']) THEN RAISE EXCEPTION 'FALLA 26.5: pedido mezclado: debe devolver únicamente r1'; END IF;
  SELECT count(*) INTO n FROM public.cardiolink_historial_envios_documento_v1(NULL);
  IF n <> 0 THEN RAISE EXCEPTION 'FALLA 26.6: ids nulos deben dar vacío'; END IF;
  SELECT count(*) INTO n FROM public.cardiolink_historial_envios_documento_v1(ARRAY[]::text[]);
  IF n <> 0 THEN RAISE EXCEPTION 'FALLA 26.7: lista vacía debe dar vacío'; END IF;
  SELECT count(*) INTO n FROM public.cardiolink_historial_envios_documento_v1((SELECT array_agg((SELECT id::text FROM t_rpc WHERE clave = 'r1')) FROM generate_series(1, 501)));
  IF n <> 0 THEN RAISE EXCEPTION 'FALLA 26.8: más de 500 ids debe dar vacío'; END IF;
  INSERT INTO t_res VALUES ('26 historial por función: Secretaría pide documentos ajenos (otro profesional, sin profesional, Imagen clínica / Mensaje a colega / clinical-images de su profesional, inexistente, listas inválidas): no recibe nada', 'OK');
END $$;

-- 27) Asociación DESACTIVADA (como postgres, mismo instante): Secretaría pierde el historial de todos sus documentos
RESET ROLE;
DO $$ DECLARE v_tabla text; BEGIN
  SELECT table_name INTO v_tabla FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('secretaria_user_id','medico_user_id','activo') GROUP BY table_name HAVING count(*) = 3;
  EXECUTE format('UPDATE public.%I SET activo = false WHERE secretaria_user_id = $1', v_tabla) USING (SELECT sec FROM t_actores);
END $$;
SET LOCAL ROLE authenticated;
DO $$ DECLARE a record; n int; BEGIN
  SELECT * INTO a FROM t_actores; PERFORM pg_temp.claims(a.sec);
  SELECT count(*) INTO n FROM public.cardiolink_historial_envios_documento_v1(pg_temp.todos_rpc());
  IF n <> 0 THEN RAISE EXCEPTION 'FALLA 27.1: con la asociación desactivada Secretaría sigue recibiendo % filas del historial', n; END IF;
  SELECT count(*) INTO n FROM public.cardiolink_historial_envios_documento_v1(pg_temp.ids_rpc('r1', 'r2'));
  IF n <> 0 THEN RAISE EXCEPTION 'FALLA 27.2: con la asociación desactivada Secretaría sigue recibiendo el historial de r1/r2 (%)', n; END IF;
  INSERT INTO t_res VALUES ('27 historial por función: con la asociación DESACTIVADA Secretaría pierde de inmediato el historial de los documentos de ese profesional', 'OK');
END $$;

-- 28) Asociación REACTIVADA (estado original de las asociaciones): lo recupera, también al instante
RESET ROLE;
DO $$ DECLARE v_tabla text; BEGIN
  SELECT table_name INTO v_tabla FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('secretaria_user_id','medico_user_id','activo') GROUP BY table_name HAVING count(*) = 3;
  EXECUTE format('UPDATE public.%I a SET activo = o.activo FROM t_asoc_orig o WHERE a.secretaria_user_id = o.secretaria_user_id AND a.medico_user_id = o.medico_user_id', v_tabla);
END $$;
SET LOCAL ROLE authenticated;
DO $$ DECLARE a record; BEGIN
  SELECT * INTO a FROM t_actores; PERFORM pg_temp.claims(a.sec);
  IF NOT pg_temp.mismo(pg_temp.hist(pg_temp.todos_rpc()), ARRAY['r1', 'r2']) THEN RAISE EXCEPTION 'FALLA 28.1: reactivada la asociación, Secretaría no recupera exactamente r1 y r2 (recibe %)', pg_temp.hist(pg_temp.todos_rpc()); END IF;
  INSERT INTO t_res VALUES ('28 historial por función: al REACTIVAR la asociación Secretaría recupera el historial de sus documentos autorizados (y solo esos)', 'OK');
END $$;

-- 29) Owner/admin conserva el acceso administrativo: todo lo pedido (incluso documentos cerrados, sin profesional, de otro profesional e inexistentes)
DO $$ DECLARE a record; n int; BEGIN
  SELECT * INTO a FROM t_actores; PERFORM pg_temp.claims(a.own);
  IF NOT pg_temp.mismo(pg_temp.hist(pg_temp.todos_rpc()), ARRAY['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'huerfano']) THEN RAISE EXCEPTION 'FALLA 29.1: owner/admin debe recibir el historial de todos los documentos pedidos (recibe %)', pg_temp.hist(pg_temp.todos_rpc()); END IF;
  SELECT count(*) INTO n FROM public.cardiolink_historial_envios_documento_v1(pg_temp.todos_rpc());
  IF n <> 10 THEN RAISE EXCEPTION 'FALLA 29.2: owner/admin debe recibir 10 filas (9 documentos + el huérfano; el envío de otro tipo no cuenta), recibe %', n; END IF;
  INSERT INTO t_res VALUES ('29 historial por función: owner/admin conserva el acceso administrativo (todo lo pedido, también documentos cerrados, sin profesional, ajenos e inexistentes)', 'OK');
END $$;

-- 35) Médico: conserva su regla vigente (documentos que emitió él: professional_id propio, o sin profesional y subido por él); lo ajeno, aunque lo haya subido, no
DO $$ DECLARE a record; n int; BEGIN
  SELECT * INTO a FROM t_actores; PERFORM pg_temp.claims(a.med);
  IF NOT pg_temp.mismo(pg_temp.hist(pg_temp.todos_rpc()), ARRAY['r1', 'r2', 'r5', 'r7', 'r8', 'r9']) THEN RAISE EXCEPTION 'FALLA 35.1: el médico debe recibir r1, r2, r5, r7, r8 y r9 (recibe %)', pg_temp.hist(pg_temp.todos_rpc()); END IF;
  SELECT count(*) INTO n FROM public.cardiolink_historial_envios_documento_v1(pg_temp.ids_rpc('r3', 'r4', 'r6'));
  IF n <> 0 THEN RAISE EXCEPTION 'FALLA 35.2: el médico recibe % filas de documentos de otro profesional o sin profesional subidos por otro', n; END IF;
  SELECT count(*) INTO n FROM public.cardiolink_historial_envios_documento_v1(ARRAY['00000000-0000-4000-8000-0000000000ee']);
  IF n <> 0 THEN RAISE EXCEPTION 'FALLA 35.3: el médico recibe el historial de un documento inexistente'; END IF;
  INSERT INTO t_res VALUES ('35 historial por función: el médico conserva su regla (documentos propios, también los de tipo cerrado para Secretaría; no los de otro profesional aunque los haya subido)', 'OK');
END $$;

-- ===== 8) Resultado y ROLLBACK =====
RESET ROLE;
SELECT nombre, resultado FROM t_res ORDER BY nombre;      -- se esperan 22 filas, todas 'OK'
ROLLBACK;
-- Verificación posterior (fuera de la transacción): no queda nada sintético. Todas las cifras deben ser 0.
SELECT (SELECT count(*) FROM public.cardiolink_patient_documents WHERE patient_id LIKE 'qa4c\_%' ESCAPE '\') AS documentos_qa4c_restantes,
       (SELECT count(*) FROM storage.objects WHERE bucket_id='patient-documents' AND name LIKE '%qa4c\_%' ESCAPE '\') AS objetos_qa4c_restantes,
       (SELECT count(*) FROM public.cardiolink_pacientes WHERE id LIKE 'qa4c\_%' ESCAPE '\') AS pacientes_qa4c_restantes,
       (SELECT count(*) FROM public.cardiolink_hc_evoluciones WHERE id LIKE 'qa4c\_%' ESCAPE '\') AS evoluciones_qa4c_restantes,
       (SELECT count(*) FROM public.cardiolink_atenciones WHERE id LIKE '\_\_t\_qa4c%' ESCAPE '\') AS atenciones_qa4c_restantes,
       (SELECT count(*) FROM public.cardiolink_user_roles WHERE professional_id = 'qa4c_prof_b') AS roles_convertidos_restantes,
       (SELECT count(*) FROM public.cardiolink_communications WHERE message LIKE 'qa4c%') AS comunicaciones_qa4c_restantes,
       (SELECT (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.cardiolink_paciente_profesionales_v1 where %I = ''qa4c_pac_d''', (SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='cardiolink_paciente_profesionales_v1' AND column_name IN ('paciente_id','patient_id') LIMIT 1)), false, true, '')))[1]::text::int) AS asociaciones_qa4c_restantes;
