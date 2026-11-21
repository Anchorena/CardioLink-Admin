'use strict';
// Fichas estables · la tabla relacional manda; refrescar/leer nunca escribe; sólo las ediciones reales generan pendientes; reintento automático acotado; errores permanentes sin bucle.
// Ejecutar: node --test cardiolink-fichas-estables.test.cjs   (extrae las funciones REALES de app.js y usa el módulo real de fichas; sin servidor ni navegador)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('./cardiolink-pacientes-ficha-v1.js');
const APP = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const GLUE = fs.readFileSync(path.join(__dirname, 'cardiolink-outbox-glue-v1.js'), 'utf8');
const R2B = fs.readFileSync(path.join(__dirname, 'cardiolink-config-concurrencia-v1.js'), 'utf8');
const clon = (o) => JSON.parse(JSON.stringify(o));

function tramo(src, ini, fin) { const a = src.indexOf(ini), b = src.indexOf(fin, a + 1); assert.ok(a >= 0 && b > a, 'no se encontró ' + ini); return src.slice(a, b); }

// ---------- servidor simulado: tabla cardiolink_pacientes con UPDATE condicionado, conteo de escrituras y errores inyectables ----------
function servidor(filas) {
  const tabla = new Map(filas.map((f) => [f.id, clon(f)])), rastro = { inserts: 0, updates: 0, escrituras: [] }, hooks = {};
  function consulta() {
    const q = { _f: [], _op: 'select', _vals: null };
    q.select = () => { return q; };
    q.eq = (c, v) => { q._f.push([c, v, 'eq']); return q; }; q.neq = (c, v) => { q._f.push([c, v, 'neq']); return q; }; q.limit = () => q;
    q.insert = (v) => { q._op = 'insert'; q._vals = v; return q; }; q.update = (v) => { q._op = 'update'; q._vals = v; return q; };
    q.then = (res, rej) => ejecutar(q).then(res, rej);
    return q;
  }
  async function ejecutar(q) {
    const filtrar = () => Array.from(tabla.values()).filter((f) => q._f.every(([c, v, t]) => (t === 'eq' ? String(f[c]) === String(v) : String(f[c]) !== String(v))));
    if (hooks.error && q._op !== 'select') return { data: null, error: hooks.error };
    if (q._op === 'select') return { data: filtrar().map(clon), error: null };
    if (q._op === 'insert') { rastro.inserts++; rastro.escrituras.push('insert'); const f = clon(q._vals[0]); tabla.set(f.id, f); return { data: [clon(f)], error: null }; }
    const afectadas = filtrar(); rastro.updates++; rastro.escrituras.push('update:' + Object.keys(q._vals).filter((k) => k !== 'actualizado_en').sort().join(','));
    afectadas.forEach((f) => Object.assign(tabla.get(f.id), q._vals)); return { data: afectadas.map((f) => clon(tabla.get(f.id))), error: null };
  }
  return { tabla, rastro, hooks, sb: { from: () => consulta() } };
}
const fila = (extra) => Object.assign({ id: 'p1', nombre_completo: 'Ana Pérez', dni: '30111222', fecha_nacimiento: '1980-01-01', sexo: 'F', localidad: 'Lomas', provincia: 'Buenos Aires', direccion: null,
  cobertura_habitual: 'OSDE', numero_afiliado_habitual: '123', telefono: '1155', email: null, activo: true, actualizado_en: '2026-11-10T10:00:00.000Z' }, extra || {});

// ---------- entorno de la capa clínica extraída de app.js ----------
function capa(extra) {
  const ctx = Object.assign({ console, String, Array, Object, Map, Set, JSON, Promise, Date, Math, setTimeout, clearTimeout, window: { addEventListener() {} }, data: { pacientes: [] }, localStorage: { setItem() {}, getItem() { return null; } },
    storageConfig: 'cfg', alias410: new Map(), adoptados410: [], digits410: (v) => String(v || '').replace(/\D/g, ''), registrarCola410() {}, listo410: () => true }, extra || {});
  ctx.window.cardiolinkFichaV1 = F; vm.createContext(ctx); return ctx;
}
function cargarMerge(ctx) { vm.runInContext(tramo(APP, '  function mergePaciente410(row){', '  function mergeResumen410(row){') + '\nthis.mergePaciente410=mergePaciente410;', ctx); return ctx.mergePaciente410; }

