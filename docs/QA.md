# CardioLink Admin — QA mínima antes de producción

Última actualización: 2026-08-15

## Regla
No considerar estable un cambio solo porque “abre”.
Probar persistencia, permisos y navegación.

## 1. Sintaxis
Para cada `.js` modificado:
- ejecutar `node --check archivo.js`.

## 2. Login / sesión
- iniciar sesión;
- confirmar usuario/rol visible;
- verificar que no aparezca falso aviso de sesión vencida.

## 3. Supabase / persistencia
Crear UN dato de prueba:
- paciente o atención;
- esperar sincronización;
- cerrar sesión;
- volver a entrar;
- confirmar que sigue existiendo.

Si el cambio toca HC:
- crear evolución;
- cerrar/reabrir;
- confirmar persistencia.

## 4. Roles
### Secretaría
- crear y editar la ficha administrativa del paciente;
- confirmar que HC, RCTA y Certificado están bloqueados;
- confirmar que Constancia administrativa está disponible;
- gestionar prestaciones por profesional, obras sociales/prepagas, convenios,
  aranceles, valores particulares y copagos;
- confirmar que importar/restaurar backup está disponible;
- confirmar que exportar un backup completo sensible y ejecutar borrado global
  están bloqueados;
- confirmar que Caja, producción financiera, sueldo, liquidaciones y
  usuarios/roles están bloqueados.

### Médico
- confirmar acceso a pacientes, HC, evoluciones, RCTA y documentos clínicos;
- confirmar que no obtiene permisos administrativos o comerciales adicionales.

### Dueño / Administrador
- confirmar acceso completo a administración, configuración, usuarios/roles,
  finanzas, Caja, HC, documentos, reportes, backups y mantenimiento.

### Roles personalizados
- probar al menos un rol basado en `admin`, uno en `medico` y uno en
  `secretaria`;
- confirmar que cada uno hereda capacidades y restricciones de su `baseRole`.

## 5. Navegación
Recorrer:
- Dashboard
- Carga
- Agenda
- Pacientes
- HC (solo con un rol permitido)
- Pendientes
- Caja (solo con un rol permitido)
- Estadísticas
- Configuración

## 6. Paciente actual
Con Médico o Dueño/Administrador:
- seleccionar paciente;
- abrir HC;
- evolucionar;
- usar Acciones;
- cerrar paciente;
- seleccionar otro;
- confirmar que no reaparece el anterior.

## 7. Finanzas
Si se toca Caja:
- particular;
- copago;
- OS/prepaga;
- sueldo Secretaría;
- colocaciones;
- filtro por período;
- perfil correcto.

Si se toca Pendientes de cobro:
- atención histórica (sin estado de cobro): su importe no cambia en Caja;
- atención nueva con "Cobro pendiente": 0 en Caja del día, Listado y Finanzas;
- confirmar con Secretaría: entra una sola vez, en la caja del profesional
  correcto y con el medio elegido (fecha/usuario/medio quedan registrados);
- doble clic y segunda sesión confirmando lo mismo: no se duplica;
- Médico: ve solo los pendientes de su caja y no puede confirmar;
- Secretaría: confirma sin ver totales de Caja.
- Secretaría asociada al profesional confirma; no asociada no confirma (mensaje de falta de autorización) pero sigue operando Agenda/Sala/Carga;
- si cambia la caja (profesional) o el importe mientras se ve el cobro: no confirma y pide volver a confirmar;
- cobro "No cobrar" y cobro pendiente de bono/firma siguen diferenciados del pendiente de pago;
- procedimiento completo de STAGING: `docs/PENDIENTES_COBRO_V1_QA_STAGING.md`.

## 8. Prestaciones
Si se toca configuración:
- cambiar profesional;
- confirmar que cambia la lista de prestaciones;
- destildar/tildar;
- confirmar que no borra historial.

## 9. PWA / caché
Si se cambia `index.html`, `sw.js` o módulos:
- probar recarga forzada;
- confirmar versión publicada;
- revisar que el Service Worker no sirva código viejo.

## 10. Responsive
Probar al menos:
- desktop;
- ancho tipo iPad;
- ancho tipo teléfono si el cambio es visual.

## 11. Copias para facturación (si se toca el módulo)
Con Secretaría asociada, Médico y Dueño/Administrador:
- subir un PDF desde una atención de Holter/MAPA/Eco: se vinculan solos los datos
  y la atención muestra «Copia de facturación subida»;
- subir desde la sección sin atención;
- filtros (mes, profesional, obra social, estado), descargar, imprimir, marcar
  impreso, reimprimir y eliminar con confirmación;
