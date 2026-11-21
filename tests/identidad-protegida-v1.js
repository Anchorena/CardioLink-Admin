'use strict';
// Protección de identidad de pacientes (hotfix del incidente del 19/11/2026: 1001 fichas quedaron sin nombre ni DNI y cada equipo adoptaba esos vacíos).
// Cubre el módulo real (reconciliarCarga) y la integración en app.js. Corre con Node (previsto: 22) y también con JavaScriptCore.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const F = require(path.join(root, 'cardiolink-pacientes-ficha-v1.js'));
const APP = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

let ok = 0, fail = 0; const pendientes = [];
const t = (n, f) => pendientes.push([n, f]);
const fila = (o) => Object.assign({ id: 'p1', nombre_completo: 'Paciente Prueba', dni: '11111111', telefono: '111', email: null, fecha_nacimiento: null, sexo: null, localidad: null, direccion: null, provincia: null, cobertura_habitual: null, numero_afiliado_habitual: null, actualizado_en: '2026-11-19T17:40:54.385+00:00' }, o || {});
const vacia = () => fila({ nombre_completo: null, dni: null, telefono: null });
const local = (o) => Object.assign({ id: 'p1', nombreCompleto: 'Paciente Prueba', dni: '11111111', telefono: '111' }, o || {});

t('A · INCIDENTE: la tabla vacía (sin nombre ni DNI) y la copia local con datos: NO se adopta el vaciado de identidad', () => {
  const r = F.reconciliarCarga(local(), vacia(), undefined);
  assert.equal('nombreCompleto' in r.adoptar, false); assert.equal('dni' in r.adoptar, false);
  assert.deepEqual(Object.keys(r.vaciadosIdentidad || {}).sort(), ['dni', 'nombreCompleto']);
  assert.equal(r.vaciadosIdentidad.nombreCompleto, 'Paciente Prueba'); assert.equal(r.vaciadosIdentidad.dni, '11111111');
});
t('B · los demás campos siguen a la tabla, también cuando quedan vacíos (teléfono vaciado se adopta)', () => {
  const r = F.reconciliarCarga(local(), vacia(), undefined);
  assert.equal(r.adoptar.telefono, null);
});
t('C · un cambio legítimo de nombre o DNI (otro valor, no vacío) sí se adopta', () => {
  const r = F.reconciliarCarga(local(), fila({ nombre_completo: 'Paciente Prueba Nestor', dni: '11111112' }), undefined);
  assert.equal(r.adoptar.nombreCompleto, 'Paciente Prueba Nestor'); assert.equal(r.adoptar.dni, '11111112');
  assert.equal(r.vaciadosIdentidad, undefined);
});
t('D · copia local vacía y tabla con datos: se completa (la recuperación funciona)', () => {
  const r = F.reconciliarCarga({ id: 'p1', nombreCompleto: '', dni: '' }, fila(), undefined);
  assert.equal(r.adoptar.nombreCompleto, 'Paciente Prueba'); assert.equal(r.adoptar.dni, '11111111');
  assert.equal(r.vaciadosIdentidad, undefined);
});
t('E · ambos vacíos: nada que hacer; ambos iguales: nada que hacer', () => {
  const a = F.reconciliarCarga({ id: 'p1', nombreCompleto: '', dni: '' }, vacia(), undefined);
  assert.deepEqual(a.adoptar, {}); assert.equal(a.vaciadosIdentidad, undefined);
  const b = F.reconciliarCarga(local(), fila(), undefined);
  assert.deepEqual(b.adoptar, {}); assert.equal(b.vaciadosIdentidad, undefined);
});
t('F · una edición real pendiente de la persona se conserva (no se informa ni se adopta)', () => {
  const r = F.reconciliarCarga(local({ dni: '' }), fila(), { origen: 'usuario', cambios: { dni: { a: '11111111', d: null } } });
  assert.equal('dni' in r.adoptar, false); assert.equal(r.vaciadosIdentidad, undefined);
});
t('G · la reconciliación sigue sin escribir: sin empujes ni divergencias', () => {
  const r = F.reconciliarCarga(local(), vacia(), undefined);
  assert.deepEqual(r.empujar, {}); assert.deepEqual(r.divergencias, {});
});