test('REFRESCOS: 100 pacientes × 5 ciclos con copia local distinta de la tabla → CERO escrituras, CERO pendientes y la copia siempre queda alineada con la tabla', () => {
  F.limpiarEstado(); const ctx = capa(), merge = cargarMerge(ctx);
  const filas = Array.from({ length: 100 }, (_, i) => fila({ id: 'p' + i, dni: String(30000000 + i), telefono: '11' + i }));
  ctx.data.pacientes = filas.map((f, i) => ({ id: f.id, nombreCompleto: 'Copia vieja ' + i, dni: f.dni, telefono: 'viejo', localidad: 'Quilmes', fechaNacimiento: '1970-02-02', actualizadoEn: '2020-01-01T00:00:00Z' }));
  for (let ciclo = 0; ciclo < 5; ciclo++) filas.forEach((f) => merge(f));
  assert.equal(F.listarPendientes().length, 0, 'ningún pendiente por refrescar'); assert.equal(F.listarDivergencias().length, 0, 'ninguna divergencia');
  assert.ok(ctx.data.pacientes.every((p, i) => p.nombreCompleto === 'Ana Pérez' && p.telefono === '11' + i && p.localidad === 'Lomas'), 'la copia sigue a la tabla');
  assert.equal(ctx.adoptados410.length >= 100, true, 'lo adoptado se informa a la configuración como NO-edición');
});

test('CAMPO ELIMINADO A PROPÓSITO: una copia vieja con el teléfono NO lo resucita (ni se rellena la tabla desde la copia)', () => {
  F.limpiarEstado(); const ctx = capa(), merge = cargarMerge(ctx);
  ctx.data.pacientes = [{ id: 'p1', nombreCompleto: 'Ana Pérez', dni: '30111222', telefono: '1155-VIEJO', email: 'viejo@x.com', direccion: 'Calle vieja 1' }];
  merge(fila({ telefono: null, email: null, direccion: null }));
  const p = ctx.data.pacientes[0]; assert.equal(p.telefono, ''); assert.equal(p.email, ''); assert.equal(p.direccion, '');
  assert.equal(F.listarPendientes().length, 0);
});

test('EDICIÓN REAL en curso: el refresco no pisa lo que la persona escribió y todavía no se guardó', () => {
  F.limpiarEstado(); const ctx = capa(), merge = cargarMerge(ctx);
  ctx.data.pacientes = [{ id: 'p1', nombreCompleto: 'Ana Pérez', dni: '30111222', telefono: '2222' }];
  F.marcarPendiente('p1', { telefono: { a: '1155', d: '2222' } }, 'usuario'); merge(fila());
  assert.equal(ctx.data.pacientes[0].telefono, '2222');
  F.limpiarEstado();
});

// ---------- sincronización básica (Carga, panel, alta) ----------
function sincronizador(srv) {
  const ctx = capa({ supabaseClient: srv.sb, usuarioSupabase: { id: 'u1' }, idRelacional410: async (p) => p.id, aplicarResultadoFicha410() {}, programarReintento410() {} });
  vm.runInContext(tramo(APP, '  async function sincronizarFichaPacienteBasica410(p){', '  // Cuando un alta local ("nueva" solo porque') + '\nthis.sync=sincronizarFichaPacienteBasica410;', ctx); return ctx;
}
const dePantalla = (f) => ({ id: f.id, nombreCompleto: f.nombre_completo, dni: f.dni, fechaNacimiento: f.fecha_nacimiento, sexo: f.sexo, localidad: f.localidad, provincia: f.provincia, coberturaHabitual: f.cobertura_habitual, numeroAfiliadoHabitual: f.numero_afiliado_habitual, telefono: f.telefono, email: f.email || '', direccion: f.direccion || '' });

