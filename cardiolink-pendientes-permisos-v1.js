/* CardioLink — Pendientes permisos V1. Guardia pura: NO sustituye RLS.
 * No integrar en producción hasta cambiar la sincronización por registro
 * y validar el control de acceso también en Supabase.
 */
(function(root,factory){
  const api=factory();
  if(typeof module==='object' && module.exports) module.exports=api;
  else root.CardioLinkPendientesPermisosV1=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const ADMIN=new Set(['owner','admin','duenio']);
  const clean=x=>typeof x==='string'?x.trim():'';
  // identidad debe derivarse del backend autenticado, nunca de aliases o del DOM.
  function puedeVerPendiente(identidad,atencion){
    if(!identidad||identidad.confirmadaBackend!==true||!atencion||typeof atencion!=='object')return false;
    const rol=clean(identidad.baseRole).toLowerCase();
    if(ADMIN.has(rol))return true;
    if(rol==='secretaria'){
      if(identidad.secretariaGlobal===true)return true;
      return Array.isArray(identidad.profesionalesAutorizados)&&
        identidad.profesionalesAutorizados.some(pid=>clean(pid)!==''&&clean(pid)===clean(atencion.profesionalId));
    }
    if(rol!=='medico')return false;
    const pid=clean(identidad.professionalId);
    // cajaPerfil identifica asignación económica, no autoriza acceso clínico.
    return pid!==''&&pid===clean(atencion.profesionalId);
  }
  function puedeResolverPendiente(identidad,atencion,tipo,tiposActivos){
    return puedeVerPendiente(identidad,atencion)&&
      typeof tipo==='string'&&tipo.trim()!==''&&
      Array.isArray(tiposActivos)&&tiposActivos.includes(tipo);
  }
  return Object.freeze({puedeVerPendiente,puedeResolverPendiente});
});
