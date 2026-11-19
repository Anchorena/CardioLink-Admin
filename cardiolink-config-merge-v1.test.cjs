'use strict';
// Persistencia V1 / R2B · pruebas unitarias del motor de fusión de tres vías (módulo independiente, sin app.js ni Supabase).
// Ejecutar: node --test cardiolink-config-merge-v1.test.cjs
const test = require('node:test');
const assert = require('node:assert');
const M = require('./cardiolink-config-merge-v1.js');

const clon = (o) => JSON.parse(JSON.stringify(o));
const fus = (b, l, r, o) => M.fusionar(b, l, r, o);
const cfg = (extra) => Object.assign({
  pacientes: [
    { id: 'p1', nombreCompleto: 'Ana Pérez', dni: '100', telefono: '111', fechaNacimiento: '1980-01-01', coberturaHabitual: 'OSDE' },
    { id: 'p2', nombreCompleto: 'Juan Gómez', dni: '200', telefono: '222', fechaNacimiento: '1970-02-02', coberturaHabitual: 'Particular' }
  ],
  arancelesPorProfesional: { matias: [
    { id: 'a1', obraSocial: 'OSDE', prestacion: 'Consulta', valor: 1000, copago: 0 },
    { id: 'a2', obraSocial: 'Swiss', prestacion: 'Consulta', valor: 2000, copago: 100 }
  ] },
  conveniosPorProfesional: { matias: [
    { obraSocial: 'OSDE', regla: 'OSDE', activo: true },
    { obraSocial: 'Swiss', regla: 'GENERAL', activo: true }
  ] },
  obrasSociales: ['OSDE', 'Swiss', 'Particular'],
  reglasOS: { OSDE: 'OSDE', PAMI: 'COBERTURA' },
  profesionales: [{ id: 'matias', nombre: 'Dr. M', prestaciones: ['Consulta', 'ECG'], valores: { consulta: 35000, copago: 0 } }],
  auditoriaPacientes: [{ tipo: 'fusion_paciente', principalId: 'p1', duplicadoId: 'p9', fecha: '2026-01-01T00:00:00Z' }],
  listaRara: [1, 2, 3]
}, extra || {});
const conPac = (c, id, cambios) => { const o = clon(c); Object.assign(o.pacientes.find((p) => p.id === id), cambios); return o; };
const conAr = (c, id, cambios) => { const o = clon(c); Object.assign(o.arancelesPorProfesional.matias.find((a) => a.id === id), cambios); return o; };

test('sin cambios: resultado idéntico, sin conflictos', () => {
  const b = cfg(); const r = fus(b, clon(b), clon(b));
  assert.equal(r.ok, true); assert.deepStrictEqual(r.config, b); assert.equal(r.conflictos.length, 0);
});

test('sólo cambia el local / sólo cambia el remoto', () => {
  const b = cfg(); const l = conPac(b, 'p1', { telefono: '999' });
  assert.deepStrictEqual(fus(b, l, clon(b)).config, l);
  assert.deepStrictEqual(fus(b, clon(b), l).config, l);
});

test('pacientes diferentes: se conservan ambos cambios', () => {
  const b = cfg(); const l = conPac(b, 'p1', { telefono: '999' }); const r = conPac(b, 'p2', { telefono: '888' });
  const m = fus(b, l, r); assert.equal(m.ok, true);
  assert.equal(m.config.pacientes.find((p) => p.id === 'p1').telefono, '999');
  assert.equal(m.config.pacientes.find((p) => p.id === 'p2').telefono, '888');
});

test('campos diferentes del MISMO paciente: se conservan ambos', () => {
  const b = cfg(); const l = conPac(b, 'p1', { telefono: '999' }); const r = conPac(b, 'p1', { fechaNacimiento: '1981-05-05' });
  const m = fus(b, l, r); assert.equal(m.ok, true);
  const p = m.config.pacientes.find((x) => x.id === 'p1');
  assert.equal(p.telefono, '999'); assert.equal(p.fechaNacimiento, '1981-05-05'); assert.equal(p.dni, '100');
});

test('mismo campo del mismo paciente con valores distintos: conflicto de campo con ruta legible; conserva lo local', () => {
  const b = cfg(); const l = conPac(b, 'p1', { telefono: '999' }); const r = conPac(b, 'p1', { telefono: '888' });
  const m = fus(b, l, r); assert.equal(m.ok, false); assert.equal(m.conflictos.length, 1);
  const c = m.conflictos[0];
  assert.equal(c.tipo, 'campo'); assert.equal(c.ruta, 'pacientes[p1].telefono'); assert.equal(c.base, '111'); assert.equal(c.local, '999'); assert.equal(c.remoto, '888');
  assert.equal(m.config.pacientes.find((p) => p.id === 'p1').telefono, '999');
});

test('mismo valor en ambos lados: no es conflicto', () => {
  const b = cfg(); const m = fus(b, conPac(b, 'p1', { telefono: '999' }), conPac(b, 'p1', { telefono: '999' }));
  assert.equal(m.ok, true);
});

