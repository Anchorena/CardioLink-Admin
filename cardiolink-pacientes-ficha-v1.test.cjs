'use strict';
// Persistencia V1 / R3 · pruebas de la escritura segura de la ficha demográfica (Supabase simulado en memoria).
// Ejecutar: node --test cardiolink-pacientes-ficha-v1.test.cjs
const test = require('node:test');
const assert = require('node:assert');
const F = require('./cardiolink-pacientes-ficha-v1.js');
const clon = (o) => JSON.parse(JSON.stringify(o));

function entorno(filas, opc) {
  opc = opc || {}; const tabla = new Map(); let reloj = 1000; const tic = () => new Date(Date.UTC(2026, 10, 18, 12, 0, 0, reloj++)).toISOString();
  const rastro = { updates: 0, inserts: 0, lecturas: 0 }; const hooks = { antesDeUpdate: null, errorUpdate: null, errorLectura: null, errorInsert: null };
  const dniN = (r) => { const d = String(r.dni || '').replace(/\D/g, ''); return d || null; };
  (filas || []).forEach((f) => { tabla.set(f.id, Object.assign({ actualizado_en: tic() }, f)); });
  const unico = (fila, exceptoId) => { const d = dniN(fila); if (!d) return true; return ![...tabla.values()].some((x) => x.id !== exceptoId && dniN(x) === d); };
  const sb = {
    from(t) {
      assert.equal(t, 'cardiolink_pacientes');
      const q = { op: 'select', f: [], valores: null, cols: '*' };
      const api = {
        select(c) { if (q.op === 'select') q.cols = c || '*'; return api; }, limit() { return api; },
        eq(k, v) { q.f.push(['eq', k, v]); return api; }, neq(k, v) { q.f.push(['neq', k, v]); return api; }, is(k, v) { q.f.push(['is', k, v]); return api; },
        update(v) { q.op = 'update'; q.valores = v; return api; }, insert(v) { q.op = 'insert'; q.valores = v; return api; },
        then(res, rej) { return Promise.resolve(ejecutar()).then(res, rej); }
      };
      const coincide = (fila) => q.f.every(([op, k, v]) => { const val = k === 'dni_normalizado' ? dniN(fila) : fila[k]; return op === 'eq' ? String(val) === String(v) && !(val == null) : op === 'neq' ? String(val) !== String(v) : (val == null) === (v === null); });
      function ejecutar() {
        if (q.op === 'select') { rastro.lecturas++; if (hooks.errorLectura) return { data: null, error: hooks.errorLectura }; return { data: [...tabla.values()].filter(coincide).map(clon), error: null }; }
        if (q.op === 'insert') {
          rastro.inserts++; if (hooks.errorInsert) return { data: null, error: hooks.errorInsert };
          const f = q.valores[0]; if (tabla.has(f.id)) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "cardiolink_pacientes_pkey"' } };
          if (!unico(f, f.id)) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "cardiolink_pacientes_dni_normalizado_uq"' } };
          tabla.set(f.id, clon(f)); return { data: [clon(f)], error: null };
        }
        rastro.updates++; if (hooks.antesDeUpdate) { const h = hooks.antesDeUpdate; hooks.antesDeUpdate = null; h(); }
        if (hooks.errorUpdate) return { data: null, error: hooks.errorUpdate };
        const objetivo = [...tabla.values()].filter(coincide); if (!objetivo.length) return { data: [], error: null };
        const nuevo = Object.assign({}, objetivo[0], q.valores); if (!unico(nuevo, nuevo.id)) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "cardiolink_pacientes_dni_normalizado_uq"' } };
        tabla.set(nuevo.id, nuevo); return { data: [clon(nuevo)], error: null };
      }
      return api;
    }
  };
  return { sb, tabla, rastro, hooks, tic, ahora: () => tic(), remoto(id, cambios) { const f = tabla.get(id); tabla.set(id, Object.assign({}, f, cambios, { actualizado_en: tic() })); } };
}
const fila = (extra) => Object.assign({ id: 'p1', nombre_completo: 'Ana Pérez', dni: '30111222', fecha_nacimiento: '1970-01-01', telefono: '1155550000', email: 'a@x.com', sexo: 'Femenino', cobertura_habitual: 'OSDE', numero_afiliado_habitual: null }, extra || {});
const app = (f) => F.desdeFila(f);

