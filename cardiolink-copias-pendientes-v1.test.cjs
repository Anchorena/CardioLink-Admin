// Contrato de la integración Copias para facturación → Pendientes (sin app.js ni SQL). Ejecutar: node --test
const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs');
const path=require('node:path');
const leer=f=>fs.readFileSync(path.join(__dirname,f),'utf8');
const src=leer('cardiolink-copias-facturacion-v1.js');
const bloque=src.slice(src.indexOf('Integración con Pendientes'),src.indexOf('Enganches (sin tocar app.js)'));

test('la integración vive solo en el módulo de Copias: no hay tablas/campos nuevos ni se escribe copiaImpresa a mano',()=>{
  assert.ok(bloque.length>1000);
  assert.doesNotMatch(bloque,/copiaImpresa\s*=/,'el cierre usa resolverPendiente383, nunca asigna copiaImpresa directamente');
  assert.doesNotMatch(bloque,/\.(insert|update|upsert|delete)\(/,'el bloque de Pendientes solo lee');
  assert.match(bloque,/resolver\(id, 'copia'\)/);
  assert.match(bloque,/pendientes\(a\)\.includes\('copia'\)/,'idempotente: no vuelve a cerrar ni a auditar');
});
test('vínculo por atención y por prestación; copia sin vincular o de otra prestación no cambia el pendiente',()=>{
  assert.match(bloque,/\.in\('attention_id', lote\)/);
  assert.match(bloque,/f\.copy_type === tipo/);
  assert.match(bloque,/if \(!id\) return \{ ok: true, omitido: 'sin_vinculo' \}/);
  assert.match(bloque,/sigue el amarillo/);
});
test('observador sin bucles: solo hijos directos, debounce, un lote y caché con TTL (también para los "sin copia")',()=>{
  assert.match(bloque,/observe\(box, \{ childList: true \}\)/);
  assert.doesNotMatch(bloque,/subtree:\s*true/);
  assert.match(bloque,/clearTimeout\(timerPend\)/);
  assert.match(bloque,/procesandoPend/);
  assert.match(bloque,/TTL_PEND_MS/);
  assert.match(bloque,/:not\(\[data-copias-v1\]\)/);
  assert.match(bloque,/i \+= 100/);
});
test('Deshacer se oculta en este flujo y "Marcar impreso" sigue siendo explícito; un fallo parcial se informa y se reintenta sin reimprimir',()=>{
  assert.match(bloque,/ocultarDeshacer\(\);/);
  assert.match(src,/b\('Marcar impreso'/);
  assert.match(src,/registrarImpresion\(f\.id, 'marcar_impreso'\);[\s\S]{0,400}cerrarPendienteCopia\(f\.attention_id, f\.copy_type\)/);
  assert.match(src,/No se registró ninguna impresión nueva/);
  assert.match(bloque,/Copia impresa · cerrar pendiente/);
  assert.match(bloque,/abrirCopia\(fila\)/,'el chip verde abre la copia correspondiente');
});
test('la caché de Pendientes se invalida al subir, eliminar y marcar impreso',()=>{
  assert.match(src,/cacheAtencion\.delete\(String\(st\.atencionId \|\| ''\)\);\s*invalidarPendientes\(\);/);
  assert.match(src,/rutas\.delete\(fila\.id\);\s*invalidarPendientes\(\);/);
  assert.match(src,/invalidarPendientes\(\);\s*await cargarLista\(\);/);
});
test('app.js, SQL, Cobros, Caja y Finanzas no se tocan; versiones nuevas publicadas',()=>{
  assert.match(leer('index.html'),/cardiolink-copias-facturacion-v1\.js\?v=2-pendientes/);
  assert.match(leer('index.html'),/cardiolink-copias-facturacion-v1\.css\?v=2-pendientes/);
  assert.match(leer('sw.js'),/const CACHE='cardiolink-v4\.1\.0-persistencia-r1'/);
  assert.match(leer('cardiolink-copias-facturacion-v1.css'),/\.p-copia-subida/);
});
