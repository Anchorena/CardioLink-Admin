// Pruebas de contrato (estáticas) de las guardas de sincronización clínica en app.js.
// No reemplazan el QA funcional con navegador autenticado: sólo evitan que una
// edición futura quite sin querer una guarda crítica. Ejecutar: node --test
const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs');
const path=require('node:path');
const src=fs.readFileSync(path.join(__dirname,'app.js'),'utf8');
const between=(from,to)=>{const i=src.indexOf(from);assert.notEqual(i,-1,'no se encontró: '+from);const j=src.indexOf(to,i+from.length);assert.notEqual(j,-1,'no se encontró fin: '+to);return src.slice(i,j);};

test('helper fail-closed: sólo owner/admin o secretaría confirmados por backend',()=>{
  const m=src.match(/function sincronizacionMasivaPermitidaV1\(\)\{([^}]*)\}/);
  assert.ok(m,'falta sincronizacionMasivaPermitidaV1');
  assert.match(m[1],/backendEsAdminOwner===true/);
  assert.match(m[1],/backendTieneAccesoTurnos===true/);
  assert.doesNotMatch(m[1],/medico/);
});

test('la RPC de identidad está aislada: su falla no invalida owner/admin/secretaría',()=>{
  const f=between('async function cargarPermisoBackendRoles(){','finally{');
  assert.match(f,/rpc\('cardiolink_identidad_pendientes_v1'\)\.then\(/);
  const lanza=f.match(/if\(adminOwner\.error\|\|appointmentRequests\.error[^\n]*throw[^\n]*/);
  assert.ok(lanza,'falta el throw de las RPC de rol');
  assert.doesNotMatch(lanza[0],/pendientesIdentidad/);
});

test('ambas rutas de carga bloquean la siembra desde caché local antes del bootstrap',()=>{
  const a=between('async function cargarAtencionesDesdeSupabase() {','function programarSyncSupabase');
  assert.ok(a.indexOf('!sincronizacionMasivaPermitidaV1()')!==-1);
  assert.ok(a.indexOf('!sincronizacionMasivaPermitidaV1()')<a.indexOf('Se migran atenciones locales a la nube'));
  const b=between('window.cargarAtencionesDesdeSupabase = cargarAtencionesDesdeSupabase = async function(){','snapshotBaselineAtenciones298(atenciones);');
  assert.ok(b.indexOf('!sincronizacionMasivaPermitidaV1()')!==-1);
  assert.ok(b.indexOf('!sincronizacionMasivaPermitidaV1()')<b.indexOf('ÚNICO CASO QUE CONSERVA forzar=true'));
});

test('sincronización forzada bloqueada sin rol global confirmado',()=>{
  assert.match(src,/if\(forzar && !sincronizacionMasivaPermitidaV1\(\)\)\{\s*console\.warn\('Sincronización forzada deshabilitada para perfil médico\.'\);\s*return false;/);
});

test('guardado normal conserva el UPDATE condicionado por updated_at (concurrencia optimista)',()=>{
  assert.match(src,/\.update\(\{payload:a, updated_at:now298\}\)\s*\.eq\('id',idStr\)\s*\.eq\('updated_at',baselineVersion\)/);
});

test('el médico resuelve pendientes sólo por RPC acotada, sin reenviar toda la colección',()=>{
  const f=between('async function actualizarPendienteMedicoV1(','function labels383').replace(/^\s*\/\/.*$/gm,'');
  assert.match(f,/rpc\('cardiolink_pendiente_mutar_v1'/);
  assert.doesNotMatch(f,/saveAtenciones\(|sincronizarAtencionesSupabase\(|\.upsert\(/);
});