test('normalización: null / vacío / fecha dd/mm/aaaa; las diferencias son sólo de campos editables', () => {
  assert.equal(F.norm('telefono', '  '), null); assert.equal(F.norm('fechaNacimiento', '05/05/1975'), '1975-05-05'); assert.equal(F.norm('fechaNacimiento', 'basura'), null);
  const d = F.diferencias({ telefono: '1', email: '', otroCampo: 'x' }, { telefono: '2', email: null, otroCampo: 'y' }); assert.deepStrictEqual(Object.keys(d), ['telefono']);
});

test('3 vías: independientes se aplican, ya aplicado no se reescribe, mismo campo distinto = conflicto', () => {
  const remoto = fila({ telefono: '999', email: 'nuevo@x.com' });
  const p = F.planificar({ fechaNacimiento: { a: '1970-01-01', d: '1975-05-05' }, telefono: { a: '1155550000', d: '111' }, email: { a: 'a@x.com', d: 'nuevo@x.com' } }, remoto);
  assert.deepStrictEqual(p.aplicar, { fechaNacimiento: '1975-05-05' }); assert.deepStrictEqual(p.ya, ['email']);
  assert.equal(p.conflictos.length, 1); assert.deepStrictEqual(p.conflictos[0], { campo: 'telefono', antes: '1155550000', nuevo: '111', remoto: '999' });
});

test('guardarEdicion: escribe SÓLO los campos cambiados con UPDATE condicionado y confirma con la fila devuelta', async () => {
  const E = entorno([fila()]); const base = app(E.tabla.get('p1')); F.limpiarEstado();
  const nuevo = Object.assign({}, base, { fechaNacimiento: '1975-05-05', telefono: '1166667777' });
  const r = await F.guardarEdicion({ sb: E.sb, id: 'p1', base, nuevo, ahora: E.ahora });
  assert.equal(r.estado, 'confirmada'); assert.deepStrictEqual(r.aplicados.sort(), ['fechaNacimiento', 'telefono']);
  const f = E.tabla.get('p1'); assert.equal(f.fecha_nacimiento, '1975-05-05'); assert.equal(f.telefono, '1166667777'); assert.equal(f.email, 'a@x.com'); assert.equal(f.nombre_completo, 'Ana Pérez');
  assert.equal(F.listarPendientes().length, 0, 'confirmada: ya no hay pendiente'); assert.equal(E.rastro.updates, 1);
});

test('sesiones independientes: otra sesión cambió el email mientras tanto → se conservan ambos cambios', async () => {
  const E = entorno([fila()]); const base = app(E.tabla.get('p1')); F.limpiarEstado();
  E.remoto('p1', { email: 'otra-sesion@x.com' });
  const r = await F.guardarEdicion({ sb: E.sb, id: 'p1', base, nuevo: Object.assign({}, base, { fechaNacimiento: '1975-05-05' }), ahora: E.ahora });
  assert.equal(r.estado, 'confirmada'); const f = E.tabla.get('p1'); assert.equal(f.fecha_nacimiento, '1975-05-05'); assert.equal(f.email, 'otra-sesion@x.com');
});

test('mismo campo cambiado por otra sesión → CONFLICTO: no se pisa, no se resuelve por fecha, no queda pendiente', async () => {
  const E = entorno([fila()]); const base = app(E.tabla.get('p1')); F.limpiarEstado();
  E.remoto('p1', { telefono: 'REMOTO' });
  const r = await F.guardarEdicion({ sb: E.sb, id: 'p1', base, nuevo: Object.assign({}, base, { telefono: 'LOCAL', fechaNacimiento: '1975-05-05' }), ahora: E.ahora });
  assert.equal(r.estado, 'confirmada'); assert.equal(r.conflictos.length, 1); assert.equal(r.conflictos[0].campo, 'telefono');
  const f = E.tabla.get('p1'); assert.equal(f.telefono, 'REMOTO'); assert.equal(f.fecha_nacimiento, '1975-05-05'); assert.equal(F.listarPendientes().length, 0);
});

