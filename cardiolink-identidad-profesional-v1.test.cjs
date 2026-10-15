// Pruebas de contrato (estáticas) de la persistencia de la identidad profesional (hotfix identidad-profesional-persistencia).
// No reemplazan el QA funcional con navegador autenticado ni las pruebas SQL (pending_review_identidad_profesional_v1_tests.sql, que se
// corren contra PostgreSQL real): evitan que una edición futura quite sin querer una guarda crítica. Ejecutar: node --test
const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs');
const path=require('node:path');
const src=fs.readFileSync(path.join(__dirname,'app.js'),'utf8');
const sql=fs.readFileSync(path.join(__dirname,'supabase','migrations','pending_review_identidad_profesional_v1.sql'),'utf8');
const rollback=fs.readFileSync(path.join(__dirname,'supabase','migrations','pending_review_identidad_profesional_v1_rollback.sql'),'utf8');
const prot=fs.readFileSync(path.join(__dirname,'supabase','migrations','pending_review_identidad_profesional_v1_proteccion.sql'),'utf8');
const protRb=fs.readFileSync(path.join(__dirname,'supabase','migrations','pending_review_identidad_profesional_v1_proteccion_rollback.sql'),'utf8');
const sinComentarios=t=>t.replace(/^\s*\/\/.*$/gm,'').replace(/^\s*--.*$/gm,'');
const between=(from,to,t=src)=>{const i=t.indexOf(from);assert.notEqual(i,-1,'no se encontró: '+from);const j=t.indexOf(to,i+from.length);assert.notEqual(j,-1,'no se encontró el fin: '+to);return t.slice(i,j);};
const CAMPOS=['marcaDocumento','logoDocumento','logoDocumentoData','firmaDocumentoData','matriculaNacional','matriculaProvincial','telefonoDocumento','emailDocumento','direccionDocumento','redesDocumento','colorDocumento','mostrarFirmaDocumento'];
const listaDe=t=>[...t.matchAll(/'([A-Za-z]+Documento(?:Data)?|matricula(?:Nacional|Provincial))'/g)].map(m=>m[1]);

test('las 12 claves de identidad son las mismas en el cliente, en la RPC y en cardiolink_config_medico_v1',()=>{
  const js=between('const CAMPOS_IDENTIDAD_V1=[',']');
  assert.deepEqual([...new Set(listaDe(js))].sort(),[...CAMPOS].sort());
  const rpc=between("c_campos  constant text[] := ARRAY[","];",sql);
  assert.deepEqual([...new Set(listaDe(rpc))].sort(),[...CAMPOS].sort());
  const cfg=between("unnest(ARRAY[","]) AS k",between('CREATE OR REPLACE FUNCTION public.cardiolink_config_medico_v1','$f$;',sql));
  assert.deepEqual([...new Set(listaDe(cfg))].sort(),[...CAMPOS].sort());
});

test('RPC: SECURITY DEFINER, autorización sólo por servidor (cardiolink_user_roles + auth.uid), sin rol enviado por el cliente',()=>{
  const f=sinComentarios(between('CREATE FUNCTION public.cardiolink_guardar_identidad_profesional_v1','$function$;',sql));
  assert.match(f,/SECURITY DEFINER/);
  assert.match(f,/SET search_path TO 'pg_catalog', 'public'/);
  assert.match(f,/auth\.uid\(\)/);
  assert.match(f,/FROM public\.cardiolink_user_roles r WHERE r\.user_id=v_uid AND r\.active IS TRUE/);
  assert.match(f,/IF v_rol IN \('owner','admin'\) THEN/);
  assert.match(f,/ELSIF v_rol='medico' THEN/);
  assert.match(f,/v_prof <> p_professional_id/);
  assert.match(f,/Tu rol no puede modificar la identidad profesional/);        // secretaría u otro rol
  assert.doesNotMatch(f,/p_rol|p_role|p_user|p_uid/);                           // ningún rol/usuario llega por parámetro
  assert.match(f,/\(p_professional_id text, p_identity jsonb\)/);
});

