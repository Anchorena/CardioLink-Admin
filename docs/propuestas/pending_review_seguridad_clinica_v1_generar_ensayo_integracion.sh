#!/bin/sh
# Genera pending_review_seguridad_clinica_v1_ensayo_integracion.sql (NO se edita a mano). Solo concatena texto: no se conecta a ninguna base ni ejecuta SQL.
# Uso: sh docs/propuestas/pending_review_seguridad_clinica_v1_generar_ensayo_integracion.sh
set -eu
D="$(cd "$(dirname "$0")" && pwd)"; P=pending_review_seguridad_clinica_v1; Q=pending_review_documentos_seguridad_4c1
OUT="$D/${P}_ensayo_integracion.sql"
sin_tx() { awk '!(/^BEGIN;$/ || /^COMMIT;$/)' "$1"; }
cat > "$OUT" <<'EOF_CAB'
-- CardioLink · Seguridad clínica V1 · ENSAYO DE INTEGRACIÓN REVERSIBLE (ARCHIVO GENERADO: no editar a mano; ver ..._generar_ensayo_integracion.sh)
-- SOLO STAGING (yslhwdlzdknhskawqrtv), donde 4C-1, 4C-1b y las partes 1-3 ya están aplicadas. NUNCA en Production. Termina SIEMPRE con una excepción informativa: se revierte TODO (sin COMMIT).
-- QUÉ DEMUESTRA (en una transacción): (1) toma la huella del catálogo de los objetos de las partes 1-3; (2) los revierte con los rollback versionados (4C-1b, 4C-1, p3, p2, p1) hasta un estado equivalente a Production;
-- (3) re-aplica p1, p2 y p3 y exige que la huella sea IDÉNTICA a la de STAGING (tablas, columnas, constraints, índices, RLS, políticas, triggers, grants y cuerpos de función); (4) re-aplica 4C-1 y 4C-1b sobre ese estado y corre los checks.
-- RESULTADO: el mensaje de la excepción final. «ENSAYO_INTEGRACION_OK …» = todo pasó. Cualquier otro mensaje = falla (nada queda persistido).
-- SIN EJECUTAR: sintaxis sin validar contra una base.

