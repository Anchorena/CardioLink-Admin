#!/bin/sh
# Genera pending_review_facturacion_presentaciones_v1_terceros_ensayo_reversible.sql = SQL complementario + pruebas + ROLLBACK del complemento + veredicto.
# Uso: sh pending_review_facturacion_presentaciones_v1_terceros_generar_ensayo.sh   (desde docs/propuestas). El resultado se pega en el SQL Editor de STAGING (NUNCA Production).
# PRECONDICIÓN: STAGING ya tiene el bloque base de Presentaciones (con PR412). El ensayo NO lo aplica: aplica solo el complemento, lo prueba y lo revierte.
cd "$(dirname "$0")" || exit 1
P=pending_review_facturacion_presentaciones_v1
OUT=${P}_terceros_ensayo_reversible.sql
strip() { sed -e '/^BEGIN;$/d' -e '/^COMMIT;$/d' "$1"; }
{
cat <<'HDR'
-- CardioLink · Facturación mensual V1 · COMPLEMENTO TERCEROS · ENSAYO REVERSIBLE (STAGING). GENERADO por pending_review_facturacion_presentaciones_v1_terceros_generar_ensayo.sh: no editar a mano.
-- NO ejecutar en Production. Sin BEGIN/COMMIT: el SQL Editor corre todo en UNA transacción y el script termina SIEMPRE con una EXCEPTION, que revierte todo (complemento, filas sintéticas qa_pres_*, asociación activada para el ensayo).
-- RESULTADO ESPERADO: error final "ENSAYO_TERC_OK: N pruebas ..." (señal de éxito + rollback). Cualquier otro mensaje "FALLA ..." indica la prueba que no pasó. Deja la base como estaba.
-- Orden: complemento (precondiciones incluidas) -> pruebas como owner / secretaría asociada / médico / sin rol / anon -> rollback del complemento -> verificación de que el bloque base quedó intacto -> veredicto.
-- NO cubre dos sesiones simultáneas (hace falta otra conexión): la garantía es el índice único por atención, que D3d ejercita con un INSERT directo.
HDR
echo "-- ===== SQL complementario ====="
strip ${P}_terceros.sql
cat ${P}_terceros_ensayo_pruebas.sql
echo "-- ===== ROLLBACK del complemento ====="
strip ${P}_terceros_rollback.sql
cat <<'FIN'
DO $$
DECLARE v_np int;
BEGIN
  IF (SELECT count(*) FROM public.cardiolink_atenciones WHERE id NOT LIKE 'qa\_pres\_%' ESCAPE '\') <> (SELECT n FROM t_n_real) THEN RAISE EXCEPTION 'FALLA R2: cambió la cantidad de atenciones reales'; END IF;
  IF to_regclass('public.cardiolink_presentaciones_os_items_v1') IS NULL OR to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb)') IS NULL THEN RAISE EXCEPTION 'FALLA R3: el rollback del complemento dañó el bloque base'; END IF;
  SELECT count(*) INTO v_np FROM t_res;
  RAISE EXCEPTION 'ENSAYO_TERC_OK: % pruebas pasaron, el rollback del complemento dejó el bloque base como estaba y se revierte todo (esta EXCEPTION es la señal de éxito)', v_np;
END $$;
FIN
} > "$OUT"
echo "generado: $OUT ($(wc -l < "$OUT") líneas)"