test('REGISTRAR UNA ATENCIÓN SIN EDITAR LA FICHA: cero escrituras de datos personales (la comparación es contra lo que la persona vio)', async () => {
  F.limpiarEstado(); const S = servidor([fila()]), ctx = sincronizador(S), p = dePantalla(S.tabla.get('p1'));
  F.registrarVista(S.tabla.get('p1')); F.fijarVistaEdicion('p1', p);                          // usarPaciente(): el formulario muestra la ficha
  assert.equal(await ctx.sync(Object.assign({}, p)), true); assert.equal(S.rastro.updates + S.rastro.inserts, 0);
  // otra sesión cambia el teléfono; el formulario (con el teléfono viejo) se guarda SIN que la persona lo haya tocado: lo no editado no se escribe
  S.tabla.get('p1').telefono = '9999'; S.tabla.get('p1').actualizado_en = '2026-11-12T10:00:00.000Z'; F.registrarVista(S.tabla.get('p1')); F.fijarVistaEdicion('p1', p);
  assert.equal(await ctx.sync(Object.assign({}, p)), true); assert.equal(S.rastro.updates, 0, 'no pisa el teléfono nuevo con el viejo del formulario'); assert.equal(S.tabla.get('p1').telefono, '9999');
  // sin saber qué vio la persona (no hay vista de edición) y con la ficha ya existente: NO se escribe nunca
  assert.equal(await ctx.sync(Object.assign({}, p, { telefono: '0000' })), true); assert.equal(S.rastro.updates, 0); assert.equal(S.tabla.get('p1').telefono, '9999');
});

test('EDICIÓN REAL de una ficha: guarda SÓLO el campo modificado con confirmación del servidor', async () => {
  F.limpiarEstado(); const S = servidor([fila()]), ctx = sincronizador(S), p = dePantalla(S.tabla.get('p1'));
  F.registrarVista(S.tabla.get('p1')); F.fijarVistaEdicion('p1', p); const editado = Object.assign({}, p, { email: 'nuevo@x.com' });
  assert.equal(await ctx.sync(editado), true); assert.deepEqual(S.rastro.escrituras, ['update:email']); assert.equal(S.tabla.get('p1').email, 'nuevo@x.com'); assert.equal(F.listarPendientes().length, 0);
});

test('EDICIONES SIMULTÁNEAS: lo que otra sesión cambió en OTRO campo se conserva; el MISMO campo no se pisa en silencio', async () => {
  F.limpiarEstado(); const S = servidor([fila()]), ctx = sincronizador(S), p = dePantalla(S.tabla.get('p1'));
  F.registrarVista(S.tabla.get('p1')); F.fijarVistaEdicion('p1', p);
  S.tabla.get('p1').localidad = 'Avellaneda'; S.tabla.get('p1').telefono = '7777'; S.tabla.get('p1').actualizado_en = '2026-11-12T10:00:00.000Z';   // otra sesión
  await ctx.sync(Object.assign({}, p, { telefono: '8888', email: 'mio@x.com' }));
  assert.equal(S.tabla.get('p1').email, 'mio@x.com', 'mi cambio independiente se aplica'); assert.equal(S.tabla.get('p1').localidad, 'Avellaneda', 'el cambio ajeno se conserva');
  assert.equal(S.tabla.get('p1').telefono, '7777', 'mismo campo: gana lo ya guardado y se informa; no se pisa en silencio');
});

test('ALTA DE PACIENTE NUEVO: se crea la fila con insert (una escritura)', async () => {
  F.limpiarEstado(); const S = servidor([]), ctx = sincronizador(S);
  assert.equal(await ctx.sync({ id: 'pnuevo', nombreCompleto: 'Nuevo Paciente', dni: '40111222', fechaNacimiento: '1990-05-05', sexo: 'M', telefono: '1100' }), true);
  assert.deepEqual(S.rastro.escrituras, ['insert']); assert.equal(S.tabla.get('pnuevo').nombre_completo, 'Nuevo Paciente');
});

test('SIN LA FILA CARGADA (sin lo que la persona vio): nunca se pisa una ficha existente con la copia local (los conflictos conservan el valor del servidor)', async () => {
  F.limpiarEstado(); const S = servidor([fila()]), ctx = sincronizador(S);
  await ctx.sync({ id: 'p1', nombreCompleto: 'Copia vieja', dni: '30111222', telefono: '0000', localidad: 'Quilmes' });
  assert.equal(S.tabla.get('p1').nombre_completo, 'Ana Pérez'); assert.equal(S.tabla.get('p1').telefono, '1155'); assert.equal(S.rastro.updates, 0);
});

