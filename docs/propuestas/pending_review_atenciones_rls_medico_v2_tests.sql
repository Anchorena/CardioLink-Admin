-- Pruebas SQL del borrador pending_review_atenciones_rls_medico_v2.sql (v3.2: identidad por backend, sin prefijo de email)
-- SOLO STAGING, con el borrador YA aplicado en STAGING. NO ejecutar en Production.
-- Todo corre dentro de una transacción que termina en ROLLBACK: no deja datos.
-- Ejecutar en el SQL Editor de STAGING (rol postgres). No usa datos de pacientes reales.
-- BORRADOR SIN EJECUTAR: validar sintaxis y nombres en STAGING antes de confiar en el resultado.
--
-- Prerrequisitos (consultas de lectura previas: staging_discovery_readonly.sql):
--   * 2 médicos activos distintos con professional_id, 1 secretaría y 1 owner/admin activos.
--   * Cada médico con una identidad de mensajería distinta (usuario configurado vinculado o seudónimo de backend).
-- Estructura: 1) fixtures como postgres  2) pruebas bajo el rol `authenticated` con claims JWT  3) ROLLBACK.

BEGIN;

-- 00) PRECHEQUEO de triggers/dependencias de auth.users y cardiolink_user_roles ANTES de crear cuentas transaccionales.
--     Todo lo creado se revierte con el ROLLBACK, incluidos los efectos de triggers transaccionales. Aborta (sin cambios) si:
--       * algún trigger de usuario sobre auth.users / cardiolink_user_roles invoca http/net/dblink (efectos fuera de la transacción);
--       * auth.users tiene columnas NOT NULL sin default que este script no informa (id, aud, role, email).
DO $$ DECLARE r record; faltan text; BEGIN
  FOR r IN SELECT c.relname AS tabla, t.tgname, p.proname, p.prosrc
           FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
           JOIN pg_proc p ON p.oid=t.tgfoid
           WHERE NOT t.tgisinternal AND ((n.nspname='auth' AND c.relname='users') OR (n.nspname='public' AND c.relname='cardiolink_user_roles'))
  LOOP
    RAISE NOTICE 'Trigger sobre %: % -> %()', r.tabla, r.tgname, r.proname;
    IF r.prosrc ~* '(net\.http|http_post|http_request|http_get|dblink|pg_net)' THEN
      RAISE EXCEPTION 'Abortado: el trigger % (%) parece invocar servicios externos; no usar cuentas transaccionales (usar el nivel 3)', r.tgname, r.proname; END IF;
  END LOOP;
  SELECT string_agg(column_name, ', ') INTO faltan FROM information_schema.columns
   WHERE table_schema='auth' AND table_name='users' AND is_nullable='NO' AND column_default IS NULL
     AND column_name NOT IN ('id','aud','role','email');
  IF faltan IS NOT NULL THEN
    RAISE EXCEPTION 'Abortado: auth.users tiene columnas NOT NULL sin default que este script no informa: % (usar el nivel 3)', faltan; END IF;
  RAISE NOTICE 'OK prechequeo: sin triggers con efectos externos y sin columnas obligatorias adicionales en auth.users';
END $$;

-- 0) IDENTIDAD B EFÍMERA. STAGING tiene un único médico backend (medico_qa_staging). Si no hay un segundo médico activo, se crea
--    DENTRO de esta transacción una identidad ficticia (auth.users + cardiolink_user_roles) que se revierte con el ROLLBACK final:
--    no queda ninguna cuenta ni fila. Si el INSERT falla (columnas/triggers de auth.users), la transacción aborta sin cambios:
--    en ese caso usar el procedimiento B de BLOQUEANTES_PENDIENTES_MEDICOS_V1.md (cuenta ficticia persistente, con autorización).
DO $$ DECLARE v_b uuid; BEGIN
  IF (SELECT count(*) FROM public.cardiolink_user_roles WHERE base_role='medico' AND active AND professional_id ~ '^[A-Za-z0-9_.-]{1,64}$') < 2 THEN
    v_b := gen_random_uuid();
    INSERT INTO auth.users(id, aud, role, email) VALUES (v_b,'authenticated','authenticated','qa-tmp-medico-b@invalid.test');
    INSERT INTO public.cardiolink_user_roles(user_id, base_role, active, professional_id) VALUES (v_b,'medico',true,'qa_tmp_medico_b');
    RAISE NOTICE 'Identidad B efímera creada (se revierte con ROLLBACK)';
  END IF;
