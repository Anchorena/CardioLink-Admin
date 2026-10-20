// Pruebas de contrato (estáticas) de las guardas de sincronización clínica en app.js.
// No reemplazan el QA funcional con navegador autenticado: sólo evitan que una
// edición futura quite sin querer una guarda crítica. Ejecutar: node --test
const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs');
const path=require('node:path');
const src=fs.readFileSync(path.join(__dirname,'app.js'),'utf8');
const srcPdf=fs.readFileSync(path.join(__dirname,'cardiolink-documentos-pdf-v1.js'),'utf8');
const sinComentarios=t=>t.replace(/^\s*\/\/.*$/gm,'');
const between=(from,to)=>{const i=src.indexOf(from);assert.notEqual(i,-1,'no se encontró: '+from);const j=src.indexOf(to,i+from.length);assert.notEqual(j,-1,'no se encontró fin: '+to);return src.slice(i,j);};
const betweenIn=(txt,from,to)=>{const i=txt.indexOf(from);assert.notEqual(i,-1,'no se encontró: '+from);const j=txt.indexOf(to,i+from.length);assert.notEqual(j,-1,'no se encontró fin: '+to);return txt.slice(i,j);};

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

test('cierre de sesión: los documentos clínicos sin respaldo confirmado se resguardan por uid y nunca se pierden',()=>{
  const lib=sinComentarios(between('async function liberarCacheLocalAlCerrarSesionV1(){','// Directorio mínimo de destinatarios'));
  // el respaldo se resuelve ANTES de decidir si se elimina la caché, y la caché no se elimina si no está garantizado
  assert.ok(lib.indexOf('protegerDocumentosSinRespaldoV1()')!==-1);
  assert.ok(lib.indexOf('protegerDocumentosSinRespaldoV1()')<lib.indexOf('hayPendientesSync298'));
  assert.ok(lib.indexOf('if(!docsSeguros) return false;')!==-1&&lib.indexOf('if(!docsSeguros) return false;')<lib.indexOf('clavesCacheLocalV1().forEach(k=>localStorage.removeItem(k))'));
  // la evidencia viene del SERVIDOR (PDF archivado con el mismo hash o copia idéntica en la config remota), nunca de la memoria local
  const c=sinComentarios(between('async function documentosSinRespaldoConfirmadoV1(docs){','// true = es seguro eliminar la caché'));
  assert.match(c,/from\('cardiolink_patient_documents'\)\.select\(cols\)\.in\('source_document_id'/);
  assert.match(c,/consultaDocs\('source_document_id,source_content_hash,document_type,patient_id,pv:source_payload->>v'\)/);
  // el hash archivado NO distingue paciente, tipo ni firma: una fila sólo confirma si además coinciden tipo y paciente real y el documento nunca fue editado
  const f=sinComentarios(between('function filaArchivadaConfirmaDocV1(f,d,hash){','// Huella completa'));
  assert.match(f,/f\.source_content_hash!==hash/);
  assert.match(f,/if\(String\(f\.pv\)==='2'\) return true;/);                 // huella v2 (cliente de Documentos V1): cubre tipo, firma, paciente y presentación
  assert.ok(f.indexOf("if(String(f.pv)==='2') return true;")<f.indexOf('if(d.actualizadoEn) return false;'));   // las filas ANTERIORES siguen con las reglas estrictas
  assert.match(f,/if\(d\.actualizadoEn\) return false;/);
  assert.match(f,/f\.document_type!==TIPO_ARCHIVO_PDF_POR_DOC_V1\[d\.tipo\]/);
  assert.match(f,/real===null\|\|String\(f\.patient_id\)!==real\) return false;/);   // el paciente real debe coincidir SIEMPRE (también con huella v2)
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


test('documentos V1 / Bloque A: guardado confirmado en servidor antes de tocar el estado local ni cerrar el modal',()=>{
  const f=sinComentarios(between('async function saveDocument406(p,existing,printAfter,formatoImpresion){','// ---- Documentos V1 / Bloque A: recuperación'));
  assert.match(f,/if\(window\.__docGuardandoV1\)return;/);                                  // reentrada / doble clic
  assert.match(f,/modalEl\.dataset\.docIdV1=docId/);                                           // id estable por modal: un reintento no crea otro documento
  assert.match(f,/data\.documentosClinicos\.find\(x=>String\(x\.id\)===docId\)/);              // el estado se resuelve POR ID
  assert.match(f,/Object\.assign\(clone406\(base\)/);                                         // el candidato es una copia: no muta el estado
  const iArch=f.indexOf('await window.archivarVersionDocumentoV1(candidato');
  assert.ok(iArch!==-1);
  assert.ok(iArch<f.indexOf('data.documentosClinicos.push(candidato)'));                      // el estado local se toca DESPUÉS de la confirmación
  assert.ok(iArch<f.indexOf("$406('clinicalDocModal406')?.remove()"));                          // el modal se cierra DESPUÉS de la confirmación
  assert.ok(f.indexOf('if(!r||!r.ok){')<f.indexOf('persist406()'));
  assert.match(f,/Tu texto sigue acá y no se perdió/);
  assert.match(f,/refrescarSeccionesDocs406\(p\)/);                                           // el historial se actualiza ya
  assert.match(f,/finally\{\s*window\.__docGuardandoV1=false;/);
  assert.match(f,/baseArchivoId/);                                                            // versión sobre la que se editó (edición concurrente)
  // el refresco automático se pausa con el modal de documento abierto
  const r=between('async function refrescarDesdeSupabaseAutomatico(){','await cargarAtencionesDesdeSupabase();');
  assert.match(r,/window\.__docGuardandoV1\s*\|\|\s*document\.getElementById\('clinicalDocModal406'\)/);
});

test('documentos V1 / Bloque A: huella de versión, catálogo único y payload sin datos de más',()=>{
  const h=sinComentarios(between('async function hashContenidoDocumento406(d){','// Expuesto para el cierre de sesión'));
  ['tipo','incluirFirma','paciente:{id:','prof:{marca','logo:','firma:'].forEach(k=>assert.ok(h.includes(k),'la huella debe cubrir '+k));
  assert.match(src,/TIPO_PDF_ARCHIVO_POR_DOC406=\{receta:'Receta',orden:'Orden'.*mensaje_colega:'Mensaje a colega',indicacion_paciente:'Indicaciones'\}/s);   // los 13 tipos, un solo catálogo
  const g=sinComentarios(between('window.generarPdfDocumentoGenerado406=async function(docId,formato,docOverride){','// Bloque E - mini-selector de formato'));
  assert.match(g,/resolverDatosDocumento406\(docId,formato,docOverride\)/);
  const pl=g.slice(g.indexOf('const payload={'),g.indexOf('return {',g.indexOf('const payload={')));
  assert.doesNotMatch(pl,/dni|pacienteNombre/);                                               // el payload no duplica nombre ni DNI del paciente
  assert.match(pl,/v:2/);
});

test('documentos V1 / Bloque A: recuperación sin pisar contenido local, versiones y archivado manual',()=>{
  const s=sinComentarios(between('function sincronizarDocumentosDesdeFilas406(p,rows){','window.idsPayloadNecesariosV1'));
  assert.match(s,/local\.conflictoV1=v\.id/);                                                // contenido local propio: se conserva y se avisa
  assert.match(s,/igualesPayload406\(local,basePl\)/);                                       // sólo se actualiza si la local ES la versión anterior archivada
  assert.ok(s.indexOf('igualesPayload406(local,basePl)')<s.indexOf('local.conflictoV1=v.id'));   // el aviso es el ÚLTIMO recurso: antes se descartan los casos seguros
  assert.match(s,/isMedical406\(\)/);
  const a=sinComentarios(between('async function archivarLocales406(key){','function versionesDoc406(d,p){'));
  assert.match(a,/confirm\(/);                                                               // sólo con confirmación del usuario
  assert.doesNotMatch(a,/data\.documentosClinicos\s*=[^=]|splice\(|\.filter\(x=>!/);        // nunca borra copias locales
  assert.match(a,/live\.archivoId=r\.rowId/);                                                // se marca archivado recién cuando el servidor confirma
});

test('documentos V1 / Bloque A: el aviso y el archivado manual actúan SÓLO sobre el paciente en pantalla; el resguardo del logout sigue cubriendo a todos',()=>{
  // el conteo es del paciente (docsForPatient406) y sin paciente no cuenta nada
  const c=sinComentarios(between('function docsSinArchivar406(p){','// Archivado MANUAL'));
  assert.match(c,/if\(!p\)return \[\];/);
  assert.match(c,/docsForPatient406\(p\)\.filter\(d=>d&&d\.id&&!d\.archivoId&&canIssueDoc406\(d\.tipo\)\)/);
  assert.doesNotMatch(c,/data\.documentosClinicos\.filter/);                                  // ya no recorre los documentos de todos los pacientes
  // el botón lleva la clave del paciente y la confirmación lo nombra y dice cuántos se archivan
  const a=sinComentarios(between('async function archivarLocales406(key){','function versionesDoc406(d,p){'));
  assert.match(a,/const pac=patient406\(key\);if\(!pac\)return;/);
  assert.match(a,/const pend=docsSinArchivar406\(pac\);/);
  assert.match(a,/confirm\('Se van a archivar en el servidor[^\n]*pend\.length[^\n]*patientName406\(pac\)/);
  const sec=between('function docsSection406(p){','const fila=d=>');
  assert.match(sec,/isMedical406\(\)\?docsSinArchivar406\(p\):\[\]/);
  assert.doesNotMatch(src,/guardado\$\{pend\.length===1\?'':'s'\} solo en este equipo/);   // ya no afirma "sólo en este equipo"
  assert.match(src,/data-docs-archivar-locales-v1="\$\{esc406\(patientKey406\(p\)\)\}"/);
  assert.match(src,/archivarLocales406\(al\.dataset\.docsArchivarLocalesV1\)/);
  // el resguardo del cierre de sesión NO usa este conteo: sigue cubriendo los documentos de TODOS los pacientes
  const lg=sinComentarios(between('async function protegerDocumentosSinRespaldoV1(){','// Tras iniciar sesión'));
  assert.match(lg,/docsLocalesV1\(\)/);
  assert.doesNotMatch(lg,/docsSinArchivar406|docsForPatient406/);
});

test('documentos V1 / Bloque A: el N.º de afiliado entra en la huella SÓLO en órdenes con número (sin él la huella no cambia)',()=>{
  const h=sinComentarios(between('async function hashContenidoDocumento406(d){','// Expuesto para el cierre de sesión'));
  assert.match(h,/const afiliado=afiliadoOrden406\(d,p\);/);                                  // misma regla que imprime el PDF: sólo órdenes con número
  assert.match(h,/cobertura:p\.coberturaHabitual\|\|'',\.\.\.\(afiliado\?\{afiliado\}:\{\}\)\}/);   // la clave sólo existe si hay número => huellas anteriores intactas
  assert.match(h,/paciente:\{id:p\.id\|\|'',nombre:/);
  const a=sinComentarios(between('function afiliadoOrden406(d,p){','function resolverDatosDocumento406('));
  assert.match(a,/d\.tipo!=='orden'\)return ''/);                                             // otros tipos: sin afiliado
});

test('documentos V1 / Bloque A: el aviso distingue "versión eliminada" de "versión más nueva" sin tocar el versionado',()=>{
  const v=sinComentarios(between('function versionesDoc406(d,p){','if(!lst.length)return'));
  assert.match(v,/const baseEliminada=!!d\.conflictoV1&&!!d\.archivoId&&lst\.length>0&&lst\.some\(r=>String\(r\.id\)===String\(d\.conflictoV1\)\)&&!lst\.some\(r=>String\(r\.id\)===String\(d\.archivoId\)\);/);   // listado no vacío y coherente
  assert.match(v,/ya no está en el servidor \(fue eliminada\)/);
  assert.match(v,/Hay una versión más nueva en el servidor/);                                  // el texto de siempre se conserva como valor por defecto
  assert.ok(v.indexOf('baseEliminada?')<v.indexOf('Hay una versión más nueva'));
  // las reglas de versionado/sincronización NO cambiaron
  const s=sinComentarios(between('function sincronizarDocumentosDesdeFilas406(p,rows){','window.idsPayloadNecesariosV1'));
  assert.match(s,/local\.conflictoV1=v\.id/);
  assert.match(src,/const baseArchivoId=base\?\(base\.conflictoV1\|\|base\.archivoId\|\|''\):'';/);
});

test('documentos V1 / médico: un documento de OTRO profesional ya archivado no se regenera ni se versiona; se reutiliza sólo si la fila es la esperada',()=>{
  // app.js: ajeno = rol médico en el backend + id propio conocido + profesional distinto
  const h=sinComentarios(between('function esDocumentoAjenoDeMedicoV1(d){','// Devuelve los documentos SIN respaldo confirmado'));
  assert.match(h,/!esMedicoBackendV1\(\)\) return false;/);                                  // owner/admin/secretaría: comportamiento intacto
  assert.match(h,/return !!mio&&!!de&&de!==mio;/);                                            // sin id propio no se considera ajeno
  const e=sinComentarios(between('function payloadIgualDocV1(d,pl){','function esDocumentoAjenoDeMedicoV1(d){'));
  ['tipo','titulo','contenido','adicional','fechaHora','profesionalId','incluirFirma'].forEach(k=>assert.ok(e.indexOf("'"+k+"'")!==-1,'falta '+k));
  // módulo PDF: la ruta de documento ajeno va ANTES del archivado y nunca archiva ni sube nada
  const a=sinComentarios(betweenIn(srcPdf,'async function asegurarDocumentoArchivadoV1(docId){','window.guardarPdfDocumentoGenerado406='));
  assert.match(a,/esDocumentoAjenoDeMedicoV1\(d\)/);
  assert.ok(a.indexOf('esDocumentoAjenoDeMedicoV1(d)')<a.indexOf('archivarVersionDocumentoV1(d,'));
  assert.match(a,/verificarFilaDocumentoAjenoV1\(d\)/);
  const v=sinComentarios(betweenIn(srcPdf,'async function verificarFilaDocumentoAjenoV1(d,fin){','window.abrirPdfOriginalDocumentoAjenoV1='));
  assert.match(v,/d\.conflictoV1\)return \{ok:false/);                                       // conflicto: no se reutiliza
  assert.match(v,/if\(!f\)return \{ok:false/);                                                // falta de respaldo: no se crea nada
  assert.match(v,/String\(f\.patient_id\)!==real/);                                           // la fila corresponde a este paciente
  assert.match(v,/String\(f\.pv\)!=='2'\|\|!f\.source_payload/);                              // sin payload no hay forma de validar
  assert.match(v,/String\(d\.archivoId\|\|''\)!==String\(f\.id\)/);                           // versión esperada (la que ve el usuario)
  assert.match(v,/payloadIgualDocV1\(d,f\.source_payload\)/);                                 // mismo contenido
  assert.doesNotMatch(v,/archivarVersionDocumentoV1|generarPdfDocumentoGenerado406|\.upload\(|\.insert\(|\.remove\(|\.delete\(/);   // nunca genera, sube, inserta ni borra
  assert.match(srcPdf,/return \{ok:true,documentId:a\.rowId,patientId:a\.patientId,reusado:true,ajeno:true\};/);
});

test('documentos V1 / médico: el resguardo del logout no copia documentos ajenos con respaldo confirmado y mantiene la protección de propios y pendientes',()=>{
  const f=sinComentarios(between('async function documentosSinRespaldoConfirmadoV1(docs){','// true = es seguro eliminar la caché'));
  // los ajenos exigen archivoId, fila del mismo documento, mismo paciente y MISMO contenido archivado
  assert.match(f,/const ajenos=docs\.filter\(d=>!confirmados\.has\(String\(d\.id\)\)&&d\.archivoId&&esDocumentoAjenoDeMedicoV1\(d\)\);/);
  assert.match(f,/String\(f\.source_document_id\)!==String\(d\.id\)\) return;/);
  assert.match(f,/String\(f\.patient_id\)!==real\) return;/);
  assert.match(f,/if\(payloadIgualDocV1\(d,f\.source_payload\)\) confirmados\.add\(String\(d\.id\)\);/);
  // un error de consulta sigue lanzando (el llamador conserva todo) y las demás vías de confirmación no se tocaron
  assert.match(f,/\.in\('id',lote\.map\(d=>String\(d\.archivoId\)\)\);\s*if\(error\) throw error;/);
  assert.ok(f.indexOf('filaArchivadaConfirmaDocV1(f,d,hashes.get(String(d.id)))')<f.indexOf('const ajenos='));
  assert.ok(f.indexOf('const ajenos=')<f.indexOf('if(!esMedicoBackendV1()){'));
  // los propios no pasan por la vía de contenido: sólo huella; y sin archivoId (pendiente) nunca se confirma por esta vía
  assert.doesNotMatch(f,/ajenos[^;]*profesionalId===/);
  const lg=sinComentarios(between('async function protegerDocumentosSinRespaldoV1(){','// Tras iniciar sesión'));
  assert.match(lg,/docsLocalesV1\(\)/);                                                       // sigue cubriendo los documentos de todos los pacientes
});

test('documentos V1 / médico: Eliminar sólo se ofrece sobre documentos propios y el borrado denegado no pasa inadvertido',()=>{
  const f=sinComentarios(betweenIn(srcPdf,'function puedeEliminarDocumentoV1(d){','function pacienteActivoPdfV1(){'));
  assert.match(f,/if\(!puedeAccederClinicaPdfV1\(\)\)return false;/);                          // el gate anterior se conserva
  assert.match(f,/!esMedicoBackendV1\(\)\)return true;/);                                       // owner/admin: sin cambios
  assert.match(f,/if\(d\.professional_id\)return !!mio&&String\(d\.professional_id\)===mio;/);   // con professional_id: sólo el suyo (haberla subido no alcanza)
  assert.match(f,/return !!uid&&!!d\.uploaded_by&&String\(d\.uploaded_by\)===uid;/);               // sin professional_id: sólo quien la subió (uploaded_by confirmado)
  assert.match(f,/catch\(e\)\{return false;\}/);                                                // ante la duda no se ofrece
  assert.match(srcPdf,/\$\{puedeEliminarDocumentoV1\(d\)\?`<button class="danger small-btn" type="button" data-pdf-eliminar-v1=/);
  assert.equal((srcPdf.match(/data-pdf-eliminar-v1="/g)||[]).length,1);                         // un solo punto de emisión del botón
  const e=sinComentarios(betweenIn(srcPdf,'async function eliminarPdfV1(id,path,patientId){','// patientId viene'));
  assert.match(e,/\.delete\(\)\.eq\('id',id\)\.select\('id'\);/);
  assert.match(e,/if\(!delRows\|\|!delRows\.length\)throw new Error\(/);                        // 0 filas (RLS) => error visible, no éxito silencioso
  assert.ok(e.indexOf('.remove([path])')<e.indexOf('.delete().eq'));                            // el orden Storage -> fila no cambia
});

test('documentos V1 / médico: imprimir un documento de OTRO profesional abre su PDF original archivado (sin regenerar ni versionar)',()=>{
  // app.js: el desvío va ANTES de resolver/regenerar y el selector A4/A5 se omite para ajenos
  const pr=between('function printDocument406(id,formato){','const datos406=resolverDatosDocumento406(id,formato);');
  assert.match(pr,/esDocumentoAjenoDeMedicoV1\(dAjeno\)/);
  assert.match(pr,/window\.abrirPdfOriginalDocumentoAjenoV1\(dAjeno\)/);
  assert.match(pr,/No se imprimió nada\./);                                                   // sin el módulo: se bloquea, no se regenera
  assert.match(pr,/return;\s*\}\s*$/);                                                        // el desvío termina antes de la regeneración
  const el=sinComentarios(between('function elegirFormatoEImprimir406(id){','cerrarPrintFormatModal406();\n    const modal'));
  assert.match(el,/esDocumentoAjenoDeMedicoV1\(d\)\)\{printDocument406\(id\);return;\}/);
  // módulo PDF: reutiliza la verificación de Guardar PDF / Enviar y abre una URL firmada; nunca genera, archiva ni escribe
  const v=sinComentarios(betweenIn(srcPdf,'window.abrirPdfOriginalDocumentoAjenoV1=async function(d){','async function asegurarDocumentoArchivadoV1(docId){'));
  assert.match(v,/verificarFilaDocumentoAjenoV1\(d,'No se imprimió nada\.'\)/);
  assert.match(v,/if\(!a\.ok\)\{alert\(a\.error\);return false;\}/);                         // falta de PDF / conflicto / contenido distinto: bloquea con el mensaje
  assert.match(v,/createSignedUrl\(a\.storagePath,120\)/);                                    // acceso autorizado al Storage privado, URL temporal
  assert.match(v,/window\.open\(signed\.signedUrl,'_blank'\)/);
  assert.doesNotMatch(v,/archivarVersionDocumentoV1|generarPdfDocumentoGenerado406|\.upload\(|\.insert\(|\.update\(|\.delete\(|\.remove\(|saveConfig/);
  const ver=sinComentarios(betweenIn(srcPdf,'async function verificarFilaDocumentoAjenoV1(d,fin){','window.abrirPdfOriginalDocumentoAjenoV1='));
  assert.match(ver,/storagePath:f\.storage_path\}/);
  assert.match(ver,/String\(d\.archivoId\|\|''\)!==String\(f\.id\)/);                         // las mismas validaciones que ya cubría el test anterior
});

test('documentos V1 / Bloque A: archivado por versión (módulo PDF): idempotente, con candado y sin dejar filas sin archivo',()=>{
  const m=sinComentarios(betweenIn(srcPdf,'async function archivarInternoV1(doc,opts){','// Un documento a la vez'));
  assert.match(m,/ult\.source_content_hash===gen\.sourceContentHash\)return \{ok:true,rowId:ult\.id/);   // misma huella: se reutiliza, no se duplica
  assert.match(m,/String\(ult\.pv\)==='2'&&String\(ult\.id\)!==String\(opts\.baseArchivoId\|\|''\)/);   // edición concurrente: no se sobrescribe
  assert.match(m,/conflicto:true/);
  assert.match(m,/source_payload:gen\.payload/);
  assert.match(m,/select\('id,created_at'\)\.single\(\)/);
  // si el INSERT devuelve error se verifica ANTES de borrar el PDF, y sólo se borra cuando se comprobó que la fila no existe
  const e=m.slice(m.indexOf('if(insErr){'));
  assert.ok(e.indexOf(".eq('storage_path',storagePath)")!==-1&&e.indexOf('if(existe)return')<e.indexOf('remove([storagePath])'));
  assert.match(e,/if\(existe===false\)\{try\{await supabaseClient\.storage/);
  const c=sinComentarios(betweenIn(srcPdf,'function archivarVersionDocumentoV1(doc,opts){','window.archivarVersionDocumentoV1=archivarVersionDocumentoV1;'));
  assert.match(c,/archivandoV1\.has\(id\)\)return archivandoV1\.get\(id\)/);                  // un documento a la vez: doble clic comparte la misma operación
  // listados sin payload; los tipos sin plantilla de envío no ofrecen Enviar
  assert.doesNotMatch(srcPdf,/select\('\*'\)/);
  assert.match(srcPdf,/TIPOS_SIN_ENVIO_V1=\['Receta','Indicaciones','Apto físico','Mensaje a colega'\]/);
  assert.match(srcPdf,/if\(TIPOS_SIN_ENVIO_V1\.includes\(d\?\.document_type\)\)return false;/);
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

test('documentos V1: orden de despliegue seguro (servidor sin la columna source_payload): lecturas degradan, guardar avisa explícito',()=>{
  assert.match(srcPdf,/async function consultarDocsV1\(armar\)\{/);
  const usos=(srcPdf.match(/await consultarDocsV1\(c=>supabaseClient\.from\('cardiolink_patient_documents'\)\.select\(c\)/g)||[]).length;
  assert.equal(usos,4);                                                                       // listas del paciente, de evolución, impresión de HC y sincronización
  assert.doesNotMatch(srcPdf,/select\(COLUMNAS_LISTA_PDF_V1\)/);                              // ninguna lectura depende de la columna sin degradar
  assert.match(srcPdf,/falloColumnaPayloadV1\(e\)\)return \{ok:false,error:'El servidor todavía no admite guardar el contenido editable/);   // guardar: mensaje explícito, nunca en silencio
  const lo=sinComentarios(between('async function documentosSinRespaldoConfirmadoV1(docs){','// true = es seguro eliminar la caché'));
  assert.match(lo,/rr\.error&&\/source_payload\|does not exist\|Could not find\/i\.test\(String\(rr\.error\.message\|\|''\)\)\) rr=await consultaDocs\('source_document_id,source_content_hash,document_type,patient_id'\)/);   // el cierre de sesión sigue con las reglas estrictas de las filas anteriores
});
