'use strict';

// tests/pacientes-backfill-sync.js
// Cubre dos cosas de la etapa "backfill histórico de cardiolink_pacientes"
// (ver docs/CARDIOLINK_PATIENT_BACKFILL_AUDIT.md, v2):
//   1) que las tres altas/ediciones de paciente del Admin (app.js) también
//      sincronicen la capa relacional (cardiolink_pacientes) usando la
//      variante "básica" (nunca toca tablas de HC, apta para Secretaría);
//   2) que la migración SQL propuesta (NO ejecutada), reconstruida sobre
//      config.pacientes (fuente real, no atenciones sueltas), mantenga las
//      garantías de diseño acordadas: idempotente, nunca UPDATE sobre
//      pacientes existentes, conflicto de id múltiple excluido, fecha
//      nunca casteada directo, sin agregar observaciones_administrativas.
//
// Este entorno no tiene Node ni un motor SQL disponibles para ejecutar de
// verdad ni app.js ni la migración (confirmado repetidas veces en esta
// sesión) — son pruebas estáticas: aserciones sobre el código/SQL fuente.
// app.js en particular tampoco es parseable con esprima (usa `catch{}` sin
// binding, ES2019, ya presente en el archivo ANTES de esta tarea — no es
// una regresión de este cambio); se verificó en cambio que los agregados
// mantienen el archivo con parens/llaves balanceados (mismo desbalance
// preexistente de paréntesis, sin cambios).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const appPath = path.join(root, 'app.js');
const appSource = fs.readFileSync(appPath, 'utf8');
const migrationPath = path.join(root, 'supabase', 'migrations', '20260824190000_cardiolink_pacientes_backfill_historico.sql');
const migrationSource = fs.readFileSync(migrationPath, 'utf8');
const auditDocPath = path.join(root, 'docs', 'CARDIOLINK_PATIENT_BACKFILL_AUDIT.md');