END $$;

-- Actores (con sus emails resueltos ANTES de bajar de privilegios: `authenticated` no puede leer auth.users).
CREATE TEMP TABLE t_actores AS
SELECT
 a.med_a, a.prof_a, (SELECT email FROM auth.users WHERE id=a.med_a) AS mail_a,
 b.med_b, b.prof_b, (SELECT email FROM auth.users WHERE id=b.med_b) AS mail_b,
 (SELECT user_id FROM public.cardiolink_user_roles WHERE base_role='secretaria' AND active LIMIT 1) AS sec,
 (SELECT user_id FROM public.cardiolink_user_roles WHERE base_role IN ('owner','admin') AND active ORDER BY base_role LIMIT 1) AS own
FROM
 (SELECT user_id AS med_a, professional_id AS prof_a FROM public.cardiolink_user_roles
  WHERE base_role='medico' AND active AND professional_id ~ '^[A-Za-z0-9_.-]{1,64}$' ORDER BY professional_id LIMIT 1) a,
 (SELECT user_id AS med_b, professional_id AS prof_b FROM public.cardiolink_user_roles
  WHERE base_role='medico' AND active AND professional_id ~ '^[A-Za-z0-9_.-]{1,64}$' ORDER BY professional_id DESC LIMIT 1) b;
CREATE TEMP TABLE t_logins(login_a text[], login_b text[]);
GRANT SELECT ON t_actores, t_logins TO authenticated;

DO $$ DECLARE a record; BEGIN SELECT * INTO a FROM t_actores;
  IF a.med_a IS NULL OR a.med_b IS NULL OR a.med_a=a.med_b OR a.sec IS NULL OR a.own IS NULL THEN
    RAISE EXCEPTION 'Faltan actores de prueba (2 médicos distintos con professional_id, 1 secretaría, 1 owner/admin)'; END IF; END $$;

CREATE OR REPLACE FUNCTION pg_temp.claims(p_uid uuid, p_mail text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', json_build_object('sub',p_uid,'role','authenticated','email',p_mail)::text, true) $$;

-- ===== 0b) PRIVILEGIOS DE EJECUCIÓN (catálogo; como postgres) =====
DO $$ DECLARE f text; BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.cardiolink_config_usuarios_v1()','public.cardiolink_login_seudonimo_v1(text)'] LOOP
    IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE') THEN
      RAISE EXCEPTION 'FALLA: el helper interno % es ejecutable por anon/authenticated',f; END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY[
    'public.cardiolink_config_medico_v1()','public.cardiolink_directorio_mensajes_v1()','public.cardiolink_mensaje_marcar_leido_v1(text)',
    'public.cardiolink_logins_propios_v1()','public.cardiolink_ctx_rol_v1()','public.cardiolink_ctx_prof_v1()',
    'public.cardiolink_atencion_permitida_v2(jsonb,text,text)','public.cardiolink_mensaje_visible_medico_v1(jsonb,text[],uuid)',
    'public.cardiolink_mensaje_crea_medico_v1(jsonb,text[],uuid)','public.cardiolink_login_cliente_v1(text)'] LOOP
    IF has_function_privilege('anon',f,'EXECUTE') THEN RAISE EXCEPTION 'FALLA: anon puede ejecutar %',f; END IF;
    IF NOT has_function_privilege('authenticated',f,'EXECUTE') THEN RAISE EXCEPTION 'FALLA: authenticated NO puede ejecutar % (las políticas/RPC fallarían)',f; END IF;
  END LOOP;
  RAISE NOTICE 'OK privilegios: helpers internos cerrados; RPC y predicados sólo para authenticated (no anon)';
END $$;

