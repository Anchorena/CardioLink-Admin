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
7. fila con cambios locales + cambio remoto real de otra sesión: el guardado condicionado detecta el conflicto (gana el remoto, con aviso);
8. Médico: resolver un pendiente (RPC) durante un refresco → sigue resuelto;
9. editar una fila mientras su propio guardado está en vuelo (o resolver un pendiente justo después de editar la ficha del paciente): la segunda edición se sube en el ciclo siguiente (la base de contenido es lo ENVIADO, no lo que haya tras el await).
Nota de método: esperar a que termine el guardado de arranque antes de cada caso (`!syncPendienteSinConfirmar && !syncAtencionesEnCurso`); dos refrescos seguidos sin pausa no son un caso real (el segundo se omite mientras hay un guardado sin confirmar).
Hallazgos fuera de R1 (sin corregir; candidatos a R2): (a) con filas corruptas en el servidor, la primera carga de cada sesión llama a `sincronizarAtencionesSupabase(false)` ANTES de fijar la base de contenido y reescribe TODAS las atenciones (en STAGING ≈ 70 PATCH por inicio de sesión, subiendo `updated_at` de todas): otra sesión con edición en curso choca con el guardado condicionado y pierde su cambio; (b) la config de Dueño/Admin y las RPC de Secretaría pueden pisarse entre sí (última escritura gana por clave).
Arnés local reproducible (app real + Supabase simulado en memoria, sin credenciales): resultados R1 en el informe de la tarea.

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