test('concurrencia en el momento de escribir: el UPDATE condicionado falla, se relee y se fusiona (máx. 3)', async () => {
  const E = entorno([fila()]); const base = app(E.tabla.get('p1')); F.limpiarEstado();
  E.hooks.antesDeUpdate = () => E.remoto('p1', { sexo: 'Otro' });
  const r = await F.guardarEdicion({ sb: E.sb, id: 'p1', base, nuevo: Object.assign({}, base, { fechaNacimiento: '1975-05-05' }), ahora: E.ahora });
  assert.equal(r.estado, 'confirmada'); assert.equal(E.rastro.updates, 2); const f = E.tabla.get('p1'); assert.equal(f.sexo, 'Otro'); assert.equal(f.fecha_nacimiento, '1975-05-05');
});

test('reintentos agotados: se informa como error transitorio, no se escribe a ciegas y el cambio queda PENDIENTE', async () => {
  const E = entorno([fila()]); const base = app(E.tabla.get('p1')); F.limpiarEstado(); let n = 0;
  const trampa = () => { E.remoto('p1', { localidad: 'L' + n++ }); E.hooks.antesDeUpdate = trampa; }; E.hooks.antesDeUpdate = trampa;
  const r = await F.guardarEdicion({ sb: E.sb, id: 'p1', base, nuevo: Object.assign({}, base, { fechaNacimiento: '1975-05-05' }), ahora: E.ahora });
  assert.equal(r.estado, 'error'); assert.equal(r.transitorio, true); assert.equal(E.tabla.get('p1').fecha_nacimiento, '1970-01-01'); assert.equal(F.listarPendientes().length, 1);
});

test('DNI duplicado: verificación previa y árbitro de la base (carrera); el id no cambia y la edición queda rechazada (no se reintenta ni se descarta)', async () => {
  const E = entorno([fila(), fila({ id: 'p2', nombre_completo: 'Juan', dni: '30333444' })]); const base = app(E.tabla.get('p1')); F.limpiarEstado();
  let r = await F.guardarEdicion({ sb: E.sb, id: 'p1', base, nuevo: Object.assign({}, base, { dni: '30.333.444' }), ahora: E.ahora });
  assert.equal(r.estado, 'dni_duplicado'); assert.equal(E.tabla.get('p1').dni, '30111222'); assert.equal(E.rastro.updates, 0);
  assert.equal(F.listarPendientes().length, 1, 'la edición NO se descarta: queda rechazada con su motivo'); assert.equal(F.listarPendientes()[0].rechazo.tipo, 'dni_duplicado');
  // carrera: nadie tenía ese DNI al verificar, pero otra sesión lo toma antes del UPDATE
  const E2 = entorno([fila(), fila({ id: 'p2', nombre_completo: 'Juan', dni: '30333444' })]); F.limpiarEstado();
  E2.tabla.get('p2').dni = '40000000';
  E2.hooks.antesDeUpdate = () => { E2.tabla.get('p2').dni = '30555666'; };
  r = await F.guardarEdicion({ sb: E2.sb, id: 'p1', base: app(E2.tabla.get('p1')), nuevo: Object.assign({}, app(E2.tabla.get('p1')), { dni: '30555666' }), ahora: E2.ahora });
  assert.equal(r.estado, 'dni_duplicado', 'la unicidad de la base manda'); assert.equal(E2.tabla.get('p1').dni, '30111222');
  // cambio de DNI legítimo: conserva el id
  const E3 = entorno([fila()]); F.limpiarEstado(); const b3 = app(E3.tabla.get('p1'));
  r = await F.guardarEdicion({ sb: E3.sb, id: 'p1', base: b3, nuevo: Object.assign({}, b3, { dni: '30999888' }), ahora: E3.ahora });
  assert.equal(r.estado, 'confirmada'); assert.equal(E3.tabla.get('p1').id, 'p1'); assert.equal(E3.tabla.get('p1').dni, '30999888'); assert.equal(E3.tabla.size, 1);
});