test('aranceles diferentes: ambos persisten; el mismo arancel y campo: conflicto', () => {
  const b = cfg();
  const m = fus(b, conAr(b, 'a1', { valor: 1500 }), conAr(b, 'a2', { valor: 2500 }));
  assert.equal(m.ok, true);
  const L = m.config.arancelesPorProfesional.matias; assert.equal(L.find((a) => a.id === 'a1').valor, 1500); assert.equal(L.find((a) => a.id === 'a2').valor, 2500);
  const k = fus(b, conAr(b, 'a1', { valor: 1500 }), conAr(b, 'a1', { valor: 1600 }));
  assert.equal(k.ok, false); assert.equal(k.conflictos[0].ruta, 'arancelesPorProfesional.matias[a1].valor');
  const o = fus(b, conAr(b, 'a1', { valor: 1500 }), conAr(b, 'a1', { copago: 50 })); assert.equal(o.ok, true);   // campos distintos del mismo arancel
  assert.equal(o.config.arancelesPorProfesional.matias[0].valor, 1500); assert.equal(o.config.arancelesPorProfesional.matias[0].copago, 50);
});

test('Dueño modifica un arancel y Secretaría un paciente (claves distintas)', () => {
  const b = cfg(); const m = fus(b, conAr(b, 'a1', { valor: 1200 }), conPac(b, 'p2', { telefono: '777' }));
  assert.equal(m.ok, true);
  assert.equal(m.config.arancelesPorProfesional.matias[0].valor, 1200); assert.equal(m.config.pacientes[1].telefono, '777');
});

test('altas simultáneas con ids distintos: se conservan ambas; las que eran últimas se agregan al final', () => {
  const b = cfg(); const l = clon(b); l.pacientes.push({ id: 'pL', nombreCompleto: 'Local' }); const r = clon(b); r.pacientes.push({ id: 'pR', nombreCompleto: 'Remoto' });
  const m = fus(b, l, r); assert.equal(m.ok, true);
  assert.deepStrictEqual(m.config.pacientes.map((p) => p.id), ['p1', 'p2', 'pR', 'pL']);
});

test('altas con el MISMO id y contenido distinto: conflicto de identidad (no fusiona campo a campo)', () => {
  const b = cfg(); const l = clon(b); l.pacientes.push({ id: 'pX', nombreCompleto: 'Uno', dni: '1' }); const r = clon(b); r.pacientes.push({ id: 'pX', nombreCompleto: 'Dos', telefono: '2' });
  const m = fus(b, l, r); assert.equal(m.ok, false); assert.equal(m.conflictos.length, 1);
  assert.equal(m.conflictos[0].tipo, 'identidad'); assert.equal(m.conflictos[0].ruta, 'pacientes[pX]');
  const x = m.config.pacientes.find((p) => p.id === 'pX'); assert.deepStrictEqual(x, { id: 'pX', nombreCompleto: 'Uno', dni: '1' });   // sin mezcla
});

test('altas con el mismo id y contenido idéntico: sin conflicto', () => {
  const b = cfg(); const e = { id: 'pX', nombreCompleto: 'Igual' }; const l = clon(b); l.pacientes.push(clon(e)); const r = clon(b); r.pacientes.push(clon(e));
  const m = fus(b, l, r); assert.equal(m.ok, true); assert.equal(m.config.pacientes.filter((p) => p.id === 'pX').length, 1);
});

test('eliminación remota de una entidad que el local no tocó: queda eliminada (no se resucita)', () => {
  const b = cfg(); const r = clon(b); r.pacientes = r.pacientes.filter((p) => p.id !== 'p2'); const l = conPac(b, 'p1', { telefono: '999' });
  const m = fus(b, l, r); assert.equal(m.ok, true);
  assert.deepStrictEqual(m.config.pacientes.map((p) => p.id), ['p1']); assert.equal(m.config.pacientes[0].telefono, '999');
});

test('eliminación local de una entidad que el remoto no tocó: se elimina', () => {
  const b = cfg(); const l = clon(b); l.pacientes = l.pacientes.filter((p) => p.id !== 'p2'); const m = fus(b, l, conPac(b, 'p1', { telefono: '5' }));
  assert.equal(m.ok, true); assert.deepStrictEqual(m.config.pacientes.map((p) => p.id), ['p1']);
});

test('eliminada por ambos lados: sigue eliminada, sin conflicto', () => {
  const b = cfg(); const x = clon(b); x.pacientes = x.pacientes.filter((p) => p.id !== 'p2'); const m = fus(b, x, clon(x));
  assert.equal(m.ok, true); assert.equal(m.config.pacientes.length, 1);
});

test('eliminación frente a modificación: conflicto explícito en ambos sentidos', () => {
  const b = cfg(); const borrada = clon(b); borrada.pacientes = borrada.pacientes.filter((p) => p.id !== 'p2'); const mod = conPac(b, 'p2', { telefono: '555' });
  const a = fus(b, borrada, mod); assert.equal(a.ok, false); assert.equal(a.conflictos[0].tipo, 'eliminacion_vs_modificacion'); assert.equal(a.conflictos[0].localAusente, true);
  const c = fus(b, mod, borrada); assert.equal(c.ok, false); assert.equal(c.conflictos[0].remotoAusente, true);
  assert.equal(c.config.pacientes.find((p) => p.id === 'p2').telefono, '555');   // se conserva lo local
});

