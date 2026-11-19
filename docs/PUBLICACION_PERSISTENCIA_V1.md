# Publicación de Persistencia V1 (PR #31) — procedimiento, límites y rollback

Estado: desarrollo funcional cerrado. Este documento es el único lugar operativo de la publicación; el detalle técnico y los QA están en `docs/QA.md`.

## 1. Estado del PR #31 (verificado el 2026-11-19)

| Punto | Resultado |
|---|---|
| Base / cabeza | `main` (`e0052fa…`) ← `fix/persistencia-datos-v1-r4` (`3185432…`) |
| Contenido | 11 commits, 27 archivos, +5798 / −233 |
| Conflictos | Ninguno: `main` es ancestro directo de la cabeza (avance rápido); `git merge-tree` sin conflictos. La API de GitHub devuelve `mergeable: unknown` mientras el PR sea borrador. |
| Checks | Un único check: Cloudflare Pages (vista previa) = success. El repositorio no tiene workflows de CI. Las pruebas se corren a mano (`docs/QA.md`). |
| SQL / base de datos | 0 archivos `.sql` ni de `supabase/` en el diff. No hay nada que aplicar ni revertir en la base. |
| Estado | Borrador: hay que marcarlo «Ready for review» antes de mergear. |

Antes del merge: marcar «Ready for review», mergear con **commit de merge (no squash ni rebase)** para poder revertirlo de una sola vez, y cerrar sin mergear los PR dependientes anteriores (R2B…R3).

## 2. Qué se pierde y qué no al publicar (para los equipos actuales)

Los equipos actuales guardan datos en el navegador con las claves antiguas. La versión nueva usa claves por proyecto y usuario (`<base>:<proyecto>:<uid>`). **La migración se hace sola, por usuario, la primera vez que ese usuario ingresa con su contraseña**, y solo mueve lo que se puede atribuir con certeza a ese usuario. No borra nada.

## 3. Procedimiento para sanear los datos locales heredados (sin perder pendientes)

Responsable: el Dueño/Admin con ayuda de quien use cada equipo. Duración: unos minutos por equipo.

**Antes de publicar (día anterior)**
1. En cada equipo, cada usuario cierra sesión normalmente y confirma que no tiene aviso de «cambios pendientes de sincronización». Si lo tiene, conectarse y esperar a que se sincronice.
2. No usar «borrar datos del sitio», modo incógnito ni desinstalar la aplicación instalada: borrarían pendientes.
3. Anotar los aranceles y copagos por profesional (Configuración): si hubiera que revertir, el código anterior puede reponer valores por defecto sobre valores en cero (ver §6).
4. Opcional, solo lectura: en cada equipo, consola del navegador → pegar el **inventario** (§3.1) y anotar los números. No muestra contenido.

**Día de la publicación (en este orden)**
5. El Dueño abre la aplicación y recarga una vez para que se instale la versión nueva (`app.js?v=40128-seguridad-local`).
6. El Dueño ingresa **escribiendo su contraseña** (no con una sesión que ya estaba abierta: en equipos compartidos la sesión abierta pide la contraseña al reabrir). Se migra solo lo suyo.
7. Abrir «Datos de este equipo» (enlace bajo «Cerrar sesión»). Verificar que «Equipo compartido» esté tildado en los equipos que usa más de una persona. Destildarlo solo en un equipo exclusivamente personal (queda sin cifrar al cerrar).
8. Datos **sin dueño verificable**: si el cuadro de «Datos de este equipo» los muestra, elegir **«Sellar en mi custodia»** (se cifran con la contraseña del que decide; con «Ver» se revisan; ningún dato se descarta solo). Descartar únicamente si se confirmó que son basura (mensajes viejos no enviados, valores rechazados ya resueltos).
9. Cada usuario restante ingresa **una vez**, con su contraseña, en cada equipo que usó. Con eso sus datos heredados pasan a su clave nueva y quedan protegidos al cerrar. No hace falta hacer nada más.
10. Datos de **usuarios que ya no ingresan** (aparecen como «Heredados de OTROS usuarios en claro»): un owner/admin puede usar **«Sellar heredados de otros en mi custodia»**. No se descartan; con «Devolver» vuelven a su lugar si su dueño aparece.
11. **Caso Geraldine (Secretaría, resguardo atascado en Production):** que ingrese con su contraseña. La app mostrará el aviso de configuración sin sincronizar. **Antes de «Descartar copia»**, abrir «Datos de este equipo» y confirmar que el resguardo es lo único pendiente (no hay otros cambios sin sincronizar). Solo entonces descartar y rehacer su edición de la fecha de nacimiento (ya no se rechaza). Si hay otros pendientes, usar «Reintentar» y esperar.
12. Repetir el **inventario** (§3.1): deben quedar sin claves heredadas los usuarios que ya ingresaron. Las que queden pertenecen a quien aún no ingresó: avisarle.

