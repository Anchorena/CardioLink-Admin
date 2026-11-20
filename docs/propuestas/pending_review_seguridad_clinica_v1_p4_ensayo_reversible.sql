-- CardioLink · Seguridad clínica V1 · p4 "padrón compartido" · ENSAYO REVERSIBLE (STAGING). GENERADO por pending_review_seguridad_clinica_v1_p4_generar_ensayo.sh: no editar a mano.
-- NO ejecutar en Production. Sin BEGIN/COMMIT: el SQL Editor corre todo en UNA transacción y el script termina SIEMPRE con una EXCEPTION, que revierte todo (pacientes, filas, objetos y cambios de rol sintéticos).
-- RESULTADO ESPERADO: error final "ENSAYO_P4_OK: N pruebas ..." (es la señal de éxito + rollback). Cualquier otro mensaje "FALLA ..." indica la prueba que no pasó. Deja la base como estaba.
-- Orden: foto de políticas -> p4 -> (p4b si p3) -> pruebas -> rollback de p4b/p4 -> la foto debe coincidir exactamente -> veredicto.
CREATE TEMP TABLE t_antes AS SELECT tablename, policyname, cmd, permissive, roles::text AS roles, qual, with_check FROM pg_policies WHERE tablename IN ('cardiolink_patient_documents','cardiolink_hc_evoluciones','cardiolink_hc_resumen');
CREATE TEMP TABLE t_flags AS SELECT (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND policyname LIKE '%\_v1' ESCAPE '\') = 8 AS hay_p3;
GRANT SELECT ON t_flags TO authenticated;
-- ===== p4 =====
-- CardioLink · Seguridad clínica V1 · CORRECCIÓN P0 "PADRÓN COMPARTIDO" (p4) · DOCUMENTOS (INSERT de cardiolink_patient_documents)
-- BORRADOR PARA REVISIÓN. NO EJECUTAR en Production sin autorización explícita. Primero STAGING (ensayo reversible: pending_review_seguridad_clinica_v1_p4_ensayo_reversible.sql).
-- Una sola transacción, sin DML sobre datos. Falla (y revierte todo) si el estado no es el esperado. Rollback: pending_review_seguridad_clinica_v1_p4_padron_compartido_rollback.sql
--
-- PROBLEMA (confirmado en Production). La política RESTRICTIVE cardiolink_patient_documents_insert_4c1 exige, para el médico, cardiolink_paciente_acceso_clinico_v1(patient_id):
-- asociación manual, evolución propia o atención propia con ese paciente. Eso impide que un médico emita su PRIMER documento a un paciente que todavía no atendió.
-- DECISIÓN DEL DUEÑO: el padrón de pacientes es compartido por todos los médicos activos; los pacientes no son de un profesional.
--
-- CORRECCIÓN MÍNIMA. (1) Función nueva cardiolink_paciente_padron_v1(text): true sólo si hay sesión, el usuario tiene un rol ACTIVO owner/admin o médico (con professional_id válido)
-- y el paciente EXISTE en cardiolink_pacientes. Secretaría, usuarios sin rol, inactivos y sesiones ajenas: false. (2) ALTER POLICY de insert_4c1: en la rama del médico, la condición
-- "acceso clínico al paciente" pasa a "padrón" (el paciente existe). TODO LO DEMÁS DE LA POLÍTICA QUEDA IDÉNTICO: owner/admin; médico a nombre propio (o sin profesional) y con archivo asignable
-- (subido por él, hace menos de 1 h, en la ruta de ESE paciente); Secretaría con tipo permitido, profesional AUTORIZADO por asociación activa, sin evolución y con archivo asignable.
--
-- NO CAMBIA (sigue protegido por cardiolink_paciente_acceso_clinico_v1): SELECT de documentos ajenos, UPDATE, vínculos a evolución/atención ajenas, historial de envíos, Storage, notas internas
-- (viven en la config, fuera de este SQL), asociaciones Secretaría-profesional, trigger de inmutables. Un médico NO puede insertar a nombre de otro profesional ni sobre un archivo ajeno.
DO $$
BEGIN
  IF to_regprocedure('public.cardiolink_ctx_rol_v1()') IS NULL OR to_regprocedure('public.cardiolink_ctx_prof_v1()') IS NULL
     OR to_regprocedure('public.cardiolink_objeto_asignable_v1(text,text)') IS NULL OR to_regprocedure('public.cardiolink_secretaria_autorizada_prof_v1(text)') IS NULL
     OR to_regprocedure('public.cardiolink_tipos_documento_secretaria_v1()') IS NULL OR to_regprocedure('public.cardiolink_paciente_acceso_clinico_v1(text)') IS NULL THEN
    RAISE EXCEPTION 'Precondición: falta alguna función de 4C-1 / p2 (¿4C-1 y p2 aplicados?)'; END IF;
  IF to_regclass('public.cardiolink_pacientes') IS NULL OR to_regclass('public.cardiolink_user_roles') IS NULL THEN RAISE EXCEPTION 'Precondición: faltan cardiolink_pacientes / cardiolink_user_roles'; END IF;
  IF to_regprocedure('public.cardiolink_paciente_padron_v1(text)') IS NOT NULL THEN RAISE EXCEPTION 'Precondición: p4 ya está aplicada (cardiolink_paciente_padron_v1 existe)'; END IF;
  IF (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.cardiolink_patient_documents'::regclass AND polname = 'cardiolink_patient_documents_insert_4c1' AND NOT polpermissive AND polcmd = 'a') <> 1 THEN
    RAISE EXCEPTION 'Precondición: falta la política RESTRICTIVE de INSERT cardiolink_patient_documents_insert_4c1'; END IF;
  IF (SELECT pg_get_expr(polwithcheck, polrelid) FROM pg_policy WHERE polrelid = 'public.cardiolink_patient_documents'::regclass AND polname = 'cardiolink_patient_documents_insert_4c1')
       NOT LIKE '%cardiolink_paciente_acceso_clinico_v1(patient_id)%' THEN
    RAISE EXCEPTION 'Precondición: la política INSERT 4C-1 no tiene la forma esperada (acceso clínico en la rama del médico); el estado difiere'; END IF;
END $$;

-- ===== 1) Padrón compartido: ¿el usuario es un profesional activo del consultorio y el paciente existe? =====
-- SECURITY DEFINER (ignora la RLS a propósito, como cardiolink_paciente_acceso_clinico_v1): "existe" no puede depender de lo que el usuario vea. No expone datos: sólo un boolean.
CREATE FUNCTION public.cardiolink_paciente_padron_v1(p_paciente_id text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $f$
 SELECT auth.uid() IS NOT NULL
    AND nullif(btrim(p_paciente_id), '') IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.cardiolink_user_roles r
                 WHERE r.user_id = auth.uid() AND r.active IS TRUE
                   AND (r.base_role IN ('owner', 'admin')
                        OR (r.base_role = 'medico' AND r.professional_id ~ '^[A-Za-z0-9_.-]{1,64}$')))
    AND EXISTS (SELECT 1 FROM public.cardiolink_pacientes p WHERE p.id = p_paciente_id)
$f$;
REVOKE ALL ON FUNCTION public.cardiolink_paciente_padron_v1(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cardiolink_paciente_padron_v1(text) TO authenticated;
COMMENT ON FUNCTION public.cardiolink_paciente_padron_v1(text) IS 'Seguridad clínica V1 p4: padrón compartido. true si hay sesión, rol ACTIVO owner/admin/médico (professional_id válido) y el paciente existe. NO da acceso a la información clínica de otros profesionales (eso es cardiolink_paciente_acceso_clinico_v1).';

-- ===== 2) INSERT de documentos: la rama del médico usa el padrón (el resto de la política es idéntico a 4C-1) =====
ALTER POLICY cardiolink_patient_documents_insert_4c1 ON public.cardiolink_patient_documents
  WITH CHECK (
    (SELECT public.cardiolink_ctx_rol_v1()) IN ('owner', 'admin')
    OR ((SELECT public.cardiolink_ctx_rol_v1()) = 'medico'
        AND (professional_id IS NULL OR professional_id = (SELECT public.cardiolink_ctx_prof_v1()))
        AND public.cardiolink_paciente_padron_v1(patient_id)
        AND public.cardiolink_objeto_asignable_v1(storage_path, patient_id))
    OR ((SELECT public.cardiolink_ctx_rol_v1()) = 'secretaria'
        AND document_type = ANY (public.cardiolink_tipos_documento_secretaria_v1()) AND storage_path NOT LIKE 'clinical-images/%'
        AND evolution_id IS NULL AND public.cardiolink_secretaria_autorizada_prof_v1(professional_id)
        AND public.cardiolink_objeto_asignable_v1(storage_path, patient_id))
  );

-- ===== 3) Postcondiciones =====
DO $$
DECLARE v text;
BEGIN
  SELECT pg_get_expr(polwithcheck, polrelid) INTO v FROM pg_policy WHERE polrelid = 'public.cardiolink_patient_documents'::regclass AND polname = 'cardiolink_patient_documents_insert_4c1';
  IF v IS NULL OR v NOT LIKE '%cardiolink_paciente_padron_v1(patient_id)%' OR v LIKE '%cardiolink_paciente_acceso_clinico_v1%' THEN RAISE EXCEPTION 'Postcondición: la política INSERT no quedó con el padrón'; END IF;
  IF v NOT LIKE '%cardiolink_objeto_asignable_v1(storage_path, patient_id)%' OR v NOT LIKE '%cardiolink_secretaria_autorizada_prof_v1(professional_id)%' OR v NOT LIKE '%cardiolink_ctx_prof_v1()%' THEN
    RAISE EXCEPTION 'Postcondición: se perdió una condición del médico/Secretaría (archivo asignable, profesional autorizado o profesional propio)'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.cardiolink_patient_documents'::regclass AND polname = 'cardiolink_patient_documents_insert_4c1' AND NOT polpermissive AND polcmd = 'a') THEN
    RAISE EXCEPTION 'Postcondición: la política dejó de ser RESTRICTIVE de INSERT'; END IF;
  IF has_function_privilege('anon', 'public.cardiolink_paciente_padron_v1(text)', 'EXECUTE') OR has_function_privilege('public', 'public.cardiolink_paciente_padron_v1(text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.cardiolink_paciente_padron_v1(text)', 'EXECUTE') THEN RAISE EXCEPTION 'Postcondición: privilegios de cardiolink_paciente_padron_v1'; END IF;
  IF (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.cardiolink_patient_documents'::regclass AND polname LIKE '%\_4c1' ESCAPE '\') <> 3 THEN RAISE EXCEPTION 'Postcondición: se esperaban las 3 políticas _4c1 de la tabla'; END IF;
END $$;
-- ===== p4b (sólo si p3 está aplicada) =====
DO $ens$ BEGIN IF (SELECT hay_p3 FROM t_flags) THEN EXECUTE $b$
-- CardioLink · Seguridad clínica V1 · p4b · HC por padrón compartido. SOLO donde p3 (HC RLS) YA está aplicada (hoy: STAGING). En Production p3 está postergada: allí NO aplicar; cuando se publique p3, aplicar p4b inmediatamente después.
-- NO EJECUTAR en Production sin autorización. Una sola transacción. Rollback: pending_review_seguridad_clinica_v1_p4b_hc_padron_rollback.sql. Requiere p4 (cardiolink_paciente_padron_v1).
-- Sin p4b, con p3 un médico no puede crear su PRIMERA evolución de un paciente (la política exige acceso clínico, que a su vez se obtiene al tener una evolución).
-- Cambios (todo lo demás de p3 queda igual: UPDATE/DELETE de evoluciones sólo propias y con acceso; SELECT de evoluciones ajenas sólo con acceso clínico; Secretaría sin acceso a HC):
--   evoluciones INSERT: padrón + (owner/admin o médico escribiendo con SU professional_id). evoluciones SELECT: acceso clínico O autoría propia (necesaria para INSERT ... RETURNING, que no ve su propia fila nueva a través de la función).
--   [D1] resumen clínico del paciente (antecedentes/alergias/medicación; es del paciente, no de un médico): SELECT/INSERT/UPDATE por padrón, para poder atender por primera vez con las alergias a la vista. DELETE sigue con acceso clínico. Si el Dueño no lo quiere: borrar el bloque D1.
DO $$
BEGIN
  IF to_regprocedure('public.cardiolink_paciente_padron_v1(text)') IS NULL THEN RAISE EXCEPTION 'Precondición: aplicar antes p4'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND policyname LIKE '%\_v1' ESCAPE '\') <> 8 THEN
    RAISE EXCEPTION 'Precondición: p3 no está aplicada (se esperaban 8 políticas _v1 de HC). En Production NO aplicar p4b antes que p3'; END IF;
END $$;

ALTER POLICY cardiolink_hc_evoluciones_insert_v1 ON public.cardiolink_hc_evoluciones
  WITH CHECK (cardiolink_paciente_padron_v1(paciente_id) AND ((cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text])) OR ((cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1()))))));