- Secretaría no ve copias de médicos no asociados; al desactivar la asociación
  pierde el acceso; Médico sólo las suyas;
- eliminar una copia no toca el informe clínico ni documentos de HC; el paciente
  no ve nada en el portal.
Suite estática: `node tests/copias-facturacion-v1.js`.

## 12. Persistencia y sincronización entre sesiones (si se toca guardado, refresco o carga)
Antecedente confirmado (Persistencia V1, 2026-11): el refresco automático (cada 30 s) pide TODA la tabla y, al responder,
reemplazaba `data` y `atenciones` por esa foto aunque fuera anterior a un cambio local hecho mientras la respuesta estaba en
vuelo. Cambios perdidos sin aviso: fecha de nacimiento, pendientes resueltos, aranceles. Además, un guardado pedido mientras
`cargandoDesdeNube` estaba activo se descartaba, y una fila nueva podía desaparecer. Con dos sesiones, la config de
Dueño/Admin se escribe con upsert ciego (sin versión) y puede pisar cambios de otra sesión (R2, pendiente); las atenciones
tienen guardado condicionado por versión y, ante conflicto, gana el remoto con un aviso breve.

Causas identificadas (ver informe de diagnóstico):
- R1 refresco que pisa cambios locales (corregido en la rama `fix/persistencia-datos-v1-r1`, pendiente de validar en STAGING);
- R2 config de Dueño/Admin sin control de concurrencia (pendiente);
- R3 «Editar ficha» desde HC (Médico) no persiste en servidor (pendiente);
- R4 `normalizarConfigCritica` pisa reglas/valores/obras sociales editados y `regla` se lee de dos fuentes (pendiente).

QA dirigido de R1 (editar → guardar → verificar remoto → recargar → verificar; segunda sesión cuando corresponda):
1. fecha de nacimiento: guardar la ficha mientras un refresco está en vuelo → persiste en el servidor y tras recargar, sin aviso de error;
2. pendiente: resolverlo (a) antes y (b) después de los 700 ms del guardado, con un refresco en vuelo → sigue resuelto tras recargar;
3. arancel: editarlo/guardarlo durante un refresco → queda en remoto y local;
4. refresco normal: un cambio hecho por otra sesión se refleja en la sesión inactiva;
5. guardado pedido durante una carga: no se descarta (se reprograma al terminar); fila nueva creada durante un refresco no desaparece;
6. guardado de configuración que falla: la config local NO se reemplaza por la remota (sin límite de tiempo), aparece de inmediato el aviso de cambios sin guardar y, al recuperarse el servidor, se guarda y el aviso desaparece;
6b. cambio real en memoria todavía sin `saveConfig()` (p. ej. mientras se espera una respuesta antes de guardar) y un refresco con otra clave cambiada por otra sesión: se conservan las claves con cambios locales (y se guardan), el resto se toma del servidor; si no hay cambios locales el refresco se aplica entero. Sin cambios reales, `window.cardiolinkPersistenciaR1.estado().mezcladas` debe quedar vacío (las normalizaciones/inicializaciones no cuentan);
7. fila con cambios locales + cambio remoto real de otra sesión: el guardado condicionado detecta el conflicto (R1/R2A/R2B: gana el remoto, con aviso; desde R2C se fusiona por grupos y los choques reales se resuelven con aviso persistente, ver más abajo);
8. Médico: resolver un pendiente (RPC) durante un refresco → sigue resuelto;
9. editar una fila mientras su propio guardado está en vuelo (o resolver un pendiente justo después de editar la ficha del paciente): la segunda edición se sube en el ciclo siguiente (la base de contenido es lo ENVIADO, no lo que haya tras el await).
Nota de método: esperar a que termine el guardado de arranque antes de cada caso (`!syncPendienteSinConfirmar && !syncAtencionesEnCurso`); dos refrescos seguidos sin pausa no son un caso real (el segundo se omite mientras hay un guardado sin confirmar).
R2A (reescritura masiva al iniciar sesión; corregida): con filas corruptas en el servidor la primera carga ya no reescribe las atenciones. Verificar: (1) login con filas corruptas → 0 PATCH condicionados (`performance.getEntriesByType('resource')` con `updated_at=eq`) y ningún `updated_at` cambia; (2) login sin corruptas → comportamiento normal; (3) Dueño inicia sesión mientras Secretaría resuelve un pendiente → persiste en remoto y tras recargar; (4) una modificación legítima posterior al login produce exactamente 1 PATCH y sólo cambia la versión de esa fila; (5) un cambio local pendiente seguido de un refresco con filas corruptas no se adopta como base confirmada y se guarda. Test estático: `node --test cardiolink-persistencia-r2a.test.cjs`.
Hallazgos fuera de R1 (el primero corregido por R2A): (a) con filas corruptas en el servidor, la primera carga de cada sesión llama a `sincronizarAtencionesSupabase(false)` ANTES de fijar la base de contenido y reescribe TODAS las atenciones (en STAGING ≈ 70 PATCH por inicio de sesión, subiendo `updated_at` de todas): otra sesión con edición en curso choca con el guardado condicionado y pierde su cambio; (b) la config de Dueño/Admin y las RPC de Secretaría pueden pisarse entre sí (última escritura gana por clave).
Arnés local reproducible (app real + Supabase simulado en memoria, sin credenciales): resultados R1 en el informe de la tarea.