t('H · app.js: umbral de vaciado masivo y decisión ANTES de fusionar (las correcciones puntuales pasan, el lote se bloquea)', () => {
  assert.match(APP, /const UMBRAL_VACIADO410=10;/);
  assert.match(APP, /const nVaciados=contarVaciadosIdentidad410\(pa\);\s*vaciadoIdentidadPermitido410=nVaciados<UMBRAL_VACIADO410;/);
  assert.ok(APP.indexOf('vaciadoIdentidadPermitido410=nVaciados<UMBRAL_VACIADO410') < APP.indexOf('pa.forEach(mergePaciente410);re.forEach(mergeResumen410)'), 'la decisión va antes de fusionar');
  assert.match(APP, /if\(vaciadoIdentidadPermitido410&&rec\.vaciadosIdentidad\)Object\.keys\(rec\.vaciadosIdentidad\)\.forEach\(k=>\{p\[k\]='';\}\);/);
  assert.match(APP, /Protección de identidad: la tabla trae/);
  assert.match(APP, /if\(!avisoVaciado410\)\{avisoVaciado410=true;/);   // un solo aviso por sesión
});
t('I · app.js: ningún upsert de fila completa pisa un nombre/DNI existente con NULL', () => {
  assert.match(APP, /function sinVaciosIdentidad410\(row\)\{const o=\{\.\.\.row\};if\(o\.nombre_completo==null\|\|String\(o\.nombre_completo\)\.trim\(\)===''\|\|o\.nombre_completo===NOMBRE_SUSTITUTO410\)delete o\.nombre_completo;if\(o\.dni==null\)delete o\.dni;return o;\}/);
  assert.match(APP, /const NOMBRE_SUSTITUTO410='Paciente sin nombre';/);
  const up = APP.match(/from\('cardiolink_pacientes'\)\.upsert\(\[[^\]]*\]\s*,\{onConflict:'id'\}\)/g) || [];
  assert.ok(up.length >= 4, 'hay al menos 4 upserts de fila completa'); up.forEach((u) => assert.match(u, /sinVaciosIdentidad410\(/, u));
});
t('J · app.js: el reintento de fichas no envía un lote de vaciados de nombre/DNI', () => {
  assert.match(APP, /const bloquearVacias=lista\.filter\(vacia\)\.length>=UMBRAL_VACIADO410;/);
  assert.match(APP, /if\(bloquearVacias&&vacia\(f\)\)\{res\.rechazadas\+\+;/);
});
t('K · el hotfix no agrega escrituras: leer sigue sin escribir (las únicas rutas de escritura nuevas son filtros)', () => {
  const tramo = APP.slice(APP.indexOf('function contarVaciadosIdentidad410'), APP.indexOf('function mergePaciente410'));
  assert.ok(!/\.(insert|upsert|update|delete|rpc)\s*\(/.test(tramo), 'el conteo no escribe');
  assert.ok(!/supabaseClient/.test(tramo), 'el conteo no consulta el servidor');
});
t('L · versiones: la app y el módulo de fichas suben de versión para romper la caché', () => {
  assert.match(INDEX, /app\.js\?v=40132-identidad-protegida/); assert.match(INDEX, /cardiolink-pacientes-ficha-v1\.js\?v=fe-2/);
});

(async () => {
  for (const [n, f] of pendientes) { try { await f(); ok++; console.log('  OK  ' + n); } catch (e) { fail++; console.log('FALLA ' + n + '\n      ' + (e && e.message || e)); } }
  console.log('\nidentidad-protegida-v1: ' + ok + '/' + (ok + fail) + ' pruebas OK');
  if (fail && typeof process !== 'undefined') process.exitCode = 1;
})();
