'use strict';
// Regresión: aceptarFichasEnBase (cardiolink-config-concurrencia-v1.js) usaba `n` sin declararla (`..., n = 0;` tras el forEach): en modo estricto lanzaba
// «ReferenceError: n is not defined» en cada carga y la configuración nunca recibía «fichas adoptadas, no son ediciones». La prueba anterior corría el tramo SIN el
// 'use strict' del módulo (por eso no lo veía): acá se ejecuta EN MODO ESTRICTO, como en el navegador.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'cardiolink-config-concurrencia-v1.js'), 'utf8');
let ok = 0, fail = 0; const pendientes = []; const t = (n, f) => pendientes.push([n, f]);
function tramo(ini, fin) { const a = SRC.indexOf(ini), b = SRC.indexOf(fin, a + 1); assert.ok(a >= 0 && b > a, 'no se encontró ' + ini); return SRC.slice(a, b); }
function cargar(data) {
  const ctx = { data, JSON, Object, Array, String }; vm.createContext(ctx);
  vm.runInContext("'use strict';\n" + tramo('  var CAMPOS_FICHA_BASE', '  function aceptarFichas(ids)') + '\nthis.f = aceptarFichasEnBase;', ctx);
  return ctx.f;
}
t('A · el módulo es estricto (la prueba es válida): una variable sin declarar lanzaría ReferenceError', () => {
  assert.match(SRC, /\(function \(\) \{\s*'use strict';/);
  assert.throws(() => vm.runInContext("'use strict'; (function(){ var s = {}; [1].forEach(function(){}), zz = 0; })()", vm.createContext({})), /zz is not defined/);
});
t('B · EN MODO ESTRICTO aceptarFichasEnBase no lanza y devuelve la cantidad de fichas tomadas como base', () => {
  const f = cargar({ pacientes: [{ id: 'p1', nombreCompleto: 'Ana', telefono: '2', actualizadoEn: 'T2' }, { id: 'p9', nombreCompleto: 'Nueva desde tabla' }] });
  const base = { pacientes: [{ id: 'p1', nombreCompleto: 'Ana', telefono: '1', actualizadoEn: 'T1' }] };
  let n; assert.doesNotThrow(() => { n = f(base, ['p1', 'p9']); });
  assert.equal(typeof n, 'number'); assert.ok(n >= 2);
  assert.equal(base.pacientes[0].telefono, '2'); assert.equal(base.pacientes.find((p) => p.id === 'p9').nombreCompleto, 'Nueva desde tabla');
});
t('C · sin ids o sin base no hace nada (devuelve 0) y una ficha ajena a los ids no se toca', () => {
  const f = cargar({ pacientes: [{ id: 'p1', telefono: '2' }, { id: 'p5', telefono: 'edición real' }] });
  assert.equal(f(null, ['p1']), 0); assert.equal(f({ pacientes: [] }, []), 0);
  const base = { pacientes: [{ id: 'p5', telefono: 'valor del servidor' }] };
  f(base, ['p1']); assert.equal(base.pacientes.find((p) => p.id === 'p5').telefono, 'valor del servidor');
});
t('D · el cambio es mínimo: `n` se declara junto con `set` y la lógica restante no cambia', () => {
  assert.match(SRC, /var set = \{\}, n = 0; ids\.forEach\(function \(i\) \{ set\[String\(i\)\] = 1; \}\);/);
  assert.doesNotMatch(SRC, /\}\), n = 0;/);
});
(async () => { for (const [n, f] of pendientes) { try { await f(); ok++; console.log('  OK  ' + n); } catch (e) { fail++; console.log('FALLA ' + n + '\n      ' + (e && e.message || e)); } }
  console.log('\nconfig-concurrencia-aceptar-fichas-v1: ' + ok + '/' + (ok + fail) + ' pruebas OK'); if (fail) process.exitCode = 1; })();