// ---------- errores: sin bucles, sin ocultar ----------
test('ERRORES PERMANENTES (permiso, validación, DNI repetido): se conservan con su motivo y NO se reintentan; los transitorios sí', async () => {
  F.limpiarEstado(); const S = servidor([fila()]), p = dePantalla(S.tabla.get('p1')); F.registrarVista(S.tabla.get('p1'));
  const intentar = async (err) => { S.hooks.error = err; F.limpiarEstado(); F.registrarVista(S.tabla.get('p1')); return F.guardarEdicion({ sb: S.sb, id: 'p1', base: p, nuevo: Object.assign({}, p, { telefono: '1' }) }); };
  let r = await intentar({ code: '42501', message: 'new row violates row-level security policy' }); assert.equal(F.esErrorPermanente(r), true); assert.equal(F.listarPendientes()[0].rechazo.tipo, 'permiso');
  r = await intentar({ code: '22008', message: 'date/time field value out of range' }); assert.equal(F.esErrorPermanente(r), true); assert.equal(F.listarPendientes()[0].rechazo.tipo, 'invalido');
  r = await intentar({ code: 'XX000', message: 'Failed to fetch' }); assert.equal(F.esErrorPermanente(r), false); assert.equal(F.listarPendientes()[0].rechazo, undefined === F.listarPendientes()[0].rechazo ? undefined : null, 'transitorio: sigue pendiente sin rechazo');
  assert.equal(F.listarPendientes()[0].origen, 'usuario');
});

test('REINTENTO AUTOMÁTICO: esperas crecientes (15 s, 1, 3, 10, 30 min), tope de 5, un refresco NO lo cancela, y no ejecuta nada si no hay ediciones reales (ignora heredados y rechazados)', async () => {
  F.limpiarEstado(); const demoras = [], cola = []; let reintentos = 0;
  const ctx = capa({ setTimeout: (fn, ms) => { demoras.push(ms); cola.push(fn); return demoras.length; }, clearTimeout() {}, reintentarFichas410: async () => { reintentos++; return { guardadas: 0, transitorios: 1 }; } });
  vm.runInContext(tramo(APP, '  let reintentandoFichas410=false,intentoAuto410=0,timerAuto410=null,timerPend410=false;', '  async function reintentarFichas410(manual){') + '\nthis.programar=programarReintento410;', ctx);
  ctx.programar(); assert.deepEqual(demoras, [], 'sin pendientes no programa nada');
  F.marcarPendiente('p1', { telefono: { a: '1', d: '2' } }, 'heredado'); ctx.programar(); assert.deepEqual(demoras, [], 'un pendiente heredado NO se reintenta solo');
  F.limpiarEstado(); F.marcarPendiente('p1', { telefono: { a: '1', d: '2' } }, 'usuario'); F.rechazarPendiente('p1', 'permiso'); ctx.programar(); assert.deepEqual(demoras, [], 'lo rechazado de forma permanente no se reintenta');
  F.limpiarEstado(); F.marcarPendiente('p1', { telefono: { a: '1', d: '2' } }, 'usuario');
  for (let i = 0; i < 6; i++) ctx.programar();                                    // seis refrescos seguidos con un reintento en espera
  assert.deepEqual(demoras, [15000], 'los refrescos no cancelan ni reprograman el reintento en espera');
  for (let i = 0; i < 9 && cola.length; i++) { const fn = cola.shift(); await fn(); }   // el tiempo pasa y cada reintento falla
  assert.deepEqual(demoras, [15000, 60000, 180000, 600000, 1800000], 'esperas crecientes y tope de 5: sin bucles'); assert.equal(reintentos, 5);
  F.limpiarEstado();
});

