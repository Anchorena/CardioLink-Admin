-- CardioLink · Seguridad clínica V1 · p3c "HC compartida" + integridad de evoluciones + privilegios · ENSAYO REVERSIBLE. GENERADO por pending_review_seguridad_clinica_v1_p3c_generar_ensayo.sh: no editar a mano.
-- Sin BEGIN/COMMIT: todo corre en UNA transacción y el script termina SIEMPRE con una EXCEPTION que revierte TODO (cuentas, pacientes, filas, políticas, trigger y privilegios sintéticos/ensayados).
-- RESULTADO ESPERADO: error final "ENSAYO_P3C_OK: N pruebas ..." (= éxito + rollback). Cualquier otro mensaje "FALLA ..." indica la prueba que no pasó. La base queda como estaba.
-- Orden: foto → estado base → p3c → pruebas → privilegios → integridad (con control previo del hueco) → rollbacks de integridad y privilegios → rollback de p3c → p3 → delta (idéntico a p3c) → rollback del delta → restauración y comparación con la foto inicial.
-- ===== GUARDA DE TRANSACCIÓN: si el cliente ejecutara cada sentencia por separado (autocommit), esta tabla (ON COMMIT DROP) ya no existiría en la sentencia siguiente y el script ABORTA antes de cambiar nada =====
CREATE TEMP TABLE t_guard_tx(x int) ON COMMIT DROP;
DO $g$ BEGIN PERFORM 1 FROM t_guard_tx; END $g$;
-- ===== PRUEBAS p3c (como cada actor sintético, vía claims + SET LOCAL ROLE; todo qa3c_*; el veredicto final es una EXCEPTION que revierte TODO) =====
-- Actores: own (owner 'qa3c_matias' = Matías), adm (admin), med_a (médico tipo Rogelio 'qa3c_med_a'), med_b (médico NUEVO sin vínculos ni atenciones 'qa3c_med_b'),
-- sec (Secretaría), inact (médico INACTIVO), sinprof (médico activo sin professional_id), norol (cuenta sin fila de rol), anon.
CREATE TEMP TABLE t_act(clave text PRIMARY KEY, uid uuid, rol text, prof text);
CREATE TEMP TABLE t_res(nombre text);
CREATE TEMP TABLE t_pol(fase text, tablename name, policyname name, cmd text, permissive text, roles text, qual text, with_check text);
CREATE TEMP TABLE t_acl(fase text, rel name, grantee text, priv text);

CREATE FUNCTION pg_temp.snap_pol(p_fase text) RETURNS void LANGUAGE sql AS $f$
  INSERT INTO t_pol SELECT p_fase, tablename, policyname, cmd, permissive, roles::text, qual, with_check FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') $f$;
CREATE FUNCTION pg_temp.snap_acl(p_fase text) RETURNS void LANGUAGE sql AS $f$
  INSERT INTO t_acl SELECT p_fase, c.relname, (aclexplode(c.relacl)).grantee::regrole::text, (aclexplode(c.relacl)).privilege_type FROM pg_class c WHERE c.oid IN ('public.cardiolink_hc_evoluciones'::regclass,'public.cardiolink_hc_resumen'::regclass) $f$;
CREATE FUNCTION pg_temp.igual_pol(p_a text, p_b text) RETURNS boolean LANGUAGE sql AS $f$
  SELECT NOT EXISTS (SELECT tablename,policyname,cmd,permissive,roles,qual,with_check FROM t_pol WHERE fase=p_a EXCEPT SELECT tablename,policyname,cmd,permissive,roles,qual,with_check FROM t_pol WHERE fase=p_b)
     AND NOT EXISTS (SELECT tablename,policyname,cmd,permissive,roles,qual,with_check FROM t_pol WHERE fase=p_b EXCEPT SELECT tablename,policyname,cmd,permissive,roles,qual,with_check FROM t_pol WHERE fase=p_a) $f$;

CREATE FUNCTION pg_temp.como(p_clave text, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v_uid uuid; v_rol text; r text; n bigint;
BEGIN
  SELECT uid, rol INTO v_uid, v_rol FROM t_act WHERE clave = p_clave;
  IF v_rol = 'anon' THEN PERFORM set_config('request.jwt.claims', '', true); EXECUTE 'SET LOCAL ROLE anon';
  ELSE PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true); EXECUTE 'SET LOCAL ROLE authenticated'; END IF;
  BEGIN
    IF p_sql ~* '^\s*select' THEN EXECUTE p_sql INTO r; ELSE EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; r := n::text; END IF;
    EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claims', '', true); RETURN 'n=' || coalesce(r, 'null');
  EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claims', '', true); RETURN 'E' || SQLSTATE;
  END;
END $f$;
CREATE FUNCTION pg_temp.chk(p_nombre text, p_got text, p_exp text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  IF p_got IS DISTINCT FROM p_exp THEN RAISE EXCEPTION 'FALLA %: obtuvo [%] esperado [%]', p_nombre, p_got, p_exp; END IF;
  INSERT INTO t_res VALUES (p_nombre);
END $f$;
CREATE FUNCTION pg_temp.chk_uno(p_nombre text, p_got text, p_ok text[]) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  IF NOT (p_got = ANY (p_ok)) THEN RAISE EXCEPTION 'FALLA %: obtuvo [%] esperado uno de %', p_nombre, p_got, p_ok; END IF;
  INSERT INTO t_res VALUES (p_nombre);
END $f$;
CREATE FUNCTION pg_temp.arma_insert(p_tabla text, p_val jsonb) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE c record; cols text := ''; vals text := ''; v text; k text;
BEGIN
  FOR k IN SELECT jsonb_object_keys(p_val) LOOP
    cols := cols || CASE WHEN cols = '' THEN '' ELSE ',' END || quote_ident(k);
    vals := vals || CASE WHEN vals = '' THEN '' ELSE ',' END || quote_literal(p_val ->> k);
  END LOOP;
  FOR c IN SELECT column_name, data_type FROM information_schema.columns
            WHERE table_schema='public' AND table_name=p_tabla AND is_nullable='NO' AND column_default IS NULL AND NOT (p_val ? column_name) ORDER BY ordinal_position LOOP
    IF c.data_type IN ('text','character varying','character') THEN v := quote_literal('QA SINTETICO p3c');
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

CREATE TEMP TABLE t_flags AS SELECT
  (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND policyname LIKE '%\_v1' ESCAPE '\') = 8 AS hay_p3,
  to_regprocedure('public.cardiolink_paciente_padron_v1(text)') IS NOT NULL AS hay_p4,
  coalesce((SELECT qual LIKE '%cardiolink_paciente_padron_v1%' FROM pg_policies WHERE policyname='cardiolink_hc_evoluciones_select_v1'), false) AS hay_p3c,
  coalesce((SELECT with_check LIKE '%cardiolink_paciente_padron_v1%' FROM pg_policies WHERE policyname='cardiolink_hc_evoluciones_insert_v1'), false)
    AND NOT coalesce((SELECT qual LIKE '%cardiolink_paciente_padron_v1%' FROM pg_policies WHERE policyname='cardiolink_hc_evoluciones_select_v1'), false) AS hay_p4b,
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.cardiolink_hc_evoluciones'::regclass AND tgname='cardiolink_hc_evoluciones_inmutables_v1') AS hay_trg,
  NOT has_table_privilege('anon','public.cardiolink_hc_evoluciones','SELECT') AND NOT has_table_privilege('authenticated','public.cardiolink_hc_evoluciones','TRUNCATE') AS hay_grants;
CREATE TEMP TABLE t_antes AS SELECT tablename, policyname, cmd, permissive, roles::text AS roles, qual, with_check FROM pg_policies WHERE tablename IN ('cardiolink_patient_documents','cardiolink_hc_evoluciones','cardiolink_hc_resumen');
SELECT pg_temp.snap_pol('ini'); SELECT pg_temp.snap_acl('ini');
-- ===== estado base «Production»: sin trigger ni privilegios endurecidos, políticas abiertas + p4 =====
DO $ens$ BEGIN IF (SELECT hay_trg FROM t_flags) THEN EXECUTE $b$
-- ROLLBACK del ajuste de integridad de evoluciones: elimina el trigger y su función. Una sola transacción.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.cardiolink_hc_evoluciones'::regclass AND tgname='cardiolink_hc_evoluciones_inmutables_v1') THEN RAISE EXCEPTION 'Rollback: el trigger de integridad no está aplicado'; END IF;
END $$;
DROP TRIGGER cardiolink_hc_evoluciones_inmutables_v1 ON public.cardiolink_hc_evoluciones;
DROP FUNCTION public.cardiolink_hc_evolucion_inmutables_v1();
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.cardiolink_hc_evoluciones'::regclass AND NOT tgisinternal) OR to_regprocedure('public.cardiolink_hc_evolucion_inmutables_v1()') IS NOT NULL THEN RAISE EXCEPTION 'Rollback: quedaron restos del trigger'; END IF;
END $$;
$b$; END IF; END $ens$;
DO $ens$ BEGIN IF (SELECT hay_grants FROM t_flags) THEN EXECUTE $b$
-- ROLLBACK del endurecimiento de privilegios: vuelve al estado de Production (todos los privilegios de tabla para anon y authenticated; la RLS sigue siendo la barrera). Una sola transacción.
-- (STAGING originalmente no tenía TRUNCATE para anon/authenticated; este rollback los vuelve a conceder, igual que Production.)
GRANT ALL ON TABLE public.cardiolink_hc_evoluciones, public.cardiolink_hc_resumen TO anon, authenticated;
$b$; END IF; END $ens$;
DO $ens$ BEGIN IF (SELECT hay_p3 FROM t_flags) THEN EXECUTE $b$
-- CardioLink · Seguridad clínica V1 · ROLLBACK de la PARTE 3 (restaura las políticas abiertas *_authenticated)
-- Recuperado de STAGING (catálogo: pg_get_functiondef / pg_get_constraintdef / pg_policies / aclexplode, 2026-11-13); QA de STAGING aprobado. Versionado para publicar en Production.
-- NO EJECUTAR en Production sin autorización explícita. Una sola transacción, sin DML sobre datos. Falla (y revierte todo) si el estado no es el esperado.
-- Orden de publicación y rollback: docs/propuestas/pending_review_seguridad_clinica_v1_PUBLICACION.md
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND policyname LIKE '%\_authenticated' ESCAPE '\') THEN RAISE EXCEPTION 'Rollback: ya existen políticas *_authenticated (¿ya revertido?)'; END IF;
END $$;
DROP POLICY IF EXISTS cardiolink_hc_evoluciones_delete_v1 ON public.cardiolink_hc_evoluciones;
DROP POLICY IF EXISTS cardiolink_hc_evoluciones_insert_v1 ON public.cardiolink_hc_evoluciones;
DROP POLICY IF EXISTS cardiolink_hc_evoluciones_select_v1 ON public.cardiolink_hc_evoluciones;
DROP POLICY IF EXISTS cardiolink_hc_evoluciones_update_v1 ON public.cardiolink_hc_evoluciones;
DROP POLICY IF EXISTS cardiolink_hc_resumen_delete_v1 ON public.cardiolink_hc_resumen;
DROP POLICY IF EXISTS cardiolink_hc_resumen_insert_v1 ON public.cardiolink_hc_resumen;
DROP POLICY IF EXISTS cardiolink_hc_resumen_select_v1 ON public.cardiolink_hc_resumen;
DROP POLICY IF EXISTS cardiolink_hc_resumen_update_v1 ON public.cardiolink_hc_resumen;

CREATE POLICY cardiolink_hc_evoluciones_authenticated ON public.cardiolink_hc_evoluciones AS PERMISSIVE FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY cardiolink_hc_resumen_authenticated ON public.cardiolink_hc_resumen AS PERMISSIVE FOR ALL TO authenticated USING (true) WITH CHECK (true);

DO $$ BEGIN
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen')) <> 2 THEN RAISE EXCEPTION 'Rollback: estado final inesperado'; END IF;
END $$;
$b$; END IF; END $ens$;
DO $ens$ BEGIN IF NOT (SELECT hay_p4 FROM t_flags) THEN EXECUTE $b$
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
$b$; END IF; END $ens$;
SELECT pg_temp.snap_pol('open');
-- ===== p3c (camino Production) =====
DO $ens$ BEGIN EXECUTE $b$
-- CardioLink · Seguridad clínica V1 · p3c · HISTORIA CLÍNICA COMPARTIDA entre profesionales activos autorizados (reemplaza a p3 + p4b en Production)
-- ESTADO: PREPARADO PARA REVISIÓN. NO EJECUTAR en Production sin autorización explícita. Probar primero con el ensayo reversible (…_p3c_ensayo_reversible.sql).
-- Una sola transacción, sin DML sobre datos. Falla (y revierte todo) si el estado no es el esperado. Rollback: pending_review_seguridad_clinica_v1_p3c_hc_compartida_rollback.sql
-- Para una base que YA tiene p3 (hoy: STAGING) usar el delta: pending_review_seguridad_clinica_v1_p3c_delta_staging.sql (deja las políticas IDÉNTICAS a las de este archivo; el ensayo lo comprueba).
--
-- DECISIÓN DEL DUEÑO (D1/D2, 2026-11-20): la HC es COMPARTIDA entre los profesionales activos del consultorio. No hay vínculos manuales por paciente como condición para consultarla.
-- REGLAS (cardiolink_paciente_padron_v1 = hay sesión + rol ACTIVO owner/admin/médico con professional_id válido + el paciente existe):
--   cardiolink_hc_evoluciones  SELECT : cualquier profesional activo (padrón).
--                              INSERT/UPDATE/DELETE : owner/admin (cualquier evolución) o médico SÓLO con profesional_id = el SUYO (no se puede suplantar ni transferir a otro: WITH CHECK).
--   cardiolink_hc_resumen      SELECT/INSERT/UPDATE : cualquier profesional activo (antecedentes, alergias, medicación, alertas). DELETE : sólo owner/admin (los médicos consultan y actualizan, no borran).
--   Secretaría, cuentas sin rol, cuentas inactivas y anon: SIN acceso (no hay política para ellos). El control de concurrencia del PR #33 (UPDATE condicionado) no se toca: es el cliente.
-- Las 8 políticas nuevas y el DROP de las abiertas ocurren en la misma transacción: no hay ventana sin política.
-- Requiere p4 (cardiolink_paciente_padron_v1), ya aplicada en Production.
DO $$
BEGIN
  IF to_regprocedure('public.cardiolink_paciente_padron_v1(text)') IS NULL THEN RAISE EXCEPTION 'Precondición: aplicar antes p4 (cardiolink_paciente_padron_v1)'; END IF;
  IF to_regprocedure('public.cardiolink_ctx_rol_v1()') IS NULL OR to_regprocedure('public.cardiolink_ctx_prof_v1()') IS NULL THEN RAISE EXCEPTION 'Precondición: faltan cardiolink_ctx_rol_v1() / cardiolink_ctx_prof_v1()'; END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.cardiolink_hc_evoluciones'::regclass) OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.cardiolink_hc_resumen'::regclass) THEN
    RAISE EXCEPTION 'Precondición: RLS apagada en las tablas de HC'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen')
        AND policyname IN ('cardiolink_hc_evoluciones_authenticated','cardiolink_hc_resumen_authenticated') AND permissive='PERMISSIVE' AND cmd='ALL' AND qual='true' AND with_check='true' AND roles = ARRAY['authenticated']::name[]) <> 2 THEN
    RAISE EXCEPTION 'Precondición: se esperaban exactamente las dos políticas abiertas *_authenticated (cmd ALL, true/true, authenticated); el estado difiere (¿p3 ya aplicada? usar el delta)'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen')) <> 2 THEN
    RAISE EXCEPTION 'Precondición: hay otras políticas en las tablas de HC; revisar antes de continuar'; END IF;