ALTER POLICY cardiolink_hc_evoluciones_select_v1 ON public.cardiolink_hc_evoluciones
  USING (cardiolink_paciente_acceso_clinico_v1(paciente_id) OR ((cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1())))));

-- [D1] resumen clínico compartido
ALTER POLICY cardiolink_hc_resumen_select_v1 ON public.cardiolink_hc_resumen USING (cardiolink_paciente_padron_v1(paciente_id));
ALTER POLICY cardiolink_hc_resumen_insert_v1 ON public.cardiolink_hc_resumen WITH CHECK (cardiolink_paciente_padron_v1(paciente_id));
ALTER POLICY cardiolink_hc_resumen_update_v1 ON public.cardiolink_hc_resumen USING (cardiolink_paciente_padron_v1(paciente_id)) WITH CHECK (cardiolink_paciente_padron_v1(paciente_id));
-- [fin D1]

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND policyname LIKE '%\_v1' ESCAPE '\') <> 8 THEN RAISE EXCEPTION 'Postcondición: cambió la cantidad de políticas de HC'; END IF;
  IF (SELECT with_check FROM pg_policies WHERE policyname='cardiolink_hc_evoluciones_insert_v1') NOT LIKE '%cardiolink_paciente_padron_v1(paciente_id)%' THEN RAISE EXCEPTION 'Postcondición: evoluciones INSERT'; END IF;
  IF (SELECT qual FROM pg_policies WHERE policyname='cardiolink_hc_evoluciones_update_v1') NOT LIKE '%cardiolink_paciente_acceso_clinico_v1(paciente_id)%' THEN RAISE EXCEPTION 'Postcondición: evoluciones UPDATE debe seguir con acceso clínico'; END IF;
