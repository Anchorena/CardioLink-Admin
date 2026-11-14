-- Bloque 4C-1b (v2.2) · Pruebas SQL TRANSACCIONALES: Secretaría recibe constancias, certificados, órdenes y reposos HEREDADOS —sólo de profesionales con los que tiene una asociación ACTIVA— por la RPC administrativa,
-- sin recuperar la fila completa ni datos restringidos, y pierde el acceso en cuanto se desactiva la asociación.
-- SOLO STAGING, con las etapas A y B de 4B instaladas y pending_review_documentos_seguridad_4c1b_heredados.sql YA aplicado. NO ejecutar en Production.
-- Corre dentro de UNA transacción que termina en ROLLBACK: reemplaza la fila de configuración SÓLO dentro de la transacción (se restaura sola al revertir). Requiere 4C-1 aplicado y 1 secretaria activa con al menos
-- una asociación activa. SIN EJECUTAR (sintaxis sin validar).
-- Cualquier falla lanza una excepción y aborta; ninguna prueba se omite. También se incluye, sin su BEGIN ni su cierre, en el ensayo reversible de 4C-1.

BEGIN;

CREATE TEMP TABLE IF NOT EXISTS t_res(nombre text, resultado text);
GRANT ALL ON t_res TO authenticated, anon;
CREATE TEMP TABLE IF NOT EXISTS t_sec_b(uid uuid, prof text);
GRANT SELECT ON t_sec_b TO authenticated;
CREATE OR REPLACE FUNCTION pg_temp.claims_b(p_uid uuid) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true) $$;
RESET ROLE;
DO $$ DECLARE s uuid; p text; r record; l text[]; BEGIN
  -- una secretaria con al menos una asociación ACTIVA (se mira con la misma función que usan las políticas; sin sesión real: se simulan los claims)
  FOR r IN SELECT user_id FROM public.cardiolink_user_roles WHERE base_role = 'secretaria' AND active ORDER BY user_id LOOP
    PERFORM pg_temp.claims_b(r.user_id);
    l := public.cardiolink_profesionales_autorizados_secretaria_v1();
    IF coalesce(array_length(l, 1), 0) > 0 THEN s := r.user_id; p := l[1]; EXIT; END IF;
  END LOOP;
  IF s IS NULL THEN RAISE EXCEPTION 'Faltan actores (secretaria activa con una asociación activa a un profesional)'; END IF;
  DELETE FROM t_sec_b; INSERT INTO t_sec_b VALUES (s, p);
  IF public.cardiolink_config_tipos_doc_sec_v1() IS DISTINCT FROM ARRAY['constancia_atencion','certificado','reposo_laboral','orden']::text[] THEN
    RAISE EXCEPTION 'FALLA 70.0: la lista de tipos heredados legibles no es la de 4C-1b (¿aplicado?)'; END IF;
  IF (SELECT provolatile FROM pg_proc WHERE oid = 'public.cardiolink_config_vista_sec_v1(jsonb)'::regprocedure) <> 's' THEN
    RAISE EXCEPTION 'FALLA 70.0d: la vista de lectura no tiene el filtro por profesional autorizado (4C-1b v2.2)'; END IF;
  IF to_regprocedure('public.cardiolink_config_administrativa_v1()') IS NULL THEN RAISE EXCEPTION 'FALLA 70.0b: falta la etapa A de 4B'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='cardiolink_atenciones' AND policyname='cardiolink_atenciones_config_solo_admin_v1' AND permissive='RESTRICTIVE') THEN
    RAISE EXCEPTION 'FALLA 70.0c: falta la etapa B de 4B (política restrictiva de la fila de configuración)'; END IF;
END $$;