END $$;

-- ===== cardiolink_hc_evoluciones =====
CREATE POLICY cardiolink_hc_evoluciones_select_v1 ON public.cardiolink_hc_evoluciones
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (cardiolink_paciente_padron_v1(paciente_id));

CREATE POLICY cardiolink_hc_evoluciones_insert_v1 ON public.cardiolink_hc_evoluciones
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((cardiolink_paciente_padron_v1(paciente_id) AND ((cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text])) OR ((cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1())))))));

CREATE POLICY cardiolink_hc_evoluciones_update_v1 ON public.cardiolink_hc_evoluciones
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((cardiolink_paciente_padron_v1(paciente_id) AND ((cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text])) OR ((cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1())))))))
  WITH CHECK ((cardiolink_paciente_padron_v1(paciente_id) AND ((cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text])) OR ((cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1())))))));

CREATE POLICY cardiolink_hc_evoluciones_delete_v1 ON public.cardiolink_hc_evoluciones
  AS PERMISSIVE FOR DELETE TO authenticated
  USING ((cardiolink_paciente_padron_v1(paciente_id) AND ((cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text])) OR ((cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1())))))));

-- ===== cardiolink_hc_resumen =====
CREATE POLICY cardiolink_hc_resumen_select_v1 ON public.cardiolink_hc_resumen
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (cardiolink_paciente_padron_v1(paciente_id));

CREATE POLICY cardiolink_hc_resumen_insert_v1 ON public.cardiolink_hc_resumen
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (cardiolink_paciente_padron_v1(paciente_id));

CREATE POLICY cardiolink_hc_resumen_update_v1 ON public.cardiolink_hc_resumen
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (cardiolink_paciente_padron_v1(paciente_id))
  WITH CHECK (cardiolink_paciente_padron_v1(paciente_id));

CREATE POLICY cardiolink_hc_resumen_delete_v1 ON public.cardiolink_hc_resumen
  AS PERMISSIVE FOR DELETE TO authenticated
  USING ((cardiolink_paciente_padron_v1(paciente_id) AND (cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text]))));

DROP POLICY cardiolink_hc_evoluciones_authenticated ON public.cardiolink_hc_evoluciones;
DROP POLICY cardiolink_hc_resumen_authenticated ON public.cardiolink_hc_resumen;

COMMENT ON POLICY cardiolink_hc_evoluciones_select_v1 ON public.cardiolink_hc_evoluciones IS 'Seguridad clínica V1 p3c: HC compartida entre profesionales activos (owner/admin/médico); Secretaría y cuentas sin rol, sin acceso.';