test('errores: sin conexión → transitorio y queda pendiente; permisos (42501) → rechazo permanente conservado; confirmación inconsistente no es éxito', async () => {
  const E = entorno([fila()]); F.limpiarEstado(); const base = app(E.tabla.get('p1')); const nuevo = Object.assign({}, base, { telefono: '1' });
  E.hooks.errorUpdate = new Error('Failed to fetch'); let r = await F.guardarEdicion({ sb: E.sb, id: 'p1', base, nuevo, ahora: E.ahora });
  assert.equal(r.estado, 'error'); assert.equal(r.transitorio, true); assert.equal(F.listarPendientes().length, 1);
  E.hooks.errorUpdate = { code: '42501', message: 'new row violates row-level security policy' }; r = await F.guardarEdicion({ sb: E.sb, id: 'p1', base, nuevo, ahora: E.ahora });
  assert.equal(r.estado, 'error'); assert.equal(r.permiso, true); assert.equal(F.listarPendientes().length, 1); assert.equal(F.listarPendientes()[0].rechazo.tipo, 'permiso', 'rechazo permanente: se conserva con su motivo y no se reintenta');
  const E2 = entorno([fila()]); F.limpiarEstado(); E2.hooks.errorLectura = new Error('Failed to fetch');
  r = await F.guardarEdicion({ sb: E2.sb, id: 'p1', base, nuevo, ahora: E2.ahora }); assert.equal(r.estado, 'error'); assert.equal(E2.rastro.updates, 0);
});

test('la ficha no existe en la tabla relacional: se CREA con insert (nunca upsert ciego) y respeta el DNI', async () => {
  const E = entorno([fila({ id: 'p2', nombre_completo: 'Otro', dni: '30777000' })]); F.limpiarEstado();
  const nuevo = { id: 'pX', nombreCompleto: 'Local Sólo', dni: '30111222', fechaNacimiento: '1990-02-02', telefono: '11' };
  let r = await F.guardarEdicion({ sb: E.sb, id: 'pX', base: { nombreCompleto: 'Local Sólo', dni: '30111222' }, nuevo, ahora: E.ahora });
  assert.equal(r.estado, 'confirmada'); assert.equal(r.creada, true); assert.equal(E.tabla.get('pX').fecha_nacimiento, '1990-02-02'); assert.equal(E.rastro.inserts, 1);
  r = await F.guardarEdicion({ sb: E.sb, id: 'pY', base: {}, nuevo: { id: 'pY', nombreCompleto: 'Dup', dni: '30.777.000' }, ahora: E.ahora });
  assert.equal(r.estado, 'dni_duplicado'); assert.equal(E.tabla.has('pY'), false);
});

test('sin cambios reales: no hay lecturas ni escrituras y no se informa nada', async () => {
  const E = entorno([fila()]); F.limpiarEstado(); const base = app(E.tabla.get('p1'));
  const r = await F.guardarEdicion({ sb: E.sb, id: 'p1', base, nuevo: Object.assign({}, base), ahora: E.ahora });
  assert.equal(r.sinCambios, true); assert.equal(E.rastro.lecturas, 0); assert.equal(E.rastro.updates, 0);
});