-- Fixture (como postgres): fila de configuración SINTÉTICA con documentos heredados de varios tipos y todas las claves restringidas
INSERT INTO public.cardiolink_atenciones(id, payload, updated_at) VALUES ('__cardiolink_config_v1', jsonb_build_object(
  'tipoRegistro','config','version','T-4C1B','updatedAt','2000-01-01T00:00:00.000Z',
  'config', jsonb_build_object(
    'profesionales', jsonb_build_array(jsonb_build_object('id','p1','nombre','Dr Uno','area','A','logoDocumentoData','LOGO1','campoRaro','RARO1')),
    'obrasSociales', jsonb_build_array('OS1'),
    'pacientes', jsonb_build_array(jsonb_build_object('id','pac1','nombreCompleto','QA UNO','dni','1','notaOculta','CLINICO-P1')),
    'documentosClinicos', jsonb_build_array(
        jsonb_build_object('id','c1','tipo','constancia_atencion','pacienteId','pac1','profesionalId',(SELECT prof FROM t_sec_b),'contenido','CONSTANCIA-OK'),
        jsonb_build_object('id','c2','tipo','certificado','pacienteId','pac1','profesionalId',(SELECT prof FROM t_sec_b),'contenido','CERTIFICADO-OK'),
        jsonb_build_object('id','c3','tipo','orden','pacienteId','pac1','profesionalId',(SELECT prof FROM t_sec_b),'contenido','ORDEN-OK'),
        jsonb_build_object('id','c4','tipo','reposo_laboral','pacienteId','pac1','profesionalId',(SELECT prof FROM t_sec_b),'contenido','REPOSO-OK'),
        jsonb_build_object('id','c9','tipo','certificado','pacienteId','pac1','profesionalId','qa4c_prof_no_asociado','contenido','CLINICO-AJENO'),
        jsonb_build_object('id','c10','tipo','orden','pacienteId','pac1','contenido','CLINICO-SINPROF'),
        jsonb_build_object('id','c5','tipo','receta','pacienteId','pac1','profesionalId',(SELECT prof FROM t_sec_b),'contenido','CLINICO-RECETA'),
        jsonb_build_object('id','c6','tipo','ecg','pacienteId','pac1','contenido','CLINICO-ECG'),
        jsonb_build_object('id','c7','tipo','informe','pacienteId','pac1','contenido','CLINICO-INFORME'),
        jsonb_build_object('id','c8','tipo','mensaje_colega','pacienteId','pac1','contenido','CLINICO-MENSAJE')),
    'evolucionesClinicas', jsonb_build_array(jsonb_build_object('id','e1','pacienteId','pac1','evolucion','CLINICO-E1')),
    'resumenesClinicos', jsonb_build_object('pac1', jsonb_build_object('antecedentes','CLINICO-R1')),
    'importacionesMedicloudEvoluciones', jsonb_build_array(jsonb_build_object('id','i1')),
    'notasInternasPorProfesional', jsonb_build_object('p1', jsonb_build_object('pac1','CLINICO-N1')),
    'notasInternasMedicas', jsonb_build_object('pac1','CLINICO-N2'),
    'configFinanzas411F', jsonb_build_object('sueldosSecretaria', jsonb_build_array(jsonb_build_object('monto',1))),
    'movimientosFinancieros411C', jsonb_build_array(jsonb_build_object('id','m1')),
    'hcPreparacion', jsonb_build_object('schemaVersion',1),
    'integracionesClinicas', jsonb_build_object('rctaUrl','u'),
    'identidadesArchivadas', jsonb_build_object('p9', jsonb_build_array(jsonb_build_object('identidad', jsonb_build_object('logoDocumentoData','OLD')))),
    'claveDesconocidaFutura', jsonb_build_object('x',1))
), '2026-01-01T00:00:00Z'::timestamptz)
ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at;

-- ===== 70) La RPC administrativa entrega constancias, certificados, órdenes y reposos heredados y NADA restringido =====
SET LOCAL ROLE authenticated;
DO $$ DECLARE r jsonb; v jsonb; ks text[]; ids text[]; BEGIN
  PERFORM pg_temp.claims_b((SELECT uid FROM t_sec_b));
  r := public.cardiolink_config_administrativa_v1();
  IF r->>'ok' <> 'true' OR jsonb_typeof(r->'config') <> 'object' THEN RAISE EXCEPTION 'FALLA 70.1: respuesta inesperada %', left(r::text,200); END IF;
  v := r->'config';
  SELECT array_agg(x->>'id' ORDER BY x->>'id') INTO ids FROM jsonb_array_elements(v->'documentosClinicos') x;
  IF ids IS DISTINCT FROM ARRAY['c1','c2','c3','c4'] THEN RAISE EXCEPTION 'FALLA 70.2: Secretaría debe recibir constancia, certificado, orden y reposo heredados de SU profesional (y sólo ellos): %', ids; END IF;
  IF NOT (r::text LIKE '%CONSTANCIA-OK%' AND r::text LIKE '%CERTIFICADO-OK%' AND r::text LIKE '%ORDEN-OK%' AND r::text LIKE '%REPOSO-OK%') THEN RAISE EXCEPTION 'FALLA 70.3: faltan los contenidos de los documentos heredados permitidos'; END IF;
  IF r::text ~ 'CLINICO-RECETA|CLINICO-ECG|CLINICO-INFORME|CLINICO-MENSAJE' THEN RAISE EXCEPTION 'FALLA 70.4: llegaron documentos heredados de tipos NO permitidos'; END IF;
  IF r::text ~ 'CLINICO-AJENO|CLINICO-SINPROF' THEN RAISE EXCEPTION 'FALLA 70.5: llegaron documentos heredados de un profesional SIN asociación activa o sin profesional identificable'; END IF;
  INSERT INTO t_res VALUES ('70 4C-1b: Secretaría recibe constancias, certificados, órdenes y reposos heredados de su profesional asociado y ningún otro tipo (receta, ECG, informe, mensaje a colega) ni documentos de profesionales sin asociación o sin profesional', 'OK');
END $$;