### R2B · Concurrencia de configuración (motor de fusión + integración)
Config de Dueño/Admin: ya no hay upsert ciego. Guardado = (1) sin cambios reales respecto de la base cargada → no se escribe; (2) se relee la fila y se fusiona base/local/remoto por entidad y campo (`cardiolink-config-merge-v1.js`); (3) sin conflictos → UPDATE condicionado por `updated_at` (0 filas = otra sesión escribió: se relee y fusiona, máx. 3 veces; si la versión de la fila no cambió es un rechazo de permisos); (4) con conflictos reales NO se escribe y aparece un aviso persistente (mi valor / valor del servidor / cancelar y resolver más tarde) que resuelve sólo los campos en conflicto y relee el servidor antes de confirmar. Secretaría: ante conflicto de la RPC relee la vista, fusiona sólo las claves autorizadas y reintenta; sus choques reales usan el mismo aviso.
Pruebas automatizadas: `node --test cardiolink-config-merge-v1.test.cjs` (48, incluye 300 casos deterministas) y las suites existentes.
QA dirigido (editar → guardar → verificar remoto → recargar → verificar; segunda sesión):
1. Dueño modifica un arancel y Secretaría un paciente; 2. dos sesiones modifican pacientes distintos; 3. campos distintos del mismo paciente; 4. aranceles distintos; 5. el mismo arancel y campo → conflicto (nada se escribe); 6. resolver «mi valor» (se conservan los cambios independientes); 7. resolver «valor del servidor»; 8. «cancelar» deja la insignia y conserva lo local; 9. eliminación frente a modificación (la entidad eliminada no se resucita); 10. login sin cambios → 0 escrituras de config (la versión de la fila no cambia); 11. fallo de conexión: lo local se conserva, aviso, y al volver se guarda; 12. edición durante un guardado en vuelo → se conserva y se guarda después; 13. Secretaría no modifica claves fuera de su lista; 14. R2A: 0 PATCH de atenciones al iniciar sesión.
Registrado para R4 (normalización): `normalizarConfigCritica` pisa en cada carga reglas/valores/obras sociales que el usuario edita. El motor la neutraliza con `opciones.neutro` (= normalizar(base)), pero un cambio EXPLÍCITO del usuario que coincida con el valor que impone la normalización es indistinguible de ella y no cuenta como cambio. El motor ya acepta `opciones.protegidos` (rutas editadas explícitamente, p. ej. `reglasOS.IOMA`, que nunca se neutralizan; hay prueba unitaria) pero ningún editor las marca todavía: R4 debe (a) marcar esas rutas desde `setRegla`, los formularios de valores y de convenios, y (b) eliminar la normalización destructiva para que el neutro deje de hacer falta.
Semilla de `horariosProfesionales.matias` (agenda-v1): NO se persiste por un guardado ajeno. `cardiolinkAgendaSemillaV1()` (sólo lectura) informa si es la semilla en memoria; el motor y el guardado de Secretaría la excluyen y la reponen (misma referencia) si `data` se reemplaza. «Guardar horarios» reemplaza el objeto y se persiste normalmente.
Sin el módulo de concurrencia: `guardarConfigEnSupabase298` no escribe (ni upsert ciego de respaldo): conserva los cambios pendientes y muestra un aviso persistente.
**QA OBLIGATORIO PENDIENTE ANTES DE PRODUCCIÓN — rol Admin.** El QA de R2B en STAGING se hizo con Dueño (`role=owner`), Secretaría y, en R2A, Médico; NO hay sesión Admin QA. El código autoriza a owner y admin por igual (`configCompletaPermitidaV1` = `backendEsAdminOwner`), pero NO se asume que Admin equivale a Dueño. Con una cuenta Admin real verificar: (1) login sin cambios → 0 escrituras de config y 0 PATCH de atenciones; (2) guardado con UPDATE condicionado (permiso real de UPDATE sobre la fila de configuración, distinguido de un conflicto); (3) conflicto contra Dueño y contra Secretaría con las tres salidas (mi valor / valor del servidor / cancelar); (4) fusión de cambios independientes con otra sesión; (5) reintento ante concurrencia; (6) la insignia y el aviso de módulo ausente. Hasta no cerrar este punto, R2B no se publica en Production.
Límites conocidos: con una config todavía no convergida, dos sesiones nuevas que inicializan los mismos valores por defecto pueden dar conflicto de identidad (se resuelve una sola vez); `normalizarConfigCritica` sigue sin corregirse (R4): el motor recibe `neutro` para no tratar la normalización como cambio del usuario y `protegidos` para rutas explícitas (todavía sin conectar a los editores).

