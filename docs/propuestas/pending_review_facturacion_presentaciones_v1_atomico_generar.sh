#!/bin/sh
# Genera, a partir de los SQL ya revisados (sin copiar su contenido a mano):
#   1) pending_review_facturacion_presentaciones_v1_APLICACION_ATOMICA.sql  = bloque base + complemento de terceros en UNA sola transacción (un BEGIN, un COMMIT).
#   2) pending_review_facturacion_presentaciones_v1_atomico_ensayo_reversible.sql = ensayo para STAGING: deshace (dentro de la transacción) complemento y base, aplica el atómico y corre las pruebas; termina SIEMPRE en EXCEPTION (revierte todo).
# Uso: sh pending_review_facturacion_presentaciones_v1_atomico_generar.sh   (desde docs/propuestas). No ejecuta nada contra ninguna base.
cd "$(dirname "$0")" || exit 1
P=pending_review_facturacion_presentaciones_v1
ATOM=${P}_APLICACION_ATOMICA.sql
ENS=${P}_atomico_ensayo_reversible.sql
strip() { sed -e '/^BEGIN;$/d' -e '/^COMMIT;$/d' "$1"; }

{
cat <<'HDR'
-- CardioLink · FACTURACIÓN MENSUAL V1 · APLICACIÓN ATÓMICA (bloque base + complemento de terceros). GENERADO por pending_review_facturacion_presentaciones_v1_atomico_generar.sh: no editar a mano.
-- *** SQL PROPUESTO · NO aplicado en Production. NO EJECUTAR sin autorización explícita y sin los checks previos de solo lectura (..._checks.sql). ***
-- UNA sola transacción (un único BEGIN y un único COMMIT): nadie ve el bloque base sin el complemento. Si cualquier precondición o postcondición falla, se revierte TODO y la base queda como estaba.
-- Para Production (no tiene ningún objeto de Presentaciones). NO usar en una base que ya tenga el bloque base (STAGING): ahí corresponde solo ..._terceros.sql.
-- NO ejecutar los dos archivos por separado (cada uno trae su propio BEGIN/COMMIT: entre ambos quedaría la guarda vieja del control de fecha). Rollback completo: ..._terceros_rollback.sql y luego ..._rollback.sql.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
-- ================= PARTE 1: BLOQUE BASE (pending_review_facturacion_presentaciones_v1.sql, sin su BEGIN/COMMIT) =================
HDR
strip ${P}.sql
echo "-- ================= PARTE 2: COMPLEMENTO DE TERCEROS (${P}_terceros.sql, sin su BEGIN/COMMIT) ================="
strip ${P}_terceros.sql
cat <<'FIN'
-- ================= PARTE 3: verificación conjunta antes del COMMIT =================
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename LIKE 'cardiolink\_presentaciones\_os%' ESCAPE '\' AND permissive = 'PERMISSIVE') <> 4 THEN
    RAISE EXCEPTION 'FALLA conjunta: deben quedar 4 políticas SELECT'; END IF;
  IF coalesce(pg_get_functiondef(to_regprocedure('public.cardiolink_presentacion_os_control_v1(date)')), '') NOT LIKE '%coalesce((SELECT public.cardiolink_ctx_rol_v1()%' THEN
    RAISE EXCEPTION 'FALLA conjunta: el control de fecha no quedó con la guarda robusta ante usuarios sin rol'; END IF;
END $$;
COMMIT;
FIN
} > "$ATOM"

[ "$(grep -c '^BEGIN;$' "$ATOM")" = 1 ] && [ "$(grep -c '^COMMIT;$' "$ATOM")" = 1 ] || { echo "ERROR: el atómico debe tener exactamente un BEGIN y un COMMIT"; exit 1; }
! grep -Eiq '^[[:space:]]*(ROLLBACK|SAVEPOINT|CREATE INDEX CONCURRENTLY)' "$ATOM" || { echo "ERROR: sentencia no transaccional en el atómico"; exit 1; }

{
cat <<'HDR'
-- CardioLink · Facturación mensual V1 · APLICACIÓN ATÓMICA · ENSAYO REVERSIBLE (STAGING). GENERADO por pending_review_facturacion_presentaciones_v1_atomico_generar.sh: no editar a mano.
-- NO ejecutar en Production. Sin BEGIN/COMMIT: se corre en UNA transacción y termina SIEMPRE con una EXCEPTION que revierte todo (incluidos los DROP del paso 1).
-- STAGING ya tiene base + complemento: el paso 1 los deshace DENTRO de la transacción para dejar la base como Production (sin objetos de Presentaciones); el paso 2 aplica el archivo ATÓMICO; el paso 3 corre las pruebas del complemento sobre el resultado.
-- RESULTADO ESPERADO: error final "ENSAYO_ATOMICO_OK: N pruebas ..." (señal de éxito + rollback). Cualquier "FALLA ..." indica qué no pasó.
-- ===== PASO 1: dejar la base sin objetos de Presentaciones (rollback del complemento y del base, ambos sin BEGIN/COMMIT) =====
HDR
strip ${P}_terceros_rollback.sql
strip ${P}_rollback.sql
cat <<'MID'
DO $$
BEGIN
  IF to_regclass('public.cardiolink_presentaciones_os_v1') IS NOT NULL OR to_regclass('public.cardiolink_presentaciones_os_items_v1') IS NOT NULL OR to_regclass('public.cardiolink_presentaciones_os_control_v1') IS NOT NULL
     OR to_regclass('public.cardiolink_presentaciones_os_delegaciones_v1') IS NOT NULL OR to_regprocedure('public.cardiolink_presentacion_os_confirmar_v1(text,jsonb)') IS NOT NULL
     OR to_regprocedure('public.cardiolink_presentacion_os_norm_v1(text)') IS NOT NULL THEN
    RAISE EXCEPTION 'FALLA P1: la base no quedó sin objetos de Presentaciones (estado equivalente a Production)'; END IF;
END $$;
-- ===== PASO 2: APLICACIÓN ATÓMICA (el archivo real, sin su BEGIN/COMMIT) =====
MID
strip "$ATOM"
echo "-- ===== PASO 3: pruebas (como owner / secretaría asociada / médico / sin rol / anon) ====="
cat ${P}_terceros_ensayo_pruebas.sql
cat <<'FIN'
DO $$
DECLARE v_np int;
BEGIN
  IF (SELECT count(*) FROM public.cardiolink_atenciones WHERE id NOT LIKE 'qa\_pres\_%' ESCAPE '\') <> (SELECT n FROM t_n_real) THEN RAISE EXCEPTION 'FALLA R2: cambió la cantidad de atenciones reales'; END IF;
  SELECT count(*) INTO v_np FROM t_res;
  RAISE EXCEPTION 'ENSAYO_ATOMICO_OK: % pruebas pasaron sobre la aplicación atómica base+complemento; se revierte todo (esta EXCEPTION es la señal de éxito)', v_np;
END $$;
FIN
} > "$ENS"
[ "$(grep -c '^BEGIN;$' "$ENS")" = 0 ] && [ "$(grep -c '^COMMIT;$' "$ENS")" = 0 ] || { echo "ERROR: el ensayo no debe tener BEGIN/COMMIT"; exit 1; }
echo "generado: $ATOM ($(wc -l < "$ATOM") líneas)"
echo "generado: $ENS ($(wc -l < "$ENS") líneas)"