-- Postcondiciones
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen')) <> 8 THEN RAISE EXCEPTION 'Postcondición: se esperaban exactamente 8 políticas en las tablas de HC'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND policyname LIKE '%\_v1' ESCAPE '\' AND permissive='PERMISSIVE' AND roles = ARRAY['authenticated']::name[]) <> 8 THEN RAISE EXCEPTION 'Postcondición: las 8 políticas deben ser _v1, PERMISSIVE y sólo TO authenticated'; END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND (policyname LIKE '%\_authenticated' ESCAPE '\' OR coalesce(qual,'')='true' OR coalesce(with_check,'')='true')) THEN RAISE EXCEPTION 'Postcondición: siguen las políticas abiertas'; END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND coalesce(qual,'') || coalesce(with_check,'') LIKE '%acceso_clinico%') THEN RAISE EXCEPTION 'Postcondición: p3c no debe depender del vínculo/acceso clínico por paciente'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='cardiolink_hc_evoluciones' AND policyname IN ('cardiolink_hc_evoluciones_insert_v1','cardiolink_hc_evoluciones_update_v1','cardiolink_hc_evoluciones_delete_v1') AND coalesce(qual,'') || coalesce(with_check,'') LIKE '%cardiolink_ctx_prof_v1%') <> 3 THEN RAISE EXCEPTION 'Postcondición: INSERT/UPDATE/DELETE de evoluciones deben exigir el profesional propio'; END IF;
END $$;
$b$; END $ens$;
SELECT pg_temp.snap_pol('a');
-- ===== actores y fixture (como postgres) =====
DO $$
DECLARE k text; u uuid; r record;
BEGIN
  IF EXISTS (SELECT 1 FROM public.cardiolink_pacientes WHERE id LIKE 'qa3c\_%' ESCAPE '\') OR EXISTS (SELECT 1 FROM public.cardiolink_hc_evoluciones WHERE id LIKE 'qa3c\_%' ESCAPE '\') OR EXISTS (SELECT 1 FROM auth.users WHERE email LIKE 'qa3c\_%' ESCAPE '\') THEN
    RAISE EXCEPTION 'Ya existen filas qa3c_*: se aborta'; END IF;
  FOR r IN SELECT * FROM (VALUES ('own','owner','qa3c_matias',true),('adm','admin','qa3c_admin',true),('med_a','medico','qa3c_med_a',true),('med_b','medico','qa3c_med_b',true),
                                 ('sec','secretaria',NULL,true),('inact','medico','qa3c_inact',false),('sinprof','medico',NULL,true),('norol',NULL,NULL,NULL)) v(clave, rol, prof, activo) LOOP
    u := gen_random_uuid();
    INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    VALUES (u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'qa3c_' || r.clave || '@cardiolink.local', crypt('x', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', now(), now());
    IF r.rol IS NOT NULL THEN
      INSERT INTO public.cardiolink_user_roles (user_id, cardiolink_user_key, base_role, active, professional_id) VALUES (u, 'qa3c_' || r.clave || '@cardiolink.local', r.rol, r.activo, r.prof);
    END IF;
    INSERT INTO t_act VALUES (r.clave, u, r.rol, r.prof);
  END LOOP;
  INSERT INTO t_act VALUES ('anon', NULL, 'anon', NULL);
  -- pacientes: uno CON HC de otro profesional (Matías) y uno sin nada
  EXECUTE pg_temp.arma_insert('cardiolink_pacientes', jsonb_build_object('id', 'qa3c_pac_viejo'));
  EXECUTE pg_temp.arma_insert('cardiolink_pacientes', jsonb_build_object('id', 'qa3c_pac_otro'));
  EXECUTE pg_temp.arma_insert('cardiolink_hc_evoluciones', jsonb_build_object('id', 'qa3c_evo_m1', 'paciente_id', 'qa3c_pac_viejo', 'profesional_id', 'qa3c_matias', 'evolucion', 'EVO_M1_ORIGINAL'));
  EXECUTE pg_temp.arma_insert('cardiolink_hc_evoluciones', jsonb_build_object('id', 'qa3c_evo_a1', 'paciente_id', 'qa3c_pac_viejo', 'profesional_id', 'qa3c_med_a', 'evolucion', 'EVO_A1_ORIGINAL'));
  EXECUTE pg_temp.arma_insert('cardiolink_hc_resumen', jsonb_build_object('paciente_id', 'qa3c_pac_viejo', 'alergias', 'ALERGIA_ORIGINAL'));
  -- paciente atendido SÓLO por Matías (ningún otro médico tiene evolución, atención ni vínculo con él): caso Rogelio/médico nuevo ante un paciente de Matías
  EXECUTE pg_temp.arma_insert('cardiolink_pacientes', jsonb_build_object('id', 'qa3c_pac_matias'));
  EXECUTE pg_temp.arma_insert('cardiolink_hc_evoluciones', jsonb_build_object('id', 'qa3c_evo_m2', 'paciente_id', 'qa3c_pac_matias', 'profesional_id', 'qa3c_matias', 'evolucion', 'EVO_M2_ORIGINAL'));
  EXECUTE pg_temp.arma_insert('cardiolink_hc_resumen', jsonb_build_object('paciente_id', 'qa3c_pac_matias', 'alergias', 'ALERGIA_M'));
END $$;
CREATE TEMP TABLE t_h AS SELECT md5(evolucion) h, (SELECT md5(evolucion) FROM public.cardiolink_hc_evoluciones WHERE id='qa3c_evo_m2') h2 FROM public.cardiolink_hc_evoluciones WHERE id='qa3c_evo_m1';

-- ===== T1 OWNER / ADMIN: acceso completo según los permisos existentes =====
DO $t$
DECLARE k text;
BEGIN
  FOREACH k IN ARRAY ARRAY['own','adm'] LOOP
    PERFORM pg_temp.chk('T1 '||k||' lee evoluciones ajenas y propias', pg_temp.como(k, $q$SELECT count(*)::text FROM public.cardiolink_hc_evoluciones WHERE paciente_id='qa3c_pac_viejo'$q$), 'n=2');
    PERFORM pg_temp.chk('T1 '||k||' lee resumen', pg_temp.como(k, $q$SELECT count(*)::text FROM public.cardiolink_hc_resumen WHERE paciente_id='qa3c_pac_viejo'$q$), 'n=1');
    PERFORM pg_temp.chk('T1 '||k||' inserta evolución', pg_temp.como(k, pg_temp.arma_insert('cardiolink_hc_evoluciones', jsonb_build_object('id','qa3c_evo_'||k,'paciente_id','qa3c_pac_otro','profesional_id','qa3c_med_b'))), 'n=1');
    PERFORM pg_temp.chk('T1 '||k||' edita evolución ajena', pg_temp.como(k, format($q$UPDATE public.cardiolink_hc_evoluciones SET evolucion='OWNER_EDIT' WHERE id='qa3c_evo_%s'$q$, k)), 'n=1');
    PERFORM pg_temp.chk('T1 '||k||' borra evolución', pg_temp.como(k, format($q$DELETE FROM public.cardiolink_hc_evoluciones WHERE id='qa3c_evo_%s'$q$, k)), 'n=1');
    PERFORM pg_temp.chk('T1 '||k||' actualiza resumen', pg_temp.como(k, $q$UPDATE public.cardiolink_hc_resumen SET alertas='OWNER_ALERTA' WHERE paciente_id='qa3c_pac_viejo'$q$), 'n=1');
  END LOOP;
  -- el owner inserta/borra resumen (único rol con DELETE de resumen)
  PERFORM pg_temp.chk('T1 owner crea resumen', pg_temp.como('own', pg_temp.arma_insert('cardiolink_hc_resumen', jsonb_build_object('paciente_id','qa3c_pac_otro'))), 'n=1');
  PERFORM pg_temp.chk('T1 owner borra resumen', pg_temp.como('own', $q$DELETE FROM public.cardiolink_hc_resumen WHERE paciente_id='qa3c_pac_otro'$q$), 'n=1');
END $t$;

-- ===== T2 MÉDICO tipo Rogelio (med_a): consulta lo de Matías, no lo edita; escribe lo propio =====
DO $t$
BEGIN
  PERFORM pg_temp.chk('T2 Rogelio CONSULTA la evolución de Matías', pg_temp.como('med_a', $q$SELECT count(*)::text FROM public.cardiolink_hc_evoluciones WHERE id='qa3c_evo_m1'$q$), 'n=1');
  PERFORM pg_temp.chk('T2 consulta todas las evoluciones del paciente (propia y ajena)', pg_temp.como('med_a', $q$SELECT count(*)::text FROM public.cardiolink_hc_evoluciones WHERE paciente_id='qa3c_pac_viejo'$q$), 'n=2');
  PERFORM pg_temp.chk('T2 CONSULTA la evolución de Matías en un paciente que sólo atendió Matías (sin ningún vínculo propio)', pg_temp.como('med_a', $q$SELECT count(*)::text FROM public.cardiolink_hc_evoluciones WHERE id='qa3c_evo_m2'$q$), 'n=1');
  PERFORM pg_temp.chk('T2 ... y su resumen clínico (alergias)', pg_temp.como('med_a', $q$SELECT count(*)::text FROM public.cardiolink_hc_resumen WHERE paciente_id='qa3c_pac_matias' AND alergias='ALERGIA_M'$q$), 'n=1');
  PERFORM pg_temp.chk('T2 ... pero NO la edita', pg_temp.como('med_a', $q$UPDATE public.cardiolink_hc_evoluciones SET evolucion='SUPLANTADA' WHERE id='qa3c_evo_m2'$q$), 'n=0');
  PERFORM pg_temp.chk('T2 ... ni la borra', pg_temp.como('med_a', $q$DELETE FROM public.cardiolink_hc_evoluciones WHERE id='qa3c_evo_m2'$q$), 'n=0');
  PERFORM pg_temp.chk('T2 NO edita la evolución de Matías', pg_temp.como('med_a', $q$UPDATE public.cardiolink_hc_evoluciones SET evolucion='SUPLANTADA' WHERE id='qa3c_evo_m1'$q$), 'n=0');
  PERFORM pg_temp.chk('T2 NO borra la evolución de Matías', pg_temp.como('med_a', $q$DELETE FROM public.cardiolink_hc_evoluciones WHERE id='qa3c_evo_m1'$q$), 'n=0');
  PERFORM pg_temp.chk('T2 NO se la apropia (profesional_id)', pg_temp.como('med_a', $q$UPDATE public.cardiolink_hc_evoluciones SET profesional_id='qa3c_med_a' WHERE id='qa3c_evo_m1'$q$), 'n=0');
  PERFORM pg_temp.chk('T2 inserta la PRIMERA evolución en un paciente sin vínculos ni atenciones (con RETURNING)', pg_temp.como('med_a', pg_temp.arma_insert('cardiolink_hc_evoluciones', jsonb_build_object('id','qa3c_evo_a2','paciente_id','qa3c_pac_otro','profesional_id','qa3c_med_a')) || ' RETURNING id'), 'n=1');
  PERFORM pg_temp.chk('T2 NO suplanta profesional_id (Matías)', pg_temp.como('med_a', pg_temp.arma_insert('cardiolink_hc_evoluciones', jsonb_build_object('id','qa3c_evo_x1','paciente_id','qa3c_pac_otro','profesional_id','qa3c_matias'))), 'E42501');
  PERFORM pg_temp.chk('T2 NO suplanta profesional_id (otro médico)', pg_temp.como('med_a', pg_temp.arma_insert('cardiolink_hc_evoluciones', jsonb_build_object('id','qa3c_evo_x2','paciente_id','qa3c_pac_otro','profesional_id','qa3c_med_b'))), 'E42501');
  PERFORM pg_temp.chk('T2 NO inserta con profesional_id nulo', pg_temp.como('med_a', $q$INSERT INTO public.cardiolink_hc_evoluciones (id, paciente_id) VALUES ('qa3c_evo_x3','qa3c_pac_otro')$q$), 'E42501');
  PERFORM pg_temp.chk('T2 NO inserta en paciente inexistente', pg_temp.como('med_a', pg_temp.arma_insert('cardiolink_hc_evoluciones', jsonb_build_object('id','qa3c_evo_x4','paciente_id','qa3c_no_existe','profesional_id','qa3c_med_a'))), 'E42501');
  -- guardado del PR #33: UPDATE condicionado (compare-and-swap) sobre la evolución propia
  PERFORM pg_temp.chk('T2 UPDATE condicionado (editado_en nulo) en la propia', pg_temp.como('med_a', $q$UPDATE public.cardiolink_hc_evoluciones SET evolucion='A1_EDIT1', editado_en=now() WHERE id='qa3c_evo_a1' AND editado_en IS NULL RETURNING id$q$), 'n=1');
  PERFORM pg_temp.chk('T2 UPDATE condicionado obsoleto: 0 filas (CAS normal, no error)', pg_temp.como('med_a', $q$UPDATE public.cardiolink_hc_evoluciones SET evolucion='A1_EDIT2', editado_en=now() WHERE id='qa3c_evo_a1' AND editado_en IS NULL RETURNING id$q$), 'n=0');
  PERFORM pg_temp.chk('T2 NO transfiere su evolución a otro profesional', pg_temp.como('med_a', $q$UPDATE public.cardiolink_hc_evoluciones SET profesional_id='qa3c_med_b' WHERE id='qa3c_evo_a1'$q$), 'E42501');
  PERFORM pg_temp.chk('T2 NO mueve su evolución a un paciente inexistente', pg_temp.como('med_a', $q$UPDATE public.cardiolink_hc_evoluciones SET paciente_id='qa3c_no_existe' WHERE id='qa3c_evo_a1'$q$), 'E42501');
  PERFORM pg_temp.chk('T2 borra una evolución PROPIA', pg_temp.como('med_a', $q$DELETE FROM public.cardiolink_hc_evoluciones WHERE id='qa3c_evo_a2'$q$), 'n=1');
  -- resumen compartido
  PERFORM pg_temp.chk('T2 lee el resumen (alergias) cargado por otro', pg_temp.como('med_a', $q$SELECT count(*)::text FROM public.cardiolink_hc_resumen WHERE paciente_id='qa3c_pac_viejo' AND alergias='ALERGIA_ORIGINAL'$q$), 'n=1');
  PERFORM pg_temp.chk('T2 actualiza el resumen (UPDATE condicionado por actualizado_en nulo o vigente)', pg_temp.como('med_a', $q$UPDATE public.cardiolink_hc_resumen SET alergias='ALERGIA_A', actualizado_en=now() WHERE paciente_id='qa3c_pac_viejo' RETURNING paciente_id$q$), 'n=1');
  PERFORM pg_temp.chk('T2 crea el primer resumen de un paciente nuevo', pg_temp.como('med_a', pg_temp.arma_insert('cardiolink_hc_resumen', jsonb_build_object('paciente_id','qa3c_pac_otro','alergias','A_NUEVO'))), 'n=1');
  PERFORM pg_temp.chk('T2 NO borra resúmenes', pg_temp.como('med_a', $q$DELETE FROM public.cardiolink_hc_resumen WHERE paciente_id='qa3c_pac_otro'$q$), 'n=0');
END $t$;

-- ===== T3 MÉDICO NUEVO (med_b): sin vínculos, atenciones ni evoluciones =====
DO $t$
BEGIN
  PERFORM pg_temp.chk('T3 médico nuevo lee evoluciones de Matías y de otro médico', pg_temp.como('med_b', $q$SELECT count(*)::text FROM public.cardiolink_hc_evoluciones WHERE paciente_id='qa3c_pac_viejo'$q$), 'n=2');
  PERFORM pg_temp.chk('T3 lee el resumen actualizado por otro médico', pg_temp.como('med_b', $q$SELECT count(*)::text FROM public.cardiolink_hc_resumen WHERE paciente_id='qa3c_pac_viejo' AND alergias='ALERGIA_A'$q$), 'n=1');
  PERFORM pg_temp.chk('T3 médico nuevo consulta una evolución de Matías en un paciente sin vínculo propio', pg_temp.como('med_b', $q$SELECT count(*)::text FROM public.cardiolink_hc_evoluciones WHERE id='qa3c_evo_m2'$q$), 'n=1');
  PERFORM pg_temp.chk('T3 NO edita la evolución de otro (Rogelio)', pg_temp.como('med_b', $q$UPDATE public.cardiolink_hc_evoluciones SET evolucion='X' WHERE id='qa3c_evo_a1'$q$), 'n=0');
  PERFORM pg_temp.chk('T3 NO borra la evolución de otro', pg_temp.como('med_b', $q$DELETE FROM public.cardiolink_hc_evoluciones WHERE id='qa3c_evo_a1'$q$), 'n=0');
  PERFORM pg_temp.chk('T3 inserta la suya en el mismo paciente', pg_temp.como('med_b', pg_temp.arma_insert('cardiolink_hc_evoluciones', jsonb_build_object('id','qa3c_evo_b1','paciente_id','qa3c_pac_viejo','profesional_id','qa3c_med_b'))), 'n=1');
  PERFORM pg_temp.chk('T3 actualiza el resumen compartido', pg_temp.como('med_b', $q$UPDATE public.cardiolink_hc_resumen SET medicacion_habitual='MED_B', actualizado_en=now() WHERE paciente_id='qa3c_pac_viejo'$q$), 'n=1');
END $t$;

-- ===== T4 SECRETARÍA: sin acceso directo a HC y flujos administrativos intactos =====
DO $t$
BEGIN
  PERFORM pg_temp.chk('T4 Secretaría: 0 evoluciones visibles', pg_temp.como('sec', $q$SELECT count(*)::text FROM public.cardiolink_hc_evoluciones$q$), 'n=0');
  PERFORM pg_temp.chk('T4 Secretaría: 0 resúmenes visibles', pg_temp.como('sec', $q$SELECT count(*)::text FROM public.cardiolink_hc_resumen$q$), 'n=0');
  PERFORM pg_temp.chk('T4 Secretaría NO inserta evolución', pg_temp.como('sec', pg_temp.arma_insert('cardiolink_hc_evoluciones', jsonb_build_object('id','qa3c_evo_s1','paciente_id','qa3c_pac_viejo','profesional_id','qa3c_med_a'))), 'E42501');
  PERFORM pg_temp.chk('T4 Secretaría NO inserta resumen', pg_temp.como('sec', pg_temp.arma_insert('cardiolink_hc_resumen', jsonb_build_object('paciente_id','qa3c_pac_otro'))), 'E42501');
  PERFORM pg_temp.chk('T4 Secretaría NO edita evoluciones', pg_temp.como('sec', $q$UPDATE public.cardiolink_hc_evoluciones SET evolucion='S'$q$), 'n=0');
  PERFORM pg_temp.chk('T4 Secretaría NO borra evoluciones', pg_temp.como('sec', $q$DELETE FROM public.cardiolink_hc_evoluciones$q$), 'n=0');
  PERFORM pg_temp.chk('T4 Secretaría NO edita resúmenes', pg_temp.como('sec', $q$UPDATE public.cardiolink_hc_resumen SET alergias='S'$q$), 'n=0');
  PERFORM pg_temp.chk('T4 Secretaría NO borra resúmenes', pg_temp.como('sec', $q$DELETE FROM public.cardiolink_hc_resumen$q$), 'n=0');
  -- administrativo intacto: ficha de paciente (crear y leer) sigue funcionando
  PERFORM pg_temp.chk('T4 Secretaría crea una ficha de paciente nueva (flujo administrativo)', pg_temp.como('sec', pg_temp.arma_insert('cardiolink_pacientes', jsonb_build_object('id','qa3c_pac_sec'))), 'n=1');
  PERFORM pg_temp.chk('T4 Secretaría lee la ficha', pg_temp.como('sec', $q$SELECT count(*)::text FROM public.cardiolink_pacientes WHERE id='qa3c_pac_sec'$q$), 'n=1');
  -- paciente nuevo (ficha de Secretaría): el médico lo ve y crea su primera evolución y resumen
  PERFORM pg_temp.chk('T4b paciente nuevo creado por Secretaría: el médico crea su 1.ª evolución', pg_temp.como('med_a', pg_temp.arma_insert('cardiolink_hc_evoluciones', jsonb_build_object('id','qa3c_evo_a3','paciente_id','qa3c_pac_sec','profesional_id','qa3c_med_a'))), 'n=1');
  PERFORM pg_temp.chk('T4b ... y su resumen', pg_temp.como('med_a', pg_temp.arma_insert('cardiolink_hc_resumen', jsonb_build_object('paciente_id','qa3c_pac_sec'))), 'n=1');
  PERFORM pg_temp.chk('T4b ... Secretaría sigue sin ver esa HC', pg_temp.como('sec', $q$SELECT count(*)::text FROM public.cardiolink_hc_evoluciones WHERE paciente_id='qa3c_pac_sec'$q$), 'n=0');
END $t$;

-- ===== T5 INACTIVO, SIN PROFESIONAL, SIN ROL, ANON =====
DO $t$
DECLARE k text;
BEGIN
  FOREACH k IN ARRAY ARRAY['inact','sinprof','norol'] LOOP
    PERFORM pg_temp.chk('T5 '||k||': 0 evoluciones', pg_temp.como(k, $q$SELECT count(*)::text FROM public.cardiolink_hc_evoluciones$q$), 'n=0');
    PERFORM pg_temp.chk('T5 '||k||': 0 resúmenes', pg_temp.como(k, $q$SELECT count(*)::text FROM public.cardiolink_hc_resumen$q$), 'n=0');
    PERFORM pg_temp.chk('T5 '||k||': no inserta evolución', pg_temp.como(k, pg_temp.arma_insert('cardiolink_hc_evoluciones', jsonb_build_object('id','qa3c_evo_i_'||k,'paciente_id','qa3c_pac_viejo','profesional_id', coalesce((SELECT prof FROM t_act WHERE clave=k),'qa3c_x')))), 'E42501');
    PERFORM pg_temp.chk('T5 '||k||': no inserta resumen', pg_temp.como(k, pg_temp.arma_insert('cardiolink_hc_resumen', jsonb_build_object('paciente_id','qa3c_pac_otro'))), 'E42501');
    PERFORM pg_temp.chk('T5 '||k||': no edita ni borra', pg_temp.como(k, $q$UPDATE public.cardiolink_hc_evoluciones SET evolucion='X'$q$) || '/' || pg_temp.como(k, $q$DELETE FROM public.cardiolink_hc_resumen$q$), 'n=0/n=0');
  END LOOP;
  -- anon: sin sesión (sin privilegios o sin filas; nunca datos ni escritura)
  PERFORM pg_temp.chk_uno('T5 anon no lee evoluciones', pg_temp.como('anon', $q$SELECT count(*)::text FROM public.cardiolink_hc_evoluciones$q$), ARRAY['n=0','E42501']);
  PERFORM pg_temp.chk_uno('T5 anon no lee resúmenes', pg_temp.como('anon', $q$SELECT count(*)::text FROM public.cardiolink_hc_resumen$q$), ARRAY['n=0','E42501']);
  PERFORM pg_temp.chk_uno('T5 anon no inserta evolución', pg_temp.como('anon', pg_temp.arma_insert('cardiolink_hc_evoluciones', jsonb_build_object('id','qa3c_evo_anon','paciente_id','qa3c_pac_viejo','profesional_id','qa3c_med_a'))), ARRAY['E42501']);
  PERFORM pg_temp.chk_uno('T5 anon no inserta resumen', pg_temp.como('anon', pg_temp.arma_insert('cardiolink_hc_resumen', jsonb_build_object('paciente_id','qa3c_pac_otro'))), ARRAY['E42501']);
  PERFORM pg_temp.chk_uno('T5 anon no edita', pg_temp.como('anon', $q$UPDATE public.cardiolink_hc_evoluciones SET evolucion='X'$q$), ARRAY['n=0','E42501']);
  PERFORM pg_temp.chk_uno('T5 anon no borra', pg_temp.como('anon', $q$DELETE FROM public.cardiolink_hc_resumen$q$), ARRAY['n=0','E42501']);
  PERFORM pg_temp.chk_uno('T5 anon no ejecuta el padrón', pg_temp.como('anon', $q$SELECT public.cardiolink_paciente_padron_v1('qa3c_pac_viejo')::text$q$), ARRAY['E42501']);
END $t$;

-- ===== T6 REVOCACIÓN: desactivar la fila de rol corta el acceso al instante; reactivar lo devuelve =====
DO $t$
BEGIN
  UPDATE public.cardiolink_user_roles SET active = false WHERE user_id = (SELECT uid FROM t_act WHERE clave='med_b');
  PERFORM pg_temp.chk('T6 médico desactivado: 0 evoluciones', pg_temp.como('med_b', $q$SELECT count(*)::text FROM public.cardiolink_hc_evoluciones$q$), 'n=0');
  PERFORM pg_temp.chk('T6 médico desactivado: no edita ni su propia evolución', pg_temp.como('med_b', $q$UPDATE public.cardiolink_hc_evoluciones SET evolucion='X' WHERE id='qa3c_evo_b1'$q$), 'n=0');
  UPDATE public.cardiolink_user_roles SET active = true WHERE user_id = (SELECT uid FROM t_act WHERE clave='med_b');
  PERFORM pg_temp.chk('T6 reactivado: vuelve a leer', pg_temp.como('med_b', $q$SELECT (count(*) > 0)::text FROM public.cardiolink_hc_evoluciones$q$), 'n=true');
  -- un médico NUEVO sólo con la fila de rol (alta = autorización): se crea en el momento y accede
  PERFORM pg_temp.chk('T6 alta de un médico = fila de rol: ya consulta', pg_temp.como('inact', $q$SELECT count(*)::text FROM public.cardiolink_hc_evoluciones$q$), 'n=0');
  UPDATE public.cardiolink_user_roles SET active = true WHERE user_id = (SELECT uid FROM t_act WHERE clave='inact');
  PERFORM pg_temp.chk('T6 ... al activarlo consulta toda la HC', pg_temp.como('inact', $q$SELECT (count(*) >= 3)::text FROM public.cardiolink_hc_evoluciones$q$), 'n=true');
  PERFORM pg_temp.chk('T6 ... y no edita la de otros', pg_temp.como('inact', $q$UPDATE public.cardiolink_hc_evoluciones SET evolucion='X' WHERE id='qa3c_evo_m1'$q$), 'n=0');
  UPDATE public.cardiolink_user_roles SET active = false WHERE user_id = (SELECT uid FROM t_act WHERE clave='inact');
END $t$;

-- ===== T7 la evolución de Matías quedó INTACTA tras todos los intentos de los demás =====
DO $t$
BEGIN
  IF (SELECT md5(evolucion) FROM public.cardiolink_hc_evoluciones WHERE id='qa3c_evo_m1') IS DISTINCT FROM (SELECT h FROM t_h) THEN RAISE EXCEPTION 'FALLA T7: la evolución de Matías cambió'; END IF;
  IF (SELECT md5(evolucion) FROM public.cardiolink_hc_evoluciones WHERE id='qa3c_evo_m2') IS DISTINCT FROM (SELECT h2 FROM t_h) THEN RAISE EXCEPTION 'FALLA T7: la evolución m2 de Matías cambió'; END IF;
  IF (SELECT profesional_id FROM public.cardiolink_hc_evoluciones WHERE id='qa3c_evo_m1') <> 'qa3c_matias' THEN RAISE EXCEPTION 'FALLA T7: cambió el profesional de la evolución de Matías'; END IF;
  INSERT INTO t_res VALUES ('T7 la evolución de Matías no cambió (texto ni profesional_id)');
END $t$;

-- ===== T8 políticas: abiertas reemplazadas; 8 políticas _v1 sólo TO authenticated =====
DO $t$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND (policyname LIKE '%\_authenticated' ESCAPE '\' OR qual='true' OR with_check='true')) THEN RAISE EXCEPTION 'FALLA T8: quedan políticas abiertas'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen')) <> 8 THEN RAISE EXCEPTION 'FALLA T8: no son 8 políticas'; END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND (permissive <> 'PERMISSIVE' OR roles <> ARRAY['authenticated']::name[])) THEN RAISE EXCEPTION 'FALLA T8: política con rol distinto de authenticated'; END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.cardiolink_hc_evoluciones'::regclass) OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.cardiolink_hc_resumen'::regclass) THEN RAISE EXCEPTION 'FALLA T8: RLS apagada'; END IF;
  INSERT INTO t_res VALUES ('T8 abiertas reemplazadas; 8 políticas _v1 PERMISSIVE sólo TO authenticated; RLS activa');