END $$;
$b$; END IF; END $ens$;
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
-- ===== ROLLBACKS =====
DO $ens$ BEGIN IF (SELECT hay_p3 FROM t_flags) THEN EXECUTE $b$
-- ROLLBACK de p4b: restaura las políticas de HC tal como las deja p3. Una sola transacción.
DO $$ BEGIN
  IF (SELECT with_check FROM pg_policies WHERE policyname='cardiolink_hc_evoluciones_insert_v1') NOT LIKE '%cardiolink_paciente_padron_v1(paciente_id)%' THEN RAISE EXCEPTION 'Precondición: p4b no está aplicada'; END IF;
END $$;
ALTER POLICY cardiolink_hc_evoluciones_insert_v1 ON public.cardiolink_hc_evoluciones
  WITH CHECK ((cardiolink_paciente_acceso_clinico_v1(paciente_id) AND ((cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text])) OR ((cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1())))))));
ALTER POLICY cardiolink_hc_evoluciones_select_v1 ON public.cardiolink_hc_evoluciones USING (cardiolink_paciente_acceso_clinico_v1(paciente_id));
ALTER POLICY cardiolink_hc_resumen_select_v1 ON public.cardiolink_hc_resumen USING (cardiolink_paciente_acceso_clinico_v1(paciente_id));
ALTER POLICY cardiolink_hc_resumen_insert_v1 ON public.cardiolink_hc_resumen WITH CHECK (cardiolink_paciente_acceso_clinico_v1(paciente_id));
ALTER POLICY cardiolink_hc_resumen_update_v1 ON public.cardiolink_hc_resumen USING (cardiolink_paciente_acceso_clinico_v1(paciente_id)) WITH CHECK (cardiolink_paciente_acceso_clinico_v1(paciente_id));
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE policyname LIKE 'cardiolink_hc\_%\_v1' ESCAPE '\' AND (coalesce(qual,'') LIKE '%padron%' OR coalesce(with_check,'') LIKE '%padron%')) THEN RAISE EXCEPTION 'Postcondición: quedan políticas de HC con el padrón'; END IF;
END $$;
$b$; END IF; END $ens$;
-- ROLLBACK de pending_review_seguridad_clinica_v1_p4_padron_compartido.sql: restaura EXACTAMENTE la política INSERT de 4C-1 (rama del médico con acceso clínico) y elimina la función del padrón.
-- Una sola transacción. Si algo no coincide, aborta.
DO $$
BEGIN
  IF to_regprocedure('public.cardiolink_paciente_padron_v1(text)') IS NULL THEN RAISE EXCEPTION 'Precondición: p4 no está aplicada'; END IF;
  IF (SELECT pg_get_expr(polwithcheck, polrelid) FROM pg_policy WHERE polrelid = 'public.cardiolink_patient_documents'::regclass AND polname = 'cardiolink_patient_documents_insert_4c1') NOT LIKE '%cardiolink_paciente_padron_v1(patient_id)%' THEN
    RAISE EXCEPTION 'Precondición: la política INSERT no usa el padrón'; END IF;
