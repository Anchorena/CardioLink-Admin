'use strict';

// tests/config-secretaria-v1.js  (v3, tras la segunda revisión técnica del Bloque 4B)
// Configuración administrativa de Secretaría por RPC.
//  A) Contrato cliente <-> SQL: listas de claves superiores Y de campos anidados coinciden; toda clave `data.<x>` del código está clasificada;
//     lo clínico/financiero/identidad nunca está en las listas escribibles; los campos que el código usa en pacientes/profesionales están cubiertos.
//  B) Módulo cliente con un cliente Supabase falso: SIN fallback, errores visibles, cambios locales resguardados y recuperables, serialización,
//     saneamiento anidado (sin identidad documental), recarga que no pisa cambios pendientes.
//  C) Enganches en app.js (código REAL ejecutado con dobles) y auditoría de TODOS los llamadores de guardarConfigEnSupabase298.
//  D) Revisión estática de los SQL (etapa A aditiva, etapa B sólo RLS, rollbacks).
//  v3: rol no confirmado sin acceso a la fila completa; guardados administrativos con confirmación real; cambio de sesión con operaciones pendientes;
//      fixture SQL relacional obligatorio (sin ramas que omitan la prueba).
// Sin red, sin Supabase real.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const leer = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const APP = leer('app.js');
const MOD = leer('cardiolink-config-secretaria-v1.js');
const INDEX = leer('index.html');
const SQL_A = leer('docs/propuestas/pending_review_config_secretaria_v1_a_rpc.sql');
const SQL_A_RB = leer('docs/propuestas/pending_review_config_secretaria_v1_a_rpc_rollback.sql');
const SQL_B = leer('docs/propuestas/pending_review_config_secretaria_v1_b_rls.sql');
const SQL_B_RB = leer('docs/propuestas/pending_review_config_secretaria_v1_b_rls_rollback.sql');
const SQL_TESTS = leer('docs/propuestas/pending_review_config_secretaria_v1_tests.sql');
const MODULOS = ['cardiolink-agenda-v1.js', 'cardiolink-arancel-monto.js', 'cardiolink-auth-guard.js', 'cardiolink-clear-patient-fix.js', 'cardiolink-config-v1.js',
  'cardiolink-dashboard-v1.js', 'cardiolink-documentos-pdf-v1.js', 'cardiolink-eco-informe.js', 'cardiolink-hc-referidos.js', 'cardiolink-informe-afiliado.js',
  'cardiolink-pedidos-rapidos-v1.js', 'cardiolink-pendientes-alertas.js', 'cardiolink-prestaciones-perfil.js'];

// Claves que Secretaría nunca recibe ni escribe (documentosClinicos: sólo lectura filtrada por tipo, nunca escritura)
const RESTRINGIDAS = ['evolucionesClinicas', 'resumenesClinicos', 'importacionesMedicloudEvoluciones', 'notasInternasMedicas',
  'notasInternasPorProfesional', 'configFinanzas411F', 'movimientosFinancieros411C', 'hcPreparacion', 'integracionesClinicas', 'identidadesArchivadas'];
const IGNORABLES = ['session', 'user', 'subscription', 'length', 'ok'];   // variables locales llamadas `data` que no son la config
const SOLO_LECTURA = ['usuarios', 'roles', 'brandingCardioLink', 'migracionesCardioLink', 'documentosClinicos'];

function lista(texto, marca, comentario) {
  const i = texto.indexOf(comentario + ' ' + marca + '_INICIO'), j = texto.indexOf(comentario + ' ' + marca + '_FIN');
  assert.ok(i >= 0 && j > i, 'marcas ' + marca + ' no encontradas');
  return [...texto.slice(i, j).matchAll(/'([A-Za-z0-9_]+)'/g)].map(m => m[1]);
}
const sql = (m) => lista(SQL_A, m, '--');
const js = (m) => lista(MOD, m, '//');
const ordenadas = a => a.slice().sort();

const pruebas = [];
const prueba = (nombre, fn) => pruebas.push({ nombre, fn });

// ---------------------------------------------------------------- A) contrato cliente <-> SQL
prueba('A1 todas las listas del módulo (claves y campos anidados) coinciden con las del SQL', () => {
  ['CLAVES_LECTURA', 'CLAVES_ESCRITURA', 'CAMPOS_PACIENTE', 'CAMPOS_PROFESIONAL', 'CAMPOS_IDENTIDAD'].forEach(m =>
    assert.deepEqual(ordenadas(js(m)), ordenadas(sql(m)), 'lista distinta: ' + m));
  // TIPOS_DOC: la etapa A de 4B instala la lista ORIGINAL (constancia_atencion; es lo que está aplicado en STAGING) y el Bloque 4C-1b la AMPLÍA.
  // El módulo cliente lleva la lista FINAL (la del SQL de 4C-1b); antes de aplicar 4C-1b el servidor sólo entrega la original (subconjunto), por lo que es inocuo.
  assert.deepEqual(sql('TIPOS_DOC'), ['constancia_atencion'], 'la etapa A de 4B debe conservar la lista original');
  assert.deepEqual(ordenadas(js('TIPOS_DOC')), ordenadas(lista(leer('docs/propuestas/pending_review_documentos_seguridad_4c1b_heredados.sql'), 'TIPOS_DOC', '--')), 'el módulo debe llevar la lista final de 4C-1b');
});

prueba('A2 escritura ⊆ lectura; la diferencia es exactamente usuarios/roles/branding/migraciones/documentosClinicos', () => {
  const lec = sql('CLAVES_LECTURA'), esc = sql('CLAVES_ESCRITURA');
  esc.forEach(k => assert.ok(lec.includes(k), k + ' escribible pero no legible'));
  assert.deepEqual(ordenadas(lec.filter(k => !esc.includes(k))), ordenadas(SOLO_LECTURA));
});

prueba('A3 lo restringido nunca está en las listas; documentosClinicos nunca es escribible; la identidad nunca es campo administrativo escribible', () => {
  const todas = [...sql('CLAVES_LECTURA'), ...sql('CLAVES_ESCRITURA'), ...js('CLAVES_LECTURA'), ...js('CLAVES_ESCRITURA')];
  RESTRINGIDAS.forEach(k => assert.ok(!todas.includes(k), 'clave restringida en una lista: ' + k));
  assert.ok(!sql('CLAVES_ESCRITURA').includes('documentosClinicos') && !js('CLAVES_ESCRITURA').includes('documentosClinicos'));
  const identidad = sql('CAMPOS_IDENTIDAD');
  assert.equal(identidad.length, 12);
  sql('CAMPOS_PROFESIONAL').forEach(k => assert.ok(!identidad.includes(k), 'campo de identidad entre los administrativos: ' + k));
  js('CAMPOS_PROFESIONAL').forEach(k => assert.ok(!identidad.includes(k)));
  sql('CAMPOS_PACIENTE').forEach(k => assert.ok(!/^(evolucion|resumen|diagnostico|antecedente|alergia|medicacion|nota)/i.test(k), 'campo clínico entre los del paciente: ' + k));
});

prueba('A4 toda clave data.<x> del código está clasificada (lectura, restringida o ignorable)', () => {
  const conocidas = new Set([...sql('CLAVES_LECTURA'), ...RESTRINGIDAS, ...IGNORABLES]);
  const sinClasificar = {};
  ['app.js', ...MODULOS].forEach(f => {
    for (const m of leer(f).matchAll(/\bdata\??\.([A-Za-z0-9_]+)/g)) if (!conocidas.has(m[1])) (sinClasificar[m[1]] = sinClasificar[m[1]] || new Set()).add(f);
  });
  const claves = Object.keys(sinClasificar);
  assert.equal(claves.length, 0, 'claves de data sin clasificar (agregarlas al SQL y al módulo, o a RESTRINGIDAS/IGNORABLES): ' + claves.map(k => k + ' en ' + [...sinClasificar[k]].join(',')).join('; '));
});