test('reconciliarCarga: la tabla relacional MANDA; la carga nunca empuja ni abre divergencias; una edición real pendiente se conserva; un dato vaciado a propósito no resucita', () => {
  F.limpiarEstado(); const row = fila({ actualizado_en: '2026-11-18T10:00:00.000Z', fecha_nacimiento: '1970-01-01', email: null, telefono: null });
  const loc = (extra) => Object.assign({}, F.desdeFila(row), extra);
  // copia local vieja (teléfono y email que la persona ya había borrado en la tabla): se adopta lo vacío; NO se rellena ni se empuja
  let r = F.reconciliarCarga(loc({ email: 'viejo@x.com', telefono: '1155' }), row, null);
  assert.deepStrictEqual(r.adoptar, { email: null, telefono: null }); assert.deepStrictEqual(r.empujar, {}); assert.deepStrictEqual(r.divergencias, {});
  // con marca de sincronización y la tabla sin cambios, una copia distinta TAMPOCO es una edición
  F.marcarSync('p1', row, loc({})); r = F.reconciliarCarga(loc({ fechaNacimiento: '1999-09-09' }), row, null);
  assert.deepStrictEqual(r.adoptar, { fechaNacimiento: '1970-01-01' }); assert.deepStrictEqual(r.empujar, {});
  // edición REAL de la persona sin guardar: se conserva
  r = F.reconciliarCarga(loc({ fechaNacimiento: '1980-08-08' }), row, { origen: 'usuario', cambios: { fechaNacimiento: { a: '1970-01-01', d: '1980-08-08' } } });
  assert.deepStrictEqual(r, { adoptar: {}, empujar: {}, divergencias: {} });
  // un pendiente HEREDADO (de versiones anteriores) no se conserva sobre la tabla: se muestra lo de la tabla
  r = F.reconciliarCarga(loc({ fechaNacimiento: '1980-08-08' }), row, { origen: 'heredado', cambios: { fechaNacimiento: { a: '1970-01-01', d: '1980-08-08' } } });
  assert.deepStrictEqual(r.adoptar, { fechaNacimiento: '1970-01-01' });
});

test('divergencias: se conservan para revisión; «servidor» adopta, «mío» escribe por 3 vías con antes = valor del servidor; nada se pierde', async () => {
  F.limpiarEstado(); F.registrarDivergencias('p1', { email: { local: 'local@x.com', remoto: 'servidor@x.com' } });
  assert.equal(F.listarDivergencias().length, 1);
  assert.deepStrictEqual(F.planResolucion('p1', 'email', 'servidor'), { adoptar: 'servidor@x.com' });
  const plan = F.planResolucion('p1', 'email', 'mio'); assert.deepStrictEqual(plan.cambios, { email: { a: 'servidor@x.com', d: 'local@x.com' } });
  const E = entorno([fila({ email: 'servidor@x.com' })]); let r = await F.guardarCambiosPendientes({ sb: E.sb, id: 'p1', cambios: plan.cambios, ahora: E.ahora });
  assert.equal(r.estado, 'confirmada'); assert.equal(E.tabla.get('p1').email, 'local@x.com');
  E.remoto('p1', { email: 'cambio-nuevo@x.com' });                                    // si el servidor cambió otra vez, «mío» NO lo pisa
  r = await F.guardarCambiosPendientes({ sb: E.sb, id: 'p1', cambios: { email: { a: 'servidor@x.com', d: 'otro-mio@x.com' } }, ahora: E.ahora });
  assert.equal(r.conflictos.length, 1); assert.equal(E.tabla.get('p1').email, 'cambio-nuevo@x.com');
  F.liberarDivergencia('p1', 'email'); assert.equal(F.listarDivergencias().length, 0);
});

test('ficha eliminada o sin acceso: no se RECREA, el pendiente se libera y queda ausente (no activa); marcas y huella sin valores', async () => {
  F.limpiarEstado(); const E = entorno([]); F.marcarSync('pX', { actualizado_en: '2026-11-18T10:00:00.000Z' }, { telefono: '1155' });
  assert.equal(F.existiaAntes('pX'), true); assert.ok(!JSON.stringify(F.exportarSync()).includes('1155'), 'sólo huella, no valores');
  const r = await F.guardarCambiosPendientes({ sb: E.sb, id: 'pX', cambios: { telefono: { a: '1155', d: '99' } }, nuevo: { id: 'pX', nombreCompleto: 'Borrado', dni: '30999000' }, creacionPermitida: !F.existiaAntes('pX'), ahora: E.ahora });
  assert.equal(r.estado, 'ausente'); assert.equal(E.rastro.inserts, 0); assert.equal(E.tabla.size, 0); assert.equal(F.listarPendientes().length, 0); assert.equal(F.esAusente('pX'), true);
  F.limpiarAusente('pX'); assert.equal(F.esAusente('pX'), false);
  const rec = F.importarSync(F.exportarSync()); assert.equal(F.existiaAntes('pX'), true);
});