test('archivado (estado/activo) se trata como un campo más: se fusiona con otros cambios', () => {
  const b = cfg(); const l = conPac(b, 'p2', { estado: 'fusionado', activo: false }); const r = conPac(b, 'p2', { telefono: '1' });
  const m = fus(b, l, r); assert.equal(m.ok, true);
  const p = m.config.pacientes.find((x) => x.id === 'p2'); assert.equal(p.estado, 'fusionado'); assert.equal(p.activo, false); assert.equal(p.telefono, '1');
  const k = fus(b, conPac(b, 'p2', { estado: 'fusionado' }), conPac(b, 'p2', { estado: 'activo' })); assert.equal(k.ok, false);
});

test('convenios: identidad exacta por obraSocial; dos convenios distintos se conservan', () => {
  const b = cfg(); const l = clon(b); l.conveniosPorProfesional.matias.push({ obraSocial: 'Galeno', regla: 'G', activo: true });
  const r = clon(b); r.conveniosPorProfesional.matias.push({ obraSocial: 'Medifé', regla: 'M', activo: true });
  const m = fus(b, l, r); assert.equal(m.ok, true);
  assert.deepStrictEqual(m.config.conveniosPorProfesional.matias.map((c) => c.obraSocial), ['OSDE', 'Swiss', 'Medifé', 'Galeno']);
});

test('convenios: nombres parecidos (mayúsculas, tildes, espacios) NO se fusionan: clave ambigua que bloquea la lista', () => {
  const b = cfg(); const l = clon(b); l.conveniosPorProfesional.matias.push({ obraSocial: 'Medifé', regla: 'M1' });
  const r = clon(b); r.conveniosPorProfesional.matias.push({ obraSocial: 'MEDIFE ', regla: 'M2' });
  const lm = clon(l); lm.conveniosPorProfesional.matias.push({ obraSocial: 'medife', regla: 'M3' });   // local con dos parecidos
  let m = fus(b, lm, r); assert.equal(m.ok, false); assert.equal(m.conflictos[0].tipo, 'clave_ambigua'); assert.equal(m.conflictos[0].ruta, 'conveniosPorProfesional.matias');
  // un parecido en cada lado: «Medifé» y «MEDIFE » son claves distintas -> sin similitud entre listas no hay unión: ambas altas coexisten sólo si no colisionan dentro de la misma lista
  m = fus(b, l, r); assert.equal(m.ok, true); assert.equal(m.config.conveniosPorProfesional.matias.length, 4);
});

test('convenios: claves duplicadas dentro de una lista bloquean la fusión (no se elige una)', () => {
  const b = cfg(); const l = clon(b); l.conveniosPorProfesional.matias.push({ obraSocial: 'OSDE', regla: 'DUP' }); const r = conPac(b, 'p1', { telefono: '9' }); r.conveniosPorProfesional.matias[1].activo = false;
  const m = fus(b, l, r); assert.equal(m.ok, false); assert.equal(m.conflictos[0].tipo, 'clave_duplicada');
  assert.ok(m.conflictos[0].problemas.some((p) => p.lado === 'local' && p.clave === 'OSDE'));
});

test('convenios: sin obraSocial utilizable → clave ambigua', () => {
  const b = cfg(); const l = clon(b); l.conveniosPorProfesional.matias.push({ regla: 'X' }); const r = clon(b); r.conveniosPorProfesional.matias[0].activo = false;
  const m = fus(b, l, r); assert.equal(m.ok, false); assert.equal(m.conflictos[0].tipo, 'clave_ambigua');
});

test('convenio: dos sesiones modifican campos distintos del mismo convenio y el mismo campo con distinto valor', () => {
  const b = cfg(); const mod = (c, campo, v) => { const o = clon(c); o.conveniosPorProfesional.matias[0][campo] = v; return o; };
  assert.equal(fus(b, mod(b, 'regla', 'X'), mod(b, 'activo', false)).ok, true);
  const k = fus(b, mod(b, 'regla', 'X'), mod(b, 'regla', 'Y')); assert.equal(k.ok, false); assert.equal(k.conflictos[0].ruta, 'conveniosPorProfesional.matias[OSDE].regla');
});

test('listas desconocidas: bloque (conflicto si ambos cambiaron distinto; sin inventar fusión)', () => {
  const b = cfg(); const l = clon(b); l.listaRara.push(4); const r = clon(b); r.listaRara.push(5);
  const m = fus(b, l, r); assert.equal(m.ok, false); assert.equal(m.conflictos[0].tipo, 'bloque'); assert.deepStrictEqual(m.config.listaRara, [1, 2, 3, 4]);
  const solo = fus(b, l, clon(b)); assert.equal(solo.ok, true); assert.deepStrictEqual(solo.config.listaRara, [1, 2, 3, 4]);
  const ig = fus(b, l, clon(l)); assert.equal(ig.ok, true);
});

test('listas desconocidas anidadas en una entidad también son bloque', () => {
  const b = cfg(); b.pacientes[0].otraLista = [{ os: 'A' }];
  const l = clon(b); l.pacientes[0].otraLista.push({ os: 'B' }); const r = clon(b); r.pacientes[0].otraLista.push({ os: 'C' });
  const m = fus(b, l, r); assert.equal(m.ok, false); assert.equal(m.conflictos[0].ruta, 'pacientes[p1].otraLista'); assert.equal(m.conflictos[0].tipo, 'bloque');
});

