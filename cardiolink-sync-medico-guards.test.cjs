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
  const f=between('async function cargarPermisoBackendRolesIntentoV1(ultimoIntento){','function esMatiasDuenio(){');
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
  assert.match(f,/nombre:\(esMedicoBackendV1\(\)&&\(nombreVisibleBackendV1\(\)\|\|nombreProfesionalPorIdV1\(backendPendientesIdentidadV1\.professional_id\)\)\)\|\|user/);   // directorio del servidor, luego el nombre del profesional, nunca el prefijo del email salvo último recurso
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
  const r=between('async function cargarPermisoBackendRolesIntentoV1(ultimoIntento){','function esMatiasDuenio(){');
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

test('cierre de sesión: los documentos clínicos sin respaldo confirmado se resguardan por uid y nunca se pierden',()=>{
  const lib=sinComentarios(between('async function liberarCacheLocalAlCerrarSesionV1(){','// Directorio mínimo de destinatarios'));
  // el respaldo se resuelve ANTES de decidir si se elimina la caché, y la caché no se elimina si no está garantizado
  assert.ok(lib.indexOf('protegerDocumentosSinRespaldoV1()')!==-1);
  assert.ok(lib.indexOf('protegerDocumentosSinRespaldoV1()')<lib.indexOf('hayPendientesSync298'));
  assert.ok(lib.indexOf('if(!docsSeguros) return false;')!==-1&&lib.indexOf('if(!docsSeguros) return false;')<lib.indexOf('clavesCacheLocalV1().forEach(k=>localStorage.removeItem(k))'));
  // la evidencia viene del SERVIDOR (PDF archivado con el mismo hash o copia idéntica en la config remota), nunca de la memoria local
  const c=sinComentarios(between('async function documentosSinRespaldoConfirmadoV1(docs){','// true = es seguro eliminar la caché'));
  assert.match(c,/from\('cardiolink_patient_documents'\)\.select\('source_document_id,source_content_hash,document_type,patient_id'\)\.in\('source_document_id'/);
  // el hash archivado NO distingue paciente, tipo ni firma: una fila sólo confirma si además coinciden tipo y paciente real y el documento nunca fue editado
  const f=sinComentarios(between('function filaArchivadaConfirmaDocV1(f,d,hash){','// Huella completa'));
  assert.match(f,/f\.source_content_hash!==hash/);
  assert.match(f,/if\(d\.actualizadoEn\) return false;/);
  assert.match(f,/f\.document_type!==TIPO_ARCHIVO_PDF_POR_DOC_V1\[d\.tipo\]/);
  assert.match(f,/String\(f\.patient_id\)===real/);
  assert.match(f,/real!==null/);
  // la copia remota de la config sólo confirma con la huella COMPLETA del documento (no con el hash débil)
  assert.match(c,/huellaDocCompletaV1\(r\)===huellaDocCompletaV1\(d\)/);
  assert.match(c,/payload->config->documentosClinicos/);
  assert.match(c,/if\(error\) throw error;/);                      // un error de red NO confirma nada: lanza y el llamador conserva todo
  assert.match(c,/if\(!esMedicoBackendV1\(\)\)/);                  // el médico nunca escribe la config: no se usa como respaldo
  assert.match(c,/window\.hashContenidoDocumento406/);
  // el resguardo está aislado por uid; sin uid o sin poder resguardar no se elimina nada
  const p=sinComentarios(between('async function protegerDocumentosSinRespaldoV1(){','// Tras iniciar sesión'));
  assert.match(p,/OUTBOX_DOCS_KEY_V1\+uid/);
  assert.match(p,/if\(!uid\) return locales\.length===0;/);
  assert.match(p,/catch\(e\)\{[^}]*return false;\s*\}/);
  assert.match(p,/consultaOk=false/);
  assert.match(p,/return consultaOk;/);
  // la recuperación sólo lee el resguardo del uid actual y nunca pisa un documento existente por id
  const r=sinComentarios(between('function recuperarDocumentosPendientesV1(){','// Último recurso'));
  assert.match(r,/leerOutboxDocsV1\(uid\)/);
  assert.match(r,/!ids\.has\(String\(d\.id\)\)/);
  assert.doesNotMatch(r,/removeItem/);                              // el resguardo sólo lo descarta un cierre que lo confirme
  assert.match(src,/try\{ await recuperarNuevasPendientesV1\(\); \}[^\n]*\n\s*try\{ recuperarDocumentosPendientesV1\(\); \}/);
  // si apartar la caché ajena falla por cuota, sus documentos pasan al resguardo de SU uid antes de eliminarse
  assert.match(src,/se elimina por privacidad:',k\); if\(k===storageConfig&&dueno\) salvarDocumentosDeCacheV1\(dueno,v\);/);
  assert.match(src,/window\.hashContenidoDocumento406=hashContenidoDocumento406;/);
});

test('identidad owner/admin: el servidor (rol + professional_id) prevalece sobre la config local y los alias; nunca se otorga sin ratificación',()=>{
  const i=sinComentarios(between('function identidadBackendOwnerAdminV1(){','function perfilUsuarioActual(){'));
  assert.match(i,/!usuarioSupabase\|\|!backendRolCargado\|\|!backendEsAdminOwner\|\|!i\|\|!i\.professional_id\) return null;/);   // exige sesión, rol cargado, es_admin_u_owner Y professional_id
  assert.match(i,/i\.role!=='owner'&&i\.role!=='admin'\) return null;/);
  const p=sinComentarios(between('function perfilUsuarioActual(){','/* ===== Rol backend autoritativo'));
  const iB=p.indexOf('const ib=identidadBackendOwnerAdminV1();');
  assert.ok(iB!==-1&&iB>p.indexOf('inferirUsuarioPorLogin(user)')&&iB<p.indexOf("if(!u) u={id:'usr_sin_config'"));   // después de alias/médico, antes del perfil mínimo: el servidor pisa lo local
  assert.match(p,/esDuenio=ib\.role==='owner'&&ib\.P==='matias'/);                       // sólo owner + 'matias' es el dueño; cualquier otro owner/admin = administrador
  assert.match(p,/rolLocalOk=esDuenio\?'duenio':'admin'/);
  assert.match(p,/nombreProfesionalPorIdV1\(backendPendientesIdentidadV1\.professional_id\)/);   // médico sin entrada: nombre del profesional, no el prefijo del email
  assert.doesNotMatch(i,/usuarioCoincide|email|alias/i);                                     // la decisión NO usa email ni alias
  assert.match(src,/if\(backendEsAdminOwner\) return rolLocal==='sin_configurar'\?'admin':rolLocal;/);   // owner/admin del servidor con perfil local sin mapear: nunca queda sin acceso
});