DO $$
BEGIN
  IF to_regclass('public.cardiolink_secretaria_medicos') IS NULL OR to_regclass('public.cardiolink_paciente_profesionales_v1') IS NULL
     OR to_regprocedure('public.cardiolink_paciente_acceso_clinico_v1(text)') IS NULL OR to_regprocedure('public.cardiolink_tipos_documento_secretaria_v1()') IS NULL
     OR to_regprocedure('public.cardiolink_config_tipos_doc_sec_v1()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'cardiolink_hc_evoluciones_select_v1') THEN
    RAISE EXCEPTION 'El ensayo requiere STAGING con las partes 1-3, 4B, 4C-1 y 4C-1b aplicados. No se hizo nada.'; END IF;
END $$;

BEGIN;
SET LOCAL cardiolink.rollback_confirmado = 'si';

CREATE TEMP TABLE t_huella(fase text PRIMARY KEY, h jsonb);
CREATE FUNCTION pg_temp.huella() RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object(
   'tablas', (SELECT jsonb_object_agg(n, jsonb_build_object(
      'columnas', (SELECT jsonb_agg(jsonb_build_object('c', a.attname, 't', format_type(a.atttypid, a.atttypmod), 'nn', a.attnotnull, 'def', pg_get_expr(d.adbin, d.adrelid), 'ident', a.attidentity) ORDER BY a.attnum)
                     FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=('public.'||n)::regclass AND a.attnum>0 AND NOT a.attisdropped),
      'constraints', (SELECT jsonb_agg(jsonb_build_object('n', conname, 'd', pg_get_constraintdef(oid)) ORDER BY conname) FROM pg_constraint WHERE conrelid=('public.'||n)::regclass),
      'indices', (SELECT jsonb_agg(pg_get_indexdef(i.indexrelid) ORDER BY i.indexrelid::regclass::text) FROM pg_index i WHERE i.indrelid=('public.'||n)::regclass AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid=i.indexrelid)),
      'rls', (SELECT relrowsecurity FROM pg_class WHERE oid=('public.'||n)::regclass),
      'politicas', (SELECT jsonb_agg(jsonb_build_object('n', policyname, 'p', permissive, 'r', roles, 'c', cmd, 'q', qual, 'w', with_check) ORDER BY policyname) FROM pg_policies WHERE schemaname='public' AND tablename=n),
      'triggers', (SELECT jsonb_agg(pg_get_triggerdef(oid) ORDER BY tgname) FROM pg_trigger WHERE tgrelid=('public.'||n)::regclass AND NOT tgisinternal),
      'grants', (SELECT jsonb_agg(jsonb_build_object('g', CASE WHEN e.grantee=0 THEN 'PUBLIC' ELSE (SELECT rolname FROM pg_roles WHERE oid=e.grantee) END, 'p', e.privilege_type) ORDER BY e.grantee, e.privilege_type) FROM pg_class c, LATERAL aclexplode(c.relacl) e WHERE c.oid=('public.'||n)::regclass)
    )) FROM unnest(ARRAY['cardiolink_secretaria_medicos','cardiolink_secretaria_medicos_eventos_v1','cardiolink_paciente_profesionales_v1','cardiolink_paciente_profesionales_eventos_v1','cardiolink_hc_evoluciones','cardiolink_hc_resumen']) AS n),
   'funciones', (SELECT jsonb_object_agg(p.proname, jsonb_build_object('def', pg_get_functiondef(p.oid),
      'grants', (SELECT jsonb_agg(jsonb_build_object('g', CASE WHEN e.grantee=0 THEN 'PUBLIC' ELSE (SELECT rolname FROM pg_roles WHERE oid=e.grantee) END, 'p', e.privilege_type) ORDER BY e.grantee, e.privilege_type) FROM pg_proc q, LATERAL aclexplode(q.proacl) e WHERE q.oid=p.oid)))
      FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname IN ('cardiolink_validar_asociacion_secretaria_medico_v1','cardiolink_auditar_secretaria_medico_v1','cardiolink_asociar_secretaria_medico_v1','cardiolink_listar_asociaciones_v1','cardiolink_auditar_paciente_profesional_v1','cardiolink_asociar_paciente_profesional_v1','cardiolink_paciente_acceso_clinico_v1')))
$f$;
INSERT INTO t_huella SELECT 'inicial', pg_temp.huella();

-- ===== 1) Retroceso hasta un estado equivalente a Production (rollback versionados, en orden inverso) =====
EOF_CAB
echo "-- ---------- rollback 4C-1b ----------" >> "$OUT"; sin_tx "$D/${Q}b_heredados_rollback.sql" >> "$OUT"
echo "-- ---------- rollback 4C-1 ----------" >> "$OUT"; sin_tx "$D/${Q}_rollback.sql" >> "$OUT"
echo "-- ---------- rollback p3 ----------" >> "$OUT"; sin_tx "$D/${P}_p3_hc_rls_rollback.sql" >> "$OUT"
echo "-- ---------- rollback p2 ----------" >> "$OUT"; sin_tx "$D/${P}_p2_acceso_clinico_rollback.sql" >> "$OUT"
echo "-- ---------- rollback p1 ----------" >> "$OUT"; sin_tx "$D/${P}_p1_asociaciones_rollback.sql" >> "$OUT"
cat >> "$OUT" <<'EOF_MED'