END $$;
ALTER POLICY cardiolink_patient_documents_insert_4c1 ON public.cardiolink_patient_documents
  WITH CHECK (
    (SELECT public.cardiolink_ctx_rol_v1()) IN ('owner', 'admin')
    OR ((SELECT public.cardiolink_ctx_rol_v1()) = 'medico'
        AND (professional_id IS NULL OR professional_id = (SELECT public.cardiolink_ctx_prof_v1()))
        AND public.cardiolink_paciente_acceso_clinico_v1(patient_id)
        AND public.cardiolink_objeto_asignable_v1(storage_path, patient_id))
    OR ((SELECT public.cardiolink_ctx_rol_v1()) = 'secretaria'
        AND document_type = ANY (public.cardiolink_tipos_documento_secretaria_v1()) AND storage_path NOT LIKE 'clinical-images/%'
        AND evolution_id IS NULL AND public.cardiolink_secretaria_autorizada_prof_v1(professional_id)
        AND public.cardiolink_objeto_asignable_v1(storage_path, patient_id))
  );
DROP FUNCTION public.cardiolink_paciente_padron_v1(text);
DO $$
BEGIN
  IF to_regprocedure('public.cardiolink_paciente_padron_v1(text)') IS NOT NULL THEN RAISE EXCEPTION 'Postcondición: la función del padrón sigue existiendo'; END IF;
  IF (SELECT pg_get_expr(polwithcheck, polrelid) FROM pg_policy WHERE polrelid = 'public.cardiolink_patient_documents'::regclass AND polname = 'cardiolink_patient_documents_insert_4c1') NOT LIKE '%cardiolink_paciente_acceso_clinico_v1(patient_id)%' THEN
    RAISE EXCEPTION 'Postcondición: la política no volvió a usar el acceso clínico'; END IF;
