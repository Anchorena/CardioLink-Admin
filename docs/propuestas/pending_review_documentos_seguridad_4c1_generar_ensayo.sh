#!/bin/sh
# Genera pending_review_documentos_seguridad_4c1_ensayo_reversible.sql a partir del SQL de 4C-1, el de 4C-1b, sus pruebas y sus rollbacks.
# No se conecta a ninguna base ni ejecuta SQL: sólo concatena texto. Uso: sh docs/propuestas/pending_review_documentos_seguridad_4c1_generar_ensayo.sh
# Si cambia alguno de los SQL de origen hay que volver a generar el ensayo (tests/documentos-seguridad-4c1.js, prueba F12, lo verifica).
set -eu
D="$(cd "$(dirname "$0")" && pwd)"
P=pending_review_documentos_seguridad_4c1
OUT="$D/${P}_ensayo_reversible.sql"
N1=$(grep -c 'INSERT INTO t_res' "$D/${P}_tests.sql")
N2=$(grep -c 'INSERT INTO t_res' "$D/${P}b_heredados_tests.sql")
N=$((N1 + N2 + 1))
{
cat <<'EOF_CAB'
-- CardioLink · Seguridad clinica V1 / Bloque 4C-1 (+ 4C-1b) · ENSAYO REVERSIBLE COMPLETO   -- ARCHIVO GENERADO: no editar a mano (ver ..._generar_ensayo.sh)
-- SOLO STAGING (yslhwdlzdknhskawqrtv). NO EJECUTAR sin autorizacion explicita. NUNCA en Production.
--
-- QUE HACE: en UNA sola transaccion (1) instala TEMPORALMENTE el bloque 4C-1 (funciones, politicas restrictivas, trigger) y el 4C-1b (lista de documentos heredados), (2) corre las pruebas SQL de 4C-1
-- con datos sinteticos qa4c_* (incluye vinculos documentales y la asociacion manual con la tabla real cardiolink_paciente_profesionales_v1), (3) corre las pruebas de 4C-1b (Secretaria recibe
-- constancias, certificados, ordenes y reposos heredados de su profesional asociado, sin recuperar la fila completa; y pierde el acceso al desactivar la asociacion), (4) EJECUTA LOS ROLLBACK de ambas partes y verifica que todo vuelve al estado anterior, y (5) termina con ROLLBACK.
-- (v2.3) Tambien cubre la funcion SECURITY DEFINER cardiolink_historial_envios_documento_v1 (historial de envios): 4C-1 la REEMPLAZA con la autorizacion de Secretaria por asociacion activa, se prueba (25 a 29 y 35) y el rollback
-- debe dejarla EXACTAMENTE como estaba (se compara su cuerpo, normalizado, contra el que tenia antes del ensayo).
-- (v2.4) Corrige el error 42883 (operator does not exist: text = text[]) del ensayo v2.3: la politica cardiolink_patient_documents_select_4c1 usaba ANY ((SELECT <funcion text[]>)), que Postgres toma como subconsulta de filas; ahora usa ANY (((SELECT ...))::text[]). Sin otros cambios.
-- (v2.5) Prueba 21 (3.6c): el DELETE directo sobre storage.objects lo bloquea la plataforma (trigger storage.protect_delete, 42501): se acepta SOLO ese bloqueo verificado, se revisa el predicado efectivo de las politicas DELETE/ALL y se agregan controles positivos; la RLS de DELETE sobre Storage se verifica despues por Storage API (QA funcional).
-- (v2.6) Premisas desactualizadas contra el estado real de STAGING, sin tocar la logica de seguridad: 3d.7 (el medico NO lee cardiolink_communications por SELECT directo; su historial llega por la RPC), nombre unico del archivo del medico (storage exige unicidad), titulos tras el retitulado del paso 4 (4b.6a/4b.7c), motivo >= 10 caracteres (cppv1_motivo_length), t_res escribible por anon y fixture 7b sin sesion.
-- Despues, en la misma sesion, una fila de veredicto con valores absolutos de lo que podria haber quedado (todo debe ser 0 y las 4 politicas anteriores deben seguir en pie).
-- NO hay COMMIT en este archivo. Los SQL de origen se incluyen SIN su BEGIN/COMMIT (si no, cada COMMIT haria permanente lo instalado).
--
-- PRECONDICIONES: 4C-1 y 4C-1b NO estan aplicados (si lo estan, el script se detiene sin hacer nada); etapas A y B de 4B instaladas; hay 1 secretaria asociada a un usuario con rol medico y professional_id,
-- 1 owner/admin activo, y existen cardiolink_paciente_acceso_clinico_v1(text) y cardiolink_paciente_profesionales_v1.
-- DURANTE EL ENSAYO: DDL sobre cardiolink_patient_documents y storage.objects mantiene bloqueos hasta el ROLLBACK (segundos): ejecutar sin trafico (fuera del horario de uso). La fila de configuracion se
-- reemplaza SOLO dentro de la transaccion y se restaura sola al revertir.
-- RESULTADO: la ULTIMA sentencia devuelve UNA fila con el veredicto ('ENSAYO OK'). Si una prueba falla, el script se detiene con un mensaje 'FALLA ...' y la transaccion queda abortada:
-- ejecutar ROLLBACK; (no se persiste nada). Terminar SIN error significa que TODAS las pruebas pasaron (cada una lanza una excepcion si falla).
-- Procedimiento: pending_review_documentos_seguridad_4c1_ensayo_reversible_procedimiento.md
-- SIN EJECUTAR: sintaxis sin validar contra una base.

-- ===== PASO 0: guarda de seguridad (no hace ningun cambio) =====
DO $$
BEGIN
  IF to_regprocedure('public.cardiolink_tipos_documento_secretaria_v1()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_policies WHERE policyname LIKE '%\_4c1' ESCAPE '\' AND ((schemaname='public' AND tablename='cardiolink_patient_documents') OR (schemaname='storage' AND tablename='objects'))) THEN
    RAISE EXCEPTION 'El ensayo requiere el bloque 4C-1 SIN aplicar (ya existen funciones o politicas). No se hizo nada.';
  END IF;
  IF to_regprocedure('public.cardiolink_config_tipos_doc_sec_v1()') IS NULL THEN
    RAISE EXCEPTION 'El ensayo requiere la etapa A de 4B instalada (falta cardiolink_config_tipos_doc_sec_v1). No se hizo nada.';
  END IF;
  IF (SELECT public.cardiolink_config_tipos_doc_sec_v1()) IS DISTINCT FROM ARRAY['constancia_atencion']::text[] THEN
    RAISE EXCEPTION 'El ensayo requiere 4C-1b SIN aplicar (la lista de documentos heredados no es la original). No se hizo nada.';
  END IF;
END $$;

-- Estado previo de la funcion del historial de envios (si existe): se compara al final contra lo que deja el rollback. Tabla temporal de ESTA sesion (se crea fuera de la transaccion del ensayo).
CREATE TEMP TABLE t_rpc_previa AS
  SELECT md5(regexp_replace(prosrc, '\s+', ' ', 'g')) AS h FROM pg_proc WHERE oid = to_regprocedure('public.cardiolink_historial_envios_documento_v1(text[])');

-- ===== TRANSACCION DEL ENSAYO =====
BEGIN;

-- ---------- BLOQUE 4C-1 (pending_review_documentos_seguridad_4c1.sql, sin su BEGIN/COMMIT) ----------
EOF_CAB
awk '!(/^BEGIN;$/ || /^COMMIT;$/)' "$D/${P}.sql"
echo
echo "-- ---------- BLOQUE 4C-1b (pending_review_documentos_seguridad_4c1b_heredados.sql, sin su BEGIN/COMMIT) ----------"
awk '!(/^BEGIN;$/ || /^COMMIT;$/)' "$D/${P}b_heredados.sql"
echo
echo "-- ---------- PRUEBAS SQL DE 4C-1 (pending_review_documentos_seguridad_4c1_tests.sql, secciones 0 a 7; sin su BEGIN ni su cierre) ----------"
awk '/^-- ===== 8\) Resultado y ROLLBACK =====/{exit} !/^BEGIN;$/{print}' "$D/${P}_tests.sql"
echo
echo "-- ---------- PRUEBAS SQL DE 4C-1b (pending_review_documentos_seguridad_4c1b_heredados_tests.sql; sin su BEGIN ni su cierre) ----------"
awk '/^-- ===== Resultado y ROLLBACK =====/{exit} !/^BEGIN;$/{print}' "$D/${P}b_heredados_tests.sql"
echo
echo "-- ---------- ROLLBACK DE AMBAS PARTES, DENTRO DE LA MISMA TRANSACCION (primero 4C-1b, despues 4C-1; sin sus BEGIN/COMMIT) ----------"
echo "RESET ROLE;"
awk '!(/^BEGIN;$/ || /^COMMIT;$/)' "$D/${P}b_heredados_rollback.sql"
awk '!(/^BEGIN;$/ || /^COMMIT;$/)' "$D/${P}_rollback.sql"
cat <<'EOF_RB'

DO $$
BEGIN
  IF to_regprocedure('public.cardiolink_tipos_documento_secretaria_v1()') IS NOT NULL OR to_regprocedure('public.cardiolink_profesionales_autorizados_secretaria_v1()') IS NOT NULL
     OR to_regprocedure('public.cardiolink_secretaria_autorizada_prof_v1(text)') IS NOT NULL OR to_regprocedure('public.cardiolink_objeto_sin_fila_v1(text)') IS NOT NULL
     OR to_regprocedure('public.cardiolink_objeto_asignable_v1(text,text)') IS NOT NULL OR to_regprocedure('public.cardiolink_vinculo_documental_v1(text,text,text,boolean)') IS NOT NULL
     OR to_regprocedure('public.cardiolink_patient_documents_inmutables_4c1()') IS NOT NULL THEN
    RAISE EXCEPTION 'FALLA 90a: el rollback de 4C-1 dejo funciones instaladas'; END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE policyname LIKE '%\_4c1' ESCAPE '\') OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.cardiolink_patient_documents'::regclass AND tgname='cardiolink_patient_documents_inmutables_4c1') THEN
    RAISE EXCEPTION 'FALLA 90b: el rollback de 4C-1 dejo politicas o el trigger'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE permissive='RESTRICTIVE' AND policyname IN ('cardiolink_patient_documents_select_no_img_secretaria','cardiolink_patient_documents_insert_no_img_secretaria',
        'cardiolink_clinical_images_storage_select_no_secretaria','cardiolink_clinical_images_storage_insert_no_secretaria')) <> 4 THEN
    RAISE EXCEPTION 'FALLA 90c: el rollback de 4C-1 no restauro las 4 politicas anteriores'; END IF;
  IF (SELECT public.cardiolink_config_tipos_doc_sec_v1()) IS DISTINCT FROM ARRAY['constancia_atencion']::text[] THEN
    RAISE EXCEPTION 'FALLA 90d: el rollback de 4C-1b no restauro la lista original de documentos heredados'; END IF;
  IF coalesce((SELECT h FROM t_rpc_previa), '') IS DISTINCT FROM coalesce((SELECT md5(regexp_replace(prosrc, '\s+', ' ', 'g')) FROM pg_proc WHERE oid = to_regprocedure('public.cardiolink_historial_envios_documento_v1(text[])')), '') THEN
    RAISE EXCEPTION 'FALLA 90e: el rollback de 4C-1 no dejo la funcion del historial de envios igual a como estaba antes del ensayo (o la dejo creada sin que existiera)'; END IF;
  INSERT INTO t_res VALUES ('90 rollback de AMBAS partes (4C-1b y 4C-1) ejecutado en la transaccion: restaura exactamente el estado anterior', 'OK');