-- ===== 1) FIXTURES (como postgres; sin RLS). Todos los ids con prefijo __t_ =====
DO $$ DECLARE a record; la text[]; lb text[]; BEGIN
  SELECT * INTO a FROM t_actores;
  PERFORM pg_temp.claims(a.med_a,a.mail_a); la := public.cardiolink_logins_propios_v1();
  PERFORM pg_temp.claims(a.med_b,a.mail_b); lb := public.cardiolink_logins_propios_v1();
  IF coalesce(array_length(la,1),0)=0 OR coalesce(array_length(lb,1),0)=0 OR la[1]=lb[1] THEN
    RAISE EXCEPTION 'Prerrequisito: cada médico de prueba debe tener una identidad de mensajería distinta (A=%, B=%)',la,lb; END IF;
  INSERT INTO t_logins VALUES (la,lb);
  INSERT INTO public.cardiolink_atenciones(id,payload,updated_at) VALUES
   ('__t_att_a',  jsonb_build_object('id','__t_att_a','profesionalId',a.prof_a,'paciente','QA'), now()),
   ('__t_att_b',  jsonb_build_object('id','__t_att_b','profesionalId',a.prof_b,'paciente','QA'), now()),
   ('__t_msg_todos',  '{"id":"__t_msg_todos","tipoRegistro":"mensaje","destino":"todos","texto":"t","leidoPor":[]}'::jsonb, now()),
   ('__t_msg_medicos','{"id":"__t_msg_medicos","tipoRegistro":"mensaje","destino":"rol:medico","texto":"t","leidoPor":[]}'::jsonb, now()),
   ('__t_msg_secre',  '{"id":"__t_msg_secre","tipoRegistro":"mensaje","destino":"rol:secretaria","texto":"t","leidoPor":[]}'::jsonb, now()),
   ('__t_msg_otro',   '{"id":"__t_msg_otro","tipoRegistro":"mensaje","destino":"usuario:__nadie__","texto":"t","leidoPor":[]}'::jsonb, now()),
   ('__t_msg_para_a', jsonb_build_object('id','__t_msg_para_a','tipoRegistro','mensaje','destino','usuario:'||la[1],'texto','t','leidoPor','[]'::jsonb), now()),
   ('__t_msg_para_b', jsonb_build_object('id','__t_msg_para_b','tipoRegistro','mensaje','destino','usuario:'||lb[1],'texto','t','leidoPor','[]'::jsonb), now()),
   ('__t_msg_hist_a', jsonb_build_object('id','__t_msg_hist_a','tipoRegistro','mensaje','destino','rol:secretaria','deUsuario',la[1],'texto','t','leidoPor','[]'::jsonb), now()),
   ('__t_msg_hist_b', jsonb_build_object('id','__t_msg_hist_b','tipoRegistro','mensaje','destino','rol:secretaria','deUsuario',lb[1],'texto','t','leidoPor','[]'::jsonb), now()),
   ('__t_msg_falso_a',jsonb_build_object('id','__t_msg_falso_a','tipoRegistro','mensaje','destino','rol:secretaria','deUsuario',la[1],'creadoUid',a.med_b::text,'texto','t','leidoPor','[]'::jsonb), now());
END $$;

-- ===== 2) MÉDICO A =====
SET LOCAL ROLE authenticated;
DO $$ DECLARE a record; n int; BEGIN
  SELECT * INTO a FROM t_actores; PERFORM pg_temp.claims(a.med_a,a.mail_a);
  SELECT count(*) INTO n FROM public.cardiolink_atenciones WHERE id='__t_att_a';
  IF n<>1 THEN RAISE EXCEPTION 'FALLA: médico A no ve su atención'; END IF;
  SELECT count(*) INTO n FROM public.cardiolink_atenciones WHERE id='__t_att_b';
  IF n<>0 THEN RAISE EXCEPTION 'FALLA: médico A VE la atención del médico B'; END IF;
  SELECT count(*) INTO n FROM public.cardiolink_atenciones WHERE id IN ('__t_msg_todos','__t_msg_medicos');
  IF n<>2 THEN RAISE EXCEPTION 'FALLA: médico A no ve mensajes todos/rol:medico (ve %)',n; END IF;
  SELECT count(*) INTO n FROM public.cardiolink_atenciones WHERE id IN ('__t_msg_secre','__t_msg_otro','__t_msg_para_b','__t_msg_hist_b','__t_msg_falso_a');
  IF n<>0 THEN RAISE EXCEPTION 'FALLA: médico A ve mensajes de otros destinos/remitentes (%)',n; END IF;
  SELECT count(*) INTO n FROM public.cardiolink_atenciones WHERE id IN ('__t_msg_para_a','__t_msg_hist_a');
  IF n<>2 THEN RAISE EXCEPTION 'FALLA: médico A no ve el mensaje dirigido a él ni su histórico verificable (ve %)',n; END IF;
  SELECT count(*) INTO n FROM public.cardiolink_atenciones WHERE id='__cardiolink_config_v1';
  IF n<>0 THEN RAISE EXCEPTION 'FALLA: médico A lee la fila de config completa'; END IF;
  RAISE NOTICE 'OK médico A: lectura (atenciones, mensajes, históricos, config cerrada)';
