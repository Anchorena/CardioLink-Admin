// Regresión: mensajes de WhatsApp de documentos (prepare-whatsapp de patient-document-delivery).
// Un nombre de variable inconsistente dentro de armarMensajeWhatsappDocumentoGenerado (nombrePila vs nombreCompleto)
// hizo fallar la función desplegada con una excepción sin código SQL y respondía 500 genérico sin registrar nada.
// Estas pruebas EJECUTAN las dos plantillas reales (el módulo es ESM puro, sin imports) y comprueban que nunca lanzan
// y que el saludo usa el nombre completo. Ejecutar: node --test
const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs');
const path=require('node:path');
const fuente=fs.readFileSync(path.join(__dirname,'supabase/functions/_shared/comunicaciones-logica.js'),'utf8');
const cargar=()=>new Function(fuente.replace(/^export /gm,'')+'\nreturn {armarMensajeWhatsappDocumentoGenerado,armarMensajeWhatsappDocumentoOficial};')();
const {armarMensajeWhatsappDocumentoGenerado:generado,armarMensajeWhatsappDocumentoOficial:oficial}=cargar();
const ENLACE='https://ejemplo.invalid/functions/v1/patient-document-open?t=TOKEN';

test('Orden/Certificado/Constancia: no lanza y saluda con el nombre COMPLETO',()=>{
  for(const tipo of ['Orden','Certificado','Constancia']){
    const m=generado({nombreDestinatario:'María del Carmen Pérez',tipoDocumento:tipo,profesionalNombre:'Matías Anchorena',enlaceCorto:ENLACE});
    assert.match(m,/^Hola María del Carmen Pérez\.\n/,tipo);
    assert.match(m,/Dr\. Matías Anchorena/,tipo);
    assert.match(m,/El enlace estará disponible durante 7 días\./,tipo);
    assert.ok(m.indexOf(ENLACE)>=0,'incluye el enlace corto: '+tipo);
    assert.doesNotMatch(m,/undefined|NaN|\[object/,tipo);
  }
});

test('tipo desconocido, sin profesional, sin nombre y sin enlace: degrada sin lanzar',()=>{
  const casos=[
    {nombreDestinatario:'',tipoDocumento:'Otro',profesionalNombre:null,enlaceCorto:''},
    {nombreDestinatario:null,tipoDocumento:undefined,profesionalNombre:undefined,enlaceCorto:undefined},
    {nombreDestinatario:'   ',tipoDocumento:'Orden',profesionalNombre:'Dr. Pérez',enlaceCorto:ENLACE},
    {}
  ];
  for(const c of casos){
    const m=generado(c);
    assert.match(m,/^Hola\.\n/);
    assert.doesNotMatch(m,/undefined|NaN|\[object|Dr\. Dr\./);
  }
});

test('plantilla de documentos ya almacenados (estudio): mismo criterio, nombre completo y sin lanzar',()=>{
  const m=oficial({nombreDestinatario:'Juan Carlos Gómez',estudio:'Ecocardiograma',profesionalNombre:'Dra. Ana Ruiz',enlaceCorto:ENLACE});
  assert.match(m,/Hola Juan Carlos Gómez\./);
  assert.match(m,/Dra\. Ana Ruiz/);
  assert.doesNotMatch(oficial({}),/undefined|NaN|\[object/);
});

test('el cuerpo de las dos plantillas no usa variables sin declarar (nombrePila)',()=>{
  for(const nombre of ['armarMensajeWhatsappDocumentoGenerado','armarMensajeWhatsappDocumentoOficial']){
    const i=fuente.indexOf('export function '+nombre);
    assert.notEqual(i,-1,nombre);
    const j=fuente.indexOf('\nexport ',i+10);
    const cuerpo=fuente.slice(i,j===-1?undefined:j).replace(/^\s*\/\/.*$/gm,'');
    assert.doesNotMatch(cuerpo,/nombrePila/,nombre+': no debe quedar nombrePila');
  }
});

test('el Edge Function arma el mensaje con los mismos parámetros que espera la plantilla',()=>{
  const idx=fs.readFileSync(path.join(__dirname,'supabase/functions/patient-document-delivery/index.ts'),'utf8');
  const i=idx.indexOf('armarMensajeWhatsappDocumentoGenerado({');
  assert.notEqual(i,-1);
  const llamada=idx.slice(i,idx.indexOf('})',i));
  for(const campo of ['nombreDestinatario','tipoDocumento','profesionalNombre','enlaceCorto']) assert.match(llamada,new RegExp(campo),campo);
});
