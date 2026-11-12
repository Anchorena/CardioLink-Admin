#!/bin/sh
# Genera pending_review_config_secretaria_v1_ensayo_reversible.sql a partir de los SQL de la etapa A, la etapa B y las pruebas.
# No se conecta a ninguna base ni ejecuta SQL: sólo concatena texto. Uso: sh docs/propuestas/pending_review_config_secretaria_v1_generar_ensayo.sh
# Si cambia alguno de los tres SQL de origen hay que volver a generar el ensayo (tests/config-secretaria-v1.js, prueba D8, lo verifica).
set -eu
D="$(cd "$(dirname "$0")" && pwd)"
P=pending_review_config_secretaria_v1
OUT="$D/${P}_ensayo_reversible.sql"
N=$(grep -c 'INSERT INTO t_res' "$D/${P}_tests.sql")
# cuerpo vigente del predicado que exige la etapa B como precondicion (es el que debe quedar intacto tras el ROLLBACK)
CUERPO_PREVIO="$(awk '/regexp_replace\(\$e\$/{f=1;next} /^\$e\$, /{f=0} f' "$D/${P}_b_rls.sql")"
[ -n "$CUERPO_PREVIO" ] || { echo "No se pudo extraer el cuerpo previo del predicado de la etapa B" >&2; exit 1; }
{
cat <<'EOF_CAB'
-- CardioLink · Seguridad clinica V1 / Bloque 4B · ENSAYO REVERSIBLE (v3.1)   -- ARCHIVO GENERADO: no editar a mano (ver ..._generar_ensayo.sh)
-- SOLO STAGING (yslhwdlzdknhskawqrtv). NO EJECUTAR sin autorizacion explicita. NUNCA en Production.
--
-- QUE HACE: en UNA sola transaccion instala TEMPORALMENTE las funciones de la ETAPA A y las politicas/predicado de la ETAPA B, corre el QA SQL completo
-- y termina con ROLLBACK. Despues, en la misma sesion, verifica en una sola fila que NO quedo nada: ni funciones, ni politica, ni predicado modificado,
-- ni filas sinteticas, ni la fila de configuracion heredada alterada.
-- NO hay COMMIT en este archivo. Los SQL de origen se incluyen SIN su BEGIN/COMMIT (si no, cada COMMIT haria permanente lo instalado).
-- La verificacion final NO depende de objetos creados antes de la transaccion (un cliente que envia todo el script como una sola consulta los
-- incluiria en la misma transaccion y el ROLLBACK los borraria): compara contra valores absolutos (el cuerpo previo del predicado, los marcadores del fixture).
--
-- PRECONDICIONES: las ETAPAS A y B NO estan aplicadas (si lo estan, el script se detiene sin hacer nada). Hay 1 secretaria, 1 owner/admin y 1 medico activos.
-- DURANTE EL ENSAYO: DDL sobre cardiolink_atenciones mantiene bloqueos hasta el ROLLBACK (segundos): ejecutar sin trafico (fuera del horario de uso).
-- RESULTADO: la ULTIMA sentencia devuelve UNA fila con el veredicto ('ENSAYO OK'). Si una prueba falla, el script se detiene con un mensaje 'FALLA ...' y la
-- transaccion queda abortada: ejecutar ROLLBACK; (no se persiste nada). Terminar SIN error significa que TODAS las pruebas pasaron (cada una lanza una excepcion si falla).
-- Procedimiento: pending_review_config_secretaria_v1_ensayo_reversible_procedimiento.md
-- SIN EJECUTAR: sintaxis sin validar contra una base.

-- ===== PASO 0: guarda de seguridad (no hace ningun cambio) =====
DO $$
BEGIN
  IF to_regprocedure('public.cardiolink_config_administrativa_v1()') IS NOT NULL
     OR to_regprocedure('public.cardiolink_guardar_config_administrativa_v1(jsonb,text,text,uuid)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='cardiolink_atenciones' AND policyname='cardiolink_atenciones_config_solo_admin_v1') THEN
    RAISE EXCEPTION 'El ensayo requiere las etapas A y B SIN aplicar (ya existen funciones o la politica). No se hizo nada.';
  END IF;
END $$;

-- ===== TRANSACCION DEL ENSAYO =====
BEGIN;

-- ---------- ETAPA A (pending_review_config_secretaria_v1_a_rpc.sql, sin su BEGIN/COMMIT) ----------
EOF_CAB
awk '!(/^BEGIN;$/ || /^COMMIT;$/)' "$D/${P}_a_rpc.sql"
echo
echo "-- ---------- ETAPA B (pending_review_config_secretaria_v1_b_rls.sql, sin su BEGIN/COMMIT) ----------"
awk '!(/^BEGIN;$/ || /^COMMIT;$/)' "$D/${P}_b_rls.sql"
echo
echo "-- ---------- QA SQL (pending_review_config_secretaria_v1_tests.sql, secciones 0 a 4; sin su BEGIN ni su cierre) ----------"
awk '/^-- ===== 5\) Resultado y ROLLBACK =====/{exit} !/^BEGIN;$/{print}' "$D/${P}_tests.sql"
sed "s/__N__/$N/" <<'EOF_PIE1'

-- ---------- FIN DEL QA: resultados (visibles si el cliente muestra todos los resultados) y se REVIERTE TODO ----------
RESET ROLE;
SELECT nombre, resultado FROM t_res ORDER BY nombre;      -- se esperan __N__ filas, todas 'OK'
ROLLBACK;

-- ===== VERIFICACION POSTERIOR (una sola fila; debe decir 'ENSAYO OK') =====
-- Valores absolutos, sin depender de nada creado antes de la transaccion.
EOF_PIE1
cat <<EOF_PIE2
WITH v AS (
  SELECT
    (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN (
       'cardiolink_config_administrativa_v1','cardiolink_guardar_config_administrativa_v1','cardiolink_config_claves_lectura_sec_v1',
       'cardiolink_config_claves_escritura_sec_v1','cardiolink_config_claves_identidad_v1','cardiolink_config_campos_paciente_v1',
       'cardiolink_config_campos_profesional_admin_v1','cardiolink_config_tipos_doc_sec_v1','cardiolink_config_filtrar_objetos_v1',
       'cardiolink_config_vista_sec_v1','cardiolink_config_vista_escritura_sec_v1','cardiolink_config_paciente_con_clinica_v1',
       'cardiolink_config_fusionar_pacientes_v1','cardiolink_config_fusionar_profesionales_v1','cardiolink_config_unir_auditoria_v1')) AS funciones_del_bloque_restantes,
    (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='cardiolink_atenciones'
        AND policyname='cardiolink_atenciones_config_solo_admin_v1') AS politica_restrictiva_restante,
    (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='cardiolink_atenciones'
        AND (coalesce(qual,'') ~ 'cardiolink_atencion_permitida_v2' OR coalesce(with_check,'') ~ 'cardiolink_atencion_permitida_v2')) AS politicas_con_predicado_v2,
    (SELECT regexp_replace(prosrc, '\s+', '', 'g') = regexp_replace(\$ens\$
$CUERPO_PREVIO
\$ens\$, '\s+', '', 'g')
       FROM pg_proc WHERE oid = 'public.cardiolink_atencion_permitida_v2(jsonb,text,text)'::regprocedure) AS predicado_igual_al_previo,
    (SELECT count(*) FROM public.cardiolink_atenciones WHERE id = '__cardiolink_config_v1'
        AND payload ->> 'version' IS DISTINCT FROM 'T-1'
        AND payload ->> 'updatedAt' IS DISTINCT FROM '2000-01-01T00:00:00.000Z'
        AND updated_at IS DISTINCT FROM '2026-01-01T00:00:00Z'::timestamptz
        AND NOT ((payload -> 'config') ? 'claveDesconocidaFutura')) AS fila_config_sin_marcas_del_fixture,
    (SELECT count(*) FROM public.cardiolink_atenciones WHERE id LIKE E'\\\\_\\\\_t\\\\_%') AS atenciones_sinteticas_restantes,
    (SELECT count(*) FROM public.cardiolink_pacientes WHERE id LIKE E'qa\\\\_rel\\\\_%') AS pacientes_sinteticos_restantes,
    (SELECT count(*) FROM public.cardiolink_hc_evoluciones WHERE paciente_id LIKE E'qa\\\\_rel\\\\_%') AS evoluciones_sinteticas_restantes,
    (SELECT count(*) FROM public.cardiolink_hc_resumen WHERE paciente_id LIKE E'qa\\\\_rel\\\\_%') AS resumenes_sinteticos_restantes
)
SELECT
  CASE WHEN funciones_del_bloque_restantes = 0 AND politica_restrictiva_restante = 0 AND politicas_con_predicado_v2 >= 4 AND predicado_igual_al_previo
        AND fila_config_sin_marcas_del_fixture = 1 AND atenciones_sinteticas_restantes = 0 AND pacientes_sinteticos_restantes = 0
        AND evoluciones_sinteticas_restantes = 0 AND resumenes_sinteticos_restantes = 0
       THEN 'ENSAYO OK: las $N pruebas terminaron sin error y no quedo nada persistido'
       ELSE 'REVISAR: el ensayo no cerro limpio (ver las columnas)' END AS veredicto,
  v.*
FROM v;
EOF_PIE2
} > "$OUT"
echo "Generado: $OUT ($(wc -l < "$OUT") lineas, $N pruebas esperadas)"
