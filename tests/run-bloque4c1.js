'use strict';

// tests/run-bloque4c1.js — corredor de las suites del Bloque 4C-1 y de las que ya estaban aprobadas o relacionadas. Sin dependencias: sólo Node (>= 18).
// Uso (desde esta carpeta): node run-bloque4c1.js [--solo 4c1|4b|bloque3|qr|documentos] [--detalle]
// Cada suite se ejecuta en un proceso aparte con el mismo Node. Código de salida 0 si NO hay fallas inesperadas.
// FALLAS CONOCIDAS (preexistentes; no las causa el Bloque 4C-1): dos aserciones de las suites de QR quedaron desactualizadas cuando se activaron, a propósito, el QR y la Site Key de Turnstile en
// Production (commits 72fd56b y 48be71c). Se informan SIEMPRE y no cuentan como falla inesperada; si fallara cualquier otra prueba de esas suites, el corredor termina con error.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const SUITES = [
  { grupo: '4c1', archivo: 'documentos-seguridad-4c1.js', etiqueta: 'Bloque 4C-1 (estático)' },
  { grupo: '4b', archivo: 'config-secretaria-v1.js', etiqueta: 'Bloque 4B (aprobado: 62 pruebas)' },
  { grupo: 'bloque3', archivo: 'asociaciones-ui-v1.js', etiqueta: 'Bloque 3 (aprobado: 20 pruebas)' },
  { grupo: 'qr', archivo: 'documentos-qr-v2a-f2.js', etiqueta: 'QR de autenticidad F2',
    conocidas: ['QR sólo si el archivado lo pide'], motivo: 'afirma que nadie activa CARDIOLINK_QR_V2A por defecto; index.html la activa a propósito desde 72fd56b (QR habilitado en Production)' },
  { grupo: 'qr', archivo: 'documentos-verificacion-publica-v2a-f3.js', etiqueta: 'Verificación pública F3',
    conocidas: ['entorno por hostname con LISTA CERRADA'], motivo: 'espera SITEKEY_PRODUCCION_PENDIENTE; verificar.js tiene la Site Key real desde 48be71c' },
  { grupo: 'documentos', archivo: 'documentos-pdf-imagenes-v1.js', etiqueta: 'Documentos: PDF e imágenes' },
  { grupo: 'documentos', archivo: 'documentos-guardar-imprimir-enviar-v1.js', etiqueta: 'Documentos: guardar/imprimir/enviar' },
  { grupo: 'documentos', archivo: 'documentos-sesion-vencida-v1.js', etiqueta: 'Documentos: sesión vencida' },
  { grupo: 'documentos', archivo: 'documentos-fecha-hora-v1.js', etiqueta: 'Documentos: fecha y hora' },
  { grupo: 'documentos', archivo: 'documentos-reposo-laboral-v1.js', etiqueta: 'Documentos: reposo laboral' }
];

const args = process.argv.slice(2);
const solo = args.includes('--solo') ? args[args.indexOf('--solo') + 1] : null;
const detalle = args.includes('--detalle');
const elegidas = SUITES.filter(s => !solo || s.grupo === solo || (solo === 'qr' && s.grupo === 'qr'));
if (!elegidas.length) { console.error('Grupo desconocido: ' + solo); process.exit(2); }

let inesperadas = 0, conocidas = 0;
console.log('Node ' + process.version + ' · ' + elegidas.length + ' suite(s)\n');
for (const s of elegidas) {
  const r = spawnSync(process.execPath, [path.join(__dirname, s.archivo)], { cwd: __dirname, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60 * 1000 });
  const salida = (r.stdout || '') + (r.stderr || '');
  const fallas = salida.split('\n').filter(l => /^\s*(FAIL|✗|not ok)\b/.test(l)).map(l => l.replace(/^\s*(FAIL|✗|not ok)\s*/, '').trim());
  const resumen = (salida.match(/(\d+)\/(\d+)\s*(?:pruebas OK|PASS)/g) || []).pop() || '(sin línea de resumen)';
  const esConocida = f => (s.conocidas || []).some(c => f.includes(c));
  const malas = fallas.filter(f => !esConocida(f)), conocidasAca = fallas.filter(esConocida);
  const sinResumenYError = r.status !== 0 && fallas.length === 0;     // se cayó sin informar fallas: no se esconde
  inesperadas += malas.length + (sinResumenYError ? 1 : 0); conocidas += conocidasAca.length;
  console.log((malas.length || sinResumenYError ? 'FALLA   ' : conocidasAca.length ? 'CONOCIDA ' : 'OK      ') + s.etiqueta + ' · ' + s.archivo + ' · ' + resumen);
  malas.forEach(f => console.log('    ✗ ' + f));
  if (sinResumenYError) console.log('    ✗ el proceso terminó con código ' + r.status + (r.error ? ' (' + r.error.message + ')' : '') + ' sin informar fallas');
  conocidasAca.forEach(f => console.log('    · falla conocida (preexistente): ' + f + '\n      causa: ' + s.motivo));
  if (detalle) console.log(salida.split('\n').map(l => '      | ' + l).join('\n'));
}
console.log('\n' + (inesperadas ? 'HAY FALLAS INESPERADAS: ' + inesperadas : 'Sin fallas inesperadas') + (conocidas ? ' · fallas conocidas preexistentes: ' + conocidas : ''));
process.exit(inesperadas ? 1 : 0);