-- Estado equivalente a Production: sin tablas/funciones de las partes 1-3 y con las dos políticas abiertas de HC y las 4 políticas anteriores de imagen clínica
DO $$
BEGIN
  IF to_regclass('public.cardiolink_secretaria_medicos') IS NOT NULL OR to_regclass('public.cardiolink_paciente_profesionales_v1') IS NOT NULL OR to_regprocedure('public.cardiolink_paciente_acceso_clinico_v1(text)') IS NOT NULL
     OR to_regprocedure('public.cardiolink_listar_asociaciones_v1()') IS NOT NULL THEN RAISE EXCEPTION 'FALLA I1: tras los rollback quedan objetos de las partes 1-3'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE policyname IN ('cardiolink_hc_evoluciones_authenticated','cardiolink_hc_resumen_authenticated') AND qual = 'true' AND with_check = 'true') <> 2 THEN RAISE EXCEPTION 'FALLA I2: no se restauraron las políticas abiertas de HC'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE policyname IN ('cardiolink_patient_documents_select_no_img_secretaria','cardiolink_patient_documents_insert_no_img_secretaria','cardiolink_clinical_images_storage_select_no_secretaria','cardiolink_clinical_images_storage_insert_no_secretaria')) <> 4 THEN RAISE EXCEPTION 'FALLA I3: no se restauraron las 4 políticas anteriores de imagen clínica'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE policyname LIKE '%\_4c1' ESCAPE '\') <> 0 OR to_regprocedure('public.cardiolink_tipos_documento_secretaria_v1()') IS NOT NULL THEN RAISE EXCEPTION 'FALLA I4: quedan objetos de 4C-1'; END IF;
END $$;

-- ===== 2) Aplicación en el orden de publicación: p1, p2, p3 =====
EOF_MED
echo "-- ---------- p1 ----------" >> "$OUT"; sin_tx "$D/${P}_p1_asociaciones.sql" >> "$OUT"
echo "-- ---------- p2 ----------" >> "$OUT"; sin_tx "$D/${P}_p2_acceso_clinico.sql" >> "$OUT"
echo "-- ---------- p3 ----------" >> "$OUT"; sin_tx "$D/${P}_p3_hc_rls.sql" >> "$OUT"
cat >> "$OUT" <<'EOF_FIN'

INSERT INTO t_huella SELECT 'tras_p1_p2_p3', pg_temp.huella();
DO $$
DECLARE a jsonb; b jsonb; dif text;
BEGIN
  SELECT h INTO a FROM t_huella WHERE fase = 'inicial'; SELECT h INTO b FROM t_huella WHERE fase = 'tras_p1_p2_p3';
  IF a IS DISTINCT FROM b THEN
    SELECT string_agg(k, ', ') INTO dif FROM (
      SELECT 'tabla ' || k || ' [' || coalesce((SELECT string_agg(s, ',') FROM jsonb_object_keys(a->'tablas'->k) s WHERE (a->'tablas'->k->s) IS DISTINCT FROM (b->'tablas'->k->s)), '?') || ']' AS k
        FROM jsonb_object_keys(a->'tablas') k WHERE (a->'tablas'->k) IS DISTINCT FROM (b->'tablas'->k)
      UNION ALL SELECT 'función ' || k || ' [' || CASE WHEN (a->'funciones'->k->'def') IS DISTINCT FROM (b->'funciones'->k->'def') THEN 'def' ELSE '' END
                      || CASE WHEN (a->'funciones'->k->'grants') IS DISTINCT FROM (b->'funciones'->k->'grants') THEN ' grants ' || coalesce((a->'funciones'->k->'grants')::text, 'null') || ' vs ' || coalesce((b->'funciones'->k->'grants')::text, 'null') ELSE '' END || ']'
        FROM jsonb_object_keys(a->'funciones') k WHERE (a->'funciones'->k) IS DISTINCT FROM (b->'funciones'->k)) q;
    RAISE EXCEPTION 'FALLA I5: la huella tras p1-p3 difiere de STAGING en: %', coalesce(dif, '(estructura)'); END IF;
END $$;

