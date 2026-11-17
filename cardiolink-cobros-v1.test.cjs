// Pruebas de contrato de Pendientes de cobro V1. Ejecutar: node --test
// (en este repo sin Node se corren con JavaScriptCore; ver docs/QA.md).
const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs');
const path=require('node:path');
const cobros=require('./cardiolink-cobros-v1.js');
const finanzas=require('./cardiolink-finanzas-v5.js');
const leer=f=>fs.readFileSync(path.join(__dirname,f),'utf8');

const AHORA='2026-10-21T15:00:00.000Z';
const base=(extra={})=>Object.assign({id:'a1',fecha:'2026-10-21',paciente:'Paciente Sintético',profesionalId:'matias',cajaPerfil:'matias',
  obraSocial:'Particular',prestacion:'Consulta',tipoCobro:'Particular',formaPago:'Efectivo',montoConsulta:35000,montoEstudio:0,montoCopago:0,montoTotal:35000,noCobrar:false,estadoTurno:'reservado'},extra);

/* ---------- lógica pura ---------- */
test('atenciones históricas (sin estadoCobro) no cambian: ni pendientes ni recalculadas',()=>{
  const h=base();
  assert.equal(cobros.estadoCobroDe(h),'historico');
  assert.equal(cobros.esCobroPendiente(h),false);
  const cajaOriginal={particular:35000,copago:0,total:35000};
  assert.deepEqual(cobros.cobroEfectivoSegunEstado(h,cajaOriginal),cajaOriginal);
  assert.equal(cobros.estadoCobroDe({estadoCobro:'cualquier cosa'}),'historico');
});
test('atención nueva: pendiente explícito, formaPago "No aplica" hasta confirmar',()=>{
  const a=cobros.asignarEstadoCobroNuevo(base(),{pendiente:true,usuario:'Secretaría',ahora:AHORA});
  assert.equal(a.estadoCobro,'pendiente');
  assert.equal(a.formaPago,'No aplica');
  assert.equal(a.cobroPendienteEn,AHORA);
  assert.equal(a.cobroPendientePor,'Secretaría');
  assert.equal(a.cobroAuditoria.length,1);
  assert.equal(a.montoConsulta,35000,'el importe esperado se conserva');
  assert.equal(cobros.esCobroPendiente(a),true);
});
test('atención nueva sin marcar pendiente queda cobrada con trazabilidad',()=>{
  const a=cobros.asignarEstadoCobroNuevo(base(),{usuario:'Secretaría',ahora:AHORA});
  assert.equal(a.estadoCobro,'cobrado');
  assert.equal(a.cobroMedioPago,'Efectivo');
  assert.equal(a.cobroConfirmadoPor,'Secretaría');
  assert.equal(a.formaPago,'Efectivo');
});
test('sin importe cobrable no existe pendiente aunque se pida (OS sin copago, No cobrar, Sin cobro en caja)',()=>{
  const os=cobros.asignarEstadoCobroNuevo(base({obraSocial:'OSDE',tipoCobro:'Sin cobro en caja',montoConsulta:0,formaPago:'No aplica'}),{pendiente:true,ahora:AHORA});
  assert.equal(os.estadoCobro,'sin_cobro');
  const nc=cobros.asignarEstadoCobroNuevo(base({noCobrar:true,tipoCobro:'No cobrar'}),{pendiente:true,ahora:AHORA});
  assert.equal(nc.estadoCobro,'sin_cobro');
  const cero=cobros.asignarEstadoCobroNuevo(base({tipoCobro:'Copago',montoConsulta:0,montoCopago:0}),{pendiente:true,ahora:AHORA});
  assert.equal(cero.estadoCobro,'sin_cobro');
  const copago=cobros.asignarEstadoCobroNuevo(base({obraSocial:'IOMA',tipoCobro:'Copago',montoConsulta:0,montoCopago:8000}),{pendiente:true,ahora:AHORA});
  assert.equal(copago.estadoCobro,'pendiente');
});
test('Caja: el pendiente aporta 0; al confirmar aporta una sola vez',()=>{
  const pend=cobros.asignarEstadoCobroNuevo(base(),{pendiente:true,ahora:AHORA});
  const caja={particular:35000,copago:0,total:35000};
  assert.deepEqual(cobros.cobroEfectivoSegunEstado(pend,caja),{particular:0,copago:0,total:0});
  const r=cobros.confirmarCobro(pend,{medio:'Transferencia',usuario:'Secretaría',ahora:AHORA});
  assert.equal(r.ok,true);
  assert.deepEqual(cobros.cobroEfectivoSegunEstado(r.payload,caja),caja);
});
test('confirmar: fecha, usuario, rol y medio; no muta el original; conserva el monto',()=>{
  const pend=cobros.asignarEstadoCobroNuevo(base(),{pendiente:true,ahora:'2026-10-21T10:00:00.000Z'});
  const copia=JSON.stringify(pend);
  const r=cobros.confirmarCobro(pend,{medio:'Débito',usuario:'Geraldine',usuarioId:'uid-1',rol:'secretaria',email:'sec@qa.test',ahora:AHORA});
  assert.equal(JSON.stringify(pend),copia,'no debe mutar la entrada');
  assert.equal(r.yaConfirmado,false);
  const p=r.payload;
  assert.equal(p.estadoCobro,'cobrado');
  assert.equal(p.formaPago,'Débito');
  assert.equal(p.cobroMedioPago,'Débito');
  assert.equal(p.cobroConfirmadoEn,AHORA);
  assert.equal(p.cobroConfirmadoPor,'Geraldine');
  assert.equal(p.cobroConfirmadoPorId,'uid-1');
  assert.equal(p.cobroConfirmadoPorRol,'secretaria');
  assert.equal(p.cobroConfirmadoPorEmail,'sec@qa.test');
  assert.equal(p.cobroAuditoria[1].email,'sec@qa.test');
  assert.equal(p.cobroConfirmadoPorEmail,'sec@qa.test');
  assert.equal(p.cobroAuditoria.length,2);
  assert.equal(p.montoConsulta,35000);
});
test('confirmar es idempotente: la segunda vez no cambia nada ni pisa quién/cuándo',()=>{
  const pend=cobros.asignarEstadoCobroNuevo(base(),{pendiente:true,ahora:AHORA});
  const primera=cobros.confirmarCobro(pend,{medio:'Efectivo',usuario:'A',ahora:AHORA}).payload;
  const segunda=cobros.confirmarCobro(primera,{medio:'Transferencia',usuario:'B',ahora:'2026-10-22T00:00:00.000Z'});
  assert.equal(segunda.ok,true);
  assert.equal(segunda.yaConfirmado,true);
  assert.equal(segunda.payload,primera,'devuelve la misma versión, sin reescribir');
  assert.equal(segunda.payload.cobroConfirmadoPor,'A');
  assert.equal(segunda.payload.cobroMedioPago,'Efectivo');
  assert.equal(segunda.payload.cobroAuditoria.length,2);
});
test('confirmar rechaza: histórica, sin_cobro, medio inválido, cancelada/ausente, inexistente',()=>{
  assert.equal(cobros.confirmarCobro(base(),{medio:'Efectivo'}).codigo,'no_pendiente');
  assert.equal(cobros.confirmarCobro({estadoCobro:'sin_cobro'},{medio:'Efectivo'}).codigo,'no_pendiente');
  const pend=cobros.asignarEstadoCobroNuevo(base(),{pendiente:true,ahora:AHORA});
  assert.equal(cobros.confirmarCobro(pend,{medio:'Bitcoin'}).codigo,'medio_invalido');
  assert.equal(cobros.confirmarCobro(pend,{medio:''}).codigo,'medio_invalido');
  assert.equal(cobros.confirmarCobro(pend,{medio:'No aplica'}).codigo,'medio_invalido');
  assert.equal(cobros.confirmarCobro(Object.assign({},pend,{estadoTurno:'cancelado'}),{medio:'Efectivo'}).codigo,'atencion_no_vigente');
  assert.equal(cobros.confirmarCobro(Object.assign({},pend,{estadoTurno:'ausente'}),{medio:'Efectivo'}).codigo,'atencion_no_vigente');
  assert.equal(cobros.confirmarCobro(null,{medio:'Efectivo'}).codigo,'inexistente');
});
test('un pendiente de una atención cancelada/ausente no figura como cobro pendiente',()=>{
  const pend=cobros.asignarEstadoCobroNuevo(base(),{pendiente:true,ahora:AHORA});
  assert.equal(cobros.esCobroPendiente(Object.assign({},pend,{estadoTurno:'cancelado'})),false);
  assert.equal(cobros.esCobroPendiente(Object.assign({},pend,{estadoTurno:'ausente'})),false);
  assert.equal(cobros.esCobroPendiente({tipoRegistro:'mensaje',estadoCobro:'pendiente'}),false);
});
test('permisos: confirman Secretaría/Admin/Dueño; el médico no; sin rol no',()=>{
  ['secretaria','admin','duenio','owner'].forEach(r=>assert.equal(cobros.rolPuedeConfirmarCobro(r),true,r));
  ['medico','sin_configurar','','otro',undefined,null].forEach(r=>assert.equal(cobros.rolPuedeConfirmarCobro(r),false,String(r)));
  assert.equal(cobros.rolVeTotalesPorProfesional('secretaria'),false,'Secretaría no ve totales de Caja');
  assert.equal(cobros.rolVeTotalesPorProfesional('admin'),true);
});
test('visibilidad: el médico solo ve los cobros de su propia caja',()=>{
  const propio=base({profesionalId:'rogelio',cajaPerfil:'rogelio'});
  const ajeno=base({profesionalId:'matias',cajaPerfil:'matias'});
  const derivado=base({profesionalId:'matias',cajaPerfil:'rogelio'});
  assert.equal(cobros.puedeVerCobroPendiente('medico','rogelio',propio),true);
  assert.equal(cobros.puedeVerCobroPendiente('medico','rogelio',ajeno),false);
  assert.equal(cobros.puedeVerCobroPendiente('medico','rogelio',derivado),true,'la caja la define cajaPerfil');
  assert.equal(cobros.puedeVerCobroPendiente('medico','',propio),false);
  assert.equal(cobros.puedeVerCobroPendiente('secretaria','',ajeno),true);
  assert.equal(cobros.puedeVerCobroPendiente('sin_configurar','matias',ajeno),false);
});
test('separación económica: agrupa y suma por cajaPerfil, sin mezclar profesionales',()=>{
  const lista=[base({id:'1',cajaPerfil:'matias',montoConsulta:10000}),base({id:'2',cajaPerfil:'rogelio',profesionalId:'rogelio',montoConsulta:20000}),
    base({id:'3',cajaPerfil:'matias',montoConsulta:0,montoEstudio:5000})];
  const g=cobros.agruparPorCaja(lista);
  assert.equal(g.length,2);
  assert.equal(g[0].id,'matias');assert.equal(g[0].total,15000);assert.equal(g[0].items.length,2);
  assert.equal(g[1].id,'rogelio');assert.equal(g[1].total,20000);
});

