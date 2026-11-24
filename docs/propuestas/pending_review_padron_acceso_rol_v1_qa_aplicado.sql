-- CardioLink · Bloque 0B · QA DIRIGIDO sobre la política YA APLICADA (STAGING). Se ejecuta DESPUÉS de aplicar la Parte A, con el mismo mecanismo que el ensayo:
--   cat pending_review_padron_acceso_rol_v1_ensayo_pruebas.sql pending_review_padron_acceso_rol_v1_qa_aplicado.sql  (precedido por las dos tablas t_antes/t_acl_antes del generador)
-- Cada actor se simula como lo hace PostgREST con su JWT: claims `sub` + SET LOCAL ROLE authenticated; la política se evalúa EN VIVO contra cardiolink_user_roles. Termina SIEMPRE con una EXCEPTION (todo se revierte).
-- Esperado: error final "QA_APLICADO_OK: N pruebas ...".
DO $$ BEGIN PERFORM pg_temp.suite('cerrado'); PERFORM pg_temp.extras(); END $$;

-- Q1 padrón real: cada rol ACTIVO lista los mismos pacientes reales; una cuenta sin fila y una desactivada ven 0 (listado y búsqueda)
CREATE FUNCTION pg_temp.ver_padron(p_uid uuid) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE n int; m int;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN SELECT count(*) INTO n FROM public.cardiolink_pacientes WHERE id NOT LIKE 'qa0b\_%' ESCAPE '\'; EXCEPTION WHEN insufficient_privilege THEN n := -1; END;
  BEGIN SELECT count(*) INTO m FROM (SELECT * FROM public.cardiolink_pacientes WHERE id NOT LIKE 'qa0b\_%' ESCAPE '\' ORDER BY id LIMIT 10) s; EXCEPTION WHEN insufficient_privilege THEN m := -1; END;
  RESET ROLE;
  RETURN n || '/' || m;
END $f$;
DO $t$
DECLARE total int; k text; u uuid; r text; falla text := '';
BEGIN
  SELECT count(*) INTO total FROM public.cardiolink_pacientes WHERE id NOT LIKE 'qa0b\_%' ESCAPE '\';
  FOREACH k IN ARRAY ARRAY['own', 'sec', 'med'] LOOP
    SELECT uid INTO u FROM t_act WHERE clave = k; r := pg_temp.ver_padron(u);
    IF r <> total || '/' || least(10, total) THEN falla := falla || format(' [%s ve %s, esperado %s/%s]', k, r, total, least(10, total)); END IF;
  END LOOP;
  SELECT uid INTO u FROM t_act WHERE clave = 'nadie'; r := pg_temp.ver_padron(u);
  IF r <> '0/0' THEN falla := falla || format(' [sin fila ve %s]', r); END IF;
  UPDATE public.cardiolink_user_roles SET active = false WHERE user_id = (SELECT uid FROM t_act WHERE clave = 'med');
  r := pg_temp.ver_padron((SELECT uid FROM t_act WHERE clave = 'med'));
  IF r <> '0/0' THEN falla := falla || format(' [médico DESACTIVADO ve %s]', r); END IF;
  UPDATE public.cardiolink_user_roles SET active = true WHERE user_id = (SELECT uid FROM t_act WHERE clave = 'med');
  r := pg_temp.ver_padron((SELECT uid FROM t_act WHERE clave = 'med'));
  IF r <> total || '/' || least(10, total) THEN falla := falla || format(' [médico REACTIVADO ve %s]', r); END IF;
  IF falla <> '' THEN RAISE EXCEPTION 'FALLA Q1:%', falla; END IF;
  INSERT INTO t_res VALUES ('Q1 padrón real (' || total || ' pacientes): owner, Secretaría y médico lo listan completo; sin fila y desactivado ven 0 con el mismo JWT; reactivado vuelve a ver todo');
END $t$;

-- Q2 cuenta desactivada: escribir (alta y edición) también se bloquea; reactivada vuelve a escribir. Cuenta sin fila: no escribe.
DO $t$
DECLARE r text; u uuid := (SELECT uid FROM t_act WHERE clave = 'sec');
BEGIN
  UPDATE public.cardiolink_user_roles SET active = false WHERE user_id = u;
  r := pg_temp.probar('secinact', u, 'authenticated');
  IF r <> 'sel=0 ins=rls upd=0 del=0' THEN RAISE EXCEPTION 'FALLA Q2: Secretaría DESACTIVADA obtuvo %', r; END IF;
  UPDATE public.cardiolink_user_roles SET active = true WHERE user_id = u;
  r := pg_temp.probar('secreact', u, 'authenticated');
  IF r <> 'sel=2 ins=ok upd=1 del=1' THEN RAISE EXCEPTION 'FALLA Q2: Secretaría REACTIVADA obtuvo %', r; END IF;
  INSERT INTO t_res VALUES ('Q2 Secretaría desactivada no lee ni escribe el padrón; reactivada recupera leer, alta/upsert, editar y borrar lo propio');
END $t$;

-- Q3 flujos vecinos NO afectados (sólo lo que depende del padrón): Secretaría da de alta un turno (atención) para un paciente; el médico lee SU atención y la cadena del padrón (padrón_v1, HC) responde igual
DO $t$
DECLARE su uuid := (SELECT uid FROM t_act WHERE clave = 'sec'); mu uuid := (SELECT uid FROM t_act WHERE clave = 'med'); mp text; n int; ok boolean; v_pac text;
BEGIN
  SELECT professional_id INTO mp FROM public.cardiolink_user_roles WHERE user_id = mu;
  SELECT id INTO v_pac FROM public.cardiolink_pacientes WHERE id NOT LIKE 'qa0b\_%' ESCAPE '\' ORDER BY id LIMIT 1;
  -- Secretaría: alta de un turno de prueba para ese paciente (misma tabla y forma que usa la app: id + payload)
  PERFORM set_config('request.jwt.claims', json_build_object('sub', su, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  INSERT INTO public.cardiolink_atenciones (id, payload) VALUES ('qa0b_turno_1', jsonb_build_object('id', 'qa0b_turno_1', 'tipoRegistro', 'atencion', 'pacienteId', v_pac, 'profesionalId', mp, 'estado', 'reservado', 'prestacion', 'Consulta QA0B'));
  SELECT count(*) INTO n FROM public.cardiolink_atenciones WHERE id = 'qa0b_turno_1';
  EXECUTE 'RESET ROLE';
  IF n <> 1 THEN RAISE EXCEPTION 'FALLA Q3: Secretaría no puede dar de alta/ver el turno (%)', n; END IF;
  -- Médico: ve el turno de SU profesional (abrir la atención) y la cadena del padrón responde
  PERFORM set_config('request.jwt.claims', json_build_object('sub', mu, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO n FROM public.cardiolink_atenciones WHERE id = 'qa0b_turno_1';
  ok := public.cardiolink_paciente_padron_v1(v_pac);
  PERFORM count(*) FROM public.cardiolink_hc_resumen WHERE paciente_id = v_pac;
  PERFORM count(*) FROM public.cardiolink_hc_evoluciones WHERE paciente_id = v_pac;
  EXECUTE 'RESET ROLE';
  IF n <> 1 OR ok IS NOT TRUE THEN RAISE EXCEPTION 'FALLA Q3: el médico ve el turno=% padrón_v1=%', n, ok; END IF;
  INSERT INTO t_res VALUES ('Q3 Secretaría crea el turno; el médico titular lo abre; padrón_v1 y lectura de HC/atenciones siguen respondiendo (sin error de RLS)');
END $t$;

DO $$ DECLARE n int; BEGIN SELECT count(*) INTO n FROM t_res; RAISE EXCEPTION 'QA_APLICADO_OK: % pruebas pasaron (todo se revierte: esta EXCEPTION es la señal de éxito)', n; END $$;