function test(name, run) {
  try {
    run();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

const LLAMADA_SYNC_BASICA = "window.cardiolinkClinica410?.sincronizarFichaBasica?.(p)";
const PATRON_LLAMADA_BASICA = "try{window.cardiolinkClinica410?.sincronizarFichaBasica?.(p)?.catch?.(e=>console.warn('No se pudo sincronizar la capa clínica relacional:',e));}catch(e){console.warn('No se pudo sincronizar la capa clínica relacional:',e);}";

function cuerpoDeFuncion(nombreFuncion) {
  const inicio = appSource.indexOf(`function ${nombreFuncion}(`);
  assert.notEqual(inicio, -1, `existe function ${nombreFuncion}(...)`);
  // app.js usa indentación variable (2 espacios en unas secciones, 0/4 en
  // otras): en vez de asumir un nivel fijo de indentación para el cierre,
  // se corta en la próxima aparición de "\nfunction " (siguiente función
  // de nivel superior), que alcanza para las funciones que se prueban acá
  // (chequeos de presencia/orden, no de límite exacto de cierre).
  const finPorFuncion = appSource.indexOf('\nfunction ', inicio + 1);
  const fin = finPorFuncion === -1 ? appSource.length : finPorFuncion;
  return appSource.slice(inicio, fin);
}

// -----------------------------------------------------------------------
// 1) app.js: las tres altas/ediciones de paciente sincronizan también la
//    capa relacional (cardiolink_pacientes), usando la variante básica.
// -----------------------------------------------------------------------

test('upsertPacienteDesdeCarga() sincroniza la ficha básica después de saveConfig() (cubre "nuevo turno con paciente nuevo", el alta más común)', () => {
  const cuerpo = cuerpoDeFuncion('upsertPacienteDesdeCarga');
  const posConfig = cuerpo.indexOf('saveConfig();');
  const posSync = cuerpo.indexOf(LLAMADA_SYNC_BASICA);
  assert.notEqual(posConfig, -1, 'llama a saveConfig()');
  assert.notEqual(posSync, -1, 'llama a sincronizarFichaBasica');
  assert.ok(posConfig < posSync, 'la sincronización relacional pasa después de guardar la config local');
});

test('guardarPacientePanel() sincroniza la ficha básica al editar/crear ficha desde el panel de Pacientes', () => {
  const cuerpo = cuerpoDeFuncion('guardarPacientePanel');
  assert.match(cuerpo, /saveConfig\(\);\s*\n\s*saveAtenciones\(\);/, 'sigue guardando config+atenciones como antes');
  assert.ok(cuerpo.includes(LLAMADA_SYNC_BASICA), 'agrega la sincronización relacional básica');
});

test('guardarPacienteGlobal350() sincroniza la ficha básica al guardar la ficha global (incluida la que carga observaciones administrativas locales)', () => {
  const cuerpo = cuerpoDeFuncion('guardarPacienteGlobal350');
  assert.ok(cuerpo.includes(LLAMADA_SYNC_BASICA), 'agrega la sincronización relacional básica');
});

test('las tres llamadas nuevas usan sincronizarFichaBasica, no sincronizarPacienteCompleto: nunca arriesgan escribir en tablas de HC desde un flujo de Secretaría', () => {
  const ocurrencias = (appSource.match(new RegExp(PATRON_LLAMADA_BASICA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
  assert.equal(ocurrencias, 3, 'las tres llamadas nuevas (upsertPacienteDesdeCarga, guardarPacientePanel, guardarPacienteGlobal350) usan exactamente este patrón, y ninguna otra parte de app.js lo repite');
});

test('las llamadas nuevas encadenan ?.catch?.() sobre la promesa devuelta, además del try/catch sincrónico', () => {
  const cuerpo1 = cuerpoDeFuncion('upsertPacienteDesdeCarga');
  const cuerpo2 = cuerpoDeFuncion('guardarPacientePanel');
  const cuerpo3 = cuerpoDeFuncion('guardarPacienteGlobal350');
  [cuerpo1, cuerpo2, cuerpo3].forEach((cuerpo) => {
    assert.match(cuerpo, /sincronizarFichaBasica\?\.\(p\)\?\.catch\?\.\(/, 'encadena ?.catch?. sobre la llamada async, no depende sólo del try/catch sincrónico');
  });
});

test('sincronizarFichaPacienteBasica410() existe, es async, y su cuerpo entero está protegido con try/catch que nunca relanza (la promesa que devuelve no puede rechazar)', () => {
  assert.match(appSource, /async function sincronizarFichaPacienteBasica410\(p\)\{/, 'existe la función nueva, más acotada');
  const inicio = appSource.indexOf('async function sincronizarFichaPacienteBasica410(p){');
  const fin = appSource.indexOf('\n  async function sincronizarPacienteCompleto410(p){', inicio);
  assert.notEqual(fin, -1, 'se puede acotar el cuerpo de la función hasta la siguiente función del módulo');
  const cuerpo = appSource.slice(inicio, fin);
  assert.match(cuerpo, /\}catch\(e\)\{[\s\S]*return false;[\s\S]*\}/, 'el catch nunca relanza: siempre resuelve false en vez de rechazar la promesa');
});

test('sincronizarFichaPacienteBasica410() sólo escribe en cardiolink_pacientes: nunca toca cardiolink_hc_resumen ni cardiolink_hc_evoluciones (a diferencia de sincronizarPacienteCompleto410)', () => {
  const inicio = appSource.indexOf('async function sincronizarFichaPacienteBasica410(p){');
  const fin = appSource.indexOf('\n  async function sincronizarPacienteCompleto410(p){', inicio);
  const cuerpo = appSource.slice(inicio, fin);
  assert.match(cuerpo, /from\('cardiolink_pacientes'\)\.upsert/, 'hace upsert en cardiolink_pacientes');
  assert.doesNotMatch(cuerpo, /cardiolink_hc_resumen/, 'nunca referencia la tabla de resumen clínico');
  assert.doesNotMatch(cuerpo, /cardiolink_hc_evoluciones/, 'nunca referencia la tabla de evoluciones clínicas');
});

test('sincronizarPacienteCompleto410() (preexistente) sigue sin cambios de firma y sigue expuesta junto a la nueva sincronizarFichaBasica', () => {
  assert.match(appSource, /async function sincronizarPacienteCompleto410\(p\)\{/, 'la función original sigue existiendo sin cambios de firma');
  assert.match(
    appSource,
    /window\.cardiolinkClinica410=\{version:VERSION_CLINICA_410,cargar:cargar410,sincronizarPacienteCompleto:sincronizarPacienteCompleto410,sincronizarFichaBasica:sincronizarFichaPacienteBasica410\};/,
    'expone ambas variantes'
  );
});

test('los dos puntos de HC preexistentes (saveEvolutionHC y guardado de resumen clínico) siguen llamando a sincronizarPacienteCompleto, no a la variante básica: son flujos exclusivos de Médico y sí necesitan sincronizar HC', () => {
  const ocurrenciasCompleto = (appSource.match(/window\.cardiolinkClinica410\?\.sincronizarPacienteCompleto\?\.\(p\)/g) || []).length;
  assert.equal(ocurrenciasCompleto, 2, 'sólo los 2 puntos preexistentes de HC llaman a sincronizarPacienteCompleto; los 3 nuevos usan la variante básica');
});

test('balance de llaves/paréntesis de app.js se mantiene tras los agregados (mismo desbalance preexistente de paréntesis, sin cambios)', () => {
  // app.js ya tenía un desbalance de 4 paréntesis ANTES de esta tarea
  // (texto dentro de strings/comentarios en un archivo de ~11.000 líneas,
  // no un bug real: el archivo corre en producción tal cual). Lo único
  // que se verifica acá es que los agregados de esta tarea no lo
  // empeoraron ni lo cambiaron.
  assert.equal(appSource.split('{').length, appSource.split('}').length, 'llaves balanceadas');
  const parensAbren = (appSource.match(/\(/g) || []).length;
  const parensCierran = (appSource.match(/\)/g) || []).length;
  assert.equal(parensAbren - parensCierran, 4, 'mismo desbalance preexistente de paréntesis (4), sin cambios introducidos por esta tarea');
});

// -----------------------------------------------------------------------
// 2) Migración SQL propuesta (NO ejecutada): garantías de diseño.
// -----------------------------------------------------------------------

test('la migración de backfill existe y está claramente marcada como no ejecutada', () => {
  assert.ok(fs.existsSync(migrationPath), 'existe el archivo de migración');
  assert.match(migrationSource, /REDACTADA, NO EJECUTADA TODAVIA/i);
});

test('la fuente del backfill es config.pacientes (fila técnica __cardiolink_config_v1), no filas sueltas de cardiolink_atenciones', () => {
  assert.match(migrationSource, /where id = '__cardiolink_config_v1'/, 'lee la fila técnica de config');
  assert.match(migrationSource, /coalesce\(config_row\.payload->'config'->'pacientes', '\[\]'::jsonb\)/, 'desanida payload->config->pacientes');
  assert.match(migrationSource, /jsonb_array_elements/, 'usa jsonb_array_elements para desanidar el array de pacientes');
});

test('el backfill es idempotente: sólo hace INSERT (nunca UPDATE) sobre cardiolink_pacientes, filtrando por dni_normalizado ya existente', () => {
  assert.match(migrationSource, /insert into public\.cardiolink_pacientes/i);
  assert.doesNotMatch(migrationSource, /update\s+public\.cardiolink_pacientes/i, 'nunca actualiza una fila existente');
  assert.match(migrationSource, /select 1 from public\.cardiolink_pacientes cp where cp\.dni_normalizado = m\.dni_norm/, 'excluye DNI ya existentes antes de clasificar como candidato');
});

test('preserva el id histórico cuando hay exactamente uno por DNI; genera pac_<uuid> sólo cuando no había ninguno', () => {
  assert.match(migrationSource, /when coalesce\(i\.ids_distintos, 0\) = 1[\s\S]{0,200}then i\.id_unico_si_aplica/, 'con exactamente un id histórico, lo preserva');
  assert.match(migrationSource, /when coalesce\(i\.ids_distintos, 0\) = 0 then 'pac_' \|\| replace\(gen_random_uuid\(\)::text, '-', ''\)/, 'sin id histórico, genera uno nuevo con el mismo prefijo pac_ que ya usa el Admin/gateway');
});

test('los DNI con más de un id histórico distinto NO se insertan automáticamente: quedan como conflicto_id_multiple', () => {
  assert.match(migrationSource, /when coalesce\(i\.ids_distintos, 0\) > 1 then 'conflicto_id_multiple'/);
  assert.match(migrationSource, /where r\.estado = 'candidato'/, 'el INSERT real sólo toma filas candidato, nunca conflicto_id_multiple');
});

test('protección extra: si un id histórico único ya está tomado por otro paciente en cardiolink_pacientes, no lo reutiliza a ciegas (conflicto_id_colision)', () => {
  assert.match(migrationSource, /conflicto_id_colision/);
  assert.match(migrationSource, /select 1 from public\.cardiolink_pacientes cp where cp\.id = i\.id_unico_si_aplica/);
});

test('la fecha de nacimiento nunca se castea directo: usa una función auxiliar con manejo de excepción y rango razonable', () => {
  assert.doesNotMatch(migrationSource, /\(elem\.value->>'fechaNacimiento'\)::date/, 'ningún cast directo e inseguro de la fecha');
  assert.match(migrationSource, /create or replace function public\.cardiolink_backfill_intentar_fecha/);
  assert.match(migrationSource, /candidata < date '1900-01-01' or candidata > current_date/, 'descarta años absurdos que un cast directo aceptaría sin error');
});

test('el desempate entre objetos duplicados del mismo DNI usa el timestamp propio del paciente (actualizadoEn/creadoEn), nunca updated_at de cardiolink_atenciones (que es el mismo para los 847 pacientes)', () => {
  assert.match(migrationSource, /create or replace function public\.cardiolink_backfill_intentar_timestamp/, 'existe la función auxiliar de timestamp, separada de la de fecha');
  assert.match(migrationSource, /coalesce\(\s*\n\s*public\.cardiolink_backfill_intentar_timestamp\(elem\.value->>'actualizadoEn'\),\s*\n\s*public\.cardiolink_backfill_intentar_timestamp\(elem\.value->>'creadoEn'\)/, 'prioriza actualizadoEn, cae a creadoEn');
  assert.match(migrationSource, /orden_temporal desc nulls last/, 'usa el timestamp propio del paciente para desempatar, no updated_at de la fila técnica');
  assert.doesNotMatch(migrationSource, /order by[\s\S]{0,400}updated_at desc nulls last/, 'ya no usa updated_at de cardiolink_atenciones como criterio de más reciente (no distingue nada entre los 847 pacientes de la misma fila técnica)');
});

test('ambas funciones auxiliares (fecha y timestamp) se eliminan al final de la misma migración: no quedan como objetos permanentes', () => {
  assert.match(migrationSource, /drop function public\.cardiolink_backfill_intentar_fecha\(text\);/);
  assert.match(migrationSource, /drop function public\.cardiolink_backfill_intentar_timestamp\(text\);/);
  const posCreateFecha = migrationSource.indexOf('create or replace function public.cardiolink_backfill_intentar_fecha');
  const posDropFecha = migrationSource.indexOf('drop function public.cardiolink_backfill_intentar_fecha');
  const posCreateTs = migrationSource.indexOf('create or replace function public.cardiolink_backfill_intentar_timestamp');
  const posDropTs = migrationSource.indexOf('drop function public.cardiolink_backfill_intentar_timestamp');
  assert.ok(posCreateFecha !== -1 && posDropFecha !== -1 && posCreateFecha < posDropFecha, 'función de fecha: se crea y se elimina en ese orden');
  assert.ok(posCreateTs !== -1 && posDropTs !== -1 && posCreateTs < posDropTs, 'función de timestamp: se crea y se elimina en ese orden');
});

test('no agrega observaciones_administrativas: columna confirmada ausente en el esquema real, fuera de alcance de esta etapa', () => {
  // La columna sólo puede mencionarse en comentarios que documentan la
  // decisión — nunca dentro de la lista de columnas del INSERT real, que
  // es lo que de verdad importaría.
  const inicioInsert = migrationSource.indexOf('insert into public.cardiolink_pacientes (');
  const finInsert = migrationSource.indexOf(')', inicioInsert);
  assert.notEqual(inicioInsert, -1, 'existe el INSERT real');
  const listaColumnas = migrationSource.slice(inicioInsert, finInsert);
  assert.doesNotMatch(listaColumnas, /observaciones_administrativas/i, 'la columna no está en la lista real de columnas insertadas');
});

test('la migración no asume nombre_completo NOT NULL: un candidato sin nombre igual se inserta (la columna es nullable en el esquema real)', () => {
  assert.doesNotMatch(migrationSource, /nombre is null/, 'no hay ningún filtro que excluya candidatos sin nombre');
});

test('todo el backfill corre en una única transacción (begin/commit), con instrucciones claras para hacer un dry run con rollback', () => {
  const inicioBegin = migrationSource.indexOf('\nbegin;');
  const inicioCommit = migrationSource.indexOf('\ncommit;');
  assert.ok(inicioBegin !== -1 && inicioCommit !== -1 && inicioBegin < inicioCommit);
  assert.match(migrationSource, /DRY RUN/i);
});

test('el reporte previo usa exactamente las categorías pedidas y se arma antes del INSERT real', () => {
  const posReporte = migrationSource.indexOf('cardiolink_backfill_reporte');
  const posInsert = migrationSource.indexOf('insert into public.cardiolink_pacientes');
  assert.ok(posReporte !== -1 && posInsert !== -1 && posReporte < posInsert, 'la tabla temporal de reporte se arma antes del insert real');
  ['total_fuente', 'dni_validos_distintos', 'ya_existentes', 'candidatos', 'insertables_automaticos', 'conflicto_id_multiple', 'conflicto_id_colision', 'fecha_invalida'].forEach((categoria) => {
    assert.match(migrationSource, new RegExp(`as ${categoria}\\b`), `la categoría de reporte "${categoria}" está contemplada`);
  });
});

test('los estados de clasificación por fila cubren exactamente ya_existe / conflicto_id_multiple / conflicto_id_colision / candidato (sin las categorías incompleto_* de la v1, descartada)', () => {
  ['ya_existe', 'conflicto_id_multiple', 'conflicto_id_colision', 'candidato'].forEach((estado) => {
    assert.match(migrationSource, new RegExp(`'${estado}'`), `el estado "${estado}" está contemplado en la clasificación`);
  });
  assert.doesNotMatch(migrationSource, /incompleto_dni|incompleto_sin_nombre/, 'la v1 tenía estados "incompleto_*" que la v2 ya no usa (nombre_completo nullable, no se excluye por eso)');
});

// -----------------------------------------------------------------------
// 3) Documentación
// -----------------------------------------------------------------------

test('el análisis completo (v2, sobre config.pacientes) quedó documentado en docs/CARDIOLINK_PATIENT_BACKFILL_AUDIT.md', () => {
  assert.ok(fs.existsSync(auditDocPath), 'existe el doc de auditoría');
  const doc = fs.readFileSync(auditDocPath, 'utf8');
  assert.match(doc, /causa raíz/i);
  assert.match(doc, /conflicto_id_multiple/);
  assert.match(doc, /config\.pacientes/);
  assert.match(doc, /observacionesAdministrativas|observaciones_administrativas/);
  assert.match(doc, /847/, 'documenta el total real de objetos en config.pacientes');
  assert.match(doc, /838/, 'documenta el total real de DNI válidos distintos');
});

console.log('\nTodos los tests de pacientes-backfill-sync.js pasaron.');