test('RPC: bloquea la fila de config, valida que el profesional exista y toca sólo las claves recibidas y permitidas',()=>{
  const f=sinComentarios(between('CREATE FUNCTION public.cardiolink_guardar_identidad_profesional_v1','$function$;',sql));
  assert.match(f,/WHERE a\.id=c_row_id FOR UPDATE/);
  assert.match(f,/c_row_id\s+constant text\s+:= '__cardiolink_config_v1'/);
  assert.match(f,/k <> ALL \(c_campos\)/);                                      // cualquier otra clave => error
  assert.match(f,/El profesional % no existe en la configuración/);
  assert.match(f,/v_nuevo := v_actual \|\| p_identity/);                        // merge: las claves omitidas conservan su valor
  assert.match(f,/jsonb_set\(v_payload, ARRAY\['config','profesionales',v_pos::text\], v_nuevo, false\)/);
  assert.match(f,/updated_at=clock_timestamp\(\)/);
  assert.match(f,/jsonb_typeof\(p_identity->v_k\)<>'boolean'/);                // mostrarFirmaDocumento booleano
  assert.match(f,/colorDocumento debe ser #RRGGBB/);
  assert.doesNotMatch(f,/DELETE\s+FROM|DROP\s|TRUNCATE|INSERT\s+INTO/i);
});

test('RPC: permisos (sin PUBLIC/anon; sólo authenticated) y no se tocan políticas RLS ni tablas',()=>{
  const t=sinComentarios(sql);
  assert.match(t,/REVOKE ALL ON FUNCTION public\.cardiolink_guardar_identidad_profesional_v1\(text,jsonb\) FROM PUBLIC, anon;/);
  assert.match(t,/GRANT EXECUTE ON FUNCTION public\.cardiolink_guardar_identidad_profesional_v1\(text,jsonb\) TO authenticated;/);
  assert.doesNotMatch(t,/CREATE POLICY|DROP POLICY|ALTER POLICY|ALTER TABLE|CREATE TABLE|DROP TABLE|DROP COLUMN/i);
  assert.match(t,/^BEGIN;/m);assert.match(t,/^COMMIT;/m);
  assert.match(rollback,/DROP FUNCTION public\.cardiolink_guardar_identidad_profesional_v1\(text,jsonb\)/);
  assert.doesNotMatch(sinComentarios(rollback),/UPDATE |DELETE |DROP COLUMN|DROP TABLE/i);
});

test('cardiolink_config_medico_v1: la identidad documental sólo se agrega al profesional propio y el resto no cambia',()=>{
  const f=between('CREATE OR REPLACE FUNCTION public.cardiolink_config_medico_v1','$f$;',sql);
  assert.match(f,/CASE WHEN p->>'id' = public\.cardiolink_ctx_prof_v1\(\)/);
  assert.match(f,/ELSE '\{\}'::jsonb END/);
  for(const k of ["'obrasSociales'","'usuarioPropio'","'mensajeria'","'prestaciones',p->'prestaciones'"]) assert.ok(f.includes(k),'falta '+k);
  assert.match(f,/cardiolink_logins_propios_v1\(\)\)\[1\]/);
});