END $$;

DO $$ DECLARE a record; n int; BEGIN
  SELECT * INTO a FROM t_actores; PERFORM pg_temp.claims(a.med_a,a.mail_a);
  BEGIN
    INSERT INTO public.cardiolink_atenciones(id,payload) VALUES('__t_msg_ajeno',
      jsonb_build_object('id','__t_msg_ajeno','tipoRegistro','mensaje','destino','todos','creadoUid',gen_random_uuid()::text));
    RAISE EXCEPTION 'FALLA: médico A insertó un mensaje con creadoUid de otro';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN RAISE NOTICE 'OK rechazado: mensaje con creadoUid ajeno'; END;
  -- Remitente (deUsuario) vs identidad verificada: sólo se acepta un login PROPIO
  DECLARE v_login_a text := (SELECT login_a[1] FROM t_logins); v_login_b text := (SELECT login_b[1] FROM t_logins);
  BEGIN
    BEGIN  -- creadoUid propio + deUsuario AJENO => RECHAZADO
      INSERT INTO public.cardiolink_atenciones(id,payload) VALUES('__t_msg_remit_ajeno',
        jsonb_build_object('id','__t_msg_remit_ajeno','tipoRegistro','mensaje','destino','todos','creadoUid',a.med_a::text,'deUsuario',v_login_b,'texto','x'));
      RAISE EXCEPTION 'FALLA: médico A envió con creadoUid propio y deUsuario de OTRO profesional';
    EXCEPTION WHEN insufficient_privilege OR check_violation THEN RAISE NOTICE 'OK rechazado: creadoUid propio + deUsuario ajeno'; END;
    BEGIN  -- creadoUid propio + deUsuario inexistente/vacío => RECHAZADO
      INSERT INTO public.cardiolink_atenciones(id,payload) VALUES('__t_msg_remit_vacio',
        jsonb_build_object('id','__t_msg_remit_vacio','tipoRegistro','mensaje','destino','todos','creadoUid',a.med_a::text,'texto','x'));
      RAISE EXCEPTION 'FALLA: médico A envió sin deUsuario';
    EXCEPTION WHEN insufficient_privilege OR check_violation THEN RAISE NOTICE 'OK rechazado: creadoUid propio sin deUsuario'; END;
    BEGIN  -- creadoUid propio + deUsuario propio => PERMITIDO
      INSERT INTO public.cardiolink_atenciones(id,payload) VALUES('__t_msg_remit_propio',
        jsonb_build_object('id','__t_msg_remit_propio','tipoRegistro','mensaje','destino','rol:secretaria','creadoUid',a.med_a::text,'deUsuario',v_login_a,'texto','x'));
      RAISE NOTICE 'OK permitido: creadoUid propio + deUsuario propio';
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'FALLA: médico A no puede enviar con su propio remitente (%)',SQLERRM; END;
    BEGIN  -- deUsuario con otra capitalización/espacios del MISMO login => PERMITIDO (misma normalización que el cliente)
      INSERT INTO public.cardiolink_atenciones(id,payload) VALUES('__t_msg_remit_norm',
        jsonb_build_object('id','__t_msg_remit_norm','tipoRegistro','mensaje','destino','todos','creadoUid',a.med_a::text,'deUsuario',upper(v_login_a),'texto','x'));
      RAISE NOTICE 'OK permitido: remitente propio con distinta capitalización';
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'FALLA: la normalización del remitente propio no coincide (%)',SQLERRM; END;
  END;
  BEGIN
    INSERT INTO public.cardiolink_atenciones(id,payload) VALUES('__t_msg_sin_uid',
      jsonb_build_object('id','__t_msg_sin_uid','tipoRegistro','mensaje','destino','todos','deUsuario','cualquiera'));
    RAISE EXCEPTION 'FALLA: médico A insertó un mensaje sin creadoUid (forma histórica)';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN RAISE NOTICE 'OK rechazado: mensaje sin creadoUid'; END;
  BEGIN
    INSERT INTO public.cardiolink_atenciones(id,payload) VALUES('__t_msg_propio',
      jsonb_build_object('id','__t_msg_propio','tipoRegistro','mensaje','destino','rol:secretaria','creadoUid',a.med_a::text,'deUsuario',(SELECT login_a[1] FROM t_logins),'texto','hola'));
    RAISE NOTICE 'OK permitido: mensaje propio';
  EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'FALLA: médico A no puede enviar un mensaje propio (%)',SQLERRM; END;
  BEGIN
    INSERT INTO public.cardiolink_atenciones(id,payload) VALUES('__t_msg_falsif',
      jsonb_build_object('id','__t_msg_falsif','tipoRegistro','mensaje','profesionalId',a.prof_a,'destino','todos','deUsuario','matias','texto','falsificado'));
    RAISE EXCEPTION 'FALLA: médico A falsificó un mensaje insertándolo como "atención" propia con tipoRegistro=mensaje';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN RAISE NOTICE 'OK rechazado: mensaje falsificado vía atención propia'; END;
  BEGIN
    UPDATE public.cardiolink_atenciones SET payload=payload||'{"tipoRegistro":"mensaje","destino":"todos","deUsuario":"matias"}'::jsonb WHERE id='__t_att_a';
    RAISE EXCEPTION 'FALLA: médico A reconvirtió su atención en mensaje';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN RAISE NOTICE 'OK rechazado: reconversión de atención en mensaje'; END;
  BEGIN
    INSERT INTO public.cardiolink_atenciones(id,payload) VALUES('__t_att_ajena',jsonb_build_object('id','__t_att_ajena','profesionalId',a.prof_b));
    RAISE EXCEPTION 'FALLA: médico A insertó una atención de otro profesional';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN RAISE NOTICE 'OK rechazado: atención de otro profesional'; END;
  BEGIN
    INSERT INTO public.cardiolink_atenciones(id,payload) VALUES('__cardiolink_config_v1',jsonb_build_object('tipoRegistro','config','config','{}'::jsonb))
      ON CONFLICT (id) DO UPDATE SET payload=excluded.payload;
    RAISE EXCEPTION 'FALLA: médico A pudo escribir la fila de config';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN RAISE NOTICE 'OK rechazado: escritura de config'; END;
  UPDATE public.cardiolink_atenciones SET payload=payload||'{"texto":"alterado"}' WHERE id='__t_msg_todos';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n<>0 THEN RAISE EXCEPTION 'FALLA: médico A modificó directamente el texto de un mensaje'; END IF;
  DELETE FROM public.cardiolink_atenciones WHERE id='__t_msg_todos';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n<>0 THEN RAISE EXCEPTION 'FALLA: médico A borró un mensaje'; END IF;
  RAISE NOTICE 'OK rechazados: UPDATE y DELETE directos de mensajes';