END $t$;

-- ===== T9 SECURITY DEFINER: no permiten eludir; sin EXECUTE para anon/PUBLIC; todo lo ejecutable que toca HC devuelve sólo boolean =====
DO $t$
DECLARE f record; n int := 0;
BEGIN
  FOR f IN SELECT p.oid, p.oid::regprocedure::text AS firma, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS dueno, p.prorettype
             FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname IN ('cardiolink_ctx_rol_v1','cardiolink_ctx_prof_v1','cardiolink_paciente_padron_v1','cardiolink_paciente_acceso_clinico_v1') LOOP
    n := n + 1;
    IF NOT f.prosecdef OR f.dueno <> 'postgres' OR NOT (f.proconfig::text LIKE '%search_path=pg_catalog, public%') THEN RAISE EXCEPTION 'FALLA T9: % no es SECURITY DEFINER con search_path fijo y dueño postgres', f.firma; END IF;
    IF has_function_privilege('anon', f.oid, 'EXECUTE') OR has_function_privilege('public', f.oid, 'EXECUTE') THEN RAISE EXCEPTION 'FALLA T9: % ejecutable por anon/PUBLIC', f.firma; END IF;
  END LOOP;
  IF n < 4 THEN RAISE EXCEPTION 'FALLA T9: faltan funciones de contexto (%)', n; END IF;
  -- cualquier función SECURITY DEFINER que lea HC y sea ejecutable por anon/authenticated debe devolver sólo boolean
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.prosecdef AND p.prosrc ~* 'cardiolink_hc_(evoluciones|resumen)' AND p.prorettype <> 'boolean'::regtype
               AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))) THEN RAISE EXCEPTION 'FALLA T9: una función SECURITY DEFINER que lee HC y devuelve algo distinto de boolean es ejecutable por anon/authenticated'; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.prosecdef AND p.prosrc ~* 'cardiolink_hc_(evoluciones|resumen)' AND has_function_privilege('anon', p.oid, 'EXECUTE')) THEN RAISE EXCEPTION 'FALLA T9: una función que lee HC es ejecutable por anon'; END IF;
  IF EXISTS (SELECT 1 FROM pg_class c WHERE c.relkind IN ('v','m') AND c.relnamespace='public'::regnamespace AND pg_get_viewdef(c.oid) ~* 'cardiolink_hc_(evoluciones|resumen)') THEN RAISE EXCEPTION 'FALLA T9: hay vistas sobre las tablas de HC (evitarían la RLS)'; END IF;
  IF EXISTS (SELECT 1 FROM pg_publication_tables WHERE tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen')) THEN RAISE EXCEPTION 'FALLA T9: las tablas de HC están en una publicación (Realtime)'; END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid IN ('public.cardiolink_hc_evoluciones'::regclass,'public.cardiolink_hc_resumen'::regclass) AND NOT tgisinternal) THEN RAISE EXCEPTION 'FALLA T9: hay triggers sobre HC (revisar que no sean SECURITY DEFINER que eludan permisos)'; END IF;
  INSERT INTO t_res VALUES ('T9 funciones de contexto SECURITY DEFINER con search_path fijo y sin EXECUTE para anon/PUBLIC; las que leen HC devuelven sólo boolean; sin vistas, publicaciones ni triggers sobre HC');
END $t$;
-- ===== T10 privilegios (D5 aprobada): anon sin nada; authenticated exactamente SELECT/INSERT/UPDATE/DELETE; la RLS sigue filtrando =====
SELECT pg_temp.snap_acl('pre');
DO $t$ BEGIN
  INSERT INTO t_res VALUES ('T10 informativo (antes): TRUNCATE anon=' || has_table_privilege('anon','public.cardiolink_hc_evoluciones','TRUNCATE') || ' authenticated=' || has_table_privilege('authenticated','public.cardiolink_hc_evoluciones','TRUNCATE'));
END $t$;
DO $ens$ BEGIN EXECUTE $b$
-- CardioLink · Seguridad clínica V1 · p3c · D5 APROBADA (2026-11-20) · ENDURECIMIENTO DE PRIVILEGIOS de las 2 tablas de HC (parte de la publicación de p3c).
-- NO EJECUTAR en Production sin autorización explícita. Una sola transacción. Rollback: …_p3c_grants_hc_rollback.sql
-- Hallazgo: Supabase otorga por defecto a anon y authenticated TODOS los privilegios de tabla. La RLS sólo cubre SELECT/INSERT/UPDATE/DELETE: TRUNCATE (en Production, anon y authenticated lo tienen), TRIGGER y REFERENCES NO pasan por RLS.
-- PostgREST no expone TRUNCATE, así que no era explotable por la API; esto es defensa en profundidad.
-- Efecto: anon y PUBLIC pierden todo. authenticated conserva EXACTAMENTE SELECT/INSERT/UPDATE/DELETE (lo que usan los médicos y las políticas RLS, que siguen filtrando); pierde TRUNCATE, TRIGGER y REFERENCES.
-- No afecta a service_role (edge functions) ni a las funciones SECURITY DEFINER (corren como su dueño). Sin privilegios por columna ni WITH GRANT OPTION (se verifica).
REVOKE ALL ON TABLE public.cardiolink_hc_evoluciones, public.cardiolink_hc_resumen FROM PUBLIC, anon;
REVOKE TRUNCATE, TRIGGER, REFERENCES ON TABLE public.cardiolink_hc_evoluciones, public.cardiolink_hc_resumen FROM authenticated;
DO $$
DECLARE t text; p text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.cardiolink_hc_evoluciones','public.cardiolink_hc_resumen'] LOOP
    -- anon: ningún privilegio de tabla ni de columna
    FOREACH p IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
      IF has_table_privilege('anon', t, p) THEN RAISE EXCEPTION 'Postcondición: anon conserva % sobre %', p, t; END IF;
    END LOOP;
    IF has_any_column_privilege('anon', t, 'SELECT') OR has_any_column_privilege('anon', t, 'INSERT') OR has_any_column_privilege('anon', t, 'UPDATE') OR has_any_column_privilege('anon', t, 'REFERENCES') THEN RAISE EXCEPTION 'Postcondición: anon con privilegios por columna sobre %', t; END IF;
    -- authenticated: exactamente SELECT/INSERT/UPDATE/DELETE
    FOREACH p IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
      IF NOT has_table_privilege('authenticated', t, p) THEN RAISE EXCEPTION 'Postcondición: authenticated perdió % sobre % (lo necesitan las políticas RLS)', p, t; END IF;
    END LOOP;
    FOREACH p IN ARRAY ARRAY['TRUNCATE','REFERENCES','TRIGGER'] LOOP
      IF has_table_privilege('authenticated', t, p) THEN RAISE EXCEPTION 'Postcondición: authenticated conserva % sobre %', p, t; END IF;
    END LOOP;
    -- nadie con GRANT OPTION ni PUBLIC (grantee 0) en la ACL
    IF EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid = t::regclass AND (a.grantee = 0 OR (a.is_grantable AND a.grantee::regrole::text IN ('anon','authenticated')))) THEN RAISE EXCEPTION 'Postcondición: ACL con PUBLIC o GRANT OPTION sobre %', t; END IF;
  END LOOP;
