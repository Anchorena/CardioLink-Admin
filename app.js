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
function puedeVerCajaGlobal(){ return esMatiasDuenio(); }
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
  if(section==='caja') return esMatiasDuenio();
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
  document.querySelectorAll('.solo-matias').forEach(el=>el.classList.toggle('hidden-permission',!esMatiasDuenio()));
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
      <p class="login-meta">Versión 2.8.3 · 2026</p>
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
  btn.style.left = "18px";
  btn.style.right = "auto";
  btn.style.bottom = "18px";
  btn.style.zIndex = "9999";
  btn.style.padding = "13px 18px";
  btn.style.borderRadius = "14px";
  btn.style.border = "none";
  btn.style.background = "#334155";
  btn.style.color = "white";
  btn.style.fontWeight = "800";
  btn.style.cursor = "pointer";
  btn.style.boxShadow = "0 6px 20px rgba(0,0,0,.25)";
  btn.style.fontSize = "16px";
  btn.style.minWidth = "190px";

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

async function sincronizarAtencionesSupabase(forzar = false) {
  if (!supabaseClient || !usuarioSupabase) {
    console.warn("No se sincroniza: falta Supabase o usuario.");
    return false;
  }

  if (cargandoDesdeNube && !forzar) return false;

  const rows = atencionesOperativas(atenciones || []).map(a => ({
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
let pacienteSeleccionadoPanelId=null;

const defaults={
 profesionales:[
  {id:'general',nombre:'Vista General / Administración',area:'Todos los profesionales',prestaciones:[],valores:{consulta:0,electro:0,estudio:0,copagoConsulta:0,copagoElectro:0,copagoEstudio:0}},
  {id:'matias',nombre:'Dr. Matías Anchorena',area:'Cardiología / Medicina Crítica',prestaciones:['Consulta','Electrocardiograma','ECG','Ecocardiograma Doppler','Holter','MAPA','Consulta + ECG','Consulta + Eco'],valores:{consulta:35000,electro:35000,estudio:60000,copagoConsulta:35000,copagoElectro:35000,copagoEstudio:50000}},
  {id:'rogelio',nombre:'Dr. Rogelio Anchorena',area:'Cardiología',prestaciones:['Consulta','Electrocardiograma','ECG','Ecocardiograma Doppler','Holter','MAPA','Consulta + ECG','Consulta + Eco'],valores:{consulta:35000,electro:35000,estudio:60000,copagoConsulta:35000,copagoElectro:35000,copagoEstudio:50000}},
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
data=normalizarConfigCritica(data);
try{localStorage.setItem(storageConfig,JSON.stringify(data));}catch(e){}
if(!Array.isArray(data.pacientes)) data.pacientes=[];
asegurarUsuariosConfig();
if(!Array.isArray(data.colocadores)) data.colocadores=['Geraldine','Secretaría','Otro'];
if(!data.reglasOS) data.reglasOS=structuredClone(defaults.reglasOS);
let atenciones=loadAtenciones();
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
 ['nombreCompleto','dni','telefono','email','fechaNacimiento','coberturaHabitual','numeroAfiliadoHabitual'].forEach(k=>{
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
function renderTabla(){const tbody=$('tablaAtenciones');tbody.innerHTML='';const datos=filtrar();renderResumenCaja(datos);actualizarResumenFacturaRogelio(datos);if(resumenFiltrosVisible)calcularLiquidacionColocaciones();const totalPaginas=Math.max(1,Math.ceil(datos.length/TAMANIO_PAGINA_LISTADO));if(paginaListado>totalPaginas)paginaListado=totalPaginas;if(paginaListado<1)paginaListado=1;actualizarPaginacionListado(datos.length,totalPaginas);const inicio=(paginaListado-1)*TAMANIO_PAGINA_LISTADO;const datosPagina=datos.slice(inicio,inicio+TAMANIO_PAGINA_LISTADO);if(!datos.length){tbody.innerHTML='<tr><td colspan="14">No hay registros para mostrar.</td></tr>';return}datosPagina.forEach(a=>{const e=evaluarEstado(a),m=dineroVisible(a),part=m.particular;const tr=document.createElement('tr');if(editandoId===a.id){tr.className='edit-row';tr.innerHTML=`<td><input type="date" id="e_fecha_${a.id}" value="${a.fecha||''}"></td><td><input id="e_paciente_${a.id}" value="${escapeHtml(a.paciente)}"><input id="e_obs_${a.id}" value="${escapeHtml(a.observaciones||'')}" placeholder="Obs."></td><td>${selectHTML('e_os_'+a.id,data.obrasSociales,a.obraSocial)}</td><td>${selectProfesionalesHTML('e_prof_'+a.id,a.profesionalId)}</td><td>${selectPrestacionesHTML('e_prest_'+a.id,a.profesionalId,a.prestacion)}</td><td>${selectHTML('e_consultaA_'+a.id,opcionesDestinos(a.consultaA),a.consultaA)}</td><td>${selectHTML('e_prestacionA_'+a.id,opcionesDestinos(a.prestacionA),a.prestacionA)}</td><td>${selectHTML('e_tipoCobro_'+a.id,['Sin cobro en caja','No cobrar','Copago','Particular','Particular + copago'],a.tipoCobro)}<div class="inline-checks-edit"><label><input type="checkbox" id="e_bonoConsulta_${a.id}" ${a.bonoConsulta?'checked':''}> Bono consulta</label><label><input type="checkbox" id="e_bonoEstudio_${a.id}" ${a.bonoEstudio?'checked':''}> Bono estudio</label><label><input type="checkbox" id="e_bonoFirmado_${a.id}" ${a.bonoFirmado?'checked':''}> Bono firmado</label><label><input type="checkbox" id="e_copiaImpresa_${a.id}" ${a.copiaImpresa?'checked':''}> Copia</label><label><input type="checkbox" id="e_fold2_${a.id}" ${a.fold2?'checked':''}> Fold2</label><label><input type="checkbox" id="e_planilla_${a.id}" ${a.planilla?'checked':''}> Planilla</label><label><input type="checkbox" id="e_colocacionLiquidable_${a.id}" ${a.colocacionLiquidable?'checked':''}> Colocación liquidable</label><label>Colocador/a ${selectHTML('e_colocador_'+a.id,['Geraldine','Secretaría','Otro'],a.colocador||'Geraldine')}</label></div></td><td>${selectHTML('e_formaPago_'+a.id,['No aplica','Efectivo','Transferencia','Mixto'],a.formaPago||'No aplica')}</td><td><input type="number" id="e_particular_${a.id}" value="${Number(a.montoConsulta||0)+Number(a.montoEstudio||0)}"></td><td><input type="number" id="e_copago_${a.id}" value="${Number(a.montoCopago||0)}"></td><td>${money(a.montoTotal)}</td><td class="estado-cell">${estadoHTML(a,e)}</td><td class="no-print actions-cell"><div class="edit-actions"><button class="small-btn" onclick="guardarEdicion(${idJS(a.id)})">Guardar</button><button class="small-btn" onclick="cancelarEdicion()">Cancelar</button></div></td>`}else{tr.innerHTML=`<td>${formatFecha(a.fecha)}</td><td><strong>${escapeHtml(a.paciente)}</strong>${a.observaciones?'<br><small>'+escapeHtml(a.observaciones)+'</small>':''}</td><td>${a.obraSocial}</td><td>${a.profesional}</td><td>${prestacionListado(a)}${badgeColocacion(a)}</td><td>${a.consultaA}</td><td>${a.prestacionA}</td><td>${a.tipoCobro||''}</td><td>${a.formaPago||'No aplica'}</td><td class="money-col">${money(part)}</td><td class="money-col">${money(m.copago)}</td><td class="money-col">${money(m.total)}</td><td class="estado-cell">${estadoHTML(a,e)}</td><td class="no-print actions-cell"><div class="edit-actions"><button onclick="editarAtencion(${idJS(a.id)})">Editar</button><button onclick="eliminarAtencion(${idJS(a.id)})">Borrar</button></div></td>`}tbody.appendChild(tr)})}
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
function exportarCSV(){const datos=filtrar();if(!datos.length){alert('No hay datos');return}const r=resumen(datos);const incluirValoresExport=!!$('incluirValoresImpresion')?.checked;const filas=[['CardioLink Admin v2.8.8'],['Perfil',perfilObj().nombre],['Consultas',r.consultas],['Estudios',r.estudios],[],['Fecha','Paciente','OS','Profesional','Prestación','Consulta a','Estudio a','Tipo','Forma','Particular visible','Copago visible','Total visible','Estado']];datos.forEach(a=>{const m=dineroVisible(a),e=evaluarEstado(a);filas.push([formatFecha(a.fecha),a.paciente,a.obraSocial,a.profesional,prestacionListado(a),a.consultaA,a.prestacionA,a.tipoCobro,a.formaPago,incluirValoresExport?m.particular:'',incluirValoresExport?m.copago:'',incluirValoresExport?m.total:'',e.txt])});const csv=filas.map(r=>r.map(c=>`"${String(c??'').replaceAll('"','""')}"`).join(';')).join('\n');const blob=new Blob(['\ufeff'+csv],{type:'text/csv'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='CardioLink_listado.csv';a.click()}
function exportarBackup(){const b={app:'CardioLink Admin',version:'2.8.2',fechaExportacion:new Date().toISOString(),config:data,atenciones};const blob=new Blob([JSON.stringify(b,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='CardioLink_Admin_backup.json';a.click()}
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
    <td class="agenda-actions"><button onclick="abrirAgendaModal(${a.id})">Ver</button><button onclick="cambiarEstadoAgenda(${a.id},'sala_espera')">Sala</button><button onclick="cambiarEstadoAgenda(${a.id},'en_consulta')">Atender</button><button onclick="cambiarEstadoAgenda(${a.id},'atendido')">Atendido</button></td>
  </tr>`).join('');
  cards.innerHTML=datos.map(a=>`<div class="agenda-turno-card">
    <div class="agenda-card-top"><strong>${horaTurno(a)}</strong>${estadoAgendaBadge(a)}</div>
    <h3>${escapeHtml(a.paciente||'')}</h3>
    <p>${escapeHtml(a.prestacion||'')} · ${escapeHtml(a.obraSocial||'')}</p>
    <p class="muted">${escapeHtml(a.profesional||'')}</p>
    <div class="agenda-actions"><button onclick="abrirAgendaModal(${a.id})">Ver ficha</button><button onclick="cambiarEstadoAgenda(${a.id},'sala_espera')">Sala</button><button onclick="cambiarEstadoAgenda(${a.id},'en_consulta')">Atender</button><button onclick="cambiarEstadoAgenda(${a.id},'atendido')">Atendido</button></div>
  </div>`).join('');
}
function opcionesEstadoAgendaHTML(id, actual){
  return Object.entries(ESTADOS_AGENDA).map(([k,e])=>`<button class="agenda-state-btn ${e.cls} ${actual===k?'active':''}" onclick="cambiarEstadoAgenda(${id},'${k}');abrirAgendaModal(${id});"><i></i>${e.short}</button>`).join('');
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
  <div class="agenda-actions modal-actions"><button onclick="editarAtencion(${a.id});cerrarAgendaModal();showSection('listado')">Editar atención</button></div>`;
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
      <div><span>Fecha nacimiento</span><strong>${escapeHtml(p.fechaNacimiento?formatFecha(p.fechaNacimiento):'s/d')}</strong></div>
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
      <div><label>Cobertura habitual</label><select id="pacEditCobertura">${data.obrasSociales.map(os=>`<option ${os===(p.coberturaHabitual||'')?'selected':''}>${escapeHtml(os)}</option>`).join('')}</select></div>
      <div><label>Nº afiliado habitual</label><input id="pacEditAfiliado" value="${escapeHtml(p.numeroAfiliadoHabitual||'')}"></div>
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
  p.coberturaHabitual=$('pacEditCobertura')?.value||'';
  p.numeroAfiliadoHabitual=$('pacEditAfiliado')?.value.trim()||'';
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