test('conjuntos (obras sociales, prestaciones): altas y bajas independientes, sin duplicar', () => {
  const b = cfg(); const l = clon(b); l.obrasSociales.push('Galeno'); l.obrasSociales = l.obrasSociales.filter((x) => x !== 'Particular');
  const r = clon(b); r.obrasSociales.push('Medifé'); r.obrasSociales.push('Galeno');
  const m = fus(b, l, r); assert.equal(m.ok, true);
  assert.deepStrictEqual(m.config.obrasSociales, ['OSDE', 'Swiss', 'Medifé', 'Galeno']);
  const p = clon(b); p.profesionales[0].prestaciones.push('Holter'); const q = clon(b); q.profesionales[0].prestaciones = ['Consulta'];
  assert.deepStrictEqual(fus(b, p, q).config.profesionales[0].prestaciones, ['Consulta', 'Holter']);
});

test('conjuntos: una baja remota no se resucita aunque el local no la tocó', () => {
  const b = cfg(); const r = clon(b); r.obrasSociales = r.obrasSociales.filter((x) => x !== 'Swiss'); const l = clon(b); l.obrasSociales.push('Galeno');
  assert.deepStrictEqual(fus(b, l, r).config.obrasSociales, ['OSDE', 'Particular', 'Galeno']);
});

test('conjuntos con elementos no primitivos → bloque', () => {
  const b = cfg(); b.motivosConsulta = [{ a: 1 }]; const l = clon(b); l.motivosConsulta.push({ a: 2 }); const r = clon(b); r.motivosConsulta.push({ a: 3 });
  assert.equal(fus(b, l, r).conflictos[0].tipo, 'bloque');
});

test('auditoría: se preservan las entradas de ambos lados, sin duplicar las idénticas', () => {
  const b = cfg(); const e1 = { tipo: 'fusion_paciente', principalId: 'p2', duplicadoId: 'p8', fecha: '2026-02-01T00:00:00Z' }; const e2 = { tipo: 'fusion_paciente', principalId: 'p3', duplicadoId: 'p7', fecha: '2026-03-01T00:00:00Z' };
  const l = clon(b); l.auditoriaPacientes.push(clon(e1)); const r = clon(b); r.auditoriaPacientes.push(clon(e1)); r.auditoriaPacientes.push(clon(e2));
  const m = fus(b, l, r); assert.equal(m.ok, true); assert.equal(m.config.auditoriaPacientes.length, 3);
  assert.deepStrictEqual(m.config.auditoriaPacientes.map((x) => x.principalId), ['p1', 'p2', 'p3']);
  const mismoOrden = { ...e1, fecha: e1.fecha }; mismoOrden.tipo = 'fusion_paciente';
  const d = clon(b); d.auditoriaPacientes.push(clon(mismoOrden)); d.auditoriaPacientes.push(clon(mismoOrden));   // dos entradas idénticas legítimas en un lado
  const rr = clon(b); rr.auditoriaPacientes.push(clon(mismoOrden));
  assert.equal(fus(b, d, rr).config.auditoriaPacientes.length, 3);
});

test('auditoría: una entrada de la base que ambos lados quitaron se preserva (nunca se pierde)', () => {
  const b = cfg(); const l = clon(b); l.auditoriaPacientes = []; l.auditoriaPacientes.push({ tipo: 'nuevo' }); const r = clon(b); r.auditoriaPacientes = [{ tipo: 'otro' }];
  const m = fus(b, l, r); assert.ok(m.config.auditoriaPacientes.some((e) => e.principalId === 'p1')); assert.equal(m.config.auditoriaPacientes.length, 3);
});

test('cero frente a vacío, false, null y ausente NO son equivalentes', () => {
  const b = { profesionales: [{ id: 'm', valores: { copago: 0, activo: true, nota: '', x: null } }] };
  const cambia = (campo, v) => { const o = clon(b); if (v === undefined) delete o.profesionales[0].valores[campo]; else o.profesionales[0].valores[campo] = v; return o; };
  assert.equal(M.hayCambiosLocales(b, cambia('copago', ''), {}), true);
  assert.equal(M.hayCambiosLocales(b, cambia('copago', null), {}), true);
  assert.equal(M.hayCambiosLocales(b, cambia('copago', false), {}), true);
  assert.equal(M.hayCambiosLocales(b, cambia('copago', undefined), {}), true);
  assert.equal(M.hayCambiosLocales(b, cambia('activo', false), {}), true);
  assert.equal(M.hayCambiosLocales(b, cambia('nota', null), {}), true);
  assert.equal(M.hayCambiosLocales(b, cambia('x', undefined), {}), true);
  assert.equal(M.hayCambiosLocales(b, clon(b), {}), false);
  // en la fusión: local 0→'' vs remoto 0→null son cambios distintos del mismo campo → conflicto; 0 local frente a ausente remoto también
  const m = fus(b, cambia('copago', ''), cambia('copago', null)); assert.equal(m.ok, false);
  assert.equal(fus(b, cambia('copago', false), cambia('copago', false)).ok, true);
  assert.equal(fus(b, cambia('copago', 5), cambia('nota', 'n')).ok, true);
  const solo = fus(b, cambia('copago', null), clon(b)); assert.strictEqual(solo.config.profesionales[0].valores.copago, null);
  const ausente = fus(b, cambia('copago', undefined), clon(b)); assert.equal('copago' in ausente.config.profesionales[0].valores, false);
});