END $$;

-- RPC de leído, directorio y config saneada (médico A)
DO $$ DECLARE a record; r jsonb; BEGIN
  SELECT * INTO a FROM t_actores; PERFORM pg_temp.claims(a.med_a,a.mail_a);
  r := public.cardiolink_mensaje_marcar_leido_v1('__t_msg_para_a');
  IF jsonb_array_length(r->'leidoPor')<1 OR r->>'texto'<>'t' THEN RAISE EXCEPTION 'FALLA: marcar leído alteró algo más que leidoPor'; END IF;
  BEGIN PERFORM public.cardiolink_mensaje_marcar_leido_v1('__t_msg_para_b');
    RAISE EXCEPTION 'FALLA: marcó leído un mensaje de B';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'FALLA%' THEN RAISE; END IF; RAISE NOTICE 'OK rechazado: leído de mensaje ajeno'; END;
  BEGIN PERFORM public.cardiolink_mensaje_marcar_leido_v1('__t_att_a');
    RAISE EXCEPTION 'FALLA: la RPC de leído operó sobre una atención';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'FALLA%' THEN RAISE; END IF; RAISE NOTICE 'OK rechazado: RPC de leído sobre atención'; END;
  r := public.cardiolink_directorio_mensajes_v1();
  IF r IS NULL OR jsonb_array_length(r)=0 THEN RAISE EXCEPTION 'FALLA: directorio vacío'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(r) e, jsonb_object_keys(e) k WHERE k NOT IN ('destino','nombre','rol')) THEN
    RAISE EXCEPTION 'FALLA: el directorio expone campos distintos de destino/nombre/rol'; END IF;
  IF r::text ~* '@' THEN RAISE EXCEPTION 'FALLA: el directorio contiene un email'; END IF;
  r := public.cardiolink_config_medico_v1();
  IF r ? 'usuarios' OR r ? 'pacientes' OR r ? 'reglasOS' OR r ? 'colocadores' OR r::text ~ '"valores"' THEN
    RAISE EXCEPTION 'FALLA: la config saneada expone usuarios ajenos o datos comerciales/pacientes'; END IF;
  IF r->'usuarioPropio' IS NOT NULL THEN
    IF r->'usuarioPropio'->>'profesionalId' IS DISTINCT FROM a.prof_a THEN RAISE EXCEPTION 'FALLA: usuarioPropio no corresponde al médico A'; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(r->'usuarioPropio') k
               WHERE k NOT IN ('id','usuario','nombre','rol','profesionalId','especialidad','activo','aliases')) THEN
      RAISE EXCEPTION 'FALLA: usuarioPropio expone campos fuera de la lista mínima (%)',(SELECT string_agg(k,',') FROM jsonb_object_keys(r->'usuarioPropio') k); END IF;
    IF r->'usuarioPropio' ? 'aliases' AND jsonb_array_length(r->'usuarioPropio'->'aliases')>1 THEN RAISE EXCEPTION 'FALLA: usuarioPropio devuelve más de un alias'; END IF;
    IF r->'usuarioPropio' ? 'email' OR r->'usuarioPropio' ? 'rolId' OR r->'usuarioPropio' ? 'soloMatias' THEN RAISE EXCEPTION 'FALLA: usuarioPropio expone email/rolId/soloMatias'; END IF;
  END IF;
  IF r->'mensajeria'->>'login' IS NULL THEN RAISE EXCEPTION 'FALLA: falta la identidad de mensajería del médico'; END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(public.cardiolink_directorio_mensajes_v1()) e WHERE e->>'destino'='usuario:'||(r->'mensajeria'->>'login')) THEN
    RAISE EXCEPTION 'FALLA: el médico A no figura en el directorio (no se le podrían dirigir mensajes)'; END IF;
  RAISE NOTICE 'OK médico A: RPC de leído, directorio mínimo y config saneada';