prueba('A5 estructura anidada real: los campos que el código escribe en pacientes y profesionales están clasificados', () => {
  const campos = APP.match(/const campos=\[((?:'[A-Za-z]+',?)+)\];\s*campos\.forEach/)[1].match(/'([A-Za-z]+)'/g).map(x => x.replace(/'/g, ''));
  const pac = sql('CAMPOS_PACIENTE');
  campos.forEach(k => assert.ok(pac.includes(k), 'campo de paciente no listado: ' + k));
  ['estado', 'fusionadoCon', 'fusionadoEn', 'fusionadoPor', 'historialCoberturas', 'creadoEn', 'creadoPor', 'actualizadoEn', 'actualizadoPor', 'creadoPorImportacionLote']
    .forEach(k => assert.ok(pac.includes(k), 'campo de paciente no listado: ' + k));
  ['id', 'nombre', 'area', 'prestaciones', 'valores', 'especialidadIds', 'bloquesPrestaciones', 'activo'].forEach(k => assert.ok(sql('CAMPOS_PROFESIONAL').includes(k), k));
  const ident = APP.match(/const CAMPOS_IDENTIDAD_V1=\[((?:'[A-Za-z]+',?)+)\]/)[1].match(/'([A-Za-z]+)'/g).map(x => x.replace(/'/g, ''));
  assert.deepEqual(ordenadas(ident), ordenadas(sql('CAMPOS_IDENTIDAD')));
});

// ---------------------------------------------------------------- B) módulo cliente
function crearEntorno(opc) {
  opc = opc || {};
  const llamadas = [], alertas = [];
  const almacen = opc.almacen || {};
  const respuestas = Object.assign({
    leer: { data: { ok: true, config: { profesionales: [{ id: 'p1', nombre: 'Dr', logoDocumentoData: 'LOGO', campoRaro: 'X' }], obrasSociales: ['OS'],
        pacientes: [{ id: 'pac1', nombreCompleto: 'QA', notaOculta: 'CLINICO' }], evolucionesClinicas: [{ id: 'x' }], configFinanzas411F: { a: 1 }, usuarios: [{ id: 'u' }],
        documentosClinicos: [{ id: 'd1', tipo: 'certificado', contenido: 'CERTIFICADO-D1' }, { id: 'd2', tipo: 'constancia_atencion' }, { id: 'd3', tipo: 'receta', contenido: 'CLINICO-D3' }] },
      updated_at: '2026-01-01 00:00:00+00', vista_hash: 'h1' }, error: null },
    guardar: { data: { ok: true, updated_at: '2026-01-02 00:00:00+00', vista_hash: 'h2' }, error: null }
  }, opc.respuestas || {});
  // Sesión VIVA del navegador (la que firma cada llamada). `viva` = id del usuario cuyo token se enviaría ahora; null = sin sesión.
  const sesionViva = { viva: opc.sinSesionViva ? null : (opc.uid || 'uid-sec'), cb: null, getSessionLlamadas: 0, cambiarTrasGetSession: opc.cambiarTrasGetSession || null };
  const cliente = {
    auth: {
      async getSession() {
        sesionViva.getSessionLlamadas++;
        const actual = sesionViva.viva;
        if (sesionViva.cambiarTrasGetSession !== null && sesionViva.getSessionLlamadas === (opc.cambiarEnLlamada || 1)) sesionViva.viva = sesionViva.cambiarTrasGetSession;   // la sesión cambia DESPUÉS de la comprobación
        return { data: { session: actual ? { user: { id: actual } } : null }, error: null };
      },
      onAuthStateChange(cb) { sesionViva.cb = cb; return { data: { subscription: { unsubscribe() {} } } }; }
    },
    async rpc(nombre, params) {
      const firmante = sesionViva.viva;   // el token que firma ESTA llamada se fija al enviarla
      llamadas.push({ nombre, params: JSON.parse(JSON.stringify(params || {})), firmante });
      // Emula el guard del servidor (SQL: p_uid_esperado vs auth.uid())
      if (nombre === 'cardiolink_guardar_config_administrativa_v1' && params && params.p_uid_esperado != null && params.p_uid_esperado !== sesionViva.viva) {
        return { data: null, error: { code: '42501', message: 'La sesión que inició este guardado ya no es la activa: no se guardó nada', hint: 'SESION_DISTINTA' } };
      }
      const r = nombre === 'cardiolink_config_administrativa_v1' ? respuestas.leer : respuestas.guardar;
      const v = typeof r === 'function' ? await r(params, llamadas.length) : r;
      if (v instanceof Error) throw v;
      if (nombre === 'cardiolink_guardar_config_administrativa_v1' && v && v.data && v.data.ok === true) escrituras.push({ por: firmante, config: params.p_config });
      return v;
    }
  };
  if (opc.sinAuth) delete cliente.auth;
  const escrituras = [];
  const g = {
    supabaseClient: opc.sinCliente ? null : cliente,
    usuarioSupabase: opc.sinSesion ? null : { id: opc.uid || 'uid-sec' },
    backendRolCargado: opc.rolCargado !== false, backendEsAdminOwner: opc.adminOwner === true, backendTieneAccesoTurnos: opc.turnos !== false,
    esMedicoBackendV1: () => opc.medico === true,
    localStorage: { setItem: (k, v) => { if (opc.sinAlmacen) throw new Error('cuota'); almacen[k] = v; }, getItem: k => (k in almacen ? almacen[k] : null), removeItem: k => { delete almacen[k]; } },
    alert: m => alertas.push(String(m)), console: { warn() {}, log() {}, error() {} }
  };
  const win = {};
  new Function('window', 'supabaseClient', 'usuarioSupabase', 'backendRolCargado', 'backendEsAdminOwner', 'backendTieneAccesoTurnos',
    'esMedicoBackendV1', 'localStorage', 'alert', 'console', 'data', 'setTimeout', MOD)(win, g.supabaseClient, g.usuarioSupabase, g.backendRolCargado, g.backendEsAdminOwner,
    g.backendTieneAccesoTurnos, g.esMedicoBackendV1, g.localStorage, g.alert, g.console, opc.data, opc.timer ? (fn => { opc.timer.cbs.push(fn); return opc.timer.cbs.length; }) : undefined);
  const emitirSesion = (evento, uidNuevo) => { if (sesionViva.cb) sesionViva.cb(evento, uidNuevo ? { user: { id: uidNuevo } } : null); };
  return { api: win.cardiolinkConfigSecretariaV1, llamadas, almacen, alertas, respuestas, sesionViva, escrituras, emitirSesion };
}
const guardados = e => e.llamadas.filter(l => l.nombre === 'cardiolink_guardar_config_administrativa_v1');
const claveP = 'cardiolink_config_pendiente_v1_uid-sec', claveC = 'cardiolink_config_conflicto_v1_uid-sec';

prueba('B1 aplica(): sólo Secretaría confirmada por el backend', () => {
  assert.equal(crearEntorno().api.aplica(), true);
  [{ adminOwner: true }, { medico: true }, { turnos: false }, { rolCargado: false }, { sinSesion: true }, { sinCliente: true }].forEach(o => assert.equal(crearEntorno(o).api.aplica(), false));
});

prueba('B2 cargar(): sólo claves de lectura y campos anidados permitidos; documentos sólo de tipo permitido; identidad presente (para imprimir)', async () => {
  const e = crearEntorno();
  const r = await e.api.cargar();
  assert.deepEqual(Object.keys(r.config).sort(), ['documentosClinicos', 'obrasSociales', 'pacientes', 'profesionales', 'usuarios']);
  assert.deepEqual(r.config.pacientes, [{ id: 'pac1', nombreCompleto: 'QA' }]);
  assert.deepEqual(r.config.profesionales, [{ id: 'p1', nombre: 'Dr', logoDocumentoData: 'LOGO' }]);
  // Bloque 4C-1b: constancia, certificado, reposo laboral y orden heredados se LEEN; la receta (y todo otro tipo) no
  assert.deepEqual(r.config.documentosClinicos.map(d => d.id), ['d1', 'd2']);
  assert.ok(!JSON.stringify(r).includes('CLINICO'));
});

prueba('B3 cargar(): RPC ausente / error / red → {error} con aviso visible y SIN usar la fila completa; sin configuración → {config:null}', async () => {
  let e = crearEntorno({ respuestas: { leer: { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } } } });
  let r = await e.api.cargar();
  assert.ok(r.error && !r.config); assert.match(e.api.ultimoAviso(), /no tiene habilitada/);
  e = crearEntorno({ respuestas: { leer: { data: null, error: { code: '42501', message: 'Sin permiso' } } } });
  r = await e.api.cargar(); assert.ok(r.error && !r.config); assert.match(e.api.ultimoAviso(), /No se pudo cargar/);
  e = crearEntorno({ respuestas: { leer: new Error('Failed to fetch') } });
  r = await e.api.cargar(); assert.match(r.error, /Failed to fetch/); assert.match(e.api.ultimoAviso(), /Sin conexión/);
  e = crearEntorno({ respuestas: { leer: { data: { ok: true, config: null }, error: null } } });
  r = await e.api.cargar(); assert.equal(r.config, null);
});

prueba('B4 guardar(): sin versión base → false con aviso y resguardo (no hay upsert ciego)', async () => {
  const e = crearEntorno();
  e.api.cargaTerminada();   // la carga inicial terminó sin dejar versión base (v3.3: antes de eso un guardado ESPERA, no falla)
  assert.equal(await e.api.guardar({ obrasSociales: ['x'] }), false);
  assert.equal(e.llamadas.length, 0);
  assert.match(e.api.ultimoAviso(), /NO se guardó|No se pudo guardar/);
  assert.ok(e.almacen[claveP], 'resguardo pendiente');
});

prueba('B5 guardar(): envía SÓLO claves de escritura y campos anidados permitidos (sin identidad, sin campos clínicos), con la versión base', async () => {
  const e = crearEntorno();
  await e.api.cargar();
  const datos = { obrasSociales: ['OS', 'OS2'], pacientes: [{ id: 'pac1', nombreCompleto: 'QA', notaOculta: 'CLINICO-P', diagnostico: 'CLINICO-DX', telefono: '1' }],
    profesionales: [{ id: 'p1', nombre: 'Dr', area: 'A', prestaciones: ['x'], valores: { a: 1 }, logoDocumentoData: 'LOGO-HACK', firmaDocumentoData: 'FIRMA-HACK', matriculaNacional: 'MN', campoRaro: 'R' }],
    evolucionesClinicas: [{ id: 'e', evolucion: 'CLINICO-E' }], resumenesClinicos: { a: 1 }, documentosClinicos: [{ id: 'd', contenido: 'CLINICO-D' }], notasInternasPorProfesional: { p: 1 },
    notasInternasMedicas: {}, importacionesMedicloudEvoluciones: [], configFinanzas411F: { sueldosSecretaria: [1] }, movimientosFinancieros411C: [],
    usuarios: [{ rol: 'admin' }], roles: [], brandingCardioLink: { nombre: 'HACK' }, migracionesCardioLink: {}, hcPreparacion: {}, integracionesClinicas: {}, claveFutura: 1 };
  assert.equal(await e.api.guardar(datos), true);
  const g = guardados(e)[0];
  assert.deepEqual(Object.keys(g.params.p_config).sort(), ['obrasSociales', 'pacientes', 'profesionales']);
  assert.deepEqual(g.params.p_config.pacientes, [{ id: 'pac1', nombreCompleto: 'QA', telefono: '1' }]);
  assert.deepEqual(g.params.p_config.profesionales, [{ id: 'p1', nombre: 'Dr', area: 'A', prestaciones: ['x'], valores: { a: 1 } }]);
  assert.ok(!/CLINICO|HACK|FIRMA|LOGO|campoRaro/.test(JSON.stringify(g.params)));
  assert.equal(g.params.p_base_updated_at, '2026-01-01 00:00:00+00'); assert.equal(g.params.p_base_hash, 'h1');
});

prueba('B6 tras un guardado correcto la versión base avanza y se limpian aviso y resguardo pendiente', async () => {
  const e = crearEntorno();
  await e.api.cargar();
  await e.api.guardar({ obrasSociales: ['a'] }); await e.api.guardar({ obrasSociales: ['b'] });
  const gs = guardados(e);
  assert.equal(gs[1].params.p_base_updated_at, '2026-01-02 00:00:00+00'); assert.equal(gs[1].params.p_base_hash, 'h2');
  assert.equal(e.api.estado(), 'ok'); assert.equal(e.api.ultimoAviso(), ''); assert.ok(!e.almacen[claveP]);
});

prueba('B7 conflicto → false, NO pisa, resguarda la versión local, aviso visible, versión base sin cambios; una recarga posterior adopta lo del servidor', async () => {
  const e = crearEntorno({ respuestas: { guardar: { data: { ok: false, conflict: true, updated_at: 'otra', vista_hash: 'hx' }, error: null } } });
  await e.api.cargar();
  assert.equal(await e.api.guardar({ obrasSociales: ['mi cambio'] }), false);
  assert.equal(e.api.estado(), 'conflicto'); assert.match(e.api.ultimoAviso(), /NO se guardó/);
  assert.deepEqual(JSON.parse(e.almacen[claveC]).config.obrasSociales, ['mi cambio']);
  assert.equal(await e.api.guardar({ obrasSociales: ['mi cambio 2'] }), false);
  assert.equal(guardados(e)[1].params.p_base_updated_at, '2026-01-01 00:00:00+00');
  const r = await e.api.cargar();
  assert.ok(r.config, 'tras un conflicto la recarga adopta la versión del servidor');
});

prueba('B8 rechazo del servidor (42501 / 22023) → false con el mensaje del servidor visible y resguardo; la recarga sigue funcionando', async () => {
  let e = crearEntorno({ respuestas: { guardar: { data: null, error: { code: '42501', message: 'No se puede quitar el profesional p1' } } } });
  await e.api.cargar(); assert.equal(await e.api.guardar({ profesionales: [] }), false);
  assert.match(e.api.ultimoAviso(), /No se puede quitar el profesional p1/); assert.equal(e.api.estado(), 'rechazo'); assert.ok(e.almacen[claveC]);
  assert.ok((await e.api.cargar()).config);
  e = crearEntorno({ respuestas: { guardar: { data: null, error: { code: '22023', message: 'La clave pacientes llegó vacía' } } } });
  await e.api.cargar(); assert.equal(await e.api.guardar({}), false); assert.match(e.api.ultimoAviso(), /pacientes llegó vacía/);
});

prueba('B9 SIN FALLBACK: RPC ausente al guardar → false (nunca null ni camino alternativo), aviso visible, cambios resguardados y pendientes', async () => {
  const e = crearEntorno({ respuestas: { guardar: { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } } } });
  await e.api.cargar();
  const r = await e.api.guardar({ obrasSociales: ['x'] });
  assert.strictEqual(r, false);
  assert.match(e.api.ultimoAviso(), /NO se guardó/); assert.equal(e.api.estado(), 'pendiente');
  assert.deepEqual(JSON.parse(e.almacen[claveP]).config.obrasSociales, ['x']);
  assert.deepEqual([...new Set(e.llamadas.map(l => l.nombre))].sort(), ['cardiolink_config_administrativa_v1', 'cardiolink_guardar_config_administrativa_v1']);
});

prueba('B10 error de red / respuesta inesperada → false con aviso que aclara que el cambio quedó SOLO en este equipo', async () => {
  let e = crearEntorno({ respuestas: { guardar: new Error('Failed to fetch') } });
  await e.api.cargar(); assert.strictEqual(await e.api.guardar({ obrasSociales: ['x'] }), false);
  assert.match(e.api.ultimoAviso(), /SOLO en este equipo/); assert.match(e.api.ultimoAviso(), /aunque la pantalla haya confirmado/);
  e = crearEntorno({ respuestas: { guardar: { data: { ok: false }, error: null } } });
  await e.api.cargar(); assert.strictEqual(await e.api.guardar({ obrasSociales: ['x'] }), false); assert.equal(e.api.estado(), 'pendiente');
});

prueba('B11 con cambios pendientes una recarga NO pisa la copia local ({retenido}); tras reintentar con éxito se libera', async () => {
  let falla = true;
  const e = crearEntorno({ respuestas: { guardar: () => (falla ? new Error('Failed to fetch') : { data: { ok: true, updated_at: 'u2', vista_hash: 'h2' }, error: null }) } });
  await e.api.cargar(); await e.api.guardar({ obrasSociales: ['local'] });
  const lecturasAntes = e.llamadas.filter(l => l.nombre === 'cardiolink_config_administrativa_v1').length;
  const r = await e.api.cargar();
  assert.equal(r.retenido, true); assert.ok(!r.config);
  assert.equal(e.llamadas.filter(l => l.nombre === 'cardiolink_config_administrativa_v1').length, lecturasAntes, 'no se relee mientras haya cambios pendientes');
  falla = false;
  assert.equal(await e.api.reintentar(), true);
  assert.equal(e.api.estado(), 'ok'); assert.ok(!e.almacen[claveP]);
  assert.ok((await e.api.cargar()).config);
});

prueba('B12 después de recargar la página, los cambios pendientes se recuperan y se reintentan contra la versión base ORIGINAL (no pisado ciego)', async () => {
  const almacen = {};
  let e = crearEntorno({ almacen, respuestas: { guardar: new Error('Failed to fetch') } });
  await e.api.cargar(); await e.api.guardar({ obrasSociales: ['local'] });
  assert.ok(almacen[claveP]);
  // "página nueva": mismo almacenamiento, módulo nuevo; el servidor responde conflicto porque cambió mientras tanto
  e = crearEntorno({ almacen, respuestas: { guardar: { data: { ok: false, conflict: true, updated_at: 'otra', vista_hash: 'hz' }, error: null } } });
  const r = await e.api.cargar();
  assert.equal(r.retenido, true); assert.equal(e.api.estado(), 'pendiente'); assert.match(e.api.ultimoAviso(), /sesión anterior/);
  assert.equal(await e.api.reintentar(), false);
  assert.equal(guardados(e)[0].params.p_base_updated_at, '2026-01-01 00:00:00+00', 'usa la base original resguardada');
  assert.equal(e.api.estado(), 'conflicto'); assert.ok(almacen[claveC] && almacen[claveP], 'nada se pierde: queda también el resguardo pendiente original');
});

prueba('B13 un guardado exitoso posterior NO borra el resguardo de un conflicto previo (se conserva hasta descartarlo)', async () => {
  let n = 0;
  const e = crearEntorno({ respuestas: { guardar: () => (++n === 1 ? { data: { ok: false, conflict: true }, error: null } : { data: { ok: true, updated_at: 'u3', vista_hash: 'h3' }, error: null }) } });
  await e.api.cargar(); await e.api.guardar({ obrasSociales: ['a'] });
  assert.ok(e.almacen[claveC]);
  assert.equal(await e.api.guardar({ obrasSociales: ['b'] }), true);
  assert.ok(e.almacen[claveC], 'el resguardo del conflicto sigue disponible');
  e.api.descartarResguardo(); assert.ok(!e.almacen[claveC]); assert.equal(e.api.estado(), 'ok');
});

prueba('B14 concurrencia propia: dos guardados simultáneos se serializan y el segundo usa la versión base nueva (no hay falso conflicto contra sí mismo)', async () => {
  let enVuelo = 0, maxEnVuelo = 0, soltar1;
  const e = crearEntorno({ respuestas: { guardar: (params, nllamada) => {
    enVuelo++; maxEnVuelo = Math.max(maxEnVuelo, enVuelo);
    const respuesta = { data: { ok: true, updated_at: 'u' + nllamada, vista_hash: 'h' + nllamada }, error: null };
    if (!soltar1) return new Promise(res => { soltar1 = () => { enVuelo--; res(respuesta); }; });
    enVuelo--; return respuesta;
  } } });
  await e.api.cargar();
  const p1 = e.api.guardar({ obrasSociales: ['a'] }), p2 = e.api.guardar({ obrasSociales: ['b'] });
  for (let i = 0; i < 40; i++) await Promise.resolve();
  assert.equal(guardados(e).length, 1, 'el segundo espera al primero');
  soltar1();
  assert.deepEqual([await p1, await p2], [true, true]);
  assert.equal(maxEnVuelo, 1);
  const gs = guardados(e);
  assert.equal(gs.length, 2);
  assert.notEqual(gs[1].params.p_base_updated_at, gs[0].params.p_base_updated_at, 'el segundo parte de la versión confirmada por el primero');
});

prueba('B15 sin almacenamiento disponible: igual devuelve false y muestra el aviso (no finge éxito)', async () => {
  const e = crearEntorno({ sinAlmacen: true, respuestas: { guardar: new Error('Failed to fetch') } });
  await e.api.cargar(); assert.strictEqual(await e.api.guardar({ obrasSociales: ['x'] }), false);
  assert.match(e.api.ultimoAviso(), /NO se guardó/);
});

// ---- v3: CAMBIO DE SESIÓN ------------------------------------------------------------------------------------------------------------------
const tic = async (n) => { for (let i = 0; i < (n || 40); i++) await Promise.resolve(); };
const claveOtro = 'cardiolink_config_pendiente_v1_uid-owner';

prueba('B16 cada guardado envía p_uid_esperado = el usuario que lo INICIÓ; la instantánea se toma al iniciar (no cuando le toca el turno en la cola)', async () => {
  let soltar;
  const e = crearEntorno({ respuestas: { guardar: (params, n) => (n === 2 ? new Promise(res => { soltar = () => res({ data: { ok: true, updated_at: 'u2', vista_hash: 'h2' }, error: null }); })
    : { data: { ok: true, updated_at: 'u3', vista_hash: 'h3' }, error: null }) } });
  await e.api.cargar();
  const d2 = { obrasSociales: ['b'] };
  const p1 = e.api.guardar({ obrasSociales: ['a'] }), p2 = e.api.guardar(d2);
  d2.obrasSociales.push('MUTADO-DESPUES');
  await tic();
  soltar();
  assert.deepEqual([await p1, await p2], [true, true]);
  const gs = guardados(e);
  assert.equal(gs.length, 2);
  gs.forEach(g => assert.equal(g.params.p_uid_esperado, 'uid-sec'));
  assert.deepEqual(gs[1].params.p_config.obrasSociales, ['b'], 'lo que se envía es lo que se inició, no lo mutado después');
});

prueba('B17 SESIÓN: un guardado en espera cuando se CIERRA la sesión o entra OTRO usuario NO se envía; queda resguardado bajo quien lo inició; nunca se firma con otras credenciales', async () => {
  for (const variante of ['cierre de sesión', 'otro usuario']) {
    let soltar;
    const e = crearEntorno({ respuestas: { guardar: (params, n) => (n === 2 ? new Promise(res => { soltar = () => res({ data: { ok: true, updated_at: 'u2', vista_hash: 'h2' }, error: null }); })
      : { data: { ok: true, updated_at: 'u3', vista_hash: 'h3' }, error: null }) } });
    await e.api.cargar();
    const p1 = e.api.guardar({ obrasSociales: ['en vuelo'] });
    const p2 = e.api.guardar({ obrasSociales: ['pendiente'] });   // espera detrás del primero
    await tic();
    assert.equal(guardados(e).length, 1, variante + ': el segundo espera');
    if (variante === 'cierre de sesión') { e.sesionViva.viva = null; e.emitirSesion('SIGNED_OUT', null); }
    else { e.sesionViva.viva = 'uid-owner'; e.emitirSesion('SIGNED_IN', 'uid-owner'); }
    soltar();                                                      // el primero (ya enviado por Secretaría) se resuelve DESPUÉS del cambio
    assert.equal(await p1, true, variante + ': lo ya enviado por Secretaría sí quedó confirmado por el servidor');
    assert.strictEqual(await p2, false, variante + ': lo pendiente no se ejecuta');
    assert.equal(guardados(e).length, 1, variante + ': el pendiente NO se envió');
    e.llamadas.forEach(l => assert.equal(l.firmante, 'uid-sec', variante + ': ninguna llamada se firmó con otras credenciales'));
    assert.deepEqual(e.escrituras.map(x => x.por), ['uid-sec']);
    assert.deepEqual(JSON.parse(e.almacen[claveP]).config.obrasSociales, ['pendiente'], variante + ': el cambio quedó resguardado bajo el usuario original');
    assert.ok(!e.almacen[claveOtro], variante + ': nada resguardado para el otro usuario');
    assert.equal(e.api.estado(), 'pendiente'); assert.match(e.api.ultimoAviso(), /sesión cambió o se cerró/);
    // un guardado NUEVO tras el cambio tampoco sale
    assert.strictEqual(await e.api.guardar({ obrasSociales: ['nuevo'] }), false);
    assert.equal(guardados(e).length, 1);
    e.llamadas.forEach(l => assert.equal(l.firmante, 'uid-sec'));
  }
});

prueba('B18 SESIÓN: si la sesión cambia ENTRE la comprobación y el envío, el servidor lo rechaza (SESION_DISTINTA): nada se escribe y el cambio queda resguardado', async () => {
  const e = crearEntorno({ cambiarTrasGetSession: 'uid-owner', cambiarEnLlamada: 2 });
  await e.api.cargar();                                            // getSession #1
  assert.strictEqual(await e.api.guardar({ obrasSociales: ['x'] }), false);   // getSession #2 pasa y luego la sesión cambia
  assert.equal(e.escrituras.length, 0, 'el servidor no aceptó ninguna escritura');
  assert.equal(guardados(e)[0].params.p_uid_esperado, 'uid-sec');
  assert.equal(e.api.estado(), 'pendiente'); assert.match(e.api.ultimoAviso(), /sesión cambió o se cerró/);
  assert.deepEqual(JSON.parse(e.almacen[claveP]).config.obrasSociales, ['x']);
});

prueba('B19 SESIÓN: la respuesta de una carga que llega después de un cambio de sesión se DESCARTA; luego tampoco se guarda', async () => {
  let soltar;
  const respLeer = crearEntorno().respuestas.leer;
  const e = crearEntorno({ respuestas: { leer: () => new Promise(res => { soltar = () => res(respLeer); }) } });
  const pc = e.api.cargar(); await tic();
  e.sesionViva.viva = 'uid-owner'; e.emitirSesion('SIGNED_IN', 'uid-owner');
  soltar();
  const r = await pc;
  assert.equal(r.error, 'sesion_distinta'); assert.ok(!r.config, 'no se entrega configuración de una sesión que ya no es la actual');
  assert.strictEqual(await e.api.guardar({ obrasSociales: ['x'] }), false);
  assert.equal(guardados(e).length, 0);
});

prueba('B20 SESIÓN: los resguardos están atados al usuario; otro usuario no los ve, no los reintenta ni los hereda', async () => {
  const almacen = {};
  const e1 = crearEntorno({ almacen, respuestas: { guardar: new Error('Failed to fetch') } });
  await e1.api.cargar(); await e1.api.guardar({ obrasSociales: ['SOLO-DE-UID-SEC'] });
  assert.ok(almacen[claveP]);
  const e2 = crearEntorno({ almacen, uid: 'uid-sec2' });
  const r = await e2.api.cargar();
  assert.ok(r.config && !r.retenido, 'el otro usuario no ve el pendiente del primero');
  assert.equal(e2.api.estado(), 'ok'); assert.equal(e2.api.ultimoAviso(), '');
  assert.strictEqual(await e2.api.guardar({ obrasSociales: ['propio'] }), true);
  guardados(e2).forEach(g => assert.equal(g.params.p_uid_esperado, 'uid-sec2'));
  assert.ok(!JSON.stringify(e2.llamadas).includes('SOLO-DE-UID-SEC'), 'nada del primero sale con las credenciales del segundo');
  assert.ok(almacen[claveP], 'el resguardo del primero sigue intacto para cuando vuelva');
});

prueba('B21 SESIÓN: fail-closed — si la sesión viva no se puede confirmar (sin sesión, sin API de sesión) no se envía nada', async () => {
  for (const o of [{ sinSesionViva: true }, { sinAuth: true }]) {
    const e = crearEntorno(o);
    assert.strictEqual(await e.api.guardar({ obrasSociales: ['x'] }), false);
    assert.equal(e.llamadas.length, 0, JSON.stringify(o));
    assert.ok(e.almacen[claveP], 'el cambio queda resguardado');
  }
});

// ---- v3.3: versión base (sin_base) ------------------------------------------------------------------------------------------------------------
const claveSlotP = 'cardiolink_config_pendiente_v1_uid-sec', claveSlotC = 'cardiolink_config_conflicto_v1_uid-sec';
// vista de escritura equivalente a la respuesta de lectura por defecto de crearEntorno()
const vistaIgualAlServidor = () => ({ obrasSociales: ['OS'], pacientes: [{ id: 'pac1', nombreCompleto: 'QA' }], profesionales: [{ id: 'p1', nombre: 'Dr' }] });
const slotSinBase = cfg => JSON.stringify({ fecha: '2026-11-12T01:34:41.315Z', tipo: 'pendiente', motivo: 'sin_base', base: { updatedAt: null, hash: null, uid: null }, config: cfg });
const BASE_LEIDA = '2026-01-01 00:00:00+00';

prueba('B22 GUARDADO DE ARRANQUE antes de la base: NO genera pendiente ni aviso; espera la carga inicial y, si la configuración ya cargada es idéntica a la del servidor, no escribe nada', async () => {
  const e = crearEntorno({ data: { obrasSociales: ['OS'], pacientes: [{ id: 'pac1', nombreCompleto: 'QA' }], profesionales: [{ id: 'p1', nombre: 'Dr' }] } });
  const p = e.api.guardar({ obrasSociales: ['SNAPSHOT-VIEJO-DEL-CACHE'] });    // el guardado automático de arranque llega ANTES de leer la base
  await tic();
  assert.equal(guardados(e).length, 0, 'no se envía nada sin base'); assert.ok(!e.almacen[claveSlotP], 'no se crea un pendiente'); assert.equal(e.api.ultimoAviso(), ''); assert.equal(e.api.estado(), 'ok');
  const r = await e.api.cargar();                                               // el cargador lee la base y aplica la configuración
  assert.ok(r.config); e.api.cargaTerminada();
  assert.strictEqual(await p, true, 'el servidor ya tiene exactamente esa configuración');
  assert.equal(guardados(e).length, 0, 'no se escribe nada (no se usa el snapshot viejo)'); assert.ok(!e.almacen[claveSlotP] && !e.almacen[claveSlotC]); assert.equal(e.api.estado(), 'ok');
});

prueba('B23 guardado que esperaba la base: se reevalúa con la configuración YA CARGADA (no con el snapshot previo) y usa la base realmente leída', async () => {
  const live = { obrasSociales: ['OS'], pacientes: [{ id: 'pac1', nombreCompleto: 'QA' }], profesionales: [{ id: 'p1', nombre: 'Dr' }] };
  const e = crearEntorno({ data: live });
  const p = e.api.guardar({ obrasSociales: ['SNAPSHOT-VIEJO'] });
  await tic();
  await e.api.cargar(); live.obrasSociales = ['OS', 'EDICION-REAL-DEL-USUARIO']; e.api.cargaTerminada();
  assert.strictEqual(await p, true);
  const gs = guardados(e); assert.equal(gs.length, 1);
  assert.deepEqual(gs[0].params.p_config.obrasSociales, ['OS', 'EDICION-REAL-DEL-USUARIO'], 'se envía lo actual, no el snapshot previo a la carga');
  assert.equal(gs[0].params.p_base_updated_at, BASE_LEIDA, 'la base es la leída del servidor en esta carga'); assert.equal(gs[0].params.p_uid_esperado, 'uid-sec');
  assert.ok(!JSON.stringify(gs[0].params).includes('SNAPSHOT-VIEJO'));
});

prueba('B24 si la carga inicial terminó SIN dejar base, el guardado falla de forma visible (sin_base) y resguarda; no se envía nada', async () => {
  const e = crearEntorno({ respuestas: { leer: { data: null, error: { code: '42501', message: 'x' } } } });
  const p = e.api.guardar({ obrasSociales: ['x'] }); await tic();
  assert.equal(guardados(e).length, 0);
  await e.api.cargar(); e.api.cargaTerminada();
  assert.strictEqual(await p, false); assert.equal(guardados(e).length, 0, 'jamás se inventa una base');
  assert.equal(e.api.estado(), 'pendiente'); assert.match(e.api.ultimoAviso(), /todavía no se leyó la versión del servidor/);
  const slot = JSON.parse(e.almacen[claveSlotP]); assert.equal(slot.motivo, 'sin_base'); assert.equal(slot.base.updatedAt, null);
});

prueba('B25 la espera de la base tiene tope (temporizador): vencido, falla visible y resguarda; no se queda colgado', async () => {
  const timer = { cbs: [] };
  const e = crearEntorno({ timer });
  const p = e.api.guardar({ obrasSociales: ['x'] }); await tic();
  assert.equal(timer.cbs.length, 1, 'se programó el tope de espera');
  timer.cbs[0]();
  assert.strictEqual(await p, false); assert.equal(guardados(e).length, 0); assert.equal(e.api.estado(), 'pendiente'); assert.ok(e.almacen[claveSlotP]);
});

prueba('B26 PENDIENTE sin_base IDÉNTICO al servidor: se recupera la base remota y se ELIMINA el pendiente redundante (sin aviso, sin escribir)', async () => {
  const e = crearEntorno({ almacen: { [claveSlotP]: slotSinBase(vistaIgualAlServidor()) } });
  const r = await e.api.cargar();
  assert.ok(r.config, 'la carga continúa normalmente'); assert.equal(r.sinBase, 'identico');
  assert.ok(!e.almacen[claveSlotP], 'pendiente redundante eliminado'); assert.ok(!e.almacen[claveSlotC]);
  assert.equal(e.api.estado(), 'ok'); assert.equal(e.api.ultimoAviso(), ''); assert.equal(guardados(e).length, 0, 'no se escribe nada en el servidor');
  assert.equal(e.llamadas.filter(l => l.nombre === 'cardiolink_config_administrativa_v1').length, 1);
  // y un guardado normal posterior funciona con la base recuperada
  e.api.cargaTerminada();
  assert.strictEqual(await e.api.guardar({ obrasSociales: ['OS', 'NUEVA'] }), true);
  const g = guardados(e)[0]; assert.equal(g.params.p_base_updated_at, BASE_LEIDA); assert.equal(g.params.p_base_hash, 'h1'); assert.equal(g.params.p_uid_esperado, 'uid-sec');
});

prueba('B27 PENDIENTE sin_base con DIFERENCIAS: se PRESERVA íntegro como conflicto, se pide resolución, se carga el servidor y NO se escribe nada', async () => {
  const local = vistaIgualAlServidor(); local.pacientes[0].nombreCompleto = 'CAMBIO LOCAL REAL'; local.obrasSociales.push('OS-LOCAL');
  const anterior = JSON.stringify({ fecha: 'f0', tipo: 'conflicto', motivo: 'conflicto', base: null, config: { obrasSociales: ['CONFLICTO-PREVIO'] } });
  const e = crearEntorno({ almacen: { [claveSlotP]: slotSinBase(local), [claveSlotC]: anterior } });
  const r = await e.api.cargar();
  assert.equal(r.sinBase, 'diferencias'); assert.equal(r.config.pacientes[0].nombreCompleto, 'QA', 'se carga la versión del servidor');
  assert.equal(guardados(e).length, 0, 'jamás se sobrescribe el servidor');
  assert.ok(!e.almacen[claveSlotP], 'el pendiente pasa a conflicto (no se pierde)');
  const c = JSON.parse(e.almacen[claveSlotC]);
  assert.deepEqual(c.config, local, 'contenido preservado sin cambios'); assert.equal(c.motivo, 'sin_base_con_diferencias'); assert.equal(c.tipo, 'conflicto');
  assert.deepEqual(c.anteriores[0].config, { obrasSociales: ['CONFLICTO-PREVIO'] }, 'un conflicto previo tampoco se pisa');
  assert.equal(e.api.estado(), 'conflicto'); assert.match(e.api.ultimoAviso(), /difieren del servidor/); assert.match(e.api.ultimoAviso(), /no se enviaron ni se descartaron/);
  // el aviso específico NO se reemplaza por el genérico cuando después se guarda con éxito (guardado normal con la base recuperada)
  e.api.cargaTerminada(); assert.strictEqual(await e.api.guardar({ obrasSociales: ['OS', 'X'] }), true);
  assert.match(e.api.ultimoAviso(), /difieren del servidor/); assert.equal(e.api.estado(), 'conflicto'); assert.ok(e.almacen[claveSlotC], 'el conflicto sigue resguardado');
  // tras recargar la página (módulo nuevo, mismo almacenamiento) el aviso sigue siendo el específico
  const e2 = crearEntorno({ almacen: e.almacen }); await e2.api.cargar();
  assert.match(e2.api.ultimoAviso(), /difieren del servidor/);
});

prueba('B28 pendiente sin_base y no se puede leer la base (red/RPC): el pendiente queda intacto, sin escribir ni descartar', async () => {
  const seed = slotSinBase({ obrasSociales: ['LOCAL'] });
  for (const leer of [new Error('Failed to fetch'), { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }, { data: { ok: false }, error: null }, { data: { ok: true, config: null }, error: null }]) {
    const e = crearEntorno({ almacen: { [claveSlotP]: seed }, respuestas: { leer } });
    const r = await e.api.cargar();
    assert.equal(r.retenido, true); assert.equal(e.almacen[claveSlotP], seed, 'pendiente intacto'); assert.equal(guardados(e).length, 0); assert.equal(e.api.estado(), 'pendiente');
  }
});

prueba('B29 pendiente sin_base con diferencias y NO se puede escribir el conflicto: se conserva el pendiente (nunca se pierde)', async () => {
  const local = vistaIgualAlServidor(); local.obrasSociales.push('OS-LOCAL');
  const seed = slotSinBase(local);
  const e = crearEntorno({ almacen: { [claveSlotP]: seed }, sinAlmacen: true });
  const r = await e.api.cargar();
  assert.equal(r.retenido, true); assert.equal(e.almacen[claveSlotP], seed); assert.ok(!e.almacen[claveSlotC]); assert.equal(e.api.estado(), 'pendiente'); assert.equal(guardados(e).length, 0);
});

prueba('B30 reintentar() con pendiente sin_base: recupera la base remota (idéntico → elimina; diferencias → preserva); nunca envía con una base inventada', async () => {
  let e = crearEntorno({ almacen: { [claveSlotP]: slotSinBase(vistaIgualAlServidor()) }, data: undefined });
  e.api.cargaTerminada();
  assert.strictEqual(await e.api.reintentar(), true); assert.ok(!e.almacen[claveSlotP]); assert.equal(guardados(e).length, 0); assert.equal(e.api.estado(), 'ok');
  const local = vistaIgualAlServidor(); local.obrasSociales.push('OS-LOCAL');
  e = crearEntorno({ almacen: { [claveSlotP]: slotSinBase(local) } });
  assert.strictEqual(await e.api.reintentar(), false); assert.equal(guardados(e).length, 0); assert.ok(e.almacen[claveSlotC] && !e.almacen[claveSlotP]); assert.equal(e.api.estado(), 'conflicto');
});

prueba('B31 pendiente CON su base original (comportamiento anterior): sigue retenido y se reintenta contra esa base; no se relee', async () => {
  const e = crearEntorno({ almacen: { [claveSlotP]: JSON.stringify({ fecha: 'f', tipo: 'pendiente', motivo: 'red', base: { updatedAt: 'U0', hash: 'H0', uid: 'uid-sec' }, config: { obrasSociales: ['LOCAL'] } }) } });
  const r = await e.api.cargar();
  assert.equal(r.retenido, true); assert.equal(e.llamadas.length, 0);
  assert.strictEqual(await e.api.reintentar(), true); assert.equal(guardados(e)[0].params.p_base_updated_at, 'U0');
});

prueba('B32 perfil limpio: carga, base y guardado normales; no queda ningún pendiente ni aviso', async () => {
  const e = crearEntorno();
  const r = await e.api.cargar(); e.api.cargaTerminada();
  assert.ok(r.config && !r.sinBase); assert.equal(e.api.estado(), 'ok'); assert.equal(e.api.ultimoAviso(), '');
  assert.strictEqual(await e.api.guardar({ obrasSociales: ['a'] }), true); assert.equal(guardados(e)[0].params.p_base_updated_at, BASE_LEIDA);
  assert.ok(!e.almacen[claveSlotP] && !e.almacen[claveSlotC]);
});

prueba('C17 el cargador de app.js avisa cargaTerminada() DESPUÉS de aplicar la configuración y antes de procesar las atenciones (sin romper la carga si falla)', () => {
  const i = APP.indexOf("try{ window.cardiolinkConfigSecretariaV1?.cargaTerminada?.(); }catch(e){}");
  assert.ok(i > 0);
  assert.ok(i > APP.indexOf('data=cfgRemota298; localStorage.setItem(storageConfig,JSON.stringify(data));'), 'después de aplicar la configuración remota');
  assert.ok(i < APP.indexOf('const filasAtencion298=', i), 'antes de procesar las atenciones');
  assert.equal((APP.match(/cargaTerminada\?\.\(\)/g) || []).length, 1);
  assert.match(MOD, /cargaTerminada: cargaTerminada,/);
});

// ---------------------------------------------------------------- C) enganches en app.js (código real) + auditoría de llamadores
function tramo(desde, hasta) {
  const i = APP.indexOf(desde), j = APP.indexOf(hasta, i + 1);
  assert.ok(i >= 0 && j > i, 'no se encontró el tramo: ' + desde);
  return APP.slice(i, j);
}

prueba('C1 index.html carga el módulo una vez, después de app.js', () => {
  const iApp = INDEX.indexOf('<script src="app.js'), iMod = INDEX.indexOf('<script src="cardiolink-config-secretaria-v1.js');
  assert.ok(iApp > 0 && iMod > iApp);
  assert.equal(INDEX.split('cardiolink-config-secretaria-v1.js').length - 1, 1);
});

// ---- v3: helpers para ejecutar el código REAL de app.js con dobles ---------------------------------------------------------------------------
const cuerpoGuardar = tramo('async function guardarConfigEnSupabase298(){', 'window.guardarConfigEnSupabase298=');   // incluye confirmarConfigAdministrativaV1 y avisarConfigNoConfirmadaV1
const helpersRol = tramo('function configCompletaPermitidaV1(){', '// Nombre visible CONFIABLE');                    // configCompletaPermitidaV1 + sesionVivaCoincideV1
function armarGuardar(o) {
  const upserts = [], delModulo = [], timers = [], alertas = [];
  const sesion = { viva: o.viva === undefined ? 'u' : o.viva };
  const supabaseClient = {
    auth: o.sinAuth ? undefined : { getSession: async () => { if (o.getSessionLanza) throw new Error('x'); return { data: { session: sesion.viva ? { user: { id: sesion.viva } } : null } }; } },
    from: () => ({ upsert: async rows => { upserts.push(rows); return { error: o.upsertError || null }; } })
  };
  const win = { cardiolinkConfigSecretariaV1: o.modulo === undefined ? undefined : { aplica: () => o.modulo.aplica, guardar: async d => { delModulo.push(d); return o.modulo.res; } } };
  // R2B: el guardado de Dueño/Admin lo hace el módulo de concurrencia (UPDATE condicionado). El doble de prueba verifica la sesión viva como lo hace el módulo y registra la escritura.
  if (!o.sinR2B) win.cardiolinkConfigR2B = { activo: () => true, guardarDueno: async uid => {
    try { if (!supabaseClient.auth) return false; const r = await supabaseClient.auth.getSession(); const u = r && r.data && r.data.session && r.data.session.user; if (!u || String(u.id) !== String(uid)) return false; } catch (e) { return false; }
    if (o.upsertError) return false; upserts.push([uid]); return true; } };
  const f = new Function('supabaseClient', 'usuarioSupabase', 'backendRolCargado', 'backendEsAdminOwner', 'esMedicoBackendV1', 'data', 'VERSION_298', 'CONFIG_ROW_ID',
    'esRechazoIdentidadArchivoLlenoV1', 'mostrarAvisoConfigRechazadaV1', 'quitarAvisoConfigRechazadaV1', 'window', 'console', 'clearTimeout', 'alert',
    helpersRol + '\n' + cuerpoGuardar + '\nreturn {guardar: guardarConfigEnSupabase298, confirmar: confirmarConfigAdministrativaV1, aviso: window.avisarConfigNoConfirmadaV1};');
  const api = f(supabaseClient, o.sinUsuario ? null : { id: 'u' }, o.rolCargado, o.admin, () => !!o.medico, { pacientes: [1], evolucionesClinicas: [2] }, 'v', '__cardiolink_config_v1',
    () => false, () => {}, () => {}, win, { warn() {} }, t => timers.push(t), m => alertas.push(m));
  return Object.assign({ upserts, delModulo, timers, alertas, sesion }, api);
}

prueba('C2 guardarConfigEnSupabase298: la fila completa sólo la escribe un owner/admin CONFIRMADO y con la sesión viva intacta; rol sin confirmar, Secretaría y médico nunca', async () => {
  const SEC_OK = { aplica: true, res: true };
  // owner/admin confirmado: sin cambios en su flujo legítimo
  let c = armarGuardar({ rolCargado: true, admin: true, modulo: { aplica: false } });
  assert.equal(await c.guardar(), true); assert.equal(c.upserts.length, 1); assert.equal(c.delModulo.length, 0);
  // R2B: sin el módulo de concurrencia NO hay escritura (ni upsert ciego): false, sin escrituras, los cambios quedan pendientes
  c = armarGuardar({ rolCargado: true, admin: true, sinR2B: true });
  assert.strictEqual(await c.guardar(), false); assert.equal(c.upserts.length, 0); assert.equal(c.delModulo.length, 0);
  // owner/admin confirmado pero la sesión viva cambió / se cerró / no se puede confirmar: NO se escribe con credenciales ajenas
  for (const o of [{ viva: 'otro' }, { viva: null }, { sinAuth: true }, { getSessionLanza: true }]) {
    c = armarGuardar(Object.assign({ rolCargado: true, admin: true }, o));
    assert.strictEqual(await c.guardar(), false, JSON.stringify(o)); assert.equal(c.upserts.length, 0, JSON.stringify(o));
  }
  // ROL NO CONFIRMADO: ni la fila completa ni la RPC; aunque quede una bandera de admin vieja
  for (const o of [{ rolCargado: false, admin: false }, { rolCargado: false, admin: true }, { rolCargado: undefined, admin: true }]) {
    c = armarGuardar(Object.assign({ modulo: SEC_OK }, o));
    assert.strictEqual(await c.guardar(), false, 'rol sin confirmar'); assert.equal(c.upserts.length, 0, 'rol sin confirmar: sin upsert'); assert.equal(c.delModulo.length, 0, 'rol sin confirmar: sin RPC');
  }
  // Secretaría confirmada: sólo la RPC; un fallo/conflicto/42501 (false) NO cae al upsert completo
  c = armarGuardar({ rolCargado: true, admin: false, modulo: SEC_OK });
  assert.equal(await c.guardar(), true); assert.equal(c.upserts.length, 0); assert.equal(c.delModulo.length, 1);
  c = armarGuardar({ rolCargado: true, admin: false, modulo: { aplica: true, res: false } });
  assert.strictEqual(await c.guardar(), false); assert.equal(c.upserts.length, 0, 'un fallo de la RPC no cae al JSON completo');
  for (const modulo of [{ aplica: false, res: true }, undefined]) {
    c = armarGuardar({ rolCargado: true, admin: false, modulo });
    assert.strictEqual(await c.guardar(), false); assert.equal(c.upserts.length, 0);
  }
  // médico (confirmado o no): nunca escribe
  for (const o of [{ rolCargado: true, admin: false, medico: true }, { rolCargado: false, admin: false, medico: true }]) {
    c = armarGuardar(Object.assign({ modulo: { aplica: false } }, o));
    assert.strictEqual(await c.guardar(), false); assert.equal(c.upserts.length, 0);
  }
});

function armarLector(o) {
  const registro = { neq: null };
  const fila = { id: '__cardiolink_config_v1', payload: { tipoRegistro: 'config', config: { evolucionesClinicas: [{ id: 'x' }], pacientes: [] } } };
  const otra = { id: 'a1', payload: { id: 'a1' } };
  const supabaseClient = { from: () => { const b = { filtro: null, select: () => b, neq: (c, v) => { registro.neq = [c, v]; b.filtro = [c, v]; return b; },
    order: async () => ({ data: (b.filtro && o.servidorFiltra ? [] : [fila]).concat([otra]), error: null }) }; return b; } };
  const trozo = APP.slice(APP.indexOf('const pideCfgCompleta298='), APP.indexOf('if(cfgRow?.payload?.config){', APP.indexOf('const pideCfgCompleta298=')));
  assert.ok(trozo.length > 100, 'no se encontró el enganche de carga');
  const win = { cardiolinkConfigSecretariaV1: o.modulo };
  const f = new Function('supabaseClient', 'usuarioSupabase', 'backendRolCargado', 'backendEsAdminOwner', 'esMedicoBackendV1', 'CONFIG_ROW_ID', 'window', 'alert', 'console',
    helpersRol + '\nreturn (async()=>{' + trozo + '\nreturn {cfgRow, rows};})();');
  return f(supabaseClient, { id: 'u' }, o.rolCargado, o.admin, () => !!o.medico, '__cardiolink_config_v1', win, () => {}, { warn() {}, error() {} }).then(r => Object.assign(r, { registro, fila }));
}

prueba('C3 carga remota: rol SIN confirmar nunca toma ni pide la fila completa; Secretaría usa la RPC; owner/admin y médico confirmados conservan su flujo', async () => {
  const modLanza = { aplica: () => true, cargar: async () => { throw new Error('no debe llamarse'); } };
  // rol sin confirmar (incluida una bandera de admin vieja): la fila ni se pide y, aunque el servidor la devolviera, se ignora
  for (const o of [{ rolCargado: false, admin: false }, { rolCargado: false, admin: true }, { rolCargado: undefined, admin: true }, { rolCargado: false, admin: false, medico: true }]) {
    for (const servidorFiltra of [true, false]) {
      const r = await armarLector(Object.assign({ modulo: modLanza, servidorFiltra }, o));
      assert.deepEqual(r.registro.neq, ['id', '__cardiolink_config_v1'], 'se excluye la fila de configuración de la consulta: ' + JSON.stringify(o));
      assert.equal(r.cfgRow, null, 'rol sin confirmar: nunca la fila completa (servidorFiltra=' + servidorFiltra + ')');
    }
  }
  // Secretaría confirmada: consulta sin la fila + RPC
  const caso = (cargar, extra) => armarLector(Object.assign({ rolCargado: true, admin: false, servidorFiltra: false, modulo: { aplica: () => true, cargar } }, extra || {}));
  let r = await caso(async () => ({ config: { pacientes: [1] } }));
  assert.deepEqual(r.registro.neq, ['id', '__cardiolink_config_v1']);
  assert.deepEqual(r.cfgRow.payload.config, { pacientes: [1] }); assert.ok(!('evolucionesClinicas' in r.cfgRow.payload.config));
  for (const res of [{ error: 'x' }, { retenido: true }, { config: null }]) assert.equal((await caso(async () => res)).cfgRow, null, JSON.stringify(res));
  assert.equal((await armarLector({ rolCargado: true, admin: false, servidorFiltra: false, modulo: { aplica: () => false, cargar: modLanza.cargar } })).cfgRow, null, 'no aplica: nunca la fila completa');
  assert.equal((await armarLector({ rolCargado: true, admin: false, servidorFiltra: false, modulo: undefined })).cfgRow, null, 'sin el módulo: nunca la fila completa');
  // owner/admin confirmado: sin cambios (pide y usa la fila)
  r = await armarLector({ rolCargado: true, admin: true, servidorFiltra: false, modulo: modLanza });
  assert.equal(r.registro.neq, null); assert.equal(r.cfgRow, r.fila);
  // médico confirmado: sin cambios respecto de antes (no se le quita lo que su RLS le entregue; no usa la RPC de Secretaría)
  r = await armarLector({ rolCargado: true, admin: false, medico: true, servidorFiltra: false, modulo: modLanza });
  assert.equal(r.registro.neq, null); assert.equal(r.cfgRow, r.fila);
});

prueba('C4 sin fallback en el código; y cada acceso a la fila de configuración por id está protegido por rol confirmado (censo de accesos a cardiolink_atenciones)', () => {
  assert.ok(!/sinRpc/.test(APP) && !/sinRpc/.test(MOD.replace(/\/\*[\s\S]*?\*\//g, '')), 'quedó un camino sinRpc');
  assert.ok(!/return null;\s*\/\/ RPC/.test(MOD));
  // lectura de documentos en la fila heredada: sólo con owner/admin confirmado
  assert.match(APP, /if\(configCompletaPermitidaV1\(\)\)\{[^\n]*\n\s*const \{data:filas,error\}=await supabaseClient\.from\('cardiolink_atenciones'\)\.select\('d:payload->config->documentosClinicos'\)\.eq\('id',CONFIG_ROW_ID_DOCS_V1\)/);
  // R2B: app.js YA NO escribe la fila completa con upsert (ni como respaldo). Delega en el módulo de concurrencia, después de exigir owner/admin confirmado; sin módulo no escribe y avisa.
  assert.equal((APP.match(/\.upsert\(\[\{id:CONFIG_ROW_ID,/g) || []).length, 0);
  const g = APP.slice(APP.indexOf('async function guardarConfigEnSupabase298(){'), APP.indexOf('window.guardarConfigEnSupabase298='));
  assert.ok(g.indexOf('if(!configCompletaPermitidaV1())') > 0 && g.indexOf('if(!configCompletaPermitidaV1())') < g.indexOf('guardarDueno('));
  assert.ok(g.indexOf('guardarDueno(') > 0 && g.indexOf('avisarR2BNoCargado298();') > g.indexOf('guardarDueno(') && /avisarR2BNoCargado298\(\);\s*return false;/.test(g), 'sin el módulo: aviso y return false, sin escritura');
  assert.ok(!/\.upsert\(|\.update\(/.test(g.replace(/\/\/[^\n]*/g, '')), 'guardarConfigEnSupabase298 no escribe directamente');
  // el módulo de concurrencia: sólo 2 accesos a cardiolink_atenciones (leer y actualizar la fila de config por id), la escritura es UPDATE condicionado y exige owner/admin confirmado y sesión viva
  const CONC = leer('cardiolink-config-concurrencia-v1.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal((CONC.match(/\.from\('cardiolink_atenciones'\)/g) || []).length, 2);
  assert.ok(!/\.upsert\(|\.insert\(|\.delete\(/.test(CONC), 'el módulo no hace upsert/insert/delete');
  assert.match(CONC, /\.update\(\{ payload: payload, updated_at: ahora \}\)\.eq\('id', ID_FILA\)\.eq\('updated_at', fila\.updated_at\)/);
  assert.ok(CONC.indexOf('if (!activo()) return false;') > 0 && CONC.indexOf('if (!activo()) return false;') < CONC.indexOf('sesionVivaCoincideV1(uid)') && CONC.indexOf('sesionVivaCoincideV1(uid)') < CONC.indexOf('.update({ payload'));
  // la consulta general excluye la fila de configuración salvo owner/admin/médico confirmados
  assert.match(APP, /if\(!pideCfgCompleta298\) consulta298=consulta298\.neq\('id',CONFIG_ROW_ID\);/);
  // CENSO: 13 accesos a la tabla; sólo 2 pueden tocar la fila de configuración por id y están protegidos (lectura de documentos, consulta general); la escritura vive en el módulo de concurrencia (UPDATE condicionado, owner/admin confirmado)
  const accesos = (APP.match(/\.from\((['"])cardiolink_atenciones\1\)/g) || []).length;
  assert.equal(accesos, 11, 'R2C: la relectura de conflictos y la fusión viven ahora en cardiolink-atenciones-concurrencia-v1.js (-1 acceso en app.js); cambió la cantidad de accesos a cardiolink_atenciones: revisar que ninguno nuevo pueda tocar la fila de configuración sin rol confirmado');
  assert.equal((APP.match(/CONFIG_ROW_ID_DOCS_V1\)/g) || []).length, 1);
  // R2C: el módulo de concurrencia de atenciones tiene 2 accesos (leer y UPDATE condicionado por id), rechaza la fila de configuración y nunca hace upsert/insert/delete
  const CONC2 = leer('cardiolink-atenciones-concurrencia-v1.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal((CONC2.match(/\.from\('cardiolink_atenciones'\)/g) || []).length, 2);
  assert.ok(!/\.from\('cardiolink_atenciones'\)[^;]*\.(upsert|insert|delete)\(/.test(CONC2) && !/\.upsert\(|\.insert\(/.test(CONC2), 'el módulo de atenciones no hace upsert/insert/delete sobre la tabla');
  assert.match(CONC2, /id === '__cardiolink_config_v1'\) return/);
  assert.match(CONC2, /\.update\(\{ payload: destino, updated_at: nuevaVersion \}\)\.eq\('id', id\)\.eq\('updated_at', rem\.fila\.updated_at\)/);
  MODULOS.forEach(f => assert.ok(!/cardiolink_atenciones/.test(leer(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')), f + ' accede a cardiolink_atenciones'));
});

prueba('C5 auditoría de llamadores: referencias a guardarConfigEnSupabase298 y a la confirmación (un llamador nuevo obliga a revisar su aviso de éxito)', () => {
  const cuenta = (f, re) => (leer(f).match(re) || []).length;
  assert.equal(cuenta('app.js', /guardarConfigEnSupabase298/g), 29, '20 llamadores/definiciones previos + 7 referencias internas del bloque R1 (envoltorio de persistencia y reintentos del refresco) + 2 del refresco R2B (guardado tras fusionar, Dueño y Secretaría); ningún llamador de flujo de usuario nuevo'); assert.equal(cuenta('cardiolink-agenda-v1.js', /guardarConfigEnSupabase298/g), 4);
  assert.equal(cuenta('cardiolink-pedidos-rapidos-v1.js', /guardarConfigEnSupabase298/g), 3);
  MODULOS.filter(f => !['cardiolink-agenda-v1.js', 'cardiolink-pedidos-rapidos-v1.js'].includes(f)).forEach(f => assert.equal(cuenta(f, /guardarConfigEnSupabase298/g), 0, f + ' tiene un llamador nuevo'));
  assert.match(leer('cardiolink-agenda-v1.js'), /sincronizado = await window\.guardarConfigEnSupabase298\?\.\(\);/);
  assert.match(leer('cardiolink-pedidos-rapidos-v1.js'), /sincronizado = await window\.guardarConfigEnSupabase298\?\.\(\);/);
  assert.match(APP, /async function confirmarImportPacientes298\(\)/);
  // flujos críticos que ahora esperan la confirmación real antes de afirmar éxito (o avisan cuando no se confirma)
  assert.equal(cuenta('app.js', /confirmarConfigAdministrativaV1\(\)/g), 10);
  assert.equal(cuenta('app.js', /persistirConfigVisibleV1\(/g), 9, 'flujos visibles de Coberturas y valores que esperan la confirmación (definición + 8 usos)');
  assert.equal(cuenta('app.js', /persist402\(\)/g), 3, 'persist402 (sin confirmación) sólo queda para las notas privadas médicas');
  assert.equal(cuenta('cardiolink-agenda-v1.js', /confirmarConfigAdministrativaV1\(\)/g), 1);
});

prueba('C6 importación de pacientes: el aviso de éxito aclara el fallo si el servidor no confirmó (false); sin falso éxito', async () => {
  const cuerpo = tramo('async function confirmarImportPacientes298(){', 'window.confirmarImportPacientes298=');
  const f = new Function('previewImportPacientes298', 'pacienteExistente298', 'aplicarPaciente298', 'saveConfig', 'guardarConfigEnSupabase298', 'renderPacientesPanel',
    'cerrarModalPaciente298', 'alert', 'usuarioSupabase', 'console', cuerpo + '\nreturn confirmarImportPacientes298;');
  const caso = async (res, sesion) => {
    const alertas = [];
    const g = f([{ paciente: { nombreCompleto: 'QA', dni: '1' } }], () => null, () => ({ creado: true }), () => {}, async () => res, () => {}, () => {}, m => alertas.push(m), sesion, { warn() {} });
    await g(); return alertas;
  };
  assert.ok(/ATENCIÓN[\s\S]*SOLO en este equipo/.test((await caso(false, { id: 'u' }))[0]), 'false con sesión: aviso de fallo');
  assert.ok(!/ATENCIÓN/.test((await caso(true, { id: 'u' }))[0]), 'true: sin aviso');
  assert.ok(!/ATENCIÓN/.test((await caso(false, null))[0]), 'modo local sin sesión: sin aviso de sincronización');
});

prueba('C7 convenio guardado: el mensaje de éxito sólo aparece con la confirmación del servidor; sin confirmar se dice que quedó SOLO en este equipo', async () => {
  const linea = APP.split('\n').find(l => l.includes("avisarConfigNoConfirmadaV1('El convenio'); else alert('Convenio guardado."));
  assert.ok(linea, 'no se encontró el aviso de convenio');
  const caso = async (res) => {
    const alertas = [], avisos = [];
    const g = new Function('confirmarConfigAdministrativaV1', 'avisarConfigNoConfirmadaV1', 'alert', 'console', 'return ' + linea.trim() + ';');
    await g(async () => { if (res === 'lanza') throw new Error('x'); return res; }, q => avisos.push(q), m => alertas.push(m), { warn() {} });
    return { alertas, avisos };
  };
  let r = await caso(false); assert.deepEqual(r.alertas, []); assert.deepEqual(r.avisos, ['El convenio']);
  r = await caso(true); assert.match(r.alertas[0], /^Convenio guardado\. Las nuevas/); assert.deepEqual(r.avisos, []);
  r = await caso(null); assert.match(r.alertas[0], /^Convenio guardado\. Las nuevas/, 'modo local / sin sesión');
  r = await caso('lanza'); assert.deepEqual(r.avisos, ['El convenio'], 'una excepción tampoco afirma éxito');
});

prueba('C10 confirmarConfigAdministrativaV1: true sólo si el servidor confirmó; false si no; null cuando no corresponde (sin sesión / médico); cancela el guardado diferido', async () => {
  let c = armarGuardar({ rolCargado: true, admin: true }); assert.strictEqual(await c.confirmar(), true); assert.equal(c.timers.length, 1, 'cancela el temporizador de saveConfig');
  c = armarGuardar({ rolCargado: true, admin: true, upsertError: { message: 'x' } }); assert.strictEqual(await c.confirmar(), false);
  c = armarGuardar({ rolCargado: true, admin: true, viva: 'otro' }); assert.strictEqual(await c.confirmar(), false, 'sesión distinta: no confirmado');
  c = armarGuardar({ rolCargado: false, admin: false }); assert.strictEqual(await c.confirmar(), false, 'rol sin confirmar: no se confirma nada');
  c = armarGuardar({ rolCargado: true, admin: false, modulo: { aplica: true, res: true } }); assert.strictEqual(await c.confirmar(), true);
  c = armarGuardar({ rolCargado: true, admin: false, modulo: { aplica: true, res: false } }); assert.strictEqual(await c.confirmar(), false);
  c = armarGuardar({ rolCargado: true, admin: false, medico: true }); assert.strictEqual(await c.confirmar(), null);
  c = armarGuardar({ rolCargado: true, admin: true, sinUsuario: true }); assert.strictEqual(await c.confirmar(), null);
  c = armarGuardar({ rolCargado: true, admin: true }); c.aviso('El cambio'); assert.match(c.alertas[0], /SOLO en este equipo/);
});

// Ejecuta un tramo REAL de app.js (entre dos marcas) como cuerpo de una función async con dobles; devuelve lo que pasó.
async function correrTramo(desde, hasta, params, valores) {
  const i = APP.indexOf(desde), j = APP.indexOf(hasta, i + 1);
  assert.ok(i >= 0 && j > i, 'no se encontró el tramo: ' + desde);
  const f = new Function(...Object.keys(params), 'return (async()=>{' + APP.slice(i, j + hasta.length) + '})();');
  return f(...Object.keys(params).map(k => valores && k in valores ? valores[k] : params[k]));
}
function dobles(res, extra) {
  const eventos = [];
  const d = Object.assign({
    saveConfig: () => eventos.push('saveConfig'), saveAtenciones: () => {},
    confirmarConfigAdministrativaV1: async () => { eventos.push('confirmar'); if (res === 'lanza') throw new Error('x'); return res; },
    avisarConfigNoConfirmadaV1: q => eventos.push('AVISO:' + q), alert: m => eventos.push('alert:' + m), copyText300: (t) => eventos.push('copy:' + t),
    renderPacientesPanel: () => eventos.push('render'), seleccionarPacientePanel: () => eventos.push('seleccionar'), abrirPacienteGlobalDetalle350: () => eventos.push('detalle'),
    renderTabla: () => {}, renderAgenda: () => {}, renderEstadisticas: () => {}, renderStats: () => {}, cerrarModalPaciente298: () => eventos.push('cerrar'),
    pacienteClave: () => 'k', window: {}, console: { warn() {}, error() {} }, r: { creado: true, paciente: { id: 'p1' } }, p: { id: 'p1' }
  }, extra || {});
  return { d, eventos };
}

prueba('C11 PACIENTES: el modal de alta/edición y la ficha global anuncian éxito sólo con la confirmación; sin ella avisan que quedó SOLO en este equipo', async () => {
  const claves = ['saveConfig', 'confirmarConfigAdministrativaV1', 'avisarConfigNoConfirmadaV1', 'alert', 'renderPacientesPanel', 'seleccionarPacientePanel', 'cerrarModalPaciente298', 'window', 'console', 'r'];
  const modal = async (res) => {
    const { d, eventos } = dobles(res);
    await correrTramo('let okCfg298=null;', "alert(r.creado?'Paciente cargado.':'Ficha del paciente actualizada.');", Object.fromEntries(claves.map(k => [k, d[k]])));
    return eventos;
  };
  assert.ok((await modal(true)).includes('alert:Paciente cargado.'));
  assert.ok((await modal(null)).includes('alert:Paciente cargado.'), 'modo local / médico: comportamiento anterior');
  let ev = await modal(false); assert.ok(ev.includes('AVISO:El paciente') && !ev.some(x => /Paciente cargado/.test(x)), 'no se afirma "Paciente cargado" sin confirmación');
  ev = await modal('lanza'); assert.ok(ev.includes('AVISO:El paciente') && !ev.some(x => /Paciente cargado/.test(x)));
  const ordenado = await modal(false);
  assert.ok(ordenado.indexOf('confirmar') >= 0 && ordenado.indexOf('confirmar') < ordenado.indexOf('render'), 'se confirma antes de mostrarlo como guardado');

  const claves2 = ['saveConfig', 'saveAtenciones', 'confirmarConfigAdministrativaV1', 'avisarConfigNoConfirmadaV1', 'alert', 'copyText300', 'renderPacientesPanel', 'renderTabla', 'renderAgenda',
    'renderEstadisticas', 'renderStats', 'abrirPacienteGlobalDetalle350', 'pacienteClave', 'window', 'console', 'p'];
  const global = async (res) => {
    const { d, eventos } = dobles(res);
    await correrTramo('let okCfg350=null;', "else{ try{copyText300('Ficha guardada','') }catch(e){ alert('Ficha guardada'); } }", Object.fromEntries(claves2.map(k => [k, d[k]])));
    return eventos;
  };
  assert.ok((await global(true)).includes('copy:Ficha guardada'));
  assert.ok((await global(null)).includes('copy:Ficha guardada'));
  ev = await global(false); assert.ok(ev.includes('AVISO:La ficha del paciente') && !ev.includes('copy:Ficha guardada'));
  ev = await global('lanza'); assert.ok(ev.includes('AVISO:La ficha del paciente') && !ev.includes('copy:Ficha guardada'));
});

prueba('C12 PACIENTES (panel) y CALIDAD de datos, CONVENIOS nuevos y ARANCELES: sin confirmación avisan; el panel confirma ANTES de mostrar la ficha como guardada', async () => {
  const panel = async (res) => {
    const { d, eventos } = dobles(res);
    await correrTramo("try{ if(await confirmarConfigAdministrativaV1()===false) avisarConfigNoConfirmadaV1('La ficha del paciente'); }catch(e){ console.warn(e); }", "console.warn(e); }",
      { confirmarConfigAdministrativaV1: d.confirmarConfigAdministrativaV1, avisarConfigNoConfirmadaV1: d.avisarConfigNoConfirmadaV1, console: d.console });
    return eventos;
  };
  assert.deepEqual(await panel(false), ['confirmar', 'AVISO:La ficha del paciente']);
  assert.deepEqual(await panel(true), ['confirmar']); assert.deepEqual(await panel(null), ['confirmar']);
  assert.deepEqual(await panel('lanza'), ['confirmar'], 'una excepción se registra (el aviso persistente del módulo cubre el resto)');
  const fn = APP.slice(APP.indexOf('async function guardarPacientePanel(id){'), APP.indexOf('function nuevaAtencionDesdePaciente'));
  assert.ok(fn.indexOf('await confirmarConfigAdministrativaV1()') > fn.indexOf('saveConfig();') && fn.indexOf('await confirmarConfigAdministrativaV1()') < fn.indexOf('seleccionarPacientePanel(p.id)'));
  // patrones then/catch (convenio nuevo, arancel, baja de arancel, calidad de datos)
  const patrones = [...APP.matchAll(/confirmarConfigAdministrativaV1\(\)\.then\(ok=>\{if\(ok===false\)avisarConfigNoConfirmadaV1\('([^']+)'\);\}\)\.catch\(e=>console\.warn\(e\)\);/g)];
  assert.deepEqual(patrones.map(m => m[1]).sort(), ['El arancel', 'El convenio nuevo', 'La baja del arancel', 'La corrección del paciente']);
  for (const m of patrones) {
    for (const [res, esperado] of [[false, [m[1]]], [true, []], [null, []]]) {
      const avisos = [];
      await new Function('confirmarConfigAdministrativaV1', 'avisarConfigNoConfirmadaV1', 'console', 'return ' + m[0].replace(/;$/, '') + ';')(async () => res, q => avisos.push(q), { warn() {} });
      assert.deepEqual(avisos, esperado, m[1] + ' con ' + res);
    }
  }
});

prueba('C13 TURNOS: la duración por prestación (agenda) avisa si el servidor no confirma; los horarios y las plantillas siguen esperando la confirmación real', async () => {
  const AG = leer('cardiolink-agenda-v1.js');
  const i = AG.indexOf("if (typeof window.confirmarConfigAdministrativaV1 === 'function') {"), j = AG.indexOf('} catch (e) { /* sin confirmación disponible */ }', i);
  assert.ok(i > 0 && j > i);
  const trozo = AG.slice(i, AG.indexOf('\n      }\n', i) + '\n      }\n'.length);
  const caso = async (res, hayFn) => {
    const avisos = [], win = hayFn === false ? {} : { confirmarConfigAdministrativaV1: async () => res, avisarConfigNoConfirmadaV1: q => avisos.push(q) };
    new Function('window', trozo)(win); await tic(); return avisos;
  };
  assert.deepEqual(await caso(false), ['La duración del turno']); assert.deepEqual(await caso(true), []); assert.deepEqual(await caso(null), []);
  assert.deepEqual(await caso(false, false), [], 'sin la función (script viejo en caché) no rompe');
  assert.match(AG, /if \(sincronizado\) \{\s*alert\('Horarios guardados\.'\);/);
  assert.match(leer('cardiolink-pedidos-rapidos-v1.js'), /if \(sincronizado\) \{[\s\S]*?alert\('Plantillas guardadas\.'\);/);
});

prueba('C8 documentos: la emisión se archiva en el servidor ANTES de tocar el estado local (no hay documentos nuevos "sólo locales"); Secretaría los sincroniza desde el archivo', () => {
  const i = APP.indexOf('const r=await window.archivarVersionDocumentoV1(candidato,{baseArchivoId});');
  const j = APP.indexOf('data.documentosClinicos.push(candidato)', i - 400);
  const k = APP.indexOf('candidato.archivoId=r.rowId', i);
  assert.ok(i > 0 && k > i, 'no se encontró el archivado del documento');
  assert.ok(/if\(!r\|\|!r\.ok\)\{[\s\S]*?return;/.test(APP.slice(i, k)), 'ante un fallo del archivo se aborta antes de aplicar al estado local');
  const posPush = APP.indexOf('data.documentosClinicos.push(candidato)', i);
  assert.ok(posPush > k, 'el documento se agrega al estado local recién después de la confirmación del servidor');
  // Secretaría emite estos tipos y los consulta/imprime desde el archivo (cardiolink_patient_documents), no desde la fila de configuración
  assert.match(APP, /return isSecretary406\(\)&&\['constancia_atencion','certificado','reposo_laboral','orden'\]\.includes\(String\(type\|\|''\)\);/);
  assert.match(leer('cardiolink-documentos-pdf-v1.js'), /from\('cardiolink_patient_documents'\)\.select\(c\)\.eq\('patient_id',p\.id\)/);
});

prueba('C9 documentos sin respaldo: con la fila de configuración cerrada o NO consultable ningún documento se descarta; sólo owner/admin confirmado lee la fila heredada', async () => {
  const cuerpo = tramo('const TIPO_ARCHIVO_PDF_POR_DOC_V1=', '// true = es seguro eliminar la caché');
  const f = new Function('data', 'supabaseClient', 'usuarioSupabase', 'esMedicoBackendV1', 'profesionalIdUsuarioActual', 'CONFIG_ROW_ID_DOCS_V1', 'window', 'configCompletaPermitidaV1',
    cuerpo + '\nreturn {documentosSinRespaldoConfirmadoV1,huellaDocCompletaV1};');
  const docA = { id: 'dA', tipo: 'orden', pacienteId: 'pac1', dni: '1', titulo: 't', contenido: 'c', fechaHora: 'f', profesionalId: 'p1', incluirFirma: true };
  const docB = { id: 'dB', tipo: 'constancia_atencion', pacienteId: 'pac1', dni: '1', titulo: 't', contenido: 'c2', fechaHora: 'f', profesionalId: 'p1', incluirFirma: true };
  const data = { pacientes: [{ id: 'pac1', dni: '1' }], documentosClinicos: [docA, docB] };
  const consultasFila = { n: 0 };
  const cliente = filasFila => ({ from: tabla => ({ select: () => ({
    in: async () => ({ data: tabla === 'cardiolink_patient_documents' ? [{ source_document_id: 'dA', source_content_hash: 'HA', document_type: 'Orden', patient_id: 'pac1', pv: '2' }] : [], error: null }),
    eq: () => ({ limit: async () => { consultasFila.n++; return { data: filasFila, error: null }; } }) }) }) });
  const win = { hashContenidoDocumento406: async d => 'H' + d.id.slice(1) };
  // Secretaría / rol sin confirmar: la fila heredada NO se consulta; A está respaldado por el archivo y B queda resguardado (nunca se pierde)
  consultasFila.n = 0;
  const mSec = f(data, cliente([{ d: [docB] }]), { id: 'u' }, () => false, () => 'p1', '__cardiolink_config_v1', win, () => false);
  const sinSec = await mSec.documentosSinRespaldoConfirmadoV1([docA, docB]);
  assert.deepEqual(sinSec.map(d => d.id), ['dB']); assert.equal(consultasFila.n, 0, 'no se lee la fila completa sin owner/admin confirmado');
  // dueño/admin confirmado: la copia idéntica en la fila heredada confirma a B
  consultasFila.n = 0;
  let m = f(data, cliente([{ d: [docB] }]), { id: 'u' }, () => false, () => 'p1', '__cardiolink_config_v1', win, () => true);
  let sin = await m.documentosSinRespaldoConfirmadoV1([docA, docB]);
  assert.deepEqual(sin.map(d => d.id), [], 'dueño/admin: ambos confirmados'); assert.equal(consultasFila.n, 1);
  // dueño/admin con la fila cerrada (0 filas): B queda resguardado
  m = f(data, cliente([]), { id: 'u' }, () => false, () => 'p1', '__cardiolink_config_v1', win, () => true);
  assert.deepEqual((await m.documentosSinRespaldoConfirmadoV1([docA, docB])).map(d => d.id), ['dB']);
  // error del servidor: lanza (el llamador conserva TODO)
  const roto = { from: () => ({ select: () => ({ in: async () => ({ data: null, error: { message: 'x' } }) }) }) };
  m = f(data, roto, { id: 'u' }, () => false, () => 'p1', '__cardiolink_config_v1', win, () => true);
  let lanzo = false; try { await m.documentosSinRespaldoConfirmadoV1([docA]); } catch (e) { lanzo = true; }
  assert.equal(lanzo, true, 'si no se puede consultar al servidor no se descarta nada');
});

// ---------------------------------------------------------------- v3.2: documentos heredados, flujos visibles de Coberturas y valores, etiqueta del rol
// Extrae una función completa de app.js por nombre (conteo de llaves, ignorando el contenido de cadenas).
function funcionApp(nombre, asincrona) {
  const cab = (asincrona ? 'async function ' : 'function ') + nombre + '(';
  const i = APP.indexOf(cab); assert.ok(i >= 0, 'no se encontró ' + cab);
  let k = APP.indexOf('{', APP.indexOf(')', i)), prof = 0, q = null;
  for (; k < APP.length; k++) {
    const c = APP[k];
    if (q) { if (c === '\\') k++; else if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; continue; }
    if (c === '{') prof++; else if (c === '}') { prof--; if (prof === 0) return APP.slice(i, k + 1); }
  }
  throw new Error('llaves desbalanceadas en ' + nombre);
}
function correrFuncion(codigo, nombre, params, args) {
  return new Function(...Object.keys(params), codigo + '\nreturn ' + nombre + ';')(...Object.values(params))(...(args || []));
}

prueba('C14 DOCUMENTOS HEREDADOS: Secretaría no los recibe en la sesión (ni en la memoria ni en la caché de configuración) y el resguardo se conserva intacto', async () => {
  const codigo = ['documentoRestaurableV1', 'apartarDocumentosNoPermitidosV1', 'recuperarDocumentosPendientesV1', 'leerOutboxDocsV1', 'unirDocsPorIdV1'].map(n => funcionApp(n)).join('\n')
    + '\n' + APP.match(/const TIPOS_DOC_SECRETARIA_V1=\[[^\]]*\];/)[0] + '\n' + APP.match(/const OUTBOX_DOCS_KEY_V1='[^']*';/)[0];
  const doc = (id, tipo) => ({ id, tipo, titulo: 't' + id, contenido: 'CLINICO-' + id, pacienteId: 'p1' });
  const LEGADOS = [doc('d1', 'receta'), doc('d2', 'ecg'), doc('d3', 'informe')], CONSTANCIA = doc('c1', 'constancia_atencion');   // Bloque 4C-1b: certificado, orden y reposo_laboral YA se restauran (ver más abajo)
  function entorno(o) {
    const almacen = Object.assign({}, o.almacen || {}), uid = 'uid-1';
    const g = { data: { documentosClinicos: (o.enMemoria || []).slice() }, usuarioSupabase: { id: uid }, storageConfig: 'cfg',
      backendRolCargado: o.rol !== false, backendEsAdminOwner: !!o.admin, backendTieneAccesoTurnos: o.turnos !== false, esMedicoBackendV1: () => !!o.medico,
      configCompletaPermitidaV1: () => o.rol !== false && !!o.admin && !o.medico, console: { warn() {} },
      localStorage: { getItem: k => (k in almacen ? almacen[k] : null), removeItem: k => { delete almacen[k]; },
        setItem: (k, v) => { if (o.falloOutbox && /pendientes/.test(k)) throw new Error('cuota'); almacen[k] = v; } } };
    const f = new Function(...Object.keys(g), codigo + '\nreturn {documentoRestaurableV1, apartar: apartarDocumentosNoPermitidosV1, recuperar: recuperarDocumentosPendientesV1};')(...Object.values(g));
    return { f, g, almacen, outbox: () => (JSON.parse(almacen['cardiolink_docs_pendientes_v1_' + uid] || '{"docs":[]}').docs || []).map(d => d.id).sort() };
  }
  const outboxInicial = { 'cardiolink_docs_pendientes_v1_uid-1': JSON.stringify({ docs: LEGADOS.concat([CONSTANCIA]), fecha: 'x' }) };
  // Secretaría confirmada: se restaura sólo la constancia; los 3 clínicos heredados NO vuelven y siguen resguardados
  let e = entorno({ almacen: outboxInicial });
  assert.equal(e.f.recuperar(), 1);
  assert.deepEqual(e.g.data.documentosClinicos.map(d => d.id), ['c1']);
  assert.deepEqual(e.outbox(), ['c1', 'd1', 'd2', 'd3'], 'el resguardo queda intacto');
  assert.ok(!(e.almacen.cfg || '').includes('CLINICO-d'), 'la caché de configuración no recibe los clínicos heredados');
  assert.equal(e.f.recuperar(), 0, 'idempotente');
  // Bloque 4C-1b: los certificados, órdenes y reposos laborales heredados SÍ se restauran para Secretaría (la fila completa sigue cerrada)
  const PERMITIDOS = [doc('p1', 'certificado'), doc('p2', 'orden'), doc('p3', 'reposo_laboral'), CONSTANCIA];
  e = entorno({ almacen: { 'cardiolink_docs_pendientes_v1_uid-1': JSON.stringify({ docs: PERMITIDOS, fecha: 'x' }) } });
  assert.equal(e.f.recuperar(), 4); assert.deepEqual(e.g.data.documentosClinicos.map(d => d.id).sort(), ['c1', 'p1', 'p2', 'p3']);
  e = entorno({ enMemoria: PERMITIDOS.slice() }); assert.equal(e.f.apartar(), 0, 'los tipos permitidos no se apartan');
  // lo que ya estaba en memoria/caché (cliente viejo): primero se asegura el respaldo y recién después se aparta
  e = entorno({ enMemoria: LEGADOS.concat([CONSTANCIA]), almacen: { cardiolink_docs_pendientes_v1_dummy: '{}' } });
  assert.equal(e.f.apartar(), 3);
  assert.deepEqual(e.g.data.documentosClinicos.map(d => d.id), ['c1']);
  assert.deepEqual(e.outbox(), ['d1', 'd2', 'd3'], 'los apartados quedaron en el resguardo ANTES de salir de la memoria');
  assert.ok(!(e.almacen.cfg || '').includes('CLINICO-d'));
  // si el respaldo no se puede escribir, NO se quita nada de la memoria (no se pierde nada)
  e = entorno({ enMemoria: LEGADOS.slice(), falloOutbox: true });
  assert.equal(e.f.apartar(), 0); assert.equal(e.g.data.documentosClinicos.length, 3);
  // se suma al resguardo existente sin pisarlo
  e = entorno({ enMemoria: [doc('d9', 'receta')], almacen: { 'cardiolink_docs_pendientes_v1_uid-1': JSON.stringify({ docs: [LEGADOS[0]], fecha: 'x' }) } });
  assert.equal(e.f.apartar(), 1); assert.deepEqual(e.outbox(), ['d1', 'd9']);
  // owner/admin confirmado: recupera todo; médico confirmado: como antes; rol SIN confirmar: nada (queda resguardado hasta confirmarse)
  e = entorno({ almacen: outboxInicial, admin: true }); assert.equal(e.f.recuperar(), 4); assert.equal(e.f.apartar(), 0);
  e = entorno({ almacen: outboxInicial, medico: true, turnos: false }); assert.equal(e.f.recuperar(), 4); assert.equal(e.f.apartar(), 0);
  e = entorno({ almacen: outboxInicial, rol: false }); assert.equal(e.f.recuperar(), 0); assert.equal(e.f.apartar(), 0); assert.deepEqual(e.outbox(), ['c1', 'd1', 'd2', 'd3']);
  // el cargador llama a apartar ANTES de recuperar
  const cierre = APP.slice(APP.indexOf('try{ apartarDocumentosNoPermitidosV1(); }'), APP.indexOf('try{ recuperarDocumentosPendientesV1(); }') + 40);
  assert.ok(cierre.indexOf('apartarDocumentosNoPermitidosV1') < cierre.indexOf('recuperarDocumentosPendientesV1'));
  // el cierre de sesión sigue conservando el resguardo (la protección no se tocó)
  assert.match(APP, /const k=OUTBOX_DOCS_KEY_V1\+uid, todos=unirDocsPorIdV1\(leerOutboxDocsV1\(uid\),locales\);/);
});

prueba('C15 FLUJOS VISIBLES (Coberturas y valores): obra social, valores, regla, convenio, convenio nuevo y arancel afirman éxito sólo con la confirmación; sin ella avisan y no dicen "guardado"', async () => {
  const persistir = funcionApp('persistirConfigVisibleV1', true);
  // persistirConfigVisibleV1 en sí
  const unit = async (conf) => { const av = [], ev = []; const r = await correrFuncion(persistir, 'persistirConfigVisibleV1', { saveConfig: () => ev.push('save'), window: { confirmarConfigAdministrativaV1: async () => { if (conf === 'lanza') throw new Error('x'); return conf; }, avisarConfigNoConfirmadaV1: q => av.push(q) }, console: { warn() {} } }, ['X']); return { r, av, ev }; };
  assert.deepEqual(await unit(true), { r: true, av: [], ev: ['save'] }); assert.deepEqual((await unit(false)).av, ['X']); assert.equal((await unit(null)).r, null);
  assert.deepEqual((await unit('lanza')).av, ['X'], 'una excepción tampoco afirma éxito');
  // escenario de cada flujo: el servidor confirma (true), no confirma (false) o no corresponde (null)
  const montar = (conf) => {
    const ev = [];
    const persistirFalso = async que => { ev.push('persistir:' + que); await Promise.resolve(); await Promise.resolve(); ev.push('persistido'); return conf; };
    return { ev, persistirFalso };
  };
  const casos = [
    ['addOS', true, async (conf, ev, pf) => { const g = { exigirConfigComercial: () => true, $: id => ({ value: 'OS QA ' }), data: { obrasSociales: [] }, persistirConfigVisibleV1: pf, refreshSelects: () => ev.push('refresh'), renderConfig: () => ev.push('render'), alert: m => ev.push('alert:' + m) }; await correrFuncion(funcionApp('addOS', true), 'addOS', g); return g.data.obrasSociales; }],
    ['delOS', true, async (conf, ev, pf) => { const g = { exigirConfigComercial: () => true, confirm: () => true, data: { obrasSociales: ['A', 'B'] }, persistirConfigVisibleV1: pf, refreshSelects: () => ev.push('refresh'), renderConfig: () => ev.push('render'), alert: m => ev.push('alert:' + m) }; await correrFuncion(funcionApp('delOS', true), 'delOS', g, ['A']); return g.data.obrasSociales; }],
    ['guardarValores', true, async (conf, ev, pf) => { const prof = { id: 'p', valores: {} }; const g = { exigirConfigComercial: () => true, $: id => ({ value: id === 'cfgProfesionalValores' ? 'p' : '5' }), data: { profesionales: [prof] }, persistirConfigVisibleV1: pf, alert: m => ev.push('alert:' + m), aplicarRegla: () => ev.push('aplicar'), renderStats: () => ev.push('stats') }; await correrFuncion(funcionApp('guardarValores', true), 'guardarValores', g); return prof.valores; }],
    ['guardarReglaConfig', true, async (conf, ev, pf) => { const g = { exigirConfigComercial: () => true, $: id => ({ value: 'v' }), setRegla: () => ev.push('setRegla'), persistirConfigVisibleV1: pf, alert: m => ev.push('alert:' + m), aplicarRegla: () => ev.push('aplicar') }; await correrFuncion(funcionApp('guardarReglaConfig', true), 'guardarReglaConfig', g); return null; }]
  ];
  for (const [nombre, , correr] of casos) {
    for (const conf of [true, false, null]) {
      const { ev, persistirFalso } = montar(conf); await correr(conf, ev, persistirFalso);
      const exito = ev.filter(x => /^alert:/.test(x)).length;
      if (conf === false) assert.equal(exito, 0, nombre + ': no se debe afirmar "guardado" sin confirmación');
      else if (nombre === 'guardarValores' || nombre === 'guardarReglaConfig') assert.equal(exito, 1, nombre + ': con confirmación (o modo local) se afirma el éxito');
      assert.ok(ev.some(x => /^persistir:/.test(x)), nombre + ' espera la persistencia');
      if (nombre === 'addOS' || nombre === 'delOS') assert.ok(ev.indexOf('refresh') > ev.indexOf('persistido'), nombre + ' refresca DESPUÉS de que el servidor respondió');
    }
  }
  // convenio / arancel de la tarjeta "Convenios y aranceles por profesional" (código real con dobles)
  const dobles402 = (conf) => {
    const ev = []; const els = {}; const el = id => (els[id] = els[id] || { value: ({ billOS402: 'OS Q', billValor402: '10', billCopago402: '0', billVigencia402: '2026-01-01' })[id] || 'x', checked: true });
    return { ev, g: { exigirConfigComercial: () => true, selectedBillProf402: () => 'rogelio', $402: el, conv402: () => ({}), data: { arancelesPorProfesional: { rogelio: [] }, conveniosPorProfesional: {}, obrasSociales: [] },
      copy402: x => x, persistirConfigVisibleV1: async q => { ev.push('persistir:' + q); await Promise.resolve(); await Promise.resolve(); ev.push('persistido'); return conf; }, programarSyncSupabase: () => ev.push('sync'), renderBilling402: () => ev.push('render'), loadBillConv402: () => {},
      profName402: () => 'Dr. X', alert: m => ev.push('alert:' + m), prompt: () => 'OS NUEVA', Date, Math, Number } };
  };
  for (const conf of [true, false, null]) {
    let d = dobles402(conf); await correrFuncion(funcionApp('saveBillConv402', true), 'saveBillConv402', d.g);
    assert.ok(d.ev.includes('persistir:El convenio')); assert.equal(d.ev.filter(x => /^alert:Convenio guardado/.test(x)).length, conf === false ? 0 : 1, 'convenio: ' + conf);
    assert.ok(d.ev.indexOf('render') > d.ev.indexOf('persistido'));
    d = dobles402(conf); await correrFuncion(funcionApp('newGlobalConv402', true), 'newGlobalConv402', d.g);
    assert.ok(d.ev.includes('persistir:El convenio nuevo') && d.ev.indexOf('render') > d.ev.indexOf('persistido'));
    d = dobles402(conf); await correrFuncion(funcionApp('saveBillArancel402', true), 'saveBillArancel402', d.g);
    assert.ok(d.ev.includes('persistir:El arancel') && d.ev.indexOf('render') > d.ev.indexOf('persistido'), 'arancel: se muestra recién después de la respuesta del servidor');
  }
  // baja de arancel y exclusión: persist402 (sin confirmación) ya no se usa en convenios/aranceles
  assert.match(APP, /persistirConfigVisibleV1\('La baja del arancel'\)\.then\(/);
  ['saveBillConv402', 'newGlobalConv402', 'saveBillArancel402'].forEach(n => assert.ok(!/persist402\(\)/.test(funcionApp(n, true)), n + ' no debe usar persist402'));
});

prueba('C16 ETIQUETA DEL ROL: Secretaría confirmada por el backend se muestra y audita como Secretaría aunque el alias del login coincida con otro usuario; el resto de los roles no cambia', () => {
  const nombres = ['normalizarUsuarioTexto', 'normalizarUsuarioClave', 'usuarioCoincide', 'inferirUsuarioPorLogin', 'rolLocalPerfilV1', 'identidadBackendOwnerAdminV1', 'normalizarProfesionalIdV1', 'perfilUsuarioActual', 'labelRol'];
  const codigo = nombres.map(n => funcionApp(n)).join('\n');
  const usuarios = () => [{ id: 'matias', usuario: 'matias', rol: 'duenio', nombre: 'Dr. Matías Anchorena', activo: true, profesionalId: 'matias' },
    { id: 'geraldine', usuario: 'geraldine', aliases: ['geral'], rol: 'secretaria', nombre: 'Geraldine', activo: true },
    { id: 'secretaria', usuario: 'secretaria', rol: 'secretaria', nombre: 'Secretaría', activo: true }];
  const perfil = o => {
    const g = { data: { usuarios: usuarios(), roles: [] }, usuarioSupabase: { id: 'u', email: o.email }, usuarioActualNombreCorto: () => o.email.split('@')[0], asegurarUsuariosConfig: () => {},
      backendRolCargado: o.rol !== false, backendEsAdminOwner: !!o.admin, backendTieneAccesoTurnos: !!o.turnos, esMedicoBackendV1: () => !!o.medico,
      backendPendientesIdentidadV1: o.ident || null, normalizarProfesionalIdV1: undefined, nombreVisibleBackendV1: () => '', nombreProfesionalPorIdV1: () => '', backendMensajeriaV1: null,
      usuarioPerfilActual: null };
    delete g.normalizarProfesionalIdV1;
    return new Function(...Object.keys(g), codigo + '\nreturn {u: perfilUsuarioActual(), etiqueta: labelRol};')(...Object.values(g));
  };
  // la cuenta de Secretaría cuyo login contiene "matias.anchorena" caía en el perfil del dueño
  let r = perfil({ email: 'matias.anchorena.sec@example.com', turnos: true });
  assert.equal(r.u.rol, 'secretaria'); assert.equal(r.etiqueta(r.u.rol), 'Secretaría'); assert.notEqual(r.u.id, 'matias');
  // login que coincide con una Secretaría configurada: se usa ese usuario
  r = perfil({ email: 'geraldine@example.com', turnos: true }); assert.equal(r.u.id, 'geraldine');
  // login desconocido con Secretaría confirmada: perfil de Secretaría (no "sin configurar")
  r = perfil({ email: 'cuenta.rara@example.com', turnos: true }); assert.equal(r.u.rol, 'secretaria');
  // el cambio NO concede nada ni afecta a otros roles: owner confirmado sigue siendo dueño; rol sin confirmar y médico sin cambios
  r = perfil({ email: 'matias@example.com', admin: true, turnos: true, ident: { role: 'owner', professional_id: 'matias' } }); assert.equal(r.u.rol, 'duenio');
  r = perfil({ email: 'matias.anchorena.sec@example.com', rol: false }); assert.equal(r.u.rol, 'duenio', 'sin rol confirmado no se modifica el comportamiento (los permisos salen de rolBaseUsuarioActual, fail-closed)');
  assert.match(APP, /usuarioSupabase&&backendRolCargado===true&&!backendEsAdminOwner&&!esMedicoBackendV1\(\)&&backendTieneAccesoTurnos===true&&\(!u\|\|rolLocalPerfilV1\(u\)!=='secretaria'\)/);
});

// ---------------------------------------------------------------- D) revisión estática de los SQL
const sinComentarios = t => t.replace(/--[^\n]*/g, '');

prueba('D1 etapa A: aditiva (sin políticas, sin DML sobre tablas, sin DROP) y con precondiciones/privilegios', () => {
  const s = sinComentarios(SQL_A);
  assert.ok(!/\bCREATE POLICY\b|\bDROP POLICY\b|\bALTER TABLE\b|\bDROP FUNCTION\b|\bTRUNCATE\b|\bDELETE FROM\b|\bINSERT INTO\b/i.test(s));
  assert.equal((s.match(/\bUPDATE public\.cardiolink_atenciones\b/g) || []).length, 1, 'un único UPDATE (dentro de la RPC de escritura)');
  assert.match(s, /FOR UPDATE/);
  assert.equal((s.match(/LANGUAGE plpgsql\s+(?:STABLE|VOLATILE)\s+SECURITY DEFINER/g) || []).length, 2, 'sólo las 2 RPC son SECURITY DEFINER');
  assert.match(s, /REVOKE ALL ON FUNCTION public\.cardiolink_config_administrativa_v1\(\)\s+FROM PUBLIC, anon;/);
  assert.match(s, /GRANT EXECUTE ON FUNCTION public\.cardiolink_guardar_config_administrativa_v1\(jsonb,text,text,uuid\)\s+TO authenticated;/);
  assert.match(s, /base_role = 'secretaria'/);
  assert.equal((s.match(/CREATE FUNCTION/g) || []).length, 15);
  assert.match(SQL_A, /^BEGIN;/m); assert.match(SQL_A, /COMMIT;\s*$/);
});

prueba('D2 etapa A: validaciones de la escritura (null, tipo, vaciado, ids, identidad, historia clínica) y conflicto; la fusión parte del elemento existente', () => {
  ['no puede ser null', 'cambia de tipo', 'vaciado accidental', 'objetos con id', 'ids duplicados', 'identidad documental cargada', 'historia clínica asociada'].forEach(t => assert.ok(SQL_A.includes(t), 'falta: ' + t));
  assert.match(SQL_A, /FOREACH k IN ARRAY public\.cardiolink_config_claves_escritura_sec_v1\(\)/);
  assert.match(SQL_A, /conflict', true/);
  assert.match(SQL_A, /coalesce\(o\.p, '\{\}'::jsonb\)\s*\|\| coalesce\(\(SELECT jsonb_object_agg\(k, n\.p -> k\) FROM unnest\(c_campos\)/);
});

prueba('D3 etapa B: sólo cambia el predicado y agrega una política RESTRICTIVA por id; no toca datos', () => {
  const s = sinComentarios(SQL_B);
  assert.ok(!/\bINSERT INTO\b|\bDELETE FROM\b|\bTRUNCATE\b|\bDROP POLICY\b/i.test(s.replace(/DO \$\$[\s\S]*?\$\$;/g, '')));
  assert.match(s, /CREATE POLICY cardiolink_atenciones_config_solo_admin_v1[\s\S]*AS RESTRICTIVE FOR ALL TO authenticated/);
  assert.match(s, /WHEN p_rol = 'secretaria' THEN coalesce\(p_payload->>'tipoRegistro',''\) <> 'config'/);
  assert.match(s, /WHEN p_rol IN \('owner','admin'\) THEN true/);
});

prueba('D4 el rollback de B restaura EXACTAMENTE el cuerpo previo del predicado (el que exige la precondición de B)', () => {
  const norm = t => t.replace(/\s+/g, '');
  assert.equal(norm(SQL_B_RB.match(/AS \$f\$([\s\S]*?)\$f\$/)[1]), norm(SQL_B.match(/\$e\$([\s\S]*?)\$e\$/)[1]));
});

prueba('D5 rollback de A: sólo DROP de las 15 funciones, aborta si B sigue aplicada', () => {
  const s = sinComentarios(SQL_A_RB);
  assert.equal((s.match(/DROP FUNCTION IF EXISTS/g) || []).length, 15);
  assert.match(s, /RAISE EXCEPTION 'Abortado: la ETAPA B sigue aplicada/);
  assert.ok(!/\bDELETE\b|\bUPDATE\b|\bINSERT\b|\bTRUNCATE\b/i.test(s));
});

prueba('D6 tests SQL: transaccionales (ROLLBACK) y cubren Secretaría/owner/médico, anidados, documentos, historia clínica, conflicto y preservación', () => {
  assert.match(SQL_TESTS, /^BEGIN;/m); assert.match(SQL_TESTS, /^ROLLBACK;/m); assert.ok(!/^COMMIT;/m.test(SQL_TESTS));
  ['2.1', '2.2', '2.3', '2.4', '2.5', '2.6', '2.7', '2.8', '2.9', '2.10', 'FALLA 3.1', 'FALLA 4.1', 'FALLA 2.4d', 'FALLA 2.4e', 'FALLA 2.4g', 'FALLA 2.5c', 'FALLA 2.5i', 'FALLA 2.5j3',
   'FALLA 2.6a', 'FALLA 2.6d', 'FALLA 2.8a', 'FALLA 2.9b'].forEach(t => assert.ok(SQL_TESTS.includes(t), 'falta ' + t));
});

prueba('D7 SQL v3.1: p_uid_esperado OBLIGATORIO (sin DEFAULT; NULL rechazado; debe coincidir con auth.uid() antes del chequeo de rol), fixture relacional obligatorio y prueba de cambio de sesión', () => {
  const a = sinComentarios(SQL_A);
  assert.match(a, /p_base_hash text, p_uid_esperado uuid\)\s+RETURNS jsonb/);
  assert.ok(!/p_uid_esperado uuid\s+DEFAULT/i.test(a), 'p_uid_esperado no debe tener DEFAULT');
  const iNull = a.indexOf('IF p_uid_esperado IS NULL THEN'), iDist = a.indexOf('IF auth.uid() IS NULL OR p_uid_esperado IS DISTINCT FROM auth.uid() THEN'),
    iRol = a.indexOf("base_role = 'secretaria') THEN\n    RAISE EXCEPTION 'Sin permiso para guardar");
  assert.ok(iNull > 0 && iDist > iNull && iRol > iDist, 'orden: NULL → coincidencia con auth.uid() → rol');
  assert.match(a, /HINT = 'UID_ESPERADO_OBLIGATORIO'/); assert.match(a, /HINT = 'SESION_DISTINTA'/);
  assert.match(a, /prong?argdefaults|pronargdefaults\s*FROM pg_proc WHERE oid = 'public\.cardiolink_guardar_config_administrativa_v1\(jsonb,text,text,uuid\)'::regprocedure\) <> 0/);
  assert.match(MOD, /p_uid_esperado: u/);
  const t = SQL_TESTS;
  // TODAS las llamadas de los tests SQL pasan 4 argumentos, salvo la prueba deliberada del parámetro omitido (2.11b, exactamente una)
  const llamadas = []; let pos = 0; const nombre = 'cardiolink_guardar_config_administrativa_v1(';
  while ((pos = t.indexOf(nombre, pos)) >= 0) {
    let k = pos + nombre.length, prof = 1, q = false, comas = 0;
    for (; prof > 0; k++) { const c = t[k]; if (q) { if (c === "'") { if (t[k + 1] === "'") k++; else q = false; } } else if (c === "'") q = true; else if (c === '(') prof++; else if (c === ')') prof--; else if (c === ',' && prof === 1) comas++; }
    const args = t.slice(pos + nombre.length, k - 1);
    if (!/^jsonb,text,text,uuid$/.test(args.trim())) llamadas.push({ comas, args: args.trim().slice(0, 60) });
    pos = k;
  }
  assert.ok(llamadas.length >= 25, 'se esperaban muchas llamadas en los tests SQL: ' + llamadas.length);
  const con3 = llamadas.filter(l => l.comas === 2), otras = llamadas.filter(l => l.comas !== 2 && l.comas !== 3);
  assert.equal(otras.length, 0, 'llamadas con una cantidad inesperada de argumentos');
  assert.equal(con3.length, 1, 'sólo la prueba deliberada del parámetro omitido puede llamar con 3 argumentos: ' + JSON.stringify(con3));
  assert.match(t, /EXCEPTION WHEN undefined_function THEN NULL/);
  ['FALLA 2.11a', 'FALLA 2.11b', 'FALLA 2.11c', 'FALLA 2.11d', 'FALLA 2.11d2', 'FALLA 2.11e', 'FALLA 2.11f', 'NULL::uuid', 'gen_random_uuid()', 'UID_ESPERADO_OBLIGATORIO'].forEach(x => assert.ok(t.includes(x), 'falta ' + x));
  // el fixture se crea de verdad en las tres tablas y el script aborta si no puede (no hay captura de error que lo convierta en "OK")
  assert.match(t, /INSERT INTO public\.cardiolink_hc_evoluciones\(id, paciente_id\) VALUES \('qa_rel_evo_e1', 'qa_rel_evo'\)/);
  assert.match(t, /INSERT INTO public\.cardiolink_hc_resumen\(paciente_id\) VALUES \('qa_rel_res'\)/);
  assert.match(t, /INSERT INTO public\.cardiolink_pacientes\(%s\) VALUES \(%s\)/);
  assert.match(t, /RAISE EXCEPTION 'Fixture 2\.8e: no quedó creado el fixture relacional'/);
  assert.ok(!/OMITIDA|omitida|INSERT INTO t_rel|CREATE TEMP TABLE t_rel/.test(t), 'no debe existir ninguna rama que omita la prueba de historia clínica relacional');
  assert.ok(!/EXCEPTION WHEN others THEN\s*INSERT INTO t_res/.test(t), 'ninguna excepción genérica se registra como resultado');
  ['FALLA 2.8e0', 'FALLA 2.8e2', 'FALLA 2.8e3', 'FALLA 2.8e4', 'FALLA 2.8e5', 'FALLA 2.8f', "LIKE '%historia clínica asociada%'"].forEach(x => assert.ok(t.includes(x), 'falta ' + x));
  ['FALLA 2.10a', 'FALLA 2.10b', 'FALLA 2.10c', 'FALLA 2.10d', 'FALLA 2.10e', 'SESION_DISTINTA'].forEach(x => assert.ok(t.includes(x), 'falta ' + x));
  assert.ok(!/^COMMIT;/m.test(t)); assert.match(t, /^ROLLBACK;/m); assert.match(t, /qa\\_rel\\_%/);
});

prueba('D8 ENSAYO REVERSIBLE: una sola transacción, instala A y B sin sus COMMIT, corre el QA completo, termina en ROLLBACK y verifica que no quede nada; está sincronizado con los SQL de origen', () => {
  const E = leer('docs/propuestas/pending_review_config_secretaria_v1_ensayo_reversible.sql');
  const GEN = leer('docs/propuestas/pending_review_config_secretaria_v1_generar_ensayo.sh');
  const lineas = E.split('\n');
  const cuenta = re => lineas.filter(l => re.test(l)).length;
  // estructura transaccional
  assert.equal(cuenta(/^BEGIN;$/), 1, 'exactamente un BEGIN'); assert.equal(cuenta(/^ROLLBACK;$/), 1, 'exactamente un ROLLBACK'); assert.equal(cuenta(/^COMMIT;$/), 0, 'ningún COMMIT');
  assert.ok(!/\bCOMMIT\b/i.test(sinComentarios(E).replace(/'[^']*'/g, '')), 'no debe haber COMMIT ni siquiera dentro de bloques');
  assert.ok(!/\bSAVEPOINT\b|\bRELEASE\b/i.test(sinComentarios(E)), 'sin savepoints');
  const iBegin = E.indexOf('\nBEGIN;\n'), iRollback = E.indexOf('\nROLLBACK;\n'), iVeredicto = E.indexOf('AS veredicto');
  assert.ok(iBegin > 0 && iRollback > iBegin && iVeredicto > iRollback, 'orden: BEGIN → ... → ROLLBACK → verificación');
  // contenido: A, B y tests (secciones 0–4) VERBATIM, en ese orden, entre el BEGIN y el ROLLBACK, sin sus BEGIN/COMMIT/cierre
  const sinTx = txt => txt.split('\n').filter(l => !/^(BEGIN|COMMIT);$/.test(l)).join('\n');
  const dentro = E.slice(iBegin, iRollback);
  const a = sinTx(SQL_A), b = sinTx(SQL_B), q = sinTx(SQL_TESTS.slice(0, SQL_TESTS.indexOf('-- ===== 5) Resultado y ROLLBACK =====')));
  const pa = dentro.indexOf(a), pb = dentro.indexOf(b), pq = dentro.indexOf(q);
  assert.ok(pa >= 0 && pb > pa && pq > pb, 'A, B y el QA deben estar completos y en orden A → B → QA');
  assert.ok(!dentro.includes('\nCOMMIT;'));
  // el QA incluido es el de siempre (nada omitido) y todas sus pruebas registran resultado
  const nPruebas = (SQL_TESTS.match(/INSERT INTO t_res/g) || []).length;
  assert.equal((q.match(/INSERT INTO t_res/g) || []).length, nPruebas);
  assert.match(E, new RegExp('ENSAYO OK: las ' + nPruebas + ' pruebas terminaron sin error'));
  assert.ok(E.includes('-- se esperan ' + nPruebas + ' filas'));
  // guarda previa: no corre si A o B ya están aplicadas, y está ANTES del BEGIN
  assert.ok(E.indexOf('El ensayo requiere las etapas A y B SIN aplicar') > 0 && E.indexOf('El ensayo requiere las etapas A y B SIN aplicar') < iBegin);
  // verificación posterior: sin dependencias creadas antes de la transacción y con todas las comprobaciones
  const v = E.slice(iRollback);
  assert.ok(!/CREATE TEMP|ensayo_previo|ensayo_ok_seq/i.test(sinComentarios(E.slice(0, iBegin) + v)), 'ni antes del BEGIN ni en la verificación hay objetos auxiliares (el cliente puede enviar todo en una sola transacción)');
  ['funciones_del_bloque_restantes', 'politica_restrictiva_restante', 'predicado_igual_al_previo', 'fila_config_sin_marcas_del_fixture', 'atenciones_sinteticas_restantes',
   'pacientes_sinteticos_restantes', 'evoluciones_sinteticas_restantes', 'resumenes_sinteticos_restantes'].forEach(c => assert.ok(v.includes(c), 'falta la comprobación ' + c));
  const funciones = [...sinComentarios(SQL_A_RB).matchAll(/DROP FUNCTION IF EXISTS public\.([a-z0-9_]+)\(/g)].map(m => m[1]);
  assert.equal(funciones.length, 15);
  funciones.forEach(f => assert.ok(v.includes("'" + f + "'"), 'la verificación no revisa la función ' + f));
  // el cuerpo previo del predicado de la verificación es el que exige la etapa B
  const previoB = SQL_B.match(/regexp_replace\(\$e\$([\s\S]*?)\$e\$/)[1].replace(/\s+/g, ''), previoE = v.match(/regexp_replace\(\$ens\$([\s\S]*?)\$ens\$/)[1].replace(/\s+/g, '');
  assert.equal(previoE, previoB);
  // no ejecuta nada fuera de lo declarado: ningún DML sobre tablas reales fuera del QA/fixture, y nada tras el ROLLBACK que escriba
  assert.ok(!/\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|GRANT|REVOKE|TRUNCATE)\b/i.test(sinComentarios(v).replace(/'[^']*'/g, '').replace(/\$ens\$[\s\S]*?\$ens\$/g, '')), 'tras el ROLLBACK sólo hay lecturas');
  // sincronía con el generador: el ensayo se regenera con el script y éste sólo concatena
  assert.match(GEN, /set -eu/); assert.ok(!/psql|supabase|curl|wget/i.test(sinComentarios(GEN.replace(/^#.*$/gm, ''))), 'el generador no se conecta a ninguna base');
});

// ---------------------------------------------------------------- ejecución
(async () => {
  let fallas = 0;
  for (const p of pruebas) {
    try { await p.fn(); console.log('PASS  ' + p.nombre); }
    catch (e) { fallas++; console.log('FAIL  ' + p.nombre + '\n      ' + (e && e.message || e)); }
  }
  console.log('\n' + (pruebas.length - fallas) + '/' + pruebas.length + ' pruebas OK');
  if (fallas) process.exitCode = 1;
})();