-- ===== 3) 4C-1 y 4C-1b sobre ese estado + checks =====
EOF_FIN
echo "-- ---------- 4C-1 ----------" >> "$OUT"; sin_tx "$D/${Q}.sql" >> "$OUT"
echo "-- ---------- 4C-1b ----------" >> "$OUT"; sin_tx "$D/${Q}b_heredados.sql" >> "$OUT"
cat >> "$OUT" <<'EOF_RES'

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_policies WHERE policyname LIKE '%\_4c1' ESCAPE '\' AND permissive = 'RESTRICTIVE'; IF n <> 6 THEN RAISE EXCEPTION 'FALLA I6: políticas 4C-1 restrictivas = % (esperadas 6)', n; END IF;
  SELECT count(*) INTO n FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('cardiolink_tipos_documento_secretaria_v1','cardiolink_profesionales_autorizados_secretaria_v1','cardiolink_secretaria_autorizada_prof_v1','cardiolink_objeto_sin_fila_v1','cardiolink_objeto_asignable_v1','cardiolink_vinculo_documental_v1','cardiolink_patient_documents_inmutables_4c1'); IF n <> 7 THEN RAISE EXCEPTION 'FALLA I7: funciones 4C-1 = % (esperadas 7)', n; END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.cardiolink_patient_documents'::regclass AND tgname='cardiolink_patient_documents_inmutables_4c1') <> 1 THEN RAISE EXCEPTION 'FALLA I8: trigger de 4C-1'; END IF;
  IF coalesce(obj_description(to_regprocedure('public.cardiolink_historial_envios_documento_v1(text[])'), 'pg_proc'), '') NOT LIKE '%[4C-1:%' THEN RAISE EXCEPTION 'FALLA I9: la RPC del historial no quedó con la marca de 4C-1'; END IF;
  IF public.cardiolink_config_tipos_doc_sec_v1() IS DISTINCT FROM ARRAY['constancia_atencion','certificado','reposo_laboral','orden']::text[] THEN RAISE EXCEPTION 'FALLA I10: lista de heredados de 4C-1b'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND policyname LIKE '%\_v1' ESCAPE '\') <> 8 THEN RAISE EXCEPTION 'FALLA I11: políticas HC _v1'; END IF;
  RAISE EXCEPTION 'ENSAYO_INTEGRACION_OK: huella de p1-p3 idéntica a STAGING; 4C-1 (6 políticas, 7 funciones, trigger, RPC con marca) y 4C-1b aplican sobre el estado equivalente a Production; se revierte TODO.';
END $$;
ROLLBACK;
EOF_RES
printf 'Generado: %s (%s lineas)\n' "$OUT" "$(wc -l < "$OUT" | tr -d ' ')"

# ---------------------------------------------------------------------------------------------------------------------------------
# ENSAYO REVERSIBLE PARA PRODUCTION (se ejecuta SOLO con autorización explícita): aplica el orden de publicación (SIN p3, postergado) dentro de una transacción y la revierte (excepción final).
OUT2="$D/${P}_ensayo_production.sql"
cat > "$OUT2" <<'EOF_P1'
-- CardioLink · Seguridad clínica V1 · ENSAYO REVERSIBLE PARA PRODUCTION (ARCHIVO GENERADO: no editar a mano; ver ..._generar_ensayo_integracion.sh)
-- NO EJECUTAR sin autorización explícita. Aplica, DENTRO de una transacción, p1 → p2 → 4B etapa A → 4B etapa B → 4C-1 → 4C-1b (p3 / HC RLS POSTERGADO: no se aplica) y corre los checks; termina SIEMPRE con una excepción informativa (sin COMMIT): nada queda persistido.
-- Toma bloqueos de DDL durante unos segundos: ejecutar fuera del horario de uso. «ENSAYO_PRODUCTION_OK …» = el orden de publicación (sin p3) es aplicable sobre el catálogo real de Production.
-- SIN EJECUTAR: sintaxis sin validar contra una base.