END $$;

-- Un no-médico no obtiene la config saneada ni identidad de mensajería
DO $$ DECLARE a record; BEGIN
  SELECT * INTO a FROM t_actores; PERFORM pg_temp.claims(a.sec,NULL);
  IF public.cardiolink_config_medico_v1() IS NOT NULL THEN RAISE EXCEPTION 'FALLA: Secretaría obtuvo config_medico'; END IF;
  IF coalesce(array_length(public.cardiolink_logins_propios_v1(),1),0)<>0 THEN RAISE EXCEPTION 'FALLA: Secretaría tiene logins de médico'; END IF;
  RAISE NOTICE 'OK Secretaría: sin config_medico ni identidad de médico';
END $$;

-- Identidad médica inválida: sin sesión, o professional_id vacío/ inválido => nada de config médica ni logins ni mensajes
DO $$ DECLARE a record; BEGIN
  SELECT * INTO a FROM t_actores;
  PERFORM set_config('request.jwt.claims','{}',true);                 -- sin sesión (auth.uid() NULL)
  IF public.cardiolink_config_medico_v1() IS NOT NULL OR coalesce(array_length(public.cardiolink_logins_propios_v1(),1),0)<>0
     OR public.cardiolink_directorio_mensajes_v1() IS NOT NULL THEN
    RAISE EXCEPTION 'FALLA: sin sesión se obtuvo config médica, logins o directorio'; END IF;
  RAISE NOTICE 'OK sin sesión: sin config médica, sin logins, sin directorio';