**Qué no hacer**: borrar datos del sitio; cambiar la contraseña de un usuario que dejó cambios sellados sin entrar antes con la contraseña vieja (el paquete no se abrirá; quedará descartable); cerrar el navegador con la sesión abierta en un equipo compartido (ver §4).

### 3.1 Inventario (solo lectura; no muestra contenido)

Pegar en la consola del navegador del equipo:

```js
(function () {
  const claves = Object.keys(localStorage), tam = (k) => (localStorage.getItem(k) || '').length;
  const cat = { heredadasPorUsuario: [], globales: [], apartadas: [], nuevas: [], colaR2D: [], otras: 0 };
  claves.forEach((k) => {
    if (/^cardiolink_(docs_pendientes_v1|nuevas_pendientes_v1|config_pendiente_v1|config_conflicto_v1)_/.test(k)) cat.heredadasPorUsuario.push([k.replace(/^(.*)_(.{6}).*$/, '$1_…'), tam(k)]);
    else if (/^cardiolink_(atenciones_rechazos_v1|atenciones_eliminadas_remotas_v1|mensajes_no_enviados_v1)$/.test(k)) cat.globales.push([k, tam(k)]);
    else if (/^cardiolink_apartado_/.test(k)) cat.apartadas.push([k.slice(0, 40) + '…', tam(k)]);
    else if (/^cardiolink_(docs_pendientes_v1|nuevas_pendientes_v1|config_pendiente_v1|config_conflicto_v1|atenciones_rechazos_v1|atenciones_eliminadas_remotas_v1|mensajes_no_enviados_v1):/.test(k)) cat.nuevas.push([k.slice(0, 50) + '…', tam(k)]);
    else if (/^cardiolink_outbox_r2d_v1:/.test(k)) cat.colaR2D.push([k.slice(0, 50) + '…', tam(k)]);
    else cat.otras++;
  });
  console.table(cat.heredadasPorUsuario); console.table(cat.globales); console.table(cat.apartadas); console.log('Claves nuevas:', cat.nuevas.length, '· colas R2D:', cat.colaR2D.length, '· otras:', cat.otras);
})();
```

Lectura: «heredadasPorUsuario», «globales» y «apartadas» son lo que hay que sanear (se mide en caracteres, no en registros). «nuevas» y «colaR2D» solo existen tras publicar.

## 4. Límites de confidencialidad (decisión registrada)

**El modo «Equipo compartido» NO garantiza confidencialidad ante un cierre accidental del navegador.** Si el navegador se cierra o se cae con la sesión abierta, los datos locales (caché de atenciones y configuración, cola de cambios) y el token de sesión quedan **sin cifrar** en el navegador hasta que alguien vuelva a abrir la aplicación. Al reabrirla, la aplicación pide la contraseña (bloqueo de pantalla), pero ese bloqueo **no es protección criptográfica**: quien lea el almacenamiento con las herramientas del navegador los ve. Tampoco protege contra malware ni contra quien ya tiene la sesión abierta.

Lo que el modo compartido sí garantiza: al **cerrar sesión** (manual o por inactividad) con cambios sin sincronizar, se cifran con la contraseña del usuario (AES-GCM-256, clave derivada con PBKDF2, nunca guardada) o se descartan por decisión explícita; no quedan datos legibles tras un cierre normal. Los datos heredados de versiones anteriores siguen en claro hasta que su dueño ingrese o un owner/admin los ponga en custodia (§3). Esta limitación debe comunicarse a los usuarios del consultorio.

## 5. Etapa futura registrada: Seguridad local V2 (no iniciada)

Alcance a evaluar, con diseño y QA propios, después de estabilizar V1:
1. **Cifrado desde la escritura:** capa transparente de almacenamiento cifrado para cola y cachés (clave derivada de la contraseña o WebAuthn/PRF, espejo en memoria, persistencia asíncrona con verificación). Elimina el hueco del cierre accidental. Obliga a revisar R2D (que hoy verifica la escritura de forma síncrona).
2. **Recuperación de imágenes y demás cambios de configuración que no viajan en la cola:** incluirlos en el paquete y en la recuperación con resolución de conflictos (hoy se avisa y el paquete cifrado se conserva).
3. **Protección de sesiones:** no persistir el token de sesión en `localStorage`, vencimiento por inactividad del lado del servidor, bloqueo criptográfico (no solo de pantalla) y cierre remoto.
4. Datos heredados de usuarios que ya no ingresan (retiro definitivo con auditoría) y reducción de lo que guarda la caché completa.
Fuera de alcance de V1 y de esta publicación.

## 6. Rollback

**Hash anterior:** `e0052faed27907ab842120be2a7e554d1267d709` (`main` antes del merge).

