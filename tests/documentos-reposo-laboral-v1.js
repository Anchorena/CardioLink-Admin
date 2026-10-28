'use strict';

// tests/documentos-reposo-laboral-v1.js
// Bloque 2 (Documentos V1): "Reposo físico laboral" como plantilla de certificado. Tipo LOCAL `reposo_laboral`; se archiva como 'Certificado'
// (cardiolink_patient_documents.document_type es texto libre): sin tablas, migraciones ni cambios en Edge Functions. Ejecuta el código REAL de app.js.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

function tramo(desde, hasta) {
  const i = app.indexOf(desde), j = app.indexOf(hasta, i + 1);
  assert.ok(i > 0 && j > i, 'no se encontró el tramo ' + desde);
  return app.slice(i, j);
}
const Q = new Function('patientName406', tramo('const DOC_TYPES_4093=[', 'function canEditDoc406') + '\n' + tramo('function defaultDoc406', 'function resolverFormatoImpresion406') + '\nreturn {DOC_TYPES_4093,docLabel406,defaultDoc406,esTipoCompacto406};')(() => 'Paciente Prueba');
const p = { nombreCompleto: 'Paciente Prueba', dni: '12345678' };

const casos = [];
function caso(n, f) { casos.push([n, f]); }

caso('el desplegable incluye "Reposo físico laboral" (tipo reposo_laboral) junto a Certificado', () => {
  const i = Q.DOC_TYPES_4093.findIndex(x => x[0] === 'reposo_laboral');
  assert.ok(i > 0);
  assert.equal(Q.DOC_TYPES_4093[i][1], 'Reposo físico laboral');
  assert.equal(Q.DOC_TYPES_4093[i - 1][0], 'certificado');
  assert.equal(Q.docLabel406('reposo_laboral'), 'Reposo físico laboral');
});
caso('texto inicial editable exacto y título', () => {
  const d = Q.defaultDoc406('reposo_laboral', p);
  assert.equal(d.body, 'Se indica reposo físico laboral por 48 horas.');
  assert.equal(d.title, 'Reposo físico laboral');
  assert.equal(d.extra, '');
});
caso('el certificado común no cambia', () => {
  const d = Q.defaultDoc406('certificado', p);
  assert.equal(d.title, 'Certificado médico');
  assert.ok(d.body.startsWith('Se deja constancia de que Paciente Prueba, DNI 12345678, '));
});
caso('formato compacto A5 igual que el certificado', () => {
  assert.equal(Q.esTipoCompacto406('reposo_laboral'), true);
  assert.equal(Q.esTipoCompacto406('certificado'), true);
  assert.equal(Q.esTipoCompacto406('receta'), false);
});
caso('se archiva como Certificado (generador de PDF y chequeo de respaldo al cerrar sesión)', () => {
  assert.ok(/const TIPO_PDF_ARCHIVO_POR_DOC406=\{[^}]*reposo_laboral:'Certificado'/.test(app));
  assert.ok(/const TIPO_ARCHIVO_PDF_POR_DOC_V1=\{[^}]*reposo_laboral:'Certificado'/.test(app));
});
caso('Secretaría puede emitirlo como el certificado; el aviso al profesional usa el tipo "certificado" (único que valida la Edge Function)', () => {
  assert.ok(app.includes("['constancia_atencion','certificado','reposo_laboral','orden'].includes(String(type||''))"));
  assert.ok(app.includes("tipoDocumento:tipo==='reposo_laboral'?'certificado':tipo"));
  assert.ok(app.includes("tipo==='certificado'||tipo==='reposo_laboral'||tipo==='orden'"));
});
caso('sin cambios de base: ninguna migración, SQL ni Edge Function menciona reposo_laboral', () => {
  for (const dir of ['supabase/migrations', 'supabase/functions/patient-document-delivery', 'supabase/functions/patient-communications']) {
    const base = path.join(root, dir);
    // la lectura de directorios no existe en el shim de JavaScriptCore: sólo se comprueba cuando hay fs.readdirSync
    if (typeof fs.readdirSync !== 'function') return;
    for (const f of fs.readdirSync(base)) {
      const ruta = path.join(base, f);
      if (/\.(sql|ts)$/.test(f)) assert.ok(!fs.readFileSync(ruta, 'utf8').includes('reposo_laboral'), ruta);
    }
  }
});

(async () => {
  let fallos = 0;
  for (const [n, f] of casos) {
    try { await f(); console.log('PASS ' + n); } catch (e) { fallos++; console.log('FAIL ' + n + '\n     ' + (e && e.message)); }
  }
  console.log(`\n${casos.length - fallos}/${casos.length} PASS`);
  if (fallos) process.exit(1);
})();