END $$;
$b$; END $ens$;
DO $t$
DECLARE t text; p text; esperado boolean;
BEGIN
  -- matriz de privilegios EFECTIVOS (considera membresías y PUBLIC)
  FOREACH t IN ARRAY ARRAY['public.cardiolink_hc_evoluciones','public.cardiolink_hc_resumen'] LOOP
    FOREACH p IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
      esperado := p IN ('SELECT','INSERT','UPDATE','DELETE');
      IF has_table_privilege('anon', t, p) THEN RAISE EXCEPTION 'FALLA T10: anon tiene % sobre %', p, t; END IF;
      IF has_table_privilege('authenticated', t, p) IS DISTINCT FROM esperado THEN RAISE EXCEPTION 'FALLA T10: authenticated % sobre % = % (esperado %)', p, t, has_table_privilege('authenticated', t, p), esperado; END IF;
    END LOOP;
    IF NOT has_table_privilege('service_role', t, 'SELECT,INSERT,UPDATE,DELETE') THEN RAISE EXCEPTION 'FALLA T10: service_role perdió privilegios sobre %', t; END IF;
  END LOOP;
  INSERT INTO t_res VALUES ('T10 matriz efectiva: anon nada; authenticated SELECT/INSERT/UPDATE/DELETE y sin TRUNCATE/REFERENCES/TRIGGER; service_role intacto');
  PERFORM pg_temp.chk('T10 anon: SELECT denegado por privilegio', pg_temp.como('anon', $q$SELECT count(*)::text FROM public.cardiolink_hc_evoluciones$q$), 'E42501');
  PERFORM pg_temp.chk('T10 anon: INSERT denegado por privilegio', pg_temp.como('anon', pg_temp.arma_insert('cardiolink_hc_resumen', jsonb_build_object('paciente_id','qa3c_pac_otro'))), 'E42501');
  PERFORM pg_temp.chk('T10 médico: TRUNCATE denegado', pg_temp.como('med_a', 'TRUNCATE public.cardiolink_hc_resumen'), 'E42501');
  PERFORM pg_temp.chk('T10 owner: TRUNCATE denegado', pg_temp.como('own', 'TRUNCATE public.cardiolink_hc_evoluciones'), 'E42501');
  PERFORM pg_temp.chk('T10 con privilegios reducidos el médico sigue leyendo (RLS)', pg_temp.como('med_a', $q$SELECT (count(*) >= 2)::text FROM public.cardiolink_hc_evoluciones$q$), 'n=true');
  PERFORM pg_temp.chk('T10 ... escribiendo lo propio (UPDATE condicionado)', pg_temp.como('med_a', $q$UPDATE public.cardiolink_hc_evoluciones SET evolucion='A1_G', editado_en=now() WHERE id='qa3c_evo_a1' RETURNING id$q$), 'n=1');
  PERFORM pg_temp.chk('T10 ... creando evolución y resumen', pg_temp.como('med_a', pg_temp.arma_insert('cardiolink_hc_evoluciones', jsonb_build_object('id','qa3c_evo_g1','paciente_id','qa3c_pac_otro','profesional_id','qa3c_med_a')) || ' RETURNING id'), 'n=1');
  PERFORM pg_temp.chk('T10 ... Secretaría sigue en 0', pg_temp.como('sec', $q$SELECT count(*)::text FROM public.cardiolink_hc_evoluciones$q$), 'n=0');
END $t$;

-- ===== T11 AJUSTE 1 · integridad de evoluciones =====
-- Control previo: SIN el trigger el médico SÍ podía trasladar su evolución a otro paciente existente (el hueco que se cierra)
DO $t$ BEGIN
  PERFORM pg_temp.chk('T11 control previo: sin el trigger el médico traslada su evolución a otro paciente existente (hueco)', pg_temp.como('med_a', $q$UPDATE public.cardiolink_hc_evoluciones SET paciente_id='qa3c_pac_otro' WHERE id='qa3c_evo_a1'$q$), 'n=1');
  UPDATE public.cardiolink_hc_evoluciones SET paciente_id='qa3c_pac_viejo' WHERE id='qa3c_evo_a1';   -- restituye (como postgres)
END $t$;
DO $ens$ BEGIN EXECUTE $b$
-- CardioLink · Seguridad clínica V1 · p3c · AJUSTE 1 · INTEGRIDAD DE EVOLUCIONES (protección mínima en base de datos). Aprobado por el Dueño (2026-11-20).
-- ESTADO: PREPARADO PARA REVISIÓN. NO EJECUTAR en Production sin autorización explícita. Una sola transacción, sin DML sobre datos. Rollback: …_p3c_integridad_evoluciones_rollback.sql
-- Requiere p3c aplicada (o el delta) y cardiolink_ctx_rol_v1().
--
-- HUECO CERRADO: la política de UPDATE de evoluciones permite al médico editar sus evoluciones y valida (WITH CHECK) que sigan siendo suyas, pero NO impedía cambiar paciente_id a OTRO paciente existente
-- (el ensayo lo demuestra antes de aplicar este trigger). Un trigger BEFORE UPDATE congela la identidad de la fila:
--   · id y paciente_id: inmutables para cualquier sesión de usuario (owner/admin incluidos). Una evolución mal cargada se corrige borrándola y creándola de nuevo, o con mantenimiento por SQL.
--   · profesional_id: sólo owner/admin pueden cambiarlo (permiso existente); cualquier otro rol recibe 42501 (defensa en profundidad: las políticas RLS ya lo impedían al médico).
--   · Mantenimiento por SQL Editor/postgres/service_role (sin sesión de usuario: auth.uid() nulo) no se ve afectado (backfills, correcciones administrativas).
-- COMPATIBILIDAD PR #33: el guardado multidispositivo sólo actualiza campos de contenido + editado_en/editado_por; el upsert de reintento (ON CONFLICT (id)) reenvía el MISMO paciente_id y profesional_id. Ninguno cambia id/paciente_id/profesional_id.
DO $$
BEGIN
  IF to_regclass('public.cardiolink_hc_evoluciones') IS NULL OR to_regprocedure('public.cardiolink_ctx_rol_v1()') IS NULL THEN RAISE EXCEPTION 'Precondición: faltan cardiolink_hc_evoluciones / cardiolink_ctx_rol_v1()'; END IF;
  IF (SELECT qual FROM pg_policies WHERE schemaname='public' AND policyname='cardiolink_hc_evoluciones_select_v1') IS NULL OR (SELECT qual FROM pg_policies WHERE schemaname='public' AND policyname='cardiolink_hc_evoluciones_select_v1') NOT LIKE '%cardiolink_paciente_padron_v1%' THEN
    RAISE EXCEPTION 'Precondición: aplicar antes p3c (o su delta)'; END IF;
  IF to_regprocedure('public.cardiolink_hc_evolucion_inmutables_v1()') IS NOT NULL OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.cardiolink_hc_evoluciones'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'Precondición: ya existe la función/trigger de integridad u otro trigger sobre cardiolink_hc_evoluciones (¿ya aplicado?)'; END IF;
END $$;

CREATE FUNCTION public.cardiolink_hc_evolucion_inmutables_v1()
 RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $f$
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;   -- sin sesión de usuario = mantenimiento (SQL Editor / postgres / service_role)
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.paciente_id IS DISTINCT FROM OLD.paciente_id THEN
    RAISE EXCEPTION 'Una evolución no puede cambiar de paciente' USING ERRCODE = '42501';
  END IF;
  IF NEW.profesional_id IS DISTINCT FROM OLD.profesional_id AND coalesce(public.cardiolink_ctx_rol_v1(), '') NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'No se puede transferir la evolución a otro profesional' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $f$;
REVOKE ALL ON FUNCTION public.cardiolink_hc_evolucion_inmutables_v1() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.cardiolink_hc_evolucion_inmutables_v1() IS 'Seguridad clínica V1 p3c: id y paciente_id de una evolución son inmutables para sesiones de usuario; profesional_id sólo lo cambia owner/admin. SECURITY INVOKER; mantenimiento sin sesión no se ve afectado.';

CREATE TRIGGER cardiolink_hc_evoluciones_inmutables_v1
  BEFORE UPDATE ON public.cardiolink_hc_evoluciones
  FOR EACH ROW EXECUTE FUNCTION public.cardiolink_hc_evolucion_inmutables_v1();

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.cardiolink_hc_evoluciones'::regclass AND NOT tgisinternal AND tgname='cardiolink_hc_evoluciones_inmutables_v1' AND tgenabled='O') <> 1 THEN RAISE EXCEPTION 'Postcondición: el trigger no quedó habilitado'; END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid='public.cardiolink_hc_evolucion_inmutables_v1()'::regprocedure) THEN RAISE EXCEPTION 'Postcondición: la función del trigger no debe ser SECURITY DEFINER'; END IF;
END $$;
$b$; END $ens$;
DO $t$
DECLARE n bigint;
BEGIN
  PERFORM pg_temp.chk('T11 médico NO traslada su evolución a otro paciente', pg_temp.como('med_a', $q$UPDATE public.cardiolink_hc_evoluciones SET paciente_id='qa3c_pac_otro' WHERE id='qa3c_evo_a1'$q$), 'E42501');
  PERFORM pg_temp.chk('T11 médico NO cambia el id de su evolución', pg_temp.como('med_a', $q$UPDATE public.cardiolink_hc_evoluciones SET id='qa3c_evo_a1_otro' WHERE id='qa3c_evo_a1'$q$), 'E42501');
  PERFORM pg_temp.chk('T11 médico NO transfiere su evolución a otro profesional', pg_temp.como('med_a', $q$UPDATE public.cardiolink_hc_evoluciones SET profesional_id='qa3c_med_b' WHERE id='qa3c_evo_a1'$q$), 'E42501');
  PERFORM pg_temp.chk('T11 médico NO se apropia de la evolución de Matías', pg_temp.como('med_a', $q$UPDATE public.cardiolink_hc_evoluciones SET profesional_id='qa3c_med_a' WHERE id='qa3c_evo_m1'$q$), 'n=0');
  PERFORM pg_temp.chk('T11 owner tampoco traslada una evolución a otro paciente', pg_temp.como('own', $q$UPDATE public.cardiolink_hc_evoluciones SET paciente_id='qa3c_pac_otro' WHERE id='qa3c_evo_a1'$q$), 'E42501');
  PERFORM pg_temp.chk('T11 admin tampoco', pg_temp.como('adm', $q$UPDATE public.cardiolink_hc_evoluciones SET paciente_id='qa3c_pac_otro' WHERE id='qa3c_evo_m1'$q$), 'E42501');
  PERFORM pg_temp.chk('T11 owner SÍ puede reasignar el profesional (permiso existente de owner/admin)', pg_temp.como('own', $q$UPDATE public.cardiolink_hc_evoluciones SET profesional_id='qa3c_med_b' WHERE id='qa3c_evo_a1'$q$), 'n=1');
  UPDATE public.cardiolink_hc_evoluciones SET profesional_id='qa3c_med_a' WHERE id='qa3c_evo_a1';   -- restituye (mantenimiento sin sesión)
  UPDATE public.cardiolink_hc_evoluciones SET paciente_id='qa3c_pac_otro' WHERE id='qa3c_evo_a1'; GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM pg_temp.chk('T11 mantenimiento por SQL (sin sesión de usuario) no se ve afectado', 'n=' || n, 'n=1');
  UPDATE public.cardiolink_hc_evoluciones SET paciente_id='qa3c_pac_viejo' WHERE id='qa3c_evo_a1';
  -- compatibilidad con el guardado multidispositivo del PR #33
  PERFORM pg_temp.chk('T11/PR#33 UPDATE condicionado de campos de contenido (propia)', pg_temp.como('med_a', $q$UPDATE public.cardiolink_hc_evoluciones SET evolucion='A1_PR33', motivo='M', editado_en='2031-01-01', editado_por='QA' WHERE id='qa3c_evo_a1' AND editado_en IS DISTINCT FROM '2031-01-01' RETURNING id$q$), 'n=1');
  PERFORM pg_temp.chk('T11/PR#33 upsert de reintento (ON CONFLICT (id), mismo paciente y profesional) sobre la propia', pg_temp.como('med_a', $q$INSERT INTO public.cardiolink_hc_evoluciones (id, paciente_id, profesional_id, evolucion) VALUES ('qa3c_evo_a1','qa3c_pac_viejo','qa3c_med_a','A1_UPSERT') ON CONFLICT (id) DO UPDATE SET evolucion=EXCLUDED.evolucion, paciente_id=EXCLUDED.paciente_id, profesional_id=EXCLUDED.profesional_id RETURNING id$q$), 'n=1');
  PERFORM pg_temp.chk('T11/PR#33 el upsert con OTRO paciente_id es rechazado', pg_temp.como('med_a', $q$INSERT INTO public.cardiolink_hc_evoluciones (id, paciente_id, profesional_id, evolucion) VALUES ('qa3c_evo_a1','qa3c_pac_otro','qa3c_med_a','A1_MOVIDA') ON CONFLICT (id) DO UPDATE SET paciente_id=EXCLUDED.paciente_id RETURNING id$q$), 'E42501');
  PERFORM pg_temp.chk('T11/PR#33 el upsert sobre la evolución de Matías sigue rechazado/sin efecto', pg_temp.como('med_a', $q$INSERT INTO public.cardiolink_hc_evoluciones (id, paciente_id, profesional_id, evolucion) VALUES ('qa3c_evo_m1','qa3c_pac_viejo','qa3c_med_a','PISA') ON CONFLICT (id) DO UPDATE SET evolucion=EXCLUDED.evolucion RETURNING id$q$), 'E42501');
  PERFORM pg_temp.chk('T11/PR#33 el resumen (UPDATE condicionado) no cambia', pg_temp.como('med_b', $q$UPDATE public.cardiolink_hc_resumen SET medicacion_habitual='MED_T11', actualizado_en='2031-01-01' WHERE paciente_id='qa3c_pac_viejo' AND actualizado_en IS DISTINCT FROM '2031-01-01' RETURNING paciente_id$q$), 'n=1');
  PERFORM pg_temp.chk('T11 Secretaría y sin rol siguen sin acceso', pg_temp.como('sec', $q$UPDATE public.cardiolink_hc_evoluciones SET evolucion='X'$q$) || '/' || pg_temp.como('norol', $q$UPDATE public.cardiolink_hc_evoluciones SET paciente_id='qa3c_pac_otro'$q$), 'n=0/n=0');
  -- propiedades del trigger
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid='public.cardiolink_hc_evoluciones'::regclass AND t.tgname='cardiolink_hc_evoluciones_inmutables_v1' AND t.tgenabled='O' AND NOT p.prosecdef AND p.proconfig::text LIKE '%search_path=pg_catalog, public%')
     OR has_function_privilege('anon','public.cardiolink_hc_evolucion_inmutables_v1()','EXECUTE') OR has_function_privilege('authenticated','public.cardiolink_hc_evolucion_inmutables_v1()','EXECUTE') THEN RAISE EXCEPTION 'FALLA T11: propiedades del trigger'; END IF;
  INSERT INTO t_res VALUES ('T11 trigger habilitado, SECURITY INVOKER, search_path fijo y sin EXECUTE para anon/authenticated');