test('un cambio de 0 a 0 explícito y de ausente a ausente no genera conflictos ni cambios', () => {
  const b = { a: { n: 0, f: false, s: '' } }; const m = fus(b, clon(b), clon(b)); assert.equal(m.ok, true); assert.deepStrictEqual(m.config, b);
});

test('no modifica los objetos originales (congelados) ni comparte referencias con el resultado', () => {
  const deep = (o) => { Object.freeze(o); Object.keys(o).forEach((k) => { if (o[k] && typeof o[k] === 'object') deep(o[k]); }); return o; };
  const b = deep(cfg()); const l = deep(conPac(cfg(), 'p1', { telefono: '999' })); const r = deep(conPac(cfg(), 'p2', { telefono: '888' }));
  const sb = JSON.stringify(b), sl = JSON.stringify(l), sr = JSON.stringify(r);
  const m = fus(b, l, r); assert.equal(m.ok, true);
  m.config.pacientes[0].telefono = 'MUTADO'; m.config.arancelesPorProfesional.matias.push({ id: 'zz' });
  assert.equal(JSON.stringify(b), sb); assert.equal(JSON.stringify(l), sl); assert.equal(JSON.stringify(r), sr);
  assert.notStrictEqual(m.config.pacientes[1], r.pacientes[1]);
});

test('resolución: sólo cambia el punto conflictivo y se preservan todos los cambios independientes', () => {
  const b = cfg();
  const l = conPac(conAr(b, 'a1', { valor: 1111 }), 'p1', { telefono: '999', fechaNacimiento: '1990-01-01' });
  const r = conPac(conAr(b, 'a2', { valor: 2222 }), 'p1', { telefono: '888' });
  const m = fus(b, l, r); assert.equal(m.ok, false); assert.equal(m.conflictos.length, 1); assert.equal(m.conflictos[0].ruta, 'pacientes[p1].telefono');
  const conLocal = fus(b, l, r, { resoluciones: { 'pacientes[p1].telefono': 'local' } });
  assert.equal(conLocal.ok, true); assert.equal(conLocal.config.pacientes[0].telefono, '999');
  const conRemoto = fus(b, l, r, { resoluciones: { 'pacientes[p1].telefono': 'remoto' } });
  assert.equal(conRemoto.ok, true); assert.equal(conRemoto.config.pacientes[0].telefono, '888');
  [conLocal, conRemoto].forEach((x) => {
    assert.equal(x.config.pacientes[0].fechaNacimiento, '1990-01-01');                   // cambio local independiente
    assert.equal(x.config.arancelesPorProfesional.matias.find((a) => a.id === 'a1').valor, 1111);
    assert.equal(x.config.arancelesPorProfesional.matias.find((a) => a.id === 'a2').valor, 2222);   // cambio remoto independiente
  });
  const sinMatch = fus(b, l, r, { resoluciones: { 'pacientes[p9].telefono': 'local' } }); assert.equal(sinMatch.ok, false);   // una resolución ajena no resuelve nada
});

test('resolución de eliminación vs modificación y de identidad', () => {
  const b = cfg(); const borrada = clon(b); borrada.pacientes = borrada.pacientes.filter((p) => p.id !== 'p2'); const mod = conPac(b, 'p2', { telefono: '555' });
  const a = fus(b, borrada, mod, { resoluciones: { 'pacientes[p2]': 'remoto' } }); assert.equal(a.ok, true); assert.equal(a.config.pacientes.find((p) => p.id === 'p2').telefono, '555');
  const c = fus(b, borrada, mod, { resoluciones: { 'pacientes[p2]': 'local' } }); assert.equal(c.ok, true); assert.equal(c.config.pacientes.some((p) => p.id === 'p2'), false);
  const l = clon(b); l.pacientes.push({ id: 'pX', n: 1 }); const r = clon(b); r.pacientes.push({ id: 'pX', n: 2 });
  assert.equal(fus(b, l, r, { resoluciones: { 'pacientes[pX]': 'remoto' } }).config.pacientes.find((p) => p.id === 'pX').n, 2);
});

test('resolución de una lista bloqueada (clave duplicada) elige el lado completo', () => {
  const b = cfg(); const l = clon(b); l.conveniosPorProfesional.matias.push({ obraSocial: 'OSDE', regla: 'DUP' }); const r = clon(b); r.conveniosPorProfesional.matias[1].activo = false;
  const m = fus(b, l, r, { resoluciones: { 'conveniosPorProfesional.matias': 'remoto' } }); assert.equal(m.ok, true); assert.equal(m.config.conveniosPorProfesional.matias.length, 2);
});