/* ---------- Finanzas V5 ---------- */
test('Finanzas V5: el pendiente no suma a caja cobrada ni a medios de pago, pero cuenta como realizada',()=>{
  const lista=[
    base({id:'h',fecha:'2026-10-05',montoConsulta:35000}),
    cobros.asignarEstadoCobroNuevo(base({id:'p',fecha:'2026-10-06',montoConsulta:50000}),{pendiente:true,ahora:AHORA}),
    cobros.confirmarCobro(cobros.asignarEstadoCobroNuevo(base({id:'c',fecha:'2026-10-07',montoConsulta:20000}),{pendiente:true,ahora:AHORA}),{medio:'Transferencia',usuario:'S',ahora:AHORA}).payload
  ];
  const r=finanzas.calcularIngresosCanonicos({atenciones:lista,desde:'2026-10-01',hasta:'2026-10-31',perfil:'',tipoPrestacion:()=>'CONSULTA'});
  assert.equal(r.cajaCobrada.total,55000,'35.000 histórica + 20.000 confirmada; el pendiente de 50.000 no entra');
  assert.equal(r.mediosPago.Efectivo,35000);
  assert.equal(r.mediosPago.Transferencia,20000);
  assert.equal(r.mediosPago['No aplica'],0);
  assert.equal(r.desglose.consultas.cantidad,3,'las 3 prestaciones fueron realizadas');
  assert.equal(r.desglose.consultas.particulares,55000);
});
test('Finanzas V5: confirmar un cobro no lo cuenta dos veces',()=>{
  const pend=cobros.asignarEstadoCobroNuevo(base({montoConsulta:50000}),{pendiente:true,ahora:AHORA});
  const conf=cobros.confirmarCobro(pend,{medio:'Efectivo',usuario:'S',ahora:AHORA}).payload;
  const otra=cobros.confirmarCobro(conf,{medio:'Efectivo',usuario:'S',ahora:AHORA}).payload;
  const f=l=>finanzas.calcularIngresosCanonicos({atenciones:[l],desde:'2026-10-01',hasta:'2026-10-31',perfil:''}).cajaCobrada.total;
  assert.equal(f(pend),0);assert.equal(f(conf),50000);assert.equal(f(otra),50000);
});
test('Finanzas V5: la caja de cada profesional queda separada (perfil)',()=>{
  const m=cobros.asignarEstadoCobroNuevo(base({id:'m',cajaPerfil:'matias',montoConsulta:10000}),{ahora:AHORA});
  const rp=cobros.asignarEstadoCobroNuevo(base({id:'r',profesionalId:'rogelio',cajaPerfil:'rogelio',montoConsulta:20000}),{pendiente:true,ahora:AHORA});
  const f=perfil=>finanzas.calcularIngresosCanonicos({atenciones:[m,rp],desde:'2026-10-01',hasta:'2026-10-31',perfil}).cajaCobrada.total;
  assert.equal(f('matias'),10000);assert.equal(f('rogelio'),0);assert.equal(f(''),10000);
});

/* ---------- fecha de cobro: el dinero entra el día del pago ---------- */
const PAGO_OCT=new Date(2026,9,21,10,0,0).toISOString();   // 21/10/2026 hora local
const ALTA_SEP=new Date(2026,8,10,9,0,0).toISOString();    // 10/09/2026 hora local
const diferido=(extra={})=>{
  const pend=cobros.asignarEstadoCobroNuevo(base(Object.assign({id:'d1',fecha:'2026-09-10',montoConsulta:40000},extra)),{pendiente:true,ahora:ALTA_SEP});
  return cobros.confirmarCobro(pend,{medio:'Transferencia',usuario:'S',ahora:PAGO_OCT}).payload;
};
const fin=(lista,desde,hasta,perfil='')=>finanzas.calcularIngresosCanonicos({atenciones:lista,desde,hasta,perfil,tipoPrestacion:()=>'CONSULTA'});
test('fecha de cobro: pendiente confirmado luego usa el día del pago; el resto usa la fecha de la atención',()=>{
  assert.equal(cobros.fechaCobroAtencion(diferido()),'2026-10-21');
  assert.equal(cobros.fechaCobroAtencion(base()),'2026-10-21','histórica: fecha de la atención');
  const alRegistrar=cobros.asignarEstadoCobroNuevo(base({fecha:'2026-09-10'}),{ahora:PAGO_OCT});
  assert.equal(cobros.fechaCobroAtencion(alRegistrar),'2026-09-10','cobrada al registrar: fecha de la atención');
  assert.equal(cobros.fechaCobroAtencion(cobros.asignarEstadoCobroNuevo(base({fecha:'2026-09-10'}),{pendiente:true,ahora:ALTA_SEP})),'2026-09-10');
});
test('fecha de cobro: el cálculo del módulo y el de Finanzas V5 coinciden',()=>{
  [diferido(),base(),cobros.asignarEstadoCobroNuevo(base(),{ahora:AHORA}),{estadoCobro:'cobrado',cobroPendienteEn:'x',cobroConfirmadoEn:'no-es-fecha',fecha:'2026-09-01'}]
    .forEach(a=>assert.equal(cobros.fechaCobroAtencion(a),finanzas.fechaCobroAtencion(a)));
});
test('períodos históricos intactos: septiembre no cambia cuando el pago llega en octubre',()=>{
  const sepAntes=fin([Object.assign({},diferido(),{estadoCobro:'pendiente'})],'2026-09-01','2026-09-30');
  const sepDespues=fin([diferido()],'2026-09-01','2026-09-30');
  assert.equal(sepAntes.cajaCobrada.total,0);
  assert.equal(sepDespues.cajaCobrada.total,0,'el período histórico sigue en 0 aunque ya se cobró');
  assert.equal(sepDespues.desglose.consultas.cantidad,1,'la prestación sigue contando como realizada en septiembre');
  assert.equal(sepDespues.mediosPago.Transferencia,0);
});
test('octubre recibe el dinero del pago, una sola vez, sin inflar la actividad',()=>{
  const oct=fin([diferido()],'2026-10-01','2026-10-31');
  assert.equal(oct.cajaCobrada.total,40000);
  assert.equal(oct.mediosPago.Transferencia,40000);
  assert.equal(oct.desglose.consultas.cantidad,0,'la prestación es de septiembre');
  assert.equal(oct.desglose.consultas.particulares,40000);
  const anio=fin([diferido()],'2026-01-01','2026-12-31');
  assert.equal(anio.cajaCobrada.total,40000,'en un rango que abarca ambas fechas cuenta una sola vez');
  assert.equal(anio.desglose.consultas.cantidad,1);
  assert.equal(fin([diferido()],'2026-10-22','2026-10-31').cajaCobrada.total,0);
});
test('fecha de cobro respeta la caja por profesional',()=>{
  const d=diferido({cajaPerfil:'rogelio',profesionalId:'rogelio'});
  assert.equal(fin([d],'2026-10-01','2026-10-31','rogelio').cajaCobrada.total,40000);
  assert.equal(fin([d],'2026-10-01','2026-10-31','matias').cajaCobrada.total,0);
});

