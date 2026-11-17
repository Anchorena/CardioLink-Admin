'use strict';
// Persistencia V1 / R2A: la base de contenido de las atenciones se fija ANTES de la sincronización inicial provocada por registros corruptos.
// Pruebas estáticas sobre app.js (node --test cardiolink-persistencia-r2a.test.cjs). La verificación de comportamiento está en el QA de docs/QA.md (sección 12).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

test('R2A: la base de contenido se fija entre la limpieza de corruptos y el sync inicial, sólo en la primera carga', () => {
  const i = app.indexOf('const corruptosEliminados=limpiarRegistrosCorruptosSilencioso();');
  const base = app.indexOf('if(!primeraCargaAplicada298) fijarBaseContenidoInicialR2A();', i);
  const sync = app.indexOf('if(corruptosEliminados>0){ cargandoDesdeNube=false; await sincronizarAtencionesSupabase(false); cargandoDesdeNube=true; }', i);
  assert.ok(i > 0 && base > i && sync > base, 'orden: limpiar -> fijar base -> sync por corruptos');
  assert.doesNotMatch(app.slice(i, base), /await/, 'sin await entre la asignación de lo recién bajado y la base (no puede haber ediciones locales)');
});

test('R2A: el snapshot final no re-basa filas editadas después de la base inicial y la base inicial se consume una vez', () => {
  assert.match(app, /function fijarBaseContenidoInicialR2A\(\)\{ snapshotBaselineAtenciones298\(atenciones\); baseContInicialR2A=new Map\(baselineAtenciones298\); \}/);
  assert.match(app, /if\(baseContInicialR2A\)\{ baseContInicialR2A\.forEach\(\(c,id\)=>\{ if\(m\.has\(id\)\) m\.set\(id,c\); \}\); baseContInicialR2A=null; \}/);
  assert.match(app, /snapshotBaselineAtenciones298\(atenciones\);\s+cargandoDesdeNube=false;/, 'el snapshot final y la liberación de cargandoDesdeNube siguen adyacentes');
});

test('R2A: se conservan las protecciones de R1 (filas sin versión sin base, protegidas, contenido enviado)', () => {
  assert.match(app, /baselineVersionAtenciones298\.has\(String\(a\.id\)\)\) m\.set\(String\(a\.id\), stableStringify298\(a\)\)/);
  assert.match(app, /if\(protegidasR1\)\{ protegidasR1\.forEach/);
  assert.match(app, /const contEnviado298=stableStringify298\(a\);/);
});

test('R2A: no se tocó applyNA383 (el upsert ciego de la config se eliminó en R2B)', () => {
  assert.match(app, /function applyNA383\(a\)\{\s+if\(!a\|\|typeof a!=='object'\|\|String\(a\.tipo\|\|''\)\.includes\('mensaje'\)\)return;/);
  assert.doesNotMatch(app, /\.upsert\(\[\{id:CONFIG_ROW_ID,payload,updated_at:/, 'R2B: app.js ya no hace upsert ciego de la config');
});