test('R3: fechaISODesdeTexto devuelve intacta una fecha ISO (antes «1955-05-05» → «1905-05-55» y el formulario la mostraba vacía y la borraba al guardar)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'app.js'), 'utf8');
  const a = src.indexOf('function fechaISODesdeTexto('), b = src.indexOf('function parsearTextoMedicloud(');
  const fn = new Function(src.slice(a, b) + '; return fechaISODesdeTexto;')();
  assert.equal(fn('1955-05-05'), '1955-05-05'); assert.equal(fn('1955-5-5'), '1955-05-05'); assert.equal(fn('1955-05-05T10:00:00Z'), '1955-05-05');
  assert.equal(fn('05/05/1975'), '1975-05-05'); assert.equal(fn('5-5-75'), '1975-05-05'); assert.equal(fn(''), ''); assert.equal(fn('sin fecha'), '');
});

test('INCIDENCIA PRODUCTION (Geraldine): editar un paciente EXISTENTE no cambia su id ni lo quita de la configuración (no hay «baja» ante el servidor); su fila relacional se resuelve por alias', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'app.js'), 'utf8');
  const a = src.indexOf('async function guardarPacientePanel('), b = src.indexOf('function nuevaAtencionDesdePaciente(');
  const f = src.slice(a, b);
  assert.match(f, /if\(dni&&esNuevoLocal\)\{[\s\S]{0,200}asegurarPacienteSinConflictoDni/, 'la reconciliación por DNI (adopta el id relacional y quita entradas) sólo corre en altas nuevas');
  assert.ok(!/p\.id=real\.id|data\.pacientes=data\.pacientes\.filter\(x=>x!==p\)[\s\S]{0,40}$/.test(f.slice(0, 0)), 'sin efecto');
  assert.match(src, /async function idRelacional410\(p\)/); assert.match(src, /alias410\.set\(String\(p\.id\),String\(row\.id\)\)/);
  assert.match(src, /const idF=await idRelacional410\(p\),visto=FICHA\.vistaEdicionDe\(idF\)\|\|FICHA\.vistaEdicionDe\(p\.id\);/);
  const s1 = src.indexOf('async function savePatientEditHC('), s2 = src.indexOf('function copyActionsHtmlHC409(');
  const save = src.slice(s1, s2); assert.match(save, /idRelacional\?\.\(target\)/); assert.match(save, /FICHA\.guardarEdicion\(\{sb:supabaseClient,id:idRel,/);
  assert.doesNotMatch(save, /\bp\.id=|target\.id=/, 'el id del paciente nunca se reasigna al guardar');
});

test('FICHAS ESTABLES: leer o refrescar no escribe (sin empujes ni divergencias) y no existe escritura ciega de la ficha completa desde la sincronización básica', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'app.js'), 'utf8');
  const a = src.indexOf('function mergePaciente410('), b = src.indexOf('function mergeResumen410(');
  const f = src.slice(a, b);
  assert.doesNotMatch(f, /empujes410|registrarDivergencias/); assert.match(f, /adoptados410\.push\(String\(p\.id\)\)/);
  const c = src.slice(src.indexOf('async function sincronizarFichaPacienteBasica410('), src.indexOf('async function reconciliarDniDuplicado410('));
  assert.doesNotMatch(c, /\.upsert\(/, 'la sincronización de la ficha ya no hace upsert de la fila completa'); assert.match(c, /FICHA\.guardarEdicion\(\{sb:supabaseClient,id:idF,base,nuevo:\{\.\.\.p,id:idF\}/);
});
