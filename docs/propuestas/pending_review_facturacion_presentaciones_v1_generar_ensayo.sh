#!/bin/sh
# Genera pending_review_facturacion_presentaciones_v1_ensayo_reversible.sql = SQL propuesto + pruebas + ROLLBACK + veredicto.
# Uso: sh pending_review_facturacion_presentaciones_v1_generar_ensayo.sh   (desde docs/propuestas). El resultado se pega en el SQL Editor de STAGING (NUNCA Production).
cd "$(dirname "$0")" || exit 1
P=pending_review_facturacion_presentaciones_v1
OUT=${P}_ensayo_reversible.sql
strip() { sed -e '/^BEGIN;$/d' -e '/^COMMIT;$/d' "$1"; }
{
cat <<'HDR'
-- CardioLink · Facturación mensual V1 · Bloque 1 · Presentaciones a obras sociales · ENSAYO REVERSIBLE (STAGING). GENERADO por pending_review_facturacion_presentaciones_v1_generar_ensayo.sh: no editar a mano.
-- NO ejecutar en Production. Sin BEGIN/COMMIT: el SQL Editor corre todo en UNA transacción y el script termina SIEMPRE con una EXCEPTION, que revierte todo (tablas, funciones, filas sintéticas qa_pres_* y presentaciones de prueba).
-- RESULTADO ESPERADO: error final "ENSAYO_PRES_OK: N pruebas ..." (es la señal de éxito + rollback). Cualquier otro mensaje "FALLA ..." indica la prueba que no pasó. Deja la base como estaba.
-- Orden: SQL propuesto (precondiciones incluidas) -> pruebas como owner / secretaria asociada / médico / sin rol / anon -> rollback del bloque -> verificación de que no queda nada -> veredicto.
-- NO cubre dos sesiones simultáneas (hace falta otra conexión): la garantía es el índice único por atención, que P2f ejercita con un INSERT directo.
HDR
echo "-- ===== SQL propuesto ====="
strip ${P}.sql
cat ${P}_ensayo_pruebas.sql
echo "-- ===== ROLLBACK del bloque ====="
strip ${P}_rollback.sql
cat <<'FIN'
DO $$
DECLARE v_np int;
BEGIN
  IF to_regclass('public.cardiolink_presentaciones_os_v1') IS NOT NULL OR to_regclass('public.cardiolink_presentaciones_os_items_v1') IS NOT NULL OR to_regclass('public.cardiolink_presentaciones_os_control_v1') IS NOT NULL
     OR to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb)') IS NOT NULL OR to_regprocedure('public.cardiolink_presentacion_os_control_v1(date)') IS NOT NULL
     OR to_regprocedure('public.cardiolink_presentacion_os_ver_v1(text)') IS NOT NULL OR to_regprocedure('public.cardiolink_presentacion_os_confirmar_permitido_v1(text)') IS NOT NULL THEN
    RAISE EXCEPTION 'FALLA R1: tras el rollback quedaron objetos del bloque'; END IF;
  IF (SELECT count(*) FROM public.cardiolink_atenciones WHERE id NOT LIKE 'qa\_pres\_%' ESCAPE '\') <> (SELECT n FROM t_n_real) THEN RAISE EXCEPTION 'FALLA R2: cambió la cantidad de atenciones reales'; END IF;
  SELECT count(*) INTO v_np FROM t_res;
  RAISE EXCEPTION 'ENSAYO_PRES_OK: % pruebas pasaron, el rollback del bloque dejó todo como estaba y se revierte todo (esta EXCEPTION es la señal de éxito)', v_np;
END $$;
FIN
} > "$OUT"
echo "generado: $OUT ($(wc -l < "$OUT") líneas)"