test('normalización neutra: lo que sólo coincide con normalizar(base) no se toma como cambio del usuario', () => {
  const b = { reglasOS: { OSDE: 'GENERAL' }, obrasSociales: ['OSDE'], pacientes: [{ id: 'p1', telefono: '1' }] };
  const normalizar = (c) => { const o = clon(c); o.reglasOS.OSDE = 'OSDE'; if (!o.obrasSociales.includes('Otra')) o.obrasSociales.push('Otra'); return o; };
  const neutro = normalizar(b); const local = normalizar(b);                                 // el usuario no editó nada
  const remoto = clon(b); remoto.reglasOS.OSDE = 'REGLA_REAL'; remoto.obrasSociales = ['OSDE', 'Galeno'];   // otra sesión editó legítimamente
  assert.equal(M.hayCambiosLocales(b, local, { neutro }), false);
  assert.equal(M.hayCambiosLocales(b, local), true);
  const m = fus(b, local, remoto, { neutro }); assert.equal(m.ok, true);
  assert.equal(m.config.reglasOS.OSDE, 'REGLA_REAL');                                          // la normalización no pisa el valor legítimo del servidor
  assert.deepStrictEqual(m.config.obrasSociales, ['OSDE', 'Galeno']);                          // ni re-agrega 'Otra'
  const sinNeutro = fus(b, local, remoto); assert.equal(sinNeutro.ok, false);                  // sin neutro, la normalización choca (demuestra el problema)
});

test('normalización neutra: un cambio REAL del usuario sobre una clave normalizada sí se conserva', () => {
  const b = { reglasOS: { OSDE: 'GENERAL', PAMI: 'X' }, pacientes: [{ id: 'p1', telefono: '1' }] };
  const normalizar = (c) => { const o = clon(c); o.reglasOS.OSDE = 'OSDE'; return o; };
  const neutro = normalizar(b); const local = normalizar(b); local.pacientes[0].telefono = '9'; local.reglasOS.PAMI = 'Y';
  const remoto = clon(b); remoto.reglasOS.OSDE = 'REGLA_REAL';
  const m = fus(b, local, remoto, { neutro }); assert.equal(m.ok, true);
  assert.equal(m.config.pacientes[0].telefono, '9'); assert.equal(m.config.reglasOS.PAMI, 'Y'); assert.equal(m.config.reglasOS.OSDE, 'REGLA_REAL');
  assert.equal(M.hayCambiosLocales(b, local, { neutro }), true);
});

test('normalización neutra en entidades: un elemento agregado por la normalización no se sube', () => {
  const b = { arancelesPorProfesional: { m: [{ id: 'a1', valor: 1 }] }, profesionales: [{ id: 'm', prestaciones: ['Consulta'] }] };
  const normalizar = (c) => { const o = clon(c); o.profesionales[0].prestaciones.push('ECG'); return o; };
  const neutro = normalizar(b); const local = normalizar(b); local.arancelesPorProfesional.m[0].valor = 2;
  assert.equal(M.hayCambiosLocales(b, local, { neutro }), true);
  const m = fus(b, local, clon(b), { neutro }); assert.deepStrictEqual(m.config.profesionales[0].prestaciones, ['Consulta']); assert.equal(m.config.arancelesPorProfesional.m[0].valor, 2);
});

test('hayCambiosLocales: sin cambios reales no hay que escribir; con cambio sí', () => {
  const b = cfg(); assert.equal(M.hayCambiosLocales(b, clon(b)), false);
  assert.equal(M.hayCambiosLocales(b, conPac(b, 'p1', { telefono: '0' })), true);
  const reordenado = clon(b); reordenado.pacientes.reverse(); assert.equal(M.hayCambiosLocales(b, reordenado), true);   // el orden de una lista es un cambio
  const clavesOtroOrden = {}; Object.keys(b).reverse().forEach((k) => { clavesOtroOrden[k] = clon(b[k]); }); assert.equal(M.hayCambiosLocales(b, clavesOtroOrden), false);   // el orden de claves no
});

test('claves no registradas: objetos se fusionan por clave; valores sueltos distintos → conflicto', () => {
  const b = { reglasOS: { A: '1', B: '2' }, brandingCardioLink: { nombre: 'X', slogan: 'Y' } };
  const l = clon(b); l.reglasOS.A = '9'; l.brandingCardioLink.nombre = 'L'; const r = clon(b); r.reglasOS.B = '8'; r.brandingCardioLink.slogan = 'R';
  const m = fus(b, l, r); assert.equal(m.ok, true); assert.deepStrictEqual(m.config.reglasOS, { A: '9', B: '8' }); assert.deepStrictEqual(m.config.brandingCardioLink, { nombre: 'L', slogan: 'R' });
  const rr = clon(b); rr.reglasOS.A = '7'; assert.equal(fus(b, l, rr).conflictos[0].ruta, 'reglasOS.A');
  const ambos = fus({}, { reglasOS: { Z: '1' } }, { reglasOS: { Z: '2' } }); assert.equal(ambos.conflictos[0].ruta, 'reglasOS.Z');
});

test('mapa de entidades: dos altas distintas del mismo identificador → identidad; resumen clínico por paciente', () => {
  const b = { resumenesClinicos: {} }; const l = { resumenesClinicos: { p1: { antecedentes: 'a' } } }; const r = { resumenesClinicos: { p1: { antecedentes: 'b' } } };
  const m = fus(b, l, r); assert.equal(m.conflictos[0].tipo, 'identidad'); assert.equal(m.conflictos[0].ruta, 'resumenesClinicos.p1');
  const ok = fus(b, l, { resumenesClinicos: { p2: { antecedentes: 'b' } } }); assert.equal(ok.ok, true); assert.deepStrictEqual(Object.keys(ok.config.resumenesClinicos).sort(), ['p1', 'p2']);
});

