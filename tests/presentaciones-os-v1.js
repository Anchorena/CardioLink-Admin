'use strict';
// Facturación mensual V1 · Bloque 1 · Presentaciones a obras sociales. Núcleo real (cardiolink-presentaciones-os-core.js) + Finanzas V5 real + chequeos estáticos del SQL propuesto.
// Corre con Node (previsto: 22) y con JavaScriptCore. Datos 100% sintéticos.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const C = require(path.join(root, 'cardiolink-presentaciones-os-core.js'));
const F = require(path.join(root, 'cardiolink-finanzas-v5.js'));
const leer = (f) => fs.readFileSync(path.join(root, f), 'utf8');

let ok = 0, fail = 0; const pendientes = [];
const t = (n, f) => pendientes.push([n, f]);

// Aranceles de prueba por (profesional, cobertura, prestación): el «obtenerArancel» real de la app lo consulta igual (valor fijado en la atención o vigente).
const ARANCEL = { 'matias|OSDE|Ecocardiograma': 1000, 'matias|OSDE|Consulta': 400, 'matias|Galeno|Holter': 700, 'rogelio|OSDE|Consulta': 350 };
const obtenerArancel = (a) => {
  if (['particular', 'pami'].includes(C.norm(a.obraSocial))) return 0;
  if (Number.isFinite(Number(a.valorArancelEstimado)) && Number(a.valorArancelEstimado) >= 0) return Number(a.valorArancelEstimado);
  return ARANCEL[(a.profesionalId || 'matias') + '|' + a.obraSocial + '|' + a.prestacion] || 0;
};
let n = 0;
const at = (o) => Object.assign({ id: String(1790000000000 + (++n)), fecha: '2026-11-10', obraSocial: 'OSDE', prestacion: 'Ecocardiograma', profesionalId: 'matias', paciente: 'Paciente ' + n, pacienteId: 'pac_' + n, estadoTurno: 'atendido' }, o || {});
const base = () => ([
  at({ id: '101', fecha: '2026-11-05' }),                                          // del mes
  at({ id: '102', fecha: '2026-11-20', prestacion: 'Consulta' }),                  // del mes
  at({ id: '103', fecha: '2026-10-15' }),                                          // mes anterior, no presentada
  at({ id: '104', fecha: '2026-09-30', obraSocial: 'Galeno', prestacion: 'Holter' }), // anterior, otra cobertura
  at({ id: '105', fecha: '2026-11-07', obraSocial: 'Particular' }),                 // particular: no
  at({ id: '106', fecha: '2026-11-08', obraSocial: 'PAMI' }),                       // PAMI: no
  at({ id: '107', fecha: '2026-11-09', estadoTurno: 'cancelado' }),                 // no realizada
  at({ id: '108', fecha: '2026-11-11', estadoTurno: 'ausente' }),                   // no realizada
  at({ id: '109', fecha: '2026-11-12', prestacion: 'Prestación sin arancel' }),     // sin arancel
  at({ id: '110', fecha: '2026-08-31' }),                                           // anterior al control
  at({ id: '111', fecha: '2026-12-02' }),                                           // posterior al período
  at({ id: '112', fecha: '2026-11-13', profesionalId: 'rogelio', prestacion: 'Consulta' }), // otro profesional
  at({ id: '113', fecha: '2026-11-14', valorArancelEstimado: 1234.5 })              // arancel fijado en la atención
]);
const calc = (extra) => C.calcularPendientes(Object.assign({ atenciones: base(), presentados: [], desde: '2026-09-01', hastaMes: '2026-11', obtenerArancel }, extra || {}));
const ids = (l) => l.map((x) => x.id).sort();

t('A · QA: la prestación del mes se incluye AUTOMÁTICAMENTE (sin seleccionar nada)', () => {
  const r = calc(); const l = ids(r.listos);
  assert.ok(l.includes('101') && l.includes('102') && l.includes('113'));
  assert.equal(r.listos.find((x) => x.id === '113').importe, 1234.5, 'toma el arancel fijado en la atención');
  assert.equal(r.listos.find((x) => x.id === '101').importe, 1000);
});
t('B · QA: la prestación de un mes ANTERIOR no presentada también se incluye; lo anterior al inicio del control no se ofrece solo y lo posterior al período tampoco', () => {
  const r = calc(); const l = ids(r.listos);
  assert.ok(l.includes('103') && l.includes('104'), 'octubre y setiembre sin presentar entran');
  assert.ok(!l.includes('110'), 'anterior al inicio del control: no se ofrece solo (se incorpora, si corresponde, como excepción)');
  assert.ok(!l.includes('111'), 'diciembre: fuera del período de presentación');
  assert.deepEqual(r.resumenPorMes.map((m) => m.mes), ['2026-09', '2026-10', '2026-11']);
});
t('C · solo se ofrece lo REALIZADO y FACTURABLE: sin particulares/PAMI, ausentes ni cancelados; lo sin arancel va aparte', () => {
  const r = calc(); const l = ids(r.listos);
  ['105', '106', '107', '108', '109'].forEach((i) => assert.ok(!l.includes(i), i + ' no se presenta'));
  assert.deepEqual(ids(r.sinArancel), ['109'], 'sin arancel: se informa para cargarlo, no se presenta en 0');
});
t('D · QA: la EXCEPCIÓN se excluye sin seleccionar cada prestación (por mes, por prestación o por ID) y lo demás sigue incluido', () => {
  const r = calc();
  const porMes = C.aplicarExclusiones(r.listos, { meses: ['2026-09'] });
  assert.deepEqual(ids(porMes.excluidos), ['104']); assert.equal(porMes.incluidos.length, r.listos.length - 1);
  const porPrest = C.aplicarExclusiones(r.listos, { prestaciones: ['consulta'] });
  assert.ok(porPrest.excluidos.every((x) => x.prestacion === 'Consulta') && porPrest.excluidos.length >= 2);
  const porId = C.aplicarExclusiones(r.listos, { ids: ['103'] });
  assert.deepEqual(ids(porId.excluidos), ['103']);
  const sinReglas = C.aplicarExclusiones(r.listos, {});
  assert.equal(sinReglas.incluidos.length, r.listos.length); assert.equal(sinReglas.excluidos.length, 0);
});
t('E · QA: CONFIRMACIÓN ÚNICA — la segunda confirmación de lo mismo NO duplica y no guarda nada', async () => {
  const lista = base(); const al = C.crearAlmacenMemoria({ control: '2026-09-01', atenciones: lista, usuario: { id: 'u1', email: 'a@t.test', rol: 'owner' } });
  const r = calc({ atenciones: lista });
  const lotes = C.armarLotes(r.listos);
  const res1 = await al.confirmar(C.payloadConfirmar('2026-11', lotes, 0));
  assert.equal(res1.items, r.listos.length); assert.equal(al._estado.items.length, r.listos.length);
  await assert.rejects(al.confirmar(C.payloadConfirmar('2026-11', lotes, 0)), (e) => e.code === '23505');
  assert.equal(al._estado.items.length, r.listos.length, 'no se agregó nada');
  assert.equal(new Set(al._estado.items.map((i) => i.atencion_id)).size, al._estado.items.length, 'sin IDs repetidos');
  // lo ya presentado desaparece de la próxima lista
  const presentados = await al.leerPresentados();
  assert.equal(calc({ atenciones: lista, presentados }).listos.length, 0);
});
t('F · ATOMICIDAD: si UNA prestación del lote ya estaba presentada, no se guarda NINGUNA del lote', async () => {
  const lista = base(); const al = C.crearAlmacenMemoria({ control: '2026-09-01', atenciones: lista });
  await al.confirmar(C.payloadConfirmar('2026-11', C.armarLotes(calc({ atenciones: lista }).listos.filter((x) => x.id === '101')), 0));
  const antes = al._estado.items.length;
  const todos = C.armarLotes(calc({ atenciones: lista }).listos);       // incluye la 101 de nuevo (lista desactualizada de otra sesión)
  await assert.rejects(al.confirmar(C.payloadConfirmar('2026-11', todos, 0)), (e) => e.code === '23505');
  assert.equal(al._estado.items.length, antes); assert.equal(al._estado.lotes.length, 1);
});
t('G · el cliente también controla duplicados antes de enviar (dentro del lote y contra lo presentado)', () => {
  const r = calc(); const lotes = C.armarLotes(r.listos);
  assert.deepEqual(C.validarLotes(lotes, []), []);
  assert.ok(C.validarLotes(lotes, ['101']).some((e) => /ya fue presentada/.test(e)));
  const dup = JSON.parse(JSON.stringify(lotes)); dup[0].items.push(dup[0].items[0]);
  assert.ok(C.validarLotes(dup, []).some((e) => /repetida/.test(e)));
  assert.ok(C.validarLotes([], []).length === 1);
});
t('H · QA: la PRODUCCIÓN HISTÓRICA queda intacta (Finanzas V5 da lo mismo antes y después; las atenciones no se modifican)', async () => {
  const lista = base(); const copia = JSON.parse(JSON.stringify(lista));
  const prod = () => F.calcularIngresosCanonicos({ atenciones: lista, desde: '2026-09-01', hasta: '2026-12-31', obtenerArancel, normalizar: C.norm });
  const antes = JSON.stringify(prod());
  const al = C.crearAlmacenMemoria({ control: '2026-09-01', atenciones: lista });
  await al.confirmar(C.payloadConfirmar('2026-11', C.armarLotes(calc({ atenciones: lista }).listos), 0));
  assert.equal(JSON.stringify(prod()), antes, 'la producción por fecha de atención no cambió');
  assert.deepEqual(lista, copia, 'ninguna atención fue modificada (ni su fecha)');
  const items = al._estado.items; assert.ok(items.every((i) => lista.find((a) => String(a.id) === i.atencion_id).fecha === i.fecha_atencion), 'cada ítem guarda la MISMA fecha de producción');
});
t('I · permisos por profesional: solo se listan los profesionales permitidos (Secretaría asociada) y el servidor rechaza al resto', async () => {
  const r = calc({ profesionales: ['rogelio'] }); assert.ok(r.listos.length && r.listos.every((x) => x.profesionalId === 'rogelio'));
  const lista = base(); const sec = C.crearAlmacenMemoria({ control: '2026-09-01', atenciones: lista, usuario: { id: 's', email: 's@t.test', rol: 'secretaria' }, puedeConfirmar: (rol, prof) => rol === 'secretaria' ? (prof === null || prof === 'rogelio') : false });
  const lotes = C.armarLotes(calc({ atenciones: lista }).listos);       // incluye a matias
  await assert.rejects(sec.confirmar(C.payloadConfirmar('2026-11', lotes, 0)), (e) => e.code === '42501');
  assert.equal(sec._estado.items.length, 0);
  const medico = C.crearAlmacenMemoria({ control: '2026-09-01', atenciones: lista, usuario: { id: 'm', email: 'm@t.test', rol: 'medico' } });
  await assert.rejects(medico.confirmar(C.payloadConfirmar('2026-11', lotes, 0)), (e) => e.code === '42501');
});
t('J · el servidor revalida contra la atención (profesional, cobertura, fecha) y exige la fecha de control', async () => {
  const lista = base(); const al = C.crearAlmacenMemoria({ control: '2026-09-01', atenciones: lista });
  const lotes = C.armarLotes(calc({ atenciones: lista }).listos.filter((x) => x.id === '101'));
  const mal = JSON.parse(JSON.stringify(lotes)); mal[0].items[0].fecha = '2026-11-06';
  await assert.rejects(al.confirmar(C.payloadConfirmar('2026-11', mal, 0)), (e) => /PR409/.test(e.message));
  const sinControl = C.crearAlmacenMemoria({ atenciones: lista });
  await assert.rejects(sinControl.confirmar(C.payloadConfirmar('2026-11', lotes, 0)), (e) => /PR010/.test(e.message));
  assert.throws(() => C.calcularPendientes({ atenciones: lista, presentados: [], hastaMes: '2026-11' }), /inicio del control/);
});
t('K · terceros (facturan otros) quedan aparte por defecto; la cobertura se filtra sin distinguir tildes ni mayúsculas', () => {
  const r = calc({ esFacturaTercero: (a) => a.id === '103' }); assert.deepEqual(ids(r.terceros), ['103']); assert.ok(!ids(r.listos).includes('103'));
  const r2 = calc({ esFacturaTercero: (a) => a.id === '103', incluirTerceros: true }); assert.ok(ids(r2.listos).includes('103'));
  const r3 = calc({ cobertura: 'osdé' }); assert.ok(r3.listos.length && r3.listos.every((x) => C.norm(x.cobertura) === 'osde'));
});
t('L · mapeo de errores: duplicada / permiso / control / cambio / otro, con texto simple', () => {
  assert.equal(C.mapearError({ code: '23505', message: 'duplicate key' }).tipo, 'duplicada');
  assert.equal(C.mapearError({ code: '42501', message: 'x' }).tipo, 'permiso');
  assert.equal(C.mapearError({ message: 'PR010 falta fecha de control' }).tipo, 'control');
  assert.equal(C.mapearError({ message: 'PR409 no coincide con la atención' }).tipo, 'cambio');
  assert.equal(C.mapearError({ message: 'timeout' }).tipo, 'error');
});

