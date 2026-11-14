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

test('helper de render: orden, certificado, reposo y constancia; sólo con cobertura (no Particular) y el número habitual vigente, nunca el historial',()=>{
  const h=between('function afiliadoDocumento406(d,p){','\n  }\n');
  assert.match(src,/const TIPOS_CON_AFILIADO406=\['orden','certificado','reposo_laboral','constancia_atencion'\];/);
  assert.match(h,/TIPOS_CON_AFILIADO406\.includes\(d\.tipo\)/);
  assert.match(h,/!cobertura\|\|cobertura\.toLowerCase\(\)==='particular'\)return ''/);
  assert.match(h,/const habitual=String\(p\?\.numeroAfiliadoHabitual\|\|''\)\.trim\(\);/);
  assert.match(h,/String\(a\.pacienteId\|\|''\)===pid&&igual\(a\.coberturaAtencion\|\|a\.obraSocial\)/,'la atención debe ser del mismo paciente y de la misma cobertura');
  assert.ok(!/historialCoberturas|numeroAfiliado\b/.test(h),'no mezcla el historial ni el campo antiguo');
});

test('la impresión HTML y el PDF agregan "N.º de afiliado" junto a DNI y cobertura usando el helper; la impresión escapa el valor',()=>{
  assert.match(src,/\$\{afiliadoDocumento406\(d,p\)\?' · N\.º de afiliado '\+esc406\(afiliadoDocumento406\(d,p\)\):''\}<\/div>/);
  assert.match(src,/<div class="meta"\$\{TIPOS_CON_AFILIADO406\.includes\(d\.tipo\)\?' data-afiliado-resuelto="1"':''\}>DNI /);
  assert.match(src,/\(afiliadoDocumento406\(d,p\)\?' · N\.º de afiliado '\+afiliadoDocumento406\(d,p\):''\)/);
  assert.equal((src.match(/afiliadoDocumento406\(/g)||[]).length,1+2+2,'el helper de render se usa en los dos renderers');
  assert.equal((src.match(/afiliadoOrden406\(/g)||[]).length,1+1,'afiliadoOrden406 queda sólo para la huella (documentos ya emitidos no cambian de versión)');
});

test('el parche de impresión no vuelve a agregar un número de otra fuente cuando la app ya lo resolvió',()=>{
  const patch=fs.readFileSync(path.join(__dirname,'cardiolink-informe-afiliado.js'),'utf8');
  assert.match(patch,/meta\.getAttribute\('data-afiliado-resuelto'\) === '1'\) return;/);
});

test('especialidades de Rogelio: se leen de lo persistido (catálogo + area), sin lista fija; guardar el perfil sincroniza area; la huella no cambia',()=>{
  assert.ok(!/ESPECIALIDADES_FIJAS406|else if\(p\.id==='rogelio'\)/.test(src),'no hay especialidades hardcodeadas ni sembrado forzado');
  assert.match(src,/const PERFILES_ESPECIALIDAD_EN_AREA406=\['rogelio'\];/);
  assert.match(src,/if\(faltantesArea\.length\)p\.area=\[p\.area\]\.filter\(Boolean\)\.concat\(faltantesArea\)\.join\(' \/ '\);/);
  assert.match(src,/esp:especialidadesParaHuella406\(pr\),lic,/);
});