### R2C · Concurrencia de atenciones individuales y Pendientes
Antes (R1–R2B): ante un UPDATE condicionado con 0 filas se releía la fila y **ganaba siempre el remoto** (los cambios locales se descartaban con un toast); un error en una atención cortaba el guardado de las demás (`return false`); una atención con cambios locales que otra sesión eliminó se quitaba en el refresco.
Ahora (módulos `cardiolink-atenciones-merge-v1.js` + `cardiolink-atenciones-concurrencia-v1.js`, sin SQL, reutilizando el motor y el panel de R2B): base (contenido cargado/confirmado) / local / remoto → fusión **por grupos** → UPDATE condicionado a `updated_at` (máx. 3 reintentos) → se confirma con el `updated_at` devuelto por el servidor. Una fila existente nunca se recrea con upsert.
Reglas (decisiones R2C):
- **Cobro (guard v4.2.1)**: la confirmación (`cobroConfirmado*`, `cobroMedioPago`) es siempre la del remoto; la fusión genérica nunca confirma ni altera un cobro (eso es del camino especializado de `cardiolink-cobros-v1.js`, que conserva su propia lectura fresca + CAS). Con cobro confirmado (`cobroConfirmadoPorRol`, criterio del guard) el grupo económico (importes, forma de pago, caja, `estadoCobro`, auditoría) está congelado: se conserva el remoto, el cambio local se **informa** y se guarda como respaldo (sólo los campos rechazados). «Conservar mi valor» no puede saltarse el guard. Cobro pendiente/sin cobro: el grupo económico es **indivisible** (un lado → ese lado completo; los dos distinto → un solo conflicto; nunca se combinan valores de lados distintos).
- **Estado**: grupo indivisible. Estados incompatibles → conflicto explícito (no se resuelve por fecha de edición). La cancelación del paciente ya confirmada no se revierte (ni con «mi valor»): se informa. Con cobro confirmado, un rol no administrador no puede cancelar/ausentar.
- **Identidad/pertenencia** (paciente, profesional, id, tipo) → conflicto explícito si el local la cambió; el Médico sólo puede elegir el valor del servidor. **Agenda** (fecha/horarios): un lado → ese lado; dos lados distintos → conflicto.
- **Pendientes**: cada uno es un grupo; el resuelto por otra sesión no se reabre desde una copia desactualizada; si ambos lo resolvieron (p. ej. impreso y enviado) se unen; `auditoriaPendientes` se agrega sin duplicar. Las RPC del Médico (`cardiolink_pendiente_mutar_v1`) no cambian.
- **Sellos** (`editadoPor/Usuario/Rol/En`): no generan conflictos; se toma la unidad completa del lado más reciente (nunca se mezclan usuarios) y, si hubo cambios de ambos lados, queda una entrada `auditoriaConcurrencia` (fecha, usuario que guarda, nombres de campos de cada lado; sin valores).
- **Eliminación vs modificación**: no se recrea. La atención sale de la agenda local, queda un aviso persistente y una copia local (clave `cardiolink_atenciones_eliminadas_remotas_v1`) para decidir: «restaurar mi versión» (se vuelve a crear como atención nueva, sujeto a RLS/guard) o «aceptar la eliminación» (los cambios quedan como respaldo en `cardiolink_atenciones_rechazos_v1`).
- **Aislamiento del lote**: un error en una atención no impide guardar las demás. Rechazos de permisos/guard (42501) → la fila queda retenida SIN reintento infinito (se reintenta recién cuando se edita de nuevo); errores transitorios → quedan pendientes y se reintentan en el ciclo siguiente.
- **Refresco**: una fila con cambios locales que el servidor ya no tiene se conserva (antes se descartaba) y sigue el camino de eliminación vs modificación.
- **Sin el módulo**: `app.js` retiene la fila en conflicto, no la envía, no adopta la remota ni descarta lo local y avisa (nunca vuelve al descarte silencioso).
Pruebas automatizadas: `node --test cardiolink-atenciones-merge-v1.test.cjs` (25), `cardiolink-atenciones-concurrencia-v1.test.cjs` (12, con Supabase simulado) y las suites existentes (census de accesos a `cardiolink_atenciones` en `tests/config-secretaria-v1.js` C4).
QA dirigido en STAGING (14 casos): 1 campos independientes; 2 pendientes distintos; 3 mismo campo; 4 estados incompatibles; 5 cancelación del paciente remota; 6 cobro confirmado vs edición económica; 7 corrección legítima de cobro pendiente; 8 confirmación de cobro simultánea; 9 eliminación vs modificación; 10 Copias para facturación y cierre de pendiente; 11 Médico por RPC; 12 error en una fila sin bloquear las demás; 13 edición durante un guardado en vuelo; 14 resolución de conflictos y relectura remota. Resultado (2026-11-17, STAGING, Dueño + Médico + Secretaría, filas sintéticas `qa_r2c_*`, ya borradas): los 14 casos PASS. Con el guard v4.2.1 real: un alta que falsifica una confirmación y un cambio económico de un Médico sobre un cobro confirmado se rechazan (42501), la fila queda retenida sin reintento infinito y las demás se guardan; una Secretaría que intenta pasar un cobro a «cobrado» por edición genérica no lo logra (se rechaza en el cliente y el servidor queda intacto). Hallazgos previos a R2C: `resolverPendiente383` llamado dos veces duplica la auditoría (la ruta de Copias es idempotente); una atención nueva sin teléfono/obra social se descarta por `esAtencionCorrupta` al sincronizar. **TAREA REGISTRADA (no iniciada): corrección puntual de `resolverPendiente383`** — llamado dos veces sobre el mismo pendiente agrega dos entradas idénticas a `auditoriaPendientes` (la ruta de Copias es idempotente porque comprueba antes `pendientesDeAtencion383(a).includes('copia')`). Corregir con una guarda de idempotencia en la propia función, sin tocar `applyNA383`. Método: al cambiar un módulo, subir su `?v=` en `index.html` (un reload usó la versión cacheada).
Límite conocido: las retenciones (conflicto/rechazo) viven en memoria; tras recargar la página la fila vuelve a salir del servidor y la edición no guardada se pierde (salvo el respaldo de campos rechazados y de eliminaciones remotas). La protección ante recarga es R2D.
**DISCREPANCIA A VERIFICAR (no modificar Production):** `docs/PENDIENTES_COBRO_V1.md` dice que el guard v4.2.1 «NO está instalado en Production», pero nuestros registros anteriores de la tarea indican que ya se aplicó allí. Antes de cualquier publicación de R2C, verificarlo por **lectura** en Production (comentario de la función `cardiolink_atenciones_guard_cobro_v1` con `[cobros-guard v4.2.1]`, 3 triggers habilitados) y corregir la documentación según el resultado. R2C asume el guard v4.2.1 sólo en STAGING.
**Pendiente obligatorio antes de Production (se mantiene de R2B): QA con rol Admin real.**