/* ---------- integración con app.js (instalar) con un window simulado ---------- */
function crearEntorno(opts={}){
  const filas=new Map();
  const log={updates:0,selects:0};
  const hooks={};
  // Cliente Supabase simulado: select por id y UPDATE condicionado por updated_at.
  const consulta=()=>{
    const st={op:'select',filtros:{},cuerpo:null};
    const b={
      select(){ return b; },
      update(cuerpo){ st.op='update'; st.cuerpo=cuerpo; return b; },
      eq(k,v){ st.filtros[k]=v; return b; },
      limit(){ return b; },
      then(res,rej){
        return Promise.resolve().then(()=>{
          if(opts.errorRed)return {data:null,error:{message:'sin red'}};
          const f=filas.get(String(st.filtros.id));
          if(st.op==='select'){
            log.selects++;
            const r={data:f?[{id:st.filtros.id,payload:JSON.parse(JSON.stringify(f.payload)),updated_at:f.updated_at}]:[],error:null};
            if(hooks.trasLeer){const h=hooks.trasLeer;hooks.trasLeer=null;h(filas);}
            return r;
          }
          if(opts.rechazoGuard)return {data:null,error:{code:'42501',message:'Rol no autorizado para modificar el estado de cobro'}};
          if(!f||f.updated_at!==st.filtros.updated_at)return {data:[],error:null};
          f.payload=JSON.parse(JSON.stringify(st.cuerpo.payload));
          f.updated_at=st.cuerpo.updated_at;
          log.updates++;
          return {data:[{id:st.filtros.id,updated_at:f.updated_at}],error:null};
        }).then(res,rej);
      }
    };
    return b;
  };
  const cliente={from:()=>consulta()};
  const w={
    document:{getElementById:()=>null,querySelectorAll:()=>[],createElement:()=>({}),head:{appendChild(){}}},
    localStorage:{setItem(){}},
    money:n=>'$'+n,
    rolBaseUsuarioActual:()=>opts.rol||'secretaria',
    perfilUsuarioActual:()=>({nombre:opts.nombre||'Secretaria QA'}),
    profesionalIdUsuarioActual:()=>opts.pid||'',
    hayPendientesSync298:()=>!!opts.sinSincronizar,
    sincronizarAtencionesSupabase:async()=>true,
    confirmarVersionRemotaAtencion298(){},
    saveAtenciones(){}
  };
  return {w,filas,log,hooks,cliente};
}
async function conEntorno(opts,fn){
  const env=crearEntorno(opts);
  const g=globalThis;
  const previo={a:g.atenciones,s:g.supabaseClient,u:g.usuarioSupabase,st:g.storageAtenciones,d:g.data};
  g.atenciones=[];g.supabaseClient=opts.local?null:env.cliente;g.usuarioSupabase=opts.local?null:{id:'uid-qa'};g.storageAtenciones='k';g.data={profesionales:[]};
  try{
    cobros.instalar(env.w);
    return await fn(env);
  }finally{
    g.atenciones=previo.a;g.supabaseClient=previo.s;g.usuarioSupabase=previo.u;g.storageAtenciones=previo.st;g.data=previo.d;
  }
}
const sembrar=(env,pend)=>{
  env.filas.set(String(pend.id),{payload:JSON.parse(JSON.stringify(pend)),updated_at:'v0'});
  globalThis.atenciones.push(JSON.parse(JSON.stringify(pend)));
};

test('instalar: la casilla y el panel ausentes del DOM no rompen (módulo tolerante)',async()=>{
  await conEntorno({},async(env)=>{ assert.equal(typeof env.w.CardioLinkCobrosV1Panel.confirmarCobroPersistido,'function'); });
});
test('persistencia: confirma con UPDATE condicionado y deja la fila cobrada',async()=>{
  await conEntorno({},async(env)=>{
    const pend=cobros.asignarEstadoCobroNuevo(base(),{pendiente:true,ahora:AHORA});
    sembrar(env,pend);
    const r=await env.w.CardioLinkCobrosV1Panel.confirmarCobroPersistido('a1','Efectivo');
    assert.equal(r.ok,true);assert.equal(r.yaConfirmado,false);
    assert.equal(env.filas.get('a1').payload.estadoCobro,'cobrado');
    assert.equal(env.filas.get('a1').payload.cobroConfirmadoPorId,'uid-qa');
    assert.equal(env.log.updates,1);
    assert.equal(globalThis.atenciones[0].estadoCobro,'cobrado','la copia local adopta lo confirmado');
  });
});
test('doble clic: dos confirmaciones simultáneas escriben una sola vez',async()=>{
  await conEntorno({},async(env)=>{
    sembrar(env,cobros.asignarEstadoCobroNuevo(base(),{pendiente:true,ahora:AHORA}));
    const P=env.w.CardioLinkCobrosV1Panel;
    const [r1,r2]=await Promise.all([P.confirmarCobroPersistido('a1','Efectivo'),P.confirmarCobroPersistido('a1','Efectivo')]);
    assert.equal([r1,r2].filter(r=>r.ok).length,1);
    assert.equal([r1,r2].filter(r=>r.codigo==='en_curso').length,1);
    assert.equal(env.log.updates,1);
  });
});
test('dos sesiones: la segunda confirmación no vuelve a escribir (idempotente)',async()=>{
  await conEntorno({},async(env)=>{
    sembrar(env,cobros.asignarEstadoCobroNuevo(base(),{pendiente:true,ahora:AHORA}));
    const P=env.w.CardioLinkCobrosV1Panel;
    const primera=await P.confirmarCobroPersistido('a1','Efectivo');
    assert.equal(primera.ok,true,JSON.stringify(primera));
    assert.equal(env.filas.get('a1').payload.estadoCobro,'cobrado','tras la primera: '+JSON.stringify(env.filas.get('a1')));
    // La "otra sesión" todavía veía el pendiente en su copia local.
    globalThis.atenciones[0]=cobros.asignarEstadoCobroNuevo(base(),{pendiente:true,ahora:AHORA});
    const r=await P.confirmarCobroPersistido('a1','Transferencia');
    assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.yaConfirmado,true,JSON.stringify(r));
    assert.equal(env.log.updates,1,'no hubo una segunda escritura');
    assert.equal(env.filas.get('a1').payload.cobroMedioPago,'Efectivo','gana la primera confirmación');
    assert.equal(globalThis.atenciones[0].estadoCobro,'cobrado','la copia local se corrige');
  });
});
test('conflicto: si otra sesión modificó la fila entre lectura y escritura, se relee y se conserva su cambio',async()=>{
  await conEntorno({},async(env)=>{
    sembrar(env,cobros.asignarEstadoCobroNuevo(base(),{pendiente:true,ahora:AHORA}));
    env.hooks.trasLeer=(filas)=>{const f=filas.get('a1');f.payload.estadoTurno='confirmado';f.updated_at='v-otra-sesion';};
    const r=await env.w.CardioLinkCobrosV1Panel.confirmarCobroPersistido('a1','Efectivo');
    assert.equal(r.ok,true);
    const fila=env.filas.get('a1').payload;
    assert.equal(fila.estadoCobro,'cobrado');
    assert.equal(fila.estadoTurno,'confirmado','el cambio concurrente ajeno no se pisa');
    assert.equal(env.log.updates,1);
  });
});
test('permiso: un médico no puede confirmar (no escribe nada)',async()=>{
  await conEntorno({rol:'medico',pid:'matias'},async(env)=>{
    sembrar(env,cobros.asignarEstadoCobroNuevo(base(),{pendiente:true,ahora:AHORA}));
    const r=await env.w.CardioLinkCobrosV1Panel.confirmarCobroPersistido('a1','Efectivo');
    assert.equal(r.ok,false);assert.equal(r.codigo,'sin_permiso');
    assert.equal(env.log.updates,0);assert.equal(env.log.selects,0);
    assert.equal(env.filas.get('a1').payload.estadoCobro,'pendiente');
  });
});
test('cambios locales sin sincronizar: no se confirma (evita perder la edición local)',async()=>{
  await conEntorno({sinSincronizar:true},async(env)=>{
    sembrar(env,cobros.asignarEstadoCobroNuevo(base(),{pendiente:true,ahora:AHORA}));
    const r=await env.w.CardioLinkCobrosV1Panel.confirmarCobroPersistido('a1','Efectivo');
    assert.equal(r.codigo,'sync_pendiente');assert.equal(env.log.updates,0);
  });
});
test('error de red: informa y no marca cobrado',async()=>{
  await conEntorno({errorRed:true},async(env)=>{
    sembrar(env,cobros.asignarEstadoCobroNuevo(base(),{pendiente:true,ahora:AHORA}));
    const r=await env.w.CardioLinkCobrosV1Panel.confirmarCobroPersistido('a1','Efectivo');
    assert.equal(r.ok,false);assert.equal(r.codigo,'error_red');
    assert.equal(env.filas.get('a1').payload.estadoCobro,'pendiente');
    assert.equal(globalThis.atenciones[0].estadoCobro,'pendiente');
  });
});
test('medio inválido y fila inexistente se rechazan sin escribir',async()=>{
  await conEntorno({},async(env)=>{
    sembrar(env,cobros.asignarEstadoCobroNuevo(base(),{pendiente:true,ahora:AHORA}));
    const P=env.w.CardioLinkCobrosV1Panel;
    assert.equal((await P.confirmarCobroPersistido('a1','Cripto')).codigo,'medio_invalido');
    assert.equal((await P.confirmarCobroPersistido('zzz','Efectivo')).codigo,'inexistente');
    assert.equal(env.log.updates,0);
  });
});

test('caja del día: un cobro confirmado hoy suma hoy aunque la prestación sea anterior',async()=>{
  await conEntorno({},async(env)=>{
    const hoy='2026-10-21';
    const d=diferido();
    const histHoy=base({id:'h',fecha:hoy,montoConsulta:10000});
    const sumar=(lista)=>lista.filter(a=>a.fecha===hoy).reduce((t,a)=>t+Number(a.montoConsulta||0),0);
    env.w.todayISO=()=>hoy;
    env.w.atencionesOperativas=()=>[d,histHoy];
    env.w.cajaHoy=function(datos){return {total:sumar(datos)};};   // simula el cajaHoy real: filtra por a.fecha === hoy
    cobros.instalar(env.w);
    assert.equal(env.w.cajaHoy([histHoy]).total,50000,'10.000 de hoy + 40.000 pagados hoy por una prestación de septiembre');
    assert.equal(env.w.cajaHoy().total,50000);
    env.w.todayISO=()=>'2026-10-22';
    assert.equal(env.w.cajaHoy([]).total,0,'mañana no vuelve a contar');
  });
});