END $$;
RESET ROLE;
-- (como postgres) médico con professional_id inválido, creado dentro de la transacción
DO $$ DECLARE v uuid:=gen_random_uuid(); BEGIN
  BEGIN
    INSERT INTO auth.users(id, aud, role, email) VALUES (v,'authenticated','authenticated','qa-tmp-medico-inv@invalid.test');
    INSERT INTO public.cardiolink_user_roles(user_id, base_role, active, professional_id) VALUES (v,'medico',true,'Dr. Inválido (QA)');
    CREATE TEMP TABLE t_inv AS SELECT v AS uid;
    GRANT SELECT ON t_inv TO authenticated;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'OMITIDO: no se pudo crear el médico con professional_id inválido (%). Probar manualmente.',SQLERRM;
  END;
END $$;
SET LOCAL ROLE authenticated;
DO $$ BEGIN
  IF to_regclass('pg_temp.t_inv') IS NOT NULL THEN
    PERFORM pg_temp.claims((SELECT uid FROM t_inv),'qa-tmp-medico-inv@invalid.test');
    IF public.cardiolink_config_medico_v1() IS NOT NULL OR coalesce(array_length(public.cardiolink_logins_propios_v1(),1),0)<>0 THEN
      RAISE EXCEPTION 'FALLA: médico con professional_id inválido obtuvo config médica/logins'; END IF;
    IF EXISTS (SELECT 1 FROM public.cardiolink_atenciones WHERE id IN ('__t_att_a','__t_msg_todos')) THEN
      RAISE EXCEPTION 'FALLA: médico con professional_id inválido ve atenciones o mensajes'; END IF;
    RAISE NOTICE 'OK professional_id inválido: sin config, sin logins, sin datos';
  END IF;
END $$;

-- ===== MÉDICO B: aislamiento recíproco =====
DO $$ DECLARE a record; n int; BEGIN
  SELECT * INTO a FROM t_actores; PERFORM pg_temp.claims(a.med_b,a.mail_b);
  SELECT count(*) INTO n FROM public.cardiolink_atenciones WHERE id IN ('__t_att_a','__t_msg_para_a','__t_msg_hist_a','__t_msg_falso_a');
  IF n<>0 THEN RAISE EXCEPTION 'FALLA: médico B ve datos de A (%) o un mensaje falsificado a nombre de A',n; END IF;
  SELECT count(*) INTO n FROM public.cardiolink_atenciones WHERE id IN ('__t_att_b','__t_msg_para_b','__t_msg_hist_b');
  IF n<>3 THEN RAISE EXCEPTION 'FALLA: médico B no ve lo propio (ve %/3)',n; END IF;
  RAISE NOTICE 'OK médico B: aislamiento recíproco';
END $$;

-- ===== SECRETARÍA Y OWNER conservan acceso total =====
DO $$ DECLARE a record; n int; BEGIN
  SELECT * INTO a FROM t_actores;
  PERFORM pg_temp.claims(a.sec,NULL);
  SELECT count(*) INTO n FROM public.cardiolink_atenciones WHERE id IN ('__t_att_a','__t_att_b','__t_msg_todos','__t_msg_secre','__t_msg_otro','__cardiolink_config_v1');
  IF n<>6 THEN RAISE EXCEPTION 'FALLA: secretaría perdió acceso (ve %/6)',n; END IF;
  PERFORM pg_temp.claims(a.own,NULL);
  SELECT count(*) INTO n FROM public.cardiolink_atenciones WHERE id IN ('__t_att_a','__t_att_b','__t_msg_todos','__t_msg_secre','__t_msg_otro','__cardiolink_config_v1');
  IF n<>6 THEN RAISE EXCEPTION 'FALLA: owner/admin perdió acceso (ve %/6)',n; END IF;
  RAISE NOTICE 'OK secretaría y owner/admin: acceso total conservado (incluida la config)';