## Antes de commit
Informar:
- qué se cambió;
- qué se probó;
- qué falta probar;
- riesgo;
- rollback.

## Copias para facturación → Pendientes (V1.1)
Tests: `node --test cardiolink-copias-pendientes-v1.test.cjs`. STAGING con datos sintéticos: sin PDF amarillo; subir verde (abre el PDF);
eliminar no impresa vuelve a amarillo; marcar impreso cierra el pendiente (sale de Pendientes sin otros pendientes; con otros, se conservan);
eliminar copia impresa no reabre; fallo parcial (impresión registrada, cierre fallido) → chip «cerrar pendiente», reintento sin reimprimir ni duplicar
auditoría; copia sin vincular → amarillo; médico, Secretaría asociada y no asociada; sin consultas repetidas (caché en lote).

**Deuda técnica registrada (preexistente, no corregida en esta rama):** si otra sesión abierta reescribe la misma atención justo antes de que
un usuario guarde un cambio (p. ej. cerrar un pendiente), la sincronización detecta el conflicto, adopta la versión remota y el cambio local se
pierde sin aviso. Ocurre igual con el botón existente de cada pendiente. En Copias el chip «Copia impresa · cerrar pendiente» permite reintentar.
Mejora futura: avisar el conflicto y reaplicar el cambio sobre la versión remota.
