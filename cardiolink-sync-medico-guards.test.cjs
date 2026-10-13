// Pruebas de contrato (estáticas) de las guardas de sincronización clínica en app.js.
// No reemplazan el QA funcional con navegador autenticado: sólo evitan que una
// edición futura quite sin querer una guarda crítica. Ejecutar: node --test
const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs');
const path=require('node:path');
const src=fs.readFileSync(path.join(__dirname,'app.js'),'utf8');
const sinComentarios=t=>t.replace(/^\s*\/\/.*$/gm,'');
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

test('tras la RPC del médico se relee la fila y se actualizan los baselines (sin borrar la versión)',()=>{
  const f=between('async function actualizarPendienteMedicoV1(','function labels383').replace(/^\s*\/\/.*$/gm,'');
  assert.match(f,/from\('cardiolink_atenciones'\)\s*\.select\('id,payload,updated_at'\)\s*\.eq\('id',String\(id\)\)/);
  assert.match(f,/confirmarVersionRemotaAtencion298\?\.\(id,confirmado,version,version===null\)/);
  const c=between('function confirmarVersionRemotaAtencion298(','window.confirmarVersionRemotaAtencion298=');
  assert.match(c,/baselineAtenciones298\.set\(/);
  assert.match(c,/if\(!soloContenido&&updatedAt\)baselineVersionAtenciones298\.set\(/);
  assert.doesNotMatch(c,/baselineVersionAtenciones298\.delete\(/);
});

test('mensajería del médico: identidad por backend, directorio mínimo, config nunca escrita y leído por RPC',()=>{
  const carga=between('async function cargarMensajeriaYConfigMedicoV1(){','async function cargarPermisoBackendRoles(){');
  assert.match(carga,/rpc\('cardiolink_directorio_mensajes_v1'\)/);
  assert.match(carga,/\^usuario:\[a-z0-9_\.-\]\+\$/);
  assert.match(carga,/rpc\('cardiolink_config_medico_v1'\)/);
  assert.doesNotMatch(carga,/\.upsert\(|\.update\(|saveConfig/);
  assert.match(src,/usuario:\(esMedicoBackendV1\(\)&&backendMensajeriaV1\?\.login\)\|\|user/);
  const guardar=between('async function guardarConfigEnSupabase298(){','try{');
  assert.match(guardar,/if\(esMedicoBackendV1\(\)\) return false;/);
  assert.match(src,/if\(usuarioSupabase\?\.id\) msg\.creadoUid=usuarioSupabase\.id;/);
  const leidos=between('async function marcarLeidosMedicoV1(){','function marcarMensajesVisiblesLeidos(){');
  assert.match(leidos,/rpc\('cardiolink_mensaje_marcar_leido_v1'/);
  assert.doesNotMatch(leidos,/saveAtenciones\(|sincronizarAtencionesSupabase\(|\.upsert\(/);
});

test('el perfil del médico con identidad de backend no se asigna por heurísticas de email/alias',()=>{
  const f=between('function perfilUsuarioActual(){','/* ===== Rol backend autoritativo');
  assert.match(f,/if\(esMedicoBackendV1\(\)\)\{/);
  assert.match(f,/String\(u\.profesionalId\|\|''\)!==P/);
  assert.match(f,/usuario:\(esMedicoBackendV1\(\)&&backendMensajeriaV1\?\.login\)\|\|user/);
  assert.match(f,/nombre:\(esMedicoBackendV1\(\)&&nombreVisibleBackendV1\(\)\)\|\|user/);
});

test('el remitente del médico es un login propio y el nombre visible sale del directorio, no del email',()=>{
  const n=between('function nombreVisibleBackendV1(){','function ');
  assert.match(n,/directorioMensajesV1/);
  assert.doesNotMatch(n,/usuarioSupabase|email/i);
  const f=sinComentarios(between('function enviarMensajeInterno(){','function renderMensajes(){'));
  assert.match(f,/const loginRem=medicoBk\?\(vinculado\?usuarioLoginCorto\(u\.usuario\):backendMensajeriaV1\.login\)/);
  assert.match(f,/const nombreRem=medicoBk\?\(nombreVisibleBackendV1\(\)\|\|\(vinculado&&u\.nombre\)\|\|'Médico'\)/);
  assert.match(f,/deUsuario:loginRem,/);
  assert.match(f,/deNombre:nombreRem,/);
  assert.match(f,/if\(medicoBk\)\{ msg\.creadoPor=nombreRem\+' \('\+loginRem\+'\)'; msg\.creadoUsuario=loginRem; \}/);
  // el sello de auditoría (que usa el prefijo del email) se aplica DESPUÉS de fijar los datos confiables
  assert.ok(f.indexOf('msg.creadoUsuario=loginRem')<f.indexOf('selloAuditoriaCreacion(msg)'));
});

test('un mensaje rechazado por permisos (RLS) no se reencola y no bloquea el lote de atenciones',()=>{
  const e=between('function esErrorPermisosRLS298(e){','function descartarMensajesRechazados298');
  assert.match(e,/e\.code==='42501'/);
  assert.match(e,/row-level security\|permission denied/);
  const d=sinComentarios(between('function descartarMensajesRechazados298(','function d(id)'));
  assert.match(d,/atenciones=atenciones\.filter\(/);
  assert.match(d,/baselineAtenciones298\.delete\(/);
  assert.match(d,/baselineVersionAtenciones298\.delete\(/);
  // el texto no se pierde: respaldo local (últimos 20), cuadro de mensaje si está vacío y, si no, dentro del aviso
  assert.match(d,/cardiolink_mensajes_no_enviados_v1/);
  assert.match(d,/slice\(-20\)/);
  assert.match(d,/t\.value=textos\.join/);
  assert.match(d,/Texto del mensaje \(copialo si lo necesitás\)/);
  const s=sinComentarios(between('if(nuevas298.length){','if(conflictos298.length){'));
  assert.match(s,/nuevas298\.filter\(a=>!esMsg298\(a\)\),nuevas298\.filter\(esMsg298\)/);       // lotes separados
  assert.match(s,/lote\.every\(esMsg298\)&&esErrorPermisosRLS298\(upErr\)/);                       // sólo mensajes + sólo permisos
  assert.match(s,/for\(const m of lote\)/);                                                         // uno por uno: sólo se descartan los rechazados
  assert.match(s,/descartarMensajesRechazados298\(rechazadosPorPermisos298\)/);
  // los errores que NO son de permisos siguen reencolando
  assert.match(s,/syncAtencionesPendiente=true;\s*syncReintentosFallidos\+\+;\s*return false;/);
});

test('Secretaría y owner conservan la lógica de remitente anterior',()=>{
  const f=sinComentarios(between('function enviarMensajeInterno(){','function renderMensajes(){'));
  assert.match(f,/:usuarioLoginCorto\(u\.usuario\|\|usuarioActualNombreCorto\(\)\)/);
  assert.match(f,/:\(u\.nombre\|\|u\.usuario\|\|usuarioActualNombreCorto\(\)\)/);
  assert.match(f,/const medicoBk=esMedicoBackendV1\(\)&&!!backendMensajeriaV1\?\.login;/);
});

test('caché local por usuario: se aparta sin borrar, se limpia al cerrar sólo sin pendientes y antes de signOut',()=>{
  const a=between('function aislarCacheLocalPorUsuarioV1(uid,privilegiado){','// Se llama con la sesión');
  assert.match(a,/cardiolink_apartado_/);
  assert.match(a,/if\(!dueno && privilegiado\)/);                              // caché heredada: sólo la adoptan roles que ya ven todo
  assert.match(a,/localStorage\.setItem\(ap\(dueno\|\|'desconocido',k\),v\)/);   // se APARTA bajo su dueño (no se borra)
  assert.match(a,/data=loadConfig\(\); atenciones=loadAtenciones\(\);/);          // la memoria queda alineada con la caché del usuario actual
  const r=between('async function cargarPermisoBackendRoles(){','finally{');
  assert.match(r,/aislarCacheLocalPorUsuarioV1\(usuarioSupabase\?\.id, adminOwner\.data===true\|\|appointmentRequests\.data===true\);\s*await cargarMensajeriaYConfigMedicoV1\(\);/);
  assert.match(r,/aislarCacheLocalPorUsuarioV1\(usuarioSupabase\?\.id,false\);/);   // sin rol confirmado: nunca privilegiado
  const l=between('async function liberarCacheLocalAlCerrarSesionV1(){','// Directorio mínimo');
  assert.match(l,/sincronizarAtencionesSupabase\(false\)/);
  assert.ok(l.indexOf('if(pendiente){')!==-1&&l.indexOf('if(pendiente){')<l.indexOf('removeItem(k)'));
  assert.match(src,/await liberarCacheLocalAlCerrarSesionV1\(\);\s*if \(supabaseClient\) await supabaseClient\.auth\.signOut\(\);/);   // inactividad
  assert.match(src,/await liberarCacheLocalAlCerrarSesionV1\(\);\s*await supabaseClient\.auth\.signOut\(\);/);                           // cierre manual
  assert.match(src,/window\.hayPendientesSync298=function\(\)\{/);
});

test('filas nuevas sin sincronizar: se respaldan al cerrar sesión con pendientes y se recuperan sin pisar ni duplicar',()=>{
  const l=sinComentarios(between('async function liberarCacheLocalAlCerrarSesionV1(){','// Directorio mínimo'));
  assert.match(l,/window\.filasNuevasPendientes298\(\)/);
  assert.match(l,/OUTBOX_NUEVAS_KEY_V1\+usuarioSupabase\.id/);                       // respaldo POR usuario
  assert.ok(l.indexOf('OUTBOX_NUEVAS_KEY_V1')<l.indexOf('return false;'));
  const r=sinComentarios(between('async function recuperarNuevasPendientesV1(){','function clavesCacheLocalV1()')||between('async function recuperarNuevasPendientesV1(){','function aislarCacheLocalPorUsuarioV1'));
  assert.match(r,/!ids\.has\(String\(r\.id\)\)/);                                    // lo que ya existe en el servidor NO se pisa ni se duplica
  assert.match(r,/idsRec\.has\(String\(a\.id\)\)/);                                 // confirmado = las filas recuperadas ya tienen versión remota
  assert.match(r,/if\(ok\) localStorage\.removeItem\(k\)/);                           // el respaldo se descarta sólo si quedó confirmado
  const s=between('window.filasNuevasPendientes298=function(){','window.hayPendientesSync298=function(){');
  assert.match(s,/!baselineVersionAtenciones298\.has\(String\(a\.id\)\)/);            // sólo filas sin versión remota (nunca confirmadas)
  // la recuperación corre DESPUÉS del snapshot de baselines y de soltar cargandoDesdeNube
  assert.match(src,/snapshotBaselineAtenciones298\(atenciones\);\s*cargandoDesdeNube=false;\s*try\{ await recuperarNuevasPendientesV1\(\);/);
});

test('evoluciones: guardado confiable (por id, refresco pausado, confirmación del servidor, sin duplicados)',()=>{
  const f=sinComentarios(between('async function saveEvolutionHC(p,existing,atencionId){','function mostrarErrorGuardadoEvolucionV1'));
  // (1) se resuelve la evolución POR ID en el estado actual (no se muta la referencia capturada al abrir)
  assert.match(f,/let live=editId\?\(data\.evolucionesClinicas\|\|\[\]\)\.find\(x=>String\(x\.id\)===editId\):null;/);
  assert.match(f,/Object\.assign\(live,campos\)/);
  assert.doesNotMatch(f,/Object\.assign\(existing,/);
  // evolución ausente del estado: se comprueba el servidor antes de recrear; si no existe en el servidor NO se recrea
  assert.match(f,/srv\.existe===false\)\{falloGuardado\(/);
  // control de versión contra una edición posterior de otra sesión
  assert.match(f,/vServ>vBase\+1000/);
  // (3) los datos se arman antes de cualquier await; (4) se confirma antes de cerrar y (5) se revierte el estado local si falla
  assert.match(f,/guardarEvolucionConfirmada\(p,evolutionIdFinal,\{resumen:summaryChanged\}\)/);
  assert.ok(f.indexOf('if(!r.ok){')!==-1&&f.indexOf('revertirLocal();')<f.indexOf("$hc('hcEvolutionModal')?.remove()"));
  assert.ok(f.indexOf('guardarEvolucionConfirmada(')<f.indexOf("$hc('hcEvolutionModal')?.remove()"));   // el modal se cierra DESPUÉS de confirmar
  // (6) id estable por modal y bloqueo de reentrada
  assert.match(f,/modalEl\.dataset\.evoIdV1=evolutionIdFinal/);
  assert.match(f,/if\(window\.__hcGuardandoEvolucionV1\)return;/);
  assert.match(f,/finally\{\s*window\.__hcGuardandoEvolucionV1=false;/);
  // el refresco automático se pausa con el modal abierto o guardando
  const r=between('async function refrescarDesdeSupabaseAutomatico(){','await cargarAtencionesDesdeSupabase();');
  assert.match(r,/window\.__hcGuardandoEvolucionV1\s*\|\|\s*document\.getElementById\('hcEvolutionModal'\)/);
});

test('capa relacional: guardarEvolucionConfirmada arma filas antes de los await, sólo sube la evolución editada y verifica por lectura',()=>{
  const g=sinComentarios(between('async function guardarEvolucionConfirmada410(p,evolutionId,opts){','function mergePaciente410(row){'));
  const antesDelPrimerAwait=g.slice(0,g.indexOf('await'));
  assert.match(antesDelPrimerAwait,/erow=evolucionRow410\(ev,p\)/);        // snapshot de la fila ANTES de cualquier await
  assert.doesNotMatch(g,/evolucionesLocal410\(p\)\.filter\(x=>x\?\.id\)\.map/);   // no reenvía todas las evoluciones del paciente
  assert.match(g,/\.from\('cardiolink_hc_evoluciones'\)\.upsert\(\[erow\],\{onConflict:'id'\}\)/);
  assert.match(g,/23503/);                                                    // sólo toca la ficha del paciente si falta (FK)
  assert.match(g,/leerEvolucion410\(erow\.id\)/);                              // confirmación por lectura posterior
  assert.match(src,/leerEvolucion:leerEvolucion410,guardarEvolucionConfirmada:guardarEvolucionConfirmada410/);
});