**Procedimiento preferido (no destructivo):**
1. Antes de revertir: que cada usuario con cambios sin sincronizar ingrese con su contraseña y los sincronice (abre sus paquetes sellados y vacía la cola). Si no es posible, seguir igual: nada se pierde (ver límites).
2. `git revert -m 1 <hash del commit de merge del PR #31>` y push a `main` (GitHub Pages republica el código anterior en un commit).
3. Recarga forzada en cada equipo; el service worker se actualiza solo (`sw.js` cambia).
4. Si hubo equipos con claves migradas y se necesita que el código anterior las vea: ejecutar la **reversión de claves** (§6.1) en ese equipo, con la sesión cerrada o abierta, antes de volver a usar la app.

**Emergencia (destructivo, solo con autorización explícita):** `git push --force-with-lease origin e0052faed27907ab842120be2a7e554d1267d709:main`.

**Limitaciones tras el rollback (las colas migradas y los paquetes sellados):**
- Las colas migradas (`<base>:<proyecto>:<uid>`: documentos sin respaldo, atenciones nuevas, configuración de Secretaría pendiente o en conflicto, rechazos, eliminadas, mensajes) **no las lee el código anterior**: no se pierden pero parecerían desaparecidas hasta ejecutar la reversión de claves (§6.1) o republicar.
- La cola de recuperación R2D (`cardiolink_outbox_r2d_v1:…`) no existe en `main`: el código anterior no la lee. Sus cambios solo se recuperan al volver a publicar. Por eso conviene sincronizar antes de revertir (paso 1).
- Los **paquetes sellados** (IndexedDB `cardiolink_sellado_v1`) y las custodias solo las abre la versión nueva y con la misma contraseña. El código anterior las ignora; no se pierden. Si hace falta revertir por tiempo prolongado, cada usuario debe abrirlos antes (paso 1) o aceptar que esperan hasta republicar. Una contraseña cambiada entretanto los vuelve inabribles (descartables).
- Los datos escritos al servidor por la versión nueva (fichas de pacientes en `cardiolink_pacientes`, configuración con aranceles/copagos en cero) quedan; **el código anterior normaliza la configuración en cada carga y puede reponer valores por defecto sobre aranceles/copagos en cero o vacíos**: por eso se anotan antes de publicar (§3, punto 3).
- Los marcadores de sincronización de fichas, el estado de cierre y la bandera de equipo compartido son inofensivos para el código anterior.
- Sin cambios en la base: no hay nada que revertir del lado del servidor.

### 6.1 Reversión de claves (copia, no borra; ejecutar en la consola del equipo)

```js
(function () {
  const bases = ['cardiolink_docs_pendientes_v1', 'cardiolink_nuevas_pendientes_v1', 'cardiolink_config_pendiente_v1', 'cardiolink_config_conflicto_v1'];
  const informe = { copiadas: [], yaExistian: [], listas: [] };
  Object.keys(localStorage).forEach((k) => {
    const b = bases.find((x) => k.indexOf(x + ':') === 0); if (!b) return;
    const uid = k.split(':').slice(2).join(':'); if (!uid) return;
    const destino = b + '_' + uid;
    if (localStorage.getItem(destino) === null) { localStorage.setItem(destino, localStorage.getItem(k)); informe.copiadas.push(destino.replace(/(.{40}).*/, '$1…')); }
    else informe.yaExistian.push(destino.replace(/(.{40}).*/, '$1…'));
  });
  ['cardiolink_atenciones_rechazos_v1', 'cardiolink_atenciones_eliminadas_remotas_v1', 'cardiolink_mensajes_no_enviados_v1'].forEach((g) => {
    let global = []; try { global = JSON.parse(localStorage.getItem(g) || '[]'); } catch (e) { global = []; } if (!Array.isArray(global)) global = [];
    const vistos = new Set(global.map((x) => JSON.stringify(x))); let n = 0;
    Object.keys(localStorage).forEach((k) => { if (k.indexOf(g + ':') !== 0) return; try { JSON.parse(localStorage.getItem(k)).forEach((x) => { const s = JSON.stringify(x); if (!vistos.has(s)) { vistos.add(s); global.push(x); n++; } }); } catch (e) { /* ilegible: no se toca */ } });
    if (n) { localStorage.setItem(g, JSON.stringify(global)); informe.listas.push([g, n]); }
  });
  console.log('Reversión de claves (no se borró nada):', informe);
})();
```

Después de la reversión, las claves nuevas siguen ahí (para republicar). Los datos de `docs`/`nuevas`/`config pendiente` vuelven a verse en el código anterior bajo su clave heredada.

## 7. Resumen de verificaciones previas al merge

- Pruebas: seguridad local 36/36, config de Secretaría 62/62, resto de las suites aprobadas; `cardiolink-sync-medico-guards` mantiene 6 fijaciones estáticas que ya fallaban antes de la serie.
- QA en STAGING con Secretaría, Médico y Dueño reales (el Dueño equivale a Admin: ambos usan `cardiolink_es_admin_u_owner`). Guard v4.2.1 verificado en Production (solo lectura) y regla de PAMI verificada (`COBERTURA_COBRA_PARTICULAR`).
- Deuda registrada sin iniciar: idempotencia de `resolverPendiente383`; Convenios V2 no implementado; Seguridad local V2 (§5).