END $$;
EOF_RB
sed "s/__N__/$N/" <<'EOF_PIE1'

-- ---------- FIN DE LAS PRUEBAS: resultados (visibles si el cliente muestra todos los resultados) y se REVIERTE TODO ----------
RESET ROLE;
SELECT nombre, resultado FROM t_res ORDER BY nombre;      -- se esperan __N__ filas, todas 'OK'
ROLLBACK;

-- ===== VERIFICACION POSTERIOR (una sola fila; debe decir 'ENSAYO OK') =====
EOF_PIE1
cat <<EOF_PIE2
WITH v AS (
  SELECT
    (SELECT count(*) FROM pg_policies WHERE policyname LIKE '%\\_4c1' ESCAPE '\\' AND ((schemaname='public' AND tablename='cardiolink_patient_documents') OR (schemaname='storage' AND tablename='objects'))) AS politicas_4c1_restantes,
    (SELECT count(*) FROM pg_policies WHERE permissive='RESTRICTIVE' AND policyname IN ('cardiolink_patient_documents_select_no_img_secretaria','cardiolink_patient_documents_insert_no_img_secretaria',
        'cardiolink_clinical_images_storage_select_no_secretaria','cardiolink_clinical_images_storage_insert_no_secretaria')) AS politicas_anteriores_en_pie,
    (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('cardiolink_tipos_documento_secretaria_v1','cardiolink_profesionales_autorizados_secretaria_v1',
        'cardiolink_secretaria_autorizada_prof_v1','cardiolink_objeto_sin_fila_v1','cardiolink_objeto_asignable_v1','cardiolink_vinculo_documental_v1','cardiolink_patient_documents_inmutables_4c1')) AS funciones_4c1_restantes,
    (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.cardiolink_patient_documents'::regclass AND tgname='cardiolink_patient_documents_inmutables_4c1') AS trigger_4c1_restante,
    (SELECT public.cardiolink_config_tipos_doc_sec_v1() = ARRAY['constancia_atencion']::text[]) AS lista_heredados_original,
    (SELECT count(*) FROM public.cardiolink_atenciones WHERE id = '__cardiolink_config_v1' AND payload ->> 'version' = 'T-4C1B') AS filas_config_con_marca_4c1b,
    (SELECT count(*) FROM public.cardiolink_patient_documents WHERE patient_id LIKE E'qa4c\\\\_%') AS documentos_qa4c_restantes,
    (SELECT count(*) FROM storage.objects WHERE bucket_id='patient-documents' AND name LIKE E'%qa4c\\\\_%') AS objetos_qa4c_restantes,
    (SELECT count(*) FROM public.cardiolink_pacientes WHERE id LIKE E'qa4c\\\\_%') AS pacientes_qa4c_restantes,
    (SELECT count(*) FROM public.cardiolink_hc_evoluciones WHERE id LIKE E'qa4c\\\\_%') AS evoluciones_qa4c_restantes,
    (SELECT count(*) FROM public.cardiolink_atenciones WHERE id LIKE E'\\\\_\\\\_t\\\\_qa4c%') AS atenciones_qa4c_restantes,
    (SELECT count(*) FROM public.cardiolink_user_roles WHERE professional_id = 'qa4c_prof_b') AS roles_convertidos_restantes,
    (SELECT count(*) FROM public.cardiolink_communications WHERE message LIKE 'qa4c%') AS comunicaciones_qa4c_restantes,
    (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='cardiolink_communications' AND policyname='cardiolink_communications_select_docs_4c1') AS politica_comunicaciones_restante,
    (coalesce((SELECT h FROM t_rpc_previa), '') = coalesce((SELECT md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) FROM pg_proc WHERE oid = to_regprocedure('public.cardiolink_historial_envios_documento_v1(text[])')), '')) AS rpc_historial_igual_a_la_previa,
    (SELECT (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.cardiolink_paciente_profesionales_v1 where %I = ''qa4c_pac_d''',
        (SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='cardiolink_paciente_profesionales_v1' AND column_name IN ('paciente_id','patient_id') LIMIT 1)), false, true, '')))[1]::text::int) AS asociaciones_qa4c_restantes
)
SELECT
  CASE WHEN politicas_4c1_restantes = 0 AND politicas_anteriores_en_pie = 4 AND funciones_4c1_restantes = 0 AND trigger_4c1_restante = 0 AND lista_heredados_original AND filas_config_con_marca_4c1b = 0
        AND documentos_qa4c_restantes = 0 AND objetos_qa4c_restantes = 0 AND pacientes_qa4c_restantes = 0 AND evoluciones_qa4c_restantes = 0 AND atenciones_qa4c_restantes = 0
        AND roles_convertidos_restantes = 0 AND asociaciones_qa4c_restantes = 0 AND comunicaciones_qa4c_restantes = 0 AND politica_comunicaciones_restante = 0 AND rpc_historial_igual_a_la_previa
       THEN 'ENSAYO OK: las $N pruebas terminaron sin error y no quedo nada persistido'
       ELSE 'REVISAR: el ensayo no cerro limpio (ver las columnas)' END AS veredicto,
  v.*
FROM v;
EOF_PIE2
} > "$OUT"
echo "Generado: $OUT ($(wc -l < "$OUT") lineas, $N pruebas esperadas)"
