const SUPABASE_URL = "https://tupacclmhaqiahhlttyz.supabase.co";
const SUPABASE_KEY = "sb_publishable_tPUUUmp_cR11FSEiF0vhNw_EXaTvv12";

let supabaseClient = null;

try {
  if (window.supabase && typeof window.supabase.createClient === "function") {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    console.log("Supabase conectado correctamente");
  } else {
    console.warn("Supabase no cargó. CardioLink sigue funcionando en modo local.");
  }
} catch (error) {
  console.error("Error conectando Supabase:", error);
}
let usuarioSupabase = null;
let cargandoDesdeNube = false;
let syncTimer = null;

async function loginSupabase() {
  if (!supabaseClient) return false;

  const sesionActual = await supabaseClient.auth.getSession();

  if (sesionActual?.data?.session?.user) {
    usuarioSupabase = sesionActual.data.session.user;
    console.log("Usuario Supabase ya logueado:", usuarioSupabase.email);
    return true;
  }

  const email = prompt("Email de usuario CardioLink:");
  if (!email) return false;

  const password = prompt("Contraseña de CardioLink:");
  if (!password) return false;

  const { data, error } = await supabaseClient.auth.signInWithPassword({
    email,
    password
  });

  if (error) {
    alert("No se pudo iniciar sesión en Supabase: " + error.message);
    console.error(error);
    return false;
  }

  usuarioSupabase = data.user;
  console.log("Usuario Supabase logueado:", usuarioSupabase.email);
  return true;
}

async function cargarAtencionesDesdeSupabase() {
  if (!supabaseClient || !usuarioSupabase) return;

  const { data: rows, error } = await supabaseClient
    .from("cardiolink_atenciones")
    .select("id, payload, updated_at")
    .order("updated_at", { ascending: false });

  if (error) {
    console.error("Error cargando atenciones desde Supabase:", error);
    alert("No se pudieron cargar las atenciones desde Supabase. La app sigue en modo local.");
    return;
  }

  cargandoDesdeNube = true;
  atenciones = (rows || []).map(row => row.payload);
  localStorage.setItem(storageAtenciones, JSON.stringify(atenciones));
  cargandoDesdeNube = false;

  console.log("Atenciones cargadas desde Supabase:", atenciones.length);
}

function programarSyncSupabase() {
  if (!supabaseClient || !usuarioSupabase || cargandoDesdeNube) return;

  clearTimeout(syncTimer);
  syncTimer = setTimeout(sincronizarAtencionesSupabase, 700);
}

async function sincronizarAtencionesSupabase() {
  if (!supabaseClient || !usuarioSupabase || cargandoDesdeNube) return;

  const rows = atenciones.map(a => ({
    id: String(a.id),
    payload: a,
    updated_at: new Date().toISOString()
  }));

  const { error: deleteError } = await supabaseClient
    .from("cardiolink_atenciones")
    .delete()
    .neq("id", "__nunca__");

  if (deleteError) {
    console.error("Error limpiando tabla Supabase:", deleteError);
    return;
  }

  if (!rows.length) {
    console.log("Supabase sincronizado sin atenciones.");
    return;
  }

  const { error: insertError } = await supabaseClient
    .from("cardiolink_atenciones")
    .insert(rows);

  if (insertError) {
    console.error("Error sincronizando atenciones con Supabase:", insertError);
    alert("No se pudo sincronizar con Supabase. Revisar conexión.");
    return;
  }

  console.log("Supabase sincronizado:", rows.length, "atenciones");
}
const CLAVE_DINERO_PERIODO='matias2026';
const OS_FACTURA_ROGELIO=['IOMA','OSDE','Sancor','Prevención Salud','OSPRERA'];
const FILTRO_FACTURA_ROGELIO='__FACTURA_ROGELIO__';
let mostrarConteoDashboard=false;
const storageConfig='cardiolink_config_v25';
const storageAtenciones='cardiolink_atenciones_v25';

const defaults={
 profesionales:[
  {id:'general',nombre:'Vista General / Administración',area:'Todos los profesionales',prestaciones:[],valores:{consulta:0,electro:0,estudio:0}},
  {id:'matias',nombre:'Dr. Matías Anchorena',area:'Cardiología / Medicina Crítica',prestaciones:['Consulta','Electrocardiograma','ECG','Ecocardiograma Doppler','Holter','MAPA','Consulta + ECG','Consulta + Eco'],valores:{consulta:35000,electro:35000,estudio:60000}},
  {id:'rogelio',nombre:'Dr. Rogelio Anchorena',area:'Cardiología',prestaciones:['Consulta','Electrocardiograma','ECG','Ecocardiograma Doppler','Holter','MAPA','Consulta + ECG','Consulta + Eco'],valores:{consulta:35000,electro:35000,estudio:60000}},
  {id:'humberto_drago',nombre:'Dr. Fernández Drago Humberto',area:'Diagnóstico por Imágenes',prestaciones:['Ecografía abdominal','Ecografía renal','Ecografía tiroidea','Ecografía mamaria','Doppler arterial','Doppler venoso','Mamografía'],valores:{consulta:0,electro:0,estudio:60000}},
  {id:'lucas_drago',nombre:'Dr. Drago Lucas',area:'Diagnóstico por Imágenes',prestaciones:['Ecografía abdominal','Ecografía renal','Ecografía tiroidea','Ecografía mamaria','Doppler arterial','Doppler venoso','Mamografía'],valores:{consulta:0,electro:0,estudio:60000}}
 ],
 obrasSociales:['Particular','OSDE','Swiss Medical','Medicus','Galeno','Omint','William Hope','Banco Provincia','OSMATA','OSPEGYPE','OSPE','Medifé','Luz Médica','OPIM / Ensalud','IOMA','OSPRERA','Sancor','Prevención Salud','Integral','Otra'],
 reglasOS:{'IOMA':'IOMA_OSPRERA','OSPRERA':'IOMA_OSPRERA','OSDE':'OSDE','Sancor':'SANCOR_PREVENCION','Prevención Salud':'SANCOR_PREVENCION','Integral':'INTEGRAL'}
};