END $t$;
-- ===== rollbacks de integridad y de privilegios =====
DO $ens$ BEGIN EXECUTE $b$
-- ROLLBACK del ajuste de integridad de evoluciones: elimina el trigger y su función. Una sola transacción.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.cardiolink_hc_evoluciones'::regclass AND tgname='cardiolink_hc_evoluciones_inmutables_v1') THEN RAISE EXCEPTION 'Rollback: el trigger de integridad no está aplicado'; END IF;
END $$;
DROP TRIGGER cardiolink_hc_evoluciones_inmutables_v1 ON public.cardiolink_hc_evoluciones;
DROP FUNCTION public.cardiolink_hc_evolucion_inmutables_v1();
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.cardiolink_hc_evoluciones'::regclass AND NOT tgisinternal) OR to_regprocedure('public.cardiolink_hc_evolucion_inmutables_v1()') IS NOT NULL THEN RAISE EXCEPTION 'Rollback: quedaron restos del trigger'; END IF;
END $$;
$b$; END $ens$;
DO $t$ BEGIN
  PERFORM pg_temp.chk('T11 tras el rollback vuelve el comportamiento previo (el hueco reaparece, como control)', pg_temp.como('med_a', $q$UPDATE public.cardiolink_hc_evoluciones SET paciente_id='qa3c_pac_otro' WHERE id='qa3c_evo_a1'$q$), 'n=1');
  UPDATE public.cardiolink_hc_evoluciones SET paciente_id='qa3c_pac_viejo' WHERE id='qa3c_evo_a1';
END $t$;
DO $ens$ BEGIN EXECUTE $b$
-- ROLLBACK del endurecimiento de privilegios: vuelve al estado de Production (todos los privilegios de tabla para anon y authenticated; la RLS sigue siendo la barrera). Una sola transacción.
-- (STAGING originalmente no tenía TRUNCATE para anon/authenticated; este rollback los vuelve a conceder, igual que Production.)
GRANT ALL ON TABLE public.cardiolink_hc_evoluciones, public.cardiolink_hc_resumen TO anon, authenticated;
$b$; END $ens$;
SELECT pg_temp.snap_acl('post');
DO $t$ BEGIN
  IF EXISTS (SELECT rel,grantee,priv FROM t_acl WHERE fase='pre' AND priv IN ('SELECT','INSERT','UPDATE','DELETE') EXCEPT SELECT rel,grantee,priv FROM t_acl WHERE fase='post' AND priv IN ('SELECT','INSERT','UPDATE','DELETE'))
     OR EXISTS (SELECT rel,grantee,priv FROM t_acl WHERE fase='post' AND priv IN ('SELECT','INSERT','UPDATE','DELETE') EXCEPT SELECT rel,grantee,priv FROM t_acl WHERE fase='pre' AND priv IN ('SELECT','INSERT','UPDATE','DELETE')) THEN RAISE EXCEPTION 'FALLA T10: el rollback de privilegios no restauró SELECT/INSERT/UPDATE/DELETE'; END IF;
  IF NOT (has_table_privilege('anon','public.cardiolink_hc_evoluciones','TRUNCATE') AND has_table_privilege('authenticated','public.cardiolink_hc_evoluciones','TRUNCATE')) THEN RAISE EXCEPTION 'FALLA T10: el rollback de privilegios no devolvió el estado previo (TRUNCATE)'; END IF;
  INSERT INTO t_res VALUES ('T10 rollback de privilegios restaura el estado previo');
END $t$;
-- ===== rollback de p3c → debe volver EXACTAMENTE al estado abierto =====
DO $ens$ BEGIN EXECUTE $b$
-- CardioLink · Seguridad clínica V1 · ROLLBACK de p3c (vuelve a las políticas abiertas *_authenticated = estado de Production ANTES de p3c)
-- OJO: restaura la brecha (cualquier cuenta autenticada accede a la HC). Úsese sólo para volver atrás una publicación fallida. Una sola transacción.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND policyname LIKE '%\_authenticated' ESCAPE '\') THEN RAISE EXCEPTION 'Rollback: ya existen políticas *_authenticated (¿ya revertido?)'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND policyname LIKE '%\_v1' ESCAPE '\') <> 8 THEN RAISE EXCEPTION 'Rollback: se esperaban las 8 políticas _v1 de HC'; END IF;
  IF (SELECT qual FROM pg_policies WHERE policyname='cardiolink_hc_evoluciones_select_v1') NOT LIKE '%cardiolink_paciente_padron_v1%' THEN RAISE EXCEPTION 'Rollback: p3c no está aplicada (usar el rollback del delta o el de p3 según corresponda)'; END IF;
END $$;
DROP POLICY IF EXISTS cardiolink_hc_evoluciones_delete_v1 ON public.cardiolink_hc_evoluciones;
DROP POLICY IF EXISTS cardiolink_hc_evoluciones_insert_v1 ON public.cardiolink_hc_evoluciones;
DROP POLICY IF EXISTS cardiolink_hc_evoluciones_select_v1 ON public.cardiolink_hc_evoluciones;
DROP POLICY IF EXISTS cardiolink_hc_evoluciones_update_v1 ON public.cardiolink_hc_evoluciones;
DROP POLICY IF EXISTS cardiolink_hc_resumen_delete_v1 ON public.cardiolink_hc_resumen;
DROP POLICY IF EXISTS cardiolink_hc_resumen_insert_v1 ON public.cardiolink_hc_resumen;
DROP POLICY IF EXISTS cardiolink_hc_resumen_select_v1 ON public.cardiolink_hc_resumen;
DROP POLICY IF EXISTS cardiolink_hc_resumen_update_v1 ON public.cardiolink_hc_resumen;
CREATE POLICY cardiolink_hc_evoluciones_authenticated ON public.cardiolink_hc_evoluciones AS PERMISSIVE FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY cardiolink_hc_resumen_authenticated ON public.cardiolink_hc_resumen AS PERMISSIVE FOR ALL TO authenticated USING (true) WITH CHECK (true);
DO $$ BEGIN
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen')) <> 2 THEN RAISE EXCEPTION 'Rollback: estado final inesperado'; END IF;
END $$;
$b$; END $ens$;
SELECT pg_temp.snap_pol('open2');
DO $t$ BEGIN
  IF NOT pg_temp.igual_pol('open','open2') THEN RAISE EXCEPTION 'FALLA R1: tras el rollback de p3c las políticas NO coinciden con el estado abierto previo'; END IF;
  INSERT INTO t_res VALUES ('R1 rollback de p3c restaura exactamente las políticas abiertas');
END $t$;
-- ===== p3 (original) y delta: el delta debe dejar las MISMAS políticas que p3c =====
DO $ens$ BEGIN EXECUTE $b$
-- CardioLink · Seguridad clínica V1 · PARTE 3 · RLS de Historia Clínica por acceso clínico (Bloque 4)
-- NOTA 2026-11-20: para PRODUCTION este archivo queda REEMPLAZADO por pending_review_seguridad_clinica_v1_p3c_hc_compartida.sql (HC compartida entre profesionales activos). NO aplicar p3 solo: dejaría a Rogelio con 2 de 204 pacientes con HC. Se conserva como estado de STAGING y para el ensayo del delta.
-- Recuperado de STAGING (catálogo: pg_get_functiondef / pg_get_constraintdef / pg_policies / aclexplode, 2026-11-13); QA de STAGING aprobado. Versionado para publicar en Production.
-- NO EJECUTAR en Production sin autorización explícita. Una sola transacción, sin DML sobre datos. Falla (y revierte todo) si el estado no es el esperado.
-- Orden de publicación y rollback: docs/propuestas/pending_review_seguridad_clinica_v1_PUBLICACION.md
-- CAMBIA EL COMPORTAMIENTO: reemplaza las políticas abiertas `*_authenticated` (cualquier usuario autenticado) de cardiolink_hc_evoluciones y cardiolink_hc_resumen por políticas por rol/acceso clínico.
-- Owner/admin: todo. Médico: solo pacientes con vínculo manual activo, evolución o atención propia (y solo escribe evoluciones propias). Secretaría: sin acceso a estas tablas.
-- Las dos políticas nuevas y el DROP de las viejas ocurren en la misma transacción: no hay ventana sin política.
DO $$
BEGIN
  IF to_regprocedure('public.cardiolink_paciente_acceso_clinico_v1(text)') IS NULL THEN RAISE EXCEPTION 'Precondición: aplicar antes la PARTE 2 (cardiolink_paciente_acceso_clinico_v1)'; END IF;
  IF to_regprocedure('public.cardiolink_ctx_rol_v1()') IS NULL OR to_regprocedure('public.cardiolink_ctx_prof_v1()') IS NULL THEN RAISE EXCEPTION 'Precondición: faltan cardiolink_ctx_rol_v1() / cardiolink_ctx_prof_v1()'; END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.cardiolink_hc_evoluciones'::regclass) OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.cardiolink_hc_resumen'::regclass) THEN
    RAISE EXCEPTION 'Precondición: RLS apagada en las tablas de HC'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen')
        AND policyname IN ('cardiolink_hc_evoluciones_authenticated','cardiolink_hc_resumen_authenticated') AND permissive='PERMISSIVE' AND cmd='ALL' AND qual='true' AND with_check='true') <> 2 THEN
    RAISE EXCEPTION 'Precondición: se esperaban exactamente las dos políticas abiertas *_authenticated (cmd ALL, true/true); el estado difiere'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen')) <> 2 THEN
    RAISE EXCEPTION 'Precondición: hay otras políticas en las tablas de HC; revisar antes de continuar'; END IF;
END $$;

CREATE POLICY cardiolink_hc_evoluciones_delete_v1 ON public.cardiolink_hc_evoluciones
  AS PERMISSIVE FOR DELETE TO authenticated
  USING ((cardiolink_paciente_acceso_clinico_v1(paciente_id) AND ((cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text])) OR ((cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1())))))));

CREATE POLICY cardiolink_hc_evoluciones_insert_v1 ON public.cardiolink_hc_evoluciones
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((cardiolink_paciente_acceso_clinico_v1(paciente_id) AND ((cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text])) OR ((cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1())))))));

CREATE POLICY cardiolink_hc_evoluciones_select_v1 ON public.cardiolink_hc_evoluciones
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (cardiolink_paciente_acceso_clinico_v1(paciente_id));

CREATE POLICY cardiolink_hc_evoluciones_update_v1 ON public.cardiolink_hc_evoluciones
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((cardiolink_paciente_acceso_clinico_v1(paciente_id) AND ((cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text])) OR ((cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1())))))))
  WITH CHECK ((cardiolink_paciente_acceso_clinico_v1(paciente_id) AND ((cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text])) OR ((cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1())))))));

CREATE POLICY cardiolink_hc_resumen_delete_v1 ON public.cardiolink_hc_resumen
  AS PERMISSIVE FOR DELETE TO authenticated
  USING (cardiolink_paciente_acceso_clinico_v1(paciente_id));

CREATE POLICY cardiolink_hc_resumen_insert_v1 ON public.cardiolink_hc_resumen
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (cardiolink_paciente_acceso_clinico_v1(paciente_id));

CREATE POLICY cardiolink_hc_resumen_select_v1 ON public.cardiolink_hc_resumen
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (cardiolink_paciente_acceso_clinico_v1(paciente_id));

CREATE POLICY cardiolink_hc_resumen_update_v1 ON public.cardiolink_hc_resumen
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (cardiolink_paciente_acceso_clinico_v1(paciente_id))
  WITH CHECK (cardiolink_paciente_acceso_clinico_v1(paciente_id));

DROP POLICY cardiolink_hc_evoluciones_authenticated ON public.cardiolink_hc_evoluciones;
DROP POLICY cardiolink_hc_resumen_authenticated ON public.cardiolink_hc_resumen;

-- Postcondiciones
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND policyname LIKE '%\_v1' ESCAPE '\') <> 8 THEN RAISE EXCEPTION 'Postcondición: se esperaban 8 políticas _v1'; END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND policyname LIKE '%\_authenticated' ESCAPE '\') THEN RAISE EXCEPTION 'Postcondición: siguen las políticas abiertas'; END IF;
END $$;

