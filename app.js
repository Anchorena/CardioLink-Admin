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
  if(esMatiasDuenio()) return true;
  if(esSecretaria() || esAdminComun()) return true;
  if(esMedico()) return ['dashboard','carga','agenda','mensajes','pacientes','listado','estadisticas','colocaciones','instructivos'].includes(section);
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
  document.querySelectorAll('.solo-config').forEach(el=>el.classList.toggle('hidden-permission',!puedeGestionarConfig()));
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
      <p class="login-meta">Versión 3.9.0 LTS · 2026</p>
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
  btn.style.width = "100%";
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
    // Incluye atenciones + mensajes internos. Antes los mensajes quedaban afuera y desaparecían al refrescar.
    atenciones = registrosSincronizablesSupabase(atenciones);
    localStorage.setItem(storageAtenciones, JSON.stringify(atenciones));

    const rows = atenciones.map(a => ({
      id: String(a.id),
      payload: a,
      updated_at: new Date().toISOString()
    }));

    // Reemplazo completo protegido por lock para evitar carreras entre autosync y clicks.
    const { error: deleteError } = await supabaseClient
      .from("cardiolink_atenciones")
      .delete()
      .neq("id", "__nunca__");

    if (deleteError) {
      console.error("Error limpiando tabla Supabase:", deleteError);
      alert("No se pudo limpiar/sincronizar Supabase: " + deleteError.message);
      return false;
    }

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

    console.log("Supabase sincronizado:", rows.length, "registros");
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
  on('btnBorrarDatos','click',()=>{if(confirm('¿Borrar atenciones?')){atenciones=[];saveAtenciones();renderTabla();renderStats()}});
  on('btnAddUsuarioSistema','click',agregarUsuarioSistema);
  on('btnBuscarDuplicadosPacientes','click',renderDuplicadosPacientes);

  // Solapa Pacientes
  on('btnPacientesBuscar','click',()=>renderPacientesPanel($('pacientesBuscar')?.value||'',false));
  on('pacientesBuscar','keydown',(e)=>{if(e.key==='Enter'){e.preventDefault();renderPacientesPanel($('pacientesBuscar')?.value||'',true);}});
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
      <li>Busca pacientes, importa datos desde Medicloud y actualiza datos administrativos.</li>
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
 if(!lista.length){box.innerHTML='<div class="muted">No encontré paciente local. Podés cargarlo manual o importar desde Medicloud.</div>';return;}
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
 overlay.innerHTML=`<div class="modal-edit-card modal-import-card"><div class="modal-edit-header"><div><h2>Importar paciente desde Medicloud</h2><p>Copiá los datos visibles de Medicloud, pegalos acá y CardioLink evita duplicados por DNI.</p></div><button type="button" class="modal-close" onclick="cerrarImportadorMedicloud()">×</button></div><textarea id="textoMedicloud" rows="10" placeholder="Pegá acá el texto copiado desde Medicloud"></textarea><div class="modal-actions"><button class="secondary" type="button" onclick="cerrarImportadorMedicloud()">Cancelar</button><button class="primary" type="button" onclick="aplicarImportMedicloud()">Completar paciente</button></div></div>`;
 document.body.appendChild(overlay);
 setTimeout(()=>$('textoMedicloud')?.focus(),50);
}
function cerrarImportadorMedicloud(){const m=$('modalImportMedicloud');if(m)m.remove();}
function aplicarImportMedicloud(){
 const datos=parsearTextoMedicloud($('textoMedicloud')?.value||'');
 if(!datos.nombreCompleto && !datos.dni){alert('No pude detectar nombre o DNI. Pegá más datos de la ficha.');return;}
 const existente=datos.dni?buscarPacientes(datos.dni)[0]:null;
 if(existente && !confirm('Este DNI ya existe en CardioLink. ¿Actualizar datos de la ficha existente con lo copiado desde Medicloud?')){usarPaciente(existente.id);cerrarImportadorMedicloud();return;}
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
function estadoHTML(a,e){const nc=a.noCobrar?'<span class="badge neutral informe-badge">No cobrado</span>':'';return `<span class="badge ${e.cls}">${e.txt}</span>${nc}${badgesInforme(a)}`;}

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
function renderTabla(){const tbody=$('tablaAtenciones');tbody.innerHTML='';const datos=filtrar();renderResumenCaja(datos);actualizarResumenFacturaRogelio(datos);if(resumenFiltrosVisible)calcularLiquidacionColocaciones();const totalPaginas=Math.max(1,Math.ceil(datos.length/TAMANIO_PAGINA_LISTADO));if(paginaListado>totalPaginas)paginaListado=totalPaginas;if(paginaListado<1)paginaListado=1;actualizarPaginacionListado(datos.length,totalPaginas);const inicio=(paginaListado-1)*TAMANIO_PAGINA_LISTADO;const datosPagina=datos.slice(inicio,inicio+TAMANIO_PAGINA_LISTADO);if(!datos.length){tbody.innerHTML='<tr><td colspan="14">No hay registros para mostrar.</td></tr>';return}datosPagina.forEach(a=>{const e=evaluarEstado(a),m=dineroVisible(a),part=m.particular;const tr=document.createElement('tr');if(editandoId===a.id){tr.className='edit-row';tr.innerHTML=`<td><input type="date" id="e_fecha_${a.id}" value="${a.fecha||''}"></td><td><input id="e_paciente_${a.id}" value="${escapeHtml(a.paciente)}"><input id="e_obs_${a.id}" value="${escapeHtml(a.observaciones||'')}" placeholder="Obs."></td><td>${selectHTML('e_os_'+a.id,data.obrasSociales,a.obraSocial)}</td><td>${selectProfesionalesHTML('e_prof_'+a.id,a.profesionalId)}</td><td>${selectPrestacionesHTML('e_prest_'+a.id,a.profesionalId,a.prestacion)}</td><td>${selectHTML('e_consultaA_'+a.id,opcionesDestinos(a.consultaA),a.consultaA)}</td><td>${selectHTML('e_prestacionA_'+a.id,opcionesDestinos(a.prestacionA),a.prestacionA)}</td><td>${selectHTML('e_tipoCobro_'+a.id,['Sin cobro en caja','No cobrar','Copago','Particular','Particular + copago'],a.tipoCobro)}<div class="inline-checks-edit"><label><input type="checkbox" id="e_bonoConsulta_${a.id}" ${a.bonoConsulta?'checked':''}> Bono consulta</label><label><input type="checkbox" id="e_bonoEstudio_${a.id}" ${a.bonoEstudio?'checked':''}> Bono estudio</label><label><input type="checkbox" id="e_bonoFirmado_${a.id}" ${a.bonoFirmado?'checked':''}> Bono firmado</label><label><input type="checkbox" id="e_copiaImpresa_${a.id}" ${a.copiaImpresa?'checked':''}> Copia</label><label><input type="checkbox" id="e_fold2_${a.id}" ${a.fold2?'checked':''}> Fold2</label><label><input type="checkbox" id="e_planilla_${a.id}" ${a.planilla?'checked':''}> Planilla</label><label><input type="checkbox" id="e_colocacionLiquidable_${a.id}" ${a.colocacionLiquidable?'checked':''}> Colocación liquidable</label><label>Colocador/a ${selectHTML('e_colocador_'+a.id,['Geraldine','Secretaría','Otro'],a.colocador||'Geraldine')}</label></div></td><td>${selectHTML('e_formaPago_'+a.id,['No aplica','Efectivo','Transferencia','Mixto'],a.formaPago||'No aplica')}</td><td><input type="number" id="e_particular_${a.id}" value="${Number(a.montoConsulta||0)+Number(a.montoEstudio||0)}"></td><td><input type="number" id="e_copago_${a.id}" value="${Number(a.montoCopago||0)}"></td><td>${money(a.montoTotal)}</td><td class="estado-cell">${estadoHTML(a,e)}</td><td class="no-print actions-cell"><div class="edit-actions"><button class="small-btn" onclick="guardarEdicion(${idJS(a.id)})">Guardar</button><button class="small-btn" onclick="cancelarEdicion()">Cancelar</button></div></td>`}else{tr.innerHTML=`<td>${formatFecha(a.fecha)}</td><td><strong>${escapeHtml(a.paciente)}</strong>${a.observaciones?'<br><small>'+escapeHtml(a.observaciones)+'</small>':''}</td><td>${a.obraSocial}</td><td>${a.profesional}</td><td>${prestacionListado(a)}${badgeColocacion(a)}</td><td>${a.consultaA}</td><td>${a.prestacionA}</td><td>${a.tipoCobro||''}</td><td>${a.formaPago||'No aplica'}</td><td class="money-col">${money(part)}</td><td class="money-col">${money(m.copago)}</td><td class="money-col">${money(m.total)}</td><td class="estado-cell">${estadoHTML(a,e)}</td><td class="no-print actions-cell"><div class="edit-actions"><button type="button" data-action="listado-editar" data-id="${escapeHtml(a.id)}" onclick="editarAtencion(${idJS(a.id)})">Editar</button><button type="button" data-action="listado-borrar" data-id="${escapeHtml(a.id)}" onclick="eliminarAtencion(${idJS(a.id)})">Borrar</button></div></td>`}tbody.appendChild(tr)})}
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
function exportarCSV(){const datos=filtrar();if(!datos.length){alert('No hay datos');return}const r=resumen(datos);const incluirValoresExport=!!$('incluirValoresImpresion')?.checked;const filas=[['CardioLink Admin v3.9.0 LTS'],['Perfil',perfilObj().nombre],['Consultas',r.consultas],['Estudios',r.estudios],[],['Fecha','Paciente','OS','Profesional','Prestación','Consulta a','Estudio a','Tipo','Forma','Particular visible','Copago visible','Total visible','Estado']];datos.forEach(a=>{const m=dineroVisible(a),e=evaluarEstado(a);filas.push([formatFecha(a.fecha),a.paciente,a.obraSocial,a.profesional,prestacionListado(a),a.consultaA,a.prestacionA,a.tipoCobro,a.formaPago,incluirValoresExport?m.particular:'',incluirValoresExport?m.copago:'',incluirValoresExport?m.total:'',e.txt])});const csv=filas.map(r=>r.map(c=>`"${String(c??'').replaceAll('"','""')}"`).join(';')).join('\n');const blob=new Blob(['\ufeff'+csv],{type:'text/csv'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='CardioLink_listado.csv';a.click()}
function exportarBackup(){const b={app:'CardioLink Admin',version:'2.9.8',fechaExportacion:new Date().toISOString(),config:data,atenciones};const blob=new Blob([JSON.stringify(b,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='CardioLink_Admin_backup.json';a.click()}
function importarBackup(){const inp=$('inputImportBackup');if(!inp.files[0]){alert('Elegí archivo');return}if(!confirm('Reemplaza la base actual. ¿Continuar?'))return;const rd=new FileReader();rd.onload=e=>{try{const b=JSON.parse(e.target.result);if(!b.config||!b.atenciones)throw new Error();data=b.config;atenciones=b.atenciones;saveConfig();saveAtenciones();refreshSelects();renderConfig();cambiarPerfil('general');alert('Backup importado')}catch{alert('Backup inválido')}};rd.readAsText(inp.files[0])}

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
  if(!puedeGestionarConfig()){alert('Tu perfil no puede crear usuarios.');return;}
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
  if(!puedeGestionarConfig()){alert('Tu perfil no puede depurar usuarios.');return;}
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
  tbody.innerHTML=datos.map(a=>`<tr>
    <td><strong>${horaTurno(a)}</strong></td>
    <td><strong>${escapeHtml(a.paciente||'')}</strong><br><small>${escapeHtml(a.telefono||'')} ${a.email?'· '+escapeHtml(a.email):''}</small></td>
    <td>${escapeHtml(a.profesional||'')}</td>
    <td>${escapeHtml(a.prestacion||'')}</td>
    <td>${escapeHtml(a.obraSocial||'')}</td>
    <td>${estadoAgendaBadge(a)}</td>
    <td class="agenda-actions"><button onclick="abrirAgendaModal(${idJS(a.id)})">Ver</button><button onclick="cambiarEstadoAgenda(${idJS(a.id)},'sala_espera')">Sala</button><button onclick="cambiarEstadoAgenda(${idJS(a.id)},'en_consulta')">Atender</button><button onclick="cambiarEstadoAgenda(${idJS(a.id)},'atendido')">Atendido</button></td>
  </tr>`).join('');
  cards.innerHTML=datos.map(a=>`<div class="agenda-turno-card">
    <div class="agenda-card-top"><strong>${horaTurno(a)}</strong>${estadoAgendaBadge(a)}</div>
    <h3>${escapeHtml(a.paciente||'')}</h3>
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
function renderPacientesPanel(q='', todos=false){
  const listaBox=$('pacientesLista'), resumen=$('pacientesResumen');
  if(!listaBox)return;
  const lista=pacientesPanelFiltrados(q,todos);
  if(resumen)resumen.textContent=lista.length ? `${lista.length} paciente(s) encontrados.` : 'No se encontraron pacientes.';
  if(!lista.length){listaBox.innerHTML='<div class="muted">No hay resultados. Podés importar desde Medicloud o cargar el paciente desde Carga de turno/atención.</div>';return;}
  listaBox.innerHTML=lista.map(p=>{
    const ats=atencionesPacienteGlobal(p);
    const ultima=ats[0];
    const activo=pacienteSeleccionadoPanelId===p.id?' active':'';
    return `<button type="button" class="paciente-panel-item${activo}" onclick="seleccionarPacientePanel('${escapeHtml(clavePacientePanel(p))}')">
      <strong>${escapeHtml(nombrePacientePanel(p))}</strong>
      <span>DNI ${escapeHtml(p.dni||'s/d')} · ${escapeHtml(p.telefono||'')}</span>
      <span>${ats.length} atención(es)${ultima?' · Última: '+formatFecha(ultima.fecha)+' · '+escapeHtml(ultima.profesional||''):''}</span>
    </button>`;
  }).join('');
}
function buscarPacientePanelPorId(id){
  return todosPacientes().find(p=>clavePacientePanel(p)===id || p.id===id) || null;
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

  window.eliminarAtencion = eliminarAtencion = function(id){
    if(!id){ alert('No encontré la atención seleccionada. Actualizá y probá de nuevo.'); return; }
    const a = (atenciones||[]).find(x => String(x.id)===String(id));
    if(!a){ alert('No encontré la atención seleccionada. Actualizá y probá de nuevo.'); return; }
    if(!confirm('¿Borrar esta atención?')) return;
    atenciones = (atenciones||[]).filter(x => String(x.id)!==String(id));
    try { saveAtenciones(); } catch(e) { console.error(e); }
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
  setInterval(()=>{actualizarVersionVisible295(); ajustarLogout295();},3000);
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
      btn.style.position='static'; btn.style.left='auto'; btn.style.right='auto'; btn.style.bottom='auto'; btn.style.width='100%'; btn.style.visibility=document.body.classList.contains('app-ready-360')?'visible':'hidden'; btn.style.minWidth='0'; btn.style.marginTop='10px'; btn.style.zIndex='1'; btn.style.boxShadow='none';
    }
    const dark=$id('btnDark'); if(dark){dark.style.marginTop='18px'; dark.style.marginBottom='8px';}
  }
  function version296(){
    try{document.title='CardioLink Admin v3.9.0 LTS';}catch(e){}
    document.querySelectorAll('.brand-main span').forEach(el=>el.textContent='v3.9.0');
    document.querySelectorAll('h2').forEach(el=>{ if((el.textContent||'').includes('CardioLink Admin v')) el.textContent='CardioLink Admin v3.9.0 LTS'; });
  }
  document.addEventListener('DOMContentLoaded',()=>{asegurarBloques296(); version296(); moverLogout296(); try{actualizarPrestaciones(); aplicarPermisosUI(); renderAgenda?.(); renderMensajes?.();}catch(e){} });
  setTimeout(()=>{asegurarBloques296(); version296(); moverLogout296(); try{actualizarPrestaciones(); aplicarPermisosUI(); renderAgenda?.(); renderMensajes?.();}catch(e){}},900);
  setInterval(()=>{version296(); moverLogout296();},3000);
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
  const VERSION_298='3.9.0';
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
    }catch(e){console.error(e);alert('No pude leer el Excel. Exportalo como .xlsx, .xls de Medicloud o .csv y probá de nuevo.');return;}
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
        rows.forEach((r,idx)=>{ if(vistos.has(r.id) && r.id!==CONFIG_ROW_ID) r.id='att_'+Date.now()+'_'+idx+'_'+Math.random().toString(36).slice(2,8); vistos.add(r.id); finalRows.push(r); });
        const {error:delErr}=await supabaseClient.from('cardiolink_atenciones').delete().neq('id','__nunca__');
        if(delErr){console.error(delErr); alert('No se pudo limpiar/sincronizar Supabase: '+delErr.message); return false;}
        const {error:upErr}=await supabaseClient.from('cardiolink_atenciones').upsert(finalRows,{onConflict:'id'});
        if(upErr){console.error(upErr); alert('No se pudo sincronizar con Supabase: '+upErr.message); return false;}
        console.log('Supabase sincronizado:',finalRows.length,'registros + config');
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
    try{document.title='CardioLink Admin v3.9.0 LTS';}catch(e){}
    document.querySelectorAll('.brand-main span').forEach(el=>el.textContent='v3.9.0');
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
    try{document.title='CardioLink Admin v3.9.0 LTS';}catch(e){}
    document.querySelectorAll('.brand-main span').forEach(el=>el.textContent='v3.9.0');
    const pt=document.querySelector('.print-title h2'); if(pt) pt.textContent='CardioLink Admin v3.9.0 LTS';
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
    try{document.title='CardioLink Admin v3.9.0 LTS';}catch(e){}
    document.querySelectorAll('.brand-main span').forEach(el=>el.textContent='v3.9.0');
    const pt=document.querySelector('.print-title h2'); if(pt) pt.textContent='CardioLink Admin v3.9.0 LTS';
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
    try{document.title='CardioLink Admin v3.9.0 LTS';}catch(e){}
    document.querySelectorAll('.brand-main span').forEach(el=>el.textContent='v3.9.0');
    const pt=document.querySelector('.print-title h2'); if(pt) pt.textContent='CardioLink Admin v3.9.0 LTS';
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
  setInterval(()=>{try{setVersion320();ensureTopSearch320();}catch(e){}},2500);
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
  function setVersion321(){try{document.title='CardioLink Admin v3.9.0 LTS'}catch(e){};document.querySelectorAll('.brand-main span').forEach(el=>el.textContent='v3.9.0');const pt=document.querySelector('.print-title h2');if(pt)pt.textContent='CardioLink Admin v3.9.0 LTS';}

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
  setInterval(()=>{try{setVersion321();ajustarBuscador321();}catch(e){}},2500);
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
    try{document.title='CardioLink Admin v3.9.0 LTS'}catch(e){}
    document.querySelectorAll('.brand-main span').forEach(el=>el.textContent='v3.9.0');
    const pt=document.querySelector('.print-title h2'); if(pt)pt.textContent='CardioLink Admin v3.9.0 LTS';
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
  const APP_VERSION='3.9.0';
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
  function isPending360(a){return !!(a&&(!a.estudioInformado||!a.estudioImpreso||a.pendienteEnvio||a.pendienteEntrega||a.bonoPendiente||a.autorizacionPendiente));}
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
    const pid=$360('welcomePerfil360')?.value||currentProfileId360();const list=profileAtt360(today360(),pid);const pending=list.filter(isPending360);
    const counts=prestationCounts360(list);const room=list.filter(a=>['sala_espera','en_sala','llego'].includes(a.estadoTurno||a.estado)).length;
    const html=[`<div class="welcome-kpi-360"><span>Turnos de hoy</span><strong>${list.length}</strong></div>`,
      ...counts.slice(0,8).map(([k,v])=>`<div class="welcome-kpi-360"><span>${esc360(k)}</span><strong>${v}</strong></div>`),
      `<div class="welcome-kpi-360 warning"><span>Pendientes</span><strong>${pending.length}</strong></div>`,
      `<div class="welcome-kpi-360"><span>En sala</span><strong>${room}</strong></div>`].join('');
    if($360('welcomeResumen360'))$360('welcomeResumen360').innerHTML=html||'<p class="muted">No hay turnos asignados para hoy.</p>';
  }
  function openWelcome360(force=false){
    const modal=$360('welcomeModal360');if(!modal)return;
    if(isLocalPreview360() && !force) return;
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
    ['Falta informe',list.filter(a=>!a.estudioInformado).length,'informe'],
    ['Falta copia',list.filter(a=>!a.copiaEstudioImpresa&&!a.estudioImpreso).length,'copia'],
    ['Falta enviar/imprimir',list.filter(a=>a.pendienteEnvio||a.pendienteEntrega||(!a.estudioImpreso&&!a.estudioEnviadoMail&&!a.estudioEnviadoWS)).length,'envio'],
    ['Falta firma/bono',list.filter(a=>a.bonoPendiente||a.bonoEstudioFirmado===false||a.bonoConsultaFirmado===false).length,'firma']
  ];}
  function openPendingFilter360(tipo){try{showSection('listado');modoPendientesGlobal=true;const sel=$360('filtroPendienteTipo300')||$360('filtroPendienteTipo');if(sel){sel.value=tipo;sel.dispatchEvent(new Event('change',{bubbles:true}));}renderTabla?.();}catch(e){console.warn(e)}}
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
    const prod=$360('produccionHoy360');if(prod){const cnt=prestationCounts360(list);prod.innerHTML=cnt.length?cnt.map(([k,v])=>`<div><span>${esc360(k)}</span><strong>${v}</strong></div>`).join(''):'<p class="muted">Sin prestaciones asignadas hoy.</p>';}
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

  function reorganizeConfig360(){const grid=document.querySelector('#config .config-grid');if(!grid)return;[...grid.children].forEach(card=>{if(card.dataset.configGroupCard==='sistema'){card.dataset.configGroup360='sistema';return;}const h=norm360(card.querySelector('h3')?.textContent||'');let g='mantenimiento';if(h.includes('profesional'))g='profesionales';if(h.includes('prestacion')||h.includes('bloque'))g='prestaciones';if(h.includes('obra social')||h.includes('regla')||h.includes('valor'))g='coberturas';if(h.includes('usuario')||h.includes('rol'))g='usuarios';if(h.includes('backup')||h.includes('mantenimiento')||h.includes('duplicado'))g='mantenimiento';card.dataset.configGroup360=g;});}
  function filterConfig360(group){document.querySelectorAll('#config .config-grid > *').forEach(x=>x.classList.toggle('config-hidden-360',group!=='todos'&&x.dataset.configGroup360!==group));document.querySelectorAll('[data-config-group]').forEach(b=>b.classList.toggle('active',b.dataset.configGroup===group));}

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
  document.addEventListener('DOMContentLoaded',()=>setTimeout(init360,1000));setTimeout(()=>{setVersion360();document.body.classList.add('app-ready-360');},1800);setInterval(setVersion360,4000);
})();


/* ===== v3.7.0 - bienvenida real, permisos y consistencia dashboard ===== */
(function(){
  function id(x){return document.getElementById(x)}
  function all(){try{return Array.isArray(atenciones)?atenciones:[]}catch(e){return []}}
  function profileName(pid){try{return (data.profesionales||[]).find(p=>p.id===pid)?.nombre||pid}catch(e){return pid}}
  function currentList(){
    const pid=id('perfilActivo')?.value||'general';
    return all().filter(a=>a&&(pid==='general'||!pid||a.profesionalId===pid||a.profesional===profileName(pid)));
  }
  function isBad(a){try{return evaluarEstado(a).cls==='bad'}catch(e){return false}}
  function refreshQuickPending362(){
    const list=currentList();
    const bad=list.filter(isBad);
    const stat=id('statPendientes');if(stat)stat.textContent=bad.length;
    const board=id('tableroPendientes360');if(!board)return;
    const firma=bad.filter(a=>(a.bonoConsulta||a.bonoEstudio)&&!a.bonoFirmado).length;
    const copia=bad.filter(a=>(a.bonoEstudio||a.requiereCopiaImpresa)&&!a.copiaImpresa).length;
    const informe=list.filter(a=>a.requiereInforme===true&&!a.estudioInformado).length;
    const envio=list.filter(a=>a.pendienteEnvio||a.pendienteEntrega).length;
    const rows=[['Falta informe',informe,'informe'],['Falta copia',copia,'copia'],['Falta enviar/imprimir',envio,'envio'],['Falta firma/bono',firma,'firma']];
    board.innerHTML=rows.map(r=>`<button type="button" onclick="openPendingFilter360('${r[2]}')"><span>${r[0]}</span><strong>${r[1]}</strong></button>`).join('');
  }
  const oldPerm=typeof aplicarPermisosUI==='function'?aplicarPermisosUI:null;
  if(oldPerm){window.aplicarPermisosUI=aplicarPermisosUI=function(){oldPerm.apply(this,arguments);const u=perfilUsuarioActual();document.querySelectorAll('.nav[data-section="caja"]').forEach(b=>b.classList.toggle('hidden-permission',!(esMatiasDuenio()||u.rol==='admin')));};}
  const oldStats=typeof renderStats==='function'?renderStats:null;
  if(oldStats){window.renderStats=renderStats=function(){const r=oldStats.apply(this,arguments);setTimeout(refreshQuickPending362,0);return r;};}
  document.addEventListener('DOMContentLoaded',()=>{
    document.body.classList.add('loading-362');
    setTimeout(()=>{document.body.classList.remove('loading-362');document.body.classList.add('app-ready-360');const b=id('btnCerrarSesion');if(b)b.style.visibility='visible';refreshQuickPending362();},1400);
  });
  document.addEventListener('change',e=>{if(e.target?.id==='perfilActivo')setTimeout(refreshQuickPending362,100)});
  setInterval(refreshQuickPending362,2500);
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
  document.addEventListener('DOMContentLoaded',initFiltrosCompactos372);
  setTimeout(initFiltrosCompactos372,400);
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
    const ats=Array.isArray(window.atenciones)?window.atenciones:[];
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
    const ats=Array.isArray(window.atenciones)?window.atenciones:[];
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
    data.hcPreparacion={schemaVersion:1,preparadoEn:new Date().toISOString(),versionApp:'3.9.0'};
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
  function attentions382(){ return Array.isArray(window.atenciones)?window.atenciones:[]; }
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
    const payload={app:'CardioLink Admin',version:'3.9.0',exportadoEn:new Date().toISOString(),resumen:{altas:r.created,ediciones:r.edited,fusiones:r.fusions,usuarios:r.users},atenciones:attentions382().map(a=>({id:a.id,pacienteId:a.pacienteId,paciente:a.paciente,creadoPor:a.creadoPor,creadoEn:a.creadoEn,editadoPor:a.editadoPor,editadoEn:a.editadoEn})),auditoriaPacientes:r.patientAudit};
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
      ['Versión','3.9.0','ok'],
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


/* ===== CardioLink Admin v3.9.0 LTS: Pendientes y calidad de datos ===== */
(function(){
  const V='383';
  let currentTab='todos';
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
  function esc383(s){return String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
  function renderPendientes383(){
    const box=document.getElementById('pendientesLista383');if(!box)return;
    let list=base383().filter(a=>pendientes383(a).length);
    const c=counts383(base383());
    document.querySelectorAll('#pendientesTabs383 [data-pendtab]').forEach(b=>{const k=b.dataset.pendtab;b.classList.toggle('active',k===currentTab);const s=b.querySelector('span');if(s)s.textContent=c[k]||0});
    const nav=document.getElementById('badgePendientesNav383');if(nav){nav.textContent=c.todos;nav.classList.toggle('zero',!c.todos)}
    if(currentTab!=='todos')list=list.filter(a=>pendientes383(a).includes(currentTab));
    const q=norm(document.getElementById('pendBuscar383')?.value);if(q)list=list.filter(a=>norm([a.paciente,a.dni,a.prestacion,a.obraSocial,a.profesional].join(' ')).includes(q));
    const desc=document.getElementById('pendOrden383')?.value==='desc';list.sort((a,b)=>(String(a.fecha||'').localeCompare(String(b.fecha||'')))*(desc?-1:1));
    if(!list.length){box.innerHTML='<div class="empty383">No hay pendientes en esta categoría.</div>';return}
    box.innerHTML=list.map(a=>{const ps=pendientes383(a);return `<article class="pend-card383"><div class="pend-main383"><div class="pend-date383">${esc383(typeof formatFecha==='function'?formatFecha(a.fecha):a.fecha)}${a.horaInicio?' · '+esc383(a.horaInicio):''}</div><h3>${esc383(a.paciente||'Paciente')}</h3><p>${esc383(a.prestacion||'')} · ${esc383(a.profesional||'')}</p><p class="muted">${esc383(a.obraSocial||'Sin cobertura')} · DNI ${esc383(a.dni||'s/d')}</p></div><div class="pend-tags383">${ps.map(k=>`<button type="button" class="pend-tag383 p-${k}" onclick="resolverPendiente383('${esc383(a.id)}','${k}')">${esc383(labels383(k))}</button>`).join('')}<button type="button" class="secondary open383" onclick="editarAtencion('${esc383(a.id)}')">Abrir</button></div></article>`}).join('');
  }
  window.renderPendientes383=renderPendientes383;
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
  if(oldShow&&!oldShow.__v383){const w=function(id){if(id==='pendientes383'){document.querySelectorAll('.section').forEach(s=>s.classList.remove('visible'));document.getElementById(id)?.classList.add('visible');document.querySelectorAll('.nav').forEach(b=>b.classList.toggle('active',b.dataset.section===id));if(document.getElementById('tituloBienvenida'))document.getElementById('tituloBienvenida').textContent='Pendientes';if(document.getElementById('subtituloPerfil'))document.getElementById('subtituloPerfil').textContent='Bandeja operativa por fecha y tipo';renderPendientes383();return}return oldShow.apply(this,arguments)};w.__v383=true;window.showSection=showSection=w;}

  // Clicks de calidad de datos: abre listado editable en modal.
  function qualityPatients383(kind){const ps=(data.pacientes||[]).filter(p=>{if(kind==='dni')return !String(p.dni||'').trim();if(kind==='cobertura')return !String(p.obraSocial||p.cobertura||'').trim()||norm(p.obraSocial||p.cobertura).includes('matias anchorena');if(kind==='contacto')return !String(p.telefono||'').trim()&&!String(p.email||'').trim()&&!String(p.telefonoContacto||'').trim()&&!String(p.emailContacto||'').trim();if(kind==='nacimiento')return !String(p.fechaNacimiento||'').trim();
if(kind==='sexo')return !String(p.sexo||'').trim();
if(kind==='localidad')return !String(p.localidad||'').trim();
if(kind==='direccion')return !String(p.direccion||'').trim();
if(kind==='provincia')return !String(p.provincia||'').trim();
return false});let m=document.getElementById('qualityModal383');if(!m){m=document.createElement('div');m.id='qualityModal383';m.className='modal-overlay-360 hidden';document.body.appendChild(m)}m.innerHTML=`<div class="quality-card383"><button class="modal-close-360" onclick="document.getElementById('qualityModal383').classList.add('hidden')">×</button><h2>Pacientes para completar</h2><p>${ps.length} registro(s)</p><div class="quality-list383">${ps.map(p=>`<div><strong>${esc383(p.apellidoNombre||p.nombreCompleto||p.nombre||'Paciente')}</strong><span>DNI ${esc383(p.dni||'s/d')} · ${esc383(p.telefono||'sin contacto')}</span><button class="secondary" onclick="document.getElementById('qualityModal383').classList.add('hidden');editarPacienteGlobal350('${esc383(typeof pacienteClave==='function'?pacienteClave(p):(p.id||p.dni))}')">Editar</button></div>`).join('')||'<p>No hay registros.</p>'}</div></div>`;m.classList.remove('hidden')}
  window.qualityPatients383=qualityPatients383;

  function bind383(){
    document.querySelectorAll('#pendientesTabs383 [data-pendtab]').forEach(b=>b.addEventListener('click',()=>{currentTab=b.dataset.pendtab;renderPendientes383()}));
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


/* ===== CardioLink Admin v3.9.0 LTS: completar fichas incompletas ===== */
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

/* ===== CardioLink Admin v3.9.0 LTS: calidad robusta + eliminación completa de paciente ===== */
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
    document.querySelectorAll('.brand-main span,.mobile-app-title-370 span').forEach(x=>x.textContent='v3.9.0');
    document.title='CardioLink Admin v3.9.0 LTS';
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>setTimeout(refrescarVersion386,300));else setTimeout(refrescarVersion386,300);
})();


/* ===== CardioLink Admin v3.9.0 LTS: abrir ficha completa desde calidad de datos ===== */
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
    document.querySelectorAll('.brand-main span,.mobile-app-title-370 span').forEach(x=>x.textContent='v3.9.0');
    document.title='CardioLink Admin v3.9.0 LTS';
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',()=>setTimeout(version387,300));
  else setTimeout(version387,300);
})();


/* ===== CardioLink Admin v3.9.0 LTS: ficha administrativa ampliada ===== */
(function init390(){
  function version390(){
    document.querySelectorAll('.brand-main span,.mobile-app-title-370 span').forEach(x=>x.textContent='v3.9.0');
    document.querySelectorAll('h2').forEach(x=>{if(/^CardioLink Admin v3\.8\.7$/.test(x.textContent.trim()))x.textContent='CardioLink Admin v3.9.0 LTS';});
    document.title='CardioLink Admin v3.9.0 LTS';
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>setTimeout(version390,500));else setTimeout(version390,500);
})();


/* ===== CardioLink Admin v3.9.0 LTS FINAL: versionado único + calidad de datos completa ===== */
(function init390LTSFinal(){
  const APP_VERSION_390='3.9.0 LTS';
  const norm390=v=>String(v??'').trim().toLowerCase();
  const esc390=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const digits390=v=>String(v??'').replace(/\D/g,'');
  const patientName390=p=>p?.apellidoNombre||p?.nombreCompleto||p?.paciente||p?.nombre||'Paciente';
  const patientKey390=p=>{try{return typeof pacienteClave==='function'?pacienteClave(p):(p?.id||p?.dni||patientName390(p));}catch{return p?.id||p?.dni||patientName390(p)}};
  const activePatients390=()=>Array.isArray(data?.pacientes)?data.pacientes.filter(p=>!p.fusionadoEn&&!p.inactivo):[];
  function badCoverage390(v){
    const x=norm390(v);
    return !x||['undefined','null','no ingresado','sin cobertura'].includes(x)||x.includes('matias anchorena')||x.includes('matías anchorena')||x.includes('rogelio anchorena')||x.includes('fernandez drago')||x.includes('fernández drago');
  }
  function missing390(p,k){
    if(k==='dni')return !digits390(p.dni);
    if(k==='cobertura')return badCoverage390(p.coberturaHabitual||p.obraSocial||p.cobertura);
    if(k==='contacto')return !String(p.telefono||'').trim()&&!String(p.email||'').trim()&&!String(p.contactoResponsableTelefono||p.telefonoContacto||'').trim()&&!String(p.contactoResponsableEmail||p.emailContacto||'').trim();
    if(k==='nacimiento')return !String(p.fechaNacimiento||'').trim();
    if(k==='sexo')return !String(p.sexo||'').trim();
    if(k==='localidad')return !String(p.localidad||'').trim();
    if(k==='direccion')return !String(p.direccion||'').trim();
    if(k==='provincia')return !String(p.provincia||'').trim();
    return false;
  }
  const labels390={dni:'Sin DNI',cobertura:'Cobertura incompleta',contacto:'Sin contacto',nacimiento:'Sin fecha de nacimiento',sexo:'Sin sexo',localidad:'Sin localidad',direccion:'Sin dirección',provincia:'Sin provincia'};
  function version390(){
    document.title='CardioLink Admin v3.9.0 LTS';
    document.querySelectorAll('.brand-main span,.mobile-app-title-370 span').forEach(el=>el.textContent='v3.9.0 LTS');
    document.querySelectorAll('h2').forEach(el=>{
      const t=String(el.textContent||'');
      if(t.includes('CardioLink Admin v')||t.includes('Instructivo CardioLink Admin v')){
        el.textContent=t.includes('Instructivo')?'Instructivo CardioLink Admin v3.9.0 LTS':'CardioLink Admin v3.9.0 LTS';
      }
    });
    document.querySelectorAll('.login-meta').forEach(el=>el.textContent='Versión 3.9.0 LTS · 2026');
  }
  function report390(){
    const ps=activePatients390();
    const ats=Array.isArray(atenciones)?atenciones.filter(a=>a?.tipoRegistro!=='config'):[];
    const counts={};Object.keys(labels390).forEach(k=>counts[k]=ps.filter(p=>missing390(p,k)).length);
    const dniMap=new Map();ps.forEach(p=>{const d=digits390(p.dni);if(d)dniMap.set(d,(dniMap.get(d)||0)+1)});
    counts.duplicados=[...dniMap.values()].filter(n=>n>1).reduce((a,n)=>a+n,0);
    counts.orphan=ats.filter(a=>!norm390(a.pacienteId)||!ps.some(p=>String(p.id||'')===String(a.pacienteId||''))).length;
    counts.noProf=ats.filter(a=>!norm390(a.profesionalId)).length;
    counts.total=ps.length;return counts;
  }
  window.renderQuality382=function(){
    const el=document.getElementById('dataQuality382');if(!el)return;
    const r=report390();
    const actionable=[['dni',r.dni],['cobertura',r.cobertura],['contacto',r.contacto],['nacimiento',r.nacimiento],['sexo',r.sexo],['localidad',r.localidad],['direccion',r.direccion],['provincia',r.provincia]];
    el.innerHTML=`<div class="quality-item-382 ok"><span>Pacientes activos</span><b>${r.total}</b></div>`+
      actionable.map(([k,n])=>`<button type="button" class="quality-item-382 quality-action-385 ${n?'warn':'ok'}" data-quality-kind="${k}"><span>${labels390[k]}</span><b>${n}</b></button>`).join('')+
      `<div class="quality-item-382 ${r.duplicados?'danger':'ok'}"><span>DNI duplicados</span><b>${r.duplicados}</b></div><div class="quality-item-382 ${r.orphan?'danger':'ok'}"><span>Atenciones sin paciente válido</span><b>${r.orphan}</b></div><div class="quality-item-382 ${r.noProf?'warn':'ok'}"><span>Atenciones sin profesional ID</span><b>${r.noProf}</b></div>`;
  };
  function osOptions390(current){
    const src=['',...(data?.obrasSociales||[]).map(x=>typeof x==='string'?x:(x?.nombre||x?.label||'')),...(data?.reglasOS||[]).map(x=>x?.nombre||x?.obraSocial||'')];
    const names=[...new Set(src.filter((x,i)=>x||i===0))];
    return names.map(n=>`<option value="${esc390(n)}" ${String(n)===String(current||'')?'selected':''}>${esc390(n||'Seleccionar cobertura')}</option>`).join('');
  }
  let kind390='dni',query390='';
  function rows390(){let ps=activePatients390().filter(p=>missing390(p,kind390));if(query390){const q=norm390(query390);ps=ps.filter(p=>norm390([patientName390(p),p.dni,p.telefono,p.email,p.localidad,p.sexo,p.coberturaHabitual,p.obraSocial].join(' ')).includes(q))}return ps.sort((a,b)=>patientName390(a).localeCompare(patientName390(b),'es'))}
  function input390(p,id){
    if(kind390==='dni')return `<input id="q390_${id}_dni" inputmode="numeric" placeholder="DNI" value="${esc390(p.dni||'')}">`;
    if(kind390==='cobertura')return `<select id="q390_${id}_cob">${osOptions390(badCoverage390(p.coberturaHabitual||p.obraSocial||p.cobertura)?'':(p.coberturaHabitual||p.obraSocial||p.cobertura))}</select>`;
    if(kind390==='nacimiento')return `<input id="q390_${id}_nac" type="date" value="${esc390(p.fechaNacimiento||'')}">`;
    if(kind390==='sexo')return `<select id="q390_${id}_sexo"><option value="">No definido</option><option value="Masculino" ${p.sexo==='Masculino'?'selected':''}>Masculino</option><option value="Femenino" ${p.sexo==='Femenino'?'selected':''}>Femenino</option><option value="Otro" ${p.sexo==='Otro'?'selected':''}>Otro</option></select>`;
    if(kind390==='localidad')return `<input id="q390_${id}_localidad" placeholder="Localidad" value="${esc390(p.localidad||'')}">`;
    if(kind390==='direccion')return `<input id="q390_${id}_direccion" placeholder="Dirección" value="${esc390(p.direccion||'')}">`;
    if(kind390==='provincia')return `<input id="q390_${id}_provincia" placeholder="Provincia" value="${esc390(p.provincia||'Buenos Aires')}">`;
    return `<div class="quality-contact384"><input id="q390_${id}_tel" inputmode="tel" placeholder="Teléfono paciente" value="${esc390(p.telefono||'')}"><input id="q390_${id}_mail" type="email" placeholder="Email paciente" value="${esc390(p.email||'')}"><input id="q390_${id}_rtel" inputmode="tel" placeholder="Teléfono responsable" value="${esc390(p.contactoResponsableTelefono||p.telefonoContacto||'')}"><input id="q390_${id}_rmail" type="email" placeholder="Email responsable" value="${esc390(p.contactoResponsableEmail||p.emailContacto||'')}"></div>`;
  }
  function renderModal390(){
    const modal=document.getElementById('qualityModal383');if(!modal)return;const ps=rows390();
    modal.innerHTML=`<div class="quality-card383 quality-card384"><button class="modal-close-360" type="button" id="closeQuality390">×</button><h2>Completar fichas de pacientes</h2><div class="quality-toolbar384"><label>Dato faltante<select id="qualityKind390">${Object.entries(labels390).map(([k,l])=>`<option value="${k}" ${kind390===k?'selected':''}>${l}</option>`).join('')}</select></label><label>Buscar<input id="qualitySearch390" type="search" placeholder="Apellido, nombre o DNI" value="${esc390(query390)}"></label></div><p><strong>${ps.length}</strong> paciente(s) en “${labels390[kind390]}”. Completá el dato y guardá.</p><div class="quality-list384">${ps.map(p=>{const raw=String(p.id||patientKey390(p));const id=raw.replace(/[^a-zA-Z0-9_-]/g,'_');return `<article class="quality-row384" data-patient-key="${esc390(raw)}"><div class="quality-patient384"><strong>${esc390(patientName390(p))}</strong><span>DNI ${esc390(p.dni||'s/d')} · ${esc390(p.telefono||'sin teléfono')} · ${esc390(p.coberturaHabitual||p.obraSocial||'sin cobertura')}</span></div><div class="quality-edit384">${input390(p,id)}</div><div class="quality-actions384"><button class="primary save-quality390" type="button" data-id="${esc390(raw)}" data-dom-id="${id}">Guardar</button><button class="secondary open-quality390" type="button" data-key="${esc390(patientKey390(p))}">Abrir ficha completa</button>${typeof window.eliminarPacienteCompleto386==='function'?`<button class="danger delete-quality390" type="button" data-key="${esc390(patientKey390(p))}">Eliminar paciente</button>`:''}</div></article>`}).join('')||'<div class="empty383">No hay pacientes pendientes en esta categoría.</div>'}</div></div>`;
    document.getElementById('closeQuality390')?.addEventListener('click',()=>modal.classList.add('hidden'));
    document.getElementById('qualityKind390')?.addEventListener('change',e=>{kind390=e.target.value;query390='';renderModal390()});
    document.getElementById('qualitySearch390')?.addEventListener('input',e=>{query390=e.target.value;renderModal390()});
    modal.querySelectorAll('.save-quality390').forEach(b=>b.addEventListener('click',()=>save390(b.dataset.id,b.dataset.domId)));
    modal.querySelectorAll('.open-quality390').forEach(b=>b.addEventListener('click',()=>{modal.classList.add('hidden');window.abrirFichaCompletaCalidad387?.(b.dataset.key)}));
    modal.querySelectorAll('.delete-quality390').forEach(b=>b.addEventListener('click',()=>window.eliminarPacienteCompleto386?.(b.dataset.key)));
  }
  function save390(rawId,domId){
    const p=activePatients390().find(x=>String(x.id||patientKey390(x))===String(rawId));if(!p)return;
    const val=s=>document.getElementById(s)?.value||'';
    if(kind390==='dni')p.dni=val(`q390_${domId}_dni`).trim();
    if(kind390==='cobertura'){const v=val(`q390_${domId}_cob`);p.coberturaHabitual=v;p.obraSocial=v;p.cobertura=v;}
    if(kind390==='nacimiento')p.fechaNacimiento=val(`q390_${domId}_nac`);
    if(kind390==='sexo')p.sexo=val(`q390_${domId}_sexo`);
    if(kind390==='localidad')p.localidad=val(`q390_${domId}_localidad`).trim();
    if(kind390==='direccion')p.direccion=val(`q390_${domId}_direccion`).trim();
    if(kind390==='provincia')p.provincia=val(`q390_${domId}_provincia`).trim()||'Buenos Aires';
    if(kind390==='contacto'){p.telefono=val(`q390_${domId}_tel`).trim();p.email=val(`q390_${domId}_mail`).trim();p.contactoResponsableTelefono=val(`q390_${domId}_rtel`).trim();p.contactoResponsableEmail=val(`q390_${domId}_rmail`).trim();}
    p.actualizadoEn=new Date().toISOString();
    try{saveConfig?.();saveAtenciones?.();renderPacientesPanel?.('',true)}catch(e){console.error(e)}
    window.renderQuality382();renderModal390();
  }
  window.qualityPatients383=function(kind='dni'){
    if(!Object.prototype.hasOwnProperty.call(labels390,kind))kind='dni';kind390=kind;query390='';
    let modal=document.getElementById('qualityModal383');if(!modal){modal=document.createElement('div');modal.id='qualityModal383';modal.className='modal-overlay-360 hidden';document.body.appendChild(modal)}
    renderModal390();modal.classList.remove('hidden');modal.style.zIndex='10040';
  };
  document.addEventListener('click',e=>{
    const btn=e.target?.closest?.('[data-quality-kind]');
    if(btn){e.preventDefault();e.stopImmediatePropagation();window.qualityPatients383(btn.dataset.qualityKind);return;}
    if(e.target?.closest?.('#btnRefreshQuality382')){e.preventDefault();e.stopImmediatePropagation();window.renderQuality382();window.qualityPatients383('dni');}
  },true);
  function boot390(){version390();window.renderQuality382();setTimeout(version390,800);setTimeout(version390,2200)}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot390);else boot390();
})();

/* ===== CardioLink Admin v3.9.0 LTS HOTFIX 2: calidad persistente y version estable ===== */
(function qualityHotfix3902(){
  const VERSION='3.9.0 LTS';
  const labels={dni:'Sin DNI',cobertura:'Cobertura incompleta',contacto:'Sin teléfono / contacto',nacimiento:'Sin fecha de nacimiento',sexo:'Sin sexo',localidad:'Sin localidad',direccion:'Sin dirección',provincia:'Sin provincia'};
  const norm=v=>String(v??'').trim().toLowerCase();
  const digits=v=>String(v??'').replace(/\D/g,'');
  let rendering=false;

  function patients(){
    try{return Array.isArray(data?.pacientes)?data.pacientes.filter(p=>!p?.fusionadoEn&&!p?.inactivo):[];}catch(e){return [];}
  }
  function badCoverage(v){
    const s=norm(v);
    return !s||['undefined','null','no ingresado','sin cobertura','s/d'].includes(s)||s.includes('matias anchorena')||s.includes('matías anchorena')||s.includes('rogelio anchorena')||s.includes('fernandez drago')||s.includes('fernández drago');
  }
  function missing(p,k){
    if(k==='dni') return !digits(p?.dni);
    if(k==='cobertura') return badCoverage(p?.coberturaHabitual||p?.obraSocial||p?.cobertura);
    if(k==='contacto') return !String(p?.telefono||p?.tel||'').trim()&&!String(p?.email||'').trim()&&!String(p?.contactoResponsableTelefono||p?.telefonoContacto||'').trim()&&!String(p?.contactoResponsableEmail||p?.emailContacto||'').trim();
    if(k==='nacimiento') return !String(p?.fechaNacimiento||'').trim();
    if(k==='sexo') return !String(p?.sexo||'').trim();
    if(k==='localidad') return !String(p?.localidad||'').trim();
    if(k==='direccion') return !String(p?.direccion||'').trim();
    if(k==='provincia') return !String(p?.provincia||'').trim();
    return false;
  }
  function enforceVersion(){
    try{document.title=`CardioLink Admin v${VERSION}`;}catch(e){}
    document.querySelectorAll('.brand-main span,.mobile-app-title-370 span').forEach(el=>el.textContent=`v${VERSION}`);
    document.querySelectorAll('.login-meta').forEach(el=>el.textContent=`Versión ${VERSION} · 2026`);
    document.querySelectorAll('h2').forEach(el=>{
      const t=String(el.textContent||'');
      if(t.includes('Instructivo CardioLink Admin v')) el.textContent=`Instructivo CardioLink Admin v${VERSION}`;
      else if(t.includes('CardioLink Admin v')) el.textContent=`CardioLink Admin v${VERSION}`;
    });
  }
  function renderCards(){
    const root=document.getElementById('dataQuality382');
    if(!root||rendering)return;
    rendering=true;
    const ps=patients();
    const entries=Object.keys(labels).map(k=>[k,ps.filter(p=>missing(p,k)).length]);
    const dniMap=new Map();ps.forEach(p=>{const d=digits(p.dni);if(d)dniMap.set(d,(dniMap.get(d)||0)+1)});
    const dup=[...dniMap.values()].filter(n=>n>1).reduce((a,n)=>a+n,0);
    root.innerHTML=`<div class="quality-item-382 ok"><span>Pacientes activos</span><b>${ps.length}</b></div>`+
      entries.map(([k,n])=>`<button type="button" class="quality-item-382 quality-action-385 ${n?'warn':'ok'}" data-quality-hotfix="${k}"><span>${labels[k]}</span><b>${n}</b></button>`).join('')+
      `<div class="quality-item-382 ${dup?'danger':'ok'}"><span>DNI duplicados</span><b>${dup}</b></div>`;
    rendering=false;
  }
  function openKind(k){
    if(typeof window.qualityPatients383==='function'){
      window.qualityPatients383(k);
    }else{
      alert('No se pudo abrir la bandeja de calidad de datos.');
    }
  }
  document.addEventListener('click',function(e){
    const b=e.target?.closest?.('[data-quality-hotfix]');
    if(!b)return;
    e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();
    openKind(b.dataset.qualityHotfix);
  },true);
  function boot(){
    enforceVersion();renderCards();
    const root=document.getElementById('dataQuality382');
    if(root){
      const obs=new MutationObserver(()=>{if(!rendering)setTimeout(renderCards,0)});
      obs.observe(root,{childList:true,subtree:true,characterData:true});
    }
    setInterval(()=>{enforceVersion();renderCards();},1500);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();