test('cliente: un helper común llama a la RPC, espera la confirmación y NO usa la escritura global de config',()=>{
  const h=sinComentarios(between('function guardarIdentidadProfesionalBackendV1(','// Identidad propia que llega del servidor'));
  assert.match(h,/supabaseClient\.rpc\('cardiolink_guardar_identidad_profesional_v1',\{p_professional_id:pid,p_identity\}\)/);
  assert.match(h,/if\(r\.error\)/);
  assert.match(h,/d\.ok!==true\|\|String\(d\.professionalId\)!==pid/);          // sin confirmación real no hay éxito
  assert.doesNotMatch(h,/guardarConfigEnSupabase298|persist402|persist406|programarSyncSupabase|upsert|\.from\(/);
  // saveConfig() está envuelta (programa guardarConfigEnSupabase298 a los 900 ms): la caché local se escribe directo
  assert.doesNotMatch(h,/saveConfig\(/);
  assert.match(h,/localStorage\.setItem\(storageConfig,JSON\.stringify\(data\)\)/);
  // el profesional local se actualiza únicamente DESPUÉS de la confirmación (después del chequeo de r.error y de d.ok)
  const iConf=h.indexOf('d.ok!==true'),iLoc=h.indexOf('loc[k]=d.identity[k]');
  assert.ok(iConf>0&&iLoc>iConf);
  assert.match(h,/colaIdentidadV1/);                                              // guardados serializados
  assert.match(h,/falta aplicar la migración/);                                   // servidor sin la función: error explícito
});

test('cliente: TODOS los caminos interactivos de identidad (402 y 406) usan el helper y ya no escriben el profesional ni la config global',()=>{
  const caminos={
    'saveDocumentFields402':['  async function saveDocumentFields402(){','  /* Nota interna privada por profesional */'],
    'handleIdentityFile406':['  async function handleIdentityFile406(kind,file){','  async function saveIdentity406(){'],
    'saveIdentity406':['  async function saveIdentity406(){','  async function removeIdentityImage406(kind){'],
    'removeIdentityImage406':['  async function removeIdentityImage406(kind){','  function openOwnIdentity406(){'],
    'uploadOwn406':['  async function uploadOwn406(kind,file){','  async function removeOwnImage406(kind){'],
    'removeOwnImage406 (ownRemoveLogo406/ownRemoveSignature406)':['  async function removeOwnImage406(kind){','  async function saveOwnIdentity406(){'],
    'saveOwnIdentity406':['  async function saveOwnIdentity406(){','  function docsForPatient406(p){'],
  };
  for(const [n,[a,b]] of Object.entries(caminos)){
    const f=sinComentarios(between(a,b));
    assert.match(f,/await guardarIdentidadProfesionalBackendV1\(/,n+' no usa el helper');
    assert.doesNotMatch(f,/persist402\(|persist406\(|guardarConfigEnSupabase298|programarSyncSupabase/,n+' sigue guardando por la vía global');
    assert.doesNotMatch(f,new RegExp('\\bp\\.('+CAMPOS.join('|')+')\\s*='),n+' escribe el profesional local antes de la confirmación');
    assert.match(f,/if\(!r\.ok\)/,n+' no maneja el fallo');
  }
  // los botones de quitar logo/firma del modal propio ya no tienen lógica inline
  assert.match(src,/ownRemoveLogo406'\)\{removeOwnImage406\('logo'\);return;\}/);
  assert.match(src,/ownRemoveSignature406'\)\{removeOwnImage406\('signature'\);return;\}/);
  // no queda ninguna asignación directa de campos de identidad fuera de los valores por defecto de ensure402/ensure406
  const asignaciones=[...sinComentarios(src).matchAll(new RegExp('\\.('+CAMPOS.join('|')+')\\s*=[^=]','g'))].length;
  const porDefecto=[...sinComentarios(src).matchAll(new RegExp('if\\(p\\.('+CAMPOS.join('|')+')===undefined\\)p\\.\\1\\s*=','g'))].length;
  assert.equal(asignaciones-porDefecto,0,'quedan asignaciones directas de campos de identidad (sólo se admiten los valores por defecto de ensure402/ensure406; el helper y la carga del servidor escriben con loc[k])');
});

test('cliente: si el guardado falla se informa el error, no se afirma que se guardó y el profesional local no cambia',()=>{
  for(const [a,b] of [['  async function saveDocumentFields402(){','  /* Nota interna privada por profesional */'],['  async function saveIdentity406(){','  async function removeIdentityImage406(kind){'],['  async function saveOwnIdentity406(){','  function docsForPatient406(p){']]){
    const f=sinComentarios(between(a,b));
    const iFallo=f.search(/if\(!r\.ok\)/),iExito=f.search(/alert\('(Datos profesionales guardados|Identidad profesional guardada|Membrete y firma guardados)/);
    assert.ok(iFallo>0&&iExito>iFallo,'el aviso de éxito debe ir después del manejo del fallo');
    assert.match(f.slice(iFallo,iExito),/return;/);
  }
  assert.match(src,/function errorIdentidad406\(r\)\{alert\('No se pudo guardar la identidad profesional: '\+r\.error\+'\\n\\nNo se guardó ningún cambio\.'\);\}/);
});

test('cliente: el médico recibe al iniciar sesión SOLO su identidad (login/refresh conservan logo y firma)',()=>{
  const c=sinComentarios(between('async function cargarMensajeriaYConfigMedicoV1(){','// Errores TRANSITORIOS'));
  assert.match(c,/if\(String\(p\.id\)===String\(backendPendientesIdentidadV1\?\.professional_id\|\|''\)\) aplicarIdentidadPropiaDesdeServidorV1\(/);
  assert.doesNotMatch(c,/guardarConfigEnSupabase298|upsert/);
  const a=sinComentarios(between('function aplicarIdentidadPropiaDesdeServidorV1(','// Directorio mínimo de destinatarios'));
  assert.match(a,/respaldarIdentidadLocalPreviaV1\(loc,srv\);/);                // primero se respalda, después se reemplaza
  assert.ok(a.indexOf('respaldarIdentidadLocalPreviaV1')<a.indexOf('loc[k]=srv[k]'));
  assert.match(a,/CAMPOS_IDENTIDAD_V1\.forEach\(k=>\{ if\(Object\.prototype\.hasOwnProperty\.call\(srv,k\)\) loc\[k\]=srv\[k\]; \}\)/);
});

test('respaldo de la identidad local previa: se guarda ANTES de que la del servidor la reemplace (médico y owner/admin), sin pisar versiones ya respaldadas',()=>{
  const r=sinComentarios(between('function respaldarIdentidadLocalPreviaV1(','// Identidad propia que llega del servidor'));
  assert.match(r,/cardiolink_identidad_local_respaldo_v1:'\+uid\+':'\+loc\.id/);
  assert.match(r,/\['logoDocumentoData','firmaDocumentoData'\]\.some\(k=>loc\[k\]&&loc\[k\]!==\(srv&&srv\[k\]\)\)/);   // sólo imágenes distintas de las del servidor
  assert.match(r,/reg\.snapshots\.length>=3/);                                      // tope: no se descartan los respaldos anteriores
  assert.doesNotMatch(r,/removeItem|shift\(|splice\(/);                             // nunca se borra un respaldo
  // owner/admin: la config remota reemplaza la local; antes se respalda
  const g=sinComentarios(between('const cfgRemota298=normalizarConfigCritica(','localStorage.setItem(storageConfig'));
  assert.ok(g.indexOf('respaldarIdentidadesLocalesPreviasV1(data,cfgRemota298)')>0&&g.indexOf('respaldarIdentidadesLocalesPreviasV1')<g.indexOf('data=cfgRemota298'));
});

test('protección opcional (2ª migración): trigger sólo sobre la fila de config, decide por el rol efectivo (sin marcador falsificable) y restaura sólo las 12 claves',()=>{
  const t=sinComentarios(prot);
  assert.match(t,/CREATE TRIGGER cardiolink_atenciones_proteger_identidad_v1\s+BEFORE UPDATE ON public\.cardiolink_atenciones\s+FOR EACH ROW WHEN \(OLD\.id = '__cardiolink_config_v1'\)/);
  // la excepción NO depende de ningún GUC/marcador: current_user (no falsificable) identifica a las escrituras de la API
  assert.match(t,/IF current_user NOT IN \('authenticated', 'anon'\) THEN RETURN NEW; END IF;/);
  assert.doesNotMatch(t,/current_setting|set_config|identidad_rpc/);
  assert.doesNotMatch(sinComentarios(sql),/identidad_rpc|set_config/);                  // la migración principal no cambia ni emite marcadores
  assert.match(t,/\(n\.p - c_campos\)/);                                               // se quitan sólo las 12 claves del profesional que ya existía
  assert.deepEqual([...new Set(listaDe(between("c_campos constant text[] := ARRAY[","];",t)))].sort(),[...CAMPOS].sort());
  assert.doesNotMatch(t,/CREATE POLICY|DROP POLICY|ALTER TABLE|ALTER POLICY/i);
  const cab=between('CREATE FUNCTION public.cardiolink_atenciones_proteger_identidad_v1()','AS $function$',t);
  assert.doesNotMatch(cab,/SECURITY DEFINER/);                                           // la función del trigger es SECURITY INVOKER
  assert.match(t,/IF \(SELECT prosecdef FROM pg_proc WHERE oid='public\.cardiolink_atenciones_proteger_identidad_v1\(\)'::regprocedure\) THEN/);   // y la verificación final lo exige
  assert.match(t,/REVOKE ALL ON FUNCTION public\.cardiolink_atenciones_proteger_identidad_v1\(\) FROM PUBLIC, anon, authenticated;/);
  assert.match(sinComentarios(protRb),/DROP TRIGGER IF EXISTS cardiolink_atenciones_proteger_identidad_v1/);
  assert.doesNotMatch(sinComentarios(protRb),/UPDATE |DELETE |DROP COLUMN|DROP TABLE|DROP FUNCTION public\.cardiolink_guardar/i);
});

test('protección: un profesional que una config antigua ya no incluye NO pierde su identidad en silencio (se archiva) y el archivo no se puede falsificar',()=>{
  const t=sinComentarios(prot);
  assert.match(t,/identidadesArchivadas/);
  assert.match(t,/NOT EXISTS \(SELECT 1 FROM jsonb_array_elements\(CASE WHEN jsonb_typeof\(v_new\) = 'array' THEN v_new ELSE '\[\]'::jsonb END\) n\(p\)/);
  // archivo lleno: una 6ª identidad DISTINTA se rechaza con error claro (nunca se descarta en silencio); una ya archivada no cuenta como nueva
  assert.match(t,/CONTINUE WHEN EXISTS \(SELECT 1 FROM jsonb_array_elements\(v_lista\) a\(x\) WHERE a\.x -> 'identidad' = v_ident\);/);
  assert.match(t,/IF jsonb_array_length\(v_lista\) >= 5 THEN\s+RAISE EXCEPTION 'No se guardó la configuración: el profesional % ya no figura/);
  assert.match(t,/USING ERRCODE = '54000'/);
  assert.ok(t.indexOf("jsonb_array_length(v_lista) >= 5")<t.indexOf("v_arch := jsonb_set(v_arch, ARRAY[v_id]"));   // se rechaza ANTES de intentar agregar la 6ª
  assert.doesNotMatch(t,/CONTINUE WHEN[^;]*jsonb_array_length/);                          // ya no hay un CONTINUE que descarte la identidad cuando el archivo está lleno
  assert.match(t,/'archivadoEn'/);assert.match(t,/'archivadoPor', auth\.uid\(\)/);
  assert.match(t,/RAISE EXCEPTION 'Configuración inválida/);                              // config inválida que perdería identidades: se rechaza
  // el archivo se reconstruye siempre desde OLD (el cliente no lo controla)
  assert.match(t,/v_arch0\s+jsonb := CASE WHEN jsonb_typeof\(OLD\.payload #> '\{config,identidadesArchivadas\}'\)/);
  assert.match(t,/NEW\.payload := jsonb_set\(NEW\.payload, '\{config,identidadesArchivadas\}', v_arch, true\)/);
  assert.doesNotMatch(t,/prestaciones|valores|especialidad/i);                           // no toca prestaciones, precios ni especialidades
});

test('rechazo 54000 de la config global: aviso visible y claro, nunca una confirmación de guardado, sin tocar el resto del flujo',()=>{
  const g=sinComentarios(between('async function guardarConfigEnSupabase298(){','window.guardarConfigEnSupabase298='));
  assert.match(g,/if\(esRechazoIdentidadArchivoLlenoV1\(error\)\) mostrarAvisoConfigRechazadaV1\(error\);/);
  assert.match(g,/\}else quitarAvisoConfigRechazadaV1\(\);\s+return !error;/);                 // el resultado sigue siendo !error (false cuando el servidor rechaza)
  assert.doesNotMatch(g,/alert\(/);                                                      // el flujo global no emite ninguna confirmación
  const f=sinComentarios(between('function esRechazoIdentidadArchivoLlenoV1(','// Directorio mínimo de destinatarios'));
  assert.match(f,/String\(error\.code\|\|''\)==='54000'/);
  for(const frase of ['La configuración NO se guardó.','identidad documental','podría perderse','Se requiere intervención administrativa','avisá al administrador del sistema','no están en el servidor']) assert.ok(f.includes(frase),'falta en el aviso: '+frase);
  assert.match(f,/role'\s*,\s*'alert'|setAttribute\('role','alert'\)/);
  assert.doesNotMatch(f,/guardad[oa]\b(?!\.)[^<]*confirm|alert\(/);                      // el aviso no usa alert() ni afirma que se guardó
  assert.match(f,/escapeHtml\(prof\)/);                                                 // el nombre del profesional que viene del servidor se escapa
  // las migraciones SQL no cambian: el cliente sólo interpreta el error de la protección
  assert.match(sinComentarios(prot),/USING ERRCODE = '54000'/);
});

test('sin cambios en la protección global: el médico sigue sin escribir la config compartida',()=>{
  const g=sinComentarios(between('async function guardarConfigEnSupabase298(){','window.guardarConfigEnSupabase298='));
  assert.match(g,/if\(esMedicoBackendV1\(\)\) return false;/);
  assert.match(g,/upsert\(\[\{id:CONFIG_ROW_ID,payload,updated_at:/);
});
