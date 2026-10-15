// Prueba de contrato (estática): el número de afiliado figura en la ORDEN médica, tanto en la impresión (HTML) como en el PDF (jsPDF),
// con una única fuente (afiliadoOrden406) para que ambos no diverjan. Ejecutar: node --test
const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs');
const path=require('node:path');
const src=fs.readFileSync(path.join(__dirname,'app.js'),'utf8');
const between=(from,to)=>{const i=src.indexOf(from);assert.notEqual(i,-1,'no se encontró: '+from);const j=src.indexOf(to,i+from.length);assert.notEqual(j,-1,'no se encontró el fin: '+to);return src.slice(i,j);};

test('helper único: sólo para órdenes, usa el nº de afiliado habitual (o el campo antiguo) y devuelve vacío si no hay',()=>{
  const h=between('function afiliadoOrden406(d,p){','\n  }\n');
  assert.match(h,/if\(!d\|\|d\.tipo!=='orden'\)return '';/);
  assert.match(h,/String\(p\?\.numeroAfiliadoHabitual\|\|p\?\.numeroAfiliado\|\|''\)\.trim\(\)/);
});

test('la impresión HTML y el PDF agregan "N.º de afiliado" junto a DNI y cobertura usando el helper; la impresión escapa el valor',()=>{
  assert.match(src,/<div class="meta">DNI \$\{esc406\(p\.dni\|\|d\.dni\|\|'s\/d'\)\}\$\{p\.coberturaHabitual\?' · '\+esc406\(p\.coberturaHabitual\):''\}\$\{afiliadoOrden406\(d,p\)\?' · N\.º de afiliado '\+esc406\(afiliadoOrden406\(d,p\)\):''\}<\/div>/);
  assert.match(src,/pdf\.text\('DNI '\+\(p\.dni\|\|d\.dni\|\|'s\/d'\)\+\(p\.coberturaHabitual\?' · '\+p\.coberturaHabitual:''\)\+\(afiliadoOrden406\(d,p\)\?' · N\.º de afiliado '\+afiliadoOrden406\(d,p\):''\),mX\+3,y\+boxH\/2\+3\.5\);/);
  assert.equal((src.match(/afiliadoOrden406\(/g)||[]).length,1+2+2+0,'el helper se usa en los dos renderers y nada más');
});