END $$;
DO $$
DECLARE n int;
BEGIN
  IF to_regprocedure('public.cardiolink_paciente_padron_v1(text)') IS NOT NULL THEN RAISE EXCEPTION 'FALLA R1: tras el rollback sigue existiendo cardiolink_paciente_padron_v1'; END IF;
  IF EXISTS (SELECT tablename, policyname, cmd, permissive, roles::text, qual, with_check FROM pg_policies WHERE tablename IN ('cardiolink_patient_documents','cardiolink_hc_evoluciones','cardiolink_hc_resumen')
             EXCEPT SELECT tablename, policyname, cmd, permissive, roles, qual, with_check FROM t_antes)
     OR EXISTS (SELECT tablename, policyname, cmd, permissive, roles, qual, with_check FROM t_antes
             EXCEPT SELECT tablename, policyname, cmd, permissive, roles::text, qual, with_check FROM pg_policies WHERE tablename IN ('cardiolink_patient_documents','cardiolink_hc_evoluciones','cardiolink_hc_resumen')) THEN
    RAISE EXCEPTION 'FALLA R2: tras el rollback las políticas NO coinciden con la foto inicial'; END IF;
  SELECT count(*) INTO n FROM t_res;
  RAISE EXCEPTION 'ENSAYO_P4_OK: % pruebas pasaron, el rollback restauró las políticas exactamente y todo se revierte (esta EXCEPTION es la señal de éxito)', n;
END $$;