test('REINTENTAR (manual y automático) sólo procesa ediciones reales y devuelve un resultado comprensible', async () => {
  F.limpiarEstado(); const S = servidor([fila()]), p = dePantalla(S.tabla.get('p1')); F.registrarVista(S.tabla.get('p1'));
  const ctx = capa({ supabaseClient: S.sb, usuarioSupabase: { id: 'u1' }, aplicarResultadoFicha410() {}, setTimeout: () => 1 });
  ctx.data.pacientes = [Object.assign({}, p, { telefono: '4321' })];
  vm.runInContext(tramo(APP, '  let reintentandoFichas410=false,intentoAuto410=0,timerAuto410=null,timerPend410=false;', '  async function resolverDivergencia410(id,campo,uso){') + '\nthis.reintentar=reintentarFichas410;', ctx);
  F.marcarPendiente('p1', { telefono: { a: '1155', d: '4321' } }, 'usuario'); F.marcarPendiente('pH', { telefono: { a: '1', d: '2' } }, 'heredado');
  let r = await ctx.reintentar(true); assert.equal(r.ok, true); assert.equal(r.guardadas, 1); assert.equal(S.tabla.get('p1').telefono, '4321'); assert.equal(S.rastro.updates, 1, 'el heredado no se reenvió');
  assert.equal(F.listarPendientes().filter((x) => x.id === 'pH').length, 1, 'el heredado sigue protegido sin aplicarse');
  F.limpiarEstado(); F.registrarVista(S.tabla.get('p1')); S.hooks.error = new Error('Failed to fetch'); F.marcarPendiente('p1', { telefono: { a: '4321', d: '1' } }, 'usuario');
  r = await ctx.reintentar(true); assert.equal(r.ok, false); assert.match(r.mensaje, /conexión/, 'el mensaje distingue falta de conexión');
  S.hooks.error = { code: '22008', message: 'invalid' }; F.limpiarEstado(); F.registrarVista(S.tabla.get('p1')); F.marcarPendiente('p1', { telefono: { a: '4321', d: '1' } }, 'usuario');
  r = await ctx.reintentar(true); assert.equal(r.ok, false); assert.doesNotMatch(r.mensaje, /conexión/, 'un dato inválido NO se atribuye a la falta de conexión'); assert.match(r.mensaje, /no es válido/);
  F.limpiarEstado();
});

// ---------- configuración: lo adoptado de la tabla no es una edición ----------
test('CONFIGURACIÓN: aceptar las fichas alineadas con la tabla las toma como base (cero diferencias ficticias) y no cambia nada más', () => {
  const ctx = { data: { pacientes: [{ id: 'p1', nombreCompleto: 'Ana', telefono: '2', actualizadoEn: 'T2' }, { id: 'p9', nombreCompleto: 'Nueva desde tabla' }, { id: 'p5', nombreCompleto: 'Otra', telefono: 'edición real' }] }, JSON, Object, Array, String };
  vm.createContext(ctx);
  vm.runInContext(tramo(R2B, '  var CAMPOS_FICHA_BASE', '  function aceptarFichas(ids)') + '\nthis.f=aceptarFichasEnBase;', ctx);
  const base = { pacientes: [{ id: 'p1', nombreCompleto: 'Ana', telefono: '1', actualizadoEn: 'T1' }, { id: 'p5', nombreCompleto: 'Otra', telefono: 'valor del servidor' }], profesionales: [{ id: 'x' }] };
  const n = ctx.f(base, ['p1', 'p9']);
  assert.ok(n > 0); assert.equal(base.pacientes[0].telefono, '2'); assert.equal(base.pacientes[0].actualizadoEn, 'T2'); assert.equal(base.pacientes.find((p) => p.id === 'p9').nombreCompleto, 'Nueva desde tabla');
  assert.equal(base.pacientes.find((p) => p.id === 'p5').telefono, 'valor del servidor', 'una ficha NO alineada (edición real) no se toca');
  assert.deepEqual(base.profesionales, [{ id: 'x' }]);
});