-- ===== 71) …sin recuperar la fila completa ni otros datos restringidos =====
DO $$ DECLARE r jsonb; v jsonb; ks text[]; n int; BEGIN
  PERFORM pg_temp.claims_b((SELECT uid FROM t_sec_b));
  r := public.cardiolink_config_administrativa_v1(); v := r->'config';
  SELECT array_agg(k ORDER BY k) INTO ks FROM jsonb_object_keys(v) k;
  IF NOT (ks <@ ARRAY['profesionales','especialidades','obrasSociales','reglasOS','pacientes','usuarios','roles','colocadores','medicosDerivantes','motivosConsulta',
        'bloquesPrestaciones','bloquesPrestacionesLabels','horariosProfesionales','arancelesPorProfesional','conveniosPorProfesional','conveniosFacturacion',
        'arancelesConvenios','plantillasPedidos','duracionesPrestacion','catalogoPrestaciones411P','destinosFacturacion','brandingCardioLink','auditoriaPacientes',
        'migracionesCardioLink','documentosClinicos']) THEN RAISE EXCEPTION 'FALLA 71.1: la vista trae claves fuera de la lista de lectura: %', ks; END IF;
  IF r::text ~ 'CLINICO-E1|CLINICO-R1|CLINICO-N1|CLINICO-N2|CLINICO-P1|sueldosSecretaria|movimientosFinancieros|claveDesconocidaFutura|identidadesArchivadas|rctaUrl|hcPreparacion|RARO1|importacionesMedicloudEvoluciones|notasInternas' THEN
    RAISE EXCEPTION 'FALLA 71.2: la respuesta contiene datos restringidos'; END IF;
  -- la fila COMPLETA sigue cerrada por API directa (etapa B de 4B): lectura, búsqueda por contenido y escritura
  SELECT count(*) INTO n FROM public.cardiolink_atenciones WHERE id = '__cardiolink_config_v1';
  IF n <> 0 THEN RAISE EXCEPTION 'FALLA 71.3: Secretaría lee la fila de configuración completa (%)', n; END IF;
  SELECT count(*) INTO n FROM public.cardiolink_atenciones WHERE payload ->> 'tipoRegistro' = 'config' OR payload::text LIKE '%CLINICO-RECETA%';
  IF n <> 0 THEN RAISE EXCEPTION 'FALLA 71.4: Secretaría alcanza filas de configuración por contenido (%)', n; END IF;
  UPDATE public.cardiolink_atenciones SET payload = payload || '{"x":1}'::jsonb WHERE id = '__cardiolink_config_v1'; GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FALLA 71.5: Secretaría modificó la fila de configuración completa (%)', n; END IF;
  INSERT INTO t_res VALUES ('71 4C-1b: la vista sólo trae claves de lectura; no hay evoluciones, notas, finanzas ni claves desconocidas; la fila completa sigue cerrada a Secretaría (lectura, búsqueda y escritura)', 'OK');
END $$;

-- ===== 72) Al desactivar la asociación, Secretaría pierde AL INSTANTE los documentos heredados de ese profesional =====
RESET ROLE;
DO $$ DECLARE v_tabla text; BEGIN
  SELECT table_name INTO v_tabla FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('secretaria_user_id','medico_user_id','activo') GROUP BY table_name HAVING count(*) = 3;
  IF v_tabla IS NULL THEN RAISE EXCEPTION 'FALLA 72.0: no hay tabla de asociaciones secretaria-médico'; END IF;
  EXECUTE format('UPDATE public.%I SET activo = false WHERE secretaria_user_id = $1', v_tabla) USING (SELECT uid FROM t_sec_b);
END $$;
SET LOCAL ROLE authenticated;
DO $$ DECLARE r jsonb; n int; BEGIN
  PERFORM pg_temp.claims_b((SELECT uid FROM t_sec_b));
  r := public.cardiolink_config_administrativa_v1();
  IF r->>'ok' <> 'true' THEN RAISE EXCEPTION 'FALLA 72.1: respuesta inesperada %', left(r::text,200); END IF;
  n := jsonb_array_length(coalesce(r->'config'->'documentosClinicos', '[]'::jsonb));
  IF n <> 0 THEN RAISE EXCEPTION 'FALLA 72.2: desactivada la asociación Secretaría sigue recibiendo % documentos heredados', n; END IF;
  IF r::text ~ 'CONSTANCIA-OK|CERTIFICADO-OK|ORDEN-OK|REPOSO-OK' THEN RAISE EXCEPTION 'FALLA 72.3: la respuesta conserva contenido de documentos heredados'; END IF;
  INSERT INTO t_res VALUES ('72 4C-1b: al desactivar la asociación Secretaría deja de recibir los documentos heredados de ese profesional de inmediato', 'OK');
END $$;

-- ===== Resultado y ROLLBACK =====
RESET ROLE;
SELECT nombre, resultado FROM t_res WHERE nombre LIKE '7%' ORDER BY nombre;      -- se esperan 3 filas, todas 'OK'
ROLLBACK;
-- Verificación posterior (fuera de la transacción): la fila de configuración REAL no quedó con la marca sintética. Debe ser 0.
SELECT count(*) AS filas_config_con_marca_4c1b FROM public.cardiolink_atenciones WHERE id = '__cardiolink_config_v1' AND payload ->> 'version' = 'T-4C1B';