test('tipos distintos (objeto vs arreglo, número vs cadena) → conflicto de campo', () => {
  const b = { x: 1 }; assert.equal(fus(b, { x: '1' }, { x: 2 }).conflictos[0].tipo, 'campo');
  assert.equal(fus({ x: {} }, { x: [] }, { x: { a: 1 } }).conflictos[0].tipo, 'campo');
});

test('claves del esquema: la lista de entidades usa ids con números y cadenas sin colisionar con objetos vacíos', () => {
  const b = { usuarios: [{ id: 1, n: 'a' }, { id: 2, n: 'b' }] }; const l = clon(b); l.usuarios[0].n = 'A'; const r = clon(b); r.usuarios[1].n = 'B';
  const m = fus(b, l, r); assert.equal(m.ok, true); assert.deepStrictEqual(m.config.usuarios, [{ id: 1, n: 'A' }, { id: 2, n: 'B' }]);
  const sinId = fus({ usuarios: [{ n: 'x' }] }, { usuarios: [{ n: 'x' }, { n: 'y' }] }, { usuarios: [{ n: 'z' }] }); assert.equal(sinId.conflictos[0].tipo, 'clave_ambigua');
});

test('exporta el esquema y la versión; no depende de globales de la app', () => {
  assert.ok(Array.isArray(M.ESQUEMA_CONFIG_V1) && M.ESQUEMA_CONFIG_V1.length > 20);
  assert.equal(M.VERSION, 'r2b-motor-2');
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'cardiolink-config-merge-v1.js'), 'utf8');
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, ''), /supabase|localStorage|document\.|window\.|normalizarConfigCritica\(/);
});

// ---------- propiedades con casos pseudoaleatorios deterministas (semilla fija) ----------
function prng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const ordenado = (c) => { const o = clon(c); ['pacientes'].forEach((k) => o[k] && o[k].sort((a, b) => String(a.id).localeCompare(String(b.id)))); o.obrasSociales && o.obrasSociales.sort(); return o; };

test('propiedades (300 casos): ediciones disjuntas siempre se fusionan sin pérdida y la fusión es simétrica', () => {
  const rnd = prng(20261117), ent = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'], campos = ['telefono', 'email', 'fechaNacimiento', 'sexo'];
  for (let i = 0; i < 300; i++) {
    const b = { pacientes: ent.map((id) => ({ id, telefono: 't' + id, email: 'e' + id, fechaNacimiento: '1970-01-01', sexo: 'M' })), obrasSociales: ['A', 'B', 'C', 'D'] };
    const tocado = (lado) => {
      const ops = [], usado = new Set(); const n = 1 + Math.floor(rnd() * 3);
      for (let k = 0; k < n; k++) {
        const id = ent[Math.floor(rnd() * ent.length)], tipo = rnd();
        if (tipo < 0.6) { const c = campos[Math.floor(rnd() * campos.length)]; ops.push({ op: 'mod', id, c, v: lado + i + c }); usado.add(id + '.' + c); }
        else if (tipo < 0.75) { ops.push({ op: 'del', id }); campos.forEach((c) => usado.add(id + '.' + c)); usado.add(id + '.*'); }
        else if (tipo < 0.9) { const nid = lado + 'N' + i + k; ops.push({ op: 'add', id: nid }); usado.add(nid + '.*'); }
        else { const os = 'OS' + lado + i + '_' + k; ops.push({ op: 'osadd', os }); }
      }
      return { ops, usado };
    };
    const aplicar = (base, ops) => {
      const o = clon(base);
      ops.forEach((x) => {
        if (x.op === 'mod') { const p = o.pacientes.find((q) => q.id === x.id); if (p) p[x.c] = x.v; }
        else if (x.op === 'del') o.pacientes = o.pacientes.filter((q) => q.id !== x.id);
        else if (x.op === 'add') o.pacientes.push({ id: x.id, telefono: 'n' });
        else if (x.op === 'osadd') o.obrasSociales.push(x.os);
      });
      return o;
    };
    const L = tocado('L'), R = tocado('R');
    // disjuntos: ninguna clave (entidad.campo) en común y ninguna baja de una entidad que el otro lado toque
    const choque = [...L.usado].some((u) => R.usado.has(u) || (u.endsWith('.*') ? [...R.usado].some((r) => r.startsWith(u.slice(0, -1))) : R.usado.has(u.split('.')[0] + '.*')))
      || [...R.usado].some((u) => u.endsWith('.*') && [...L.usado].some((l) => l.startsWith(u.slice(0, -1))));
    const l = aplicar(b, L.ops), r = aplicar(b, R.ops);
    const m = fus(b, l, r), s = fus(b, r, l);
    assert.equal(m.ok, s.ok, 'simetría de la detección (caso ' + i + ')');
    if (!choque) {
      assert.equal(m.ok, true, 'ediciones disjuntas deben fusionarse (caso ' + i + ')');
      const esperado = aplicar(aplicar(b, L.ops), R.ops);
      assert.deepStrictEqual(ordenado(m.config), ordenado(esperado), 'sin pérdida (caso ' + i + ')');
      assert.deepStrictEqual(ordenado(m.config), ordenado(s.config), 'conmutativa salvo orden de altas (caso ' + i + ')');
    }
    assert.deepStrictEqual(fus(b, l, clon(b)).config, l); assert.deepStrictEqual(fus(b, clon(b), r).config, r);
  }
});

