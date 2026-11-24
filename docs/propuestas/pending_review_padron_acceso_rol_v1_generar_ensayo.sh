#!/bin/sh
# Genera pending_review_padron_acceso_rol_v1_ensayo_reversible.sql = foto -> pruebas ANTES -> A -> B -> pruebas DESPUÉS + extras -> rollback B -> rollback A -> pruebas ANTES otra vez -> comparación -> veredicto.
# Uso: sh pending_review_padron_acceso_rol_v1_generar_ensayo.sh   (desde docs/propuestas). Pegar el resultado en el SQL Editor de STAGING (y, sólo con autorización expresa, de Production).
cd "$(dirname "$0")" || exit 1
P=pending_review_padron_acceso_rol_v1
OUT=${P}_ensayo_reversible.sql
strip() { sed -e '/^BEGIN;$/d' -e '/^COMMIT;$/d' "$1"; }
{
cat <<'HDR'
-- CardioLink · Bloque 0B · acceso al padrón con rol activo · ENSAYO REVERSIBLE. GENERADO por pending_review_padron_acceso_rol_v1_generar_ensayo.sh: no editar a mano.
-- Sin BEGIN/COMMIT: el SQL Editor corre todo en UNA transacción y el script termina SIEMPRE con una EXCEPTION, que revierte todo (filas qa0b_*, cambios de rol sintéticos, políticas aplicadas).
-- RESULTADO ESPERADO: error final "ENSAYO_0B_OK: N pruebas ..." (señal de éxito + rollback). Cualquier otro mensaje "FALLA ..." indica la prueba que no pasó. Deja la base como estaba.
-- Orden: foto -> pruebas (estado de hoy: el problema) -> PARTE A -> PARTE B -> pruebas (cerrado) + extras -> rollback B -> rollback A -> pruebas (otra vez abierto) -> la foto debe coincidir exactamente.
-- No toca datos: sólo inserta y borra filas sintéticas qa0b_* dentro de la transacción.
HDR
echo "CREATE TEMP TABLE t_antes AS SELECT tablename, policyname, cmd, permissive, roles::text AS roles, qual, with_check FROM pg_policies WHERE schemaname IN ('public','storage');"
echo "CREATE TEMP TABLE t_acl_antes AS SELECT relname, relacl::text AS acl FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r';"
cat ${P}_ensayo_pruebas.sql
echo "DO \$ens\$ BEGIN PERFORM pg_temp.suite('abierto'); END \$ens\$;"
echo "-- ===== PARTE A ====="
strip ${P}_a_pacientes.sql
echo "-- ===== PARTE B ====="
strip ${P}_b_legacy.sql
echo "DO \$ens\$ BEGIN PERFORM pg_temp.suite('cerrado'); PERFORM pg_temp.extras(); END \$ens\$;"
echo "-- ===== ROLLBACKS ====="
strip ${P}_b_legacy_rollback.sql
strip ${P}_a_pacientes_rollback.sql
echo "DO \$ens\$ BEGIN PERFORM pg_temp.suite('abierto'); END \$ens\$;"
cat <<'FIN'
DO $$
DECLARE n int;
BEGIN
  IF EXISTS (SELECT tablename, policyname, cmd, permissive, roles::text, qual, with_check FROM pg_policies WHERE schemaname IN ('public','storage')
             EXCEPT SELECT tablename, policyname, cmd, permissive, roles, qual, with_check FROM t_antes)
     OR EXISTS (SELECT tablename, policyname, cmd, permissive, roles, qual, with_check FROM t_antes
             EXCEPT SELECT tablename, policyname, cmd, permissive, roles::text, qual, with_check FROM pg_policies WHERE schemaname IN ('public','storage')) THEN
    RAISE EXCEPTION 'FALLA R1: tras los rollbacks las políticas NO coinciden con la foto inicial'; END IF;
  IF EXISTS (SELECT relname, relacl::text FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' EXCEPT SELECT relname, acl FROM t_acl_antes)
     OR EXISTS (SELECT relname, acl FROM t_acl_antes EXCEPT SELECT relname, relacl::text FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r') THEN
    RAISE EXCEPTION 'FALLA R2: tras los rollbacks cambiaron privilegios de tablas'; END IF;
  IF EXISTS (SELECT 1 FROM public.cardiolink_pacientes WHERE id LIKE 'qa0b\_%' ESCAPE '\' AND id NOT IN ('qa0b_fix_1','qa0b_fix_2')) THEN RAISE EXCEPTION 'FALLA R3: quedaron filas sintéticas sueltas'; END IF;
  SELECT count(*) INTO n FROM t_res;
  RAISE EXCEPTION 'ENSAYO_0B_OK: % pruebas pasaron, los rollbacks restauraron políticas y privilegios exactamente y todo se revierte (esta EXCEPTION es la señal de éxito)', n;
END $$;
FIN
} > "$OUT"
echo "generado: $OUT ($(wc -l < "$OUT") líneas)"