test('INTEGRACIÓN ESTÁTICA: la carga informa lo adoptado a la configuración (R2B y Secretaría), sin empujes; los pendientes heredados no se reaplican solos y sólo Owner/Admin los ve', () => {
  const c = tramo(APP, '  function aplicarCarga410(', '  window.cardiolinkClinica410={');   // aplicarCarga410 (merge + aceptarFichas + reintento) → reaplicarCarga410 → cargar410
  assert.match(c, /window\.cardiolinkConfigR2B\?\.aceptarFichas\?\.\(ids\);window\.cardiolinkConfigSecretariaV1\?\.aceptarFichas\?\.\(ids\)/); assert.doesNotMatch(c, /empujes410/); assert.match(c, /programarReintento410\(\)/);
  assert.match(R2B, /function aceptarFichas\(ids\) \{ if \(!baseVigente\(\)\) return 0; var n = aceptarFichasEnBase\(base, ids\); if \(n\) neutro = normalizar\(base\);/);
  assert.match(fs.readFileSync(path.join(__dirname, 'cardiolink-config-secretaria-v1.js'), 'utf8'), /function aceptarFichas\(ids\) \{ return baseVista \? aceptarFichasEnBase\(baseVista, ids\) : 0; \}/);
  const rec = tramo(APP, '        recuperarFicha:op=>{', '        guardarAhora:async op=>{');
  assert.match(rec, /const real=op\.origen==='usuario'; F\.marcarPendiente\(op\.id,op\.cambios,real\?'usuario':'heredado'\); if\(real\)\{/, 'lo heredado se conserva protegido pero NO se aplica a la ficha ni se reintenta');
  assert.match(GLUE, /if \(op\.k === 'config' && op\.origen !== 'usuario'\) \{ especiales\.set\(t \+ '\|c', Object\.assign\(\{\}, op, \{ tab: t, k: 'heredada'/);
  assert.match(GLUE, /it\.visible = \(esAdminUI\(\) && estadoUI\.tecnicos && it\.tecnico\) \? true : \(it\.real \|\| it\.problema\) && \(!it\.real \|\| seg >= UMBRAL_AVISO_SEG \|\| it\.dias >= 1\);/);
  assert.match(GLUE, /verRecuperacion: function \(\) \{ if \(!esAdminUI\(\)\) return false;/, 'sólo Owner/Admin ven los restos heredados, y sólo al pedirlo');
  assert.match(GLUE, /var UMBRAL_AVISO_SEG = 120;/); assert.match(GLUE, /if \(esAdminUI\(\) && it\.op\.k !== 'eliminada_r2c' && it\.op\.k !== 'divergencia'\) b\('Descartar'/);
});

test('el panel de pendientes no tiene comentarios de línea que se coman el resto de la sentencia (renderizado)', () => {
  const l = GLUE.split('\n').find((x) => x.indexOf('var det = it.detUsuario') >= 0); assert.ok(l && l.indexOf('//') < 0, 'la línea de render no puede llevar // en medio'); assert.match(l, /var resultado = crear\('div'/);
});

test('AVISO OPERATIVO: sin jerga técnica para médicos y secretarias; «Guardar ahora» muestra «Guardando…», confirma el resultado real y conserva la edición si falla', () => {
  assert.match(GLUE, /'Cambios sin guardar'/); assert.match(GLUE, /'Guardar ahora'/); assert.match(GLUE, /x\.textContent = 'Guardando…'/); assert.match(GLUE, /resultado\.textContent = '✓ Guardado'/);
  assert.match(GLUE, /El cambio se conserva y se vuelve a intentar solo\./);
  const visible = tramo(GLUE, '    var MOT = {', '    it.visible =');
  assert.doesNotMatch(visible.replace(/\/\/.*$/gm, ''), /divergencia|sincroniza|cola|paquete|servidor de|conflicto de versi/i, 'el texto para la persona no usa términos técnicos');
  assert.match(visible, /el DNI ya pertenece a otro paciente/); assert.match(visible, /tu usuario no tiene permiso/);
  assert.match(APP, /No hay respuesta del servidor por ahora \(revisá la conexión\)\./); assert.match(APP, /Alguno de los datos no es válido para guardarlo\./);
});

test('CERRAR SESIÓN: el botón no antepone un diálogo propio; sin ediciones sin guardar cierra directo y con ellas hay UN solo mensaje', () => {
  const btn = tramo(APP, 'function agregarBotonCerrarSesion()', 'async function cargarAtencionesDesdeSupabase');
  assert.doesNotMatch(btn.replace(/\/\/.*$/gm, ''), /confirm\s*\(/, 'el botón llama directo a cerrarSesionSupabase');
  const cierre = tramo(APP, 'async function cerrarSesionSupabase()', 'function agregarBotonCerrarSesion()');
  assert.strictEqual((cierre.match(/window\.confirm\(/g) || []).length, 1, 'un único mensaje, sólo si quedan ediciones reales');
});
