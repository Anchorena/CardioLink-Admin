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
const TAMANIO_PAGINA_LISTADO = 50;
let paginaListado = 1;
let modoPendientesGlobal = false;
const INACTIVIDAD_MS = 30 * 60 * 1000;
let timerInactividad = null;

async function loginSupabase() {
  if (!supabaseClient) {
    alert("Supabase no está conectado. Revisar URL, publishable key o script de Supabase.");
    return false;
  }

  const { data: sessionData } = await supabaseClient.auth.getSession();

  if (sessionData?.session?.user) {
    usuarioSupabase = sessionData.session.user;
    console.log("Usuario Supabase ya logueado:", usuarioSupabase.email);
    return true;
  }

  return mostrarPantallaLogin();
}

function mostrarPantallaLogin() {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.id = "loginOverlay";
    overlay.innerHTML = `
  <div class="login-card">
    <div class="login-brand">
      <div class="login-logo">
        <svg viewBox="0 0 220 80" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M5 45 L35 45 L48 45 L58 20 L72 62 L86 35 L100 45 L215 45"
                fill="none"
                stroke="currentColor"
                stroke-width="6"
                stroke-linecap="round"
                stroke-linejoin="round"/>
        </svg>
      </div>

      <h1>CardioLink Admin</h1>
      <p class="login-subtitle">by Matías Anchorena</p>
      <p class="login-meta">Versión 2.5.7 · 2026</p>
    </div>

    <div class="login-fields">
      <label>Usuario</label>
      <input id="loginUsuario" type="text" placeholder="Usuario" autocomplete="username">

      <label>Contraseña</label>
      <input id="loginPassword" type="password" placeholder="Contraseña" autocomplete="current-password">

      <button id="btnLoginCardioLink">Entrar</button>

      <p id="loginError" class="login-error"></p>
    </div>
  </div>
`;

    const style = document.createElement("style");
    style.id = "loginStyle";
  style.textContent = `
  #loginOverlay {
    position: fixed;
    inset: 0;
    z-index: 99999;
    background:
      radial-gradient(circle at top right, rgba(79,70,229,.25), transparent 30%),
      radial-gradient(circle at bottom left, rgba(14,165,233,.20), transparent 30%),
      linear-gradient(135deg, #0b132b, #111c44 55%, #0f172a);
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: Arial, sans-serif;
    padding: 24px;
  }

  .login-card {
    width: 100%;
    max-width: 460px;
    background: rgba(255,255,255,0.96);
    border-radius: 26px;
    padding: 34px 30px 28px;
    box-shadow: 0 24px 80px rgba(0,0,0,.35);
    border: 1px solid rgba(255,255,255,.25);
    backdrop-filter: blur(6px);
  }

  .login-brand {
    text-align: center;
    margin-bottom: 26px;
  }

  .login-logo {
    width: 180px;
    margin: 0 auto 16px;
    color: #2563eb;
  }

  .login-logo svg {
    width: 100%;
    height: auto;
    display: block;
  }

  .login-card h1 {
    margin: 0;
    font-size: 42px;
    line-height: 1.05;
    color: #0f172a;
    font-weight: 800;
    letter-spacing: -1px;
  }

  .login-subtitle {
    margin: 10px 0 4px;
    color: #334155;
    font-size: 19px;
    font-weight: 700;
  }

  .login-meta {
    margin: 0;
    color: #64748b;
    font-size: 14px;
    font-weight: 600;
  }

  .login-fields label {
    display: block;
    margin: 16px 0 7px;
    font-weight: 800;
    color: #1e293b;
    font-size: 15px;
  }

  .login-fields input {
    width: 100%;
    box-sizing: border-box;
    padding: 16px 18px;
    border-radius: 16px;
    border: 2px solid #cbd5e1;
    font-size: 18px;
    color: #0f172a;
    background: #fff;
    outline: none;
    transition: .2s ease;
  }

  .login-fields input:focus {
    border-color: #4f46e5;
    box-shadow: 0 0 0 4px rgba(79,70,229,.12);
  }

  .login-fields button {
    width: 100%;
    margin-top: 24px;
    padding: 17px;
    border: none;
    border-radius: 16px;
    background: linear-gradient(90deg, #4f46e5, #3b82f6);
    color: white;
    font-size: 20px;
    font-weight: 800;
    cursor: pointer;
    box-shadow: 0 14px 30px rgba(59,130,246,.28);
    transition: transform .15s ease, box-shadow .15s ease, opacity .15s ease;
  }

  .login-fields button:hover {
    transform: translateY(-1px);
    box-shadow: 0 18px 34px rgba(59,130,246,.35);
  }

  .login-fields button:active {
    transform: translateY(0);
  }

  .login-error {
    margin-top: 14px;
    color: #dc2626;
    font-weight: 700;
    min-height: 22px;
    text-align: center;
    font-size: 14px;
  }

  @media (max-width: 600px) {
    .login-card {
      padding: 26px 22px 24px;
      border-radius: 22px;
    }

    .login-card h1 {
      font-size: 34px;
    }

    .login-subtitle {
      font-size: 17px;
    }

    .login-fields input {
      font-size: 17px;
      padding: 15px 16px;
    }

    .login-fields button {
      font-size: 18px;
      padding: 15px;
    }

    .login-logo {
      width: 150px;
    }
  }
`;

    document.body.appendChild(style);
    document.body.appendChild(overlay);

    setTimeout(() => {
      const inputUsuario = document.getElementById("loginUsuario");
      if (inputUsuario) inputUsuario.focus();
    }, 100);

    async function intentarLogin() {
      let email = document.getElementById("loginUsuario").value.trim().toLowerCase();
      const password = document.getElementById("loginPassword").value;
      const errorBox = document.getElementById("loginError");

      errorBox.textContent = "";

      if (!email) {
        errorBox.textContent = "Ingresá un usuario.";
        return;
      }

      if (!password) {
        errorBox.textContent = "Ingresá la contraseña.";
        return;
      }

      if (!email.includes("@")) {
        email = email + "@cardiolink.local";
      }

      const { data, error } = await supabaseClient.auth.signInWithPassword({
        email,
        password
      });

      if (error) {
        console.error("Login Supabase falló:", error);
        errorBox.textContent = "Usuario o contraseña incorrectos.";
        return;
      }

      usuarioSupabase = data.user;

      overlay.remove();
      const loginStyle = document.getElementById("loginStyle");
      if (loginStyle) loginStyle.remove();

      resolve(true);
    }

    document.getElementById("btnLoginCardioLink").addEventListener("click", intentarLogin);

    document.getElementById("loginPassword").addEventListener("keydown", (e) => {
      if (e.key === "Enter") intentarLogin();
    });

    document.getElementById("loginUsuario").addEventListener("keydown", (e) => {
      if (e.key === "Enter") document.getElementById("loginPassword").focus();
    });
  });
}
function reiniciarTemporizadorInactividad() {
  clearTimeout(timerInactividad);
  timerInactividad = setTimeout(cerrarPorInactividad, INACTIVIDAD_MS);
}

function iniciarControlInactividad() {
  ['click','keydown','mousemove','touchstart','scroll','input'].forEach(evt => {
    window.addEventListener(evt, reiniciarTemporizadorInactividad, { passive: true });
  });
  reiniciarTemporizadorInactividad();
}

async function cerrarPorInactividad() {
  try {
    if (window.cardioLinkRefreshInterval) clearInterval(window.cardioLinkRefreshInterval);
    if (supabaseClient) await supabaseClient.auth.signOut();
  } catch (error) {
    console.error('Error cerrando sesión por inactividad:', error);
  }
  alert('Sesión cerrada por 30 minutos de inactividad. Volvé a iniciar sesión.');
  location.reload();
}

async function cerrarSesionSupabase() {
  if (!supabaseClient) return;

  await supabaseClient.auth.signOut();
  localStorage.removeItem("sb-session");

  location.reload();
}

function agregarBotonCerrarSesion() {
  if (document.getElementById("btnCerrarSesion")) return;

  const btn = document.createElement("button");
  btn.id = "btnCerrarSesion";
  btn.textContent = "Cerrar sesión";
  btn.style.position = "fixed";
  btn.style.right = "14px";
  btn.style.bottom = "14px";
  btn.style.zIndex = "9999";
  btn.style.padding = "10px 14px";
  btn.style.borderRadius = "10px";
  btn.style.border = "none";
  btn.style.background = "#334155";
  btn.style.color = "white";
  btn.style.fontWeight = "700";
  btn.style.cursor = "pointer";
  btn.style.boxShadow = "0 6px 20px rgba(0,0,0,.25)";

  btn.addEventListener("click", async () => {
    if (confirm("¿Cerrar sesión en CardioLink?")) {
      await cerrarSesionSupabase();
    }
  });

  document.body.appendChild(btn);
}
async function cargarAtencionesDesdeSupabase() {
  if (!supabaseClient || !usuarioSupabase) {
    throw new Error("No hay conexión o usuario Supabase activo.");
  }

  const { data: rows, error } = await supabaseClient
    .from("cardiolink_atenciones")
    .select("id, payload, updated_at")
    .order("updated_at", { ascending: false });

  if (error) {
    console.error("Error cargando atenciones desde Supabase:", error);
    alert("No se pudieron cargar las atenciones desde Supabase: " + error.message);
    throw error;
  }

  const remotas = (rows || []).map(row => row.payload).filter(Boolean);

  cargandoDesdeNube = true;

  if (remotas.length > 0) {
    atenciones = remotas;
    localStorage.setItem(storageAtenciones, JSON.stringify(atenciones));
    console.log("Atenciones cargadas desde Supabase:", atenciones.length);
  } else if (Array.isArray(atenciones) && atenciones.length > 0) {
    console.log("Supabase está vacío. Se migran atenciones locales a la nube:", atenciones.length);
    cargandoDesdeNube = false;
    await sincronizarAtencionesSupabase(true);
    return;
  } else {
    atenciones = [];
    localStorage.setItem(storageAtenciones, JSON.stringify(atenciones));
    console.log("Supabase sin atenciones. Base inicial vacía.");
  }

  cargandoDesdeNube = false;
}

