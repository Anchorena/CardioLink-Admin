const assert=require('node:assert/strict');
const {test}=require('node:test');
const {puedeVerPendiente,puedeResolverPendiente}=require('./cardiolink-pendientes-permisos-v1.js');
const propio={profesionalId:'rogelio',cajaPerfil:'matias'};
const ajeno={profesionalId:'matias',cajaPerfil:'rogelio'};
const medico={confirmadaBackend:true,baseRole:'medico',professionalId:'rogelio'};
test('médico ve solo profesional propio, no por cajaPerfil',()=>{
 assert.equal(puedeVerPendiente(medico,propio),true);
 assert.equal(puedeVerPendiente(medico,ajeno),false);
});
test('sin rol backend confirmado o professionalId: denegar',()=>{
 assert.equal(puedeVerPendiente({...medico,confirmadaBackend:false},propio),false);
 assert.equal(puedeVerPendiente({...medico,professionalId:''},propio),false);
 assert.equal(puedeVerPendiente({...medico,baseRole:'owner',confirmadaBackend:false},propio),false);
});
test('administrador/dueño confirmado puede acceder globalmente',()=>{
 for(const baseRole of ['owner','admin'])assert.equal(puedeVerPendiente({baseRole,confirmadaBackend:true},ajeno),true);
});
test('secretaria global o asignada, según autorización backend',()=>{
 assert.equal(puedeVerPendiente({baseRole:'secretaria',confirmadaBackend:true,secretariaGlobal:true},ajeno),true);
 const secretaria={baseRole:'secretaria',confirmadaBackend:true,profesionalesAutorizados:['rogelio']};
 assert.equal(puedeVerPendiente(secretaria,propio),true);
 assert.equal(puedeVerPendiente(secretaria,ajeno),false);
});
test('resolver exige pendiente activo y acceso al registro',()=>{
 assert.equal(puedeResolverPendiente(medico,propio,'firma',['firma','copia']),true);
 assert.equal(puedeResolverPendiente(medico,propio,'retiro',['firma','copia']),false);
 assert.equal(puedeResolverPendiente(medico,ajeno,'firma',['firma']),false);
});
test('roles desconocidos y registros vacíos: denegar',()=>{
 assert.equal(puedeVerPendiente({baseRole:'visitante',confirmadaBackend:true},propio),false);
 assert.equal(puedeVerPendiente(medico,null),false);
});