DO $$
BEGIN
  IF to_regclass('public.cardiolink_secretaria_medicos') IS NOT NULL OR to_regclass('public.cardiolink_paciente_profesionales_v1') IS NOT NULL OR to_regprocedure('public.cardiolink_paciente_acceso_clinico_v1(text)') IS NOT NULL
     OR to_regprocedure('public.cardiolink_config_tipos_doc_sec_v1()') IS NOT NULL OR to_regprocedure('public.cardiolink_tipos_documento_secretaria_v1()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_policies WHERE policyname LIKE 'cardiolink_hc_%\_v1' ESCAPE '\') THEN
    RAISE EXCEPTION 'El ensayo requiere un Production SIN ninguna de las partes aplicada (estado esperado de partida). No se hizo nada.'; END IF;
END $$;

BEGIN;
EOF_P1
for n in "p1:${P}_p1_asociaciones.sql" "p2:${P}_p2_acceso_clinico.sql" "4B-A:pending_review_config_secretaria_v1_a_rpc.sql" "4B-B:pending_review_config_secretaria_v1_b_rls.sql" "4C-1:${Q}.sql" "4C-1b:${Q}b_heredados.sql"; do
  etq="${n%%:*}"; f="${n#*:}"; echo "-- ---------- $etq ----------" >> "$OUT2"; sin_tx "$D/$f" >> "$OUT2"
done
cat >> "$OUT2" <<'EOF_P2'

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_policies WHERE policyname LIKE '%\_4c1' ESCAPE '\' AND permissive = 'RESTRICTIVE'; IF n <> 6 THEN RAISE EXCEPTION 'FALLA P1: políticas 4C-1 restrictivas = % (esperadas 6)', n; END IF;
  SELECT count(*) INTO n FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('cardiolink_tipos_documento_secretaria_v1','cardiolink_profesionales_autorizados_secretaria_v1','cardiolink_secretaria_autorizada_prof_v1','cardiolink_objeto_sin_fila_v1','cardiolink_objeto_asignable_v1','cardiolink_vinculo_documental_v1','cardiolink_patient_documents_inmutables_4c1'); IF n <> 7 THEN RAISE EXCEPTION 'FALLA P2: funciones 4C-1 = % (esperadas 7)', n; END IF;
  IF coalesce(obj_description(to_regprocedure('public.cardiolink_historial_envios_documento_v1(text[])'), 'pg_proc'), '') NOT LIKE '%[4C-1:%' THEN RAISE EXCEPTION 'FALLA P3: la RPC del historial no quedó con la marca de 4C-1'; END IF;
  IF public.cardiolink_config_tipos_doc_sec_v1() IS DISTINCT FROM ARRAY['constancia_atencion','certificado','reposo_laboral','orden']::text[] THEN RAISE EXCEPTION 'FALLA P4: lista de heredados de 4C-1b'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND policyname LIKE '%\_v1' ESCAPE '\') <> 0
     OR (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND policyname LIKE '%\_authenticated' ESCAPE '\') <> 2 THEN RAISE EXCEPTION 'FALLA P5: p3 está postergado: las políticas de HC deben quedar como están (2 abiertas, 0 _v1)'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE policyname IN ('cardiolink_patient_documents_select_no_img_secretaria','cardiolink_patient_documents_insert_no_img_secretaria','cardiolink_clinical_images_storage_select_no_secretaria','cardiolink_clinical_images_storage_insert_no_secretaria')) <> 0 THEN RAISE EXCEPTION 'FALLA P6: quedaron políticas anteriores de imagen clínica'; END IF;
  RAISE EXCEPTION 'ENSAYO_PRODUCTION_OK: p1, p2, 4B-A, 4B-B, 4C-1 y 4C-1b (sin p3) se aplican en orden sobre el catálogo real y los checks pasan; las políticas de HC no cambian; se revierte TODO (nada persistido).';
END $$;
ROLLBACK;
EOF_P2
printf 'Generado: %s (%s lineas)\n' "$OUT2" "$(wc -l < "$OUT2" | tr -d ' ')"