test('rol backend: reintento automático breve y limitado, sin conceder nada sin confirmación, con aviso claro si es permanente',()=>{
  const t=sinComentarios(between('function esErrorTransitorioRolV1(e){','function quitarAvisoRolBackendV1'));
  assert.match(t,/PGRST303/);
  assert.match(t,/jwt issued at future/);
  const w=sinComentarios(between('async function cargarPermisoBackendRoles(){','async function cargarPermisoBackendRolesIntentoV1(ultimoIntento){'));
  assert.match(w,/const demoras=\[1200,2500\];/);                                         // acotado: 2 reintentos, ~3,7 s como máximo
  assert.match(w,/cargarPermisoBackendRolesIntentoV1\(i===demoras\.length\)/);                 // el último intento aplica el fail-closed definitivo
  assert.ok(w.indexOf('backendRolConsultaFinalizada=false')<w.indexOf('for(let i=0'));          // durante los reintentos la consulta figura PENDIENTE
  assert.match(w,/finally\{\s*backendRolConsultaFinalizada=true;/);
  assert.match(w,/if\(backendRolCargado\) quitarAvisoRolBackendV1\(\); else mostrarAvisoRolBackendV1\(\);/);   // problema permanente: no se oculta
  const a=sinComentarios(between('async function cargarPermisoBackendRolesIntentoV1(ultimoIntento){','function esMatiasDuenio(){'));
  assert.equal((a.match(/backendRolCargado=true/g)||[]).length,1);                             // un solo punto donde se otorga: tras la confirmación del servidor
  assert.ok(a.indexOf('backendRolCargado=true')>a.indexOf('backendEsAdminOwner=adminOwner.data===true'));
  assert.match(a,/if\(!ultimoIntento&&esErrorTransitorioRolV1\(e\)\)\s*\{[^}]*return true;\s*\}/);     // sólo errores transitorios se reintentan
  assert.match(a,/backendRolCargado=false;backendEsAdminOwner=false;backendTieneAccesoTurnos=false;backendPendientesIdentidadV1=null/);   // fail-closed definitivo intacto
  const m=sinComentarios(between('function mostrarAvisoRolBackendV1(){','async function reintentarRolBackendV1(){'));
  assert.match(m,/btnReintentarRolV1/);
  const r=between('async function refrescarDesdeSupabaseAutomatico(){','await cargarAtencionesDesdeSupabase();');
  assert.match(r,/usuarioSupabase && backendRolConsultaFinalizada && !backendRolCargado && !window\.__rolReintentandoV1/);   // recuperación automática en el ciclo de 30 s
});