$b$; END $ens$;
SELECT pg_temp.snap_pol('p3');
DO $ens$ BEGIN EXECUTE $b$
-- CardioLink · Seguridad clínica V1 · p3c · DELTA para bases que YA tienen p3 (hoy: STAGING). En Production (políticas abiertas, sin p3) usar pending_review_seguridad_clinica_v1_p3c_hc_compartida.sql.
-- Transforma las 8 políticas _v1 de p3 (acceso clínico por paciente) en las de p3c (HC compartida entre profesionales activos) con ALTER POLICY: no hay ventana sin política.
-- Resultado IDÉNTICO a p3c_hc_compartida.sql (el ensayo reversible lo compara política por política). Funciona también si además estaba aplicada p4b. Una sola transacción, sin DML.
-- Requiere p4 (cardiolink_paciente_padron_v1). Rollback: pending_review_seguridad_clinica_v1_p3c_delta_staging_rollback.sql (vuelve a p3 exacta).
DO $$
BEGIN
  IF to_regprocedure('public.cardiolink_paciente_padron_v1(text)') IS NULL THEN RAISE EXCEPTION 'Precondición: aplicar antes p4 (cardiolink_paciente_padron_v1)'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND policyname LIKE '%\_v1' ESCAPE '\') <> 8
     OR (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen')) <> 8 THEN
    RAISE EXCEPTION 'Precondición: se esperaban exactamente las 8 políticas _v1 de p3 (sin otras). Si la base tiene las abiertas usar p3c_hc_compartida.sql'; END IF;
END $$;

ALTER POLICY cardiolink_hc_evoluciones_select_v1 ON public.cardiolink_hc_evoluciones
  USING (cardiolink_paciente_padron_v1(paciente_id));
ALTER POLICY cardiolink_hc_evoluciones_insert_v1 ON public.cardiolink_hc_evoluciones
  WITH CHECK ((cardiolink_paciente_padron_v1(paciente_id) AND ((cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text])) OR ((cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1())))))));
ALTER POLICY cardiolink_hc_evoluciones_update_v1 ON public.cardiolink_hc_evoluciones
  USING ((cardiolink_paciente_padron_v1(paciente_id) AND ((cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text])) OR ((cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1())))))))
  WITH CHECK ((cardiolink_paciente_padron_v1(paciente_id) AND ((cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text])) OR ((cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1())))))));
ALTER POLICY cardiolink_hc_evoluciones_delete_v1 ON public.cardiolink_hc_evoluciones
  USING ((cardiolink_paciente_padron_v1(paciente_id) AND ((cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text])) OR ((cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1())))))));
ALTER POLICY cardiolink_hc_resumen_select_v1 ON public.cardiolink_hc_resumen USING (cardiolink_paciente_padron_v1(paciente_id));
ALTER POLICY cardiolink_hc_resumen_insert_v1 ON public.cardiolink_hc_resumen WITH CHECK (cardiolink_paciente_padron_v1(paciente_id));
ALTER POLICY cardiolink_hc_resumen_update_v1 ON public.cardiolink_hc_resumen USING (cardiolink_paciente_padron_v1(paciente_id)) WITH CHECK (cardiolink_paciente_padron_v1(paciente_id));
ALTER POLICY cardiolink_hc_resumen_delete_v1 ON public.cardiolink_hc_resumen USING ((cardiolink_paciente_padron_v1(paciente_id) AND (cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text]))));

COMMENT ON POLICY cardiolink_hc_evoluciones_select_v1 ON public.cardiolink_hc_evoluciones IS 'Seguridad clínica V1 p3c: HC compartida entre profesionales activos (owner/admin/médico); Secretaría y cuentas sin rol, sin acceso.';

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND policyname LIKE '%\_v1' ESCAPE '\' AND permissive='PERMISSIVE' AND roles = ARRAY['authenticated']::name[]) <> 8 THEN RAISE EXCEPTION 'Postcondición: se esperaban 8 políticas _v1 PERMISSIVE TO authenticated'; END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND (coalesce(qual,'') || coalesce(with_check,'') LIKE '%acceso_clinico%' OR coalesce(qual,'')='true' OR coalesce(with_check,'')='true')) THEN RAISE EXCEPTION 'Postcondición: quedan políticas con acceso clínico por paciente o abiertas'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='cardiolink_hc_evoluciones' AND policyname IN ('cardiolink_hc_evoluciones_insert_v1','cardiolink_hc_evoluciones_update_v1','cardiolink_hc_evoluciones_delete_v1') AND coalesce(qual,'') || coalesce(with_check,'') LIKE '%cardiolink_ctx_prof_v1%') <> 3 THEN RAISE EXCEPTION 'Postcondición: INSERT/UPDATE/DELETE de evoluciones deben exigir el profesional propio'; END IF;
END $$;
$b$; END $ens$;
SELECT pg_temp.snap_pol('b');
DO $t$ BEGIN
  IF NOT pg_temp.igual_pol('a','b') THEN RAISE EXCEPTION 'FALLA D1: el delta NO deja las mismas políticas que p3c'; END IF;
  INSERT INTO t_res VALUES ('D1 delta de STAGING == p3c (políticas idénticas, una por una)');
END $t$;
DO $ens$ BEGIN EXECUTE $b$
-- ROLLBACK del delta p3c: vuelve a las 8 políticas de p3 (acceso clínico por paciente), exactamente como las deja pending_review_seguridad_clinica_v1_p3_hc_rls.sql. Una sola transacción.
-- (Si la base tenía además p4b, reaplicar p4b después.)
DO $$ BEGIN
  IF (SELECT qual FROM pg_policies WHERE policyname='cardiolink_hc_evoluciones_select_v1') NOT LIKE '%cardiolink_paciente_padron_v1%' THEN RAISE EXCEPTION 'Rollback: el delta p3c no está aplicado'; END IF;
END $$;
ALTER POLICY cardiolink_hc_evoluciones_select_v1 ON public.cardiolink_hc_evoluciones USING (cardiolink_paciente_acceso_clinico_v1(paciente_id));
ALTER POLICY cardiolink_hc_evoluciones_insert_v1 ON public.cardiolink_hc_evoluciones
  WITH CHECK ((cardiolink_paciente_acceso_clinico_v1(paciente_id) AND ((cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text])) OR ((cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1())))))));
ALTER POLICY cardiolink_hc_evoluciones_update_v1 ON public.cardiolink_hc_evoluciones
  USING ((cardiolink_paciente_acceso_clinico_v1(paciente_id) AND ((cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text])) OR ((cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1())))))))
  WITH CHECK ((cardiolink_paciente_acceso_clinico_v1(paciente_id) AND ((cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text])) OR ((cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1())))))));
ALTER POLICY cardiolink_hc_evoluciones_delete_v1 ON public.cardiolink_hc_evoluciones
  USING ((cardiolink_paciente_acceso_clinico_v1(paciente_id) AND ((cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text])) OR ((cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1())))))));
ALTER POLICY cardiolink_hc_resumen_select_v1 ON public.cardiolink_hc_resumen USING (cardiolink_paciente_acceso_clinico_v1(paciente_id));
ALTER POLICY cardiolink_hc_resumen_insert_v1 ON public.cardiolink_hc_resumen WITH CHECK (cardiolink_paciente_acceso_clinico_v1(paciente_id));
ALTER POLICY cardiolink_hc_resumen_update_v1 ON public.cardiolink_hc_resumen USING (cardiolink_paciente_acceso_clinico_v1(paciente_id)) WITH CHECK (cardiolink_paciente_acceso_clinico_v1(paciente_id));
ALTER POLICY cardiolink_hc_resumen_delete_v1 ON public.cardiolink_hc_resumen USING (cardiolink_paciente_acceso_clinico_v1(paciente_id));
COMMENT ON POLICY cardiolink_hc_evoluciones_select_v1 ON public.cardiolink_hc_evoluciones IS NULL;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE policyname LIKE 'cardiolink_hc\_%\_v1' ESCAPE '\' AND (coalesce(qual,'') LIKE '%padron%' OR coalesce(with_check,'') LIKE '%padron%')) THEN RAISE EXCEPTION 'Rollback: quedan políticas con el padrón'; END IF;
END $$;
$b$; END $ens$;
SELECT pg_temp.snap_pol('p3b');
DO $t$ BEGIN
  IF NOT pg_temp.igual_pol('p3','p3b') THEN RAISE EXCEPTION 'FALLA D2: el rollback del delta NO restaura p3 exacta'; END IF;
  INSERT INTO t_res VALUES ('D2 rollback del delta restaura p3 exacta');
  IF (SELECT hay_p3 AND NOT hay_p3c AND NOT hay_p4b FROM t_flags) AND NOT pg_temp.igual_pol('ini','p3') THEN RAISE EXCEPTION 'FALLA D3: p3 reaplicada no coincide con el estado inicial de la base'; END IF;
  IF (SELECT hay_p3 AND NOT hay_p3c AND NOT hay_p4b FROM t_flags) THEN INSERT INTO t_res VALUES ('D3 p3 versionada == p3 instalada en esta base'); END IF;
END $t$;
-- ===== restauración al estado inicial (p3c / p3 / abierta; con o sin trigger y privilegios) y comparación final =====
DO $ens$ BEGIN IF (SELECT hay_p3c FROM t_flags) THEN EXECUTE $b$
-- CardioLink · Seguridad clínica V1 · p3c · DELTA para bases que YA tienen p3 (hoy: STAGING). En Production (políticas abiertas, sin p3) usar pending_review_seguridad_clinica_v1_p3c_hc_compartida.sql.
-- Transforma las 8 políticas _v1 de p3 (acceso clínico por paciente) en las de p3c (HC compartida entre profesionales activos) con ALTER POLICY: no hay ventana sin política.
-- Resultado IDÉNTICO a p3c_hc_compartida.sql (el ensayo reversible lo compara política por política). Funciona también si además estaba aplicada p4b. Una sola transacción, sin DML.
-- Requiere p4 (cardiolink_paciente_padron_v1). Rollback: pending_review_seguridad_clinica_v1_p3c_delta_staging_rollback.sql (vuelve a p3 exacta).
DO $$
BEGIN
  IF to_regprocedure('public.cardiolink_paciente_padron_v1(text)') IS NULL THEN RAISE EXCEPTION 'Precondición: aplicar antes p4 (cardiolink_paciente_padron_v1)'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND policyname LIKE '%\_v1' ESCAPE '\') <> 8
     OR (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen')) <> 8 THEN
    RAISE EXCEPTION 'Precondición: se esperaban exactamente las 8 políticas _v1 de p3 (sin otras). Si la base tiene las abiertas usar p3c_hc_compartida.sql'; END IF;
END $$;

ALTER POLICY cardiolink_hc_evoluciones_select_v1 ON public.cardiolink_hc_evoluciones
  USING (cardiolink_paciente_padron_v1(paciente_id));
ALTER POLICY cardiolink_hc_evoluciones_insert_v1 ON public.cardiolink_hc_evoluciones
  WITH CHECK ((cardiolink_paciente_padron_v1(paciente_id) AND ((cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text])) OR ((cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1())))))));
ALTER POLICY cardiolink_hc_evoluciones_update_v1 ON public.cardiolink_hc_evoluciones
  USING ((cardiolink_paciente_padron_v1(paciente_id) AND ((cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text])) OR ((cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1())))))))
  WITH CHECK ((cardiolink_paciente_padron_v1(paciente_id) AND ((cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text])) OR ((cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1())))))));
ALTER POLICY cardiolink_hc_evoluciones_delete_v1 ON public.cardiolink_hc_evoluciones
  USING ((cardiolink_paciente_padron_v1(paciente_id) AND ((cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text])) OR ((cardiolink_ctx_rol_v1() = 'medico'::text) AND (lower(btrim(profesional_id)) = lower(btrim(cardiolink_ctx_prof_v1())))))));
ALTER POLICY cardiolink_hc_resumen_select_v1 ON public.cardiolink_hc_resumen USING (cardiolink_paciente_padron_v1(paciente_id));
ALTER POLICY cardiolink_hc_resumen_insert_v1 ON public.cardiolink_hc_resumen WITH CHECK (cardiolink_paciente_padron_v1(paciente_id));
ALTER POLICY cardiolink_hc_resumen_update_v1 ON public.cardiolink_hc_resumen USING (cardiolink_paciente_padron_v1(paciente_id)) WITH CHECK (cardiolink_paciente_padron_v1(paciente_id));
ALTER POLICY cardiolink_hc_resumen_delete_v1 ON public.cardiolink_hc_resumen USING ((cardiolink_paciente_padron_v1(paciente_id) AND (cardiolink_ctx_rol_v1() = ANY (ARRAY['owner'::text, 'admin'::text]))));