let data=loadConfig();
let atenciones=loadAtenciones();
let editandoId=null;
let guardarYContinuar=false;
const $=id=>document.getElementById(id);

function loadConfig(){return JSON.parse(localStorage.getItem(storageConfig)) || structuredClone(defaults)}
function loadAtenciones(){
 const current=JSON.parse(localStorage.getItem(storageAtenciones) || 'null');
 if(current) return current;
 const oldKeys=['cardiolink_atenciones_v14','cardiolink_atenciones_v13','cardiolink_atenciones_v12','cardiolink_atenciones_v11'];
 for(const k of oldKeys){const v=JSON.parse(localStorage.getItem(k)||'null'); if(v&&Array.isArray(v)) return v}
 return [];
}
function saveConfig(){localStorage.setItem(storageConfig,JSON.stringify(data))}
function saveAtenciones(){
  localStorage.setItem(storageAtenciones, JSON.stringify(atenciones));
  programarSyncSupabase();
}
function todayISO(){const d=new Date();const off=d.getTimezoneOffset()*60000;return new Date(d-off).toISOString().slice(0,10)}
function formatFecha(iso){if(!iso)return'';const [y,m,d]=iso.split('-');return `${d}/${m}/${y}`}
function money(n){return '$'+Number(n||0).toLocaleString('es-AR')}
function allPrestaciones(){return [...new Set(data.profesionales.flatMap(p=>p.prestaciones||[]))].sort()}
function perfilObj(){return data.profesionales.find(p=>p.id===$('perfilActivo').value)||data.profesionales[0]}
function profesionalCarga(){return data.profesionales.find(p=>p.id===$('profesional').value)}
function esConsulta(prest){return (prest||'').toLowerCase().includes('consulta')}
function esElectro(prest){const s=(prest||'').toLowerCase();return s.includes('electro')||s==='ecg'||s.includes('ecg')}
function tipoPrest(prest){const s=(prest||'').toLowerCase();if(s.includes('consulta')&&(s.includes('ecg')||s.includes('electro')))return'CONSULTA_ECG';if(s.includes('consulta'))return'CONSULTA';if(s.includes('ecg')||s.includes('electro'))return'ECG';if(s.includes('holter'))return'HOLTER';if(s.includes('mapa'))return'MAPA';if(s.includes('eco'))return'ECO';return'ESTUDIO'}
function getRegla(os){return (data.reglasOS||{})[os]||'GENERAL_CONSULTA_EXTRA'}
function setRegla(os,regla){if(!data.reglasOS)data.reglasOS={};data.reglasOS[os]=regla;saveConfig()}
function escapeHtml(s){return String(s??'').replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;')}
function llenarSelect(sel,items,val=x=>x,txt=x=>x){sel.innerHTML='';items.forEach(i=>{const o=document.createElement('option');o.value=val(i);o.textContent=txt(i);sel.appendChild(o)})}
function llenarTodos(sel,items,label){sel.innerHTML=`<option value="">${label}</option>`;items.forEach(i=>{const o=document.createElement('option');o.value=i;o.textContent=i;sel.appendChild(o)})}

function init(){
 document.body.classList.toggle('dark',localStorage.getItem('cardiolink_dark_v25')==='1');
 refreshSelects(); $('fecha').value=todayISO(); if($('adminDesde')) $('adminDesde').value=todayISO(); if($('adminHasta')) $('adminHasta').value=todayISO(); cambiarPerfil('general'); renderConfig(); actualizarHora(); setInterval(actualizarHora,30000);
 document.querySelectorAll('.nav').forEach(b=>b.addEventListener('click',()=>showSection(b.dataset.section)));
 $('btnDark').addEventListener('click',()=>{document.body.classList.toggle('dark');localStorage.setItem('cardiolink_dark_v25',document.body.classList.contains('dark')?'1':'0')});
 $('btnIrCarga').addEventListener('click',()=>showSection('carga'));
$('btnToggleConteo').addEventListener('click',()=>{mostrarConteoDashboard=!mostrarConteoDashboard;renderStats();});
 $('perfilActivo').addEventListener('change',e=>cambiarPerfil(e.target.value));
 ['profesional','obraSocial','prestacion'].forEach(id=>$(id).addEventListener('change',()=>{if(id==='profesional')actualizarPrestaciones();aplicarRegla();calcularCajaCarga()}));
 ['tipoCobro','formaPago','montoConsulta','montoEstudio','montoCopago'].forEach(id=>$(id).addEventListener('input',calcularCajaCarga));
 $('formAtencion').addEventListener('submit',guardarAtencion);
 $('btnGuardarNuevo').addEventListener('click',()=>{guardarYContinuar=true;$('formAtencion').requestSubmit()});
 $('btnNuevoRegistro').addEventListener('click',()=>{limpiarForm();showSection('carga')});
 $('btnLimpiar').addEventListener('click',limpiarForm);
 $('btnHoy').addEventListener('click',()=>{const h=todayISO();$('fDesde').value=h;$('fHasta').value=h;renderTabla()});
 $('btnMes').addEventListener('click',()=>{const d=new Date();const y=d.getFullYear();const m=String(d.getMonth()+1).padStart(2,'0');$('fDesde').value=`${y}-${m}-01`;$('fHasta').value=todayISO();renderTabla()});
 $('btnPeriodo20').addEventListener('click',setPeriodo20);
 $('btnFiltrar').addEventListener('click',renderTabla);
 $('btnResetFiltros').addEventListener('click',resetFiltros);
 $('btnPrint').addEventListener('click',()=>{setPrintMeta();document.body.classList.toggle('print-money',!!$('incluirValoresImpresion')?.checked);window.print();setTimeout(()=>document.body.classList.remove('print-money'),500)});
 $('btnExportExcel').addEventListener('click',exportarCSV);
 $('btnVerDineroPeriodo').addEventListener('click',verDineroPeriodo);
 $('btnOcultarDineroPeriodo').addEventListener('click',ocultarDineroPeriodo);
 $('btnGuardarValores').addEventListener('click',guardarValores);
 $('cfgProfesionalValores').addEventListener('change',cargarValoresConfig);
 $('cfgReglaOS').addEventListener('change',cargarReglaConfig);
 $('btnGuardarReglaOS').addEventListener('click',guardarReglaConfig);
 $('btnAddProfesional').addEventListener('click',addProfesional);
 $('btnAddOS').addEventListener('click',addOS);
 $('btnAddPrestacion').addEventListener('click',addPrestacion);
 $('btnExportBackup').addEventListener('click',exportarBackup);
 $('btnImportBackup').addEventListener('click',importarBackup);
 $('btnBorrarDatos').addEventListener('click',()=>{if(confirm('¿Borrar atenciones?')){atenciones=[];saveAtenciones();renderTabla();renderStats()}});
 renderTabla(); renderStats();
}
function refreshSelects(){
 llenarSelect($('perfilActivo'),data.profesionales,p=>p.id,p=>p.nombre);
 llenarSelect($('profesional'),data.profesionales.filter(p=>p.id!=='general'),p=>p.id,p=>p.nombre);
 llenarSelect($('obraSocial'),data.obrasSociales);
 llenarTodos($('fOS'),data.obrasSociales,'Todas las OS');
const optFacturaRogelio=document.createElement('option');
optFacturaRogelio.value=FILTRO_FACTURA_ROGELIO;
optFacturaRogelio.textContent='Factura Rogelio';
$('fOS').appendChild(optFacturaRogelio);
 llenarTodos($('fProfesional'),data.profesionales.filter(p=>p.id!=='general').map(p=>p.nombre),'Todos los médicos');
 llenarTodos($('fPrestacion'),allPrestaciones(),'Todas las prestaciones');
 llenarSelect($('profPrestacion'),data.profesionales.filter(p=>p.id!=='general'),p=>p.id,p=>p.nombre);
 llenarSelect($('cfgProfesionalValores'),data.profesionales.filter(p=>p.id!=='general'),p=>p.id,p=>p.nombre);
 llenarSelect($('cfgReglaOS'),data.obrasSociales);
}
function showSection(id){document.querySelectorAll('.section').forEach(s=>s.classList.remove('visible'));$(id).classList.add('visible');document.querySelectorAll('.nav').forEach(b=>b.classList.toggle('active',b.dataset.section===id))}
function cambiarPerfil(id){$('perfilActivo').value=id;const p=perfilObj();$('tituloBienvenida').textContent=p.id==='general'?'Vista General / Administración':`Bienvenido ${p.nombre}`;$('subtituloPerfil').textContent=p.area;$('profesional').value=p.id==='general'?'matias':p.id;actualizarPrestaciones();aplicarRegla();renderTabla();renderStats()}
function actualizarHora(){const a=new Date();$('fechaHoraPanel').textContent=a.toLocaleDateString('es-AR',{weekday:'long',day:'2-digit',month:'2-digit',year:'numeric'})+' · '+a.toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'})}
function actualizarPrestaciones(){const p=profesionalCarga();llenarSelect($('prestacion'),p?.prestaciones?.length?p.prestaciones:allPrestaciones())}
function valorPrestacionActual(){const p=profesionalCarga();const prest=$('prestacion').value;if(!p)return 0;if(esConsulta(prest))return Number(p.valores?.consulta||0);if(esElectro(prest))return Number(p.valores?.electro||0);return Number(p.valores?.estudio||0)}

function aplicarRegla(){
 const os=$('obraSocial').value, prof=$('profesional').value, prest=$('prestacion').value, t=tipoPrest(prest), regla=getRegla(os);
 $('consultaA').value='Matías'; $('prestacionA').value=prof==='rogelio'?'Rogelio':'Matías'; $('facturador').value=prof==='rogelio'?'Rogelio':'Matías';
 $('tipoCobro').value='Sin cobro en caja'; $('formaPago').value='No aplica'; $('montoConsulta').value=''; $('montoEstudio').value=''; $('montoCopago').value='';
 $('bonoConsulta').checked=false; $('bonoEstudio').checked=false; $('copiaImpresa').checked=false;
 let info=`Regla automática: ${regla}.`;
 if(os==='Particular'){ $('tipoCobro').value='Particular';$('formaPago').value='Efectivo';$('facturador').value='Particular'; if(esConsulta(prest))$('montoConsulta').value=valorPrestacionActual(); else $('montoEstudio').value=valorPrestacionActual(); info=`Particular: ${money(valorPrestacionActual())}.`; }
 else if(prof==='matias'&&regla==='IOMA_OSPRERA'){
  $('consultaA').value='Matías'; $('facturador').value='Fold2 / FEMEBA'; $('tipoCobro').value='Copago'; $('formaPago').value='Efectivo';
  if(t==='CONSULTA'){ $('prestacionA').value='No aplica';$('montoCopago').value=35000;$('bonoConsulta').checked=true;info=`${os}: consulta a Fold2/Matías + copago $35.000.`; }
  else if(t==='ECG'||t==='CONSULTA_ECG'){ $('prestacionA').value='Rogelio';$('montoCopago').value=35000;$('bonoConsulta').checked=true;$('bonoEstudio').checked=true;info=`${os}: consulta a Matías, ECG a Rogelio + copago $35.000.`; }
  else { $('prestacionA').value='Rogelio';$('montoCopago').value=50000;$('bonoConsulta').checked=true;$('bonoEstudio').checked=true;info=`${os}: consulta a Matías/Fold2, estudio como Holter a Rogelio + copago $50.000.`; }
 } else if(prof==='matias'&&regla==='OSDE'){
  $('consultaA').value='Matías'; if(t==='CONSULTA'){ $('prestacionA').value='No aplica';$('facturador').value='Matías';$('bonoConsulta').checked=true;info='OSDE: consulta a Matías.'; }
  else { $('prestacionA').value='Rogelio';$('facturador').value='Rogelio';$('bonoConsulta').checked=true;$('bonoEstudio').checked=true;info='OSDE: consulta a Matías + estudio como Holter a Rogelio.'; }
 } else if(prof==='matias'&&regla==='SANCOR_PREVENCION'){
  $('consultaA').value='Matías'; if(t==='CONSULTA'){ $('prestacionA').value='No aplica';$('bonoConsulta').checked=true;info=`${os}: consulta a Matías.`; }
  else { $('prestacionA').value='Rogelio';$('facturador').value='Rogelio';$('bonoConsulta').checked=true;$('bonoEstudio').checked=true;info=`${os}: consulta a Matías + estudio a Rogelio.`; }
 } else if(prof==='matias'&&regla==='INTEGRAL'){
  $('consultaA').value='Matías';$('prestacionA').value='Matías';$('facturador').value='Matías'; if(t==='CONSULTA'){$('bonoConsulta').checked=true;info='Integral: consulta a Matías.';} else {$('bonoEstudio').checked=true;info='Integral: estudio a Matías, sin consulta extra.';}
 } else if(prof==='matias'&&regla==='GENERAL_CONSULTA_EXTRA'){
  $('consultaA').value='Matías';$('prestacionA').value='Matías';$('facturador').value='Matías'; if(t==='CONSULTA'){$('bonoConsulta').checked=true;} else {$('bonoConsulta').checked=true;$('bonoEstudio').checked=true;} info=`${os}: regla general.`;
 }
 $('reglaInfo').textContent=info; calcularCajaCarga();
}
function calcularCajaCarga(){const tipo=$('tipoCobro').value;let total=0;const part=Number($('montoConsulta').value||0)+Number($('montoEstudio').value||0);const cop=Number($('montoCopago').value||0);if(tipo.includes('Particular'))total+=part;if(tipo.includes('Copago')||tipo.includes('copago'))total+=cop;$('montoTotal').value=total}
function limpiarForm(){$('formAtencion').reset();$('fecha').value=todayISO();const p=perfilObj();$('profesional').value=p.id==='general'?'matias':p.id;actualizarPrestaciones();aplicarRegla()}

function guardarAtencion(e){
 e.preventDefault(); calcularCajaCarga(); const prof=profesionalCarga();
 const a={id:Date.now(),fecha:$('fecha').value,paciente:$('paciente').value.trim(),dni:$('dni').value.trim(),obraSocial:$('obraSocial').value,profesionalId:$('profesional').value,profesional:prof?.nombre||'',prestacion:$('prestacion').value,consultaA:$('consultaA').value,prestacionA:$('prestacionA').value,facturador:$('facturador').value,tipoCobro:$('tipoCobro').value,formaPago:$('formaPago').value,cajaPerfil:$('profesional').value,reglaOS:getRegla($('obraSocial').value),montoConsulta:Number($('montoConsulta').value||0),montoEstudio:Number($('montoEstudio').value||0),montoCopago:Number($('montoCopago').value||0),montoTotal:Number($('montoTotal').value||0),bonoConsulta:$('bonoConsulta').checked,bonoEstudio:$('bonoEstudio').checked,bonoFirmado:$('bonoFirmado').checked,copiaImpresa:$('copiaImpresa').checked,requiereCopiaImpresa:$('bonoEstudio').checked,fold2:$('fold2').checked,planilla:$('planilla').checked,observaciones:$('observaciones').value.trim()};
 atenciones.push(a);saveAtenciones();renderTabla();renderStats();limpiarForm();if(guardarYContinuar){guardarYContinuar=false;showSection('carga');setTimeout(()=>$('paciente').focus(),50)}else showSection('listado')
}


function esRegistroFacturaRogelio(a){
  return OS_FACTURA_ROGELIO.includes(a.obraSocial) && a.prestacionA==='Rogelio' && tipoPrest(a.prestacion)!=='CONSULTA';
}
function resumenFacturaRogelio(datos){
  const porOS={};
  OS_FACTURA_ROGELIO.forEach(os=>porOS[os]=0);
  datos.filter(esRegistroFacturaRogelio).forEach(a=>{porOS[a.obraSocial]=(porOS[a.obraSocial]||0)+1;});
  const total=Object.values(porOS).reduce((s,n)=>s+n,0);
  return {porOS,total};
}
function facturaRogelioHTML(datos){
  const r=resumenFacturaRogelio(datos);
  if(r.total===0) return '';
  const partes=Object.entries(r.porOS).filter(([os,n])=>n>0).map(([os,n])=>`${os}: ${n}`).join(' | ');
  return `<div class="factura-rogelio-box"><strong>Factura Rogelio</strong>${partes} | <strong>Total estudios: ${r.total}</strong></div>`;
}
function actualizarResumenFacturaRogelio(datos){
  let box=document.getElementById('facturaRogelioResumenBox');
  const printArea=document.getElementById('printArea');
  if(!box && printArea){
    box=document.createElement('div');
    box.id='facturaRogelioResumenBox';
    const tabla=printArea.querySelector('table');
    printArea.insertBefore(box,tabla);
  }
  if(!box)return;
  box.innerHTML = $('fOS').value===FILTRO_FACTURA_ROGELIO ? facturaRogelioHTML(datos) : '';
}

function atencionesPerfil(){const p=perfilObj();if(p.id==='general')return atenciones;if(p.id==='matias')return atenciones.filter(a=>a.profesionalId==='matias'||a.consultaA==='Matías'||a.prestacionA==='Matías');if(p.id==='rogelio')return atenciones.filter(a=>a.profesionalId==='rogelio'||a.consultaA==='Rogelio'||a.prestacionA==='Rogelio');return atenciones.filter(a=>a.profesionalId===p.id)}
function filtrar(){const desde=$('fDesde').value,hasta=$('fHasta').value,os=$('fOS').value,prof=$('fProfesional').value,prest=$('fPrestacion').value,pac=$('fPaciente').value.toLowerCase().trim(),dest=$('fDestino').value;return atencionesPerfil().filter(a=>{if(desde&&a.fecha<desde)return false;if(hasta&&a.fecha>hasta)return false;if(os===FILTRO_FACTURA_ROGELIO && !esRegistroFacturaRogelio(a))return false;if(os&&os!==FILTRO_FACTURA_ROGELIO&&a.obraSocial!==os)return false;if(prof&&a.profesional!==prof)return false;if(prest&&a.prestacion!==prest)return false;if(pac&&!String(a.paciente||'').toLowerCase().includes(pac))return false;if(dest&&a.consultaA!==dest&&a.prestacionA!==dest)return false;return true}).sort((a,b)=>(b.fecha||'').localeCompare(a.fecha||''))}
function consultaComputada(a){const t=tipoPrest(a.prestacion),r=a.reglaOS||getRegla(a.obraSocial);if(t==='CONSULTA'||t==='CONSULTA_ECG')return true;if(t==='ECG'&&r==='IOMA_OSPRERA')return true;if(t!=='CONSULTA'){return ['GENERAL_CONSULTA_EXTRA','SANCOR_PREVENCION','IOMA_OSPRERA','OSDE'].includes(r)}return !!a.bonoConsulta}
function resumen(datos){return datos.reduce((r,a)=>{if(consultaComputada(a))r.consultas++;if(tipoPrest(a.prestacion)!=='CONSULTA')r.estudios++;if(a.bonoConsulta||consultaComputada(a))r.bonoConsulta++;if(a.bonoEstudio||tipoPrest(a.prestacion)!=='CONSULTA')r.bonoEstudio++;const particular=Number(a.montoConsulta||0)+Number(a.montoEstudio||0);const copago=Number(a.montoCopago||0);r.particular+=particular;r.copago+=copago;r.total+=particular+copago;return r},{consultas:0,estudios:0,bonoConsulta:0,bonoEstudio:0,particular:0,copago:0,total:0})}
function dineroVisible(a){const p=perfilObj(),cp=a.cajaPerfil||a.profesionalId;if(p.id==='rogelio'&&cp!=='rogelio')return {particular:0,copago:0,total:0};if(p.id==='matias'&&cp!=='matias')return {particular:0,copago:0,total:0};const particular=Number(a.montoConsulta||0)+Number(a.montoEstudio||0);const copago=Number(a.montoCopago||0);return {particular,copago,total:particular+copago}}
function cajaHoy(datos){return datos.filter(a=>a.fecha===todayISO()).reduce((r,a)=>{const m=dineroVisible(a);r.particular+=m.particular;r.copago+=m.copago;r.total+=m.total;return r},{particular:0,copago:0,total:0})}
function evaluarEstado(a){const f=new Set();if((a.bonoConsulta||a.bonoEstudio)&&!a.bonoFirmado)f.add('firma');if((a.bonoEstudio||a.requiereCopiaImpresa)&&!a.copiaImpresa)f.add('copia');return f.size?{txt:'Falta: '+Array.from(f).join(' + '),cls:'bad'}:{txt:'OK',cls:'ok'}}

function prestacionContable(a){const r=a.reglaOS||getRegla(a.obraSocial);if(perfilObj().id==='rogelio'&&a.prestacionA==='Rogelio'&&['OSDE','IOMA_OSPRERA'].includes(r)&&tipoPrest(a.prestacion)!=='CONSULTA')return 'Holter';return a.prestacion}
function renderTabla(){const tbody=$('tablaAtenciones');tbody.innerHTML='';const datos=filtrar();renderResumenCaja(datos);actualizarResumenFacturaRogelio(datos);if(!datos.length){tbody.innerHTML='<tr><td colspan="14">No hay registros para mostrar.</td></tr>';return}datos.forEach(a=>{const e=evaluarEstado(a),m=dineroVisible(a),part=m.particular;const tr=document.createElement('tr');if(editandoId===a.id){tr.className='edit-row';tr.innerHTML=`<td><input type="date" id="e_fecha_${a.id}" value="${a.fecha||''}"></td><td><input id="e_paciente_${a.id}" value="${escapeHtml(a.paciente)}"><input id="e_obs_${a.id}" value="${escapeHtml(a.observaciones||'')}" placeholder="Obs."></td><td>${selectHTML('e_os_'+a.id,data.obrasSociales,a.obraSocial)}</td><td>${selectProfesionalesHTML('e_prof_'+a.id,a.profesionalId)}</td><td>${selectPrestacionesHTML('e_prest_'+a.id,a.profesionalId,a.prestacion)}</td><td>${selectHTML('e_consultaA_'+a.id,['Matías','Rogelio','No aplica','A definir'],a.consultaA)}</td><td>${selectHTML('e_prestacionA_'+a.id,['Matías','Rogelio','No aplica','A definir'],a.prestacionA)}</td><td>${selectHTML('e_tipoCobro_'+a.id,['Sin cobro en caja','Copago','Particular','Particular + copago'],a.tipoCobro)}<div class="inline-checks-edit"><label><input type="checkbox" id="e_bonoConsulta_${a.id}" ${a.bonoConsulta?'checked':''}> Bono consulta</label><label><input type="checkbox" id="e_bonoEstudio_${a.id}" ${a.bonoEstudio?'checked':''}> Bono estudio</label><label><input type="checkbox" id="e_bonoFirmado_${a.id}" ${a.bonoFirmado?'checked':''}> Bono firmado</label><label><input type="checkbox" id="e_copiaImpresa_${a.id}" ${a.copiaImpresa?'checked':''}> Copia</label><label><input type="checkbox" id="e_fold2_${a.id}" ${a.fold2?'checked':''}> Fold2</label><label><input type="checkbox" id="e_planilla_${a.id}" ${a.planilla?'checked':''}> Planilla</label></div></td><td>${selectHTML('e_formaPago_'+a.id,['No aplica','Efectivo','Transferencia','Mixto'],a.formaPago||'No aplica')}</td><td><input type="number" id="e_particular_${a.id}" value="${Number(a.montoConsulta||0)+Number(a.montoEstudio||0)}"></td><td><input type="number" id="e_copago_${a.id}" value="${Number(a.montoCopago||0)}"></td><td>${money(a.montoTotal)}</td><td class="estado-cell"><span class="badge ${e.cls}">${e.txt}</span></td><td class="no-print actions-cell"><div class="edit-actions"><button class="small-btn" onclick="guardarEdicion(${a.id})">Guardar</button><button class="small-btn" onclick="cancelarEdicion()">Cancelar</button></div></td>`}else{const admin=`${a.bonoConsulta?'Bono consulta<br>':''}${a.bonoEstudio?'Bono estudio<br>':''}${a.bonoFirmado?'Firmado<br>':''}${a.copiaImpresa?'Copia<br>':''}`;tr.innerHTML=`<td>${formatFecha(a.fecha)}</td><td><strong>${escapeHtml(a.paciente)}</strong>${a.observaciones?'<br><small>'+escapeHtml(a.observaciones)+'</small>':''}</td><td>${a.obraSocial}</td><td>${a.profesional}</td><td>${prestacionContable(a)}</td><td>${a.consultaA}</td><td>${a.prestacionA}</td><td>${a.tipoCobro||''}${admin?'<br><small>'+admin+'</small>':''}</td><td>${a.formaPago||'No aplica'}</td><td class="money-col">${money(part)}</td><td class="money-col">${money(m.copago)}</td><td class="money-col">${money(m.total)}</td><td class="estado-cell"><span class="badge ${e.cls}">${e.txt}</span></td><td class="no-print actions-cell"><div class="edit-actions"><button onclick="editarAtencion(${a.id})">Editar</button><button onclick="eliminarAtencion(${a.id})">Borrar</button></div></td>`}tbody.appendChild(tr)})}
function renderResumenCaja(datos=filtrar()){const r=resumen(datos),c=cajaHoy(datos);$('rConsultas').textContent=r.consultas;$('rEstudios').textContent=r.estudios;$('rBonoConsulta').textContent=r.bonoConsulta;$('rBonoEstudio').textContent=r.bonoEstudio;$('rParticular').textContent=money(c.particular);$('rCopago').textContent=money(c.copago);$('rTotal').textContent=money(c.total)}
function renderStats(){const datos=atencionesPerfil(),c=cajaHoy(datos);$('statTotal').textContent=mostrarConteoDashboard?datos.length:'•••';if($('btnToggleConteo'))$('btnToggleConteo').textContent=mostrarConteoDashboard?'Ocultar':'Mostrar';$('statHoy').textContent=datos.filter(a=>a.fecha===todayISO()).length;$('statPendientes').textContent=datos.filter(a=>evaluarEstado(a).cls==='bad').length;$('statParticular').textContent=money(c.particular);$('statCopagos').textContent=money(c.copago);$('statTotalCaja').textContent=money(c.total);$('dashboardDetalle').textContent='Caja visible solo del día. Dinero de período solo con perfil Matías + clave.'}

function selectHTML(id,items,selected){return `<select id="${id}">`+items.map(x=>`<option ${x===selected?'selected':''}>${escapeHtml(x)}</option>`).join('')+'</select>'}
function selectProfesionalesHTML(id,selected){return `<select id="${id}">`+data.profesionales.filter(p=>p.id!=='general').map(p=>`<option value="${p.id}" ${p.id===selected?'selected':''}>${escapeHtml(p.nombre)}</option>`).join('')+'</select>'}
function selectPrestacionesHTML(id,prof,selected){const p=data.profesionales.find(x=>x.id===prof);const items=p?.prestaciones?.length?p.prestaciones:allPrestaciones();return selectHTML(id,items,selected)}
function editarAtencion(id){editandoId=id;renderTabla()}function cancelarEdicion(){editandoId=null;renderTabla()}
function guardarEdicion(id){const a=atenciones.find(x=>x.id===id);if(!a)return;const profId=$('e_prof_'+id).value,prof=data.profesionales.find(p=>p.id===profId),prest=$('e_prest_'+id).value,tipo=$('e_tipoCobro_'+id).value,part=Number($('e_particular_'+id).value||0),cop=Number($('e_copago_'+id).value||0);let total=0;if(tipo.includes('Particular'))total+=part;if(tipo.includes('Copago')||tipo.includes('copago'))total+=cop;a.fecha=$('e_fecha_'+id).value;a.paciente=$('e_paciente_'+id).value.trim();a.observaciones=$('e_obs_'+id).value.trim();a.obraSocial=$('e_os_'+id).value;a.profesionalId=profId;a.profesional=prof?.nombre||'';a.prestacion=prest;a.consultaA=$('e_consultaA_'+id).value;a.prestacionA=$('e_prestacionA_'+id).value;a.tipoCobro=tipo;a.formaPago=$('e_formaPago_'+id).value;a.cajaPerfil=profId;a.montoConsulta=esConsulta(prest)?part:0;a.montoEstudio=esConsulta(prest)?0:part;a.montoCopago=cop;a.montoTotal=total;a.bonoConsulta=$('e_bonoConsulta_'+id).checked;a.bonoEstudio=$('e_bonoEstudio_'+id).checked;a.bonoFirmado=$('e_bonoFirmado_'+id).checked;a.copiaImpresa=$('e_copiaImpresa_'+id).checked;a.requiereCopiaImpresa=a.bonoEstudio;a.fold2=$('e_fold2_'+id).checked;a.planilla=$('e_planilla_'+id).checked;a.reglaOS=getRegla(a.obraSocial);saveAtenciones();editandoId=null;renderTabla();renderStats()}
function eliminarAtencion(id){if(!confirm('¿Borrar esta atención?'))return;atenciones=atenciones.filter(a=>a.id!==id);saveAtenciones();renderTabla();renderStats()}

function setPeriodo20(){const d=new Date();let y=d.getFullYear(),m=d.getMonth()+1,day=d.getDate(),dy=y,dm=m,hy=y,hm=m+1;if(day<20){dm=m-1;hm=m}if(dm<1){dm=12;dy--}if(hm>12){hm=1;hy++}$('fDesde').value=`${dy}-${String(dm).padStart(2,'0')}-20`;$('fHasta').value=`${hy}-${String(hm).padStart(2,'0')}-20`;renderTabla()}
function resetFiltros(){$('fDesde').value='';$('fHasta').value='';$('fOS').value='';$('fProfesional').value='';$('fPrestacion').value='';$('fPaciente').value='';$('fDestino').value='';renderTabla()}
function verDineroPeriodo(){
  const res=$('dineroPeriodoResultado');
  if(perfilObj().id!=='matias'){
    res.textContent='Acceso administrativo no habilitado para este perfil.';
    return;
  }
  if($('claveDinero').value!==CLAVE_DINERO_PERIODO){
    res.textContent='Clave administrador incorrecta.';
    return;
  }

  const desde=$('adminDesde')?.value || $('fDesde').value || '';
  const hasta=$('adminHasta')?.value || $('fHasta').value || todayISO();

  let datos=atencionesPerfil().filter(a=>{
    if(desde && a.fecha < desde) return false;
    if(hasta && a.fecha > hasta) return false;
    return true;
  });

  const r=resumen(datos);
  const desdeTxt=desde ? formatFecha(desde) : 'inicio';
  const hastaTxt=hasta ? formatFecha(hasta) : 'hoy';

  res.textContent=`Resumen administrativo (${desdeTxt} a ${hastaTxt}) — Particular ${money(r.particular)} | Copagos ${money(r.copago)} | Total ${money(r.total)} | Registros ${datos.length}`;
}
function ocultarDineroPeriodo(){$('dineroPeriodoResultado').textContent='';$('claveDinero').value=''}
function setPrintMeta(){$('printMeta').textContent=`Perfil: ${perfilObj().nombre} | Registros: ${filtrar().length} | ${formatFecha(todayISO())}`}
function exportarCSV(){const datos=filtrar();if(!datos.length){alert('No hay datos');return}const r=resumen(datos);const incluirValoresExport=!!$('incluirValoresImpresion')?.checked;const filas=[['CardioLink Admin v2.5.5'],['Perfil',perfilObj().nombre],['Consultas',r.consultas],['Estudios',r.estudios],[],['Fecha','Paciente','OS','Profesional','Prestación','Consulta a','Estudio a','Tipo','Forma','Particular visible','Copago visible','Total visible','Estado']];datos.forEach(a=>{const m=dineroVisible(a),e=evaluarEstado(a);filas.push([formatFecha(a.fecha),a.paciente,a.obraSocial,a.profesional,prestacionContable(a),a.consultaA,a.prestacionA,a.tipoCobro,a.formaPago,incluirValoresExport?m.particular:'',incluirValoresExport?m.copago:'',incluirValoresExport?m.total:'',e.txt])});const csv=filas.map(r=>r.map(c=>`"${String(c??'').replaceAll('"','""')}"`).join(';')).join('\n');const blob=new Blob(['\ufeff'+csv],{type:'text/csv'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='CardioLink_listado.csv';a.click()}
function exportarBackup(){const b={app:'CardioLink Admin',version:'2.5.5',fechaExportacion:new Date().toISOString(),config:data,atenciones};const blob=new Blob([JSON.stringify(b,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='CardioLink_Admin_backup.json';a.click()}
function importarBackup(){const inp=$('inputImportBackup');if(!inp.files[0]){alert('Elegí archivo');return}if(!confirm('Reemplaza la base actual. ¿Continuar?'))return;const rd=new FileReader();rd.onload=e=>{try{const b=JSON.parse(e.target.result);if(!b.config||!b.atenciones)throw new Error();data=b.config;atenciones=b.atenciones;saveConfig();saveAtenciones();refreshSelects();renderConfig();cambiarPerfil('general');alert('Backup importado')}catch{alert('Backup inválido')}};rd.readAsText(inp.files[0])}
function renderConfig(){cargarValoresConfig();cargarReglaConfig();$('listaProfesionales').innerHTML=data.profesionales.map(p=>`<li><strong>${p.nombre}</strong> — ${p.area} ${p.id!=='general'?`<button class="small-btn" onclick="delProfesional('${p.id}')">Borrar</button>`:''}</li>`).join('');$('listaOS').innerHTML=data.obrasSociales.map(o=>`<li>${o} <button class="small-btn" onclick="delOS('${escapeHtml(o)}')">Borrar</button></li>`).join('');$('listaPrestaciones').innerHTML=allPrestaciones().map(p=>`<li>${p} <button class="small-btn" onclick="delPrestacion('${encodeURIComponent(p)}')">Borrar</button></li>`).join('')}
function cargarValoresConfig(){const p=data.profesionales.find(x=>x.id===$('cfgProfesionalValores').value)||data.profesionales.find(x=>x.id==='matias');$('cfgProfesionalValores').value=p.id;$('cfgConsultaParticular').value=p.valores?.consulta||0;$('cfgElectroParticular').value=p.valores?.electro||0;$('cfgEstudioParticular').value=p.valores?.estudio||0}
function guardarValores(){const p=data.profesionales.find(x=>x.id===$('cfgProfesionalValores').value);p.valores={consulta:Number($('cfgConsultaParticular').value||0),electro:Number($('cfgElectroParticular').value||0),estudio:Number($('cfgEstudioParticular').value||0)};saveConfig();alert('Valores guardados')}
function cargarReglaConfig(){$('cfgTipoRegla').value=getRegla($('cfgReglaOS').value)}
function guardarReglaConfig(){setRegla($('cfgReglaOS').value,$('cfgTipoRegla').value);alert('Regla guardada');aplicarRegla()}
function addProfesional(){const n=$('nuevoProfesional').value.trim();if(!n)return;data.profesionales.push({id:'p_'+Date.now(),nombre:n,area:$('nuevaArea').value.trim()||'Sin definir',prestaciones:[],valores:{consulta:0,electro:0,estudio:0}});saveConfig();refreshSelects();renderConfig()}
function delProfesional(id){if(!confirm('Borrar profesional?'))return;data.profesionales=data.profesionales.filter(p=>p.id!==id);saveConfig();refreshSelects();renderConfig()}
function addOS(){const n=$('nuevaOS').value.trim();if(!n)return;if(!data.obrasSociales.includes(n))data.obrasSociales.push(n);saveConfig();refreshSelects();renderConfig()}
function delOS(n){if(!confirm('Borrar OS?'))return;data.obrasSociales=data.obrasSociales.filter(o=>o!==n);saveConfig();refreshSelects();renderConfig()}
function addPrestacion(){const n=$('nuevaPrestacion').value.trim(),pid=$('profPrestacion').value;if(!n)return;const p=data.profesionales.find(x=>x.id===pid);if(p&&!p.prestaciones.includes(n))p.prestaciones.push(n);saveConfig();refreshSelects();renderConfig();actualizarPrestaciones()}
function delPrestacion(enc){const n=decodeURIComponent(enc);if(!confirm('Borrar prestación de todos los perfiles?'))return;data.profesionales.forEach(p=>p.prestaciones=(p.prestaciones||[]).filter(x=>x!==n));saveConfig();refreshSelects();renderConfig();actualizarPrestaciones()}

window.editarAtencion=editarAtencion;window.guardarEdicion=guardarEdicion;window.cancelarEdicion=cancelarEdicion;window.eliminarAtencion=eliminarAtencion;window.delProfesional=delProfesional;window.delOS=delOS;window.delPrestacion=delPrestacion;
async function iniciarCardioLink() {
  await loginSupabase();
  await cargarAtencionesDesdeSupabase();
  init();
}

iniciarCardioLink();
