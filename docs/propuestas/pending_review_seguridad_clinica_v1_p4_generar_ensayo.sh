#!/bin/sh
# Genera pending_review_seguridad_clinica_v1_p4_ensayo_reversible.sql = p4 + (p4b si p3 está aplicada) + pruebas + ROLLBACKS + comparación de políticas + veredicto.
# Uso: sh pending_review_seguridad_clinica_v1_p4_generar_ensayo.sh   (desde docs/propuestas). Pegar el resultado en el SQL Editor de STAGING.
cd "$(dirname "$0")" || exit 1
P=pending_review_seguridad_clinica_v1
OUT=${P}_p4_ensayo_reversible.sql
strip() { sed -e '/^BEGIN;$/d' -e '/^COMMIT;$/d' "$1"; }
{
cat <<'HDR'
-- CardioLink · Seguridad clínica V1 · p4 "padrón compartido" · ENSAYO REVERSIBLE (STAGING). GENERADO por pending_review_seguridad_clinica_v1_p4_generar_ensayo.sh: no editar a mano.
-- NO ejecutar en Production. Sin BEGIN/COMMIT: el SQL Editor corre todo en UNA transacción y el script termina SIEMPRE con una EXCEPTION, que revierte todo (pacientes, filas, objetos y cambios de rol sintéticos).
-- RESULTADO ESPERADO: error final "ENSAYO_P4_OK: N pruebas ..." (es la señal de éxito + rollback). Cualquier otro mensaje "FALLA ..." indica la prueba que no pasó. Deja la base como estaba.
-- Orden: foto de políticas -> p4 -> (p4b si p3) -> pruebas -> rollback de p4b/p4 -> la foto debe coincidir exactamente -> veredicto.
HDR
echo "CREATE TEMP TABLE t_antes AS SELECT tablename, policyname, cmd, permissive, roles::text AS roles, qual, with_check FROM pg_policies WHERE tablename IN ('cardiolink_patient_documents','cardiolink_hc_evoluciones','cardiolink_hc_resumen');"
echo "CREATE TEMP TABLE t_flags AS SELECT (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND policyname LIKE '%\\_v1' ESCAPE '\\') = 8 AS hay_p3;"
echo "GRANT SELECT ON t_flags TO authenticated;"
echo "-- ===== p4 ====="
strip ${P}_p4_padron_compartido.sql
echo "-- ===== p4b (sólo si p3 está aplicada) ====="
echo "DO \$ens\$ BEGIN IF (SELECT hay_p3 FROM t_flags) THEN EXECUTE \$b\$"
strip ${P}_p4b_hc_padron.sql
echo "\$b\$; END IF; END \$ens\$;"
cat ${P}_p4_ensayo_pruebas.sql
echo "-- ===== ROLLBACKS ====="
echo "DO \$ens\$ BEGIN IF (SELECT hay_p3 FROM t_flags) THEN EXECUTE \$b\$"
strip ${P}_p4b_hc_padron_rollback.sql
echo "\$b\$; END IF; END \$ens\$;"
strip ${P}_p4_padron_compartido_rollback.sql
cat <<'FIN'
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
FIN
} > "$OUT"
echo "generado: $OUT ($(wc -l < "$OUT") líneas)"
