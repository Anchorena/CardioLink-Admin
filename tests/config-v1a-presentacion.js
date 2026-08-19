'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const configV1 = require(path.join(root, 'cardiolink-config-v1.js'));
const moduleSource = fs.readFileSync(path.join(root, 'cardiolink-config-v1.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function test(name, run) {
  try {
    run();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

test('expone las ocho secciones V1A y la zona sensible separada', () => {
  assert.deepEqual(configV1.sections.map(section => section.id), [
    'profesionales',
    'prestaciones',
    'coberturas',
    'documentos',
    'usuarios',
    'administracion',
    'datos',
    'ayuda',
    'seguridad'
  ]);
  assert.equal(configV1.sections.find(section => section.id === 'seguridad').sensitive, true);
});

test('clasifica los editores existentes sin crear una fuente funcional nueva', () => {
  const card = (id, group = '') => ({ id, dataset: { configGroupCard: group } });
  assert.equal(configV1.classifyCard(card('clPrestacionesPerfil411P')), 'prestaciones');
  assert.equal(configV1.classifyCard(card('configBloquesPrestaciones297')), 'prestaciones');
  assert.equal(configV1.classifyCard(card('cfgPrestacionesLegacyV1A')), 'prestaciones');
  assert.equal(configV1.classifyCard(card('cfgConveniosProfesional402')), 'coberturas');
  assert.equal(configV1.classifyCard(card('cfgFinanzas411F')), 'administracion');
  assert.equal(configV1.classifyCard(card('desconocida', 'mantenimiento')), 'seguridad');
});

test('diferencia editor principal, avanzado y compatibilidad', () => {
  assert.deepEqual(configV1.editorKinds.clPrestacionesPerfil411P, ['Editor principal', 'principal']);
  assert.deepEqual(configV1.editorKinds.configBloquesPrestaciones297, ['Configuración avanzada', 'advanced']);
  assert.deepEqual(configV1.editorKinds.cfgPrestacionesLegacyV1A, ['Compatibilidad / legado', 'legacy']);
  assert.deepEqual(configV1.editorKinds.cfgConveniosProfesional402, ['Editor principal', 'principal']);
  assert.deepEqual(configV1.editorKinds.cfgReglasObraSocialV1A, ['Compatibilidad / reglas heredadas', 'legacy']);
});

test('arma un resumen de equipo de solo lectura sin mutar la configuración', () => {
  const fixture = {
    especialidades: [{ id: 'cardio', nombre: 'Cardiología' }],
    profesionales: [
      { id: 'general', nombre: 'General' },
      { id: 'p1', nombre: 'Dra. Prueba', especialidadIds: ['cardio'], activo: true, prestaciones: ['Consulta', 'ECG'] },
      { id: 'p2', nombre: 'Dr. Inactivo', area: 'Clínica', activo: false, prestaciones: [] }
    ],
    usuarios: [{ id: 'u1', nombre: 'Usuario Prueba', profesionalId: 'p1' }]
  };
  const before = JSON.stringify(fixture);
  const summary = configV1.summarizeTeam(fixture, true);
  assert.equal(JSON.stringify(fixture), before);
  assert.equal(summary.length, 2);
  assert.deepEqual(summary[0], {
    id: 'p1',
    name: 'Dra. Prueba',
    specialty: 'Cardiología',
    active: true,
    prestations: ['Consulta', 'ECG'],
    users: ['Usuario Prueba']
  });
  assert.equal(summary[1].active, false);
  assert.equal(summary[1].users.length, 0);
});

test('el resumen no expone usuarios cuando el permiso administrativo no fue concedido', () => {
  const summary = configV1.summarizeTeam({
    profesionales: [{ id: 'p1', nombre: 'Profesional' }],
    usuarios: [{ id: 'u1', nombre: 'Acceso reservado', profesionalId: 'p1' }]
  }, false);
  assert.deepEqual(summary[0].users, []);
  assert.match(moduleSource, /puedeGestionarConfigAdministrativa\s*===\s*['"]function['"]/);
});

test('el módulo se carga una sola vez después del editor de prestaciones', () => {
  const prestationsAt = indexSource.indexOf('<script src="cardiolink-prestaciones-perfil.js?v=1"></script>');
  const configAt = indexSource.indexOf('<script src="cardiolink-config-v1.js?v=1a"></script>');
  assert.ok(prestationsAt >= 0);
  assert.ok(configAt > prestationsAt);
  assert.equal(indexSource.match(/cardiolink-config-v1\.js/g)?.length, 1);
  assert.equal(indexSource.match(/cardiolink-config-v1\.css/g)?.length, 1);
});

test('mantiene IDs y controles existentes, con una etiqueta de backup precisa', () => {
  [
    'btnGuardarValores',
    'btnGuardarReglaOS',
    'btnAddProfesional',
    'btnAddOS',
    'btnAddPrestacion',
    'btnAddUsuarioSistema',
    'btnExportBackup',
    'btnImportBackup',
    'btnBorrarDatos'
  ].forEach(id => assert.equal((indexSource.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, id));
  assert.match(indexSource, /Backup de configuración y atenciones/);
  assert.doesNotMatch(indexSource, /Exportar backup completo/);
  assert.match(indexSource, /data-config-v1-legacy-trigger="mantenimiento"/);
  assert.match(indexSource, /data-config-v1-legacy-trigger="sistema"/);
});

test('preserva los atributos de acceso existentes por tarjeta y acción', () => {
  [
    /id="cfgValoresProfesionalV1A"[^>]*data-config-access="commercial"/,
    /id="cfgProfesionalesBasicoV1A"[^>]*data-config-access="operational"/,
    /id="cfgUsuariosSistemaV1A"[^>]*data-config-access="admin"/,
    /id="cfgBackupDatosV1A"[^>]*data-config-access="restore"/,
    /id="btnExportBackup"[^>]*data-config-access="admin"/,
    /id="cfgMantenimientoTecnicoV1A"[^>]*data-config-access="admin"/,
    /id="cfgInstalacionAppV1A"[^>]*data-config-access="operational"/
  ].forEach(pattern => assert.match(indexSource, pattern));
});

test('la capa V1A no guarda datos ni crea clientes o reglas de permisos', () => {
  [
    /saveConfig\s*\(/,
    /guardarConfigEnSupabase/,
    /supabaseClient/,
    /\.from\s*\(\s*['"]cardiolink_/,
    /localStorage/,
    /sessionStorage/,
    /fetch\s*\(/,
    /baseRole/,
    /rolId/
  ].forEach(pattern => assert.doesNotMatch(moduleSource, pattern));
  assert.match(moduleSource, /previous\.apply\(this, arguments\)/);
  assert.doesNotMatch(moduleSource, /MutationObserver/);
});

console.log('Config V1A presentación: OK');
