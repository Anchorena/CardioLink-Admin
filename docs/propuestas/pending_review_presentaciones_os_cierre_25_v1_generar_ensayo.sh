#!/bin/sh
# Genera pending_review_presentaciones_os_cierre_25_v1_ensayo_reversible.sql = SQL del cierre del día 25 + pruebas + ROLLBACK del cierre + verificación + veredicto.
# Uso: sh pending_review_presentaciones_os_cierre_25_v1_generar_ensayo.sh   (desde docs/propuestas). El resultado se pega en el SQL Editor de STAGING (NUNCA Production).
# PRECONDICIÓN: STAGING ya tiene el bloque base y el complemento de terceros. El ensayo NO deja nada: termina SIEMPRE con una EXCEPTION que revierte todo.
cd "$(dirname "$0")" || exit 1
P=pending_review_presentaciones_os_cierre_25_v1
T=pending_review_facturacion_presentaciones_v1_terceros_ensayo_pruebas.sql
OUT=${P}_ensayo_reversible.sql
strip() { sed -e '/^BEGIN;$/d' -e '/^COMMIT;$/d' "$1"; }
LIN=$(grep -n '^-- ===== PRUEBAS del complemento de facturación por terceros' "$T" | head -1 | cut -d: -f1)
[ -n "$LIN" ] || { echo "ERROR: no se encontró el encabezado común de pruebas en $T"; exit 1; }
{
cat <<'HDR'
-- CardioLink · Presentaciones OS · CIERRE DEL DÍA 25 · ENSAYO REVERSIBLE (STAGING). GENERADO por pending_review_presentaciones_os_cierre_25_v1_generar_ensayo.sh: no editar a mano.
-- NO ejecutar en Production. Sin BEGIN/COMMIT: se corre en UNA transacción y termina SIEMPRE con una EXCEPTION que revierte todo (el SQL del cierre, las filas sintéticas qa_pres_*, la fecha de control y la asociación activada para el ensayo).
-- RESULTADO ESPERADO: error final "ENSAYO_CIERRE25_OK: N pruebas ..." (señal de éxito + rollback). Cualquier "FALLA ..." indica la prueba que no pasó. Deja la base como estaba.
-- Orden: actores y ayudas -> SQL del cierre (con sus precondiciones) -> pruebas -> rollback del cierre -> verificación de que quedó el estado del complemento de terceros -> veredicto.
HDR
head -n $((LIN - 1)) "$T"
echo "-- ===== SQL del cierre del día 25 ====="
strip ${P}.sql
cat ${P}_ensayo_pruebas.sql
echo "-- ===== ROLLBACK del cierre ====="
strip ${P}_rollback.sql
cat <<'FIN'
DO $$
DECLARE v_np int;
BEGIN
  IF (SELECT count(*) FROM public.cardiolink_atenciones WHERE id NOT LIKE 'qa\_pres\_%' ESCAPE '\') <> (SELECT n FROM t_n_real) THEN RAISE EXCEPTION 'FALLA R1: cambió la cantidad de atenciones reales'; END IF;
  IF to_regclass('public.cardiolink_presentaciones_os_delegaciones_v1') IS NULL OR to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb)') IS NULL THEN RAISE EXCEPTION 'FALLA R2: el rollback del cierre dañó el complemento de terceros'; END IF;
  SELECT count(*) INTO v_np FROM t_res;
  RAISE EXCEPTION 'ENSAYO_CIERRE25_OK: % pruebas pasaron, el rollback del cierre dejó el estado del complemento de terceros y se revierte todo (esta EXCEPTION es la señal de éxito)', v_np;
END $$;
FIN
} > "$OUT"
[ "$(grep -c '^BEGIN;$' "$OUT")" = 0 ] && [ "$(grep -c '^COMMIT;$' "$OUT")" = 0 ] || { echo "ERROR: el ensayo no debe tener BEGIN/COMMIT"; exit 1; }
echo "generado: $OUT ($(wc -l < "$OUT") líneas)"