function programarSyncSupabase() {
  if (!supabaseClient || !usuarioSupabase || cargandoDesdeNube) return;

  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    sincronizarAtencionesSupabase(false);
  }, 700);
}

async function sincronizarAtencionesSupabase(forzar = false) {
  if (!supabaseClient || !usuarioSupabase) {
    console.warn("No se sincroniza: falta Supabase o usuario.");
    return false;
  }

  if (cargandoDesdeNube && !forzar) return false;

  const rows = (atenciones || []).map(a => ({
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
    alert("No se pudo limpiar/sincronizar Supabase: " + deleteError.message);
    return false;
  }

  if (!rows.length) {
    console.log("Supabase sincronizado: 0 atenciones.");
    return true;
  }

  const { error: insertError } = await supabaseClient
    .from("cardiolink_atenciones")
    .insert(rows);

  if (insertError) {
    console.error("Error sincronizando atenciones con Supabase:", insertError);
    alert("No se pudo sincronizar con Supabase: " + insertError.message);
    return false;
  }

  console.log("Supabase sincronizado:", rows.length, "atenciones");
  return true;
}

function bloquearAppPorLogin() {
  document.body.innerHTML = `
    <div style="font-family: Arial, sans-serif; padding: 30px; max-width: 620px; margin: auto; line-height: 1.5;">
      <h2>CardioLink Admin</h2>
      <p><strong>No se inició sesión en Supabase.</strong></p>
      <p>Para evitar que esta computadora o celular cargue datos separados en modo local, la app queda bloqueada.</p>
      <p>Recargá la página e ingresá email y contraseña de CardioLink.</p>
    </div>
  `;
}

const CLAVE_DINERO_PERIODO='matias2026';
const OS_FACTURA_ROGELIO=['IOMA','OSDE','Sancor','Prevención Salud','OSPRERA'];
const FILTRO_FACTURA_ROGELIO='__FACTURA_ROGELIO__';
const storageValoresColocacion='cardiolink_valores_colocacion_v1';
let resumenFiltrosVisible=false;
let mostrarConteoDashboard=false;
const storageConfig='cardiolink_config_v25';
const storageAtenciones='cardiolink_atenciones_v25';

const defaults={
 profesionales:[
  {id:'general',nombre:'Vista General / Administración',area:'Todos los profesionales',prestaciones:[],valores:{consulta:0,electro:0,estudio:0,copagoConsulta:0,copagoElectro:0,copagoEstudio:0}},
  {id:'matias',nombre:'Dr. Matías Anchorena',area:'Cardiología / Medicina Crítica',prestaciones:['Consulta','Electrocardiograma','ECG','Ecocardiograma Doppler','Holter','MAPA','Consulta + ECG','Consulta + Eco'],valores:{consulta:35000,electro:35000,estudio:60000,copagoConsulta:35000,copagoElectro:35000,copagoEstudio:50000}},
  {id:'rogelio',nombre:'Dr. Rogelio Anchorena',area:'Cardiología',prestaciones:['Consulta','Electrocardiograma','ECG','Ecocardiograma Doppler','Holter','MAPA','Consulta + ECG','Consulta + Eco'],valores:{consulta:35000,electro:35000,estudio:60000,copagoConsulta:35000,copagoElectro:35000,copagoEstudio:50000}},
  {id:'humberto_drago',nombre:'Dr. Fernández Drago Humberto',area:'Diagnóstico por Imágenes',prestaciones:['Ecografía abdominal','Ecografía renal','Ecografía tiroidea','Ecografía mamaria','Doppler arterial','Doppler venoso','Mamografía'],valores:{consulta:0,electro:0,estudio:60000,copagoConsulta:0,copagoElectro:0,copagoEstudio:0}},
  {id:'lucas_drago',nombre:'Dr. Drago Lucas',area:'Diagnóstico por Imágenes',prestaciones:['Ecografía abdominal','Ecografía renal','Ecografía tiroidea','Ecografía mamaria','Doppler arterial','Doppler venoso','Mamografía'],valores:{consulta:0,electro:0,estudio:60000,copagoConsulta:0,copagoElectro:0,copagoEstudio:0}}
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
function esPrestacionColocable(prest){return ['HOLTER','MAPA','ECG'].includes(tipoPrest(prest))}
function valoresColocacion(){try{return Object.assign({holter:10000,mapa:10000,ecg:0},JSON.parse(localStorage.getItem(storageValoresColocacion)||'{}'))}catch{return {holter:10000,mapa:10000,ecg:0}}}
function guardarValoresColocacion(){const v={holter:Number($('valorColocacionHolter')?.value||$('liqValorHolter')?.value||10000),mapa:Number($('valorColocacionMapa')?.value||$('liqValorMapa')?.value||10000),ecg:Number($('valorColocacionEcg')?.value||$('liqValorEcg')?.value||0)};localStorage.setItem(storageValoresColocacion,JSON.stringify(v));return v}
function mostrarResumenFiltros(){resumenFiltrosVisible=true;if($('resumenCaja'))$('resumenCaja').classList.remove('hidden');if($('liquidacionBox'))$('liquidacionBox').classList.remove('hidden')}
function ocultarResumenFiltros(){resumenFiltrosVisible=false;if($('resumenCaja'))$('resumenCaja').classList.add('hidden');if($('liquidacionBox'))$('liquidacionBox').classList.add('hidden');if($('liquidacionResultado'))$('liquidacionResultado').textContent=''}
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
 $('btnHoy').addEventListener('click',()=>{const h=todayISO();$('fDesde').value=h;$('fHasta').value=h;paginaListado=1;mostrarResumenFiltros();renderTabla();calcularLiquidacionColocaciones()});
 $('btnMes').addEventListener('click',()=>{const d=new Date();const y=d.getFullYear();const m=String(d.getMonth()+1).padStart(2,'0');$('fDesde').value=`${y}-${m}-01`;$('fHasta').value=todayISO();paginaListado=1;mostrarResumenFiltros();renderTabla();calcularLiquidacionColocaciones()});
 $('btnPeriodo20').addEventListener('click',setPeriodo20);
 $('btnFiltrar').addEventListener('click',()=>{paginaListado=1;mostrarResumenFiltros();renderTabla();calcularLiquidacionColocaciones()});
 $('btnResetFiltros').addEventListener('click',resetFiltros);
 if($('btnPendientesGlobal'))$('btnPendientesGlobal').addEventListener('click',activarFiltroPendientesGlobal);
 if($('btnVerPendientesSolapa'))$('btnVerPendientesSolapa').addEventListener('click',()=>{showSection('listado');activarFiltroPendientesGlobal();});
 if($('btnLiqCalcular'))$('btnLiqCalcular').addEventListener('click',renderLiquidacionColocacionesSolapa);
 if($('btnLiqPrint'))$('btnLiqPrint').addEventListener('click',imprimirLiquidacionColocaciones);
 if($('btnLiqMes'))$('btnLiqMes').addEventListener('click',()=>{const d=new Date();const y=d.getFullYear();const m=String(d.getMonth()+1).padStart(2,'0');$('liqDesde').value=`${y}-${m}-01`;$('liqHasta').value=todayISO();renderLiquidacionColocacionesSolapa();});
 if($('btnPaginaAnterior'))$('btnPaginaAnterior').addEventListener('click',()=>{if(paginaListado>1){paginaListado--;renderTabla();}});
 if($('btnPaginaSiguiente'))$('btnPaginaSiguiente').addEventListener('click',()=>{paginaListado++;renderTabla();});
 $('btnPrint').addEventListener('click',()=>{setPrintMeta();document.body.classList.toggle('print-money',!!$('incluirValoresImpresion')?.checked);window.print();setTimeout(()=>document.body.classList.remove('print-money'),500)});
 $('btnExportExcel').addEventListener('click',exportarCSV);
 const vc=valoresColocacion();
 if($('valorColocacionHolter'))$('valorColocacionHolter').value=vc.holter;
 if($('valorColocacionMapa'))$('valorColocacionMapa').value=vc.mapa;
 if($('valorColocacionEcg'))$('valorColocacionEcg').value=vc.ecg;
 if($('liqValorHolter'))$('liqValorHolter').value=vc.holter;
 if($('liqValorMapa'))$('liqValorMapa').value=vc.mapa;
 if($('liqValorEcg'))$('liqValorEcg').value=vc.ecg;
 if($('liqDesde')){const d=new Date();const y=d.getFullYear();const m=String(d.getMonth()+1).padStart(2,'0');$('liqDesde').value=`${y}-${m}-01`;$('liqHasta').value=todayISO();}
 if($('btnCalcularLiquidacion'))$('btnCalcularLiquidacion').addEventListener('click',()=>{mostrarResumenFiltros();calcularLiquidacionColocaciones()});
 ['valorColocacionHolter','valorColocacionMapa','valorColocacionEcg'].forEach(id=>{if($(id))$(id).addEventListener('input',()=>{guardarValoresColocacion();calcularLiquidacionColocaciones()})});
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
 renderTabla(); renderStats(); ocultarResumenFiltros();
}
function refreshSelects(){
 llenarSelect($('perfilActivo'),data.profesionales,p=>p.id,p=>p.nombre);
 llenarSelect($('profesional'),data.profesionales.filter(p=>p.id!=='general'),p=>p.id,p=>p.nombre);
 llenarSelect($('obraSocial'),data.obrasSociales);
 llenarTodos($('fOS'),data.obrasSociales,'Todas las OS');
const optFacturaRogelio=document.createElement('option');
optFacturaRogelio.value=FILTRO_FACTURA_ROGELIO;
optFacturaRogelio.textContent='Factura Rogelio / Holter';
$('fOS').appendChild(optFacturaRogelio);
 llenarTodos($('fProfesional'),data.profesionales.filter(p=>p.id!=='general').map(p=>p.nombre),'Todos los médicos');
 llenarTodos($('fPrestacion'),allPrestaciones(),'Todas las prestaciones');
 llenarSelect($('profPrestacion'),data.profesionales.filter(p=>p.id!=='general'),p=>p.id,p=>p.nombre);
 llenarSelect($('cfgProfesionalValores'),data.profesionales.filter(p=>p.id!=='general'),p=>p.id,p=>p.nombre);
 llenarSelect($('cfgReglaOS'),data.obrasSociales);
}
function showSection(id){document.querySelectorAll('.section').forEach(s=>s.classList.remove('visible'));$(id).classList.add('visible');document.querySelectorAll('.nav').forEach(b=>b.classList.toggle('active',b.dataset.section===id));if(id==='colocaciones')renderLiquidacionColocacionesSolapa()}
function cambiarPerfil(id){$('perfilActivo').value=id;const p=perfilObj();$('tituloBienvenida').textContent=p.id==='general'?'Vista General / Administración':`Bienvenido ${p.nombre}`;$('subtituloPerfil').textContent=p.area;$('profesional').value=p.id==='general'?'matias':p.id;if($('instructivoPerfiles'))$('instructivoPerfiles').classList.toggle('hidden',p.id!=='general');paginaListado=1;actualizarPrestaciones();aplicarRegla();renderTabla();renderStats()}
function actualizarHora(){const a=new Date();$('fechaHoraPanel').textContent=a.toLocaleDateString('es-AR',{weekday:'long',day:'2-digit',month:'2-digit',year:'numeric'})+' · '+a.toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'})}
function actualizarPrestaciones(){
 const p=profesionalCarga();
 const items=p?.prestaciones?.length?p.prestaciones:allPrestaciones();
 llenarSelect($('prestacion'),items);
 if($('segundoEstudio'))llenarSelect($('segundoEstudio'),items);
}
function valoresDelProfesional(p){
  const v = p?.valores || {};
  return {
    consulta: Number(v.consulta || 0),
    electro: Number(v.electro || 0),
    estudio: Number(v.estudio || 0),
    copagoConsulta: Number(v.copagoConsulta || 0),
    copagoElectro: Number(v.copagoElectro || 0),
    copagoEstudio: Number(v.copagoEstudio || 0)
  };
}
function valorPrestacionActual(){const p=profesionalCarga();const prest=$('prestacion').value;if(!p)return 0;const v=valoresDelProfesional(p);if(esConsulta(prest))return v.consulta;if(esElectro(prest))return v.electro;return v.estudio}
function copagoPrestacionActual(){
  const p=profesionalCarga();const prest=$('prestacion').value;if(!p)return 0;const v=valoresDelProfesional(p);const t=tipoPrest(prest);
  if(t==='CONSULTA'||t==='CONSULTA_ECG')return v.copagoConsulta;
  if(t==='ECG')return v.copagoElectro || v.copagoConsulta;
  return v.copagoEstudio;
}
function ensureSelectOption(sel, value){
  if(!sel || value==null || value==='') return;
  const exists = Array.from(sel.options).some(o=>o.value===value);
  if(!exists){
    const o=document.createElement('option');
    o.value=value;
    o.textContent=value;
    sel.appendChild(o);
  }
}
function setSelectValue(id,value){
  const sel=$(id);
  ensureSelectOption(sel,value);
  if(sel) sel.value=value;
}
function nombreProfesionalPorId(id){
  return data.profesionales.find(p=>p.id===id)?.nombre || id || '';
}
function aplicarReglaProfesionalSimple(){
  const os=$('obraSocial').value, profId=$('profesional').value, prest=$('prestacion').value, prof=profesionalCarga(), nombre=prof?.nombre||profId;
  const t=tipoPrest(prest);
  setSelectValue('consultaA', esConsulta(prest) ? nombre : 'No aplica');
  setSelectValue('prestacionA', nombre);
  setSelectValue('facturador', nombre);
  $('tipoCobro').value='Sin cobro en caja';
  $('formaPago').value='No aplica';
  $('montoConsulta').value='';
  $('montoEstudio').value='';
  $('montoCopago').value='';
  $('bonoConsulta').checked=false;
  $('bonoEstudio').checked=false;
  $('copiaImpresa').checked=false;

  if(os==='Particular'){
    $('tipoCobro').value='Particular';
    $('formaPago').value='Efectivo';
    if(esConsulta(prest)) $('montoConsulta').value=valorPrestacionActual();
    else $('montoEstudio').value=valorPrestacionActual();
    $('reglaInfo').textContent=`${nombre}: particular ${money(valorPrestacionActual())}.`;
  } else {
    const copago=copagoPrestacionActual();
    if(copago>0){
      $('tipoCobro').value='Copago';
      $('formaPago').value='Efectivo';
      $('montoCopago').value=copago;
    }
    if(esConsulta(prest) || t==='CONSULTA_ECG') $('bonoConsulta').checked=true;
    if(!esConsulta(prest) || t==='CONSULTA_ECG') $('bonoEstudio').checked=true;
    $('reglaInfo').textContent=`${nombre}: ${os}. Factura/circuito propio del profesional${copago>0?` + copago ${money(copago)}`:''}.`;
  }
  calcularCajaCarga();
}
function aplicarRegla(){
 const os=$('obraSocial').value, prof=$('profesional').value, prest=$('prestacion').value, t=tipoPrest(prest), regla=getRegla(os);

 // Regla general: solo Matías usa circuito especial con Rogelio/Fold2.
 // El resto de los profesionales facturan y contabilizan para sí mismos.
 if(prof!=='matias'){
   aplicarReglaProfesionalSimple();
   return;
 }

 setSelectValue('consultaA','Matías'); setSelectValue('prestacionA',prof==='rogelio'?'Rogelio':'Matías'); setSelectValue('facturador',prof==='rogelio'?'Rogelio':'Matías');
 $('tipoCobro').value='Sin cobro en caja'; $('formaPago').value='No aplica'; $('montoConsulta').value=''; $('montoEstudio').value=''; $('montoCopago').value='';
 $('bonoConsulta').checked=false; $('bonoEstudio').checked=false; $('copiaImpresa').checked=false;
 const v=valoresDelProfesional(profesionalCarga());
 const copConsulta=v.copagoConsulta||35000, copElectro=v.copagoElectro||copConsulta, copEstudio=v.copagoEstudio||50000;
 let info=`Regla automática: ${regla}.`;
 if(os==='Particular'){ $('tipoCobro').value='Particular';$('formaPago').value='Efectivo';setSelectValue('facturador','Particular'); if(esConsulta(prest))$('montoConsulta').value=valorPrestacionActual(); else $('montoEstudio').value=valorPrestacionActual(); info=`Particular: ${money(valorPrestacionActual())}.`; }
 else if(regla==='IOMA_OSPRERA'){
  setSelectValue('consultaA','Matías');
  setSelectValue('facturador','Fold2 / FEMEBA');
  $('tipoCobro').value='Copago';
  $('formaPago').value='Efectivo';

  if(t==='CONSULTA'){
    setSelectValue('prestacionA','No aplica');
    $('montoCopago').value=copConsulta;
    $('bonoConsulta').checked=true;
    $('bonoEstudio').checked=false;
    info=`${os}: consulta a Matías/Fold2 + copago ${money(copConsulta)}.`;
  } else {
    // Para Matías, IOMA/OSPRERA: cualquier estudio se liquida como Holter a Rogelio,
    // con consulta Matías/Fold2 + bono estudio Rogelio + copago de estudio configurable.
    setSelectValue('prestacionA','Rogelio');
    $('montoCopago').value=copEstudio;
    $('bonoConsulta').checked=true;
    $('bonoEstudio').checked=true;
    info=`${os}: consulta a Matías/Fold2 + estudio como Holter a Rogelio + copago ${money(copEstudio)}.`;
  }
 } else if(regla==='OSDE'){
  setSelectValue('consultaA','Matías');
  if(t==='CONSULTA'){
    setSelectValue('prestacionA','No aplica');
    setSelectValue('facturador','Matías');
    $('bonoConsulta').checked=true;
    $('bonoEstudio').checked=false;
    info='OSDE: consulta a Matías.';
  } else {
    // Para Matías, OSDE: cualquier estudio se carga como Holter a Rogelio.
    setSelectValue('prestacionA','Rogelio');
    setSelectValue('facturador','Rogelio');
    $('bonoConsulta').checked=true;
    $('bonoEstudio').checked=true;
    info='OSDE: consulta a Matías + estudio como Holter a Rogelio.';
  }
 } else if(regla==='SANCOR_PREVENCION'){
  setSelectValue('consultaA','Matías'); if(t==='CONSULTA'){ setSelectValue('prestacionA','No aplica');$('bonoConsulta').checked=true;info=`${os}: consulta a Matías.`; }
  else { setSelectValue('prestacionA','Rogelio');setSelectValue('facturador','Rogelio');$('bonoConsulta').checked=true;$('bonoEstudio').checked=true;info=`${os}: consulta a Matías + estudio a Rogelio.`; }
 } else if(regla==='INTEGRAL'){
  setSelectValue('consultaA','Matías');setSelectValue('prestacionA','Matías');setSelectValue('facturador','Matías'); if(t==='CONSULTA'){$('bonoConsulta').checked=true;info='Integral: consulta a Matías.';} else {$('bonoEstudio').checked=true;info='Integral: estudio a Matías, sin consulta extra.';}
 } else if(regla==='TODO_MATIAS'){
  setSelectValue('consultaA','Matías');setSelectValue('prestacionA','Matías');setSelectValue('facturador','Matías'); if(t==='CONSULTA'){$('bonoConsulta').checked=true;} else {$('bonoEstudio').checked=true;} info=`${os}: todo a Matías.`;
 } else if(regla==='SIN_REGLA'){
  setSelectValue('consultaA','Matías');setSelectValue('prestacionA','Matías');setSelectValue('facturador','Matías'); info=`${os}: sin regla automática.`;
 } else {
  setSelectValue('consultaA','Matías');setSelectValue('prestacionA','Matías');setSelectValue('facturador','Matías'); if(t==='CONSULTA'){$('bonoConsulta').checked=true;} else {$('bonoConsulta').checked=true;$('bonoEstudio').checked=true;} info=`${os}: regla general Matías.`;
 }
 $('reglaInfo').textContent=info; calcularCajaCarga();
}
function calcularCajaCarga(){const tipo=$('tipoCobro').value;let total=0;const part=Number($('montoConsulta').value||0)+Number($('montoEstudio').value||0);const cop=Number($('montoCopago').value||0);if(tipo.includes('Particular'))total+=part;if(tipo.includes('Copago')||tipo.includes('copago'))total+=cop;$('montoTotal').value=total}
function limpiarForm(){
 $('formAtencion').reset();
 $('fecha').value=todayISO();
 if($('colocador'))$('colocador').value='Geraldine';
 if($('activarSegundoEstudio'))$('activarSegundoEstudio').checked=false;
 ['estudioInformado','estudioImpreso','estudioImpresoFacturacion','estudioEnviadoMail','estudioEnviadoWS'].forEach(id=>{if($(id))$(id).checked=false});
 const p=perfilObj();
 $('profesional').value=p.id==='general'?'matias':p.id;
 actualizarPrestaciones();
 aplicarRegla();
}

function esRegistroDeEstudio(a){return tipoPrest(a?.prestacion)!=='CONSULTA'}
function tomarEstadoInformeDesdeCarga(){
 return {
  estudioInformado:$('estudioInformado')?.checked||false,
  estudioImpreso:$('estudioImpreso')?.checked||false,
  estudioImpresoFacturacion:$('estudioImpresoFacturacion')?.checked||false,
  estudioEnviadoMail:$('estudioEnviadoMail')?.checked||false,
  estudioEnviadoWS:$('estudioEnviadoWS')?.checked||false
 };
}
function crearAtencionDesdeFormulario(prestacion, opciones={}){
 const prof=profesionalCarga();
 const esSegunda=!!opciones.segunda;
 const estadoInforme=tomarEstadoInformeDesdeCarga();
 const observacionesBase=$('observaciones').value.trim();
 return {
  id:Date.now()+(esSegunda?1:0),
  fecha:$('fecha').value,
  paciente:$('paciente').value.trim(),
  dni:$('dni').value.trim(),
  obraSocial:$('obraSocial').value,
  profesionalId:$('profesional').value,
  profesional:prof?.nombre||'',
  prestacion:prestacion,
  consultaA:$('consultaA').value,
  prestacionA:$('prestacionA').value,
  facturador:$('facturador').value,
  tipoCobro:esSegunda?'Sin cobro en caja':$('tipoCobro').value,
  formaPago:esSegunda?'No aplica':$('formaPago').value,
  cajaPerfil:$('profesional').value,
  reglaOS:getRegla($('obraSocial').value),
  montoConsulta:esSegunda?0:Number($('montoConsulta').value||0),
  montoEstudio:esSegunda?0:Number($('montoEstudio').value||0),
  montoCopago:esSegunda?0:Number($('montoCopago').value||0),
  montoTotal:esSegunda?0:Number($('montoTotal').value||0),
  bonoConsulta:esSegunda?false:$('bonoConsulta').checked,
  bonoEstudio:$('bonoEstudio').checked,
  bonoFirmado:$('bonoFirmado').checked,
  copiaImpresa:$('copiaImpresa').checked,
  requiereCopiaImpresa:$('bonoEstudio').checked,
  fold2:$('fold2').checked,
  planilla:$('planilla').checked,
  colocacionLiquidable:$('colocacionLiquidable')?.checked||false,
  colocador:$('colocador')?.value||'',
  ...estadoInforme,
  observaciones:esSegunda ? [observacionesBase,'Segundo estudio del mismo paciente'].filter(Boolean).join(' | ') : observacionesBase
 };
}
function guardarAtencion(e){
 e.preventDefault();
 calcularCajaCarga();
 const registros=[];
 const prestPrincipal=$('prestacion').value;
 registros.push(crearAtencionDesdeFormulario(prestPrincipal));
 if($('activarSegundoEstudio')?.checked && $('segundoEstudio')?.value){
  const prest2=$('segundoEstudio').value;
  if(prest2 && prest2!==prestPrincipal) registros.push(crearAtencionDesdeFormulario(prest2,{segunda:true}));
 }
 atenciones.push(...registros);
 saveAtenciones();
 renderTabla();
 renderStats();
 if(resumenFiltrosVisible)calcularLiquidacionColocaciones();
 limpiarForm();
 if(guardarYContinuar){guardarYContinuar=false;showSection('carga');setTimeout(()=>$('paciente').focus(),50)}else showSection('listado')
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
  let box = document.getElementById('facturaRogelioResumenBox');
  const printArea = document.getElementById('printArea');
  if(!printArea) return;
  if(!box){
    box = document.createElement('div');
    box.id = 'facturaRogelioResumenBox';
    box.className = 'factura-rogelio-box';
    const wrap = printArea.querySelector('.tabla-listado-wrap');
    if(wrap && wrap.parentNode){
      wrap.parentNode.insertBefore(box, wrap);
    } else {
      printArea.prepend(box);
    }
  }
  box.innerHTML = $('fOS')?.value===FILTRO_FACTURA_ROGELIO ? facturaRogelioHTML(datos) : '';
}


function atencionesPerfil(){const p=perfilObj();if(p.id==='general')return atenciones;if(p.id==='matias')return atenciones.filter(a=>a.profesionalId==='matias'||a.consultaA==='Matías'||a.prestacionA==='Matías');if(p.id==='rogelio')return atenciones.filter(a=>a.profesionalId==='rogelio'||a.consultaA==='Rogelio'||a.prestacionA==='Rogelio');return atenciones.filter(a=>a.profesionalId===p.id)}

function esPendienteAdministrativo(a){
 const e=evaluarEstado(a);
 if(e.cls==='bad')return true;
 if(esRegistroDeEstudio(a)){
   const entregado=!!(a.estudioImpreso||a.estudioEnviadoMail||a.estudioEnviadoWS);
   if(!a.estudioInformado||!entregado)return true;
 }
 return false;
}
function activarFiltroPendientesGlobal(){
 modoPendientesGlobal=true;
 paginaListado=1;
 if($('fDesde'))$('fDesde').value='';
 if($('fHasta'))$('fHasta').value='';
 mostrarResumenFiltros();
 renderTabla();
 renderStats();
}
function filtrar(){const desde=$('fDesde').value,hasta=$('fHasta').value,os=$('fOS').value,prof=$('fProfesional').value,prest=$('fPrestacion').value,pac=$('fPaciente').value.toLowerCase().trim(),dest=$('fDestino').value;return atencionesPerfil().filter(a=>{if(modoPendientesGlobal&&!esPendienteAdministrativo(a))return false;if(!modoPendientesGlobal){if(desde&&a.fecha<desde)return false;if(hasta&&a.fecha>hasta)return false;}if(os===FILTRO_FACTURA_ROGELIO && !esRegistroFacturaRogelio(a))return false;if(os&&os!==FILTRO_FACTURA_ROGELIO&&a.obraSocial!==os)return false;if(prof&&a.profesional!==prof)return false;if(prest&&a.prestacion!==prest)return false;if(pac&&!String(a.paciente||'').toLowerCase().includes(pac))return false;if(dest&&a.consultaA!==dest&&a.prestacionA!==dest)return false;return true}).sort((a,b)=>(b.fecha||'').localeCompare(a.fecha||''))}
function consultaComputada(a){const t=tipoPrest(a.prestacion),r=a.reglaOS||getRegla(a.obraSocial);if(t==='CONSULTA'||t==='CONSULTA_ECG')return true;if(t==='ECG'&&r==='IOMA_OSPRERA')return true;if(t!=='CONSULTA'){return ['GENERAL_CONSULTA_EXTRA','SANCOR_PREVENCION','IOMA_OSPRERA','OSDE'].includes(r)}return !!a.bonoConsulta}
function resumen(datos){return datos.reduce((r,a)=>{if(consultaComputada(a))r.consultas++;if(tipoPrest(a.prestacion)!=='CONSULTA')r.estudios++;if(a.bonoConsulta||consultaComputada(a))r.bonoConsulta++;if(a.bonoEstudio||tipoPrest(a.prestacion)!=='CONSULTA')r.bonoEstudio++;const particular=Number(a.montoConsulta||0)+Number(a.montoEstudio||0);const copago=Number(a.montoCopago||0);r.particular+=particular;r.copago+=copago;r.total+=particular+copago;return r},{consultas:0,estudios:0,bonoConsulta:0,bonoEstudio:0,particular:0,copago:0,total:0})}
function dineroVisible(a){
 const p=perfilObj(),cp=a.cajaPerfil||a.profesionalId;
 if(p.id==='general')return {particular:0,copago:0,total:0};
 if(cp!==p.id)return {particular:0,copago:0,total:0};
 const particular=Number(a.montoConsulta||0)+Number(a.montoEstudio||0);
 const copago=Number(a.montoCopago||0);
 return {particular,copago,total:particular+copago};
}
function atencionesCajaDelPerfil(datos = atenciones) {
  const p = perfilObj();

  // En vista general / administración NO se mezclan cajas
  if (p.id === 'general') {
    return [];
  }

  return datos.filter(a => {
    const caja = a.cajaPerfil || a.profesionalId;
    return caja === p.id;
  });
}

function cajaHoy(datos = atenciones) {
  const datosCaja = atencionesCajaDelPerfil(datos);

  return datosCaja
    .filter(a => a.fecha === todayISO())
    .reduce((r, a) => {
      const particular = Number(a.montoConsulta || 0) + Number(a.montoEstudio || 0);
      const copago = Number(a.montoCopago || 0);

      r.particular += particular;
      r.copago += copago;
      r.total += particular + copago;

      return r;
    }, { particular: 0, copago: 0, total: 0 });
}
function evaluarEstado(a){const f=new Set();if((a.bonoConsulta||a.bonoEstudio)&&!a.bonoFirmado)f.add('firma');if((a.bonoEstudio||a.requiereCopiaImpresa)&&!a.copiaImpresa)f.add('copia');return f.size?{txt:'Falta: '+Array.from(f).join(' + '),cls:'bad'}:{txt:'OK',cls:'ok'}}
function badgesInforme(a){
 if(!esRegistroDeEstudio(a))return '';
 const badges=[];
 const informado=!!a.estudioInformado;
 const impreso=!!a.estudioImpreso;
 const enviadoMail=!!a.estudioEnviadoMail;
 const enviadoWS=!!a.estudioEnviadoWS;
 const entregado=impreso||enviadoMail||enviadoWS;
 badges.push(informado?'<span class="badge ok informe-badge">Informado</span>':'<span class="badge bad informe-badge">Pend. informe</span>');
 if(impreso)badges.push('<span class="badge ok informe-badge">Impreso</span>');
 if(a.estudioImpresoFacturacion)badges.push('<span class="badge ok informe-badge">Imp. fact.</span>');
 if(enviadoMail)badges.push('<span class="badge ok informe-badge">Mail</span>');
 if(enviadoWS)badges.push('<span class="badge ok informe-badge">WS</span>');
 if(!entregado)badges.push('<span class="badge bad informe-badge">Pend. envío/entrega</span>');
 return `<div class="estado-informe">${badges.join(' ')}</div>`;
}
function estadoHTML(a,e){return `<span class="badge ${e.cls}">${e.txt}</span>${badgesInforme(a)}`;}

function prestacionContable(a){
  const r=a.reglaOS||getRegla(a.obraSocial);
  if(a.profesionalId==='matias' && a.prestacionA==='Rogelio' && ['OSDE','IOMA_OSPRERA'].includes(r) && tipoPrest(a.prestacion)!=='CONSULTA'){
    return 'Holter';
  }
  return a.prestacion;
}
function prestacionListado(a){
  return a.prestacion || '';
}
function badgeColocacion(a){return a.colocacionLiquidable?`<br><span class="badge ok colocacion-badge">Coloc. ${escapeHtml(a.colocador||'')}</span>`:''}
function calcularLiquidacionColocaciones(){
  if(!$('liquidacionResultado'))return;
  const v=guardarValoresColocacion();
  const datos=filtrar().filter(a=>a.colocacionLiquidable && esPrestacionColocable(a.prestacion));
  const holter=datos.filter(a=>tipoPrest(a.prestacion)==='HOLTER').length;
  const mapa=datos.filter(a=>tipoPrest(a.prestacion)==='MAPA').length;
  const ecg=datos.filter(a=>tipoPrest(a.prestacion)==='ECG').length;
  const totalHolter=holter*v.holter,totalMapa=mapa*v.mapa,totalEcg=ecg*v.ecg,total=totalHolter+totalMapa+totalEcg;
  $('liquidacionResultado').innerHTML=`Holter: ${holter} × ${money(v.holter)} = <strong>${money(totalHolter)}</strong> | MAPA: ${mapa} × ${money(v.mapa)} = <strong>${money(totalMapa)}</strong> | ECG: ${ecg} × ${money(v.ecg)} = <strong>${money(totalEcg)}</strong> | <strong>Total: ${money(total)}</strong>`;
}
function valorColocacionPorPrestacion(prest){
 const v=valoresColocacion();
 const t=tipoPrest(prest);
 if(t==='HOLTER')return Number(v.holter||0);
 if(t==='MAPA')return Number(v.mapa||0);
 if(t==='ECG')return Number(v.ecg||0);
 return 0;
}
function datosLiquidacionColocaciones(){
 const desde=$('liqDesde')?.value||'';
 const hasta=$('liqHasta')?.value||'';
 const colocador=$('liqColocador')?.value||'';
 return atencionesPerfil().filter(a=>{
   if(!a.colocacionLiquidable||!esPrestacionColocable(a.prestacion))return false;
   if(desde&&a.fecha<desde)return false;
   if(hasta&&a.fecha>hasta)return false;
   if(colocador&&a.colocador!==colocador)return false;
   return true;
 }).sort((a,b)=>(b.fecha||'').localeCompare(a.fecha||''));
}

function datosLiquidacionColocacionesSolapa(){
  guardarValoresColocacion();
  const desde=$('liqDesde')?.value||'';
  const hasta=$('liqHasta')?.value||'';
  const colocador=$('liqColocador')?.value||'';
  const v={
    holter:Number($('liqValorHolter')?.value||0),
    mapa:Number($('liqValorMapa')?.value||0),
    ecg:Number($('liqValorEcg')?.value||0)
  };
  const datos=(atenciones||[]).filter(a=>{
    if(!a.colocacionLiquidable || !esPrestacionColocable(a.prestacion))return false;
    if(desde && a.fecha<desde)return false;
    if(hasta && a.fecha>hasta)return false;
    if(colocador && a.colocador!==colocador)return false;
    return true;
  }).sort((a,b)=>(b.fecha||'').localeCompare(a.fecha||''));
  const holter=datos.filter(a=>tipoPrest(a.prestacion)==='HOLTER').length;
  const mapa=datos.filter(a=>tipoPrest(a.prestacion)==='MAPA').length;
  const ecg=datos.filter(a=>tipoPrest(a.prestacion)==='ECG').length;
  const totalHolter=holter*v.holter,totalMapa=mapa*v.mapa,totalEcg=ecg*v.ecg,total=totalHolter+totalMapa+totalEcg;
  return {desde,hasta,colocador,v,datos,holter,mapa,ecg,totalHolter,totalMapa,totalEcg,total};
}

function imprimirLiquidacionColocaciones(){
  const l=datosLiquidacionColocacionesSolapa();
  if(!l.datos.length){alert('No hay colocaciones para imprimir con esos filtros.');return;}
  const desdeTxt=l.desde?formatFecha(l.desde):'Inicio';
  const hastaTxt=l.hasta?formatFecha(l.hasta):'Hoy';
  const colocadorTxt=l.colocador||'Todos';
  const filas=l.datos.map(a=>{
    const valor=tipoPrest(a.prestacion)==='HOLTER'?l.v.holter:tipoPrest(a.prestacion)==='MAPA'?l.v.mapa:l.v.ecg;
    return `<tr><td>${formatFecha(a.fecha)}</td><td>${escapeHtml(a.paciente||'')}</td><td>${escapeHtml(a.prestacion||'')}</td><td>${escapeHtml(a.colocador||'')}</td><td class="money">${money(valor)}</td></tr>`;
  }).join('');
  const html=`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Liquidación colocaciones</title><style>
    body{font-family:Arial,sans-serif;color:#111827;margin:28px}h1{margin:0 0 4px;font-size:24px}h2{font-size:18px;margin:18px 0 8px}.muted{color:#64748b;margin:0 0 14px}.box{border:1px solid #cbd5e1;background:#f8fafc;border-radius:12px;padding:14px;margin:14px 0}.total{font-size:22px;font-weight:800}.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 24px}.line{font-size:15px}table{width:100%;border-collapse:collapse;margin-top:16px}th,td{border-bottom:1px solid #e5e7eb;text-align:left;padding:8px;font-size:13px}th{background:#f1f5f9}.money{text-align:right}.footer{margin-top:18px;font-size:12px;color:#64748b}@media print{button{display:none}body{margin:18px}}
  </style></head><body>
    <h1>CardioLink Admin</h1>
    <p class="muted">Liquidación colocación Holter / MAPA / ECG · by Matías Anchorena</p>
    <div class="box">
      <div class="grid">
        <div><strong>Período:</strong> ${desdeTxt} al ${hastaTxt}</div>
        <div><strong>Colocador/a:</strong> ${escapeHtml(colocadorTxt)}</div>
        <div class="line">Holter: ${l.holter} × ${money(l.v.holter)} = <strong>${money(l.totalHolter)}</strong></div>
        <div class="line">MAPA: ${l.mapa} × ${money(l.v.mapa)} = <strong>${money(l.totalMapa)}</strong></div>
        <div class="line">ECG: ${l.ecg} × ${money(l.v.ecg)} = <strong>${money(l.totalEcg)}</strong></div>
        <div class="total">Total a pagar: ${money(l.total)}</div>
      </div>
    </div>
    <h2>Detalle incluido</h2>
    <table><thead><tr><th>Fecha</th><th>Paciente</th><th>Prestación</th><th>Colocador/a</th><th class="money">Valor</th></tr></thead><tbody>${filas}</tbody></table>
    <p class="footer">Impreso: ${new Date().toLocaleString('es-AR')}</p>
    <script>window.onload=()=>setTimeout(()=>window.print(),250)<\/script>
  </body></html>`;
  const w=window.open('','_blank');
  if(!w){alert('El navegador bloqueó la ventana de impresión. Permití ventanas emergentes para esta página.');return;}
  w.document.open();w.document.write(html);w.document.close();
}

function renderLiquidacionColocacionesSolapa(){
  if(!$('liqResultado'))return;
  const l=datosLiquidacionColocacionesSolapa();
  $('liqResultado').innerHTML=`<strong>Total a pagar: ${money(l.total)}</strong><br>Holter: ${l.holter} × ${money(l.v.holter)} = ${money(l.totalHolter)} · MAPA: ${l.mapa} × ${money(l.v.mapa)} = ${money(l.totalMapa)} · ECG: ${l.ecg} × ${money(l.v.ecg)} = ${money(l.totalEcg)}`;
  const tbody=$('tablaLiquidacionColocaciones');
  if(!tbody)return;
  tbody.innerHTML='';
  if(!l.datos.length){tbody.innerHTML='<tr><td colspan="6">No hay colocaciones para esos filtros.</td></tr>';return;}
  l.datos.forEach(a=>{
    const valor=tipoPrest(a.prestacion)==='HOLTER'?l.v.holter:tipoPrest(a.prestacion)==='MAPA'?l.v.mapa:l.v.ecg;
    const tr=document.createElement('tr');
    tr.innerHTML=`<td>${formatFecha(a.fecha)}</td><td><strong>${escapeHtml(a.paciente||'')}</strong></td><td>${escapeHtml(a.prestacion||'')}</td><td>${escapeHtml(a.colocador||'')}</td><td>${money(valor)}</td><td><button class="secondary" onclick="editarAtencion(${a.id})">Editar</button></td>`;
    tbody.appendChild(tr);
  });
}
function renderTabla(){const tbody=$('tablaAtenciones');tbody.innerHTML='';const datos=filtrar();renderResumenCaja(datos);actualizarResumenFacturaRogelio(datos);if(resumenFiltrosVisible)calcularLiquidacionColocaciones();const totalPaginas=Math.max(1,Math.ceil(datos.length/TAMANIO_PAGINA_LISTADO));if(paginaListado>totalPaginas)paginaListado=totalPaginas;if(paginaListado<1)paginaListado=1;actualizarPaginacionListado(datos.length,totalPaginas);const inicio=(paginaListado-1)*TAMANIO_PAGINA_LISTADO;const datosPagina=datos.slice(inicio,inicio+TAMANIO_PAGINA_LISTADO);if(!datos.length){tbody.innerHTML='<tr><td colspan="14">No hay registros para mostrar.</td></tr>';return}datosPagina.forEach(a=>{const e=evaluarEstado(a),m=dineroVisible(a),part=m.particular;const tr=document.createElement('tr');if(editandoId===a.id){tr.className='edit-row';tr.innerHTML=`<td><input type="date" id="e_fecha_${a.id}" value="${a.fecha||''}"></td><td><input id="e_paciente_${a.id}" value="${escapeHtml(a.paciente)}"><input id="e_obs_${a.id}" value="${escapeHtml(a.observaciones||'')}" placeholder="Obs."></td><td>${selectHTML('e_os_'+a.id,data.obrasSociales,a.obraSocial)}</td><td>${selectProfesionalesHTML('e_prof_'+a.id,a.profesionalId)}</td><td>${selectPrestacionesHTML('e_prest_'+a.id,a.profesionalId,a.prestacion)}</td><td>${selectHTML('e_consultaA_'+a.id,opcionesDestinos(a.consultaA),a.consultaA)}</td><td>${selectHTML('e_prestacionA_'+a.id,opcionesDestinos(a.prestacionA),a.prestacionA)}</td><td>${selectHTML('e_tipoCobro_'+a.id,['Sin cobro en caja','Copago','Particular','Particular + copago'],a.tipoCobro)}<div class="inline-checks-edit"><label><input type="checkbox" id="e_bonoConsulta_${a.id}" ${a.bonoConsulta?'checked':''}> Bono consulta</label><label><input type="checkbox" id="e_bonoEstudio_${a.id}" ${a.bonoEstudio?'checked':''}> Bono estudio</label><label><input type="checkbox" id="e_bonoFirmado_${a.id}" ${a.bonoFirmado?'checked':''}> Bono firmado</label><label><input type="checkbox" id="e_copiaImpresa_${a.id}" ${a.copiaImpresa?'checked':''}> Copia</label><label><input type="checkbox" id="e_fold2_${a.id}" ${a.fold2?'checked':''}> Fold2</label><label><input type="checkbox" id="e_planilla_${a.id}" ${a.planilla?'checked':''}> Planilla</label><label><input type="checkbox" id="e_colocacionLiquidable_${a.id}" ${a.colocacionLiquidable?'checked':''}> Colocación liquidable</label><label>Colocador/a ${selectHTML('e_colocador_'+a.id,['Geraldine','Secretaría','Otro'],a.colocador||'Geraldine')}</label></div></td><td>${selectHTML('e_formaPago_'+a.id,['No aplica','Efectivo','Transferencia','Mixto'],a.formaPago||'No aplica')}</td><td><input type="number" id="e_particular_${a.id}" value="${Number(a.montoConsulta||0)+Number(a.montoEstudio||0)}"></td><td><input type="number" id="e_copago_${a.id}" value="${Number(a.montoCopago||0)}"></td><td>${money(a.montoTotal)}</td><td class="estado-cell">${estadoHTML(a,e)}</td><td class="no-print actions-cell"><div class="edit-actions"><button class="small-btn" onclick="guardarEdicion(${a.id})">Guardar</button><button class="small-btn" onclick="cancelarEdicion()">Cancelar</button></div></td>`}else{tr.innerHTML=`<td>${formatFecha(a.fecha)}</td><td><strong>${escapeHtml(a.paciente)}</strong>${a.observaciones?'<br><small>'+escapeHtml(a.observaciones)+'</small>':''}</td><td>${a.obraSocial}</td><td>${a.profesional}</td><td>${prestacionListado(a)}${badgeColocacion(a)}</td><td>${a.consultaA}</td><td>${a.prestacionA}</td><td>${a.tipoCobro||''}</td><td>${a.formaPago||'No aplica'}</td><td class="money-col">${money(part)}</td><td class="money-col">${money(m.copago)}</td><td class="money-col">${money(m.total)}</td><td class="estado-cell">${estadoHTML(a,e)}</td><td class="no-print actions-cell"><div class="edit-actions"><button onclick="editarAtencion(${a.id})">Editar</button><button onclick="eliminarAtencion(${a.id})">Borrar</button></div></td>`}tbody.appendChild(tr)})}
function actualizarPaginacionListado(totalRegistros,totalPaginas){
 const box=$('paginacionListado'),info=$('paginaInfo'),prev=$('btnPaginaAnterior'),next=$('btnPaginaSiguiente');
 if(!box||!info||!prev||!next)return;
 const desde=totalRegistros?((paginaListado-1)*TAMANIO_PAGINA_LISTADO+1):0;
 const hasta=Math.min(paginaListado*TAMANIO_PAGINA_LISTADO,totalRegistros);
 info.textContent=`Hoja ${paginaListado}/${totalPaginas} · Mostrando ${desde}-${hasta} de ${totalRegistros} registros`;
 prev.disabled=paginaListado<=1;
 next.disabled=paginaListado>=totalPaginas;
 box.classList.remove('hidden');
}
function renderResumenCaja(datos=filtrar()){const r=resumen(datos),c=cajaHoy(datos);$('rConsultas').textContent=r.consultas;$('rEstudios').textContent=r.estudios;$('rBonoConsulta').textContent=r.bonoConsulta;$('rBonoEstudio').textContent=r.bonoEstudio;$('rParticular').textContent=money(c.particular);$('rCopago').textContent=money(c.copago);$('rTotal').textContent=money(c.total)}
function renderStats(){const datos=atencionesPerfil(),c=cajaHoy(datos);$('statTotal').textContent=mostrarConteoDashboard?datos.length:'•••';if($('btnToggleConteo'))$('btnToggleConteo').textContent=mostrarConteoDashboard?'Ocultar':'Mostrar';$('statHoy').textContent=datos.filter(a=>a.fecha===todayISO()).length;$('statPendientes').textContent=datos.filter(a=>evaluarEstado(a).cls==='bad').length;$('statParticular').textContent=money(c.particular);$('statCopagos').textContent=money(c.copago);$('statTotalCaja').textContent=money(c.total);if($('dashboardDetalle'))$('dashboardDetalle').textContent=''}

function selectHTML(id,items,selected){return `<select id="${id}">`+items.map(x=>`<option ${x===selected?'selected':''}>${escapeHtml(x)}</option>`).join('')+'</select>'}
function opcionesDestinos(extra){const base=['Matías','Rogelio','No aplica','A definir'];data.profesionales.filter(p=>p.id!=='general').forEach(p=>base.push(p.nombre));if(extra)base.push(extra);return [...new Set(base.filter(Boolean))];}
function selectProfesionalesHTML(id,selected){return `<select id="${id}">`+data.profesionales.filter(p=>p.id!=='general').map(p=>`<option value="${p.id}" ${p.id===selected?'selected':''}>${escapeHtml(p.nombre)}</option>`).join('')+'</select>'}
function selectPrestacionesHTML(id,prof,selected){const p=data.profesionales.find(x=>x.id===prof);const items=p?.prestaciones?.length?p.prestaciones:allPrestaciones();return selectHTML(id,items,selected)}
function editarAtencion(id){abrirModalEdicion(id)}
function cancelarEdicion(){cerrarModalEdicion()}

function abrirModalEdicion(id){
  const a=atenciones.find(x=>x.id===id);
  if(!a)return;
  cerrarModalEdicion();
  const overlay=document.createElement('div');
  overlay.id='modalEdicionAtencion';
  const particular=Number(a.montoConsulta||0)+Number(a.montoEstudio||0);
  const copago=Number(a.montoCopago||0);
  overlay.innerHTML=`
    <div class="modal-edit-card">
      <div class="modal-edit-header">
        <div>
          <h2>Editar atención</h2>
          <p>${escapeHtml(a.paciente||'Paciente sin nombre')} · ${formatFecha(a.fecha||'')}</p>
        </div>
        <button type="button" class="modal-close" onclick="cerrarModalEdicion()">×</button>
      </div>
      <div class="form-grid modal-form-grid">
        <div><label>Fecha</label><input type="date" id="m_fecha" value="${a.fecha||''}"></div>
        <div><label>Paciente</label><input id="m_paciente" value="${escapeHtml(a.paciente||'')}"></div>
        <div><label>DNI</label><input id="m_dni" value="${escapeHtml(a.dni||'')}"></div>
        <div><label>Obra social</label>${selectHTML('m_os',data.obrasSociales,a.obraSocial)}</div>
        <div><label>Profesional</label>${selectProfesionalesHTML('m_prof',a.profesionalId)}</div>
        <div><label>Prestación</label>${selectPrestacionesHTML('m_prest',a.profesionalId,a.prestacion)}</div>
        <div><label>Consulta a</label>${selectHTML('m_consultaA',opcionesDestinos(a.consultaA),a.consultaA)}</div>
        <div><label>Estudio/prestación a</label>${selectHTML('m_prestacionA',opcionesDestinos(a.prestacionA),a.prestacionA)}</div>
        <div><label>Tipo de cobro</label>${selectHTML('m_tipoCobro',['Sin cobro en caja','Copago','Particular','Particular + copago'],a.tipoCobro||'Sin cobro en caja')}</div>
        <div><label>Forma de pago</label>${selectHTML('m_formaPago',['No aplica','Efectivo','Transferencia','Mixto'],a.formaPago||'No aplica')}</div>
        <div><label>Particular</label><input type="number" id="m_particular" value="${particular}"></div>
        <div><label>Copago</label><input type="number" id="m_copago" value="${copago}"></div>
        <div class="checks modal-checks">
          <label><input type="checkbox" id="m_bonoConsulta" ${a.bonoConsulta?'checked':''}> Bono consulta</label>
          <label><input type="checkbox" id="m_bonoEstudio" ${a.bonoEstudio?'checked':''}> Bono estudio</label>
          <label><input type="checkbox" id="m_bonoFirmado" ${a.bonoFirmado?'checked':''}> Bono firmado</label>
          <label><input type="checkbox" id="m_copiaImpresa" ${a.copiaImpresa?'checked':''}> Copia impresa</label>
          <label><input type="checkbox" id="m_fold2" ${a.fold2?'checked':''}> Fold2</label>
          <label><input type="checkbox" id="m_planilla" ${a.planilla?'checked':''}> Planilla</label>
          <label><input type="checkbox" id="m_colocacionLiquidable" ${a.colocacionLiquidable?'checked':''}> Colocación liquidable</label>
          <label>Colocador/a ${selectHTML('m_colocador',['Geraldine','Secretaría','Otro'],a.colocador||'Geraldine')}</label>
          <label><input type="checkbox" id="m_estudioInformado" ${a.estudioInformado?'checked':''}> Informe realizado / informado</label>
          <label><input type="checkbox" id="m_estudioImpreso" ${a.estudioImpreso?'checked':''}> Informe impreso</label>
          <label><input type="checkbox" id="m_estudioImpresoFacturacion" ${a.estudioImpresoFacturacion?'checked':''}> Impreso facturación</label>
          <label><input type="checkbox" id="m_estudioEnviadoMail" ${a.estudioEnviadoMail?'checked':''}> Enviado por mail</label>
          <label><input type="checkbox" id="m_estudioEnviadoWS" ${a.estudioEnviadoWS?'checked':''}> Enviado por WhatsApp</label>
        </div>
        <div class="full"><label>Observaciones</label><textarea id="m_obs" rows="3">${escapeHtml(a.observaciones||'')}</textarea></div>
      </div>
      <div class="modal-actions">
        <button class="secondary" type="button" onclick="cerrarModalEdicion()">Cancelar</button>
        <button class="primary" type="button" onclick="guardarEdicionModal(${id})">Guardar cambios</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}

function cerrarModalEdicion(){
  const modal=document.getElementById('modalEdicionAtencion');
  if(modal)modal.remove();
  editandoId=null;
}

function guardarEdicionModal(id){
  const a=atenciones.find(x=>x.id===id);
  if(!a)return;
  const profId=$('m_prof').value;
  const prof=data.profesionales.find(p=>p.id===profId);
  const prest=$('m_prest').value;
  const tipo=$('m_tipoCobro').value;
  const part=Number($('m_particular').value||0);
  const cop=Number($('m_copago').value||0);
  let total=0;
  if(tipo.includes('Particular'))total+=part;
  if(tipo.includes('Copago')||tipo.includes('copago'))total+=cop;
  a.fecha=$('m_fecha').value;
  a.paciente=$('m_paciente').value.trim();
  a.dni=$('m_dni').value.trim();
  a.observaciones=$('m_obs').value.trim();
  a.obraSocial=$('m_os').value;
  a.profesionalId=profId;
  a.profesional=prof?.nombre||'';
  a.prestacion=prest;
  a.consultaA=$('m_consultaA').value;
  a.prestacionA=$('m_prestacionA').value;
  a.tipoCobro=tipo;
  a.formaPago=$('m_formaPago').value;
  a.cajaPerfil=profId;
  a.montoConsulta=esConsulta(prest)?part:0;
  a.montoEstudio=esConsulta(prest)?0:part;
  a.montoCopago=cop;
  a.montoTotal=total;
  a.bonoConsulta=$('m_bonoConsulta').checked;
  a.bonoEstudio=$('m_bonoEstudio').checked;
  a.bonoFirmado=$('m_bonoFirmado').checked;
  a.copiaImpresa=$('m_copiaImpresa').checked;
  a.requiereCopiaImpresa=a.bonoEstudio;
  a.fold2=$('m_fold2').checked;
  a.planilla=$('m_planilla').checked;
  a.colocacionLiquidable=$('m_colocacionLiquidable')?.checked||false;
  a.colocador=$('m_colocador')?.value||'';
  a.estudioInformado=$('m_estudioInformado')?.checked||false;
  a.estudioImpreso=$('m_estudioImpreso')?.checked||false;
  a.estudioImpresoFacturacion=$('m_estudioImpresoFacturacion')?.checked||false;
  a.estudioEnviadoMail=$('m_estudioEnviadoMail')?.checked||false;
  a.estudioEnviadoWS=$('m_estudioEnviadoWS')?.checked||false;
  a.reglaOS=getRegla(a.obraSocial);
  saveAtenciones();
  cerrarModalEdicion();
  renderTabla();
  renderStats();
  if(resumenFiltrosVisible)calcularLiquidacionColocaciones();
}

function guardarEdicion(id){guardarEdicionModal(id)}
function eliminarAtencion(id){if(!confirm('¿Borrar esta atención?'))return;atenciones=atenciones.filter(a=>a.id!==id);saveAtenciones();renderTabla();renderStats()}

function setPeriodo20(){const d=new Date();let y=d.getFullYear(),m=d.getMonth()+1,day=d.getDate(),dy=y,dm=m,hy=y,hm=m+1;if(day<20){dm=m-1;hm=m}if(dm<1){dm=12;dy--}if(hm>12){hm=1;hy++}$('fDesde').value=`${dy}-${String(dm).padStart(2,'0')}-20`;$('fHasta').value=`${hy}-${String(hm).padStart(2,'0')}-20`;paginaListado=1;mostrarResumenFiltros();renderTabla();calcularLiquidacionColocaciones()}
function resetFiltros(){
  $('fDesde').value='';
  $('fHasta').value='';
  $('fOS').value='';
  $('fProfesional').value='';
  $('fPrestacion').value='';
  $('fPaciente').value='';
  $('fDestino').value='';

  paginaActualListado = 1;

  ocultarResumenFiltros();
  renderTabla();
  renderStats();
}
function verDineroPeriodo(){
  const res=$('dineroPeriodoResultado');
  if(perfilObj().id==='general'){
    res.textContent='Seleccione un perfil profesional para ver ingresos. La vista general no mezcla cajas.';
    return;
  }
  if($('claveDinero').value!==CLAVE_DINERO_PERIODO){
    res.textContent='Clave incorrecta.';
    return;
  }

  const desde=$('adminDesde')?.value || $('fDesde').value || '';
  const hasta=$('adminHasta')?.value || $('fHasta').value || todayISO();

  let datos=atencionesCajaDelPerfil(atenciones).filter(a=>{
    if(desde && a.fecha < desde) return false;
    if(hasta && a.fecha > hasta) return false;
    return true;
  });

  const r=resumen(datos);
  const desdeTxt=desde ? formatFecha(desde) : 'inicio';
  const hastaTxt=hasta ? formatFecha(hasta) : 'hoy';

  res.textContent=`Ingreso del perfil ${perfilObj().nombre} (${desdeTxt} a ${hastaTxt}) — Particular ${money(r.particular)} | Copagos ${money(r.copago)} | Total ${money(r.total)} | Registros ${datos.length}`;
}
function ocultarDineroPeriodo(){$('dineroPeriodoResultado').textContent='';$('claveDinero').value=''}
function setPrintMeta(){$('printMeta').textContent=`Perfil: ${perfilObj().nombre} | Registros: ${filtrar().length} | ${formatFecha(todayISO())}`}
function exportarCSV(){const datos=filtrar();if(!datos.length){alert('No hay datos');return}const r=resumen(datos);const incluirValoresExport=!!$('incluirValoresImpresion')?.checked;const filas=[['CardioLink Admin v2.5.9'],['Perfil',perfilObj().nombre],['Consultas',r.consultas],['Estudios',r.estudios],[],['Fecha','Paciente','OS','Profesional','Prestación','Consulta a','Estudio a','Tipo','Forma','Particular visible','Copago visible','Total visible','Estado']];datos.forEach(a=>{const m=dineroVisible(a),e=evaluarEstado(a);filas.push([formatFecha(a.fecha),a.paciente,a.obraSocial,a.profesional,prestacionListado(a),a.consultaA,a.prestacionA,a.tipoCobro,a.formaPago,incluirValoresExport?m.particular:'',incluirValoresExport?m.copago:'',incluirValoresExport?m.total:'',e.txt])});const csv=filas.map(r=>r.map(c=>`"${String(c??'').replaceAll('"','""')}"`).join(';')).join('\n');const blob=new Blob(['\ufeff'+csv],{type:'text/csv'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='CardioLink_listado.csv';a.click()}
function exportarBackup(){const b={app:'CardioLink Admin',version:'2.6.6',fechaExportacion:new Date().toISOString(),config:data,atenciones};const blob=new Blob([JSON.stringify(b,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='CardioLink_Admin_backup.json';a.click()}
function importarBackup(){const inp=$('inputImportBackup');if(!inp.files[0]){alert('Elegí archivo');return}if(!confirm('Reemplaza la base actual. ¿Continuar?'))return;const rd=new FileReader();rd.onload=e=>{try{const b=JSON.parse(e.target.result);if(!b.config||!b.atenciones)throw new Error();data=b.config;atenciones=b.atenciones;saveConfig();saveAtenciones();refreshSelects();renderConfig();cambiarPerfil('general');alert('Backup importado')}catch{alert('Backup inválido')}};rd.readAsText(inp.files[0])}
function renderConfig(){cargarValoresConfig();cargarReglaConfig();$('listaProfesionales').innerHTML=data.profesionales.map(p=>`<li><strong>${p.nombre}</strong> — ${p.area} ${p.id!=='general'?`<button class="small-btn" onclick="delProfesional('${p.id}')">Borrar</button>`:''}</li>`).join('');$('listaOS').innerHTML=data.obrasSociales.map(o=>`<li>${o} <button class="small-btn" onclick="delOS('${escapeHtml(o)}')">Borrar</button></li>`).join('');$('listaPrestaciones').innerHTML=allPrestaciones().map(p=>`<li>${p} <button class="small-btn" onclick="delPrestacion('${encodeURIComponent(p)}')">Borrar</button></li>`).join('')}
function cargarValoresConfig(){
 const p=data.profesionales.find(x=>x.id===$('cfgProfesionalValores').value)||data.profesionales.find(x=>x.id==='matias');
 if(!p)return;
 const v=valoresDelProfesional(p);
 $('cfgProfesionalValores').value=p.id;
 $('cfgConsultaParticular').value=v.consulta;
 $('cfgElectroParticular').value=v.electro;
 $('cfgEstudioParticular').value=v.estudio;
 if($('cfgCopagoConsulta'))$('cfgCopagoConsulta').value=v.copagoConsulta;
 if($('cfgCopagoElectro'))$('cfgCopagoElectro').value=v.copagoElectro;
 if($('cfgCopagoEstudio'))$('cfgCopagoEstudio').value=v.copagoEstudio;
}
function guardarValores(){
 const p=data.profesionales.find(x=>x.id===$('cfgProfesionalValores').value);
 if(!p)return;
 const prev=p.valores||{};
 p.valores={
   ...prev,
   consulta:Number($('cfgConsultaParticular').value||0),
   electro:Number($('cfgElectroParticular').value||0),
   estudio:Number($('cfgEstudioParticular').value||0),
   copagoConsulta:Number($('cfgCopagoConsulta')?.value||0),
   copagoElectro:Number($('cfgCopagoElectro')?.value||0),
   copagoEstudio:Number($('cfgCopagoEstudio')?.value||0)
 };
 saveConfig();
 alert('Valores del perfil guardados');
 aplicarRegla();
 renderStats();
}
function cargarReglaConfig(){$('cfgTipoRegla').value=getRegla($('cfgReglaOS').value)}
function guardarReglaConfig(){setRegla($('cfgReglaOS').value,$('cfgTipoRegla').value);alert('Regla guardada');aplicarRegla()}
function addProfesional(){const n=$('nuevoProfesional').value.trim();if(!n)return;data.profesionales.push({id:'p_'+Date.now(),nombre:n,area:$('nuevaArea').value.trim()||'Sin definir',prestaciones:[],valores:{consulta:0,electro:0,estudio:0,copagoConsulta:0,copagoElectro:0,copagoEstudio:0}});saveConfig();refreshSelects();renderConfig()}
function delProfesional(id){if(!confirm('Borrar profesional?'))return;data.profesionales=data.profesionales.filter(p=>p.id!==id);saveConfig();refreshSelects();renderConfig()}
function addOS(){const n=$('nuevaOS').value.trim();if(!n)return;if(!data.obrasSociales.includes(n))data.obrasSociales.push(n);saveConfig();refreshSelects();renderConfig()}
function delOS(n){if(!confirm('Borrar OS?'))return;data.obrasSociales=data.obrasSociales.filter(o=>o!==n);saveConfig();refreshSelects();renderConfig()}
function addPrestacion(){const n=$('nuevaPrestacion').value.trim(),pid=$('profPrestacion').value;if(!n)return;const p=data.profesionales.find(x=>x.id===pid);if(p&&!p.prestaciones.includes(n))p.prestaciones.push(n);saveConfig();refreshSelects();renderConfig();actualizarPrestaciones()}
function delPrestacion(enc){const n=decodeURIComponent(enc);if(!confirm('Borrar prestación de todos los perfiles?'))return;data.profesionales.forEach(p=>p.prestaciones=(p.prestaciones||[]).filter(x=>x!==n));saveConfig();refreshSelects();renderConfig();actualizarPrestaciones()}

window.editarAtencion=editarAtencion;window.guardarEdicion=guardarEdicion;window.guardarEdicionModal=guardarEdicionModal;window.cerrarModalEdicion=cerrarModalEdicion;window.cancelarEdicion=cancelarEdicion;window.eliminarAtencion=eliminarAtencion;window.delProfesional=delProfesional;window.delOS=delOS;window.delPrestacion=delPrestacion;

async function refrescarDesdeSupabaseAutomatico() {
  if (!supabaseClient || !usuarioSupabase) return;

  // No refrescar si alguien está editando una atención
  if (typeof editandoId !== "undefined" && editandoId) return;

  try {
    await cargarAtencionesDesdeSupabase();

    if (typeof renderTabla === "function") renderTabla();
    if (typeof renderStats === "function") renderStats();

    console.log("Refresco automático Supabase OK:", new Date().toLocaleTimeString());
  } catch (error) {
    console.error("Error en refresco automático:", error);
  }
}

function iniciarRefrescoAutomatico() {
  if (window.cardioLinkRefreshInterval) {
    clearInterval(window.cardioLinkRefreshInterval);
  }

  window.cardioLinkRefreshInterval = setInterval(() => {
    refrescarDesdeSupabaseAutomatico();
  }, 30000);

  console.log("Refresco automático activado cada 30 segundos");
}

async function iniciarCardioLink() {
  const loginOk = await loginSupabase();

  if (!loginOk) {
    document.body.innerHTML = `
      <div style="font-family: Arial; padding: 30px; max-width: 600px; margin: auto;">
        <h2>CardioLink Admin</h2>
        <p>No se inició sesión en Supabase.</p>
        <p>Recargá la página e ingresá usuario y contraseña.</p>
      </div>
    `;
    return;
  }

  await cargarAtencionesDesdeSupabase();
  init();
  agregarBotonCerrarSesion();
  iniciarControlInactividad();
  iniciarRefrescoAutomatico();
}

iniciarCardioLink();