/* ---------- contratos estáticos del cableado ---------- */
test('cableado: el módulo carga después de app.js y finanzas V5; el formulario y el panel existen',()=>{
  const html=leer('index.html');
  const iApp=html.indexOf('<script src="app.js');
  const iCobros=html.indexOf('<script src="cardiolink-cobros-v1.js');
  assert.ok(iApp>0&&iCobros>iApp,'cobros debe cargarse después de app.js');
  assert.match(html,/id="cobroPendiente"/);
  assert.match(html,/id="cobrosPendientesPanelV1"/);
  assert.equal(html.split('id="cobroPendiente"').length,2,'una sola casilla');
});
test('cableado: la regla "pendiente = 0 en caja" existe en las dos fuentes de verdad de Caja',()=>{
  const fin=leer('cardiolink-finanzas-v5.js');
  assert.match(fin,/atencion\.estadoCobro === 'pendiente'/);
  const mod=leer('cardiolink-cobros-v1.js');
  assert.match(mod,/w\.cobroEfectivoAtencion = envuelta/);
  assert.match(mod,/w\.crearAtencionDesdeFormulario = envuelta/);
});
test('el módulo no usa service_role ni claves, ni toca tablas distintas de cardiolink_atenciones',()=>{
  const mod=leer('cardiolink-cobros-v1.js');
  assert.doesNotMatch(mod,/service_role|eval\(|\.rpc\(|\.upsert\(|\)\s*\.delete\(/);
  const tablas=(mod.match(/\.from\('([a-z_]+)'\)/g)||[]).filter((v,i,a)=>a.indexOf(v)===i);
  assert.deepEqual(tablas,[".from('cardiolink_atenciones')"]);
});
test('el módulo no recalcula histórico: no recorre ni muta atenciones existentes al cargar',()=>{
  const mod=leer('cardiolink-cobros-v1.js');
  assert.doesNotMatch(mod,/atenciones\.forEach|listaAtenciones\(\)\.forEach|\.map\(\(?a\)? *=> *asignarEstadoCobroNuevo/);
});

/* ---------- contrato del SQL propuesto (no se ejecuta; evita derivas con el módulo) ---------- */
test('SQL propuesto: protege exactamente los campos de cobro que escribe el módulo',()=>{
  const sql=leer('docs/propuestas/pending_review_cobros_v1_guard_medico.sql');
  const bloque=sql.match(/c_estado constant text\[\] := ARRAY\[([^\]]*)\]/);
  assert.ok(bloque,'falta la lista de campos del guard');
  const protegidos=bloque[1].match(/'([A-Za-z]+)'/g).map(x=>x.replace(/'/g,'')).sort();
  const pendiente=cobros.asignarEstadoCobroNuevo(base(),{pendiente:true,usuario:'S',ahora:AHORA});
  const conf=cobros.confirmarCobro(pendiente,{medio:'Efectivo',usuario:'S',usuarioId:'u',rol:'secretaria',email:'s@x',ahora:AHORA}).payload;
  const escritos=Object.keys(conf).filter(k=>k==='estadoCobro'||/^cobro/.test(k)).sort();
  assert.deepEqual(escritos.filter(k=>!protegidos.includes(k)),[],'campos de cobro que el guard no protege');
  assert.deepEqual(protegidos.filter(k=>!escritos.includes(k)),[],'campos protegidos que el módulo no escribe');
});
test('SQL propuesto: UPDATE/DELETE, SECURITY INVOKER, sin TG_OP/OLD inválidos en WHEN, rol de la API y rollback exacto',()=>{
  const sql=leer('docs/propuestas/pending_review_cobros_v1_guard_medico.sql');
  const codigo=sql.replace(/^\s*--.*$/gm,'');
  assert.match(codigo,/BEFORE UPDATE ON public\.cardiolink_atenciones/);
  assert.match(codigo,/BEFORE DELETE ON public\.cardiolink_atenciones/);
  assert.doesNotMatch(codigo,/BEFORE INSERT|INSERT OR/);
  const fn=codigo.slice(codigo.indexOf('CREATE FUNCTION'),codigo.indexOf('REVOKE ALL'));
  assert.doesNotMatch(fn,/SECURITY DEFINER/);
  assert.match(fn,/current_user NOT IN \('authenticated', 'anon'\)/);
  assert.match(fn,/cardiolink_has_appointment_requests_access\(\)/);
  assert.match(fn,/ERRCODE = '42501'/);
  const when=codigo.slice(codigo.indexOf('WHEN ('),codigo.indexOf('EXECUTE FUNCTION'));
  assert.doesNotMatch(when,/TG_OP/);
  assert.match(codigo,/REVOKE ALL ON FUNCTION public\.cardiolink_atenciones_guard_cobro_v1\(\) FROM PUBLIC, anon, authenticated/);
  const rb=leer('docs/propuestas/pending_review_cobros_v1_guard_medico_rollback.sql');
  assert.match(rb,/DROP TRIGGER IF EXISTS cardiolink_atenciones_guard_cobro_v1 ON/);
  assert.match(rb,/DROP TRIGGER IF EXISTS cardiolink_atenciones_guard_cobro_v1_del ON/);
  assert.match(rb,/DROP FUNCTION IF EXISTS public\.cardiolink_atenciones_guard_cobro_v1\(\)/);
  const tests=leer('docs/propuestas/pending_review_cobros_v1_guard_medico_tests.sql');
  assert.match(tests,/ROLLBACK;\s*$/);
  assert.doesNotMatch(tests.replace(/^\s*--.*$/gm,''),/\bCOMMIT\b/);
});

test('SQL propuesto: los datos económicos congelados son los que escribe la edición de la app; fecha/OS no',()=>{
  const sql=leer('docs/propuestas/pending_review_cobros_v1_guard_medico.sql');
  const m=sql.match(/c_economicos constant text\[\] := ARRAY\[([^\]]*)\]/);
  assert.ok(m);
  const congelados=m[1].match(/'([A-Za-z]+)'/g).map(x=>x.replace(/'/g,'')).sort();
  assert.deepEqual(congelados,['cajaPerfil','formaPago','montoConsulta','montoCopago','montoEstudio','montoTotal','noCobrar','tipoCobro']);
  assert.equal(congelados.includes('fecha'),false,'no se traba la reprogramación');
  const app=leer('app.js');
  const modal=app.slice(app.indexOf('function guardarEdicionModal(id){'),app.indexOf('function guardarEdicion(id){'));
  congelados.forEach(c=>assert.match(modal,new RegExp('a\\.'+c+'\\s*='),'la edición de la app escribe '+c));
});
test('SQL propuesto: el DELETE sólo se intercepta con cobro pendiente o confirmado por el flujo',()=>{
  const sql=leer('docs/propuestas/pending_review_cobros_v1_guard_medico.sql').replace(/^\s*--.*$/gm,'');
  const del=sql.slice(sql.indexOf('BEFORE DELETE'),sql.indexOf('-- Verificación'));
  assert.match(del,/estadoCobro' = 'pendiente'/);
  assert.match(del,/cobroConfirmadoPorRol/);
  assert.doesNotMatch(del,/TG_OP/);
});

/* ---------- espejo en la interfaz de las reglas del guard + importe visto ---------- */
test('importe visto: si cambió desde que se mostró el pendiente, no se confirma',()=>{
  const pend=cobros.asignarEstadoCobroNuevo(base({montoConsulta:35000}),{pendiente:true,ahora:AHORA});
  assert.equal(cobros.confirmarCobro(pend,{medio:'Efectivo',montoVisto:35000,ahora:AHORA}).ok,true);
  const editado=Object.assign({},pend,{montoConsulta:350000});
  const r=cobros.confirmarCobro(editado,{medio:'Efectivo',montoVisto:35000,ahora:AHORA});
  assert.equal(r.ok,false);assert.equal(r.codigo,'monto_cambio');
  assert.equal(cobros.confirmarCobro(editado,{medio:'Efectivo',ahora:AHORA}).ok,true,'sin importe visto (API vieja) no cambia el comportamiento');
});
test('importe visto: una confirmación ya hecha sigue siendo idempotente aunque el importe haya cambiado',()=>{
  const conf=cobros.confirmarCobro(cobros.asignarEstadoCobroNuevo(base(),{pendiente:true,ahora:AHORA}),{medio:'Efectivo',ahora:AHORA}).payload;
  const r=cobros.confirmarCobro(Object.assign({},conf,{montoConsulta:1}),{medio:'Efectivo',montoVisto:35000});
  assert.equal(r.ok,true);assert.equal(r.yaConfirmado,true);
});
test('interfaz: el médico no edita lo económico de un cobro confirmado por el flujo ni borra pendientes/confirmados',()=>{
  const pend=cobros.asignarEstadoCobroNuevo(base(),{pendiente:true,ahora:AHORA});
  const conf=cobros.confirmarCobro(pend,{medio:'Efectivo',rol:'secretaria',ahora:AHORA}).payload;
  const alRegistrar=cobros.asignarEstadoCobroNuevo(base(),{ahora:AHORA});
  assert.equal(cobros.edicionEconomicaBloqueada('medico',conf),true);
  assert.equal(cobros.edicionEconomicaBloqueada('medico',pend),false,'pendiente: editable');
  assert.equal(cobros.edicionEconomicaBloqueada('medico',alRegistrar),false,'cobrada al registrar: editable');
  assert.equal(cobros.edicionEconomicaBloqueada('medico',base()),false,'histórica: editable');
  assert.equal(cobros.edicionEconomicaBloqueada('secretaria',conf),false);
  assert.equal(cobros.borradoBloqueado('medico',pend),true);
  assert.equal(cobros.borradoBloqueado('medico',conf),true);
  assert.equal(cobros.borradoBloqueado('medico',alRegistrar),false);
  assert.equal(cobros.borradoBloqueado('medico',base()),false);
  assert.equal(cobros.borradoBloqueado('admin',pend),false);
  assert.equal(cobros.borradoBloqueado('sin_configurar',conf),true,'sin rol confirmado: como médico');
});

test('SQL propuesto: el WHEN del UPDATE usa exactamente los campos protegidos, en OLD y en NEW (alcance acotado)',()=>{
  const sql=leer('docs/propuestas/pending_review_cobros_v1_guard_medico.sql').replace(/^\s*--.*$/gm,'');
  const protegidos=sql.match(/c_estado constant text\[\] := ARRAY\[([^\]]*)\]/)[1].match(/'([A-Za-z]+)'/g).map(x=>x.replace(/'/g,'')).sort();
  const inicio=sql.indexOf('CREATE TRIGGER cardiolink_atenciones_guard_cobro_v1\n');
  const when=sql.slice(inicio,sql.indexOf('EXECUTE FUNCTION',inicio));
  const usos=when.match(/jsonb_exists_any\((OLD|NEW)\.payload, ARRAY\[([^\]]*)\]\)/g);
  assert.equal(usos.length,2,'una comprobación en OLD y otra en NEW');
  usos.forEach(u=>{
    const claves=u.match(/'([A-Za-z]+)'/g).map(x=>x.replace(/'/g,'')).sort();
    assert.deepEqual(claves,protegidos,'el WHEN debe listar los mismos 10 campos que protege la función');
  });
  assert.ok(/OLD\.payload/.test(usos[0])&&/NEW\.payload/.test(usos[1]));
  assert.equal(protegidos.length,10);
  // Emulación del WHEN: una atención histórica (sin ninguno de los campos) NUNCA dispara el trigger.
  const dispara=(o,n)=>[o,n].some(p=>protegidos.some(k=>Object.prototype.hasOwnProperty.call(p,k)));
  assert.equal(dispara(base(),Object.assign({},base(),{observaciones:'x',montoConsulta:1,estadoTurno:'atendido'})),false,'histórica: no se ejecuta');
  assert.equal(dispara({__config:true},{__config:true,a:1}),false,'config/mensajes: no se ejecuta');
  protegidos.forEach(k=>assert.equal(dispara(base(),Object.assign({},base(),{[k]:'x'})),true,'agregar sólo '+k+' dispara el guard'));
  const conCobro=cobros.asignarEstadoCobroNuevo(base(),{pendiente:true,ahora:AHORA});
  assert.equal(dispara(conCobro,{}),true,'si OLD tenía campos de cobro y NEW los quita, también dispara');
  // Todo lo que escribe el módulo está dentro del alcance del WHEN
  const conf=cobros.confirmarCobro(conCobro,{medio:'Efectivo',usuarioId:'u',rol:'secretaria',email:'e',ahora:AHORA}).payload;
  Object.keys(conf).filter(k=>k==='estadoCobro'||/^cobro/.test(k)).forEach(k=>assert.ok(protegidos.includes(k),k));
});
test('SQL propuesto: la prueba 9 exige ejecución correcta de la RPC y conservación de los campos económicos',()=>{
  const t=leer('docs/propuestas/pending_review_cobros_v1_guard_medico_tests.sql');
  const bloque=t.slice(t.indexOf('-- 9. RPC'),t.indexOf('-- 10. Secretaría confirma'));
  assert.match(bloque,/v_msg = 'OK'/);
  assert.match(bloque,/bonoFirmado.*= 'true'/);
  assert.match(bloque,/\(v_antes - 'bonoFirmado' - 'auditoriaPendientes'\) = \(v_desp - 'bonoFirmado' - 'auditoriaPendientes'\)/);
  assert.doesNotMatch(bloque,/<> '42501'/,'ya no se acepta cualquier error distinto de 42501');
  assert.doesNotMatch(bloque,/NOT LIKE/);
  assert.match(t,/6b médico agrega sólo cobroConfirmadoPorRol/);
});
test('SQL propuesto: _checks.sql lista las funciones de autorización reales y la ejecución de authenticated',()=>{
  const c=leer('docs/propuestas/pending_review_cobros_v1_guard_medico_checks.sql');
  ['cardiolink_has_appointment_requests_access','cardiolink_es_admin_u_owner','cardiolink_permite_atencion_v1','cardiolink_identidad_pendientes_v1',
   'cardiolink_pendiente_mutar_v1','cardiolink_atenciones_proteger_identidad_v1','cardiolink_atenciones_guard_cobro_v1'].forEach(f=>assert.ok(c.includes(f),f));
  assert.match(c,/has_function_privilege\('authenticated'/);
  assert.match(c,/cardiolink_atenciones_guard_cobro_v1_del/);
  assert.doesNotMatch(c.replace(/^\s*--.*$/gm,''),/\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|GRANT|REVOKE)\b/,'sólo lectura');
});
test('SQL propuesto: se conservan SECURITY INVOKER, la verificación posterior, los dos triggers y el rollback',()=>{
  const sql=leer('docs/propuestas/pending_review_cobros_v1_guard_medico.sql').replace(/^\s*--.*$/gm,'');
  assert.equal((sql.match(/CREATE TRIGGER/g)||[]).length,2);
  assert.ok((sql.match(/RAISE EXCEPTION/g)||[]).length>=9,'pre-chequeos y verificación posterior presentes');
  assert.match(sql,/tgenabled = 'O'\) <> 2/);
  assert.match(sql,/RAISE EXCEPTION 'La función del trigger no puede ser SECURITY DEFINER/);
  assert.match(sql,/has_function_privilege\('authenticated', 'public\.cardiolink_has_appointment_requests_access\(\)'/);
  assert.doesNotMatch(sql.slice(sql.indexOf('CREATE FUNCTION'),sql.indexOf('REVOKE ALL')),/SECURITY DEFINER/);
});

/* ---------- v4.2: destinatario económico (cajaPerfil) al confirmar ---------- */
test('cajaPerfil: confirmarCobro rechaza si la caja cambió respecto de la que se vio',()=>{
  const pend=cobros.asignarEstadoCobroNuevo(base(),{pendiente:true,ahora:AHORA});
  assert.equal(cobros.confirmarCobro(pend,{medio:'Efectivo',cajaVista:'matias',ahora:AHORA}).ok,true);
  const movido=Object.assign({},pend,{cajaPerfil:'rogelio'});
  const r=cobros.confirmarCobro(movido,{medio:'Efectivo',cajaVista:'matias',ahora:AHORA});
  assert.equal(r.ok,false);assert.equal(r.codigo,'caja_cambio');assert.equal(r.payload,undefined,'no genera payload confirmado');
  // sin cajaPerfil se usa profesionalId (mismo criterio que app.js y el guard SQL)
  const sinCaja=Object.assign({},pend);delete sinCaja.cajaPerfil;
  assert.equal(cobros.cajaDe(sinCaja),'matias');
  assert.equal(cobros.confirmarCobro(sinCaja,{medio:'Efectivo',cajaVista:'matias',ahora:AHORA}).ok,true);
});
test('cajaPerfil: ya confirmada por otra sesión sigue siendo idempotente aunque la caja difiera',()=>{
  const conf=cobros.confirmarCobro(cobros.asignarEstadoCobroNuevo(base(),{pendiente:true,ahora:AHORA}),{medio:'Efectivo',ahora:AHORA}).payload;
  const r=cobros.confirmarCobro(conf,{medio:'Transferencia',cajaVista:'otra'});
  assert.equal(r.ok,true);assert.equal(r.yaConfirmado,true);
});
test('cajaPerfil: persistido — si la caja cambió no se confirma, no hay UPDATE, no entra dinero y la copia local se actualiza',async()=>{
  await conEntorno({},async(env)=>{
    sembrar(env,cobros.asignarEstadoCobroNuevo(base(),{pendiente:true,ahora:AHORA}));
    env.filas.get('a1').payload.cajaPerfil='rogelio'; // otra sesión la movió después de que se mostró
    const r=await env.w.CardioLinkCobrosV1Panel.confirmarCobroPersistido('a1','Efectivo',35000,'matias');
    assert.equal(r.ok,false);assert.equal(r.codigo,'caja_cambio');
    assert.equal(env.log.updates,0);
    assert.equal(env.filas.get('a1').payload.estadoCobro,'pendiente');
    assert.equal(globalThis.atenciones[0].cajaPerfil,'rogelio','se refrescó la copia local para volver a confirmar');
    assert.match(cobros.MENSAJES.caja_cambio,/confirm[aá] de nuevo/i);
    const ok=await env.w.CardioLinkCobrosV1Panel.confirmarCobroPersistido('a1','Efectivo',35000,'rogelio');
    assert.equal(ok.ok,true);assert.equal(env.log.updates,1);
  });
});
test('confirmación simultánea (misma sesión): dos solicitudes a la vez escriben una sola vez',async()=>{
  await conEntorno({},async(env)=>{
    sembrar(env,cobros.asignarEstadoCobroNuevo(base(),{pendiente:true,ahora:AHORA}));
    const P=env.w.CardioLinkCobrosV1Panel;
    const [a,b]=await Promise.all([P.confirmarCobroPersistido('a1','Efectivo',35000,'matias'),P.confirmarCobroPersistido('a1','Transferencia',35000,'matias')]);
    assert.equal([a,b].filter(x=>x.ok&&!x.yaConfirmado).length,1,JSON.stringify([a,b]));
    assert.equal([a,b].filter(x=>!x.ok&&x.codigo==='en_curso').length,1,JSON.stringify([a,b]));
    assert.equal(env.log.updates,1);
    assert.equal(env.filas.get('a1').payload.cobroAuditoria.filter(e=>e.accion==='confirmado').length,1);
  });
});
test('confirmación simultánea (dos sesiones): si otra confirma entre la lectura y el UPDATE, el UPDATE condicionado afecta 0 filas y no se duplica',async()=>{
  await conEntorno({},async(env)=>{
    sembrar(env,cobros.asignarEstadoCobroNuevo(base(),{pendiente:true,ahora:AHORA}));
    env.hooks.trasLeer=(filas)=>{ // la otra sesión confirma justo después de nuestra lectura
      const f=filas.get('a1');
      f.payload=cobros.confirmarCobro(f.payload,{medio:'Efectivo',usuario:'Otra',rol:'secretaria',ahora:AHORA}).payload;
      f.updated_at='v-otra-sesion';
    };
    const r=await env.w.CardioLinkCobrosV1Panel.confirmarCobroPersistido('a1','Transferencia',35000,'matias');
    assert.equal(r.ok,true);assert.equal(r.yaConfirmado,true,JSON.stringify(r));
    assert.equal(env.log.updates,0,'esta sesión no escribió');
    assert.equal(env.filas.get('a1').payload.cobroMedioPago,'Efectivo','gana la primera confirmación');
    assert.equal(env.filas.get('a1').payload.cobroAuditoria.filter(e=>e.accion==='confirmado').length,1);
  });
});
test('guard v4.2: un 42501 del backend se informa como falta de autorización (no como error de red) y no deja la fila confirmada',async()=>{
  await conEntorno({rechazoGuard:true},async(env)=>{
    sembrar(env,cobros.asignarEstadoCobroNuevo(base(),{pendiente:true,ahora:AHORA}));
    const r=await env.w.CardioLinkCobrosV1Panel.confirmarCobroPersistido('a1','Efectivo',35000,'matias');
    assert.equal(r.ok,false);assert.equal(r.codigo,'sin_autorizacion');
    assert.equal(env.filas.get('a1').payload.estadoCobro,'pendiente');
    assert.match(cobros.MENSAJES.sin_autorizacion,/asociaci[oó]n/i);
  });
});
test('cableado v4.2: el botón de confirmar lleva la caja visualizada y se envía al confirmar',()=>{
  const mod=leer('cardiolink-cobros-v1.js');
  assert.match(mod,/data-cobro-caja="\$\{esc\(cajaDe\(a\)\)\}"/);
  assert.match(mod,/confirmarCobroPersistido\(id, medio, Number\(boton\.getAttribute\('data-cobro-monto'\)\), boton\.getAttribute\('data-cobro-caja'\)\)/);
  assert.doesNotMatch(mod,/service_role|eval\(|\.rpc\(|\.upsert\(|\)\s*\.delete\(/);
});

/* ---------- v4.2: contrato de los SQL (no hay PostgreSQL local: se verifican los archivos) ---------- */
const sinComentarios=(sql)=>sql.split('\n').filter(l=>!/^\s*--/.test(l)).join('\n');
const P='docs/propuestas/pending_review_cobros_v1_guard_';
const cuerpoFuncion=(sql,nombre)=>{const i=sql.indexOf('FUNCTION public.'+nombre);assert.ok(i>=0,'falta '+nombre);const a=sql.indexOf('$function$',i)+10;return sql.slice(a,sql.indexOf('$function$',a));};
const CAMPOS10=['estadoCobro','cobroPendienteEn','cobroPendientePor','cobroConfirmadoEn','cobroConfirmadoPor','cobroConfirmadoPorId','cobroConfirmadoPorRol','cobroConfirmadoPorEmail','cobroMedioPago','cobroAuditoria'];
test('v4.2.1 apply: reutiliza las funciones de asociaciones, no crea permisos ni toca el RLS, y es SECURITY INVOKER',()=>{
  const sql=leer(P+'v421.sql'),cod=sinComentarios(sql);
  assert.match(cod,/cardiolink_has_finance_access\(\)/);
  assert.match(cod,/cardiolink_secretaria_autorizada_prof_v1\(/);
  assert.match(cod,/cardiolink_has_appointment_requests_access\(\)/);
  assert.doesNotMatch(cod,/CREATE\s+(OR REPLACE\s+)?POLICY|ALTER\s+POLICY|DROP\s+POLICY|CREATE\s+TABLE|ALTER\s+TABLE|ENABLE ROW LEVEL/i,'no toca RLS ni tablas');
  assert.doesNotMatch(cod,/LANGUAGE\s+plpgsql\s+SECURITY\s+DEFINER/i,'SECURITY INVOKER: current_user identifica al rol de la API');
  assert.match(cod,/current_user NOT IN \('authenticated', 'anon'\)/);
  assert.doesNotMatch(cod,/service_role\s*\)/);
  // destinatario económico: cajaPerfil y, si falta, profesionalId (mismo criterio que app.js); se autoriza OLD y NEW
  assert.match(cod,/coalesce\(nullif\(btrim\(OLD\.payload ->> 'cajaPerfil'\), ''\), nullif\(btrim\(OLD\.payload ->> 'profesionalId'\), ''\)\)/);
  assert.match(cod,/coalesce\(nullif\(btrim\(NEW\.payload ->> 'cajaPerfil'\), ''\), nullif\(btrim\(NEW\.payload ->> 'profesionalId'\), ''\)\)/);
});
test('v4.2.1 apply: la lista de campos protegidos es la de v4.1.1 y coincide en los 3 WHEN',()=>{
  const v42=leer(P+'v421.sql'),v411=leer(P+'medico.sql');
  const lista=(sql,re)=>{const m=sql.match(re);assert.ok(m,'sin lista');return Array.from(m[1].matchAll(/'([A-Za-z]+)'/g)).map(x=>x[1]);};
  assert.deepEqual(lista(v42,/c_estado constant text\[\] := ARRAY\[([^\]]+)\]/),CAMPOS10);
  assert.deepEqual(lista(v42,/c_estado constant text\[\] := ARRAY\[([^\]]+)\]/),lista(v411,/c_estado constant text\[\] := ARRAY\[([^\]]+)\]/));
  assert.deepEqual(lista(v42,/c_economicos constant text\[\] := ARRAY\[([^\]]+)\]/),lista(v411,/c_economicos constant text\[\] := ARRAY\[([^\]]+)\]/));
  const trg=v42.slice(v42.indexOf('CREATE TRIGGER'));
  const whens=Array.from(trg.matchAll(/WHEN \((?:jsonb_exists_any\((?:OLD|NEW)\.payload, ARRAY\[([^\]]+)\]\)\s*(?:OR\s*)?)+/g));
  assert.equal(whens.length,2,'WHEN de UPDATE (OLD y NEW) y de INSERT (NEW)');
  const todos=Array.from(trg.matchAll(/jsonb_exists_any\((?:OLD|NEW)\.payload, ARRAY\[([^\]]+)\]\)/g)).map(m=>Array.from(m[1].matchAll(/'([A-Za-z]+)'/g)).map(x=>x[1]));
  assert.equal(todos.length,3);todos.forEach(l=>assert.deepEqual(l,CAMPOS10));
  assert.match(v42,/CREATE TRIGGER cardiolink_atenciones_guard_cobro_v1_ins\s+BEFORE INSERT/);
  assert.match(v42,/CREATE TRIGGER cardiolink_atenciones_guard_cobro_v1_del\s+BEFORE DELETE[\s\S]*?WHEN \(OLD\.payload ->> 'estadoCobro' = 'pendiente' OR jsonb_exists\(OLD\.payload, 'cobroConfirmadoPorRol'\)\)/);
});
test('v4.2.1 apply: la confirmación verificada exige identidad del backend, rol y fecha acotada; no se reescribe una confirmación',()=>{
  const cod=sinComentarios(leer(P+'v421.sql'));
  assert.match(cod,/NEW\.payload ->> 'cobroConfirmadoPorId' IS DISTINCT FROM auth\.uid\(\)::text/);
  assert.match(cod,/coalesce\(NEW\.payload ->> 'cobroConfirmadoPorRol', ''\) <> 'secretaria'/);
  assert.match(cod,/v_ts < now\(\) - interval '1 day' OR v_ts > now\(\) \+ interval '1 day'/);
  assert.match(cod,/IF OLD\.payload \? 'cobroConfirmadoPorRol' THEN\s+FOREACH v_campo IN ARRAY c_identidad/);
});
test('v4.2.1 apply: el INSERT sólo admite las formas legítimas del alta y deja pasar al upsert de filas existentes',()=>{
  const cod=sinComentarios(leer(P+'v421.sql'));
  const ins=cuerpoFuncion(cod,'cardiolink_atenciones_guard_cobro_ins_v1');
  assert.match(ins,/PERFORM 1 FROM public\.cardiolink_atenciones a WHERE a\.id = NEW\.id FOR KEY SHARE;\s+IF FOUND THEN RETURN NEW; END IF;/,'upsert de fila existente, con bloqueo');
  assert.ok(ins.indexOf('WHERE a.id = NEW.id')<ins.indexOf("'cobroConfirmadoPorId', 'cobroConfirmadoPorRol', 'cobroConfirmadoPorEmail'"),'la excepción del upsert precede a las validaciones');
  ['cobroConfirmadoPorId','cobroConfirmadoPorRol','cobroConfirmadoPorEmail'].forEach(c=>assert.match(ins,new RegExp("'"+c+"'")));
  assert.match(ins,/v_estado = 'cobrado' AND jsonb_exists_any\(NEW\.payload, ARRAY\['cobroPendienteEn', 'cobroPendientePor'\]\)/);
  assert.match(ins,/'cobrado' THEN 'cobrado_al_registrar' WHEN 'pendiente' THEN 'pendiente'/);
  assert.match(ins,/v_estado NOT IN \('cobrado', 'pendiente', 'sin_cobro'\)/);
  assert.match(ins,/IF coalesce\(public\.cardiolink_has_finance_access\(\), false\) THEN RETURN NEW; END IF;/,'owner/admin: sin restricción');
  // Las formas legítimas que escribe el módulo no usan ninguna de las marcas prohibidas.
  const nuevo=cobros.asignarEstadoCobroNuevo(base(),{pendiente:false,ahora:AHORA,usuario:'Dra'});
  ['cobroConfirmadoPorId','cobroConfirmadoPorRol','cobroConfirmadoPorEmail','cobroPendienteEn','cobroPendientePor'].forEach(c=>assert.equal(nuevo[c],undefined,'cobrado al registrar no trae '+c));
  assert.deepEqual(nuevo.cobroAuditoria.map(e=>e.accion),['cobrado_al_registrar']);
  const pend=cobros.asignarEstadoCobroNuevo(base(),{pendiente:true,ahora:AHORA,usuario:'Sec'});
  ['cobroConfirmadoEn','cobroConfirmadoPor','cobroMedioPago','cobroConfirmadoPorId','cobroConfirmadoPorRol','cobroConfirmadoPorEmail'].forEach(c=>assert.equal(pend[c],undefined,'pendiente no trae '+c));
  assert.deepEqual(pend.cobroAuditoria.map(e=>e.accion),['pendiente']);
  const sc=cobros.asignarEstadoCobroNuevo(base({noCobrar:true,tipoCobro:'No cobrar'}),{ahora:AHORA});
  assert.equal(sc.estadoCobro,'sin_cobro');CAMPOS10.filter(c=>c!=='estadoCobro').forEach(c=>assert.equal(sc[c],undefined));
});
// MD5 en JS puro (sirve en Node y en JavaScriptCore): el contrato exige que los md5 declarados correspondan a los cuerpos reales.
function md5(str){
  const u=unescape(encodeURIComponent(str)),n=u.length,x=[];
  const rl=(a,b)=>(a<<b)|(a>>>(32-b)),ad=(a,b)=>(a+b)|0;
  for(let i=0;i<n;i++)x[i>>2]=(x[i>>2]||0)|(u.charCodeAt(i)<<((i%4)*8));
  x[n>>2]=(x[n>>2]||0)|(0x80<<((n%4)*8));const len=(((n+8)>>6)+1)*16;for(let i=0;i<len;i++)x[i]=x[i]||0;x[len-2]=n*8;
  const K=[],R=[7,12,17,22,5,9,14,20,4,11,16,23,6,10,15,21];for(let i=0;i<64;i++)K[i]=Math.floor(Math.abs(Math.sin(i+1))*4294967296)|0;
  let a0=1732584193,b0=-271733879,c0=-1732584194,d0=271733878;
  for(let o=0;o<len;o+=16){let a=a0,b=b0,c=c0,d=d0;
    for(let i=0;i<64;i++){let f,g;
      if(i<16){f=(b&c)|(~b&d);g=i;}else if(i<32){f=(d&b)|(~d&c);g=(5*i+1)%16;}else if(i<48){f=b^c^d;g=(3*i+5)%16;}else{f=c^(b|~d);g=(7*i)%16;}
      const tmp=d;d=c;c=b;b=ad(b,rl(ad(ad(a,f),ad(K[i],x[o+g])),R[(i>>4)*4+(i%4)]));a=tmp;}
    a0=ad(a0,a);b0=ad(b0,b);c0=ad(c0,c);d0=ad(d0,d);}
  const h=v=>{let r='';for(let i=0;i<4;i++)r+=((v>>>(i*8))&255).toString(16).padStart(2,'0');return r;};
  return h(a0)+h(b0)+h(c0)+h(d0);
}
const MD5_REPO='5d9ac1d364bd571b60f5551d94903e83',MD5_STG='b511fed99268c140651ee622b84fde0b';
const cuerpoDe=(sql)=>{const a=sql.indexOf('AS $function$')+13;return sql.slice(a,sql.indexOf('$function$',a));};
const compacto=()=>cuerpoDe(leer(P+'v411_staging_compacto_referencia.sql'));
const formateado=()=>cuerpoDe(leer(P+'medico.sql'));
const esencia=(b)=>b.replace(/--[^\n]*/g,'').replace(/\s+/g,'');
test('v4.1.1: los dos cuerpos conocidos tienen el md5 declarado y son lógicamente idénticos',()=>{
  assert.equal(md5('abc'),'900150983cd24fb0d6963f7d28e17f72','el md5 del test es correcto');
  assert.equal(md5(formateado()),MD5_REPO);
  assert.equal(md5(compacto()),MD5_STG);
  assert.equal(esencia(compacto()),esencia(formateado()),'sin comentarios ni espacios son iguales');
  assert.notEqual(MD5_REPO,MD5_STG);
});
test('v4.2.1 apply: reconoce SOLO los 2 cuerpos conocidos de v4.1.1, registra estado previo y md5, y aborta con cualquier otro',()=>{
  const sql=leer(P+'v421.sql'),cod=sinComentarios(sql);
  assert.match(cod,new RegExp("c_md5_v411_repo constant text := '"+MD5_REPO+"'"));
  assert.match(cod,new RegExp("c_md5_v411_stg  constant text := '"+MD5_STG+"'"));
  assert.match(cod,/IF v_md5 NOT IN \(c_md5_v411_repo, c_md5_v411_stg\) THEN/);
  const todos=new Set(Array.from(cod.matchAll(/\b[0-9a-f]{32}\b/g)).map(m=>m[0]));
  assert.deepEqual(Array.from(todos).sort(),[MD5_REPO,MD5_STG].sort(),'no hay md5 desconocidos aceptados');
  assert.match(cod,/'v4\.1\.1 md5_previo=' \|\| v_md5/,'registra el fingerprint del estado previo');
  assert.match(cod,/estado_previo=/);assert.match(cod,/'sin_guard'/);
  assert.match(cod,/COMMENT ON FUNCTION public\.cardiolink_atenciones_guard_cobro_v1\(\) IS %L/);
  assert.match(cod,/IF v_ntrg <> 2 THEN/);
});
test('v4.2.1 checks: ambos md5 se infieren como v4.1.1 y cualquier otro como desconocido',()=>{
  const sql=leer(P+'v421_checks.sql');
  assert.match(sql,new RegExp("md5_cuerpo IN \\('"+MD5_REPO+"', '"+MD5_STG+"'\\)"));
  assert.match(sql,/tgenabled::text/,'corrección del operador "char" || text');
});
test('v4.2.1 rollback A: restaura EXACTAMENTE el cuerpo previo según md5_previo (compacto de STAGING o formateado) y nada más',()=>{
  const a=leer(P+'v421_rollback_a_staging_v411.sql');
  const cuerpos=Array.from(a.matchAll(/AS \$function\$([\s\S]*?)\$function\$/g)).map(m=>m[1]);
  assert.equal(cuerpos.length,2,'una rama por cada cuerpo conocido');
  assert.equal(cuerpos[0],compacto(),'rama STAGING = referencia exacta del cuerpo compacto');
  assert.equal(cuerpos[1],formateado(),'rama repositorio = v4.1.1 formateado');
  assert.equal(md5(cuerpos[0]),MD5_STG);assert.equal(md5(cuerpos[1]),MD5_REPO);
  assert.match(a,new RegExp("current_setting\\('cardiolink\\.cobros_guard_md5_rollback'\\) = '"+MD5_STG+"'"));
  assert.match(a,/v_md5 NOT IN \('5d9ac1d364bd571b60f5551d94903e83', 'b511fed99268c140651ee622b84fde0b'\)/,'rechaza md5_previo ausente o desconocido');
  assert.match(a,/substring\(v_cmt from 'md5_previo=\(\[0-9a-f\]\{32\}\)'\)/);
  assert.match(a,/estado_previo=v4\.1\.1/);
  assert.match(a,/DROP TRIGGER IF EXISTS cardiolink_atenciones_guard_cobro_v1_ins/);
  assert.match(a,/DROP FUNCTION IF EXISTS public\.cardiolink_atenciones_guard_cobro_ins_v1\(\)/);
  assert.doesNotMatch(a,/DROP TRIGGER IF EXISTS cardiolink_atenciones_guard_cobro_v1 ON|DROP TRIGGER IF EXISTS cardiolink_atenciones_guard_cobro_v1_del/,'los triggers de UPDATE/DELETE se conservan');
  assert.match(a,/COMMENT ON FUNCTION public\.cardiolink_atenciones_guard_cobro_v1\(\) IS NULL/,'v4.1.1 no tenía COMMENT');
  assert.match(a,/La función restaurada no coincide con el md5_previo registrado/);
  assert.match(a,/prosecdef/);
});
test('v4.2.1 rollback B: deja el estado SIN guard (Production) y exige estado_previo=sin_guard; no toca datos ni identidad',()=>{
  const b=sinComentarios(leer(P+'v421_rollback_b_production_sin_guard.sql'));
  assert.match(b,/estado_previo=sin_guard/);
  ['cardiolink_atenciones_guard_cobro_v1_ins','cardiolink_atenciones_guard_cobro_v1_del','cardiolink_atenciones_guard_cobro_v1'].forEach(n=>assert.match(b,new RegExp('DROP TRIGGER IF EXISTS '+n+' ON')));
  assert.match(b,/DROP FUNCTION IF EXISTS public\.cardiolink_atenciones_guard_cobro_ins_v1\(\)/);
  assert.match(b,/DROP FUNCTION IF EXISTS public\.cardiolink_atenciones_guard_cobro_v1\(\)/);
  assert.doesNotMatch(b,/\b(UPDATE|DELETE FROM|INSERT INTO|TRUNCATE)\b/i,'no toca datos');
  assert.match(b,/proteger_identidad_v1/);
});
test('v4.2.1 checks: sólo lectura, informa el estado inferido por entorno y las dependencias',()=>{
  const sql=leer(P+'v421_checks.sql'),cod=sinComentarios(sql);
  assert.doesNotMatch(cod,/\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|GRANT|REVOKE|TRUNCATE|COMMENT ON)\b/i);
  ['sin_guard','v4.1.1','v4.2','desconocido','cardiolink_secretaria_autorizada_prof_v1','cardiolink_has_finance_access','pg_policies'].forEach(x=>assert.ok(sql.includes(x),'falta '+x));
  assert.doesNotMatch(cod,/payload\s*->>?\s*'(paciente|dni|email|telefono)/i,'no lee datos de pacientes');
});
test('v4.2.1 tests SQL: conservan las 28 comprobaciones originales, agregan los casos nuevos y terminan en ROLLBACK',()=>{
  const nuevo=leer(P+'v421_tests.sql'),viejo=leer(P+'medico_tests.sql');
  const etiquetas=(sql)=>Array.from(sql.matchAll(/VALUES \('(\d+[a-z]?) /g)).map(m=>m[1]);
  const orig=Array.from(new Set(etiquetas(viejo)));
  orig.forEach(n=>assert.ok(new RegExp("'"+n+" ").test(nuevo),'falta la prueba original '+n));
  [14,15,17,21,22,26,33,35,39,47,50,55,57,60,64,65,66].forEach(n=>assert.ok(new RegExp("pg_temp\\.r\\('"+n+"[a-z]? ").test(nuevo),'falta el caso nuevo '+n));
  assert.match(nuevo,/ROLLBACK;\s*$/);assert.doesNotMatch(sinComentarios(nuevo),/\bCOMMIT\b/);
  assert.match(nuevo,/cardiolink_asociar_secretaria_medico_v1/,'usa la RPC real de asociaciones');
  assert.match(nuevo,/LIKE 'Rol no autorizado%'/,'distingue el guard de la RLS');
  assert.doesNotMatch(sinComentarios(nuevo),/DISABLE TRIGGER|DROP POLICY|ALTER TABLE/i,'no desactiva controles para pasar');
});

/* ---------- v4.2.1: identidad de la confirmación = sesión autenticada ---------- */
test('v4.2.1 módulo: la confirmación usa como identidad el email de la sesión y un rol que el backend acepta',async()=>{
  assert.equal(cobros.rolParaAuditoria('duenio'),'owner');assert.equal(cobros.rolParaAuditoria('admin'),'admin');
  assert.equal(cobros.rolParaAuditoria('secretaria'),'secretaria');assert.equal(cobros.rolParaAuditoria('Secretaria '),'secretaria');
  await conEntorno({},async(env)=>{
    globalThis.usuarioSupabase={id:'uid-qa',email:'Sec.QA@cardiolink-qa.test'};
    sembrar(env,cobros.asignarEstadoCobroNuevo(base(),{pendiente:true,ahora:AHORA,usuario:'Sec'}));
    const r=await env.w.CardioLinkCobrosV1Panel.confirmarCobroPersistido('a1','Efectivo',35000,'matias');
    assert.equal(r.ok,true,JSON.stringify(r));
    const f=env.filas.get('a1').payload;
    assert.equal(f.cobroConfirmadoPorId,'uid-qa');assert.equal(f.cobroConfirmadoPorRol,'secretaria');
    assert.equal(f.cobroConfirmadoPorEmail,'Sec.QA@cardiolink-qa.test');
    assert.equal(f.cobroConfirmadoPor,'Sec.QA@cardiolink-qa.test','el nombre visible es la identidad autenticada, no un nombre libre');
    const aud=f.cobroAuditoria;assert.equal(aud.length,2);assert.equal(aud[0].accion,'pendiente');
    assert.equal(aud[1].accion,'confirmado');assert.equal(aud[1].usuario,'Sec.QA@cardiolink-qa.test');assert.equal(aud[1].email,'Sec.QA@cardiolink-qa.test');
    assert.equal(f.cobroPendienteEn,AHORA,'no se reescribe el pendiente original');
  });
});
test('v4.2.1 módulo: el dueño guarda rol owner (no "duenio") al confirmar',async()=>{
  await conEntorno({rol:'duenio'},async(env)=>{
    globalThis.usuarioSupabase={id:'uid-own',email:'owner.qa@cardiolink-qa.test'};
    sembrar(env,cobros.asignarEstadoCobroNuevo(base(),{pendiente:true,ahora:AHORA}));
    const r=await env.w.CardioLinkCobrosV1Panel.confirmarCobroPersistido('a1','Efectivo',35000,'matias');
    assert.equal(r.ok,true,JSON.stringify(r));assert.equal(env.filas.get('a1').payload.cobroConfirmadoPorRol,'owner');
  });
});
test('v4.2.1 apply: verifica identidad autenticada en la confirmación (también owner/admin), auditoría de sólo-agregar y FOR KEY SHARE en el INSERT',()=>{
  const cod=sinComentarios(leer(P+'v421.sql'));
  assert.match(cod,/v_mail := lower\(coalesce\(auth\.jwt\(\) ->> 'email', ''\)\)/);
  assert.match(cod,/cobroConfirmadoPorEmail debe ser el email autenticado/);
  assert.match(cod,/cobroConfirmadoPor debe ser la identidad autenticada/);
  assert.match(cod,/coalesce\(NEW\.payload ->> 'cobroConfirmadoPorRol', ''\) NOT IN \('owner', 'admin'\)/,'owner/admin: rol de la categoría real');
  assert.match(cod,/IF v_global OR v_aut_sec THEN/,'owner/admin ya no tienen un atajo que se saltee la verificación');
  assert.match(cod,/c_identidad constant text\[\]/);
  assert.match(cod,/v_added <> 1/);
  assert.match(cod,/PERFORM 1 FROM public\.cardiolink_atenciones a WHERE a\.id = NEW\.id FOR KEY SHARE;\s+IF FOUND THEN RETURN NEW; END IF;/);
  assert.doesNotMatch(cod,/IF EXISTS \(SELECT 1 FROM public\.cardiolink_atenciones a WHERE a\.id = NEW\.id\)/,'el EXISTS sin bloqueo (carrera) ya no está');
  assert.doesNotMatch(cod,/service_role\s*\)/);
});
test('v4.2.1 tests SQL: cubren auditoría (A1..A22) y las confirmaciones usan la identidad del JWT',()=>{
  const t=leer(P+'v421_tests.sql');
  for(let i=1;i<=22;i++)assert.ok(new RegExp("pg_temp\\.r\\('A"+i+" ").test(t),'falta A'+i);
  assert.match(t,/'email', CASE WHEN p_con_email THEN \(SELECT email FROM auth\.users WHERE id = p_uid\) END/);
  assert.match(t,/pg_temp\.sql_confirmar/);
  assert.match(t,/ROLLBACK;\s*$/);
});

/* ---------- caso 12b: la sincronización de atenciones no corre antes de la primera carga remota ---------- */
test('12b app.js: cargandoDesdeNube arranca en true (sin sync ni upsert ciego antes de la primera carga) y el resto del mecanismo sigue igual',()=>{
  const app=leer('app.js');
  const decl=app.match(/^let cargandoDesdeNube = (true|false);/gm);
  assert.deepEqual(decl,['let cargandoDesdeNube = true;'],'una sola declaración, inicializada en true');
  assert.match(app,/permanece bloqueada hasta completar la PRIMERA carga remota y establecer el baseline/,'comentario que explica el motivo');
  // programarSyncSupabase y las dos versiones de sincronizarAtencionesSupabase respetan el indicador (no forzado)
  assert.match(app,/function programarSyncSupabase\(\) \{\s+if \(!supabaseClient \|\| !usuarioSupabase \|\| cargandoDesdeNube\) return;/);
  assert.match(app,/if\(cargandoDesdeNube && !forzar\) return false;/,'la versión vigente del sync corta antes de la primera carga');
  // el bootstrap legítimo (remoto vacío) NO queda bloqueado: libera el indicador de forma explícita antes de forzar
  assert.match(app,/cargandoDesdeNube=false; await sincronizarAtencionesSupabase\(true\); return;/);
  // toda salida de la primera carga libera el indicador
  assert.match(app,/snapshotBaselineAtenciones298\(atenciones\);\s+cargandoDesdeNube=false;/);
  // la limpieza de corruptos se conserva tal cual (su reescritura innecesaria es una mejora posterior documentada)
  assert.match(app,/if\(corruptosEliminados>0\)\{ cargandoDesdeNube=false; await sincronizarAtencionesSupabase\(false\); cargandoDesdeNube=true; \}/);
  // ningún otro punto fuerza el indicador a true fuera de las cargas
  const asig=Array.from(app.matchAll(/cargandoDesdeNube\s*=\s*true/g)).length;
  assert.ok(asig>=2&&asig<=5,'asignaciones a true: la declaración y las cargas ('+asig+')');
});
test('12b versionado: index.html y sw.js apuntan a la nueva versión de app.js y la caché cambió',()=>{
  const idx=leer('index.html'),sw=leer('sw.js');
  assert.match(idx,/<script src="app\.js\?v=40109-persistencia-r2a"><\/script>/);
  assert.match(sw,/'\.\/app\.js\?v=40109-persistencia-r2a'/);
  const cache=sw.match(/const CACHE='([^']+)'/)[1];
  assert.equal(cache,'cardiolink-v4.1.0-persistencia-r2a');
  assert.ok(!['cardiolink-v4.1.0-documentos-v1','cardiolink-v4.1.0-pendientes-cobro-v1','cardiolink-v4.1.0-pendientes-cobro-v1-int','cardiolink-v4.1.0-pendientes-cobro-v1-sync-arranque','cardiolink-v4.1.0-pendientes-cobro-v1-casilla'].includes(cache),'no reutiliza nombres de caché anteriores');
});
test('casilla Cobro pendiente: se recalcula tras aplicarRegla (app.js fija tipoCobro con .value, sin eventos) y al cambiar profesional',()=>{
  const src=leer('cardiolink-cobros-v1.js');
  assert.match(src,/\['tipoCobro',\s*'noCobrar',\s*'obraSocial',\s*'prestacion',\s*'profesional'\]/);
  assert.match(src,/w\.aplicarRegla\.__cobrosV1/);
  assert.match(src,/original\.apply\(this, arguments\);\s*sincronizarCasilla\(\);/);
  assert.match(leer('index.html'),/cardiolink-cobros-v1\.js\?v=1b-casilla-regla/);
});