test('orden: no se reordena un catálogo sin necesidad; un reordenamiento sólo local se respeta; alta al principio queda al principio', () => {
  const b = cfg(); b.obrasSociales = ['A', 'B', 'C', 'D'];
  const soloLocalReordena = clon(b); soloLocalReordena.obrasSociales = ['D', 'C', 'B', 'A']; const remotoAgrega = clon(b); remotoAgrega.obrasSociales.push('E');
  assert.deepStrictEqual(fus(b, soloLocalReordena, remotoAgrega).config.obrasSociales, ['D', 'C', 'B', 'A', 'E']);
  const ambosAgregan = clon(b); ambosAgregan.obrasSociales = ['Z', 'A', 'B', 'C', 'D']; const rem = clon(b); rem.obrasSociales = ['A', 'B', 'X', 'C', 'D'];
  assert.deepStrictEqual(fus(b, ambosAgregan, rem).config.obrasSociales, ['Z', 'A', 'B', 'X', 'C', 'D']);
  const l = clon(b); l.pacientes.unshift({ id: 'pCero' }); const r = clon(b); r.pacientes.push({ id: 'pFin' });
  assert.deepStrictEqual(fus(b, l, r).config.pacientes.map((p) => p.id), ['pCero', 'p1', 'p2', 'pFin']);
  const sinCambioOrden = fus(b, clon(b), (() => { const o = clon(b); o.obrasSociales.reverse(); return o; })()); assert.deepStrictEqual(sinCambioOrden.config.obrasSociales, ['D', 'C', 'B', 'A']);
});

test('rutas inequívocas: claves con puntos, corchetes o barras no colisionan con otras rutas', () => {
  const b = { pacientes: [{ id: 'a.b', t: '1' }, { id: 'a', b: { t: '1' } }, { id: 'x]y[z', t: '1' }] };
  const l = clon(b); l.pacientes[0].t = 'L'; l.pacientes[1].b.t = 'L'; l.pacientes[2].t = 'L';
  const r = clon(b); r.pacientes[0].t = 'R'; r.pacientes[1].b.t = 'R'; r.pacientes[2].t = 'R';
  const m = fus(b, l, r); const rutas = m.conflictos.map((c) => c.ruta);
  assert.equal(new Set(rutas).size, 3); assert.deepStrictEqual(rutas.sort(), ['pacientes[a.b].t', 'pacientes[a].b.t', 'pacientes[x\\]y\\[z].t'].sort().map((x) => x.replace('a.b', 'a\\.b')));
  const res = {}; rutas.forEach((x) => { res[x] = 'remoto'; }); const ok = fus(b, l, r, { resoluciones: res }); assert.equal(ok.ok, true); assert.equal(ok.config.pacientes[0].t, 'R');
  assert.equal(M.rutaATexto(['mapa', 'k.1']), 'mapa.k\\.1');
});

test('historial de coberturas y alias de usuarios: auditoría y conjunto (no bloque); sueldos de secretaría por id', () => {
  const b = { pacientes: [{ id: 'p1', historialCoberturas: [{ cobertura: 'A', hasta: '2026-01-01' }] }], usuarios: [{ id: 'u', aliases: ['x'] }], configFinanzas411F: { sueldosSecretaria: [{ id: 's1', monto: 1 }] } };
  const l = clon(b); l.pacientes[0].historialCoberturas.push({ cobertura: 'B', hasta: '2026-02-01' }); l.usuarios[0].aliases.push('y'); l.configFinanzas411F.sueldosSecretaria.push({ id: 's2', monto: 2 });
  const r = clon(b); r.pacientes[0].historialCoberturas.push({ cobertura: 'C', hasta: '2026-03-01' }); r.usuarios[0].aliases.push('z'); r.configFinanzas411F.sueldosSecretaria[0].monto = 5;
  const m = fus(b, l, r); assert.equal(m.ok, true);
  assert.equal(m.config.pacientes[0].historialCoberturas.length, 3); assert.deepStrictEqual(m.config.usuarios[0].aliases, ['x', 'z', 'y']);
  assert.deepStrictEqual(m.config.configFinanzas411F.sueldosSecretaria.map((s) => s.id + ':' + s.monto), ['s1:5', 's2:2']);
});

test('neutro: un cambio explícito protegido que coincide con el valor normalizado NO se descarta', () => {
  const b = { reglasOS: { IOMA: 'X' } }; const normalizar = (c) => { const o = clon(c); o.reglasOS.IOMA = 'IOMA_OSPRERA'; return o; };
  const neutro = normalizar(b); const local = normalizar(b);      // el usuario eligió, a propósito, el mismo valor que impone la normalización
  assert.equal(M.hayCambiosLocales(b, local, { neutro }), false);                                   // sin marca: indistinguible de la normalización
  assert.equal(M.hayCambiosLocales(b, local, { neutro, protegidos: ['reglasOS.IOMA'] }), true);       // con marca explícita: es un cambio del usuario
  const m = fus(b, local, clon(b), { neutro, protegidos: ['reglasOS.IOMA'] }); assert.equal(m.config.reglasOS.IOMA, 'IOMA_OSPRERA');
  const sinMarca = fus(b, local, clon(b), { neutro }); assert.equal(sinMarca.config.reglasOS.IOMA, 'X');
});
