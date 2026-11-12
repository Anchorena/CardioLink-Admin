# Bloque 4B — Procedimiento del ENSAYO REVERSIBLE (v3.1)

**Estado: NO ejecutar todavía.** Requiere autorización explícita. Solo STAGING (`yslhwdlzdknhskawqrtv`). Nunca Production (`tupacclmhaqiahhlttyz`).
La CLI de Supabase de esta Mac apunta a Production: **no usarla** para esto; usar el SQL Editor de STAGING (confirmar el proyecto en la URL) o `psql` con la cadena de conexión de STAGING.

## Qué es
`pending_review_config_secretaria_v1_ensayo_reversible.sql` (generado, no se edita a mano) hace, en UNA transacción:
1. Guarda de seguridad: si la etapa A o la B ya están aplicadas, se detiene sin hacer nada.
2. `BEGIN;`
3. Instala **temporalmente** las funciones de la etapa A (`..._a_rpc.sql`, sin su BEGIN/COMMIT).
4. Instala **temporalmente** el predicado y la política de la etapa B (`..._b_rls.sql`, sin su BEGIN/COMMIT).
5. Corre el QA SQL completo (`..._tests.sql`, secciones 0–4: 18 pruebas, con el fixture relacional sintético `qa_rel_*` y las pruebas de `p_uid_esperado`).
6. `ROLLBACK;` (no existe ningún `COMMIT` en el archivo).
7. Una última sentencia de **solo lectura** devuelve UNA fila con el veredicto y las comprobaciones de que no quedó nada.

La verificación final usa valores absolutos (el cuerpo previo del predicado exigido por la etapa B, los marcadores del fixture) y **no** objetos creados antes de la transacción: algunos clientes envían todo el script como una sola consulta y, entonces, esos objetos quedarían dentro de la misma transacción y el ROLLBACK los borraría.

## Antes de empezar (solo lectura)
1. Confirmar que el editor apunta a STAGING.
2. Ejecutar `..._checks.sql` consultas 1, 2 y 7 y guardar el resultado (políticas, predicado, funciones —deben ser 0 filas—, una sola fila de configuración).
3. Elegir un momento sin tráfico en STAGING: el DDL mantiene bloqueos sobre `cardiolink_atenciones` hasta el ROLLBACK (segundos).
4. Verificar que los tres SQL de origen no cambiaron desde la revisión: `sh docs/propuestas/pending_review_config_secretaria_v1_generar_ensayo.sh` debe regenerar el mismo archivo (`shasum` idéntico) y el test D8 debe pasar.

## Ejecución
1. Pegar el archivo completo y ejecutarlo **de una sola vez** (una sola solicitud). Preferible `psql -f` (muestra todos los resultados); el SQL Editor muestra solo el último.
2. Resultado esperado:
   - **Sin error** durante el script (cada prueba lanza una excepción `FALLA …` si no se cumple; terminar sin error = las 18 pruebas pasaron).
   - Con `psql` o un cliente que muestre todos los resultados: la consulta previa al ROLLBACK lista 18 filas, todas `OK`.
   - La última sentencia devuelve `veredicto = 'ENSAYO OK: las 18 pruebas terminaron sin error y no quedo nada persistido'`, con `funciones_del_bloque_restantes = 0`, `politica_restrictiva_restante = 0`, `politicas_con_predicado_v2 >= 4`, `predicado_igual_al_previo = true`, `fila_config_sin_marcas_del_fixture = 1` y las cuatro cifras `*_sinteticas_restantes = 0`.
3. Repetir `..._checks.sql` consultas 1, 2 y 7: deben dar exactamente lo guardado en el paso previo (huellas idénticas).

## Si algo falla
- **El script se detiene con `FALLA …`**: la transacción queda abortada; ejecutar `ROLLBACK;` (o cerrar la sesión). No se persistió nada. Corregir la causa y volver a empezar. Un error de sintaxis o del fixture es esperable la primera vez (los SQL nunca se validaron contra una base).
- **`veredicto = 'REVISAR…'`**: mirar las columnas. Si `funciones_del_bloque_restantes > 0` o `politica_restrictiva_restante > 0` o `predicado_igual_al_previo = false`, el cliente NO ejecutó el script como una única transacción (p. ej. una herramienta que corre cada sentencia en una conexión distinta con autocommit) y algo quedó aplicado: ejecutar de inmediato `..._b_rls_rollback.sql` y luego `..._a_rpc_rollback.sql`, y repetir el paso 3 de "Antes de empezar". Si hay filas sintéticas (`__t_*`, `qa_rel_*`) restantes, borrar **solo** esas filas por id sintético.
- Ningún camino toca los datos clínicos heredados: el ensayo reemplaza la fila de configuración **dentro de la transacción** y el ROLLBACK la restaura (la verificación comprueba que no queden las marcas del fixture).

## Límites (decirlo claro)
- No se pudo ejecutar ni validar ninguno de los SQL en una base; lo que hay son revisiones estáticas (tests D1–D8) y mutaciones que las detectan.
- Si el cliente confirma por su cuenta cada sentencia (autocommit entre sentencias), el `BEGIN` no agrupa nada. Por eso existe la verificación final y los rollbacks anteriores.
- Una transacción abortada por error no ejecuta la verificación final: hay que usar `ROLLBACK;` y revisar el mensaje.
- Los DDL (CREATE FUNCTION/POLICY, CREATE OR REPLACE FUNCTION del predicado) son transaccionales en PostgreSQL; las secuencias y el estado de otras sesiones no se ven afectados. Otras sesiones de STAGING pueden quedar esperando unos segundos por los bloqueos.

## Después
Solo si el veredicto es `ENSAYO OK` se plantea la aplicación real por etapas (A → cliente → B), con autorización explícita y sus propios rollbacks.