// ---- chequeos estáticos: alcance, independencia y SQL propuesto
const CORE = leer('cardiolink-presentaciones-os-core.js');
t('M · independencia: el núcleo no usa la red ni toca atenciones, sincronización, finance_expenses ni copias_facturacion', () => {
  assert.ok(!/supabase|\.from\(['"`]|\.rpc\(|fetch\(|localStorage|XMLHttpRequest/.test(CORE.replace(/\/\*[\s\S]*?\*\//g, '')), 'el núcleo es puro');
  assert.ok(!/finance_expenses|copias_facturacion|sincronizarAtenciones|programarSync/.test(CORE.replace(/\/\*[\s\S]*?\*\//g, '')));
});
const SQLF = 'docs/propuestas/pending_review_facturacion_presentaciones_v1.sql';
t('N · SQL propuesto: una prestación solo puede presentarse UNA vez, sin escritura directa y con identidad/fecha fijadas por el servidor', () => {
  if (!fs.existsSync(path.join(root, SQLF))) { return; }
  const s = leer(SQLF);
  assert.match(s, /CREATE UNIQUE INDEX[\s\S]{0,160}\(atencion_id\)/);
  assert.match(s, /GRANT SELECT ON TABLE public\.cardiolink_presentaciones_os_v1 TO authenticated/);
  assert.ok(!/GRANT[^;]*\b(INSERT|UPDATE|DELETE)\b[^;]*TO authenticated/i.test(s.replace(/--.*$/gm, '')), 'authenticated no escribe directo');
  assert.match(s, /v_uid uuid := auth\.uid\(\)/); assert.match(s, /auth\.jwt\(\) ->> 'email'/); assert.match(s, /VALUES \(v_cob, v_prof, p_periodo, v_n, v_total, v_uid, v_email, v_rol\)/);   // usuario, rol y email salen de la sesión, no del cliente
  assert.match(s, /presentado_en timestamptz NOT NULL DEFAULT now\(\)/);                   // la fecha la fija el servidor
  assert.match(s, /CASE WHEN \(v_pl ->> 'valorArancelEstimado'\) ~/);                      // cast del arancel protegido por CASE
  assert.ok(!/p_excluidas|total_importe[^;]{0,40}v_lote ->>/.test(s), 'el cliente no envía totales');
  assert.ok(!/UPDATE\s+public\.cardiolink_atenciones|DELETE\s+FROM\s+public\.cardiolink_atenciones|ALTER\s+TABLE\s+public\.cardiolink_atenciones/i.test(s.replace(/--.*$/gm, '')), 'no modifica atenciones');
  assert.ok(!/finance_expenses|copias_facturacion/.test(s.replace(/--.*$/gm, '')), 'no reutiliza esas tablas');
});

// ---- AJUSTE: incorporación EXCEPCIONAL de prestaciones anteriores al inicio del control (01/12/2026), p. ej. bonos pendientes de presentación
const INICIO = '2026-12-01';
const baseDic = () => ([
  at({ id: '201', fecha: '2026-12-03' }),                                              // posterior al inicio: automática
  at({ id: '202', fecha: '2026-11-25', prestacion: 'Consulta' }),                       // anterior (bono pendiente)
  at({ id: '203', fecha: '2026-10-14' }),                                               // anterior, otra fecha
  at({ id: '204', fecha: '2026-11-20', obraSocial: 'Galeno', prestacion: 'Holter' }),   // anterior, otra cobertura
  at({ id: '205', fecha: '2026-11-18', estadoTurno: 'ausente' }),                       // anterior no realizada
  at({ id: '206', fecha: '2026-11-19', obraSocial: 'PAMI' }),                           // anterior PAMI
  at({ id: '207', fecha: '2026-11-17', prestacion: 'Sin arancel' }),                    // anterior sin arancel
  at({ id: '208', fecha: '2026-11-16', profesionalId: 'rogelio', prestacion: 'Consulta' }) // anterior de otro profesional
]);
const autoDic = (lista, presentados) => C.calcularPendientes({ atenciones: lista, presentados: presentados || [], desde: INICIO, hastaMes: '2026-12', obtenerArancel });
const antDic = (lista, extra) => C.calcularAnteriores(Object.assign({ atenciones: lista, presentados: [], desde: INICIO, obtenerArancel }, extra || {}));

t('O · AJUSTE: lo anterior al 01/12/2026 NO se da por facturado ni se ofrece solo; se busca aparte y solo aparece lo realizado, facturable y no presentado', () => {
  const lista = baseDic();
  assert.deepEqual(ids(autoDic(lista).listos), ['201'], 'la lista automática arranca el 01/12/2026');
  const r = antDic(lista);
  assert.deepEqual(ids(r.listos), ['202', '203', '204', '208'], 'anteriores realizadas y facturables, sin presentar');
  assert.equal(r.yaPresentadas, 0, 'nada anterior se considera presentado por defecto');
  assert.deepEqual(ids(r.sinArancel), ['207']); assert.ok(!ids(r.listos).includes('205') && !ids(r.listos).includes('206'));
  assert.ok(r.listos.every((x) => x.fecha < INICIO));
  assert.throws(() => C.calcularAnteriores({ atenciones: lista, presentados: [] }), /inicio del control/);
});
t('P · AJUSTE: búsqueda acotada por fechas, paciente/prestación y cobertura; lo ya presentado y lo de otros profesionales no permitidos quedan fuera', () => {
  const lista = baseDic();
  assert.deepEqual(ids(antDic(lista, { desdeFecha: '2026-11-21', hastaFecha: '2026-11-30' }).listos), ['202']);
  assert.deepEqual(ids(antDic(lista, { texto: 'holter' }).listos), ['204']);
  assert.deepEqual(ids(antDic(lista, { cobertura: 'galeno' }).listos), ['204']);
  const pac = lista.find((a) => a.id === '203').paciente; assert.deepEqual(ids(antDic(lista, { texto: pac }).listos), ['203']);
  const pres = antDic(lista, { presentados: ['202'] }); assert.ok(!ids(pres.listos).includes('202')); assert.equal(pres.yaPresentadas, 1);
  assert.ok(antDic(lista, { profesionales: ['rogelio'] }).listos.every((x) => x.profesionalId === 'rogelio'));
  assert.ok(antDic(lista, { esFacturaTercero: (a) => a.id === '203' }).terceros.some((x) => x.id === '203'));
});
t('Q · AJUSTE QA: una excepción se confirma junto con la lista automática, conserva su fecha original y queda marcada con motivo; la segunda confirmación no duplica', async () => {
  const lista = baseDic(); const al = C.crearAlmacenMemoria({ control: INICIO, atenciones: lista, usuario: { id: 'u1', email: 'a@t.test', rol: 'owner' } });
  const auto = autoDic(lista).listos, extra = C.marcarExcepcionales(antDic(lista).listos.filter((x) => x.id === '202'), 'Bono pendiente de presentación');
  assert.equal(extra[0].excepcional, true); assert.equal(antDic(lista).listos.find((x) => x.id === '202').excepcional, undefined, 'marcar no altera las originales');
  const lotes = C.armarLotes(auto.concat(extra));
  assert.deepEqual(C.validarLotes(lotes, [], INICIO), []);
  const res = await al.confirmar(C.payloadConfirmar('2026-12', lotes));
  assert.equal(res.items, 2);
  const it = (id) => al._estado.items.find((i) => i.atencion_id === id);
  assert.equal(it('202').fecha_atencion, '2026-11-25', 'conserva la fecha original de producción');
  assert.equal(it('202').excepcional, true); assert.equal(it('202').motivo_excepcion, 'Bono pendiente de presentación');
  assert.equal(it('201').excepcional, false); assert.equal(it('201').motivo_excepcion, null);
  await assert.rejects(al.confirmar(C.payloadConfirmar('2026-12', lotes)), (e) => e.code === '23505');
  assert.equal(al._estado.items.length, 2, 'sin duplicados');
  assert.ok(!ids(antDic(lista, { presentados: await al.leerPresentados() }).listos).includes('202'), 'ya no se vuelve a ofrecer');
});
t('R · AJUSTE: sin marca de excepción o sin motivo, el servidor y el cliente rechazan una prestación anterior al inicio y no guardan nada', async () => {
  const lista = baseDic(); const al = C.crearAlmacenMemoria({ control: INICIO, atenciones: lista });
  const fila = antDic(lista).listos.find((x) => x.id === '202');
  const sinMarca = C.armarLotes([fila]);
  assert.ok(C.validarLotes(sinMarca, [], INICIO).some((e) => /excepción/.test(e)));
  await assert.rejects(al.confirmar(C.payloadConfirmar('2026-12', sinMarca)), (e) => /PR411/.test(e.message));
  const sinMotivo = C.armarLotes(C.marcarExcepcionales([fila], '   '));
  assert.ok(C.validarLotes(sinMotivo, [], INICIO).some((e) => /motivo/.test(e)));
  await assert.rejects(al.confirmar(C.payloadConfirmar('2026-12', sinMotivo)), (e) => /PR411/.test(e.message));
  const mezcla = C.armarLotes(autoDic(lista).listos.concat([fila]));                 // la automática válida + la anterior sin marca: todo o nada
  await assert.rejects(al.confirmar(C.payloadConfirmar('2026-12', mezcla)), (e) => /PR411/.test(e.message));
  assert.equal(al._estado.items.length, 0); assert.equal(al._estado.lotes.length, 0);
  assert.equal(C.mapearError({ message: 'PR411: solo como excepción' }).tipo, 'excepcion');
});
t('S · AJUSTE QA: producción histórica intacta con excepciones (Finanzas V5 idéntica antes y después; atenciones y fechas sin modificar; cada ítem con su fecha original)', async () => {
  const lista = baseDic(); const copia = JSON.parse(JSON.stringify(lista));
  const prod = () => F.calcularIngresosCanonicos({ atenciones: lista, desde: '2026-10-01', hasta: '2026-12-31', obtenerArancel, normalizar: C.norm });
  const antes = JSON.stringify(prod());
  const al = C.crearAlmacenMemoria({ control: INICIO, atenciones: lista });
  const extra = C.marcarExcepcionales(antDic(lista).listos, 'Bono pendiente');
  await al.confirmar(C.payloadConfirmar('2026-12', C.armarLotes(autoDic(lista).listos.concat(extra))));
  assert.equal(JSON.stringify(prod()), antes, 'la producción por fecha de atención no cambió');
  assert.deepEqual(lista, copia, 'ninguna atención fue modificada');
  assert.ok(al._estado.items.every((i) => i.fecha_atencion === lista.find((a) => String(a.id) === i.atencion_id).fecha));
  assert.equal(al._estado.items.length, 5);
});
t('T · AJUSTE: permisos — la excepción respeta el profesional (Secretaría asociada) y el médico no confirma', async () => {
  const lista = baseDic(); const fila = C.marcarExcepcionales(antDic(lista).listos, 'Bono pendiente');
  const sec = C.crearAlmacenMemoria({ control: INICIO, atenciones: lista, usuario: { id: 's', email: 's@t.test', rol: 'secretaria' }, puedeConfirmar: (rol, prof) => rol === 'secretaria' ? (prof === null || prof === 'rogelio') : false });
  await assert.rejects(sec.confirmar(C.payloadConfirmar('2026-12', C.armarLotes(fila))), (e) => e.code === '42501');
  const solo = C.armarLotes(fila.filter((x) => x.profesionalId === 'rogelio')); await sec.confirmar(C.payloadConfirmar('2026-12', solo));
  assert.equal(sec._estado.items.length, 1); assert.equal(sec._estado.items[0].excepcional, true);
  const medico = C.crearAlmacenMemoria({ control: INICIO, atenciones: lista, usuario: { id: 'm', email: 'm@t.test', rol: 'medico' } });
  await assert.rejects(medico.confirmar(C.payloadConfirmar('2026-12', C.armarLotes(fila))), (e) => e.code === '42501');
});
t('U · AJUSTE: SQL propuesto — fecha de inicio 2026-12-01, excepción marcada con motivo y decidida por el servidor, sin dar por presentado lo anterior', () => {
  if (!fs.existsSync(path.join(root, SQLF))) { return; }
  const s = leer(SQLF), sinCom = s.replace(/--.*$/gm, '');
  assert.match(sinCom, /VALUES \(true, DATE '2026-12-01'/);
  assert.match(sinCom, /excepcional boolean NOT NULL DEFAULT false/); assert.match(sinCom, /CHECK \(excepcional = \(motivo_excepcion IS NOT NULL AND btrim\(motivo_excepcion\) <> ''\)\)/);
  assert.match(sinCom, /v_exc := v_f < v_ctrl/); assert.match(sinCom, /PR411/);
  assert.match(sinCom, /v_f > v_fin/);                                                    // solo el techo del período; el piso ya no descarta lo anterior
  assert.ok(!/v_f < v_ctrl OR v_f > v_fin/.test(sinCom), 'lo anterior al control ya no se rechaza de plano');
  assert.ok(!/INSERT INTO public\.cardiolink_presentaciones_os_items_v1[^;]*SELECT[^;]*cardiolink_atenciones/i.test(sinCom), 'no marca como presentado nada del histórico');
  assert.ok(!/UPDATE\s+public\.cardiolink_atenciones/i.test(sinCom));
});

t('V · CIERRE DE INCIDENCIAS: SQL — el médico lee (no escribe) la fecha de control y la RPC exige arancel FIJADO (PR412) sin usar importes del cliente; delta y rollback coherentes', () => {
  if (!fs.existsSync(path.join(root, SQLF))) { return; }
  const sinCom = (f) => leer(f).replace(/--.*$/gm, ''), s = sinCom(SQLF);
  assert.match(s, /control_select[\s\S]{0,200}IN \('owner', 'admin', 'secretaria', 'medico'\)/);
  assert.ok(!/GRANT[^;]*\b(INSERT|UPDATE|DELETE)\b[^;]*control_v1[^;]*TO authenticated/i.test(s), 'el control sigue sin escritura directa');
  assert.match(s, /v_val := CASE WHEN \(v_pl ->> 'valorArancelEstimado'\) ~/);
  assert.match(s, /v_arancel_id = '' OR v_val IS NULL OR v_val <= 0/); assert.match(s, /PR412/);
  assert.ok(!/IF[^;]*\bCASE\b[^;]*\bTHEN\b[^;]*\bTHEN\b/.test(s.replace(/v_val := CASE[^;]*;/, '')), 'sin CASE ... THEN dentro de IF ... THEN');
  assert.match(s, /v_arancel_id, nullif\(btrim\(coalesce\(v_item ->> 'patient_id'/, 'el arancel_id guardado sale de la atención, no del cliente');
  assert.ok(!/importe_presentado[^;]{0,60}(arancel_id|valorArancelEstimado)[^;]{0,40}ELSE\s+v_importe/.test(s));
  const d = sinCom('docs/propuestas/pending_review_facturacion_presentaciones_v1_delta_incidencias.sql'), r = sinCom('docs/propuestas/pending_review_facturacion_presentaciones_v1_delta_incidencias_rollback.sql');
  assert.match(d, /ALTER POLICY cardiolink_presentaciones_os_control_select[\s\S]{0,200}'medico'/); assert.match(d, /PR412/);
  assert.ok(!/(DROP|DELETE|UPDATE\s+public|INSERT\s+INTO|TRUNCATE|ALTER\s+TABLE)/i.test(d.replace(/\$f\$[\s\S]*?\$f\$/, '')), 'el delta (fuera del cuerpo de la RPC) no toca datos ni tablas');
  assert.ok(!/'medico'/.test(r.split('ALTER POLICY')[1].split(';')[0]), 'el rollback vuelve a la política sin médico'); assert.ok(!/PR412/.test(r.split('CREATE OR REPLACE FUNCTION')[1].split('$f$;')[0]), 'el rollback vuelve a la RPC anterior');
  assert.match(leer('docs/propuestas/pending_review_facturacion_presentaciones_v1_checks.sql'), /medico_lee_control/);
});
t('W · CIERRE DE INCIDENCIAS: el cliente no calcula importes por tabla (solo arancel fijado) y mapea PR412 a un texto simple', () => {
  assert.equal(C.mapearError({ message: 'PR412: la prestación no tiene un arancel válido fijado' }).tipo, 'arancel');
  const U = leer('cardiolink-presentaciones-os-v1.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const f = U.slice(U.indexOf('function arancelDe'), U.indexOf('function esFacturaTercero'));
  assert.ok(!/arancelesPorProfesional|vigenteDesde/.test(f), 'sin búsqueda por tabla de aranceles'); assert.match(f, /arancelId/); assert.match(f, /v > 0/);
  // una prestación sin arancel fijado queda en «sin arancel» (incidencias pendientes), nunca en la lista a presentar
  const lista = [at({ id: '301', fecha: '2026-12-02' }), at({ id: '302', fecha: '2026-12-03', arancelId: 'a1', valorArancelEstimado: 900 })];
  const fijado = (a) => (a.arancelId && Number(a.valorArancelEstimado) > 0) ? Number(a.valorArancelEstimado) : 0;
  const r = C.calcularPendientes({ atenciones: lista, presentados: [], desde: INICIO, hastaMes: '2026-12', obtenerArancel: fijado });
  assert.deepEqual(ids(r.listos), ['302']); assert.deepEqual(ids(r.sinArancel), ['301']);
});


// ============================================================================================================================================================
// FACTURACIÓN POR TERCEROS (complemento): estudios realizados por un profesional y facturados por otro, con delegaciones EXPLÍCITAS
// ============================================================================================================================================================
const DELEG = [
  { realiza_professional_id: 'matias', destino_norm: 'rogelio', facturante_professional_id: 'rogelio', activa: true },
  { realiza_professional_id: 'matias', destino_norm: 'dr. rogelio anchorena', facturante_professional_id: 'rogelio', activa: true }
];
const fijado = (a) => { if (['particular', 'pami'].includes(C.norm(a.obraSocial))) return 0; return (a.arancelId && Number(a.valorArancelEstimado) > 0) ? Number(a.valorArancelEstimado) : 0; };
const IN_T = '2026-12-01';
const aT = (o) => Object.assign({ id: 'x' + (++n), fecha: '2026-12-03', obraSocial: 'OSDE', prestacion: 'Holter', profesionalId: 'matias', prestacionA: 'Rogelio', paciente: 'Paciente ' + n, pacienteId: 'pac_' + n, estadoTurno: 'atendido', arancelId: 'ar1', valorArancelEstimado: 1000 }, o || {});
const baseT = () => ([
  aT({ id: 'T1' }),                                                                   // Matías realiza, destino Rogelio → lo factura Rogelio
  aT({ id: 'T2', prestacionA: 'Dr. Rogelio Anchorena' }),                              // el mismo destino escrito con nombre completo
  aT({ id: 'T3', prestacionA: '  rogelio ' }),                                         // espacios/mayúsculas
  aT({ id: 'T4', prestacion: 'Consulta' }),                                            // una consulta nunca se delega
  aT({ id: 'T5', prestacionA: 'No aplica' }),                                          // factura quien realizó
  aT({ id: 'T6', prestacionA: 'Matías' }),                                             // destino = el mismo que realiza
  aT({ id: 'T7', prestacionA: 'A definir' }),                                          // destino sin definir: factura quien realizó (nada se reencamina)
  aT({ id: 'T8', arancelId: '', valorArancelEstimado: 0 }),                    // delegado SIN arancel fijado → incidencia
  aT({ id: 'T9', profesionalId: 'rogelio', prestacionA: 'Rogelio' }),                  // lo realiza Rogelio y es de Rogelio
  aT({ id: 'T10', profesionalId: 'lucas', prestacionA: 'Rogelio' })                    // otro profesional con destino «Rogelio»: NO hay delegación para él
]);
const calcT = (extra) => C.calcularPendientes(Object.assign({ atenciones: baseT(), presentados: [], desde: IN_T, hastaMes: '2026-12', obtenerArancel: fijado, facturanteDe: C.crearResolvedorFacturante(DELEG) }, extra || {}));

t('X1 · TERCEROS: el facturante sale de una DELEGACIÓN explícita (realiza + destino de prestacionA), no de lo que «coincida»; consultas y destinos no delegados factura quien realizó', () => {
  const R = C.crearResolvedorFacturante(DELEG);
  const f = (o) => R(aT(o));
  assert.deepEqual([f({}).facturante, f({}).realiza, f({}).delegada], ['rogelio', 'matias', true]);
  assert.equal(f({ prestacionA: 'DR. ROGELIO   ANCHORENA' }).facturante, 'rogelio', 'normaliza mayúsculas y espacios');
  assert.equal(f({ prestacionA: 'Rogelío' }).facturante, 'rogelio', 'y las tildes');
  ['No aplica', 'A definir', '', 'Matías', 'Fold2 / FEMEBA', 'Otro'].forEach((d) => { const r = f({ prestacionA: d }); assert.equal(r.facturante, 'matias', d); assert.equal(r.delegada, false); });
  assert.equal(f({ prestacion: 'Consulta' }).delegada, false, 'una consulta no se delega');
  assert.equal(f({ prestacion: 'Consulta ECG' }).delegada, false);
  assert.equal(f({ profesionalId: 'lucas' }).facturante, 'lucas', 'la delegación vale solo para quien realiza');
  const inactiva = C.crearResolvedorFacturante(DELEG.map((d) => Object.assign({}, d, { activa: false })));
  assert.equal(inactiva(aT({})).facturante, 'matias', 'delegación inactiva: factura quien realizó');
  assert.equal(C.crearResolvedorFacturante(null)(aT({})).facturante, 'matias', 'sin delegaciones nada se reencamina');
});

t('X2 · TERCEROS: el estudio entra en la lista del profesional que FACTURA, conserva quién lo realizó, y lo sin arancel fijado queda como incidencia', () => {
  const r = calcT();
  assert.deepEqual(ids(r.listos), ['T1', 'T10', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T9'].sort());
  const T1 = r.listos.find((x) => x.id === 'T1');
  assert.deepEqual([T1.profesionalId, T1.facturante, T1.realizadoPor, T1.delegada, T1.destino], ['rogelio', 'rogelio', 'matias', true, 'Rogelio']);
  const T4 = r.listos.find((x) => x.id === 'T4'); assert.deepEqual([T4.profesionalId, T4.delegada], ['matias', false], 'la consulta la presenta quien la realizó');
  assert.equal(r.listos.find((x) => x.id === 'T10').profesionalId, 'lucas', 'otro realizador con el mismo destino: factura él');
  assert.deepEqual(ids(r.sinArancel), ['T8'], 'delegado sin arancel fijado: incidencia, no se presenta');
  assert.equal(r.sinArancel[0].facturante, 'rogelio');
  const lotes = C.armarLotes(r.listos);
  const rog = lotes.find((l) => l.profesionalId === 'rogelio');
  assert.deepEqual(ids(rog.items), ['T1', 'T2', 'T3', 'T9'], 'el lote del facturante junta lo suyo y lo delegado, y es por cobertura + facturante');
  assert.ok(lotes.every((l) => l.items.every((x) => x.profesionalId === l.profesionalId && x.facturante === l.profesionalId)));
});

t('X3 · TERCEROS: permisos — se autoriza sobre el FACTURANTE; quien realizó solo ve un aviso; sin delegaciones o sin permiso nada se reencamina a otro', () => {
  const rogelio = calcT({ profesionales: ['rogelio'] });
  assert.deepEqual(ids(rogelio.listos), ['T1', 'T2', 'T3', 'T9'], 'Rogelio (o Secretaría asociada a él) ve lo que factura, también lo realizado por Matías');
  assert.equal(rogelio.terceros.length, 0);
  const matias = calcT({ profesionales: ['matias'] });
  assert.ok(!ids(matias.listos).includes('T1') && ids(matias.listos).includes('T4') && ids(matias.listos).includes('T5'));
  assert.deepEqual(ids(matias.terceros), ['T1', 'T2', 'T3', 'T8'], 'Matías ve como informativo lo que presenta Rogelio (incluida la incidencia): nunca puede presentarlo');
  assert.ok(matias.terceros.every((x) => x.delegada && x.facturante === 'rogelio' && x.realizadoPor === 'matias'));
  const otro = calcT({ profesionales: ['nadie'] }); assert.equal(otro.listos.length + otro.terceros.length + otro.sinArancel.length, 0);
  const sinDeleg = C.calcularPendientes({ atenciones: baseT(), presentados: [], desde: IN_T, hastaMes: '2026-12', obtenerArancel: fijado, facturanteDe: C.crearResolvedorFacturante([]), esFacturaTercero: (a) => a.prestacionA === 'Rogelio' && a.profesionalId === 'matias' });
  assert.ok(!ids(sinDeleg.listos).includes('T1') && ids(sinDeleg.terceros).includes('T1'), 'sin delegación explícita lo que factura otro NO se presenta (nunca se asume)');
});

t('X4 · TERCEROS: confirmación — el servidor deriva el facturante, rechaza lo que no coincide, guarda quién realizó y quién factura, y NUNCA duplica', async () => {
  const lista = baseT(); const al = C.crearAlmacenMemoria({ control: IN_T, atenciones: lista, delegaciones: DELEG, usuario: { id: 'o', email: 'o@t.test', rol: 'owner' } });
  const r = calcT({ atenciones: lista }); const lotes = C.armarLotes(r.listos);
  assert.deepEqual(C.validarLotes(lotes, [], IN_T), []);
  const res = await al.confirmar(C.payloadConfirmar('2026-12', lotes));
  assert.equal(res.items, r.listos.length);
  const it = (id) => al._estado.items.find((i) => i.atencion_id === id);
  assert.deepEqual([it('T1').realizado_por_professional_id, it('T1').facturante_professional_id, it('T1').destino_texto], ['matias', 'rogelio', 'Rogelio']);
  assert.equal(it('T2').destino_texto, 'Dr. Rogelio Anchorena'); assert.equal(it('T4').facturante_professional_id, 'matias');
  assert.equal(al._estado.lotes.find((l) => l.professional_id === 'rogelio').cantidad, 4);
  // segunda confirmación (misma lista) o por el realizador: nunca duplica
  await assert.rejects(al.confirmar(C.payloadConfirmar('2026-12', lotes)), (e) => e.code === '23505');
  const comoRealiza = JSON.parse(JSON.stringify(C.armarLotes([r.listos.find((x) => x.id === 'T1')]))); comoRealiza[0].profesionalId = 'matias'; comoRealiza[0].items[0].profesionalId = 'matias'; delete comoRealiza[0].items[0].facturante;
  await assert.rejects(al.confirmar(C.payloadConfirmar('2026-12', comoRealiza)), (e) => /PR409/.test(e.message), 'presentar un estudio delegado por quien lo realizó se rechaza');
  assert.equal(al._estado.items.length, r.listos.length); assert.equal(new Set(al._estado.items.map((i) => i.atencion_id)).size, al._estado.items.length);
  // un cliente que declara otro facturante o realizador es rechazado
  const al2 = C.crearAlmacenMemoria({ control: IN_T, atenciones: baseT(), delegaciones: DELEG });
  const ok1 = C.armarLotes(calcT().listos.filter((x) => x.id === 'T1')); const mal = JSON.parse(JSON.stringify(C.payloadConfirmar('2026-12', ok1)));
  mal.p_lotes[0].items[0].facturante_professional_id = 'lucas'; await assert.rejects(al2.confirmar(mal), (e) => /PR409/.test(e.message));
  mal.p_lotes[0].items[0].facturante_professional_id = 'rogelio'; mal.p_lotes[0].items[0].realizado_por_professional_id = 'lucas'; await assert.rejects(al2.confirmar(mal), (e) => /PR409/.test(e.message));
  assert.equal(al2._estado.items.length, 0, 'todo o nada');
});

t('X5 · TERCEROS: permisos del servidor sobre el FACTURANTE (Secretaría asociada solo al realizador no presenta; Secretaría asociada al facturante sí; el médico nunca)', async () => {
  const lista = baseT(); const delegado = calcT({ atenciones: lista }).listos.filter((x) => x.id === 'T1');
  const puede = (rol, prof) => rol === 'secretaria' ? (prof === null || prof === SEC_PROF) : false; let SEC_PROF = 'matias';
  const sec1 = C.crearAlmacenMemoria({ control: IN_T, atenciones: lista, delegaciones: DELEG, usuario: { id: 's', email: 's@t.test', rol: 'secretaria' }, puedeConfirmar: puede });
  await assert.rejects(sec1.confirmar(C.payloadConfirmar('2026-12', C.armarLotes(delegado))), (e) => e.code === '42501');
  SEC_PROF = 'rogelio';
  const sec2 = C.crearAlmacenMemoria({ control: IN_T, atenciones: lista, delegaciones: DELEG, usuario: { id: 's', email: 's@t.test', rol: 'secretaria' }, puedeConfirmar: puede });
  await sec2.confirmar(C.payloadConfirmar('2026-12', C.armarLotes(delegado))); assert.equal(sec2._estado.items.length, 1);
  const med = C.crearAlmacenMemoria({ control: IN_T, atenciones: lista, delegaciones: DELEG, usuario: { id: 'm', email: 'm@t.test', rol: 'medico' } });
  await assert.rejects(med.confirmar(C.payloadConfirmar('2026-12', C.armarLotes(delegado))), (e) => e.code === '42501');
});

t('X6 · TERCEROS: la asignación NO depende de la configuración del convenio y un cambio posterior no altera lo ya presentado ni lo ya registrado', async () => {
  const lista = baseT();
  // el resolvedor es puro: no usa convenios, ni esFacturaTercero, ni nada de la configuración
  const RS = require('node:fs').readFileSync(path.join(root, 'cardiolink-presentaciones-os-core.js'), 'utf8');
  const fn = RS.slice(RS.indexOf('function crearResolvedorFacturante'), RS.indexOf('/** Lista AUTOMÁTICA'));
  assert.ok(!/convenio|esRegistroFacturaRogelio|incluirFacturaRogelio|destinoEstudio|window|data\./i.test(fn), 'el resolvedor solo usa delegaciones y la propia atención');
  const antes = C.crearResolvedorFacturante(DELEG)(lista[0]);
  // «el convenio cambió» (Matías consigue convenio directo): se simula con otra función de tercero legada → no cambia nada
  assert.deepEqual(C.crearResolvedorFacturante(DELEG)(lista[0]), antes);
  // lo ya presentado conserva su facturante aunque después se cambie o desactive la delegación
  const al = C.crearAlmacenMemoria({ control: IN_T, atenciones: lista, delegaciones: DELEG });
  await al.confirmar(C.payloadConfirmar('2026-12', C.armarLotes(calcT({ atenciones: lista }).listos.filter((x) => x.id === 'T1'))));
  const guardado = JSON.stringify(al._estado.items[0]);
  DELEG.forEach((d) => { d.activa = false; });
  const luego = calcT({ atenciones: lista, presentados: await al.leerPresentados(), facturanteDe: C.crearResolvedorFacturante(DELEG) });
  assert.ok(!ids(luego.listos).includes('T1'), 'lo ya presentado no se vuelve a ofrecer, ni por quien realizó');
  assert.equal(JSON.stringify(al._estado.items[0]), guardado, 'el registro presentado quedó intacto');
  assert.ok(ids(luego.listos).includes('T2'), 'lo NO presentado todavía sí sigue la delegación vigente (inactiva → factura quien realizó)');
  assert.equal(luego.listos.find((x) => x.id === 'T2').profesionalId, 'matias');
  DELEG.forEach((d) => { d.activa = true; });
});

t('X7 · TERCEROS: Caja y Finanzas no se modifican — producción idéntica antes y después de presentar por terceros; atenciones sin tocar; cada ítem con su fecha original', async () => {
  const lista = baseT(); const copia = JSON.parse(JSON.stringify(lista));
  const prod = () => F.calcularIngresosCanonicos({ atenciones: lista, desde: '2026-12-01', hasta: '2026-12-31', obtenerArancel: fijado, normalizar: C.norm });
  const antes = JSON.stringify(prod());
  const al = C.crearAlmacenMemoria({ control: IN_T, atenciones: lista, delegaciones: DELEG });
  await al.confirmar(C.payloadConfirmar('2026-12', C.armarLotes(calcT({ atenciones: lista }).listos)));
  assert.equal(JSON.stringify(prod()), antes); assert.deepEqual(lista, copia);
  assert.ok(al._estado.items.every((i) => i.fecha_atencion === lista.find((a) => String(a.id) === i.atencion_id).fecha));
});

t('X8 · TERCEROS: compatibilidad V1 — sin delegaciones (SQL complementario sin aplicar) el comportamiento es el de la V1; y el SQL complementario fija las reglas del diseño', () => {
  const v1 = calc(); const sinResolver = C.calcularPendientes({ atenciones: base(), presentados: [], desde: '2026-09-01', hastaMes: '2026-11', obtenerArancel });
  assert.deepEqual(ids(v1.listos), ids(sinResolver.listos));
  const UIsrc = leer('cardiolink-presentaciones-os-v1.js');
  assert.match(UIsrc, /leerDelegaciones[\s\S]{0,260}noHabilitada\(r\.error\)\) return null/, 'si la tabla no existe devuelve null → modo V1');
  assert.match(UIsrc, /if \(Array\.isArray\(st\.delegaciones\)\) o\.facturanteDe = Core\.crearResolvedorFacturante\(st\.delegaciones\)/);
  assert.ok(!/realizadas por vos/.test(UIsrc), 'el aviso informativo no habla en primera persona: lo lee también una Secretaría');
  assert.match(UIsrc, /prestaciones realizadas por ' \+ \[\.\.\.new Set\(deleg\.map\(\(x\) => nombreProfesional\(x\.realizadoPor\)\)\)\]\.join\(', '\)/, 'el aviso nombra al profesional que realizó');
  const f = 'docs/propuestas/pending_review_facturacion_presentaciones_v1_terceros.sql';
  ['_terceros_rollback', '_terceros_checks', '_terceros_ensayo_pruebas', '_terceros_ensayo_reversible'].forEach((x) => assert.ok(fs.existsSync(path.join(root, 'docs/propuestas/pending_review_facturacion_presentaciones_v1' + x + '.sql')), x));
  const s = leer(f), sinCom = s.replace(/--.*$/gm, '');
  assert.match(sinCom, /PRIMARY KEY \(realiza_professional_id, destino_norm\)/, 'un único facturante por (quien realiza, destino)');
  assert.match(sinCom, /CHECK \(realiza_professional_id <> facturante_professional_id\)/);
  assert.match(sinCom, /v_fact <> v_prof/); assert.match(sinCom, /NOT LIKE '%consulta%'/); assert.match(sinCom, /d\.activa/);
  assert.match(sinCom, /PR412/); assert.match(sinCom, /v_real, v_prof, left\(nullif\(btrim\(coalesce\(v_pl ->> 'prestacionA'/, 'guarda quién realizó, quién factura y el destino');
  assert.match(sinCom, /CHECK \(facturante_professional_id = professional_id/);
  assert.ok(!/CREATE (UNIQUE )?INDEX[^;]*items_v1[^;]*DROP|DROP INDEX[^;]*atencion_uq/i.test(sinCom), 'no toca el índice único por atención');
  assert.ok(!/UPDATE\s+public\.cardiolink_atenciones|INSERT\s+INTO\s+public\.cardiolink_atenciones|DELETE\s+FROM\s+public\.cardiolink_atenciones/i.test(sinCom), 'no modifica atenciones');
  assert.ok(!/finance|cobro|caja|colocacion|hc_|cardiolink_patient/i.test(sinCom.replace(/'[^']*'/g, "''")), 'no toca Caja, Finanzas, Colocaciones ni HC');
  assert.match(sinCom, /coalesce\(\(SELECT public\.cardiolink_ctx_rol_v1\(\)\), ''\) NOT IN \('owner', 'admin'\)/, 'guarda robusta ante usuarios sin rol (NULL NOT IN no frena)');
  assert.match(sinCom, /INSERT INTO public\.cardiolink_presentaciones_os_delegaciones_v1[\s\S]{0,400}'matias', 'rogelio', 'rogelio'[\s\S]{0,300}'matias', 'dr\. rogelio anchorena', 'rogelio'/, 'semilla aprobada: Matías → Rogelio');
  const rb = leer('docs/propuestas/pending_review_facturacion_presentaciones_v1_terceros_rollback.sql').replace(/--.*$/gm, '');
  assert.match(rb, /DROP TABLE IF EXISTS public\.cardiolink_presentaciones_os_delegaciones_v1/); assert.match(rb, /DROP COLUMN IF EXISTS facturante_professional_id/);
  assert.ok(/PR412/.test(rb.split('CREATE OR REPLACE FUNCTION public.cardiolink_presentacion_os_confirmar_v1')[1].split('$f$;')[0]) && !/delegaciones_v1/.test(rb.split('CREATE OR REPLACE FUNCTION public.cardiolink_presentacion_os_confirmar_v1')[1].split('$f$;')[0]), 'el rollback vuelve a la RPC base');
  // misma normalización que el servidor
  assert.equal(C.norm('  Dr.  ROGELIO   Anchorena '), 'dr. rogelio anchorena'); assert.equal(C.norm('MATÍAS'), 'matias');
  assert.match(sinCom, /translate\(lower\(coalesce\(p, ''\)\), 'áàäâéèëêíìïîóòöôúùüûñ', 'aaaaeeeeiiiioooouuuun'\)/);
});

// ===== CIERRE DEL CÍRCULO MÉDICO (día 25): período 26→25, corte manual, fecha efectiva de presentación =====
const fx = (id, fecha, extra) => Object.assign({ id, fecha, obraSocial: 'OSDE', prestacion: 'Holter', profesionalId: 'matias', paciente: 'P ' + id, pacienteId: 'p_' + id, estadoTurno: 'atendido', valorArancelEstimado: 1000, arancelId: 'ar_' + id, prestacionA: '' }, extra || {});
const LISTA_C = () => [fx('c1', '2026-12-05'), fx('c2', '2026-12-20'), fx('c3', '2026-12-25'), fx('c4', '2026-12-26'), fx('c5', '2027-01-10'), fx('c6', '2027-01-24'), fx('c7', '2027-01-25'), fx('c8', '2027-01-26'), fx('c9', '2027-01-31'),
  fx('o1', '2026-12-10', { obraSocial: 'Galeno' }), fx('r1', '2027-01-12', { profesionalId: 'rogelio', obraSocial: 'Galeno' })];
const calcC = (mes, extra) => C.calcularPendientes(Object.assign({ atenciones: LISTA_C(), presentados: [], desde: '2026-12-01', hastaMes: mes, hastaFecha: C.corteHabitual(mes), obtenerArancel: fijado }, extra || {}));

t('CZ1 · CIERRE: corte habitual el 25, período del 26 del mes anterior al 25 inclusive (también en enero), y control de fechas', () => {
  assert.equal(C.DIA_CIERRE, 25); assert.equal(C.corteHabitual('2027-01'), '2027-01-25'); assert.equal(C.inicioPeriodo('2027-01'), '2026-12-26'); assert.equal(C.inicioPeriodo('2026-12'), '2026-11-26'); assert.equal(C.mesAnterior('2027-01'), '2026-12');
  const v = (o) => C.validarCierre(Object.assign({ periodo: '2027-01', corte: '2027-01-25', presentacion: '2027-01-26', hoy: '2027-01-26', ultimaAtencion: '2027-01-25' }, o));
  assert.deepEqual(v({}), []); assert.deepEqual(v({ corte: '2027-01-23' }), []); assert.deepEqual(v({ corte: '2027-01-31' }), []);
  assert.ok(v({ corte: '2027-02-01' }).length, 'corte fuera del mes del período'); assert.ok(v({ corte: '2027-02-30' }).length); assert.ok(v({ corte: 'x' }).length);
  assert.ok(v({ presentacion: '2027-01-27' }).length, 'presentación futura'); assert.ok(v({ presentacion: '2027-01-24' }).length, 'presentación anterior a la última atención incluida'); assert.ok(v({ presentacion: '' }).length);
  assert.deepEqual(v({ presentacion: '2027-01-25' }), [], 'el mismo día de la última atención es válido');
});

t('CZ2 · CIERRE: la lista entra hasta el corte INCLUSIVE; con corte manual (23, 24, 26) cambia solo ese límite; lo de períodos anteriores sigue apareciendo solo', () => {
  const ids = (r) => r.listos.map((x) => x.id).sort().join(',');
  const r25 = calcC('2027-01'); assert.equal(ids(r25), 'c1,c2,c3,c4,c5,c6,c7,o1,r1'.split(',').sort().join(','), 'hasta el 25/01 inclusive (c8 y c9 quedan para el próximo período)');
  assert.equal(r25.periodo.desde, '2026-12-26'); assert.equal(r25.periodo.corte, '2027-01-25'); assert.equal(r25.periodo.corteHabitual, '2027-01-25');
  const por = (r, id) => r.listos.find((x) => x.id === id);
  assert.equal(por(r25, 'c1').anterior, true, 'del 05/12: pendiente de un período anterior'); assert.equal(por(r25, 'c3').anterior, true); assert.equal(por(r25, 'c4').anterior, false, '26/12: primer día del período'); assert.equal(por(r25, 'c7').anterior, false);
  assert.equal(r25.anteriores, 4, 'c1, c2, c3 y o1');
  assert.equal(ids(calcC('2027-01', { hastaFecha: '2027-01-24' })), 'c1,c2,c3,c4,c5,c6,o1,r1'.split(',').sort().join(','), 'corte 24: la del 25 pasa al período siguiente');
  assert.equal(ids(calcC('2027-01', { hastaFecha: '2027-01-23' })), 'c1,c2,c3,c4,c5,o1,r1'.split(',').sort().join(','));
  assert.equal(ids(calcC('2027-01', { hastaFecha: '2027-01-26' })), 'c1,c2,c3,c4,c5,c6,c7,c8,o1,r1'.split(',').sort().join(','), 'corte 26: entra la del 26');
  // la regla no depende de «mes calendario»: sin hastaFecha se mantiene el comportamiento anterior (fin de mes)
  assert.equal(ids(C.calcularPendientes({ atenciones: LISTA_C(), presentados: [], desde: '2026-12-01', hastaMes: '2027-01', obtenerArancel: fijado })).includes('c9'), true);
  // lo presentado nunca reaparece y lo no presentado de un período anterior sigue ahí en el siguiente
  const presentadas = ['c1', 'c4', 'c5'];
  const sig = C.calcularPendientes({ atenciones: LISTA_C(), presentados: presentadas, desde: '2026-12-01', hastaMes: '2027-02', hastaFecha: '2027-02-25', obtenerArancel: fijado });
  assert.ok(!sig.listos.some((x) => presentadas.includes(x.id)), 'lo presentado no se ofrece'); ['c2', 'c3', 'c6', 'c7', 'c8', 'c9'].forEach((id) => assert.ok(sig.listos.some((x) => x.id === id), 'sigue pendiente: ' + id));
  assert.equal(sig.listos.find((x) => x.id === 'c7').anterior, true, 'el 25/01 pertenece al período de enero: en febrero es anterior'); assert.equal(sig.listos.find((x) => x.id === 'c8').anterior, false, 'el 26/01 es el primer día del período de febrero');
});

t('CZ3 · CIERRE: tres fechas separadas, importes por cobertura y facturante, y NUNCA duplica (servidor simulado)', async () => {
  const atenciones = LISTA_C();
  const al = C.crearAlmacenMemoria({ control: '2026-12-01', atenciones, ahora: () => '2027-01-27T15:00:00.000Z' });
  const r = C.calcularPendientes({ atenciones, presentados: [], desde: '2026-12-01', hastaMes: '2027-01', hastaFecha: '2027-01-25', obtenerArancel: fijado });
  const lotes = C.armarLotes(r.listos);
  const m = lotes.find((l) => l.cobertura === 'OSDE' && l.profesionalId === 'matias'), g = lotes.find((l) => l.cobertura === 'Galeno' && l.profesionalId === 'matias'), gr = lotes.find((l) => l.cobertura === 'Galeno' && l.profesionalId === 'rogelio');
  assert.equal(lotes.length, 3, 'un lote por (cobertura, profesional facturante)');
  assert.equal(m.cantidad, 7); assert.equal(m.total, 7000); assert.equal(m.anteriores.cantidad, 3); assert.equal(m.anteriores.total, 3000); assert.equal(m.delPeriodo.cantidad, 4); assert.equal(m.delPeriodo.total, 4000);
  assert.equal(g.cantidad, 1); assert.equal(g.anteriores.cantidad, 1); assert.equal(g.delPeriodo.cantidad, 0); assert.equal(gr.cantidad, 1); assert.equal(gr.delPeriodo.total, 1000);
  assert.equal(C.redondear(lotes.reduce((s, l) => s + l.total, 0)), r.total, 'el total por lotes coincide con el de la lista');
  const p = C.payloadConfirmar('2027-01', lotes, { corte: '2027-01-25', presentacion: '2027-01-27' });
  assert.equal(p.p_fecha_corte, '2027-01-25'); assert.equal(p.p_fecha_presentacion, '2027-01-27'); assert.equal(p.p_periodo, '2027-01');
  assert.deepEqual(Object.keys(C.payloadConfirmar('2027-01', lotes)).sort(), ['p_lotes', 'p_periodo'], 'sin cierre: el payload es el de siempre (compatible)'); assert.deepEqual(Object.keys(C.payloadConfirmar('2027-01', lotes, 0)).sort(), ['p_lotes', 'p_periodo']);
  const res = await al.confirmar(p); assert.equal(res.items, 9);
  const hist = await al.leerHistorial(true); assert.ok(hist.length === 3 && hist.every((h) => h.periodo === '2027-01' && h.fecha_corte === '2027-01-25' && h.fecha_presentacion === '2027-01-27'), 'período, corte y presentación quedan por separado');
  assert.deepEqual(al._estado.items.map((i) => i.fecha_atencion).sort()[0], '2026-12-05', 'cada ítem conserva su fecha de atención');
  await assert.rejects(al.confirmar(p), (e) => e.code === '23505', 'repetir no duplica'); assert.equal(al._estado.items.length, 9);
  const otra = C.armarLotes(C.calcularPendientes({ atenciones, presentados: await al.leerPresentados(), desde: '2026-12-01', hastaMes: '2027-02', hastaFecha: '2027-02-25', obtenerArancel: fijado }).listos);
  assert.equal(otra.reduce((s, l) => s + l.cantidad, 0), 2, 'solo quedan c8 y c9 para el período siguiente');
});

t('CZ4 · CIERRE: el servidor rechaza corte fuera del mes (PR413), presentación futura o anterior a una prestación (PR414) y prestaciones posteriores al corte; no guarda nada', async () => {
  const atenciones = LISTA_C();
  const mk = () => C.crearAlmacenMemoria({ control: '2026-12-01', atenciones, ahora: () => '2027-01-27T15:00:00.000Z' });
  const lotesDe = (ids) => C.armarLotes(C.calcularPendientes({ atenciones, presentados: [], desde: '2026-12-01', hastaMes: '2027-01', hastaFecha: '2027-01-31', obtenerArancel: fijado }).listos.filter((x) => ids.includes(x.id)));
  const L = lotesDe(['c1', 'c6']);
  let al = mk();
  await assert.rejects(al.confirmar(C.payloadConfirmar('2027-01', L, { corte: '2027-02-01', presentacion: '2027-01-27' })), (e) => /PR413/.test(e.message));
  await assert.rejects(al.confirmar(C.payloadConfirmar('2027-01', L, { corte: '2027-01-25', presentacion: '2027-01-28' })), (e) => /PR414/.test(e.message), 'futura');
  await assert.rejects(al.confirmar(C.payloadConfirmar('2027-01', L, { corte: '2027-01-25', presentacion: '2027-01-20' })), (e) => /PR414/.test(e.message), 'anterior a c6 (24/01)');
  await assert.rejects(al.confirmar(C.payloadConfirmar('2027-01', lotesDe(['c8']), { corte: '2027-01-25', presentacion: '2027-01-27' })), (e) => /PR409/.test(e.message), 'c8 (26/01) es posterior al corte');
  assert.equal(al._estado.items.length, 0, 'nada guardado'); assert.equal(al._estado.lotes.length, 0);
  assert.equal(C.mapearError({ message: 'PR413 x' }).tipo, 'corte'); assert.equal(C.mapearError({ message: 'PR414 x' }).tipo, 'fecha');
  const viejo = await al.confirmar(C.payloadConfirmar('2027-01', L)); assert.equal(viejo.items, 2, 'una llamada sin las fechas nuevas (cliente viejo) se comporta como antes');
  const h = (await al.leerHistorial(true))[0]; assert.equal(h.fecha_corte, '2027-01-31', 'corte = fin de mes'); assert.equal(h.fecha_presentacion, '2027-01-27', 'presentación = hoy');
});

t('CZ5 · CIERRE: la pantalla detecta si el SQL del cierre está aplicado (sin él funciona como antes), arma el período, el corte editable y la fecha de presentación, y no toca Caja/HC/Aranceles', () => {
  const UI = leer('cardiolink-presentaciones-os-v1.js'), CORE = leer('cardiolink-presentaciones-os-core.js');
  assert.match(UI, /async cierreDisponible\(\)[\s\S]{0,400}42703/, 'sin las columnas nuevas (42703) → modo anterior');
  assert.match(UI, /st\.cierre = typeof almacen\.cierreDisponible === 'function'/); assert.match(UI, /leerHistorial\(st\.cierre\)/);
  assert.match(UI, /\.select\('id,cobertura,[^']*' \+ \(conCierre \? ',fecha_corte,fecha_presentacion' : ''\)\)/, 'solo pide las columnas nuevas si existen');
  assert.match(UI, /hastaFecha: corteEfectivo\(\)/); assert.match(UI, /id: 'presOsCorte'/); assert.match(UI, /id: 'presOsFechaPres'/); assert.match(UI, /Volver al corte habitual \(25\)/);
  assert.match(UI, /Core\.payloadConfirmar\(st\.mes, lotes, cierre\)/); assert.match(UI, /Core\.validarCierre\(/); assert.match(UI, /cierre = null;/, 'sin cierre disponible no se envían las fechas nuevas');
  assert.match(UI, /del período ' \+ l\.delPeriodo\.cantidad/, 'cantidades e importes por lote separando el período de lo anterior');
  assert.match(UI, /x\.anterior \? 'Anterior' : 'Del período'/); assert.match(UI, /Presentada el/);
  assert.match(CORE, /function inicioPeriodo/); assert.match(CORE, /DIA_CIERRE = 25/);
  const src = (UI + CORE).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/copagoDePrestacion|calcularIngresosCanonicos|guardarAtencion|saveAtenciones|colocador|evolucion/i.test(src), 'no toca Caja, HC, aranceles ni colocaciones');
});

t('CZ6 · CIERRE: SQL propuesto — columnas nullable sin tocar históricos, RPC de 4 argumentos compatible con la de 2, PR413/PR414, mismos permisos y mismas reglas, rollback y ensayo', () => {
  const f = 'docs/propuestas/pending_review_presentaciones_os_cierre_25_v1';
  [f + '.sql', f + '_rollback.sql', f + '_checks.sql', f + '_ensayo_pruebas.sql', f + '_ensayo_reversible.sql', f + '_generar_ensayo.sh'].forEach((x) => assert.ok(fs.existsSync(path.join(root, x)), x));
  const sql = leer(f + '.sql'), s = sql.replace(/--.*$/gm, '');
  assert.match(s, /ADD COLUMN fecha_corte date NULL, ADD COLUMN fecha_presentacion date NULL/); assert.ok(!/ADD COLUMN[^;]*NOT NULL|ADD COLUMN[^;]*DEFAULT/i.test(s.match(/ALTER TABLE[^;]*ADD COLUMN[^;]*;/)[0].replace(/NULL,/g, ',').replace(/ NULL;/, ';').replace(/\bNULL\b/g, '')) , 'nullable y sin valor por defecto: no se inventan fechas históricas');
  assert.ok(!/UPDATE\s+public\.cardiolink_presentaciones_os|DELETE\s+FROM\s+public\.cardiolink_presentaciones_os|UPDATE\s+public\.cardiolink_atenciones|INSERT\s+INTO\s+public\.cardiolink_atenciones/i.test(s), 'no modifica históricos ni atenciones');
  assert.match(s, /p_fecha_corte date DEFAULT NULL, p_fecha_presentacion date DEFAULT NULL/); assert.match(s, /DROP FUNCTION public\.cardiolink_presentacion_os_confirmar_v1\(text, jsonb\)/);
  assert.match(s, /PR413/); assert.match(s, /PR414/); assert.match(s, /to_char\(p_fecha_corte, 'YYYY-MM'\) <> p_periodo/); assert.match(s, /p_fecha_presentacion > current_date/); assert.match(s, /v_f > v_fpres/);
  ['PR403', 'PR409', 'PR411', 'PR412', 'delegaciones_v1', 'cardiolink_presentacion_os_confirmar_permitido_v1', 'presentado_por_rol'].forEach((k) => assert.ok(s.includes(k), 'conserva ' + k));
  assert.match(s, /REVOKE ALL ON FUNCTION public\.cardiolink_presentacion_os_confirmar_v1\(text, jsonb, date, date\) FROM PUBLIC, anon/); assert.match(s, /GRANT EXECUTE ON FUNCTION[^;]*TO authenticated/);
  assert.ok(!/DROP\s+(INDEX|TABLE|POLICY)|CREATE\s+(UNIQUE\s+)?INDEX|ALTER\s+TABLE\s+public\.cardiolink_presentaciones_os_items_v1|DISABLE|GRANT\s+(INSERT|UPDATE|DELETE)/i.test(s), 'no toca índices, ítems, políticas ni grants de tablas');
  assert.ok(!/finance|cobro|caja|colocacion|hc_|cardiolink_patient/i.test(s.replace(/'[^']*'/g, "''")), 'no toca Caja, Finanzas, Colocaciones ni HC');
  // la RPC nueva es idéntica a la del complemento de terceros salvo las líneas del cierre (misma lógica de facturante, permisos y arancel)
  const cuerpo = (x) => x.split('BEGIN\n  IF v_uid IS NULL')[1].split('$f$;')[0];
  const nuevo = cuerpo(s).split('\n').filter((l) => !/p_fecha|v_corte|v_fpres|PR413|PR414|fecha_corte|ELSE v_corte|END IF;\s*$/.test(l) || /RAISE|IF /.test(l) && false);
  const viejo = cuerpo(leer('docs/propuestas/pending_review_facturacion_presentaciones_v1_terceros.sql').replace(/--.*$/gm, ''));
  ['v_fact <> v_prof', 'NOT LIKE \'%consulta%\'', 'd.activa', 'PR412', 'v_exc := v_f < v_ctrl', 'abs(v_val - v_importe) > 0.01'].forEach((k) => assert.ok(cuerpo(s).includes(k) && viejo.includes(k), 'misma regla: ' + k));
  const rb = leer(f + '_rollback.sql').replace(/--.*$/gm, ''); assert.match(rb, /DROP COLUMN IF EXISTS fecha_corte, DROP COLUMN IF EXISTS fecha_presentacion/); assert.match(rb, /delegaciones_v1/); assert.match(rb, /PR412/);
  assert.ok(!/p_fecha_corte/.test(rb.split('CREATE OR REPLACE FUNCTION')[1]), 'el rollback restaura la RPC de 2 argumentos');
});

(async () => {
  for (const [nombre, fn] of pendientes) { try { await fn(); ok++; console.log('  OK  ' + nombre); } catch (e) { fail++; console.log('FALLA ' + nombre + '\n      ' + (e && e.message || e)); } }
  console.log('\npresentaciones-os-v1: ' + ok + '/' + (ok + fail) + ' pruebas OK');
  if (fail && typeof process !== 'undefined') process.exitCode = 1;
})();
