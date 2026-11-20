#!/bin/sh
# Genera pending_review_seguridad_clinica_v1_p3c_ensayo_reversible.sql a partir de los SQL reales (p3c, p3, delta, integridad, grants, rollbacks) + las pruebas.
# Uso (desde docs/propuestas): sh pending_review_seguridad_clinica_v1_p3c_generar_ensayo.sh  → pegar el resultado en el SQL Editor (STAGING o, con autorización, Production) o ejecutarlo con la CLI.
# El script NO tiene BEGIN/COMMIT: corre en una sola transacción y termina SIEMPRE con una EXCEPTION que revierte todo.
# Funciona desde cualquier estado de la base: abierta (Production), p3, p3c, con o sin trigger de integridad y con o sin privilegios endurecidos. Primero la lleva al estado «Production» (abiertas + p4),
# aplica p3c → integridad → privilegios, prueba, verifica todos los rollbacks y la equivalencia del delta, y restaura el estado inicial.
cd "$(dirname "$0")" || exit 1
P=pending_review_seguridad_clinica_v1
OUT=${P}_p3c_ensayo_reversible.sql
strip() { sed -e '/^BEGIN;$/d' -e '/^COMMIT;$/d' "$1"; }
run() { echo "DO \$ens\$ BEGIN EXECUTE \$b\$"; strip "$1"; echo "\$b\$; END \$ens\$;"; }
runif() { echo "DO \$ens\$ BEGIN IF $1 THEN EXECUTE \$b\$"; strip "$2"; echo "\$b\$; END IF; END \$ens\$;"; }
{
cat <<'HDR'
-- CardioLink · Seguridad clínica V1 · p3c "HC compartida" + integridad de evoluciones + privilegios · ENSAYO REVERSIBLE. GENERADO por pending_review_seguridad_clinica_v1_p3c_generar_ensayo.sh: no editar a mano.
-- Sin BEGIN/COMMIT: todo corre en UNA transacción y el script termina SIEMPRE con una EXCEPTION que revierte TODO (cuentas, pacientes, filas, políticas, trigger y privilegios sintéticos/ensayados).
-- RESULTADO ESPERADO: error final "ENSAYO_P3C_OK: N pruebas ..." (= éxito + rollback). Cualquier otro mensaje "FALLA ..." indica la prueba que no pasó. La base queda como estaba.
-- Orden: foto → estado base → p3c → pruebas → privilegios → integridad (con control previo del hueco) → rollbacks de integridad y privilegios → rollback de p3c → p3 → delta (idéntico a p3c) → rollback del delta → restauración y comparación con la foto inicial.
HDR
cat <<'EOG'
-- ===== GUARDA DE TRANSACCIÓN: si el cliente ejecutara cada sentencia por separado (autocommit), esta tabla (ON COMMIT DROP) ya no existiría en la sentencia siguiente y el script ABORTA antes de cambiar nada =====
CREATE TEMP TABLE t_guard_tx(x int) ON COMMIT DROP;
DO $g$ BEGIN PERFORM 1 FROM t_guard_tx; END $g$;
EOG
sed '/^-- ===== actores y fixture/,$d' ${P}_p3c_ensayo_pruebas.sql
cat <<'EOF2'
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
EOF2
runif "(SELECT hay_trg FROM t_flags)" ${P}_p3c_integridad_evoluciones_rollback.sql
runif "(SELECT hay_grants FROM t_flags)" ${P}_p3c_grants_hc_rollback.sql
runif "(SELECT hay_p3 FROM t_flags)" ${P}_p3_hc_rls_rollback.sql
runif "NOT (SELECT hay_p4 FROM t_flags)" ${P}_p4_padron_compartido.sql
echo "SELECT pg_temp.snap_pol('open');"
echo "-- ===== p3c (camino Production) ====="
run ${P}_p3c_hc_compartida.sql
echo "SELECT pg_temp.snap_pol('a');"
sed -n '/^-- ===== actores y fixture/,$p' ${P}_p3c_ensayo_pruebas.sql
cat <<'EOF3'
-- ===== T10 privilegios (D5 aprobada): anon sin nada; authenticated exactamente SELECT/INSERT/UPDATE/DELETE; la RLS sigue filtrando =====
SELECT pg_temp.snap_acl('pre');
DO $t$ BEGIN
  INSERT INTO t_res VALUES ('T10 informativo (antes): TRUNCATE anon=' || has_table_privilege('anon','public.cardiolink_hc_evoluciones','TRUNCATE') || ' authenticated=' || has_table_privilege('authenticated','public.cardiolink_hc_evoluciones','TRUNCATE'));
END $t$;
EOF3
run ${P}_p3c_grants_hc.sql
cat <<'EOF4'
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
EOF4
run ${P}_p3c_integridad_evoluciones.sql
cat <<'EOF5'
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
EOF5
run ${P}_p3c_integridad_evoluciones_rollback.sql
cat <<'EOF6'
DO $t$ BEGIN
  PERFORM pg_temp.chk('T11 tras el rollback vuelve el comportamiento previo (el hueco reaparece, como control)', pg_temp.como('med_a', $q$UPDATE public.cardiolink_hc_evoluciones SET paciente_id='qa3c_pac_otro' WHERE id='qa3c_evo_a1'$q$), 'n=1');
  UPDATE public.cardiolink_hc_evoluciones SET paciente_id='qa3c_pac_viejo' WHERE id='qa3c_evo_a1';
END $t$;
EOF6
run ${P}_p3c_grants_hc_rollback.sql
cat <<'EOF7'
SELECT pg_temp.snap_acl('post');
DO $t$ BEGIN
  IF EXISTS (SELECT rel,grantee,priv FROM t_acl WHERE fase='pre' AND priv IN ('SELECT','INSERT','UPDATE','DELETE') EXCEPT SELECT rel,grantee,priv FROM t_acl WHERE fase='post' AND priv IN ('SELECT','INSERT','UPDATE','DELETE'))
     OR EXISTS (SELECT rel,grantee,priv FROM t_acl WHERE fase='post' AND priv IN ('SELECT','INSERT','UPDATE','DELETE') EXCEPT SELECT rel,grantee,priv FROM t_acl WHERE fase='pre' AND priv IN ('SELECT','INSERT','UPDATE','DELETE')) THEN RAISE EXCEPTION 'FALLA T10: el rollback de privilegios no restauró SELECT/INSERT/UPDATE/DELETE'; END IF;
  IF NOT (has_table_privilege('anon','public.cardiolink_hc_evoluciones','TRUNCATE') AND has_table_privilege('authenticated','public.cardiolink_hc_evoluciones','TRUNCATE')) THEN RAISE EXCEPTION 'FALLA T10: el rollback de privilegios no devolvió el estado previo (TRUNCATE)'; END IF;
  INSERT INTO t_res VALUES ('T10 rollback de privilegios restaura el estado previo');
END $t$;
-- ===== rollback de p3c → debe volver EXACTAMENTE al estado abierto =====
EOF7
run ${P}_p3c_hc_compartida_rollback.sql
cat <<'EOF8'
SELECT pg_temp.snap_pol('open2');
DO $t$ BEGIN
  IF NOT pg_temp.igual_pol('open','open2') THEN RAISE EXCEPTION 'FALLA R1: tras el rollback de p3c las políticas NO coinciden con el estado abierto previo'; END IF;
  INSERT INTO t_res VALUES ('R1 rollback de p3c restaura exactamente las políticas abiertas');
END $t$;
-- ===== p3 (original) y delta: el delta debe dejar las MISMAS políticas que p3c =====
EOF8
run ${P}_p3_hc_rls.sql
echo "SELECT pg_temp.snap_pol('p3');"
run ${P}_p3c_delta_staging.sql
echo "SELECT pg_temp.snap_pol('b');"
cat <<'EOF9'
DO $t$ BEGIN
  IF NOT pg_temp.igual_pol('a','b') THEN RAISE EXCEPTION 'FALLA D1: el delta NO deja las mismas políticas que p3c'; END IF;
  INSERT INTO t_res VALUES ('D1 delta de STAGING == p3c (políticas idénticas, una por una)');
END $t$;
EOF9
run ${P}_p3c_delta_staging_rollback.sql
cat <<'EOF10'
SELECT pg_temp.snap_pol('p3b');
DO $t$ BEGIN
  IF NOT pg_temp.igual_pol('p3','p3b') THEN RAISE EXCEPTION 'FALLA D2: el rollback del delta NO restaura p3 exacta'; END IF;
  INSERT INTO t_res VALUES ('D2 rollback del delta restaura p3 exacta');
  IF (SELECT hay_p3 AND NOT hay_p3c AND NOT hay_p4b FROM t_flags) AND NOT pg_temp.igual_pol('ini','p3') THEN RAISE EXCEPTION 'FALLA D3: p3 reaplicada no coincide con el estado inicial de la base'; END IF;
  IF (SELECT hay_p3 AND NOT hay_p3c AND NOT hay_p4b FROM t_flags) THEN INSERT INTO t_res VALUES ('D3 p3 versionada == p3 instalada en esta base'); END IF;
END $t$;
-- ===== restauración al estado inicial (p3c / p3 / abierta; con o sin trigger y privilegios) y comparación final =====
EOF10
runif "(SELECT hay_p3c FROM t_flags)" ${P}_p3c_delta_staging.sql
runif "(SELECT hay_p3c AND hay_trg FROM t_flags)" ${P}_p3c_integridad_evoluciones.sql
runif "(SELECT hay_grants FROM t_flags)" ${P}_p3c_grants_hc.sql
runif "NOT (SELECT hay_p3 FROM t_flags)" ${P}_p3_hc_rls_rollback.sql
runif "NOT (SELECT hay_p4 FROM t_flags)" ${P}_p4_padron_compartido_rollback.sql
cat <<'FIN'
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
FIN
} > "$OUT"
echo "generado: $OUT ($(wc -l < "$OUT") líneas)"
