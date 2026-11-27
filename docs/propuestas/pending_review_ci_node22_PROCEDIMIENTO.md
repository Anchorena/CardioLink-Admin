# CI permanente (GitHub Actions, Node 22) · cómo funciona, cómo tratar las 10 fallas históricas y cómo activarlo

Estado: **PR «solo CI» (PR-A) preparado.** El workflow se crea desde la web de GitHub: el token de la línea de comandos no tiene el permiso `workflow`, y GitHub rechaza subir archivos de workflow desde ahí.

## 1. Objetivo
Una barrera útil para futuras publicaciones: **ni permanentemente roja ni artificialmente verde**. Verde significa "no hay ninguna falla que no esté declarada y explicada"; rojo significa "hay una falla nueva o una falla que se intentó normalizar".

## 2. Qué corre
Con Node 22 y sin dependencias: `*.test.cjs` de la raíz (`node --test`) y `tests/*.js` (`node archivo`), vía `sh tests/ci-suites.sh run`. Sobre `main` son **50 suites**: **40 pasan y 10 fallan por expectativas obsoletas (clase A) ya documentadas (19 pruebas), 0 no registradas** (verificado con Node 22.23.5; con la rama de Gestión de usuarios son 53 suites, 43 sin fallas).
Se ejecuta en `pull_request` a `main` (compara contra la base), en `push` a `main` (solo la barrera de registro) y a pedido (`workflow_dispatch`). Sin secretos, red ni Supabase; permisos `contents: read`.

## 3. Las dos barreras
1. **`comparar` (PR vs base):** toda falla del PR que no existía en `main` hace fallar el CI.
2. **`verificar` (registro explícito `tests/fallas-conocidas.tsv`):** toda prueba que falle debe estar en el registro (suite, nombre exacto, clase, deuda, motivo). Evita la **normalización**: si una regresión llegara a `main`, el siguiente PR la vería como "preexistente" en `comparar`, pero `verificar` la sigue rechazando por no estar registrada.
Probadas localmente: corrida real → verde; falla nueva en suite sana → rojo; falla nueva dentro de una suite con fallas conocidas → rojo; suite que termina con error sin nombrar la prueba → rojo; falla registrada que ya pasa → **verde + aviso "RESUELTA: retirar del registro"**.

## 3b. Cómo se tratan las 10 fallas históricas (sin ocultarlas, sin desactivar, sin permitir nuevas)
- **No se desactiva ninguna prueba:** se ejecutan y se muestran en cada corrida (resumen del job y artefacto `registro.txt`).
- **Están registradas** (19 pruebas en 10 suites, clase A) con su deuda técnica (`DT-01` a `DT-09`, en `pending_review_deuda_tecnica_independiente.md`).
- **El registro solo puede achicarse con una decisión:** cuando alguien corrige una, el CI avisa "RESUELTA" y esa línea se retira en el mismo PR. **Agregar** una línea exige un PR con justificación; nunca para "poner en verde" una regresión.
- **Límite conocido (honesto):** algunas suites (`portal-frontend`, `portal-gateway-logica`, `pacientes-backfill-sync`, `solicitudes-turno-presentacion`) **abortan en la primera falla**; una falla nueva *posterior* en la misma suite quedaría oculta tras la histórica hasta que esa se corrija. Por eso esas cuatro tienen prioridad en la deuda técnica.
- **Sin gatillo de "rojo permanente":** hoy el CI sale verde porque las 19 fallas están declaradas; se pone rojo solo si aparece algo nuevo o normalizado.

## 4. Activación (sin commit ni push desde acá)
Orden recomendado para evitar el problema del permiso:
1. Subir el PR normal (con el token actual) con: `tests/ci-suites.sh` (modo `verificar`), `tests/fallas-conocidas.tsv`, la corrección de 3 líneas de `tests/config-v1a-presentacion.js` y este procedimiento. **No** incluir el workflow (el archivo `docs/propuestas/pruebas-node22.workflow.yml` es solo la copia a pegar en la web). Las referencias `DT-xx` del registro se explican en `pending_review_deuda_tecnica_independiente.md`, que viaja con el PR de Gestión de usuarios.
2. **Crear el workflow desde la web de GitHub** (ahí no hace falta el permiso `workflow`):
   1. Entrar a `https://github.com/Anchorena/CardioLink-Admin`.
   2. Cambiar a la rama del PR (selector de ramas) — o a `main` una vez fusionado.
   3. **Add file → Create new file**.
   4. En el nombre escribir exactamente: `.github/workflows/pruebas-node22.yml` (al escribir las `/` GitHub crea las carpetas).
   5. **Pegar el contenido completo de `docs/propuestas/pruebas-node22.workflow.yml`** (es el archivo ya validado: un job, disparadores `pull_request`, `push` a `main` y `workflow_dispatch`, permisos `contents: read`).
   6. **Commit changes** (sobre la rama del PR o con PR propio).
3. En la pestaña **Actions → Pruebas (Node 22) → Run workflow** correr una vez en `main` para tener la línea base; debe salir verde con el resumen "Fallas conocidas activas: 19 de 19".
4. (Opcional, recomendado) En **Settings → Branches → Branch protection rules** de `main`, marcar el job "Pruebas (Node 22)" como check requerido.

## 5. Mantenimiento
- Al corregir una suite histórica: quitar sus líneas de `tests/fallas-conocidas.tsv` en el mismo PR (el CI lo indica).
- Al cambiar versiones de `app.js`/caché: actualizar los pines de las pruebas correspondientes en el mismo PR (hoy son 4 pruebas; está en la deuda técnica desacoplarlas).
- Si el CI se pone rojo por una prueba nueva legítima que debe fallar un tiempo: no se registra; se corrige o se revierte.