COMMENT ON POLICY cardiolink_hc_evoluciones_select_v1 ON public.cardiolink_hc_evoluciones IS 'Seguridad clínica V1 p3c: HC compartida entre profesionales activos (owner/admin/médico); Secretaría y cuentas sin rol, sin acceso.';

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND policyname LIKE '%\_v1' ESCAPE '\' AND permissive='PERMISSIVE' AND roles = ARRAY['authenticated']::name[]) <> 8 THEN RAISE EXCEPTION 'Postcondición: se esperaban 8 políticas _v1 PERMISSIVE TO authenticated'; END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND (coalesce(qual,'') || coalesce(with_check,'') LIKE '%acceso_clinico%' OR coalesce(qual,'')='true' OR coalesce(with_check,'')='true')) THEN RAISE EXCEPTION 'Postcondición: quedan políticas con acceso clínico por paciente o abiertas'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='cardiolink_hc_evoluciones' AND policyname IN ('cardiolink_hc_evoluciones_insert_v1','cardiolink_hc_evoluciones_update_v1','cardiolink_hc_evoluciones_delete_v1') AND coalesce(qual,'') || coalesce(with_check,'') LIKE '%cardiolink_ctx_prof_v1%') <> 3 THEN RAISE EXCEPTION 'Postcondición: INSERT/UPDATE/DELETE de evoluciones deben exigir el profesional propio'; END IF;
END $$;
$b$; END IF; END $ens$;
DO $ens$ BEGIN IF (SELECT hay_p3c AND hay_trg FROM t_flags) THEN EXECUTE $b$
-- CardioLink · Seguridad clínica V1 · p3c · AJUSTE 1 · INTEGRIDAD DE EVOLUCIONES (protección mínima en base de datos). Aprobado por el Dueño (2026-11-20).
-- ESTADO: PREPARADO PARA REVISIÓN. NO EJECUTAR en Production sin autorización explícita. Una sola transacción, sin DML sobre datos. Rollback: …_p3c_integridad_evoluciones_rollback.sql
-- Requiere p3c aplicada (o el delta) y cardiolink_ctx_rol_v1().
--
-- HUECO CERRADO: la política de UPDATE de evoluciones permite al médico editar sus evoluciones y valida (WITH CHECK) que sigan siendo suyas, pero NO impedía cambiar paciente_id a OTRO paciente existente
-- (el ensayo lo demuestra antes de aplicar este trigger). Un trigger BEFORE UPDATE congela la identidad de la fila:
--   · id y paciente_id: inmutables para cualquier sesión de usuario (owner/admin incluidos). Una evolución mal cargada se corrige borrándola y creándola de nuevo, o con mantenimiento por SQL.
--   · profesional_id: sólo owner/admin pueden cambiarlo (permiso existente); cualquier otro rol recibe 42501 (defensa en profundidad: las políticas RLS ya lo impedían al médico).
--   · Mantenimiento por SQL Editor/postgres/service_role (sin sesión de usuario: auth.uid() nulo) no se ve afectado (backfills, correcciones administrativas).
-- COMPATIBILIDAD PR #33: el guardado multidispositivo sólo actualiza campos de contenido + editado_en/editado_por; el upsert de reintento (ON CONFLICT (id)) reenvía el MISMO paciente_id y profesional_id. Ninguno cambia id/paciente_id/profesional_id.
DO $$
BEGIN
  IF to_regclass('public.cardiolink_hc_evoluciones') IS NULL OR to_regprocedure('public.cardiolink_ctx_rol_v1()') IS NULL THEN RAISE EXCEPTION 'Precondición: faltan cardiolink_hc_evoluciones / cardiolink_ctx_rol_v1()'; END IF;
  IF (SELECT qual FROM pg_policies WHERE schemaname='public' AND policyname='cardiolink_hc_evoluciones_select_v1') IS NULL OR (SELECT qual FROM pg_policies WHERE schemaname='public' AND policyname='cardiolink_hc_evoluciones_select_v1') NOT LIKE '%cardiolink_paciente_padron_v1%' THEN
    RAISE EXCEPTION 'Precondición: aplicar antes p3c (o su delta)'; END IF;
  IF to_regprocedure('public.cardiolink_hc_evolucion_inmutables_v1()') IS NOT NULL OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.cardiolink_hc_evoluciones'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'Precondición: ya existe la función/trigger de integridad u otro trigger sobre cardiolink_hc_evoluciones (¿ya aplicado?)'; END IF;
END $$;

CREATE FUNCTION public.cardiolink_hc_evolucion_inmutables_v1()
 RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $f$
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;   -- sin sesión de usuario = mantenimiento (SQL Editor / postgres / service_role)
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.paciente_id IS DISTINCT FROM OLD.paciente_id THEN
    RAISE EXCEPTION 'Una evolución no puede cambiar de paciente' USING ERRCODE = '42501';
  END IF;
  IF NEW.profesional_id IS DISTINCT FROM OLD.profesional_id AND coalesce(public.cardiolink_ctx_rol_v1(), '') NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'No se puede transferir la evolución a otro profesional' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $f$;
REVOKE ALL ON FUNCTION public.cardiolink_hc_evolucion_inmutables_v1() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.cardiolink_hc_evolucion_inmutables_v1() IS 'Seguridad clínica V1 p3c: id y paciente_id de una evolución son inmutables para sesiones de usuario; profesional_id sólo lo cambia owner/admin. SECURITY INVOKER; mantenimiento sin sesión no se ve afectado.';

CREATE TRIGGER cardiolink_hc_evoluciones_inmutables_v1
  BEFORE UPDATE ON public.cardiolink_hc_evoluciones
  FOR EACH ROW EXECUTE FUNCTION public.cardiolink_hc_evolucion_inmutables_v1();

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.cardiolink_hc_evoluciones'::regclass AND NOT tgisinternal AND tgname='cardiolink_hc_evoluciones_inmutables_v1' AND tgenabled='O') <> 1 THEN RAISE EXCEPTION 'Postcondición: el trigger no quedó habilitado'; END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid='public.cardiolink_hc_evolucion_inmutables_v1()'::regprocedure) THEN RAISE EXCEPTION 'Postcondición: la función del trigger no debe ser SECURITY DEFINER'; END IF;
END $$;
$b$; END IF; END $ens$;
DO $ens$ BEGIN IF (SELECT hay_grants FROM t_flags) THEN EXECUTE $b$
-- CardioLink · Seguridad clínica V1 · p3c · D5 APROBADA (2026-11-20) · ENDURECIMIENTO DE PRIVILEGIOS de las 2 tablas de HC (parte de la publicación de p3c).
-- NO EJECUTAR en Production sin autorización explícita. Una sola transacción. Rollback: …_p3c_grants_hc_rollback.sql
-- Hallazgo: Supabase otorga por defecto a anon y authenticated TODOS los privilegios de tabla. La RLS sólo cubre SELECT/INSERT/UPDATE/DELETE: TRUNCATE (en Production, anon y authenticated lo tienen), TRIGGER y REFERENCES NO pasan por RLS.
-- PostgREST no expone TRUNCATE, así que no era explotable por la API; esto es defensa en profundidad.
-- Efecto: anon y PUBLIC pierden todo. authenticated conserva EXACTAMENTE SELECT/INSERT/UPDATE/DELETE (lo que usan los médicos y las políticas RLS, que siguen filtrando); pierde TRUNCATE, TRIGGER y REFERENCES.
-- No afecta a service_role (edge functions) ni a las funciones SECURITY DEFINER (corren como su dueño). Sin privilegios por columna ni WITH GRANT OPTION (se verifica).
REVOKE ALL ON TABLE public.cardiolink_hc_evoluciones, public.cardiolink_hc_resumen FROM PUBLIC, anon;
REVOKE TRUNCATE, TRIGGER, REFERENCES ON TABLE public.cardiolink_hc_evoluciones, public.cardiolink_hc_resumen FROM authenticated;
DO $$
DECLARE t text; p text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.cardiolink_hc_evoluciones','public.cardiolink_hc_resumen'] LOOP
    -- anon: ningún privilegio de tabla ni de columna
    FOREACH p IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
      IF has_table_privilege('anon', t, p) THEN RAISE EXCEPTION 'Postcondición: anon conserva % sobre %', p, t; END IF;
    END LOOP;
    IF has_any_column_privilege('anon', t, 'SELECT') OR has_any_column_privilege('anon', t, 'INSERT') OR has_any_column_privilege('anon', t, 'UPDATE') OR has_any_column_privilege('anon', t, 'REFERENCES') THEN RAISE EXCEPTION 'Postcondición: anon con privilegios por columna sobre %', t; END IF;
    -- authenticated: exactamente SELECT/INSERT/UPDATE/DELETE
    FOREACH p IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
      IF NOT has_table_privilege('authenticated', t, p) THEN RAISE EXCEPTION 'Postcondición: authenticated perdió % sobre % (lo necesitan las políticas RLS)', p, t; END IF;
    END LOOP;
    FOREACH p IN ARRAY ARRAY['TRUNCATE','REFERENCES','TRIGGER'] LOOP
      IF has_table_privilege('authenticated', t, p) THEN RAISE EXCEPTION 'Postcondición: authenticated conserva % sobre %', p, t; END IF;
    END LOOP;
    -- nadie con GRANT OPTION ni PUBLIC (grantee 0) en la ACL
    IF EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid = t::regclass AND (a.grantee = 0 OR (a.is_grantable AND a.grantee::regrole::text IN ('anon','authenticated')))) THEN RAISE EXCEPTION 'Postcondición: ACL con PUBLIC o GRANT OPTION sobre %', t; END IF;
  END LOOP;
END $$;
$b$; END IF; END $ens$;
DO $ens$ BEGIN IF NOT (SELECT hay_p3 FROM t_flags) THEN EXECUTE $b$
-- CardioLink · Seguridad clínica V1 · ROLLBACK de la PARTE 3 (restaura las políticas abiertas *_authenticated)
-- Recuperado de STAGING (catálogo: pg_get_functiondef / pg_get_constraintdef / pg_policies / aclexplode, 2026-11-13); QA de STAGING aprobado. Versionado para publicar en Production.
-- NO EJECUTAR en Production sin autorización explícita. Una sola transacción, sin DML sobre datos. Falla (y revierte todo) si el estado no es el esperado.
-- Orden de publicación y rollback: docs/propuestas/pending_review_seguridad_clinica_v1_PUBLICACION.md
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND policyname LIKE '%\_authenticated' ESCAPE '\') THEN RAISE EXCEPTION 'Rollback: ya existen políticas *_authenticated (¿ya revertido?)'; END IF;
END $$;
DROP POLICY IF EXISTS cardiolink_hc_evoluciones_delete_v1 ON public.cardiolink_hc_evoluciones;
DROP POLICY IF EXISTS cardiolink_hc_evoluciones_insert_v1 ON public.cardiolink_hc_evoluciones;
DROP POLICY IF EXISTS cardiolink_hc_evoluciones_select_v1 ON public.cardiolink_hc_evoluciones;
DROP POLICY IF EXISTS cardiolink_hc_evoluciones_update_v1 ON public.cardiolink_hc_evoluciones;
DROP POLICY IF EXISTS cardiolink_hc_resumen_delete_v1 ON public.cardiolink_hc_resumen;
DROP POLICY IF EXISTS cardiolink_hc_resumen_insert_v1 ON public.cardiolink_hc_resumen;
DROP POLICY IF EXISTS cardiolink_hc_resumen_select_v1 ON public.cardiolink_hc_resumen;
DROP POLICY IF EXISTS cardiolink_hc_resumen_update_v1 ON public.cardiolink_hc_resumen;

CREATE POLICY cardiolink_hc_evoluciones_authenticated ON public.cardiolink_hc_evoluciones AS PERMISSIVE FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY cardiolink_hc_resumen_authenticated ON public.cardiolink_hc_resumen AS PERMISSIVE FOR ALL TO authenticated USING (true) WITH CHECK (true);

DO $$ BEGIN
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen')) <> 2 THEN RAISE EXCEPTION 'Rollback: estado final inesperado'; END IF;
END $$;
$b$; END IF; END $ens$;
DO $ens$ BEGIN IF NOT (SELECT hay_p4 FROM t_flags) THEN EXECUTE $b$
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
$b$; END IF; END $ens$;
SELECT pg_temp.snap_acl('fin');
DO $$
DECLARE n int;
BEGIN
  IF (SELECT hay_p4b FROM t_flags) THEN
    RAISE NOTICE 'La base tenía p4b: se omite la comparación final de políticas (p4b no se reaplica en el ensayo)';
  ELSIF EXISTS (SELECT tablename, policyname, cmd, permissive, roles::text, qual, with_check FROM pg_policies WHERE tablename IN ('cardiolink_patient_documents','cardiolink_hc_evoluciones','cardiolink_hc_resumen')
             EXCEPT SELECT tablename, policyname, cmd, permissive, roles, qual, with_check FROM t_antes)
     OR EXISTS (SELECT tablename, policyname, cmd, permissive, roles, qual, with_check FROM t_antes
             EXCEPT SELECT tablename, policyname, cmd, permissive, roles::text, qual, with_check FROM pg_policies WHERE tablename IN ('cardiolink_patient_documents','cardiolink_hc_evoluciones','cardiolink_hc_resumen')) THEN
    RAISE EXCEPTION 'FALLA R2: al terminar, las políticas NO coinciden con la foto inicial'; END IF;
  IF NOT (SELECT hay_p4 FROM t_flags) AND to_regprocedure('public.cardiolink_paciente_padron_v1(text)') IS NOT NULL THEN RAISE EXCEPTION 'FALLA R3: quedó cardiolink_paciente_padron_v1 tras el rollback de p4'; END IF;
  IF (SELECT hay_trg FROM t_flags) IS DISTINCT FROM EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.cardiolink_hc_evoluciones'::regclass AND tgname='cardiolink_hc_evoluciones_inmutables_v1') THEN RAISE EXCEPTION 'FALLA R4: el trigger no quedó como al inicio'; END IF;
  IF EXISTS (SELECT rel,grantee,priv FROM t_acl WHERE fase='ini' AND priv IN ('SELECT','INSERT','UPDATE','DELETE') EXCEPT SELECT rel,grantee,priv FROM t_acl WHERE fase='fin' AND priv IN ('SELECT','INSERT','UPDATE','DELETE'))
     OR EXISTS (SELECT rel,grantee,priv FROM t_acl WHERE fase='fin' AND priv IN ('SELECT','INSERT','UPDATE','DELETE') EXCEPT SELECT rel,grantee,priv FROM t_acl WHERE fase='ini' AND priv IN ('SELECT','INSERT','UPDATE','DELETE')) THEN RAISE EXCEPTION 'FALLA R5: los privilegios no quedaron como al inicio'; END IF;
  SELECT count(*) INTO n FROM t_res;
  RAISE EXCEPTION 'ENSAYO_P3C_OK: % pruebas pasaron; p3c, integridad, privilegios, el delta y todos los rollbacks verificados; todo se revierte (esta EXCEPTION es la señal de éxito)', n;
END $$;
