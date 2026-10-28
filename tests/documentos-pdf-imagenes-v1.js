'use strict';

// tests/documentos-pdf-imagenes-v1.js
// Logo y firma/sello del PDF de documentos: se dibujan dentro de una caja conservando la proporción de la imagen (antes: tamaño fijo 14x14 mm para el logo y
// 30x10 mm para la firma, que aplastaba o estiraba cualquier imagen con otra proporción). Ejecuta encajarImagen406 REAL de app.js.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const ini = app.indexOf('function encajarImagen406');
const fin = app.indexOf('async function generarPdfBlobDocumento406', ini);
assert.ok(ini > 0 && fin > ini);
const H = new Function(app.slice(ini, fin) + '\nreturn {encajarImagen406,cajaImagenPdf406};')();

const casos = [];
function caso(n, f) { casos.push([n, f]); }
const casi = (a, b) => Math.abs(a - b) < 1e-9;

caso('imagen apaisada en caja apaisada: ocupa el ancho y conserva la proporción', () => {
  const r = H.encajarImagen406(600, 200, 38, 12);   // 3:1 en 38x12 (firma A5)
  assert.ok(casi(r.w / r.h, 3));
  assert.ok(r.w <= 38 + 1e-9 && r.h <= 12 + 1e-9);
  assert.ok(casi(r.dx, (38 - r.w) / 2) && casi(r.dy, (12 - r.h) / 2));
});
caso('imagen muy ancha: limita por ancho y se centra en vertical', () => {
  const r = H.encajarImagen406(1000, 100, 38, 12);
  assert.ok(casi(r.w, 38) && casi(r.h, 3.8) && casi(r.dy, (12 - 3.8) / 2));
});
caso('imagen cuadrada en caja apaisada: limita por alto y se centra en horizontal', () => {
  const r = H.encajarImagen406(300, 300, 22.4, 14);
  assert.ok(casi(r.w, 14) && casi(r.h, 14) && casi(r.dx, (22.4 - 14) / 2));
});
caso('imagen alta (retrato): conserva la proporción', () => {
  const r = H.encajarImagen406(200, 400, 30, 10);
  assert.ok(casi(r.h, 10) && casi(r.w, 5) && casi(r.w / r.h, 0.5));
});
caso('nunca deforma: la proporción dibujada = la proporción de la imagen', () => {
  for (const [iw, ih] of [[640, 213], [100, 100], [1200, 300], [90, 400], [333, 111]]) {
    const r = H.encajarImagen406(iw, ih, 38, 12);
    assert.ok(Math.abs(r.w / r.h - iw / ih) < 1e-9, iw + 'x' + ih);
  }
});
caso('dimensiones inválidas: cae a la caja completa (comportamiento anterior) sin romper', () => {
  assert.equal(JSON.stringify(H.encajarImagen406(0, 0, 38, 12)), JSON.stringify({ w: 38, h: 12, dx: 0, dy: 0 }));
  const r = H.cajaImagenPdf406({ getImageProperties() { throw new Error('x'); } }, 'data:', 38, 12);
  assert.equal(r.w, 38); assert.equal(r.h, 12);
});
caso('getImageProperties de jsPDF se usa para medir la imagen', () => {
  const r = H.cajaImagenPdf406({ getImageProperties() { return { width: 600, height: 200 }; } }, 'data:', 38, 12);
  assert.ok(casi(r.w / r.h, 3));
});
caso('estático: el generador ya no fuerza tamaños fijos para logo y firma', () => {
  assert.ok(!app.includes('mX,y-2,logoSize,logoSize'), 'logo con tamaño fijo cuadrado');
  assert.ok(!app.includes('sigY-11,30,10'), 'firma con tamaño fijo 30x10');
  assert.ok(app.includes('cajaImagenPdf406(pdf,imgData,logoSize*1.6,logoSize)'));
  assert.ok(app.includes('cajaImagenPdf406(pdf,sigData,bw,bh)'));
});

(async () => {
  let fallos = 0;
  for (const [n, f] of casos) {
    try { await f(); console.log('PASS ' + n); } catch (e) { fallos++; console.log('FAIL ' + n + '\n     ' + (e && e.message)); }
  }
  console.log(`\n${casos.length - fallos}/${casos.length} PASS`);
  if (fallos) process.exit(1);
})();
