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


/* ===== ROLES / PERMISOS / AUDITORÍA v2.7.5 ===== */
let usuarioPerfilActual = null;

function normalizarUsuarioTexto(s){
  return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();
}
function usuarioDesdeEmail(email){
  const e=String(email||'').toLowerCase().trim();
  return e.split('@')[0] || e || 'local';
}
function usuarioActualNombreCorto(){
  return usuarioDesdeEmail(usuarioSupabase?.email || 'local');
}
function usuariosDefault(){
  return [
    {id:'matias',usuario:'matias',aliases:['matias.anchorena','drm.anchorena'],nombre:'Dr. Matías Anchorena',rol:'duenio',profesionalId:'matias',especialidad:'Medicina Intensiva y Cardiología',activo:true,soloMatias:true},
    {id:'geraldine',usuario:'geraldine',aliases:['geral','secretaria1'],nombre:'Geraldine',rol:'secretaria',profesionalId:'',especialidad:'Administración',activo:true},
    {id:'secretaria',usuario:'secretaria',aliases:['administracion','admin_secretaria'],nombre:'Secretaría',rol:'secretaria',profesionalId:'',especialidad:'Administración',activo:true},
    {id:'rogelio',usuario:'rogelio',aliases:['rogelio.anchorena'],nombre:'Dr. Rogelio Anchorena',rol:'medico',profesionalId:'rogelio',especialidad:'Cardiología',activo:true},
    // Usuario de acceso humberto asociado al profesional existente humberto_drago.
    // Alias drago queda para compatibilidad con cargas anteriores: no crea otro profesional.
    {id:'humberto_drago',usuario:'humberto',aliases:['drago','humberto_drago','humberto.fernandez.drago','fernandez_drago','fernandezdrago','drago_humberto'],nombre:'Dr. Fernández Drago Humberto',rol:'medico',profesionalId:'humberto_drago',especialidad:'Diagnóstico por Imágenes',activo:true},
    {id:'lucas_drago',usuario:'lucas',aliases:['lucas_drago','drago_lucas','lucas.drago'],nombre:'Dr. Drago Lucas',rol:'medico',profesionalId:'lucas_drago',especialidad:'Diagnóstico por Imágenes',activo:true}
  ];
}
function usuarioLoginCorto(s){
  let x=String(s||'').toLowerCase().trim();
  if(x.includes('@')) x=x.split('@')[0];
  return normalizarUsuarioTexto(x).replace(/\s+/g,'_');
}
function userKeys(u){
  return [u?.id,u?.usuario,u?.email].concat(u?.aliases||[]).filter(Boolean).map(x=>normalizarUsuarioClave(usuarioLoginCorto(x))).filter(Boolean);
}
function uniqueList(arr){return [...new Set((arr||[]).filter(Boolean))];}
function usuariosCoinciden(a,b){
  const ka=new Set(userKeys(a));
  return userKeys(b).some(k=>ka.has(k));
}
function normalizarUsuarioRegistro(u){
  u.usuario=usuarioLoginCorto(u.usuario||u.email||u.id);
  if(!u.id)u.id='usr_'+(u.usuario||Date.now());
  if(!Array.isArray(u.aliases))u.aliases=[];
  u.aliases=uniqueList(u.aliases.map(usuarioLoginCorto).filter(x=>x && x!==u.usuario));
  if(u.activo===undefined)u.activo=true;
  if(!u.rol)u.rol='medico';
  return u;
}
function consolidarUsuariosConfig(){
  if(!data) return;
  const actuales=(Array.isArray(data.usuarios)?data.usuarios:[]).map(u=>normalizarUsuarioRegistro({...u}));
  const defaults=usuariosDefault().map(u=>normalizarUsuarioRegistro({...u}));
  const usados=new Set();
  const resultado=[];

  defaults.forEach(def=>{
    const candidatos=[];
    actuales.forEach((u,i)=>{
      if(usados.has(i))return;
      if(usuariosCoinciden(u,def)){candidatos.push([u,i]);}
    });
    if(candidatos.length){
      candidatos.forEach(([_,i])=>usados.add(i));
      const aliases=[];
      candidatos.forEach(([u])=>{
        aliases.push(u.usuario, u.email, u.id, ...(u.aliases||[]));
      });
      resultado.push({
        ...candidatos[0][0],
        ...def,
        aliases: uniqueList([...(def.aliases||[]), ...aliases.map(usuarioLoginCorto)].filter(x=>x && x!==def.usuario))
      });
    }else{
      resultado.push(def);
    }
  });

  actuales.forEach((u,i)=>{
    if(usados.has(i))return;
    const ya=resultado.find(r=>usuariosCoinciden(r,u));
    if(ya){
      ya.aliases=uniqueList([...(ya.aliases||[]), u.usuario, u.email, u.id, ...(u.aliases||[])].map(usuarioLoginCorto).filter(x=>x && x!==ya.usuario));
      if(!ya.profesionalId && u.profesionalId)ya.profesionalId=u.profesionalId;
      if(!ya.especialidad && u.especialidad)ya.especialidad=u.especialidad;
      if(ya.activo!==false && u.activo===false)ya.activo=false;
    }else{
      resultado.push(u);
    }
  });
  data.usuarios=resultado;
}
function normalizarUsuarioClave(s){
  return normalizarUsuarioTexto(s).replace(/[^a-z0-9]/g,'');
}
function usuarioCoincide(u, user, email){
  const buscados=[user, email, String(email||'').split('@')[0]].filter(Boolean).map(normalizarUsuarioClave);
  const candidatos=[u.usuario,u.email,u.id].concat(u.aliases||[]).filter(Boolean).map(normalizarUsuarioClave);
  return buscados.some(b=>candidatos.includes(b));
}
function asegurarUsuariosConfig(){
  if(!data) return;
  consolidarUsuariosConfig();
  data.usuarios.forEach(u=>{
    normalizarUsuarioRegistro(u);
  });
}
function inferirUsuarioPorLogin(user){
  const k=normalizarUsuarioClave(user);
  if(!k) return null;
  if(k==='matias' || k.includes('matiasanchorena') || k.includes('drmanchorena')) return (data.usuarios||[]).find(x=>x.usuario==='matias');
  if(k.includes('geraldine') || k.includes('secretaria') || k.includes('administracion')) return (data.usuarios||[]).find(x=>x.usuario==='geraldine' || x.usuario==='secretaria');
  if(k.includes('rogelio')) return (data.usuarios||[]).find(x=>x.usuario==='rogelio');
  if(k.includes('lucas') && k.includes('drago')) return (data.usuarios||[]).find(x=>x.id==='lucas_drago' || x.usuario==='lucas');
  if(k.includes('humberto') || k.includes('fernandezdrago') || k==='drago' || k.includes('dragohumberto')) return (data.usuarios||[]).find(x=>x.id==='humberto_drago' || x.usuario==='humberto' || (x.aliases||[]).map(normalizarUsuarioClave).includes('drago'));
  return null;
}
function perfilUsuarioActual(){
  asegurarUsuariosConfig();
  const user = usuarioActualNombreCorto();
  const email = usuarioSupabase?.email || '';
  let u=(data.usuarios||[]).find(x=>usuarioCoincide(x,user,email) && x.activo!==false);
  if(!u) u=inferirUsuarioPorLogin(user) || inferirUsuarioPorLogin(email);
  // Si no se reconoce el usuario, entra con permisos mínimos. No cae en Matías para evitar exposición de caja/reportes.
  if(!u) u={id:'usr_sin_config',usuario:user,nombre:user||'Usuario sin configurar',rol:'medico',profesionalId:'',especialidad:'Perfil no configurado',activo:true};
  usuarioPerfilActual=u;
  return u;
}
function esMatiasDuenio(){
  const u=perfilUsuarioActual();
  return u.rol==='duenio' && (normalizarUsuarioClave(u.usuario)==='matias' || u.soloMatias===true || u.id==='matias');
}
function esSecretaria(){ const r=perfilUsuarioActual().rol; return r==='secretaria'; }
function esAdminComun(){ const r=perfilUsuarioActual().rol; return r==='admin'; }
function esMedico(){ const r=perfilUsuarioActual().rol; return r==='medico'; }
function puedeVerFacturaRogelio(){ return esMatiasDuenio(); }
function puedeVerCajaGlobal(){ return esMatiasDuenio() || esAdminComun(); }
function puedeGestionarConfig(){ return esMatiasDuenio() || esSecretaria() || esAdminComun(); }
function puedeGestionarConfigAdministrativa(){ return esMatiasDuenio() || esAdminComun(); }
function exigirConfigAdministrativa(mensaje='Tu perfil no puede modificar esta configuración administrativa.'){
  if(puedeGestionarConfigAdministrativa()) return true;
  alert(mensaje);
  return false;
}
function profesionalIdUsuarioActual(){ return perfilUsuarioActual().profesionalId || ''; }
function nombreUsuarioAuditoria(){
  const u=perfilUsuarioActual();
  return `${u.nombre || u.usuario || usuarioActualNombreCorto()} (${usuarioActualNombreCorto()})`;
}
function selloAuditoriaCreacion(obj){
  obj.creadoPor = obj.creadoPor || nombreUsuarioAuditoria();
  obj.creadoUsuario = obj.creadoUsuario || usuarioActualNombreCorto();
  obj.creadoRol = obj.creadoRol || (perfilUsuarioActual().rol || '');
  obj.creadoEn = obj.creadoEn || new Date().toISOString();
}
function selloAuditoriaEdicion(obj){
  obj.editadoPor = nombreUsuarioAuditoria();
  obj.editadoUsuario = usuarioActualNombreCorto();
  obj.editadoRol = perfilUsuarioActual().rol || '';
  obj.editadoEn = new Date().toISOString();
}
function fechaHoraAuditoria(iso){
  if(!iso) return '';
  try{return new Date(iso).toLocaleString('es-AR',{dateStyle:'short',timeStyle:'short'});}catch{return iso;}
}
function auditoriaHTML(a){
  const creado = a.creadoPor ? `${escapeHtml(a.creadoPor)} · ${fechaHoraAuditoria(a.creadoEn)}` : 'Sin dato previo';
  const editado = a.editadoPor ? `${escapeHtml(a.editadoPor)} · ${fechaHoraAuditoria(a.editadoEn)}` : 'Sin modificaciones registradas';
  return `<div class="audit-box"><strong>Trazabilidad</strong><br><small>Carga: ${creado}<br>Última edición: ${editado}</small></div>`;
}
function seccionPermitida(section){
  if(section==='caja') return esMatiasDuenio() || esAdminComun();
  if(section==='config') return puedeGestionarConfig();
  if(esMatiasDuenio()) return true;
  if(esSecretaria() || esAdminComun()) return true;
  if(esMedico()) return ['dashboard','carga','agenda','mensajes','pacientes','hc','listado','estadisticas','colocaciones','instructivos'].includes(section);
  return section!=='config';
}
function aplicarPermisosUI(){
  perfilUsuarioActual();
  document.body.dataset.rol = perfilUsuarioActual().rol || '';
  document.body.dataset.usuario = usuarioActualNombreCorto();
  document.querySelectorAll('.nav').forEach(b=>{
    const ok=seccionPermitida(b.dataset.section);
    b.classList.toggle('hidden-permission',!ok);
  });
  const pa=$('perfilActivo');
  if(pa){
    if(esMedico()){
      const pid=profesionalIdUsuarioActual();
      if(pid){ pa.value=pid; }
      pa.disabled=true;
    }else{
      pa.disabled=false;
    }
  }
  document.querySelectorAll('.solo-matias').forEach(el=>{const isCaja=el.dataset?.section==='caja';el.classList.toggle('hidden-permission',isCaja?!(esMatiasDuenio()||esAdminComun()):!esMatiasDuenio());});
  document.querySelectorAll('.no-medico').forEach(el=>el.classList.toggle('hidden-permission',esMedico()));
  document.querySelectorAll('.solo-config,[data-config-access="admin"]').forEach(el=>el.classList.toggle('hidden-permission',!puedeGestionarConfigAdministrativa()));
  document.querySelectorAll('[data-config-group="usuarios"]').forEach(el=>el.classList.toggle('hidden-permission',!puedeGestionarConfigAdministrativa()));
  const lock=document.querySelector('.money-lock');
  if(lock) lock.classList.toggle('hidden-permission',!puedeVerCajaGlobal());
  const fOS=$('fOS');
  if(fOS && !puedeVerFacturaRogelio() && fOS.value===FILTRO_FACTURA_ROGELIO) fOS.value='';
  const box=$('usuarioActivoBox');
  if(box){
    const u=perfilUsuarioActual();
    box.innerHTML=`Usuario: <strong>${escapeHtml(u.nombre||u.usuario)}</strong> · Rol: <strong>${escapeHtml(labelRol(u.rol))}</strong>${u.especialidad?` · ${escapeHtml(u.especialidad)}`:''}`;
  }
  actualizarNotificacionMensajes();
}
function labelRol(r){return ({duenio:'Matías / dueño',admin:'Administrador',secretaria:'Secretaría',medico:'Médico',tecnico:'Técnico / colocador'}[r]||r||'Sin rol');}

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
      <p class="login-meta">Versión 4.1.0-hc · 2026</p>
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
  btn.style.position = "static";
  btn.style.left = "auto";
  btn.style.right = "auto";
  btn.style.bottom = "auto";
  btn.style.zIndex = "1";
  btn.style.visibility = "hidden";
  btn.style.padding = "13px 18px";
  btn.style.borderRadius = "14px";
  btn.style.border = "none";
  btn.style.background = "#334155";
  btn.style.color = "white";
  btn.style.fontWeight = "800";
  btn.style.cursor = "pointer";
  btn.style.boxShadow = "0 6px 20px rgba(0,0,0,.25)";
  btn.style.fontSize = "16px";
  btn.style.minWidth = "0";
  btn.style.width = "auto";
  btn.style.maxWidth = "220px";
  btn.style.minWidth = "140px";
  btn.style.display = "none";
  btn.style.marginTop = "10px";

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
    const corruptosEliminados = limpiarRegistrosCorruptosSilencioso();
    localStorage.setItem(storageAtenciones, JSON.stringify(atenciones));
    console.log("Atenciones cargadas desde Supabase:", atenciones.length);

    // Si se limpiaron registros corruptos mientras se estaba cargando desde la nube,
    // hay que escribir la base limpia de vuelta en Supabase. Durante la carga normal
    // programarSyncSupabase queda bloqueado por cargandoDesdeNube, por eso se fuerza acá.
    if (corruptosEliminados > 0) {
      cargandoDesdeNube = false;
      await sincronizarAtencionesSupabase(true);
      cargandoDesdeNube = true;
    }
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

let syncAtencionesEnCurso = false;
let syncAtencionesPendiente = false;

function registrosSincronizablesSupabase(lista = atenciones) {
  const vistos = new Set();
  const out = [];
  (lista || []).forEach((a, idx) => {
    if (!a || typeof a !== 'object') return;
    if (!esMensajeInterno(a) && esAtencionCorrupta(a)) return;
    let id = String(a.id || '').trim();
    if (!id || id === 'undefined' || id === 'null') {
      id = (esMensajeInterno(a) ? 'msg_' : 'att_') + Date.now() + '_' + idx + '_' + Math.random().toString(36).slice(2, 7);
      a.id = id;
    }
    if (vistos.has(id)) {
      // No mandar dos filas con el mismo id, porque Supabase rechaza la carga por primary key.
      a.id = (esMensajeInterno(a) ? 'msg_' : 'att_') + Date.now() + '_' + idx + '_' + Math.random().toString(36).slice(2, 7);
      id = String(a.id);
    }
    vistos.add(id);
    out.push(a);
  });
  return out;
}


/* ===== SINCRONIZACIÓN SEGURA v4.1.0-hc =====
   Evita el patrón peligroso "DELETE ALL + UPSERT".
   Primero confirma/escribe los registros actuales y recién después limpia
   IDs remotos obsoletos. Incluye protecciones contra vaciados accidentales. */
async function limpiarIdsRemotosObsoletosSeguro(idsLocales, cantidadAtencionesLocales) {
  // v4.1.0-hc: NO se eliminan filas remotas por comparación automática.
  // En un entorno con varias computadoras, una fila que no esté en esta copia local
  // puede haber sido creada hace segundos por Secretaría u otro profesional.
  // Las bajas reales se hacen únicamente por ID cuando el usuario pulsa “Borrar”.
  return { ok:true, eliminados:0, omitido:true, modo:'upsert_only' };
}

async function sincronizarAtencionesSupabase(forzar = false) {
  if (!supabaseClient || !usuarioSupabase) {
    console.warn("No se sincroniza: falta Supabase o usuario.");
    return false;
  }

  if (cargandoDesdeNube && !forzar) return false;

  if (syncAtencionesEnCurso) {
    syncAtencionesPendiente = true;
    return false;
  }

  syncAtencionesEnCurso = true;
  try {
    // Incluye atenciones + mensajes internos y normaliza IDs antes de enviar.
    atenciones = registrosSincronizablesSupabase(atenciones);
    localStorage.setItem(storageAtenciones, JSON.stringify(atenciones));

    const rows = atenciones.map(a => ({
      id: String(a.id),
      payload: a,
      updated_at: new Date().toISOString()
    }));

    // PASO 1: escribir/actualizar primero. Nunca vaciar la tabla antes del UPSERT.
    if (rows.length) {
      const { error: upsertError } = await supabaseClient
        .from("cardiolink_atenciones")
        .upsert(rows, { onConflict: "id" });

      if (upsertError) {
        console.error("Error sincronizando atenciones con Supabase:", upsertError);
        alert("No se pudo sincronizar con Supabase: " + upsertError.message);
        return false;
      }
    }

    // PASO 2: limpiar solo IDs remotos que ya no existen localmente.
    // Si la base local está vacía o la diferencia es sospechosamente grande,
    // la protección bloquea el borrado en lugar de arriesgar los datos remotos.
    const limpieza = await limpiarIdsRemotosObsoletosSeguro(
      rows.map(r => r.id),
      atenciones.length
    );

    if (limpieza?.protegido) {
      console.warn("Sincronización guardada, pero la limpieza remota fue bloqueada por seguridad.");
    }

    console.log("Supabase sincronizado de forma segura:", rows.length, "registros", limpieza?.eliminados ? `· ${limpieza.eliminados} obsoletos eliminados` : "");
    return true;
  } finally {
    syncAtencionesEnCurso = false;
    if (syncAtencionesPendiente) {
      syncAtencionesPendiente = false;
      setTimeout(() => sincronizarAtencionesSupabase(false), 900);
    }
  }
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
let pacienteSeleccionadoPanelId=null;

const defaults={
 profesionales:[
  {id:'general',nombre:'Vista General / Administración',area:'Todos los profesionales',prestaciones:[],valores:{consulta:0,electro:0,estudio:0,copagoConsulta:0,copagoElectro:0,copagoEstudio:0}},
  {id:'matias',nombre:'Dr. Matías Anchorena',area:'Cardiología / Medicina Crítica',prestaciones:['Consulta','Electrocardiograma','ECG','Ecocardiograma Doppler','Holter','MAPA'],valores:{consulta:35000,electro:35000,estudio:60000,copagoConsulta:35000,copagoElectro:35000,copagoEstudio:50000}},
  {id:'rogelio',nombre:'Dr. Rogelio Anchorena',area:'Cardiología',prestaciones:['Consulta','Electrocardiograma','ECG','Ecocardiograma Doppler','Holter','MAPA'],valores:{consulta:35000,electro:35000,estudio:60000,copagoConsulta:35000,copagoElectro:35000,copagoEstudio:50000}},
  {id:'humberto_drago',nombre:'Dr. Fernández Drago Humberto',area:'Diagnóstico por Imágenes',prestaciones:['Ecografía abdominal','Ecografía renal','Ecografía tiroidea','Ecografía mamaria','Doppler arterial','Doppler venoso','Mamografía'],valores:{consulta:0,electro:0,estudio:60000,copagoConsulta:0,copagoElectro:0,copagoEstudio:0}},
  {id:'lucas_drago',nombre:'Dr. Drago Lucas',area:'Diagnóstico por Imágenes',prestaciones:['Ecografía abdominal','Ecografía renal','Ecografía tiroidea','Ecografía mamaria','Doppler arterial','Doppler venoso','Mamografía'],valores:{consulta:0,electro:0,estudio:60000,copagoConsulta:0,copagoElectro:0,copagoEstudio:0}}
 ],
 obrasSociales:['Particular','PAMI','OSDE','Swiss Medical','Medicus','Galeno','Omint','William Hope','Banco Provincia','OSMATA','OSPEGYPE','OSPE','Medifé','Luz Médica','OPIM / Ensalud','IOMA','OSPRERA','Sancor','Prevención Salud','Integral','Otra'],
 reglasOS:{'IOMA':'IOMA_OSPRERA','OSPRERA':'IOMA_OSPRERA','OSDE':'OSDE','Sancor':'SANCOR_PREVENCION','Prevención Salud':'SANCOR_PREVENCION','Integral':'INTEGRAL','PAMI':'COBERTURA_COBRA_PARTICULAR'},
 pacientes:[],
 usuarios: usuariosDefault(),
 colocadores:['Geraldine','Secretaría','Otro']
};

let data=loadConfig();

function esPrestacionCompuestaNombre(nombre){
  const s=String(nombre||'').toLowerCase();
  return s.includes('+') || s.includes(' + ') || s.includes('consulta +') || s.includes('eco +') || s.includes('holter +') || s.includes('mapa +') || s.includes('electro +') || s.includes('ecg +');
}
function limpiarPrestacionesCompuestasConfig(){
  try{
    (data.profesionales||[]).forEach(p=>{
      p.prestaciones=(p.prestaciones||[]).filter(pr=>!esPrestacionCompuestaNombre(pr));
    });
    saveConfig?.();
  }catch(e){console.warn('No se pudieron limpiar prestaciones compuestas:',e);}
}
data=normalizarConfigCritica(data);
try{localStorage.setItem(storageConfig,JSON.stringify(data));}catch(e){}
if(!Array.isArray(data.pacientes)) data.pacientes=[];
asegurarUsuariosConfig();
if(!Array.isArray(data.colocadores)) data.colocadores=['Geraldine','Secretaría','Otro'];
if(!data.reglasOS) data.reglasOS=structuredClone(defaults.reglasOS);
let atenciones=loadAtenciones();
limpiarPrestacionesCompuestasConfig();
let editandoId=null;
let guardarYContinuar=false;
const $=id=>document.getElementById(id);


function literalInvalido(v){
  const s=String(v??'').trim().toLowerCase();
  return s==='' || s==='undefined' || s==='null' || s==='nan';
}
function normalizarConfigCritica(cfg){
  cfg = cfg && typeof cfg==='object' ? cfg : structuredClone(defaults);
  cfg.profesionales = Array.isArray(cfg.profesionales) ? cfg.profesionales : [];
  cfg.obrasSociales = Array.isArray(cfg.obrasSociales) ? cfg.obrasSociales : [];
  cfg.reglasOS = cfg.reglasOS && typeof cfg.reglasOS==='object' ? cfg.reglasOS : {};
  cfg.pacientes = Array.isArray(cfg.pacientes) ? cfg.pacientes : [];
  cfg.usuarios = Array.isArray(cfg.usuarios) ? cfg.usuarios : usuariosDefault();
  cfg.colocadores = Array.isArray(cfg.colocadores) ? cfg.colocadores : ['Geraldine','Secretaría','Otro'];

  // No pisar configuraciones reales: solo completar lo que falta o quedó en cero por error.
  defaults.profesionales.forEach(def=>{
    let p = cfg.profesionales.find(x=>x.id===def.id);
    if(!p){ cfg.profesionales.push(structuredClone(def)); return; }
    if(!p.nombre) p.nombre=def.nombre;
    if(!p.area) p.area=def.area;
    if(!Array.isArray(p.prestaciones)) p.prestaciones=[];
    def.prestaciones.forEach(pr=>{ if(!p.prestaciones.includes(pr)) p.prestaciones.push(pr); });
    p.valores = p.valores && typeof p.valores==='object' ? p.valores : {};
    Object.entries(def.valores||{}).forEach(([k,v])=>{
      if((p.id==='matias' || p.id==='rogelio') && (!Number(p.valores[k]) || Number(p.valores[k])<0)) p.valores[k]=v;
      else if(p.valores[k]===undefined || p.valores[k]===null || p.valores[k]==='') p.valores[k]=v;
    });
  });
  defaults.obrasSociales.forEach(os=>{ if(!cfg.obrasSociales.includes(os)) cfg.obrasSociales.push(os); });
  cfg.reglasOS = Object.assign({}, defaults.reglasOS, cfg.reglasOS);
  // Reparación de variantes comunes.
  if(cfg.obrasSociales.includes('Prevencion Salud') && !cfg.obrasSociales.includes('Prevención Salud')) cfg.obrasSociales.push('Prevención Salud');
  if(cfg.reglasOS['Prevencion Salud'] && !cfg.reglasOS['Prevención Salud']) cfg.reglasOS['Prevención Salud']=cfg.reglasOS['Prevencion Salud'];
  cfg.reglasOS['IOMA']='IOMA_OSPRERA';
  cfg.reglasOS['OSPRERA']='IOMA_OSPRERA';
  cfg.reglasOS['OSDE']='OSDE';
  cfg.reglasOS['Sancor']='SANCOR_PREVENCION';
  cfg.reglasOS['Prevención Salud']='SANCOR_PREVENCION';
  cfg.reglasOS['Integral']='INTEGRAL';
  cfg.reglasOS['PAMI']='COBERTURA_COBRA_PARTICULAR';
  return cfg;
}
function loadConfig(){
  let cfg=null;
  try{ cfg=JSON.parse(localStorage.getItem(storageConfig)||'null'); }catch(e){ cfg=null; }
  return normalizarConfigCritica(cfg || structuredClone(defaults));
}

function loadAtenciones(){
 const current=JSON.parse(localStorage.getItem(storageAtenciones) || 'null');
 if(current) return current;
 const oldKeys=['cardiolink_atenciones_v14','cardiolink_atenciones_v13','cardiolink_atenciones_v12','cardiolink_atenciones_v11'];
 for(const k of oldKeys){const v=JSON.parse(localStorage.getItem(k)||'null'); if(v&&Array.isArray(v)) return v}
 return [];
}

function esAtencionCorrupta(a){
  if(!a || typeof a!=='object')return true;
  if(esMensajeInterno(a))return false;
  const paciente=String(a.paciente??'').trim();
  const dni=String(a.dni??'').trim();
  const tel=String(a.telefono??'').trim();
  const prest=String(a.prestacion??'').trim();
  const os=String(a.obraSocial??a.coberturaAtencion??'').trim();
  const prof=String(a.profesionalId??a.profesional??'').trim();
  const id=String(a.id??'').trim();
  const pacienteOk=!literalInvalido(paciente);
  const dniOk=!literalInvalido(dni) && /\d{5,}/.test(dni.replace(/\D/g,''));
  const telOk=!literalInvalido(tel) && /\d{6,}/.test(tel.replace(/\D/g,''));
  const prestOk=!literalInvalido(prest);
  const osOk=!literalInvalido(os);
  const profOk=!literalInvalido(prof);
  const idMalo=literalInvalido(id) || id==='0';
  const tieneIdentidad=pacienteOk || dniOk || telOk;

  // Registros vacíos o creados por el bug WhatsApp/undefined.
  if(!tieneIdentidad && (!prestOk || !profOk || !osOk))return true;
  if(!pacienteOk && !dniOk && !telOk)return true;
  if(!prestOk || !profOk || !osOk)return true;
  if(idMalo && !tieneIdentidad)return true;
  // Filas con todos los campos visibles en undefined.
  const visibles=[paciente, prest, os, prof, String(a.consultaA??''), String(a.prestacionA??''), String(a.tipoCobro??'')];
  const undefCount=visibles.filter(v=>String(v).trim().toLowerCase()==='undefined').length;
  if(undefCount>=2)return true;
  return false;
}
function limpiarRegistrosCorruptosSilencioso(){
  const antes=Array.isArray(atenciones)?atenciones.length:0;
  const vistos=new Set();
  atenciones=(atenciones||[]).filter(a=>{
    if(esAtencionCorrupta(a)) return false;
    const id=String(a.id||'').trim();
    if(!id || id==='undefined' || id==='null') return false;
    if(vistos.has(id)) return false;
    vistos.add(id);
    return true;
  });
  const eliminados=antes-atenciones.length;
  if(eliminados>0){
    console.warn('CardioLink limpió registros corruptos/undefined:',eliminados);
    localStorage.setItem(storageAtenciones,JSON.stringify(atenciones));
    programarSyncSupabase();
  }
  return eliminados;
}

async function limpiarRegistrosCorruptosManual(){
  if(!exigirConfigAdministrativa('Tu perfil no puede ejecutar mantenimiento sensible.'))return;
  const eliminados = limpiarRegistrosCorruptosSilencioso();
  localStorage.setItem(storageAtenciones, JSON.stringify(atenciones));
  if (supabaseClient && usuarioSupabase) {
    await sincronizarAtencionesSupabase(true);
  }
  try { renderTabla(); } catch(e) { console.warn(e); }
  try { if (typeof renderAgenda === 'function') renderAgenda(); } catch(e) { console.warn(e); }
  try { renderStats(); } catch(e) { console.warn(e); }
  alert(eliminados > 0
    ? `Se eliminaron ${eliminados} registros corruptos/incompletos y se sincronizó Supabase.`
    : 'No se encontraron registros corruptos/incompletos para eliminar.');
}
window.limpiarRegistrosCorruptosManual = limpiarRegistrosCorruptosManual;

function asegurarValorSelect(id,valorFallback){
  const el=$(id);
  if(!el)return '';
  if((el.value==='' || el.value==='undefined' || el.value==null) && valorFallback!=null){
    ensureSelectOption(el,valorFallback);
    el.value=valorFallback;
  }
  return el.value;
}
function atencionValidaParaGuardar(a){
  if(!a || typeof a!=='object')return false;
  if(esAtencionCorrupta(a))return false;
  if(!String(a.paciente||'').trim() && !String(a.dni||'').trim())return false;
  if(!String(a.prestacion||'').trim() || String(a.prestacion).trim()==='undefined')return false;
  if(!String(a.profesionalId||'').trim() || String(a.profesionalId).trim()==='undefined')return false;
  if(!String(a.obraSocial||'').trim() || String(a.obraSocial).trim()==='undefined')return false;
  return true;
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
function getRegla(os){ if(os==='PAMI') return 'COBERTURA_COBRA_PARTICULAR'; return (data.reglasOS||{})[os] || (defaults.reglasOS||{})[os] || 'GENERAL_CONSULTA_EXTRA'}
function setRegla(os,regla){if(!data.reglasOS)data.reglasOS={};data.reglasOS[os]=regla;saveConfig()}
function escapeHtml(s){return String(s??'').replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;')}
function esMensajeInterno(a){return a && a.tipoRegistro==='mensaje';}
function atencionesOperativas(datos=atenciones){return (datos||[]).filter(a=>!esMensajeInterno(a) && !esAtencionCorrupta(a));}
function llenarSelect(sel,items,val=x=>x,txt=x=>x){sel.innerHTML='';items.forEach(i=>{const o=document.createElement('option');o.value=val(i);o.textContent=txt(i);sel.appendChild(o)})}
function llenarTodos(sel,items,label){sel.innerHTML=`<option value="">${label}</option>`;items.forEach(i=>{const o=document.createElement('option');o.value=i;o.textContent=i;sel.appendChild(o)})}

function init(){
  // Init robusto: ningún botón faltante debe romper toda la app.
  const on = (id, ev, fn) => {
    const el = $(id);
    if (el && typeof fn === 'function') el.addEventListener(ev, fn);
  };

  try { document.body.classList.toggle('dark', localStorage.getItem('cardiolink_dark_v25') === '1'); } catch(e) {}
  try { refreshSelects(); } catch(e) { console.warn('refreshSelects falló:', e); }
  if ($('fecha')) $('fecha').value = todayISO();
  if ($('adminDesde')) $('adminDesde').value = todayISO();
  if ($('adminHasta')) $('adminHasta').value = todayISO();
  try { cambiarPerfil(esMedico() ? (profesionalIdUsuarioActual() || 'general') : 'general'); } catch(e) { console.warn('cambiarPerfil inicial falló:', e); }
  try { showSection('dashboard'); } catch(e) { console.warn('showSection dashboard falló:', e); }
  try { if (typeof renderConfig === 'function') renderConfig(); } catch(e) { console.warn('renderConfig falló:', e); }
  try { aplicarPermisosUI(); actualizarInstructivoRolActual(); } catch(e) { console.warn('aplicarPermisosUI falló:', e); }
  try { actualizarHora(); setInterval(actualizarHora,30000); } catch(e) {}

  document.querySelectorAll('.nav').forEach(b=>b.addEventListener('click',()=>showSection(b.dataset.section)));
  actualizarNotificacionMensajes();

  on('btnDark','click',()=>{document.body.classList.toggle('dark');localStorage.setItem('cardiolink_dark_v25',document.body.classList.contains('dark')?'1':'0')});
  on('btnIrCarga','click',()=>showSection('carga'));
  on('btnToggleConteo','click',()=>{mostrarConteoDashboard=!mostrarConteoDashboard;renderStats();});
  on('perfilActivo','change',e=>cambiarPerfil(e.target.value));

  ['profesional','obraSocial','prestacion'].forEach(id=>on(id,'change',()=>{if(id==='profesional')actualizarPrestaciones();actualizarExtrasPrestaciones();aplicarRegla();calcularCajaCarga()}));
  ['tipoCobro','formaPago','montoConsulta','montoEstudio','montoCopago'].forEach(id=>on(id,'input',calcularCajaCarga));

  on('formAtencion','submit',guardarAtencion);
  on('btnGuardarNuevo','click',()=>{guardarYContinuar=true;$('formAtencion')?.requestSubmit()});
  on('btnNuevoRegistro','click',()=>{limpiarForm();showSection('carga')});
  on('btnLimpiar','click',limpiarForm);

  on('btnBuscarPaciente','click',buscarPacienteDesdeCarga);
  on('buscarPaciente','keydown',(e)=>{if(e.key==='Enter'){e.preventDefault();buscarPacienteDesdeCarga();}});
  on('buscarPaciente','input',()=>{const q=$('buscarPaciente').value.trim();if(q.length>=3)buscarPacienteDesdeCarga();});
  on('btnLimpiarBuscarPaciente','click',()=>{if($('buscarPaciente'))$('buscarPaciente').value=''; if($('resultadosPacientes'))$('resultadosPacientes').innerHTML='';});
  on('btnImportarMedicloud','click',abrirImportadorMedicloud);
  on('btnImportarWhatsapp','click',abrirImportadorWhatsapp);
  on('btnNuevoPacienteManual','click',nuevoPacienteManual);
  on('dni','blur',buscarPacientePorDniSiExiste);

  on('btnHoy','click',()=>{const h=todayISO();$('fDesde').value=h;$('fHasta').value=h;paginaListado=1;mostrarResumenFiltros();renderTabla();calcularLiquidacionColocaciones()});
  on('btnMes','click',()=>{const d=new Date();const y=d.getFullYear();const m=String(d.getMonth()+1).padStart(2,'0');$('fDesde').value=`${y}-${m}-01`;$('fHasta').value=todayISO();paginaListado=1;mostrarResumenFiltros();renderTabla();calcularLiquidacionColocaciones()});
  on('btnPeriodo20','click',setPeriodo20);
  on('btnFiltrar','click',()=>{paginaListado=1;mostrarResumenFiltros();renderTabla();calcularLiquidacionColocaciones()});
  on('btnResetFiltros','click',resetFiltros);
  on('btnPendientesGlobal','click',activarFiltroPendientesGlobal);
  on('btnVerPendientesSolapa','click',()=>{showSection('listado');activarFiltroPendientesGlobal();});

  on('btnLiqCalcular','click',renderLiquidacionColocacionesSolapa);
  on('btnLiqPrint','click',imprimirLiquidacionColocaciones);
  on('btnLiqMes','click',()=>{const d=new Date();const y=d.getFullYear();const m=String(d.getMonth()+1).padStart(2,'0');$('liqDesde').value=`${y}-${m}-01`;$('liqHasta').value=todayISO();renderLiquidacionColocacionesSolapa();});

  on('btnPaginaAnterior','click',()=>{if(paginaListado>1){paginaListado--;renderTabla();}});
  on('btnPaginaSiguiente','click',()=>{paginaListado++;renderTabla();});
  on('btnPrint','click',()=>{setPrintMeta();document.body.classList.toggle('print-money',!!$('incluirValoresImpresion')?.checked);window.print();setTimeout(()=>document.body.classList.remove('print-money'),500)});
  on('btnExportExcel','click',exportarCSV);

  const vc=valoresColocacion();
  if($('valorColocacionHolter'))$('valorColocacionHolter').value=vc.holter;
  if($('valorColocacionMapa'))$('valorColocacionMapa').value=vc.mapa;
  if($('valorColocacionEcg'))$('valorColocacionEcg').value=vc.ecg;
  if($('liqValorHolter'))$('liqValorHolter').value=vc.holter;
  if($('liqValorMapa'))$('liqValorMapa').value=vc.mapa;
  if($('liqValorEcg'))$('liqValorEcg').value=vc.ecg;
  if($('liqDesde')){const d=new Date();const y=d.getFullYear();const m=String(d.getMonth()+1).padStart(2,'0');$('liqDesde').value=`${y}-${m}-01`;$('liqHasta').value=todayISO();}
  on('btnCalcularLiquidacion','click',()=>{mostrarResumenFiltros();calcularLiquidacionColocaciones()});
  ['valorColocacionHolter','valorColocacionMapa','valorColocacionEcg'].forEach(id=>on(id,'input',()=>{guardarValoresColocacion();calcularLiquidacionColocaciones()}));

  on('btnVerDineroPeriodo','click',verDineroPeriodo);
  on('btnOcultarDineroPeriodo','click',ocultarDineroPeriodo);
  on('btnGuardarValores','click',guardarValores);
  on('cfgProfesionalValores','change',cargarValoresConfig);
  on('cfgReglaOS','change',cargarReglaConfig);
  on('btnGuardarReglaOS','click',guardarReglaConfig);
  on('btnAddProfesional','click',addProfesional);
  on('btnAddOS','click',addOS);
  on('btnAddPrestacion','click',addPrestacion);
  on('btnExportBackup','click',exportarBackup);
  on('btnImportBackup','click',importarBackup);
  on('btnBorrarDatos','click',()=>{if(!exigirConfigAdministrativa('Tu perfil no puede borrar atenciones.'))return;if(confirm('¿Borrar atenciones?')){atenciones=[];saveAtenciones();renderTabla();renderStats()}});
  on('btnAddUsuarioSistema','click',agregarUsuarioSistema);
  on('btnBuscarDuplicadosPacientes','click',renderDuplicadosPacientes);

  // Solapa Pacientes
  on('btnPacientesBuscar','click',()=>renderPacientesPanel($('pacientesBuscar')?.value||'',false));
  on('pacientesBuscar','keydown',(e)=>{if(e.key==='Enter'){e.preventDefault();renderPacientesPanel($('pacientesBuscar')?.value||'',false);}});
  on('pacientesBuscar','input',()=>{const q=$('pacientesBuscar').value.trim(); if(q.length>=3)renderPacientesPanel(q,false);});
  on('btnPacientesLimpiar','click',()=>{if($('pacientesBuscar'))$('pacientesBuscar').value=''; pacienteSeleccionadoPanelId=''; renderPacientesPanel('',true); if($('pacienteDetalle'))$('pacienteDetalle').innerHTML='<h3>Ficha del paciente</h3><p class="muted">Seleccioná un paciente de la lista. Desde acá podés ver su historial cruzado entre médicos, editar datos básicos o cargar una nueva atención.</p>';});
  on('btnPacientesTodos','click',()=>renderPacientesPanel('',true));
  on('btnPacientesDuplicados','click',()=>{renderDuplicadosPacientes(); const a=$('resultadoDuplicadosPacientes'), b=$('resultadoDuplicadosPacientesPacientes'); if(a&&b)b.innerHTML=a.innerHTML;});

  // Mensajes internos
  on('btnEnviarMensaje','click',enviarMensajeInterno);
  on('btnLimpiarMensaje','click',limpiarMensajeInterno);
  on('btnMensajesActualizar','click',renderMensajes);
  on('btnMensajesMarcarLeidos','click',marcarMensajesVisiblesLeidos);
  on('msgFraseRapida','change',()=>{const v=$('msgFraseRapida')?.value||''; if(v) $('msgTexto').value=v;});
  on('msgFiltro','change',renderMensajes);
  document.querySelectorAll('.msgQuick').forEach(b=>b.addEventListener('click',()=>{if($('msgTexto'))$('msgTexto').value=b.dataset.text||b.textContent||'';}));

  // Agenda / sala
  on('btnAgendaActualizar','click',renderAgenda);
  on('btnAgendaHoy','click',()=>{if($('agendaFecha'))$('agendaFecha').value=todayISO();renderAgenda();});
  on('agendaFecha','change',renderAgenda);
  on('agendaProfesional','change',renderAgenda);
  on('agendaEstado','change',renderAgenda);
  on('agendaVista','change',()=>{guardarPreferenciaAgenda($('agendaVista')?.value||'tabla');renderAgenda();});
  on('btnAgendaModalCerrar','click',cerrarAgendaModal);

  // Estadísticas / gráficos
  on('btnStatsGenerar','click',renderEstadisticas);
  on('btnStatsMes','click',()=>{setPeriodoStatsMes();renderEstadisticas();});
  on('btnStatsHoy','click',()=>{const h=todayISO(); if($('statsDesde'))$('statsDesde').value=h; if($('statsHasta'))$('statsHasta').value=h; renderEstadisticas();});
  ['statsDesde','statsHasta','statsProfesional','statsOS','statsPrestacion','statsEstado'].forEach(id=>on(id,'change',renderEstadisticas));

  const agendaModal=$('agendaModal');
  if(agendaModal)agendaModal.addEventListener('click',e=>{if(e.target===agendaModal)cerrarAgendaModal();});
  try { initAgenda(); } catch(e) { console.warn('initAgenda falló:', e); }

  try { renderTabla(); } catch(e) { console.warn('renderTabla falló:', e); }
  try { renderStats(); } catch(e) { console.warn('renderStats falló:', e); }
  try { ocultarResumenFiltros(); } catch(e) {}
}
function refreshSelects(){
 llenarSelect($('perfilActivo'),data.profesionales,p=>p.id,p=>p.nombre);
 llenarSelect($('profesional'),data.profesionales.filter(p=>p.id!=='general'),p=>p.id,p=>p.nombre);
 llenarSelect($('obraSocial'),data.obrasSociales);
 llenarTodos($('fOS'),data.obrasSociales,'Todas las OS');
if(puedeVerFacturaRogelio()){
 const optFacturaRogelio=document.createElement('option');
 optFacturaRogelio.value=FILTRO_FACTURA_ROGELIO;
 optFacturaRogelio.textContent='Factura Rogelio / Holter';
 $('fOS').appendChild(optFacturaRogelio);
}
 llenarTodos($('fProfesional'),data.profesionales.filter(p=>p.id!=='general').map(p=>p.nombre),'Todos los médicos');
 llenarSelectAgendaProfesionales();
 llenarSelectEstadisticas();
 llenarTodos($('fPrestacion'),allPrestaciones(),'Todas las prestaciones');
 llenarSelect($('profPrestacion'),data.profesionales.filter(p=>p.id!=='general'),p=>p.id,p=>p.nombre);
 llenarSelect($('cfgProfesionalValores'),data.profesionales.filter(p=>p.id!=='general'),p=>p.id,p=>p.nombre);
 llenarSelect($('cfgReglaOS'),data.obrasSociales);
}

function actualizarInstructivoRolActual(){
  const box=$('instructivoRolActual');
  if(!box)return;
  let html='';
  if(esMatiasDuenio()){
    html=`<p>Estás usando el perfil <strong>Matías / dueño</strong>. Este perfil administra el sistema completo.</p>
    <ol>
      <li>Gestiona pacientes, turnos, atenciones, profesionales y configuraciones.</li>
      <li>Administra caja global, reportes generales, colocaciones y circuitos internos.</li>
      <li>Crea usuarios internos, define roles, especialidades y profesionales asociados.</li>
      <li>Configura obras sociales, reglas, prestaciones, valores y copagos.</li>
      <li>Revisa mantenimiento de pacientes, duplicados y auditoría del sistema.</li>
    </ol>`;
  }else if(esSecretaria()){
    html=`<p>Estás usando un perfil de <strong>Secretaría</strong>. Este perfil gestiona el trabajo operativo del consultorio.</p>
    <ol>
      <li>Carga y gestiona turnos/atenciones de todos los profesionales.</li>
      <li>Busca pacientes, importa datos desde otra app y actualiza datos administrativos.</li>
      <li>Actualiza coberturas, bonos, autorizaciones, copagos y estados administrativos.</li>
      <li>Agrega obras sociales, prestaciones, reglas y valores cuando esté habilitado.</li>
      <li>Coordina pacientes, pendientes, colocaciones y comunicación interna del consultorio.</li>
    </ol>`;
  }else if(esMedico()){
    html=`<p>Estás usando un perfil de <strong>Médico</strong>. Este perfil está orientado a la actividad propia del profesional.</p>
    <ol>
      <li>Consulta sus turnos/atenciones y pacientes asociados.</li>
      <li>Carga turnos propios cuando corresponda.</li>
      <li>Actualiza estados de atención cuando esté habilitada la agenda.</li>
      <li>Consulta su historial profesional y reportes propios por rango cuando estén habilitados.</li>
      <li>Usa mensajes internos para coordinar con secretaría y otros profesionales.</li>
    </ol>`;
  }else{
    html=`<p>Este usuario todavía no tiene un perfil interno completo. Matías debe configurarlo desde Usuarios, roles y permisos.</p>`;
  }
  box.innerHTML=html;
}

function showSection(id){
  if(!seccionPermitida(id)){alert('Tu perfil no tiene permiso para abrir esta sección.');return;}
  aplicarPermisosUI();
  document.querySelectorAll('.section').forEach(s=>s.classList.remove('visible'));
  if($(id))$(id).classList.add('visible');
  document.querySelectorAll('.nav').forEach(b=>b.classList.toggle('active',b.dataset.section===id));
  if(id==='dashboard'){
    if($('tituloBienvenida'))$('tituloBienvenida').textContent='Dashboard';
    if($('subtituloPerfil'))$('subtituloPerfil').textContent='Resumen del perfil activo';
    renderStats();
  }else if(id==='carga'){
    if($('tituloBienvenida'))$('tituloBienvenida').textContent='Carga de turno/atención';
    if($('subtituloPerfil'))$('subtituloPerfil').textContent='Carga operativa de pacientes, coberturas y prestaciones';
  }else if(id==='agenda'){
    if($('tituloBienvenida'))$('tituloBienvenida').textContent='Agenda / sala de espera';
    if($('subtituloPerfil'))$('subtituloPerfil').textContent='Turnos del día y estados de atención';
    initAgenda();
    renderAgenda();
  }else if(id==='mensajes'){
    if($('tituloBienvenida'))$('tituloBienvenida').textContent='Mensajes internos';
    if($('subtituloPerfil'))$('subtituloPerfil').textContent='Comunicación simple entre secretaría y profesionales';
    initMensajes();
    renderMensajes();
  }else if(id==='listado'){
    if($('tituloBienvenida'))$('tituloBienvenida').textContent='Listado / filtros';
    if($('subtituloPerfil'))$('subtituloPerfil').textContent='Búsqueda y listados de atenciones';
    renderTabla();
  }else if(id==='instructivos'){
    if($('tituloBienvenida'))$('tituloBienvenida').textContent='Instructivos de uso';
    if($('subtituloPerfil'))$('subtituloPerfil').textContent='Guía según el perfil activo';
    actualizarInstructivoRolActual();
  }else if(id==='pacientes'){
    if($('tituloBienvenida'))$('tituloBienvenida').textContent='Pacientes';
    if($('subtituloPerfil'))$('subtituloPerfil').textContent='Ficha administrativa e historial cruzado entre profesionales';
    renderPacientesPanel($('pacientesBuscar')?.value||'',false);
  }else if(id==='caja'){
    if($('tituloBienvenida'))$('tituloBienvenida').textContent='Caja / reportes';
    if($('subtituloPerfil'))$('subtituloPerfil').textContent='Panel reservado para Matías';
  }else if(id==='estadisticas'){
    if($('tituloBienvenida'))$('tituloBienvenida').textContent='Estadísticas / gráficos';
    if($('subtituloPerfil'))$('subtituloPerfil').textContent='Indicadores por período, OS, prestación y profesional';
    initEstadisticas();
    renderEstadisticas();
  }else if(id==='colocaciones'){
    if($('tituloBienvenida'))$('tituloBienvenida').textContent='Colocaciones / pendientes';
    if($('subtituloPerfil'))$('subtituloPerfil').textContent='Liquidación y pendientes de estudios';
    renderLiquidacionColocacionesSolapa();
  }else if(id==='config'){
    if($('tituloBienvenida'))$('tituloBienvenida').textContent='Configuración';
    if($('subtituloPerfil'))$('subtituloPerfil').textContent='Profesionales, obras sociales, valores, usuarios y reglas';
  }
}
function cambiarPerfil(id){
 if(esMedico()){id=profesionalIdUsuarioActual()||id;}
 $('perfilActivo').value=id;const p=perfilObj();
 $('tituloBienvenida').textContent=p.id==='general'?'Vista General / Administración':`Bienvenido ${p.nombre}`;
 $('subtituloPerfil').textContent=p.area||'';
 if($('profesional'))$('profesional').value=p.id==='general'?'matias':p.id;
 if($('instructivoPerfiles'))$('instructivoPerfiles').classList.toggle('hidden',p.id!=='general');
 paginaListado=1;actualizarPrestaciones();aplicarRegla();renderTabla();renderStats();aplicarPermisosUI();
}
function actualizarHora(){const a=new Date();$('fechaHoraPanel').textContent=a.toLocaleDateString('es-AR',{weekday:'long',day:'2-digit',month:'2-digit',year:'numeric'})+' · '+a.toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'})}
function actualizarPrestaciones(){
 const p=profesionalCarga();
 const items=p?.prestaciones?.length?p.prestaciones:allPrestaciones();
 llenarSelect($('prestacion'),items);
 actualizarExtrasPrestaciones();
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

  if(getRegla(os)==='COBERTURA_COBRA_PARTICULAR'){
    $('tipoCobro').value='Particular';
    $('formaPago').value='Efectivo';
    setSelectValue('facturador','Particular');
    if(esConsulta(prest)) $('montoConsulta').value=valorPrestacionActual();
    else $('montoEstudio').value=valorPrestacionActual();
    $('reglaInfo').textContent=`${nombre}: ${os} informativa. Se cobra como particular ${money(valorPrestacionActual())}.`;
  } else if(os==='Particular'){
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
 if(regla==='COBERTURA_COBRA_PARTICULAR'){ $('tipoCobro').value='Particular';$('formaPago').value='Efectivo';setSelectValue('facturador','Particular');setSelectValue('consultaA', esConsulta(prest)?'Matías':'No aplica');setSelectValue('prestacionA', esConsulta(prest)?'No aplica':'Matías'); if(esConsulta(prest))$('montoConsulta').value=valorPrestacionActual(); else $('montoEstudio').value=valorPrestacionActual(); $('bonoConsulta').checked=false;$('bonoEstudio').checked=false; info=`${os}: cobertura informativa. Se cobra como particular (${money(valorPrestacionActual())}).`; }
 else if(os==='Particular'){ $('tipoCobro').value='Particular';$('formaPago').value='Efectivo';setSelectValue('facturador','Particular'); if(esConsulta(prest))$('montoConsulta').value=valorPrestacionActual(); else $('montoEstudio').value=valorPrestacionActual(); info=`Particular: ${money(valorPrestacionActual())}.`; }
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
function calcularCajaCarga(){const tipo=$('tipoCobro').value;let total=0;if(tipo==='No cobrar'){ $('montoConsulta').value=0;$('montoEstudio').value=0;$('montoCopago').value=0;$('montoTotal').value=0;return;}const part=Number($('montoConsulta').value||0)+Number($('montoEstudio').value||0);const cop=Number($('montoCopago').value||0);if(tipo.includes('Particular'))total+=part;if(tipo.includes('Copago')||tipo.includes('copago'))total+=cop;$('montoTotal').value=total}
function limpiarForm(){
 $('formAtencion').reset();
 $('fecha').value=todayISO();
 if($('colocador'))$('colocador').value='Geraldine';
 if($('pacienteId'))$('pacienteId').value='';
 if($('buscarPaciente'))$('buscarPaciente').value='';
 if($('resultadosPacientes'))$('resultadosPacientes').innerHTML='';
 if($('pacienteSeleccionadoBox')){$('pacienteSeleccionadoBox').innerHTML='';$('pacienteSeleccionadoBox').classList.add('hidden')}
 document.querySelectorAll('.extra-prestacion,.no-cobrar-inline input').forEach(ch=>ch.checked=false);
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
function valorDePrestacion(profId, prestacion){
 const p=data.profesionales.find(x=>x.id===profId)||profesionalCarga();
 if(!p)return 0;
 const v=valoresDelProfesional(p);
 if(esConsulta(prestacion))return v.consulta;
 if(esElectro(prestacion))return v.electro;
 return v.estudio;
}
function copagoDePrestacion(profId, prestacion){
 const p=data.profesionales.find(x=>x.id===profId)||profesionalCarga();
 if(!p)return 0;
 const v=valoresDelProfesional(p);
 const t=tipoPrest(prestacion);
 if(t==='CONSULTA'||t==='CONSULTA_ECG')return v.copagoConsulta;
 if(t==='ECG')return v.copagoElectro || v.copagoConsulta;
 return v.copagoEstudio;
}
function calcularMontosParaRegistro(prestacion,{adicional=false,noCobrar=false}={}){
 if(noCobrar)return {montoConsulta:0,montoEstudio:0,montoCopago:0,montoTotal:0,tipoCobro:'No cobrar',formaPago:'No aplica',noCobrar:true};
 const tipo=$('tipoCobro').value;
 const os=$('obraSocial').value;
 const profId=$('profesional').value;
 const regla=getRegla(os);
 const t=tipoPrest(prestacion);
 let montoConsulta=0,montoEstudio=0,montoCopago=0,montoTotal=0;
 let tipoCobro=tipo;
 let formaPago=$('formaPago').value;
 if(adicional){
   // En estudios adicionales se cobra por prestación, pero la consulta no se duplica.
   if(os==='Particular' || tipo.includes('Particular')){
     tipoCobro='Particular';formaPago=formaPago==='No aplica'?'Efectivo':formaPago;
     montoEstudio=valorDePrestacion(profId,prestacion);
   } else if(regla==='IOMA_OSPRERA' || tipo.includes('Copago')){
     tipoCobro='Copago';formaPago=formaPago==='No aplica'?'Efectivo':formaPago;
     montoCopago=copagoDePrestacion(profId,prestacion);
   } else {
     tipoCobro='Sin cobro en caja';formaPago='No aplica';
   }
 } else {
   montoConsulta=Number($('montoConsulta').value||0);
   montoEstudio=Number($('montoEstudio').value||0);
   montoCopago=Number($('montoCopago').value||0);
 }
 if(tipoCobro.includes('Particular'))montoTotal+=montoConsulta+montoEstudio;
 if(tipoCobro.includes('Copago')||tipoCobro.includes('copago'))montoTotal+=montoCopago;
 return {montoConsulta,montoEstudio,montoCopago,montoTotal,tipoCobro,formaPago,noCobrar:false};
}
function crearAtencionDesdeFormulario(prestacion, opciones={}){
 const profId=asegurarValorSelect('profesional', esMedico()?profesionalIdUsuarioActual():'matias') || 'matias';
 const osValor=asegurarValorSelect('obraSocial','Particular') || 'Particular';
 const prestValor=String(prestacion || $('prestacion')?.value || '').trim();
 const prof=data.profesionales.find(x=>x.id===profId)||profesionalCarga()||data.profesionales.find(x=>x.id==='matias');
 const esAdicional=!!opciones.adicional;
 const noCobrar=!!opciones.noCobrar;
 const grupoTurnoId=opciones.grupoTurnoId || ('turno_'+Date.now());
 const estadoInforme=tomarEstadoInformeDesdeCarga();
 const observacionesBase=$('observaciones')?.value.trim()||'';
 const montos=calcularMontosParaRegistro(prestValor,{adicional:esAdicional,noCobrar});
 const cuentaConsulta = esAdicional ? false : true;
 const pacienteNombre=($('paciente')?.value||'').trim();
 const dniValor=($('dni')?.value||'').trim();
 return {
  id:Date.now()+Math.floor(Math.random()*100000),
  grupoTurnoId,
  pacienteId:$('pacienteId')?.value || pacienteIdPorDni(dniValor) || '',
  fecha:$('fecha')?.value || todayISO(),
  horaInicio:$('horaInicio')?.value||'',
  horaFin:$('horaFin')?.value||'',
  estadoTurno:'reservado',
  paciente:pacienteNombre,
  dni:dniValor,
  telefono:$('telefono')?.value.trim()||'',
  email:$('email')?.value.trim()||'',
  fechaNacimiento:$('fechaNacimiento')?.value||'',
  obraSocial:osValor,
  coberturaAtencion:osValor,
  numeroAfiliadoAtencion:$('numeroAfiliado')?.value.trim()||'',
  profesionalId:profId,
  profesional:prof?.nombre||'',
  prestacion:prestValor,
  consultaA:$('consultaA')?.value || 'Matías',
  prestacionA:$('prestacionA')?.value || 'Matías',
  facturador:$('facturador')?.value || 'Matías',
  tipoCobro:montos.tipoCobro,
  formaPago:montos.formaPago,
  noCobrar:!!montos.noCobrar,
  cajaPerfil:profId,
  reglaOS:getRegla(osValor),
  montoConsulta:montos.montoConsulta,
  montoEstudio:montos.montoEstudio,
  montoCopago:montos.montoCopago,
  montoTotal:montos.montoTotal,
  cuentaConsulta,
  bonoConsulta:cuentaConsulta ? ($('bonoConsulta')?.checked||false) : false,
  bonoEstudio: tipoPrest(prestValor)!=='CONSULTA' ? true : ($('bonoEstudio')?.checked||false),
  bonoFirmado:$('bonoFirmado')?.checked||false,
  copiaImpresa:$('copiaImpresa')?.checked||false,
  requiereCopiaImpresa: tipoPrest(prestValor)!=='CONSULTA',
  fold2:$('fold2')?.checked||false,
  planilla:$('planilla')?.checked||false,
  colocacionLiquidable: esPrestacionColocable(prestValor) ? ($('colocacionLiquidable')?.checked||false) : false,
  colocador:$('colocador')?.value||'',
  ...estadoInforme,
  creadoPor: nombreUsuarioAuditoria(),
  creadoUsuario: usuarioActualNombreCorto(),
  creadoRol: perfilUsuarioActual().rol || '',
  creadoEn: new Date().toISOString(),
  editadoPor:'',
  editadoUsuario:'',
  editadoRol:'',
  editadoEn:'',
  observaciones:esAdicional ? [observacionesBase,'Estudio adicional del mismo turno'].filter(Boolean).join(' | ') : observacionesBase
 };
}

function prestacionesAdicionalesSeleccionadas(prestPrincipal){
 const extras=[];
 document.querySelectorAll('.extra-prestacion:checked').forEach(ch=>{
   const prest=ch.dataset.prestacion;
   if(!prest || prest===prestPrincipal)return;
   const noId='noCobrar_'+prest.replaceAll(' ','_').replaceAll('/','_');
   extras.push({prestacion:prest,noCobrar:!!$(noId)?.checked});
 });
 return extras;
}
let guardandoAtencion=false;
function guardarAtencion(e){
 if(e)e.preventDefault();
 if(guardandoAtencion)return;
 guardandoAtencion=true;
 try{
  calcularCajaCarga();
  const nombre=($('paciente')?.value||'').trim();
  const dni=($('dni')?.value||'').trim();
  if(!nombre && !dni){alert('Falta seleccionar o cargar paciente.');return;}
  asegurarValorSelect('obraSocial','Particular');
  asegurarValorSelect('profesional',esMedico()?profesionalIdUsuarioActual():'matias');
  if(!$('prestacion')?.value){alert('Falta seleccionar prestación.');return;}
  const paciente=upsertPacienteDesdeCarga();
  const registros=[];
  const grupoTurnoId='turno_'+Date.now();
  const prestPrincipal=$('prestacion').value;
  const noCobrarPrincipal=$('tipoCobro').value==='No cobrar';
  registros.push(crearAtencionDesdeFormulario(prestPrincipal,{grupoTurnoId,noCobrar:noCobrarPrincipal}));
  prestacionesAdicionalesSeleccionadas(prestPrincipal).forEach(extra=>{
    const r=crearAtencionDesdeFormulario(extra.prestacion,{grupoTurnoId,adicional:true,noCobrar:extra.noCobrar});
    registros.push(r);
  });
  registros.forEach(r=>{if(paciente?.id)r.pacienteId=paciente.id;});
  const validos=registros.filter(atencionValidaParaGuardar);
  if(!validos.length){alert('No se pudo guardar: el registro quedó incompleto. Revisá paciente, cobertura, profesional y prestación.');return;}
  if(validos.length!==registros.length)console.warn('Se descartaron registros incompletos antes de guardar:',registros.filter(r=>!atencionValidaParaGuardar(r)));
  validos.forEach(r=>{ try{ if(typeof window.aplicarArancelSnapshot3102Final==='function') window.aplicarArancelSnapshot3102Final(r,false); }catch(e){ console.warn('No se pudo fijar arancel estimado',e); } });
  atenciones.push(...validos);
  limpiarRegistrosCorruptosSilencioso();
  saveAtenciones();
  renderTabla();
  if(typeof renderAgenda==='function')renderAgenda();
  renderStats();
  if(resumenFiltrosVisible)calcularLiquidacionColocaciones();
  limpiarForm();
  if(guardarYContinuar){guardarYContinuar=false;showSection('carga');setTimeout(()=>$('buscarPaciente')?.focus(),50)}else showSection('listado')
 }finally{
  guardandoAtencion=false;
 }
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
  box.innerHTML = (puedeVerFacturaRogelio() && $('fOS')?.value===FILTRO_FACTURA_ROGELIO) ? facturaRogelioHTML(datos) : '';
}



function normalizarTexto(s){return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();}
function pacienteIdPorDni(dni){const d=String(dni||'').replace(/\D/g,'');if(!d)return'';return (data.pacientes||[]).find(p=>String(p.dni||'').replace(/\D/g,'')===d)?.id||'';}
function pacientesDesdeAtenciones(){
 const mapa=new Map();
 atenciones.forEach(a=>{
   const dni=dniLimpio(a.dni);
   const nombre=normalizarTexto(a.paciente||'');
   const key=a.pacienteId || dni || nombre;
   if(!key || mapa.has(key))return;
   mapa.set(key,{id:a.pacienteId||('legacy_'+key),nombreCompleto:a.paciente||'',dni:a.dni||'',telefono:a.telefono||'',email:a.email||'',fechaNacimiento:a.fechaNacimiento||'',coberturaHabitual:a.obraSocial||'',numeroAfiliadoHabitual:a.numeroAfiliadoAtencion||'',origen:'historial'});
 });
 return Array.from(mapa.values());
}
function mergePacienteInfo(dest, src){
 if(!dest || !src)return dest;
 ['nombreCompleto','dni','telefono','email','fechaNacimiento','sexo','localidad','direccion','provincia','coberturaHabitual','numeroAfiliadoHabitual','contactoResponsableNombre','contactoResponsableRelacion','contactoResponsableTelefono','contactoResponsableEmail'].forEach(k=>{
   if(!dest[k] && src[k])dest[k]=src[k];
 });
 return dest;
}
function todosPacientes(){
 const lista=[];
 const activos=[...(data.pacientes||[]).filter(pacienteActivoPanel),...pacientesDesdeAtenciones()];
 activos.forEach(p=>{
   const dni=dniLimpio(p.dni);
   const nombre=normalizarTexto(p.nombreCompleto||p.paciente||'');
   const id=String(p.id||'');
   let existente=null;
   if(id)existente=lista.find(x=>String(x.id||'')===id);
   if(!existente && dni)existente=lista.find(x=>dniLimpio(x.dni)===dni);
   if(!existente && nombre)existente=lista.find(x=>normalizarTexto(x.nombreCompleto||x.paciente||'')===nombre);
   if(existente){
     mergePacienteInfo(existente,p);
     // Si el existente es legacy y el nuevo tiene id persistente, conservar el persistente.
     if(String(existente.id||'').startsWith('legacy_') && p.id && !String(p.id).startsWith('legacy_')) existente.id=p.id;
   }else{
     lista.push({...p});
   }
 });
 return lista;
}
function buscarPacientes(q){
 const nq=normalizarTexto(q||'');
 const nd=String(q||'').replace(/\D/g,'');
 if(!nq && !nd)return[];
 const lista=todosPacientes().filter(p=>{
   const dni=String(p.dni||'').replace(/\D/g,'');
   const tel=String(p.telefono||'').replace(/\D/g,'');
   const nombre=normalizarTexto(p.nombreCompleto||p.paciente||'');
   const email=normalizarTexto(p.email||'');
   const ats=atencionesPacienteGlobal ? atencionesPacienteGlobal(p) : [];
   return (nd && dni.includes(nd)) ||
          (nd && tel.includes(nd)) ||
          (nq && nombre.includes(nq)) ||
          (nq && email.includes(nq)) ||
          ats.some(a=>normalizarTexto(a.paciente||'').includes(nq) || normalizarTexto(a.profesional||'').includes(nq) || normalizarTexto(a.prestacion||'').includes(nq));
 }).sort((a,b)=>nombrePacientePanel(a).localeCompare(nombrePacientePanel(b),'es'));
 return lista.slice(0,20);
}
function renderResultadosPacientes(lista){
 const box=$('resultadosPacientes');if(!box)return;
 if(!lista.length){box.innerHTML='<div class="muted">No encontré paciente local. Podés cargarlo manual o importar desde otra app.</div>';return;}
 box.innerHTML=lista.map(p=>`<div class="paciente-result"><div><strong>${escapeHtml(p.nombreCompleto||'Paciente')}</strong><br><small>DNI ${escapeHtml(p.dni||'s/d')} · ${escapeHtml(p.telefono||'')} · Cobertura habitual: ${escapeHtml(p.coberturaHabitual||'s/d')}</small></div><button type="button" class="secondary" onclick="usarPaciente('${escapeHtml(p.id)}')">Usar</button></div>`).join('');
}
function buscarPacienteDesdeCarga(){const q=($('buscarPaciente')?.value||'').trim(); renderResultadosPacientes(buscarPacientes(q));}
function buscarPacientePorDniSiExiste(){const dni=$('dni')?.value||'';if(String(dni).replace(/\D/g,'').length>=6){const r=buscarPacientes(dni);if(r.length)renderResultadosPacientes(r);}}
function usarPaciente(id){
 const p=todosPacientes().find(x=>x.id===id);if(!p)return;
 $('pacienteId').value=p.id;
 $('paciente').value=p.nombreCompleto||'';
 $('dni').value=p.dni||'';
 if($('telefono'))$('telefono').value=p.telefono||'';
 if($('email'))$('email').value=p.email||'';
 if($('fechaNacimiento'))$('fechaNacimiento').value=fechaISODesdeTexto(p.fechaNacimiento||'')||p.fechaNacimiento||'';
 if(p.coberturaHabitual){ensureSelectOption($('obraSocial'),p.coberturaHabitual);$('obraSocial').value=p.coberturaHabitual;}
 if($('numeroAfiliado'))$('numeroAfiliado').value=p.numeroAfiliadoHabitual||'';
 if($('pacienteSeleccionadoBox')){$('pacienteSeleccionadoBox').classList.remove('hidden');$('pacienteSeleccionadoBox').innerHTML=`Paciente seleccionado: <strong>${escapeHtml(p.nombreCompleto||'')}</strong> · DNI ${escapeHtml(p.dni||'')} · cobertura habitual ${escapeHtml(p.coberturaHabitual||'s/d')}`;}
 if($('resultadosPacientes'))$('resultadosPacientes').innerHTML='';
 aplicarRegla();
}
function nuevoPacienteManual(){
 if($('pacienteId'))$('pacienteId').value='';
 if($('resultadosPacientes'))$('resultadosPacientes').innerHTML='<div class="muted">Cargá los datos manualmente. Si ponés DNI, CardioLink evitará duplicados al guardar.</div>';
}
function upsertPacienteDesdeCarga(){
 const dni=String($('dni')?.value||'').replace(/\D/g,'');
 const nombreCompleto=($('paciente')?.value||'').trim();
 if(!dni && !nombreCompleto)return null;
 if(!Array.isArray(data.pacientes))data.pacientes=[];
 let p=dni?data.pacientes.find(x=>String(x.dni||'').replace(/\D/g,'')===dni):null;
 if(!p && $('pacienteId')?.value)p=data.pacientes.find(x=>x.id===$('pacienteId').value);
 if(!p){p={id:'pac_'+Date.now()+Math.floor(Math.random()*10000),historialCoberturas:[]};data.pacientes.push(p);}
 p.nombreCompleto=nombreCompleto;
 p.dni=$('dni')?.value.trim()||p.dni||'';
 p.telefono=$('telefono')?.value.trim()||p.telefono||'';
 p.email=$('email')?.value.trim()||p.email||'';
 p.fechaNacimiento=$('fechaNacimiento')?.value||p.fechaNacimiento||'';
 const os=$('obraSocial')?.value||'';
 const afiliado=$('numeroAfiliado')?.value.trim()||'';
 const actualizar=$('actualizarCoberturaHabitual')?.checked || !p.coberturaHabitual;
 if(actualizar){
   if(p.coberturaHabitual && p.coberturaHabitual!==os){
     p.historialCoberturas=p.historialCoberturas||[];
     p.historialCoberturas.push({cobertura:p.coberturaHabitual,numeroAfiliado:p.numeroAfiliadoHabitual||'',hasta:todayISO()});
   }
   p.coberturaHabitual=os;
   p.numeroAfiliadoHabitual=afiliado;
 }
 p.actualizadoEn=new Date().toISOString();
 $('pacienteId').value=p.id;
 saveConfig();
 return p;
}
function fechaISODesdeTexto(t){
 const m=String(t||'').match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
 if(!m)return'';
 let y=m[3]; if(y.length===2)y='19'+y;
 return `${y.padStart(4,'0')}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
}
function parsearTextoMedicloud(txt){
 const lines=String(txt||'').split(/\n+/).map(x=>x.trim()).filter(Boolean);
 function despuesDe(etiquetas){
   for(let i=0;i<lines.length;i++){
     const n=normalizarTexto(lines[i]);
     if(etiquetas.some(e=>n.includes(e))){
       for(let j=i+1;j<Math.min(lines.length,i+4);j++){
         if(!normalizarTexto(lines[j]).includes('opcional') && !normalizarTexto(lines[j]).includes('nombre') && !normalizarTexto(lines[j]).includes('apellido')) return lines[j];
       }
     }
   }
   return '';
 }
 const nombre=despuesDe(['nombre']);
 const apellido=despuesDe(['apellido']);
 const email=(txt.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)||[''])[0];
 const dni=despuesDe(['dni / cedula','dni / cédula','pasaporte']) || (txt.match(/\b\d{7,8}\b/)||[''])[0];
 const tel=(txt.match(/(?:\+?54)?\s?9?\s?\d{8,11}/)||[''])[0];
 const fn=despuesDe(['fecha de nacimiento']);
 return {nombreCompleto:[apellido,nombre].filter(Boolean).join(' ').trim(),dni,email,telefono:tel,fechaNacimiento:fechaISODesdeTexto(fn)};
}
function abrirImportadorMedicloud(){
 const overlay=document.createElement('div');
 overlay.id='modalImportMedicloud';
 overlay.innerHTML=`<div class="modal-edit-card modal-import-card"><div class="modal-edit-header"><div><h2>Importar paciente desde otra app</h2><p>Copiá los datos visibles de la otra app, pegalos acá y CardioLink evita duplicados por DNI.</p></div><button type="button" class="modal-close" onclick="cerrarImportadorMedicloud()">×</button></div><textarea id="textoMedicloud" rows="10" placeholder="Pegá acá el texto copiado desde la otra app"></textarea><div class="modal-actions"><button class="secondary" type="button" onclick="cerrarImportadorMedicloud()">Cancelar</button><button class="primary" type="button" onclick="aplicarImportMedicloud()">Completar paciente</button></div></div>`;
 document.body.appendChild(overlay);
 setTimeout(()=>$('textoMedicloud')?.focus(),50);
}
function cerrarImportadorMedicloud(){const m=$('modalImportMedicloud');if(m)m.remove();}
function aplicarImportMedicloud(){
 const datos=parsearTextoMedicloud($('textoMedicloud')?.value||'');
 if(!datos.nombreCompleto && !datos.dni){alert('No pude detectar nombre o DNI. Pegá más datos de la ficha.');return;}
 const existente=datos.dni?buscarPacientes(datos.dni)[0]:null;
 if(existente && !confirm('Este DNI ya existe en CardioLink. ¿Actualizar la ficha existente con los datos copiados desde otra app?')){usarPaciente(existente.id);cerrarImportadorMedicloud();return;}
 $('paciente').value=datos.nombreCompleto||'';
 $('dni').value=datos.dni||'';
 if($('telefono'))$('telefono').value=datos.telefono||'';
 if($('email'))$('email').value=datos.email||'';
 if($('fechaNacimiento'))$('fechaNacimiento').value=datos.fechaNacimiento||'';
 upsertPacienteDesdeCarga();
 const id=$('pacienteId').value;
 if(id)usarPaciente(id);
 cerrarImportadorMedicloud();
}

function mesNumeroDesdeTexto(mes){
 const m=normalizarTexto(mes||'');
 const mapa={enero:1,febrero:2,marzo:3,abril:4,mayo:5,junio:6,julio:7,agosto:8,septiembre:9,setiembre:9,octubre:10,noviembre:11,diciembre:12};
 return mapa[m]||'';
}
function fechaISODesdeWhatsapp(txt){
 const t=String(txt||'');
 let m=t.match(/\b(\d{1,2})\s*(?:de)?\s*(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\s*(?:de)?\s*(\d{2,4})?\b/i);
 if(m){
   let y=m[3]||String(new Date().getFullYear()); if(y.length===2)y='20'+y;
   const mm=mesNumeroDesdeTexto(m[2]);
   return `${String(y).padStart(4,'0')}-${String(mm).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`;
 }
 m=t.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
 if(m){
   let y=m[3]||String(new Date().getFullYear()); if(y.length===2)y='20'+y;
   return `${String(y).padStart(4,'0')}-${String(m[2]).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`;
 }
 return '';
}
function horaDesdeWhatsapp(txt){
 const m=String(txt||'').match(/\b(\d{1,2})[:.](\d{2})\s*(?:hs|h|hrs)?\b/i);
 if(!m)return '';
 return `${String(m[1]).padStart(2,'0')}:${m[2]}`;
}
function sumarMinutosHora(hora,min){
 if(!hora)return '';
 const [hh,mm]=hora.split(':').map(Number);
 const d=new Date(2000,0,1,hh||0,mm||0); d.setMinutes(d.getMinutes()+min);
 return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
function valorCampoWhatsapp(txt, patrones){
 const lines=String(txt||'').split(/\n+/).map(x=>x.replace(/^[\s•\-*]+/,'').trim()).filter(Boolean);
 for(const l of lines){
   const n=normalizarTexto(l);
   for(const pat of patrones){
     if(n.includes(pat)){
       let v=l.replace(/^.*?(?:\:|\.\s)/,'').trim();
       // Si no hubo separador, quita la etiqueta aproximada
       v=v.replace(/^(numero\s+de\s+dni|nro\s+de\s+dni|dni|nombre\s+y\s+apellido|nombre\s+apellido|mail|email|e-mail|obra\s+social|cobertura|f\.?\s*de\s*nacimiento|fecha\s+de\s+nacimiento|telefono|teléfono|tel)\s*/i,'').trim();
       return v;
     }
   }
 }
 return '';
}
function detectarPrestacionWhatsapp(txt){
 const n=normalizarTexto(txt||'');
 if(n.includes('mapa'))return 'MAPA';
 if(n.includes('holter'))return 'Holter';
 if(n.includes('ecocardiograma')||n.includes('eco doppler')||n.includes('doppler'))return 'Ecocardiograma Doppler';
 if(n.includes('electrocardiograma')||n.includes('ecg')||n.includes('riesgo quirurgico')||n.includes('riesgo quirúrgico'))return 'Electrocardiograma';
 if(n.includes('apto fisico')||n.includes('apto físico'))return 'Apto físico';
 if(n.includes('cardiologia')||n.includes('cardiología')||n.includes('consulta'))return 'Consulta';
 return '';
}
function parsearTextoWhatsapp(txt){
 const raw=String(txt||'');
 const email=(raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)||[''])[0];
 const dniRaw=valorCampoWhatsapp(raw,['numero de dni','nro de dni','dni']);
 const dni=(dniRaw.match(/\d{6,9}/)||raw.match(/\b\d{7,9}\b/)||[''])[0];
 const nombre=valorCampoWhatsapp(raw,['nombre y apellido','nombre apellido','apellido y nombre']);
 const telRaw=valorCampoWhatsapp(raw,['telefono','teléfono','tel ']);
 const tel=(telRaw.match(/(?:\+?54)?\s?9?\s?\d{8,11}/)||raw.match(/(?:\+?54)?\s?9?\s?\d{8,11}/)||[''])[0];
 const os=valorCampoWhatsapp(raw,['obra social','cobertura','prepaga']);
 const fnRaw=valorCampoWhatsapp(raw,['f. de nacimiento','fecha de nacimiento','nacimiento']);
 const fechaNacimiento=fechaISODesdeWhatsapp(fnRaw);
 const prestacion=detectarPrestacionWhatsapp(raw);
 const fechaTurno=fechaISODesdeWhatsapp(raw.match(/(?:lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo)[^\n]*/i)?.[0]||'');
 const horaInicio=horaDesdeWhatsapp(raw);
 const lineas=raw.split(/\n+/).map(x=>x.trim()).filter(Boolean);
 const motivo=lineas.filter(l=>/para|motivo|estudio|consulta|cardio|eco|mapa|holter|electro|apto/i.test(l)).slice(-2).join(' · ');
 return {nombreCompleto:nombre,dni,email,telefono:tel,fechaNacimiento,obraSocial:os,prestacion,fechaTurno,horaInicio,horaFin:sumarMinutosHora(horaInicio,20),motivo};
}
function abrirImportadorWhatsapp(){
 const overlay=document.createElement('div');
 overlay.id='modalImportWhatsapp';
 overlay.innerHTML=`<div class="modal-edit-card modal-import-card"><div class="modal-edit-header"><div><h2>Importar paciente/turno desde WhatsApp</h2><p>Copiá el mensaje de WhatsApp con los datos del paciente y pegalos acá. CardioLink intentará completar paciente, cobertura, prestación, fecha y horario.</p></div><button type="button" class="modal-close" onclick="cerrarImportadorWhatsapp()">×</button></div><textarea id="textoWhatsapp" rows="11" placeholder="Pegá acá el mensaje copiado de WhatsApp"></textarea><div class="modal-actions"><button class="secondary" type="button" onclick="cerrarImportadorWhatsapp()">Cancelar</button><button class="primary" type="button" onclick="aplicarImportWhatsapp()">Completar paciente/turno</button></div></div>`;
 document.body.appendChild(overlay);
 setTimeout(()=>$('textoWhatsapp')?.focus(),50);
}
function cerrarImportadorWhatsapp(){const m=$('modalImportWhatsapp');if(m)m.remove();}
function aplicarImportWhatsapp(){
 const datos=parsearTextoWhatsapp($('textoWhatsapp')?.value||'');
 if(!datos.nombreCompleto && !datos.dni && !datos.telefono){alert('No pude detectar datos suficientes. Pegá el mensaje completo de WhatsApp.');return;}
 const existente=datos.dni?buscarPacientes(datos.dni)[0]:(datos.telefono?buscarPacientes(datos.telefono)[0]:null);
 if(existente){usarPaciente(existente.id);} else {
   if($('paciente'))$('paciente').value=datos.nombreCompleto||'';
   if($('dni'))$('dni').value=datos.dni||'';
   if($('telefono'))$('telefono').value=datos.telefono||'';
   if($('email'))$('email').value=datos.email||'';
   if($('fechaNacimiento'))$('fechaNacimiento').value=datos.fechaNacimiento||'';
   upsertPacienteDesdeCarga();
   const id=$('pacienteId')?.value; if(id)usarPaciente(id);
 }
 // Completa/actualiza datos del turno aunque el paciente ya existiera
 if(datos.nombreCompleto && !$('paciente')?.value)$('paciente').value=datos.nombreCompleto;
 if(datos.dni && !$('dni')?.value)$('dni').value=datos.dni;
 if(datos.telefono && $('telefono') && !$('telefono').value)$('telefono').value=datos.telefono;
 if(datos.email && $('email') && !$('email').value)$('email').value=datos.email;
 if(datos.fechaNacimiento && $('fechaNacimiento') && !$('fechaNacimiento').value)$('fechaNacimiento').value=datos.fechaNacimiento;
 if(datos.obraSocial && $('obraSocial')){ensureSelectOption($('obraSocial'),datos.obraSocial);$('obraSocial').value=datos.obraSocial;}
 if(datos.prestacion && $('prestacion')){ensureSelectOption($('prestacion'),datos.prestacion);$('prestacion').value=datos.prestacion;actualizarExtrasPrestaciones();}
 if(datos.fechaTurno && $('fecha'))$('fecha').value=datos.fechaTurno;
 if(datos.horaInicio && $('horaInicio'))$('horaInicio').value=datos.horaInicio;
 if(datos.horaFin && $('horaFin') && !$('horaFin').value)$('horaFin').value=datos.horaFin;
 if(datos.motivo && $('observaciones'))$('observaciones').value=($('observaciones').value?$('observaciones').value+'\n':'')+'Importado desde WhatsApp: '+datos.motivo;
 aplicarRegla(); calcularCajaCarga(); cerrarImportadorWhatsapp();
}
function actualizarExtrasPrestaciones(){
 const prest=$('prestacion')?.value||'';
 document.querySelectorAll('.extra-prestacion').forEach(ch=>{
   ch.disabled=ch.dataset.prestacion===prest;
   if(ch.disabled)ch.checked=false;
 });
}
function atencionesPerfil(){
 const base = atencionesOperativas(Array.isArray(atenciones) ? atenciones : []);
 if(esMedico()){
   const pid=profesionalIdUsuarioActual();
   return base.filter(a=>a.profesionalId===pid || a.cajaPerfil===pid);
 }
 const p=perfilObj();
 if(p.id==='general')return base;
 if(p.id==='matias')return base.filter(a=>a.profesionalId==='matias'||a.consultaA==='Matías'||a.prestacionA==='Matías');
 if(p.id==='rogelio')return base.filter(a=>a.profesionalId==='rogelio'||a.consultaA==='Rogelio'||a.prestacionA==='Rogelio');
 return base.filter(a=>a.profesionalId===p.id);
}

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
function filtrar(){const desde=$('fDesde').value,hasta=$('fHasta').value,os=$('fOS').value,prof=$('fProfesional').value,prest=$('fPrestacion').value,pac=$('fPaciente').value.toLowerCase().trim(),dest=$('fDestino').value;return atencionesPerfil().filter(a=>{if(modoPendientesGlobal&&!esPendienteAdministrativo(a))return false;if(!modoPendientesGlobal){if(desde&&a.fecha<desde)return false;if(hasta&&a.fecha>hasta)return false;}if(os===FILTRO_FACTURA_ROGELIO){ if(!puedeVerFacturaRogelio()) return false; if(!esRegistroFacturaRogelio(a))return false;}if(os&&os!==FILTRO_FACTURA_ROGELIO&&a.obraSocial!==os)return false;if(prof&&a.profesional!==prof)return false;if(prest&&a.prestacion!==prest)return false;if(pac&&!String(a.paciente||'').toLowerCase().includes(pac))return false;if(dest&&a.consultaA!==dest&&a.prestacionA!==dest)return false;return true}).sort((a,b)=>(b.fecha||'').localeCompare(a.fecha||''))}
function consultaComputada(a){if(a.cuentaConsulta===false)return false;const t=tipoPrest(a.prestacion),r=a.reglaOS||getRegla(a.obraSocial);if(t==='CONSULTA'||t==='CONSULTA_ECG')return true;if(t==='ECG'&&r==='IOMA_OSPRERA')return true;if(t!=='CONSULTA'){return ['GENERAL_CONSULTA_EXTRA','SANCOR_PREVENCION','IOMA_OSPRERA','OSDE'].includes(r)}return !!a.bonoConsulta}
function resumen(datos){return datos.reduce((r,a)=>{if(consultaComputada(a))r.consultas++;if(tipoPrest(a.prestacion)!=='CONSULTA')r.estudios++;if(a.bonoConsulta||consultaComputada(a))r.bonoConsulta++;if(a.bonoEstudio||tipoPrest(a.prestacion)!=='CONSULTA')r.bonoEstudio++;const particular=Number(a.montoConsulta||0)+Number(a.montoEstudio||0);const copago=Number(a.montoCopago||0);r.particular+=particular;r.copago+=copago;r.total+=particular+copago;return r},{consultas:0,estudios:0,bonoConsulta:0,bonoEstudio:0,particular:0,copago:0,total:0})}
function dineroVisible(a){
 const cp=a.cajaPerfil||a.profesionalId;
 let perfilCaja=perfilObj().id;
 if(esMedico()) perfilCaja=profesionalIdUsuarioActual();
 if(perfilCaja==='general')return {particular:0,copago:0,total:0};
 if(cp!==perfilCaja)return {particular:0,copago:0,total:0};
 const particular=Number(a.montoConsulta||0)+Number(a.montoEstudio||0);
 const copago=Number(a.montoCopago||0);
 return {particular,copago,total:particular+copago};
}
function atencionesCajaDelPerfil(datos = atencionesOperativas()) {
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

function cajaHoy(datos = atencionesOperativas()) {
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
function diasAntiguedadPendiente411C(a){
  if(!a || !a.fecha)return null;
  try{const f=new Date(String(a.fecha)+'T12:00:00');const h=new Date();h.setHours(12,0,0,0);if(Number.isNaN(f.getTime()))return null;return Math.max(0,Math.floor((h-f)/86400000));}catch(e){return null;}
}
function nivelPendiente411C(a){
  try{if(typeof esPendienteAdministrativo==='function'&&!esPendienteAdministrativo(a))return null;}catch(e){return null;}
  const d=diasAntiguedadPendiente411C(a);if(d==null)return null;
  if(d>14)return {dias:d,cls:'critical',label:'Crítico'};if(d>7)return {dias:d,cls:'overdue',label:'Vencido'};if(d>=4)return {dias:d,cls:'delayed',label:'Demorado'};return {dias:d,cls:'normal',label:'En término'};
}
function badgeAntiguedadPendiente411C(a){const n=nivelPendiente411C(a);if(!n||n.cls==='normal')return '';const icon=n.cls==='critical'?'⚠️ ':'';return `<span class="badge pending-age-411c ${n.cls}" title="Pendiente desde hace ${n.dias} días">${icon}${n.label} · ${n.dias} d</span>`;}
function estadoHTML(a,e){const nc=a.noCobrar?'<span class="badge neutral informe-badge">No cobrado</span>':'';return `<span class="badge ${e.cls}">${e.txt}</span>${nc}${badgesInforme(a)}${badgeAntiguedadPendiente411C(a)}`;}

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
    tr.innerHTML=`<td>${formatFecha(a.fecha)}</td><td><strong>${escapeHtml(a.paciente||'')}</strong></td><td>${escapeHtml(a.prestacion||'')}</td><td>${escapeHtml(a.colocador||'')}</td><td>${money(valor)}</td><td><button class="secondary" onclick="editarAtencion(${idJS(a.id)})">Editar</button></td>`;
    tbody.appendChild(tr);
  });
}
function idJS(id){return JSON.stringify(String(id));}
function renderTabla(){const tbody=$('tablaAtenciones');tbody.innerHTML='';const datos=filtrar();renderResumenCaja(datos);actualizarResumenFacturaRogelio(datos);if(resumenFiltrosVisible)calcularLiquidacionColocaciones();const totalPaginas=Math.max(1,Math.ceil(datos.length/TAMANIO_PAGINA_LISTADO));if(paginaListado>totalPaginas)paginaListado=totalPaginas;if(paginaListado<1)paginaListado=1;actualizarPaginacionListado(datos.length,totalPaginas);const inicio=(paginaListado-1)*TAMANIO_PAGINA_LISTADO;const datosPagina=datos.slice(inicio,inicio+TAMANIO_PAGINA_LISTADO);if(!datos.length){tbody.innerHTML='<tr><td colspan="14">No hay registros para mostrar.</td></tr>';return}datosPagina.forEach(a=>{const e=evaluarEstado(a),m=dineroVisible(a),part=m.particular;const tr=document.createElement('tr');if(editandoId===a.id){tr.className='edit-row';tr.innerHTML=`<td><input type="date" id="e_fecha_${a.id}" value="${a.fecha||''}"></td><td><input id="e_paciente_${a.id}" value="${escapeHtml(a.paciente)}"><input id="e_obs_${a.id}" value="${escapeHtml(a.observaciones||'')}" placeholder="Obs."></td><td>${selectHTML('e_os_'+a.id,data.obrasSociales,a.obraSocial)}</td><td>${selectProfesionalesHTML('e_prof_'+a.id,a.profesionalId)}</td><td>${selectPrestacionesHTML('e_prest_'+a.id,a.profesionalId,a.prestacion)}</td><td>${selectHTML('e_consultaA_'+a.id,opcionesDestinos(a.consultaA),a.consultaA)}</td><td>${selectHTML('e_prestacionA_'+a.id,opcionesDestinos(a.prestacionA),a.prestacionA)}</td><td>${selectHTML('e_tipoCobro_'+a.id,['Sin cobro en caja','No cobrar','Copago','Particular','Particular + copago'],a.tipoCobro)}<div class="inline-checks-edit"><label><input type="checkbox" id="e_bonoConsulta_${a.id}" ${a.bonoConsulta?'checked':''}> Bono consulta</label><label><input type="checkbox" id="e_bonoEstudio_${a.id}" ${a.bonoEstudio?'checked':''}> Bono estudio</label><label><input type="checkbox" id="e_bonoFirmado_${a.id}" ${a.bonoFirmado?'checked':''}> Bono firmado</label><label><input type="checkbox" id="e_copiaImpresa_${a.id}" ${a.copiaImpresa?'checked':''}> Copia</label><label><input type="checkbox" id="e_fold2_${a.id}" ${a.fold2?'checked':''}> Fold2</label><label><input type="checkbox" id="e_planilla_${a.id}" ${a.planilla?'checked':''}> Planilla</label><label><input type="checkbox" id="e_colocacionLiquidable_${a.id}" ${a.colocacionLiquidable?'checked':''}> Colocación liquidable</label><label>Colocador/a ${selectHTML('e_colocador_'+a.id,['Geraldine','Secretaría','Otro'],a.colocador||'Geraldine')}</label></div></td><td>${selectHTML('e_formaPago_'+a.id,['No aplica','Efectivo','Transferencia','Débito','Mixto'],a.formaPago||'No aplica')}</td><td><input type="number" id="e_particular_${a.id}" value="${Number(a.montoConsulta||0)+Number(a.montoEstudio||0)}"></td><td><input type="number" id="e_copago_${a.id}" value="${Number(a.montoCopago||0)}"></td><td>${money(a.montoTotal)}</td><td class="estado-cell">${estadoHTML(a,e)}</td><td class="no-print actions-cell"><div class="edit-actions"><button class="small-btn" onclick="guardarEdicion(${idJS(a.id)})">Guardar</button><button class="small-btn" onclick="cancelarEdicion()">Cancelar</button></div></td>`}else{tr.innerHTML=`<td>${formatFecha(a.fecha)}</td><td><strong>${escapeHtml(a.paciente)}</strong>${a.observaciones?'<br><small>'+escapeHtml(a.observaciones)+'</small>':''}</td><td>${a.obraSocial}</td><td>${a.profesional}</td><td>${prestacionListado(a)}${badgeColocacion(a)}</td><td>${a.consultaA}</td><td>${a.prestacionA}</td><td>${a.tipoCobro||''}</td><td>${a.formaPago||'No aplica'}</td><td class="money-col">${money(part)}</td><td class="money-col">${money(m.copago)}</td><td class="money-col">${money(m.total)}</td><td class="estado-cell">${estadoHTML(a,e)}</td><td class="no-print actions-cell"><div class="edit-actions"><button type="button" data-action="listado-editar" data-id="${escapeHtml(a.id)}" onclick="editarAtencion(${idJS(a.id)})">Editar</button><button type="button" data-action="listado-borrar" data-id="${escapeHtml(a.id)}" onclick="eliminarAtencion(${idJS(a.id)})">Borrar</button></div></td>`}tbody.appendChild(tr)})}
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
function renderStats(){const datos=atencionesPerfil(),c=cajaHoy(datos);$('statTotal').textContent=mostrarConteoDashboard?datos.length:'•••';if($('btnToggleConteo'))$('btnToggleConteo').textContent=mostrarConteoDashboard?'Ocultar':'Mostrar';$('statHoy').textContent=datos.filter(a=>a.fecha===todayISO()).length;$('statPendientes').textContent=datos.filter(a=>evaluarEstado(a).cls==='bad').length;$('statParticular').textContent=money(c.particular);$('statCopagos').textContent=money(c.copago);$('statTotalCaja').textContent=money(c.total);if($('dashboardDetalle')){$('dashboardDetalle').style.display='block';const u=perfilUsuarioActual();$('dashboardDetalle').textContent=`Sesión: ${u.nombre||u.usuario} · ${labelRol(u.rol)}${u.especialidad?' · '+u.especialidad:''}`;}}

function selectHTML(id,items,selected){return `<select id="${id}">`+items.map(x=>`<option ${x===selected?'selected':''}>${escapeHtml(x)}</option>`).join('')+'</select>'}
function opcionesDestinos(extra){const base=['Matías','Rogelio','No aplica','A definir'];data.profesionales.filter(p=>p.id!=='general').forEach(p=>base.push(p.nombre));if(extra)base.push(extra);return [...new Set(base.filter(Boolean))];}
function selectProfesionalesHTML(id,selected){return `<select id="${id}">`+data.profesionales.filter(p=>p.id!=='general').map(p=>`<option value="${p.id}" ${p.id===selected?'selected':''}>${escapeHtml(p.nombre)}</option>`).join('')+'</select>'}
function selectPrestacionesHTML(id,prof,selected){const p=data.profesionales.find(x=>x.id===prof);const items=p?.prestaciones?.length?p.prestaciones:allPrestaciones();return selectHTML(id,items,selected)}
function editarAtencion(id){abrirModalEdicion(id)}
function cancelarEdicion(){cerrarModalEdicion()}

function abrirModalEdicion(id){
  const a=atenciones.find(x=>String(x.id)===String(id));
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
        <div><label>Tipo de cobro</label>${selectHTML('m_tipoCobro',['Sin cobro en caja','No cobrar','Copago','Particular','Particular + copago'],a.tipoCobro||'Sin cobro en caja')}</div>
        <div><label>Forma de pago</label>${selectHTML('m_formaPago',['No aplica','Efectivo','Transferencia','Débito','Mixto'],a.formaPago||'No aplica')}</div>
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
      ${auditoriaHTML(a)}
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
  const a=atenciones.find(x=>String(x.id)===String(id));
  if(!a)return;
  const profId=$('m_prof').value;
  const prof=data.profesionales.find(p=>p.id===profId);
  const prest=$('m_prest').value;
  const tipo=$('m_tipoCobro').value;
  const part=Number($('m_particular').value||0);
  const cop=Number($('m_copago').value||0);
  let total=0;
  if(tipo==='No cobrar'){total=0;} else {if(tipo.includes('Particular'))total+=part;if(tipo.includes('Copago')||tipo.includes('copago'))total+=cop;}
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
  a.noCobrar=tipo==='No cobrar';
  a.montoConsulta=a.noCobrar?0:(esConsulta(prest)?part:0);
  a.montoEstudio=a.noCobrar?0:(esConsulta(prest)?0:part);
  a.montoCopago=a.noCobrar?0:cop;
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
  try{ if(typeof window.aplicarArancelSnapshot3102Final==='function') window.aplicarArancelSnapshot3102Final(a,true); }catch(e){ console.warn('No se pudo actualizar arancel estimado',e); }
  selloAuditoriaEdicion(a);
  saveAtenciones();
  cerrarModalEdicion();
  renderTabla();
  renderStats();
  if(resumenFiltrosVisible)calcularLiquidacionColocaciones();
}

function guardarEdicion(id){guardarEdicionModal(id)}
function eliminarAtencion(id){if(!confirm('¿Borrar esta atención?'))return;atenciones=atenciones.filter(a=>String(a.id)!==String(id));saveAtenciones();renderTabla();renderStats()}

function setPeriodo20(){const d=new Date();let y=d.getFullYear(),m=d.getMonth()+1,day=d.getDate(),dy=y,dm=m,hy=y,hm=m+1;if(day<20){dm=m-1;hm=m}if(dm<1){dm=12;dy--}if(hm>12){hm=1;hy++}$('fDesde').value=`${dy}-${String(dm).padStart(2,'0')}-20`;$('fHasta').value=`${hy}-${String(hm).padStart(2,'0')}-20`;paginaListado=1;mostrarResumenFiltros();renderTabla();calcularLiquidacionColocaciones()}
function resetFiltros(){
 $('fDesde').value='';
 $('fHasta').value='';
 $('fOS').value='';
 $('fProfesional').value='';
 $('fPrestacion').value='';
 $('fPaciente').value='';
 $('fDestino').value='';
 paginaListado=1;
 modoPendientesGlobal=false;
 ocultarResumenFiltros();
 renderTabla();
 renderStats();
}
function verDineroPeriodo(){
  const res=$('dineroPeriodoResultado');
  if(!puedeVerCajaGlobal()){ if(res)res.textContent='Panel reservado para Matías.'; return; }
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
function exportarCSV(){const datos=filtrar();if(!datos.length){alert('No hay datos');return}const r=resumen(datos);const incluirValoresExport=!!$('incluirValoresImpresion')?.checked;const filas=[['CardioLink Admin v4.1.0-hc'],['Perfil',perfilObj().nombre],['Consultas',r.consultas],['Estudios',r.estudios],[],['Fecha','Paciente','OS','Profesional','Prestación','Consulta a','Estudio a','Tipo','Forma','Particular visible','Copago visible','Total visible','Estado']];datos.forEach(a=>{const m=dineroVisible(a),e=evaluarEstado(a);filas.push([formatFecha(a.fecha),a.paciente,a.obraSocial,a.profesional,prestacionListado(a),a.consultaA,a.prestacionA,a.tipoCobro,a.formaPago,incluirValoresExport?m.particular:'',incluirValoresExport?m.copago:'',incluirValoresExport?m.total:'',e.txt])});const csv=filas.map(r=>r.map(c=>`"${String(c??'').replaceAll('"','""')}"`).join(';')).join('\n');const blob=new Blob(['\ufeff'+csv],{type:'text/csv'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='CardioLink_listado.csv';a.click()}
function exportarBackup(){if(!exigirConfigAdministrativa('Tu perfil no puede exportar backups completos.'))return;const b={app:'CardioLink Admin',version:'4.1.0-hc',fechaExportacion:new Date().toISOString(),config:data,atenciones};const blob=new Blob([JSON.stringify(b,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='CardioLink_Admin_backup.json';a.click()}
function importarBackup(){if(!exigirConfigAdministrativa('Tu perfil no puede restaurar backups.'))return;const inp=$('inputImportBackup');if(!inp.files[0]){alert('Elegí archivo');return}if(!confirm('Reemplaza la base actual. ¿Continuar?'))return;const rd=new FileReader();rd.onload=e=>{try{const b=JSON.parse(e.target.result);if(!b.config||!b.atenciones)throw new Error();data=b.config;atenciones=b.atenciones;saveConfig();saveAtenciones();refreshSelects();renderConfig();cambiarPerfil('general');alert('Backup importado')}catch{alert('Backup inválido')}};rd.readAsText(inp.files[0])}

function dniLimpio(v){return String(v||'').replace(/\D/g,'');}
function telLimpio(v){return String(v||'').replace(/\D/g,'');}
function nombreClavePaciente(p){return normalizarTexto(p.nombreCompleto||p.paciente||'').replace(/\s+/g,' ').trim();}
function pacienteActivoConfig(p){return p && p.estado!=='fusionado';}
function atencionesDelPaciente(p){
  const dni=dniLimpio(p.dni);
  const nombre=normalizarTexto(p.nombreCompleto||p.paciente||'');
  return atenciones.filter(a=>{
    if(p.id && a.pacienteId===p.id)return true;
    if(dni && dniLimpio(a.dni)===dni)return true;
    if(nombre && normalizarTexto(a.paciente||'')===nombre)return true;
    return false;
  });
}
function idsAtencionesPacienteParaDuplicados(p){
  return new Set(atencionesDelPaciente(p).map(a=>String(a.id||'')));
}
function compartenAtenciones(a,b){
  const A=idsAtencionesPacienteParaDuplicados(a), B=idsAtencionesPacienteParaDuplicados(b);
  if(!A.size || !B.size) return false;
  for(const id of A){ if(id && B.has(id)) return true; }
  return false;
}
function duplicadoYaResuelto(a,b){
  if(!Array.isArray(data.auditoriaPacientes)) return false;
  const ids=[String(a.id||''),String(b.id||''),normalizarTexto(a.nombreCompleto||''),normalizarTexto(b.nombreCompleto||'')].filter(Boolean);
  return data.auditoriaPacientes.some(x=>x.tipo==='fusion_paciente' && ids.includes(String(x.principalId||'')) && ids.includes(String(x.duplicadoId||'')));
}
function detectarDuplicadosPacientes(){
  if(!Array.isArray(data.pacientes))data.pacientes=[];
  const pacientes=[...(data.pacientes||[]).filter(pacienteActivoPanel),...pacientesDesdeAtenciones().filter(pacienteActivoPanel)].filter(p=>p && p.estado!=='fusionado' && !p.fusionadoCon);
  const pares=[];
  const seen=new Set();
  for(let i=0;i<pacientes.length;i++){
    for(let j=i+1;j<pacientes.length;j++){
      const a=pacientes[i], b=pacientes[j];
      if(a.id && b.id && a.id===b.id)continue;
      if(compartenAtenciones(a,b))continue;
      if(duplicadoYaResuelto(a,b))continue;
      const dniA=dniLimpio(a.dni), dniB=dniLimpio(b.dni);
      const telA=telLimpio(a.telefono), telB=telLimpio(b.telefono);
      const nomA=nombreClavePaciente(a), nomB=nombreClavePaciente(b);
      const fnA=a.fechaNacimiento||'', fnB=b.fechaNacimiento||'';
      let score=0, motivos=[];
      if(dniA && dniB && dniA===dniB){score+=100;motivos.push('mismo DNI');}
      if(telA && telB && telA.length>=7 && telB.length>=7 && telA===telB){score+=45;motivos.push('mismo teléfono');}
      if(a.email && b.email && normalizarTexto(a.email)===normalizarTexto(b.email)){score+=40;motivos.push('mismo email');}
      if(fnA && fnB && fnA===fnB){score+=25;motivos.push('misma fecha de nacimiento');}
      if(nomA && nomB){
        if(nomA===nomB){
          score+=70;motivos.push('mismo nombre');
          if((dniA&&!dniB)||(!dniA&&dniB)) {score+=20;motivos.push('uno tiene DNI y el otro no');}
        }
        else if(nomA.includes(nomB)||nomB.includes(nomA)){score+=35;motivos.push('nombre parecido');}
      }
      if(score>=60){
        const key=[a.id||nomA,b.id||nomB].sort().join('|');
        if(!seen.has(key)){seen.add(key);pares.push({a,b,score,motivos});}
      }
    }
  }
  return pares.sort((x,y)=>y.score-x.score);
}
function resumenPacienteDuplicado(p){
  const ats=atencionesDelPaciente(p);
  return `${escapeHtml(p.nombreCompleto||'Paciente')} · DNI ${escapeHtml(p.dni||'s/d')} · Tel ${escapeHtml(p.telefono||'s/d')} · Atenciones ${ats.length}`;
}
function renderDuplicadosPacientes(){
  const box=$('resultadoDuplicadosPacientes');
  const boxPac=$('resultadoDuplicadosPacientesPacientes');
  const pares=detectarDuplicadosPacientes();
  const renderTarget=(html)=>{ if(box)box.innerHTML=html; if(boxPac)boxPac.innerHTML=html; };
  if(!pares.length){renderTarget('<div class="ok-box">No encontré duplicados probables entre pacientes activos.</div>');return;}
  const html=pares.map((g,idx)=>{
    const aCount=atencionesDelPaciente(g.a).length;
    const bCount=atencionesDelPaciente(g.b).length;
    const sugerido=aCount>=bCount?g.a:g.b;
    const otro=sugerido.id===g.a.id?g.b:g.a;
    return `<div class="duplicado-card">
      <h4>Posible duplicado ${idx+1}</h4>
      <p class="muted">Motivo: ${escapeHtml(g.motivos.join(', '))}</p>
      <div class="duplicado-grid">
        <div><strong>Paciente A</strong><br>${resumenPacienteDuplicado(g.a)}</div>
        <div><strong>Paciente B</strong><br>${resumenPacienteDuplicado(g.b)}</div>
      </div>
      <div class="duplicado-actions">
        <button class="primary" type="button" onclick="fusionarPacientes('${escapeHtml(sugerido.id)}','${escapeHtml(otro.id)}')">Fusionar: conservar ${escapeHtml(sugerido.nombreCompleto||'principal')}</button>
        <button class="secondary" type="button" onclick="fusionarPacientes('${escapeHtml(otro.id)}','${escapeHtml(sugerido.id)}')">Conservar el otro</button>
      </div>
    </div>`;
  }).join('');
  renderTarget(html);
}
function asegurarPacientePersistente(p){
  if(!Array.isArray(data.pacientes))data.pacientes=[];
  if(!p)return null;
  let existente=null;
  if(p.id && !String(p.id).startsWith('legacy_')) existente=data.pacientes.find(x=>x.id===p.id);
  const dni=dniLimpio(p.dni);
  const nombre=normalizarTexto(p.nombreCompleto||p.paciente||'');
  if(!existente && dni) existente=data.pacientes.find(x=>dniLimpio(x.dni)===dni);
  if(!existente && nombre) existente=data.pacientes.find(x=>normalizarTexto(x.nombreCompleto||x.paciente||'')===nombre);
  if(!existente){
    existente={id:'pac_'+Date.now()+Math.floor(Math.random()*10000),historialCoberturas:[]};
    data.pacientes.push(existente);
  }
  mergePacienteInfo(existente,p);
  return existente;
}
function fusionarPacientes(principalId,duplicadoId){
  if(principalId===duplicadoId)return;
  const principalOrigen=todosPacientes().find(p=>clavePacientePanel(p)===principalId || p.id===principalId);
  const duplicado=todosPacientes().find(p=>clavePacientePanel(p)===duplicadoId || p.id===duplicadoId);
  const principal=asegurarPacientePersistente(principalOrigen);
  if(!principal||!duplicado){alert('No encontré uno de los pacientes.');return;}
  const atsDuplicado=atencionesDelPaciente(duplicado);
  const cantAntes=atsDuplicado.length;
  if(!confirm(`Fusionar pacientes?\n\nPrincipal: ${principal.nombreCompleto||''}\nDuplicado: ${duplicado.nombreCompleto||''}\n\nSe conservarán las atenciones y estadísticas. Se reasignarán ${cantAntes} atenciones al paciente principal.`))return;
  const dniDup=dniLimpio(duplicado.dni);
  const nombreDup=normalizarTexto(duplicado.nombreCompleto||duplicado.paciente||'');
  atenciones.forEach(a=>{
    const coincide =
      (duplicado.id && a.pacienteId===duplicado.id) ||
      (dniDup && dniLimpio(a.dni)===dniDup) ||
      (nombreDup && normalizarTexto(a.paciente||'')===nombreDup);
    if(coincide){
      a.pacienteId=principal.id;
      if(principal.dni)a.dni=principal.dni;
      if(principal.nombreCompleto)a.paciente=principal.nombreCompleto;
      if(principal.telefono)a.telefono=principal.telefono;
      if(principal.email)a.email=principal.email;
      if(principal.fechaNacimiento)a.fechaNacimiento=principal.fechaNacimiento;
      a.pacienteFusionadoDesde=duplicado.id||nombreDup;
      a.pacienteFusionadoEn=new Date().toISOString();
    }
  });
  ['telefono','email','fechaNacimiento','coberturaHabitual','numeroAfiliadoHabitual','dni','nombreCompleto'].forEach(k=>{
    if(!principal[k] && duplicado[k])principal[k]=duplicado[k];
  });
  principal.historialCoberturas=[...(principal.historialCoberturas||[]),...(duplicado.historialCoberturas||[])];
  principal.actualizadoEn=new Date().toISOString();
  const duplicadoPersistente=(data.pacientes||[]).find(p=>p.id===duplicado.id);
  if(duplicadoPersistente && duplicadoPersistente.id!==principal.id){
    duplicadoPersistente.estado='fusionado';
    duplicadoPersistente.fusionadoCon=principal.id;
    duplicadoPersistente.fusionadoEn=new Date().toISOString();
    duplicadoPersistente.fusionadoPor=usuarioSupabase?.email||'local';
  }
  if(!data.auditoriaPacientes)data.auditoriaPacientes=[];
  data.auditoriaPacientes.push({tipo:'fusion_paciente',principalId:principal.id,duplicadoId:duplicado.id||nombreDup,fecha:new Date().toISOString(),usuario:usuarioSupabase?.email||'local',atencionesReasignadas:cantAntes});
  saveConfig();
  saveAtenciones();
  renderDuplicadosPacientes();
  const a=$('resultadoDuplicadosPacientes'), b=$('resultadoDuplicadosPacientesPacientes'); if(a&&b)b.innerHTML=a.innerHTML;
  pacienteSeleccionadoPanelId=principal.id;
  renderPacientesPanel($('pacientesBuscar')?.value||'', false);
  seleccionarPacientePanel(principal.id);
  renderTabla();
  renderStats();
  alert('Pacientes fusionados. Las atenciones y estadísticas se conservaron.');
}




function repararReglasValoresBaseManual(){
  if(!exigirConfigAdministrativa('Tu perfil no puede reparar reglas y valores administrativos.'))return;
  data=normalizarConfigCritica(data);
  saveConfig();
  refreshSelects();
  renderConfig();
  aplicarRegla();
  alert('Reglas y valores base reparados. Se restauraron IOMA/OSPRERA, OSDE, Sancor/Prevención, Integral, PAMI como particular y valores base de Matías/Rogelio si estaban en cero.');
}
window.repararReglasValoresBaseManual=repararReglasValoresBaseManual;

/* ===== CONFIGURACION: FUNCIONES RESTAURADAS v2.7.3 ===== */
function renderConfig(){renderUsuariosConfig();
  if($('cfgProfesionalValores')) cargarValoresConfig();
  if($('cfgReglaOS')) cargarReglaConfig();
  if($('listaProfesionales')){
    $('listaProfesionales').innerHTML=(data.profesionales||[]).map(p=>`<li><strong>${escapeHtml(p.nombre||'')}</strong> — ${escapeHtml(p.area||'Sin definir')} ${p.id!=='general'?`<button class="small-btn" onclick="delProfesional('${p.id}')">Borrar</button>`:''}</li>`).join('');
  }
  if($('listaOS')){
    $('listaOS').innerHTML=(data.obrasSociales||[]).map(o=>`<li>${escapeHtml(o)} <button class="small-btn" onclick="delOS('${encodeURIComponent(o)}')">Borrar</button></li>`).join('');
  }
  if($('listaPrestaciones')){
    $('listaPrestaciones').innerHTML=allPrestaciones().map(pr=>`<li>${escapeHtml(pr)} <button class="small-btn" onclick="delPrestacion('${encodeURIComponent(pr)}')">Borrar</button></li>`).join('');
  }
}

function cargarValoresConfig(){
  if(!$('cfgProfesionalValores')) return;
  let p=(data.profesionales||[]).find(x=>x.id===$('cfgProfesionalValores').value) || (data.profesionales||[]).find(x=>x.id==='matias') || (data.profesionales||[])[0];
  if(!p)return;
  const v=valoresDelProfesional(p);
  $('cfgProfesionalValores').value=p.id;
  if($('cfgConsultaParticular')) $('cfgConsultaParticular').value=v.consulta||0;
  if($('cfgElectroParticular')) $('cfgElectroParticular').value=v.electro||0;
  if($('cfgEstudioParticular')) $('cfgEstudioParticular').value=v.estudio||0;
  if($('cfgCopagoConsulta')) $('cfgCopagoConsulta').value=v.copagoConsulta||0;
  if($('cfgCopagoElectro')) $('cfgCopagoElectro').value=v.copagoElectro||0;
  if($('cfgCopagoEstudio')) $('cfgCopagoEstudio').value=v.copagoEstudio||0;
}

function guardarValores(){
  if(!exigirConfigAdministrativa('Tu perfil no puede modificar valores financieros.'))return;
  if(!$('cfgProfesionalValores')) return;
  const p=(data.profesionales||[]).find(x=>x.id===$('cfgProfesionalValores').value);
  if(!p)return;
  const prev=p.valores||{};
  p.valores={
    ...prev,
    consulta:Number($('cfgConsultaParticular')?.value||0),
    electro:Number($('cfgElectroParticular')?.value||0),
    estudio:Number($('cfgEstudioParticular')?.value||0),
    copagoConsulta:Number($('cfgCopagoConsulta')?.value||0),
    copagoElectro:Number($('cfgCopagoElectro')?.value||0),
    copagoEstudio:Number($('cfgCopagoEstudio')?.value||0)
  };
  saveConfig();
  alert('Valores del perfil guardados');
  if(typeof aplicarRegla==='function') aplicarRegla();
  renderStats();
}

function cargarReglaConfig(){
  if($('cfgTipoRegla') && $('cfgReglaOS')) $('cfgTipoRegla').value=getRegla($('cfgReglaOS').value);
}

function guardarReglaConfig(){
  if(!exigirConfigAdministrativa('Tu perfil no puede modificar reglas administrativas de obras sociales.'))return;
  if(!$('cfgReglaOS') || !$('cfgTipoRegla')) return;
  setRegla($('cfgReglaOS').value,$('cfgTipoRegla').value);
  alert('Regla guardada');
  if(typeof aplicarRegla==='function') aplicarRegla();
}

function addProfesional(){
  const n=$('nuevoProfesional')?.value.trim();
  if(!n)return;
  data.profesionales=data.profesionales||[];
  data.profesionales.push({id:'p_'+Date.now(),nombre:n,area:$('nuevaArea')?.value.trim()||'Sin definir',prestaciones:[],valores:{consulta:0,electro:0,estudio:0,copagoConsulta:0,copagoElectro:0,copagoEstudio:0}});
  saveConfig();refreshSelects();renderConfig();
}
function delProfesional(id){
  if(!confirm('¿Borrar profesional?'))return;
  data.profesionales=(data.profesionales||[]).filter(p=>p.id!==id);
  saveConfig();refreshSelects();renderConfig();
}
function addOS(){
  const n=$('nuevaOS')?.value.trim();
  if(!n)return;
  data.obrasSociales=data.obrasSociales||[];
  if(!data.obrasSociales.includes(n))data.obrasSociales.push(n);
  saveConfig();refreshSelects();renderConfig();
}
function delOS(enc){
  const n=decodeURIComponent(enc);
  if(!confirm('¿Borrar obra social?'))return;
  data.obrasSociales=(data.obrasSociales||[]).filter(o=>o!==n);
  saveConfig();refreshSelects();renderConfig();
}
function addPrestacion(){
  const n=$('nuevaPrestacion')?.value.trim(), pid=$('profPrestacion')?.value;
  if(!n)return;
  const p=(data.profesionales||[]).find(x=>x.id===pid);
  if(p){
    p.prestaciones=p.prestaciones||[];
    if(!p.prestaciones.includes(n))p.prestaciones.push(n);
  }
  saveConfig();refreshSelects();renderConfig();actualizarPrestaciones();
}
function delPrestacion(enc){
  const n=decodeURIComponent(enc);
  if(!confirm('¿Borrar prestación de todos los perfiles?'))return;
  (data.profesionales||[]).forEach(p=>p.prestaciones=(p.prestaciones||[]).filter(x=>x!==n));
  saveConfig();refreshSelects();renderConfig();actualizarPrestaciones();
}



function renderUsuariosConfig(){
  asegurarUsuariosConfig();
  const lista=$('listaUsuariosSistema');
  if(lista){
    lista.innerHTML=(data.usuarios||[]).map(u=>{
      const prof=(data.profesionales||[]).find(p=>p.id===u.profesionalId);
      const acceso=escapeHtml(usuarioLoginCorto(u.usuario||u.email||''));
      return `<li><strong>${escapeHtml(u.nombre||u.usuario)}</strong> <span class="muted">@${acceso} · ${escapeHtml(labelRol(u.rol))}${prof?' · Profesional: '+escapeHtml(prof.nombre):' · Sin profesional asociado'}${u.especialidad?' · '+escapeHtml(u.especialidad):''}</span> ${u.activo===false?'<span class="badge bad">Inactivo</span>':''}</li>`;
    }).join('') || '<li class="muted">Sin usuarios configurados.</li>';
  }
  const profSel=$('usrProfesionalId');
  if(profSel){
    profSel.innerHTML='<option value="">Sin profesional asociado</option>'+(data.profesionales||[]).filter(p=>p.id!=='general').map(p=>`<option value="${p.id}">${escapeHtml(p.nombre)}</option>`).join('');
  }
}
function agregarUsuarioSistema(){
  if(!exigirConfigAdministrativa('Tu perfil no puede crear usuarios ni modificar permisos.'))return;
  asegurarUsuariosConfig();
  const usuario=usuarioLoginCorto($('usrUsuario')?.value||'');
  const nombre=($('usrNombre')?.value||'').trim();
  const rol=$('usrRol')?.value||'medico';
  const profesionalId=$('usrProfesionalId')?.value||'';
  const especialidad=($('usrEspecialidad')?.value||'').trim();
  if(!usuario||!nombre){alert('Completá nombre real y nombre de usuario.');return;}

  // Si el login coincide con un usuario existente o alias, se actualiza ese usuario.
  // Esto evita duplicar profesionales cuando se crea, por ejemplo, humberto@cardiolink.local
  // para el profesional ya existente Dr. Fernández Drago Humberto.
  let existente=(data.usuarios||[]).find(u=>{
    const keys=new Set(userKeys(u));
    return keys.has(normalizarUsuarioClave(usuario));
  });
  if(existente){
    existente.usuario = usuario;
    existente.nombre = nombre;
    existente.rol = rol;
    existente.profesionalId = profesionalId;
    existente.especialidad = especialidad;
    existente.activo = true;
    existente.aliases = uniqueList([...(existente.aliases||[]), usuario].filter(x=>x!==existente.usuario));
    existente.editadoPor = nombreUsuarioAuditoria();
    existente.editadoEn = new Date().toISOString();
    saveConfig();renderUsuariosConfig();aplicarPermisosUI();
    ['usrUsuario','usrNombre','usrEspecialidad'].forEach(id=>{if($(id))$(id).value='';});
    alert('Usuario interno actualizado y asociado al profesional seleccionado.');
    return;
  }

  data.usuarios.push({id:'usr_'+Date.now(),usuario,nombre,rol,profesionalId,especialidad,activo:true,aliases:[],creadoPor:nombreUsuarioAuditoria(),creadoEn:new Date().toISOString()});
  saveConfig();renderUsuariosConfig();aplicarPermisosUI();
  ['usrUsuario','usrNombre','usrEspecialidad'].forEach(id=>{if($(id))$(id).value='';});
  alert('Usuario interno creado. Recordá: el usuario también debe existir en Supabase Auth con el mismo nombre antes de @cardiolink.local.');
}
function limpiarUsuariosDuplicados(){
  if(!exigirConfigAdministrativa('Tu perfil no puede depurar usuarios ni permisos.'))return;
  asegurarUsuariosConfig();
  saveConfig();
  renderUsuariosConfig();
  aplicarPermisosUI();
  alert('Usuarios de acceso depurados. Los logins quedaron asociados a profesionales existentes cuando correspondía.');
}
function renderConfigOriginalSeguro(){
  if(typeof renderConfig === 'function'){}
}

window.guardarValores=guardarValores;
window.guardarReglaConfig=guardarReglaConfig;
window.addProfesional=addProfesional;
window.delProfesional=delProfesional;
window.addOS=addOS;


/* ===== AGENDA / SALA DE ESPERA v2.8.1 ===== */
const ESTADOS_AGENDA = {
  reservado:{label:'Reservado / tomado', short:'Tomado', cls:'estado-reservado'},
  confirmado:{label:'Confirmado', short:'Confirmado', cls:'estado-confirmado'},
  sala_espera:{label:'Sala de espera', short:'Sala', cls:'estado-sala_espera'},
  en_consulta:{label:'En consulta / atendiendo', short:'Atendiendo', cls:'estado-en_consulta'},
  atendido:{label:'Atendido', short:'Atendido', cls:'estado-atendido'},
  ausente:{label:'Ausente', short:'Ausente', cls:'estado-ausente'},
  cancelado:{label:'Cancelado', short:'Cancelado', cls:'estado-ausente'}
};
function preferenciaAgendaKey(){return 'cardiolink_agenda_vista_'+usuarioActualNombreCorto();}
function guardarPreferenciaAgenda(v){localStorage.setItem(preferenciaAgendaKey(),v||'tabla');}
function leerPreferenciaAgenda(){return localStorage.getItem(preferenciaAgendaKey())||'tabla';}
function horaTurno(a){return a.horaInicio ? `${a.horaInicio}${a.horaFin?' - '+a.horaFin:''}` : 's/h';}
function estadoTurno(a){return a.estadoTurno || 'reservado';}
function estadoAgendaBadge(a){const e=ESTADOS_AGENDA[estadoTurno(a)]||ESTADOS_AGENDA.reservado;return `<span class="agenda-status ${e.cls}"><i></i>${e.short}</span>`;}
function llenarSelectAgendaProfesionales(){
  const sel=$('agendaProfesional'); if(!sel||!data?.profesionales)return;
  sel.innerHTML='';
  const profs=data.profesionales.filter(p=>p.id!=='general');
  if(esSecretaria()||esAdminComun()){
    const opt=document.createElement('option'); opt.value=''; opt.textContent='Todos los profesionales'; sel.appendChild(opt);
    profs.forEach(p=>{const o=document.createElement('option');o.value=p.id;o.textContent=p.nombre;sel.appendChild(o);});
  }else if(esMatiasDuenio()){
    profs.forEach(p=>{const o=document.createElement('option');o.value=p.id;o.textContent=p.nombre;sel.appendChild(o);});
    sel.value='matias';
  }else if(esMedico()){
    const pid=profesionalIdUsuarioActual();
    const p=profs.find(x=>x.id===pid) || profs[0];
    if(p){const o=document.createElement('option');o.value=p.id;o.textContent=p.nombre;sel.appendChild(o);sel.value=p.id;}
    sel.disabled=true;
    return;
  }
  sel.disabled=false;
}
function initAgenda(){
  if($('agendaFecha')&&!$('agendaFecha').value)$('agendaFecha').value=todayISO();
  if($('agendaVista'))$('agendaVista').value=leerPreferenciaAgenda();
  llenarSelectAgendaProfesionales();
  if($('agendaProfesional')){
    if(esMatiasDuenio()&&!$('agendaProfesional').value)$('agendaProfesional').value='matias';
    if(esMedico())$('agendaProfesional').value=profesionalIdUsuarioActual();
  }
}
function agendaDatos(){
  const fecha=$('agendaFecha')?.value||todayISO();
  let prof=$('agendaProfesional')?.value||'';
  const estado=$('agendaEstado')?.value||'';
  if(esMedico())prof=profesionalIdUsuarioActual();
  if(esMatiasDuenio()&&!prof)prof='matias';
  return atenciones.filter(a=>{
    if((a.fecha||'')!==fecha)return false;
    if(prof && a.profesionalId!==prof)return false;
    if(estado && estadoTurno(a)!==estado)return false;
    return true;
  }).sort((a,b)=>(a.horaInicio||'99:99').localeCompare(b.horaInicio||'99:99') || String(a.paciente||'').localeCompare(String(b.paciente||''),'es'));
}
function agendaTextoPerfil(){
  if(!$('agendaTextoPerfil'))return;
  if(esSecretaria()||esAdminComun())$('agendaTextoPerfil').textContent='Vista operativa general. Podés ver todos los profesionales o filtrar uno puntual.';
  else if(esMatiasDuenio())$('agendaTextoPerfil').textContent='Vista de Matías por defecto. Podés cambiar el filtro si necesitás revisar otro profesional.';
  else $('agendaTextoPerfil').textContent='Vista propia del profesional logueado.';
}
function renderAgenda(){
  const tbody=$('agendaTabla'), cards=$('agendaTarjetas'), wrap=$('agendaTablaWrap'); if(!tbody||!cards)return;
  agendaTextoPerfil();
  const datos=agendaDatos();
  const vista=$('agendaVista')?.value||'tabla';
  if($('agendaResumen'))$('agendaResumen').textContent=datos.length?`${datos.length} turno(s) para la fecha seleccionada.`:'No hay turnos para la fecha seleccionada.';
  wrap?.classList.toggle('hidden',vista==='tarjetas');
  cards.classList.toggle('hidden',vista!=='tarjetas');
  if(!datos.length){tbody.innerHTML='<tr><td colspan="7">No hay turnos para mostrar.</td></tr>';cards.innerHTML='<div class="muted">No hay turnos para mostrar.</div>';return;}
  tbody.innerHTML=datos.map(a=>`<tr data-id="${escapeHtml(String(a.id||''))}">
    <td><strong>${horaTurno(a)}</strong></td>
    <td><button type="button" class="agenda-patient-name4092" data-evolve-attention403="${escapeHtml(String(a.id||''))}" title="Abrir evolución clínica">${escapeHtml(a.paciente||'')}</button><br><small>${escapeHtml(a.telefono||'')} ${a.email?'· '+escapeHtml(a.email):''}</small></td>
    <td>${escapeHtml(a.profesional||'')}</td>
    <td>${escapeHtml(a.prestacion||'')}</td>
    <td>${escapeHtml(a.obraSocial||'')}</td>
    <td>${estadoAgendaBadge(a)}</td>
    <td class="agenda-actions"><button onclick="abrirAgendaModal(${idJS(a.id)})">Ver</button><button onclick="cambiarEstadoAgenda(${idJS(a.id)},'sala_espera')">Sala</button><button onclick="cambiarEstadoAgenda(${idJS(a.id)},'en_consulta')">Atender</button><button onclick="cambiarEstadoAgenda(${idJS(a.id)},'atendido')">Atendido</button></td>
  </tr>`).join('');
  cards.innerHTML=datos.map(a=>`<div class="agenda-turno-card" data-id="${escapeHtml(String(a.id||''))}">
    <div class="agenda-card-top"><strong>${horaTurno(a)}</strong>${estadoAgendaBadge(a)}</div>
    <h3><button type="button" class="agenda-patient-name4092" data-evolve-attention403="${escapeHtml(String(a.id||''))}" title="Abrir evolución clínica">${escapeHtml(a.paciente||'')}</button></h3>
    <p>${escapeHtml(a.prestacion||'')} · ${escapeHtml(a.obraSocial||'')}</p>
    <p class="muted">${escapeHtml(a.profesional||'')}</p>
    <div class="agenda-actions"><button onclick="abrirAgendaModal(${idJS(a.id)})">Ver ficha</button><button onclick="cambiarEstadoAgenda(${idJS(a.id)},'sala_espera')">Sala</button><button onclick="cambiarEstadoAgenda(${idJS(a.id)},'en_consulta')">Atender</button><button onclick="cambiarEstadoAgenda(${idJS(a.id)},'atendido')">Atendido</button></div>
  </div>`).join('');
}
function opcionesEstadoAgendaHTML(id, actual){
  return Object.entries(ESTADOS_AGENDA).map(([k,e])=>`<button class="agenda-state-btn ${e.cls} ${actual===k?'active':''}" onclick="cambiarEstadoAgenda(${idJS(id)},'${k}');abrirAgendaModal(${idJS(id)});"><i></i>${e.short}</button>`).join('');
}
function abrirAgendaModal(id){
  const a=atenciones.find(x=>String(x.id)===String(id)); if(!a)return;
  const m=$('agendaModal'), body=$('agendaModalBody'); if(!m||!body)return;
  $('agendaModalTitulo').textContent=a.paciente||'Turno';
  body.innerHTML=`<div class="agenda-modal-grid">
    <div><label>Horario</label><strong>${horaTurno(a)}</strong></div>
    <div><label>Fecha</label><strong>${formatFecha(a.fecha)}</strong></div>
    <div><label>Profesional</label><strong>${escapeHtml(a.profesional||'')}</strong></div>
    <div><label>Prestación</label><strong>${escapeHtml(a.prestacion||'')}</strong></div>
    <div><label>Cobertura</label><strong>${escapeHtml(a.obraSocial||'')}</strong></div>
    <div><label>Teléfono</label><strong>${escapeHtml(a.telefono||'s/d')}</strong></div>
  </div>
  <h3>Estado del turno</h3>
  <div class="agenda-state-grid">${opcionesEstadoAgendaHTML(a.id,estadoTurno(a))}</div>
  <div class="agenda-actions modal-actions"><button onclick="editarAtencion(${idJS(a.id)});cerrarAgendaModal();showSection('listado')">Editar atención</button></div>`;
  m.classList.remove('hidden');
}
function cerrarAgendaModal(){ $('agendaModal')?.classList.add('hidden'); }
function cambiarEstadoAgenda(id,estado){
  const a=atenciones.find(x=>String(x.id)===String(id)); if(!a)return;
  a.estadoTurno=estado;
  a.estadoTurnoEditadoPor=nombreUsuarioAuditoria();
  a.estadoTurnoEditadoEn=new Date().toISOString();
  selloAuditoriaEdicion(a);
  saveAtenciones();
  renderAgenda();
  renderTabla();
  renderStats();
}



/* ===== ESTADISTICAS / GRAFICOS ===== */
let statsCharts={};

function nombreEstadoTurnoLabel(k){
  const x=ESTADOS_AGENDA?.[k];
  return x?.label || x?.short || k || 'Sin estado';
}
function setPeriodoStatsMes(){
  const d=new Date();
  const y=d.getFullYear();
  const m=String(d.getMonth()+1).padStart(2,'0');
  if($('statsDesde'))$('statsDesde').value=`${y}-${m}-01`;
  if($('statsHasta'))$('statsHasta').value=todayISO();
}
function llenarSelectEstadisticas(){
  const prof=$('statsProfesional'), os=$('statsOS'), prest=$('statsPrestacion');
  if(prof){
    prof.innerHTML='';
    const add=(value,text)=>{const o=document.createElement('option');o.value=value;o.textContent=text;prof.appendChild(o);};
    if(esMedico()){
      const pid=profesionalIdUsuarioActual();
      add(pid,nombreProfesionalPorId(pid)||'Mi perfil');
      prof.value=pid;
      prof.disabled=true;
    }else{
      add('', 'Todos los profesionales');
      data.profesionales.filter(p=>p.id!=='general').forEach(p=>add(p.id,p.nombre));
      prof.disabled=false;
      if(esMatiasDuenio() && !prof.value) prof.value='matias';
    }
  }
  if(os) llenarTodos(os,data.obrasSociales,'Todas las OS');
  if(prest) llenarTodos(prest,allPrestaciones(),'Todas las prestaciones');
}
function initEstadisticas(){
  llenarSelectEstadisticas();
  if($('statsDesde')&&!$('statsDesde').value) setPeriodoStatsMes();
  if($('statsProfesional')){
    if(esMedico())$('statsProfesional').value=profesionalIdUsuarioActual();
    else if(esMatiasDuenio()&&!$('statsProfesional').value)$('statsProfesional').value='matias';
  }
  actualizarTextoEstadisticasPerfil();
}
function actualizarTextoEstadisticasPerfil(){
  const el=$('estadisticasTextoPerfil'); if(!el)return;
  if(esMedico())el.textContent='Vista estadística propia del profesional logueado.';
  else if(esSecretaria()||esAdminComun())el.textContent='Vista operativa general. Podés filtrar por profesional, obra social, prestación y estado.';
  else if(esMatiasDuenio())el.textContent='Vista de Matías por defecto. Podés cambiar filtros para revisar otros perfiles cuando lo necesites.';
  else el.textContent='Gráficos por rango, profesional, obra social, prestación y estado.';
}
function datosEstadisticas(){
  const desde=$('statsDesde')?.value||'';
  const hasta=$('statsHasta')?.value||'';
  let prof=$('statsProfesional')?.value||'';
  const os=$('statsOS')?.value||'';
  const prest=$('statsPrestacion')?.value||'';
  const estado=$('statsEstado')?.value||'';
  if(esMedico())prof=profesionalIdUsuarioActual();
  return atenciones.filter(a=>{
    if(desde && (a.fecha||'')<desde)return false;
    if(hasta && (a.fecha||'')>hasta)return false;
    if(prof && a.profesionalId!==prof)return false;
    if(os && a.obraSocial!==os)return false;
    if(prest && a.prestacion!==prest)return false;
    if(estado && estadoTurno(a)!==estado)return false;
    if(!estado && ['ausente','cancelado'].includes(estadoTurno(a)))return false;
    if(esMedico()){
      const pid=profesionalIdUsuarioActual();
      if(a.profesionalId!==pid && a.cajaPerfil!==pid)return false;
    }
    return true;
  });
}
function contarPor(datos,fn){
  const out={};
  datos.forEach(a=>{const k=fn(a)||'Sin dato'; out[k]=(out[k]||0)+1;});
  return Object.entries(out).sort((a,b)=>b[1]-a[1]);
}
function setText(id,txt){const el=$(id); if(el)el.textContent=txt;}
function porcentaje(n,total){return total?Math.round((n*1000)/total)/10:0;}
function renderEstadisticas(){
  actualizarTextoEstadisticasPerfil();
  const datos=datosEstadisticas();
  const total=datos.length;
  const atendidos=datos.filter(a=>estadoTurno(a)==='atendido').length;
  const ausentes=datos.filter(a=>estadoTurno(a)==='ausente').length;
  const cancelados=datos.filter(a=>estadoTurno(a)==='cancelado').length;
  setText('statsTotal',String(total));
  setText('statsAtendidos',String(atendidos));
  setText('statsAusentes',`${porcentaje(ausentes,total)}%`);
  setText('statsCancelados',`${porcentaje(cancelados,total)}%`);
  const r=$('statsResumen');
  if(r){
    const desde=$('statsDesde')?.value||'inicio'; const hasta=$('statsHasta')?.value||'hoy';
    r.textContent=`Período ${desde} a ${hasta}. ${total} registro(s). Atendidos: ${atendidos}. Ausentes: ${ausentes}. Cancelados: ${cancelados}.`;
  }
  const porOS=contarPor(datos,a=>a.obraSocial||'Sin OS');
  const porPrest=contarPor(datos,a=>prestacionListado ? prestacionListado(a) : (a.prestacion||'Sin prestación'));
  const porEstado=contarPor(datos,a=>nombreEstadoTurnoLabel(estadoTurno(a)));
  const porProf=contarPor(datos,a=>a.profesional||nombreProfesionalPorId(a.profesionalId)||'Sin profesional');
  renderChartOrFallback('chartOS','chartOSFallback','bar',porOS,'OS');
  renderChartOrFallback('chartPrestaciones','chartPrestacionesFallback','bar',porPrest,'Prestaciones');
  renderChartOrFallback('chartEstados','chartEstadosFallback','doughnut',porEstado,'Estados');
  const profCard=$('chartProfesionalesCard');
  if(profCard)profCard.classList.toggle('hidden',esMedico());
  if(!esMedico())renderChartOrFallback('chartProfesionales','chartProfesionalesFallback','bar',porProf,'Profesionales');
}
function paletaChart(n){
  const base=['#2563eb','#14b8a6','#8b5cf6','#9333ea','#ef4444','#f59e0b','#22c55e','#0ea5e9','#64748b','#ec4899'];
  return Array.from({length:n},(_,i)=>base[i%base.length]);
}
function renderChartOrFallback(canvasId, fallbackId, tipo, entries, label){
  const canvas=$(canvasId), fb=$(fallbackId); if(!canvas)return;
  const top=entries.slice(0,12);
  if(fb)fb.innerHTML='';
  if(window.Chart){
    if(statsCharts[canvasId])statsCharts[canvasId].destroy();
    statsCharts[canvasId]=new Chart(canvas,{type:tipo,data:{labels:top.map(x=>x[0]),datasets:[{label,data:top.map(x=>x[1]),backgroundColor:paletaChart(top.length),borderWidth:1}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:tipo==='doughnut',position:'bottom'}},scales:tipo==='bar'?{y:{beginAtZero:true,ticks:{precision:0}}}:undefined}});
    canvas.classList.remove('hidden');
    return;
  }
  canvas.classList.add('hidden');
  if(fb)fb.innerHTML=top.length?top.map(([k,v])=>`<div class="bar-row"><span>${escapeHtml(k)}</span><strong>${v}</strong><i style="width:${Math.min(100,v*8)}%"></i></div>`).join(''):'<p class="muted">No hay datos para graficar.</p>';
}

window.delOS=delOS;
window.addPrestacion=addPrestacion;
window.delPrestacion=delPrestacion;
window.limpiarUsuariosDuplicados=limpiarUsuariosDuplicados;
window.abrirAgendaModal=abrirAgendaModal;
window.cerrarAgendaModal=cerrarAgendaModal;
window.cambiarEstadoAgenda=cambiarEstadoAgenda;
window.editarAtencion=editarAtencion;
window.eliminarAtencion=eliminarAtencion;
window.guardarEdicion=guardarEdicion;
window.cancelarEdicion=cancelarEdicion;
window.showSection=showSection;
window.renderAgenda=renderAgenda;
window.renderTabla=renderTabla;

async function refrescarDesdeSupabaseAutomatico(){
  try{
    await cargarAtencionesDesdeSupabase();
    renderTabla();
    renderStats();
    if($('agenda')?.classList.contains('visible'))renderAgenda();
    if($('pacientes')?.classList.contains('visible'))renderPacientesPanel($('pacientesBuscar')?.value||'', false);
    if($('mensajes')?.classList.contains('visible'))renderMensajes();
    actualizarNotificacionMensajes();
  }catch(e){console.warn('Refresco automático falló:', e);}
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


/* ===== MENSAJES INTERNOS v2.8.2 ===== */
function destinatariosMensajes(){
  asegurarUsuariosConfig();
  const lista=[{value:'todos',label:'Todos'}, {value:'rol:secretaria',label:'Secretaría'}];
  (data.usuarios||[]).filter(u=>u.activo!==false).forEach(u=>{
    lista.push({value:'usuario:'+usuarioLoginCorto(u.usuario||u.id), label:u.nombre||u.usuario});
  });
  return lista;
}
function initMensajes(){
  const sel=$('msgDestino');
  if(sel && !sel.dataset.ready){
    sel.innerHTML='';
    destinatariosMensajes().forEach(d=>{
      const o=document.createElement('option'); o.value=d.value; o.textContent=d.label; sel.appendChild(o);
    });
    sel.dataset.ready='1';
  }
  renderMensajes();
}
function limpiarMensajeInterno(){
  if($('msgTexto'))$('msgTexto').value='';
  if($('msgFraseRapida'))$('msgFraseRapida').value='';
}
function mensajeVisibleParaUsuario(m){
  const u=perfilUsuarioActual();
  const usr=usuarioLoginCorto(u.usuario||usuarioActualNombreCorto());
  const destino=String(m.destino||'todos');
  if(destino==='todos')return true;
  if(destino==='rol:secretaria')return esSecretaria() || esMatiasDuenio() || esAdminComun();
  if(destino==='rol:medico')return esMedico();
  if(destino==='usuario:'+usr)return true;
  if(m.deUsuario===usr)return true;
  return false;
}
function nombreDestinoMensaje(destino){
  if(destino==='todos')return 'Todos';
  if(destino==='rol:secretaria')return 'Secretaría';
  if(destino==='rol:medico')return 'Médicos';
  if(String(destino).startsWith('usuario:')){
    const usr=destino.replace('usuario:','');
    const u=(data.usuarios||[]).find(x=>usuarioLoginCorto(x.usuario||x.id)===usr || (x.aliases||[]).map(usuarioLoginCorto).includes(usr));
    return u?.nombre || usr;
  }
  return destino || 'Todos';
}
function mensajesInternos(){return (atenciones||[]).filter(esMensajeInterno).sort((a,b)=>String(b.creadoEn||b.fecha||'').localeCompare(String(a.creadoEn||a.fecha||'')));}
function mensajesNoLeidosUsuario(){
  const usr=usuarioLoginCorto(perfilUsuarioActual().usuario||usuarioActualNombreCorto());
  return mensajesInternos().filter(m=>{
    if(m.deUsuario===usr) return false;
    if(!mensajeVisibleParaUsuario(m)) return false;
    return !(Array.isArray(m.leidoPor) && m.leidoPor.includes(usr));
  });
}
function asegurarBadgeMensajes(){
  const btn=document.querySelector('.nav[data-section="mensajes"]');
  if(!btn) return null;
  let badge=btn.querySelector('.msg-badge');
  if(!badge){
    badge=document.createElement('span');
    badge.className='msg-badge';
    badge.setAttribute('aria-label','Mensajes nuevos');
    btn.appendChild(badge);
  }
  return badge;
}
function actualizarNotificacionMensajes(){
  const btn=document.querySelector('.nav[data-section="mensajes"]');
  const badge=asegurarBadgeMensajes();
  if(!btn || !badge) return;
  let n=0;
  try{ n=mensajesNoLeidosUsuario().length; }catch(e){ n=0; }
  if(n>0){
    badge.textContent = n>99 ? '99+' : String(n);
    badge.classList.remove('hidden');
    btn.classList.add('nav-unread');
    btn.title = `${n} mensaje${n===1?'':'s'} nuevo${n===1?'':'s'}`;
  }else{
    badge.textContent='';
    badge.classList.add('hidden');
    btn.classList.remove('nav-unread');
    btn.removeAttribute('title');
  }
}
function enviarMensajeInterno(){
  const texto=($('msgTexto')?.value||'').trim();
  if(!texto){alert('Escribí un mensaje.');return;}
  const u=perfilUsuarioActual();
  const msg={
    id:'msg_'+Date.now()+'_'+Math.random().toString(36).slice(2,7),
    tipoRegistro:'mensaje',
    fecha:todayISO(),
    horaInicio:new Date().toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'}),
    deUsuario:usuarioLoginCorto(u.usuario||usuarioActualNombreCorto()),
    deNombre:u.nombre||u.usuario||usuarioActualNombreCorto(),
    deRol:u.rol||'',
    destino:$('msgDestino')?.value||'todos',
    texto,
    leidoPor:[]
  };
  selloAuditoriaCreacion(msg);
  atenciones.push(msg);
  saveAtenciones();
  limpiarMensajeInterno();
  renderMensajes();
  actualizarNotificacionMensajes();
}
function renderMensajes(){
  const box=$('mensajesLista'); if(!box)return;
  const filtro=$('msgFiltro')?.value||'visibles';
  const usr=usuarioLoginCorto(perfilUsuarioActual().usuario||usuarioActualNombreCorto());
  let datos=mensajesInternos();
  if(filtro==='enviados')datos=datos.filter(m=>m.deUsuario===usr);
  else datos=datos.filter(m=>mensajeVisibleParaUsuario(m));
  datos=datos.slice(0,80);
  if(!datos.length){box.innerHTML='<p class="muted">No hay mensajes para mostrar.</p>';actualizarNotificacionMensajes();return;}
  box.innerHTML=datos.map(m=>{
    const visto=(m.leidoPor||[]).includes(usr);
    return `<div class="mensaje-item ${visto?'visto':'nuevo'}">
      <div class="mensaje-head"><strong>${escapeHtml(m.deNombre||m.deUsuario||'Usuario')}</strong><span>${escapeHtml(fechaHoraAuditoria(m.creadoEn)||m.horaInicio||'')}</span></div>
      <div class="mensaje-destino">Para: ${escapeHtml(nombreDestinoMensaje(m.destino))}</div>
      <div class="mensaje-texto">${escapeHtml(m.texto||'')}</div>
    </div>`;
  }).join('');
  actualizarNotificacionMensajes();
}
function marcarMensajesVisiblesLeidos(){
  const usr=usuarioLoginCorto(perfilUsuarioActual().usuario||usuarioActualNombreCorto());
  let cambio=false;
  mensajesInternos().forEach(m=>{
    if(mensajeVisibleParaUsuario(m)){
      if(!Array.isArray(m.leidoPor))m.leidoPor=[];
      if(!m.leidoPor.includes(usr)){m.leidoPor.push(usr);cambio=true;}
    }
  });
  if(cambio)saveAtenciones();
  renderMensajes();
  actualizarNotificacionMensajes();
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



/* ===== SOLAPA PACIENTES ===== */
function pacienteActivoPanel(p){return p && p.estado!=='fusionado';}
function nombrePacientePanel(p){return p.nombreCompleto || p.paciente || 'Paciente sin nombre';}
function clavePacientePanel(p){return String(p.id||'') || dniLimpio(p.dni) || normalizarTexto(nombrePacientePanel(p));}
function atencionesPacienteGlobal(p){
  const dni=dniLimpio(p.dni);
  const nombre=normalizarTexto(nombrePacientePanel(p));
  return atenciones.filter(a=>{
    if(p.id && a.pacienteId===p.id)return true;
    if(dni && dniLimpio(a.dni)===dni)return true;
    if(nombre && normalizarTexto(a.paciente||'')===nombre)return true;
    return false;
  }).sort((a,b)=>(b.fecha||'').localeCompare(a.fecha||''));
}
function pacientesPanelFiltrados(q='', todos=false){
  const nq=normalizarTexto(q); const nd=dniLimpio(q);
  let lista=todosPacientes().filter(pacienteActivoPanel);
  if(!todos && (nq||nd)){
    lista=lista.filter(p=>{
      const ats=atencionesPacienteGlobal(p);
      return (nd && dniLimpio(p.dni).includes(nd)) ||
        (nd && String(p.telefono||'').replace(/\D/g,'').includes(nd)) ||
        normalizarTexto(nombrePacientePanel(p)).includes(nq) ||
        normalizarTexto(p.email||'').includes(nq) ||
        ats.some(a=>normalizarTexto(a.profesional||'').includes(nq)||normalizarTexto(a.prestacion||'').includes(nq));
    });
  }
  return lista.sort((a,b)=>nombrePacientePanel(a).localeCompare(nombrePacientePanel(b),'es'));
}
let pacientesPagina4092=1;
let pacientesConsulta4092='';
let pacientesTextoActual4092='';
let pacientesModoTodos4092=false;
const PACIENTES_POR_PAGINA4092=50;
function renderPacientesPanel(q='', todos=false){
  const listaBox=$('pacientesLista'), resumen=$('pacientesResumen');
  if(!listaBox)return;
  pacientesTextoActual4092=String(q||'');
  pacientesModoTodos4092=!!todos;
  const firmaConsulta=`${normalizarTexto(q)}|${todos?'todos':'filtro'}`;
  if(firmaConsulta!==pacientesConsulta4092){pacientesConsulta4092=firmaConsulta;pacientesPagina4092=1;}
  const lista=pacientesPanelFiltrados(q,todos);
  const edadDesdeFecha409=(raw)=>{
    const s=String(raw||'').trim();if(!s)return '';
    let y,m,d,mt=s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if(mt){y=+mt[1];m=+mt[2];d=+mt[3];}
    else{mt=s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);if(!mt)return '';d=+mt[1];m=+mt[2];y=+mt[3];if(y<100)y+=y>40?1900:2000;}
    const dt=new Date(y,m-1,d);if(dt.getFullYear()!==y||dt.getMonth()!==m-1||dt.getDate()!==d)return '';
    const now=new Date();let age=now.getFullYear()-y;if(now.getMonth()<m-1||(now.getMonth()===m-1&&now.getDate()<d))age--;
    return age>=0&&age<130?String(age):'';
  };
  const totalPaginas=Math.max(1,Math.ceil(lista.length/PACIENTES_POR_PAGINA4092));
  pacientesPagina4092=Math.min(Math.max(1,pacientesPagina4092),totalPaginas);
  const desde=(pacientesPagina4092-1)*PACIENTES_POR_PAGINA4092;
  const pagina=lista.slice(desde,desde+PACIENTES_POR_PAGINA4092);
  if(resumen)resumen.textContent=lista.length ? `${lista.length} paciente(s) en el padrón · página ${pacientesPagina4092} de ${totalPaginas}.` : 'No se encontraron pacientes.';
  if(!lista.length){listaBox.innerHTML='<div class="muted patients-empty409">No hay resultados. Podés importar desde otra app o cargar un paciente nuevo.</div>';return;}
  const rows=pagina.map(p=>{
    const key=clavePacientePanel(p),active=pacienteSeleccionadoPanelId===key?' active':'';
    const age=edadDesdeFecha409(p.fechaNacimiento);
    const encodedKey=encodeURIComponent(key);
    return `<div class="patients-directory-row409${active}" role="row" data-patient-open4091="${escapeHtml(encodedKey)}" tabindex="0" aria-label="Abrir ficha de ${escapeHtml(nombrePacientePanel(p))}">
      <div class="patients-name409" role="cell"><button type="button" data-patient-open4091="${escapeHtml(encodedKey)}">${escapeHtml(nombrePacientePanel(p))}</button></div>
      <div role="cell" data-label="DNI">${escapeHtml(p.dni||'s/d')}</div>
      <div role="cell" data-label="Edad">${escapeHtml(age?age+' años':'s/d')}</div>
      <div role="cell" data-label="Cobertura">${escapeHtml(p.coberturaHabitual||'s/d')}</div>
      <div role="cell" data-label="Teléfono">${escapeHtml(p.telefono||'s/d')}</div>
      <div role="cell" data-label="Email" class="patients-email409">${escapeHtml(p.email||'s/d')}</div>
    </div>`;
  }).join('');
  const botonesPagina=(()=>{const out=[];const inicio=Math.max(1,pacientesPagina4092-2),fin=Math.min(totalPaginas,inicio+4);for(let n=Math.max(1,fin-4);n<=fin;n++)out.push(`<button type="button" class="${n===pacientesPagina4092?'active':''}" data-patient-page4092="${n}" aria-label="Ir a la página ${n}">${n}</button>`);return out.join('');})();
  listaBox.innerHTML=`<div class="patients-directory409" role="table" aria-label="Padrón de pacientes">
    <div class="patients-directory-head409" role="row"><div role="columnheader">Paciente</div><div role="columnheader">DNI</div><div role="columnheader">Edad</div><div role="columnheader">Cobertura</div><div role="columnheader">Teléfono</div><div role="columnheader">Email</div></div>
    <div class="patients-directory-body409">${rows}</div>
  </div>
  <nav class="patients-pagination4092" aria-label="Paginación del padrón"><button type="button" data-patient-page4092="${pacientesPagina4092-1}" ${pacientesPagina4092<=1?'disabled':''}>Anterior</button><div class="patients-page-numbers4092">${botonesPagina}</div><button type="button" data-patient-page4092="${pacientesPagina4092+1}" ${pacientesPagina4092>=totalPaginas?'disabled':''}>Siguiente</button><span>Mostrando ${desde+1}–${Math.min(desde+pagina.length,lista.length)} de ${lista.length}</span></nav>`;
}
function buscarPacientePanelPorId(id){
  return todosPacientes().find(p=>clavePacientePanel(p)===id || p.id===id) || null;
}

/* v4.1.0-hc.1: apertura robusta de ficha desde el padrón de Pacientes.
   Se usa delegación de eventos en vez de onclick inline para evitar fallos
   con claves que contienen espacios, tildes o apóstrofes. */
function abrirFichaDesdePadron4091(id){
  const key=String(id||'');
  const p=buscarPacientePanelPorId(key);
  if(!p){alert('No se pudo abrir la ficha del paciente. Actualizá el padrón e intentá nuevamente.');return;}
  pacienteSeleccionadoPanelId=clavePacientePanel(p);
  try{seleccionarPacientePanel(pacienteSeleccionadoPanelId);}catch(e){console.error('Error al preparar la ficha del paciente',e);}
  try{
    if(typeof window.abrirPacienteGlobal320==='function'){
      window.abrirPacienteGlobal320(pacienteSeleccionadoPanelId);
      document.body.classList.add('patient-modal-open-371');
      return;
    }
    if(typeof window.abrirPacienteGlobalDetalle350==='function'){
      window.abrirPacienteGlobalDetalle350(pacienteSeleccionadoPanelId);
      document.body.classList.add('patient-modal-open-371');
      return;
    }
  }catch(e){console.error('Error al abrir la ficha modal',e);}
  const detalle=$('pacienteDetalle');
  if(detalle){detalle.scrollIntoView({behavior:'smooth',block:'start'});detalle.focus?.();}
}
window.abrirFichaDesdePadron4091=abrirFichaDesdePadron4091;
if(!window.__cardiolinkPatientsDirectory4091){
  window.__cardiolinkPatientsDirectory4091=true;
  document.addEventListener('click',e=>{
    const target=e.target.closest?.('[data-patient-open4091]');
    if(!target||!target.closest('#pacientesLista'))return;
    e.preventDefault();
    e.stopPropagation();
    let key='';
    try{key=decodeURIComponent(target.dataset.patientOpen4091||'');}catch(_){key=target.dataset.patientOpen4091||'';}
    abrirFichaDesdePadron4091(key);
  },true);
  document.addEventListener('keydown',e=>{
    if(e.key!=='Enter'&&e.key!==' ')return;
    const target=e.target.closest?.('[data-patient-open4091]');
    if(!target||!target.closest('#pacientesLista'))return;
    e.preventDefault();
    let key='';
    try{key=decodeURIComponent(target.dataset.patientOpen4091||'');}catch(_){key=target.dataset.patientOpen4091||'';}
    abrirFichaDesdePadron4091(key);
  });
}
if(!window.__cardiolinkPatientsPagination4092){
  window.__cardiolinkPatientsPagination4092=true;
  document.addEventListener('click',e=>{
    const b=e.target.closest?.('[data-patient-page4092]');
    if(!b||b.disabled||!b.closest('#pacientesLista'))return;
    e.preventDefault();
    pacientesPagina4092=Math.max(1,Number(b.dataset.patientPage4092)||1);
    renderPacientesPanel(pacientesTextoActual4092,pacientesModoTodos4092);
    $('pacientesLista')?.scrollIntoView({behavior:'smooth',block:'start'});
  });
}
function estadoCortoPaciente(a){
  const e=evaluarEstado(a);
  const partes=[];
  partes.push(e.txt||'');
  if(tipoPrest(a.prestacion)!=='CONSULTA'){
    partes.push(a.estudioInformado?'Informe OK':'Informe pendiente');
    if(a.estudioImpreso)partes.push('Impreso');
    if(a.estudioEnviadoMail)partes.push('Mail');
    if(a.estudioEnviadoWS)partes.push('WS');
  }
  return partes.filter(Boolean).join(' · ');
}
function seleccionarPacientePanel(id){
  const p=buscarPacientePanelPorId(id); if(!p)return;
  pacienteSeleccionadoPanelId=clavePacientePanel(p);
  try{window.CardioLinkPacienteActual411B?.set?.(pacienteSeleccionadoPanelId);}catch(e){}
  const ats=atencionesPacienteGlobal(p);
  const porProf={}; ats.forEach(a=>{porProf[a.profesional||'Sin profesional']=(porProf[a.profesional||'Sin profesional']||0)+1;});
  const detalle=$('pacienteDetalle'); if(!detalle)return;
  detalle.innerHTML=`
    <div class="paciente-ficha-head">
      <div>
        <h3>${escapeHtml(nombrePacientePanel(p))}</h3>
        <p class="muted">DNI ${escapeHtml(p.dni||'s/d')} · Tel ${escapeHtml(p.telefono||'s/d')} · ${escapeHtml(p.email||'')}</p>
      </div>
      <div class="paciente-ficha-actions">
        <button class="primary" type="button" onclick="nuevaAtencionDesdePaciente('${escapeHtml(clavePacientePanel(p))}')">Nueva atención</button>
        <button class="secondary" type="button" onclick="editarPacientePanel('${escapeHtml(clavePacientePanel(p))}')">Editar ficha</button>
      </div>
    </div>
    <div class="paciente-ficha-grid">
      <div><span>Cobertura habitual</span><strong>${escapeHtml(p.coberturaHabitual||'s/d')}</strong></div>
      <div><span>Nº afiliado habitual</span><strong>${escapeHtml(p.numeroAfiliadoHabitual||'s/d')}</strong></div>
      <div><span>Contacto responsable</span><strong>${escapeHtml(p.contactoResponsableNombre||'s/d')}${p.contactoResponsableRelacion?' · '+escapeHtml(p.contactoResponsableRelacion):''}</strong></div>
      <div><span>Teléfono contacto</span><strong>${escapeHtml(p.contactoResponsableTelefono||'s/d')}</strong></div>
      <div><span>Email contacto</span><strong>${escapeHtml(p.contactoResponsableEmail||'s/d')}</strong></div>
      <div><span>Fecha nacimiento</span><strong>${escapeHtml(p.fechaNacimiento?formatFecha(p.fechaNacimiento):'s/d')}</strong></div>
      <div><span>Sexo</span><strong>${escapeHtml(p.sexo||'s/d')}</strong></div>
      <div><span>Localidad</span><strong>${escapeHtml(p.localidad||'s/d')}</strong></div>
      <div><span>Dirección</span><strong>${escapeHtml(p.direccion||'s/d')}</strong></div>
      <div><span>Provincia</span><strong>${escapeHtml(p.provincia||'Buenos Aires')}</strong></div>
      <div><span>Total atenciones</span><strong>${ats.length}</strong></div>
    </div>
    <div class="paciente-mini-resumen">
      ${Object.entries(porProf).map(([prof,n])=>`<span>${escapeHtml(prof)}: <strong>${n}</strong></span>`).join('') || '<span>Sin atenciones registradas</span>'}
    </div>
    <h3>Historial cruzado</h3>
    <p class="muted">Incluye consultas y estudios de todos los profesionales cargados en CardioLink para este mismo paciente.</p>
    <div class="paciente-historial-wrap">
      <table class="tabla-mini paciente-historial">
        <thead><tr><th>Fecha</th><th>Profesional</th><th>Prestación</th><th>Cobertura turno</th><th>Estado / informe / entrega</th><th></th></tr></thead>
        <tbody>
          ${ats.length?ats.map(a=>`<tr>
            <td>${formatFecha(a.fecha)}</td>
            <td>${escapeHtml(a.profesional||'')}</td>
            <td><strong>${escapeHtml(prestacionListado(a))}</strong>${a.observaciones?'<br><small>'+escapeHtml(a.observaciones)+'</small>':''}</td>
            <td>${escapeHtml(a.obraSocial||'')}</td>
            <td>${escapeHtml(estadoCortoPaciente(a))}</td>
            <td><button class="secondary" type="button" onclick="editarAtencion(${idJS(a.id)})">Editar</button></td>
          </tr>`).join(''):'<tr><td colspan="6">Este paciente todavía no tiene atenciones cargadas.</td></tr>'}
        </tbody>
      </table>
    </div>`;
  renderPacientesPanel($('pacientesBuscar')?.value||'',false);
}
function editarPacientePanel(id){
  const p=buscarPacientePanelPorId(id); if(!p)return;
  const detalle=$('pacienteDetalle'); if(!detalle)return;
  detalle.innerHTML=`
    <h3>Editar ficha administrativa</h3>
    <p class="muted">Esto actualiza los datos básicos del paciente. No borra atenciones previas.</p>
    <div class="form-grid paciente-edit-form">
      <div><label>Apellido y nombre</label><input id="pacEditNombre" value="${escapeHtml(nombrePacientePanel(p))}"></div>
      <div><label>DNI</label><input id="pacEditDni" value="${escapeHtml(p.dni||'')}"></div>
      <div><label>Teléfono</label><input id="pacEditTelefono" value="${escapeHtml(p.telefono||'')}"></div>
      <div><label>Email</label><input id="pacEditEmail" value="${escapeHtml(p.email||'')}"></div>
      <div><label>Fecha nacimiento</label><input type="date" id="pacEditNacimiento" value="${escapeHtml(fechaISODesdeTexto(p.fechaNacimiento||'')||p.fechaNacimiento||'')}"></div>
      <div><label>Sexo</label><select id="pacEditSexo"><option value="">No definido</option><option value="Masculino" ${p.sexo==='Masculino'?'selected':''}>Masculino</option><option value="Femenino" ${p.sexo==='Femenino'?'selected':''}>Femenino</option></select></div>
      <div><label>Localidad</label><input id="pacEditLocalidad" value="${escapeHtml(p.localidad||'')}"></div>
      <div><label>Dirección</label><input id="pacEditDireccion" value="${escapeHtml(p.direccion||'')}"></div>
      <div><label>Provincia</label><input id="pacEditProvincia" value="${escapeHtml(p.provincia||'Buenos Aires')}"></div>
      <div><label>Cobertura habitual</label><select id="pacEditCobertura">${data.obrasSociales.map(os=>`<option ${os===(p.coberturaHabitual||'')?'selected':''}>${escapeHtml(os)}</option>`).join('')}</select></div>
      <div><label>Nº afiliado habitual</label><input id="pacEditAfiliado" value="${escapeHtml(p.numeroAfiliadoHabitual||'')}"></div>
      <div class="form-subtitle full-span">Contacto responsable / familiar a cargo</div>
      <div><label>Nombre contacto</label><input id="pacEditContactoNombre" value="${escapeHtml(p.contactoResponsableNombre||'')}" placeholder="Ej: madre, hijo, cuidador"></div>
      <div><label>Relación</label><input id="pacEditContactoRelacion" value="${escapeHtml(p.contactoResponsableRelacion||'')}" placeholder="Madre / hijo / familiar"></div>
      <div><label>Teléfono contacto</label><input id="pacEditContactoTelefono" value="${escapeHtml(p.contactoResponsableTelefono||'')}"></div>
      <div><label>Email contacto</label><input id="pacEditContactoEmail" value="${escapeHtml(p.contactoResponsableEmail||'')}"></div>
    </div>
    <div class="patient-copy-edit411c">
      <span>Copiar datos:</span>
      <button class="secondary small-btn" type="button" onclick="copiarDatoPacienteEdit411C('dni')">DNI</button>
      <button class="secondary small-btn" type="button" onclick="copiarDatoPacienteEdit411C('telefono')">Teléfono</button>
      <button class="secondary small-btn" type="button" onclick="copiarDatoPacienteEdit411C('email')">Email</button>
      <button class="secondary small-btn" type="button" onclick="copiarDatoPacienteEdit411C('todo')">Todos</button>
    </div>
    <div class="modal-actions paciente-edit-actions">
      <button class="secondary" type="button" onclick="seleccionarPacientePanel('${escapeHtml(clavePacientePanel(p))}')">Cancelar</button>
      <button class="primary" type="button" onclick="guardarPacientePanel('${escapeHtml(clavePacientePanel(p))}')">Guardar ficha</button>
    </div>`;
}
function guardarPacientePanel(id){
  const original=buscarPacientePanelPorId(id);
  if(!original)return;
  if(!Array.isArray(data.pacientes))data.pacientes=[];
  const nombreOriginal=normalizarTexto(nombrePacientePanel(original));
  const dni=dniLimpio($('pacEditDni')?.value||original.dni||'');
  let p=null;
  if(original.id && !String(original.id).startsWith('legacy_')) p=data.pacientes.find(x=>x.id===original.id);
  if(!p && dni) p=data.pacientes.find(x=>dniLimpio(x.dni)===dni);
  if(!p && nombreOriginal) p=data.pacientes.find(x=>normalizarTexto(x.nombreCompleto||x.paciente||'')===nombreOriginal);
  if(!p){
    p={id:'pac_'+Date.now()+Math.floor(Math.random()*10000),historialCoberturas:[]};
    data.pacientes.push(p);
  }
  const atencionesOriginales=atencionesDelPaciente(original);
  p.nombreCompleto=$('pacEditNombre')?.value.trim()||original.nombreCompleto||'';
  p.dni=$('pacEditDni')?.value.trim()||original.dni||'';
  p.telefono=$('pacEditTelefono')?.value.trim()||'';
  p.email=$('pacEditEmail')?.value.trim()||'';
  p.fechaNacimiento=$('pacEditNacimiento')?.value||'';
  p.sexo=$('pacEditSexo')?.value||'';
  p.localidad=$('pacEditLocalidad')?.value.trim()||'';
  p.direccion=$('pacEditDireccion')?.value.trim()||'';
  p.provincia=$('pacEditProvincia')?.value.trim()||'Buenos Aires';
  p.coberturaHabitual=$('pacEditCobertura')?.value||'';
  p.numeroAfiliadoHabitual=$('pacEditAfiliado')?.value.trim()||'';
  p.contactoResponsableNombre=$('pacEditContactoNombre')?.value.trim()||'';
  p.contactoResponsableRelacion=$('pacEditContactoRelacion')?.value.trim()||'';
  p.contactoResponsableTelefono=$('pacEditContactoTelefono')?.value.trim()||'';
  p.contactoResponsableEmail=$('pacEditContactoEmail')?.value.trim()||'';
  p.actualizadoEn=new Date().toISOString();

  // Clave del arreglo: editar ficha actualiza el paciente seleccionado y adopta sus atenciones previas.
  // No crea un paciente suelto con 0 atenciones.
  atencionesOriginales.forEach(a=>{
    a.pacienteId=p.id;
    if(p.nombreCompleto)a.paciente=p.nombreCompleto;
    if(p.dni)a.dni=p.dni;
    if(p.telefono)a.telefono=p.telefono;
    if(p.email)a.email=p.email;
    if(p.fechaNacimiento)a.fechaNacimiento=p.fechaNacimiento;
  });
  const dniNuevo=dniLimpio(p.dni);
  const nombreNuevo=normalizarTexto(p.nombreCompleto||'');
  atenciones.forEach(a=>{
    if((dniNuevo && dniLimpio(a.dni)===dniNuevo) || (nombreNuevo && normalizarTexto(a.paciente||'')===nombreNuevo)){
      a.pacienteId=p.id;
      if(p.dni)a.dni=p.dni;
      if(p.nombreCompleto)a.paciente=p.nombreCompleto;
    }
  });
  saveConfig();
  saveAtenciones();
  pacienteSeleccionadoPanelId=p.id;
  renderPacientesPanel($('pacientesBuscar')?.value||'',false);
  seleccionarPacientePanel(p.id);
}
function nuevaAtencionDesdePaciente(id){
  const p=buscarPacientePanelPorId(id); if(!p)return;
  usarPaciente(p.id);
  showSection('carga');
  setTimeout(()=>{$('prestacion')?.focus();},50);
}


/* ===== v2.9.0 FIX ROBUSTO BOTONES / MODALES ===== */
function cardio290Arg(raw){
  raw=String(raw||'').trim();
  if((raw.startsWith('"')&&raw.endsWith('"'))||(raw.startsWith("'")&&raw.endsWith("'"))){
    return raw.slice(1,-1).replace(/\\'/g,"'").replace(/\\"/g,'"');
  }
  if(raw==='undefined'||raw==='null')return '';
  return raw;
}
function cardio290ArgsFromOnclick(oc, fn){
  const re=new RegExp(fn.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\(([^)]*)\\)');
  const m=String(oc||'').match(re);
  if(!m)return [];
  const txt=m[1];
  const out=[]; let cur='', q=null;
  for(let i=0;i<txt.length;i++){
    const ch=txt[i];
    if(q){ cur+=ch; if(ch===q && txt[i-1] !== '\\') q=null; }
    else if(ch==='"'||ch==="'"){ q=ch; cur+=ch; }
    else if(ch===','){ out.push(cardio290Arg(cur)); cur=''; }
    else cur+=ch;
  }
  if(cur.trim()!=='' || txt.includes(',')) out.push(cardio290Arg(cur));
  return out;
}
function cardio290IdDesdeBoton(btn){
  const oc=btn?.getAttribute?.('onclick')||'';
  const fns=['editarAtencion','eliminarAtencion','guardarEdicion','abrirAgendaModal','cambiarEstadoAgenda'];
  for(const fn of fns){
    const args=cardio290ArgsFromOnclick(oc,fn);
    if(args[0])return args[0];
  }
  return btn?.dataset?.id||'';
}
async function cardio290CambiarEstado(id, estado){
  if(!id||!estado)return;
  const a=atenciones.find(x=>String(x.id)===String(id));
  if(!a){ alert('No encontré la atención seleccionada. Actualizá y probá de nuevo.'); return; }
  a.estadoTurno=estado;
  a.estado=estado;
  a.editadoPor=usuarioActualNombreCorto();
  a.editadoEn=new Date().toISOString();
  await saveAtenciones();
  if(typeof renderAgenda==='function')renderAgenda();
  if(typeof renderTabla==='function')renderTabla();
  if(typeof renderStats==='function')renderStats();
}
function cardio290EjecutarBoton(btn,e){
  if(!btn)return false;
  const idBtn=btn.id||'';
  const oc=btn.getAttribute('onclick')||'';
  const texto=(btn.textContent||'').trim().toLowerCase();
  try{
    if(idBtn==='btnAgendaActualizar'){
      e?.preventDefault?.(); e?.stopPropagation?.();
      renderAgenda();
      return true;
    }
    if(idBtn==='btnAgendaHoy'){
      e?.preventDefault?.(); e?.stopPropagation?.();
      if($('agendaFecha'))$('agendaFecha').value=todayISO();
      renderAgenda();
      return true;
    }
    if(oc.includes('editarAtencion(')){
      e?.preventDefault?.(); e?.stopPropagation?.();
      const [id]=cardio290ArgsFromOnclick(oc,'editarAtencion');
      abrirModalEdicion(String(id));
      if(oc.includes('cerrarAgendaModal'))cerrarAgendaModal();
      if(oc.includes('showSection'))showSection('listado');
      return true;
    }
    if(oc.includes('eliminarAtencion(')){
      e?.preventDefault?.(); e?.stopPropagation?.();
      const [id]=cardio290ArgsFromOnclick(oc,'eliminarAtencion');
      eliminarAtencion(String(id));
      return true;
    }
    if(oc.includes('guardarEdicion(')){
      e?.preventDefault?.(); e?.stopPropagation?.();
      const [id]=cardio290ArgsFromOnclick(oc,'guardarEdicion');
      guardarEdicion(String(id));
      return true;
    }
    if(oc.includes('cancelarEdicion(')){
      e?.preventDefault?.(); e?.stopPropagation?.();
      cancelarEdicion();
      return true;
    }
    if(oc.includes('abrirAgendaModal(') && !oc.includes('cambiarEstadoAgenda(')){
      e?.preventDefault?.(); e?.stopPropagation?.();
      const [id]=cardio290ArgsFromOnclick(oc,'abrirAgendaModal');
      abrirAgendaModal(String(id));
      return true;
    }
    if(oc.includes('cambiarEstadoAgenda(')){
      e?.preventDefault?.(); e?.stopPropagation?.();
      const [id,estado]=cardio290ArgsFromOnclick(oc,'cambiarEstadoAgenda');
      cardio290CambiarEstado(String(id),String(estado));
      if(oc.includes('abrirAgendaModal'))setTimeout(()=>abrirAgendaModal(String(id)),60);
      return true;
    }
    // Fallback por texto dentro de agenda aunque el onclick esté roto o cacheado.
    const row=btn.closest?.('tr,.agenda-turno-card');
    if(row && row.querySelector?.('.agenda-status')){
      const id=cardio290IdDesdeBoton(btn);
      if(texto==='ver' || texto==='ver ficha'){
        e?.preventDefault?.(); e?.stopPropagation?.(); abrirAgendaModal(id); return true;
      }
      if(texto==='sala'){
        e?.preventDefault?.(); e?.stopPropagation?.(); cardio290CambiarEstado(id,'sala_espera'); return true;
      }
      if(texto==='atender'){
        e?.preventDefault?.(); e?.stopPropagation?.(); cardio290CambiarEstado(id,'en_consulta'); return true;
      }
      if(texto==='atendido'){
        e?.preventDefault?.(); e?.stopPropagation?.(); cardio290CambiarEstado(id,'atendido'); return true;
      }
    }
  }catch(err){
    console.error('Error en botón CardioLink v2.9.0:', err);
    alert('No se pudo ejecutar el botón. Abrí consola y mandame el primer error rojo.');
    return true;
  }
  return false;
}
document.addEventListener('click',function(e){
  const btn=e.target.closest?.('button');
  if(!btn)return;
  const handled=cardio290EjecutarBoton(btn,e);
  if(handled) e.stopImmediatePropagation?.();
},true);
function cardio290AsegurarBotones(){
  const b1=$('btnAgendaActualizar'); if(b1&&!b1.dataset.cardio290){b1.dataset.cardio290='1'; b1.addEventListener('click',e=>cardio290EjecutarBoton(b1,e));}
  const b2=$('btnAgendaHoy'); if(b2&&!b2.dataset.cardio290){b2.dataset.cardio290='1'; b2.addEventListener('click',e=>cardio290EjecutarBoton(b2,e));}
}
document.addEventListener('DOMContentLoaded',cardio290AsegurarBotones);
setTimeout(cardio290AsegurarBotones,500);
setTimeout(cardio290AsegurarBotones,1500);
try{Object.assign(window,{editarAtencion,eliminarAtencion,guardarEdicion,cancelarEdicion,abrirAgendaModal,cerrarAgendaModal,cambiarEstadoAgenda,showSection,renderAgenda,renderTabla,abrirImportadorMedicloud,cerrarImportadorMedicloud,aplicarImportMedicloud,abrirImportadorWhatsapp,cerrarImportadorWhatsapp,aplicarImportWhatsapp});}catch(e){console.warn('Funciones críticas no expuestas:',e);}


/* ===== v2.9.1 REPARACION ESTABLE: botones, mensajes y prestaciones simples ===== */
(function(){
  const $id = (id) => document.getElementById(id);

  function cl291EsCompuesta(nombre){
    const s=String(nombre||'').toLowerCase();
    return s.includes('+') || s.includes('consulta +') || s.includes('eco +') || s.includes('holter +') || s.includes('mapa +') || s.includes('ecg +') || s.includes('electro +');
  }
  function cl291PrestacionesSimples(items){
    return [...new Set((items||[]).filter(pr=>pr && !cl291EsCompuesta(pr)))].sort();
  }

  try{
    if(typeof data==='object' && data){
      (data.profesionales||[]).forEach(p=>{ p.prestaciones = cl291PrestacionesSimples(p.prestaciones||[]); });
      if(typeof saveConfig==='function') saveConfig();
    }
  }catch(e){ console.warn('v2.9.1 prestaciones simples:', e); }

  // Sobrescribe selectores de prestaciones para que el desplegable principal solo tenga prestaciones simples.
  window.allPrestaciones = allPrestaciones = function(){
    return cl291PrestacionesSimples((data.profesionales||[]).flatMap(p=>p.prestaciones||[]));
  };
  window.actualizarPrestaciones = actualizarPrestaciones = function(){
    const p = typeof profesionalCarga==='function' ? profesionalCarga() : null;
    const items = cl291PrestacionesSimples(p?.prestaciones?.length ? p.prestaciones : allPrestaciones());
    if($id('prestacion')) llenarSelect($id('prestacion'), items);
    if(typeof actualizarExtrasPrestaciones==='function') actualizarExtrasPrestaciones();
  };
  window.selectPrestacionesHTML = selectPrestacionesHTML = function(id, prof, selected){
    const p=(data.profesionales||[]).find(x=>x.id===prof);
    const items=cl291PrestacionesSimples(p?.prestaciones?.length?p.prestaciones:allPrestaciones());
    return selectHTML(id, items, selected);
  };

  function cl291FindAtencionIdFromElement(el){
    const direct = el?.dataset?.id || el?.closest?.('[data-id]')?.dataset?.id;
    if(direct) return String(direct);
    const oc = el?.getAttribute?.('onclick') || '';
    const m = oc.match(/\((['"]?)([^,'")]+)\1(?:,|\))/);
    if(m && m[2]) return String(m[2]);
    const row = el?.closest?.('tr,.agenda-turno-card');
    if(row?.dataset?.id) return String(row.dataset.id);
    return '';
  }
  function cl291GetAtencion(id){ return (atenciones||[]).find(a=>String(a.id)===String(id)); }

  // Re-render de Agenda con data-id/data-action, sin depender de onclick frágil.
  window.renderAgenda = renderAgenda = function(){
    const fecha=$id('agendaFecha')?.value||todayISO();
    const prof=$id('agendaProfesional')?.value||'';
    const est=$id('agendaEstado')?.value||'';
    const vista=$id('agendaVista')?.value||'tabla';
    const datos=atencionesOperativas().filter(a=>{
      if((a.fecha||'')!==fecha) return false;
      if(prof && String(a.profesionalId||'')!==String(prof)) return false;
      if(est && estadoTurno(a)!==est) return false;
      return true;
    }).sort((a,b)=>String(a.horaInicio||'').localeCompare(String(b.horaInicio||'')));
    if($id('agendaConteo')) $id('agendaConteo').textContent=`${datos.length} turno(s) para la fecha seleccionada.`;
    const tabla=$id('agendaTabla'), cards=$id('agendaTarjetas');
    if(tabla){
      tabla.innerHTML = datos.length ? datos.map(a=>`<tr data-id="${escapeHtml(a.id)}">
        <td>${escapeHtml(a.horaInicio||'')}</td><td><strong>${escapeHtml(a.paciente||'')}</strong></td><td>${escapeHtml(a.profesional||'')}</td><td>${escapeHtml(a.prestacion||'')}</td><td>${escapeHtml(a.obraSocial||'')}</td><td>${estadoAgendaBadge(a)}</td>
        <td class="agenda-actions"><button type="button" data-action="agenda-ver" data-id="${escapeHtml(a.id)}">Ver</button><button type="button" data-action="agenda-estado" data-estado="sala_espera" data-id="${escapeHtml(a.id)}">Sala</button><button type="button" data-action="agenda-estado" data-estado="en_consulta" data-id="${escapeHtml(a.id)}">Atender</button><button type="button" data-action="agenda-estado" data-estado="atendido" data-id="${escapeHtml(a.id)}">Atendido</button></td>
      </tr>`).join('') : '<tr><td colspan="7">No hay turnos para mostrar.</td></tr>';
    }
    if(cards){
      cards.innerHTML = datos.map(a=>`<div class="agenda-turno-card" data-id="${escapeHtml(a.id)}"><div><strong>${escapeHtml(a.horaInicio||'')}</strong> · ${escapeHtml(a.paciente||'')}</div><div>${escapeHtml(a.profesional||'')} · ${escapeHtml(a.prestacion||'')} · ${escapeHtml(a.obraSocial||'')}</div><div>${estadoAgendaBadge(a)}</div><div class="agenda-actions"><button type="button" data-action="agenda-ver" data-id="${escapeHtml(a.id)}">Ver ficha</button><button type="button" data-action="agenda-estado" data-estado="sala_espera" data-id="${escapeHtml(a.id)}">Sala</button><button type="button" data-action="agenda-estado" data-estado="en_consulta" data-id="${escapeHtml(a.id)}">Atender</button><button type="button" data-action="agenda-estado" data-estado="atendido" data-id="${escapeHtml(a.id)}">Atendido</button></div></div>`).join('');
    }
    const contTabla=$id('agendaTablaWrap'), contCards=$id('agendaTarjetas');
    if(contTabla) contTabla.style.display = vista==='tabla' ? 'block' : 'none';
    if(contCards) contCards.style.display = vista==='tarjetas' ? 'grid' : 'none';
  };

  window.abrirAgendaModal = abrirAgendaModal = function(id){
    const a=cl291GetAtencion(id);
    if(!a){ alert('No encontré la atención seleccionada. Actualizá y probá de nuevo.'); return; }
    const m=$id('agendaModal'), title=$id('agendaModalTitulo'), body=$id('agendaModalBody');
    if(!m||!body) return;
    if(title) title.textContent=a.paciente||'Turno';
    body.innerHTML=`<div class="agenda-modal-grid"><div><label>Horario</label><strong>${escapeHtml(a.horaInicio||'')}</strong></div><div><label>Paciente</label><strong>${escapeHtml(a.paciente||'')}</strong></div><div><label>Profesional</label><strong>${escapeHtml(a.profesional||'')}</strong></div><div><label>Prestación</label><strong>${escapeHtml(a.prestacion||'')}</strong></div><div><label>Cobertura</label><strong>${escapeHtml(a.obraSocial||'')}</strong></div><div><label>Teléfono</label><strong>${escapeHtml(a.telefono||'s/d')}</strong></div></div><h3>Estado del turno</h3><div class="agenda-state-grid">${Object.entries(ESTADOS_AGENDA).map(([k,e])=>`<button type="button" class="agenda-state-btn ${e.cls} ${estadoTurno(a)===k?'active':''}" data-action="agenda-estado-modal" data-id="${escapeHtml(a.id)}" data-estado="${k}"><i></i>${e.short}</button>`).join('')}</div><div class="agenda-actions modal-actions"><button type="button" data-action="listado-editar" data-id="${escapeHtml(a.id)}">Editar atención</button></div>`;
    m.classList.remove('hidden');
  };

  window.cambiarEstadoAgenda = cambiarEstadoAgenda = function(id, estado){
    const a=cl291GetAtencion(id);
    if(!a){ alert('No encontré la atención seleccionada. Actualizá y probá de nuevo.'); return; }
    a.estadoTurno=estado;
    a.estado=estado;
    a.estadoTurnoEditadoPor=typeof nombreUsuarioAuditoria==='function'?nombreUsuarioAuditoria():usuarioActualNombreCorto();
    a.estadoTurnoEditadoEn=new Date().toISOString();
    if(typeof selloAuditoriaEdicion==='function') selloAuditoriaEdicion(a);
    saveAtenciones();
    renderAgenda();
    if(typeof renderTabla==='function') renderTabla();
    if(typeof renderStats==='function') renderStats();
  };

  // Click único, robusto, para agenda/listado/mensajes/modales.
  document.addEventListener('click', function(e){
    const btn=e.target.closest?.('button');
    if(!btn) return;
    const action=btn.dataset?.action;
    if(!action) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation?.();
    const id=cl291FindAtencionIdFromElement(btn);
    if(action==='agenda-ver') return abrirAgendaModal(id);
    if(action==='agenda-estado') return cambiarEstadoAgenda(id, btn.dataset.estado);
    if(action==='agenda-estado-modal'){ cambiarEstadoAgenda(id, btn.dataset.estado); return abrirAgendaModal(id); }
    if(action==='listado-editar') { if(typeof cerrarAgendaModal==='function') cerrarAgendaModal(); if(typeof showSection==='function') showSection('listado'); return abrirModalEdicion(String(id)); }
    if(action==='listado-borrar') return eliminarAtencion(String(id));
  }, true);

  function cl291BotonesBasicos(){
    const bAct=$id('btnAgendaActualizar'); if(bAct && !bAct.dataset.cl291){ bAct.dataset.cl291='1'; bAct.addEventListener('click',e=>{e.preventDefault();renderAgenda();},true); }
    const bHoy=$id('btnAgendaHoy'); if(bHoy && !bHoy.dataset.cl291){ bHoy.dataset.cl291='1'; bHoy.addEventListener('click',e=>{e.preventDefault(); if($id('agendaFecha'))$id('agendaFecha').value=todayISO(); renderAgenda();},true); }
  }
  document.addEventListener('DOMContentLoaded', cl291BotonesBasicos);
  setTimeout(cl291BotonesBasicos,500);
  setTimeout(()=>{ try{ actualizarPrestaciones(); renderAgenda(); actualizarNotificacionMensajes?.(); }catch(e){} },1200);
})();

/* ===== v2.9.2 FIX DEFINITIVO: editar/borrar listado y retorno desde agenda ===== */
(function(){
  let retornoEdicion = null;
  const $id = (id) => document.getElementById(id);
  const idDesde = (el) => String(el?.dataset?.id || el?.closest?.('[data-id]')?.dataset?.id || '');
  const seccionAgendaVisible = () => !!($id('agenda') && $id('agenda').classList.contains('visible'));
  const seccionListadoVisible = () => !!($id('listado') && $id('listado').classList.contains('visible'));

  function renderDespuesDeCambios(){
    try { if(typeof renderTabla==='function') renderTabla(); } catch(e) { console.warn(e); }
    try { if(typeof renderAgenda==='function') renderAgenda(); } catch(e) { console.warn(e); }
    try { if(typeof renderStats==='function') renderStats(); } catch(e) { console.warn(e); }
    try { if(typeof renderMensajes==='function') renderMensajes(); } catch(e) {}
    try { if(typeof actualizarNotificacionMensajes==='function') actualizarNotificacionMensajes(); } catch(e) {}
  }

  // Quita onclick inline de botones críticos: los maneja este bloque antes que los parches viejos.
  function normalizarBotonesCriticos(root=document){
    root.querySelectorAll?.('button[data-action]').forEach(btn => {
      if(['listado-editar','listado-borrar','agenda-ver','agenda-estado','agenda-estado-modal','modal-guardar-edicion','modal-cancelar-edicion'].includes(btn.dataset.action)){
        btn.removeAttribute('onclick');
      }
    });
    // Botones viejos del listado que todavía puedan venir con onclick: convertirlos a data-action.
    root.querySelectorAll?.('button[onclick*="editarAtencion"],button[onclick*="eliminarAtencion"]').forEach(btn => {
      const oc = btn.getAttribute('onclick') || '';
      const m = oc.match(/\((['"])(.*?)\1\)/) || oc.match(/\(([^)]+)\)/);
      let id = btn.dataset.id || '';
      if(!id && m) id = String(m[2] || m[1] || '').replace(/^['"]|['"]$/g,'');
      if(id){ btn.dataset.id = id; }
      btn.dataset.action = oc.includes('eliminarAtencion') ? 'listado-borrar' : 'listado-editar';
      btn.removeAttribute('onclick');
    });
  }

  const abrirOriginal = typeof abrirModalEdicion === 'function' ? abrirModalEdicion : null;
  window.abrirModalEdicion = abrirModalEdicion = function(id){
    if(!id){ alert('No encontré la atención seleccionada. Actualizá y probá de nuevo.'); return; }
    if(!abrirOriginal){ alert('No está disponible el editor de atención.'); return; }
    abrirOriginal(String(id));
    const modal = $id('modalEdicionAtencion');
    if(!modal) return;
    modal.dataset.atencionId = String(id);
    const guardar = modal.querySelector('.modal-actions .primary');
    if(guardar){
      guardar.removeAttribute('onclick');
      guardar.dataset.action = 'modal-guardar-edicion';
      guardar.dataset.id = String(id);
      guardar.type = 'button';
    }
    const cancelar = modal.querySelector('.modal-actions .secondary');
    if(cancelar){
      cancelar.removeAttribute('onclick');
      cancelar.dataset.action = 'modal-cancelar-edicion';
      cancelar.type = 'button';
    }
    const cerrar = modal.querySelector('.modal-close');
    if(cerrar){
      cerrar.removeAttribute('onclick');
      cerrar.dataset.action = 'modal-cancelar-edicion';
      cerrar.type = 'button';
    }
  };

  const guardarOriginal = typeof guardarEdicionModal === 'function' ? guardarEdicionModal : null;
  window.guardarEdicionModal = guardarEdicionModal = function(id){
    if(!guardarOriginal){ alert('No está disponible guardar edición.'); return; }
    guardarOriginal(String(id));
    if(retornoEdicion === 'agenda'){
      try { if(typeof showSection==='function') showSection('agenda'); } catch(e) {}
      try { if(typeof renderAgenda==='function') renderAgenda(); } catch(e) {}
    } else {
      try { if(typeof showSection==='function' && seccionListadoVisible()) showSection('listado'); } catch(e) {}
      try { if(typeof renderTabla==='function') renderTabla(); } catch(e) {}
    }
    retornoEdicion = null;
  };

  window.eliminarAtencion = eliminarAtencion = async function(id){
    if(!id){ alert('No encontré la atención seleccionada. Actualizá y probá de nuevo.'); return; }
    const a = (atenciones||[]).find(x => String(x.id)===String(id));
    if(!a){ alert('No encontré la atención seleccionada. Actualizá y probá de nuevo.'); return; }
    if(!confirm('¿Borrar esta atención?')) return;

    // Primero borrar exactamente este ID en Supabase. Nunca se hace un borrado masivo.
    if(supabaseClient && usuarioSupabase){
      const { error } = await supabaseClient
        .from('cardiolink_atenciones')
        .delete()
        .eq('id', String(id));
      if(error){
        console.error('No se pudo borrar la atención en Supabase:', error);
        alert('No se pudo borrar la atención en la nube. No se realizaron cambios. Revisá la conexión e intentá nuevamente.');
        return;
      }
    }

    atenciones = (atenciones||[]).filter(x => String(x.id)!==String(id));
    try {
      localStorage.setItem(storageAtenciones, JSON.stringify(atenciones));
    } catch(e) { console.error(e); }
    renderDespuesDeCambios();
  };

  // Captura en window: corre antes que los listeners viejos en document y evita que pisen la acción.
  window.addEventListener('click', function(e){
    const btn = e.target?.closest?.('button');
    if(!btn) return;
    normalizarBotonesCriticos(document);
    const action = btn.dataset?.action;
    if(!action) return;

    if(['listado-editar','listado-borrar','modal-guardar-edicion','modal-cancelar-edicion','agenda-ver','agenda-estado','agenda-estado-modal'].includes(action)){
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation?.();
    } else {
      return;
    }

    const id = idDesde(btn);
    if(action === 'listado-editar'){
      retornoEdicion = (btn.closest('#agendaModal') || seccionAgendaVisible()) ? 'agenda' : 'listado';
      try { if(typeof cerrarAgendaModal==='function') cerrarAgendaModal(); } catch(err) {}
      return abrirModalEdicion(id);
    }
    if(action === 'listado-borrar'){
      return eliminarAtencion(id);
    }
    if(action === 'modal-guardar-edicion'){
      return guardarEdicionModal(id || $id('modalEdicionAtencion')?.dataset?.atencionId || '');
    }
    if(action === 'modal-cancelar-edicion'){
      try { if(typeof cerrarModalEdicion==='function') cerrarModalEdicion(); } catch(err) {}
      if(retornoEdicion === 'agenda'){
        try { if(typeof showSection==='function') showSection('agenda'); } catch(err) {}
        try { if(typeof renderAgenda==='function') renderAgenda(); } catch(err) {}
      }
      retornoEdicion = null;
      return;
    }
    if(action === 'agenda-ver'){
      return abrirAgendaModal(id);
    }
    if(action === 'agenda-estado' || action === 'agenda-estado-modal'){
      if(typeof cambiarEstadoAgenda==='function') cambiarEstadoAgenda(id, btn.dataset.estado);
      if(action === 'agenda-estado-modal') setTimeout(()=>abrirAgendaModal(id), 80);
      return;
    }
  }, true);

  // En cada render, normalizar botones nuevos.
  const renderTablaOriginal = typeof renderTabla === 'function' ? renderTabla : null;
  if(renderTablaOriginal){
    window.renderTabla = renderTabla = function(){
      const r = renderTablaOriginal.apply(this, arguments);
      normalizarBotonesCriticos(document);
      return r;
    };
  }
  const renderAgendaOriginal = typeof renderAgenda === 'function' ? renderAgenda : null;
  if(renderAgendaOriginal){
    window.renderAgenda = renderAgenda = function(){
      const r = renderAgendaOriginal.apply(this, arguments);
      normalizarBotonesCriticos(document);
      return r;
    };
  }

  document.addEventListener('DOMContentLoaded', ()=>setTimeout(()=>normalizarBotonesCriticos(document), 300));
  setTimeout(()=>normalizarBotonesCriticos(document), 1000);
})();

/* ===== v2.9.3 HORARIOS, EDICION Y PRESTACIONES ADICIONALES DINAMICAS ===== */
(function(){
  const $id = (id)=>document.getElementById(id);
  const limpiarPrestExtraId = (p)=>String(p||'').replace(/[^a-zA-Z0-9]+/g,'_');
  const esCompuesta293 = (p)=>String(p||'').includes('+') || /consulta\s*\+/i.test(String(p||''));
  const prestacionesExtraDisponibles293 = ()=>{
    try{
      return [...new Set((data.profesionales||[]).flatMap(p=>p.prestaciones||[])
        .filter(Boolean)
        .filter(p=>!esCompuesta293(p))
        .filter(p=>tipoPrest(p)!=='CONSULTA'))].sort((a,b)=>String(a).localeCompare(String(b),'es'));
    }catch(e){return ['Ecocardiograma Doppler','MAPA','Holter','Electrocardiograma'];}
  };
  function normalizarHora293(v){
    let s=String(v||'').trim().toLowerCase();
    if(!s)return '';
    s=s.replace(/hs?\.?/g,'').replace(/h/g,':').replace(/\s+/g,'');
    const am=s.includes('am'), pm=s.includes('pm');
    s=s.replace(/am|pm/g,'');
    let hh=0, mm=0;
    let m=s.match(/^(\d{1,2})[:.](\d{1,2})$/);
    if(m){hh=Number(m[1]); mm=Number(m[2]);}
    else if(/^\d{3,4}$/.test(s)){hh=Number(s.slice(0,-2)); mm=Number(s.slice(-2));}
    else if(/^\d{1,2}$/.test(s)){hh=Number(s); mm=0;}
    else return '';
    if(pm && hh<12)hh+=12;
    if(am && hh===12)hh=0;
    if(!Number.isFinite(hh)||!Number.isFinite(mm)||hh<0||hh>23||mm<0||mm>59)return '';
    return String(hh).padStart(2,'0')+':'+String(mm).padStart(2,'0');
  }
  window.normalizarHora293 = normalizarHora293;

  function convertirInputsHora293(root=document){
    ['horaInicio','horaFin','m_horaInicio','m_horaFin'].forEach(id=>{
      const el=root.querySelector?.('#'+id) || $id(id);
      if(el){
        try{ el.type='text'; }catch(e){}
        el.placeholder='13:00';
        el.inputMode='numeric';
        el.pattern='[0-2][0-9]:[0-5][0-9]';
        if(!el.dataset.hora293){
          el.dataset.hora293='1';
          el.addEventListener('blur',()=>{ const h=normalizarHora293(el.value); if(h)el.value=h; });
        }
      }
    });
  }

  function renderExtrasDinamicos293(){
    const grid=document.querySelector('.prestaciones-extra-grid');
    if(!grid)return;
    const principal=$id('prestacion')?.value || '';
    const items=prestacionesExtraDisponibles293();
    grid.innerHTML=items.map(prest=>{
      const disabled=prest===principal;
      const safe=limpiarPrestExtraId(prest);
      return `<label><input type="checkbox" class="extra-prestacion" data-prestacion="${escapeHtml(prest)}" id="extra_${safe}" ${disabled?'disabled':''}> ${escapeHtml(prest)} <span class="no-cobrar-inline"><input type="checkbox" id="noCobrar_${safe}"> No cobrar</span></label>`;
    }).join('');
  }

  const actualizarExtrasOriginal293 = typeof actualizarExtrasPrestaciones === 'function' ? actualizarExtrasPrestaciones : null;
  window.actualizarExtrasPrestaciones = actualizarExtrasPrestaciones = function(){
    renderExtrasDinamicos293();
    if(actualizarExtrasOriginal293){try{actualizarExtrasOriginal293.apply(this,arguments);}catch(e){}}
    const prest=$id('prestacion')?.value||'';
    document.querySelectorAll('.extra-prestacion').forEach(ch=>{
      ch.disabled=ch.dataset.prestacion===prest;
      if(ch.disabled)ch.checked=false;
    });
  };

  window.prestacionesAdicionalesSeleccionadas = prestacionesAdicionalesSeleccionadas = function(prestPrincipal){
    const extras=[];
    document.querySelectorAll('.extra-prestacion:checked').forEach(ch=>{
      const prest=ch.dataset.prestacion;
      if(!prest || prest===prestPrincipal)return;
      const noId='noCobrar_'+limpiarPrestExtraId(prest);
      extras.push({prestacion:prest,noCobrar:!!$id(noId)?.checked});
    });
    return extras;
  };

  const crearOriginal293 = typeof crearAtencionDesdeFormulario === 'function' ? crearAtencionDesdeFormulario : null;
  if(crearOriginal293){
    window.crearAtencionDesdeFormulario = crearAtencionDesdeFormulario = function(prestacion, opciones={}){
      if($id('horaInicio'))$id('horaInicio').value=normalizarHora293($id('horaInicio').value)||$id('horaInicio').value;
      if($id('horaFin'))$id('horaFin').value=normalizarHora293($id('horaFin').value)||$id('horaFin').value;
      return crearOriginal293.call(this,prestacion,opciones);
    };
  }

  function selectExtrasModal293(a){
    const grupo=String(a.grupoTurnoId||'');
    const existentes=new Set((atenciones||[]).filter(x=>grupo && String(x.grupoTurnoId||'')===grupo && String(x.id)!==String(a.id)).map(x=>String(x.prestacion||'')));
    const principal=String(a.prestacion||'');
    const items=prestacionesExtraDisponibles293().filter(p=>p!==principal);
    if(!items.length)return '';
    return `<div class="full prestaciones-multiples-box modal-extra-box"><h3>Agregar prestaciones adicionales del mismo turno</h3><p>Cada prestación marcada se agrega como registro separado vinculado al mismo turno.</p><div class="prestaciones-extra-grid modal-extra-grid">${items.map(prest=>{
      const ya=existentes.has(prest);
      const safe=limpiarPrestExtraId(prest);
      return `<label><input type="checkbox" class="m_extra_prestacion" data-prestacion="${escapeHtml(prest)}" id="m_extra_${safe}" ${ya?'checked disabled':''}> ${escapeHtml(prest)}${ya?' <small>ya cargada</small>':''} <span class="no-cobrar-inline"><input type="checkbox" id="m_noCobrar_${safe}" ${ya?'disabled':''}> No cobrar</span></label>`;
    }).join('')}</div></div>`;
  }

  function crearExtraDesdeModal293(base, prest, noCobrar){
    const profId=$id('m_prof')?.value || base.profesionalId || 'matias';
    const prof=(data.profesionales||[]).find(p=>p.id===profId)||{};
    const tipo=$id('m_tipoCobro')?.value || base.tipoCobro || 'Sin cobro en caja';
    const os=$id('m_os')?.value || base.obraSocial || 'Particular';
    const formaBase=$id('m_formaPago')?.value || base.formaPago || 'No aplica';
    const regla=getRegla(os);
    let tipoCobro=tipo, formaPago=formaBase, montoConsulta=0, montoEstudio=0, montoCopago=0, montoTotal=0;
    if(noCobrar || tipo==='No cobrar'){
      tipoCobro='No cobrar'; formaPago='No aplica';
    }else if(os==='Particular' || regla==='COBERTURA_COBRA_PARTICULAR' || tipo.includes('Particular')){
      tipoCobro='Particular'; formaPago=formaPago==='No aplica'?'Efectivo':formaPago;
      montoEstudio=valorDePrestacion(profId, prest);
    }else if(tipo.includes('Copago') || regla==='IOMA_OSPRERA'){
      tipoCobro='Copago'; formaPago=formaPago==='No aplica'?'Efectivo':formaPago;
      montoCopago=copagoDePrestacion(profId, prest);
    }else{
      tipoCobro='Sin cobro en caja'; formaPago='No aplica';
    }
    if(tipoCobro.includes('Particular'))montoTotal+=montoConsulta+montoEstudio;
    if(tipoCobro.includes('Copago')||tipoCobro.includes('copago'))montoTotal+=montoCopago;
    return {
      ...base,
      id:Date.now()+Math.floor(Math.random()*100000),
      grupoTurnoId:base.grupoTurnoId || ('turno_'+Date.now()),
      fecha:$id('m_fecha')?.value || base.fecha || todayISO(),
      horaInicio:normalizarHora293($id('m_horaInicio')?.value) || $id('m_horaInicio')?.value || base.horaInicio || '',
      horaFin:normalizarHora293($id('m_horaFin')?.value) || $id('m_horaFin')?.value || base.horaFin || '',
      paciente:$id('m_paciente')?.value.trim() || base.paciente || '',
      dni:$id('m_dni')?.value.trim() || base.dni || '',
      obraSocial:os,
      coberturaAtencion:os,
      profesionalId:profId,
      profesional:prof.nombre||base.profesional||'',
      prestacion:prest,
      consultaA:$id('m_consultaA')?.value || base.consultaA || 'Matías',
      prestacionA:$id('m_prestacionA')?.value || base.prestacionA || 'Matías',
      cajaPerfil:profId,
      reglaOS:getRegla(os),
      tipoCobro,formaPago,noCobrar:tipoCobro==='No cobrar',montoConsulta,montoEstudio,montoCopago,montoTotal,
      cuentaConsulta:false,
      bonoConsulta:false,
      bonoEstudio:tipoPrest(prest)!=='CONSULTA',
      bonoFirmado:false,
      copiaImpresa:false,
      requiereCopiaImpresa:tipoPrest(prest)!=='CONSULTA',
      fold2:false, planilla:false,
      colocacionLiquidable:esPrestacionColocable(prest) ? ($id('m_colocacionLiquidable')?.checked||false) : false,
      colocador:$id('m_colocador')?.value||base.colocador||'',
      observaciones:[($id('m_obs')?.value||base.observaciones||'').trim(),'Prestación adicional agregada desde edición'].filter(Boolean).join(' | '),
      creadoPor:nombreUsuarioAuditoria(),creadoUsuario:usuarioActualNombreCorto(),creadoRol:perfilUsuarioActual().rol||'',creadoEn:new Date().toISOString(),
      editadoPor:'',editadoUsuario:'',editadoRol:'',editadoEn:''
    };
  }

  const abrirOriginal293 = typeof abrirModalEdicion === 'function' ? abrirModalEdicion : null;
  if(abrirOriginal293){
    window.abrirModalEdicion = abrirModalEdicion = function(id){
      abrirOriginal293.call(this,id);
      const modal=$id('modalEdicionAtencion');
      const a=(atenciones||[]).find(x=>String(x.id)===String(id));
      if(!modal||!a)return;
      modal.dataset.atencionId=String(id);
      const grid=modal.querySelector('.modal-form-grid');
      if(grid && !$id('m_horaInicio')){
        const fechaDiv=$id('m_fecha')?.closest('div');
        const wrap=document.createElement('div');
        wrap.innerHTML=`<label>Hora inicio</label><input type="text" id="m_horaInicio" placeholder="13:00" value="${escapeHtml(a.horaInicio||'')}">`;
        const wrap2=document.createElement('div');
        wrap2.innerHTML=`<label>Hora fin</label><input type="text" id="m_horaFin" placeholder="13:20" value="${escapeHtml(a.horaFin||'')}">`;
        if(fechaDiv?.nextSibling){grid.insertBefore(wrap,fechaDiv.nextSibling);grid.insertBefore(wrap2,wrap.nextSibling);}else{grid.prepend(wrap2);grid.prepend(wrap);}        
      }
      if(grid && !modal.querySelector('.modal-extra-box')){
        const obs=$id('m_obs')?.closest('.full');
        const holder=document.createElement('div');
        holder.innerHTML=selectExtrasModal293(a);
        if(holder.firstElementChild){ grid.insertBefore(holder.firstElementChild, obs || null); }
      }
      convertirInputsHora293(modal);
    };
  }

  const guardarModalOriginal293 = typeof guardarEdicionModal === 'function' ? guardarEdicionModal : null;
  if(guardarModalOriginal293){
    window.guardarEdicionModal = guardarEdicionModal = function(id){
      const a=(atenciones||[]).find(x=>String(x.id)===String(id));
      const grupo=a ? (a.grupoTurnoId || ('turno_'+Date.now())) : '';
      if(a && !a.grupoTurnoId)a.grupoTurnoId=grupo;
      const extras=[];
      document.querySelectorAll('.m_extra_prestacion:checked:not(:disabled)').forEach(ch=>{
        const prest=ch.dataset.prestacion;
        if(!prest)return;
        const safe=limpiarPrestExtraId(prest);
        extras.push({prestacion:prest,noCobrar:!!$id('m_noCobrar_'+safe)?.checked});
      });
      if($id('m_horaInicio'))$id('m_horaInicio').value=normalizarHora293($id('m_horaInicio').value)||$id('m_horaInicio').value;
      if($id('m_horaFin'))$id('m_horaFin').value=normalizarHora293($id('m_horaFin').value)||$id('m_horaFin').value;
      guardarModalOriginal293.call(this,id);
      const actualizado=(atenciones||[]).find(x=>String(x.id)===String(id));
      if(actualizado){
        if($id('m_horaInicio'))actualizado.horaInicio=$id('m_horaInicio').value;
        if($id('m_horaFin'))actualizado.horaFin=$id('m_horaFin').value;
        if(grupo)actualizado.grupoTurnoId=grupo;
        const existentes=new Set((atenciones||[]).filter(x=>String(x.grupoTurnoId||'')===String(grupo)).map(x=>String(x.prestacion||'')));
        extras.forEach(ex=>{ if(!existentes.has(ex.prestacion)){ atenciones.push(crearExtraDesdeModal293(actualizado,ex.prestacion,ex.noCobrar)); existentes.add(ex.prestacion); } });
        saveAtenciones();
        try{renderTabla();}catch(e){}
        try{renderAgenda();}catch(e){}
        try{renderStats();}catch(e){}
      }
    };
  }

  document.addEventListener('DOMContentLoaded',()=>{convertirInputsHora293(document); renderExtrasDinamicos293();});
  setTimeout(()=>{convertirInputsHora293(document); renderExtrasDinamicos293();},500);
})();

/* ===== v2.9.4 MENSAJES CHAT, BLOQUES DE PRESTACIONES Y REGLAS EN EXTRAS ===== */
(function(){
  const $id=(id)=>document.getElementById(id);
  const esc=(v)=> typeof escapeHtml==='function' ? escapeHtml(v) : String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const usuarioCortoActual=()=>{ try{return usuarioLoginCorto(perfilUsuarioActual().usuario||usuarioActualNombreCorto());}catch(e){return usuarioActualNombreCorto?.()||'local';} };
  const esAdminActual=()=>{ try{return esDuenioMatias?.() || perfilUsuarioActual().rol==='admin';}catch(e){return false;} };

  // Versión visible incluso si alguna etiqueta quedó cacheada en el login.
  function actualizarVersionVisible294(){
    document.querySelectorAll('.brand-main span').forEach(el=>el.textContent='v2.9.4');
    document.querySelectorAll('h2').forEach(el=>{ if((el.textContent||'').includes('CardioLink Admin v')) el.textContent='CardioLink Admin v2.9.4'; });
    try{document.title='CardioLink Admin v2.9.4';}catch(e){}
  }

  // Base de bloques. Primer paso: queda operativo y más adelante se lleva a Configuración visual.
  const BLOQUES_PRESTACIONES_294={
    cardiologia:[
      'Consulta','Ecocardiograma Doppler','MAPA','Holter','Electrocardiograma','ECG','Ergometría','Ecoestrés','Ecocardiograma transesofágico'
    ],
    diagnostico_imagenes:[
      'Ecografía abdominal','Ecografía renal','Ecografía tiroidea','Ecografía mamaria','Ecografía pleural','Ecografía pulmonar','Ecodoppler de vasos del cuello','Doppler arterial de miembros inferiores','Doppler venoso de miembros inferiores','Doppler de vena porta','Doppler de aorta abdominal','Doppler radial','Mamografía'
    ],
    neuro_vascular:[
      'Doppler / Dúplex transcraneal'
    ],
    neumonologia:[
      'Consulta neumonología','Espirometría','VEF1'
    ],
    neuro:[
      'Consulta neurología','Electroencefalograma'
    ],
    kinesiologia:[
      'Consulta kinesiología','Sesión de kinesiología','Rehabilitación respiratoria','Rehabilitación motora'
    ],
    otras_especialidades:[
      'Consulta'
    ]
  };
  window.BLOQUES_PRESTACIONES_294=BLOQUES_PRESTACIONES_294;
  function limpiarCompuesta294(nombre){
    const s=String(nombre||'').toLowerCase();
    return s.includes('+') || s.includes('consulta +') || s.includes('eco +') || s.includes('holter +') || s.includes('mapa +') || s.includes('electro +') || s.includes('ecg +');
  }
  function mergeUnicos294(arr){return [...new Set((arr||[]).filter(Boolean).filter(x=>!limpiarCompuesta294(x)))];}
  function asegurarBloquesPrestaciones294(){
    if(!data || !Array.isArray(data.profesionales)) return;
    if(!data.bloquesPrestaciones) data.bloquesPrestaciones=BLOQUES_PRESTACIONES_294;
    Object.entries(BLOQUES_PRESTACIONES_294).forEach(([k,items])=>{ if(!Array.isArray(data.bloquesPrestaciones[k])) data.bloquesPrestaciones[k]=items; });
    (data.profesionales||[]).forEach(p=>{
      if(!Array.isArray(p.bloquesPrestaciones)){
        const area=String(p.area||'').toLowerCase();
        const id=String(p.id||'');
        if(id==='humberto_drago'||id==='lucas_drago'||area.includes('imagen')) p.bloquesPrestaciones=['diagnostico_imagenes'];
        else if(id==='matias') p.bloquesPrestaciones=['cardiologia','neuro_vascular'];
        else if(id==='rogelio') p.bloquesPrestaciones=['cardiologia'];
        else p.bloquesPrestaciones=['otras_especialidades'];
      }
      const desdeBloques=(p.bloquesPrestaciones||[]).flatMap(b=>data.bloquesPrestaciones[b]||[]);
      p.prestaciones=mergeUnicos294([...(p.prestaciones||[]), ...desdeBloques]);
    });
    try{saveConfig?.();}catch(e){}
  }
  asegurarBloquesPrestaciones294();

  // Mejora de sync: deduplicación final de rows y merge seguro ante duplicate key.
  function deduplicarAtenciones294(lista=atenciones){
    const out=[]; const vistos=new Set();
    (lista||[]).forEach((a,idx)=>{
      if(!a || typeof a!=='object')return;
      if(!esMensajeInterno(a) && typeof esAtencionCorrupta==='function' && esAtencionCorrupta(a))return;
      let id=String(a.id??'').trim();
      if(!id || id==='undefined' || id==='null' || vistos.has(id)){
        id=(esMensajeInterno(a)?'msg_':'att_')+Date.now()+'_'+idx+'_'+Math.random().toString(36).slice(2,10);
        a.id=id;
      }
      vistos.add(String(a.id)); out.push(a);
    });
    return out;
  }
  const syncOriginal294 = typeof sincronizarAtencionesSupabase==='function' ? sincronizarAtencionesSupabase : null;
  if(syncOriginal294){
    window.sincronizarAtencionesSupabase = sincronizarAtencionesSupabase = async function(forzar=false){
      try{
        atenciones=deduplicarAtenciones294(atenciones);
        try{localStorage.setItem(storageAtenciones, JSON.stringify(atenciones));}catch(e){}
        return await syncOriginal294.call(this,forzar);
      }catch(err){
        const msg=String(err?.message||err||'');
        if(msg.toLowerCase().includes('duplicate key')){
          atenciones=deduplicarAtenciones294(atenciones);
          try{localStorage.setItem(storageAtenciones, JSON.stringify(atenciones));}catch(e){}
        }
        throw err;
      }
    };
  }

  // Prestaciones visibles por perfil: según bloques asignados, sin compuestas.
  window.allPrestaciones = allPrestaciones = function(){
    asegurarBloquesPrestaciones294();
    return mergeUnicos294((data.profesionales||[]).flatMap(p=>p.prestaciones||[])).sort((a,b)=>String(a).localeCompare(String(b),'es'));
  };
  window.selectPrestacionesHTML = selectPrestacionesHTML = function(id, prof, selected){
    asegurarBloquesPrestaciones294();
    const p=(data.profesionales||[]).find(x=>x.id===prof);
    const items=mergeUnicos294(p?.prestaciones?.length ? p.prestaciones : allPrestaciones()).sort((a,b)=>String(a).localeCompare(String(b),'es'));
    return selectHTML(id, items, selected);
  };
  window.actualizarPrestaciones = actualizarPrestaciones = function(){
    asegurarBloquesPrestaciones294();
    const p=typeof profesionalCarga==='function' ? profesionalCarga() : null;
    const items=mergeUnicos294(p?.prestaciones?.length ? p.prestaciones : allPrestaciones()).sort((a,b)=>String(a).localeCompare(String(b),'es'));
    if($id('prestacion')) llenarSelect($id('prestacion'),items);
    if(typeof actualizarExtrasPrestaciones==='function') actualizarExtrasPrestaciones();
  };

  // Reglas correctas para prestaciones adicionales del mismo turno, especialmente IOMA/OSDE/Rogelio.
  function destinoPrestacionExtra294(profId, os, prestacion){
    const regla=typeof getRegla==='function'?getRegla(os):'';
    const t=typeof tipoPrest==='function'?tipoPrest(prestacion):'ESTUDIO';
    if(profId==='matias' && t!=='CONSULTA'){
      if(['IOMA_OSPRERA','OSDE','SANCOR_PREVENCION'].includes(regla)) return {consultaA:'Matías', prestacionA:'Rogelio', facturador: regla==='IOMA_OSPRERA'?'Fold2 / FEMEBA':'Rogelio'};
      if(regla==='INTEGRAL') return {consultaA:'Matías', prestacionA:'Matías', facturador:'Matías'};
    }
    const prof=(data.profesionales||[]).find(p=>p.id===profId);
    const nom=prof?.nombre || profId || 'A definir';
    return {consultaA: t==='CONSULTA'?nom:'No aplica', prestacionA: t==='CONSULTA'?'No aplica':nom, facturador:nom};
  }
  function montosExtra294(profId, os, prestacion, tipoBase, formaBase, noCobrar){
    const regla=typeof getRegla==='function'?getRegla(os):'';
    const tipoPrestacion=typeof tipoPrest==='function'?tipoPrest(prestacion):'ESTUDIO';
    let tipoCobro=tipoBase||'Sin cobro en caja', formaPago=formaBase||'No aplica', montoConsulta=0, montoEstudio=0, montoCopago=0, montoTotal=0;
    if(noCobrar || tipoCobro==='No cobrar'){
      return {tipoCobro:'No cobrar',formaPago:'No aplica',montoConsulta:0,montoEstudio:0,montoCopago:0,montoTotal:0,noCobrar:true};
    }
    if(os==='Particular' || regla==='COBERTURA_COBRA_PARTICULAR' || String(tipoCobro).includes('Particular')){
      tipoCobro='Particular'; formaPago=formaPago==='No aplica'?'Efectivo':formaPago;
      montoEstudio= tipoPrestacion==='CONSULTA' ? 0 : (valorDePrestacion?.(profId,prestacion)||0);
      montoTotal=montoEstudio;
    }else if(regla==='IOMA_OSPRERA' || String(tipoCobro).includes('Copago')){
      tipoCobro='Copago'; formaPago=formaPago==='No aplica'?'Efectivo':formaPago;
      montoCopago= tipoPrestacion==='CONSULTA' ? 0 : (copagoDePrestacion?.(profId,prestacion)||0);
      // Si por configuración quedó en 0, usar copago estudio del profesional o fallback Matías.
      if(!montoCopago && tipoPrestacion!=='CONSULTA'){
        const p=(data.profesionales||[]).find(x=>x.id===profId) || (data.profesionales||[]).find(x=>x.id==='matias');
        montoCopago=Number(p?.valores?.copagoEstudio||50000);
      }
      montoTotal=montoCopago;
    }else{
      tipoCobro='Sin cobro en caja'; formaPago='No aplica';
    }
    return {tipoCobro,formaPago,montoConsulta,montoEstudio,montoCopago,montoTotal,noCobrar:false};
  }

  const crearAtencionOriginal294 = typeof crearAtencionDesdeFormulario==='function' ? crearAtencionDesdeFormulario : null;
  if(crearAtencionOriginal294){
    window.crearAtencionDesdeFormulario = crearAtencionDesdeFormulario = function(prestacion, opciones={}){
      const r=crearAtencionOriginal294.call(this, prestacion, opciones);
      if(opciones && opciones.adicional && r){
        const profId=r.profesionalId || $id('profesional')?.value || 'matias';
        const os=r.obraSocial || $id('obraSocial')?.value || 'Particular';
        Object.assign(r, destinoPrestacionExtra294(profId, os, r.prestacion));
        Object.assign(r, montosExtra294(profId, os, r.prestacion, r.tipoCobro, r.formaPago, opciones.noCobrar));
        r.cuentaConsulta=false;
        r.bonoConsulta=false;
        r.bonoEstudio=(tipoPrest?.(r.prestacion)!=='CONSULTA');
      }
      return r;
    };
  }

  // Reemplaza creación de extra desde edición modal con la regla corregida.
  window.crearExtraDesdeModal294 = function(base, prest, noCobrar){
    const profId=$id('m_prof')?.value || base.profesionalId || 'matias';
    const prof=(data.profesionales||[]).find(p=>p.id===profId)||{};
    const os=$id('m_os')?.value || base.obraSocial || 'Particular';
    const montos=montosExtra294(profId, os, prest, $id('m_tipoCobro')?.value || base.tipoCobro, $id('m_formaPago')?.value || base.formaPago, noCobrar);
    const destinos=destinoPrestacionExtra294(profId, os, prest);
    return {
      ...base,
      id:'att_'+Date.now()+'_'+Math.random().toString(36).slice(2,8),
      grupoTurnoId:base.grupoTurnoId || ('turno_'+Date.now()),
      fecha:$id('m_fecha')?.value || base.fecha || todayISO(),
      horaInicio:typeof normalizarHora293==='function' ? (normalizarHora293($id('m_horaInicio')?.value)||$id('m_horaInicio')?.value||base.horaInicio||'') : ($id('m_horaInicio')?.value||base.horaInicio||''),
      horaFin:typeof normalizarHora293==='function' ? (normalizarHora293($id('m_horaFin')?.value)||$id('m_horaFin')?.value||base.horaFin||'') : ($id('m_horaFin')?.value||base.horaFin||''),
      paciente:$id('m_paciente')?.value.trim() || base.paciente || '',
      dni:$id('m_dni')?.value.trim() || base.dni || '',
      obraSocial:os,
      coberturaAtencion:os,
      profesionalId:profId,
      profesional:prof.nombre||base.profesional||'',
      prestacion:prest,
      ...destinos,
      cajaPerfil:profId,
      reglaOS:typeof getRegla==='function'?getRegla(os):'',
      ...montos,
      cuentaConsulta:false,
      bonoConsulta:false,
      bonoEstudio:tipoPrest?.(prest)!=='CONSULTA',
      bonoFirmado:false,
      copiaImpresa:false,
      requiereCopiaImpresa:tipoPrest?.(prest)!=='CONSULTA',
      fold2:false, planilla:false,
      colocacionLiquidable:typeof esPrestacionColocable==='function' && esPrestacionColocable(prest) ? ($id('m_colocacionLiquidable')?.checked||false) : false,
      colocador:$id('m_colocador')?.value||base.colocador||'',
      observaciones:[($id('m_obs')?.value||base.observaciones||'').trim(),'Prestación adicional agregada desde edición'].filter(Boolean).join(' | '),
      creadoPor:typeof nombreUsuarioAuditoria==='function'?nombreUsuarioAuditoria():'',creadoUsuario:usuarioActualNombreCorto?.()||'',creadoRol:perfilUsuarioActual?.().rol||'',creadoEn:new Date().toISOString(),
      editadoPor:'',editadoUsuario:'',editadoRol:'',editadoEn:''
    };
  };

  // Intercepta guardar edición para corregir adicionales creados por v2.9.3 si quedaron con No aplica/$0.
  const guardarModalPre294 = typeof guardarEdicionModal==='function' ? guardarEdicionModal : null;
  if(guardarModalPre294){
    window.guardarEdicionModal = guardarEdicionModal = function(id){
      const antesIds=new Set((atenciones||[]).map(a=>String(a.id)));
      guardarModalPre294.call(this,id);
      (atenciones||[]).forEach(a=>{
        if(!antesIds.has(String(a.id)) && String(a.observaciones||'').includes('Prestación adicional')){
          const profId=a.profesionalId||'matias', os=a.obraSocial||'Particular';
          Object.assign(a, destinoPrestacionExtra294(profId, os, a.prestacion));
          Object.assign(a, montosExtra294(profId, os, a.prestacion, a.tipoCobro, a.formaPago, a.noCobrar));
          a.cuentaConsulta=false; a.bonoConsulta=false; a.bonoEstudio=tipoPrest?.(a.prestacion)!=='CONSULTA';
        }
      });
      try{saveAtenciones(); renderTabla?.(); renderAgenda?.(); renderStats?.();}catch(e){}
    };
  }

  // Mensajes tipo chat + borrar.
  function colorClaseMensaje294(m){
    const u=String(m.deUsuario||'').toLowerCase();
    if(u.includes('geraldine')||u.includes('secre')) return 'msg-color-secretaria';
    if(u.includes('rogelio')) return 'msg-color-rogelio';
    if(u.includes('humberto')||u.includes('lucas')||u.includes('drago')) return 'msg-color-drago';
    if(u.includes('matias')) return 'msg-color-matias';
    return 'msg-color-otro';
  }
  window.renderMensajes = renderMensajes = function(){
    const box=$id('mensajesLista'); if(!box)return;
    const filtro=$id('msgFiltro')?.value||'visibles';
    const usr=usuarioCortoActual();
    let datos=(atenciones||[]).filter(esMensajeInterno).sort((a,b)=>String(b.creadoEn||b.fecha||'').localeCompare(String(a.creadoEn||a.fecha||'')));
    if(filtro==='enviados') datos=datos.filter(m=>m.deUsuario===usr);
    else datos=datos.filter(m=>mensajeVisibleParaUsuario?.(m));
    datos=datos.slice(0,120);
    if(!datos.length){box.innerHTML='<p class="muted">No hay mensajes para mostrar.</p>';actualizarNotificacionMensajes?.();return;}
    box.innerHTML=datos.map(m=>{
      const propio=m.deUsuario===usr;
      const visto=(m.leidoPor||[]).includes(usr);
      const puedeBorrar=propio || esAdminActual();
      return `<div class="mensaje-item chat ${propio?'propio':'ajeno'} ${visto?'visto':'nuevo'} ${colorClaseMensaje294(m)}" data-id="${esc(m.id)}">
        <div class="mensaje-texto principal">${esc(m.texto||'')}</div>
        <div class="mensaje-meta"><strong>${esc(m.deNombre||m.deUsuario||'Usuario')}</strong><span>${esc(fechaHoraAuditoria?.(m.creadoEn)||m.horaInicio||'')}</span></div>
        <div class="mensaje-destino">Para: ${esc(nombreDestinoMensaje?.(m.destino)||m.destino||'Todos')}</div>
        ${puedeBorrar?`<button type="button" class="mensaje-borrar" data-action="mensaje-borrar" data-id="${esc(m.id)}">Borrar</button>`:''}
      </div>`;
    }).join('');
    actualizarNotificacionMensajes?.();
  };
  window.eliminarMensajeInterno294=function(id){
    const m=(atenciones||[]).find(x=>String(x.id)===String(id));
    if(!m || !esMensajeInterno(m)){alert('No encontré el mensaje.');return;}
    const usr=usuarioCortoActual();
    if(m.deUsuario!==usr && !esAdminActual()){alert('Solo podés borrar tus mensajes.');return;}
    if(!confirm('¿Borrar este mensaje?'))return;
    atenciones=(atenciones||[]).filter(x=>String(x.id)!==String(id));
    try{saveAtenciones();}catch(e){}
    renderMensajes(); actualizarNotificacionMensajes?.();
  };
  window.addEventListener('click',function(e){
    const btn=e.target?.closest?.('button[data-action="mensaje-borrar"]');
    if(!btn)return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation?.();
    eliminarMensajeInterno294(btn.dataset.id);
  },true);

  document.addEventListener('DOMContentLoaded',()=>{actualizarVersionVisible294(); asegurarBloquesPrestaciones294(); try{actualizarPrestaciones?.(); renderMensajes?.();}catch(e){} });
  setTimeout(()=>{actualizarVersionVisible294(); asegurarBloquesPrestaciones294(); try{actualizarPrestaciones?.(); renderMensajes?.();}catch(e){}},800);
})();


/* ===== v2.9.5 AJUSTES VISUALES: agenda hora, chat real, version visible ===== */
(function(){
  const $id=(id)=>document.getElementById(id);
  const esc=(v)=> typeof escapeHtml==='function' ? escapeHtml(v) : String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const usrActual=()=>{ try{return usuarioLoginCorto(perfilUsuarioActual().usuario||usuarioActualNombreCorto());}catch(e){return usuarioActualNombreCorto?.()||'local';} };
  const esAdmin=()=>{ try{return esDuenioMatias?.() || perfilUsuarioActual().rol==='admin';}catch(e){return false;} };

  function actualizarVersionVisible295(){
    try{document.title='CardioLink Admin v2.9.5';}catch(e){}
    document.querySelectorAll('.brand-main span').forEach(el=>el.textContent='v2.9.5');
    document.querySelectorAll('h2').forEach(el=>{ if((el.textContent||'').includes('CardioLink Admin v')) el.textContent='CardioLink Admin v2.9.5'; });
  }

  function horaAgenda295(a){
    const ini=(a?.horaInicio||a?.hora||a?.horaTurno||a?.horaAtencion||a?.turnoHora||'').toString().trim();
    const fin=(a?.horaFin||a?.horaHasta||a?.turnoHoraFin||'').toString().trim();
    const n=(typeof normalizarHora293==='function' ? normalizarHora293(ini) : '') || ini;
    const f=(typeof normalizarHora293==='function' ? normalizarHora293(fin) : '') || fin;
    if(n && f) return `${n} - ${f}`;
    if(n) return n;
    return 's/h';
  }
  window.horaAgenda295=horaAgenda295;
  window.horaTurno = function(a){ return horaAgenda295(a); };

  function datosAgenda295(){
    const fecha=$id('agendaFecha')?.value||todayISO();
    let prof=$id('agendaProfesional')?.value||'';
    const est=$id('agendaEstado')?.value||'';
    if(typeof esMedico==='function' && esMedico()) prof=profesionalIdUsuarioActual?.()||prof;
    return (atenciones||[]).filter(a=>{
      if(typeof esMensajeInterno==='function' && esMensajeInterno(a)) return false;
      if(typeof esAtencionCorrupta==='function' && esAtencionCorrupta(a)) return false;
      if(a.fecha!==fecha) return false;
      if(prof && prof!=='todos' && a.profesionalId!==prof) return false;
      if(est && (typeof estadoTurno==='function' ? estadoTurno(a) : (a.estadoTurno||'reservado'))!==est) return false;
      return true;
    }).sort((a,b)=>horaAgenda295(a).localeCompare(horaAgenda295(b)) || String(a.paciente||'').localeCompare(String(b.paciente||''),'es'));
  }

  // Render agenda final: conserva botones que ya funcionan, pero muestra hora robusta.
  window.renderAgenda = renderAgenda = function(){
    const tbody=$id('agendaTabla'), cards=$id('agendaTarjetas'); if(!tbody||!cards)return;
    try{ if(typeof agendaTextoPerfil==='function') agendaTextoPerfil(); }catch(e){}
    const datos=datosAgenda295();
    const vista=$id('agendaVista')?.value||'tabla';
    if($id('agendaResumen')) $id('agendaResumen').textContent=datos.length?`${datos.length} turno(s) para la fecha seleccionada.`:'No hay turnos para la fecha seleccionada.';
    if($id('agendaConteo')) $id('agendaConteo').textContent=datos.length?`${datos.length} turno(s) para la fecha seleccionada.`:'No hay turnos para la fecha seleccionada.';
    tbody.innerHTML=datos.map(a=>`<tr data-id="${esc(a.id)}">
      <td><strong>${esc(horaAgenda295(a))}</strong></td>
      <td><strong>${esc(a.paciente||'')}</strong>${a.esPrestacionAdicional?'<br><small class="muted">Estudio adicional del mismo turno</small>':''}</td>
      <td>${esc(a.profesional||'')}</td>
      <td>${esc(a.prestacion||'')}</td>
      <td>${esc(a.obraSocial||a.coberturaAtencion||'')}</td>
      <td>${typeof estadoAgendaBadge==='function'?estadoAgendaBadge(a):esc(a.estadoTurno||'')}</td>
      <td class="agenda-actions"><button type="button" data-action="agenda-ver" data-id="${esc(a.id)}">Ver</button><button type="button" data-action="agenda-estado" data-estado="sala_espera" data-id="${esc(a.id)}">Sala</button><button type="button" data-action="agenda-estado" data-estado="en_consulta" data-id="${esc(a.id)}">Atender</button><button type="button" data-action="agenda-estado" data-estado="atendido" data-id="${esc(a.id)}">Atendido</button></td>
    </tr>`).join('');
    cards.innerHTML=datos.map(a=>`<div class="agenda-turno-card" data-id="${esc(a.id)}">
      <div class="agenda-card-top"><strong>${esc(horaAgenda295(a))}</strong>${typeof estadoAgendaBadge==='function'?estadoAgendaBadge(a):''}</div>
      <div><strong>${esc(a.paciente||'')}</strong></div>
      <div>${esc(a.profesional||'')} · ${esc(a.prestacion||'')} · ${esc(a.obraSocial||a.coberturaAtencion||'')}</div>
      <div class="agenda-actions"><button type="button" data-action="agenda-ver" data-id="${esc(a.id)}">Ver ficha</button><button type="button" data-action="agenda-estado" data-estado="sala_espera" data-id="${esc(a.id)}">Sala</button><button type="button" data-action="agenda-estado" data-estado="en_consulta" data-id="${esc(a.id)}">Atender</button><button type="button" data-action="agenda-estado" data-estado="atendido" data-id="${esc(a.id)}">Atendido</button></div>
    </div>`).join('');
    const wrap=$id('agendaTablaWrap');
    if(wrap) wrap.style.display=vista==='tarjetas'?'none':'';
    cards.style.display=vista==='tarjetas'?'grid':'none';
  };

  // Repara apertura de agenda modal para mostrar horario robusto.
  const abrirAgendaPre295 = typeof abrirAgendaModal==='function' ? abrirAgendaModal : null;
  window.abrirAgendaModal = abrirAgendaModal = function(id){
    const a=(atenciones||[]).find(x=>String(x.id)===String(id));
    const m=$id('agendaModal'), title=$id('agendaModalTitulo'), body=$id('agendaModalBody');
    if(!a || !m || !body){ if(abrirAgendaPre295) return abrirAgendaPre295(id); alert('No encontré la atención seleccionada. Actualizá y probá de nuevo.'); return; }
    if(title) title.textContent=a.paciente||'Turno';
    body.innerHTML=`<div class="agenda-modal-grid"><div><label>Horario</label><strong>${esc(horaAgenda295(a))}</strong></div><div><label>Paciente</label><strong>${esc(a.paciente||'')}</strong></div><div><label>Profesional</label><strong>${esc(a.profesional||'')}</strong></div><div><label>Prestación</label><strong>${esc(a.prestacion||'')}</strong></div><div><label>Cobertura</label><strong>${esc(a.obraSocial||a.coberturaAtencion||'')}</strong></div><div><label>Teléfono</label><strong>${esc(a.telefono||'s/d')}</strong></div></div><h3>Estado del turno</h3><div class="agenda-state-grid">${Object.entries(ESTADOS_AGENDA||{}).map(([k,e])=>`<button type="button" class="agenda-state-btn ${e.cls||''} ${(typeof estadoTurno==='function'?estadoTurno(a):a.estadoTurno)===k?'active':''}" data-action="agenda-estado-modal" data-id="${esc(a.id)}" data-estado="${k}"><i></i>${e.short||k}</button>`).join('')}</div><div class="agenda-actions modal-actions"><button type="button" data-action="listado-editar" data-id="${esc(a.id)}">Editar atención</button></div>`;
    m.classList.remove('hidden');
  };

  function claseColorMensaje295(m){
    const u=String(m.deUsuario||m.deNombre||'').toLowerCase();
    if(u.includes('geraldine')||u.includes('secre')) return 'msg-secretaria';
    if(u.includes('rogelio')) return 'msg-rogelio';
    if(u.includes('humberto')||u.includes('lucas')||u.includes('drago')) return 'msg-drago';
    if(u.includes('matias')) return 'msg-matias';
    return 'msg-otro';
  }
  window.renderMensajes = renderMensajes = function(){
    const box=$id('mensajesLista'); if(!box)return;
    const filtro=$id('msgFiltro')?.value||'visibles';
    const usr=usrActual();
    let datos=(atenciones||[]).filter(a=>typeof esMensajeInterno==='function' && esMensajeInterno(a)).sort((a,b)=>String(b.creadoEn||b.fecha||'').localeCompare(String(a.creadoEn||a.fecha||'')));
    if(filtro==='enviados') datos=datos.filter(m=>m.deUsuario===usr);
    else datos=datos.filter(m=> typeof mensajeVisibleParaUsuario==='function' ? mensajeVisibleParaUsuario(m) : true);
    datos=datos.slice(0,120);
    if(!datos.length){box.innerHTML='<p class="muted">No hay mensajes para mostrar.</p>'; try{actualizarNotificacionMensajes?.();}catch(e){} return;}
    box.innerHTML=datos.map(m=>{
      const propio=String(m.deUsuario||'')===String(usr);
      const visto=(m.leidoPor||[]).includes(usr);
      const puedeBorrar=propio || esAdmin();
      return `<div class="mensaje-burbuja ${propio?'propio':'ajeno'} ${visto?'visto':'nuevo'} ${claseColorMensaje295(m)}" data-id="${esc(m.id)}">
        <div class="mensaje-texto">${esc(m.texto||'')}</div>
        <div class="mensaje-info"><strong>${esc(m.deNombre||m.deUsuario||'Usuario')}</strong><span>${esc((typeof fechaHoraAuditoria==='function'?fechaHoraAuditoria(m.creadoEn):'')||m.horaInicio||'')}</span></div>
        <div class="mensaje-para">Para: ${esc((typeof nombreDestinoMensaje==='function'?nombreDestinoMensaje(m.destino):'')||m.destino||'Todos')}</div>
        ${puedeBorrar?`<button type="button" class="mensaje-borrar" data-action="mensaje-borrar" data-id="${esc(m.id)}">Borrar</button>`:''}
      </div>`;
    }).join('');
    try{actualizarNotificacionMensajes?.();}catch(e){}
  };

  function ajustarLogout295(){
    const btn=$id('btnCerrarSesion');
    if(btn){
      btn.style.bottom='18px'; btn.style.left='18px'; btn.style.zIndex='9999'; btn.style.minWidth='210px';
    }
    const dark=document.querySelector('.dark-toggle');
    if(dark) dark.style.marginBottom='90px';
  }

  document.addEventListener('DOMContentLoaded',()=>{actualizarVersionVisible295(); ajustarLogout295(); try{renderAgenda(); renderMensajes();}catch(e){} });
  setTimeout(()=>{actualizarVersionVisible295(); ajustarLogout295(); try{renderAgenda(); renderMensajes();}catch(e){} },900);
})();


/* ===== v2.9.6 AJUSTES: bloques por perfil, hora edición, chat compacto, permisos colocaciones ===== */
(function(){
  const $id=(id)=>document.getElementById(id);
  const esc=(v)=> typeof escapeHtml==='function' ? escapeHtml(v) : String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));

  const BLOQUES_296={
    cardiologia:['Consulta','Ecocardiograma Doppler','MAPA','Holter','Electrocardiograma','ECG','Ergometría','Ecoestrés','Ecocardiograma transesofágico'],
    diagnostico_imagenes:['Consulta','Ecografía abdominal','Ecografía renal','Ecografía tiroidea','Ecografía mamaria','Ecografía pleural','Ecografía pulmonar','Ecodoppler de vasos del cuello','Doppler arterial de miembros inferiores','Doppler venoso de miembros inferiores','Doppler de vena porta','Doppler de aorta abdominal','Doppler radial','Mamografía'],
    neuro_vascular:['Doppler / Dúplex transcraneal'],
    neumonologia:['Consulta neumonología','Espirometría','VEF1'],
    neuro:['Consulta neurología','Electroencefalograma'],
    kinesiologia:['Consulta kinesiología','Sesión de kinesiología','Rehabilitación respiratoria','Rehabilitación motora'],
    otras_especialidades:['Consulta']
  };
  function limpiarCompuesta296(x){
    const s=String(x||'').toLowerCase();
    return !s || s.includes('+') || s.includes('consulta +') || s.includes('eco +') || s.includes('holter +') || s.includes('mapa +') || s.includes('electro +') || s.includes('ecg +');
  }
  function uniq296(arr){return [...new Set((arr||[]).filter(Boolean).filter(x=>!limpiarCompuesta296(x)))];}
  function bloquesDefault296(prof){
    const id=String(prof?.id||'');
    const area=String(prof?.area||'').toLowerCase();
    if(id==='humberto_drago' || id==='lucas_drago' || area.includes('imagen')) return ['diagnostico_imagenes'];
    if(id==='matias') return ['cardiologia','neuro_vascular'];
    if(id==='rogelio') return ['cardiologia'];
    if(area.includes('neumo')) return ['neumonologia'];
    if(area.includes('neuro')) return ['neuro'];
    if(area.includes('kines')) return ['kinesiologia'];
    return ['otras_especialidades'];
  }
  function asegurarBloques296(){
    if(!window.data || !Array.isArray(data.profesionales)) return;
    data.bloquesPrestaciones = Object.assign({}, BLOQUES_296, data.bloquesPrestaciones||{});
    data.profesionales.forEach(p=>{
      const def=bloquesDefault296(p);
      // Para los perfiles conocidos corregimos los bloques aunque versiones previas hayan mezclado listas.
      if(['matias','rogelio','humberto_drago','lucas_drago'].includes(String(p.id||''))){
        p.bloquesPrestaciones=def;
      }else if(!Array.isArray(p.bloquesPrestaciones) || !p.bloquesPrestaciones.length){
        p.bloquesPrestaciones=def;
      }
    });
    try{localStorage.setItem(storageConfig, JSON.stringify(data));}catch(e){}
  }
  function prestacionesDePerfil296(profId){
    asegurarBloques296();
    const p=(data.profesionales||[]).find(x=>String(x.id)===String(profId)) || (typeof profesionalCarga==='function'?profesionalCarga():null);
    const bloques=(p?.bloquesPrestaciones&&p.bloquesPrestaciones.length?p.bloquesPrestaciones:bloquesDefault296(p));
    let items=bloques.flatMap(b=> (data.bloquesPrestaciones||BLOQUES_296)[b] || BLOQUES_296[b] || []);
    // Permite que perfiles nuevos con prestaciones manuales también las conserven, pero no para perfiles conocidos ya bloqueados.
    if(p && !['matias','rogelio','humberto_drago','lucas_drago'].includes(String(p.id||''))){ items=items.concat(p.prestaciones||[]); }
    return uniq296(items).sort((a,b)=>String(a).localeCompare(String(b),'es'));
  }
  window.prestacionesDePerfil296=prestacionesDePerfil296;

  window.allPrestaciones = allPrestaciones = function(){
    asegurarBloques296();
    return uniq296(Object.values(data.bloquesPrestaciones||BLOQUES_296).flat()).sort((a,b)=>String(a).localeCompare(String(b),'es'));
  };
  window.selectPrestacionesHTML = selectPrestacionesHTML = function(id, prof, selected){
    const items=prestacionesDePerfil296(prof);
    return `<select id="${id}">`+items.map(x=>`<option ${x===selected?'selected':''}>${esc(x)}</option>`).join('')+'</select>';
  };
  window.actualizarPrestaciones = actualizarPrestaciones = function(){
    const profId=$id('profesional')?.value || (typeof profesionalIdUsuarioActual==='function'?profesionalIdUsuarioActual():'matias') || 'matias';
    const items=prestacionesDePerfil296(profId);
    if($id('prestacion')){
      const prev=$id('prestacion').value;
      llenarSelect($id('prestacion'), items);
      if(items.includes(prev)) $id('prestacion').value=prev;
    }
    if(typeof actualizarExtrasPrestaciones==='function') actualizarExtrasPrestaciones();
  };

  function safeId296(prest){return String(prest||'').replace(/[^a-zA-Z0-9_]+/g,'_');}
  window.actualizarExtrasPrestaciones = actualizarExtrasPrestaciones = function(){
    const grid=document.querySelector('.prestaciones-extra-grid');
    if(!grid)return;
    const profId=$id('profesional')?.value || (typeof profesionalIdUsuarioActual==='function'?profesionalIdUsuarioActual():'matias') || 'matias';
    const principal=$id('prestacion')?.value || '';
    const items=prestacionesDePerfil296(profId).filter(p=>p!==principal && !(typeof esConsulta==='function' && esConsulta(p)));
    grid.innerHTML=items.map(prest=>{
      const safe=safeId296(prest);
      return `<label><input type="checkbox" class="extra-prestacion" data-prestacion="${esc(prest)}" id="extra_${safe}"> <span>${esc(prest)}</span> <span class="no-cobrar-inline"><input type="checkbox" id="noCobrar_${safe}"> No cobrar</span></label>`;
    }).join('') || '<p class="muted">Este perfil no tiene prestaciones adicionales configuradas.</p>';
  };

  function actualizarExtrasModal296(){
    const modal=$id('modalEdicionAtencion'); if(!modal)return;
    const box=modal.querySelector('.modal-extra-box'); if(!box)return;
    const grid=box.querySelector('.prestaciones-extra-grid'); if(!grid)return;
    const id=modal.dataset.atencionId;
    const base=(atenciones||[]).find(a=>String(a.id)===String(id));
    const grupo=base?.grupoTurnoId;
    const profId=$id('m_prof')?.value || base?.profesionalId || 'matias';
    const principal=$id('m_prest')?.value || base?.prestacion || '';
    const existentes=new Set((atenciones||[]).filter(x=>grupo && String(x.grupoTurnoId||'')===String(grupo) && String(x.id)!==String(id)).map(x=>String(x.prestacion||'')));
    const items=prestacionesDePerfil296(profId).filter(p=>p!==principal && !(typeof esConsulta==='function' && esConsulta(p)));
    grid.innerHTML=items.map(prest=>{
      const safe=safeId296(prest); const ya=existentes.has(prest);
      return `<label><input type="checkbox" class="m_extra_prestacion" data-prestacion="${esc(prest)}" id="m_extra_${safe}" ${ya?'checked disabled':''}> <span>${esc(prest)}${ya?' <small>ya cargada</small>':''}</span> <span class="no-cobrar-inline"><input type="checkbox" id="m_noCobrar_${safe}" ${ya?'disabled':''}> No cobrar</span></label>`;
    }).join('') || '<p class="muted">Este perfil no tiene prestaciones adicionales configuradas.</p>';
  }

  const abrirPre296=typeof abrirModalEdicion==='function'?abrirModalEdicion:null;
  if(abrirPre296){
    window.abrirModalEdicion = abrirModalEdicion = function(id){
      abrirPre296.call(this,id);
      const modal=$id('modalEdicionAtencion'); const a=(atenciones||[]).find(x=>String(x.id)===String(id));
      if(!modal||!a)return;
      modal.dataset.atencionId=String(id);
      const grid=modal.querySelector('.modal-form-grid');
      if(grid && !$id('m_horaInicio')){
        const fechaDiv=$id('m_fecha')?.closest('div');
        const w1=document.createElement('div'); w1.innerHTML=`<label>Hora inicio</label><input type="text" id="m_horaInicio" placeholder="13:00" value="${esc(a.horaInicio||'')}">`;
        const w2=document.createElement('div'); w2.innerHTML=`<label>Hora fin</label><input type="text" id="m_horaFin" placeholder="13:20" value="${esc(a.horaFin||'')}">`;
        if(fechaDiv?.nextSibling){grid.insertBefore(w1,fechaDiv.nextSibling);grid.insertBefore(w2,w1.nextSibling);}else{grid.prepend(w2);grid.prepend(w1);}
      }
      const prest=$id('m_prest');
      if(prest){
        const items=prestacionesDePerfil296($id('m_prof')?.value || a.profesionalId);
        const prev=prest.value || a.prestacion;
        prest.innerHTML=items.map(x=>`<option ${x===prev?'selected':''}>${esc(x)}</option>`).join('');
        if(items.includes(prev)) prest.value=prev;
      }
      $id('m_prof')?.addEventListener('change',()=>{
        const items=prestacionesDePerfil296($id('m_prof').value);
        if(prest){ prest.innerHTML=items.map(x=>`<option>${esc(x)}</option>`).join(''); }
        actualizarExtrasModal296();
      });
      $id('m_prest')?.addEventListener('change',actualizarExtrasModal296);
      actualizarExtrasModal296();
    };
  }

  const guardarPre296=typeof guardarEdicionModal==='function'?guardarEdicionModal:null;
  if(guardarPre296){
    window.guardarEdicionModal = guardarEdicionModal = function(id){
      const hiRaw=$id('m_horaInicio')?.value || '';
      const hfRaw=$id('m_horaFin')?.value || '';
      const hi=(typeof normalizarHora293==='function'?normalizarHora293(hiRaw):'') || hiRaw;
      const hf=(typeof normalizarHora293==='function'?normalizarHora293(hfRaw):'') || hfRaw;
      guardarPre296.call(this,id);
      const a=(atenciones||[]).find(x=>String(x.id)===String(id));
      if(a){
        a.horaInicio=hi;
        a.horaFin=hf;
        try{selloAuditoriaEdicion?.(a);}catch(e){}
        try{saveAtenciones();}catch(e){}
        try{renderAgenda?.(); renderTabla?.(); renderStats?.();}catch(e){}
      }
    };
  }

  // Oculta Colocaciones/Pendientes a médicos comunes. Queda para Matías, Administración y Secretaría.
  window.puedeVerColocaciones296=function(){
    try{return esMatiasDuenio?.() || esSecretaria?.() || esAdminComun?.() || perfilObj?.().id==='general';}catch(e){return false;}
  };
  const seccionPre296=typeof seccionPermitida==='function'?seccionPermitida:null;
  if(seccionPre296){
    window.seccionPermitida = seccionPermitida = function(section){
      if(section==='colocaciones') return window.puedeVerColocaciones296();
      return seccionPre296.call(this,section);
    };
  }
  const permisosPre296=typeof aplicarPermisosUI==='function'?aplicarPermisosUI:null;
  if(permisosPre296){
    window.aplicarPermisosUI = aplicarPermisosUI = function(){
      permisosPre296.call(this);
      document.querySelectorAll('.nav[data-section="colocaciones"]').forEach(b=>b.classList.toggle('hidden-permission',!window.puedeVerColocaciones296()));
    };
  }

  function moverLogout296(){
    const sidebar=document.querySelector('.sidebar'); const btn=$id('btnCerrarSesion');
    if(sidebar && btn && btn.parentElement!==sidebar) sidebar.appendChild(btn);
    if(btn){
      btn.style.position='static'; btn.style.left='auto'; btn.style.right='auto'; btn.style.bottom='auto'; btn.style.width='auto'; btn.style.maxWidth='220px'; btn.style.visibility=(document.body.classList.contains('app-ready-310')||document.body.classList.contains('app-ready-360'))?'visible':'hidden'; btn.style.display=(document.body.classList.contains('app-ready-310')||document.body.classList.contains('app-ready-360'))?'inline-flex':'none'; btn.style.minWidth='140px'; btn.style.marginTop='10px'; btn.style.zIndex='1'; btn.style.boxShadow='none'; btn.style.alignSelf='flex-start';
    }
    const dark=$id('btnDark'); if(dark){dark.style.marginTop='18px'; dark.style.marginBottom='8px';}
  }
  function version296(){
    try{document.title='CardioLink Admin v4.1.0-hc';}catch(e){}
    document.querySelectorAll('.brand-main span').forEach(el=>el.textContent='v4.1.0-hc');
    document.querySelectorAll('h2').forEach(el=>{ if((el.textContent||'').includes('CardioLink Admin v')) el.textContent='CardioLink Admin v4.1.0-hc'; });
  }
  document.addEventListener('DOMContentLoaded',()=>{asegurarBloques296(); version296(); moverLogout296(); try{actualizarPrestaciones(); aplicarPermisosUI(); renderAgenda?.(); renderMensajes?.();}catch(e){} });
  setTimeout(()=>{asegurarBloques296(); version296(); moverLogout296(); try{actualizarPrestaciones(); aplicarPermisosUI(); renderAgenda?.(); renderMensajes?.();}catch(e){}},900);
})();

/* ===== v2.9.7 CONFIGURACION VISUAL DE BLOQUES DE PRESTACIONES ===== */
(function(){
  const $id=(id)=>document.getElementById(id);
  const esc=(s)=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
  const uniq=(arr)=>[...new Set((arr||[]).map(x=>String(x||'').trim()).filter(Boolean))];
  const normKey=(s)=>String(s||'').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'') || ('bloque_'+Date.now());
  const esCompuesta=(s)=>String(s||'').includes('+') || /consulta\s*\+/i.test(String(s||''));

  const BLOQUES_297={
    cardiologia:['Consulta','Ecocardiograma Doppler','MAPA','Holter','Electrocardiograma','ECG','Ergometría','Ecoestrés','Ecocardiograma transesofágico'],
    diagnostico_imagenes:['Consulta','Ecografía abdominal','Ecografía renal','Ecografía tiroidea','Ecografía mamaria','Ecografía pleural','Ecografía pulmonar','Ecodoppler de vasos del cuello','Doppler arterial de miembros inferiores','Doppler venoso de miembros inferiores','Doppler de vena porta','Doppler de aorta abdominal','Doppler radial','Mamografía'],
    neuro_vascular:['Consulta','Doppler / Dúplex transcraneal'],
    neumonologia:['Consulta neumonología','Espirometría','VEF1','Prueba broncodilatadora','Oximetría','Caminata de 6 minutos'],
    neuro:['Consulta neurología','Electroencefalograma'],
    kinesiologia:['Consulta kinesiología','Sesión de kinesiología','Rehabilitación respiratoria','Rehabilitación motora'],
    otras_especialidades:['Consulta']
  };
  const LABELS_297={
    cardiologia:'Cardiología',
    diagnostico_imagenes:'Diagnóstico por imágenes',
    neuro_vascular:'Neuro vascular',
    neumonologia:'Neumonología',
    neuro:'Neuro',
    kinesiologia:'Kinesiología',
    otras_especialidades:'Otras especialidades'
  };

  function defaultBloquesParaProfesional(p){
    const id=String(p?.id||''); const area=String(p?.area||'').toLowerCase(); const nombre=String(p?.nombre||'').toLowerCase();
    if(id==='general') return [];
    if(id==='matias') return ['cardiologia','neuro_vascular'];
    if(id==='rogelio') return ['cardiologia'];
    if(id==='humberto_drago'||id==='lucas_drago'||area.includes('imagen')||nombre.includes('drago')) return ['diagnostico_imagenes'];
    if(area.includes('neumo')) return ['neumonologia'];
    if(area.includes('kines')) return ['kinesiologia'];
    if(area.includes('neuro')) return ['neuro'];
    return ['otras_especialidades'];
  }

  function asegurarBloques297(){
    if(!window.data) return;
    data.bloquesPrestaciones=data.bloquesPrestaciones && typeof data.bloquesPrestaciones==='object' ? data.bloquesPrestaciones : {};
    Object.entries(BLOQUES_297).forEach(([k,items])=>{
      data.bloquesPrestaciones[k]=uniq([...(data.bloquesPrestaciones[k]||[]), ...items]).filter(x=>!esCompuesta(x));
    });
    data.bloquesPrestacionesLabels=Object.assign({}, LABELS_297, data.bloquesPrestacionesLabels||{});
    (data.profesionales||[]).forEach(p=>{
      if(p.id==='general') return;
      if(!Array.isArray(p.bloquesPrestaciones) || !p.bloquesPrestaciones.length) p.bloquesPrestaciones=defaultBloquesParaProfesional(p);
      p.bloquesPrestaciones=p.bloquesPrestaciones.filter(b=>data.bloquesPrestaciones[b]);
      if(!p.bloquesPrestaciones.length) p.bloquesPrestaciones=defaultBloquesParaProfesional(p);
    });
  }

  function prestacionesDeBloques297(bloques){
    asegurarBloques297();
    const items=[];
    (bloques||[]).forEach(b=>items.push(...(data.bloquesPrestaciones[b]||[])));
    return uniq(items).filter(x=>!esCompuesta(x)).sort((a,b)=>a.localeCompare(b,'es'));
  }
  function prestacionesDePerfil297(profId){
    asegurarBloques297();
    const p=(data.profesionales||[]).find(x=>String(x.id)===String(profId)) || (typeof profesionalCarga==='function'?profesionalCarga():null);
    const bloques=(Array.isArray(p?.bloquesPrestaciones) && p.bloquesPrestaciones.length) ? p.bloquesPrestaciones : defaultBloquesParaProfesional(p);
    let items=prestacionesDeBloques297(bloques);
    // Consulta siempre disponible como base de atención.
    if(!items.some(x=>String(x).toLowerCase()==='consulta')) items.unshift('Consulta');
    return uniq(items).filter(x=>!esCompuesta(x));
  }
  window.prestacionesDePerfil297=prestacionesDePerfil297;
  window.prestacionesDePerfil296=prestacionesDePerfil297;

  window.allPrestaciones = allPrestaciones = function(){
    asegurarBloques297();
    return uniq(Object.values(data.bloquesPrestaciones||{}).flat()).filter(x=>!esCompuesta(x)).sort((a,b)=>a.localeCompare(b,'es'));
  };
  window.selectPrestacionesHTML = selectPrestacionesHTML = function(id, prof, selected){
    const items=prestacionesDePerfil297(prof);
    return `<select id="${id}">`+items.map(x=>`<option ${x===selected?'selected':''}>${esc(x)}</option>`).join('')+'</select>';
  };
  window.actualizarPrestaciones = actualizarPrestaciones = function(){
    const profId=$id('profesional')?.value || (typeof profesionalIdUsuarioActual==='function'?profesionalIdUsuarioActual():'matias') || 'matias';
    const items=prestacionesDePerfil297(profId);
    if($id('prestacion')){
      const prev=$id('prestacion').value;
      llenarSelect($id('prestacion'),items);
      if(items.includes(prev)) $id('prestacion').value=prev;
    }
    if(typeof actualizarExtrasPrestaciones==='function') actualizarExtrasPrestaciones();
  };
  function safeId(prest){return String(prest||'').replace(/[^a-zA-Z0-9_]+/g,'_');}
  window.actualizarExtrasPrestaciones = actualizarExtrasPrestaciones = function(){
    const grid=document.querySelector('.prestaciones-extra-grid');
    if(!grid) return;
    const profId=$id('profesional')?.value || (typeof profesionalIdUsuarioActual==='function'?profesionalIdUsuarioActual():'matias') || 'matias';
    const principal=$id('prestacion')?.value || '';
    const items=prestacionesDePerfil297(profId).filter(p=>p!==principal && !(typeof esConsulta==='function' && esConsulta(p)));
    grid.innerHTML=items.map(prest=>{
      const safe=safeId(prest);
      return `<label><input type="checkbox" class="extra-prestacion" data-prestacion="${esc(prest)}" id="extra_${safe}"> <span>${esc(prest)}</span> <span class="no-cobrar-inline"><input type="checkbox" id="noCobrar_${safe}"> No cobrar</span></label>`;
    }).join('') || '<p class="muted">Este perfil no tiene prestaciones adicionales configuradas.</p>';
  };

  function insertarPanelBloques(){
    if($id('configBloquesPrestaciones297')) return;
    const grid=document.querySelector('#config .config-grid');
    if(!grid) return;
    const card=document.createElement('div');
    card.className='config-bloques-card full-config-card';
    card.id='configBloquesPrestaciones297';
    card.dataset.configGroupCard='prestaciones';
    card.innerHTML=`
      <h3>Bloques de prestaciones por perfil</h3>
      <p class="muted">Usá esto cuando entra un profesional nuevo. Elegís sus bloques y esas prestaciones aparecen en el desplegable principal y en los tildes de prestaciones adicionales.</p>
      <div class="bloques-config-grid">
        <div>
          <label>Profesional</label>
          <select id="cfgBloquesProfesional"></select>
          <div id="cfgBloquesChecks" class="bloques-checks"></div>
          <button class="primary" type="button" id="btnGuardarBloquesProfesional">Guardar bloques del profesional</button>
        </div>
        <div>
          <label>Bloque para editar prestaciones</label>
          <select id="cfgBloqueEditar"></select>
          <div class="inline-form compact-inline">
            <input id="cfgNuevaPrestacionBloque" placeholder="Nueva prestación dentro del bloque">
            <button class="secondary" type="button" id="btnAgregarPrestacionBloque">Agregar prestación</button>
          </div>
          <ul id="cfgListaPrestacionesBloque" class="lista-bloque-prestaciones"></ul>
        </div>
        <div>
          <h4>Crear bloque nuevo</h4>
          <div class="inline-form compact-inline">
            <input id="cfgNuevoBloqueNombre" placeholder="Ej: Dermatología">
            <button class="secondary" type="button" id="btnCrearBloquePrestaciones">Crear bloque</button>
          </div>
          <p class="muted">Después asignalo al profesional y agregale prestaciones.</p>
        </div>
      </div>`;
    const ref=$id('listaPrestaciones')?.closest('div');
    if(ref && ref.parentNode===grid) grid.insertBefore(card, ref.nextSibling); else grid.appendChild(card);
  }

  function opcionesBloquesHTML(selected=''){
    asegurarBloques297();
    return Object.keys(data.bloquesPrestaciones||{}).map(k=>`<option value="${esc(k)}" ${k===selected?'selected':''}>${esc(data.bloquesPrestacionesLabels?.[k]||k)}</option>`).join('');
  }
  function renderBloquesConfig297(){
    insertarPanelBloques(); asegurarBloques297();
    const profSel=$id('cfgBloquesProfesional');
    const bloqueSel=$id('cfgBloqueEditar');
    if(!profSel||!bloqueSel) return;
    const prevProf=profSel.value || 'matias';
    profSel.innerHTML=(data.profesionales||[]).filter(p=>p.id!=='general').map(p=>`<option value="${esc(p.id)}" ${p.id===prevProf?'selected':''}>${esc(p.nombre||p.id)}</option>`).join('');
    if(!profSel.value && profSel.options.length) profSel.value=profSel.options[0].value;
    const prevBloque=bloqueSel.value || Object.keys(data.bloquesPrestaciones||{})[0] || '';
    bloqueSel.innerHTML=opcionesBloquesHTML(prevBloque);
    if(prevBloque && data.bloquesPrestaciones[prevBloque]) bloqueSel.value=prevBloque;
    renderChecksBloquesProfesional297();
    renderListaPrestacionesBloque297();
    bindBloquesConfig297();
  }

  function renderChecksBloquesProfesional297(){
    const box=$id('cfgBloquesChecks'); const profId=$id('cfgBloquesProfesional')?.value;
    if(!box||!profId) return;
    const p=(data.profesionales||[]).find(x=>x.id===profId);
    const activos=new Set(p?.bloquesPrestaciones||[]);
    box.innerHTML=Object.keys(data.bloquesPrestaciones||{}).map(k=>`<label class="bloque-check"><input type="checkbox" class="cfgBloqueProfCheck" value="${esc(k)}" ${activos.has(k)?'checked':''}> <span>${esc(data.bloquesPrestacionesLabels?.[k]||k)}</span></label>`).join('');
    const resumen=prestacionesDePerfil297(profId).join(' · ');
    box.insertAdjacentHTML('beforeend',`<p class="muted prestaciones-preview"><strong>Prestaciones visibles:</strong> ${esc(resumen||'sin prestaciones')}</p>`);
  }
  function renderListaPrestacionesBloque297(){
    const ul=$id('cfgListaPrestacionesBloque'); const b=$id('cfgBloqueEditar')?.value;
    if(!ul||!b) return;
    const items=data.bloquesPrestaciones?.[b]||[];
    ul.innerHTML=items.map(pr=>`<li><span>${esc(pr)}</span> <button type="button" class="small-btn" data-bloque-del="${esc(b)}" data-prest-del="${esc(pr)}">Borrar</button></li>`).join('') || '<li class="muted">Este bloque no tiene prestaciones todavía.</li>';
  }

  let bound297=false;
  function bindBloquesConfig297(){
    if(bound297) return; bound297=true;
    document.addEventListener('change',(e)=>{
      if(e.target?.id==='cfgBloquesProfesional') renderChecksBloquesProfesional297();
      if(e.target?.id==='cfgBloqueEditar') renderListaPrestacionesBloque297();
    });
    document.addEventListener('click',(e)=>{
      const btn=e.target.closest?.('button'); if(!btn) return;
      if(btn.id==='btnGuardarBloquesProfesional'){
        const profId=$id('cfgBloquesProfesional')?.value; const p=(data.profesionales||[]).find(x=>x.id===profId);
        if(!p) return;
        const bloques=[...document.querySelectorAll('.cfgBloqueProfCheck:checked')].map(ch=>ch.value);
        if(!bloques.length){ alert('Elegí al menos un bloque para este profesional.'); return; }
        p.bloquesPrestaciones=bloques;
        p.prestaciones=prestacionesDePerfil297(profId);
        try{saveConfig();}catch(err){}
        try{refreshSelects(); actualizarPrestaciones(); renderConfig();}catch(err){}
        alert('Bloques guardados para '+(p.nombre||profId));
        return;
      }
      if(btn.id==='btnAgregarPrestacionBloque'){
        const b=$id('cfgBloqueEditar')?.value; const pr=($id('cfgNuevaPrestacionBloque')?.value||'').trim();
        if(!b||!pr) return;
        if(esCompuesta(pr)){alert('No agregues prestaciones compuestas acá. Las combinaciones se manejan con tildes de prestaciones adicionales.');return;}
        data.bloquesPrestaciones[b]=uniq([...(data.bloquesPrestaciones[b]||[]), pr]);
        (data.profesionales||[]).forEach(p=>{ if((p.bloquesPrestaciones||[]).includes(b)) p.prestaciones=prestacionesDePerfil297(p.id); });
        $id('cfgNuevaPrestacionBloque').value='';
        try{saveConfig(); refreshSelects(); actualizarPrestaciones(); renderConfig();}catch(err){}
        return;
      }
      if(btn.id==='btnCrearBloquePrestaciones'){
        const nombre=($id('cfgNuevoBloqueNombre')?.value||'').trim();
        if(!nombre) return;
        const k=normKey(nombre);
        if(!data.bloquesPrestaciones[k]) data.bloquesPrestaciones[k]=['Consulta'];
        data.bloquesPrestacionesLabels=data.bloquesPrestacionesLabels||{};
        data.bloquesPrestacionesLabels[k]=nombre;
        $id('cfgNuevoBloqueNombre').value='';
        try{saveConfig(); renderConfig();}catch(err){}
        setTimeout(()=>{ if($id('cfgBloqueEditar')){$id('cfgBloqueEditar').value=k; renderListaPrestacionesBloque297();}},50);
        return;
      }
      if(btn.dataset?.bloqueDel){
        const b=btn.dataset.bloqueDel; const pr=btn.dataset.prestDel;
        if(!confirm('¿Borrar esta prestación del bloque?')) return;
        data.bloquesPrestaciones[b]=(data.bloquesPrestaciones[b]||[]).filter(x=>x!==pr);
        (data.profesionales||[]).forEach(p=>{ if((p.bloquesPrestaciones||[]).includes(b)) p.prestaciones=prestacionesDePerfil297(p.id); });
        try{saveConfig(); refreshSelects(); actualizarPrestaciones(); renderConfig();}catch(err){}
      }
    });
  }

  const renderConfigPre297=typeof renderConfig==='function'?renderConfig:null;
  if(renderConfigPre297){
    window.renderConfig = renderConfig = function(){
      const r=renderConfigPre297.apply(this,arguments);
      renderBloquesConfig297();
      return r;
    };
  }

  const addProfPre297=typeof addProfesional==='function'?addProfesional:null;
  if(addProfPre297){
    window.addProfesional = addProfesional = function(){
      addProfPre297.apply(this,arguments);
      asegurarBloques297();
      try{saveConfig(); refreshSelects(); renderConfig();}catch(e){}
    };
  }

  function version297(){
    try{document.title='CardioLink Admin v2.9.7';}catch(e){}
    document.querySelectorAll('.brand-main span').forEach(el=>el.textContent='v2.9.7');
    document.querySelectorAll('h2').forEach(el=>{ if((el.textContent||'').includes('CardioLink Admin v')) el.textContent='CardioLink Admin v2.9.7'; });
  }

  function init297(){
    asegurarBloques297();
    try{localStorage.setItem(storageConfig,JSON.stringify(data));}catch(e){}
    version297();
    try{renderBloquesConfig297(); actualizarPrestaciones(); renderAgenda?.(); renderTabla?.();}catch(e){console.warn('Init bloques 2.9.7:',e);}
  }
  document.addEventListener('DOMContentLoaded',()=>setTimeout(init297,350));
  setTimeout(init297,1200);
})();


/* ===== v2.9.8 - Carga pura e importación de pacientes desde Excel Medicloud ===== */
(function(){
  const VERSION_298='4.1.0-hc';
  const CONFIG_ROW_ID='__cardiolink_config_v1';
  let previewImportPacientes298=[];

  function d(id){return document.getElementById(id)}
  function esc(v){return String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')}
  function clean(v){return String(v??'').replace(/<[^>]*>/g,' ').replace(/&nbsp;/gi,' ').replace(/\s+/g,' ').trim()}
  function emptyLike(v){const n=norm(clean(v)); return !n || ['no ingresado','no informado','sin dato','sin datos','s/d','sd','null','undefined','no aplica'].includes(n);}
  function val(v){return emptyLike(v)?'':clean(v)}
  function onlyDigits(v){return String(v??'').replace(/\D/g,'')}
  function norm(v){return String(v??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim()}
  function patientKeyName(v){return norm(v).replace(/\s+/g,' ')}
  function splitName(nombre){
    const s=clean(nombre).replace(/\s+/g,' ');
    if(!s) return {nombreCompleto:''};
    return {nombreCompleto:s};
  }
  function parseFechaPac(v){
    if(!v && v!==0) return '';
    if(v instanceof Date && !isNaN(v)){
      const y=v.getFullYear(), m=String(v.getMonth()+1).padStart(2,'0'), d2=String(v.getDate()).padStart(2,'0');
      return `${y}-${m}-${d2}`;
    }
    if(typeof v==='number'){
      // Excel serial date.
      const utc=Math.round((v-25569)*86400*1000);
      const dt=new Date(utc);
      if(!isNaN(dt) && dt.getFullYear()>1900 && dt.getFullYear()<2100){
        const y=dt.getUTCFullYear(), m=String(dt.getUTCMonth()+1).padStart(2,'0'), d2=String(dt.getUTCDate()).padStart(2,'0');
        return `${y}-${m}-${d2}`;
      }
    }
    const s=clean(v).toLowerCase();
    if(!s) return '';
    const iso=s.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
    if(iso) return `${iso[1]}-${iso[2].padStart(2,'0')}-${iso[3].padStart(2,'0')}`;
    const ar=s.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
    if(ar){let y=ar[3]; if(y.length===2)y='19'+y; return `${y}-${ar[2].padStart(2,'0')}-${ar[1].padStart(2,'0')}`;}
    const meses={ene:1,enero:1,jan:1,january:1,feb:2,febrero:2,february:2,mar:3,marzo:3,march:3,abr:4,abril:4,apr:4,april:4,may:5,mayo:5,jun:6,junio:6,june:6,jul:7,julio:7,july:7,ago:8,agosto:8,aug:8,august:8,sep:9,set:9,sept:9,septiembre:9,setiembre:9,september:9,oct:10,octubre:10,october:10,nov:11,noviembre:11,november:11,dic:12,diciembre:12,dec:12,december:12};
    const mt=s.match(/(\d{1,2})\s*(?:de\s*)?([a-záéíóúñ]{3,12})\s*(?:de\s*)?(\d{2,4})/i);
    if(mt){let y=mt[3]; if(y.length===2)y='19'+y; const mm=meses[norm(mt[2])]; if(mm) return `${String(y).padStart(4,'0')}-${String(mm).padStart(2,'0')}-${String(mt[1]).padStart(2,'0')}`;}
    try{ if(typeof fechaISODesdeTexto==='function') return fechaISODesdeTexto(s)||''; }catch(e){}
    return '';
  }
  function headerScore(h, keys){
    const n=norm(h).replace(/[^a-z0-9]/g,'');
    for(const k of keys){
      const nk=norm(k).replace(/[^a-z0-9]/g,'');
      if(n===nk) return 3;
      if(n.includes(nk) || nk.includes(n)) return 2;
    }
    return 0;
  }
  function pick(row, headers, keys){
    let best='', bestScore=0;
    headers.forEach(h=>{const sc=headerScore(h,keys); if(sc>bestScore){bestScore=sc; best=h;}});
    return bestScore?row[best]:'';
  }
  function rowToPaciente298(row, headers){
    function byExact(names){
      const wanted=names.map(norm);
      for(const h of headers){ if(wanted.includes(norm(h))) return row[h]; }
      return '';
    }
    const apellido=val(byExact(['Apellido','Apellidos'])) || val(pick(row,headers,['apellido','apellidos','surname']));
    const nombre=val(byExact(['Nombre','Nombres'])) || val(pick(row,headers,['nombre','nombres','name']));
    const completo=val(pick(row,headers,['nombre y apellido','apellido y nombre','paciente','pacientes','nombre completo','persona','afiliado','beneficiario']));
    // Medicloud exporta Nombre y Apellido separados. Para CardioLink guardamos Apellido primero.
    const nom=val([apellido,nombre].filter(Boolean).join(' ')) || val(completo);
    const dni=onlyDigits(byExact(['N° de Documento','Nº de Documento','Nro Documento','Documento','DNI'])) || onlyDigits(pick(row,headers,['dni','documento','numero documento','nro documento','doc','num doc','numero de dni','número de dni','n° de documento','nº de documento']));
    const telefono=val(byExact(['Teléfono','Telefono','Celular'])) || val(pick(row,headers,['telefono','teléfono','celular','telefono movil','móvil','movil','whatsapp','contacto','tel']));
    let email=val(byExact(['E-Mail','Email','Mail','Correo'])) || val(pick(row,headers,['email','mail','correo','correo electronico','e-mail']));
    if(email && !/@/.test(email)) email='';
    const fechaNacimiento=parseFechaPac(byExact(['Fecha de Nacimiento','Fecha nacimiento','Nacimiento']) || pick(row,headers,['fecha nacimiento','f nacimiento','fecha de nacimiento','nacimiento','fec nac','f. de nacimiento','fnac','fecha nac']));
    const cobertura=val(byExact(['Obra Social','OS','Cobertura','Prepaga','Mutual','Financiador'])) || val(pick(row,headers,['obra social','cobertura','prepaga','mutual','financiador']));
    const afiliado=val(pick(row,headers,['numero afiliado','nro afiliado','número afiliado','afiliado nro','credencial','numero de afiliado','nro. afiliado','plan']));
    const medico=val(byExact(['Médico','Medico','Profesional'])) || val(pick(row,headers,['medico','médico','profesional']));
    const obsBase=val(pick(row,headers,['observaciones','nota','notas','comentarios','comentario']));
    const obs=[obsBase,medico?`Médico Medicloud: ${medico}`:''].filter(Boolean).join(' · ');
    return {
      nombreCompleto: nom,
      dni,
      telefono,
      email,
      fechaNacimiento,
      coberturaHabitual: cobertura,
      numeroAfiliadoHabitual: afiliado,
      observacionesAdministrativas: obs
    };
  }
  function pacienteExistente298(p){
    if(!Array.isArray(data.pacientes)) data.pacientes=[];
    const dni=onlyDigits(p.dni);
    if(dni){const x=data.pacientes.find(q=>onlyDigits(q.dni)===dni); if(x) return x;}
    // Teléfono y email pueden repetirse entre familiares a cargo.
    // No se usan para fusionar pacientes automáticamente.
    const nom=patientKeyName(p.nombreCompleto);
    const fn=p.fechaNacimiento||'';
    if(nom && fn){const x=data.pacientes.find(q=>patientKeyName(q.nombreCompleto||q.paciente)===nom && (q.fechaNacimiento||'')===fn); if(x) return x;}
    return null;
  }
  function aplicarPaciente298(p, existente=null){
    if(!Array.isArray(data.pacientes)) data.pacientes=[];
    const ex=existente || pacienteExistente298(p);
    const target=ex || {id:'pac_'+Date.now()+'_'+Math.random().toString(36).slice(2,8), historialCoberturas:[], creadoEn:new Date().toISOString(), creadoPor: (typeof usuarioActualNombreCorto==='function'?usuarioActualNombreCorto():'')};
    if(!ex) data.pacientes.push(target);
    const campos=['nombreCompleto','dni','telefono','email','fechaNacimiento','coberturaHabitual','numeroAfiliadoHabitual','contactoResponsableNombre','contactoResponsableRelacion','contactoResponsableTelefono','contactoResponsableEmail','observacionesAdministrativas'];
    campos.forEach(k=>{ if(clean(p[k])) target[k]=clean(p[k]); });
    target.actualizadoEn=new Date().toISOString();
    target.actualizadoPor=typeof usuarioActualNombreCorto==='function'?usuarioActualNombreCorto():'';
    if(target.coberturaHabitual){
      target.historialCoberturas=Array.isArray(target.historialCoberturas)?target.historialCoberturas:[];
      if(!target.historialCoberturas.some(h=>norm(h.cobertura||h.os)===norm(target.coberturaHabitual))){
        target.historialCoberturas.push({fecha:typeof todayISO==='function'?todayISO():'', cobertura:target.coberturaHabitual, afiliado:target.numeroAfiliadoHabitual||'', origen:'importación/carga paciente'});
      }
    }
    return {paciente:target, creado:!ex};
  }
  function cerrarModalPaciente298(){ const m=d('modalPacientes298'); if(m) m.remove(); }
  window.cerrarModalPaciente298=cerrarModalPaciente298;
  function modalPaciente298(titulo, html){
    cerrarModalPaciente298();
    const wrap=document.createElement('div');
    wrap.id='modalPacientes298';
    wrap.className='modal-backdrop modal-pacientes298';
    wrap.innerHTML=`<div class="agenda-modal-card pacientes-import-card298">
      <div class="modal-header"><div><h2>${esc(titulo)}</h2><p class="muted">Carga pacientes sin crear turno, consulta, caja ni agenda.</p></div><button class="modal-close" type="button" onclick="cerrarModalPaciente298()">×</button></div>
      ${html}
    </div>`;
    document.body.appendChild(wrap);
  }
  function abrirCargaPacientePuro298(){
    const osOpts=(data.obrasSociales||[]).map(os=>`<option>${esc(os)}</option>`).join('');
    modalPaciente298('Cargar paciente',`<div class="form-grid paciente-edit-form">
      <div><label>Apellido y nombre</label><input id="pac298Nombre" placeholder="Ej: Pérez Juan"></div>
      <div><label>DNI</label><input id="pac298Dni" inputmode="numeric"></div>
      <div><label>Fecha nacimiento</label><input type="date" id="pac298Nacimiento"></div>
      <div><label>Teléfono</label><input id="pac298Telefono"></div>
      <div><label>Email</label><input id="pac298Email"></div>
      <div><label>Obra social / cobertura habitual</label><select id="pac298Cobertura"><option value="">Sin cobertura cargada</option>${osOpts}</select></div>
      <div><label>Nº afiliado</label><input id="pac298Afiliado"></div>
      <div class="form-subtitle full-span">Contacto responsable / familiar a cargo</div>
      <div><label>Nombre contacto</label><input id="pac298ContactoNombre" placeholder="Ej: María Pérez"></div>
      <div><label>Relación</label><input id="pac298ContactoRelacion" placeholder="Madre / hijo / familiar / cuidador"></div>
      <div><label>Teléfono contacto</label><input id="pac298ContactoTelefono"></div>
      <div><label>Email contacto</label><input id="pac298ContactoEmail"></div>
      <div style="grid-column:1/-1"><label>Observaciones administrativas</label><textarea id="pac298Obs" rows="3" placeholder="Dato administrativo útil. No genera evolución ni informe."></textarea></div>
    </div>
    <div class="modal-actions"><button class="secondary" type="button" onclick="cerrarModalPaciente298()">Cancelar</button><button class="primary" type="button" id="btnGuardarPacientePuro298">Guardar paciente</button></div>`);
  }
  window.abrirCargaPacientePuro298=abrirCargaPacientePuro298;
  function guardarPacientePuro298(){
    const p={
      nombreCompleto: clean(d('pac298Nombre')?.value), dni: onlyDigits(d('pac298Dni')?.value), fechaNacimiento:d('pac298Nacimiento')?.value||'', telefono:clean(d('pac298Telefono')?.value), email:clean(d('pac298Email')?.value), coberturaHabitual:clean(d('pac298Cobertura')?.value), numeroAfiliadoHabitual:clean(d('pac298Afiliado')?.value), contactoResponsableNombre:clean(d('pac298ContactoNombre')?.value), contactoResponsableRelacion:clean(d('pac298ContactoRelacion')?.value), contactoResponsableTelefono:clean(d('pac298ContactoTelefono')?.value), contactoResponsableEmail:clean(d('pac298ContactoEmail')?.value), observacionesAdministrativas:clean(d('pac298Obs')?.value)
    };
    if(!p.nombreCompleto && !p.dni && !p.telefono){alert('Cargá al menos nombre, DNI o teléfono.');return;}
    const ex=pacienteExistente298(p);
    if(ex && !confirm('Ya existe un paciente probable. ¿Actualizar la ficha existente?')) return;
    const r=aplicarPaciente298(p,ex);
    try{saveConfig(); guardarConfigEnSupabase298(); renderPacientesPanel('',true); seleccionarPacientePanel(r.paciente.id);}catch(e){console.warn(e)}
    cerrarModalPaciente298();
    alert(r.creado?'Paciente cargado.':'Ficha del paciente actualizada.');
  }
  window.guardarPacientePuro298=guardarPacientePuro298;

  function tablaHtmlMedicloudARows298(text){
    const html=String(text||'');
    if(!/<table[\s>]/i.test(html)) return [];
    const doc=new DOMParser().parseFromString(html,'text/html');
    const table=doc.querySelector('table');
    if(!table) return [];
    const trs=[...table.querySelectorAll('tr')];
    if(!trs.length) return [];
    const headers=[...trs[0].querySelectorAll('th,td')].map(c=>clean(c.textContent));
    return trs.slice(1).map(tr=>{
      const cells=[...tr.querySelectorAll('td,th')].map(c=>clean(c.textContent));
      const obj={}; headers.forEach((h,i)=>obj[h||`Columna ${i+1}`]=cells[i]||'');
      return obj;
    }).filter(r=>Object.values(r).some(v=>clean(v)));
  }
  function abrirImportExcel298(){
    const inp=d('inputPacientesExcel');
    if(inp){ inp.value=''; inp.click(); }
  }
  window.abrirImportExcel298=abrirImportExcel298;
  async function procesarExcelPacientes298(file){
    if(!file) return;
    if(!window.XLSX && !file.name.toLowerCase().endsWith('.csv')){
      alert('No se cargó el lector de Excel. Revisá conexión a internet o probá recargar la página.'); return;
    }
    const buf=await file.arrayBuffer();
    let rows=[];
    try{
      const lower=file.name.toLowerCase();
      const textCandidate=new TextDecoder('utf-8').decode(buf.slice(0,2048));
      if(lower.endsWith('.csv')){
        const text=new TextDecoder('utf-8').decode(buf);
        const wb=XLSX.read(text,{type:'string'});
        rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:''});
      }else if(/<html|<table/i.test(textCandidate)){
        const text=new TextDecoder('utf-8').decode(buf);
        rows=tablaHtmlMedicloudARows298(text);
      }else{
        const wb=XLSX.read(buf,{type:'array',cellDates:true});
        rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:''});
      }
    }catch(e){console.error(e);alert('No pude leer el Excel. Exportalo como .xlsx, .xls o .csv desde la otra app y probá de nuevo.');return;}
    if(!rows.length){alert('El archivo no tiene filas para importar.');return;}
    const headers=[...new Set(rows.flatMap(r=>Object.keys(r)))];
    const parsed=rows.map((r,idx)=>({idx:idx+2, raw:r, paciente:rowToPaciente298(r,headers)})).filter(x=>x.paciente.nombreCompleto||x.paciente.dni||x.paciente.telefono||x.paciente.email);
    previewImportPacientes298=parsed.map(x=>{
      const ex=pacienteExistente298(x.paciente);
      return {...x, existente:ex, accion:ex?'actualizar':'crear'};
    });
    renderPreviewExcel298(file.name);
  }
  function renderPreviewExcel298(filename){
    const nuevos=previewImportPacientes298.filter(x=>x.accion==='crear').length;
    const act=previewImportPacientes298.filter(x=>x.accion==='actualizar').length;
    const sinDni=previewImportPacientes298.filter(x=>!x.paciente.dni).length;
    const body=previewImportPacientes298.slice(0,80).map(x=>`<tr>
      <td>${x.idx}</td><td><strong>${esc(x.paciente.nombreCompleto||'s/n')}</strong></td><td>${esc(x.paciente.dni||'')}</td><td>${esc(x.paciente.telefono||'')}</td><td>${esc(x.paciente.email||'')}</td><td>${esc(x.paciente.coberturaHabitual||'')}</td><td><span class="pill ${x.accion==='crear'?'ok':'warn'}">${x.accion==='crear'?'Nuevo':'Actualiza existente'}</span></td>
    </tr>`).join('');
    modalPaciente298('Importar pacientes desde Excel',`<div class="ok-box"><strong>Archivo:</strong> ${esc(filename)} · ${previewImportPacientes298.length} paciente(s) detectados · ${nuevos} nuevo(s) · ${act} existente(s) · ${sinDni} sin DNI.</div>
      <p class="muted">Se importan solo fichas administrativas. No se crea turno, consulta, estudio, caja ni agenda. Si el DNI ya existe, se actualizan datos faltantes/mejores.</p>
      <div class="import-preview-wrap298"><table class="tabla-mini"><thead><tr><th>Fila</th><th>Paciente</th><th>DNI</th><th>Teléfono</th><th>Email</th><th>Cobertura</th><th>Acción</th></tr></thead><tbody>${body||'<tr><td colspan="7">Sin filas válidas.</td></tr>'}</tbody></table></div>
      ${previewImportPacientes298.length>80?'<p class="muted">Vista previa limitada a las primeras 80 filas.</p>':''}
      <div class="modal-actions"><button class="secondary" type="button" onclick="cerrarModalPaciente298()">Cancelar</button><button class="primary" type="button" id="btnConfirmarImportPacientes298">Importar pacientes</button></div>`);
  }
  function confirmarImportPacientes298(){
    if(!previewImportPacientes298.length){alert('No hay pacientes para importar.');return;}
    let creados=0, actualizados=0, omitidos=0;
    previewImportPacientes298.forEach(x=>{
      const p=x.paciente;
      if(!p.nombreCompleto && !p.dni && !p.telefono && !p.email){omitidos++;return;}
      const ex=pacienteExistente298(p);
      const r=aplicarPaciente298(p,ex);
      if(r.creado) creados++; else actualizados++;
    });
    try{saveConfig(); guardarConfigEnSupabase298(); renderPacientesPanel('',true);}catch(e){console.warn(e)}
    cerrarModalPaciente298();
    alert(`Importación terminada. Nuevos: ${creados}. Actualizados: ${actualizados}. Omitidos: ${omitidos}.`);
  }
  window.confirmarImportPacientes298=confirmarImportPacientes298;

  // Sincronización de configuración/pacientes con Supabase usando una fila técnica.
  async function guardarConfigEnSupabase298(){
    if(!supabaseClient || !usuarioSupabase) return false;
    try{
      const payload={tipoRegistro:'config', version:VERSION_298, config:data, updatedAt:new Date().toISOString()};
      const {error}=await supabaseClient.from('cardiolink_atenciones').upsert([{id:CONFIG_ROW_ID,payload,updated_at:new Date().toISOString()}],{onConflict:'id'});
      if(error) console.warn('No se pudo guardar config/pacientes en Supabase:',error.message);
      return !error;
    }catch(e){console.warn('Error config Supabase:',e);return false;}
  }
  window.guardarConfigEnSupabase298=guardarConfigEnSupabase298;

  if(typeof cargarAtencionesDesdeSupabase==='function'){
    const cargarOld298=cargarAtencionesDesdeSupabase;
    window.cargarAtencionesDesdeSupabase = cargarAtencionesDesdeSupabase = async function(){
      if(!supabaseClient || !usuarioSupabase) return cargarOld298.apply(this,arguments);
      const { data: rows, error } = await supabaseClient.from('cardiolink_atenciones').select('id,payload,updated_at').order('updated_at',{ascending:false});
      if(error){ console.error(error); alert('No se pudieron cargar las atenciones desde Supabase: '+error.message); throw error; }
      const cfgRow=(rows||[]).find(r=>r.id===CONFIG_ROW_ID || r.payload?.tipoRegistro==='config');
      if(cfgRow?.payload?.config){
        try{ data=normalizarConfigCritica(cfgRow.payload.config); localStorage.setItem(storageConfig,JSON.stringify(data)); }catch(e){console.warn('Config remota inválida:',e);}
      }
      const remotas=(rows||[]).filter(r=>r.id!==CONFIG_ROW_ID && r.payload?.tipoRegistro!=='config').map(r=>r.payload).filter(Boolean);
      cargandoDesdeNube=true;
      if(remotas.length>0){
        atenciones=remotas;
        const corruptosEliminados=limpiarRegistrosCorruptosSilencioso();
        localStorage.setItem(storageAtenciones,JSON.stringify(atenciones));
        if(corruptosEliminados>0){ cargandoDesdeNube=false; await sincronizarAtencionesSupabase(true); cargandoDesdeNube=true; }
      }else if(Array.isArray(atenciones)&&atenciones.length>0){
        cargandoDesdeNube=false; await sincronizarAtencionesSupabase(true); return;
      }else{
        atenciones=[]; localStorage.setItem(storageAtenciones,JSON.stringify(atenciones));
      }
      cargandoDesdeNube=false;
    };
  }
  if(typeof sincronizarAtencionesSupabase==='function'){
    window.sincronizarAtencionesSupabase = sincronizarAtencionesSupabase = async function(forzar=false){
      if(!supabaseClient || !usuarioSupabase) return false;
      if(cargandoDesdeNube && !forzar) return false;
      if(syncAtencionesEnCurso){ syncAtencionesPendiente=true; return false; }
      syncAtencionesEnCurso=true;
      try{
        atenciones=registrosSincronizablesSupabase(atenciones);
        localStorage.setItem(storageAtenciones,JSON.stringify(atenciones));
        localStorage.setItem(storageConfig,JSON.stringify(data));

        const rows=atenciones.map(a=>({id:String(a.id),payload:a,updated_at:new Date().toISOString()}));
        rows.push({id:CONFIG_ROW_ID,payload:{tipoRegistro:'config',version:VERSION_298,config:data,updatedAt:new Date().toISOString()},updated_at:new Date().toISOString()});

        const vistos=new Set();
        const finalRows=[];
        rows.forEach((r,idx)=>{
          if(vistos.has(r.id) && r.id!==CONFIG_ROW_ID) r.id='att_'+Date.now()+'_'+idx+'_'+Math.random().toString(36).slice(2,8);
          vistos.add(r.id);
          finalRows.push(r);
        });

        // SINCRONIZACIÓN SEGURA: primero UPSERT. Nunca DELETE ALL antes de guardar.
        const {error:upErr}=await supabaseClient
          .from('cardiolink_atenciones')
          .upsert(finalRows,{onConflict:'id'});
        if(upErr){
          console.error(upErr);
          alert('No se pudo sincronizar con Supabase: '+upErr.message);
          return false;
        }

        // Luego elimina únicamente IDs obsoletos, con protección contra vaciados masivos.
        const limpieza=await limpiarIdsRemotosObsoletosSeguro(
          finalRows.map(r=>r.id),
          atenciones.length
        );
        if(limpieza?.protegido){
          console.warn('CardioLink protegió la base remota: se omitió una limpieza potencialmente masiva.');
        }

        console.log('Supabase sincronizado de forma segura:',finalRows.length,'registros + config',limpieza?.eliminados?`· ${limpieza.eliminados} obsoletos eliminados`:'' );
        return true;
      }finally{
        syncAtencionesEnCurso=false;
        if(syncAtencionesPendiente){ syncAtencionesPendiente=false; setTimeout(()=>sincronizarAtencionesSupabase(false),900); }
      }
    };
  }

  const saveConfigOld298=typeof saveConfig==='function'?saveConfig:null;
  if(saveConfigOld298){
    window.saveConfig = saveConfig = function(){
      const r=saveConfigOld298.apply(this,arguments);
      clearTimeout(window.__syncConfig298Timer);
      window.__syncConfig298Timer=setTimeout(()=>guardarConfigEnSupabase298(),900);
      return r;
    };
  }

  function bind298(){
    document.addEventListener('click',(e)=>{
      const btn=e.target.closest?.('button'); if(!btn) return;
      if(btn.id==='btnPacienteNuevoPuro') abrirCargaPacientePuro298();
      if(btn.id==='btnPacientesImportExcel') abrirImportExcel298();
      if(btn.id==='btnGuardarPacientePuro298') guardarPacientePuro298();
      if(btn.id==='btnConfirmarImportPacientes298') confirmarImportPacientes298();
    });
    const inp=d('inputPacientesExcel'); if(inp && !inp.dataset.bound298){ inp.dataset.bound298='1'; inp.addEventListener('change',()=>procesarExcelPacientes298(inp.files?.[0])); }
  }
  function version298(){
    try{document.title='CardioLink Admin v4.1.0-hc';}catch(e){}
    document.querySelectorAll('.brand-main span').forEach(el=>el.textContent='v4.1.0-hc');
  }
  document.addEventListener('DOMContentLoaded',()=>setTimeout(()=>{bind298();version298();},450));
  setTimeout(()=>{bind298();version298();},1300);
})();


/* ===== v3.0.0 - import texto, nombres Medicloud, filtros finos y copiado rápido ===== */
(function(){
  function $id(id){return document.getElementById(id)}
  function esc(v){return String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')}
  function clean(v){return String(v??'').trim()}
  function digits(v){return String(v??'').replace(/\D/g,'')}
  function copyText300(txt,label='dato'){
    txt=String(txt||'').trim();
    if(!txt){alert('No hay '+label+' cargado para copiar.');return;}
    if(navigator.clipboard?.writeText){navigator.clipboard.writeText(txt).then(()=>toast300('Copiado: '+label)).catch(()=>fallbackCopy300(txt,label));}
    else fallbackCopy300(txt,label);
  }
  function fallbackCopy300(txt,label){const ta=document.createElement('textarea');ta.value=txt;document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove();toast300('Copiado: '+label);}
  function toast300(msg){
    let t=$id('toast300'); if(!t){t=document.createElement('div');t.id='toast300';t.className='toast300';document.body.appendChild(t);}
    t.textContent=msg; t.classList.add('show'); clearTimeout(t._tm); t._tm=setTimeout(()=>t.classList.remove('show'),1400);
  }
  window.copyText300=copyText300;

  function pendienteDetalle300(a,tipo){
    if(!tipo) return true;
    if(tipo==='firma') return !!((a.bonoConsulta||a.bonoEstudio)&&!a.bonoFirmado);
    if(tipo==='copia') return !!((a.bonoEstudio||a.requiereCopiaImpresa)&&!a.copiaImpresa);
    if(tipo==='informe') return !!(typeof esRegistroDeEstudio==='function' && esRegistroDeEstudio(a) && !a.estudioInformado);
    if(tipo==='entrega') return !!(typeof esRegistroDeEstudio==='function' && esRegistroDeEstudio(a) && !(a.estudioImpreso||a.estudioEnviadoMail||a.estudioEnviadoWS));
    return true;
  }
  const oldFiltrar300 = typeof filtrar==='function' ? filtrar : null;
  if(oldFiltrar300){
    window.filtrar = filtrar = function(){
      const base=oldFiltrar300.apply(this,arguments);
      const tipo=$id('fPendienteDetalle')?.value||'';
      return tipo ? base.filter(a=>pendienteDetalle300(a,tipo)) : base;
    }
  }

  function bindPendienteSelect300(){
    const sel=$id('fPendienteDetalle');
    if(sel && !sel.dataset.bound300){
      sel.dataset.bound300='1';
      sel.addEventListener('change',()=>{ try{modoPendientesGlobal=true; paginaListado=1; mostrarResumenFiltros?.(); renderTabla?.(); renderStats?.();}catch(e){console.warn(e)} });
    }
  }

  function marcarPendientesResueltosModal300(){
    ['m_bonoFirmado','m_copiaImpresa','m_estudioInformado','m_estudioImpreso'].forEach(id=>{const el=$id(id); if(el) el.checked=true;});
    toast300('Pendientes marcados como resueltos en esta edición');
  }
  window.marcarPendientesResueltosModal300=marcarPendientesResueltosModal300;

  function botonesCopiaAtencion300(a){
    return `<div class="copy-row300">
      <button type="button" class="copy-btn300" onclick="copyText300('${esc(a.dni||'')}','DNI')">Copiar DNI</button>
      <button type="button" class="copy-btn300" onclick="copyText300('${esc(a.telefono||'')}','teléfono')">Copiar teléfono</button>
      <button type="button" class="copy-btn300" onclick="copyText300('${esc(a.email||'')}','email')">Copiar email</button>
      <button type="button" class="copy-btn300 ok" onclick="marcarPendientesResueltosModal300()">Tildar pendientes resueltos</button>
    </div>`;
  }

  const oldAbrirModal300 = typeof abrirModalEdicion==='function' ? abrirModalEdicion : null;
  if(oldAbrirModal300){
    window.abrirModalEdicion = abrirModalEdicion = function(id){
      oldAbrirModal300.apply(this,arguments);
      setTimeout(()=>{
        const modal=$id('modalEdicionAtencion'); if(!modal || modal.querySelector('.copy-row300')) return;
        const a=(atenciones||[]).find(x=>String(x.id)===String(id)); if(!a) return;
        const header=modal.querySelector('.modal-edit-header');
        if(header) header.insertAdjacentHTML('afterend',botonesCopiaAtencion300(a));
      },20);
    }
  }

  const oldSeleccionarPaciente300 = typeof seleccionarPacientePanel==='function' ? seleccionarPacientePanel : null;
  if(oldSeleccionarPaciente300){
    window.seleccionarPacientePanel = seleccionarPacientePanel = function(id){
      oldSeleccionarPaciente300.apply(this,arguments);
      setTimeout(()=>{
        const det=$id('pacienteDetalle'); if(!det || det.querySelector('.copy-row300')) return;
        const p=(typeof buscarPacientePanelPorId==='function') ? buscarPacientePanelPorId(id) : null; if(!p) return;
        const actions=det.querySelector('.paciente-ficha-actions');
        const html=`<div class="copy-row300 compact">
          <button type="button" class="copy-btn300" onclick="copyText300('${esc(p.dni||'')}','DNI')">Copiar DNI</button>
          <button type="button" class="copy-btn300" onclick="copyText300('${esc(p.telefono||'')}','teléfono')">Copiar teléfono</button>
          <button type="button" class="copy-btn300" onclick="copyText300('${esc(p.email||'')}','email')">Copiar email</button>
        </div>`;
        if(actions) actions.insertAdjacentHTML('beforeend',html);
      },30);
    }
  }

  // En el historial del paciente y el listado agregamos copiado por delegación liviana.
  const oldRenderTabla300 = typeof renderTabla==='function' ? renderTabla : null;
  if(oldRenderTabla300){
    window.renderTabla = renderTabla = function(){
      oldRenderTabla300.apply(this,arguments);
      try{
        document.querySelectorAll('#tablaAtenciones tr').forEach(tr=>{
          if(tr.querySelector('.copy-mini300')) return;
          const edit=tr.querySelector('[data-action="listado-editar"]'); if(!edit) return;
          const id=edit.getAttribute('data-id'); const a=(atenciones||[]).find(x=>String(x.id)===String(id)); if(!a) return;
          const td=tr.children?.[1]; if(!td) return;
          td.insertAdjacentHTML('beforeend',`<div class="copy-mini300"><button type="button" onclick="copyText300('${esc(a.dni||'')}','DNI')">DNI</button><button type="button" onclick="copyText300('${esc(a.telefono||'')}','teléfono')">Tel</button><button type="button" onclick="copyText300('${esc(a.email||'')}','email')">Mail</button></div>`);
        });
      }catch(e){console.warn(e)}
    }
  }

  function bindImportTexto300(){
    const b1=$id('btnPacientesImportTextoMedicloud');
    if(b1 && !b1.dataset.bound300){b1.dataset.bound300='1';b1.addEventListener('click',()=>{ if(typeof abrirImportadorMedicloud==='function') abrirImportadorMedicloud(); });}
    const b2=$id('btnPacientesImportTextoWhatsapp');
    if(b2 && !b2.dataset.bound300){b2.dataset.bound300='1';b2.addEventListener('click',()=>{ if(typeof abrirImportadorWhatsapp==='function') abrirImportadorWhatsapp(); });}
  }

  function version300(){
    try{document.title='CardioLink Admin v4.1.0-hc';}catch(e){}
    document.querySelectorAll('.brand-main span').forEach(el=>el.textContent='v4.1.0-hc');
    const pt=document.querySelector('.print-title h2'); if(pt) pt.textContent='CardioLink Admin v4.1.0-hc';
  }
  function init300(){bindPendienteSelect300();bindImportTexto300();version300();}
  document.addEventListener('DOMContentLoaded',()=>setTimeout(init300,700));
  setTimeout(init300,1600);
})();


/* ===== v3.1.0 - prolijar pacientes: textos de importación y quitar copiar de filas ===== */
(function(){
  function $id(id){return document.getElementById(id)}
  function setText(id,txt){const el=$id(id); if(el) el.textContent=txt;}
  function limpiarCopiasDeFilas310(){
    try{document.querySelectorAll('.copy-mini300').forEach(el=>el.remove());}catch(e){}
  }
  function ajustarBotonesPacientes310(){
    setText('btnPacientesImportExcel','Subir pacientes desde Excel');
    setText('btnPacientesImportTextoWhatsapp','Subir texto WhatsApp');
    setText('btnPacientesImportTextoMedicloud','Subir texto de otra app');
    // Títulos más genéricos en los modales de texto, sin cambiar el parser.
    try{
      const oldAbrirMed = typeof abrirImportadorMedicloud==='function' ? abrirImportadorMedicloud : null;
      if(oldAbrirMed && !oldAbrirMed.__v310){
        const wrapped=function(){
          oldAbrirMed.apply(this,arguments);
          setTimeout(()=>{
            const m=document.getElementById('modalImportMedicloud');
            if(!m) return;
            const h=m.querySelector('h2'); if(h) h.textContent='Subir texto de otra app';
            const p=m.querySelector('p'); if(p) p.textContent='Copiá los datos visibles de la app externa, pegalos acá y CardioLink evita duplicados por DNI.';
            const ta=m.querySelector('textarea'); if(ta) ta.placeholder='Pegá acá el texto copiado desde la otra app';
          },20);
        };
        wrapped.__v310=true;
        window.abrirImportadorMedicloud = abrirImportadorMedicloud = wrapped;
      }
    }catch(e){console.warn(e)}
  }
  const oldRender310 = typeof renderTabla==='function' ? renderTabla : null;
  if(oldRender310 && !oldRender310.__v310){
    const wrapped=function(){
      oldRender310.apply(this,arguments);
      limpiarCopiasDeFilas310();
    };
    wrapped.__v310=true;
    window.renderTabla = renderTabla = wrapped;
  }
  function version310(){
    try{document.title='CardioLink Admin v4.1.0-hc';}catch(e){}
    document.querySelectorAll('.brand-main span').forEach(el=>el.textContent='v4.1.0-hc');
    const pt=document.querySelector('.print-title h2'); if(pt) pt.textContent='CardioLink Admin v4.1.0-hc';
  }
  function init310(){ajustarBotonesPacientes310();limpiarCopiasDeFilas310();version310();}
  document.addEventListener('DOMContentLoaded',()=>setTimeout(init310,800));
  setTimeout(init310,1800);
  setInterval(limpiarCopiasDeFilas310,1200);
})();

/* ===== v3.2.1 - agenda semana/mes, búsqueda global de pacientes y contador de coberturas ===== */
(function(){
  function $id(id){return document.getElementById(id)}
  function esc(v){
    try{return escapeHtml(String(v ?? ''));}catch(e){return String(v ?? '').replace(/[&<>'"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
  }
  function fmtFechaISO(d){return d.toISOString().slice(0,10)}
  function parseISODate(s){
    const m=String(s||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if(!m) return new Date();
    return new Date(Number(m[1]), Number(m[2])-1, Number(m[3]));
  }
  function startOfWeek(date){
    const d=new Date(date.getFullYear(),date.getMonth(),date.getDate());
    const day=d.getDay();
    const diff=(day===0?-6:1-day);
    d.setDate(d.getDate()+diff);
    return d;
  }
  function nombreDiaCorto(d){return ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'][d.getDay()];}
  function mesNombre(d){return d.toLocaleDateString('es-AR',{month:'long',year:'numeric'});}

  function setVersion320(){
    try{document.title='CardioLink Admin v4.1.0-hc';}catch(e){}
    document.querySelectorAll('.brand-main span').forEach(el=>el.textContent='v4.1.0-hc');
    const pt=document.querySelector('.print-title h2'); if(pt) pt.textContent='CardioLink Admin v4.1.0-hc';
  }

  // ---------- Buscador global de pacientes ----------
  function pacientesBusquedaGlobal(q){
    q=String(q||'').trim();
    if(q.length<2) return [];
    try{
      const lista = (typeof pacientesPanelFiltrados==='function') ? pacientesPanelFiltrados(q,false) : [];
      return lista.slice(0,10);
    }catch(e){
      const nq=(typeof normalizarTexto==='function')?normalizarTexto(q):q.toLowerCase();
      const nd=String(q).replace(/\D/g,'');
      return (typeof todosPacientes==='function'?todosPacientes():(data?.pacientes||[])).filter(p=>{
        const nombre=(p.nombreCompleto||p.paciente||'');
        return (nd && String(p.dni||'').replace(/\D/g,'').includes(nd)) ||
          (nd && String(p.telefono||'').replace(/\D/g,'').includes(nd)) ||
          String(nombre).toLowerCase().includes(nq) || String(p.email||'').toLowerCase().includes(nq);
      }).slice(0,10);
    }
  }
  function clavePac320(p){try{return clavePacientePanel(p)}catch(e){return p.id || String(p.dni||'') || String(p.nombreCompleto||p.paciente||'')}}
  function nombrePac320(p){try{return nombrePacientePanel(p)}catch(e){return p.nombreCompleto||p.paciente||'Paciente'}}
  function atencionesPac320(p){try{return atencionesPacienteGlobal(p)}catch(e){return []}}
  function pacientePorClave320(k){
    try{return buscarPacientePanelPorId(k)}catch(e){return (data?.pacientes||[]).find(p=>p.id===k || String(p.dni||'')===k) || null;}
  }
  function ensurePacienteGlobalModal320(){
    if($id('pacienteGlobalModal'))return;
    document.body.insertAdjacentHTML('beforeend',`<div id="pacienteGlobalModal" class="modal-backdrop hidden">
      <div class="modal global-paciente-modal">
        <div class="modal-header"><h2 id="pacienteGlobalTitulo">Ficha paciente</h2><button class="secondary" type="button" id="btnCerrarPacienteGlobal">Cerrar</button></div>
        <div id="pacienteGlobalBody"></div>
      </div>
    </div>`);
    $id('btnCerrarPacienteGlobal')?.addEventListener('click',()=>cerrarPacienteGlobal320());
    $id('pacienteGlobalModal')?.addEventListener('click',(e)=>{if(e.target?.id==='pacienteGlobalModal')cerrarPacienteGlobal320();});
  }
  function cerrarPacienteGlobal320(){ $id('pacienteGlobalModal')?.classList.add('hidden'); document.body.classList.remove('patient-modal-open-371'); }
  function abrirPacienteGlobal320(k){
    const p=pacientePorClave320(k); if(!p){alert('No encontré el paciente.'); return;}
    try{window.CardioLinkPacienteActual411B?.set?.(clavePac320(p));}catch(e){}
    ensurePacienteGlobalModal320();
    const ats=atencionesPac320(p);
    const ult=ats[0];
    const titulo=$id('pacienteGlobalTitulo'); if(titulo) titulo.textContent=nombrePac320(p);
    const body=$id('pacienteGlobalBody'); if(!body)return;
    body.innerHTML=`
      <div class="paciente-ficha-grid global-paciente-grid">
        <div><span>DNI</span><strong>${esc(p.dni||'s/d')}</strong></div>
        <div><span>Teléfono</span><strong>${esc(p.telefono||'s/d')}</strong></div>
        <div><span>Email</span><strong>${esc(p.email||'s/d')}</strong></div>
        <div><span>Contacto responsable</span><strong>${esc(p.contactoResponsableNombre||'s/d')}${p.contactoResponsableRelacion?' · '+esc(p.contactoResponsableRelacion):''}</strong></div>
        <div><span>Teléfono contacto</span><strong>${esc(p.contactoResponsableTelefono||'s/d')}</strong></div>
        <div><span>Email contacto</span><strong>${esc(p.contactoResponsableEmail||'s/d')}</strong></div>
        <div><span>Cobertura habitual</span><strong>${esc(p.coberturaHabitual||p.obraSocial||'Incompleto')}</strong></div>
        <div><span>Nº afiliado</span><strong>${esc(p.numeroAfiliadoHabitual||p.numeroAfiliado||'s/d')}</strong></div>
        <div><span>Fecha nacimiento</span><strong>${esc(p.fechaNacimiento?(typeof formatFecha==='function'?formatFecha(p.fechaNacimiento):p.fechaNacimiento):'s/d')}</strong></div>
        <div><span>Sexo</span><strong>${esc(p.sexo||'s/d')}</strong></div>
        <div><span>Localidad</span><strong>${esc(p.localidad||'s/d')}</strong></div>
        <div><span>Dirección</span><strong>${esc(p.direccion||'s/d')}</strong></div>
        <div><span>Provincia</span><strong>${esc(p.provincia||'Buenos Aires')}</strong></div>
        <div><span>Total atenciones</span><strong>${ats.length}</strong></div>
        <div><span>Última atención</span><strong>${ult?esc((typeof formatFecha==='function'?formatFecha(ult.fecha):ult.fecha)+' · '+(ult.prestacion||'')):'s/d'}</strong></div>
      </div>
      <div class="copy-row300 global-copy-row">
        <button type="button" class="copy-btn300" onclick="copyText300('${esc(p.dni||'')}','DNI')">Copiar DNI</button>
        <button type="button" class="copy-btn300" onclick="copyText300('${esc(p.telefono||'')}','teléfono')">Copiar teléfono</button>
        <button type="button" class="copy-btn300" onclick="copyText300('${esc(p.email||'')}','email')">Copiar email</button>
        <button type="button" class="copy-btn300" onclick="copyText300('${esc(p.contactoResponsableTelefono||'')}','teléfono contacto')">Copiar tel. contacto</button>
        <button type="button" class="copy-btn300" onclick="copyText300('${esc(p.contactoResponsableEmail||'')}','email contacto')">Copiar mail contacto</button>
      </div>
      <div class="modal-actions global-paciente-actions">
        <button class="secondary" type="button" onclick="cerrarPacienteGlobal320();showSection('pacientes');seleccionarPacientePanel('${esc(clavePac320(p))}')">Ver en Pacientes</button>
        <button class="primary" type="button" onclick="cerrarPacienteGlobal320();nuevaAtencionDesdePaciente('${esc(clavePac320(p))}')">Nueva atención</button>
      </div>
      <h3>Últimas atenciones</h3>
      <div class="paciente-historial-wrap"><table class="tabla-mini paciente-historial">
        <thead><tr><th>Fecha</th><th>Profesional</th><th>Prestación</th><th>OS</th><th></th></tr></thead>
        <tbody>${ats.length?ats.slice(0,10).map(a=>`<tr><td>${typeof formatFecha==='function'?formatFecha(a.fecha):esc(a.fecha)}</td><td>${esc(a.profesional||'')}</td><td><strong>${esc((typeof prestacionListado==='function')?prestacionListado(a):a.prestacion)}</strong></td><td>${esc(a.obraSocial||'')}</td><td><button class="secondary" type="button" onclick="cerrarPacienteGlobal320();editarAtencion(${idJS(a.id)})">Editar</button></td></tr>`).join(''):'<tr><td colspan="5">Sin atenciones registradas.</td></tr>'}</tbody>
      </table></div>`;
    $id('pacienteGlobalModal')?.classList.remove('hidden');
  }
  window.abrirPacienteGlobal320=abrirPacienteGlobal320;
  window.cerrarPacienteGlobal320=cerrarPacienteGlobal320;

  function ensureTopSearch320(){
    const top=document.querySelector('.topbar');
    if(!top || $id('globalPatientSearchBox'))return;
    const box=document.createElement('div');
    box.className='global-patient-search-box';
    box.id='globalPatientSearchBox';
    box.innerHTML=`<label>Buscar paciente</label>
      <div class="global-patient-search-inner"><input type="text" id="globalPatientSearch" placeholder="DNI, apellido, teléfono o email"><button type="button" id="globalPatientClear">×</button></div>
      <div id="globalPatientResults" class="global-patient-results hidden"></div>`;
    top.querySelector('.profile-box')?.insertAdjacentElement('afterend',box);
    const inp=$id('globalPatientSearch'), res=$id('globalPatientResults');
    function render(){
      const lista=pacientesBusquedaGlobal(inp?.value||'');
      if(!res)return;
      if(!lista.length){res.classList.add('hidden');res.innerHTML='';return;}
      res.innerHTML=lista.map(p=>`<button type="button" onclick="abrirPacienteGlobal320('${esc(clavePac320(p))}');document.getElementById('globalPatientResults')?.classList.add('hidden')"><strong>${esc(nombrePac320(p))}</strong><span>DNI ${esc(p.dni||'s/d')} · ${esc(p.telefono||'')}</span></button>`).join('');
      res.classList.remove('hidden');
    }
    inp?.addEventListener('input',render);
    inp?.addEventListener('keydown',(e)=>{if(e.key==='Enter'){e.preventDefault();const first=res?.querySelector('button'); if(first)first.click();}});
    $id('globalPatientClear')?.addEventListener('click',()=>{if(inp)inp.value=''; if(res){res.innerHTML='';res.classList.add('hidden');}});
    document.addEventListener('click',(e)=>{if(!box.contains(e.target))res?.classList.add('hidden');});
  }

  // ---------- Agenda semana / mes ----------
  function ensureAgendaCalendar320(){
    if($id('agendaCalendario320'))return $id('agendaCalendario320');
    const ref=$id('agendaTarjetas');
    const div=document.createElement('div');
    div.id='agendaCalendario320';
    div.className='agenda-calendar320 hidden';
    ref?.insertAdjacentElement('afterend',div);
    return div;
  }
  function ensureAgendaViewOptions320(){
    const sel=$id('agendaVista'); if(!sel)return;
    if(!Array.from(sel.options).some(o=>o.value==='semana'))sel.insertAdjacentHTML('beforeend','<option value="semana">Semana calendario</option><option value="mes">Mes calendario</option>');
  }
  function agendaDatosRango320(desde,hasta){
    let prof=$id('agendaProfesional')?.value||'';
    const estado=$id('agendaEstado')?.value||'';
    try{ if(esMedico())prof=profesionalIdUsuarioActual(); if(esMatiasDuenio()&&!prof)prof='matias'; }catch(e){}
    return (atenciones||[]).filter(a=>{
      const f=a.fecha||'';
      if(f<desde || f>hasta)return false;
      if(prof && a.profesionalId!==prof)return false;
      if(estado && estadoTurno(a)!==estado)return false;
      return true;
    }).sort((a,b)=>(a.fecha||'').localeCompare(b.fecha||'') || (a.horaInicio||'99:99').localeCompare(b.horaInicio||'99:99') || String(a.paciente||'').localeCompare(String(b.paciente||''),'es'));
  }
  function turnoMini320(a){
    const hora=(typeof horaTurno==='function'?horaTurno(a):(a.horaInicio||'s/h'));
    return `<button type="button" class="cal-turno320 estado-${estadoTurno(a)}" onclick="abrirAgendaModal(${idJS(a.id)})"><strong>${esc(hora)}</strong> ${esc(a.paciente||'')}<small>${esc(a.prestacion||'')} · ${esc(a.obraSocial||'')}</small></button>`;
  }
  function renderSemana320(cal){
    const base=parseISODate($id('agendaFecha')?.value||fmtFechaISO(new Date()));
    const start=startOfWeek(base);
    const days=Array.from({length:7},(_,i)=>{const d=new Date(start);d.setDate(start.getDate()+i);return d;});
    const desde=fmtFechaISO(days[0]), hasta=fmtFechaISO(days[6]);
    const datos=agendaDatosRango320(desde,hasta);
    cal.innerHTML=`<div class="cal-head320"><strong>Semana del ${typeof formatFecha==='function'?formatFecha(desde):desde} al ${typeof formatFecha==='function'?formatFecha(hasta):hasta}</strong><span>${datos.length} turno(s)</span></div>
      <div class="week-grid320">${days.map(d=>{const iso=fmtFechaISO(d);const arr=datos.filter(a=>a.fecha===iso);return `<div class="day-col320"><h3>${nombreDiaCorto(d)} <span>${d.getDate()}/${d.getMonth()+1}</span></h3>${arr.length?arr.map(turnoMini320).join(''):'<p class="muted empty-day320">Sin turnos</p>'}</div>`}).join('')}</div>`;
    if($id('agendaResumen'))$id('agendaResumen').textContent=`Semana calendario: ${datos.length} turno(s) entre ${desde} y ${hasta}.`;
  }
  function renderMes320(cal){
    const base=parseISODate($id('agendaFecha')?.value||fmtFechaISO(new Date()));
    const first=new Date(base.getFullYear(),base.getMonth(),1);
    const gridStart=startOfWeek(first);
    const days=Array.from({length:42},(_,i)=>{const d=new Date(gridStart);d.setDate(gridStart.getDate()+i);return d;});
    const desde=fmtFechaISO(days[0]), hasta=fmtFechaISO(days[41]);
    const datos=agendaDatosRango320(desde,hasta);
    cal.innerHTML=`<div class="cal-head320"><strong>${mesNombre(base)}</strong><span>${datos.filter(a=>{const d=parseISODate(a.fecha||'');return d.getMonth()===base.getMonth()&&d.getFullYear()===base.getFullYear();}).length} turno(s) del mes</span></div>
      <div class="month-grid320">${days.map(d=>{const iso=fmtFechaISO(d);const arr=datos.filter(a=>a.fecha===iso);const other=d.getMonth()!==base.getMonth()?' other-month320':'';return `<div class="month-cell320${other}"><h3>${nombreDiaCorto(d)} ${d.getDate()}</h3>${arr.slice(0,5).map(turnoMini320).join('')}${arr.length>5?`<small class="muted">+${arr.length-5} más</small>`:arr.length?'':'<p class="muted empty-day320">—</p>'}</div>`}).join('')}</div>`;
    if($id('agendaResumen'))$id('agendaResumen').textContent=`Mes calendario: ${mesNombre(base)}.`;
  }
  function renderAgendaCalendario320(){
    const vista=$id('agendaVista')?.value||'tabla';
    const cal=ensureAgendaCalendar320();
    if(!cal)return;
    if(vista!=='semana' && vista!=='mes'){cal.classList.add('hidden'); return;}
    $id('agendaTablaWrap')?.classList.add('hidden');
    $id('agendaTarjetas')?.classList.add('hidden');
    cal.classList.remove('hidden');
    if(vista==='semana')renderSemana320(cal); else renderMes320(cal);
  }

  const oldRenderAgenda320 = typeof renderAgenda==='function' ? renderAgenda : null;
  if(oldRenderAgenda320 && !oldRenderAgenda320.__v320){
    const wrapped=function(){
      oldRenderAgenda320.apply(this,arguments);
      ensureAgendaViewOptions320();
      renderAgendaCalendario320();
    };
    wrapped.__v320=true;
    window.renderAgenda = renderAgenda = wrapped;
  }

  // ---------- Contador de coberturas de pacientes ----------
  function coberturaPaciente320(p){
    const v=String(p.coberturaHabitual || p.obraSocial || p.cobertura || '').trim();
    if(!v || /^(no ingresado|sin dato|s\/d|undefined|null)$/i.test(v)) return 'Incompleto';
    return v;
  }
  function pacientesUnicosCobertura320(){
    const map=new Map();
    try{
      (typeof todosPacientes==='function'?todosPacientes():(data?.pacientes||[])).forEach(p=>{
        if(!p || p.estado==='fusionado')return;
        const k=(p.dni?String(p.dni).replace(/\D/g,''):'') || normalizarTexto(nombrePac320(p));
        if(k && !map.has(k))map.set(k,p);
      });
    }catch(e){(data?.pacientes||[]).forEach(p=>{if(p?.id&&!map.has(p.id))map.set(p.id,p)});}
    return Array.from(map.values());
  }
  function renderContadorCoberturas320(){
    const card=document.querySelector('#estadisticas .estadisticas-card'); if(!card)return;
    let box=$id('contadorCoberturas320');
    if(!box){
      box=document.createElement('div');
      box.id='contadorCoberturas320';
      box.className='chart-card contador-coberturas320';
      const charts=card.querySelector('.charts-grid');
      if(charts) charts.insertAdjacentElement('beforebegin',box); else card.appendChild(box);
    }
    const pacientes=pacientesUnicosCobertura320();
    const counts={};
    pacientes.forEach(p=>{const k=coberturaPaciente320(p);counts[k]=(counts[k]||0)+1;});
    const entries=Object.entries(counts).sort((a,b)=>(a[0]==='Incompleto'?-1:b[0]==='Incompleto'?1:b[1]-a[1]));
    box.innerHTML=`<h3>Contador de coberturas de pacientes</h3>
      <p class="muted">Conteo de fichas de pacientes, independiente del rango de fechas de las estadísticas. Los datos vacíos figuran como <strong>Incompleto</strong>.</p>
      <div class="coverage-grid320">${entries.length?entries.map(([k,v])=>`<div class="coverage-pill320 ${k==='Incompleto'?'incomplete':''}"><span>${esc(k)}</span><strong>${v}</strong></div>`).join(''):'<p class="muted">Sin pacientes cargados.</p>'}</div>`;
  }
  const oldRenderEstadisticas320 = typeof renderEstadisticas==='function' ? renderEstadisticas : null;
  if(oldRenderEstadisticas320 && !oldRenderEstadisticas320.__v320){
    const wrapped=function(){oldRenderEstadisticas320.apply(this,arguments); renderContadorCoberturas320();};
    wrapped.__v320=true;
    window.renderEstadisticas = renderEstadisticas = wrapped;
  }

  function init320(){
    setVersion320();
    ensureTopSearch320();
    ensurePacienteGlobalModal320();
    ensureAgendaViewOptions320();
    renderAgendaCalendario320();
    renderContadorCoberturas320();
  }
  document.addEventListener('DOMContentLoaded',()=>setTimeout(init320,900));
  setTimeout(init320,1800);
})();


/* ===== v3.2.1 - ajustes datos familiares, agenda robusta y coberturas ===== */
(function(){
  function $id(id){return document.getElementById(id)}
  function esc(v){try{return escapeHtml(String(v??''));}catch(e){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}}
  function norm(v){try{return normalizarTexto(v)}catch(e){return String(v||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();}}
  function today(){try{return todayISO()}catch(e){return new Date().toISOString().slice(0,10)}}
  function fmt(d){try{return formatFecha(d)}catch(e){return d||''}}
  function isoDate(d){return d.toISOString().slice(0,10)}
  function parseISO(s){const m=String(s||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);return m?new Date(+m[1],+m[2]-1,+m[3]):new Date();}
  function lunes(d){const x=new Date(d.getFullYear(),d.getMonth(),d.getDate());const day=x.getDay();x.setDate(x.getDate()+(day===0?-6:1-day));return x;}
  function diaCorto(d){return ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'][d.getDay()];}
  function nombreMes(d){return d.toLocaleDateString('es-AR',{month:'long',year:'numeric'});}
  function hora(a){try{return horaAgenda295(a)}catch(e){return a?.horaInicio||'s/h'}}
  function estado(a){try{return estadoTurno(a)}catch(e){return a?.estadoTurno||a?.estado||'reservado'}}
  function atencionById(id){return (atenciones||[]).find(a=>String(a.id)===String(id));}
  function operativas(){try{return atencionesOperativas()}catch(e){return (atenciones||[]).filter(a=>a && a.id && a.tipoRegistro!=='mensaje' && !a.__config);} }
  function profFiltro(){let prof=$id('agendaProfesional')?.value||'';try{if(esMedico())prof=profesionalIdUsuarioActual(); if(esMatiasDuenio()&&!prof)prof='matias';}catch(e){} return prof;}
  function setVersion321(){try{document.title='CardioLink Admin v4.1.0-hc'}catch(e){};document.querySelectorAll('.brand-main span').forEach(el=>el.textContent='v4.1.0-hc');const pt=document.querySelector('.print-title h2');if(pt)pt.textContent='CardioLink Admin v4.1.0-hc';}

  // No fusionar pacientes por teléfono/email: esos datos pueden pertenecer a familiar responsable.
  window.pacienteExistenteSinTelefonoMail321=function(p){
    if(!Array.isArray(data.pacientes)) data.pacientes=[];
    const dni=String(p?.dni||'').replace(/\D/g,'');
    if(dni){const x=data.pacientes.find(q=>String(q.dni||'').replace(/\D/g,'')===dni); if(x)return x;}
    const nom=norm(p?.nombreCompleto||p?.paciente||'');
    const fn=p?.fechaNacimiento||'';
    if(nom && fn){const x=data.pacientes.find(q=>norm(q.nombreCompleto||q.paciente||'')===nom && (q.fechaNacimiento||'')===fn); if(x)return x;}
    return null;
  };

  // Limpia visualmente coberturas que en importaciones anteriores quedaron como médico de Medicloud.
  function esNombreProfesionalComoCobertura(v){
    const n=norm(v);
    if(!n)return false;
    if(n==='matias anchorena' || n==='dr matias anchorena')return true;
    if(n.includes('rogelio anchorena'))return true;
    if(n.includes('fernandez drago') || n.includes('lucas drago') || n.includes('humberto drago'))return true;
    if((data?.profesionales||[]).some(p=>norm(p.nombre)===n))return true;
    return false;
  }
  window.coberturaPacienteNormalizada321=function(p){
    const v=String(p?.coberturaHabitual || p?.obraSocial || p?.cobertura || '').trim();
    if(!v || /^(no ingresado|sin dato|s\/d|undefined|null)$/i.test(v) || esNombreProfesionalComoCobertura(v)) return 'Incompleto';
    return v;
  };

  // Buscador global más prolijo y clickeable.
  function ajustarBuscador321(){
    const box=$id('globalPatientSearchBox'); if(!box)return;
    const label=box.querySelector('label'); if(label)label.textContent='Buscar paciente';
    const inp=$id('globalPatientSearch'); if(inp)inp.placeholder='DNI, apellido, teléfono o email';
  }

  function datosAgendaDia(){
    const fecha=$id('agendaFecha')?.value||today(); const prof=profFiltro(); const est=$id('agendaEstado')?.value||'';
    return operativas().filter(a=>{
      if((a.fecha||'')!==fecha)return false;
      if(prof && String(a.profesionalId||'')!==String(prof))return false;
      if(est && estado(a)!==est)return false;
      return true;
    }).sort((a,b)=>String(a.horaInicio||'99:99').localeCompare(String(b.horaInicio||'99:99')) || String(a.paciente||'').localeCompare(String(b.paciente||''),'es'));
  }
  function datosAgendaRango(desde,hasta){
    const prof=profFiltro(); const est=$id('agendaEstado')?.value||'';
    return operativas().filter(a=>{
      const f=a.fecha||''; if(f<desde||f>hasta)return false;
      if(prof && String(a.profesionalId||'')!==String(prof))return false;
      if(est && estado(a)!==est)return false;
      return true;
    }).sort((a,b)=>(a.fecha||'').localeCompare(b.fecha||'') || String(a.horaInicio||'99:99').localeCompare(String(b.horaInicio||'99:99')) || String(a.paciente||'').localeCompare(String(b.paciente||''),'es'));
  }
  function mini(a){
    return `<button type="button" class="cal-turno320 estado-${esc(estado(a))}" data-action="agenda-ver" data-id="${esc(a.id)}"><strong>${esc(hora(a))}</strong> ${esc(a.paciente||'')}<small>${esc(a.prestacion||'')} · ${esc(a.obraSocial||a.coberturaAtencion||'')}</small></button>`;
  }
  function renderTablaAgenda321(){
    const tabla=$id('agendaTabla'), cards=$id('agendaTarjetas'), wrap=$id('agendaTablaWrap'), cal=$id('agendaCalendario320');
    const datos=datosAgendaDia();
    if($id('agendaResumen'))$id('agendaResumen').textContent=datos.length?`${datos.length} turno(s) para la fecha seleccionada.`:'No hay turnos para la fecha seleccionada.';
    if(cal)cal.classList.add('hidden');
    if(wrap){wrap.classList.remove('hidden');wrap.style.display='block';}
    if(cards){cards.classList.add('hidden');cards.style.display='none';}
    if(!tabla)return;
    tabla.innerHTML=datos.length?datos.map(a=>`<tr data-id="${esc(a.id)}"><td>${esc(hora(a))}</td><td><strong>${esc(a.paciente||'')}</strong></td><td>${esc(a.profesional||'')}</td><td>${esc(a.prestacion||'')}</td><td>${esc(a.obraSocial||a.coberturaAtencion||'')}</td><td>${typeof estadoAgendaBadge==='function'?estadoAgendaBadge(a):esc(estado(a))}</td><td class="agenda-actions"><button type="button" data-action="agenda-ver" data-id="${esc(a.id)}">Ver</button><button type="button" data-action="agenda-estado" data-estado="sala_espera" data-id="${esc(a.id)}">Sala</button><button type="button" data-action="agenda-estado" data-estado="en_consulta" data-id="${esc(a.id)}">Atender</button><button type="button" data-action="agenda-estado" data-estado="atendido" data-id="${esc(a.id)}">Atendido</button></td></tr>`).join(''):'<tr><td colspan="7">No hay turnos para mostrar.</td></tr>';
  }
  function renderTarjetasAgenda321(){
    const cards=$id('agendaTarjetas'), wrap=$id('agendaTablaWrap'), cal=$id('agendaCalendario320'); const datos=datosAgendaDia();
    if($id('agendaResumen'))$id('agendaResumen').textContent=datos.length?`${datos.length} turno(s) para la fecha seleccionada.`:'No hay turnos para la fecha seleccionada.';
    if(cal)cal.classList.add('hidden'); if(wrap){wrap.classList.add('hidden');wrap.style.display='none';}
    if(cards){cards.classList.remove('hidden');cards.style.display='grid';cards.innerHTML=datos.map(a=>`<div class="agenda-turno-card" data-id="${esc(a.id)}"><div class="agenda-card-top"><strong>${esc(hora(a))}</strong>${typeof estadoAgendaBadge==='function'?estadoAgendaBadge(a):''}</div><div><strong>${esc(a.paciente||'')}</strong></div><div>${esc(a.profesional||'')} · ${esc(a.prestacion||'')} · ${esc(a.obraSocial||a.coberturaAtencion||'')}</div><div class="agenda-actions"><button type="button" data-action="agenda-ver" data-id="${esc(a.id)}">Ver ficha</button><button type="button" data-action="agenda-estado" data-estado="sala_espera" data-id="${esc(a.id)}">Sala</button><button type="button" data-action="agenda-estado" data-estado="en_consulta" data-id="${esc(a.id)}">Atender</button><button type="button" data-action="agenda-estado" data-estado="atendido" data-id="${esc(a.id)}">Atendido</button></div></div>`).join('');}
  }
  function renderSemanaAgenda321(){
    const cal=$id('agendaCalendario320')||document.createElement('div'); if(!cal.id){cal.id='agendaCalendario320';cal.className='agenda-calendar320';$id('agendaTarjetas')?.insertAdjacentElement('afterend',cal);} const wrap=$id('agendaTablaWrap'), cards=$id('agendaTarjetas');
    if(wrap){wrap.classList.add('hidden');wrap.style.display='none';} if(cards){cards.classList.add('hidden');cards.style.display='none';} cal.classList.remove('hidden');
    const base=parseISO($id('agendaFecha')?.value||today()); const start=lunes(base); const days=Array.from({length:7},(_,i)=>{const d=new Date(start);d.setDate(start.getDate()+i);return d;});
    const desde=isoDate(days[0]), hasta=isoDate(days[6]); const datos=datosAgendaRango(desde,hasta);
    if($id('agendaResumen'))$id('agendaResumen').textContent=`Semana calendario: ${datos.length} turno(s) entre ${desde} y ${hasta}.`;
    cal.innerHTML=`<div class="cal-head320"><strong>Semana del ${fmt(desde)} al ${fmt(hasta)}</strong><span>${datos.length} turno(s)</span></div><div class="week-grid320">${days.map(d=>{const iso=isoDate(d);const arr=datos.filter(a=>a.fecha===iso);return `<div class="day-col320"><h3>${diaCorto(d)} <span>${d.getDate()}/${d.getMonth()+1}</span></h3>${arr.length?arr.map(mini).join(''):'<p class="muted empty-day320">Sin turnos</p>'}</div>`}).join('')}</div>`;
  }
  function renderMesAgenda321(){
    const cal=$id('agendaCalendario320')||document.createElement('div'); if(!cal.id){cal.id='agendaCalendario320';cal.className='agenda-calendar320';$id('agendaTarjetas')?.insertAdjacentElement('afterend',cal);} const wrap=$id('agendaTablaWrap'), cards=$id('agendaTarjetas');
    if(wrap){wrap.classList.add('hidden');wrap.style.display='none';} if(cards){cards.classList.add('hidden');cards.style.display='none';} cal.classList.remove('hidden');
    const base=parseISO($id('agendaFecha')?.value||today()); const first=new Date(base.getFullYear(),base.getMonth(),1); const start=lunes(first); const days=Array.from({length:42},(_,i)=>{const d=new Date(start);d.setDate(start.getDate()+i);return d;});
    const datos=datosAgendaRango(isoDate(days[0]),isoDate(days[41])); const mesCount=datos.filter(a=>{const d=parseISO(a.fecha||'');return d.getMonth()===base.getMonth()&&d.getFullYear()===base.getFullYear();}).length;
    if($id('agendaResumen'))$id('agendaResumen').textContent=`Mes calendario: ${nombreMes(base)}.`;
    cal.innerHTML=`<div class="cal-head320"><strong>${nombreMes(base)}</strong><span>${mesCount} turno(s) del mes</span></div><div class="month-grid320">${days.map(d=>{const iso=isoDate(d);const arr=datos.filter(a=>a.fecha===iso);const other=d.getMonth()!==base.getMonth()?' other-month320':'';return `<div class="month-cell320${other}"><h3>${diaCorto(d)} ${d.getDate()}</h3>${arr.slice(0,5).map(mini).join('')}${arr.length>5?`<small class="muted">+${arr.length-5} más</small>`:arr.length?'':'<p class="muted empty-day320">—</p>'}</div>`}).join('')}</div>`;
  }
  window.renderAgenda = renderAgenda = function(){
    try{agendaTextoPerfil&&agendaTextoPerfil();}catch(e){}
    const sel=$id('agendaVista'); if(sel && !Array.from(sel.options).some(o=>o.value==='semana')) sel.insertAdjacentHTML('beforeend','<option value="semana">Semana calendario</option><option value="mes">Mes calendario</option>');
    const vista=sel?.value||'tabla';
    if(vista==='semana')return renderSemanaAgenda321();
    if(vista==='mes')return renderMesAgenda321();
    if(vista==='tarjetas')return renderTarjetasAgenda321();
    return renderTablaAgenda321();
  };
  window.abrirAgendaModal = abrirAgendaModal = function(id){
    const a=atencionById(id);
    const m=$id('agendaModal'), title=$id('agendaModalTitulo'), body=$id('agendaModalBody');
    if(!a||!m||!body){alert('No encontré la atención seleccionada. Actualizá y probá de nuevo.');return;}
    if(title)title.textContent=a.paciente||'Turno';
    body.innerHTML=`<div class="agenda-modal-grid"><div><label>Horario</label><strong>${esc(hora(a))}</strong></div><div><label>Fecha</label><strong>${fmt(a.fecha)}</strong></div><div><label>Paciente</label><strong>${esc(a.paciente||'')}</strong></div><div><label>Profesional</label><strong>${esc(a.profesional||'')}</strong></div><div><label>Prestación</label><strong>${esc(a.prestacion||'')}</strong></div><div><label>Cobertura</label><strong>${esc(a.obraSocial||a.coberturaAtencion||'')}</strong></div><div><label>Teléfono</label><strong>${esc(a.telefono||'s/d')}</strong></div><div><label>Email</label><strong>${esc(a.email||'s/d')}</strong></div></div><h3>Estado del turno</h3><div class="agenda-state-grid">${Object.entries(ESTADOS_AGENDA||{}).map(([k,e])=>`<button type="button" class="agenda-state-btn ${e.cls||''} ${estado(a)===k?'active':''}" data-action="agenda-estado-modal" data-id="${esc(a.id)}" data-estado="${k}"><i></i>${e.short||k}</button>`).join('')}</div><div class="agenda-actions modal-actions"><button type="button" data-action="listado-editar" data-id="${esc(a.id)}">Editar atención</button></div>`;
    m.classList.remove('hidden');
  };

  // Reemplaza el contador de coberturas para que el médico Medicloud no cuente como cobertura.
  window.renderContadorCoberturas321=function(){
    const card=document.querySelector('#estadisticas .estadisticas-card'); if(!card)return;
    let box=$id('contadorCoberturas320'); if(!box){box=document.createElement('div');box.id='contadorCoberturas320';box.className='chart-card contador-coberturas320';const charts=card.querySelector('.charts-grid'); if(charts)charts.insertAdjacentElement('beforebegin',box); else card.appendChild(box);}
    const base=(typeof todosPacientes==='function'?todosPacientes():(data?.pacientes||[])).filter(p=>p&&p.estado!=='fusionado');
    const map=new Map(); base.forEach(p=>{const k=String(p.dni||'').replace(/\D/g,'') || norm(p.nombreCompleto||p.paciente||''); if(k&&!map.has(k))map.set(k,p);});
    const counts={}; Array.from(map.values()).forEach(p=>{const c=window.coberturaPacienteNormalizada321(p);counts[c]=(counts[c]||0)+1;});
    const entries=Object.entries(counts).sort((a,b)=>(a[0]==='Incompleto'?-1:b[0]==='Incompleto'?1:b[1]-a[1]));
    box.innerHTML=`<h3>Contador de coberturas de pacientes</h3><p class="muted">Conteo de fichas de pacientes. Si la cobertura está vacía o quedó cargado el médico de Medicloud, figura como <strong>Incompleto</strong>.</p><div class="coverage-grid320">${entries.length?entries.map(([k,v])=>`<div class="coverage-pill320 ${k==='Incompleto'?'incomplete':''}"><span>${esc(k)}</span><strong>${v}</strong></div>`).join(''):'<p class="muted">Sin pacientes cargados.</p>'}</div>`;
  };
  const oldEst321=typeof renderEstadisticas==='function'?renderEstadisticas:null;
  if(oldEst321){window.renderEstadisticas=renderEstadisticas=function(){oldEst321.apply(this,arguments);window.renderContadorCoberturas321();};}

  function init321(){setVersion321();ajustarBuscador321();try{renderAgenda();}catch(e){};try{window.renderContadorCoberturas321();}catch(e){}}
  document.addEventListener('DOMContentLoaded',()=>setTimeout(init321,600));
  setTimeout(init321,1200);
})();


/* ===== v3.3.0 - ficha administrativa extendida ===== */
(function(){
  try{
    if(window.data && Array.isArray(data.pacientes)){
      data.pacientes.forEach(p=>{
        p.contactoResponsableNombre=p.contactoResponsableNombre||'';
        p.contactoResponsableRelacion=p.contactoResponsableRelacion||'';
        p.contactoResponsableTelefono=p.contactoResponsableTelefono||'';
        p.contactoResponsableEmail=p.contactoResponsableEmail||'';
      });
    }
  }catch(e){console.warn('v3.3 init pacientes extendidos',e)}
})();


/* ===== v3.5.0 - ficha editable global, limpieza coberturas, pendientes masivos y WS ===== */
(function(){
  function $id(id){return document.getElementById(id)}
  function esc(v){try{return escapeHtml(String(v??''));}catch(e){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}}
  function norm(v){try{return normalizarTexto(v)}catch(e){return String(v||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();}}
  function dniClean(v){try{return dniLimpio(v)}catch(e){return String(v||'').replace(/\D/g,'')}}
  function fechaHoy(){try{return todayISO()}catch(e){return new Date().toISOString().slice(0,10)}}
  function version350(){
    try{document.title='CardioLink Admin v4.1.0-hc'}catch(e){}
    document.querySelectorAll('.brand-main span').forEach(el=>el.textContent='v4.1.0-hc');
    const pt=document.querySelector('.print-title h2'); if(pt)pt.textContent='CardioLink Admin v4.1.0-hc';
  }
  function pacientesBase(){return Array.isArray(data?.pacientes)?data.pacientes:[];}
  function pacienteClave(p){try{return clavePacientePanel(p)}catch(e){return p?.id||dniClean(p?.dni)||norm(p?.nombreCompleto||p?.paciente)}}
  function nombrePac(p){try{return nombrePacientePanel(p)}catch(e){return p?.nombreCompleto||p?.paciente||'Paciente'}}
  function atencionesPac(p){try{return atencionesPacienteGlobal(p)}catch(e){return []}}
  function pacientePorClave350(k){
    try{const p=buscarPacientePanelPorId(k); if(p)return p;}catch(e){}
    return pacientesBase().find(p=>p.id===k || dniClean(p.dni)===dniClean(k) || norm(p.nombreCompleto||p.paciente)===norm(k)) || null;
  }
  function esCoberturaProfesional350(v){
    const n=norm(v); if(!n)return false;
    const nombres=['matias anchorena','dr matias anchorena','rogelio anchorena','dr rogelio anchorena','fernandez drago humberto','dr fernandez drago humberto','lucas drago','dr lucas drago','humberto drago'];
    if(nombres.includes(n))return true;
    if((data?.profesionales||[]).some(p=>norm(p.nombre)===n))return true;
    if(n.includes('anchorena') || n.includes('fernandez drago'))return true;
    return false;
  }
  function coberturaVisible350(p){
    const v=String(p?.coberturaHabitual || p?.obraSocial || p?.cobertura || '').trim();
    if(!v || /^(no ingresado|sin dato|s\/d|undefined|null)$/i.test(v) || esCoberturaProfesional350(v)) return 'Incompleto';
    return v;
  }
  window.coberturaVisible350=coberturaVisible350;
  window.coberturaPacienteNormalizada321=function(p){return coberturaVisible350(p)};
  function limpiarCoberturasMedicloud350(silencioso=false){
    let n=0;
    pacientesBase().forEach(p=>{
      const v=String(p.coberturaHabitual||p.obraSocial||p.cobertura||'').trim();
      if(esCoberturaProfesional350(v)){
        const nota=`${fechaHoy()}: se limpió cobertura importada como médico (${v}).`;
        p.observacionesAdministrativas = [p.observacionesAdministrativas||'', nota].filter(Boolean).join('\n');
        p.coberturaHabitual='';
        if(p.obraSocial===v)p.obraSocial='';
        if(p.cobertura===v)p.cobertura='';
        p.actualizadoEn=new Date().toISOString();
        n++;
      }
    });
    if(n){
      try{saveConfig();}catch(e){}
      try{renderPacientesPanel?.('',true);}catch(e){}
      try{renderEstadisticas?.();}catch(e){}
      try{renderStats?.();}catch(e){}
    }
    if(!silencioso) alert(n?`Se limpiaron ${n} cobertura(s) mal importadas como nombre de médico. Ahora figuran como Incompleto.`:'No encontré coberturas mal importadas como médicos.');
    return n;
  }
  window.limpiarCoberturasMedicloud350=limpiarCoberturasMedicloud350;

  // Agrega botón manual de reparación en Configuración.
  function asegurarBotonRepararCoberturas350(){
    if($id('btnRepararCoberturasMedicloud350'))return;
    const backupTitle=Array.from(document.querySelectorAll('#config h3')).find(h=>/backup/i.test(h.textContent||''));
    const cont=backupTitle?.parentElement || document.querySelector('#config .config-grid') || document.querySelector('#config .card');
    if(!cont)return;
    const btn=document.createElement('button');
    btn.id='btnRepararCoberturasMedicloud350';
    btn.type='button';
    btn.className='secondary';
    btn.textContent='Reparar coberturas Medicloud';
    btn.addEventListener('click',()=>limpiarCoberturasMedicloud350(false));
    cont.appendChild(btn);
  }

  function osOptions350(actual=''){
    const arr=['',...(data?.obrasSociales||[])];
    if(actual && !arr.some(x=>norm(x)===norm(actual)) && !esCoberturaProfesional350(actual)) arr.push(actual);
    return arr.map(os=>`<option value="${esc(os)}" ${String(os)===String(actual)?'selected':''}>${os?esc(os):'Sin cobertura cargada'}</option>`).join('');
  }
  function relacionOptions350(actual=''){
    const arr=['','Madre','Padre','Hijo/a','Esposo/a','Familiar','Cuidador/a','Otro'];
    if(actual && !arr.includes(actual))arr.push(actual);
    return arr.map(x=>`<option value="${esc(x)}" ${x===actual?'selected':''}>${x?esc(x):'Sin especificar'}</option>`).join('');
  }
  function abrirPacienteGlobalDetalle350(k){
    const p=pacientePorClave350(k); if(!p){alert('No encontré el paciente.');return;}
    try{window.CardioLinkPacienteActual411B?.set?.(pacienteClave(p));}catch(e){}
    if(typeof ensurePacienteGlobalModal320==='function') try{ensurePacienteGlobalModal320()}catch(e){}
    let modal=$id('pacienteGlobalModal');
    if(!modal){
      document.body.insertAdjacentHTML('beforeend',`<div id="pacienteGlobalModal" class="modal-backdrop hidden"><div class="modal global-paciente-modal"><div class="modal-header"><h2 id="pacienteGlobalTitulo">Ficha paciente</h2><button class="secondary" type="button" onclick="cerrarPacienteGlobal350()">Cerrar</button></div><div id="pacienteGlobalBody"></div></div></div>`);
      modal=$id('pacienteGlobalModal');
    }
    const ats=atencionesPac(p); const ult=ats[0];
    const title=$id('pacienteGlobalTitulo'); if(title)title.textContent=nombrePac(p);
    const body=$id('pacienteGlobalBody'); if(!body)return;
    body.innerHTML=`
      <div class="paciente-global-actions-top"><button class="primary" type="button" onclick="nuevaAtencionDesdePaciente('${esc(pacienteClave(p))}')">Nueva atención</button><button class="secondary" type="button" onclick="editarPacienteGlobal350('${esc(pacienteClave(p))}')">Editar ficha</button></div>
      <div class="paciente-ficha-grid global-paciente-grid">
        <div><span>DNI</span><strong>${esc(p.dni||'s/d')}</strong></div>
        <div><span>Teléfono</span><strong>${esc(p.telefono||'s/d')}</strong></div>
        <div><span>Email</span><strong>${esc(p.email||'s/d')}</strong></div>
        <div><span>Cobertura habitual</span><strong>${esc(coberturaVisible350(p))}</strong></div>
        <div><span>Nº afiliado habitual</span><strong>${esc(p.numeroAfiliadoHabitual||p.numeroAfiliado||'s/d')}</strong></div>
        <div><span>Contacto responsable</span><strong>${esc(p.contactoResponsableNombre||'s/d')}${p.contactoResponsableRelacion?' · '+esc(p.contactoResponsableRelacion):''}</strong></div>
        <div><span>Teléfono contacto</span><strong>${esc(p.contactoResponsableTelefono||'s/d')}</strong></div>
        <div><span>Email contacto</span><strong>${esc(p.contactoResponsableEmail||'s/d')}</strong></div>
        <div><span>Fecha nacimiento</span><strong>${esc(p.fechaNacimiento?(typeof formatFecha==='function'?formatFecha(p.fechaNacimiento):p.fechaNacimiento):'s/d')}</strong></div>
        <div><span>Total atenciones</span><strong>${ats.length}</strong></div>
        <div><span>Última atención</span><strong>${ult?esc((typeof formatFecha==='function'?formatFecha(ult.fecha):ult.fecha)+' · '+(ult.prestacion||'')):'s/d'}</strong></div>
      </div>
      <div class="copy-row300 global-copy-row">
        <button type="button" class="copy-btn300" onclick="copyText300('${esc(p.dni||'')}','DNI')">Copiar DNI</button>
        <button type="button" class="copy-btn300" onclick="copyText300('${esc(p.telefono||'')}','teléfono')">Copiar teléfono</button>
        <button type="button" class="copy-btn300" onclick="copyText300('${esc(p.email||'')}','email')">Copiar email</button>
        <button type="button" class="copy-btn300" onclick="copyText300('${esc(p.contactoResponsableTelefono||'')}','teléfono contacto')">Copiar tel. contacto</button>
        <button type="button" class="copy-btn300" onclick="copyText300('${esc(p.contactoResponsableEmail||'')}','email contacto')">Copiar mail contacto</button>
      </div>
      <h3>Últimas atenciones</h3>
      <div class="paciente-historial-wrap"><table class="tabla-mini paciente-historial"><thead><tr><th>Fecha</th><th>Profesional</th><th>Prestación</th><th>OS</th><th></th></tr></thead><tbody>${ats.length?ats.slice(0,12).map(a=>`<tr><td>${typeof formatFecha==='function'?formatFecha(a.fecha):esc(a.fecha)}</td><td>${esc(a.profesional||'')}</td><td><strong>${esc((typeof prestacionListado==='function')?prestacionListado(a):a.prestacion)}</strong></td><td>${esc(a.obraSocial||'')}</td><td><button class="secondary" type="button" onclick="cerrarPacienteGlobal350();editarAtencion(${idJS(a.id)})">Editar</button></td></tr>`).join(''):'<tr><td colspan="5">Sin atenciones registradas.</td></tr>'}</tbody></table></div>`;
    modal.classList.remove('hidden');
  }
  function editarPacienteGlobal350(k){
    const p=pacientePorClave350(k); if(!p)return;
    const body=$id('pacienteGlobalBody'); if(!body)return;
    const coberturaActual=esCoberturaProfesional350(p.coberturaHabitual)?'':(p.coberturaHabitual||'');
    body.innerHTML=`
      <div class="paciente-edit-global350">
        <div class="form-grid paciente-edit-form">
          <div class="full-span"><label>Apellido y nombre</label><input id="gPacNombre" value="${esc(nombrePac(p))}"></div>
          <div><label>DNI</label><input id="gPacDni" value="${esc(p.dni||'')}"></div>
          <div><label>Fecha nacimiento</label><input type="date" id="gPacNacimiento" value="${esc(p.fechaNacimiento||'')}"></div>
          <div><label>Sexo</label><select id="gPacSexo"><option value="">No definido</option><option value="Masculino" ${p.sexo==='Masculino'?'selected':''}>Masculino</option><option value="Femenino" ${p.sexo==='Femenino'?'selected':''}>Femenino</option></select></div>
          <div><label>Localidad</label><input id="gPacLocalidad" value="${esc(p.localidad||'')}"></div>
          <div><label>Dirección</label><input id="gPacDireccion" value="${esc(p.direccion||'')}"></div>
          <div><label>Provincia</label><input id="gPacProvincia" value="${esc(p.provincia||'Buenos Aires')}"></div>
          <div><label>Teléfono paciente</label><input id="gPacTelefono" value="${esc(p.telefono||'')}"></div>
          <div><label>Email paciente</label><input id="gPacEmail" value="${esc(p.email||'')}"></div>
          <div><label>Cobertura habitual</label><select id="gPacCobertura">${osOptions350(coberturaActual)}</select></div>
          <div><label>Nº afiliado habitual</label><input id="gPacAfiliado" value="${esc(p.numeroAfiliadoHabitual||'')}"></div>
          <div class="form-subtitle full-span">Contacto responsable / familiar a cargo</div>
          <div><label>Nombre contacto</label><input id="gPacContactoNombre" value="${esc(p.contactoResponsableNombre||'')}"></div>
          <div><label>Relación</label><select id="gPacContactoRelacion">${relacionOptions350(p.contactoResponsableRelacion||'')}</select></div>
          <div><label>Teléfono contacto</label><input id="gPacContactoTelefono" value="${esc(p.contactoResponsableTelefono||'')}"></div>
          <div><label>Email contacto</label><input id="gPacContactoEmail" value="${esc(p.contactoResponsableEmail||'')}"></div>
          <div class="full-span"><label>Observaciones administrativas</label><textarea id="gPacObs" rows="3">${esc(p.observacionesAdministrativas||'')}</textarea></div>
        </div>
        <div class="modal-actions"><button class="secondary" type="button" onclick="abrirPacienteGlobalDetalle350('${esc(k)}')">Cancelar</button><button class="primary" type="button" onclick="guardarPacienteGlobal350('${esc(k)}')">Guardar ficha</button></div>
      </div>`;
  }
  function guardarPacienteGlobal350(k){
    const original=pacientePorClave350(k); if(!original)return;
    if(!Array.isArray(data.pacientes))data.pacientes=[];
    let p=null; const dni=dniClean($id('gPacDni')?.value||original.dni||'');
    if(original.id && !String(original.id).startsWith('legacy_'))p=data.pacientes.find(x=>x.id===original.id);
    if(!p && dni)p=data.pacientes.find(x=>dniClean(x.dni)===dni);
    if(!p){p={id:'pac_'+Date.now()+Math.floor(Math.random()*10000),historialCoberturas:[]};data.pacientes.push(p);}
    p.nombreCompleto=($id('gPacNombre')?.value||'').trim();
    p.dni=($id('gPacDni')?.value||'').trim();
    p.fechaNacimiento=$id('gPacNacimiento')?.value||'';
    p.sexo=$id('gPacSexo')?.value||'';
    p.localidad=($id('gPacLocalidad')?.value||'').trim();
    p.direccion=($id('gPacDireccion')?.value||'').trim();
    p.provincia=($id('gPacProvincia')?.value||'Buenos Aires').trim()||'Buenos Aires';
    p.telefono=($id('gPacTelefono')?.value||'').trim();
    p.email=($id('gPacEmail')?.value||'').trim();
    p.coberturaHabitual=$id('gPacCobertura')?.value||'';
    p.numeroAfiliadoHabitual=($id('gPacAfiliado')?.value||'').trim();
    p.contactoResponsableNombre=($id('gPacContactoNombre')?.value||'').trim();
    p.contactoResponsableRelacion=$id('gPacContactoRelacion')?.value||'';
    p.contactoResponsableTelefono=($id('gPacContactoTelefono')?.value||'').trim();
    p.contactoResponsableEmail=($id('gPacContactoEmail')?.value||'').trim();
    p.observacionesAdministrativas=($id('gPacObs')?.value||'').trim();
    p.actualizadoEn=new Date().toISOString();
    const ats=atencionesPac(original);
    ats.forEach(a=>{a.pacienteId=p.id; a.paciente=p.nombreCompleto; a.dni=p.dni; a.telefono=p.telefono; a.email=p.email; a.fechaNacimiento=p.fechaNacimiento;});
    try{saveConfig();saveAtenciones();}catch(e){}
    try{renderPacientesPanel?.('',true);renderTabla?.();renderAgenda?.();renderEstadisticas?.();renderStats?.();}catch(e){}
    abrirPacienteGlobalDetalle350(pacienteClave(p));
    try{copyText300('Ficha guardada','') }catch(e){ alert('Ficha guardada'); }
  }
  window.abrirPacienteGlobalDetalle350=abrirPacienteGlobalDetalle350;
  window.editarPacienteGlobal350=editarPacienteGlobal350;
  window.guardarPacienteGlobal350=guardarPacienteGlobal350;
  window.cerrarPacienteGlobal350=function(){ $id('pacienteGlobalModal')?.classList.add('hidden'); };

  // Reemplaza apertura del buscador global por versión editable.
  window.abrirPacienteGlobal320=function(k){abrirPacienteGlobalDetalle350(k)};

  // Mejora edición desde solapa Pacientes: select con opción vacía y limpieza de médico como cobertura.
  const oldEditarPac350=typeof editarPacientePanel==='function'?editarPacientePanel:null;
  if(oldEditarPac350 && !oldEditarPac350.__v350){
    const wrapped=function(id){
      oldEditarPac350.apply(this,arguments);
      setTimeout(()=>{
        const sel=$id('pacEditCobertura'); if(sel){
          const p=pacientePorClave350(id); const actual=esCoberturaProfesional350(p?.coberturaHabitual)?'':(p?.coberturaHabitual||sel.value||'');
          sel.innerHTML=osOptions350(actual); sel.value=actual;
        }
      },30);
    };
    wrapped.__v350=true; window.editarPacientePanel=editarPacientePanel=wrapped;
  }

  // Contador de coberturas corregido: Incompleto arriba y médico no cuenta como OS.
  window.renderContadorCoberturas350=function(){
    const card=document.querySelector('#estadisticas .estadisticas-card'); if(!card)return;
    let box=$id('contadorCoberturas320'); if(!box){box=document.createElement('div');box.id='contadorCoberturas320';box.className='chart-card contador-coberturas320';const charts=card.querySelector('.charts-grid'); if(charts)charts.insertAdjacentElement('beforebegin',box); else card.appendChild(box);}
    const map=new Map();
    (typeof todosPacientes==='function'?todosPacientes():pacientesBase()).filter(p=>p&&p.estado!=='fusionado').forEach(p=>{const key=dniClean(p.dni)||norm(nombrePac(p)); if(key && !map.has(key))map.set(key,p);});
    const counts={}; Array.from(map.values()).forEach(p=>{const c=coberturaVisible350(p); counts[c]=(counts[c]||0)+1;});
    const entries=Object.entries(counts).sort((a,b)=>(a[0]==='Incompleto'?-1:b[0]==='Incompleto'?1:b[1]-a[1]));
    box.innerHTML=`<h3>Contador de coberturas de pacientes</h3><p class="muted">Conteo de fichas administrativas. Cobertura vacía o importada como médico aparece como <strong>Incompleto</strong>.</p><div class="coverage-grid320">${entries.length?entries.map(([k,v])=>`<button type="button" class="coverage-pill320 ${k==='Incompleto'?'incomplete':''}" onclick="showSection('pacientes');document.getElementById('pacientesBuscar').value='${k==='Incompleto'?'':esc(k)}';renderPacientesPanel(document.getElementById('pacientesBuscar').value,true)"><span>${esc(k)}</span><strong>${v}</strong></button>`).join(''):'<p class="muted">Sin pacientes cargados.</p>'}</div><div class="mini-actions350"><button class="secondary" type="button" onclick="limpiarCoberturasMedicloud350(false)">Reparar coberturas Medicloud</button></div>`;
  };
  const oldRenderEst350=typeof renderEstadisticas==='function'?renderEstadisticas:null;
  if(oldRenderEst350 && !oldRenderEst350.__v350){
    const wrapped=function(){oldRenderEst350.apply(this,arguments);window.renderContadorCoberturas350();};
    wrapped.__v350=true; window.renderEstadisticas=renderEstadisticas=wrapped;
  }

  // Pendientes 3.5: botón para resolver todos los visibles según filtros.
  function resolverPendiente(a){
    if((a.bonoConsulta||a.bonoEstudio)) a.bonoFirmado=true;
    if(a.bonoEstudio||a.requiereCopiaImpresa) a.copiaImpresa=true;
    if(typeof esRegistroDeEstudio==='function' ? esRegistroDeEstudio(a) : !/consulta/i.test(a.prestacion||'')){
      a.estudioInformado=true; a.estudioImpreso=true;
    }
    a.pendienteEnvio=false;
    a.pendienteEntrega=false;
    a.estudioEnviadoWS=a.estudioEnviadoWS||false;
    a.actualizadoEn=new Date().toISOString();
  }
  function marcarPendientesVisiblesResueltos350(){
    let lista=[]; try{lista=filtrar().filter(a=>typeof esPendienteAdministrativo==='function'?esPendienteAdministrativo(a):true);}catch(e){lista=[];}
    if(!lista.length){alert('No hay pendientes visibles para marcar.');return;}
    if(!confirm(`Vas a marcar como resueltos ${lista.length} registro(s) visibles según el filtro actual. ¿Continuar?`))return;
    lista.forEach(resolverPendiente);
    try{saveAtenciones();renderTabla();renderStats();renderAgenda();}catch(e){}
    alert(`Listo. Se marcaron ${lista.length} pendiente(s) como resueltos.`);
  }
  window.marcarPendientesVisiblesResueltos350=marcarPendientesVisiblesResueltos350;
  function asegurarBotonPendientes350(){
    if($id('btnPendientesResueltosVisibles350'))return;
    const sel=$id('fPendienteDetalle'); if(!sel)return;
    const btn=document.createElement('button'); btn.id='btnPendientesResueltosVisibles350'; btn.type='button'; btn.className='secondary'; btn.textContent='Resolver pendientes visibles';
    btn.addEventListener('click',marcarPendientesVisiblesResueltos350);
    sel.insertAdjacentElement('afterend',btn);
  }

  // Plantillas WS 3.4: copiar desde el modal de agenda, sin reemplazar WhatsApp rápido del consultorio.
  function textoWsTurno350(a,tipo='turno'){
    const nom=a?.paciente||'paciente'; const fecha=a?.fecha?(typeof formatFecha==='function'?formatFecha(a.fecha):a.fecha):''; const hora=a?.horaInicio||''; const prest=a?.prestacion||'turno';
    if(tipo==='holter')return `Hola ${nom}. Le recordamos su turno para Holter el ${fecha}${hora?' a las '+hora+' hs':''}. Traer DNI, orden/bono o autorización si corresponde. El equipo se retira según indicación del consultorio.`;
    if(tipo==='mapa')return `Hola ${nom}. Le recordamos su turno para MAPA el ${fecha}${hora?' a las '+hora+' hs':''}. Traer DNI, orden/bono o autorización si corresponde. Venir con ropa cómoda para la colocación del equipo.`;
    if(tipo==='eco')return `Hola ${nom}. Le recordamos su turno para ${prest} el ${fecha}${hora?' a las '+hora+' hs':''}. Traer DNI, estudios previos si tiene y orden/bono o autorización si corresponde.`;
    return `Hola ${nom}. Le recordamos su turno para ${prest} el ${fecha}${hora?' a las '+hora+' hs':''}. Traer DNI y orden/bono o autorización si corresponde.`;
  }
  window.copiarWsTurno350=function(id,tipo){const a=(atenciones||[]).find(x=>String(x.id)===String(id)); if(!a){alert('No encontré el turno.');return;} try{copyText300(textoWsTurno350(a,tipo),'mensaje WhatsApp')}catch(e){navigator.clipboard?.writeText(textoWsTurno350(a,tipo));alert('Mensaje copiado');}};
  const oldAgendaModal350=typeof abrirAgendaModal==='function'?abrirAgendaModal:null;
  if(oldAgendaModal350 && !oldAgendaModal350.__v350){
    const wrapped=function(id){
      oldAgendaModal350.apply(this,arguments);
      setTimeout(()=>{const body=$id('agendaModalBody'); if(body && !$id('wsTemplatesTurno350'))body.insertAdjacentHTML('beforeend',`<div id="wsTemplatesTurno350" class="ws-templates350"><h3>Copiar mensaje WhatsApp</h3><button type="button" class="secondary" onclick="copiarWsTurno350(${idJS(id)},'turno')">Recordatorio turno</button><button type="button" class="secondary" onclick="copiarWsTurno350(${idJS(id)},'holter')">Holter</button><button type="button" class="secondary" onclick="copiarWsTurno350(${idJS(id)},'mapa')">MAPA</button><button type="button" class="secondary" onclick="copiarWsTurno350(${idJS(id)},'eco')">Eco/estudio</button></div>`);},30);
    };
    wrapped.__v350=true; window.abrirAgendaModal=abrirAgendaModal=wrapped;
  }

  function init350(){
    version350(); asegurarBotonRepararCoberturas350(); asegurarBotonPendientes350();
    const fixed=limpiarCoberturasMedicloud350(true); if(fixed)console.log('v3.5 limpió coberturas:',fixed);
    try{window.renderContadorCoberturas350();}catch(e){}
  }
  document.addEventListener('DOMContentLoaded',()=>setTimeout(init350,900));
  setTimeout(init350,1800);
  setInterval(()=>{try{version350();asegurarBotonRepararCoberturas350();asegurarBotonPendientes350();}catch(e){}},2500);
})();


/* ===== v3.6.0 - Inicio inteligente y pulido administrativo ===== */
(()=>{
  const APP_VERSION='4.1.0-hc';
  const $360=id=>document.getElementById(id);
  const esc360=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const norm360=s=>String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();
  const today360=()=>new Date().toISOString().slice(0,10);
  function setVersion360(){
    document.title=`CardioLink Admin v${APP_VERSION}`;
    document.querySelectorAll('.brand-main span').forEach(x=>x.textContent=`v${APP_VERSION}`);
    document.querySelectorAll('.login-meta').forEach(x=>x.textContent=`Versión ${APP_VERSION} · 2026`);
    const pt=document.querySelector('.print-title h2');if(pt)pt.textContent=`CardioLink Admin v${APP_VERSION}`;
  }
  function hasAuthenticatedSession360(){
    try{return !!(usuarioSupabase?.email || usuarioSupabase?.id || window.usuarioSupabase?.email || window.usuarioSupabase?.id);}catch(e){return false;}
  }
  function allAtt360(){
    try{return Array.isArray(atenciones)?atenciones:(Array.isArray(window.atenciones)?window.atenciones:[]);}catch(e){return Array.isArray(window.atenciones)?window.atenciones:[];}
  }
  function isLocalPreview360(){return location.protocol==='file:' || !hasAuthenticatedSession360();}
  function currentUser360(){
    try{
      const u=perfilUsuarioActual();
      if(u && (u.nombre||u.usuario) && !/^local$/i.test(String(u.nombre||u.usuario||''))) return u;
    }catch(e){}
    const pid=$360('perfilActivo')?.value||'general';
    return {nombre:profName360(pid)||'Vista local',rol:'preview',profesionalId:pid,usuario:'local'};
  }
  function currentProfileId360(){return $360('perfilActivo')?.value||currentUser360().profesionalId||'general';}
  function profName360(id){return (data?.profesionales||[]).find(p=>p.id===id)?.nombre||id||'Vista general';}
  function profileAtt360(date=today360(), pid=currentProfileId360()){
    return allAtt360().filter(a=>a&&a.fecha===date&&(pid==='general'||!pid||a.profesionalId===pid||a.profesional===profName360(pid)));
  }
  function pendingTypes360(a){
    try{if(typeof window.pendientesDeAtencion383==='function')return window.pendientesDeAtencion383(a)}catch(e){}
    return a&&(!a.estudioInformado||!a.estudioImpreso||a.pendienteEnvio||a.pendienteEntrega||a.bonoPendiente||a.autorizacionPendiente)?['legacy']:[];
  }
  function isPending360(a){return pendingTypes360(a).length>0;}
  function isRealizedProduction360(a){return !['ausente','cancelado'].includes(norm360(a?.estadoTurno||a?.estado));}
  function prestationCounts360(list){const c={};list.forEach(a=>{const k=String(a.prestacion||'Sin prestación').trim()||'Sin prestación';c[k]=(c[k]||0)+1;});return Object.entries(c).sort((a,b)=>b[1]-a[1]);}
  function firstName360(n){const s=String(n||'').replace(/^Dr\.?\s*/i,'').replace(/^Dra\.?\s*/i,'').trim();return s||'Usuario';}
  function welcomeTitle360(u){
    if(isLocalPreview360()){
      const nombre=profName360(currentProfileId360());
      return nombre&&nombre!=='general' ? `Resumen de ${nombre}` : 'Vista previa local';
    }
    if(u.rol==='secretaria')return `Bienvenida, ${firstName360(u.nombre)}`;
    if(u.rol==='admin')return `Bienvenido, ${firstName360(u.nombre)}`;
    const isDoc=['medico','duenio'].includes(u.rol);return `Bienvenido${isDoc?' Dr.':''} ${firstName360(u.nombre)}`;
  }
  function renderWelcomeSummary360(){
    const pid=$360('welcomePerfil360')?.value||currentProfileId360();
    const list=profileAtt360(today360(),pid);const pending=list.filter(isPending360);
    const counts=prestationCounts360(list);const room=list.filter(a=>['sala_espera','en_sala','llego'].includes(a.estadoTurno||a.estado)).length;
    const profName=profName360(pid);const globalProfile=allAtt360().filter(a=>a&&(pid==='general'||!pid||a.profesionalId===pid||a.profesional===profName));
    const globalPending=globalProfile.filter(a=>{try{return typeof esPendienteAdministrativo==='function'?esPendienteAdministrativo(a):isPending360(a);}catch(e){return isPending360(a);}});
    const overdue=globalPending.filter(a=>{const d=typeof diasAntiguedadPendiente411C==='function'?diasAntiguedadPendiente411C(a):null;return d!=null&&d>7;});
    const critical=globalPending.filter(a=>{const d=typeof diasAntiguedadPendiente411C==='function'?diasAntiguedadPendiente411C(a):null;return d!=null&&d>14;});
    const html=[`<div class="welcome-kpi-360"><span>Turnos de hoy</span><strong>${list.length}</strong></div>`,...counts.slice(0,8).map(([k,v])=>`<div class="welcome-kpi-360"><span>${esc360(k)}</span><strong>${v}</strong></div>`),`<div class="welcome-kpi-360 warning"><span>Pendientes hoy</span><strong>${pending.length}</strong></div>`,`<div class="welcome-kpi-360"><span>En sala</span><strong>${room}</strong></div>`,`<div class="welcome-kpi-360 pending-overdue-411c"><span>Vencidos +7 días</span><strong>${overdue.length}</strong></div>`,`<div class="welcome-kpi-360 pending-critical-411c"><span>Críticos +14 días</span><strong>${critical.length}</strong></div>`].join('');
    const actions=(overdue.length||critical.length)?`<div class="welcome-pending-action411c"><div><strong>⚠️ Hay ${overdue.length} pendiente(s) de más de 7 días.</strong>${critical.length?` <span>${critical.length} superan 14 días.</span>`:''}</div><button type="button" onclick="verPendientesVencidos411C()">Ver vencidos</button></div>`:'';
    if($360('welcomeResumen360'))$360('welcomeResumen360').innerHTML=(html+actions)||'<p class="muted">No hay turnos asignados para hoy.</p>';
  }
  function openWelcome360(force=false){
    const modal=$360('welcomeModal360');if(!modal)return;
    // v4.1.0-hc 3B.1: la bienvenida también se muestra en la prueba local.
    const u=currentUser360();
    const key=`cl_welcome_${hasAuthenticatedSession360()?(usuarioActualNombreCorto?.()||'usuario'):'preview'}_${today360()}`;if(!force&&window.__welcomeShown371)return;
    $360('welcomeFecha360').textContent=new Date().toLocaleDateString('es-AR',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
    $360('welcomeTitulo360').textContent=welcomeTitle360(u);
    $360('welcomeUsuario360').textContent=isLocalPreview360()?'Vista local de diseño':`Usuario conectado: ${u.nombre||u.usuario||''}`;
    const canChoose=isLocalPreview360()||u.rol==='secretaria'||u.rol==='admin'||u.rol==='duenio';const wrap=$360('welcomePerfilWrap360'),sel=$360('welcomePerfil360');
    wrap?.classList.toggle('hidden',!canChoose);
    if(sel){sel.innerHTML=(data?.profesionales||[]).map(p=>`<option value="${esc360(p.id)}">${esc360(p.nombre)}</option>`).join('');let target=currentProfileId360();if(target==='general')target=u.profesionalId||(data?.profesionales||[])[0]?.id;sel.value=target||'';sel.onchange=renderWelcomeSummary360;}
    renderWelcomeSummary360();modal.classList.remove('hidden');modal.dataset.key=key;
  }
  function closeWelcome360(apply=true){const modal=$360('welcomeModal360');if(!modal)return;if(apply){const sel=$360('welcomePerfil360');if(sel&&!$360('welcomePerfilWrap360')?.classList.contains('hidden')&&sel.value){const pa=$360('perfilActivo');if(pa){pa.value=sel.value;pa.dispatchEvent(new Event('change',{bubbles:true}));}}window.__welcomeShown371=true;}modal.classList.add('hidden');renderAdmin360();}

  function pendingBreakdown360(list){return [
    ['Falta informe',list.filter(a=>pendingTypes360(a).includes('informe')).length,'informe'],
    ['Falta copia',list.filter(a=>pendingTypes360(a).includes('copia')).length,'copia'],
    ['Falta enviar/imprimir',list.filter(a=>pendingTypes360(a).includes('entrega')).length,'entrega'],
    ['Falta firma/bono',list.filter(a=>pendingTypes360(a).includes('firma')).length,'firma']
  ];}
  function openPendingFilter360(tipo){try{showSection('pendientes383');document.querySelector(`#pendientesTabs383 [data-pendtab="${tipo}"]`)?.click();}catch(e){console.warn(e)}}
  window.openPendingFilter360=openPendingFilter360;
  function computeNotifications360(){
    const pid=currentProfileId360();const own=allAtt360().filter(a=>a&&(pid==='general'||a.profesionalId===pid||a.profesional===profName360(pid)));const pend=own.filter(isPending360);
    const pats=(typeof todosPacientes==='function'?todosPacientes():(data?.pacientes||[])).filter(p=>p&&p.estado!=='fusionado');
    const noContact=pats.filter(p=>!p.telefono&&!p.email&&!p.telefonoResponsable&&!p.emailResponsable).length;
    const noCover=pats.filter(p=>{const c=String(p.obraSocial||p.coberturaHabitual||'').trim();return !c||norm360(c).includes('matias anchorena')}).length;
    const duplicates=0;const out=[];
    if(pend.length)out.push({icon:'⚠️',text:`${pend.length} pendiente(s) del perfil activo`,action:'pendientes'});
    if(noCover)out.push({icon:'🪪',text:`${noCover} paciente(s) con cobertura incompleta`,action:'pacientes'});
    if(noContact)out.push({icon:'📞',text:`${noContact} paciente(s) sin datos de contacto`,action:'pacientes'});
    const last=Number(localStorage.getItem('cl_last_backup')||0);if(!last||Date.now()-last>7*864e5)out.push({icon:'💾',text:'Conviene realizar un backup: pasaron más de 7 días',action:'config'});
    return out;
  }
  function renderNotifications360(){const items=computeNotifications360();const badge=$360('badgeNotificaciones360');if(badge){badge.textContent=items.length;badge.style.display=items.length?'inline-flex':'none';}
    const html=items.length?items.map((n,i)=>`<button type="button" class="notification-item-360" data-notif-action="${n.action}"><span>${n.icon}</span><span>${esc360(n.text)}</span></button>`).join(''):'<p class="muted">No hay alertas importantes.</p>';
    if($360('notificationsList360'))$360('notificationsList360').innerHTML=html;if($360('notificacionesDashboard360'))$360('notificacionesDashboard360').innerHTML=html;
  }
  function renderDashboard360(){const list=profileAtt360();const board=$360('tableroPendientes360');if(board){board.innerHTML=pendingBreakdown360(list).map(([t,n,k])=>`<button type="button" onclick="openPendingFilter360('${k}')"><span>${esc360(t)}</span><strong>${n}</strong></button>`).join('');}
    const prod=$360('produccionHoy360');if(prod){const cnt=prestationCounts360(list.filter(isRealizedProduction360));prod.innerHTML=cnt.length?cnt.map(([k,v])=>`<div><span>${esc360(k)}</span><strong>${v}</strong></div>`).join(''):'<p class="muted">Sin prestaciones realizadas hoy.</p>';}
    renderNotifications360();applyDashboardPrefs360();}
  function dashboardPrefsKey360(){return `cl_dashboard_${usuarioActualNombreCorto?.()||'local'}`}
  function getDashboardPrefs360(){try{return JSON.parse(localStorage.getItem(dashboardPrefsKey360())||'null')||{kpis:true,resumen:true,pendientes:true,notificaciones:true,produccion:true}}catch{return {kpis:true,resumen:true,pendientes:true,notificaciones:true,produccion:true}}}
  function applyDashboardPrefs360(){const prefs=getDashboardPrefs360();document.querySelectorAll('[data-dashboard-widget]').forEach(x=>x.classList.toggle('dashboard-hidden-360',prefs[x.dataset.dashboardWidget]===false));}
  function openDashboardConfig360(){const prefs=getDashboardPrefs360();document.querySelectorAll('[data-widget-toggle]').forEach(x=>x.checked=prefs[x.dataset.widgetToggle]!==false);$360('dashboardConfigModal360')?.classList.remove('hidden');}
  function saveDashboardConfig360(){const p={};document.querySelectorAll('[data-widget-toggle]').forEach(x=>p[x.dataset.widgetToggle]=x.checked);localStorage.setItem(dashboardPrefsKey360(),JSON.stringify(p));$360('dashboardConfigModal360')?.classList.add('hidden');applyDashboardPrefs360();}

  let spotlightIndex360=-1,spotlightMatches360=[];
  function patients360(){return (typeof todosPacientes==='function'?todosPacientes():(data?.pacientes||[])).filter(p=>p&&p.estado!=='fusionado');}
  function patientLabel360(p){return p.nombreCompleto||p.paciente||p.nombre||'Paciente';}
  function renderSpotlight360(q){const box=$360('resultadosGlobal360');if(!box)return;const n=norm360(q);if(n.length<2){box.classList.add('hidden');box.innerHTML='';spotlightMatches360=[];return;}
    spotlightMatches360=patients360().filter(p=>norm360([patientLabel360(p),p.dni,p.telefono,p.email,p.telefonoResponsable,p.emailResponsable].join(' ')).includes(n)).slice(0,10);spotlightIndex360=spotlightMatches360.length?0:-1;
    box.innerHTML=spotlightMatches360.length?spotlightMatches360.map((p,i)=>`<button type="button" class="spotlight-item-360 ${i===0?'active':''}" data-patient-id="${esc360(p.id)}"><strong>${esc360(patientLabel360(p))}</strong><small>DNI ${esc360(p.dni||'s/d')} · ${esc360(p.obraSocial||p.coberturaHabitual||'Sin cobertura')}</small></button>`).join(''):'<p class="muted">Sin coincidencias.</p>';box.classList.remove('hidden');}
  function openPatient360(p){if(!p)return;try{const key=(typeof clavePac320==='function'?clavePac320(p):(p.id||p.dni||''));if(typeof abrirPacienteGlobal320==='function'){abrirPacienteGlobal320(key);document.getElementById('buscadorGlobal360')?.blur();document.getElementById('pacienteGlobalModal')?.scrollTo?.(0,0);document.body.classList.add('patient-modal-open-371');return;}if(typeof abrirFichaPaciente==='function'){abrirFichaPaciente(p.id);return;}showSection('pacientes');setTimeout(()=>{if(typeof seleccionarPacientePanel==='function')seleccionarPacientePanel(key);},80);}catch(e){console.error('No se pudo abrir paciente desde búsqueda global',e);showSection('pacientes');}}
  function updateSpotlightActive360(){document.querySelectorAll('.spotlight-item-360').forEach((x,i)=>x.classList.toggle('active',i===spotlightIndex360));document.querySelectorAll('.spotlight-item-360')[spotlightIndex360]?.scrollIntoView({block:'nearest'});}

  function shiftAgenda360(dir){const inp=$360('agendaFecha');if(!inp)return;const d=new Date((inp.value||today360())+'T12:00:00');const vista=$360('agendaVista')?.value||'tabla';d.setDate(d.getDate()+dir*(vista==='mes'?30:vista==='semana'?7:1));inp.value=d.toISOString().slice(0,10);renderAgenda?.();}
  function enhanceMonthClick360(){document.querySelectorAll('.month-cell320').forEach(cell=>{if(cell.dataset.nav360)return;cell.dataset.nav360='1';cell.style.cursor='pointer';cell.addEventListener('click',e=>{if(e.target.closest('button,.mini-turno320'))return;const h=cell.querySelector('h3')?.textContent||'';const n=(h.match(/(\d+)\s*$/)||[])[1];if(!n)return;const base=new Date(($360('agendaFecha')?.value||today360())+'T12:00:00');base.setDate(Number(n));$360('agendaFecha').value=base.toISOString().slice(0,10);$360('agendaVista').value='tabla';renderAgenda?.();});});}

  function reorganizeConfig360(){const grid=document.querySelector('#config .config-grid');if(!grid)return;[...grid.children].forEach(card=>{const explicit=card.dataset.configGroupCard;if(explicit){card.dataset.configGroup360=explicit;return;}const h=norm360(card.querySelector('h3')?.textContent||'');let g='mantenimiento';if(h.includes('profesional'))g='profesionales';if(h.includes('prestacion')||h.includes('bloque'))g='prestaciones';if(h.includes('obra social')||h.includes('regla')||h.includes('valor'))g='coberturas';if(h.includes('usuario')||h.includes('rol'))g='usuarios';if(h.includes('backup')||h.includes('mantenimiento')||h.includes('duplicado'))g='mantenimiento';card.dataset.configGroup360=g;});}
  function filterConfig360(group){reorganizeConfig360();document.querySelectorAll('#config .config-grid > *').forEach(x=>x.classList.toggle('config-hidden-360',group!=='todos'&&x.dataset.configGroup360!==group));document.querySelectorAll('[data-config-group]').forEach(b=>b.classList.toggle('active',b.dataset.configGroup===group));}

  function enrichStats360(){const card=document.querySelector('#estadisticas .estadisticas-card');if(!card)return;let box=$360('statsEnriched360');if(!box){box=document.createElement('div');box.id='statsEnriched360';box.className='stats-enriched-360';card.appendChild(box);}const desde=$360('statsDesde')?.value||'0000-00-00',hasta=$360('statsHasta')?.value||'9999-99-99',pid=$360('statsProfesional')?.value||'general';const list=allAtt360().filter(a=>a&&a.fecha>=desde&&a.fecha<=hasta&&(pid==='general'||!pid||a.profesionalId===pid||a.profesional===profName360(pid)));
    const os={},prod={},prof={};list.forEach(a=>{const o=a.obraSocial||a.coberturaAtencion||'Incompleto';os[o]=(os[o]||0)+1;const pr=a.prestacion||'Sin prestación';prod[pr]=(prod[pr]||0)+1;const pf=a.profesional||'Sin profesional';prof[pf]=(prof[pf]||0)+1;});
    const tbl=(title,obj)=>`<div class="stats-table-360"><h3>${title}</h3>${Object.keys(obj).length?Object.entries(obj).sort((a,b)=>b[1]-a[1]).slice(0,15).map(([k,v])=>`<div><span>${esc360(k)}</span><strong>${v}</strong></div>`).join(''):'<p class="muted">Sin datos.</p>'}</div>`;
    box.innerHTML=tbl('Atenciones por cobertura',os)+tbl('Prestaciones',prod)+tbl('Producción por profesional',prof);}

  function improvePatientModal360(){const m=document.querySelector('.global-patient-modal320:not(.patient-improved-360), #modalFichaPacienteGlobal:not(.patient-improved-360)');if(!m)return;m.classList.add('patient-improved-360');const body=m.querySelector('.modal-body, .global-patient-card320')||m;const txt=body.textContent||'';}

  function renderAdmin360(){setVersion360();renderDashboard360();reorganizeConfig360();enrichStats360();setTimeout(()=>{enhanceMonthClick360();improvePatientModal360();},80);}
  function bind360(){
    $360('btnCerrarWelcome360')?.addEventListener('click',()=>closeWelcome360(true));$360('btnEntrarWelcome360')?.addEventListener('click',()=>closeWelcome360(true));$360('btnAbrirBienvenida360')?.addEventListener('click',()=>openWelcome360(true));
    $360('btnNotificaciones360')?.addEventListener('click',()=>{$360('notificationsPanel360')?.classList.toggle('hidden');renderNotifications360();});$360('btnCerrarNotificaciones360')?.addEventListener('click',()=>$360('notificationsPanel360')?.classList.add('hidden'));
    document.addEventListener('click',e=>{const n=e.target.closest('[data-notif-action]');if(n){$360('notificationsPanel360')?.classList.add('hidden');const a=n.dataset.notifAction;if(a==='pendientes')openPendingFilter360('');else showSection(a==='pacientes'?'pacientes':'config');}const p=e.target.closest('[data-patient-id]');if(p&&p.closest('#resultadosGlobal360')){const patient=patients360().find(x=>String(x.id)===String(p.dataset.patientId));openPatient360(patient);$360('resultadosGlobal360')?.classList.add('hidden');if($360('buscadorGlobal360'))$360('buscadorGlobal360').value='';}});
    const inp=$360('buscadorGlobal360');if(inp){inp.addEventListener('input',e=>renderSpotlight360(e.target.value));inp.addEventListener('keydown',e=>{if(e.key==='ArrowDown'){e.preventDefault();spotlightIndex360=Math.min(spotlightIndex360+1,spotlightMatches360.length-1);updateSpotlightActive360();}if(e.key==='ArrowUp'){e.preventDefault();spotlightIndex360=Math.max(spotlightIndex360-1,0);updateSpotlightActive360();}if(e.key==='Enter'&&spotlightIndex360>=0){e.preventDefault();openPatient360(spotlightMatches360[spotlightIndex360]);$360('resultadosGlobal360')?.classList.add('hidden');}if(e.key==='Escape')$360('resultadosGlobal360')?.classList.add('hidden');});}
    $360('btnAgendaAnterior360')?.addEventListener('click',()=>shiftAgenda360(-1));$360('btnAgendaSiguiente360')?.addEventListener('click',()=>shiftAgenda360(1));$360('btnAgendaHoy360')?.addEventListener('click',()=>{if($360('agendaFecha'))$360('agendaFecha').value=today360();renderAgenda?.();});
    $360('btnPersonalizarDashboard360')?.addEventListener('click',openDashboardConfig360);$360('btnCerrarDashboardConfig360')?.addEventListener('click',()=>$360('dashboardConfigModal360')?.classList.add('hidden'));$360('btnGuardarDashboard360')?.addEventListener('click',saveDashboardConfig360);
    $360('configTabs360')?.addEventListener('click',e=>{const b=e.target.closest('[data-config-group]');if(b)filterConfig360(b.dataset.configGroup);});
    $360('perfilActivo')?.addEventListener('change',()=>setTimeout(renderAdmin360,80));
    document.querySelectorAll('.nav').forEach(b=>b.addEventListener('click',()=>setTimeout(renderAdmin360,80)));
  }
  const oldRenderAgenda360=typeof renderAgenda==='function'?renderAgenda:null;if(oldRenderAgenda360){window.renderAgenda=renderAgenda=function(){const r=oldRenderAgenda360.apply(this,arguments);setTimeout(enhanceMonthClick360,20);return r;}}
  const oldRenderStats360=typeof renderEstadisticas==='function'?renderEstadisticas:null;if(oldRenderStats360){window.renderEstadisticas=renderEstadisticas=function(){const r=oldRenderStats360.apply(this,arguments);setTimeout(enrichStats360,40);return r;}}
  const oldExport360=typeof exportarBackup==='function'?exportarBackup:null;if(oldExport360){window.exportarBackup=exportarBackup=function(){localStorage.setItem('cl_last_backup',String(Date.now()));return oldExport360.apply(this,arguments);}}
  function init360(){
    setVersion360();bind360();renderAdmin360();document.body.classList.add('app-ready-360');
    const logout=document.getElementById('btnCerrarSesion');if(logout)logout.style.visibility='visible';
    if(location.protocol!=='file:'){
      let tries=0;
      const waitWelcome=setInterval(()=>{
        tries++;
        if(hasAuthenticatedSession360()){clearInterval(waitWelcome);openWelcome360(false);}
        else if(tries>=60)clearInterval(waitWelcome);
      },250);
    }
  }
  document.addEventListener('DOMContentLoaded',()=>setTimeout(init360,1000));setTimeout(()=>{setVersion360();document.body.classList.add('app-ready-360');},1800);
})();


/* ===== v3.7.0 - bienvenida real, permisos y consistencia dashboard ===== */
(function(){
  function id(x){return document.getElementById(x)}
  const oldPerm=typeof aplicarPermisosUI==='function'?aplicarPermisosUI:null;
  if(oldPerm){window.aplicarPermisosUI=aplicarPermisosUI=function(){oldPerm.apply(this,arguments);const u=perfilUsuarioActual();document.querySelectorAll('.nav[data-section="caja"]').forEach(b=>b.classList.toggle('hidden-permission',!(esMatiasDuenio()||u.rol==='admin')));};}
  document.addEventListener('DOMContentLoaded',()=>{
    document.body.classList.add('loading-362');
    setTimeout(()=>{document.body.classList.remove('loading-362');document.body.classList.add('app-ready-360');const b=id('btnCerrarSesion');if(b)b.style.visibility='visible';},1400);
  });
})();


/* ===== v3.7.0 - experiencia responsive iPhone / iPad / Android ===== */
(function initResponsive370(){
  const $=id=>document.getElementById(id);
  function isMobile370(){ return window.matchMedia('(max-width: 1024px)').matches; }
  function setSidebar370(open){
    document.body.classList.toggle('mobile-menu-open-370', !!open);
    const btn=$('btnMobileMenu370');
    const ov=$('mobileSidebarOverlay370');
    if(btn){ btn.setAttribute('aria-expanded', open?'true':'false'); btn.textContent=open?'×':'☰'; }
    if(ov){ ov.classList.toggle('hidden', !open); ov.setAttribute('aria-hidden', open?'false':'true'); }
  }
  function focusSearch370(){
    const input=$('buscadorGlobal360');
    if(!input) return;
    setSidebar370(false);
    input.scrollIntoView({behavior:'smooth',block:'center'});
    setTimeout(()=>input.focus(),220);
  }
  function init(){
    const menu=$('btnMobileMenu370'), search=$('btnMobileSearch370'), ov=$('mobileSidebarOverlay370');
    if(menu) menu.addEventListener('click',()=>setSidebar370(!document.body.classList.contains('mobile-menu-open-370')));
    if(search) search.addEventListener('click',focusSearch370);
    if(ov) ov.addEventListener('click',()=>setSidebar370(false));
    document.querySelectorAll('.sidebar .nav').forEach(b=>b.addEventListener('click',()=>{if(isMobile370()) setSidebar370(false);}));
    document.addEventListener('keydown',e=>{if(e.key==='Escape') setSidebar370(false);});
    window.addEventListener('resize',()=>{if(!isMobile370()) setSidebar370(false);});
    window.addEventListener('orientationchange',()=>setTimeout(()=>setSidebar370(false),200));
    document.documentElement.classList.add('responsive-370');
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init); else init();
})();

/* ===== v3.7.1 - fix búsqueda global y bienvenida ===== */


/* ===== v3.7.2 - listado compacto en tablet horizontal ===== */
(function(){
  function initFiltrosCompactos372(){
    const btn=document.getElementById('btnToggleFiltros372');
    const panel=document.getElementById('listadoFiltros372');
    if(!btn||!panel||btn.dataset.ready372==='1') return;
    btn.dataset.ready372='1';
    const sync=()=>{
      const abierto=panel.classList.contains('open-372');
      btn.textContent=abierto?'Ocultar filtros':'Mostrar filtros';
      btn.setAttribute('aria-expanded',abierto?'true':'false');
    };
    btn.addEventListener('click',()=>{panel.classList.toggle('open-372');sync();});
    sync();
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',initFiltrosCompactos372,{once:true});
  else initFiltrosCompactos372();
})();


/* ===== v3.8.1 - PWA, estado de conexión y preparación segura para HC 4.0 ===== */
(function init380(){
  const $=id=>document.getElementById(id);
  let deferredPrompt380=null;

  function setStatus380(){
    const el=$('appStatus380'), tx=$('appStatusText380');
    if(!el||!tx)return;
    const online=navigator.onLine;
    el.classList.toggle('online',online);
    el.classList.toggle('offline',!online);
    tx.textContent=online?'Conectado':'Sin conexión';
    el.title=online?'CardioLink conectado a internet':'Los cambios necesitan conexión para sincronizar con Supabase';
  }

  async function registerSW380(){
    if(!('serviceWorker' in navigator) || location.protocol==='file:')return;
    try{
      const reg=await navigator.serviceWorker.register('./sw.js?v=382',{scope:'./'});
      reg.update().catch(()=>{});
    }catch(e){ console.warn('No se pudo registrar la PWA:',e); }
  }

  function standalone380(){
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone===true;
  }

  function refreshInstall380(){
    const btn=$('btnInstalarApp380'), st=$('estadoInstalacion380');
    if(!btn)return;
    if(standalone380()){
      btn.disabled=true; btn.textContent='CardioLink ya está instalado';
      if(st)st.textContent='Se está ejecutando como aplicación instalada.';
    }else if(deferredPrompt380){
      btn.disabled=false; btn.textContent='Instalar CardioLink';
      if(st)st.textContent='Instalación disponible en este dispositivo.';
    }else{
      btn.disabled=false; btn.textContent='Ver instrucciones de instalación';
      if(st)st.textContent='En iPhone/iPad se instala desde Compartir → Agregar a inicio.';
    }
  }

  async function install380(){
    if(deferredPrompt380){
      deferredPrompt380.prompt();
      try{ await deferredPrompt380.userChoice; }catch(e){}
      deferredPrompt380=null; refreshInstall380();
      return;
    }
    ayudaInstalar380();
  }

  function ayudaInstalar380(){
    const ios=/iphone|ipad|ipod/i.test(navigator.userAgent);
    const android=/android/i.test(navigator.userAgent);
    const msg=ios
      ? 'En Safari: tocá Compartir y elegí “Agregar a pantalla de inicio”.'
      : android
        ? 'En Chrome: abrí el menú ⋮ y elegí “Instalar aplicación” o “Agregar a pantalla principal”.'
        : 'En Chrome o Edge: buscá el icono Instalar en la barra de direcciones o abrí el menú del navegador y elegí Instalar CardioLink.';
    alert(msg);
  }

  function cleanDni380(v){return String(v||'').replace(/\D/g,'');}
  function patientForAttention380(a){
    const list=Array.isArray(data?.pacientes)?data.pacientes:[];
    if(a?.pacienteId){ const p=list.find(x=>x.id===a.pacienteId); if(p)return p; }
    const d=cleanDni380(a?.dni); if(d){ const p=list.find(x=>cleanDni380(x.dni)===d); if(p)return p; }
    const n=String(a?.paciente||'').trim().toLowerCase();
    return n?list.find(x=>String(x.nombreCompleto||x.paciente||`${x.apellido||''} ${x.nombre||''}`).trim().toLowerCase()===n):null;
  }

  function reportHC380(){
    const ps=Array.isArray(data?.pacientes)?data.pacientes:[];
    const ats=Array.isArray(atenciones)?atenciones:[];
    const pSinId=ps.filter(p=>!String(p.id||'').trim()).length;
    const aSinId=ats.filter(a=>!String(a.id||'').trim()).length;
    const aSinPaciente=ats.filter(a=>!String(a.pacienteId||'').trim()).length;
    const aSinProf=ats.filter(a=>!String(a.profesionalId||'').trim()).length;
    const vinculables=ats.filter(a=>!a.pacienteId && patientForAttention380(a)).length;
    return {pacientes:ps.length,atenciones:ats.length,pSinId,aSinId,aSinPaciente,aSinProf,vinculables};
  }

  function renderHC380(r=reportHC380()){
    const el=$('resultadoHC380'); if(!el)return r;
    const listo=r.pSinId===0&&r.aSinId===0&&r.aSinPaciente===0&&r.aSinProf===0;
    el.innerHTML=`<div class="hc-ready-summary-380 ${listo?'ready':'warning'}"><strong>${listo?'Estructura lista para HC 4.0':'Hay vínculos por completar'}</strong><span>${r.pacientes} pacientes · ${r.atenciones} atenciones</span></div>
      <div class="hc-ready-grid-380">
        <span>Pacientes sin ID <b>${r.pSinId}</b></span><span>Atenciones sin ID <b>${r.aSinId}</b></span>
        <span>Sin vínculo a paciente <b>${r.aSinPaciente}</b></span><span>Sin profesional <b>${r.aSinProf}</b></span>
        <span>Vinculables automáticamente <b>${r.vinculables}</b></span>
      </div>`;
    return r;
  }

  async function prepararHC380(){
    const ps=Array.isArray(data?.pacientes)?data.pacientes:[];
    const ats=Array.isArray(atenciones)?atenciones:[];
    let np=0,na=0,nv=0,nprof=0;
    ps.forEach(p=>{ if(!p.id){p.id='pac_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8);np++;} });
    ats.forEach(a=>{
      if(!a.id){a.id='at_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8);na++;}
      if(!a.atencionId)a.atencionId=a.id;
      if(!a.pacienteId){const p=patientForAttention380(a);if(p){a.pacienteId=p.id;nv++;}}
      if(!a.profesionalId){
        const prof=(data?.profesionales||[]).find(p=>String(p.nombre||'').trim().toLowerCase()===String(a.profesional||'').trim().toLowerCase());
        if(prof){a.profesionalId=prof.id;nprof++;}
      }
      if(!a.hcMeta)a.hcMeta={schemaVersion:1,evoluciones:0,informes:0,adjuntos:0};
    });
    data.hcPreparacion={schemaVersion:1,preparadoEn:new Date().toISOString(),versionApp:'4.1.0-hc'};
    try{saveConfig();saveAtenciones();}catch(e){console.warn(e);}
    try{await sincronizarAtencionesSupabase(true);}catch(e){console.warn('Sincronización HC pendiente:',e);}
    renderHC380();
    alert(`Preparación completada. Pacientes identificados: ${np}. Atenciones identificadas: ${na}. Vínculos a paciente: ${nv}. Profesionales vinculados: ${nprof}.`);
  }

  function initConfigGroups380(){
    // Integrar App/HC al mismo filtro modular sin usar display inline.
    // La v3.8.0 ocultaba todos los paneles al entrar en esta pestaña y esos
    // estilos quedaban pegados, por eso luego las demás pestañas aparecían vacías.
    document.querySelectorAll('[data-config-group-card="sistema"]').forEach(c=>{
      c.dataset.configGroup360='sistema';
      c.style.removeProperty('display');
    });
    document.querySelectorAll('#config .config-grid > *').forEach(c=>c.style.removeProperty('display'));
    document.querySelectorAll('[data-config-group="sistema"]').forEach(b=>b.addEventListener('click',()=>{
      renderHC380(); refreshInstall380();
    }));
  }

  function init(){
    setStatus380(); registerSW380(); refreshInstall380(); initConfigGroups380(); renderHC380();
    $('btnInstalarApp380')?.addEventListener('click',install380);
    $('btnAyudaInstalar380')?.addEventListener('click',ayudaInstalar380);
    $('btnRevisarHC380')?.addEventListener('click',()=>renderHC380());
    $('btnPrepararHC380')?.addEventListener('click',()=>{
      if(confirm('Esto completa identificadores y vínculos faltantes sin borrar datos. ¿Continuar?')) prepararHC380();
    });
    window.addEventListener('online',setStatus380); window.addEventListener('offline',setStatus380);
    window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredPrompt380=e;refreshInstall380();});
    window.addEventListener('appinstalled',()=>{deferredPrompt380=null;refreshInstall380();});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();

/* ===== v3.8.2 - estabilización final, diagnóstico, calidad y auditoría ===== */
(function init382(){
  const $=id=>document.getElementById(id);
  const norm=v=>String(v??'').trim();
  const lower=v=>norm(v).toLowerCase();
  const digits=v=>norm(v).replace(/\D/g,'');
  const fmtDate=ts=>{
    if(!ts)return 'Sin registro';
    const d=new Date(Number(ts)||ts);
    return Number.isNaN(d.getTime())?'Sin registro':d.toLocaleString('es-AR');
  };

  function patients382(){ return Array.isArray(data?.pacientes)?data.pacientes:[]; }
  function attentions382(){ return Array.isArray(atenciones)?atenciones:[]; }
  function isBadCoverage382(v){
    const s=lower(v);
    if(!s)return true;
    return s==='undefined'||s==='null'||s==='no ingresado'||s.includes('matias anchorena')||s.includes('matías anchorena')||s.includes('rogelio anchorena')||s.includes('fernandez drago')||s.includes('fernández drago');
  }

  function qualityReport382(){
    const ps=patients382().filter(p=>!p.fusionadoEn&&!p.inactivo);
    const ats=attentions382();
    const noDni=ps.filter(p=>!digits(p.dni)).length;
    const noCoverage=ps.filter(p=>isBadCoverage382(p.obraSocial||p.cobertura||p.coberturaHabitual)).length;
    const noContact=ps.filter(p=>!digits(p.telefono||p.tel)&&!norm(p.email)&&!digits(p.telefonoContacto)&&!norm(p.emailContacto)).length;
    const noBirth=ps.filter(p=>!norm(p.fechaNacimiento)).length;
    const dniMap=new Map();
    ps.forEach(p=>{const d=digits(p.dni);if(d)dniMap.set(d,(dniMap.get(d)||0)+1);});
    const duplicatedDni=[...dniMap.values()].filter(n=>n>1).reduce((a,n)=>a+n,0);
    const orphan=ats.filter(a=>!norm(a.pacienteId)||!ps.some(p=>p.id===a.pacienteId)).length;
    const noProf=ats.filter(a=>!norm(a.profesionalId)).length;
    return {total:ps.length,noDni,noCoverage,noContact,noBirth,duplicatedDni,orphan,noProf};
  }

  function renderQuality382(){
    const el=$('dataQuality382');if(!el)return;
    const r=qualityReport382();
    const items=[
      ['Pacientes activos',r.total,'ok'],['Sin DNI',r.noDni,r.noDni?'warn':'ok'],['Cobertura incompleta',r.noCoverage,r.noCoverage?'warn':'ok'],
      ['Sin contacto',r.noContact,r.noContact?'warn':'ok'],['Sin fecha de nacimiento',r.noBirth,r.noBirth?'warn':'ok'],['DNI duplicados',r.duplicatedDni,r.duplicatedDni?'danger':'ok'],
      ['Atenciones sin paciente válido',r.orphan,r.orphan?'danger':'ok'],['Atenciones sin profesional ID',r.noProf,r.noProf?'warn':'ok']
    ];
    const kindByTitle={'Sin DNI':'dni','Cobertura incompleta':'cobertura','Sin contacto':'contacto','Sin fecha de nacimiento':'nacimiento'};
    el.innerHTML=items.map(([t,n,c])=>{
      const kind=kindByTitle[t];
      if(kind){
        return `<button type="button" class="quality-item-382 quality-action-385 ${c}" data-quality-kind="${kind}" onclick="window.qualityPatients383 && window.qualityPatients383('${kind}')" aria-label="Abrir pacientes: ${t}"><span>${t}</span><b>${n}</b></button>`;
      }
      return `<div class="quality-item-382 ${c}"><span>${t}</span><b>${n}</b></div>`;
    }).join('');
    el.querySelectorAll('[data-quality-kind]').forEach(btn=>btn.addEventListener('click',()=>window.qualityPatients383?.(btn.dataset.qualityKind)));
  }

  function auditData382(){
    const ats=attentions382();
    const patientAudit=Array.isArray(data?.auditoriaPacientes)?data.auditoriaPacientes:[];
    const users=new Set();let created=0,edited=0;
    ats.forEach(a=>{
      if(a.creadoPor||a.creadoEn)created++;
      if(a.editadoPor||a.editadoEn)edited++;
      [a.creadoPor,a.editadoPor].filter(Boolean).forEach(x=>users.add(String(x)));
    });
    patientAudit.forEach(x=>{if(x.usuario)users.add(String(x.usuario));});
    return {created,edited,fusions:patientAudit.filter(x=>x.tipo==='fusion_paciente').length,users:[...users],patientAudit};
  }

  function renderAudit382(){
    const el=$('auditSummary382');if(!el)return;
    const r=auditData382();
    el.innerHTML=`<div class="audit-kpis-382"><span>Atenciones con alta registrada <b>${r.created}</b></span><span>Atenciones editadas <b>${r.edited}</b></span><span>Fusiones de pacientes <b>${r.fusions}</b></span><span>Usuarios detectados <b>${r.users.length}</b></span></div><p class="muted">${r.users.length?'Usuarios: '+r.users.slice(0,8).join(', '):'Todavía no hay usuarios registrados en auditoría.'}</p>`;
  }

  function exportAudit382(){
    const r=auditData382();
    const payload={app:'CardioLink Admin',version:'4.1.0-hc',exportadoEn:new Date().toISOString(),resumen:{altas:r.created,ediciones:r.edited,fusiones:r.fusions,usuarios:r.users},atenciones:attentions382().map(a=>({id:a.id,pacienteId:a.pacienteId,paciente:a.paciente,creadoPor:a.creadoPor,creadoEn:a.creadoEn,editadoPor:a.editadoPor,editadoEn:a.editadoEn})),auditoriaPacientes:r.patientAudit};
    const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});
    const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='CardioLink_Auditoria_'+new Date().toISOString().slice(0,10)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  }

  function healthReport382(){
    let session='No iniciada';
    try{session=usuarioSupabase?.email||window.usuarioSupabase?.email||'No iniciada';}catch(e){}
    const lastBackup=localStorage.getItem('cl_last_backup');
    const lastSync=localStorage.getItem('cl_last_sync_382');
    const hc=typeof reportHC380==='function'?reportHC380():null;
    return {online:navigator.onLine,session,lastBackup,lastSync,hc};
  }

  function renderHealth382(){
    const el=$('systemHealth382');if(!el)return;
    const r=healthReport382();
    const hcReady=!r.hc||(!r.hc.pSinId&&!r.hc.aSinId&&!r.hc.aSinPaciente&&!r.hc.aSinProf);
    const items=[
      ['Internet',r.online?'Conectado':'Sin conexión',r.online?'ok':'danger'],
      ['Sesión Supabase',r.session,r.session==='No iniciada'?'warn':'ok'],
      ['Última sincronización',fmtDate(r.lastSync),r.lastSync?'ok':'warn'],
      ['Último backup',fmtDate(r.lastBackup),r.lastBackup?'ok':'warn'],
      ['Versión','4.1.0-hc','ok'],
      ['Preparación HC',hcReady?'Lista':'Revisar vínculos',hcReady?'ok':'warn']
    ];
    el.innerHTML=items.map(([t,v,c])=>`<div class="health-item-382 ${c}"><span>${t}</span><b>${v}</b></div>`).join('');
  }

  async function syncNow382(){
    const btn=$('btnSyncNow382');if(btn){btn.disabled=true;btn.textContent='Sincronizando…';}
    try{
      if(typeof sincronizarAtencionesSupabase==='function'){
        const ok=await sincronizarAtencionesSupabase(true);
        if(ok!==false)localStorage.setItem('cl_last_sync_382',String(Date.now()));
      }
      renderHealth382();
    }catch(e){console.error(e);alert('No se pudo sincronizar. Revisá la conexión o volvé a iniciar sesión.');}
    finally{if(btn){btn.disabled=false;btn.textContent='Sincronizar ahora';}}
  }

  function goPatients382(){
    const nav=document.querySelector('[data-section="pacientes"]');
    if(nav)nav.click();
    setTimeout(()=>document.getElementById('pacientes')?.scrollIntoView({behavior:'smooth',block:'start'}),100);
  }

  function installSyncTracker382(){
    if(window.__syncTracker382)return;window.__syncTracker382=true;
    if(typeof sincronizarAtencionesSupabase!=='function')return;
    const old=sincronizarAtencionesSupabase;
    window.sincronizarAtencionesSupabase=sincronizarAtencionesSupabase=async function(){
      const result=await old.apply(this,arguments);
      if(result!==false)localStorage.setItem('cl_last_sync_382',String(Date.now()));
      renderHealth382();
      return result;
    };
  }

  function initUpdateNotice382(){
    if(!('serviceWorker' in navigator)||location.protocol==='file:')return;
    navigator.serviceWorker.getRegistration('./').then(reg=>{
      if(!reg)return;
      const show=()=>{
        if(document.getElementById('updateBanner382'))return;
        const b=document.createElement('div');b.id='updateBanner382';b.className='update-banner-382';
        b.innerHTML='<span>Hay una nueva versión de CardioLink disponible.</span><button type="button">Actualizar ahora</button>';
        b.querySelector('button').onclick=()=>{reg.waiting?.postMessage({type:'SKIP_WAITING'});location.reload();};
        document.body.appendChild(b);
      };
      if(reg.waiting)show();
      reg.addEventListener('updatefound',()=>{const w=reg.installing;if(w)w.addEventListener('statechange',()=>{if(w.state==='installed'&&navigator.serviceWorker.controller)show();});});
    }).catch(()=>{});
    navigator.serviceWorker.addEventListener('controllerchange',()=>{if(!window.__reloaded382){window.__reloaded382=true;location.reload();}});
  }

  function init(){
    renderQuality382();renderAudit382();renderHealth382();installSyncTracker382();initUpdateNotice382();
    $('btnRefreshQuality382')?.addEventListener('click',renderQuality382);
    $('btnRefreshHealth382')?.addEventListener('click',renderHealth382);
    $('btnSyncNow382')?.addEventListener('click',syncNow382);
    $('btnGoPatients382')?.addEventListener('click',goPatients382);
    $('btnExportAudit382')?.addEventListener('click',exportAudit382);
    window.addEventListener('online',renderHealth382);window.addEventListener('offline',renderHealth382);
    document.querySelectorAll('[data-config-group="sistema"],[data-config-group="mantenimiento"]').forEach(b=>b.addEventListener('click',()=>setTimeout(()=>{renderHealth382();renderQuality382();renderAudit382();},50)));
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();


/* ===== CardioLink Admin v4.1.0-hc: Pendientes y calidad de datos ===== */
(function(){
  const V='383';
  let currentTab='todos';
  let onlyOverdue383=false;
  let undo383=null;
  const norm=s=>String(s||'').trim().toLowerCase();
  const isStudy=a=>{try{return typeof esRegistroDeEstudio==='function'?esRegistroDeEstudio(a):!norm(a.prestacion).includes('consulta')}catch{return !norm(a.prestacion).includes('consulta')}};
  function isParticular383(a){const os=norm(a.obraSocial);return os==='particular'||os==='pami'}
  function isOsde383(a){return norm(a.obraSocial)==='osde'}
  function applyNA383(a){
    if(!a||typeof a!=='object'||String(a.tipo||'').includes('mensaje'))return;
    if(isParticular383(a)){a.noAplicaFirmaBono=true;a.noAplicaCopiaFacturacion=true;}
    else if(isOsde383(a)){a.noAplicaFirmaBono=true;a.noAplicaCopiaFacturacion=true;}
    else {if(a.noAplicaFirmaBono==='auto')delete a.noAplicaFirmaBono;if(a.noAplicaCopiaFacturacion==='auto')delete a.noAplicaCopiaFacturacion;}
  }
  function pendientes383(a){
    if(!a||typeof a!=='object'||(typeof esMensajeInterno==='function'&&esMensajeInterno(a)))return [];
    const estadoTurno383=String(a.estadoTurno||a.estado||'').toLowerCase();
    if(estadoTurno383==='ausente'||estadoTurno383==='cancelado')return [];
    applyNA383(a);
    const out=[];
    const requiereFirma=!!(a.bonoConsulta||a.bonoEstudio);
    const requiereCopia=!!(a.bonoEstudio||a.requiereCopiaImpresa);
    if(requiereFirma&&!a.noAplicaFirmaBono&&!a.bonoFirmado)out.push('firma');
    if(requiereCopia&&!a.noAplicaCopiaFacturacion&&!a.copiaImpresa)out.push('copia');
    if(isStudy(a)&&!a.estudioInformado)out.push('informe');
    if(isStudy(a)&&a.estudioInformado&&!(a.estudioImpreso||a.estudioEnviadoMail||a.estudioEnviadoWS))out.push('entrega');
    if(isStudy(a)&&a.estudioImpreso&&!a.retiradoFisico&&!a.estudioEnviadoMail&&!a.estudioEnviadoWS)out.push('retiro');
    if(a.requiereAutorizacion&&!a.autorizacionCompleta)out.push('autorizacion');
    return out;
  }
  window.pendientesDeAtencion383=pendientes383;
  function base383(){try{return typeof atencionesPerfil==='function'?atencionesPerfil().filter(a=>!(typeof esMensajeInterno==='function'&&esMensajeInterno(a))):atenciones}catch{return atenciones||[]}}
  function labels383(k){return {firma:'Falta firma / bono',copia:'Falta copia facturación',informe:'Falta informe',entrega:'Falta imprimir / enviar',retiro:'Pendiente de retiro',autorizacion:'Falta autorización'}[k]||k}
  function counts383(list){const c={todos:0,firma:0,copia:0,informe:0,entrega:0,retiro:0,autorizacion:0};list.forEach(a=>{const p=pendientes383(a);if(p.length)c.todos++;p.forEach(k=>c[k]++)});return c}
  function overdue383(a){try{return typeof diasAntiguedadPendiente411C==='function'&&diasAntiguedadPendiente411C(a)>7}catch(e){return false}}
  function esc383(s){return String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
  function renderPendientes383(){
    const box=document.getElementById('pendientesLista383');if(!box)return;
    let list=base383().filter(a=>pendientes383(a).length);
    const c=counts383(base383());
    document.querySelectorAll('#pendientesTabs383 [data-pendtab]').forEach(b=>{const k=b.dataset.pendtab;b.classList.toggle('active',k===currentTab);const s=b.querySelector('span');if(s)s.textContent=c[k]||0});
    const nav=document.getElementById('badgePendientesNav383');if(nav){nav.textContent=c.todos;nav.classList.toggle('zero',!c.todos)}
    if(currentTab!=='todos')list=list.filter(a=>pendientes383(a).includes(currentTab));
    if(onlyOverdue383)list=list.filter(overdue383);
    const q=norm(document.getElementById('pendBuscar383')?.value);if(q)list=list.filter(a=>norm([a.paciente,a.dni,a.prestacion,a.obraSocial,a.profesional].join(' ')).includes(q));
    const desc=document.getElementById('pendOrden383')?.value==='desc';list.sort((a,b)=>(String(a.fecha||'').localeCompare(String(b.fecha||'')))*(desc?-1:1));
    if(!list.length){box.innerHTML=`<div class="empty383">${onlyOverdue383?'No hay pendientes vencidos de más de 7 días.':'No hay pendientes en esta categoría.'}</div>`;return}
    const notice=onlyOverdue383?'<div class="empty383">Mostrando pendientes vencidos de más de 7 días. Elegí una categoría para volver a la vista completa.</div>':'';
    box.innerHTML=notice+list.map(a=>{const ps=pendientes383(a);return `<article class="pend-card383"><div class="pend-main383"><div class="pend-date383">${esc383(typeof formatFecha==='function'?formatFecha(a.fecha):a.fecha)}${a.horaInicio?' · '+esc383(a.horaInicio):''}</div><h3>${esc383(a.paciente||'Paciente')}</h3><p>${esc383(a.prestacion||'')} · ${esc383(a.profesional||'')}</p><p class="muted">${esc383(a.obraSocial||'Sin cobertura')} · DNI ${esc383(a.dni||'s/d')}</p></div><div class="pend-tags383">${ps.map(k=>`<button type="button" class="pend-tag383 p-${k}" onclick="resolverPendiente383('${esc383(a.id)}','${k}')">${esc383(labels383(k))}</button>`).join('')}<button type="button" class="secondary open383" onclick="abrirFichaPacienteDesdePendiente411C('${esc383(a.id)}')">Ficha paciente</button></div></article>`}).join('');
  }
  window.renderPendientes383=renderPendientes383;
  window.mostrarPendientesVencidos383=function(){currentTab='todos';onlyOverdue383=true;const search=document.getElementById('pendBuscar383');if(search)search.value='';renderPendientes383();};
  function audit383(a,k){a.auditoriaPendientes=Array.isArray(a.auditoriaPendientes)?a.auditoriaPendientes:[];let u={};try{u=perfilUsuarioActual()||{}}catch{}a.auditoriaPendientes.push({tipo:k,accion:'resuelto',fecha:new Date().toISOString(),usuario:u.nombre||u.usuario||'usuario'});}
  function resolverPendiente383(id,k){
    const a=(atenciones||[]).find(x=>String(x.id)===String(id));if(!a)return;
    const prev=JSON.parse(JSON.stringify(a));
    if(k==='firma')a.bonoFirmado=true;
    if(k==='copia')a.copiaImpresa=true;
    if(k==='informe')a.estudioInformado=true;
    if(k==='entrega'){a.estudioImpreso=true;a.disponibleRetiro=true;}
    if(k==='retiro'){a.retiradoFisico=true;a.fechaRetiroFisico=new Date().toISOString();}
    if(k==='autorizacion')a.autorizacionCompleta=true;
    audit383(a,k);try{saveAtenciones();renderTabla?.();renderStats?.();renderAgenda?.()}catch(e){console.error(e)}renderPendientes383();
    undo383={id,prev};toastUndo383(labels383(k)+' resuelto');
  }
  window.resolverPendiente383=resolverPendiente383;
  function toastUndo383(msg){let t=document.getElementById('undoToast383');if(!t){t=document.createElement('div');t.id='undoToast383';t.className='undo-toast383';document.body.appendChild(t)}t.innerHTML=`<span>${esc383(msg)}</span><button type="button" onclick="deshacerPendiente383()">Deshacer</button>`;t.classList.add('show');clearTimeout(t._tm);t._tm=setTimeout(()=>{t.classList.remove('show');undo383=null},6500)}
  window.deshacerPendiente383=function(){if(!undo383)return;const i=(atenciones||[]).findIndex(x=>String(x.id)===String(undo383.id));if(i>=0){atenciones[i]=undo383.prev;saveAtenciones();renderPendientes383();renderTabla?.();renderStats?.()}document.getElementById('undoToast383')?.classList.remove('show');undo383=null};

  // Un único cálculo para dashboard/listados nuevos.
  const oldEval=typeof evaluarEstado==='function'?evaluarEstado:null;
  window.evaluarEstado=evaluarEstado=function(a){const p=pendientes383(a).filter(k=>k==='firma'||k==='copia');return p.length?{txt:'Falta: '+p.map(k=>k==='firma'?'firma':'copia').join(' + '),cls:'bad'}:{txt:'OK',cls:'ok'}};
  const oldBadges=typeof badgesInforme==='function'?badgesInforme:null;
  window.badgesInforme=badgesInforme=function(a){if(!isStudy(a))return '';const p=pendientes383(a),b=[];b.push(a.estudioInformado?'<span class="badge ok informe-badge">Informado</span>':'<span class="badge bad informe-badge">Pend. informe</span>');if(a.estudioImpreso)b.push('<span class="badge ok informe-badge">Impreso</span>');if(a.estudioEnviadoMail)b.push('<span class="badge ok informe-badge">Mail</span>');if(a.estudioEnviadoWS)b.push('<span class="badge ok informe-badge">WS</span>');if(a.retiradoFisico)b.push('<span class="badge ok informe-badge">Retirado</span>');else if(a.estudioImpreso&&!a.estudioEnviadoMail&&!a.estudioEnviadoWS)b.push('<span class="badge bad informe-badge">Pend. retiro</span>');else if(p.includes('entrega'))b.push('<span class="badge bad informe-badge">Pend. impresión/envío</span>');return `<div class="estado-informe">${b.join(' ')}</div>`};

  const originalSave=typeof saveAtenciones==='function'?saveAtenciones:null;
  if(originalSave&&!originalSave.__v383){const w=function(){(atenciones||[]).forEach(applyNA383);return originalSave.apply(this,arguments)};w.__v383=true;window.saveAtenciones=saveAtenciones=w;}
  (atenciones||[]).forEach(applyNA383);

  const oldShow=typeof showSection==='function'?showSection:null;
  if(oldShow&&!oldShow.__v383){const w=function(id){if(id==='pendientes383'){onlyOverdue383=false;document.querySelectorAll('.section').forEach(s=>s.classList.remove('visible'));document.getElementById(id)?.classList.add('visible');document.querySelectorAll('.nav').forEach(b=>b.classList.toggle('active',b.dataset.section===id));if(document.getElementById('tituloBienvenida'))document.getElementById('tituloBienvenida').textContent='Pendientes';if(document.getElementById('subtituloPerfil'))document.getElementById('subtituloPerfil').textContent='Bandeja operativa por fecha y tipo';renderPendientes383();return}return oldShow.apply(this,arguments)};w.__v383=true;window.showSection=showSection=w;}

  // Clicks de calidad de datos: abre listado editable en modal.
  function qualityPatients383(kind){const ps=(data.pacientes||[]).filter(p=>{if(kind==='dni')return !String(p.dni||'').trim();if(kind==='cobertura')return !String(p.obraSocial||p.cobertura||'').trim()||norm(p.obraSocial||p.cobertura).includes('matias anchorena');if(kind==='contacto')return !String(p.telefono||'').trim()&&!String(p.email||'').trim()&&!String(p.telefonoContacto||'').trim()&&!String(p.emailContacto||'').trim();if(kind==='nacimiento')return !String(p.fechaNacimiento||'').trim();return false});let m=document.getElementById('qualityModal383');if(!m){m=document.createElement('div');m.id='qualityModal383';m.className='modal-overlay-360 hidden';document.body.appendChild(m)}m.innerHTML=`<div class="quality-card383"><button class="modal-close-360" onclick="document.getElementById('qualityModal383').classList.add('hidden')">×</button><h2>Pacientes para completar</h2><p>${ps.length} registro(s)</p><div class="quality-list383">${ps.map(p=>`<div><strong>${esc383(p.apellidoNombre||p.nombreCompleto||p.nombre||'Paciente')}</strong><span>DNI ${esc383(p.dni||'s/d')} · ${esc383(p.telefono||'sin contacto')}</span><button class="secondary" onclick="document.getElementById('qualityModal383').classList.add('hidden');editarPacienteGlobal350('${esc383(typeof pacienteClave==='function'?pacienteClave(p):(p.id||p.dni))}')">Editar</button></div>`).join('')||'<p>No hay registros.</p>'}</div></div>`;m.classList.remove('hidden')}
  window.qualityPatients383=qualityPatients383;

  function bind383(){
    document.querySelectorAll('#pendientesTabs383 [data-pendtab]').forEach(b=>b.addEventListener('click',()=>{currentTab=b.dataset.pendtab;onlyOverdue383=false;renderPendientes383()}));
    document.getElementById('btnRefreshPend383')?.addEventListener('click',renderPendientes383);
    document.getElementById('pendOrden383')?.addEventListener('change',renderPendientes383);
    document.getElementById('pendBuscar383')?.addEventListener('input',renderPendientes383);
    document.querySelectorAll('.nav[data-section]').forEach(b=>{if(!b.dataset.v383){b.dataset.v383='1';b.addEventListener('click',()=>{if(b.dataset.section==='pendientes383')showSection('pendientes383')})}});
    // Enhance quality cards using their visible text
    document.querySelectorAll('#dataQuality382 .quality-item-382, .data-quality-grid-382 > *').forEach(el=>{const t=norm(el.textContent);let k=t.includes('sin dni')?'dni':t.includes('cobertura incompleta')?'cobertura':t.includes('sin contacto')?'contacto':t.includes('sin fecha')?'nacimiento':'';if(k){el.classList.add('clickable383');el.addEventListener('click',()=>qualityPatients383(k))}});
    renderPendientes383();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>setTimeout(bind383,500));else setTimeout(bind383,500);
})();


/* ===== CardioLink Admin v4.1.0-hc: completar fichas incompletas ===== */
(function init384(){
  const norm=v=>String(v??'').trim().toLowerCase();
  const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  let qualityKind384='dni';
  let qualityQuery384='';
  function activePatients384(){return (data?.pacientes||[]).filter(p=>!p.fusionadoEn&&!p.inactivo);}
  function badCoverage384(v){const x=norm(v);return !x||['undefined','null','no ingresado'].includes(x)||x.includes('matias anchorena')||x.includes('matías anchorena')||x.includes('rogelio anchorena')||x.includes('fernandez drago')||x.includes('fernández drago');}
  function missing384(p,k){
    if(k==='dni')return !String(p.dni||'').replace(/\D/g,'');
    if(k==='cobertura')return badCoverage384(p.coberturaHabitual||p.obraSocial||p.cobertura);
    if(k==='contacto')return !String(p.telefono||'').trim()&&!String(p.email||'').trim()&&!String(p.contactoResponsableTelefono||p.telefonoContacto||'').trim()&&!String(p.contactoResponsableEmail||p.emailContacto||'').trim();
    if(k==='nacimiento')return !String(p.fechaNacimiento||'').trim();
    return false;
  }
  function patientName384(p){return p.apellidoNombre||p.nombreCompleto||p.paciente||p.nombre||'Paciente';}
  function patientKey384(p){try{return typeof pacienteClave==='function'?pacienteClave(p):(p.id||p.dni)}catch{return p.id||p.dni}}
  function osOptions384(current){
    const names=[...new Set(['',...(data?.obrasSociales||[]).map(x=>typeof x==='string'?x:(x.nombre||x.label||'')),...(data?.reglasOS||[]).map(x=>x.nombre||x.obraSocial||'')].filter((x,i,a)=>x||i===0))];
    return names.map(n=>`<option value="${esc(n)}" ${String(n)===String(current||'')?'selected':''}>${esc(n||'Seleccionar cobertura')}</option>`).join('');
  }
  function rows384(){
    let ps=activePatients384().filter(p=>missing384(p,qualityKind384));
    if(qualityQuery384){const q=norm(qualityQuery384);ps=ps.filter(p=>norm([patientName384(p),p.dni,p.telefono,p.email,p.coberturaHabitual,p.obraSocial].join(' ')).includes(q));}
    return ps.sort((a,b)=>patientName384(a).localeCompare(patientName384(b),'es'));
  }
  function input384(p){
    const id=esc(p.id||patientKey384(p));
    if(qualityKind384==='dni')return `<input id="q384_${id}_dni" inputmode="numeric" placeholder="DNI" value="${esc(p.dni||'')}">`;
    if(qualityKind384==='cobertura')return `<select id="q384_${id}_cob">${osOptions384(badCoverage384(p.coberturaHabitual||p.obraSocial||p.cobertura)?'':(p.coberturaHabitual||p.obraSocial||p.cobertura))}</select>`;
    if(qualityKind384==='nacimiento')return `<input id="q384_${id}_nac" type="date" value="${esc(p.fechaNacimiento||'')}">`;
    return `<div class="quality-contact384"><input id="q384_${id}_tel" inputmode="tel" placeholder="Teléfono paciente" value="${esc(p.telefono||'')}"><input id="q384_${id}_mail" type="email" placeholder="Email paciente" value="${esc(p.email||'')}"><input id="q384_${id}_rtel" inputmode="tel" placeholder="Teléfono responsable" value="${esc(p.contactoResponsableTelefono||p.telefonoContacto||'')}"><input id="q384_${id}_rmail" type="email" placeholder="Email responsable" value="${esc(p.contactoResponsableEmail||p.emailContacto||'')}"></div>`;
  }
  function renderQuality384(){
    const modal=document.getElementById('qualityModal383');if(!modal)return;
    const ps=rows384();
    const labels={dni:'Sin DNI',cobertura:'Cobertura incompleta',contacto:'Sin contacto',nacimiento:'Sin fecha de nacimiento'};
    modal.innerHTML=`<div class="quality-card383 quality-card384"><button class="modal-close-360" onclick="document.getElementById('qualityModal383').classList.add('hidden')">×</button><h2>Completar fichas de pacientes</h2><div class="quality-toolbar384"><label>Dato faltante<select id="qualityKind384"><option value="dni" ${qualityKind384==='dni'?'selected':''}>Sin DNI</option><option value="cobertura" ${qualityKind384==='cobertura'?'selected':''}>Cobertura incompleta</option><option value="contacto" ${qualityKind384==='contacto'?'selected':''}>Sin contacto</option><option value="nacimiento" ${qualityKind384==='nacimiento'?'selected':''}>Sin fecha de nacimiento</option></select></label><label>Buscar<input id="qualitySearch384" type="search" placeholder="Apellido, nombre o DNI" value="${esc(qualityQuery384)}"></label></div><p><strong>${ps.length}</strong> paciente(s) en “${labels[qualityKind384]}”. Completá el dato y guardá: el paciente sale automáticamente de la lista.</p><div class="quality-list384">${ps.map(p=>{const id=esc(p.id||patientKey384(p));return `<article class="quality-row384"><div class="quality-patient384"><strong>${esc(patientName384(p))}</strong><span>DNI ${esc(p.dni||'s/d')} · ${esc(p.telefono||'sin teléfono')} · ${esc(p.coberturaHabitual||p.obraSocial||'sin cobertura')}</span></div><div class="quality-edit384">${input384(p)}</div><div class="quality-actions384"><button class="primary" onclick="guardarCalidad384('${id}')">Guardar</button><button class="secondary" type="button" onclick="abrirFichaCompletaCalidad387('${esc(patientKey384(p))}')">Abrir ficha completa</button></div></article>`}).join('')||'<div class="empty383">No hay pacientes pendientes en esta categoría.</div>'}</div></div>`;
    document.getElementById('qualityKind384')?.addEventListener('change',e=>{qualityKind384=e.target.value;qualityQuery384='';renderQuality384()});
    document.getElementById('qualitySearch384')?.addEventListener('input',e=>{qualityQuery384=e.target.value;renderQuality384()});
  }
  window.qualityPatients383=function(kind){qualityKind384=kind||'dni';qualityQuery384='';let m=document.getElementById('qualityModal383');if(!m){m=document.createElement('div');m.id='qualityModal383';m.className='modal-overlay-360 hidden';document.body.appendChild(m)}renderQuality384();m.classList.remove('hidden');};
  window.guardarCalidad384=function(id){
    const p=(data?.pacientes||[]).find(x=>String(x.id||patientKey384(x))===String(id));if(!p)return;
    if(qualityKind384==='dni')p.dni=(document.getElementById(`q384_${id}_dni`)?.value||'').trim();
    if(qualityKind384==='cobertura'){const v=document.getElementById(`q384_${id}_cob`)?.value||'';p.coberturaHabitual=v;p.obraSocial=v;}
    if(qualityKind384==='nacimiento')p.fechaNacimiento=document.getElementById(`q384_${id}_nac`)?.value||'';
    if(qualityKind384==='contacto'){
      p.telefono=(document.getElementById(`q384_${id}_tel`)?.value||'').trim();p.email=(document.getElementById(`q384_${id}_mail`)?.value||'').trim();
      p.contactoResponsableTelefono=(document.getElementById(`q384_${id}_rtel`)?.value||'').trim();p.contactoResponsableEmail=(document.getElementById(`q384_${id}_rmail`)?.value||'').trim();
    }
    p.actualizadoEn=new Date().toISOString();
    try{saveConfig();if(typeof saveAtenciones==='function')saveAtenciones();renderQuality382?.();renderHealth382?.();renderPacientesPanel?.('',true);}catch(e){console.error(e)}
    renderQuality384();
  };
  // LTS: al tocar Revisar datos abre directamente la bandeja editable.
  document.addEventListener('click',e=>{
    const qualityButton=e.target?.closest?.('[data-quality-kind]');
    if(qualityButton){e.preventDefault();window.qualityPatients383(qualityButton.dataset.qualityKind);return;}
    if(e.target?.id==='btnRefreshQuality382'){e.preventDefault();window.qualityPatients383('dni');}
  },true);
})();

/* ===== CardioLink Admin v4.1.0-hc: calidad robusta + eliminación completa de paciente ===== */
(function init386(){
  const norm386=v=>String(v??'').trim().toLowerCase();
  const esc386=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  function nombre386(p){return p?.apellidoNombre||p?.nombreCompleto||p?.paciente||p?.nombre||'Paciente';}
  function clave386(p){try{return typeof pacienteClave==='function'?pacienteClave(p):(p?.id||p?.dni||nombre386(p));}catch{return p?.id||p?.dni||nombre386(p)}}
  function dni386(v){return String(v||'').replace(/\D/g,'');}
  function puedeEliminar386(){try{return typeof esAdmin==='function'?esAdmin():true}catch{return true}}
  function paciente386(key){
    const ps=(data?.pacientes||[]);
    let p=ps.find(x=>String(x.id||'')===String(key));
    if(!p) p=ps.find(x=>String(clave386(x))===String(key));
    if(!p){
      const todos=typeof todosPacientes==='function'?todosPacientes():ps;
      p=todos.find(x=>String(x.id||'')===String(key)||String(clave386(x))===String(key));
    }
    return p||null;
  }
  function atenciones386(p){
    if(!p)return[];
    const id=String(p.id||'');
    const d=dni386(p.dni);
    const n=norm386(nombre386(p));
    return (atenciones||[]).filter(a=>{
      if(a?.tipoRegistro==='config'||(typeof esMensajeInterno==='function'&&esMensajeInterno(a)))return false;
      if(id&&String(a.pacienteId||'')===id)return true;
      if(d&&dni386(a.dni)===d)return true;
      return !!n&&norm386(a.paciente||'')===n;
    });
  }
  async function eliminarPacienteCompleto386(key){
    if(!puedeEliminar386()){alert('Solo Matías / administración puede eliminar pacientes completos.');return false;}
    const p=paciente386(key);if(!p){alert('No encontré el paciente.');return false;}
    const relacionados=atenciones386(p);
    const nom=nombre386(p);
    const aviso=`Vas a eliminar definitivamente a ${nom}.\n\nTambién se eliminarán ${relacionados.length} consulta(s) o estudio(s) vinculados. Esta acción no se puede deshacer salvo restaurando un backup.\n\nEscribí ELIMINAR para confirmar:`;
    const escrito=prompt(aviso,'');
    if(escrito!=='ELIMINAR'){if(escrito!==null)alert('No se eliminó el paciente. La confirmación no coincidió.');return false;}
    const ids=new Set(relacionados.map(a=>String(a.id)));
    atenciones=(atenciones||[]).filter(a=>!ids.has(String(a.id)));
    if(!Array.isArray(data.pacientes))data.pacientes=[];
    const pk=String(p.id||''); const pclave=String(clave386(p)); const pdni=dni386(p.dni); const pnom=norm386(nombre386(p));
    data.pacientes=data.pacientes.filter(x=>{
      if(pk&&String(x.id||'')===pk)return false;
      if(String(clave386(x))===pclave)return false;
      if(pdni&&dni386(x.dni)===pdni)return false;
      return !(pnom&&norm386(nombre386(x))===pnom&&!dni386(x.dni));
    });
    if(!Array.isArray(data.auditoriaPacientes))data.auditoriaPacientes=[];
    data.auditoriaPacientes.push({tipo:'eliminacion_paciente',pacienteId:p.id||'',paciente:nom,dni:p.dni||'',atencionesEliminadas:relacionados.length,usuario:(typeof usrActual==='function'?usrActual():'administrador'),fecha:new Date().toISOString()});
    try{saveConfig();saveAtenciones();await (typeof guardarConfigEnSupabase298==='function'?guardarConfigEnSupabase298():Promise.resolve());await (typeof sincronizarAtencionesSupabase==='function'?sincronizarAtencionesSupabase(true):Promise.resolve());}catch(e){console.error(e);alert('Se eliminó localmente, pero la sincronización falló. Volvé a iniciar sesión y sincronizá.');}
    try{document.getElementById('qualityModal383')?.classList.add('hidden');document.getElementById('pacienteGlobalModal')?.classList.add('hidden');renderPacientesPanel?.('',true);renderQuality382?.();renderHealth382?.();renderPendientes383?.();}catch(e){}
    const det=document.getElementById('pacienteDetalle');if(det)det.innerHTML='<h3>Paciente eliminado</h3><p class="muted">El registro y sus atenciones vinculadas fueron eliminados.</p>';
    alert(`Paciente eliminado: ${nom}. Registros vinculados eliminados: ${relacionados.length}.`);
    return true;
  }
  window.eliminarPacienteCompleto386=eliminarPacienteCompleto386;

  // Bandeja de calidad robusta. Reemplaza el render anterior y agrega eliminar paciente.
  const qualityOld386=window.qualityPatients383;
  window.qualityPatients383=function(kind){
    if(['dni','cobertura','contacto','nacimiento'].includes(kind)){
      try{
        // La implementación v3.8.5 conserva estado interno; la invocamos primero.
        qualityOld386?.(kind);
        setTimeout(()=>{
          const modal=document.getElementById('qualityModal383');
          if(!modal)return;
          modal.querySelectorAll('.quality-row384').forEach(row=>{
            if(row.querySelector('.delete-patient386'))return;
            const full=row.querySelector('[onclick*="editarPacienteGlobal350"]');
            const onclick=full?.getAttribute('onclick')||'';
            const m=onclick.match(/editarPacienteGlobal350\('([^']+)'\)/);
            if(!m)return;
            const key=m[1];
            const btn=document.createElement('button');btn.type='button';btn.className='danger delete-patient386';btn.textContent='Eliminar paciente';btn.addEventListener('click',()=>eliminarPacienteCompleto386(key));
            row.querySelector('.quality-actions384')?.appendChild(btn);
          });
        },0);
        return;
      }catch(e){console.error(e);}
    }
    return qualityOld386?.(kind);
  };

  // Delegación reforzada: especialmente Cobertura incompleta, aunque el contenido se vuelva a renderizar.
  document.addEventListener('click',e=>{
    let el=e.target?.closest?.('[data-quality-kind]');
    if(el){e.preventDefault();e.stopPropagation();window.qualityPatients383(el.dataset.qualityKind);return;}
    el=e.target?.closest?.('#dataQuality382 .quality-item-382');
    if(!el)return;
    const t=norm386(el.textContent);
    const kind=t.includes('cobertura incompleta')?'cobertura':t.includes('sin dni')?'dni':t.includes('sin contacto')?'contacto':t.includes('sin fecha de nacimiento')?'nacimiento':'';
    if(kind){e.preventDefault();e.stopPropagation();window.qualityPatients383(kind);}
  },true);

  // Botón Eliminar en ficha de Pacientes.
  const selOld386=typeof seleccionarPacientePanel==='function'?seleccionarPacientePanel:null;
  if(selOld386){window.seleccionarPacientePanel=seleccionarPacientePanel=function(id){const r=selOld386.apply(this,arguments);setTimeout(()=>{const actions=document.querySelector('#pacienteDetalle .paciente-ficha-actions');if(actions&&!actions.querySelector('.delete-patient386')){const b=document.createElement('button');b.type='button';b.className='danger delete-patient386';b.textContent='Eliminar paciente';b.onclick=()=>eliminarPacienteCompleto386(id);actions.appendChild(b);}},0);return r;};}

  // Botón Eliminar en ficha emergente global.
  const openOld386=typeof abrirPacienteGlobalDetalle350==='function'?abrirPacienteGlobalDetalle350:null;
  if(openOld386){window.abrirPacienteGlobalDetalle350=abrirPacienteGlobalDetalle350=function(k){const r=openOld386.apply(this,arguments);setTimeout(()=>{const actions=document.querySelector('#pacienteGlobalBody .paciente-global-actions-top');if(actions&&!actions.querySelector('.delete-patient386')){const b=document.createElement('button');b.type='button';b.className='danger delete-patient386';b.textContent='Eliminar paciente';b.onclick=()=>eliminarPacienteCompleto386(k);actions.appendChild(b);}},0);return r;};}

  function refrescarVersion386(){
    document.querySelectorAll('.brand-main span,.mobile-app-title-370 span').forEach(x=>x.textContent='v4.1.0-hc');
    document.title='CardioLink Admin v4.1.0-hc';
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>setTimeout(refrescarVersion386,300));else setTimeout(refrescarVersion386,300);
})();


/* ===== CardioLink Admin v4.1.0-hc: abrir ficha completa desde calidad de datos ===== */
(function init387(){
  window.abrirFichaCompletaCalidad387=function(key){
    try{
      const quality=document.getElementById('qualityModal383');
      if(quality) quality.classList.add('hidden');
      // Abre la ficha emergente unificada sin cambiar de solapa ni volver a Configuración.
      if(typeof window.abrirPacienteGlobalDetalle350==='function'){
        window.abrirPacienteGlobalDetalle350(key);
      }else if(typeof window.abrirPacienteGlobal320==='function'){
        window.abrirPacienteGlobal320(key);
      }else{
        alert('No se pudo abrir la ficha completa del paciente.');
      }
      // Refuerzo para que el modal quede por encima de Configuración en todos los navegadores.
      setTimeout(()=>{
        const modal=document.getElementById('pacienteGlobalModal');
        if(modal){
          modal.classList.remove('hidden');
          modal.style.zIndex='10050';
          const focusable=modal.querySelector('button, input, select, textarea');
          focusable?.focus?.({preventScroll:true});
        }
      },0);
    }catch(e){
      console.error('Error al abrir ficha completa desde calidad de datos',e);
      alert('No se pudo abrir la ficha completa del paciente.');
    }
  };

  function version387(){
    document.querySelectorAll('.brand-main span,.mobile-app-title-370 span').forEach(x=>x.textContent='v4.1.0-hc');
    document.title='CardioLink Admin v4.1.0-hc';
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',()=>setTimeout(version387,300));
  else setTimeout(version387,300);
})();


/* ===== CardioLink Admin v4.1.0-hc: ficha administrativa ampliada ===== */
(function init390(){
  function version390(){
    document.querySelectorAll('.brand-main span,.mobile-app-title-370 span').forEach(x=>x.textContent='v4.1.0-hc');
    document.querySelectorAll('h2').forEach(x=>{if(/^CardioLink Admin v3\.8\.7$/.test(x.textContent.trim()))x.textContent='CardioLink Admin v4.1.0-hc';});
    document.title='CardioLink Admin v4.1.0-hc';
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>setTimeout(version390,500));else setTimeout(version390,500);
})();


/* ===== CardioLink Admin v4.1.0-hc: calidad de datos con fuente unificada ===== */
(function initQuality310(){
  'use strict';
  const VERSION='4.1.0-hc';
  const labels={
    dni:'Sin DNI', cobertura:'Cobertura incompleta', contacto:'Sin teléfono / contacto',
    nacimiento:'Sin fecha de nacimiento', sexo:'Sin sexo', localidad:'Sin localidad',
    direccion:'Sin dirección', provincia:'Sin provincia'
  };
  const norm=v=>String(v??'').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const digits=v=>String(v??'').replace(/\D/g,'');
  const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const name=p=>p?.apellidoNombre||p?.nombreCompleto||p?.paciente||p?.nombre||'Paciente';
  const key=p=>{try{return typeof pacienteClave==='function'?pacienteClave(p):(p?.id||p?.dni||name(p));}catch{return p?.id||p?.dni||name(p)}};

  function sourcePatients(){
    try{
      const src=typeof todosPacientes==='function' ? todosPacientes() : (Array.isArray(data?.pacientes)?data.pacientes:[]);
      return (Array.isArray(src)?src:[]).filter(p=>p && p.estado!=='fusionado' && !p.fusionadoEn && !p.inactivo);
    }catch(e){console.error('Calidad: no se pudieron leer pacientes',e);return []}
  }
  function badCoverage(v){
    const s=norm(v);
    return !s || ['undefined','null','no ingresado','sin cobertura','s/d','incompleto'].includes(s) ||
      s.includes('matias anchorena') || s.includes('rogelio anchorena') || s.includes('fernandez drago');
  }
  function missing(p,k){
    if(k==='dni') return !digits(p?.dni);
    if(k==='cobertura') return badCoverage(p?.coberturaHabitual||p?.obraSocial||p?.cobertura);
    if(k==='contacto') return !String(p?.telefono||p?.tel||'').trim() && !String(p?.email||'').trim() &&
      !String(p?.contactoResponsableTelefono||p?.telefonoContacto||'').trim() &&
      !String(p?.contactoResponsableEmail||p?.emailContacto||'').trim();
    if(k==='nacimiento') return !String(p?.fechaNacimiento||'').trim();
    if(k==='sexo') return !String(p?.sexo||'').trim();
    if(k==='localidad') return !String(p?.localidad||'').trim();
    if(k==='direccion') return !String(p?.direccion||'').trim();
    if(k==='provincia') return !String(p?.provincia||'').trim();
    return false;
  }
  function persistentPatient(p){
    try{
      if(typeof asegurarPacientePersistente==='function') return asegurarPacientePersistente(p);
      if(!Array.isArray(data.pacientes)) data.pacientes=[];
      let dest=data.pacientes.find(x=>String(x.id||'')===String(p.id||''));
      const d=digits(p.dni);
      if(!dest&&d)dest=data.pacientes.find(x=>digits(x.dni)===d);
      if(!dest){dest={...p,id:(String(p.id||'').startsWith('legacy_')||!p.id)?'pac_'+Date.now()+'_'+Math.random().toString(36).slice(2,7):p.id};data.pacientes.push(dest)}
      return dest;
    }catch(e){console.error('Calidad: no se pudo persistir paciente',e);return null}
  }
  function report(){
    const ps=sourcePatients(); const counts={total:ps.length};
    Object.keys(labels).forEach(k=>counts[k]=ps.filter(p=>missing(p,k)).length);
    const map=new Map();ps.forEach(p=>{const d=digits(p.dni);if(d)map.set(d,(map.get(d)||0)+1)});
    counts.duplicados=[...map.values()].filter(n=>n>1).reduce((a,n)=>a+n,0);
    return counts;
  }
  window.renderQuality382=function(){
    const root=document.getElementById('dataQuality382'); if(!root)return;
    const r=report();
    root.innerHTML=`<div class="quality-item-382 ok"><span>Pacientes activos</span><b>${r.total}</b></div>`+
      Object.keys(labels).map(k=>`<button type="button" class="quality-item-382 quality-action-385 ${r[k]?'warn':'ok'}" data-quality310="${k}"><span>${labels[k]}</span><b>${r[k]}</b></button>`).join('')+
      `<div class="quality-item-382 ${r.duplicados?'danger':'ok'}"><span>DNI duplicados</span><b>${r.duplicados}</b></div>`;
  };

  let currentKind='dni', currentQuery='';
  function filteredRows(){
    let ps=sourcePatients().filter(p=>missing(p,currentKind));
    if(currentQuery){const q=norm(currentQuery);ps=ps.filter(p=>norm([name(p),p.dni,p.telefono,p.email,p.localidad,p.sexo,p.coberturaHabitual,p.obraSocial].join(' ')).includes(q))}
    return ps.sort((a,b)=>name(a).localeCompare(name(b),'es'));
  }
  function coverageOptions(current){
    const raw=['',...(data?.obrasSociales||[]).map(x=>typeof x==='string'?x:(x?.nombre||x?.label||''))];
    const list=[...new Set(raw.filter((v,i)=>i===0||v))];
    return list.map(v=>`<option value="${esc(v)}" ${String(v)===String(current||'')?'selected':''}>${esc(v||'Seleccionar cobertura')}</option>`).join('');
  }
  function field(p,domId){
    if(currentKind==='dni')return `<input id="q310_${domId}_dni" inputmode="numeric" placeholder="DNI" value="${esc(p.dni||'')}">`;
    if(currentKind==='cobertura')return `<select id="q310_${domId}_cob">${coverageOptions(badCoverage(p.coberturaHabitual||p.obraSocial||p.cobertura)?'':(p.coberturaHabitual||p.obraSocial||p.cobertura))}</select>`;
    if(currentKind==='nacimiento')return `<input id="q310_${domId}_nac" type="date" value="${esc(p.fechaNacimiento||'')}">`;
    if(currentKind==='sexo')return `<select id="q310_${domId}_sexo"><option value="">No definido</option><option value="Masculino" ${p.sexo==='Masculino'?'selected':''}>Masculino</option><option value="Femenino" ${p.sexo==='Femenino'?'selected':''}>Femenino</option><option value="Otro" ${p.sexo==='Otro'?'selected':''}>Otro</option></select>`;
    if(currentKind==='localidad')return `<input id="q310_${domId}_localidad" placeholder="Localidad" value="${esc(p.localidad||'')}">`;
    if(currentKind==='direccion')return `<input id="q310_${domId}_direccion" placeholder="Dirección" value="${esc(p.direccion||'')}">`;
    if(currentKind==='provincia')return `<input id="q310_${domId}_provincia" placeholder="Provincia" value="${esc(p.provincia||'')}">`;
    return `<div class="quality-contact384"><input id="q310_${domId}_tel" inputmode="tel" placeholder="Teléfono" value="${esc(p.telefono||'')}"><input id="q310_${domId}_mail" type="email" placeholder="Email" value="${esc(p.email||'')}"><input id="q310_${domId}_rtel" inputmode="tel" placeholder="Teléfono responsable" value="${esc(p.contactoResponsableTelefono||p.telefonoContacto||'')}"><input id="q310_${domId}_rmail" type="email" placeholder="Email responsable" value="${esc(p.contactoResponsableEmail||p.emailContacto||'')}"></div>`;
  }
  function ensureModal(){
    let m=document.getElementById('qualityModal383');
    if(!m){m=document.createElement('div');m.id='qualityModal383';m.className='modal-overlay-360 hidden';document.body.appendChild(m)}
    return m;
  }
  function renderModal(){
    const m=ensureModal(), ps=filteredRows();
    m.innerHTML=`<div class="quality-card383 quality-card384"><button class="modal-close-360" type="button" data-q310-close>×</button><h2>Completar fichas de pacientes</h2><div class="quality-toolbar384"><label>Dato faltante<select data-q310-kind>${Object.entries(labels).map(([k,l])=>`<option value="${k}" ${currentKind===k?'selected':''}>${l}</option>`).join('')}</select></label><label>Buscar<input data-q310-search type="search" placeholder="Apellido, nombre o DNI" value="${esc(currentQuery)}"></label></div><p><strong>${ps.length}</strong> paciente(s) en “${labels[currentKind]}”.</p><div class="quality-list384">${ps.map(p=>{const raw=String(p.id||key(p));const dom=raw.replace(/[^a-zA-Z0-9_-]/g,'_');return `<article class="quality-row384"><div class="quality-patient384"><strong>${esc(name(p))}</strong><span>DNI ${esc(p.dni||'s/d')} · ${esc(p.telefono||'sin teléfono')} · ${esc(p.coberturaHabitual||p.obraSocial||p.cobertura||'sin cobertura')}</span></div><div class="quality-edit384">${field(p,dom)}</div><div class="quality-actions384"><button class="primary" type="button" data-q310-save="${esc(raw)}" data-q310-dom="${dom}">Guardar</button><button class="secondary" type="button" data-q310-open="${esc(key(p))}">Abrir ficha completa</button></div></article>`}).join('')||'<div class="empty383">No hay pacientes pendientes en esta categoría.</div>'}</div></div>`;
  }
  function savePatient(raw,dom){
    const src=sourcePatients().find(p=>String(p.id||key(p))===String(raw)); if(!src)return;
    const p=persistentPatient(src); if(!p)return;
    const val=id=>document.getElementById(id)?.value||'';
    if(currentKind==='dni')p.dni=val(`q310_${dom}_dni`).trim();
    else if(currentKind==='cobertura'){const v=val(`q310_${dom}_cob`);p.coberturaHabitual=v;p.obraSocial=v;p.cobertura=v}
    else if(currentKind==='nacimiento')p.fechaNacimiento=val(`q310_${dom}_nac`);
    else if(currentKind==='sexo')p.sexo=val(`q310_${dom}_sexo`);
    else if(currentKind==='localidad')p.localidad=val(`q310_${dom}_localidad`).trim();
    else if(currentKind==='direccion')p.direccion=val(`q310_${dom}_direccion`).trim();
    else if(currentKind==='provincia')p.provincia=val(`q310_${dom}_provincia`).trim();
    else {p.telefono=val(`q310_${dom}_tel`).trim();p.email=val(`q310_${dom}_mail`).trim();p.contactoResponsableTelefono=val(`q310_${dom}_rtel`).trim();p.contactoResponsableEmail=val(`q310_${dom}_rmail`).trim()}
    p.actualizadoEn=new Date().toISOString();
    try{saveConfig();if(typeof guardarConfigEnSupabase298==='function')guardarConfigEnSupabase298();renderPacientesPanel?.('',true)}catch(e){console.error('Calidad: error guardando',e)}
    window.renderQuality382();renderModal();
  }
  window.qualityPatients383=function(kind='dni'){
    currentKind=Object.prototype.hasOwnProperty.call(labels,kind)?kind:'dni';currentQuery='';
    const m=ensureModal();renderModal();m.classList.remove('hidden');m.style.zIndex='10040';
  };

  document.addEventListener('click',e=>{
    const card=e.target.closest?.('[data-quality310]');
    if(card){e.preventDefault();window.qualityPatients383(card.dataset.quality310);return}
    if(e.target.closest?.('[data-q310-close]')){ensureModal().classList.add('hidden');return}
    const save=e.target.closest?.('[data-q310-save]');if(save){savePatient(save.dataset.q310Save,save.dataset.q310Dom);return}
    const open=e.target.closest?.('[data-q310-open]');if(open){ensureModal().classList.add('hidden');if(typeof window.abrirFichaCompletaCalidad387==='function')window.abrirFichaCompletaCalidad387(open.dataset.q310Open);else{showSection('pacientes');setTimeout(()=>seleccionarPacientePanel?.(open.dataset.q310Open),80)}return}
    if(e.target.closest?.('#btnRefreshQuality382')){window.renderQuality382();return}
  });
  document.addEventListener('change',e=>{if(e.target.matches?.('[data-q310-kind]')){currentKind=e.target.value;currentQuery='';renderModal()}});
  document.addEventListener('input',e=>{if(e.target.matches?.('[data-q310-search]')){currentQuery=e.target.value;renderModal();document.querySelector('[data-q310-search]')?.focus()}});

  function setVersion(){
    document.title=`CardioLink Admin v${VERSION}`;
    document.querySelectorAll('.brand-main span,.mobile-app-title-370 span').forEach(el=>el.textContent=`v${VERSION}`);
    document.querySelectorAll('.login-meta').forEach(el=>el.textContent=`Versión ${VERSION} · 2026`);
  }
  function boot(){setVersion();window.renderQuality382();setTimeout(window.renderQuality382,1200);setTimeout(window.renderQuality382,3500)}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();

/* ===== CardioLink Admin v4.1.0-hc — Administración Inteligente ===== */
(function(){
  'use strict';
  const VERSION='4.1.0-hc';
  const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const slug=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'')||('item_'+Date.now());

  function ensureSmartConfig(){
    data.roles=Array.isArray(data.roles)?data.roles:[];
    const roleDefaults=[
      {id:'admin',nombre:'Administrador',baseRole:'admin',activo:true},
      {id:'director_medico',nombre:'Director Médico',baseRole:'admin',activo:true},
      {id:'medico',nombre:'Médico',baseRole:'medico',activo:true},
      {id:'secretaria',nombre:'Secretaría',baseRole:'secretaria',activo:true}
    ];
    roleDefaults.forEach(r=>{if(!data.roles.some(x=>x.id===r.id))data.roles.push(r)});

    data.especialidades=Array.isArray(data.especialidades)?data.especialidades:[];
    ['Cardiología','Medicina Intensiva','Diagnóstico por Imágenes'].forEach(nombre=>{
      const id=slug(nombre); if(!data.especialidades.some(x=>x.id===id||String(x.nombre).toLowerCase()===nombre.toLowerCase()))data.especialidades.push({id,nombre,activo:true});
    });

    (data.profesionales||[]).forEach(p=>{
      if(!Array.isArray(p.especialidadIds))p.especialidadIds=[];
      const area=String(p.area||'').toLowerCase();
      if(p.id==='matias'){
        ['cardiologia','medicina_intensiva'].forEach(id=>{if(!p.especialidadIds.includes(id))p.especialidadIds.push(id)});
        p.area='Cardiología / Medicina Intensiva';
      } else {
        data.especialidades.forEach(e=>{if(area.includes(String(e.nombre).toLowerCase())&&!p.especialidadIds.includes(e.id))p.especialidadIds.push(e.id)});
      }
      if(p.activo===undefined)p.activo=true;
    });
    (data.usuarios||[]).forEach(u=>{
      if(!u.rolId)u.rolId=u.rol||'medico';
      if(!Array.isArray(u.especialidadIds)){
        u.especialidadIds=[];
        const txt=String(u.especialidad||'').toLowerCase();
        data.especialidades.forEach(e=>{if(txt.includes(String(e.nombre).toLowerCase()))u.especialidadIds.push(e.id)});
      }
    });
  }

  function selectedSpecialties(){return [...document.querySelectorAll('#cfgEspecialidadesProfesional310 input:checked')].map(x=>x.value)}
  function roleOptions(value){return (data.roles||[]).filter(r=>r.activo!==false||r.id===value).map(r=>`<option value="${esc(r.id)}" ${r.id===value?'selected':''}>${esc(r.nombre)}</option>`).join('')}

  function injectCards(){
    const grid=document.querySelector('#config .config-grid'); if(!grid||document.getElementById('cfgRoles310'))return;
    const wrap=document.createElement('div'); wrap.id='cfgRoles310'; wrap.className='config-smart-card-310'; wrap.dataset.configGroupCard='usuarios';wrap.dataset.configAccess='admin';wrap.classList.toggle('hidden-permission',!puedeGestionarConfigAdministrativa());
    wrap.innerHTML=`<h3>Roles editables</h3><p class="muted">El rol define permisos. Podés crear nuevos roles tomando como base Administrador, Médico o Secretaría.</p><div class="inline-form"><input id="nuevoRol310" placeholder="Nombre del rol"><select id="baseRol310"><option value="medico">Base Médico</option><option value="secretaria">Base Secretaría</option><option value="admin">Base Administrador</option></select><button class="primary" id="addRol310" type="button">Agregar</button></div><ul id="listaRoles310"></ul>`;
    grid.insertBefore(wrap,grid.firstChild);

    const esp=document.createElement('div'); esp.id='cfgEspecialidades310'; esp.className='config-smart-card-310'; esp.dataset.configGroupCard='profesionales';
    esp.innerHTML=`<h3>Especialidades editables</h3><p class="muted">Cada profesional puede tener una o varias especialidades.</p><div class="inline-form"><input id="nuevaEspecialidad310" placeholder="Nueva especialidad"><button class="primary" id="addEspecialidad310" type="button">Agregar</button></div><ul id="listaEspecialidades310"></ul>`;
    grid.insertBefore(esp,wrap.nextSibling);

    const perfil=document.createElement('div'); perfil.id='cfgPerfilProfesional310'; perfil.className='config-smart-card-310 full-config-card'; perfil.dataset.configGroupCard='profesionales';
    perfil.innerHTML=`<h3>Perfil profesional</h3><p class="muted">Editá nombre, área visible, estado y especialidades sin tocar el código.</p><div class="profile-editor-310"><label>Profesional<select id="cfgProfEditar310"></select></label><label>Nombre<input id="cfgProfNombre310"></label><label>Área visible<input id="cfgProfArea310"></label><label class="check-row-310"><input type="checkbox" id="cfgProfActivo310"> Profesional activo</label><div><strong>Especialidades</strong><div id="cfgEspecialidadesProfesional310" class="checks-grid-310"></div></div><button class="primary" id="guardarPerfil310" type="button">Guardar perfil profesional</button></div>`;
    grid.insertBefore(perfil,esp.nextSibling);
  }

  function renderSmartConfig(){
    ensureSmartConfig(); injectCards();
    const lr=document.getElementById('listaRoles310');
    if(lr)lr.innerHTML=data.roles.map(r=>`<li><strong>${esc(r.nombre)}</strong> <span class="muted">Base: ${esc(r.baseRole)}</span> ${['admin','director_medico','medico','secretaria'].includes(r.id)?'':`<button class="small-btn" data-del-role310="${esc(r.id)}">Borrar</button>`}</li>`).join('');
    const le=document.getElementById('listaEspecialidades310');
    if(le)le.innerHTML=data.especialidades.map(e=>`<li>${esc(e.nombre)} <button class="small-btn" data-del-esp310="${esc(e.id)}">Borrar</button></li>`).join('');
    const ps=document.getElementById('cfgProfEditar310');
    if(ps){const old=ps.value;ps.innerHTML=(data.profesionales||[]).filter(p=>p.id!=='general').map(p=>`<option value="${esc(p.id)}">${esc(p.nombre)}</option>`).join('');if([...ps.options].some(o=>o.value===old))ps.value=old;loadProfessional();}
    const usrRole=document.getElementById('usrRol'); if(usrRole){const current=usrRole.value;usrRole.innerHTML=roleOptions(current);}
  }

  function loadProfessional(){
    const id=document.getElementById('cfgProfEditar310')?.value; const p=(data.profesionales||[]).find(x=>x.id===id); if(!p)return;
    document.getElementById('cfgProfNombre310').value=p.nombre||'';
    document.getElementById('cfgProfArea310').value=p.area||'';
    document.getElementById('cfgProfActivo310').checked=p.activo!==false;
    const box=document.getElementById('cfgEspecialidadesProfesional310');
    if(box)box.innerHTML=(data.especialidades||[]).filter(e=>e.activo!==false).map(e=>`<label><input type="checkbox" value="${esc(e.id)}" ${(p.especialidadIds||[]).includes(e.id)?'checked':''}> ${esc(e.nombre)}</label>`).join('');
  }
  function saveProfessional(){
    const p=(data.profesionales||[]).find(x=>x.id===document.getElementById('cfgProfEditar310')?.value);if(!p)return;
    p.nombre=document.getElementById('cfgProfNombre310').value.trim()||p.nombre;
    p.area=document.getElementById('cfgProfArea310').value.trim();p.activo=document.getElementById('cfgProfActivo310').checked;p.especialidadIds=selectedSpecialties();
    saveConfig();refreshSelects();renderConfig();alert('Perfil profesional guardado.');
  }
  function addRole(){if(!exigirConfigAdministrativa('Tu perfil no puede crear roles ni permisos.'))return;const input=document.getElementById('nuevoRol310');const nombre=input.value.trim();if(!nombre)return;let id=slug(nombre);if(data.roles.some(r=>r.id===id))id+='_'+Date.now();data.roles.push({id,nombre,baseRole:document.getElementById('baseRol310').value,activo:true});input.value='';saveConfig();renderSmartConfig();}
  function addSpecialty(){const input=document.getElementById('nuevaEspecialidad310');const nombre=input.value.trim();if(!nombre)return;const id=slug(nombre);if(!data.especialidades.some(e=>e.id===id))data.especialidades.push({id,nombre,activo:true});input.value='';saveConfig();renderSmartConfig();}

  const oldRender=window.renderConfig;
  window.renderConfig=function(){if(typeof oldRender==='function')oldRender();renderSmartConfig();};

  document.addEventListener('click',e=>{
    if(e.target.id==='addRol310')addRole();
    if(e.target.id==='addEspecialidad310')addSpecialty();
    if(e.target.id==='guardarPerfil310')saveProfessional();
    const dr=e.target.closest('[data-del-role310]');if(dr){if(!exigirConfigAdministrativa('Tu perfil no puede borrar roles ni permisos.'))return;const id=dr.dataset.delRole310;if(confirm('¿Borrar este rol?')){data.roles=data.roles.filter(r=>r.id!==id);saveConfig();renderSmartConfig();}}
    const de=e.target.closest('[data-del-esp310]');if(de){const id=de.dataset.delEsp310;if(confirm('¿Borrar esta especialidad?')){data.especialidades=data.especialidades.filter(x=>x.id!==id);(data.profesionales||[]).forEach(p=>p.especialidadIds=(p.especialidadIds||[]).filter(x=>x!==id));saveConfig();renderSmartConfig();}}
  });
  document.addEventListener('change',e=>{if(e.target.id==='cfgProfEditar310')loadProfessional();});

  function setVersion(){
    document.title=`CardioLink Admin v${VERSION}`;
    document.querySelectorAll('.brand-main span,.mobile-app-title-370 span').forEach(el=>el.textContent=`v${VERSION}`);
    document.querySelectorAll('.login-meta').forEach(el=>el.textContent=`Versión ${VERSION} · 2026`);
    document.querySelectorAll('h2').forEach(el=>{if(/^CardioLink Admin v/.test((el.textContent||'').trim()))el.textContent=`CardioLink Admin v${VERSION}`});
  }
  function boot(){ensureSmartConfig();saveConfig();injectCards();renderSmartConfig();setVersion();document.body.classList.add('app-ready-310');
    // El contador se calcula al iniciar y vuelve a calcularse luego de sincronizar.
    try{window.renderPendientes383?.()}catch(e){}
    setTimeout(()=>{try{window.renderPendientes383?.();renderStats?.()}catch(e){}},500);
    setTimeout(()=>{try{window.renderPendientes383?.();renderStats?.()}catch(e){}},1800);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();


/* ===== CardioLink Admin v4.1.0-hc — usuarios editables + badge inmediato + logout estable ===== */
(function(){
  const VERSION_3101='4.1.0-hc';
  const byId=id=>document.getElementById(id);
  const esc3101=v=>typeof escapeHtml==='function'?escapeHtml(v):String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  let editingUserId3101='';

  function normalizeVersion3101(){
    document.title=`CardioLink Admin v${VERSION_3101}`;
    document.querySelectorAll('.brand-main span,.mobile-app-title-370 span').forEach(el=>el.textContent=`v${VERSION_3101}`);
    document.querySelectorAll('.login-meta').forEach(el=>el.textContent=`Versión ${VERSION_3101} · 2026`);
    document.querySelectorAll('h2').forEach(el=>{if(/^CardioLink Admin v/i.test((el.textContent||'').trim()))el.textContent=`CardioLink Admin v${VERSION_3101}`;});
  }

  function stableLogout3101(){
    const btn=byId('btnCerrarSesion');
    const sidebar=document.querySelector('.sidebar');
    if(!btn)return;
    if(sidebar && btn.parentElement!==sidebar)sidebar.appendChild(btn);
    const ready=document.body.classList.contains('app-ready-310')||document.body.classList.contains('app-ready-360');
    Object.assign(btn.style,{
      position:'static',left:'auto',right:'auto',bottom:'auto',width:'auto',maxWidth:'220px',minWidth:'140px',
      margin:'10px 0 0',zIndex:'1',boxShadow:'none',alignSelf:'flex-start',justifyContent:'center',
      display:ready?'inline-flex':'none',visibility:ready?'visible':'hidden',opacity:ready?'1':'0'
    });
  }

  function pendingSource3101(){
    try{
      const src=typeof atencionesPerfil==='function'?atencionesPerfil():(Array.isArray(window.atenciones)?window.atenciones:(typeof atenciones!=='undefined'?atenciones:[]));
      return Array.isArray(src)?src:[];
    }catch{return Array.isArray(window.atenciones)?window.atenciones:[];}
  }
  function countPending3101(){
    const fn=window.pendientesDeAtencion383;
    if(typeof fn!=='function')return 0;
    return pendingSource3101().reduce((n,a)=>{try{return n+(fn(a).length?1:0)}catch{return n}},0);
  }
  function refreshPendingBadge3101(){
    const count=countPending3101();
    const badge=byId('badgePendientesNav383');
    if(badge){badge.textContent=String(count);badge.classList.toggle('zero',count===0);badge.setAttribute('aria-label',`${count} pendientes`);}
    const stat=byId('statPendientes');if(stat)stat.textContent=String(count);
    return count;
  }
  window.refreshPendingBadge3101=refreshPendingBadge3101;

  function resetUserForm3101(){
    editingUserId3101='';
    ['usrNombre','usrUsuario','usrEspecialidad'].forEach(id=>{const el=byId(id);if(el)el.value='';});
    if(byId('usrRol'))byId('usrRol').value='medico';
    if(byId('usrProfesionalId'))byId('usrProfesionalId').value='';
    const save=byId('btnAddUsuarioSistema');if(save)save.textContent='Agregar usuario';
    document.querySelectorAll('[data-edit-user3101]').forEach(x=>x.classList.remove('selected-user-3101'));
  }
  function loadUserForm3101(id){
    if(!exigirConfigAdministrativa('Tu perfil no puede consultar usuarios ni permisos.'))return;
    const u=(data.usuarios||[]).find(x=>String(x.id)===String(id));if(!u)return;
    editingUserId3101=String(u.id);
    if(byId('usrNombre'))byId('usrNombre').value=u.nombre||'';
    if(byId('usrUsuario'))byId('usrUsuario').value=usuarioLoginCorto(u.usuario||u.email||'');
    if(byId('usrRol'))byId('usrRol').value=u.rol||'medico';
    if(byId('usrProfesionalId'))byId('usrProfesionalId').value=u.profesionalId||'';
    if(byId('usrEspecialidad'))byId('usrEspecialidad').value=u.especialidad||'';
    const save=byId('btnAddUsuarioSistema');if(save)save.textContent='Guardar cambios';
    document.querySelectorAll('[data-edit-user3101]').forEach(x=>x.classList.toggle('selected-user-3101',x.dataset.editUser3101===editingUserId3101));
    byId('usrNombre')?.focus();
  }
  window.loadUserForm3101=loadUserForm3101;

  const oldRenderUsers3101=window.renderUsuariosConfig;
  window.renderUsuariosConfig=renderUsuariosConfig=function(){
    try{asegurarUsuariosConfig();}catch{}
    const lista=byId('listaUsuariosSistema');
    if(lista){
      lista.classList.add('users-list-3101');
      lista.innerHTML=(data.usuarios||[]).map(u=>{
        const prof=(data.profesionales||[]).find(p=>p.id===u.profesionalId);
        const acceso=esc3101(usuarioLoginCorto(u.usuario||u.email||''));
        return `<li><button type="button" class="user-edit-row-3101 ${String(u.id)===editingUserId3101?'selected-user-3101':''}" data-edit-user3101="${esc3101(u.id)}"><span><strong>${esc3101(u.nombre||u.usuario)}</strong><small>@${acceso} · ${esc3101(labelRol(u.rol))}${prof?' · Profesional: '+esc3101(prof.nombre):' · Sin profesional asociado'}${u.especialidad?' · '+esc3101(u.especialidad):''}</small></span><b>Editar</b></button></li>`;
      }).join('')||'<li class="muted">Sin usuarios configurados.</li>';
    }
    const profSel=byId('usrProfesionalId');
    if(profSel){const selected=profSel.value;profSel.innerHTML='<option value="">Sin profesional asociado</option>'+(data.profesionales||[]).filter(p=>p.id!=='general').map(p=>`<option value="${esc3101(p.id)}">${esc3101(p.nombre)}</option>`).join('');if([...profSel.options].some(o=>o.value===selected))profSel.value=selected;}
    let newBtn=byId('btnNuevoUsuario3101');
    const save=byId('btnAddUsuarioSistema');
    if(save&&!newBtn){newBtn=document.createElement('button');newBtn.id='btnNuevoUsuario3101';newBtn.type='button';newBtn.className='secondary';newBtn.textContent='Nuevo / limpiar';save.insertAdjacentElement('afterend',newBtn);}
  };

  document.addEventListener('click',e=>{
    const user=e.target.closest('[data-edit-user3101]');if(user){loadUserForm3101(user.dataset.editUser3101);return;}
    if(e.target.closest('#btnNuevoUsuario3101')){resetUserForm3101();return;}
    if(e.target.closest('.nav[data-section="pendientes383"]'))setTimeout(refreshPendingBadge3101,0);
  });

  // Cuando termina una carga o sincronización, actualiza la burbuja sin necesidad de abrir la solapa.
  if(typeof window.cargarAtencionesDesdeSupabase==='function'&&!window.cargarAtencionesDesdeSupabase.__badge3101){
    const original=window.cargarAtencionesDesdeSupabase;
    const wrapped=async function(){const r=await original.apply(this,arguments);refreshPendingBadge3101();setTimeout(refreshPendingBadge3101,250);return r;};
    wrapped.__badge3101=true;window.cargarAtencionesDesdeSupabase=cargarAtencionesDesdeSupabase=wrapped;
  }
  if(typeof window.saveAtenciones==='function'&&!window.saveAtenciones.__badge3101){
    const original=window.saveAtenciones;
    const wrapped=function(){const r=original.apply(this,arguments);queueMicrotask(refreshPendingBadge3101);return r;};
    wrapped.__badge3101=true;window.saveAtenciones=saveAtenciones=wrapped;
  }

  function boot3101(){
    normalizeVersion3101();
    try{window.renderUsuariosConfig?.();}catch(e){console.warn('Usuarios 4.1.0-hc',e)}
    refreshPendingBadge3101();stableLogout3101();
    [250,800,1600].forEach(ms=>setTimeout(()=>{normalizeVersion3101();refreshPendingBadge3101();stableLogout3101();},ms));
    // Refresco liviano: evita que el contador dependa de haber visitado la solapa.
    setInterval(()=>{refreshPendingBadge3101();stableLogout3101();normalizeVersion3101();},3000);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot3101);else boot3101();
})();


/* ===== CardioLink Admin v4.1.0-hc — Convenios, destinos y aranceles configurables ===== */
(function(){
  'use strict';
  const VERSION_3102='4.1.0-hc';
  const $3102=id=>document.getElementById(id);
  const esc3102=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const norm3102=s=>String(s??'').trim();
  const convenioDefaults3102=[
    {obraSocial:'IOMA',activo:true,regla:'IOMA_OSPRERA',destinoConsulta:'Matías',destinoEstudio:'Rogelio',facturadorConsulta:'Fold2 / FEMEBA',facturadorEstudio:'Fold2 / FEMEBA',bonoConsulta:true,bonoEstudio:true,firmaRequerida:true,copiaRequerida:true,incluirFacturaRogelio:true},
    {obraSocial:'OSPRERA',activo:true,regla:'IOMA_OSPRERA',destinoConsulta:'Matías',destinoEstudio:'Rogelio',facturadorConsulta:'Fold2 / FEMEBA',facturadorEstudio:'Fold2 / FEMEBA',bonoConsulta:true,bonoEstudio:true,firmaRequerida:true,copiaRequerida:true,incluirFacturaRogelio:true},
    {obraSocial:'OSDE',activo:true,regla:'OSDE',destinoConsulta:'Matías',destinoEstudio:'Rogelio',facturadorConsulta:'Matías',facturadorEstudio:'Rogelio',bonoConsulta:false,bonoEstudio:false,firmaRequerida:false,copiaRequerida:false,incluirFacturaRogelio:true},
    {obraSocial:'Sancor',activo:true,regla:'SANCOR_PREVENCION',destinoConsulta:'Matías',destinoEstudio:'Rogelio',facturadorConsulta:'Matías',facturadorEstudio:'Rogelio',bonoConsulta:true,bonoEstudio:true,firmaRequerida:true,copiaRequerida:true,incluirFacturaRogelio:true},
    {obraSocial:'Prevención Salud',activo:true,regla:'SANCOR_PREVENCION',destinoConsulta:'Matías',destinoEstudio:'Rogelio',facturadorConsulta:'Matías',facturadorEstudio:'Rogelio',bonoConsulta:true,bonoEstudio:true,firmaRequerida:true,copiaRequerida:true,incluirFacturaRogelio:true},
    {obraSocial:'Integral',activo:true,regla:'INTEGRAL',destinoConsulta:'Matías',destinoEstudio:'Matías',facturadorConsulta:'Matías',facturadorEstudio:'Matías',bonoConsulta:true,bonoEstudio:true,firmaRequerida:true,copiaRequerida:true,incluirFacturaRogelio:false},
    {obraSocial:'PAMI',activo:true,regla:'COBERTURA_COBRA_PARTICULAR',destinoConsulta:'Matías',destinoEstudio:'Matías',facturadorConsulta:'Particular',facturadorEstudio:'Particular',bonoConsulta:false,bonoEstudio:false,firmaRequerida:false,copiaRequerida:false,incluirFacturaRogelio:false},
    {obraSocial:'Particular',activo:true,regla:'SIN_REGLA',destinoConsulta:'Matías',destinoEstudio:'Matías',facturadorConsulta:'Particular',facturadorEstudio:'Particular',bonoConsulta:false,bonoEstudio:false,firmaRequerida:false,copiaRequerida:false,incluirFacturaRogelio:false}
  ];

  function ensureConvenios3102(){
    if(!Array.isArray(data.conveniosFacturacion))data.conveniosFacturacion=[];
    convenioDefaults3102.forEach(def=>{
      let c=data.conveniosFacturacion.find(x=>norm3102(x.obraSocial).toLowerCase()===def.obraSocial.toLowerCase());
      if(!c){data.conveniosFacturacion.push({...def});return;}
      Object.keys(def).forEach(k=>{if(c[k]===undefined)c[k]=def[k]});
    });
    if(!Array.isArray(data.arancelesConvenios))data.arancelesConvenios=[];
    if(!Array.isArray(data.destinosFacturacion))data.destinosFacturacion=[];
    ['Matías','Rogelio','Fold2 / FEMEBA','Particular','No aplica','A definir'].forEach(nombre=>{
      if(!data.destinosFacturacion.some(x=>String(x.nombre||x)===nombre))data.destinosFacturacion.push({id:nombre.toLowerCase().replace(/\W+/g,'_'),nombre,activo:true});
    });
  }
  function convenio3102(os){
    ensureConvenios3102();
    return data.conveniosFacturacion.find(x=>norm3102(x.obraSocial).toLowerCase()===norm3102(os).toLowerCase())||null;
  }
  function destinos3102(){
    ensureConvenios3102();
    const base=(data.destinosFacturacion||[]).filter(x=>x.activo!==false).map(x=>typeof x==='string'?x:x.nombre);
    (data.profesionales||[]).filter(p=>p.id!=='general'&&p.activo!==false).forEach(p=>base.push(p.nombre));
    return [...new Set(base.filter(Boolean))];
  }
  function osOptions3102(value=''){
    const names=[...(data.obrasSociales||[]).map(x=>typeof x==='string'?x:(x.nombre||x.label||'')),...(data.conveniosFacturacion||[]).map(x=>x.obraSocial),value];
    return [...new Set(names.filter(Boolean))].sort((a,b)=>a.localeCompare(b,'es')).map(x=>`<option value="${esc3102(x)}" ${x===value?'selected':''}>${esc3102(x)}</option>`).join('');
  }
  function destinoOptions3102(value=''){
    return destinos3102().concat(value&&!destinos3102().includes(value)?[value]:[]).filter(Boolean).map(x=>`<option value="${esc3102(x)}" ${x===value?'selected':''}>${esc3102(x)}</option>`).join('');
  }
  function prestOptions3102(value=''){
    const items=(typeof allPrestaciones==='function'?allPrestaciones():[]).concat(value||[]);
    return [...new Set(items.filter(Boolean))].sort((a,b)=>a.localeCompare(b,'es')).map(x=>`<option value="${esc3102(x)}" ${x===value?'selected':''}>${esc3102(x)}</option>`).join('');
  }
  function reglaOptions3102(value=''){
    const opts=[
      ['GENERAL_CONSULTA_EXTRA','General: consulta + estudio'],['IOMA_OSPRERA','IOMA / OSPRERA'],['OSDE','OSDE'],['SANCOR_PREVENCION','Sancor / Prevención'],['INTEGRAL','Integral'],['TODO_MATIAS','Todo a Matías'],['COBERTURA_COBRA_PARTICULAR','Se cobra como particular'],['SIN_REGLA','Sin regla automática']
    ];
    return opts.map(([v,l])=>`<option value="${v}" ${v===value?'selected':''}>${l}</option>`).join('');
  }

  function injectConvenios3102(){
    const grid=document.querySelector('#config .config-grid');
    if(!puedeGestionarConfigAdministrativa()){
      ['cfgConvenios3102','cfgAranceles3102','cfgProduccionEstimada3102'].forEach(id=>$3102(id)?.remove());
      return;
    }
    if(!grid||$3102('cfgConvenios3102'))return;
    const card=document.createElement('div');
    card.id='cfgConvenios3102';card.className='config-smart-card-310 full-config-card';card.dataset.configGroupCard='coberturas';card.dataset.configAccess='admin';
    card.innerHTML=`<h3>Convenios y destinos de facturación</h3><p class="muted">Conserva la lógica actual de “Factura Rogelio”, pero permite cambiarla cuando cambien los convenios, sin modificar código.</p>
      <div class="convenio-editor-3102">
        <label>Obra social / prepaga<select id="convOS3102"></select></label>
        <label>Regla automática<select id="convRegla3102"></select></label>
        <label>Destino de consulta<select id="convDestinoConsulta3102"></select></label>
        <label>Destino del estudio<select id="convDestinoEstudio3102"></select></label>
        <label>Facturador de consulta<select id="convFactConsulta3102"></select></label>
        <label>Facturador del estudio<select id="convFactEstudio3102"></select></label>
        <label class="check-row-310"><input type="checkbox" id="convActivo3102"> Convenio activo</label>
        <label class="check-row-310"><input type="checkbox" id="convBonoConsulta3102"> Requiere bono/registro de consulta</label>
        <label class="check-row-310"><input type="checkbox" id="convBonoEstudio3102"> Requiere bono/registro de estudio</label>
        <label class="check-row-310"><input type="checkbox" id="convFirma3102"> Requiere firma de bono</label>
        <label class="check-row-310"><input type="checkbox" id="convCopia3102"> Requiere copia para facturación</label>
        <label class="check-row-310"><input type="checkbox" id="convFacturaRogelio3102"> Incluir estudios en “Factura Rogelio”</label>
        <div class="config-actions-3102"><button class="primary" id="guardarConvenio3102" type="button">Guardar convenio</button><button class="secondary" id="nuevoConvenio3102" type="button">Nuevo convenio</button></div>
      </div><div id="listaConvenios3102" class="convenios-list-3102"></div>`;
    grid.appendChild(card);

    const ar=document.createElement('div');
    ar.id='cfgAranceles3102';ar.className='config-smart-card-310 full-config-card';ar.dataset.configGroupCard='coberturas';ar.dataset.configAccess='admin';
    ar.innerHTML=`<h3>Aranceles estimados por convenio</h3><p class="muted">Carga opcional. El valor vigente se fija automáticamente en cada nueva atención, pero los totales económicos solo se muestran cuando Matías o un Administrador presionan “Calcular estimación”.</p>
      <div class="arancel-editor-3102"><label>Convenio<select id="arOS3102"></select></label><label>Prestación<select id="arPrest3102"></select></label><label>Valor esperado<input id="arValor3102" type="number" min="0" step="1" placeholder="0"></label><label>Vigente desde<input id="arVigencia3102" type="date"></label><button class="primary" id="agregarArancel3102" type="button">Agregar arancel</button></div><div id="listaAranceles3102" class="aranceles-list-3102"></div>`;
    grid.appendChild(ar);

    if(puedeVerEconomico3102Final()&&!$3102('cfgProduccionEstimada3102')){
      const prod=document.createElement('div');
      prod.id='cfgProduccionEstimada3102';prod.className='config-smart-card-310 full-config-card';prod.dataset.configGroupCard='coberturas';prod.dataset.configAccess='admin';
      prod.innerHTML=`<h3>Producción estimada</h3><p class="muted">Los importes permanecen ocultos hasta que presiones <strong>Calcular estimación</strong>. Solo Matías y los perfiles Administrador pueden acceder.</p>
        <div class="estimacion-editor-3102">
          <label>Desde<input id="estDesde3102" type="date"></label>
          <label>Hasta<input id="estHasta3102" type="date"></label>
          <label>Cobertura<select id="estOS3102"><option value="">Todas</option></select></label>
          <label>Profesional<select id="estProf3102"><option value="">Todos</option></select></label>
          <label>Prestación<select id="estPrest3102"><option value="">Todas</option></select></label>
          <button class="primary" id="calcularEstimacion3102" type="button">Calcular estimación</button>
          <button class="secondary" id="limpiarEstimacion3102" type="button">Ocultar resultados</button>
        </div>
        <div id="resultadoEstimacion3102" class="resultado-estimacion-3102 hidden"><p class="muted">Seleccioná el período y presioná Calcular estimación.</p></div>`;
      grid.appendChild(prod);
    }
  }

  function loadConvenio3102(){
    const os=$3102('convOS3102')?.value||'';
    let c=convenio3102(os);
    if(!c)c={obraSocial:os,activo:true,regla:'GENERAL_CONSULTA_EXTRA',destinoConsulta:'Matías',destinoEstudio:'Matías',facturadorConsulta:'Matías',facturadorEstudio:'Matías',bonoConsulta:true,bonoEstudio:true,firmaRequerida:true,copiaRequerida:true,incluirFacturaRogelio:false};
    $3102('convRegla3102').innerHTML=reglaOptions3102(c.regla);
    $3102('convDestinoConsulta3102').innerHTML=destinoOptions3102(c.destinoConsulta);
    $3102('convDestinoEstudio3102').innerHTML=destinoOptions3102(c.destinoEstudio);
    $3102('convFactConsulta3102').innerHTML=destinoOptions3102(c.facturadorConsulta);
    $3102('convFactEstudio3102').innerHTML=destinoOptions3102(c.facturadorEstudio);
    $3102('convActivo3102').checked=c.activo!==false;
    $3102('convBonoConsulta3102').checked=!!c.bonoConsulta;
    $3102('convBonoEstudio3102').checked=!!c.bonoEstudio;
    $3102('convFirma3102').checked=!!c.firmaRequerida;
    $3102('convCopia3102').checked=!!c.copiaRequerida;
    $3102('convFacturaRogelio3102').checked=!!c.incluirFacturaRogelio;
  }
  function puedeVerEconomico3102Final(){
    try{return !!(esMatiasDuenio?.()||esAdminComun?.());}catch(e){return false;}
  }
  function normalizarPrest3102Final(v){return norm3102(v).toLowerCase().replace(/\s+/g,' ');}
  function buscarArancel3102Final(obraSocial,prestacion,fecha,profesionalId='matias'){
    ensureConvenios3102();
    const os=norm3102(obraSocial).toLowerCase(),pr=normalizarPrest3102Final(prestacion),f=fecha||new Date().toISOString().slice(0,10);
    const porProfesional=data.arancelesPorProfesional?.[profesionalId];
    const fuente=Array.isArray(porProfesional)?porProfesional:(profesionalId==='matias'?(data.arancelesConvenios||[]):[]);
    const candidatos=fuente.filter(a=>a.activo!==false&&norm3102(a.obraSocial).toLowerCase()===os&&normalizarPrest3102Final(a.prestacion)===pr&&(!a.vigenteDesde||a.vigenteDesde<=f));
    candidatos.sort((a,b)=>(b.vigenteDesde||'').localeCompare(a.vigenteDesde||''));
    return candidatos[0]||null;
  }
  window.aplicarArancelSnapshot3102Final=function(a,forzar){
    if(!a)return a;
    if(!forzar&&Number.isFinite(Number(a.valorArancelEstimado))&&a.arancelId)return a;
    const pid=a.profesionalId||'matias';
    const ar=buscarArancel3102Final(a.obraSocial,a.prestacion,a.fecha,pid);
    const conv=(data.conveniosPorProfesional?.[pid]||[]).find(c=>norm3102(c.obraSocial).toLowerCase()===norm3102(a.obraSocial).toLowerCase())||(pid==='matias'?convenio3102(a.obraSocial):null);
    const esCons=typeof tipoPrest==='function'?tipoPrest(a.prestacion)==='CONSULTA':/consulta/i.test(a.prestacion||'');
    a.destinoFacturacionEstimado=esCons?(conv?.facturadorConsulta||conv?.destinoConsulta||''):(conv?.facturadorEstudio||conv?.destinoEstudio||'');
    if(ar){
      a.valorArancelEstimado=Number(ar.valor||0);a.arancelId=ar.id||'';a.arancelVigencia=ar.vigenteDesde||'';a.arancelCalculadoEn=new Date().toISOString();
    }else if(forzar){
      a.valorArancelEstimado=null;a.arancelId='';a.arancelVigencia='';a.arancelCalculadoEn=new Date().toISOString();
    }
    return a;
  };
  function valorEstimadoAtencion3102Final(a){
    if(Number.isFinite(Number(a?.valorArancelEstimado))&&a?.arancelId)return {valor:Number(a.valorArancelEstimado),arancelId:a.arancelId,origen:'fijado'};
    const ar=buscarArancel3102Final(a?.obraSocial,a?.prestacion,a?.fecha,a?.profesionalId||'matias');
    return ar?{valor:Number(ar.valor||0),arancelId:ar.id||'',origen:'vigente'}:{valor:null,arancelId:'',origen:'sin_arancel'};
  }
  function fechaMes3102Final(){
    const d=new Date(),y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0'),last=new Date(y,d.getMonth()+1,0).getDate();
    return {desde:`${y}-${m}-01`,hasta:`${y}-${m}-${String(last).padStart(2,'0')}`};
  }
  function llenarFiltrosEstimacion3102Final(){
    if(!puedeVerEconomico3102Final())return;
    const per=fechaMes3102Final();if($3102('estDesde3102')&&!$3102('estDesde3102').value)$3102('estDesde3102').value=per.desde;if($3102('estHasta3102')&&!$3102('estHasta3102').value)$3102('estHasta3102').value=per.hasta;
    const os=$3102('estOS3102');if(os){const val=os.value;os.innerHTML='<option value="">Todas</option>'+osOptions3102(val);if([...os.options].some(o=>o.value===val))os.value=val;}
    const prof=$3102('estProf3102');if(prof){const val=prof.value;prof.innerHTML='<option value="">Todos</option>'+(data.profesionales||[]).filter(p=>p.id!=='general'&&p.activo!==false).map(p=>`<option value="${esc3102(p.id)}">${esc3102(p.nombre)}</option>`).join('');if([...prof.options].some(o=>o.value===val))prof.value=val;}
    const prest=$3102('estPrest3102');if(prest){const val=prest.value;prest.innerHTML='<option value="">Todas</option>'+prestOptions3102(val);if([...prest.options].some(o=>o.value===val))prest.value=val;}
  }
  function calcularEstimacion3102Final(){
    if(!puedeVerEconomico3102Final()){alert('No tenés permiso para ver información económica.');return;}
    const desde=$3102('estDesde3102')?.value||'',hasta=$3102('estHasta3102')?.value||'',os=$3102('estOS3102')?.value||'',prof=$3102('estProf3102')?.value||'',prest=$3102('estPrest3102')?.value||'';
    if(!desde||!hasta){alert('Seleccioná fecha desde y hasta.');return;}
    const filas=(atenciones||[]).filter(a=>a.fecha>=desde&&a.fecha<=hasta&&(!os||a.obraSocial===os)&&(!prof||a.profesionalId===prof)&&(!prest||a.prestacion===prest));
    const grupos={},faltantes=[];let total=0,conValor=0;
    filas.forEach(a=>{const r=valorEstimadoAtencion3102Final(a);if(r.valor===null){faltantes.push(a);return;}total+=r.valor;conValor++;const key=a.obraSocial||'Sin cobertura';if(!grupos[key])grupos[key]={cantidad:0,total:0,prest:{}};grupos[key].cantidad++;grupos[key].total+=r.valor;const pk=a.prestacion||'Sin prestación';if(!grupos[key].prest[pk])grupos[key].prest[pk]={cantidad:0,total:0};grupos[key].prest[pk].cantidad++;grupos[key].prest[pk].total+=r.valor;});
    const fmt=n=>typeof money==='function'?money(n):'$ '+Number(n||0).toLocaleString('es-AR');
    let html=`<div class="estimacion-resumen-3102"><div><span>Atenciones filtradas</span><strong>${filas.length}</strong></div><div><span>Con arancel</span><strong>${conValor}</strong></div><div><span>Sin arancel</span><strong>${faltantes.length}</strong></div><div><span>Total estimado</span><strong>${fmt(total)}</strong></div></div>`;
    html+=Object.entries(grupos).sort((a,b)=>b[1].total-a[1].total).map(([k,g])=>`<section class="estimacion-grupo-3102"><header><strong>${esc3102(k)}</strong><span>${g.cantidad} prestaciones · ${fmt(g.total)}</span></header>${Object.entries(g.prest).sort((a,b)=>b[1].total-a[1].total).map(([pk,pv])=>`<div><span>${esc3102(pk)} × ${pv.cantidad}</span><strong>${fmt(pv.total)}</strong></div>`).join('')}</section>`).join('');
    if(faltantes.length)html+=`<details class="faltantes-arancel-3102"><summary>${faltantes.length} prestaciones sin arancel configurado</summary>${faltantes.slice(0,100).map(a=>`<div>${esc3102(a.fecha)} · ${esc3102(a.obraSocial||'Sin cobertura')} · ${esc3102(a.prestacion||'Sin prestación')} · ${esc3102(a.paciente||'')}</div>`).join('')}${faltantes.length>100?'<p class="muted">Se muestran las primeras 100.</p>':''}</details>`;
    const out=$3102('resultadoEstimacion3102');if(out){out.innerHTML=html;out.classList.remove('hidden');out.scrollIntoView({behavior:'smooth',block:'nearest'});}
  }
  function ocultarEstimacion3102Final(){const out=$3102('resultadoEstimacion3102');if(out){out.innerHTML='<p class="muted">Seleccioná el período y presioná Calcular estimación.</p>';out.classList.add('hidden');}}

  function renderConvenios3102(){
    if(!puedeGestionarConfigAdministrativa()){injectConvenios3102();return;}
    ensureConvenios3102();injectConvenios3102();
    const sel=$3102('convOS3102');
    if(sel){const old=sel.value;sel.innerHTML=osOptions3102(old||data.conveniosFacturacion[0]?.obraSocial);if(old&&[...sel.options].some(o=>o.value===old))sel.value=old;loadConvenio3102();}
    if($3102('arOS3102'))$3102('arOS3102').innerHTML=osOptions3102($3102('arOS3102').value);
    if($3102('arPrest3102'))$3102('arPrest3102').innerHTML=prestOptions3102($3102('arPrest3102').value);
    if($3102('arVigencia3102')&&!$3102('arVigencia3102').value)$3102('arVigencia3102').value=new Date().toISOString().slice(0,10);
    const list=$3102('listaConvenios3102');if(list)list.innerHTML=data.conveniosFacturacion.slice().sort((a,b)=>a.obraSocial.localeCompare(b.obraSocial,'es')).map(c=>`<div class="convenio-row-3102"><strong>${esc3102(c.obraSocial)}</strong><span>${esc3102(c.destinoConsulta||'')} / ${esc3102(c.destinoEstudio||'')}</span><span>${c.incluirFacturaRogelio?'Factura Rogelio':'Circuito propio'}</span><span>${c.activo===false?'Inactivo':'Activo'}</span></div>`).join('');
    const ars=$3102('listaAranceles3102');if(ars)ars.innerHTML=(data.arancelesConvenios||[]).slice().sort((a,b)=>(b.vigenteDesde||'').localeCompare(a.vigenteDesde||'')).map(a=>`<div class="arancel-row-3102"><span><strong>${esc3102(a.obraSocial)}</strong> · ${esc3102(a.prestacion)}</span><span>${typeof money==='function'?money(a.valor):'$ '+Number(a.valor||0).toLocaleString('es-AR')}</span><span>desde ${esc3102(a.vigenteDesde||'s/f')}</span><button class="small-btn" type="button" data-del-arancel3102="${esc3102(a.id)}">Borrar</button></div>`).join('')||'<p class="muted">Todavía no hay aranceles cargados.</p>';    llenarFiltrosEstimacion3102Final();
  }
  function saveConvenio3102(){
    if(!exigirConfigAdministrativa('Tu perfil no puede modificar convenios administrativos.'))return;
    const os=$3102('convOS3102').value; if(!os)return;
    let c=convenio3102(os); if(!c){c={obraSocial:os};data.conveniosFacturacion.push(c)}
    c.activo=$3102('convActivo3102').checked;c.regla=$3102('convRegla3102').value;
    c.destinoConsulta=$3102('convDestinoConsulta3102').value;c.destinoEstudio=$3102('convDestinoEstudio3102').value;
    c.facturadorConsulta=$3102('convFactConsulta3102').value;c.facturadorEstudio=$3102('convFactEstudio3102').value;
    c.bonoConsulta=$3102('convBonoConsulta3102').checked;c.bonoEstudio=$3102('convBonoEstudio3102').checked;
    c.firmaRequerida=$3102('convFirma3102').checked;c.copiaRequerida=$3102('convCopia3102').checked;c.incluirFacturaRogelio=$3102('convFacturaRogelio3102').checked;
    if(!data.reglasOS)data.reglasOS={};data.reglasOS[os]=c.regla;
    saveConfig();try{guardarConfigEnSupabase298?.()}catch(e){};renderConvenios3102();refreshSelects?.();alert('Convenio guardado. Las nuevas atenciones usarán esta configuración.');
  }
  function newConvenio3102(){
    if(!exigirConfigAdministrativa('Tu perfil no puede crear convenios administrativos.'))return;
    const nombre=prompt('Nombre de la nueva obra social, prepaga o convenio:');if(!nombre)return;
    if(!(data.obrasSociales||[]).includes(nombre))data.obrasSociales.push(nombre);
    data.conveniosFacturacion.push({obraSocial:nombre,activo:true,regla:'GENERAL_CONSULTA_EXTRA',destinoConsulta:'Matías',destinoEstudio:'Matías',facturadorConsulta:'Matías',facturadorEstudio:'Matías',bonoConsulta:true,bonoEstudio:true,firmaRequerida:true,copiaRequerida:true,incluirFacturaRogelio:false});
    saveConfig();renderConvenios3102();$3102('convOS3102').value=nombre;loadConvenio3102();
  }
  function addArancel3102(){
    if(!exigirConfigAdministrativa('Tu perfil no puede modificar aranceles.'))return;
    const obraSocial=$3102('arOS3102').value,prestacion=$3102('arPrest3102').value,valor=Number($3102('arValor3102').value||0),vigenteDesde=$3102('arVigencia3102').value;
    if(!obraSocial||!prestacion||!vigenteDesde){alert('Seleccioná convenio, prestación y fecha de vigencia.');return}
    data.arancelesConvenios.push({id:'ar_'+Date.now()+'_'+Math.random().toString(36).slice(2,6),obraSocial,prestacion,valor,vigenteDesde,activo:true});
    saveConfig();$3102('arValor3102').value='';renderConvenios3102();
  }

  // Aplica la configuración editable después de la regla histórica existente.
  const oldAplicarRegla3102=window.aplicarRegla;
  window.aplicarRegla=function(){
    if(typeof oldAplicarRegla3102==='function')oldAplicarRegla3102();
    try{
      if(document.getElementById('profesional')?.value!=='matias')return;
      const os=document.getElementById('obraSocial')?.value,prest=document.getElementById('prestacion')?.value,c=convenio3102(os);if(!c||c.activo===false)return;
      const tipo=typeof tipoPrest==='function'?tipoPrest(prest):'';const consulta=tipo==='CONSULTA';
      setSelectValue('consultaA',consulta?c.destinoConsulta:(c.destinoConsulta||'Matías'));
      setSelectValue('prestacionA',consulta?'No aplica':(c.destinoEstudio||'Matías'));
      setSelectValue('facturador',consulta?(c.facturadorConsulta||c.destinoConsulta):(c.facturadorEstudio||c.destinoEstudio));
      const bc=document.getElementById('bonoConsulta'),be=document.getElementById('bonoEstudio');if(bc)bc.checked=consulta?!!c.bonoConsulta:!!c.bonoConsulta;if(be)be.checked=!consulta&&!!c.bonoEstudio;
      const ci=document.getElementById('copiaImpresa');if(ci&&!c.copiaRequerida)ci.checked=true;
      const info=document.getElementById('reglaInfo');if(info)info.textContent=`${os}: convenio configurable. Consulta → ${c.destinoConsulta}; estudio → ${c.destinoEstudio}; factura → ${consulta?c.facturadorConsulta:c.facturadorEstudio}.`;
      calcularCajaCarga?.();
    }catch(e){console.error('Convenio configurable',e)}
  };
  // Mantiene Factura Rogelio, pero la lista de coberturas se toma de la configuración.
  window.esRegistroFacturaRogelio=function(a){
    const c=convenio3102(a?.obraSocial);return !!(c?.activo!==false&&c?.incluirFacturaRogelio&&String(a?.prestacionA||'')===String(c.destinoEstudio||'Rogelio')&&tipoPrest(a?.prestacion)!=='CONSULTA');
  };
  window.resumenFacturaRogelio=function(datos){
    const convenios=(data.conveniosFacturacion||[]).filter(c=>c.activo!==false&&c.incluirFacturaRogelio);const porOS={};convenios.forEach(c=>porOS[c.obraSocial]=0);
    (datos||[]).filter(window.esRegistroFacturaRogelio).forEach(a=>porOS[a.obraSocial]=(porOS[a.obraSocial]||0)+1);
    return {porOS,total:Object.values(porOS).reduce((s,n)=>s+n,0)};
  };

  const oldRenderConfig3102=window.renderConfig;
  window.renderConfig=function(){if(typeof oldRenderConfig3102==='function')oldRenderConfig3102();renderConvenios3102();};
  document.addEventListener('change',e=>{if(e.target.id==='convOS3102')loadConvenio3102();});
  document.addEventListener('click',e=>{
    if(e.target.id==='guardarConvenio3102')saveConvenio3102();
    if(e.target.id==='nuevoConvenio3102')newConvenio3102();
    if(e.target.id==='agregarArancel3102')addArancel3102();
    if(e.target.id==='calcularEstimacion3102')calcularEstimacion3102Final();
    if(e.target.id==='limpiarEstimacion3102')ocultarEstimacion3102Final();
    const del=e.target.closest?.('[data-del-arancel3102]');if(del){if(!exigirConfigAdministrativa('Tu perfil no puede borrar aranceles.'))return;if(confirm('¿Borrar este arancel?')){data.arancelesConvenios=data.arancelesConvenios.filter(a=>a.id!==del.dataset.delArancel3102);saveConfig();renderConvenios3102();}}
  });
  function version3102(){document.title=`CardioLink Admin v${VERSION_3102}`;document.querySelectorAll('.brand-main span,.mobile-app-title-370 span').forEach(el=>el.textContent=`v${VERSION_3102}`);document.querySelectorAll('.login-meta').forEach(el=>el.textContent=`Versión ${VERSION_3102} · 2026`);}
  function boot3102(){ensureConvenios3102();saveConfig();injectConvenios3102();renderConvenios3102();version3102();}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot3102);else boot3102();
})();

/* ===== CardioLink HC 4.0 · Fase 1 ===== */
(function(){
  const VERSION_HC='4.1.0-hc';
  let hcPacienteSeleccionado='';
  let hcPaginaResultados=1;
  const HC_RESULTADOS_POR_PAGINA=50;
  const $hc=id=>document.getElementById(id);
  const escHC=s=>typeof escapeHtml==='function'?escapeHtml(String(s??'')):String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
  function ensureHC(){
    if(!data||typeof data!=='object')return;
    if(!Array.isArray(data.evolucionesClinicas))data.evolucionesClinicas=[];
    if(!data.resumenesClinicos||typeof data.resumenesClinicos!=='object')data.resumenesClinicos={};
  }
  function userHC(){
    try{return perfilUsuarioActual?.()||usuarioPerfilActual||{};}catch(e){return usuarioPerfilActual||{};}
  }
  function profesionalHC(){
    const u=userHC();
    const id=typeof profesionalIdUsuarioActual==='function'?profesionalIdUsuarioActual():u.profesionalId;
    const prof=(data?.profesionales||[]).find(p=>p.id===id);
    return {id:id||u.profesionalId||u.id||'local',nombre:prof?.nombre||u.nombre||usuarioSupabase?.email||'Profesional'};
  }
  function adminHC(){try{return !!(esMatiasDuenio?.()||esAdminComun?.());}catch(e){return false;}}
  function patientKeyHC(p){return p?.id||('legacy_'+(dniLimpio?.(p?.dni||'')||normalizarTexto?.(nombrePacientePanel?.(p)||p?.nombreCompleto||'')));}
  function patientByKeyHC(key){return (typeof todosPacientes==='function'?todosPacientes():data.pacientes||[]).find(p=>patientKeyHC(p)===key||p.id===key)||null;}
  function evolucionesHC(p){
    ensureHC(); const key=patientKeyHC(p),dni=typeof dniLimpio==='function'?dniLimpio(p?.dni||''):String(p?.dni||'').replace(/\D/g,'');
    return data.evolucionesClinicas.filter(e=>e.pacienteId===key||e.pacienteId===p?.id||(dni&&String(e.dni||'').replace(/\D/g,'')===dni)).sort((a,b)=>String(b.fechaHora||'').localeCompare(String(a.fechaHora||'')));
  }
  function canEditHC(e){
    if(adminHC())return true;
    const created=new Date(e.fechaHora||e.creadoEn||0).getTime();
    return Date.now()-created<=24*60*60*1000 && profesionalHC().id===e.profesionalId;
  }
  function fmtDateTimeHC(v){try{return new Intl.DateTimeFormat('es-AR',{dateStyle:'short',timeStyle:'short'}).format(new Date(v));}catch(e){return v||'';}}
  function normSearchHC(v){
    return String(v??'').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ');
  }
  function cleanDigitsHC(v){return String(v??'').replace(/\D/g,'');}
  function allPatientsHC(){
    let source=[];
    try{source=typeof todosPacientes==='function'?todosPacientes():(data?.pacientes||[]);}catch(e){source=data?.pacientes||[];}
    const seen=new Set(),out=[];
    for(const p of source||[]){
      if(!p)continue;
      const key=patientKeyHC(p);
      if(!key||seen.has(key))continue;
      seen.add(key);out.push(p);
    }
    return out;
  }
  function searchScoreHC(p,q,qDigits){
    if(!q)return 1;
    const name=normSearchHC(nombrePacientePanel?.(p)||p.nombreCompleto||p.paciente||'');
    const dni=cleanDigitsHC(p.dni||'');
    const tel=cleanDigitsHC(p.telefono||'');
    const mail=normSearchHC(p.email||'');
    const coverage=normSearchHC(p.coberturaHabitual||'');
    const tokens=q.split(' ').filter(Boolean);
    const haystack=[name,mail,coverage].join(' ');
    const tokenMatch=tokens.every(t=>haystack.includes(t));
    const digitMatch=qDigits&&(dni.includes(qDigits)||tel.includes(qDigits));
    if(!tokenMatch&&!digitMatch)return -1;
    let score=0;
    if(qDigits&&dni===qDigits)score+=10000;
    else if(qDigits&&dni.startsWith(qDigits))score+=6000;
    else if(qDigits&&tel===qDigits)score+=5000;
    else if(qDigits&&(dni.includes(qDigits)||tel.includes(qDigits)))score+=2500;
    if(name===q)score+=9000;
    else if(name.startsWith(q))score+=7000;
    else if(name.split(' ').some(x=>x.startsWith(q)))score+=5000;
    else if(name.includes(q))score+=3500;
    if(mail===q)score+=4500;else if(mail.startsWith(q))score+=2500;
    return score;
  }
  function resultPatientsHC(){
    const input=($hc('hcBuscarPaciente')?.value||'').trim();
    const q=normSearchHC(input),qDigits=cleanDigitsHC(input);
    return allPatientsHC().map(p=>({p,score:searchScoreHC(p,q,qDigits)})).filter(x=>x.score>=0).sort((a,b)=>{
      if(b.score!==a.score)return b.score-a.score;
      return normSearchHC(nombrePacientePanel?.(a.p)||a.p.nombreCompleto||'').localeCompare(normSearchHC(nombrePacientePanel?.(b.p)||b.p.nombreCompleto||''),'es');
    }).map(x=>x.p);
  }
  function renderSearchHC(autoOpenExact=false){
    const input=($hc('hcBuscarPaciente')?.value||'').trim();
    const qDigits=cleanDigitsHC(input);
    const all=resultPatientsHC();
    const total=all.length;
    const pages=Math.max(1,Math.ceil(total/HC_RESULTADOS_POR_PAGINA));
    hcPaginaResultados=Math.min(Math.max(1,hcPaginaResultados),pages);
    const from=(hcPaginaResultados-1)*HC_RESULTADOS_POR_PAGINA;
    const list=all.slice(from,from+HC_RESULTADOS_POR_PAGINA);
    const box=$hc('hcResultadosPacientes'),sum=$hc('hcResultadosResumen');if(!box)return;
    if(sum){
      if(!total)sum.textContent='No se encontraron pacientes.';
      else sum.textContent=`${total} paciente(s). Mostrando ${from+1}-${Math.min(from+list.length,total)}.`;
    }
    const items=list.map(p=>{const key=patientKeyHC(p),active=key===hcPacienteSeleccionado?' active':'';return `<button type="button" class="hc-result-item${active}" data-hc-patient="${escHC(key)}"><strong>${escHC(nombrePacientePanel?.(p)||p.nombreCompleto||'Paciente')}</strong><span>DNI ${escHC(p.dni||'s/d')} · ${escHC(p.telefono||'Tel. s/d')}</span><span>${evolucionesHC(p).length} evolución(es) clínica(s)</span></button>`}).join('')||'<div class="muted">Sin resultados.</div>';
    const pager=total>HC_RESULTADOS_POR_PAGINA?`<div class="hc-pagination-408"><button type="button" class="secondary" data-hc-page="${hcPaginaResultados-1}" ${hcPaginaResultados<=1?'disabled':''}>Anterior</button><span>Página ${hcPaginaResultados} de ${pages}</span><button type="button" class="secondary" data-hc-page="${hcPaginaResultados+1}" ${hcPaginaResultados>=pages?'disabled':''}>Siguiente</button></div>`:'';
    box.innerHTML=items+pager;
    if(autoOpenExact&&qDigits.length>=6){
      const exact=all.filter(p=>cleanDigitsHC(p.dni||'')===qDigits);
      if(exact.length===1)renderDetailHC(patientKeyHC(exact[0]));
    }
  }
  function birthISOHC(p){
    const raw=String(p?.fechaNacimiento||'').trim();if(!raw)return '';
    let y,m,d,match=raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if(match){y=+match[1];m=+match[2];d=+match[3];}
    else{
      match=raw.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
      if(!match){try{const parsed=typeof fechaISODesdeTexto==='function'?fechaISODesdeTexto(raw):'';if(parsed&&parsed!==raw)return birthISOHC({fechaNacimiento:parsed});}catch(e){}return '';}
      d=+match[1];m=+match[2];y=+match[3];if(y<100)y+=y>40?1900:2000;
    }
    const date=new Date(y,m-1,d);
    if(date.getFullYear()!==y||date.getMonth()!==m-1||date.getDate()!==d)return '';
    if(y<1900||date.getTime()>Date.now())return '';
    return `${String(y).padStart(4,'0')}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  }
  function ageHC(p){
    const iso=birthISOHC(p);if(!iso)return '';
    const [y,m,d]=iso.split('-').map(Number),now=new Date();let age=now.getFullYear()-y;
    if(now.getMonth()+1<m||(now.getMonth()+1===m&&now.getDate()<d))age--;
    return age>=0&&age<130?String(age):'';
  }
  function birthDisplayHC(p){
    const iso=birthISOHC(p);if(iso)return typeof formatFecha==='function'?formatFecha(iso):iso;
    return p?.fechaNacimiento?'Fecha inválida':'s/d';
  }
function patientInfoTextHC(p,coverage){
    const name=nombrePacientePanel?.(p)||p.nombreCompleto||'Paciente';
    return [name,`DNI: ${p.dni||'s/d'}`,`Fecha de nacimiento: ${birthISOHC(p)?(formatFecha?.(birthISOHC(p))||birthISOHC(p)):'s/d'}`,`Edad: ${ageHC(p)||'s/d'}`,`Sexo: ${p.sexo||'s/d'}`,`Cobertura: ${coverage||'s/d'}`,`Teléfono: ${p.telefono||'s/d'}`,`Email: ${p.email||'s/d'}`].join('\n');
  }
  async function copyHC408(value,label,button){
    if(!value)return;
    try{await navigator.clipboard.writeText(value);}catch(e){const t=document.createElement('textarea');t.value=value;t.style.position='fixed';t.style.opacity='0';document.body.appendChild(t);t.select();document.execCommand('copy');t.remove();}
    if(button){const old=button.textContent;button.textContent='Copiado';setTimeout(()=>button.textContent=old,900);}
  }
  function resumenHC(p){ensureHC();return data.resumenesClinicos[patientKeyHC(p)]||{antecedentes:'',alergias:'',medicacion:'',alertas:''};}
  function atencionesHC(p){try{return atencionesPacienteGlobal(p)||[];}catch(e){return [];}}
  function timelineHC(p){
    const ev=evolucionesHC(p).map(e=>({type:'evolution',date:e.fechaHora,obj:e}));
    const ats=atencionesHC(p).map(a=>({type:'attention',date:(a.fecha||'')+'T'+(a.horaInicio||'00:00'),obj:a}));
    return [...ev,...ats].sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')));
  }
  function editablePatientHC(p){
    if(!Array.isArray(data.pacientes))data.pacientes=[];
    let target=null;
    if(p?.id&&!String(p.id).startsWith('legacy_'))target=data.pacientes.find(x=>String(x.id)===String(p.id));
    const dni=cleanDigitsHC(p?.dni||'');
    if(!target&&dni)target=data.pacientes.find(x=>cleanDigitsHC(x.dni||'')===dni);
    if(!target){
      target={...p,id:(p?.id&&!String(p.id).startsWith('legacy_'))?p.id:'pac_'+Date.now()+'_'+Math.floor(Math.random()*10000),historialCoberturas:Array.isArray(p?.historialCoberturas)?p.historialCoberturas:[]};
      data.pacientes.push(target);
    }
    return target;
  }
  function movePatientLinkedDataHC(oldKey,newKey,oldDni,newDni,oldName,newName){
    if(oldKey!==newKey){
      if(data.resumenesClinicos?.[oldKey]&&!data.resumenesClinicos[newKey])data.resumenesClinicos[newKey]=data.resumenesClinicos[oldKey];
      if(data.resumenesClinicos?.[oldKey])delete data.resumenesClinicos[oldKey];
      Object.values(data.notasInternasPorProfesional||{}).forEach(bucket=>{if(bucket?.[oldKey]&&!bucket[newKey])bucket[newKey]=bucket[oldKey];if(bucket?.[oldKey])delete bucket[oldKey];});
    }
    (data.evolucionesClinicas||[]).forEach(e=>{if(e.pacienteId===oldKey||e.pacienteId===newKey||(oldDni&&cleanDigitsHC(e.dni||'')===oldDni)){e.pacienteId=newKey;e.dni=newDni;e.pacienteNombre=newName;}});
    (data.documentosClinicos||[]).forEach(d=>{if(d.pacienteId===oldKey||d.pacienteId===newKey||(oldDni&&cleanDigitsHC(d.dni||'')===oldDni)){d.pacienteId=newKey;d.dni=newDni;d.pacienteNombre=newName;}});
    (typeof atenciones!=='undefined'&&Array.isArray(atenciones)?atenciones:[]).forEach(a=>{
      const match=(a.pacienteId&&String(a.pacienteId)===String(oldKey))||(oldDni&&cleanDigitsHC(a.dni||'')===oldDni)||(!oldDni&&normSearchHC(a.paciente||'')===normSearchHC(oldName));
      if(match){a.pacienteId=newKey;a.paciente=newName;a.dni=newDni;}
    });
  }
  function patientEditCoverageOptionsHC(value){
    const names=[...(data.obrasSociales||[]),value].filter(Boolean);const unique=[...new Set(names)];
    return `<option value="">Sin definir</option>`+unique.map(x=>`<option value="${escHC(x)}" ${x===value?'selected':''}>${escHC(x)}</option>`).join('');
  }
  function openPatientEditHC(key,context='detail'){
    const p=patientByKeyHC(key);if(!p)return;
    document.getElementById('hcPatientEditModal409')?.remove();
    const iso=birthISOHC(p),overlay=document.createElement('div');overlay.id='hcPatientEditModal409';overlay.className='hc-modal-overlay';overlay.dataset.context409=context;
    overlay.innerHTML=`<div class="hc-modal-card hc-patient-edit-card409"><div class="hc-modal-head"><div><h2>Editar ficha del paciente</h2><p class="muted">Los cambios actualizan la ficha existente y sus vínculos; no crean duplicados.</p></div><button class="modal-close" type="button" data-hc-close-patient409>×</button></div>
      <div class="hc-modal-grid hc-patient-edit-grid409">
        <div class="full"><label>Apellido y nombre</label><input id="hcEditNombre409" value="${escHC(nombrePacientePanel?.(p)||p.nombreCompleto||'')}"></div>
        <div><label>DNI</label><input id="hcEditDni409" inputmode="numeric" value="${escHC(p.dni||'')}"></div>
        <div><label>Fecha de nacimiento</label><input id="hcEditNacimiento409" type="date" value="${escHC(iso)}"><small id="hcEditEdad409">${escHC(ageHC(p)?'Edad actual: '+ageHC(p)+' años':(p.fechaNacimiento?'Revisar fecha inválida':'Edad sin calcular'))}</small></div>
        <div><label>Sexo</label><select id="hcEditSexo409"><option value="">Sin definir</option><option value="Masculino" ${p.sexo==='Masculino'?'selected':''}>Masculino</option><option value="Femenino" ${p.sexo==='Femenino'?'selected':''}>Femenino</option><option value="Otro" ${p.sexo==='Otro'?'selected':''}>Otro</option></select></div>
        <div><label>Cobertura habitual</label><select id="hcEditCobertura409">${patientEditCoverageOptionsHC(p.coberturaHabitual||'')}</select></div>
        <div><label>N.º de afiliado</label><input id="hcEditAfiliado409" value="${escHC(p.numeroAfiliadoHabitual||'')}"></div>
        <div><label>Teléfono</label><input id="hcEditTelefono409" value="${escHC(p.telefono||'')}"></div>
        <div><label>Email</label><input id="hcEditEmail409" type="email" value="${escHC(p.email||'')}"></div>
        <div><label>Localidad</label><input id="hcEditLocalidad409" value="${escHC(p.localidad||'')}"></div>
        <div><label>Provincia</label><input id="hcEditProvincia409" value="${escHC(p.provincia||'Buenos Aires')}"></div>
        <div class="full"><label>Dirección</label><input id="hcEditDireccion409" value="${escHC(p.direccion||'')}"></div>
      </div>
      <div class="hc-modal-actions"><button class="secondary" type="button" data-hc-close-patient409>Cancelar</button><button class="primary" type="button" id="hcSavePatient409">Guardar ficha</button></div></div>`;
    document.body.appendChild(overlay);
    const updateAge=()=>{const v=$hc('hcEditNacimiento409')?.value||'',tmp={fechaNacimiento:v},a=ageHC(tmp);if($hc('hcEditEdad409'))$hc('hcEditEdad409').textContent=a?'Edad actual: '+a+' años':(v?'Fecha inválida':'Edad sin calcular');};
    $hc('hcEditNacimiento409')?.addEventListener('change',updateAge);$hc('hcEditNacimiento409')?.addEventListener('input',updateAge);
    $hc('hcSavePatient409').onclick=()=>savePatientEditHC(key,context);
  }
  function refreshEvolutionPatientBannerHC(p,coverage){
    const modal=$hc('hcEvolutionModal');if(!modal)return;
    const values={name:nombrePacientePanel?.(p)||p.nombreCompleto||'Paciente',dni:p.dni||'s/d',birth:birthDisplayHC(p),age:ageHC(p)?ageHC(p)+' años':'s/d',sex:p.sexo||'s/d',coverage:coverage||p.coberturaHabitual||'s/d',affiliate:p.numeroAfiliadoHabitual||'s/d',phone:p.telefono||'s/d',email:p.email||'s/d'};
    const n=modal.querySelector('[data-hc-patient-name409]');if(n)n.textContent=values.name;
    Object.entries(values).forEach(([k,v])=>{modal.querySelectorAll(`[data-hc-field409="${k}"]`).forEach(el=>el.textContent=v);});
    const info=patientInfoTextHC(p,values.coverage),digits=cleanDigitsHC(p.telefono||'');
    const actions=modal.querySelector('#hcCopyActions409');if(actions)actions.innerHTML=copyActionsHtmlHC409(p,values.coverage,info,digits);
  }
  function savePatientEditHC(key,context){
    const original=patientByKeyHC(key);if(!original)return;
    const oldKey=patientKeyHC(original),oldDni=cleanDigitsHC(original.dni||''),oldName=nombrePacientePanel?.(original)||original.nombreCompleto||'';
    const nombre=$hc('hcEditNombre409')?.value.trim()||'',dni=cleanDigitsHC($hc('hcEditDni409')?.value||'');
    if(!nombre&&!dni){alert('Ingresá al menos el nombre o el DNI.');return;}
    if(dni){const duplicate=(data.pacientes||[]).find(x=>x!==original&&String(x.id||'')!==String(original.id||'')&&cleanDigitsHC(x.dni||'')===dni);if(duplicate){alert('Ya existe otro paciente con ese DNI. Revisá la ficha antes de guardar.');return;}}
    const target=editablePatientHC(original);
    Object.assign(target,{nombreCompleto:nombre,dni,fechaNacimiento:$hc('hcEditNacimiento409')?.value||'',sexo:$hc('hcEditSexo409')?.value||'',coberturaHabitual:$hc('hcEditCobertura409')?.value||'',numeroAfiliadoHabitual:$hc('hcEditAfiliado409')?.value.trim()||'',telefono:$hc('hcEditTelefono409')?.value.trim()||'',email:$hc('hcEditEmail409')?.value.trim()||'',localidad:$hc('hcEditLocalidad409')?.value.trim()||'',provincia:$hc('hcEditProvincia409')?.value.trim()||'',direccion:$hc('hcEditDireccion409')?.value.trim()||'',actualizadoEn:new Date().toISOString()});
    if(original!==target)Object.assign(original,target);
    const newKey=patientKeyHC(target);movePatientLinkedDataHC(oldKey,newKey,oldDni,dni,oldName,nombre);
    try{saveConfig?.();saveAtenciones?.();programarSyncSupabase?.();}catch(e){console.warn(e)}
    $hc('hcPatientEditModal409')?.remove();
    if(context==='evolution')refreshEvolutionPatientBannerHC(target,target.coberturaHabitual||'s/d');
    else renderDetailHC(newKey);
    try{renderPacientesPanel?.($hc('pacientesBuscar')?.value||'',false);}catch(e){}
  }
  function copyActionsHtmlHC409(p,coverage,infoText,phoneDigits){
    const copyAttr=v=>escHC(encodeURIComponent(String(v||''))),phone=String(p.telefono||'').trim(),email=String(p.email||'').trim();
    return `<button class="secondary" type="button" data-hc-copy408="${copyAttr(p.dni||'')}" data-hc-copy-label408="DNI">Copiar DNI</button><button class="secondary" type="button" data-hc-copy408="${copyAttr(phone)}" data-hc-copy-label408="teléfono" ${phone?'':'disabled'}>Copiar teléfono</button><button class="secondary" type="button" data-hc-copy408="${copyAttr(email)}" data-hc-copy-label408="email" ${email?'':'disabled'}>Copiar email</button><button class="secondary" type="button" data-hc-copy408="${copyAttr(infoText)}" data-hc-copy-label408="datos">Copiar datos</button>${phoneDigits?`<a class="secondary hc-link-button-408" href="https://wa.me/${escHC(phoneDigits)}" target="_blank" rel="noopener">WhatsApp</a>`:''}${email?`<a class="secondary hc-link-button-408" href="mailto:${escHC(email)}">Enviar email</a>`:''}`;
  }
  function numHC(v){
    if(v===null||v===undefined||v==='')return null;
    const n=Number(String(v).replace(',','.'));
    return Number.isFinite(n)?n:null;
  }
  function imcHC(peso,tallaCm){
    const p=numHC(peso),t=numHC(tallaCm);
    if(!(p>0)||!(t>0))return null;
    return Math.round((p/Math.pow(t/100,2))*10)/10;
  }
  function vitalesHC(e){
    if(!e)return '';
    const items=[];
    if(numHC(e.pesoKg)!=null)items.push(`Peso ${escHC(e.pesoKg)} kg`);
    if(numHC(e.tallaCm)!=null)items.push(`Talla ${escHC(e.tallaCm)} cm`);
    if(numHC(e.imc)!=null)items.push(`IMC ${escHC(e.imc)}`);
    if(numHC(e.taSistolica)!=null||numHC(e.taDiastolica)!=null)items.push(`TA ${escHC(e.taSistolica??'—')}/${escHC(e.taDiastolica??'—')} mmHg`);
    if(numHC(e.frecuenciaCardiaca)!=null)items.push(`FC ${escHC(e.frecuenciaCardiaca)} lpm`);
    if(numHC(e.sato2)!=null)items.push(`SatO₂ ${escHC(e.sato2)}%`);
    return items.join(' · ');
  }
  function ultimaEvolucionConVitalesHC(p){
    return evolucionesHC(p).filter(e=>vitalesHC(e)).sort((a,b)=>new Date(b.fechaHora||0)-new Date(a.fechaHora||0))[0]||null;
  }
  function cronologiaBreveHC(p,excludeId=''){
    return evolucionesHC(p).filter(e=>String(e.id)!==String(excludeId||'')).sort((a,b)=>new Date(b.fechaHora||0)-new Date(a.fechaHora||0)).slice(0,3);
  }
  function cronologiaCompletaHC(p,excludeId=''){
    return evolucionesHC(p).filter(e=>String(e.id)!==String(excludeId||'')).sort((a,b)=>new Date(b.fechaHora||0)-new Date(a.fechaHora||0));
  }
  function resumenEvolucionPrevHC(e){
    const partes=[];
    if(e?.motivo)partes.push(e.motivo);
    if(vitalesHC(e))partes.push(vitalesHC(e));
    return partes.join(' · ') || e?.diagnostico || e?.evolucion || 'Evolución clínica';
  }
  function renderDetailHC(key){
    const p=patientByKeyHC(key),box=$hc('hcPacienteDetalle');if(!p||!box)return;
    hcPacienteSeleccionado=patientKeyHC(p); renderSearchHC();
    const sum=resumenHC(p),evs=evolucionesHC(p),ats=atencionesHC(p),timeline=timelineHC(p),age=ageHC(p);
    box.innerHTML=`<div class="hc-patient-header"><div><h2>${escHC(nombrePacientePanel?.(p)||p.nombreCompleto||'Paciente')}</h2><p class="muted">DNI ${escHC(p.dni||'s/d')} · Nacimiento ${escHC(birthDisplayHC(p))} · ${escHC(age?age+' años':'Edad s/d')} · ${escHC(p.coberturaHabitual||'Cobertura s/d')}</p></div><div class="hc-patient-actions"><button class="primary" type="button" data-hc-new="${escHC(patientKeyHC(p))}">+ Nueva evolución</button><button class="secondary" type="button" data-hc-edit-patient409="${escHC(patientKeyHC(p))}" data-hc-edit-context409="detail">Editar ficha</button><button class="secondary" type="button" data-hc-edit-summary="${escHC(patientKeyHC(p))}">Resumen clínico</button><button class="secondary" type="button" data-hc-print="${escHC(patientKeyHC(p))}">Imprimir HC</button></div></div>
      <div class="hc-summary-grid"><div class="hc-summary-card"><span>Evoluciones</span><strong>${evs.length}</strong></div><div class="hc-summary-card"><span>Atenciones</span><strong>${ats.length}</strong></div><div class="hc-summary-card"><span>Último evento</span><strong>${timeline[0]?fmtDateTimeHC(timeline[0].date):'Sin registros'}</strong></div></div>${(()=>{const uv=ultimaEvolucionConVitalesHC(p);return uv?`<div class="hc-last-vitals410"><span>Últimos signos vitales registrados · ${escHC(fmtDateTimeHC(uv.fechaHora))}</span><strong>${vitalesHC(uv)}</strong></div>`:'';})()}
      <div class="hc-clinical-summary"><div class="hc-clinical-summary-title409"><h3>Resumen clínico</h3><button class="secondary small-btn" type="button" data-hc-edit-summary="${escHC(patientKeyHC(p))}">Editar</button></div><div class="hc-clinical-summary-grid"><div><strong>Antecedentes</strong><p>${escHC(sum.antecedentes||'Sin registrar')}</p></div><div><strong>Alergias</strong><p>${escHC(sum.alergias||'Sin registrar')}</p></div><div><strong>Medicación habitual</strong><p>${escHC(sum.medicacion||'Sin registrar')}</p></div></div>${sum.alertas?`<div class="hc-event-section"><label>Alertas</label><p>${escHC(sum.alertas)}</p></div>`:''}</div>
      <h3>Línea de tiempo clínica</h3><div class="hc-timeline">${timeline.length?timeline.map(x=>x.type==='evolution'?renderEvolutionEventHC(x.obj):renderAttentionEventHC(x.obj)).join(''):'<div class="hc-empty"><strong>Sin eventos</strong><span>Creá la primera evolución clínica.</span></div>'}</div>`;
  }
  function puedeEliminarEvolucionHC(){
    try{return (typeof esMatiasDuenio==='function'&&esMatiasDuenio())||(typeof esAdminComun==='function'&&esAdminComun());}catch(e){return false;}
  }
  function renderEvolutionEventHC(e){
    const editable=canEditHC(e),canDelete=puedeEliminarEvolucionHC();
    const cabecera=[e.motivo||'',vitalesHC(e)||''].filter(Boolean).join(' · ');
    return `<article class="hc-event hc-event-compact411" data-hc-evolution-id="${escHC(e.id)}" data-hc-attention-id="${escHC(e.atencionId||'')}"><div class="hc-event-head"><div><strong>${escHC(e.motivo||'Evolución clínica')}</strong><div class="hc-event-meta">${escHC(fmtDateTimeHC(e.fechaHora))} · ${escHC(e.profesionalNombre||'')}</div>${cabecera?`<div class="hc-event-compact-line411">${escHC(cabecera)}</div>`:''}</div><div class="hc-event-actions411b1">${editable?`<button class="secondary small-btn" data-hc-edit="${escHC(e.id)}">Editar</button>`:'<span class="hc-lock">Bloqueada +24 h</span>'}${canDelete?`<button class="secondary small-btn hc-delete411b1" data-hc-delete411b1="${escHC(e.id)}">Eliminar</button>`:''}</div></div>${e.evolucion?`<div class="hc-event-section"><label>Evolución / examen</label><p>${escHC(e.evolucion)}</p></div>`:''}${e.diagnostico?`<div class="hc-event-section"><label>Impresión diagnóstica</label><p>${escHC(e.diagnostico)}</p></div>`:''}${e.conducta?`<div class="hc-event-section"><label>Conducta / plan</label><p>${escHC(e.conducta)}</p></div>`:''}</article>`;
  }
  async function eliminarEvolucionHCProtegida411B1(id){
    if(!puedeEliminarEvolucionHC()){alert('Solo Administración puede eliminar una evolución.');return;}
    const ev=(data.evolucionesClinicas||[]).find(x=>String(x.id)===String(id));if(!ev)return;
    const clave=prompt('Eliminar evolución clínica. Ingresá la clave de administrador:');
    if(clave===null)return;
    const claveAdmin=(typeof CLAVE_DINERO_PERIODO!=='undefined'?CLAVE_DINERO_PERIODO:'matias2026');
    if(String(clave)!==String(claveAdmin)){alert('Clave incorrecta. No se eliminó nada.');return;}
    if(!confirm('¿Eliminar definitivamente esta evolución? Esta acción no se puede deshacer.'))return;
    const patientKey=ev.pacienteId||'';
    data.evolucionesClinicas=(data.evolucionesClinicas||[]).filter(x=>String(x.id)!==String(id));
    saveConfig();
    try{
      if(typeof supabaseClient!=='undefined'&&supabaseClient){
        const {error}=await supabaseClient.from('cardiolink_hc_evoluciones').delete().eq('id',String(id));
        if(error)throw error;
      }
    }catch(err){
      console.error('No se pudo eliminar la evolución relacional:',err);
      alert('Se quitó de la HC local, pero Supabase informó un error. No continúes borrando y revisemos la sincronización.');
    }
    try{renderDetailHC(patientKey);}catch(e){}
  }
  function renderAttentionEventHC(a){return `<article class="hc-event attention" data-hc-attention-id="${escHC(a.id)}"><div class="hc-event-head"><div><strong>${escHC(a.prestacion||'Atención')}</strong><div class="hc-event-meta">${escHC(formatFecha?.(a.fecha)||a.fecha||'')} ${escHC(a.horaInicio||'')} · ${escHC(a.profesional||'')}</div></div><span class="hc-lock">Atención administrativa</span></div><div class="hc-event-section"><label>Cobertura</label><p>${escHC(a.obraSocial||'s/d')}</p></div>${a.observaciones?`<div class="hc-event-section"><label>Observaciones</label><p>${escHC(a.observaciones)}</p></div>`:''}<div class="hc-event-section"><button class="secondary small-btn" data-hc-new="${escHC(hcPacienteSeleccionado)}" data-atencion-id="${escHC(a.id)}">Evolucionar esta atención</button></div></article>`;}
  function openEvolutionModalHC(key,evolutionId='',atencionId=''){
    const p=patientByKeyHC(key);if(!p)return;ensureHC();
    const existing=evolutionId?data.evolucionesClinicas.find(x=>x.id===evolutionId):null;
    if(existing&&!canEditHC(existing)){alert('Esta evolución superó las 24 horas y solo puede modificarse con perfil Administrador.');return;}
    const prof=profesionalHC(),now=new Date(),sum=resumenHC(p);
    const linked=atencionId||existing?.atencionId||'';
    const attention=linked?atencionesHC(p).find(a=>String(a.id)===String(linked)):null;
    const coverage=attention?.obraSocial||attention?.coberturaAtencion||p.coberturaHabitual||'s/d';
    const dob=birthISOHC(p),age=ageHC(p),phone=String(p.telefono||'').trim(),email=String(p.email||'').trim(),phoneDigits=cleanDigitsHC(phone);
    const infoText=patientInfoTextHC(p,coverage),patientKey=patientKeyHC(p);
    const overlay=document.createElement('div');overlay.id='hcEvolutionModal';overlay.className='hc-modal-overlay';overlay.dataset.summaryBaseline409=JSON.stringify({antecedentes:sum.antecedentes||'',alergias:sum.alergias||'',medicacion:sum.medicacion||'',alertas:sum.alertas||''});
    overlay.innerHTML=`<div class="hc-modal-card hc-evolution-card-408 hc-evolution-card-409"><div class="hc-modal-head"><div><h2>${existing?'Editar evolución':'Nueva evolución'}</h2><p class="muted">Registro clínico del paciente</p></div><button class="modal-close" type="button" data-hc-close>×</button></div>
      <section class="hc-patient-banner-408"><div class="hc-patient-title-408"><div><h3 data-hc-patient-name409>${escHC(nombrePacientePanel?.(p)||p.nombreCompleto||'Paciente')}</h3>${p.fechaNacimiento&&!dob?'<div class="hc-invalid-date409">Fecha de nacimiento inválida: corregila para calcular la edad.</div>':''}</div><div class="hc-patient-title-actions409"><span>${linked?'Atención vinculada':'Evolución sin turno'}</span><button class="secondary small-btn" type="button" data-hc-edit-patient409="${escHC(patientKey)}" data-hc-edit-context409="evolution">Editar ficha</button></div></div>
        <div class="hc-patient-data-408"><div><span>DNI</span><strong data-hc-field409="dni">${escHC(p.dni||'s/d')}</strong></div><div><span>Fecha de nacimiento</span><strong data-hc-field409="birth">${escHC(dob?(formatFecha?.(dob)||dob):(p.fechaNacimiento?'Fecha inválida':'s/d'))}</strong></div><div><span>Edad</span><strong data-hc-field409="age">${escHC(age?age+' años':'s/d')}</strong></div><div><span>Sexo</span><strong data-hc-field409="sex">${escHC(p.sexo||'s/d')}</strong></div><div><span>Obra social</span><strong data-hc-field409="coverage">${escHC(coverage)}</strong></div><div><span>N.º afiliado</span><strong data-hc-field409="affiliate">${escHC(p.numeroAfiliadoHabitual||attention?.numeroAfiliadoAtencion||'s/d')}</strong></div><div><span>Teléfono</span><strong data-hc-field409="phone">${escHC(phone||'s/d')}</strong></div><div><span>Email</span><strong data-hc-field409="email">${escHC(email||'s/d')}</strong></div></div>
        <div class="hc-copy-actions-408" id="hcCopyActions409">${copyActionsHtmlHC409(p,coverage,infoText,phoneDigits)}</div>
      </section>
      <div class="hc-context-cards409"><div><span>Fecha y hora</span><strong>${escHC(fmtDateTimeHC(existing?.fechaHora||now.toISOString()))}</strong></div><div><span>Profesional</span><strong>${escHC(existing?.profesionalNombre||prof.nombre)}</strong></div><div><span>Vinculación</span><strong>${linked?(attention?`${escHC(attention.prestacion||'Atención')} · ${escHC(formatFecha?.(attention.fecha)||attention.fecha||'')}`:'Atención vinculada'):'Sin turno'}</strong></div></div>
      ${(()=>{const prev=cronologiaBreveHC(p,existing?.id||''),allPrev=cronologiaCompletaHC(p,existing?.id||'');return `<section class="hc-prev-evolutions410" id="hcPrevSection411" data-hc-prev-all411="${escHC(encodeURIComponent(JSON.stringify(allPrev.map(e=>({id:e.id,fechaHora:e.fechaHora,motivo:e.motivo||'',evolucion:e.evolucion||'',diagnostico:e.diagnostico||'',conducta:e.conducta||'',vitales:vitalesHC(e)})))))}"><div class="hc-prev-head410"><div><h3>Últimas evoluciones</h3><span>${prev.length?'Contexto clínico previo':'Sin evoluciones previas'}</span></div>${allPrev.length?`<div class="hc-prev-actions411"><button class="secondary small-btn" type="button" id="hcVerTodas411">${allPrev.length>3?'Ver todas':'Ver detalle'}</button>${!existing?`<button class="secondary small-btn" type="button" id="hcContinuarUltima411">Continuar última</button>`:''}</div>`:''}</div><div id="hcPrevList411">${prev.length?prev.map(e=>`<article><strong>${escHC(fmtDateTimeHC(e.fechaHora))}</strong><span>${escHC(e.motivo||e.diagnostico||e.evolucion||'Evolución clínica')}</span>${vitalesHC(e)?`<small>${vitalesHC(e)}</small>`:''}</article>`).join(''):`<div class="muted">Esta será la primera evolución clínica registrada.</div>`}</div>${allPrev.length&&!existing?`<div class="hc-continue-panel411 hidden" id="hcContinuePanel411"><div><strong>Traer de la última evolución</strong><p class="muted">Elegí qué campos querés reutilizar. No se copian signos vitales, fecha ni datos permanentes.</p></div><div class="hc-continue-options411"><label><input type="checkbox" data-hc-copyfield411="motivo"> Motivo</label><label><input type="checkbox" data-hc-copyfield411="evolucion"> Evolución / examen</label><label><input type="checkbox" data-hc-copyfield411="diagnostico"> Diagnóstico</label><label><input type="checkbox" data-hc-copyfield411="conducta"> Conducta / plan</label></div><div class="hc-continue-actions411"><button type="button" class="secondary small-btn" id="hcCancelarContinuar411">Cancelar</button><button type="button" class="primary small-btn" id="hcAplicarContinuar411">Traer seleccionados</button></div></div>`:''}</section>`;})()}
      <section class="hc-vitals-section410"><div class="hc-permanent-title409"><div><h3>Signos vitales y antropometría</h3><p class="muted">Opcionales. En una evolución nueva comienzan siempre en blanco; no se copian valores anteriores.</p></div></div><div class="hc-vitals-grid410">
        <label>Peso (kg)<input id="hcPeso410" type="number" inputmode="decimal" min="0" step="0.1" value="${existing?.pesoKg??''}" placeholder="Ej. 88"></label>
        <label>Talla (cm)<input id="hcTalla410" type="number" inputmode="decimal" min="0" step="0.1" value="${existing?.tallaCm??''}" placeholder="Ej. 185"></label>
        <label>IMC<input id="hcImc410" type="text" value="${existing?.imc??''}" placeholder="Automático" readonly></label>
        <label>TA sistólica<input id="hcTas410" type="number" inputmode="numeric" min="0" step="1" value="${existing?.taSistolica??''}" placeholder="120"></label>
        <label>TA diastólica<input id="hcTad410" type="number" inputmode="numeric" min="0" step="1" value="${existing?.taDiastolica??''}" placeholder="80"></label>
        <label>FC (lpm)<input id="hcFc410" type="number" inputmode="numeric" min="0" step="1" value="${existing?.frecuenciaCardiaca??''}" placeholder="70"></label>
        <label>SatO₂ (%)<input id="hcSat410" type="number" inputmode="decimal" min="0" max="100" step="0.1" value="${existing?.sato2??''}" placeholder="98"></label>
      </div></section>
      <section class="hc-permanent-data409"><div class="hc-permanent-title409"><div><h3>Datos clínicos permanentes</h3><p class="muted">Se actualizan en el resumen del paciente y quedan visibles en futuras consultas.</p></div></div><div class="hc-permanent-grid409"><div><div class="cl-voice-label4094"><label for="hcSumAntecedentes409">Antecedentes</label><button class="cl-voice-btn4094" type="button" data-cl-voice-target4094="hcSumAntecedentes409" aria-label="Dictar antecedentes">🎤 Dictar</button></div><textarea id="hcSumAntecedentes409" rows="3" placeholder="HTA, DBT, cirugías, antecedentes relevantes...">${escHC(sum.antecedentes||'')}</textarea></div><div><div class="cl-voice-label4094"><label for="hcSumAlergias409">Alergias</label><button class="cl-voice-btn4094" type="button" data-cl-voice-target4094="hcSumAlergias409" aria-label="Dictar alergias">🎤 Dictar</button></div><textarea id="hcSumAlergias409" rows="3" placeholder="Fármacos, alimentos u otras alergias...">${escHC(sum.alergias||'')}</textarea></div><div><div class="cl-voice-label4094"><label for="hcSumMedicacion409">Medicación habitual</label><button class="cl-voice-btn4094" type="button" data-cl-voice-target4094="hcSumMedicacion409" aria-label="Dictar medicación habitual">🎤 Dictar</button></div><textarea id="hcSumMedicacion409" rows="3" placeholder="Medicamento, dosis y esquema...">${escHC(sum.medicacion||'')}</textarea></div></div></section>
      <div class="hc-modal-grid hc-evolution-grid-408"><div class="full hc-motive-field-408"><div class="cl-voice-label4094"><label for="hcMotivo">Motivo de consulta</label><button class="cl-voice-btn4094" type="button" data-cl-voice-target4094="hcMotivo" aria-label="Dictar motivo de consulta">🎤 Dictar</button></div><input id="hcMotivo" type="text" placeholder="Ej.: control de HTA, dolor precordial, apto físico" value="${escHC(existing?.motivo||'')}"></div><div class="full hc-main-evolution-408"><div class="cl-voice-label4094"><label for="hcEvolucion">Evolución / examen físico</label><button class="cl-voice-btn4094" type="button" data-cl-voice-target4094="hcEvolucion" aria-label="Dictar evolución y examen físico">🎤 Dictar</button></div><textarea id="hcEvolucion" placeholder="Narrativa clínica, hallazgos, signos vitales...">${escHC(existing?.evolucion||'')}</textarea></div><div><div class="cl-voice-label4094"><label for="hcDiagnostico">Impresión diagnóstica</label><button class="cl-voice-btn4094" type="button" data-cl-voice-target4094="hcDiagnostico" aria-label="Dictar impresión diagnóstica">🎤 Dictar</button></div><textarea id="hcDiagnostico" placeholder="Diagnósticos o problemas activos">${escHC(existing?.diagnostico||'')}</textarea></div><div><div class="cl-voice-label4094"><label for="hcConducta">Conducta / plan</label><button class="cl-voice-btn4094" type="button" data-cl-voice-target4094="hcConducta" aria-label="Dictar conducta y plan">🎤 Dictar</button></div><textarea id="hcConducta" placeholder="Tratamiento, indicaciones, estudios, control">${escHC(existing?.conducta||'')}</textarea></div></div><div class="hc-modal-actions"><button class="secondary" type="button" data-hc-close>Cancelar</button><button class="primary" type="button" id="hcGuardarEvolucion">${existing?'Guardar cambios':'Guardar evolución'}</button></div></div>`;
    document.body.appendChild(overlay);
    const recalcularImc410=()=>{const v=imcHC($hc('hcPeso410')?.value,$hc('hcTalla410')?.value);if($hc('hcImc410'))$hc('hcImc410').value=v??'';};
    $hc('hcPeso410')?.addEventListener('input',recalcularImc410);$hc('hcTalla410')?.addEventListener('input',recalcularImc410);recalcularImc410();

    const prevSection411=$hc('hcPrevSection411');
    let prevAll411=[];
    try{prevAll411=JSON.parse(decodeURIComponent(prevSection411?.dataset.hcPrevAll411||''));}catch(e){prevAll411=[];}
    let mostrandoTodas411=false;
    const pintarPrev411=()=>{
      const list=$hc('hcPrevList411');if(!list)return;
      const arr=mostrandoTodas411?prevAll411:prevAll411.slice(0,3);
      list.innerHTML=arr.length?arr.map(e=>`<article><strong>${escHC(fmtDateTimeHC(e.fechaHora))}</strong><span>${escHC(e.motivo||e.diagnostico||e.evolucion||'Evolución clínica')}</span>${e.vitales?`<small>${escHC(e.vitales)}</small>`:''}${mostrandoTodas411?`${e.evolucion?`<p><b>Evolución:</b> ${escHC(e.evolucion)}</p>`:''}${e.diagnostico?`<p><b>Diagnóstico:</b> ${escHC(e.diagnostico)}</p>`:''}${e.conducta?`<p><b>Conducta:</b> ${escHC(e.conducta)}</p>`:''}`:''}</article>`).join(''):'<div class="muted">Esta será la primera evolución clínica registrada.</div>';
      if($hc('hcVerTodas411'))$hc('hcVerTodas411').textContent=mostrandoTodas411?'Ver últimas 3':(prevAll411.length>3?'Ver todas':'Ver detalle');
    };
    $hc('hcVerTodas411')?.addEventListener('click',()=>{mostrandoTodas411=!mostrandoTodas411;pintarPrev411();});
    $hc('hcContinuarUltima411')?.addEventListener('click',()=>{$hc('hcContinuePanel411')?.classList.remove('hidden');});
    $hc('hcCancelarContinuar411')?.addEventListener('click',()=>{$hc('hcContinuePanel411')?.classList.add('hidden');});
    $hc('hcAplicarContinuar411')?.addEventListener('click',()=>{
      const last=prevAll411[0];if(!last)return;
      const map={motivo:'hcMotivo',evolucion:'hcEvolucion',diagnostico:'hcDiagnostico',conducta:'hcConducta'};
      const selected=[...overlay.querySelectorAll('[data-hc-copyfield411]:checked')].map(x=>x.dataset.hcCopyfield411);
      if(!selected.length){alert('Elegí al menos un campo para traer.');return;}
      selected.forEach(k=>{const el=$hc(map[k]);if(el)el.value=last[k]||'';});
      $hc('hcContinuePanel411')?.classList.add('hidden');
      overlay.querySelectorAll('[data-hc-copyfield411]').forEach(x=>x.checked=false);
    });

    $hc('hcGuardarEvolucion').onclick=()=>saveEvolutionHC(p,existing,linked);
  }
  function saveEvolutionHC(p,existing,atencionId){
    const motivo=$hc('hcMotivo')?.value.trim()||'',evolucion=$hc('hcEvolucion')?.value.trim()||'',diagnostico=$hc('hcDiagnostico')?.value.trim()||'',conducta=$hc('hcConducta')?.value.trim()||'';
    const pesoKg=numHC($hc('hcPeso410')?.value),tallaCm=numHC($hc('hcTalla410')?.value),imc=imcHC(pesoKg,tallaCm),taSistolica=numHC($hc('hcTas410')?.value),taDiastolica=numHC($hc('hcTad410')?.value),frecuenciaCardiaca=numHC($hc('hcFc410')?.value),sato2=numHC($hc('hcSat410')?.value);
    const hasVitales=[pesoKg,tallaCm,taSistolica,taDiastolica,frecuenciaCardiaca,sato2].some(v=>v!==null);
    const summaryNow={antecedentes:$hc('hcSumAntecedentes409')?.value.trim()||'',alergias:$hc('hcSumAlergias409')?.value.trim()||'',medicacion:$hc('hcSumMedicacion409')?.value.trim()||'',alertas:resumenHC(p).alertas||''};
    let summaryBefore={};try{summaryBefore=JSON.parse($hc('hcEvolutionModal')?.dataset.summaryBaseline409||'{}');}catch(e){}
    const summaryChanged=['antecedentes','alergias','medicacion'].some(k=>(summaryNow[k]||'')!==(summaryBefore[k]||''));
    const hasEvolution=!!(motivo||evolucion||diagnostico||conducta||hasVitales);
    if(!hasEvolution&&!summaryChanged){alert('No hay datos nuevos para guardar.');return;}
    ensureHC();const prof=profesionalHC(),now=new Date().toISOString(),key=patientKeyHC(p);
    if(summaryChanged)data.resumenesClinicos[key]={...resumenHC(p),...summaryNow,actualizadoEn:now,actualizadoPor:prof.nombre};
    if(existing){
      if(!hasEvolution){alert('Una evolución existente no puede quedar completamente vacía.');return;}
      Object.assign(existing,{motivo,evolucion,diagnostico,conducta,pesoKg,tallaCm,imc,taSistolica,taDiastolica,frecuenciaCardiaca,sato2,actualizadoEn:now,actualizadoPor:prof.nombre});
    }else if(hasEvolution){
      data.evolucionesClinicas.push({id:'evo_'+Date.now()+'_'+Math.floor(Math.random()*10000),pacienteId:key,dni:p.dni||'',pacienteNombre:nombrePacientePanel?.(p)||p.nombreCompleto||'',atencionId:atencionId||'',fechaHora:now,profesionalId:prof.id,profesionalNombre:prof.nombre,motivo,evolucion,diagnostico,conducta,pesoKg,tallaCm,imc,taSistolica,taDiastolica,frecuenciaCardiaca,sato2,creadoEn:now});
    }
    saveConfig();try{programarSyncSupabase?.();}catch(e){}
    // v4.1.0-hc: copia clínica relacional adicional en Supabase.
    // La HC local/config sigue siendo compatible durante esta fase de transición.
    try{window.cardiolinkClinica410?.sincronizarPacienteCompleto?.(p);}catch(e){console.warn('No se pudo sincronizar la capa clínica relacional:',e);}
    // Al guardar una evolución vinculada, el turno se considera finalizado y pasa a "Atendido".
    if(hasEvolution&&atencionId){
      try{
        const linkedAttention=(typeof atenciones!=='undefined'&&Array.isArray(atenciones))?atenciones.find(a=>String(a.id)===String(atencionId)):null;
        if(linkedAttention){
          linkedAttention.estadoTurno='atendido';
          linkedAttention.estadoTurnoEditadoPor=(typeof nombreUsuarioAuditoria==='function'?nombreUsuarioAuditoria():prof.nombre);
          linkedAttention.estadoTurnoEditadoEn=now;
          if(typeof selloAuditoriaEdicion==='function')selloAuditoriaEdicion(linkedAttention);
          saveAtenciones?.();renderAgenda?.();renderTabla?.();renderStats?.();
        }
      }catch(e){console.warn('La evolución se guardó, pero no se pudo marcar el turno como atendido.',e);}
    }
    $hc('hcEvolutionModal')?.remove();renderDetailHC(key);
    if(!hasEvolution&&summaryChanged)setTimeout(()=>alert('Resumen clínico actualizado. No se creó una evolución en blanco.'),30);
  }
  function editSummaryHC(key){
    const p=patientByKeyHC(key);if(!p)return;const s=resumenHC(p),o=document.createElement('div');o.id='hcSummaryModal';o.className='hc-modal-overlay';o.innerHTML=`<div class="hc-modal-card"><div class="hc-modal-head"><div><h2>Resumen clínico</h2><p class="muted">${escHC(nombrePacientePanel?.(p)||p.nombreCompleto||'')}</p></div><button class="modal-close" data-hc-close-summary>×</button></div><div class="hc-modal-grid"><div><div class="cl-voice-label4094"><label for="hcSumAntecedentes">Antecedentes</label><button class="cl-voice-btn4094" type="button" data-cl-voice-target4094="hcSumAntecedentes" aria-label="Dictar antecedentes">🎤 Dictar</button></div><textarea id="hcSumAntecedentes">${escHC(s.antecedentes||'')}</textarea></div><div><div class="cl-voice-label4094"><label for="hcSumAlergias">Alergias</label><button class="cl-voice-btn4094" type="button" data-cl-voice-target4094="hcSumAlergias" aria-label="Dictar alergias">🎤 Dictar</button></div><textarea id="hcSumAlergias">${escHC(s.alergias||'')}</textarea></div><div><div class="cl-voice-label4094"><label for="hcSumMedicacion">Medicación habitual</label><button class="cl-voice-btn4094" type="button" data-cl-voice-target4094="hcSumMedicacion" aria-label="Dictar medicación habitual">🎤 Dictar</button></div><textarea id="hcSumMedicacion">${escHC(s.medicacion||'')}</textarea></div><div><div class="cl-voice-label4094"><label for="hcSumAlertas">Alertas clínicas</label><button class="cl-voice-btn4094" type="button" data-cl-voice-target4094="hcSumAlertas" aria-label="Dictar alertas clínicas">🎤 Dictar</button></div><textarea id="hcSumAlertas">${escHC(s.alertas||'')}</textarea></div></div><div class="hc-modal-actions"><button class="secondary" data-hc-close-summary>Cancelar</button><button class="primary" id="hcSaveSummary">Guardar resumen</button></div></div>`;document.body.appendChild(o);$hc('hcSaveSummary').onclick=()=>{ensureHC();data.resumenesClinicos[patientKeyHC(p)]={antecedentes:$hc('hcSumAntecedentes').value.trim(),alergias:$hc('hcSumAlergias').value.trim(),medicacion:$hc('hcSumMedicacion').value.trim(),alertas:$hc('hcSumAlertas').value.trim(),actualizadoEn:new Date().toISOString()};saveConfig();try{programarSyncSupabase?.();}catch(e){}try{window.cardiolinkClinica410?.sincronizarPacienteCompleto?.(p);}catch(e){console.warn('No se pudo sincronizar el resumen clínico relacional:',e);}o.remove();renderDetailHC(patientKeyHC(p));};
  }
  function printHC(key){const p=patientByKeyHC(key);if(!p)return;const s=resumenHC(p),tl=timelineHC(p);const w=window.open('','_blank');if(!w)return;w.document.write(`<html><head><title>Historia clínica - ${escHC(nombrePacientePanel?.(p)||p.nombreCompleto||'')}</title><style>body{font-family:Arial,sans-serif;margin:32px;color:#111}h1{margin-bottom:4px}.muted{color:#555}.box{border:1px solid #bbb;border-radius:10px;padding:12px;margin:12px 0}.event{border-left:4px solid #174b5c;padding:8px 14px;margin:14px 0;page-break-inside:avoid}label{font-size:11px;text-transform:uppercase;color:#555;font-weight:bold}p{white-space:pre-wrap}</style></head><body><h1>${escHC(nombrePacientePanel?.(p)||p.nombreCompleto||'')}</h1><div class="muted">DNI ${escHC(p.dni||'s/d')} · Fecha de emisión ${escHC(fmtDateTimeHC(new Date().toISOString()))}</div><div class="box"><strong>Antecedentes:</strong> ${escHC(s.antecedentes||'s/d')}<br><strong>Alergias:</strong> ${escHC(s.alergias||'s/d')}<br><strong>Medicación:</strong> ${escHC(s.medicacion||'s/d')}</div>${tl.map(x=>x.type==='evolution'?`<div class="event"><h3>Evolución clínica · ${escHC(fmtDateTimeHC(x.obj.fechaHora))}</h3><div>${escHC(x.obj.profesionalNombre||'')}</div>${x.obj.motivo?`<p><label>Motivo</label><br>${escHC(x.obj.motivo)}</p>`:''}${x.obj.evolucion?`<p><label>Evolución</label><br>${escHC(x.obj.evolucion)}</p>`:''}${x.obj.diagnostico?`<p><label>Diagnóstico</label><br>${escHC(x.obj.diagnostico)}</p>`:''}${x.obj.conducta?`<p><label>Conducta</label><br>${escHC(x.obj.conducta)}</p>`:''}</div>`:`<div class="event"><h3>${escHC(x.obj.prestacion||'Atención')} · ${escHC(formatFecha?.(x.obj.fecha)||x.obj.fecha||'')}</h3><div>${escHC(x.obj.profesional||'')} · ${escHC(x.obj.obraSocial||'')}</div></div>`).join('')}</body></html>`);w.document.close();setTimeout(()=>w.print(),300);}
  function addPatientButtonHC(){
    const old=window.seleccionarPacientePanel;if(typeof old!=='function'||old.__hcWrapped)return;
    const wrapped=function(id){const r=old.apply(this,arguments);setTimeout(()=>{const actions=document.querySelector('#pacienteDetalle .paciente-ficha-actions');if(actions&&!actions.querySelector('[data-open-hc]')){const b=document.createElement('button');b.className='primary';b.type='button';b.dataset.openHc=id;b.textContent='Historia clínica';actions.prepend(b);}},0);return r};wrapped.__hcWrapped=true;window.seleccionarPacientePanel=wrapped;
  }
  function bootHC(){ensureHC();addPatientButtonHC();
    const search=$hc('hcBuscarPaciente');
    $hc('hcBtnBuscar')?.addEventListener('click',()=>{hcPaginaResultados=1;renderSearchHC(true);});
    search?.addEventListener('input',()=>{hcPaginaResultados=1;renderSearchHC(false);});
    search?.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();hcPaginaResultados=1;renderSearchHC(true);}});
    $hc('hcLimpiarBusqueda')?.addEventListener('click',()=>{if(search)search.value='';hcPaginaResultados=1;renderSearchHC(false);});
    document.addEventListener('click',e=>{
      const copyBtn=e.target.closest?.('[data-hc-copy408]');
      if(copyBtn){e.preventDefault();const value=decodeURIComponent(copyBtn.dataset.hcCopy408||'');copyHC408(value,copyBtn.dataset.hcCopyLabel408||'dato',copyBtn);return;}
      const page=e.target.closest?.('[data-hc-page]');
      if(page&&!page.disabled){e.preventDefault();hcPaginaResultados=Number(page.dataset.hcPage)||1;renderSearchHC(false);$hc('hcResultadosResumen')?.scrollIntoView({behavior:'smooth',block:'nearest'});return;}
      const nav=e.target.closest?.('[data-section="hc"]');
      if(nav){setTimeout(()=>renderSearchHC(false),80);return;}
      const t=e.target.closest('[data-hc-patient],[data-hc-new],[data-hc-edit],[data-hc-delete411b1],[data-hc-edit-summary],[data-hc-edit-patient409],[data-hc-print],[data-hc-close],[data-hc-close-summary],[data-hc-close-patient409],[data-open-hc]');if(!t)return;
      if(t.dataset.hcPatient)renderDetailHC(t.dataset.hcPatient);else if(t.dataset.hcNew)openEvolutionModalHC(t.dataset.hcNew,'',t.dataset.atencionId||'');else if(t.dataset.hcEdit){const ev=data.evolucionesClinicas.find(x=>x.id===t.dataset.hcEdit);if(ev)openEvolutionModalHC(ev.pacienteId,ev.id,ev.atencionId||'');}else if(t.dataset.hcDelete411b1){eliminarEvolucionHCProtegida411B1(t.dataset.hcDelete411b1);}else if(t.dataset.hcEditSummary)editSummaryHC(t.dataset.hcEditSummary);else if(t.dataset.hcEditPatient409)openPatientEditHC(t.dataset.hcEditPatient409,t.dataset.hcEditContext409||'detail');else if(t.dataset.hcPrint)printHC(t.dataset.hcPrint);else if(t.hasAttribute('data-hc-close'))$hc('hcEvolutionModal')?.remove();else if(t.hasAttribute('data-hc-close-summary'))$hc('hcSummaryModal')?.remove();else if(t.hasAttribute('data-hc-close-patient409'))$hc('hcPatientEditModal409')?.remove();else if(t.dataset.openHc){showSection('hc');setTimeout(()=>renderDetailHC(t.dataset.openHc),40);}
    });
    // Mostrar pacientes desde el ingreso y volver a calcular tras la sincronización inicial.
    setTimeout(()=>renderSearchHC(false),50);setTimeout(()=>renderSearchHC(false),900);setTimeout(()=>renderSearchHC(false),2200);
    document.title='CardioLink 4.1.0-hc HC';document.querySelectorAll('.brand-main span,.mobile-app-title-370 span').forEach(x=>x.textContent='v4.1.0-hc');
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bootHC);else bootHC();
  window.abrirNuevaEvolucionHC=(id,atencionId='')=>openEvolutionModalHC(id,'',atencionId);
})();


/* ===== CardioLink 4.1.0-hc · HC profesional, pendientes y convenios por profesional ===== */
(function(){
  'use strict';
  const VERSION_402='4.1.0-hc';
  const $402=id=>document.getElementById(id);
  const esc402=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const norm402=s=>String(s??'').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const copy402=v=>JSON.parse(JSON.stringify(v));

  function currentUser402(){
    try{return typeof perfilUsuarioActual==='function'?perfilUsuarioActual():(window.usuarioPerfilActual||{});}catch(e){return window.usuarioPerfilActual||{};}
  }
  function canMedical402(){
    try{if(typeof esMatiasDuenio==='function'&&esMatiasDuenio())return true;if(typeof esAdminComun==='function'&&esAdminComun())return true;if(typeof esMedico==='function'&&esMedico())return true;}catch(e){}
    const u=currentUser402();const r=norm402(u.rolId||u.rol||u.baseRole||'');return r.includes('medico')||r.includes('director')||r.includes('duenio')||r.includes('admin');
  }
  function canAdminConfig402(){try{return !!(esMatiasDuenio?.()||esAdminComun?.())}catch(e){return false}}
  function currentProfessionalId402(){
    try{return typeof profesionalIdUsuarioActual==='function'?profesionalIdUsuarioActual():(currentUser402().profesionalId||'');}catch(e){return currentUser402().profesionalId||'';}
  }
  function prof402(id){return (data?.profesionales||[]).find(p=>String(p.id)===String(id))||null;}
  function profName402(id){return prof402(id)?.nombre||id||'Profesional';}
  function patientKey402(p){
    if(!p)return '';
    try{
      if(p.id)return p.id;
      const dni=typeof dniLimpio==='function'?dniLimpio(p.dni||''):String(p.dni||'').replace(/\D/g,'');
      const nombre=typeof normalizarTexto==='function'?normalizarTexto(patientName402(p)):norm402(patientName402(p));
      return 'legacy_'+(dni||nombre);
    }catch(e){return p.id||p.dni||'';}
  }
  function patients402(){try{return typeof todosPacientes==='function'?todosPacientes():(data?.pacientes||[]);}catch(e){return data?.pacientes||[];}}
  function patient402(key){return patients402().find(p=>String(p.id||'')===String(key)||patientKey402(p)===String(key))||null;}
  function patientName402(p){try{return typeof nombrePacientePanel==='function'?nombrePacientePanel(p):(p.nombreCompleto||p.paciente||p.nombre||'Paciente');}catch(e){return p?.nombreCompleto||p?.paciente||p?.nombre||'Paciente';}}
  function attention402(id){return (window.atenciones||atenciones||[]).find(a=>String(a.id)===String(id))||null;}
  function specialities402(p){
    const names=(p?.especialidadIds||[]).map(id=>(data?.especialidades||[]).find(e=>e.id===id)?.nombre).filter(Boolean);
    return names.length?names.join(' · '):(p?.area||'');
  }
  function ensure402(){
    if(!data||typeof data!=='object')return;
    if(!data.notasInternasMedicas||typeof data.notasInternasMedicas!=='object')data.notasInternasMedicas={};
    if(!data.notasInternasPorProfesional||typeof data.notasInternasPorProfesional!=='object')data.notasInternasPorProfesional={};
    if(!data.migracionesCardioLink||typeof data.migracionesCardioLink!=='object')data.migracionesCardioLink={};
    if(!data.migracionesCardioLink.notasPrivadas407){
      if(!data.notasInternasPorProfesional.matias||typeof data.notasInternasPorProfesional.matias!=='object')data.notasInternasPorProfesional.matias={};
      Object.entries(data.notasInternasMedicas||{}).forEach(([patientKey,note])=>{
        if(data.notasInternasPorProfesional.matias[patientKey]===undefined)data.notasInternasPorProfesional.matias[patientKey]=copy402(note);
      });
      data.migracionesCardioLink.notasPrivadas407={fecha:new Date().toISOString(),destino:'matias'};
    }
    if(!data.conveniosPorProfesional||typeof data.conveniosPorProfesional!=='object')data.conveniosPorProfesional={};
    if(!data.arancelesPorProfesional||typeof data.arancelesPorProfesional!=='object')data.arancelesPorProfesional={};
    if(!Array.isArray(data.conveniosPorProfesional.matias))data.conveniosPorProfesional.matias=copy402(Array.isArray(data.conveniosFacturacion)?data.conveniosFacturacion:[]);
    if(!Array.isArray(data.arancelesPorProfesional.matias))data.arancelesPorProfesional.matias=copy402(Array.isArray(data.arancelesConvenios)?data.arancelesConvenios:[]);
    (data.profesionales||[]).filter(p=>p.id!=='general').forEach(p=>{
      if(!Array.isArray(data.conveniosPorProfesional[p.id]))data.conveniosPorProfesional[p.id]=[];
      if(!data.conveniosPorProfesional[p.id].some(c=>norm402(c?.obraSocial)==='particular'))data.conveniosPorProfesional[p.id].push(defaultConv402(p.id,'Particular'));
      if(!Array.isArray(data.arancelesPorProfesional[p.id]))data.arancelesPorProfesional[p.id]=[];
      if(p.marcaDocumento===undefined)p.marcaDocumento=p.id==='matias'?'Consultorio Médico RM':p.nombre;
      if(p.logoDocumento===undefined)p.logoDocumento='icons/icon-192.png';
      if(p.telefonoDocumento===undefined)p.telefonoDocumento='';
      if(p.emailDocumento===undefined)p.emailDocumento='';
      if(p.direccionDocumento===undefined)p.direccionDocumento='';
      if(p.redesDocumento===undefined)p.redesDocumento='';
      if(p.matriculaNacional===undefined)p.matriculaNacional=p.id==='matias'?'M.N. 115.607':'';
      if(p.matriculaProvincial===undefined)p.matriculaProvincial=p.id==='matias'?'M.P. 332.578':'';
    });
  }
  function persist402(){
    try{saveConfig?.();}catch(e){console.error(e)}
    try{guardarConfigEnSupabase298?.();}catch(e){}
    try{programarSyncSupabase?.();}catch(e){}
  }
  function setVersion402(){
    document.title=`CardioLink Admin v${VERSION_402}`;
    document.querySelectorAll('.brand-main span,.mobile-app-title-370 span').forEach(el=>el.textContent=`v${VERSION_402}`);
    document.querySelectorAll('.login-meta').forEach(el=>el.textContent=`Versión ${VERSION_402} · 2026`);
    document.querySelectorAll('.print-title h2').forEach(el=>el.textContent=`CardioLink Admin v${VERSION_402}`);
  }

  /* Datos profesionales que se imprimen en documentos */
  function injectDocumentFields402(){
    const editor=document.querySelector('#cfgPerfilProfesional310 .profile-editor-310');
    if(!editor||$402('docProfFields402'))return;
    const block=document.createElement('div');block.id='docProfFields402';block.className='doc-prof-fields-402';
    block.innerHTML=`<h4>Encabezado de documentos</h4><p class="muted">Estos datos se usan en la Historia Clínica impresa y futuros informes.</p>
      <label>Marca / consultorio<input id="docMarca402" placeholder="Ej. Consultorio Médico RM"></label>
      <label>Logo (ruta o URL)<input id="docLogo402" placeholder="icons/icon-192.png"></label>
      <label>Matrícula nacional<input id="docMN402" placeholder="M.N. ..."></label>
      <label>Matrícula provincial<input id="docMP402" placeholder="M.P. ..."></label>
      <label>Teléfono<input id="docTelefono402" placeholder="Teléfono / WhatsApp"></label>
      <label>Email<input id="docEmail402" type="email" placeholder="correo@consultorio.com"></label>
      <label>Dirección del consultorio<input id="docDireccion402" placeholder="Dirección, localidad"></label>
      <label>Redes / web<input id="docRedes402" placeholder="Instagram, web u otras redes"></label>
      <button class="secondary" id="guardarDocProf402" type="button">Guardar datos para documentos</button>`;
    editor.appendChild(block);loadDocumentFields402();
  }
  function loadDocumentFields402(){
    ensure402();const id=$402('cfgProfEditar310')?.value||currentProfessionalId402()||'matias',p=prof402(id);if(!p)return;
    const vals={docMarca402:p.marcaDocumento,docLogo402:p.logoDocumento,docMN402:p.matriculaNacional,docMP402:p.matriculaProvincial,docTelefono402:p.telefonoDocumento,docEmail402:p.emailDocumento,docDireccion402:p.direccionDocumento,docRedes402:p.redesDocumento};
    Object.entries(vals).forEach(([id,v])=>{if($402(id))$402(id).value=v||'';});
  }
  function saveDocumentFields402(){
    ensure402();const p=prof402($402('cfgProfEditar310')?.value||currentProfessionalId402()||'matias');if(!p)return;
    p.marcaDocumento=$402('docMarca402')?.value.trim()||p.nombre;
    p.logoDocumento=$402('docLogo402')?.value.trim()||'icons/icon-192.png';
    p.matriculaNacional=$402('docMN402')?.value.trim()||'';p.matriculaProvincial=$402('docMP402')?.value.trim()||'';
    p.telefonoDocumento=$402('docTelefono402')?.value.trim()||'';p.emailDocumento=$402('docEmail402')?.value.trim()||'';
    p.direccionDocumento=$402('docDireccion402')?.value.trim()||'';p.redesDocumento=$402('docRedes402')?.value.trim()||'';
    persist402();alert('Datos profesionales guardados para documentos e impresiones.');
  }

  /* Nota interna privada por profesional */
  const noteTags402=['Recomendado','Amigo / familiar','Atención preferente','Comunicación demandante','Antecedente de conflicto','Agradecimiento / regalo','Otro'];
  function noteOwnerId402(){
    const direct=currentProfessionalId402();
    if(direct)return direct;
    const active=$402('perfilActivo')?.value;
    if(active&&active!=='general')return active;
    const u=currentUser402();
    return 'usuario_'+String(u.usuario||u.id||'sin_perfil').replace(/[^a-zA-Z0-9_-]+/g,'_');
  }
  function noteOwnerName402(){
    const id=noteOwnerId402();
    return prof402(id)?.nombre||currentUser402().nombre||currentUser402().usuario||'Perfil actual';
  }
  function noteBucket402(){
    ensure402();const owner=noteOwnerId402();
    if(!data.notasInternasPorProfesional[owner]||typeof data.notasInternasPorProfesional[owner]!=='object')data.notasInternasPorProfesional[owner]={};
    return data.notasInternasPorProfesional[owner];
  }
  function note402(key){return noteBucket402()[key]||{tags:[],texto:'',actualizadoEn:'',actualizadoPor:'',profesionalId:noteOwnerId402()};}
  function noteCard402(key,compact=false){
    if(!canMedical402())return '';
    const n=note402(key),tags=(n.tags||[]).map(t=>`<span class="private-note-tag-402">${esc402(t)}</span>`).join('');
    return `<section class="private-note-card-402 ${compact?'compact':''}" data-private-note-card402="${esc402(key)}"><div><div class="private-note-title-402">Nota interna de ${esc402(noteOwnerName402())}</div><div class="private-note-warning-402">Privada para este perfil profesional. No se comparte con otros médicos, no se imprime ni aparece en informes.</div>${tags?`<div class="private-note-tags-402">${tags}</div>`:''}<p>${esc402(n.texto||'Sin nota interna para este perfil.')}</p></div><button type="button" class="secondary small-btn no-print" data-edit-private-note402="${esc402(key)}">Editar nota</button></section>`;
  }
  function openNoteModal402(key){
    if(!canMedical402())return;const p=patient402(key),n=note402(key),o=document.createElement('div');o.id='privateNoteModal402';o.className='hc-modal-overlay';
    o.innerHTML=`<div class="hc-modal-card"><div class="hc-modal-head"><div><h2>Nota interna privada</h2><p class="muted">${esc402(patientName402(p))} · ${esc402(noteOwnerName402())}</p></div><button class="modal-close" type="button" data-close-private-note402>×</button></div><div class="private-note-privacy-402">Esta nota pertenece al perfil profesional actual. Los demás médicos que compartan al paciente tendrán su propia nota independiente.</div><div class="checks-grid-310 private-note-checks-402">${noteTags402.map(t=>`<label><input type="checkbox" value="${esc402(t)}" ${(n.tags||[]).includes(t)?'checked':''}> ${esc402(t)}</label>`).join('')}</div><label>Recordatorio interno<textarea id="privateNoteText402" placeholder="Ej.: recomendado por..., requiere explicaciones detalladas, antecedente administrativo concreto...">${esc402(n.texto||'')}</textarea></label><div class="hc-modal-actions"><button class="secondary" type="button" data-close-private-note402>Cancelar</button><button class="primary" type="button" data-save-private-note402="${esc402(key)}">Guardar nota interna</button></div></div>`;
    document.body.appendChild(o);
  }
  function saveNote402(key){
    ensure402();const tags=[...document.querySelectorAll('#privateNoteModal402 input[type="checkbox"]:checked')].map(x=>x.value),texto=$402('privateNoteText402')?.value.trim()||'';
    const owner=noteOwnerId402();noteBucket402()[key]={tags,texto,profesionalId:owner,profesionalNombre:noteOwnerName402(),actualizadoEn:new Date().toISOString(),actualizadoPor:currentUser402().nombre||currentUser402().usuario||'Usuario'};
    persist402();$402('privateNoteModal402')?.remove();document.querySelector('#hcPacienteDetalle [data-private-note-card402]')?.remove();enhanceHC402();enhancePatientFicha402(key);
  }
  function enhancePatientFicha402(key){
    if(!canMedical402())return;const p=patient402(key);if(!p)return;const root=$402('pacienteDetalle');if(!root)return;
    root.querySelectorAll('.private-note-card-402').forEach(x=>x.remove());
    const actions=root.querySelector('.paciente-ficha-actions');if(actions)actions.insertAdjacentHTML('afterend',noteCard402(patientKey402(p),true));else root.insertAdjacentHTML('afterbegin',noteCard402(patientKey402(p),true));
  }

  /* Estado operativo desde la evolución y la prestación */
  function statusBar402(a){
    if(!a||!canMedical402())return '';
    const sent=!!(a.estudioEnviadoMail||a.estudioEnviadoWS),needsBono=!!(a.bonoConsulta||a.bonoEstudio||a.firmaRequerida),needsCopy=!!(a.bonoEstudio||a.requiereCopiaImpresa||a.copiaRequerida);
    let isStudy=true;try{if(typeof esRegistroDeEstudio==='function')isStudy=!!esRegistroDeEstudio(a);else if(typeof tipoPrest==='function')isStudy=tipoPrest(a.prestacion)!=='CONSULTA';}catch(e){}
    const btn=(field,label,on,disabled=false)=>`<button type="button" class="hc-status-btn-402 ${on?'done':''}" data-hc-status-toggle402="${field}" data-attention402="${esc402(a.id)}" ${disabled?'disabled':''}>${on?'✓ ':''}${esc402(label)}</button>`;
    const studyButtons=isStudy?btn('informe','Informe hecho',!!a.estudioInformado)+btn('impreso','Impreso',!!a.estudioImpreso)+btn('enviado','Enviado',sent):'';
    return `<div class="hc-status-box-402"><strong>Estado de la prestación</strong><div class="hc-status-actions-402">${studyButtons}${btn('bono',needsBono?'Bono / firma OK':'Bono no requerido',!!a.bonoFirmado,!needsBono)}${btn('copia',needsCopy?'Copia facturación':'Copia no requerida',!!a.copiaImpresa,!needsCopy)}${btn('pago','Pago registrado',!!a.pagoRegistrado)}</div></div>`;
  }
  function toggleStatus402(id,field){
    const a=attention402(id);if(!a)return;
    if(field==='informe')a.estudioInformado=!a.estudioInformado;
    if(field==='impreso')a.estudioImpreso=!a.estudioImpreso;
    if(field==='enviado'){
      const on=!!(a.estudioEnviadoMail||a.estudioEnviadoWS);a.estudioEnviadoMail=false;a.estudioEnviadoWS=!on;if(!on){a.pendienteEnvio=false;a.pendienteEntrega=false;}
    }
    if(field==='bono')a.bonoFirmado=!a.bonoFirmado;
    if(field==='copia')a.copiaImpresa=!a.copiaImpresa;
    if(field==='pago')a.pagoRegistrado=!a.pagoRegistrado;
    try{saveAtenciones?.();}catch(e){}
    try{programarSyncSupabase?.();}catch(e){}
    try{window.renderPendientes383?.();window.refreshPendingBadge3101?.();renderTabla?.();renderStats?.();}catch(e){}
    document.querySelectorAll(`.hc-event[data-hc-attention-id="${CSS.escape(String(id))}"] .hc-status-box-402`).forEach(x=>x.remove());
    const key=document.querySelector('#hcPacienteDetalle [data-hc-new]')?.dataset.hcNew;
    if(key){const btn=document.querySelector(`#hcPacienteDetalle [data-hc-patient]`);try{document.querySelector(`[data-hc-patient="${CSS.escape(key)}"]`)?.click();}catch(e){}}
    setTimeout(enhanceHC402,20);
  }
  function enhanceHC402(){
    const root=$402('hcPacienteDetalle');if(!root)return;
    const key=root.querySelector('[data-hc-new]')?.dataset.hcNew;
    if(key&&canMedical402()&&!root.querySelector('[data-private-note-card402]')){
      const head=root.querySelector('.hc-patient-header');if(head)head.insertAdjacentHTML('afterend',noteCard402(key,false));
    }
    root.querySelectorAll('.hc-event[data-hc-attention-id]').forEach(ev=>{
      const id=ev.dataset.hcAttentionId;if(!id||ev.querySelector('.hc-status-box-402'))return;const a=attention402(id);if(a)ev.insertAdjacentHTML('beforeend',statusBar402(a));
    });
  }

  /* Historia Clínica impresa con identidad profesional */
  function evolutions402(p){
    const key=patientKey402(p),dni=String(p?.dni||'').replace(/\D/g,'');
    return (data?.evolucionesClinicas||[]).filter(e=>e.pacienteId===key||e.pacienteId===p?.id||(dni&&String(e.dni||'').replace(/\D/g,'')===dni)).sort((a,b)=>String(b.fechaHora||'').localeCompare(String(a.fechaHora||'')));
  }
  function attentionsForPatient402(p){try{return typeof atencionesPacienteGlobal==='function'?atencionesPacienteGlobal(p):[];}catch(e){return [];}}
  function fmtDT402(v){try{return new Intl.DateTimeFormat('es-AR',{dateStyle:'short',timeStyle:'short'}).format(new Date(v));}catch(e){return v||'';}}
  function fmtD402(v){try{return typeof formatFecha==='function'?formatFecha(v):v;}catch(e){return v||'';}}
  function printHC402(key){
    const p=patient402(key);if(!p)return;ensure402();
    const pid=currentProfessionalId402()||'matias',pr=prof402(pid)||prof402('matias')||{},summary=data.resumenesClinicos?.[patientKey402(p)]||{};
    const ev=evolutions402(p).map(x=>({type:'evolution',date:x.fechaHora,obj:x})),ats=attentionsForPatient402(p).map(x=>({type:'attention',date:(x.fecha||'')+'T'+(x.horaInicio||'00:00'),obj:x}));
    const timeline=[...ev,...ats].sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')));
    let logo=pr.logoDocumentoData||pr.logoDocumento||'icons/icon-192.png';try{if(!/^data:image\//i.test(logo))logo=new URL(logo,location.href).href;}catch(e){}const signature=(pr.mostrarFirmaDocumento!==false?(pr.firmaDocumentoData||''):'');
    const contacts=[pr.telefonoDocumento,pr.emailDocumento,pr.direccionDocumento,pr.redesDocumento].filter(Boolean).map(esc402).join(' · ');
    const licenses=[pr.matriculaNacional,pr.matriculaProvincial].filter(Boolean).map(esc402).join(' · ');
    const w=window.open('','_blank');if(!w)return;
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Historia clínica - ${esc402(patientName402(p))}</title><style>@page{size:A4;margin:18mm 16mm}*{box-sizing:border-box}body{font-family:Arial,Helvetica,sans-serif;color:#111827;margin:0;font-size:13px}.doc-head{display:grid;grid-template-columns:72px 1fr;gap:16px;align-items:center;border-bottom:3px solid #174b5c;padding-bottom:12px;margin-bottom:18px}.doc-logo{width:68px;height:68px;object-fit:contain;border-radius:12px}.brand{font-size:21px;font-weight:800;color:#174b5c}.doctor{font-size:17px;font-weight:800;margin-top:3px}.meta,.contact{color:#475569;line-height:1.45}.patient{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;margin-bottom:12px}.patient h1{margin:0 0 4px;font-size:25px}.box{border:1px solid #cbd5e1;border-radius:10px;padding:11px 13px;margin:12px 0;background:#f8fafc}.event{border-left:4px solid #174b5c;padding:8px 14px;margin:15px 0;page-break-inside:avoid}.event h3{margin:0 0 6px;font-size:16px}.event-meta{color:#475569;margin-bottom:8px}label{font-size:10px;text-transform:uppercase;color:#64748b;font-weight:800;letter-spacing:.04em}p{white-space:pre-wrap;margin:4px 0 9px;line-height:1.45}.hc-signature{margin:42px 0 18px auto;width:270px;text-align:center;page-break-inside:avoid}.hc-signature img{max-width:230px;max-height:90px;object-fit:contain;display:block;margin:0 auto 4px}.hc-signature-line{border-top:1px solid #334155;padding-top:5px;font-weight:700}.hc-signature-meta{font-size:10px;color:#475569;line-height:1.35}.footer{position:fixed;bottom:0;left:0;right:0;border-top:1px solid #cbd5e1;padding-top:6px;color:#64748b;font-size:10px;display:flex;justify-content:space-between}</style></head><body><header class="doc-head"><img class="doc-logo" src="${esc402(logo)}"><div><div class="brand">${esc402(pr.marcaDocumento||'CardioLink')}</div><div class="doctor">${esc402(pr.nombre||'Profesional')}</div><div class="meta">${esc402(specialities402(pr))}${licenses?' · '+licenses:''}</div>${contacts?`<div class="contact">${contacts}</div>`:''}</div></header><section class="patient"><div><h1>${esc402(patientName402(p))}</h1><div class="meta">DNI ${esc402(p.dni||'s/d')} · ${esc402(p.fechaNacimiento?'Fecha de nacimiento '+fmtD402(p.fechaNacimiento):'Fecha de nacimiento s/d')} · ${esc402(p.coberturaHabitual||'Cobertura s/d')}</div></div><div class="meta">Emisión: ${esc402(fmtDT402(new Date().toISOString()))}</div></section><div class="box"><strong>Antecedentes:</strong> ${esc402(summary.antecedentes||'s/d')}<br><strong>Alergias:</strong> ${esc402(summary.alergias||'s/d')}<br><strong>Medicación habitual:</strong> ${esc402(summary.medicacion||'s/d')}</div>${timeline.map(x=>x.type==='evolution'?`<article class="event"><h3>Evolución clínica · ${esc402(fmtDT402(x.obj.fechaHora))}</h3><div class="event-meta">${esc402(x.obj.profesionalNombre||'')}</div>${x.obj.motivo?`<p><label>Motivo</label><br>${esc402(x.obj.motivo)}</p>`:''}${x.obj.evolucion?`<p><label>Evolución / examen</label><br>${esc402(x.obj.evolucion)}</p>`:''}${x.obj.diagnostico?`<p><label>Impresión diagnóstica</label><br>${esc402(x.obj.diagnostico)}</p>`:''}${x.obj.conducta?`<p><label>Conducta / plan</label><br>${esc402(x.obj.conducta)}</p>`:''}</article>`:`<article class="event"><h3>${esc402(x.obj.prestacion||'Atención')} · ${esc402(fmtD402(x.obj.fecha))}</h3><div class="event-meta">${esc402(x.obj.profesional||'')} · ${esc402(x.obj.obraSocial||'')}</div>${x.obj.observaciones?`<p><label>Observaciones</label><br>${esc402(x.obj.observaciones)}</p>`:''}</article>`).join('')}<section class="hc-signature">${signature?`<img src="${esc402(signature)}">`:''}<div class="hc-signature-line">${esc402(pr.nombre||'Profesional')}</div><div class="hc-signature-meta">${esc402(specialities402(pr))}<br>${licenses}</div></section><footer class="footer"><span>${esc402(pr.marcaDocumento||'CardioLink')}</span><span>Documento emitido desde CardioLink v${VERSION_402}</span></footer></body></html>`);
    w.document.close();setTimeout(()=>w.print(),350);
  }

  /* Convenios y aranceles por profesional */
  function catalogOS402(){
    ensure402();const names=[...(data.obrasSociales||[]).map(x=>typeof x==='string'?x:(x.nombre||x.label||''))];
    Object.values(data.conveniosPorProfesional||{}).flat().forEach(c=>names.push(c.obraSocial));return [...new Set(names.filter(Boolean))].sort((a,b)=>a.localeCompare(b,'es'));
  }
  function defaultConv402(pid,os){const own=profName402(pid);return {obraSocial:os,activo:os==='Particular',regla:'SIN_REGLA',destinoConsulta:own,destinoEstudio:own,facturadorConsulta:own,facturadorEstudio:own,bonoConsulta:false,bonoEstudio:false,firmaRequerida:false,copiaRequerida:false,incluirFacturaRogelio:false};}
  function conv402(pid,os,create=false){ensure402();const arr=data.conveniosPorProfesional[pid]||(data.conveniosPorProfesional[pid]=[]);let c=arr.find(x=>norm402(x.obraSocial)===norm402(os));if(!c&&create){c=defaultConv402(pid,os);arr.push(c);}return c||null;}
  function destinations402(){const x=['Particular','No aplica','A definir'];(data.profesionales||[]).filter(p=>p.id!=='general'&&p.activo!==false).forEach(p=>x.push(p.nombre));return [...new Set(x)];}
  function opts402(list,value){return list.map(x=>`<option value="${esc402(x)}" ${String(x)===String(value)?'selected':''}>${esc402(x)}</option>`).join('');}
  function ruleOpts402(value){return opts402(['SIN_REGLA','GENERAL_CONSULTA_EXTRA','IOMA_OSPRERA','OSDE','SANCOR_PREVENCION','INTEGRAL','TODO_MATIAS','COBERTURA_COBRA_PARTICULAR'],value);}
  function injectBilling402(){
    const grid=document.querySelector('#config .config-grid');if(!grid)return;
    if(!canAdminConfig402()){$402('cfgConveniosProfesional402')?.remove();return;}
    [$402('cfgConvenios3102'),$402('cfgAranceles3102')].forEach(x=>{if(x)x.style.display='none';});
    let card=$402('cfgConveniosProfesional402');
    if(!card){card=document.createElement('div');card.id='cfgConveniosProfesional402';card.className='config-smart-card-310 full-config-card';card.dataset.configGroupCard='coberturas';card.dataset.configAccess='admin';card.innerHTML=`<h3>Convenios y aranceles por profesional</h3><p class="muted">Cada profesional tiene su propia configuración. El catálogo global solo ofrece nombres de coberturas: no copia reglas ni destinos de otro médico.</p><div class="professional-billing-head-402"><label>Profesional que estás configurando<select id="billProf402"></select></label><label>Convenio a configurar<select id="billOS402"></select></label></div><div id="billProfileNotice404" class="billing-profile-notice-404"></div><div class="convenio-editor-3102"><label>Regla automática<select id="billRegla402"></select></label><label>Destino de consulta<select id="billDestConsulta402"></select></label><label>Destino del estudio<select id="billDestEstudio402"></select></label><label>Facturador de consulta<select id="billFactConsulta402"></select></label><label>Facturador del estudio<select id="billFactEstudio402"></select></label><label class="check-row-310"><input type="checkbox" id="billActivo402"> Habilitado: este profesional atiende este convenio</label><label class="check-row-310"><input type="checkbox" id="billBonoConsulta402"> Requiere bono de consulta</label><label class="check-row-310"><input type="checkbox" id="billBonoEstudio402"> Requiere bono de estudio</label><label class="check-row-310"><input type="checkbox" id="billFirma402"> Requiere firma</label><label class="check-row-310"><input type="checkbox" id="billCopia402"> Requiere copia para facturación</label><label class="check-row-310"><input type="checkbox" id="billRogelio402"> Incluir en Factura Rogelio</label><div class="config-actions-3102"><button class="primary" id="saveBillConv402" type="button">Guardar para este profesional</button><button class="secondary" id="newBillConv402" type="button">Nuevo convenio global</button></div></div><h4 id="billConfiguredTitle404">Convenios configurados</h4><p class="muted">Activo significa que el profesional lo atiende y sus reglas se aplican. Los deshabilitados quedan guardados, pero no intervienen en nuevas atenciones.</p><div id="billList402" class="convenios-list-3102"></div><hr><h4>Arancel del profesional seleccionado</h4><p class="muted" id="billArancelHelp404">Cada valor corresponde a una combinación exacta de profesional + convenio + prestación + fecha de vigencia.</p><div class="arancel-editor-3102 arancel-editor-prof-404"><label>Convenio al que aplica<select id="billArancelOS404"></select></label><label>Prestación<select id="billPrest402"></select></label><label>Valor convenio / particular<input id="billValor402" type="number" min="0" step="1" placeholder="0"></label><label>Copago paciente (si corresponde)<input id="billCopago402" type="number" min="0" step="1" placeholder="0"></label><label>Vigente desde<input id="billVigencia402" type="date"></label><button class="primary" id="saveBillArancel402" type="button">Agregar arancel</button></div><div class="arancel-table-head-404 arancel-head-fin411f"><span>Convenio y prestación</span><span>Valor convenio / particular</span><span>Copago</span><span>Vigencia</span><span></span></div><div id="billArancelList402" class="aranceles-list-3102"></div>`;const ref=$402('cfgProduccionEstimada3102');if(ref)grid.insertBefore(card,ref);else grid.appendChild(card);}
    renderBilling402();
  }
  function selectedBillProf402(){return $402('billProf402')?.value||$402('cfgProfEditar310')?.value||currentProfessionalId402()||'matias';}
  function loadBillConv402(){
    const pid=selectedBillProf402(),os=$402('billOS402')?.value||catalogOS402()[0]||'Particular',c=conv402(pid,os,false)||defaultConv402(pid,os),dest=destinations402();
    if($402('billRegla402'))$402('billRegla402').innerHTML=ruleOpts402(c.regla||'SIN_REGLA');
    [['billDestConsulta402',c.destinoConsulta],['billDestEstudio402',c.destinoEstudio],['billFactConsulta402',c.facturadorConsulta],['billFactEstudio402',c.facturadorEstudio]].forEach(([id,v])=>{if($402(id))$402(id).innerHTML=opts402(dest.concat(v&&!dest.includes(v)?[v]:[]),v);});
    if($402('billActivo402'))$402('billActivo402').checked=c.activo!==false;if($402('billBonoConsulta402'))$402('billBonoConsulta402').checked=!!c.bonoConsulta;if($402('billBonoEstudio402'))$402('billBonoEstudio402').checked=!!c.bonoEstudio;if($402('billFirma402'))$402('billFirma402').checked=!!c.firmaRequerida;if($402('billCopia402'))$402('billCopia402').checked=!!c.copiaRequerida;if($402('billRogelio402'))$402('billRogelio402').checked=!!c.incluirFacturaRogelio;
  }
  function renderBilling402(){
    ensure402();const ps=$402('billProf402');if(!ps)return;
    const activePid=$402('perfilActivo')?.value||'';const contextPid=(activePid&&activePid!=='general'?activePid:'')||$402('cfgProfEditar310')?.value||currentProfessionalId402()||'matias';
    const oldP=ps.value||contextPid;
    ps.innerHTML=(data.profesionales||[]).filter(p=>p.id!=='general'&&p.activo!==false).map(p=>`<option value="${esc402(p.id)}">${esc402(p.nombre)}</option>`).join('');
    if([...ps.options].some(o=>o.value===oldP))ps.value=oldP;else if([...ps.options].some(o=>o.value===contextPid))ps.value=contextPid;
    const pid=selectedBillProf402();
    const osSel=$402('billOS402'),oldOS=osSel?.value||'Particular';if(osSel){osSel.innerHTML=opts402(catalogOS402(),oldOS);if([...osSel.options].some(o=>o.value===oldOS))osSel.value=oldOS;else if([...osSel.options].some(o=>o.value==='Particular'))osSel.value='Particular';}
    const arOS=$402('billArancelOS404'),oldArOS=arOS?.value||osSel?.value||'Particular';if(arOS){arOS.innerHTML=opts402(catalogOS402(),oldArOS);if([...arOS.options].some(o=>o.value===oldArOS))arOS.value=oldArOS;}
    loadBillConv402();
    const arr=(data.conveniosPorProfesional[pid]||[]).slice();
    const active=arr.filter(c=>c.activo!==false).sort((a,b)=>String(a.obraSocial).localeCompare(String(b.obraSocial),'es'));
    const inactive=arr.filter(c=>c.activo===false).sort((a,b)=>String(a.obraSocial).localeCompare(String(b.obraSocial),'es'));
    if($402('billProfileNotice404'))$402('billProfileNotice404').innerHTML=`Configurando exclusivamente a <strong>${esc402(profName402(pid))}</strong>. Ningún cambio de esta pantalla modifica los convenios de otro profesional.`;
    if($402('billConfiguredTitle404'))$402('billConfiguredTitle404').textContent=`Convenios de ${profName402(pid)}`;
    const row=c=>`<button type="button" class="convenio-row-3102 bill-row-402" data-load-bill-os402="${esc402(c.obraSocial)}"><strong>${esc402(c.obraSocial)}</strong><span>${esc402(c.destinoConsulta||profName402(pid))} / ${esc402(c.destinoEstudio||profName402(pid))}</span><span>${c.incluirFacturaRogelio?'Factura Rogelio':'Circuito propio'}</span><span class="billing-status-404 ${c.activo===false?'off':'on'}">${c.activo===false?'Deshabilitado':'Habilitado'}</span></button>`;
    if($402('billList402'))$402('billList402').innerHTML=`<div class="billing-group-title-404">Habilitados (${active.length})</div>${active.map(row).join('')||'<p class="muted billing-empty-404">Este profesional todavía no tiene convenios habilitados.</p>'}${inactive.length?`<details class="billing-inactive-404"><summary>Ver ${inactive.length} convenio(s) deshabilitado(s)</summary>${inactive.map(row).join('')}</details>`:''}`;
    const prest=[...new Set((prof402(pid)?.prestaciones||[]).concat(typeof allPrestaciones==='function'?allPrestaciones():[]))].filter(Boolean).sort((a,b)=>a.localeCompare(b,'es'));if($402('billPrest402'))$402('billPrest402').innerHTML=opts402(prest,$402('billPrest402').value||prest[0]);if($402('billVigencia402')&&!$402('billVigencia402').value)$402('billVigencia402').value=new Date().toISOString().slice(0,10);
    const ars=data.arancelesPorProfesional[pid]||[];if($402('billArancelList402'))$402('billArancelList402').innerHTML=ars.slice().sort((a,b)=>String(b.vigenteDesde||'').localeCompare(String(a.vigenteDesde||''))||String(a.obraSocial||'').localeCompare(String(b.obraSocial||''),'es')).map(a=>`<div class="arancel-row-3102 arancel-row-fin411f"><span><strong>${esc402(a.obraSocial)}</strong> · ${esc402(a.prestacion)}</span><span>${typeof money==='function'?money(a.valor):'$ '+Number(a.valor||0).toLocaleString('es-AR')}</span><span>${Number(a.copago||0)>0?(typeof money==='function'?money(a.copago):'$ '+Number(a.copago||0).toLocaleString('es-AR')):'—'}</span><span>desde ${esc402(a.vigenteDesde||'s/f')}</span><button type="button" class="small-btn" data-del-bill-arancel402="${esc402(a.id)}">Borrar</button></div>`).join('')||'<p class="muted">Sin aranceles cargados para este profesional.</p>';
  }
  function saveBillConv402(){
    if(!exigirConfigAdministrativa('Tu perfil no puede modificar convenios administrativos.'))return;
    const pid=selectedBillProf402(),os=$402('billOS402')?.value;if(!pid||!os)return;const c=conv402(pid,os,true);c.activo=$402('billActivo402').checked;c.regla=$402('billRegla402').value;c.destinoConsulta=$402('billDestConsulta402').value;c.destinoEstudio=$402('billDestEstudio402').value;c.facturadorConsulta=$402('billFactConsulta402').value;c.facturadorEstudio=$402('billFactEstudio402').value;c.bonoConsulta=$402('billBonoConsulta402').checked;c.bonoEstudio=$402('billBonoEstudio402').checked;c.firmaRequerida=$402('billFirma402').checked;c.copiaRequerida=$402('billCopia402').checked;c.incluirFacturaRogelio=$402('billRogelio402').checked;
    if(pid==='matias')data.conveniosFacturacion=copy402(data.conveniosPorProfesional.matias);persist402();renderBilling402();alert(`Convenio guardado para ${profName402(pid)}.`);
  }
  function newGlobalConv402(){if(!exigirConfigAdministrativa('Tu perfil no puede crear convenios administrativos.'))return;const name=prompt('Nombre de la nueva obra social, prepaga o convenio:');if(!name)return;if(!(data.obrasSociales||[]).includes(name))data.obrasSociales.push(name);persist402();renderBilling402();$402('billOS402').value=name;loadBillConv402();}
  function saveBillArancel402(){if(!exigirConfigAdministrativa('Tu perfil no puede modificar aranceles.'))return;const pid=selectedBillProf402(),obraSocial=$402('billArancelOS404')?.value||$402('billOS402')?.value,prestacion=$402('billPrest402')?.value,valor=Number($402('billValor402')?.value||0),copago=Number($402('billCopago402')?.value||0),vigenteDesde=$402('billVigencia402')?.value;if(!obraSocial||!prestacion||!vigenteDesde){alert('Completá convenio, prestación y fecha de vigencia.');return;}if(!Number.isFinite(valor)||valor<0||!Number.isFinite(copago)||copago<0){alert('Ingresá valores válidos.');return;}data.arancelesPorProfesional[pid].push({id:'arp_'+Date.now()+'_'+Math.random().toString(36).slice(2,6),profesionalId:pid,obraSocial,prestacion,valor,copago,vigenteDesde,activo:true});if(pid==='matias')data.arancelesConvenios=copy402(data.arancelesPorProfesional.matias);persist402();$402('billValor402').value='';if($402('billCopago402'))$402('billCopago402').value='';renderBilling402();}

  const oldApply402=window.aplicarRegla;
  window.aplicarRegla=function(){
    if(typeof oldApply402==='function')oldApply402.apply(this,arguments);
    try{const pid=$402('profesional')?.value,os=$402('obraSocial')?.value,prest=$402('prestacion')?.value,c=conv402(pid,os,false);if(!c||c.activo===false)return;const t=typeof tipoPrest==='function'?tipoPrest(prest):'',consulta=t==='CONSULTA';if(typeof setSelectValue==='function'){setSelectValue('consultaA',c.destinoConsulta||profName402(pid));setSelectValue('prestacionA',consulta?'No aplica':(c.destinoEstudio||profName402(pid)));setSelectValue('facturador',consulta?(c.facturadorConsulta||c.destinoConsulta):(c.facturadorEstudio||c.destinoEstudio));}const bc=$402('bonoConsulta'),be=$402('bonoEstudio');if(bc)bc.checked=!!c.bonoConsulta;if(be)be.checked=!consulta&&!!c.bonoEstudio;const info=$402('reglaInfo');if(info)info.textContent=`${profName402(pid)} · ${os}: consulta → ${c.destinoConsulta}; estudio → ${c.destinoEstudio}.`;calcularCajaCarga?.();}catch(e){console.error('Regla por profesional',e);}
  };
  window.esRegistroFacturaRogelio=function(a){const pid=a?.profesionalId||'matias',c=conv402(pid,a?.obraSocial,false);return !!(c&&c.activo!==false&&c.incluirFacturaRogelio&&String(a?.prestacionA||'')===String(c.destinoEstudio||'Rogelio')&&(typeof tipoPrest!=='function'||tipoPrest(a?.prestacion)!=='CONSULTA'));};

  function wrapRenderConfig402(){const old=window.renderConfig;if(typeof old!=='function'||old.__v402)return;const w=function(){const r=old.apply(this,arguments);setTimeout(()=>{injectDocumentFields402();injectBilling402();setVersion402();},0);return r;};w.__v402=true;window.renderConfig=renderConfig=w;}
  function wrapPatient402(){const old=window.seleccionarPacientePanel;if(typeof old!=='function'||old.__v402)return;const w=function(id){const r=old.apply(this,arguments);setTimeout(()=>enhancePatientFicha402(id),0);return r;};w.__v402=true;window.seleccionarPacientePanel=seleccionarPacientePanel=w;}

  document.addEventListener('click',e=>{
    const print=e.target.closest?.('[data-hc-print]');if(print){e.preventDefault();e.stopImmediatePropagation();printHC402(print.dataset.hcPrint);return;}
    const note=e.target.closest?.('[data-edit-private-note402]');if(note){e.preventDefault();openNoteModal402(note.dataset.editPrivateNote402);return;}
    if(e.target.closest?.('[data-close-private-note402]')){$402('privateNoteModal402')?.remove();return;}
    const saveNote=e.target.closest?.('[data-save-private-note402]');if(saveNote){saveNote402(saveNote.dataset.savePrivateNote402);return;}
    const st=e.target.closest?.('[data-hc-status-toggle402]');if(st){toggleStatus402(st.dataset.attention402,st.dataset.hcStatusToggle402);return;}
    if(e.target.id==='guardarDocProf402'){saveDocumentFields402();return;}
    if(e.target.id==='saveBillConv402'){saveBillConv402();return;}
    if(e.target.id==='newBillConv402'){newGlobalConv402();return;}
    if(e.target.id==='saveBillArancel402'){saveBillArancel402();return;}
    const row=e.target.closest?.('[data-load-bill-os402]');if(row){$402('billOS402').value=row.dataset.loadBillOs402;if($402('billArancelOS404'))$402('billArancelOS404').value=row.dataset.loadBillOs402;loadBillConv402();row.scrollIntoView({behavior:'smooth',block:'nearest'});return;}
    const del=e.target.closest?.('[data-del-bill-arancel402]');if(del){if(!exigirConfigAdministrativa('Tu perfil no puede borrar aranceles.'))return;if(confirm('¿Borrar este arancel?')){const pid=selectedBillProf402();data.arancelesPorProfesional[pid]=data.arancelesPorProfesional[pid].filter(a=>a.id!==del.dataset.delBillArancel402);if(pid==='matias')data.arancelesConvenios=copy402(data.arancelesPorProfesional.matias);persist402();renderBilling402();}}
  },true);
  document.addEventListener('change',e=>{
    if(e.target.id==='cfgProfEditar310'){setTimeout(loadDocumentFields402,0);const b=$402('billProf402');if(b&&[...b.options].some(o=>o.value===e.target.value)){b.value=e.target.value;renderBilling402();}}
    if(e.target.id==='perfilActivo'){const b=$402('billProf402');if(b&&[...b.options].some(o=>o.value===e.target.value)){b.value=e.target.value;renderBilling402();}}
    if(e.target.id==='billProf402'||e.target.id==='billOS402')renderBilling402();
    if(e.target.id==='billOS402'&&$402('billArancelOS404'))$402('billArancelOS404').value=e.target.value;
  });

  function boot402(){ensure402();wrapRenderConfig402();wrapPatient402();injectDocumentFields402();injectBilling402();setVersion402();
    const detail=$402('hcPacienteDetalle');if(detail)new MutationObserver(()=>setTimeout(enhanceHC402,0)).observe(detail,{childList:true,subtree:true});
    $402('perfilActivo')?.addEventListener('change',()=>{
      document.querySelectorAll('.private-note-card-402').forEach(x=>x.remove());
      setTimeout(()=>{enhanceHC402();},60);
    });
    setTimeout(()=>{enhanceHC402();window.refreshPendingBadge3101?.();},250);setTimeout(setVersion402,1200);persist402();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot402);else boot402();
})();


/* ===== CardioLink 4.1.0-hc · evolución directa desde Agenda ===== */
(function(){
  'use strict';
  const VERSION_403='4.1.0-hc';
  const $403=id=>document.getElementById(id);
  const norm403=s=>String(s??'').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');

  function currentUserCanEvolve403(){
    try{
      if(typeof esMatiasDuenio==='function'&&esMatiasDuenio())return true;
      if(typeof esAdminComun==='function'&&esAdminComun())return true;
      if(typeof esMedico==='function'&&esMedico())return true;
    }catch(e){}
    try{
      const u=typeof perfilUsuarioActual==='function'?perfilUsuarioActual():(window.usuarioPerfilActual||{});
      const r=norm403(u?.rolId||u?.rol||u?.baseRole||'');
      return r.includes('medico')||r.includes('director')||r.includes('admin')||r.includes('duenio');
    }catch(e){return false;}
  }
  function attentions403(){
    try{return Array.isArray(window.atenciones)?window.atenciones:(typeof atenciones!=='undefined'&&Array.isArray(atenciones)?atenciones:[]);}catch(e){return [];}
  }
  function patients403(){
    try{return typeof todosPacientes==='function'?todosPacientes():(data?.pacientes||[]);}catch(e){return data?.pacientes||[];}
  }
  function patientName403(p){
    try{return typeof nombrePacientePanel==='function'?nombrePacientePanel(p):(p?.nombreCompleto||p?.paciente||p?.nombre||'');}catch(e){return p?.nombreCompleto||p?.paciente||p?.nombre||'';}
  }
  function cleanDni403(v){return String(v||'').replace(/\D/g,'');}
  function patientKey403(p){
    if(!p)return '';
    if(p.id)return p.id;
    const dni=cleanDni403(p.dni);
    return 'legacy_'+(dni||norm403(patientName403(p)));
  }
  function attention403(id){return attentions403().find(a=>String(a?.id)===String(id))||null;}
  function patientForAttention403(a){
    if(!a)return null;
    const list=patients403();
    if(a.pacienteId){const p=list.find(x=>String(x.id)===String(a.pacienteId));if(p)return p;}
    const dni=cleanDni403(a.dni);
    if(dni){const p=list.find(x=>cleanDni403(x.dni)===dni);if(p)return p;}
    const name=norm403(a.paciente);
    if(name){const matches=list.filter(x=>norm403(patientName403(x))===name);if(matches.length===1)return matches[0];}
    return null;
  }
  function evolutionForAttention403(attentionId){
    const list=Array.isArray(data?.evolucionesClinicas)?data.evolucionesClinicas:[];
    return list.find(e=>String(e?.atencionId||'')===String(attentionId))||null;
  }
  function triggerEditEvolution403(evolutionId){
    const b=document.createElement('button');
    b.type='button';b.hidden=true;b.dataset.hcEdit=String(evolutionId);
    document.body.appendChild(b);b.click();b.remove();
  }
  function openEvolutionFromAgenda403(attentionId){
    if(!currentUserCanEvolve403())return;
    const a=attention403(attentionId);
    if(!a){alert('No se encontró la atención seleccionada.');return;}
    const p=patientForAttention403(a);
    if(!p){alert('Este turno todavía no está vinculado a una ficha de paciente. Vinculalo desde la atención antes de evolucionar.');return;}
    if(!a.pacienteId&&p.id){
      a.pacienteId=p.id;
      try{saveConfig?.();programarSyncSupabase?.();}catch(e){}
    }
    // Flujo clínico: al abrir la evolución desde la Agenda, Secretaría ve al paciente "En consulta".
    // No se degradan estados terminales ni una atención ya finalizada.
    const currentState403=String(a.estadoTurno||a.estado||'reservado');
    if(!['en_consulta','atendido','cancelado','ausente'].includes(currentState403)){
      a.estadoTurno='en_consulta';
      a.estadoTurnoEditadoPor=(typeof nombreUsuarioAuditoria==='function'?nombreUsuarioAuditoria():(typeof usuarioActualNombreCorto==='function'?usuarioActualNombreCorto():''));
      a.estadoTurnoEditadoEn=new Date().toISOString();
      try{if(typeof selloAuditoriaEdicion==='function')selloAuditoriaEdicion(a);}catch(e){}
      try{saveAtenciones?.();renderAgenda?.();renderTabla?.();renderStats?.();programarSyncSupabase?.();}catch(e){console.warn('No se pudo actualizar el estado a En consulta',e);}
    }
    const existing=evolutionForAttention403(a.id);
    if(existing){triggerEditEvolution403(existing.id);return;}
    if(typeof window.abrirNuevaEvolucionHC!=='function'){
      alert('El módulo de Historia Clínica todavía no terminó de cargar. Esperá un instante y volvé a tocar el paciente.');return;
    }
    window.abrirNuevaEvolucionHC(patientKey403(p),a.id);
  }
  function makeClickable403(el,id){
    if(!el||el.dataset.evolveAttention403)return;
    el.dataset.evolveAttention403=String(id);
    el.classList.add('agenda-patient-evolve-403');
    el.setAttribute('role','button');el.setAttribute('tabindex','0');
    el.setAttribute('title','Abrir evolución clínica vinculada a este turno');
    el.setAttribute('aria-label',`Evolucionar ${el.textContent.trim()||'paciente'}`);
  }
  function decorateAgenda403(){
    if(!currentUserCanEvolve403())return;
    const agenda=$403('agenda');if(!agenda)return;
    agenda.querySelectorAll('tr[data-id]').forEach(row=>{
      const id=row.dataset.id;
      const name=row.querySelector('.agenda-patient-name4092')||row.querySelector('td:nth-child(2) strong')||row.querySelector('td:nth-child(2)');
      makeClickable403(name,id);
    });
    agenda.querySelectorAll('.agenda-turno-card[data-id]').forEach(card=>{
      const id=card.dataset.id;
      const name=card.querySelector('.agenda-patient-name4092')||card.querySelector('.agenda-card-top + div strong')||[...card.querySelectorAll('strong')][1];
      makeClickable403(name,id);
    });
  }
  function modalHasClinicalChanges403(modal){
    if(!modal)return false;
    return ['hcMotivo','hcEvolucion','hcDiagnostico','hcConducta','hcSumAntecedentes409','hcSumAlergias409','hcSumMedicacion409'].some(id=>($403(id)?.value||'').trim());
  }
  function markModalBaseline403(){
    const m=$403('hcEvolutionModal');if(!m||m.dataset.baseline403)return;
    m.dataset.baseline403=JSON.stringify(['hcMotivo','hcEvolucion','hcDiagnostico','hcConducta','hcSumAntecedentes409','hcSumAlergias409','hcSumMedicacion409'].map(id=>$403(id)?.value||''));
  }
  function modalDirty403(){
    const m=$403('hcEvolutionModal');if(!m)return false;
    let base=[];try{base=JSON.parse(m.dataset.baseline403||'[]');}catch(e){}
    const now=['hcMotivo','hcEvolucion','hcDiagnostico','hcConducta','hcSumAntecedentes409','hcSumAlergias409','hcSumMedicacion409'].map(id=>$403(id)?.value||'');
    return now.some((v,i)=>v!==(base[i]||''));
  }
  function closeEvolutionModal403(){
    const m=$403('hcEvolutionModal');if(!m)return;
    if(modalDirty403()&&modalHasClinicalChanges403(m)&&!confirm('Hay cambios sin guardar. ¿Cerrar la evolución y descartarlos?'))return;
    m.remove();
  }
  function setVersion403(){
    try{document.title='CardioLink Admin v'+VERSION_403;}catch(e){}
    document.querySelectorAll('.brand-main span,.mobile-app-title-370 span').forEach(x=>x.textContent='v'+VERSION_403);
    document.querySelectorAll('.login-meta').forEach(x=>x.textContent='Versión '+VERSION_403+' · 2026');
  }
  function boot403(){
    setVersion403();decorateAgenda403();
    const agenda=$403('agenda');if(agenda)new MutationObserver(()=>decorateAgenda403()).observe(agenda,{childList:true,subtree:true});
    new MutationObserver(()=>markModalBaseline403()).observe(document.body,{childList:true,subtree:true});
    setTimeout(()=>{setVersion403();decorateAgenda403();markModalBaseline403();},500);
  }
  document.addEventListener('click',e=>{
    const target=e.target.closest?.('[data-evolve-attention403]');
    if(target){e.preventDefault();e.stopImmediatePropagation();openEvolutionFromAgenda403(target.dataset.evolveAttention403);return;}
    const close=e.target.closest?.('#hcEvolutionModal [data-hc-close]');
    if(close){e.preventDefault();e.stopImmediatePropagation();closeEvolutionModal403();}
  },true);
  document.addEventListener('keydown',e=>{
    const target=e.target.closest?.('[data-evolve-attention403]');
    if(target&&(e.key==='Enter'||e.key===' ')){e.preventDefault();openEvolutionFromAgenda403(target.dataset.evolveAttention403);}
    if(e.key==='Escape'&&$403('hcEvolutionModal')){e.preventDefault();closeEvolutionModal403();}
  },true);

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot403);else boot403();
  window.abrirEvolucionAtencion403=openEvolutionFromAgenda403;
})();

/* v4.1.0-hc: convenios/aranceles aislados por profesional, selector explícito de cobertura y sincronización de perfil. */


/* ===== CardioLink 4.1.0-hc · importación histórica de evoluciones Medicloud ===== */
(function(){
  'use strict';
  const VERSION_405='4.1.0-hc';
  const $405=id=>document.getElementById(id);
  const esc405=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
  const clean405=v=>String(v??'').replace(/<[^>]*>/g,' ').replace(/&nbsp;/gi,' ').replace(/\s+/g,' ').trim();
  const norm405=v=>clean405(v).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  const dni405=v=>String(v??'').replace(/\D/g,'');
  let preview405=[];
  let currentFile405='';

  function ensure405(){
    if(!Array.isArray(data.evolucionesClinicas))data.evolucionesClinicas=[];
    if(!Array.isArray(data.importacionesMedicloudEvoluciones))data.importacionesMedicloudEvoluciones=[];
    if(!Array.isArray(data.pacientes))data.pacientes=[];
  }
  function isAdmin405(){
    try{return !!(esMatiasDuenio?.()||esAdminComun?.());}catch(e){return false;}
  }
  function canImport405(){
    try{return !!(isAdmin405()||esMedico?.());}catch(e){return true;}
  }
  function patients405(){
    try{return typeof todosPacientes==='function'?todosPacientes():data.pacientes;}catch(e){return data.pacientes||[];}
  }
  function patientName405(p){
    try{return nombrePacientePanel?.(p)||p?.nombreCompleto||p?.paciente||'';}catch(e){return p?.nombreCompleto||p?.paciente||'';}
  }
  function patientKey405(p){
    if(p?.id)return p.id;
    return 'legacy_'+(dni405(p?.dni)||norm405(patientName405(p)).replace(/\s+/g,'_'));
  }
  function hash405(s){
    let h=2166136261;
    for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}
    return (h>>>0).toString(16).padStart(8,'0');
  }
  function parseDate405(v){
    if(v instanceof Date&&!isNaN(v)){
      const y=v.getFullYear(),m=String(v.getMonth()+1).padStart(2,'0'),d=String(v.getDate()).padStart(2,'0'),hh=String(v.getHours()).padStart(2,'0'),mm=String(v.getMinutes()).padStart(2,'0');
      return `${y}-${m}-${d}T${hh}:${mm}:00`;
    }
    if(typeof v==='number'&&window.XLSX){
      const p=XLSX.SSF.parse_date_code(v);
      if(p)return `${String(p.y).padStart(4,'0')}-${String(p.m).padStart(2,'0')}-${String(p.d).padStart(2,'0')}T${String(p.H||0).padStart(2,'0')}:${String(p.M||0).padStart(2,'0')}:00`;
    }
    const s=clean405(v);
    if(!s)return '';
    let m=s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if(m){let y=m[3];if(y.length===2)y=Number(y)>50?'19'+y:'20'+y;return `${y.padStart(4,'0')}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}T${String(m[4]||'00').padStart(2,'0')}:${String(m[5]||'00').padStart(2,'0')}:${String(m[6]||'00').padStart(2,'0')}`;}
    m=s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if(m)return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}T${String(m[4]||'00').padStart(2,'0')}:${String(m[5]||'00').padStart(2,'0')}:${String(m[6]||'00').padStart(2,'0')}`;
    const dt=new Date(s);if(!isNaN(dt))return parseDate405(dt);
    return '';
  }
  function htmlRows405(text){
    const doc=new DOMParser().parseFromString(String(text||''),'text/html');
    const table=doc.querySelector('table');if(!table)return [];
    const trs=[...table.querySelectorAll('tr')];if(!trs.length)return [];
    const headers=[...trs[0].querySelectorAll('th,td')].map(c=>clean405(c.textContent));
    return trs.slice(1).map(tr=>{const cells=[...tr.querySelectorAll('th,td')].map(c=>clean405(c.textContent));const o={};headers.forEach((h,i)=>o[h||`Columna ${i+1}`]=cells[i]||'');return o;}).filter(r=>Object.values(r).some(v=>clean405(v)));
  }
  function headerKey405(h){return norm405(h).replace(/[^a-z0-9]/g,'');}
  function pick405(row,keys){
    const entries=Object.entries(row||{});let best='';let score=0;
    for(const [h,v] of entries){const hk=headerKey405(h);for(const k of keys){const kk=headerKey405(k);let s=0;if(hk===kk)s=3;else if(hk.includes(kk)||kk.includes(hk))s=2;if(s>score){score=s;best=v;}}}
    return score?best:'';
  }
  function row405(row,idx){
    const nombre=clean405(pick405(row,['Nombre','Nombres']));
    const apellido=clean405(pick405(row,['Apellido','Apellidos']));
    const identificacion=dni405(pick405(row,['Identificación','Identificacion','DNI','Documento','N° de Documento','Nº de Documento']));
    const fechaHora=parseDate405(pick405(row,['Fecha','Fecha y hora','Fecha de evolución','Fecha de evolucion']));
    const tipo=clean405(pick405(row,['Tipo de evolución','Tipo de evolucion','Tipo']));
    const titulo=clean405(pick405(row,['Título','Titulo','Motivo']));
    const texto=clean405(pick405(row,['Texto','Evolución','Evolucion','Detalle','Descripción','Descripcion']));
    const nombreArchivo=[apellido,nombre].filter(Boolean).join(' ')||[nombre,apellido].filter(Boolean).join(' ');
    const fp='medicloud_'+hash405([identificacion,fechaHora,norm405(titulo),norm405(texto)].join('|'));
    return {idx,nombre,apellido,nombreArchivo,identificacion,fechaHora,tipo,titulo,texto,fingerprint:fp,raw:row};
  }
  function evolutionSignature405(e){
    return [dni405(e?.dni),String(e?.fechaHora||'').slice(0,19),norm405(e?.motivo),norm405(e?.evolucion)].join('|');
  }
  function itemSignature405(x){return [x.identificacion,String(x.fechaHora||'').slice(0,19),norm405(x.titulo),norm405(x.texto)].join('|');}
  function existingDuplicate405(x){
    return (data.evolucionesClinicas||[]).some(e=>e.importacionMedicloudId===x.fingerprint||evolutionSignature405(e)===itemSignature405(x));
  }
  function matchPatient405(x){
    const list=patients405();
    if(x.identificacion){
      const m=list.filter(p=>dni405(p.dni)===x.identificacion);
      if(m.length===1)return {status:'matched',patient:m[0],reason:'DNI exacto'};
      if(m.length>1)return {status:'ambiguous',matches:m,reason:'DNI duplicado en CardioLink'};
    }
    const a=norm405([x.apellido,x.nombre].filter(Boolean).join(' '));
    const b=norm405([x.nombre,x.apellido].filter(Boolean).join(' '));
    const byName=list.filter(p=>{const n=norm405(patientName405(p));return n&&(n===a||n===b);});
    if(byName.length===1)return {status:'matched',patient:byName[0],reason:'Nombre exacto'};
    if(byName.length>1)return {status:'ambiguous',matches:byName,reason:'Nombre repetido'};
    return {status:'missing',reason:'Paciente no encontrado'};
  }
  function classify405(items){
    ensure405();const seen=new Set();
    return items.map(x=>{
      if(!x.identificacion||!x.fechaHora||(!x.titulo&&!x.texto))return {...x,status:'invalid',reason:'Falta DNI, fecha o contenido'};
      if(seen.has(x.fingerprint))return {...x,status:'duplicate',reason:'Duplicada dentro del archivo'};
      seen.add(x.fingerprint);
      if(existingDuplicate405(x))return {...x,status:'duplicate',reason:'Ya existe en la Historia Clínica'};
      const m=matchPatient405(x);return {...x,...m};
    });
  }
  async function readFile405(file){
    const buf=await file.arrayBuffer();let rows=[];
    const head=new TextDecoder('utf-8').decode(buf.slice(0,4096));
    if(/<html|<table/i.test(head))rows=htmlRows405(new TextDecoder('utf-8').decode(buf));
    else{
      if(!window.XLSX)throw new Error('No se cargó el lector de Excel.');
      const wb=XLSX.read(buf,{type:'array',cellDates:true});
      rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:'',raw:false});
    }
    return rows;
  }
  function counts405(){
    return preview405.reduce((a,x)=>(a[x.status]=(a[x.status]||0)+1,a),{matched:0,missing:0,ambiguous:0,duplicate:0,invalid:0});
  }
  function professionalOptions405(){
    let list=(data.profesionales||[]).filter(p=>p.id!=='general');
    if(!isAdmin405()){
      const id=defaultProfessional405();list=list.filter(p=>p.id===id);
    }
    return list.map(p=>`<option value="${esc405(p.id)}">${esc405(p.nombre)}</option>`).join('');
  }
  function defaultProfessional405(){
    const active=$405('perfilActivo')?.value;
    if(active&&active!=='general'&&(data.profesionales||[]).some(p=>p.id===active))return active;
    try{const id=profesionalIdUsuarioActual?.();if(id&&id!=='general')return id;}catch(e){}
    return (data.profesionales||[]).find(p=>p.id==='matias')?.id||(data.profesionales||[]).find(p=>p.id!=='general')?.id||'';
  }
  function closeModal405(){$405('modalImportEvol405')?.remove();}
  function renderPreview405(){
    const c=counts405();
    const modal=document.createElement('div');modal.id='modalImportEvol405';modal.className='modal-backdrop hc-import-modal405';
    const rows=preview405.slice(0,140).map(x=>`<tr><td>${x.idx}</td><td><strong>${esc405([x.nombre,x.apellido].filter(Boolean).join(' '))}</strong></td><td>${esc405(x.identificacion)}</td><td>${esc405(x.fechaHora?new Intl.DateTimeFormat('es-AR',{dateStyle:'short',timeStyle:'short'}).format(new Date(x.fechaHora)):'')}</td><td>${esc405(x.titulo||'(sin título)')}</td><td><span class="import-badge405 ${x.status}">${esc405(x.status==='matched'?'Vinculada':x.status==='missing'?'Crear ficha':x.status==='ambiguous'?'Revisar':x.status==='duplicate'?'Duplicada':'Inválida')}</span><small>${esc405(x.reason||'')}</small></td></tr>`).join('');
    modal.innerHTML=`<div class="agenda-modal-card hc-import-card405"><div class="modal-header"><div><h2>Importar evoluciones desde otra app</h2><p class="muted">Archivo: ${esc405(currentFile405)}. Se conserva la fecha histórica y no se crean turnos, caja ni agenda.</p></div><button type="button" class="modal-close" data-close-import405>×</button></div>
      <div class="hc-import-summary405"><div><span>Total</span><strong>${preview405.length}</strong></div><div><span>Vinculadas</span><strong>${c.matched}</strong></div><div><span>Fichas nuevas</span><strong>${c.missing}</strong></div><div><span>Duplicadas</span><strong>${c.duplicate}</strong></div><div><span>Revisar</span><strong>${c.ambiguous+c.invalid}</strong></div></div>
      <div class="hc-import-options405"><div><label>Profesional autor</label><select id="importProf405">${professionalOptions405()}</select></div><label class="check-line405"><input type="checkbox" id="createMissing405" checked> Crear ficha mínima cuando el DNI no existe</label></div>
      <p class="muted">Vinculación principal: DNI exacto. Las filas con DNI duplicado en CardioLink o datos inválidos no se importan. Al repetir el mismo archivo se detectan y omiten duplicados.</p>
      <div class="hc-import-table-wrap405"><table class="tabla-mini"><thead><tr><th>Fila</th><th>Paciente</th><th>DNI</th><th>Fecha</th><th>Título</th><th>Estado</th></tr></thead><tbody>${rows}</tbody></table></div>${preview405.length>140?`<p class="muted">Vista previa limitada a 140 filas. El lote completo contiene ${preview405.length}.</p>`:''}
      <div class="modal-actions"><button class="secondary" type="button" data-close-import405>Cancelar</button><button class="primary" type="button" id="confirmImportEvol405">Importar lote</button></div></div>`;
    document.body.appendChild(modal);
    const prof=$405('importProf405');if(prof){prof.value=defaultProfessional405();if(!isAdmin405())prof.disabled=true;}
  }
  async function chooseFile405(file){
    if(!file)return;
    try{
      currentFile405=file.name;const rows=await readFile405(file);
      if(!rows.length){alert('El archivo no contiene filas para importar.');return;}
      preview405=classify405(rows.map((r,i)=>row405(r,i+2)));
      renderPreview405();
    }catch(e){console.error(e);alert('No pude leer el archivo de evoluciones. Usá un archivo .xls/.xlsx compatible exportado por otra app.');}
  }
  function createPatient405(x,batchId){
    const p={id:'pac_'+Date.now()+'_'+Math.random().toString(36).slice(2,9),nombreCompleto:[x.apellido,x.nombre].filter(Boolean).join(' ')||x.nombreArchivo,dni:x.identificacion,telefono:'',email:'',fechaNacimiento:'',coberturaHabitual:'',numeroAfiliadoHabitual:'',observacionesAdministrativas:'Ficha mínima creada al importar evoluciones históricas desde otra app.',historialCoberturas:[],creadoEn:new Date().toISOString(),creadoPor:'Importación desde otra app',creadoPorImportacionLote:batchId};
    data.pacientes.push(p);return p;
  }
  function confirmImport405(){
    ensure405();if(!preview405.length)return;
    const profId=$405('importProf405')?.value;const prof=(data.profesionales||[]).find(p=>p.id===profId);
    if(!prof){alert('Seleccioná el profesional autor.');return;}
    const createMissing=!!$405('createMissing405')?.checked;
    const importable=preview405.filter(x=>x.status==='matched'||(x.status==='missing'&&createMissing));
    if(!importable.length){alert('No hay evoluciones importables en este lote.');return;}
    if(!confirm(`Se importarán ${importable.length} evoluciones históricas como ${prof.nombre}. ¿Continuar?`))return;
    const batchId='medicloud_lote_'+Date.now()+'_'+Math.random().toString(36).slice(2,7);const now=new Date().toISOString();
    const evolutionIds=[],createdPatientIds=[];let matched=0,created=0;
    importable.forEach((x,i)=>{
      let p=x.patient;
      if(!p){p=createPatient405(x,batchId);createdPatientIds.push(p.id);created++;}else matched++;
      const id='evo_med_'+Date.now()+'_'+i+'_'+Math.random().toString(36).slice(2,6);
      data.evolucionesClinicas.push({id,pacienteId:patientKey405(p),dni:p.dni||x.identificacion,pacienteNombre:patientName405(p)||x.nombreArchivo,atencionId:'',fechaHora:x.fechaHora,profesionalId:prof.id,profesionalNombre:prof.nombre,motivo:x.titulo||x.tipo||'Evolución',evolucion:x.texto||'',diagnostico:'',conducta:'',creadoEn:now,creadoPor:'Importación desde otra app',origen:'Otra app',importadoDesde:'Otra app',importacionMedicloudId:x.fingerprint,importacionLoteId:batchId,filaOrigen:x.idx,tipoEvolucionOriginal:x.tipo||'',tituloOriginal:x.titulo||''});
      evolutionIds.push(id);
    });
    data.importacionesMedicloudEvoluciones.push({id:batchId,archivo:currentFile405,importadoEn:now,importadoPor:typeof usuarioActualNombreCorto==='function'?usuarioActualNombreCorto():'',profesionalId:prof.id,profesionalNombre:prof.nombre,totalArchivo:preview405.length,evolucionesImportadas:evolutionIds.length,pacientesVinculados:matched,pacientesCreados:created,evolutionIds,createdPatientIds});
    saveConfig();try{window.guardarConfigEnSupabase298?.();window.programarSyncSupabase?.();}catch(e){console.warn(e);}
    closeModal405();preview405=[];updateStatus405();$405('hcBtnBuscar')?.click();
    alert(`Importación terminada. Evoluciones: ${evolutionIds.length}. Pacientes vinculados: ${matched}. Fichas mínimas creadas: ${created}.`);
  }
  function lastBatch405(){ensure405();return [...data.importacionesMedicloudEvoluciones].sort((a,b)=>String(b.importadoEn||'').localeCompare(String(a.importadoEn||'')))[0]||null;}
  function undoLast405(){
    const b=lastBatch405();if(!b){alert('No hay lotes de evoluciones importadas para deshacer.');return;}
    if(!confirm(`¿Deshacer el lote ${b.archivo||''} con ${b.evolucionesImportadas||b.evolutionIds?.length||0} evoluciones?`))return;
    const ids=new Set(b.evolutionIds||[]);data.evolucionesClinicas=(data.evolucionesClinicas||[]).filter(e=>!ids.has(e.id)&&e.importacionLoteId!==b.id);
    const created=new Set(b.createdPatientIds||[]);
    const referencedAtt=new Set((typeof atenciones!=='undefined'&&Array.isArray(atenciones)?atenciones:[]).map(a=>String(a.pacienteId||'')));
    const referencedEvo=new Set((data.evolucionesClinicas||[]).map(e=>String(e.pacienteId||'')));
    data.pacientes=(data.pacientes||[]).filter(p=>!(created.has(p.id)&&p.creadoPorImportacionLote===b.id&&!referencedAtt.has(String(p.id))&&!referencedEvo.has(String(p.id))));
    data.importacionesMedicloudEvoluciones=(data.importacionesMedicloudEvoluciones||[]).filter(x=>x.id!==b.id);
    saveConfig();try{window.guardarConfigEnSupabase298?.();window.programarSyncSupabase?.();}catch(e){console.warn(e);}
    updateStatus405();$405('hcBtnBuscar')?.click();alert('Último lote de evoluciones importadas deshecho.');
  }
  function updateStatus405(){
    const box=$405('hcImportStatus405'),btn=$405('btnUndoEvolMedicloud405');const b=lastBatch405();
    if(box)box.textContent=b?`Último lote importado: ${b.archivo||'archivo'} · ${b.evolucionesImportadas||0} evoluciones · ${new Intl.DateTimeFormat('es-AR',{dateStyle:'short',timeStyle:'short'}).format(new Date(b.importadoEn))}`:'Todavía no se importaron evoluciones desde otra app.';
    if(btn)btn.disabled=!b;
  }
  function decorateImported405(){
    document.querySelectorAll('[data-hc-evolution-id]').forEach(card=>{const id=card.dataset.hcEvolutionId;const e=(data.evolucionesClinicas||[]).find(x=>x.id===id);if(!e?.importadoDesde||card.querySelector('.hc-origin405'))return;const meta=card.querySelector('.hc-event-meta');if(meta){const badge=document.createElement('span');badge.className='hc-origin405';badge.textContent='Importada desde otra app';meta.appendChild(document.createTextNode(' · '));meta.appendChild(badge);}});
  }
  function setVersion405(){
    document.title='CardioLink Admin v'+VERSION_405;document.querySelectorAll('.brand-main span,.mobile-app-title-370 span').forEach(x=>x.textContent='v'+VERSION_405);document.querySelectorAll('.login-meta').forEach(x=>x.textContent='Versión '+VERSION_405+' · 2026');
  }
  function boot405(){
    ensure405();setVersion405();updateStatus405();
    const importBtn=$405('btnImportEvolMedicloud405'),importPacBtn=$405('btnImportEvolMedicloudPac407'),undoBtn=$405('btnUndoEvolMedicloud405');
    if(!canImport405()){if(importBtn)importBtn.hidden=true;if(importPacBtn)importPacBtn.hidden=true;if(undoBtn)undoBtn.hidden=true;}
    const detail=$405('hcPacienteDetalle');if(detail)new MutationObserver(()=>decorateImported405()).observe(detail,{childList:true,subtree:true});
    setTimeout(()=>{setVersion405();updateStatus405();decorateImported405();},600);
  }
  document.addEventListener('click',e=>{
    if(e.target.id==='btnImportEvolMedicloud405'||e.target.id==='btnImportEvolMedicloudPac407'){$405('inputImportEvolMedicloud405').value='';$405('inputImportEvolMedicloud405').click();}
    if(e.target.id==='btnUndoEvolMedicloud405')undoLast405();
    if(e.target.closest?.('[data-close-import405]'))closeModal405();
    if(e.target.id==='confirmImportEvol405')confirmImport405();
  },true);
  document.addEventListener('change',e=>{if(e.target.id==='inputImportEvolMedicloud405')chooseFile405(e.target.files?.[0]);});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot405);else boot405();
  window.importarEvolucionesMedicloud405=chooseFile405;
})();

/* ===== CardioLink Admin v4.1.0-hc — identidad profesional y documentos clínicos ===== */
(function(){
  'use strict';
  const VERSION_406='4.1.0-hc';
  const $406=id=>document.getElementById(id);
  const esc406=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const norm406=s=>String(s??'').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const clone406=o=>JSON.parse(JSON.stringify(o));

  function currentUser406(){
    try{return typeof perfilUsuarioActual==='function'?perfilUsuarioActual():(window.usuarioPerfilActual||{});}catch(e){return window.usuarioPerfilActual||{};}
  }
  function isAdmin406(){
    try{if(typeof esMatiasDuenio==='function'&&esMatiasDuenio())return true;if(typeof esAdminComun==='function'&&esAdminComun())return true;}catch(e){}
    const r=norm406(currentUser406().rolId||currentUser406().rol||currentUser406().baseRole||'');
    return r.includes('admin')||r.includes('duenio');
  }
  function isMedical406(){
    try{if(typeof esMedico==='function'&&esMedico())return true;}catch(e){}
    const r=norm406(currentUser406().rolId||currentUser406().rol||currentUser406().baseRole||'');
    return isAdmin406()||r.includes('medico');
  }
  function isSecretary406(){
    try{if(typeof esSecretaria==='function'&&esSecretaria())return true;}catch(e){}
    const r=norm406(currentUser406().rolId||currentUser406().rol||currentUser406().baseRole||'');
    return r.includes('secretaria');
  }
  function canIssueDoc406(type=''){
    if(isMedical406()||isAdmin406())return true;
    return isSecretary406()&&['certificado','constancia_atencion'].includes(String(type||''));
  }
  function responsibleProfId406(p){
    if(!p)return currentProfId406()||selectedProfId406()||'matias';
    try{
      const ats=(typeof atencionesPacienteGlobal==='function'?atencionesPacienteGlobal(p):[])
        .filter(a=>a&&a.tipoRegistro!=='mensaje'&&a.profesionalId);
      if(ats.length){
        const hoy=(typeof todayISO==='function'?todayISO():'');
        const hoyActiva=ats.find(a=>a.fecha===hoy&&!['cancelado','ausente'].includes(String(a.estadoTurno||a.estado||'').toLowerCase()));
        const activa=ats.find(a=>!['cancelado','ausente'].includes(String(a.estadoTurno||a.estado||'').toLowerCase()));
        return String((hoyActiva||activa||ats[0]).profesionalId||'');
      }
    }catch(e){}
    return currentProfId406()||selectedProfId406()||'matias';
  }
  function currentProfId406(){
    try{return typeof profesionalIdUsuarioActual==='function'?(profesionalIdUsuarioActual()||''):(currentUser406().profesionalId||'');}catch(e){return currentUser406().profesionalId||'';}
  }
  function prof406(id){return (data?.profesionales||[]).find(p=>String(p.id)===String(id))||null;}
  function profName406(id){return prof406(id)?.nombre||id||'Profesional';}
  function selectedProfId406(){
    const cfg=$406('cfgProfEditar310')?.value;
    if(isAdmin406()&&cfg)return cfg;
    return currentProfId406()||cfg||'matias';
  }
  function canEditIdentity406(pid){return isAdmin406()||String(pid)===String(currentProfId406());}
  function patientName406(p){
    try{return typeof nombrePacientePanel==='function'?nombrePacientePanel(p):(p?.nombreCompleto||p?.paciente||p?.nombre||'Paciente');}catch(e){return p?.nombreCompleto||p?.paciente||p?.nombre||'Paciente';}
  }
  function patientKey406(p){
    if(!p)return '';
    if(p.id)return p.id;
    const dni=String(p.dni||'').replace(/\D/g,'');
    return 'legacy_'+(dni||norm406(patientName406(p)));
  }
  function patients406(){try{return typeof todosPacientes==='function'?todosPacientes():(data?.pacientes||[]);}catch(e){return data?.pacientes||[];}}
  function patient406(key){return patients406().find(p=>String(p.id||'')===String(key)||patientKey406(p)===String(key))||null;}
  function fmtDT406(v){try{return new Intl.DateTimeFormat('es-AR',{dateStyle:'short',timeStyle:'short'}).format(new Date(v));}catch(e){return v||'';}}
  function fmtD406(v){try{return typeof formatFecha==='function'?formatFecha(v):new Intl.DateTimeFormat('es-AR').format(new Date(v));}catch(e){return v||'';}}
  function specialities406(p){
    const ids=Array.isArray(p?.especialidadIds)?p.especialidadIds:[];
    const names=ids.map(id=>(data?.especialidades||[]).find(e=>e.id===id)?.nombre).filter(Boolean);
    return names.length?names.join(' · '):(p?.area||p?.especialidad||'');
  }
  function persist406(){
    try{saveConfig?.();}catch(e){console.error(e)}
    try{guardarConfigEnSupabase298?.();}catch(e){}
    try{programarSyncSupabase?.();}catch(e){}
  }
  function ensure406(){
    if(!data||typeof data!=='object')return;
    if(!Array.isArray(data.documentosClinicos))data.documentosClinicos=[];
    (data.profesionales||[]).filter(p=>p.id!=='general').forEach(p=>{
      if(p.marcaDocumento===undefined)p.marcaDocumento=p.id==='matias'?'Consultorio Médico RM':p.nombre;
      if(p.logoDocumento===undefined)p.logoDocumento='icons/icon-192.png';
      if(p.logoDocumentoData===undefined)p.logoDocumentoData='';
      if(p.firmaDocumentoData===undefined)p.firmaDocumentoData='';
      if(p.telefonoDocumento===undefined)p.telefonoDocumento='';
      if(p.emailDocumento===undefined)p.emailDocumento='';
      if(p.direccionDocumento===undefined)p.direccionDocumento='';
      if(p.redesDocumento===undefined)p.redesDocumento='';
      if(p.matriculaNacional===undefined)p.matriculaNacional=p.id==='matias'?'M.N. 115.607':'';
      if(p.matriculaProvincial===undefined)p.matriculaProvincial=p.id==='matias'?'M.P. 332.578':'';
      if(p.colorDocumento===undefined)p.colorDocumento='#174b5c';
      if(p.mostrarFirmaDocumento===undefined)p.mostrarFirmaDocumento=true;
    });
  }
  function setVersion406(){
    document.title=`CardioLink Admin v${VERSION_406}`;
    document.querySelectorAll('.brand-main span,.mobile-app-title-370 span').forEach(el=>el.textContent=`v${VERSION_406}`);
    document.querySelectorAll('.login-meta').forEach(el=>el.textContent=`Versión ${VERSION_406} · 2026`);
    document.querySelectorAll('.print-title h2').forEach(el=>el.textContent=`CardioLink Admin v${VERSION_406}`);
  }

  function getLogo406(p){return p?.logoDocumentoData||p?.logoDocumento||'icons/icon-192.png';}
  function getSignature406(p){return p?.firmaDocumentoData||'';}
  function resolveImage406(src){
    if(!src)return '';
    if(/^data:image\//i.test(src)||/^blob:/i.test(src)||/^https?:/i.test(src))return src;
    try{return new URL(src,location.href).href;}catch(e){return src;}
  }
  function loadImage406(src){return new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=reject;img.src=src;});}
  function readDataUrl406(file){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(file);});}
  async function compressImage406(file,kind){
    if(!file||!/^image\//i.test(file.type||''))throw new Error('El archivo debe ser una imagen.');
    if(file.size>6*1024*1024)throw new Error('La imagen supera 6 MB.');
    const raw=await readDataUrl406(file),img=await loadImage406(raw);
    const maxW=kind==='signature'?1000:640,maxH=kind==='signature'?360:640;
    const scale=Math.min(1,maxW/img.width,maxH/img.height);
    const w=Math.max(1,Math.round(img.width*scale)),h=Math.max(1,Math.round(img.height*scale));
    const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
    const ctx=canvas.getContext('2d');ctx.clearRect(0,0,w,h);ctx.drawImage(img,0,0,w,h);
    let out='';
    try{out=canvas.toDataURL('image/webp',kind==='signature'?0.88:0.86);}catch(e){}
    if(!out||!out.startsWith('data:image/'))out=canvas.toDataURL('image/png');
    if(out.length>1100000)throw new Error('La imagen sigue siendo demasiado pesada luego de optimizarla. Usá una imagen más simple.');
    return out;
  }

  function identityPreviewHtml406(p){
    const logo=resolveImage406(getLogo406(p)),sig=resolveImage406(getSignature406(p));
    return `<div class="identity-preview406"><div class="identity-logo406">${logo?`<img src="${esc406(logo)}" alt="Logo">`:'<span>Sin logo</span>'}</div><div class="identity-copy406"><strong>${esc406(p?.marcaDocumento||p?.nombre||'Marca profesional')}</strong><span>${esc406(p?.nombre||'Profesional')}</span><small>${esc406(specialities406(p))}</small></div><div class="identity-signature406">${sig?`<img src="${esc406(sig)}" alt="Firma">`:'<span>Sin firma cargada</span>'}</div></div>`;
  }

  function enhanceConfigIdentity406(){
    ensure406();
    const block=$406('docProfFields402');if(!block||$406('identityUploads406'))return;
    const add=document.createElement('div');add.id='identityUploads406';add.className='identity-uploads406';
    add.innerHTML=`<h4>Logo y firma del profesional</h4><p class="muted">Se guardan en el perfil profesional y se aplican a Historia Clínica, recetas, órdenes y certificados. La firma cargada es una imagen gráfica; no reemplaza una firma digital certificada.</p><div id="identityPreview406"></div><div class="identity-upload-grid406"><div><label>Logo del consultorio o profesional</label><input id="logoFile406" type="file" accept="image/png,image/jpeg,image/webp" hidden><div class="identity-actions406"><button type="button" class="secondary" id="uploadLogo406">Subir logo</button><button type="button" class="secondary" id="removeLogo406">Quitar logo subido</button></div></div><div><label>Firma escaneada</label><input id="signatureFile406" type="file" accept="image/png,image/jpeg,image/webp" hidden><div class="identity-actions406"><button type="button" class="secondary" id="uploadSignature406">Subir firma</button><button type="button" class="secondary" id="removeSignature406">Quitar firma</button></div></div><label>Color del membrete<input id="docColor406" type="color" value="#174b5c"></label><label class="check-row-310"><input id="showSignature406" type="checkbox"> Incluir firma en documentos impresos</label></div><button type="button" class="primary" id="saveIdentity406">Guardar identidad profesional</button>`;
    block.appendChild(add);loadIdentityFields406();
  }
  function loadIdentityFields406(){
    ensure406();const pid=selectedProfId406(),p=prof406(pid);if(!p)return;
    const prev=$406('identityPreview406');if(prev)prev.innerHTML=identityPreviewHtml406(p);
    if($406('docColor406'))$406('docColor406').value=/^#[0-9a-f]{6}$/i.test(p.colorDocumento||'')?p.colorDocumento:'#174b5c';
    if($406('showSignature406'))$406('showSignature406').checked=p.mostrarFirmaDocumento!==false;
    const allowed=canEditIdentity406(pid);['uploadLogo406','removeLogo406','uploadSignature406','removeSignature406','saveIdentity406','docColor406','showSignature406'].forEach(id=>{const el=$406(id);if(el)el.disabled=!allowed;});
  }
  async function handleIdentityFile406(kind,file){
    const pid=selectedProfId406(),p=prof406(pid);if(!p||!canEditIdentity406(pid))return;
    try{
      const dataUrl=await compressImage406(file,kind);
      if(kind==='logo')p.logoDocumentoData=dataUrl;else p.firmaDocumentoData=dataUrl;
      persist406();loadIdentityFields406();alert(kind==='logo'?'Logo guardado.':'Firma guardada.');
    }catch(e){alert(e.message||'No se pudo procesar la imagen.');}
  }
  function saveIdentity406(){
    const pid=selectedProfId406(),p=prof406(pid);if(!p||!canEditIdentity406(pid))return;
    p.colorDocumento=$406('docColor406')?.value||'#174b5c';p.mostrarFirmaDocumento=$406('showSignature406')?.checked!==false;
    persist406();loadIdentityFields406();alert('Identidad profesional guardada.');
  }
  function removeIdentityImage406(kind){
    const pid=selectedProfId406(),p=prof406(pid);if(!p||!canEditIdentity406(pid))return;
    if(kind==='logo')p.logoDocumentoData='';else p.firmaDocumentoData='';persist406();loadIdentityFields406();
  }

  function openOwnIdentity406(){
    ensure406();const pid=currentProfId406()||selectedProfId406(),p=prof406(pid);if(!p){alert('Este usuario no tiene un profesional asociado.');return;}
    const modal=document.createElement('div');modal.id='identityModal406';modal.className='hc-modal-overlay';
    modal.innerHTML=`<div class="hc-modal-card identity-modal-card406"><div class="hc-modal-head"><div><h2>Mi membrete y firma</h2><p class="muted">${esc406(p.nombre||'Profesional')}</p></div><button class="modal-close" type="button" data-close-identity406>×</button></div><div id="ownIdentityPreview406">${identityPreviewHtml406(p)}</div><div class="hc-modal-grid"><div><label>Nombre del consultorio / marca</label><input id="ownMarca406" value="${esc406(p.marcaDocumento||p.nombre||'')}"></div><div><label>Color del membrete</label><input id="ownColor406" type="color" value="${esc406(/^#[0-9a-f]{6}$/i.test(p.colorDocumento||'')?p.colorDocumento:'#174b5c')}"></div><div><label>Matrícula nacional</label><input id="ownMN406" value="${esc406(p.matriculaNacional||'')}"></div><div><label>Matrícula provincial</label><input id="ownMP406" value="${esc406(p.matriculaProvincial||'')}"></div><div><label>Teléfono / WhatsApp</label><input id="ownTelefono406" value="${esc406(p.telefonoDocumento||'')}"></div><div><label>Email</label><input id="ownEmail406" value="${esc406(p.emailDocumento||'')}"></div><div class="full"><label>Dirección del consultorio</label><input id="ownDireccion406" value="${esc406(p.direccionDocumento||'')}"></div><div class="full"><label>Redes / web</label><input id="ownRedes406" value="${esc406(p.redesDocumento||'')}"></div></div><div class="identity-upload-grid406"><div><input id="ownLogoFile406" type="file" accept="image/png,image/jpeg,image/webp" hidden><button class="secondary" type="button" id="ownUploadLogo406">Subir logo</button><button class="secondary" type="button" id="ownRemoveLogo406">Quitar logo</button></div><div><input id="ownSignatureFile406" type="file" accept="image/png,image/jpeg,image/webp" hidden><button class="secondary" type="button" id="ownUploadSignature406">Subir firma</button><button class="secondary" type="button" id="ownRemoveSignature406">Quitar firma</button></div><label class="check-row-310"><input id="ownShowSignature406" type="checkbox" ${p.mostrarFirmaDocumento!==false?'checked':''}> Incluir firma en documentos</label></div><div class="hc-modal-actions"><button class="secondary" type="button" data-close-identity406>Cancelar</button><button class="primary" type="button" id="saveOwnIdentity406">Guardar cambios</button></div></div>`;
    document.body.appendChild(modal);
  }
  async function uploadOwn406(kind,file){
    const pid=currentProfId406()||selectedProfId406(),p=prof406(pid);if(!p)return;
    try{const url=await compressImage406(file,kind);if(kind==='logo')p.logoDocumentoData=url;else p.firmaDocumentoData=url;persist406();$406('ownIdentityPreview406').innerHTML=identityPreviewHtml406(p);}catch(e){alert(e.message||'No se pudo procesar la imagen.');}
  }
  function saveOwnIdentity406(){
    const pid=currentProfId406()||selectedProfId406(),p=prof406(pid);if(!p)return;
    p.marcaDocumento=$406('ownMarca406')?.value.trim()||p.nombre;p.colorDocumento=$406('ownColor406')?.value||'#174b5c';p.matriculaNacional=$406('ownMN406')?.value.trim()||'';p.matriculaProvincial=$406('ownMP406')?.value.trim()||'';p.telefonoDocumento=$406('ownTelefono406')?.value.trim()||'';p.emailDocumento=$406('ownEmail406')?.value.trim()||'';p.direccionDocumento=$406('ownDireccion406')?.value.trim()||'';p.redesDocumento=$406('ownRedes406')?.value.trim()||'';p.mostrarFirmaDocumento=$406('ownShowSignature406')?.checked!==false;persist406();$406('identityModal406')?.remove();alert('Membrete y firma guardados.');
  }

  function docsForPatient406(p){
    ensure406();const key=patientKey406(p),dni=String(p?.dni||'').replace(/\D/g,'');
    return data.documentosClinicos.filter(d=>d.pacienteId===key||d.pacienteId===p?.id||(dni&&String(d.dni||'').replace(/\D/g,'')===dni)).sort((a,b)=>String(b.fechaHora||'').localeCompare(String(a.fechaHora||'')));
  }
  const DOC_TYPES_4093=[
    ['receta','Receta'],
    ['orden','Orden médica'],
    ['certificado','Certificado'],
    ['constancia_atencion','Constancia de atención'],
    ['ecg','ECG'],
    ['ecg_riesgo_quirurgico','ECG y riesgo quirúrgico'],
    ['apto_fisico','Apto físico'],
    ['ecografia','Ecografía'],
    ['holter','Holter'],
    ['mapa','MAPA'],
    ['radiografia','Radiografía'],
    ['mensaje_colega','Mensaje a colega'],
    ['indicacion_paciente','Indicación al paciente']
  ];
  function docLabel406(type){return (DOC_TYPES_4093.find(x=>x[0]===type)||['','Documento clínico'])[1];}
  function docTypeOptions406(type){return DOC_TYPES_4093.map(([value,label])=>`<option value="${esc406(value)}" ${type===value?'selected':''}>${esc406(label)}</option>`).join('');}
  function canEditDoc406(d){
    if(isAdmin406())return true;
    const ts=new Date(d.fechaHora||d.creadoEn||0).getTime();return String(d.profesionalId)===String(currentProfId406())&&Date.now()-ts<=24*60*60*1000;
  }
  function defaultDoc406(type,p){
    const name=patientName406(p)||'Paciente',dni=p?.dni||'s/d';
    if(type==='receta')return {title:'Receta médica',body:'R/P\n\n',extra:'Indicaciones:\n'};
    if(type==='orden')return {title:'Orden médica',body:'Solicito:\n\n',extra:'Diagnóstico presuntivo / indicación:\n'};
    if(type==='certificado')return {title:'Certificado médico',body:`Se deja constancia de que ${name}, DNI ${dni}, `,extra:''};
    if(type==='constancia_atencion')return {title:'Constancia de atención',body:`Se deja constancia de que ${name}, DNI ${dni}, fue atendido/a en este consultorio en la fecha indicada.\n\nSe extiende la presente constancia a solicitud del interesado/a.`,extra:''};
    if(type==='ecg')return {title:'Informe de electrocardiograma',body:'Ritmo: ___\nFrecuencia cardíaca: ___ lpm\nEje eléctrico: ___\nIntervalos PR / QRS / QTc: ___ / ___ / ___ ms\nRepolarización: ___\n\nConclusión: ___',extra:''};
    if(type==='ecg_riesgo_quirurgico')return {title:'ECG y evaluación de riesgo quirúrgico',body:'ECG: ___\nAntecedentes cardiovasculares relevantes: ___\nCapacidad funcional estimada: ___ METS\nRiesgo cardiovascular perioperatorio: ___\n\nConclusión y recomendaciones: ___',extra:''};
    if(type==='apto_fisico')return {title:'Evaluación para apto físico',body:`Se deja constancia de que ${name}, DNI ${dni}, fue evaluado/a para la realización de actividad física.\n\nConclusión: [APTO / APTO CONDICIONAL / NO APTO TRANSITORIO]\nObservaciones: ___`,extra:''};
    if(type==='ecografia')return {title:'Informe de ecografía',body:'Estudio realizado: ___\n\nHallazgos: ___\n\nConclusión: ___',extra:''};
    if(type==='holter')return {title:'Informe de Holter',body:'Ritmo predominante: ___\nFC mínima / media / máxima: ___ / ___ / ___ lpm\nExtrasístoles supraventriculares: ___\nExtrasístoles ventriculares: ___\nPausas / bloqueos: ___\nSíntomas y correlación: ___\n\nConclusión: ___',extra:''};
    if(type==='mapa')return {title:'Informe de MAPA',body:'Período válido: ___ horas\nPromedio 24 h: ___ / ___ mmHg\nPromedio vigilia: ___ / ___ mmHg\nPromedio sueño: ___ / ___ mmHg\nPatrón nocturno: ___\nCarga hipertensiva: ___\n\nConclusión: ___',extra:''};
    if(type==='radiografia')return {title:'Informe de radiografía',body:'Estudio: ___\n\nHallazgos: ___\n\nConclusión: ___',extra:''};
    if(type==='mensaje_colega')return {title:'Mensaje a colega',body:`Estimado/a colega:\n\nLe envío información sobre ${name}, DNI ${dni}.\n\nMotivo / resumen clínico: ___\n\nConducta o solicitud: ___\n\nSaludos cordiales.`,extra:''};
    if(type==='indicacion_paciente')return {title:'Indicaciones al paciente',body:'Indicaciones:\n1. ___\n2. ___\n3. ___\n\nSignos de alarma: ___\nPróximo control: ___',extra:''};
    return {title:'Documento clínico',body:'',extra:''};
  }
  function openDocumentModal406(key,docId='',forcedType=''){
    const p=patient406(key);if(!p)return;ensure406();
    const existing=docId?data.documentosClinicos.find(d=>d.id===docId):null;
    const type=existing?.tipo||forcedType||'receta';
    if(!canIssueDoc406(type)){alert('Tu perfil no tiene permiso para emitir este tipo de documento.');return;}
    if(existing&&!canEditDoc406(existing)&&!isSecretary406()){alert('Este documento superó las 24 horas y solo puede modificarse con perfil Administrador.');return;}
    const profId=existing?.profesionalId||(isSecretary406()?responsibleProfId406(p):(currentProfId406()||selectedProfId406())),pr=prof406(profId);if(!pr){alert('No se pudo identificar el profesional responsable de la atención.');return;}
    const defs=defaultDoc406(type,p);
    const modal=document.createElement('div');modal.id='clinicalDocModal406';modal.className='hc-modal-overlay';
    modal.innerHTML=`<div class="hc-modal-card clinical-doc-card406"><div class="hc-modal-head"><div><h2>${existing?'Editar documento':'Nuevo documento clínico'}</h2><p class="muted">${esc406(patientName406(p))} · <span id="docProfLabel406">${esc406(pr.nombre||'')}</span></p></div><button type="button" class="modal-close" data-close-doc406>×</button></div>${isSecretary406()?`<div class="doc-prof-selector406"><label>Profesional responsable<select id="docProfessional406">${(data.profesionales||[]).filter(x=>x.id!=='general').map(x=>`<option value="${esc406(x.id)}" ${String(x.id)===String(profId)?'selected':''}>${esc406(x.nombre)}</option>`).join('')}</select></label><p class="muted">El certificado/constancia usará el membrete del profesional seleccionado.</p></div>`:''}<div class="clinical-doc-header406" id="docIdentityPreview406">${identityPreviewHtml406(pr)}</div><div class="hc-modal-grid"><div><label>Tipo de documento</label><select id="docType406">${docTypeOptions406(type)}</select></div><div><label>Fecha</label><input id="docDate406" type="datetime-local" value="${esc406((existing?.fechaHora||new Date().toISOString()).slice(0,16))}"></div><div class="full"><div class="cl-voice-label4094"><label for="docTitle406">Título</label><button class="cl-voice-btn4094" type="button" data-cl-voice-target4094="docTitle406" aria-label="Dictar título del documento">🎤 Dictar</button></div><input id="docTitle406" value="${esc406(existing?.titulo||defs.title)}"></div><div class="full"><div class="cl-voice-label4094"><label id="docBodyLabel406" for="docBody406">Contenido</label><button class="cl-voice-btn4094" type="button" data-cl-voice-target4094="docBody406" aria-label="Dictar contenido del documento">🎤 Dictar</button></div><textarea id="docBody406" rows="8" placeholder="Escribí el contenido del documento">${esc406(existing?.contenido||defs.body)}</textarea></div><div class="full"><div class="cl-voice-label4094"><label for="docExtra406">Indicaciones / aclaraciones adicionales</label><button class="cl-voice-btn4094" type="button" data-cl-voice-target4094="docExtra406" aria-label="Dictar indicaciones adicionales">🎤 Dictar</button></div><textarea id="docExtra406" rows="4">${esc406(existing?.adicional||defs.extra)}</textarea></div><label class="check-row-310 full"><input type="checkbox" id="docIncludeSignature406" ${existing?.incluirFirma===false?'':'checked'}> Incluir firma cargada del profesional</label></div><p class="muted">El documento no se guarda si está vacío. El guardado es manual. Puede editarse durante 24 horas; el Administrador conserva edición sin límite.</p><div class="hc-modal-actions"><button class="secondary" type="button" data-close-doc406>Cancelar</button><button class="secondary" type="button" id="saveDoc406">Guardar</button><button class="primary" type="button" id="savePrintDoc406">Guardar e imprimir</button></div></div>`;
    document.body.appendChild(modal);
    $406('docType406').addEventListener('change',()=>{if(existing)return;const d=defaultDoc406($406('docType406').value,p);$406('docTitle406').value=d.title;$406('docBody406').value=d.body;$406('docExtra406').value=d.extra;});
    $406('docProfessional406')?.addEventListener('change',e=>{
      const pp=prof406(e.target.value);if(!pp)return;
      if($406('docProfLabel406'))$406('docProfLabel406').textContent=pp.nombre||'Profesional';
      if($406('docIdentityPreview406'))$406('docIdentityPreview406').innerHTML=identityPreviewHtml406(pp);
    });
    $406('saveDoc406').onclick=()=>saveDocument406(p,existing,false);
    $406('savePrintDoc406').onclick=()=>saveDocument406(p,existing,true);
  }
  function saveDocument406(p,existing,printAfter){
    const tipo=$406('docType406')?.value||'receta',titulo=$406('docTitle406')?.value.trim()||docLabel406(tipo),contenido=$406('docBody406')?.value.trim()||'',adicional=$406('docExtra406')?.value.trim()||'';
    if(!contenido&&!adicional){alert('Escribí el contenido antes de guardar.');return;}
    const profId=existing?.profesionalId||($406('docProfessional406')?.value)||(isSecretary406()?responsibleProfId406(p):(currentProfId406()||selectedProfId406())),pr=prof406(profId);if(!pr){alert('No se pudo identificar el profesional responsable.');return;}
    const now=new Date().toISOString(),fechaInput=$406('docDate406')?.value,fechaHora=fechaInput?new Date(fechaInput).toISOString():now;
    let doc=existing;
    if(existing){Object.assign(existing,{tipo,titulo,contenido,adicional,fechaHora,incluirFirma:$406('docIncludeSignature406')?.checked!==false,actualizadoEn:now,actualizadoPor:pr.nombre});}
    else{doc={id:'doc_'+Date.now()+'_'+Math.random().toString(36).slice(2,7),pacienteId:patientKey406(p),dni:p.dni||'',pacienteNombre:patientName406(p),tipo,titulo,contenido,adicional,fechaHora,profesionalId:profId,profesionalNombre:pr.nombre,incluirFirma:$406('docIncludeSignature406')?.checked!==false,creadoEn:now,creadoPor:currentUser406().nombre||pr.nombre};data.documentosClinicos.push(doc);}
    persist406();$406('clinicalDocModal406')?.remove();enhanceHC406();enhancePatientFicha406();if(printAfter)printDocument406(doc.id);
  }
  function printDocument406(id){
    ensure406();const d=data.documentosClinicos.find(x=>x.id===id);if(!d)return;const p=patient406(d.pacienteId)||patients406().find(x=>String(x.dni||'').replace(/\D/g,'')===String(d.dni||'').replace(/\D/g,''))||{},pr=prof406(d.profesionalId)||{},color=/^#[0-9a-f]{6}$/i.test(pr.colorDocumento||'')?pr.colorDocumento:'#174b5c';
    const logo=resolveImage406(getLogo406(pr)),sig=d.incluirFirma!==false&&pr.mostrarFirmaDocumento!==false?resolveImage406(getSignature406(pr)):'';
    const contacts=[pr.telefonoDocumento,pr.emailDocumento,pr.direccionDocumento,pr.redesDocumento].filter(Boolean).map(esc406).join(' · '),licenses=[pr.matriculaNacional,pr.matriculaProvincial].filter(Boolean).map(esc406).join(' · ');
    const w=window.open('','_blank');if(!w)return;
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc406(d.titulo)} - ${esc406(patientName406(p)||d.pacienteNombre)}</title><style>@page{size:A4;margin:18mm 16mm 20mm}*{box-sizing:border-box}body{font-family:Arial,Helvetica,sans-serif;color:#111827;margin:0;font-size:14px}.doc-head{display:grid;grid-template-columns:78px 1fr;gap:16px;align-items:center;border-bottom:3px solid ${color};padding-bottom:12px;margin-bottom:24px}.doc-logo{width:74px;height:74px;object-fit:contain}.brand{font-size:22px;font-weight:800;color:${color}}.doctor{font-size:17px;font-weight:800;margin-top:3px}.meta,.contact{color:#475569;line-height:1.45}.doc-title{text-align:center;text-transform:uppercase;letter-spacing:.08em;font-size:20px;margin:28px 0 22px;color:${color}}.patient-box{border:1px solid #cbd5e1;border-radius:10px;padding:12px 14px;margin-bottom:24px;display:grid;grid-template-columns:1fr auto;gap:14px}.patient-name{font-size:18px;font-weight:800}.body{min-height:330px;font-size:16px;line-height:1.65;white-space:pre-wrap}.extra{margin-top:22px;padding-top:16px;border-top:1px solid #e2e8f0;white-space:pre-wrap;line-height:1.55}.signature{margin-top:48px;margin-left:auto;width:270px;text-align:center;page-break-inside:avoid}.signature img{max-width:230px;max-height:100px;object-fit:contain;display:block;margin:0 auto 4px}.sig-line{border-top:1px solid #334155;padding-top:5px;font-weight:700}.sig-meta{font-size:11px;color:#475569;line-height:1.35}.footer{position:fixed;bottom:0;left:0;right:0;border-top:1px solid #cbd5e1;padding-top:6px;color:#64748b;font-size:9px;display:flex;justify-content:space-between;gap:12px}</style></head><body><header class="doc-head">${logo?`<img class="doc-logo" src="${esc406(logo)}">`:''}<div><div class="brand">${esc406(pr.marcaDocumento||pr.nombre||'')}</div><div class="doctor">${esc406(pr.nombre||d.profesionalNombre||'')}</div><div class="meta">${esc406(specialities406(pr))}${licenses?' · '+licenses:''}</div>${contacts?`<div class="contact">${contacts}</div>`:''}</div></header><h1 class="doc-title">${esc406(d.titulo||docLabel406(d.tipo))}</h1><section class="patient-box"><div><div class="patient-name">${esc406(patientName406(p)||d.pacienteNombre||'Paciente')}</div><div class="meta">DNI ${esc406(p.dni||d.dni||'s/d')}${p.coberturaHabitual?' · '+esc406(p.coberturaHabitual):''}</div></div><div class="meta">${esc406(fmtDT406(d.fechaHora))}</div></section><main class="body">${esc406(d.contenido||'')}</main>${d.adicional?`<section class="extra">${esc406(d.adicional)}</section>`:''}<section class="signature">${sig?`<img src="${esc406(sig)}">`:''}<div class="sig-line">${esc406(pr.nombre||d.profesionalNombre||'')}</div><div class="sig-meta">${esc406(specialities406(pr))}<br>${licenses}</div></section><footer class="footer"><span>${esc406(pr.marcaDocumento||'CardioLink')}</span><span>Firma gráfica. Documento emitido desde CardioLink v${VERSION_406}</span></footer></body></html>`);
    w.document.close();setTimeout(()=>w.print(),350);
  }
  function docsSection406(p){
    const docs=docsForPatient406(p);
    return `<section class="clinical-docs406" data-docs-section406><div class="clinical-docs-head406"><div><h3>Documentos clínicos e informes rápidos</h3><p class="muted">Recetas, órdenes, certificados, informes breves e indicaciones emitidas para este paciente.</p></div>${isMedical406()?`<button class="primary" type="button" data-new-doc406="${esc406(patientKey406(p))}">+ Nuevo documento</button>`:''}</div><div class="clinical-doc-list406">${docs.length?docs.map(d=>`<article class="clinical-doc-row406"><div><strong>${esc406(d.titulo||docLabel406(d.tipo))}</strong><span>${esc406(fmtDT406(d.fechaHora))} · ${esc406(d.profesionalNombre||'')}</span></div><div class="clinical-doc-actions406">${canEditDoc406(d)?`<button class="secondary small-btn" type="button" data-edit-doc406="${esc406(d.id)}" data-doc-patient406="${esc406(patientKey406(p))}">Editar</button>`:''}<button class="secondary small-btn" type="button" data-print-doc406="${esc406(d.id)}">Imprimir</button></div></article>`).join(''):'<p class="muted">Todavía no hay documentos emitidos.</p>'}</div></section>`;
  }
  function enhanceHC406(){
    ensure406();const root=$406('hcPacienteDetalle');if(!root)return;const key=root.querySelector('[data-hc-new]')?.dataset.hcNew;if(!key)return;const p=patient406(key);if(!p)return;
    const actions=root.querySelector('.hc-patient-actions');if(actions&&isMedical406()&&!actions.querySelector('[data-new-doc406]')){const b=document.createElement('button');b.className='secondary';b.type='button';b.dataset.newDoc406=key;b.textContent='+ Documento';actions.insertBefore(b,actions.querySelector('[data-hc-print]')||null);}
    if(!root.querySelector('[data-docs-section406]')){const summary=root.querySelector('.hc-clinical-summary');if(summary)summary.insertAdjacentHTML('afterend',docsSection406(p));else root.insertAdjacentHTML('beforeend',docsSection406(p));}
  }
  function enhancePatientFicha406(id){
    ensure406();const key=id||window.pacienteSeleccionadoPanelId||'';const p=patient406(key);if(!p)return;const root=$406('pacienteDetalle');if(!root)return;
    const actions=root.querySelector('.paciente-ficha-actions');if(actions&&isMedical406()&&!actions.querySelector('[data-new-doc406]')){const b=document.createElement('button');b.className='secondary';b.type='button';b.dataset.newDoc406=patientKey406(p);b.textContent='Documento / informe rápido';actions.prepend(b);}
    if(!root.querySelector('[data-docs-section406]')){const history=root.querySelector('.paciente-historial-wrap');if(history)history.insertAdjacentHTML('beforebegin',docsSection406(p));}
  }
  function injectIdentityToolbar406(){
    const hc=$406('hc');if(!hc||$406('myIdentity406')||!isMedical406())return;const card=hc.querySelector('.card');if(!card)return;const b=document.createElement('button');b.id='myIdentity406';b.className='secondary my-identity406';b.type='button';b.textContent='Mi membrete y firma';const title=card.querySelector('h2');if(title)title.insertAdjacentElement('afterend',b);else card.prepend(b);
  }
  function wrapRenderConfig406(){
    const old=window.renderConfig;if(typeof old!=='function'||old.__v406)return;
    const w=function(){const r=old.apply(this,arguments);setTimeout(()=>{enhanceConfigIdentity406();loadIdentityFields406();setVersion406();},30);return r;};w.__v406=true;window.renderConfig=renderConfig=w;
  }
  function wrapPatient406(){
    const old=window.seleccionarPacientePanel;if(typeof old!=='function'||old.__v406)return;
    const w=function(id){const r=old.apply(this,arguments);setTimeout(()=>enhancePatientFicha406(id),50);return r;};w.__v406=true;window.seleccionarPacientePanel=seleccionarPacientePanel=w;
  }

  document.addEventListener('click',e=>{
    if(e.target.id==='uploadLogo406'){$406('logoFile406')?.click();return;}
    if(e.target.id==='uploadSignature406'){$406('signatureFile406')?.click();return;}
    if(e.target.id==='removeLogo406'){removeIdentityImage406('logo');return;}
    if(e.target.id==='removeSignature406'){removeIdentityImage406('signature');return;}
    if(e.target.id==='saveIdentity406'){saveIdentity406();return;}
    if(e.target.id==='myIdentity406'){openOwnIdentity406();return;}
    if(e.target.closest?.('[data-close-identity406]')){$406('identityModal406')?.remove();return;}
    if(e.target.id==='ownUploadLogo406'){$406('ownLogoFile406')?.click();return;}
    if(e.target.id==='ownUploadSignature406'){$406('ownSignatureFile406')?.click();return;}
    if(e.target.id==='ownRemoveLogo406'){const p=prof406(currentProfId406()||selectedProfId406());if(p){p.logoDocumentoData='';persist406();$406('ownIdentityPreview406').innerHTML=identityPreviewHtml406(p);}return;}
    if(e.target.id==='ownRemoveSignature406'){const p=prof406(currentProfId406()||selectedProfId406());if(p){p.firmaDocumentoData='';persist406();$406('ownIdentityPreview406').innerHTML=identityPreviewHtml406(p);}return;}
    if(e.target.id==='saveOwnIdentity406'){saveOwnIdentity406();return;}
    const nd=e.target.closest?.('[data-new-doc406]');if(nd){openDocumentModal406(nd.dataset.newDoc406);return;}
    const ed=e.target.closest?.('[data-edit-doc406]');if(ed){openDocumentModal406(ed.dataset.docPatient406,ed.dataset.editDoc406);return;}
    const pd=e.target.closest?.('[data-print-doc406]');if(pd){printDocument406(pd.dataset.printDoc406);return;}
    if(e.target.closest?.('[data-close-doc406]')){$406('clinicalDocModal406')?.remove();return;}
  },true);
  document.addEventListener('change',e=>{
    if(e.target.id==='logoFile406')handleIdentityFile406('logo',e.target.files?.[0]);
    if(e.target.id==='signatureFile406')handleIdentityFile406('signature',e.target.files?.[0]);
    if(e.target.id==='ownLogoFile406')uploadOwn406('logo',e.target.files?.[0]);
    if(e.target.id==='ownSignatureFile406')uploadOwn406('signature',e.target.files?.[0]);
    if(e.target.id==='cfgProfEditar310')setTimeout(loadIdentityFields406,20);
  });

  function boot406(){
    ensure406();wrapRenderConfig406();wrapPatient406();injectIdentityToolbar406();enhanceConfigIdentity406();loadIdentityFields406();enhanceHC406();enhancePatientFicha406();setVersion406();
    const hc=$406('hcPacienteDetalle');if(hc)new MutationObserver(()=>setTimeout(enhanceHC406,0)).observe(hc,{childList:true,subtree:true});
    const pd=$406('pacienteDetalle');if(pd)new MutationObserver(()=>setTimeout(()=>enhancePatientFicha406(),0)).observe(pd,{childList:true,subtree:true});
    setTimeout(()=>{setVersion406();injectIdentityToolbar406();enhanceConfigIdentity406();loadIdentityFields406();enhanceHC406();enhancePatientFicha406();},900);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot406);else boot406();
  window.printClinicalDocument406=printDocument406;
  window.openClinicalDocument406=openDocumentModal406;
  window.openClinicalDocumentTyped406=(key,type)=>openDocumentModal406(key,'',type||'receta');
})();


/* ===== CardioLink Admin v4.1.0-hc — dictado clínico por campo ===== */
(function(){
  'use strict';
  const Recognition=window.SpeechRecognition||window.webkitSpeechRecognition;
  let recognition=null,activeTarget=null,activeButton=null,lastError='',silentEnd=false;

  function statusBox(){
    let box=document.getElementById('clVoiceStatus4094');
    if(!box){
      box=document.createElement('div');
      box.id='clVoiceStatus4094';
      box.className='cl-voice-status4094';
      box.hidden=true;
      box.innerHTML='<span class="cl-voice-dot4094"></span><strong>Dictado</strong><span data-cl-voice-status-text4094></span><button type="button" data-cl-voice-stop4094>Detener</button>';
      document.body.appendChild(box);
    }
    return box;
  }
  function setStatus(text,mode='listening'){
    const box=statusBox(),label=box.querySelector('[data-cl-voice-status-text4094]');
    if(label)label.textContent=text||'';
    box.dataset.mode=mode;box.hidden=false;
  }
  function hideStatus(delay=0){
    const box=document.getElementById('clVoiceStatus4094');if(!box)return;
    const doHide=()=>{box.hidden=true;box.dataset.mode='';};
    delay?setTimeout(doHide,delay):doHide();
  }
  function resetButton(){
    if(activeButton){activeButton.classList.remove('is-listening');activeButton.textContent='🎤 Dictar';activeButton.setAttribute('aria-pressed','false');}
  }
  function normalizeSpacing(target,text){
    let t=String(text||'').trim();if(!t)return '';
    const value=String(target.value||''),start=Number.isFinite(target.selectionStart)?target.selectionStart:value.length;
    const before=value.slice(0,start),after=value.slice(Number.isFinite(target.selectionEnd)?target.selectionEnd:start);
    if(before&&!/\s$/.test(before)&&!/^\s|^[,.;:!?)]/.test(t))t=' '+t;
    if(after&&!/^\s/.test(after)&&!/[\s(]$/.test(t))t=t+' ';
    return t;
  }
  function insertAtCursor(target,text){
    if(!target||!target.isConnected)return;
    const value=String(target.value||''),start=Number.isFinite(target.selectionStart)?target.selectionStart:value.length,end=Number.isFinite(target.selectionEnd)?target.selectionEnd:start;
    const inserted=normalizeSpacing(target,text);if(!inserted)return;
    target.value=value.slice(0,start)+inserted+value.slice(end);
    const pos=start+inserted.length;try{target.setSelectionRange(pos,pos);}catch(e){}
    target.focus();target.dispatchEvent(new Event('input',{bubbles:true}));target.dispatchEvent(new Event('change',{bubbles:true}));
  }
  function friendlyError(code){
    const map={
      'not-allowed':'No se autorizó el micrófono. Revisá el permiso del navegador.',
      'service-not-allowed':'El navegador bloqueó el servicio de dictado.',
      'audio-capture':'No se encontró un micrófono disponible.',
      'network':'El servicio de reconocimiento no respondió. Probá nuevamente.',
      'no-speech':'No se detectó voz.',
      'language-not-supported':'El idioma es-AR no está disponible en este dispositivo.'
    };
    return map[code]||'El dictado se interrumpió.';
  }
  function cleanup(showEnd=false){
    resetButton();recognition=null;activeTarget=null;activeButton=null;
    if(showEnd){setStatus('Dictado detenido. El texto queda editable y todavía no se guardó.','done');hideStatus(1800);}else hideStatus();
  }
  function stop(showEnd=true){
    silentEnd=!showEnd;
    const r=recognition;if(!r){cleanup(false);return;}
    try{r.stop();}catch(e){try{r.abort();}catch(_){}cleanup(showEnd);}
  }
  function unsupportedMessage(){
    const local=location.protocol==='file:';
    alert((local?'Para probar el micrófono abrí CardioLink desde GitHub Pages (HTTPS), no desde el index.html local.\n\n':'')+'Este navegador no habilita el dictado integrado. Podés usar el micrófono del teclado del teléfono/tablet o probar con un navegador compatible. CardioLink solo incorpora el texto; no guarda el audio.');
  }
  function start(targetId,button){
    const target=document.getElementById(targetId);if(!target){alert('No se encontró el campo de destino.');return;}
    if(!Recognition){unsupportedMessage();return;}
    if(recognition){
      if(activeTarget===target){stop(true);return;}
      stop(false);setTimeout(()=>start(targetId,button),180);return;
    }
    lastError='';silentEnd=false;activeTarget=target;activeButton=button;
    recognition=new Recognition();
    recognition.lang='es-AR';recognition.interimResults=true;recognition.continuous=true;recognition.maxAlternatives=1;
    recognition.onstart=()=>{
      if(activeButton){activeButton.classList.add('is-listening');activeButton.textContent='⏹ Detener';activeButton.setAttribute('aria-pressed','true');}
      setStatus('Escuchando en “'+(target.getAttribute('aria-label')||target.closest('div')?.querySelector('label')?.textContent||'campo')+'”…','listening');
    };
    recognition.onresult=e=>{
      if(!activeTarget?.isConnected){stop(false);return;}
      let finalText='',interim='';
      for(let i=e.resultIndex;i<e.results.length;i++){
        const transcript=e.results[i][0]?.transcript||'';
        if(e.results[i].isFinal)finalText+=transcript;else interim+=transcript;
      }
      if(finalText)insertAtCursor(activeTarget,finalText);
      setStatus(interim?('Escuchando: '+interim.trim()):'Escuchando…','listening');
    };
    recognition.onerror=e=>{
      lastError=e.error||'error';
      const msg=friendlyError(lastError);setStatus(msg,'error');
      if(['not-allowed','service-not-allowed','audio-capture','network','language-not-supported'].includes(lastError))setTimeout(()=>alert(msg+'\n\nEl texto ya dictado no se pierde.'),30);
    };
    recognition.onend=()=>{
      const err=lastError,quiet=silentEnd;resetButton();recognition=null;activeTarget=null;activeButton=null;silentEnd=false;
      if(quiet){hideStatus();}else if(err){hideStatus(2600);}else{setStatus('Dictado detenido. Revisá el texto antes de guardar.','done');hideStatus(1600);}
    };
    try{recognition.start();}catch(e){cleanup(false);setStatus('No se pudo iniciar el micrófono. Probá nuevamente.','error');hideStatus(2500);}
  }

  document.addEventListener('click',e=>{
    const btn=e.target.closest?.('[data-cl-voice-target4094]');
    if(btn){e.preventDefault();e.stopPropagation();start(btn.dataset.clVoiceTarget4094,btn);return;}
    if(e.target.closest?.('[data-cl-voice-stop4094]')){e.preventDefault();stop(true);return;}
    if(e.target.closest?.('[data-hc-close],[data-hc-close-summary],[data-close-doc406],#hcGuardarEvolucion,#saveDoc406,#savePrintDoc406'))stop(false);
  },true);
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&recognition)stop(false);});
  document.addEventListener('visibilitychange',()=>{if(document.hidden&&recognition)stop(false);});
  window.addEventListener('beforeunload',()=>{if(recognition)try{recognition.abort();}catch(e){}});
  window.CardioLinkVoice4094={stop:()=>stop(true),supported:!!Recognition};
})();


/* ===== CardioLink Admin v4.1.0-hc — RCTA asistido + paneles con scroll propio ===== */
(function(){
  'use strict';
  const VERSION_RCTA_4095='4.1.0-hc';
  const DEFAULT_RCTA_URL='https://app.rcta.me/';

  const esc4095=(value)=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[ch]));
  const digits4095=(value)=>String(value||'').replace(/\D/g,'');
  const patientName4095=(p)=>{
    try{return nombrePacientePanel?.(p)||p?.nombreCompleto||[p?.apellido,p?.nombre].filter(Boolean).join(' ')||'Paciente';}
    catch(_){return p?.nombreCompleto||[p?.apellido,p?.nombre].filter(Boolean).join(' ')||'Paciente';}
  };
  const patientKey4095=(p)=>{
    if(!p)return '';
    if(p.id)return String(p.id);
    const dni=digits4095(p.dni);if(dni)return 'legacy_'+dni;
    return 'legacy_'+patientName4095(p).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\W+/g,'_');
  };
  function allPatients4095(){
    try{if(typeof todosPacientes==='function')return todosPacientes()||[];}catch(_){ }
    return Array.isArray(window.data?.pacientes)?window.data.pacientes:[];
  }
  function findPatient4095(key){
    const raw=String(key||'');
    try{if(typeof buscarPacientePanelPorId==='function'){const p=buscarPacientePanelPorId(raw);if(p)return p;}}catch(_){ }
    return allPatients4095().find(p=>patientKey4095(p)===raw||String(p.id||'')===raw||digits4095(p.dni)===digits4095(raw))||null;
  }
  function validDate4095(raw){
    const s=String(raw||'').trim();if(!s)return null;
    let y,m,d,mt=s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if(mt){y=+mt[1];m=+mt[2];d=+mt[3];}
    else{mt=s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);if(!mt)return null;d=+mt[1];m=+mt[2];y=+mt[3];if(y<100)y+=y>40?1900:2000;}
    const dt=new Date(y,m-1,d);return dt.getFullYear()===y&&dt.getMonth()===m-1&&dt.getDate()===d?dt:null;
  }
  function age4095(p){
    const d=validDate4095(p?.fechaNacimiento);if(!d)return '';
    const n=new Date();let a=n.getFullYear()-d.getFullYear();
    if(n.getMonth()<d.getMonth()||(n.getMonth()===d.getMonth()&&n.getDate()<d.getDate()))a--;
    return a>=0&&a<130?String(a):'';
  }
  function displayDate4095(raw){
    const d=validDate4095(raw);if(!d)return String(raw||'s/d');
    return new Intl.DateTimeFormat('es-AR',{day:'2-digit',month:'2-digit',year:'numeric'}).format(d);
  }
  function preparedText4095(p){
    const rows=[
      ['Paciente',patientName4095(p)],
      ['DNI',p?.dni||'s/d'],
      ['Fecha de nacimiento',displayDate4095(p?.fechaNacimiento)],
      ['Edad',age4095(p)?age4095(p)+' años':'s/d'],
      ['Sexo',p?.sexo||'s/d'],
      ['Cobertura',p?.coberturaHabitual||'s/d'],
      ['N.º de afiliado',p?.numeroAfiliadoHabitual||'s/d'],
      ['Teléfono',p?.telefono||'s/d'],
      ['Email',p?.email||'s/d']
    ];
    return rows.map(([k,v])=>`${k}: ${v}`).join('\n');
  }
  async function copy4095(text){
    try{await navigator.clipboard.writeText(text);return true;}catch(_){
      try{const ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();const ok=document.execCommand('copy');ta.remove();return ok;}catch(__){return false;}
    }
  }
  function rctaUrl4095(){
    try{return String(window.data?.integracionesClinicas?.rctaUrl||DEFAULT_RCTA_URL);}catch(_){return DEFAULT_RCTA_URL;}
  }
  function openRcta4095(){
    const win=window.open(rctaUrl4095(),'_blank','noopener');
    if(!win)alert('El navegador bloqueó la apertura de RCTA. Habilitá las ventanas emergentes para CardioLink.');
  }
  function openRctaModal4095(key){
    const p=findPatient4095(key);if(!p){alert('No se encontró la ficha del paciente.');return;}
    document.getElementById('rctaAssistModal4095')?.remove();
    const text=preparedText4095(p),o=document.createElement('div');o.id='rctaAssistModal4095';o.className='hc-modal-overlay';
    o.innerHTML=`<div class="hc-modal-card rcta-assist-card4095"><div class="hc-modal-head"><div><h2>Recetar en RCTA</h2><p class="muted">CardioLink prepara los datos del paciente para evitar volver a buscarlos o escribirlos desde cero.</p></div><button class="modal-close" type="button" data-rcta-close4095>×</button></div>
      <div class="rcta-patient-title4095"><strong>${esc4095(patientName4095(p))}</strong><span>DNI ${esc4095(p.dni||'s/d')} · ${esc4095(p.coberturaHabitual||'Cobertura s/d')}</span></div>
      <label class="rcta-copy-label4095" for="rctaPrepared4095">Datos preparados</label><textarea id="rctaPrepared4095" readonly>${esc4095(text)}</textarea>
      <div class="rcta-assist-note4095"><strong>Cómo usarlo</strong><span>Copiá los datos y abrí RCTA. Si el paciente ya existe, buscalo por DNI. Si no existe, pegá estos datos al cargarlo.</span></div>
      <div class="hc-modal-actions rcta-actions4095"><button class="secondary" type="button" data-rcta-close4095>Cancelar</button><button class="secondary" type="button" data-rcta-copy4095>Copiar datos</button><button class="secondary" type="button" data-rcta-open4095>Abrir RCTA</button><button class="primary" type="button" data-rcta-copy-open4095>Copiar y abrir RCTA</button></div></div>`;
    document.body.appendChild(o);
  }
  function addButton4095(container,key,label='Recetar en RCTA',before=null){
    if(!container||!key||container.querySelector('[data-rcta-patient4095]'))return;
    const b=document.createElement('button');b.className='secondary rcta-button4095';b.type='button';b.dataset.rctaPatient4095=key;b.textContent=label;
    if(before&&before.parentNode===container)container.insertBefore(b,before);else container.appendChild(b);
  }
  function decorate4095(root=document){
    // Historia clínica seleccionada.
    const hc=root.querySelector?.('#hcPacienteDetalle')||document.getElementById('hcPacienteDetalle');
    if(hc){const actions=hc.querySelector('.hc-patient-actions'),key=hc.querySelector('[data-hc-new]')?.dataset.hcNew;if(actions&&key)addButton4095(actions,key,'Recetar en RCTA',actions.querySelector('[data-hc-print]'));}
    // Ficha administrativa.
    const pd=root.querySelector?.('#pacienteDetalle')||document.getElementById('pacienteDetalle');
    if(pd){
      const actions=pd.querySelector('.paciente-ficha-actions');
      const key=actions?.querySelector('[data-new-doc406]')?.dataset.newDoc406||actions?.querySelector('[data-open-hc]')?.dataset.openHc||'';
      const p=findPatient4095(key);
      if(actions&&p)addButton4095(actions,patientKey4095(p),'Recetar en RCTA');
    }
    // Ventana de evolución.
    const ev=document.getElementById('hcEvolutionModal');
    if(ev){const actions=ev.querySelector('.hc-patient-title-actions409'),key=ev.querySelector('[data-hc-edit-patient409]')?.dataset.hcEditPatient409;if(actions&&key)addButton4095(actions,key,'RCTA');}
  }
  let decorateQueued4096=false;
  function queueDecorate4096(delay=0){
    if(decorateQueued4096)return;
    decorateQueued4096=true;
    const run=()=>requestAnimationFrame(()=>{decorateQueued4096=false;decorate4095(document);});
    if(delay>0)setTimeout(run,delay);else run();
  }
  function bindLightDecorators4096(){
    // La versión anterior observaba cada cambio de todo el DOM. Con cientos de
    // pacientes y múltiples renderizados eso disparaba búsquedas constantes y
    // enlentecía toda la aplicación. Ahora se decora solo tras acciones reales.
    document.addEventListener('click',()=>queueDecorate4096(70),false);
    document.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' ')queueDecorate4096(90);},false);
    const originalShowSection=window.showSection;
    if(typeof originalShowSection==='function'&&!originalShowSection.__rctaPerf4096){
      const wrapped=function(){const result=originalShowSection.apply(this,arguments);queueDecorate4096(80);return result;};
      wrapped.__rctaPerf4096=true;
      window.showSection=wrapped;
    }
    queueDecorate4096(0);
    setTimeout(()=>queueDecorate4096(0),700);
    setTimeout(()=>queueDecorate4096(0),1800);
  }
  document.addEventListener('click',async e=>{
    const patientBtn=e.target.closest?.('[data-rcta-patient4095]');if(patientBtn){e.preventDefault();openRctaModal4095(patientBtn.dataset.rctaPatient4095);return;}
    if(e.target.closest?.('[data-rcta-close4095]')){document.getElementById('rctaAssistModal4095')?.remove();return;}
    if(e.target.closest?.('[data-rcta-copy4095]')){const ok=await copy4095(document.getElementById('rctaPrepared4095')?.value||'');alert(ok?'Datos del paciente copiados.':'No se pudieron copiar los datos.');return;}
    if(e.target.closest?.('[data-rcta-open4095]')){openRcta4095();return;}
    if(e.target.closest?.('[data-rcta-copy-open4095]')){const text=document.getElementById('rctaPrepared4095')?.value||'';openRcta4095();const ok=await copy4095(text);if(!ok)alert('RCTA se abrió, pero el navegador no permitió copiar automáticamente. Usá “Copiar datos”.');return;}
  },true);
  function boot4095(){
    try{if(window.data&&typeof window.data==='object'){window.data.integracionesClinicas=window.data.integracionesClinicas||{};if(!window.data.integracionesClinicas.rctaUrl)window.data.integracionesClinicas.rctaUrl=DEFAULT_RCTA_URL;}}
    catch(_){ }
    bindLightDecorators4096();
    try{document.title=`CardioLink Admin v${VERSION_RCTA_4095}`;document.querySelectorAll('.brand-main span,.mobile-app-title-370 span').forEach(x=>x.textContent=`v${VERSION_RCTA_4095}`);document.querySelectorAll('.login-meta').forEach(x=>x.textContent=`Versión ${VERSION_RCTA_4095} · 2026`);}catch(_){ }
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot4095);else boot4095();
  window.CardioLinkRCTA4095={open:openRctaModal4095,prepare:preparedText4095};
})();


/* ===== CardioLink v4.1.0-hc · Capa clínica relacional Fase 1 =====
   Objetivo:
   - Mantener compatibilidad con la HC actual en data/localStorage/config.
   - Copiar y recuperar pacientes clínicos, resumen y evoluciones desde tablas propias.
   - NO borrar automáticamente registros clínicos remotos.
   - NO convertir todavía estas tablas en única fuente de verdad.
*/
(function(){
  const VERSION_CLINICA_410='4.1.0-hc-fase1';

  function listo410(){
    try{return !!(supabaseClient && usuarioSupabase && data);}catch(e){return false;}
  }
  function digits410(v){return String(v||'').replace(/\D/g,'');}
  function isoDate410(v){
    const s=String(v||'').trim();
    if(!s)return null;
    if(/^\d{4}-\d{2}-\d{2}/.test(s))return s.slice(0,10);
    const m=s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
    if(!m)return null;
    let y=m[3]; if(y.length===2)y=(Number(y)>40?'19':'20')+y;
    return `${y.padStart(4,'0')}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  }
  function nombre410(p){
    try{return nombrePacientePanel?.(p)||p?.nombreCompleto||p?.paciente||'';}catch(e){return p?.nombreCompleto||p?.paciente||'';}
  }
  function key410(p){
    if(p?.id && !String(p.id).startsWith('legacy_'))return String(p.id);
    const dni=digits410(p?.dni);
    if(dni){
      const real=(data?.pacientes||[]).find(x=>digits410(x.dni)===dni && x.id && !String(x.id).startsWith('legacy_'));
      if(real)return String(real.id);
    }
    return String(p?.id||('pac_'+Date.now()+'_'+Math.floor(Math.random()*10000)));
  }
  function resumenLocal410(p){
    const k=key410(p);
    const direct=data?.resumenesClinicos?.[k];
    if(direct)return direct;
    const dni=digits410(p?.dni);
    if(dni && data?.resumenesClinicos){
      const match=(data?.pacientes||[]).find(x=>digits410(x.dni)===dni);
      if(match?.id && data.resumenesClinicos[match.id])return data.resumenesClinicos[match.id];
    }
    return null;
  }
  function evolucionesLocal410(p){
    const k=key410(p),dni=digits410(p?.dni);
    return (data?.evolucionesClinicas||[]).filter(e=>String(e.pacienteId||'')===k || (dni && digits410(e.dni)===dni));
  }
  function pacienteRow410(p){
    const id=key410(p);
    return {
      id,
      nombre_completo:nombre410(p)||null,
      dni:String(p?.dni||'').trim()||null,
      telefono:String(p?.telefono||'').trim()||null,
      email:String(p?.email||'').trim()||null,
      fecha_nacimiento:isoDate410(p?.fechaNacimiento),
      sexo:String(p?.sexo||'').trim()||null,
      localidad:String(p?.localidad||'').trim()||null,
      direccion:String(p?.direccion||'').trim()||null,
      provincia:String(p?.provincia||'').trim()||null,
      cobertura_habitual:String(p?.coberturaHabitual||'').trim()||null,
      numero_afiliado_habitual:String(p?.numeroAfiliadoHabitual||'').trim()||null,
      contacto_responsable_nombre:String(p?.contactoResponsableNombre||'').trim()||null,
      contacto_responsable_relacion:String(p?.contactoResponsableRelacion||'').trim()||null,
      contacto_responsable_telefono:String(p?.contactoResponsableTelefono||'').trim()||null,
      contacto_responsable_email:String(p?.contactoResponsableEmail||'').trim()||null,
      activo:p?.estado==='fusionado'?false:true,
      actualizado_en:new Date().toISOString()
    };
  }
  function resumenRow410(p,s){
    if(!s)return null;
    return {
      paciente_id:key410(p),
      antecedentes:String(s.antecedentes||''),
      alergias:String(s.alergias||''),
      medicacion_habitual:String(s.medicacion||s.medicacion_habitual||''),
      alertas:String(s.alertas||''),
      actualizado_en:s.actualizadoEn||new Date().toISOString(),
      actualizado_por:s.actualizadoPor||(()=>{try{return nombreUsuarioAuditoria?.()||usuarioSupabase?.email||'';}catch(e){return usuarioSupabase?.email||'';}})()
    };
  }
  function evolucionRow410(e,p){
    return {
      id:String(e.id),
      paciente_id:key410(p),
      atencion_id:e.atencionId?String(e.atencionId):null,
      fecha_hora:e.fechaHora||e.creadoEn||new Date().toISOString(),
      profesional_id:e.profesionalId?String(e.profesionalId):null,
      profesional_nombre:e.profesionalNombre||null,
      motivo:e.motivo||null,
      evolucion:e.evolucion||null,
      diagnostico:e.diagnostico||null,
      conducta:e.conducta||null,
      peso_kg:e.pesoKg??e.peso_kg??null,
      talla_cm:e.tallaCm??e.talla_cm??null,
      imc:e.imc??null,
      ta_sistolica:e.taSistolica??e.ta_sistolica??null,
      ta_diastolica:e.taDiastolica??e.ta_diastolica??null,
      frecuencia_cardiaca:e.frecuenciaCardiaca??e.frecuencia_cardiaca??null,
      sato2:e.sato2??null,
      temperatura:e.temperatura??null,
      creado_en:e.creadoEn||e.fechaHora||new Date().toISOString(),
      creado_por:e.creadoPor||e.profesionalNombre||null,
      editado_en:e.actualizadoEn||e.editadoEn||null,
      editado_por:e.actualizadoPor||e.editadoPor||null,
      origen:'CardioLink'
    };
  }

  async function sincronizarPacienteCompleto410(p){
    if(!listo410()||!p)return false;
    try{
      const prow=pacienteRow410(p);
      const {error:pe}=await supabaseClient.from('cardiolink_pacientes').upsert([prow],{onConflict:'id'});
      if(pe)throw pe;

      const s=resumenLocal410(p);
      if(s){
        const {error:se}=await supabaseClient.from('cardiolink_hc_resumen').upsert([resumenRow410(p,s)],{onConflict:'paciente_id'});
        if(se)throw se;
      }

      const ev=evolucionesLocal410(p).filter(x=>x?.id);
      if(ev.length){
        const rows=ev.map(x=>evolucionRow410(x,p));
        const {error:ee}=await supabaseClient.from('cardiolink_hc_evoluciones').upsert(rows,{onConflict:'id'});
        if(ee)throw ee;
      }
      console.log('HC relacional sincronizada:',prow.id,ev.length,'evolución(es)');
      return true;
    }catch(e){
      console.warn('HC relacional: no se pudo sincronizar paciente completo:',e?.message||e);
      return false;
    }
  }

  function mergePaciente410(row){
    if(!row?.id)return;
    if(!Array.isArray(data.pacientes))data.pacientes=[];
    let p=data.pacientes.find(x=>String(x.id||'')===String(row.id));
    if(!p && row.dni){p=data.pacientes.find(x=>digits410(x.dni)===digits410(row.dni));}
    if(!p){p={id:String(row.id),historialCoberturas:[]};data.pacientes.push(p);}
    // En Fase 1 la ficha administrativa vigente sigue teniendo prioridad.
    const fill=(k,v)=>{if((p[k]===undefined||p[k]===null||p[k]==='') && v!==undefined&&v!==null&&v!=='')p[k]=v;};
    fill('nombreCompleto',row.nombre_completo);fill('dni',row.dni);fill('telefono',row.telefono);fill('email',row.email);
    fill('fechaNacimiento',row.fecha_nacimiento);fill('sexo',row.sexo);fill('localidad',row.localidad);fill('direccion',row.direccion);fill('provincia',row.provincia);
    fill('coberturaHabitual',row.cobertura_habitual);fill('numeroAfiliadoHabitual',row.numero_afiliado_habitual);
    fill('contactoResponsableNombre',row.contacto_responsable_nombre);fill('contactoResponsableRelacion',row.contacto_responsable_relacion);
    fill('contactoResponsableTelefono',row.contacto_responsable_telefono);fill('contactoResponsableEmail',row.contacto_responsable_email);
  }
  function mergeResumen410(row){
    if(!row?.paciente_id)return;
    if(!data.resumenesClinicos||typeof data.resumenesClinicos!=='object')data.resumenesClinicos={};
    const local=data.resumenesClinicos[row.paciente_id];
    const rt=Date.parse(row.actualizado_en||0)||0,lt=Date.parse(local?.actualizadoEn||0)||0;
    if(!local || rt>=lt){
      data.resumenesClinicos[row.paciente_id]={antecedentes:row.antecedentes||'',alergias:row.alergias||'',medicacion:row.medicacion_habitual||'',alertas:row.alertas||'',actualizadoEn:row.actualizado_en||'',actualizadoPor:row.actualizado_por||''};
    }
  }
  function mergeEvolucion410(row){
    if(!row?.id)return;
    if(!Array.isArray(data.evolucionesClinicas))data.evolucionesClinicas=[];
    const incoming={id:String(row.id),pacienteId:String(row.paciente_id||''),atencionId:row.atencion_id?String(row.atencion_id):'',fechaHora:row.fecha_hora||row.creado_en||'',profesionalId:row.profesional_id||'',profesionalNombre:row.profesional_nombre||'',motivo:row.motivo||'',evolucion:row.evolucion||'',diagnostico:row.diagnostico||'',conducta:row.conducta||'',pesoKg:row.peso_kg??null,tallaCm:row.talla_cm??null,imc:row.imc??null,taSistolica:row.ta_sistolica??null,taDiastolica:row.ta_diastolica??null,frecuenciaCardiaca:row.frecuencia_cardiaca??null,sato2:row.sato2??null,temperatura:row.temperatura??null,creadoEn:row.creado_en||'',creadoPor:row.creado_por||'',actualizadoEn:row.editado_en||'',actualizadoPor:row.editado_por||''};
    const i=data.evolucionesClinicas.findIndex(x=>String(x.id||'')===String(row.id));
    if(i<0){data.evolucionesClinicas.push(incoming);return;}
    const local=data.evolucionesClinicas[i],rt=Date.parse(row.editado_en||row.creado_en||row.fecha_hora||0)||0,lt=Date.parse(local.actualizadoEn||local.creadoEn||local.fechaHora||0)||0;
    if(rt>=lt)data.evolucionesClinicas[i]={...local,...incoming};
  }

  let cargando410=false;
  async function cargar410(){
    if(!listo410()||cargando410)return false;
    cargando410=true;
    try{
      const [pa,re,ev]=await Promise.all([
        supabaseClient.from('cardiolink_pacientes').select('*'),
        supabaseClient.from('cardiolink_hc_resumen').select('*'),
        supabaseClient.from('cardiolink_hc_evoluciones').select('*').order('fecha_hora',{ascending:false})
      ]);
      if(pa.error)throw pa.error;if(re.error)throw re.error;if(ev.error)throw ev.error;
      (pa.data||[]).forEach(mergePaciente410);(re.data||[]).forEach(mergeResumen410);(ev.data||[]).forEach(mergeEvolucion410);
      try{localStorage.setItem(storageConfig,JSON.stringify(data));}catch(e){}
      console.log(`Capa clínica relacional ${VERSION_CLINICA_410} cargada:`,(pa.data||[]).length,'pacientes,',(re.data||[]).length,'resúmenes,',(ev.data||[]).length,'evoluciones');
      return true;
    }catch(e){console.warn('No se pudo cargar la capa clínica relacional:',e?.message||e);return false;}
    finally{cargando410=false;}
  }

  window.cardiolinkClinica410={version:VERSION_CLINICA_410,cargar:cargar410,sincronizarPacienteCompleto:sincronizarPacienteCompleto410};

  // Carga inicial: espera a que Supabase Auth haya terminado el login.
  let intentos=0;
  const timer=setInterval(async()=>{
    intentos++;
    if(listo410()){
      clearInterval(timer);
      await cargar410();
    }else if(intentos>60){clearInterval(timer);}
  },500);
})();


/* ===== CardioLink v4.1.0-hc · Fase 2: signos vitales + continuidad clínica ===== */
(function(){
  const s=document.createElement('style');
  s.id='cardiolink-hc-fase2-410';
  s.textContent=`
    .hc-vitals-section410,.hc-prev-evolutions410,.hc-last-vitals410{border:1px solid #d9e4e8;background:#f8fbfc;border-radius:14px;padding:14px;margin:14px 0}
    .hc-vitals-grid410{display:grid;grid-template-columns:repeat(4,minmax(120px,1fr));gap:10px}
    .hc-vitals-grid410 label{font-size:12px;font-weight:700;color:#334155}
    .hc-vitals-grid410 input{width:100%;margin-top:5px;box-sizing:border-box}
    .hc-vitals-grid410 input[readonly]{background:#eef4f6;font-weight:700}
    .hc-prev-head410{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}
    .hc-prev-head410 h3{margin:0}.hc-prev-head410 span{font-size:12px;color:#64748b}
    .hc-prev-evolutions410 article{display:grid;grid-template-columns:170px 1fr;gap:4px 12px;padding:9px 0;border-top:1px solid #e2e8f0}
    .hc-prev-evolutions410 article:first-of-type{border-top:0}
    .hc-prev-evolutions410 article span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .hc-prev-evolutions410 article small{grid-column:2;color:#475569}
    .hc-vitals-inline410{display:inline-block;margin:8px 0;padding:6px 9px;border-radius:9px;background:#eef6f8;color:#174b5c;font-size:12px;font-weight:700}
    .hc-last-vitals410{display:flex;flex-direction:column;gap:4px}.hc-last-vitals410 span{font-size:12px;color:#64748b}.hc-last-vitals410 strong{color:#174b5c}
    @media(max-width:900px){.hc-vitals-grid410{grid-template-columns:repeat(2,minmax(120px,1fr))}.hc-prev-evolutions410 article{grid-template-columns:1fr}.hc-prev-evolutions410 article small{grid-column:1}}
  `;
  document.head.appendChild(s);
})();


/* ===== CardioLink v4.1.0-hc · Fase 3A: continuidad clínica ===== */
(function(){
  if(document.getElementById('cardiolink-hc-fase3a-411'))return;
  const s=document.createElement('style');
  s.id='cardiolink-hc-fase3a-411';
  s.textContent=`
    .hc-prev-head410{align-items:flex-start}
    .hc-prev-head410>div:first-child{min-width:0}
    .hc-prev-actions411{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
    .hc-prev-evolutions410 article p{grid-column:1/-1;margin:4px 0 0;color:#475569;line-height:1.45}
    .hc-continue-panel411{margin-top:12px;padding:12px;border:1px solid #cbd5e1;border-radius:12px;background:#fff}
    .hc-continue-panel411.hidden{display:none}
    .hc-continue-options411{display:flex;gap:14px;flex-wrap:wrap;margin:10px 0}
    .hc-continue-options411 label{display:flex;gap:6px;align-items:center;font-size:13px;font-weight:700;color:#334155}
    .hc-continue-actions411{display:flex;gap:8px;justify-content:flex-end}
    .hc-event-compact411 .hc-event-head{align-items:flex-start}
    .hc-event-compact-line411{margin-top:6px;color:#174b5c;font-size:12px;font-weight:700;line-height:1.45}
    .hc-event-compact411 .hc-event-section{margin-top:8px}
    @media(max-width:760px){
      .hc-prev-head410{display:block}
      .hc-prev-actions411{justify-content:flex-start;margin-top:8px}
      .hc-continue-actions411{justify-content:stretch}.hc-continue-actions411 button{flex:1}
    }
  `;
  document.head.appendChild(s);
})();


/* ===== CardioLink v4.1.0-hc · Fase 3B: Paciente actual + comandos rápidos ===== */
(function(){
  'use strict';
  if(window.__cardiolinkPhase3B411B)return;
  window.__cardiolinkPhase3B411B=true;

  const STORAGE='cardiolink_paciente_actual_411b';
  let currentKey411B='';
  const $b=id=>document.getElementById(id);
  const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  function norm(s){return String(s||'').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');}
  function patients(){
    try{return typeof todosPacientes==='function'?todosPacientes():(window.data?.pacientes||[]);}catch(_){return window.data?.pacientes||[];}
  }
  function patientByKey(key){
    key=String(key||'');if(!key)return null;
    return patients().find(p=>{
      const ids=[p?.id,p?.dni,typeof clavePac320==='function'?clavePac320(p):'',typeof clavePacientePanel==='function'?clavePacientePanel(p):''].map(x=>String(x||''));
      return ids.includes(key);
    })||null;
  }
  function patientKey(p){
    if(!p)return '';
    try{if(typeof clavePac320==='function')return String(clavePac320(p)||'');}catch(_){}
    try{if(typeof clavePacientePanel==='function')return String(clavePacientePanel(p)||'');}catch(_){}
    return String(p.id||p.dni||'');
  }
  function patientName(p){return p?.nombreCompleto||p?.paciente||p?.nombre||'Paciente';}
  function role(){
    try{return norm(perfilUsuarioActual()?.rol||'');}catch(_){return '';}
  }
  function isSecretary(){return role().includes('secretaria');}
  function isMedical(){
    try{return (typeof esMedico==='function'&&esMedico())||(typeof esMatiasDuenio==='function'&&esMatiasDuenio())||(typeof esAdminComun==='function'&&esAdminComun());}catch(_){return false;}
  }

  function saveCurrent411B(key){
    currentKey411B=String(key||'');
    try{if(currentKey411B)sessionStorage.setItem(STORAGE,currentKey411B);else sessionStorage.removeItem(STORAGE);}catch(_){}
    renderCurrent411B();
  }
  function restoreCurrent411B(){
    try{const k=sessionStorage.getItem(STORAGE)||'';if(k&&patientByKey(k))currentKey411B=k;}catch(_){}
  }
  function getCurrent411B(){
    let p=patientByKey(currentKey411B);
    if(p)return p;
    try{
      const selected=(typeof pacienteSeleccionadoPanelId!=='undefined'?pacienteSeleccionadoPanelId:'')||'';
      if(selected){p=patientByKey(String(selected));if(p){currentKey411B=patientKey(p);try{sessionStorage.setItem(STORAGE,currentKey411B);}catch(_){}return p;}}
    }catch(_){}
    try{
      const modal=document.getElementById('pacienteGlobalModal');
      const title=document.getElementById('pacienteGlobalTitulo')?.textContent?.trim()||'';
      if(modal&&!modal.classList.contains('hidden')&&title){
        p=patients().find(x=>patientName(x).trim()===title);
        if(p){currentKey411B=patientKey(p);try{sessionStorage.setItem(STORAGE,currentKey411B);}catch(_){}return p;}
      }
    }catch(_){}
    return null;
  }

  function ensureUI411B(){
    const top=document.querySelector('.topbar');
    if(!top)return;
    if(!$b('currentPatient411B')){
      const bar=document.createElement('div');
      bar.id='currentPatient411B';
      bar.className='current-patient411b hidden';
      bar.innerHTML=`<button class="current-patient-main411b" type="button" data-cp-action411b="open"><span class="cp-label411b">Paciente actual</span><strong data-cp-name411b></strong><small data-cp-meta411b></small></button>
        <button class="cp-quick411b" type="button" data-cp-action411b="hc" title="Historia clínica">HC</button>
        <button class="cp-quick411b" type="button" data-cp-action411b="evolve" title="Nueva evolución">Evolucionar</button>
        <button class="cp-more411b" type="button" data-cp-toggle411b>Acciones ▾</button>
        <button class="cp-clear411b" type="button" data-cp-action411b="clear" title="Quitar paciente actual" aria-label="Quitar paciente actual">×</button>
        <div class="cp-menu411b hidden" id="cpMenu411B"></div>`;
      top.appendChild(bar);
    }
    if(!$b('globalQuick411B')){
      const q=document.createElement('button');
      q.id='globalQuick411B';q.className='global-quick411b';q.type='button';q.textContent='+';q.title='Comandos rápidos';q.setAttribute('aria-label','Comandos rápidos');
      document.body.appendChild(q);
      const menu=document.createElement('div');menu.id='globalQuickMenu411B';menu.className='global-quick-menu411b hidden';document.body.appendChild(menu);
    }
  }

  function patientActionsHtml411B(p){
    if(!p)return '';
    const medical=isMedical();
    const common=[
      ['attention','Nueva atención'],
      ['rcta','RCTA'],
      ['constancia','Constancia']
    ];
    if(medical){
      common.splice(1,0,['evolve','Nueva evolución']);
      common.splice(3,0,['order','Orden médica'],['certificate','Certificado']);
      common.push(['whatsapp','WhatsApp']);
    }else{
      common.push(['whatsapp','WhatsApp']);
    }
    return common.map(([a,l])=>`<button type="button" data-cp-action411b="${a}">${l}</button>`).join('');
  }
  function resolveActionPatient411B(){
    let p=getCurrent411B();if(p)return p;
    try{
      const bar=$b('currentPatient411B');
      const k=bar?.dataset?.patientKey411b||'';
      if(k){p=patientByKey(k);if(p)return p;}
      const name=(bar?.querySelector?.('[data-cp-name411b]')?.textContent||'').trim();
      const dni=(bar?.querySelector?.('[data-cp-meta411b]')?.textContent||'').replace(/\D/g,'');
      if(name||dni){
        p=patients().find(x=>(dni&&String(x.dni||'').replace(/\D/g,'')===dni)||(name&&patientName(x).trim()===name));
        if(p){saveCurrent411B(patientKey(p));return p;}
      }
    }catch(_){}
    try{
      const selected=String(typeof pacienteSeleccionadoPanelId!=='undefined'?(pacienteSeleccionadoPanelId||''):'');
      if(selected){p=patientByKey(selected);if(p){saveCurrent411B(patientKey(p));return p;}}
    }catch(_){}
    return null;
  }
  function globalActionsHtml411B(){
    const p=resolveActionPatient411B(),secretary=isSecretary();
    let arr=[];
    if(secretary){
      arr=[['newpatient','Nuevo paciente'],['attention','Nuevo turno / atención'],['rcta','RCTA'],['certificate','Certificado'],['constancia','Constancia de atención'],['search','Buscar paciente']];
    }else{
      arr=[['newpatient','Nuevo paciente'],['attention','Nueva atención'],['evolve','Nueva evolución'],['rcta','RCTA'],['order','Orden médica'],['certificate','Certificado'],['constancia','Constancia'],['search','Buscar paciente']];
    }
    return `<div class="gq-title411b">${p?`Paciente: ${esc(patientName(p))}`:'Comandos rápidos'}</div>`+
      arr.map(([a,l])=>`<button type="button" data-cp-action411b="${a}">${l}</button>`).join('');
  }
  function renderCurrent411B(){
    ensureUI411B();
    const p=getCurrent411B(),bar=$b('currentPatient411B');
    if(!bar)return;
    if(!p){bar.classList.add('hidden');}
    else{
      bar.classList.remove('hidden');
      bar.dataset.patientKey411b=patientKey(p);
      bar.querySelector('[data-cp-name411b]').textContent=patientName(p);
      bar.querySelector('[data-cp-meta411b]').textContent=`DNI ${p.dni||'s/d'}`;
      const ev=bar.querySelector('[data-cp-action411b="evolve"]');if(ev)ev.classList.toggle('hidden',!isMedical());
      const menu=$b('cpMenu411B');if(menu)menu.innerHTML=patientActionsHtml411B(p);
    }
    const gm=$b('globalQuickMenu411B');if(gm)gm.innerHTML=globalActionsHtml411B();
  }

  function focusGlobalSearch411B(){
    const candidates=['buscadorGlobal360','globalPatientSearch','pacientesBuscar','hcBuscarPaciente'];
    for(const id of candidates){
      const el=$b(id);if(el){try{el.focus();el.select?.();}catch(_){}return true;}
    }
    try{showSection('pacientes');setTimeout(()=>$b('pacientesBuscar')?.focus(),80);return true;}catch(_){return false;}
  }
  function newPatient411B(){
    try{showSection('carga');if(typeof nuevoPacienteManual==='function')nuevoPacienteManual();setTimeout(()=>{$b('paciente')?.focus();},80);}catch(e){console.error(e);}
  }
  function openPatient411B(p){
    if(!p)return;
    const k=patientKey(p);saveCurrent411B(k);
    if(typeof window.abrirPacienteGlobal320==='function'){window.abrirPacienteGlobal320(k);return;}
    try{showSection('pacientes');setTimeout(()=>window.seleccionarPacientePanel?.(k),60);}catch(_){}
  }
  function openHC411B(p){
    if(!p)return;const k=patientKey(p);saveCurrent411B(k);
    try{
      showSection('hc');
      const fake=document.createElement('button');fake.dataset.openHc=k;fake.style.display='none';document.body.appendChild(fake);fake.click();fake.remove();
    }catch(e){console.error('No se pudo abrir HC',e);}
  }
  function evolve411B(p){
    if(!p)return;if(!isMedical()){alert('La evolución clínica requiere perfil médico.');return;}
    const k=patientKey(p);saveCurrent411B(k);
    if(typeof window.abrirNuevaEvolucionHC==='function')window.abrirNuevaEvolucionHC(k);
  }
  function attention411B(p){
    if(p){const k=patientKey(p);saveCurrent411B(k);try{nuevaAtencionDesdePaciente(k);return;}catch(_){}}
    try{showSection('carga');}catch(_){}
  }
  function rcta411B(p){
    if(!p)return;const k=patientKey(p);saveCurrent411B(k);
    if(window.CardioLinkRCTA4095?.open)window.CardioLinkRCTA4095.open(k);else alert('RCTA todavía no está disponible en esta pantalla.');
  }
  function doc411B(p,type){
    if(!p)return;const k=patientKey(p);saveCurrent411B(k);
    if(isSecretary()&&['certificado','constancia_atencion'].includes(type)){
      if(typeof window.openClinicalDocumentTyped406==='function'){window.openClinicalDocumentTyped406(k,type);return;}
    }
    if(!isMedical()){alert('Este documento requiere un perfil médico o Secretaría habilitada.');return;}
    if(typeof window.openClinicalDocumentTyped406==='function')window.openClinicalDocumentTyped406(k,type);
    else if(typeof window.openClinicalDocument406==='function')window.openClinicalDocument406(k);
  }
  function printConstancia411B(p){
    const ats=(typeof atencionesPacienteGlobal==='function'?atencionesPacienteGlobal(p):[]).filter(a=>a&&!String(a.tipoRegistro||'').includes('mensaje'));
    const a=ats[0]||null;
    const fecha=a?.fecha?(typeof formatFecha==='function'?formatFecha(a.fecha):a.fecha):new Date().toLocaleDateString('es-AR');
    const prest=a?.prestacion||'atención';

    const profesionales=(window.data?.profesionales||[]);
    let pr=profesionales.find(x=>String(x.id||'')===String(a?.profesionalId||''));
    if(!pr&&a?.profesional)pr=profesionales.find(x=>String(x.nombre||'').trim()===String(a.profesional||'').trim());
    if(!pr)pr=profesionales.find(x=>x.id==='matias')||profesionales.find(x=>x.id!=='general')||{};

    let logo=pr.logoDocumentoData||pr.logoDocumento||'icons/icon-192.png';
    try{if(logo&&!/^data:image\//i.test(logo)&&!/^https?:/i.test(logo)&&!/^blob:/i.test(logo))logo=new URL(logo,location.href).href;}catch(e){}

    const marca=pr.marcaDocumento||'CardioLink';
    const medico=pr.nombre||a?.profesional||'Profesional';
    const especialidades=(()=>{
      const ids=Array.isArray(pr.especialidadIds)?pr.especialidadIds:[];
      const names=ids.map(id=>(window.data?.especialidades||[]).find(e=>e.id===id)?.nombre).filter(Boolean);
      return names.length?names.join(' · '):(pr.area||pr.especialidad||'');
    })();
    const matriculas=[pr.matriculaNacional,pr.matriculaProvincial].filter(Boolean).join(' · ');
    const contacto=[pr.direccionDocumento,pr.telefonoDocumento,pr.emailDocumento].filter(Boolean).join(' · ');
    const color=/^#[0-9a-f]{6}$/i.test(pr.colorDocumento||'')?pr.colorDocumento:'#174b5c';

    const w=window.open('','_blank');if(!w){alert('El navegador bloqueó la constancia.');return;}
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Constancia de atención</title><style>
      @page{size:A4;margin:18mm 16mm 20mm}*{box-sizing:border-box}
      body{font-family:Arial,Helvetica,sans-serif;color:#111827;margin:0;font-size:14px;line-height:1.55}
      .head{display:grid;grid-template-columns:78px 1fr;gap:16px;align-items:center;border-bottom:3px solid ${color};padding-bottom:12px;margin-bottom:28px}
      .logo{width:74px;height:74px;object-fit:contain}.brand{font-size:23px;font-weight:800;color:${color}}
      .doctor{font-size:17px;font-weight:800;margin-top:2px}.meta{color:#475569;line-height:1.45}
      .title{text-align:center;text-transform:uppercase;letter-spacing:.07em;color:${color};font-size:20px;margin:26px 0 24px}
      .patient{border:1px solid #cbd5e1;border-radius:11px;padding:12px 14px;margin-bottom:28px;background:#f8fafc}
      .patient strong{font-size:18px}.body{font-size:17px;min-height:300px;line-height:1.7}
      .sig{margin-top:72px;width:310px;margin-left:auto;text-align:center;border-top:1px solid #334155;padding-top:7px;font-weight:700}
      .sig small{display:block;color:#475569;font-weight:400;line-height:1.4}
      .footer{position:fixed;bottom:0;left:0;right:0;border-top:1px solid #cbd5e1;padding-top:6px;color:#64748b;font-size:9px;display:flex;justify-content:space-between;gap:12px}
    </style></head><body>
      <header class="head">${logo?`<img class="logo" src="${esc(logo)}">`:''}<div><div class="brand">${esc(marca)}</div><div class="doctor">${esc(medico)}</div>${especialidades?`<div class="meta">${esc(especialidades)}</div>`:''}${matriculas?`<div class="meta">${esc(matriculas)}</div>`:''}${contacto?`<div class="meta">${esc(contacto)}</div>`:''}</div></header>
      <h1 class="title">Constancia de atención</h1>
      <section class="patient"><strong>${esc(patientName(p))}</strong><div class="meta">DNI ${esc(p.dni||'s/d')} · Fecha de atención: ${esc(fecha)}</div></section>
      <main class="body">Se deja constancia de que <strong>${esc(patientName(p))}</strong>, DNI <strong>${esc(p.dni||'s/d')}</strong>, fue atendido/a en este consultorio el día <strong>${esc(fecha)}</strong>${a?` por <strong>${esc(medico)}</strong>, por ${esc(prest)}`:''}.<br><br>Se extiende la presente a solicitud del interesado/a.</main>
      <section class="sig">${esc(medico)}${especialidades?`<small>${esc(especialidades)}</small>`:''}${matriculas?`<small>${esc(matriculas)}</small>`:''}</section>
      <footer class="footer"><span>${esc(marca)}</span><span>Constancia emitida administrativamente desde CardioLink</span></footer>
      <script>window.onload=()=>setTimeout(()=>window.print(),250)<\/script>
    </body></html>`);
    w.document.close();
  }
  function whatsapp411B(p){
    if(!p)return;let digits=String(p.telefono||'').replace(/\D/g,'');if(!digits){alert('El paciente no tiene teléfono cargado.');return;}
    if(digits.startsWith('0'))digits=digits.replace(/^0+/,'');
    if(!digits.startsWith('54')&&digits.length>=10)digits='54'+digits;
    window.open(`https://wa.me/${digits}`,'_blank','noopener');
  }

  function runAction411B(action){
    const p=resolveActionPatient411B();
    if(action==='clear')return saveCurrent411B('');
    if(action==='newpatient')return newPatient411B();
    if(action==='search')return focusGlobalSearch411B();
    if(!p&&['evolve','rcta','order','certificate','constancia'].includes(action)){
      try{showSection('pacientes');setTimeout(()=>$b('pacientesBuscar')?.focus(),80);}catch(_){}
      alert('Primero seleccioná un paciente. Te llevo al buscador de Pacientes.');
      return;
    }
    if(action==='open')return openPatient411B(p);
    if(action==='hc')return openHC411B(p);
    if(action==='evolve')return evolve411B(p);
    if(action==='attention')return attention411B(p);
    if(action==='rcta')return rcta411B(p);
    if(action==='order')return doc411B(p,'orden');
    if(action==='certificate')return doc411B(p,'certificado');
    if(action==='constancia')return doc411B(p,'constancia_atencion');
    if(action==='whatsapp')return whatsapp411B(p);
  }

  function wrapPatientFunctions411B(){
    const wrap=(name)=>{
      const old=window[name];if(typeof old!=='function'||old.__cp411b)return;
      const fn=function(key){if(key)saveCurrent411B(String(key));return old.apply(this,arguments);};
      fn.__cp411b=true;window[name]=fn;
      try{if(name==='abrirPacienteGlobalDetalle350')abrirPacienteGlobalDetalle350=fn;}catch(_){}
    };
    wrap('abrirPacienteGlobal320');wrap('abrirPacienteGlobalDetalle350');

    const oldEv=window.abrirNuevaEvolucionHC;
    if(typeof oldEv==='function'&&!oldEv.__cp411b){
      const fn=function(key){if(key)saveCurrent411B(String(key));return oldEv.apply(this,arguments);};fn.__cp411b=true;window.abrirNuevaEvolucionHC=fn;
    }
    const oldSel=window.seleccionarPacientePanel;
    if(typeof oldSel==='function'&&!oldSel.__cp411b){
      const fn=function(key){if(key)saveCurrent411B(String(key));return oldSel.apply(this,arguments);};fn.__cp411b=true;window.seleccionarPacientePanel=fn;try{seleccionarPacientePanel=fn;}catch(_){}
    }
  }

  document.addEventListener('click',e=>{
    const a=e.target.closest?.('[data-cp-action411b]');
    if(a){e.preventDefault();runAction411B(a.dataset.cpAction411b);$b('cpMenu411B')?.classList.add('hidden');$b('globalQuickMenu411B')?.classList.add('hidden');return;}
    const toggle=e.target.closest?.('[data-cp-toggle411b]');
    if(toggle){e.preventDefault();$b('cpMenu411B')?.classList.toggle('hidden');return;}
    if(e.target.closest?.('#globalQuick411B')){e.preventDefault();resolveActionPatient411B();renderCurrent411B();$b('globalQuickMenu411B')?.classList.toggle('hidden');return;}
    if(!e.target.closest?.('#currentPatient411B')&&!e.target.closest?.('#globalQuickMenu411B')){$b('cpMenu411B')?.classList.add('hidden');$b('globalQuickMenu411B')?.classList.add('hidden');}
    const patientTarget=e.target.closest?.('[data-hc-patient],[data-hc-new],[data-open-hc],[data-patient-open4091],[data-rcta-patient4095]');
    if(patientTarget){
      const raw=patientTarget.dataset.hcPatient||patientTarget.dataset.hcNew||patientTarget.dataset.openHc||patientTarget.dataset.rctaPatient4095||'';
      if(raw)saveCurrent411B(raw);
    }
  },true);

  function boot411B(){
    ensureUI411B();restoreCurrent411B();wrapPatientFunctions411B();renderCurrent411B();
    setTimeout(()=>{wrapPatientFunctions411B();renderCurrent411B();},700);
    setTimeout(()=>{wrapPatientFunctions411B();renderCurrent411B();},1800);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot411B);else boot411B();

  window.CardioLinkPacienteActual411B={set:saveCurrent411B,get:()=>getCurrent411B(),clear:()=>saveCurrent411B(''),render:renderCurrent411B};
})();

/* ===== Estilos Fase 3B ===== */
(function(){
  if(document.getElementById('cardiolink-phase3b-style411b'))return;
  const s=document.createElement('style');s.id='cardiolink-phase3b-style411b';
  s.textContent=`
    .current-patient411b{position:fixed;left:50%;top:16px;transform:translateX(-50%);display:flex;align-items:center;gap:7px;min-width:0;z-index:12050;padding:6px;border:1px solid #9fb8c2;border-radius:16px;background:rgba(243,249,250,.97);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);box-shadow:0 10px 28px rgba(23,75,92,.18)}
    .current-patient411b.hidden{display:none}

    .topbar{position:relative}
    .hc-event-actions411b1{display:flex;align-items:center;gap:7px;flex-wrap:wrap;justify-content:flex-end}
    .hc-delete411b1{color:#991b1b!important;border-color:#fecaca!important;background:#fff7f7!important}
    .hc-delete411b1:hover{background:#fee2e2!important}
    .current-patient-main411b{display:flex;flex-direction:column;align-items:flex-start;min-width:230px;max-width:330px;padding:8px 12px;border:0;border-radius:11px;background:transparent;color:#0f172a;cursor:pointer}
    .cp-label411b{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#64748b;font-weight:800}
    .current-patient-main411b strong{font-size:15px;max-width:300px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#174b5c}
    .current-patient-main411b small{font-size:10px;color:#64748b}
    .cp-quick411b,.cp-more411b,.cp-clear411b{border:1px solid #cbd5e1;background:#fff;color:#174b5c;border-radius:10px;padding:9px 10px;font-weight:800;cursor:pointer}.cp-clear411b{width:36px;height:36px;padding:0;font-size:21px;color:#64748b}.cp-clear411b:hover{background:#fee2e2;color:#991b1b;border-color:#fecaca}
    .cp-quick411b.hidden{display:none}
    .cp-more411b{background:#174b5c;color:white;border-color:#174b5c}
    .cp-menu411b{position:absolute;right:0;top:calc(100% + 8px);min-width:210px;padding:8px;background:#fff;border:1px solid #cbd5e1;border-radius:14px;box-shadow:0 18px 45px rgba(15,23,42,.18);z-index:10050;display:grid;gap:4px}
    .cp-menu411b.hidden,.global-quick-menu411b.hidden{display:none}
    .cp-menu411b button,.global-quick-menu411b button{width:100%;text-align:left;border:0;background:transparent;border-radius:9px;padding:10px 12px;font-weight:750;color:#0f172a;cursor:pointer}
    .cp-menu411b button:hover,.global-quick-menu411b button:hover{background:#eef6f8;color:#174b5c}
    .global-quick411b{position:fixed;right:22px;bottom:92px;width:54px;height:54px;border:0;border-radius:50%;background:#174b5c;color:white;font-size:32px;line-height:1;box-shadow:0 14px 30px rgba(15,23,42,.28);z-index:10020;cursor:pointer}
    .global-quick-menu411b{position:fixed;right:22px;bottom:156px;width:240px;padding:9px;background:#fff;border:1px solid #cbd5e1;border-radius:15px;box-shadow:0 18px 45px rgba(15,23,42,.22);z-index:10021;display:grid;gap:3px}
    .global-quick-menu411b button:disabled{opacity:.42;cursor:not-allowed}
    .gq-title411b{padding:8px 10px 6px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#64748b;font-weight:800;border-bottom:1px solid #e2e8f0;margin-bottom:3px}
    @media(max-width:1180px){.current-patient411b{left:50%;top:12px;bottom:auto;transform:translateX(-50%);max-width:calc(100vw - 24px)}.current-patient-main411b{min-width:180px}.global-quick411b{right:16px;bottom:92px}.global-quick-menu411b{right:16px;bottom:154px}}
  `;
  document.head.appendChild(s);
})();


/* ===== CardioLink v4.1.0-hc · Fase 3C: cierre operativo ===== */
(function(){
  'use strict';if(window.__cardiolinkPhase3C411C)return;window.__cardiolinkPhase3C411C=true;
  window.verPendientesVencidos411C=function(){try{const welcome=document.getElementById('welcomeModal360');if(welcome)welcome.classList.add('hidden');if(typeof showSection==='function')showSection('pendientes383');if(typeof window.mostrarPendientesVencidos383==='function')window.mostrarPendientesVencidos383();}catch(e){console.error(e);alert('No se pudo abrir la bandeja de pendientes vencidos.');}};
  function pendientesPerfil411C(){let base=[];try{base=typeof atencionesPerfil==='function'?atencionesPerfil():(Array.isArray(atenciones)?atenciones:[]);}catch(e){base=[];}return (base||[]).filter(a=>{try{return typeof window.pendientesDeAtencion383==='function'&&window.pendientesDeAtencion383(a).length>0;}catch(e){return false;}});}
  function actualizarBadgePendientes411C(){const list=pendientesPerfil411C();const overdue=list.filter(a=>{const d=diasAntiguedadPendiente411C(a);return d!=null&&d>7;});const critical=list.filter(a=>{const d=diasAntiguedadPendiente411C(a);return d!=null&&d>14;});const btn=document.querySelector('.nav[data-section="pendientes383"]');if(btn){btn.title=`${list.length} pendientes · ${overdue.length} vencidos >7 días · ${critical.length} críticos >14 días`;btn.classList.toggle('has-critical-411c',critical.length>0);}}
  const oldRenderStats=typeof renderStats==='function'?renderStats:null;if(oldRenderStats&&!oldRenderStats.__phase3c411c){const wrapped=function(){const r=oldRenderStats.apply(this,arguments);setTimeout(actualizarBadgePendientes411C,0);return r;};wrapped.__phase3c411c=true;try{window.renderStats=renderStats=wrapped;}catch(e){window.renderStats=wrapped;}}
  function asegurarBotonVencidos411C(){if(document.getElementById('btnVerVencidos411C'))return;const anchor=document.getElementById('btnPendientesGlobal')||document.getElementById('btnVerPendientesSolapa');if(!anchor)return;const b=document.createElement('button');b.id='btnVerVencidos411C';b.type='button';b.className='secondary pending-overdue-btn411c';b.textContent='Vencidos >7 días';b.addEventListener('click',window.verPendientesVencidos411C);anchor.insertAdjacentElement('afterend',b);}
  function boot411C(){actualizarBadgePendientes411C();asegurarBotonVencidos411C();setTimeout(()=>{actualizarBadgePendientes411C();asegurarBotonVencidos411C();},800);setTimeout(()=>{actualizarBadgePendientes411C();asegurarBotonVencidos411C();},2200);}if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot411C);else boot411C();
})();
(function(){if(document.getElementById('cardiolink-phase3c-style411c'))return;const s=document.createElement('style');s.id='cardiolink-phase3c-style411c';s.textContent=`.pending-age-411c{margin-left:5px!important;font-weight:800!important}.pending-age-411c.delayed{background:#fff7ed!important;color:#9a3412!important;border:1px solid #fed7aa!important}.pending-age-411c.overdue{background:#fee2e2!important;color:#991b1b!important;border:1px solid #fecaca!important}.pending-age-411c.critical{background:#7f1d1d!important;color:#fff!important;border:1px solid #7f1d1d!important}.pending-overdue-411c{background:#fff7ed!important;border-color:#fdba74!important}.pending-overdue-411c strong{color:#c2410c!important}.pending-critical-411c{background:#fef2f2!important;border-color:#fca5a5!important}.pending-critical-411c strong{color:#b91c1c!important}.welcome-pending-action411c{grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;gap:14px;margin-top:10px;padding:12px 14px;border:1px solid #fecaca;border-radius:13px;background:#fff7f7;color:#7f1d1d}.welcome-pending-action411c button{border:0;border-radius:10px;background:#b91c1c;color:#fff;padding:9px 13px;font-weight:800;cursor:pointer}.nav.has-critical-411c{box-shadow:inset 3px 0 0 #dc2626}.pending-overdue-btn411c{border-color:#fed7aa!important;color:#9a3412!important}@media(max-width:720px){.welcome-pending-action411c{display:block}.welcome-pending-action411c button{margin-top:9px;width:100%}}`;document.head.appendChild(s);})();


/* ===== CardioLink v4.1.0-hc · Fase 3C AMPLIADA ===== */
(function(){
  'use strict';
  if(window.__cardiolinkPhase3CAmpliada411C)return;
  window.__cardiolinkPhase3CAmpliada411C=true;

  const $c=id=>document.getElementById(id);
  const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const money411=n=>typeof money==='function'?money(Number(n||0)):'$ '+Number(n||0).toLocaleString('es-AR');
  const norm=s=>String(s||'').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const estado411=a=>String(a?.estadoTurno||a?.estado||'').toLowerCase();

  function patientForAttention411C(a){
    if(!a)return null;
    try{
      const list=typeof todosPacientes==='function'?todosPacientes():(data?.pacientes||[]);
      const dni=String(a.dni||'').replace(/\D/g,'');
      return list.find(p=>String(p.id||'')===String(a.pacienteId||'')) ||
        (dni?list.find(p=>String(p.dni||'').replace(/\D/g,'')===dni):null) ||
        list.find(p=>norm(p.nombreCompleto||p.paciente||'')===norm(a.paciente||'')) || null;
    }catch(e){return null;}
  }

  window.abrirFichaPacienteDesdePendiente411C=function(id){
    const a=(atenciones||[]).find(x=>String(x.id)===String(id));
    if(!a)return;
    const p=patientForAttention411C(a);
    if(!p){alert('No encontré la ficha del paciente asociada a este pendiente.');return;}
    const key=(typeof clavePacientePanel==='function'?clavePacientePanel(p):(p.id||p.dni||''));
    try{
      if(window.CardioLinkPacienteActual411B?.set)window.CardioLinkPacienteActual411B.set(key);
      if(typeof window.abrirPacienteGlobal320==='function'){window.abrirPacienteGlobal320(key);return;}
      if(typeof showSection==='function')showSection('pacientes');
      if(typeof seleccionarPacientePanel==='function')seleccionarPacientePanel(key);
    }catch(e){console.error(e);alert('No se pudo abrir la ficha del paciente.');}
  };

  async function copy411C(txt){
    const v=String(txt||'');
    try{await navigator.clipboard.writeText(v);}
    catch(e){
      const t=document.createElement('textarea');t.value=v;document.body.appendChild(t);t.select();document.execCommand('copy');t.remove();
    }
  }
  window.copiarDatoPacienteEdit411C=async function(tipo){
    const vals={
      dni:$c('pacEditDni')?.value||'',
      telefono:$c('pacEditTelefono')?.value||'',
      email:$c('pacEditEmail')?.value||''
    };
    let txt='';
    if(tipo==='dni')txt=vals.dni;
    else if(tipo==='telefono')txt=vals.telefono;
    else if(tipo==='email')txt=vals.email;
    else txt=[`DNI: ${vals.dni||'s/d'}`,`Teléfono: ${vals.telefono||'s/d'}`,`Email: ${vals.email||'s/d'}`].join('\n');
    await copy411C(txt);
  };

  // ---------- HC: buscador protagonista + integración genérica plegable ----------
  function ajustarHcVisual411C(){
    const search=$c('hcBuscarPaciente');
    if(search){
      const host=search.closest('.card,.panel,.hc-search-card,.hc-search-wrap')||search.parentElement;
      host?.classList.add('hc-search-emphasis411c');
      search.placeholder='Buscar paciente por apellido, DNI, teléfono o email';
    }
    const headings=[...document.querySelectorAll('#hc h1,#hc h2,#hc h3,#hc h4,.section h2,.section h3')];
    const h=headings.find(x=>/integraciones clinicas|integración clínica|integraciones clínicas|medicloud/i.test(x.textContent||''));
    if(h){
      h.textContent='Vinculación con otra app';
      const host=h.closest('.card,.panel,section,div');
      if(host&&!host.classList.contains('integration-collapsible411c')){
        host.classList.add('integration-collapsible411c','collapsed411c');
        h.classList.add('integration-title411c');
        h.title='Mostrar / ocultar vinculación con otra app';
        h.addEventListener('click',()=>host.classList.toggle('collapsed411c'));
      }
    }
    document.querySelectorAll('#hc button,#hc p,#hc label,#hc small').forEach(el=>{
      if(/medicloud/i.test(el.textContent||''))el.textContent=(el.textContent||'').replace(/Medicloud/gi,'otra app');
    });
  }

  // ---------- Seña en ausentes / cancelados ----------
  function preguntarSenia411C(a,estado){
    const etiqueta=estado==='ausente'?'ausente':'cancelado';
    const pago=confirm(`Turno ${etiqueta}. ¿El paciente pagó una seña?`);
    if(!pago){
      a.seniaPagada=false;a.seniaMonto=0;a.seniaFormaPago='';a.seniaRegistradaEn=new Date().toISOString();
      return;
    }
    const raw=prompt('Monto de la seña:',String(a.seniaMonto||''));
    if(raw===null)return;
    const monto=Number(String(raw).replace(/\./g,'').replace(',','.'));
    if(!Number.isFinite(monto)||monto<0){alert('Monto inválido.');return;}
    const forma=(prompt('Medio de pago: Efectivo / Transferencia / Débito',a.seniaFormaPago||'Efectivo')||'Efectivo').trim();
    a.seniaPagada=true;a.seniaMonto=monto;a.seniaFormaPago=forma;a.seniaRegistradaEn=new Date().toISOString();
  }

  const oldCambiarEstado411C=window.cambiarEstadoAgenda;
  if(typeof oldCambiarEstado411C==='function'&&!oldCambiarEstado411C.__senia411c){
    const wrapped=function(id,estado){
      const a=(atenciones||[]).find(x=>String(x.id)===String(id));
      if(a&&['ausente','cancelado'].includes(String(estado))){
        preguntarSenia411C(a,String(estado));
      }
      const r=oldCambiarEstado411C.apply(this,arguments);
      try{window.renderPendientes383?.();renderStats?.();}catch(e){}
      return r;
    };
    wrapped.__senia411c=true;
    window.cambiarEstadoAgenda=cambiarEstadoAgenda=wrapped;
  }

  // Caja diaria: ausentes/cancelados no cuentan como prestación cobrada; solo su seña.
  const oldCajaHoy411C=window.cajaHoy||((typeof cajaHoy==='function')?cajaHoy:null);
  window.cajaHoy=cajaHoy=function(datos=atencionesOperativas()){
    const perfil=typeof perfilObj==='function'?perfilObj():{id:'general'};
    if(perfil.id==='general')return {particular:0,copago:0,total:0};
    return (datos||[]).filter(a=>(a.cajaPerfil||a.profesionalId)===perfil.id).filter(a=>a.fecha===todayISO()).reduce((r,a)=>{
      if(['ausente','cancelado'].includes(estado411(a))){
        const s=Number(a.seniaMonto||0);r.particular+=s;r.total+=s;return r;
      }
      const part=Number(a.montoConsulta||0)+Number(a.montoEstudio||0),cop=Number(a.montoCopago||0);
      r.particular+=part;r.copago+=cop;r.total+=part+cop;return r;
    },{particular:0,copago:0,total:0});
  };

  // ---------- Estadística específica cancelados/ausentes ----------
  function inyectarAusentismo411C(){
    const sec=$c('estadisticas');if(!sec||$c('ausentismo411C'))return;
    const box=document.createElement('div');box.id='ausentismo411C';box.className='card stats-ausentismo411c';
    box.innerHTML=`<h3>Cancelaciones y ausentismo</h3><p class="muted">No se incluyen en la producción general. Se miden por separado.</p><div id="ausentismoResultado411C"></div>`;
    sec.appendChild(box);
  }
  function renderAusentismo411C(){
    const out=$c('ausentismoResultado411C');if(!out)return;
    const desde=$c('statsDesde')?.value||'',hasta=$c('statsHasta')?.value||'',prof=$c('statsProfesional')?.value||'';
    const list=(atenciones||[]).filter(a=>(!desde||a.fecha>=desde)&&(!hasta||a.fecha<=hasta)&&(!prof||a.profesionalId===prof));
    const aus=list.filter(a=>estado411(a)==='ausente'),can=list.filter(a=>estado411(a)==='cancelado'),total=list.length;
    const senias=[...aus,...can].reduce((s,a)=>s+Number(a.seniaMonto||0),0);
    const pct=n=>total?Math.round(n*1000/total)/10:0;
    out.innerHTML=`<div class="finance-kpis411c"><div><span>Ausentes</span><strong>${aus.length}</strong><small>${pct(aus.length)}%</small></div><div><span>Cancelados</span><strong>${can.length}</strong><small>${pct(can.length)}%</small></div><div><span>Señas cobradas</span><strong>${money411(senias)}</strong></div></div>`;
  }
  const oldRenderEst411C=window.renderEstadisticas;
  if(typeof oldRenderEst411C==='function'&&!oldRenderEst411C.__ausentismo411c){
    const w=function(){const r=oldRenderEst411C.apply(this,arguments);inyectarAusentismo411C();renderAusentismo411C();return r;};
    w.__ausentismo411c=true;window.renderEstadisticas=renderEstadisticas=w;
  }

  // ---------- Finanzas ----------
  function ensureMov411C(){
    if(!data.movimientosFinancieros411C||!Array.isArray(data.movimientosFinancieros411C))data.movimientosFinancieros411C=[];
  }
  function saveMov411C(){
    ensureMov411C();saveConfig();
    try{window.guardarConfigEnSupabase298?.();}catch(e){}
  }
  function month411C(){
    const d=new Date(),y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0');
    return {desde:`${y}-${m}-01`,hasta:todayISO()};
  }
  function injectFinance411C(){
    const permitido=(()=>{try{return !!(esMatiasDuenio?.()||esAdminComun?.());}catch(e){return false;}})();
    const sec=$c('caja');if(!permitido){$c('finanzas411C')?.remove();return;}if(!sec||$c('finanzas411C'))return;
    const p=month411C();
    const profOpts=(data.profesionales||[]).filter(x=>x.id!=='general').map(x=>`<option value="${esc(x.id)}">${esc(x.nombre)}</option>`).join('');
    const box=document.createElement('section');box.id='finanzas411C';box.className='card finance411c';
    box.innerHTML=`<div class="finance-head411c"><div><h2>Informe financiero</h2><p class="muted">Ingresos y egresos por período. Los aranceles de OS/prepagas se toman de los convenios configurados.</p></div></div>
      <div class="finance-filters411c"><label>Desde<input id="finDesde411C" type="date" value="${p.desde}"></label><label>Hasta<input id="finHasta411C" type="date" value="${p.hasta}"></label><label>Perfil<select id="finPerfil411C"><option value="">Todos</option>${profOpts}</select></label><button id="finCalcular411C" class="primary" type="button">Calcular informe</button></div>
      <details class="finance-mov411c"><summary>Registrar egreso / movimiento</summary><div class="finance-mov-grid411c"><label>Fecha<input id="movFecha411C" type="date" value="${todayISO()}"></label><label>Categoría<select id="movCategoria411C"><option>Otros egresos</option><option>Otro movimiento</option></select></label><label>Concepto<input id="movConcepto411C" placeholder="Ej. sueldo agosto"></label><label>Monto<input id="movMonto411C" type="number" min="0" step="0.01"></label><label>Medio<select id="movMedio411C"><option>Efectivo</option><option>Transferencia</option><option>Débito</option><option>Otro</option></select></label><label>Perfil<select id="movPerfil411C"><option value="">General</option>${profOpts}</select></label></div><div class="modal-actions"><button id="movGuardar411C" class="primary" type="button">Guardar egreso</button></div></details>
      <div id="finResultado411C" class="finance-result411c"><p class="muted">Elegí período y presioná Calcular informe.</p></div>`;
    sec.appendChild(box);
    $c('finCalcular411C')?.addEventListener('click',renderFinance411C);
    $c('movGuardar411C')?.addEventListener('click',()=>{
      const monto=Number($c('movMonto411C')?.value||0);if(!(monto>0)){alert('Ingresá un monto válido.');return;}
      ensureMov411C();
      data.movimientosFinancieros411C.push({id:'mov_'+Date.now(),fecha:$c('movFecha411C')?.value||todayISO(),tipo:'egreso',categoria:$c('movCategoria411C')?.value||'Otros egresos',concepto:$c('movConcepto411C')?.value.trim()||'',monto,medio:$c('movMedio411C')?.value||'Otro',perfilId:$c('movPerfil411C')?.value||'',creadoEn:new Date().toISOString(),creadoPor:typeof nombreUsuarioAuditoria==='function'?nombreUsuarioAuditoria():''});
      saveMov411C();$c('movMonto411C').value='';$c('movConcepto411C').value='';renderFinance411C();
    });
  }

  function ensureFinanceConfig411F(){
    if(!data.configFinanzas411F||typeof data.configFinanzas411F!=='object')data.configFinanzas411F={};
    if(!Array.isArray(data.configFinanzas411F.sueldosSecretaria))data.configFinanzas411F.sueldosSecretaria=[];
    if(!data.configFinanzas411F.sueldosSecretaria.length){
      data.configFinanzas411F.sueldosSecretaria.push({id:'sueldo_secretaria_inicial_411f',monto:400000,vigenteDesde:'2026-08-01'});
    }
  }
  function mesesPeriodo411F(desde,hasta){
    if(!desde||!hasta)return [];
    const out=[],d=new Date(desde+'T12:00:00'),end=new Date(hasta+'T12:00:00');
    if(Number.isNaN(d.getTime())||Number.isNaN(end.getTime()))return [];
    d.setDate(1);
    while(d<=end){
      out.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`);
      d.setMonth(d.getMonth()+1);
      if(out.length>120)break;
    }
    return out;
  }
  function fechaNormal411F(v){
    const s=String(v||'').trim();
    if(/^\d{4}-\d{2}-\d{2}$/.test(s))return s;
    const m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if(m)return `${m[3]}-${String(m[2]).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`;
    return '';
  }
  function sueldoMes411F(ym){
    ensureFinanceConfig411F();
    const finMes=ym+'-31';
    const arr=(data.configFinanzas411F.sueldosSecretaria||[])
      .filter(x=>x&&Number.isFinite(Number(x.monto)))
      .map(x=>({...x,_fecha:fechaNormal411F(x.vigenteDesde)}))
      .filter(x=>!x._fecha||x._fecha<=finMes)
      .sort((a,b)=>String(b._fecha||'').localeCompare(String(a._fecha||'')));
    if(arr.length)return Number(arr[0].monto||0);
    // Respaldo seguro: si la configuración existe pero la fecha antigua tenía otro formato,
    // usar el último monto cargado. Si no existe, mantener el valor inicial vigente.
    const any=(data.configFinanzas411F.sueldosSecretaria||[]).slice().reverse().find(x=>Number.isFinite(Number(x?.monto)));
    return Number(any?.monto||400000);
  }
  function perfilEsDuenio411F(perfil){
    if(!perfil)return true; // vista "Todos": el costo fijo se descuenta una sola vez.
    const p=(data.profesionales||[]).find(x=>String(x.id)===String(perfil));
    const txt=norm([perfil,p?.id,p?.nombre].filter(Boolean).join(' '));
    return txt.includes('matias')||txt.includes('anchorena');
  }
  function sueldoPeriodo411F(desde,hasta,perfil){
    if(!perfilEsDuenio411F(perfil))return 0;
    const meses=mesesPeriodo411F(desde,hasta);
    if(!meses.length){
      const d=(desde||hasta||todayISO()).slice(0,7);
      return d?sueldoMes411F(d):sueldoMes411F(todayISO().slice(0,7));
    }
    return meses.reduce((s,m)=>s+sueldoMes411F(m),0);
  }
  function buscarArancel411F(a){
    if(!a)return null;
    const pid=a.profesionalId||a.cajaPerfil||'matias',os=norm(a.obraSocial),prest=norm(a.prestacion),f=a.fecha||todayISO();
    const arr=(data.arancelesPorProfesional?.[pid]||[]).filter(x=>x&&x.activo!==false&&norm(x.obraSocial)===os&&norm(x.prestacion)===prest&&(!x.vigenteDesde||x.vigenteDesde<=f));
    arr.sort((x,y)=>String(y.vigenteDesde||'').localeCompare(String(x.vigenteDesde||'')));
    return arr[0]||null;
  }
  function placementCost411C(a){
    if(!a?.colocacionLiquidable)return 0;
    try{return typeof valorColocacionPorPrestacion==='function'?Number(valorColocacionPorPrestacion(a.prestacion)||0):0;}catch(e){return 0;}
  }
  function mesAnterior411F(ym){
    const m=String(ym||'').match(/^(\d{4})-(\d{2})$/);if(!m)return '';
    const d=new Date(Number(m[1]),Number(m[2])-1,1,12,0,0);
    d.setMonth(d.getMonth()-1);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
  }
  function nombreMes411F(ym){
    const m=String(ym||'').match(/^(\d{4})-(\d{2})$/);if(!m)return ym||'';
    const d=new Date(Number(m[1]),Number(m[2])-1,1,12,0,0);
    try{return d.toLocaleDateString('es-AR',{month:'long',year:'numeric'});}catch(e){return ym;}
  }
  function colocacionesLiquidacion411F(desde,hasta,perfil){
    const mesesPago=mesesPeriodo411F(desde,hasta);
    if(!mesesPago.length){
      const ref=(desde||hasta||todayISO()).slice(0,7);
      if(ref)mesesPago.push(ref);
    }
    const mesesTrabajo=new Set(mesesPago.map(mesAnterior411F).filter(Boolean));
    return (atenciones||[]).filter(a=>{
      if(!a?.colocacionLiquidable||!a.fecha)return false;
      const mesTrabajo=String(a.fecha).slice(0,7);
      if(!mesesTrabajo.has(mesTrabajo))return false;
      if(perfil&&a.profesionalId!==perfil&&a.cajaPerfil!==perfil)return false;
      return true;
    }).reduce((s,a)=>s+placementCost411C(a),0);
  }
  function etiquetaColocaciones411F(desde,hasta){
    const mesesPago=mesesPeriodo411F(desde,hasta);
    if(!mesesPago.length){
      const ref=(desde||hasta||todayISO()).slice(0,7);
      if(ref)mesesPago.push(ref);
    }
    if(mesesPago.length===1){
      const pago=mesesPago[0],trabajo=mesAnterior411F(pago);
      return `Colocaciones de ${nombreMes411F(trabajo)} (liquidadas en ${nombreMes411F(pago)})`;
    }
    return 'Colocaciones de los meses previos (liquidadas en el período)';
  }
  function arancel411C(a){
    if(['particular','pami'].includes(norm(a.obraSocial)))return 0;
    if(Number.isFinite(Number(a.valorArancelEstimado))&&Number(a.valorArancelEstimado)>=0)return Number(a.valorArancelEstimado||0);
    const ar=buscarArancel411F(a);
    return ar?Number(ar.valor||0):0;
  }
  function isFacturaOtro411C(a,perfilId){
    if(!a||!perfilId)return false;
    if(perfilId==='matias'){
      try{return typeof esRegistroFacturaRogelio==='function'&&esRegistroFacturaRogelio(a);}catch(e){return false;}
    }
    const prof=(data.profesionales||[]).find(p=>p.id===perfilId);
    const destino=String(a.destinoFacturacionEstimado||a.prestacionA||'');
    return !!(destino&&prof&&norm(destino)!==norm(prof.nombre)&&norm(destino)!=='no aplica');
  }
  function addBucket411C(obj,key,val){obj[key]=(obj[key]||0)+Number(val||0);}
  function renderFinance411C(){
    injectFinance411C();ensureMov411C();ensureFinanceConfig411F();
    const permitido=(()=>{try{return !!(esMatiasDuenio?.()||esAdminComun?.());}catch(e){return false;}})();
    if(!permitido)return;
    const desde=$c('finDesde411C')?.value||'',hasta=$c('finHasta411C')?.value||'',perfil=$c('finPerfil411C')?.value||'';
    const list=(atenciones||[]).filter(a=>a&&(!desde||a.fecha>=desde)&&(!hasta||a.fecha<=hasta)&&(!perfil||a.profesionalId===perfil||a.cajaPerfil===perfil));
    const ingresos={particular:0,copago:0,os:0,facturaOtro:0,senias:0},medios={Efectivo:0,Transferencia:0,'Débito':0,Mixto:0,'No aplica':0,Otro:0};
    let colocaciones=0;
    list.forEach(a=>{
      if(['ausente','cancelado'].includes(estado411(a))){
        const s=Number(a.seniaMonto||0);ingresos.senias+=s;addBucket411C(medios,a.seniaFormaPago||'Otro',s);return;
      }
      const part=Number(a.montoConsulta||0)+Number(a.montoEstudio||0),cop=Number(a.montoCopago||0),forma=a.formaPago||'Otro';
      ingresos.particular+=part;ingresos.copago+=cop;addBucket411C(medios,forma,part+cop);
      const ar=arancel411C(a);
      if(ar>0){
        if(perfil&&isFacturaOtro411C(a,perfil))ingresos.facturaOtro+=ar;
        else if(!perfil&&a.profesionalId==='matias'&&isFacturaOtro411C(a,'matias'))ingresos.facturaOtro+=ar;
        else ingresos.os+=ar;
      }
      // Las colocaciones no se imputan por la fecha de realización:
      // se liquidan en el mes siguiente.
    });
    colocaciones=colocacionesLiquidacion411F(desde,hasta,perfil);
    const etiquetaColocaciones=etiquetaColocaciones411F(desde,hasta);

    // Los sueldos cargados antiguamente como movimiento manual se ignoran:
    // desde esta versión el sueldo es un costo fijo mensual configurado.
    const movs=(data.movimientosFinancieros411C||[]).filter(m=>m.categoria!=='Sueldo Secretaría'&&(!desde||m.fecha>=desde)&&(!hasta||m.fecha<=hasta)&&(!perfil||!m.perfilId||m.perfilId===perfil));
    const sueldo=sueldoPeriodo411F(desde,hasta,perfil);
    const otros=movs.reduce((s,m)=>s+Number(m.monto||0),0);

    const cajaCobrada=ingresos.particular+ingresos.copago+ingresos.senias;
    const aFacturar=ingresos.os+ingresos.facturaOtro;
    const totalIng=cajaCobrada+aFacturar;
    const liquidacionSecretaria=sueldo+colocaciones;
    const totalEgr=liquidacionSecretaria+otros;
    const neto=totalIng-totalEgr;
    const facturaLabel=perfil==='matias'?'Factura Rogelio':(perfil?'Factura otro':'Factura terceros');
    const medioHtml=Object.entries(medios).filter(([,v])=>v>0).map(([k,v])=>`<div><span>${esc(k)}</span><strong>${money411(v)}</strong></div>`).join('')||'<p class="muted">Sin ingresos cobrados en el período.</p>';
    const movHtml=movs.slice().sort((a,b)=>String(b.fecha).localeCompare(String(a.fecha))).map(m=>`<tr><td>${esc(m.fecha)}</td><td>${esc(m.categoria)}</td><td>${esc(m.concepto||'')}</td><td>${esc(m.medio||'')}</td><td>${money411(m.monto)}</td><td><button class="small-btn" type="button" data-del-mov411c="${esc(m.id)}">Borrar</button></td></tr>`).join('');
    const missing=list.filter(a=>!['particular','pami'].includes(norm(a.obraSocial))&&!['ausente','cancelado'].includes(estado411(a))&&arancel411C(a)<=0).length;

    $c('finResultado411C').innerHTML=`
      <div class="finance-kpis411c finance-kpis-4-411f">
        <div><span>Caja cobrada</span><strong>${money411(cajaCobrada)}</strong></div>
        <div><span>A facturar OS / terceros</span><strong>${money411(aFacturar)}</strong></div>
        <div><span>Egresos</span><strong>${money411(totalEgr)}</strong></div>
        <div class="${neto<0?'neg411c':'pos411c'}"><span>Neto estimado</span><strong>${money411(neto)}</strong></div>
      </div>
      ${missing?`<div class="finance-warning411f">⚠️ Hay <strong>${missing}</strong> atención(es) de OS/prepaga sin arancel cargado para esa combinación de profesional + convenio + prestación + fecha.</div>`:''}
      <div class="finance-columns411c">
        <section>
          <h3>Ingresos cobrados</h3>
          <div class="finance-lines411c">
            <div><span>Particulares</span><strong>${money411(ingresos.particular)}</strong></div>
            <div><span>Copagos</span><strong>${money411(ingresos.copago)}</strong></div>
            <div><span>Señas de ausentes/cancelados</span><strong>${money411(ingresos.senias)}</strong></div>
          </div>
          <h4>Por medio de pago</h4><div class="finance-lines411c">${medioHtml}</div>
        </section>
        <section>
          <h3>Producción a facturar</h3>
          <div class="finance-lines411c">
            <div><span>OS / prepagas (arancel vigente)</span><strong>${money411(ingresos.os)}</strong></div>
            <div><span>${facturaLabel}</span><strong>${money411(ingresos.facturaOtro)}</strong></div>
          </div>
          <p class="muted finance-note411f">Estos importes son producción estimada según los aranceles configurados; no significan dinero ya cobrado.</p>
        </section>
      </div>
      <div class="finance-columns411c">
        <section>
          <h3>Egresos</h3>
          <div class="finance-lines411c">
            <div><span>Sueldo Secretaría (costo fijo mensual)</span><strong>${money411(sueldo)}</strong></div>
            <div><span>${esc(etiquetaColocaciones)}</span><strong>${money411(colocaciones)}</strong></div>
            <div><span>Otros egresos</span><strong>${money411(otros)}</strong></div>
          </div>
        </section>
        <section>
          <h3>Liquidación Secretaría · solo Administración</h3>
          <div class="finance-lines411c">
            <div><span>Sueldo fijo</span><strong>${money411(sueldo)}</strong></div>
            <div><span>${esc(etiquetaColocaciones)}</span><strong>${money411(colocaciones)}</strong></div>
            <div><span>Total a liquidar</span><strong>${money411(liquidacionSecretaria)}</strong></div>
          </div>
          <p class="muted finance-note411f">Este bloque no se muestra en el perfil Secretaría. El sueldo se toma automáticamente de Configuración financiera según su vigencia. Las colocaciones se imputan al mes siguiente de su realización (por ejemplo: julio se liquida en agosto).</p>
        </section>
      </div>
      ${movs.length?`<h3>Otros movimientos manuales</h3><div class="finance-table-wrap411c"><table><thead><tr><th>Fecha</th><th>Categoría</th><th>Concepto</th><th>Medio</th><th>Monto</th><th></th></tr></thead><tbody>${movHtml}</tbody></table></div>`:''}`;
  }

  document.addEventListener('click',e=>{
    const b=e.target.closest?.('[data-del-mov411c]');if(!b)return;
    if(!confirm('¿Borrar este movimiento financiero?'))return;
    ensureMov411C();data.movimientosFinancieros411C=data.movimientosFinancieros411C.filter(m=>m.id!==b.dataset.delMov411c);saveMov411C();renderFinance411C();
  });

  function ensureDebitOptions411C(){
    document.querySelectorAll('select').forEach(sel=>{
      const opts=[...sel.options].map(o=>o.value||o.textContent);
      if(opts.includes('Efectivo')&&opts.includes('Transferencia')&&!opts.includes('Débito')){
        const o=document.createElement('option');o.value='Débito';o.textContent='Débito';sel.appendChild(o);
      }
    });
  }

  function boot411C(){
    ajustarHcVisual411C();inyectarAusentismo411C();injectFinance411C();ensureDebitOptions411C();

    // QA Finanzas 2:
    // al iniciar la app todavía puede no estar restaurada la sesión.
    // Si el bloque financiero fue descartado en ese momento, lo reinyectamos
    // cuando el usuario abre Caja / reportes.
    const oldShow411F=window.showSection;
    if(typeof oldShow411F==='function'&&!oldShow411F.__financeVisible411F){
      const wrapped411F=function(id){
        const r=oldShow411F.apply(this,arguments);
        if(id==='caja'){
          setTimeout(()=>{
            injectFinance411C();
            try{renderFinance411C();}catch(e){console.warn('Informe financiero:',e);}
          },60);
        }
        return r;
      };
      wrapped411F.__financeVisible411F=true;
      try{window.showSection=showSection=wrapped411F;}catch(e){window.showSection=wrapped411F;}
    }

    document.addEventListener('click',e=>{
      const nav=e.target.closest?.('.nav[data-section="caja"]');
      if(!nav)return;
      setTimeout(()=>{
        injectFinance411C();
        try{renderFinance411C();}catch(err){console.warn('Informe financiero:',err);}
      },120);
    },true);

    setTimeout(()=>{ajustarHcVisual411C();inyectarAusentismo411C();injectFinance411C();ensureDebitOptions411C();},700);
    setTimeout(()=>{ajustarHcVisual411C();inyectarAusentismo411C();injectFinance411C();ensureDebitOptions411C();},1800);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot411C);else boot411C();
})();

/* ===== Estilos Fase 3C ampliada ===== */
(function(){
  if(document.getElementById('phase3c-ampliada-style411c'))return;
  const s=document.createElement('style');s.id='phase3c-ampliada-style411c';
  s.textContent=`
    #hcBuscarPaciente{min-height:48px!important;font-size:17px!important;border:2px solid #174b5c!important;box-shadow:0 0 0 4px rgba(23,75,92,.08)!important;background:#fff!important}
    .hc-search-emphasis411c{border:1px solid #9fb8c2!important;background:#f7fbfc!important;box-shadow:0 8px 24px rgba(23,75,92,.08)!important}
    .integration-collapsible411c{transition:.2s ease}.integration-title411c{cursor:pointer;display:flex;align-items:center;justify-content:space-between}.integration-title411c:after{content:'▾';font-size:13px;color:#64748b}.integration-collapsible411c.collapsed411c>*:not(.integration-title411c){display:none!important}.integration-collapsible411c.collapsed411c .integration-title411c:after{content:'▸'}
    .patient-copy-edit411c{display:flex;gap:7px;align-items:center;flex-wrap:wrap;padding:10px 0}.patient-copy-edit411c>span{font-weight:800;color:#475569}
    .stats-ausentismo411c{margin-top:18px}.finance-kpis411c{display:grid;grid-template-columns:repeat(3,minmax(150px,1fr));gap:12px;margin:12px 0}.finance-kpis411c>div{border:1px solid #dbe4e8;border-radius:13px;padding:12px;background:#f8fafc}.finance-kpis411c span{display:block;color:#64748b;font-size:12px;font-weight:700}.finance-kpis411c strong{display:block;font-size:22px;color:#0f172a;margin-top:3px}.finance-kpis411c small{color:#64748b}
    .finance411c{margin-top:22px}.finance-filters411c,.finance-mov-grid411c{display:grid;grid-template-columns:repeat(4,minmax(150px,1fr));gap:10px;align-items:end}.finance-filters411c label,.finance-mov-grid411c label{font-size:12px;font-weight:800;color:#475569}.finance-filters411c input,.finance-filters411c select,.finance-mov-grid411c input,.finance-mov-grid411c select{width:100%;margin-top:5px}
    .finance-mov411c{margin:14px 0;padding:10px;border:1px solid #dbe4e8;border-radius:12px;background:#fbfdfe}.finance-mov411c summary{cursor:pointer;font-weight:800;color:#174b5c}
    .finance-columns411c{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:14px}.finance-columns411c section{border:1px solid #dbe4e8;border-radius:13px;padding:14px;background:#fff}.finance-lines411c>div{display:flex;justify-content:space-between;gap:14px;padding:8px 0;border-bottom:1px solid #edf2f4}.finance-lines411c>div:last-child{border-bottom:0}.finance-table-wrap411c{overflow:auto}.finance-table-wrap411c table{width:100%;border-collapse:collapse}.finance-table-wrap411c th,.finance-table-wrap411c td{padding:8px;border-bottom:1px solid #e5e7eb;text-align:left}.pos411c strong{color:#166534!important}.neg411c strong{color:#b91c1c!important}
    @media(max-width:900px){.finance-filters411c,.finance-mov-grid411c{grid-template-columns:repeat(2,minmax(130px,1fr))}.finance-columns411c{grid-template-columns:1fr}.finance-kpis411c{grid-template-columns:1fr}}
  `;
  document.head.appendChild(s);
})();


/* ===== CardioLink v4.1.0-hc · QA FINAL perfiles/documentos ===== */
(function(){
  'use strict';
  if(window.__cardiolinkQaFinal410)return;
  window.__cardiolinkQaFinal410=true;

  function escQ(s){return String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}
  function userQ(){
    try{return typeof perfilUsuarioActual==='function'?perfilUsuarioActual():(window.usuarioPerfilActual||{});}catch(e){return window.usuarioPerfilActual||{};}
  }
  function roleLabelQ(r){
    try{return typeof labelRol==='function'?labelRol(r):r;}catch(e){return r||'';}
  }
  function ensureUserBadgeQ(){
    let box=document.getElementById('loggedUserBadgeQAF');
    if(!box){
      box=document.createElement('div');
      box.id='loggedUserBadgeQAF';
      box.className='logged-user-badge-qaf';
      document.body.appendChild(box);
    }
    const u=userQ();
    box.innerHTML=`<span>Usuario activo</span><strong>${escQ(u.nombre||u.usuario||'Usuario')}</strong><small>${escQ(roleLabelQ(u.rol||''))}${u.especialidad?' · '+escQ(u.especialidad):''}</small>`;
  }

  // Mantener el menú + actualizado cuando se abre una ficha o se cambia de solapa.
  document.addEventListener('click',e=>{
    if(e.target.closest?.('[data-patient-open4091],#pacienteGlobalModal,[data-hc-patient],[data-hc-new],[data-open-hc]')){
      setTimeout(()=>{window.CardioLinkPacienteActual411B?.render?.();},40);
    }
  },true);

  const oldApply=window.aplicarPermisosUI;
  if(typeof oldApply==='function'&&!oldApply.__qaf){
    const w=function(){const r=oldApply.apply(this,arguments);setTimeout(ensureUserBadgeQ,0);return r;};
    w.__qaf=true;window.aplicarPermisosUI=aplicarPermisosUI=w;
  }

  function bootQ(){
    ensureUserBadgeQ();
    setTimeout(ensureUserBadgeQ,500);
    setTimeout(()=>{ensureUserBadgeQ();window.CardioLinkPacienteActual411B?.render?.();},1500);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bootQ);else bootQ();
})();

(function(){
  if(document.getElementById('cardiolink-qaf-style'))return;
  const s=document.createElement('style');s.id='cardiolink-qaf-style';
  s.textContent=`
    .logged-user-badge-qaf{position:fixed;top:14px;right:18px;z-index:12040;display:flex;flex-direction:column;align-items:flex-end;max-width:290px;padding:7px 11px;border:1px solid #cbd5e1;border-radius:12px;background:rgba(255,255,255,.96);box-shadow:0 8px 22px rgba(15,23,42,.12);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);pointer-events:none}
    .logged-user-badge-qaf span{font-size:9px;text-transform:uppercase;letter-spacing:.07em;color:#64748b;font-weight:800}
    .logged-user-badge-qaf strong{font-size:13px;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:270px}
    .logged-user-badge-qaf small{font-size:10px;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:270px}
    @media(max-width:1180px){.logged-user-badge-qaf{top:auto;bottom:14px;left:14px;right:auto;align-items:flex-start;max-width:230px}}
  `;
  document.head.appendChild(s);
})();


(function(){
  if(document.getElementById('cardiolink-qaf2-style'))return;
  const s=document.createElement('style');s.id='cardiolink-qaf2-style';
  s.textContent=`
    .doc-prof-selector406{margin:10px 0 14px;padding:12px;border:1px solid #bae6fd;border-radius:12px;background:#f0f9ff}
    .doc-prof-selector406 label{display:block;font-weight:800;color:#0f172a}
    .doc-prof-selector406 select{width:100%;margin-top:6px;min-height:42px}
  `;
  document.head.appendChild(s);
})();


/* ===== CardioLink v4.1.0-hc · QA FINANZAS ===== */
(function(){
  'use strict';
  if(window.__cardiolinkQaFinanzas411F)return;
  window.__cardiolinkQaFinanzas411F=true;
  const $f=id=>document.getElementById(id);
  const escf=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const normf=s=>String(s??'').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const moneyf=n=>typeof money==='function'?money(Number(n||0)):'$ '+Number(n||0).toLocaleString('es-AR');

  function adminf(){try{return !!(esMatiasDuenio?.()||esAdminComun?.());}catch(e){return false;}}
  function ensuref(){
    if(!data.configFinanzas411F||typeof data.configFinanzas411F!=='object')data.configFinanzas411F={};
    if(!Array.isArray(data.configFinanzas411F.sueldosSecretaria))data.configFinanzas411F.sueldosSecretaria=[];
    if(!data.configFinanzas411F.sueldosSecretaria.length)data.configFinanzas411F.sueldosSecretaria.push({id:'sueldo_secretaria_inicial_411f',monto:400000,vigenteDesde:'2026-08-01'});
  }
  function persistf(){
    try{saveConfig();}catch(e){}
    try{window.guardarConfigEnSupabase298?.();}catch(e){}
  }
  function salaryCurrentf(){
    ensuref();
    const hoy=typeof todayISO==='function'?todayISO():new Date().toISOString().slice(0,10);
    const arr=data.configFinanzas411F.sueldosSecretaria.filter(x=>x.vigenteDesde<=hoy).slice().sort((a,b)=>String(b.vigenteDesde).localeCompare(String(a.vigenteDesde)));
    return arr[0]||data.configFinanzas411F.sueldosSecretaria[0];
  }
  function injectConfigf(){
    const grid=document.querySelector('#config .config-grid');
    if(!grid)return;
    if(!adminf()){$f('cfgFinanzas411F')?.remove();return;}
    ensuref();
    let card=$f('cfgFinanzas411F');
    if(!card){
      card=document.createElement('div');card.id='cfgFinanzas411F';card.className='config-smart-card-310 full-config-card';card.dataset.configGroupCard='administracion';
      card.innerHTML=`<h3>Configuración financiera · Administración</h3>
        <p class="muted">Visible únicamente para dueño/Administrador. El sueldo se considera un costo fijo mensual. Las colocaciones se suman a la liquidación del mes siguiente al que fueron realizadas.</p>
        <div class="finance-config-grid411f">
          <label>Sueldo mensual Secretaría<input id="finSueldo411F" type="number" min="0" step="1"></label>
          <label>Vigente desde<input id="finSueldoDesde411F" type="date"></label>
          <button id="finGuardarSueldo411F" type="button" class="primary">Guardar nuevo valor</button>
        </div>
        <div id="finSueldoHist411F" class="finance-salary-history411f"></div>`;
      grid.appendChild(card);
      card.addEventListener('click',e=>{
        if(e.target.id!=='finGuardarSueldo411F')return;
        const monto=Number($f('finSueldo411F')?.value||0),desde=$f('finSueldoDesde411F')?.value;
        if(!Number.isFinite(monto)||monto<0||!desde){alert('Ingresá sueldo y fecha de vigencia.');return;}
        ensuref();data.configFinanzas411F.sueldosSecretaria.push({id:'sal_'+Date.now(),monto,vigenteDesde:desde});
        persistf();renderConfigf();alert('Sueldo mensual actualizado.');
      });
    }
    renderConfigf();
  }
  function renderConfigf(){
    if(!adminf())return;ensuref();
    const cur=salaryCurrentf();
    if($f('finSueldo411F'))$f('finSueldo411F').value=Number(cur?.monto||400000);
    if($f('finSueldoDesde411F')&&!$f('finSueldoDesde411F').value)$f('finSueldoDesde411F').value=typeof todayISO==='function'?todayISO():new Date().toISOString().slice(0,10);
    if($f('finSueldoHist411F'))$f('finSueldoHist411F').innerHTML=`<h4>Historial de sueldo</h4>`+
      data.configFinanzas411F.sueldosSecretaria.slice().sort((a,b)=>String(b.vigenteDesde).localeCompare(String(a.vigenteDesde))).map(x=>`<div class="salary-row411f"><span>Desde ${escf(x.vigenteDesde)}</span><strong>${moneyf(x.monto)}</strong></div>`).join('');
  }

  function tariff(pid,os,prest,fecha){
    const arr=(data.arancelesPorProfesional?.[pid]||[]).filter(a=>a&&a.activo!==false&&normf(a.obraSocial)===normf(os)&&normf(a.prestacion)===normf(prest)&&(!a.vigenteDesde||a.vigenteDesde<=fecha));
    arr.sort((a,b)=>String(b.vigenteDesde||'').localeCompare(String(a.vigenteDesde||'')));
    return arr[0]||null;
  }
  function applyConfiguredPatientChargef(){
    const prof=$f('profesional')?.value,os=$f('obraSocial')?.value,prest=$f('prestacion')?.value;
    if(!prof||!os||!prest)return;
    const ar=tariff(prof,os,prest,typeof todayISO==='function'?todayISO():new Date().toISOString().slice(0,10));
    if(!ar)return;
    const tipo=$f('tipoCobro'),forma=$f('formaPago'),mConsulta=$f('montoConsulta'),mEstudio=$f('montoEstudio'),mCop=$f('montoCopago');
    const isConsult=(()=>{try{return typeof tipoPrest==='function'?tipoPrest(prest)==='CONSULTA':/consulta/i.test(prest);}catch(e){return /consulta/i.test(prest);}})();
    if(normf(os)==='particular'){
      if(tipo)tipo.value='Particular';if(forma&&forma.value==='No aplica')forma.value='Efectivo';
      if(isConsult&&mConsulta)mConsulta.value=Number(ar.valor||0);
      if(!isConsult&&mEstudio)mEstudio.value=Number(ar.valor||0);
      if(mCop)mCop.value=0;
    }else if(Number(ar.copago||0)>0){
      if(tipo&&!String(tipo.value).includes('Particular'))tipo.value='Copago';
      if(forma&&forma.value==='No aplica')forma.value='Efectivo';
      if(mCop)mCop.value=Number(ar.copago||0);
    }
    try{calcularCajaCarga?.();}catch(e){}
  }

  const oldRule=window.aplicarRegla;
  if(typeof oldRule==='function'&&!oldRule.__finance411f){
    const wrapped=function(){const r=oldRule.apply(this,arguments);setTimeout(applyConfiguredPatientChargef,0);return r;};
    wrapped.__finance411f=true;window.aplicarRegla=aplicarRegla=wrapped;
  }

  const oldPermFinance411F=window.aplicarPermisosUI;
  if(typeof oldPermFinance411F==='function'&&!oldPermFinance411F.__finance411f){
    const wrappedPerm411F=function(){
      const r=oldPermFinance411F.apply(this,arguments);
      setTimeout(()=>{
        try{
          const cajaEl=document.getElementById('caja');
          const cajaVisible=!!(cajaEl&&cajaEl.classList.contains('visible'));
          if(cajaVisible&&adminf()){
            // solo refrescar si Caja es realmente la sección activa
            if(typeof injectFinance411C==='function')injectFinance411C();
            if(typeof renderFinance411C==='function')renderFinance411C();
          }
        }catch(e){}
      },120);
      return r;
    };
    wrappedPerm411F.__finance411f=true;
    try{window.aplicarPermisosUI=aplicarPermisosUI=wrappedPerm411F;}catch(e){window.aplicarPermisosUI=wrappedPerm411F;}
  }

  const oldConfig=window.renderConfig;
  if(typeof oldConfig==='function'&&!oldConfig.__finance411f){
    const wrapped=function(){const r=oldConfig.apply(this,arguments);setTimeout(injectConfigf,0);return r;};
    wrapped.__finance411f=true;window.renderConfig=renderConfig=wrapped;
  }

  function bootf(){
    ensuref();injectConfigf();
    document.addEventListener('click',e=>{
      const nav=e.target.closest?.('.nav[data-section="config"]');
      if(!nav)return;
      setTimeout(()=>{
        try{injectConfigf();renderConfigf();}catch(err){console.warn('Configuración financiera:',err);}
      },120);
    },true);
    // Refuerzo: aunque alguien fuerce el DOM, los bloques financieros quedan solo en dueño/admin.
    if(!adminf())document.querySelectorAll('#finanzas411C,#cfgFinanzas411F').forEach(x=>x.remove());
    setTimeout(injectConfigf,700);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bootf);else bootf();
})();

(function(){
  if(document.getElementById('finance411f-style'))return;
  const s=document.createElement('style');s.id='finance411f-style';
  s.textContent=`
    .finance-kpis-4-411f{grid-template-columns:repeat(4,minmax(145px,1fr))!important}
    .finance-warning411f{margin:12px 0;padding:11px 13px;border:1px solid #fdba74;border-radius:12px;background:#fff7ed;color:#9a3412}
    .finance-note411f{font-size:12px;margin-top:10px}
    .finance-config-grid411f{display:grid;grid-template-columns:minmax(180px,1fr) minmax(170px,1fr) auto;gap:10px;align-items:end}
    .finance-config-grid411f label{font-size:12px;font-weight:800;color:#475569}
    .finance-config-grid411f input{width:100%;margin-top:5px}
    .finance-salary-history411f{margin-top:14px}
    .salary-row411f{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px solid #e5e7eb}
    .arancel-head-fin411f,.arancel-row-fin411f{grid-template-columns:2fr 1fr 1fr 1fr auto!important}
    @media(max-width:980px){.finance-kpis-4-411f{grid-template-columns:repeat(2,1fr)!important}.finance-config-grid411f{grid-template-columns:1fr}}
  `;
  document.head.appendChild(s);
})();