END $$;

-- ===== 3) MÚLTIPLES LOGINS de un mismo médico (como postgres; se revierte con ROLLBACK) =====
RESET ROLE;
UPDATE public.cardiolink_atenciones
   SET payload = jsonb_set(payload,'{config,usuarios}', coalesce(payload#>'{config,usuarios}','[]'::jsonb)
        || jsonb_build_array(
             jsonb_build_object('id','__t_u1','usuario','__t_login_1','nombre','T1','rol','medico','profesionalId',(SELECT prof_a FROM t_actores),'activo',true),
             jsonb_build_object('id','__t_u2','usuario','__t_login_2','nombre','T2','rol','medico','profesionalId',(SELECT prof_a FROM t_actores),'activo',true)))
 WHERE id='__cardiolink_config_v1';
INSERT INTO public.cardiolink_atenciones(id,payload,updated_at) VALUES
 ('__t_msg_login2', jsonb_build_object('id','__t_msg_login2','tipoRegistro','mensaje','destino','usuario:__t_login_2','texto','t','leidoPor','[]'::jsonb), now()),
 ('__t_msg_hist_login1', jsonb_build_object('id','__t_msg_hist_login1','tipoRegistro','mensaje','destino','rol:secretaria','deUsuario','__t_login_1','texto','t','leidoPor','[]'::jsonb), now());
SET LOCAL ROLE authenticated;
DO $$ DECLARE a record; n int; r jsonb; L text[]; BEGIN
  SELECT * INTO a FROM t_actores; PERFORM pg_temp.claims(a.med_a,a.mail_a);
  L := public.cardiolink_logins_propios_v1();
  IF NOT (L @> ARRAY['__t_login_1','__t_login_2']) THEN RAISE EXCEPTION 'FALLA: logins propios incompletos (%)',L; END IF;
  SELECT count(*) INTO n FROM public.cardiolink_atenciones WHERE id IN ('__t_msg_login2','__t_msg_hist_login1');
  IF n<>2 THEN RAISE EXCEPTION 'FALLA: médico con 2 logins no ve el mensaje dirigido al 2º ni el histórico del 1º (ve %)',n; END IF;
  r := public.cardiolink_mensaje_marcar_leido_v1('__t_msg_login2');
  IF NOT (r->'leidoPor' ? '__t_login_1' AND r->'leidoPor' ? '__t_login_2') THEN RAISE EXCEPTION 'FALLA: "leído" no incluyó todos sus logins (%)',r->'leidoPor'; END IF;
  PERFORM pg_temp.claims(a.med_b,a.mail_b);
  SELECT count(*) INTO n FROM public.cardiolink_atenciones WHERE id IN ('__t_msg_login2','__t_msg_hist_login1');
  IF n<>0 THEN RAISE EXCEPTION 'FALLA: médico B ve mensajes de los logins de A'; END IF;
  RAISE NOTICE 'OK múltiples logins: visibilidad, "leído" por todos los logins y aislamiento con B';
END $$;

-- ===== 4) RENDIMIENTO (informativo): plan de la consulta del médico =====
-- Ejecutar aparte, con claims del médico A, y revisar que "InitPlan" calcule logins/uid una sola vez:
--   EXPLAIN (ANALYZE, BUFFERS) SELECT id FROM public.cardiolink_atenciones;
--   -> esperado: Filter con InitPlan para cardiolink_logins_propios_v1()/auth.uid(); tiempo comparable a la política actual.

RESET ROLE;
ROLLBACK;  -- no deja datos de prueba
-- Verificación posterior (fuera de la transacción): select count(*) from public.cardiolink_user_roles where professional_id like 'qa_tmp_%'; -- = 0
--                                                    select count(*) from auth.users where email like 'qa-tmp-%'; -- = 0
