/* ===== CardioLink Admin — Documentos y estudios PDF (Fase 6 / Bloque 6D) =====
 * V1 + 6D.1 + 6D.2 + 6D.3 + 6E.1. Módulo independiente: NO modifica app.js ni
 * cardiolink-config-v1.js (salvo los 2 enganches puntuales que SÍ exigían
 * tocar app.js, documentados en los comentarios de openEvolutionModalHC/
 * saveEvolutionHC/printHC402 en ese archivo).
 *
 * Bloque 6D.2 - vínculo REAL documento <-> evolución clínica, vía la
 * columna evolution_id (FK a cardiolink_hc_evoluciones, migración
 * 20261007120000). Reemplaza el enfoque anterior (que usaba attention_id
 * como sustituto, nunca realmente poblado). Flujo:
 *   - Subir un PDF desde "Nueva evolución" lo agrega a una lista de
 *     "adjuntos pendientes" dentro del modal (solo en memoria/DOM,
 *     dataset del modal) - el documento YA existe en Storage/tabla con
 *     evolution_id=null, pero todavía no está vinculado.
 *   - Al guardar la evolución (app.js, saveEvolutionHC), una vez que esa
 *     evolución tiene un id real confirmado, se llama al hook expuesto
 *     window.vincularAdjuntosPendientesEvolucionV1(evolutionId), que
 *     recién ahí hace el UPDATE evolution_id=<id> (y desvincula los que
 *     el usuario haya sacado de la lista con "Quitar de esta evolución").
 *   - Un documento con evolution_id se muestra ANIDADO dentro de esa
 *     evolución (ficha de HC y printHC402); uno sin evolution_id se
 *     muestra como "Estudio incorporado" independiente. Nunca los dos a
 *     la vez.
 *
 * Sube/lista/ve/descarga/elimina PDFs reales asociados al paciente activo,
 * mostrando el MISMO documento en dos lugares de la UI (sin duplicar nada
 * en Storage ni en la tabla de metadata):
 *   - Ficha del paciente (#pacienteDetalle) -> sección "Documentos y
 *     estudios", con su propio botón "+ Subir PDF".
 *   - Historia clínica (#hcPacienteDetalle) -> sección "Estudios y
 *     documentos" (solo lectura + acciones; la subida desde HC se hace
 *     con el botón "Subir estudio / PDF" dentro de "Nueva evolución",
 *     que reutiliza el mismo modal/flujo de subida de la ficha).
 * Infraestructura (sin cambios respecto a 6D):
 *   - Supabase Storage privado, bucket "patient-documents" (sólo PDF, 20MB)
 *   - tabla de metadata "cardiolink_patient_documents" (nunca el archivo)
 * El PDF NUNCA se guarda en localStorage, base64, app.js ni en el jsonb de
 * configuración/HC. Ver/Descargar usan siempre una URL firmada temporal
 * (el bucket es privado, nunca se genera una URL pública permanente).
 *
 * Reutiliza el cliente Supabase y los permisos YA existentes de CardioLink
 * (supabaseClient, puedeAccederInformacionClinica, esSecretaria,
 * escapeHtml, data, pacienteSeleccionadoPanelId) - no crea un cliente
 * Supabase nuevo ni un sistema de roles nuevo. Dos gates distintos, ambos
 * compuestos a partir de funciones de rol YA existentes:
 *   - puedeListarSubirPdfV1()  = owner/admin/médico/secretaria (listar,
 *     subir, ver, descargar - sección de la FICHA). Mismo conjunto que
 *     cardiolink_has_clinical_documents_access() en la migración de RLS.
 *   - puedeAccederClinicaPdfV1() = owner/admin/médico (eliminar, y
 *     visibilidad de la sección dentro de HISTORIA CLÍNICA - Secretaría
 *     no entra, aunque sí puede operar documentos desde la ficha). Mismo
 *     conjunto que cardiolink_can_delete_clinical_documents() y que
 *     canAccessClinicalHC()/puedeAccederInformacionClinica() en app.js.
 * Ver supabase/migrations/20261007100000_cardiolink_patient_documents_v1.sql
 * y supabase/migrations/20261007110000_cardiolink_patient_documents_secretaria_access.sql.
 *
 * Bloque 6D.3 - Imagen clínica desde cámara/webcam. Reutiliza EXACTAMENTE
 * el mecanismo de adjuntos pendientes de 6D.2 (misma tabla, mismo bucket,
 * mismo evolution_id, mismas funciones pendingDocsGetV1/SetV1,
 * renderAdjuntosPendientesV1, vincularAdjuntosPendientesEvolucionV1,
 * cargarYRenderizarListaPdfV1) - sólo se generaliza esas funciones para
 * distinguir document_type==='Imagen clínica' (ver TIPO_IMAGEN_CLINICA_V1)
 * donde la presentación difiere (un solo botón "Ver imagen", sin
 * Descargar ni nombre de archivo en los bloques anidados/impresión). No
 * se crea un cliente Supabase, un bucket, una tabla ni un sistema de
 * roles nuevo. El botón "Tomar imagen clínica" sólo existe dentro de
 * "Nueva evolución" (#hcEvolutionModal) - ese modal ya está gateado a
 * owner/admin/médico (requireClinicalHC() en app.js), así que Secretaría
 * nunca llega a verlo; además la RLS (migración 20261007130000) bloquea
 * el acceso real en Supabase a filas/objetos de imagen clínica para
 * Secretaría, independientemente de la UI.
 * Ver supabase/migrations/20261007120000_cardiolink_patient_documents_evolution_link.sql
 * y supabase/migrations/20261007130000_cardiolink_patient_documents_clinical_images.sql.
 *
 * Bloque 6E.1 - Envío digital de documentos/estudios ya almacenados
 * (botón "Enviar" en cada tarjeta, Email/WhatsApp/Ambos). Habla con una
 * Edge Function NUEVA e independiente, supabase/functions/
 * patient-document-delivery (no se tocó patient-communications, ya
 * cerrada y en Production). La resolución de destinatario (paciente o
 * contacto responsable, email y WhatsApp) y la autorización real para
 * leer el documento/archivo (Secretaría bloqueada para Imagen clínica)
 * viven ENTERAMENTE del lado servidor - lo que este módulo resuelve acá
 * (puedeEnviarDocumentoV1, resolverContactoPreviewV1) es sólo una vista
 * previa de UI, nunca la autorización real.
 */
(function(){
  'use strict';
  const BUCKET_PDF_V1='patient-documents';
  const MAX_BYTES_PDF_V1=20*1024*1024;
  const TIPOS_PDF_V1=['Estudio','Informe','Laboratorio','ECG','Holter','MAPA','Ecocardiograma','Orden','Certificado','Otro'];
  // Bloque 6D.3
  const TIPO_IMAGEN_CLINICA_V1='Imagen clínica';
  const IMG_MAX_DIMENSION_V1=1600; // preserva detalle clínico sin archivos excesivos
  const IMG_JPEG_QUALITY_V1=0.85;

  function escPdfV1(s){try{return typeof escapeHtml==='function'?escapeHtml(s):String(s==null?'':s);}catch(e){return String(s==null?'':s);}}

  // Ficha del paciente: listar/subir/ver/descargar. Mismo conjunto de
  // roles que cardiolink_has_clinical_documents_access() (owner/admin/
  // médico/secretaria) - compuesto a partir de las funciones de rol
  // atómicas que ya existen en app.js, sin inventar ninguna nueva.
  function puedeListarSubirPdfV1(){
    try{
      return !!(
        (typeof esMatiasDuenio==='function'&&esMatiasDuenio())||
        (typeof esAdminComun==='function'&&esAdminComun())||
        (typeof esMedico==='function'&&esMedico())||
        (typeof esSecretaria==='function'&&esSecretaria())
      );
    }catch(e){return false;}
  }
  // Eliminar (ficha o HC) y visibilidad de la sección dentro de Historia
  // Clínica: owner/admin/médico únicamente - Secretaría queda afuera acá
  // aunque sí entra en puedeListarSubirPdfV1(). Mismo gate que ya usa el
  // resto de HC (canAccessClinicalHC() en app.js).
  function puedeAccederClinicaPdfV1(){
    try{return typeof puedeAccederInformacionClinica==='function'&&!!puedeAccederInformacionClinica();}catch(e){return false;}
  }

  function pacienteActivoPdfV1(){
    try{
      // pacienteSeleccionadoPanelId es un "let" de nivel superior en
      // app.js: NO es una propiedad de window (mismo caso que
      // "atenciones"), hay que leer el identificador a secas, que SÍ es
      // visible acá porque todos los <script> clásicos de esta página
      // comparten un único entorno global léxico.
      const key=(typeof pacienteSeleccionadoPanelId!=='undefined'?pacienteSeleccionadoPanelId:'')||'';
      if(!key)return null;
      const lista=(typeof todosPacientes==='function'?todosPacientes():((typeof data!=='undefined'&&data&&data.pacientes)||[]));
      const resolverClave=(typeof clavePacientePanel==='function')?clavePacientePanel:(p=>p&&p.id);
      return lista.find(p=>String(resolverClave(p))===String(key))||null;
    }catch(e){return null;}
  }

  function profNombrePdfV1(id){
    try{const pr=((typeof data!=='undefined'&&data&&data.profesionales)||[]).find(x=>String(x.id)===String(id));return pr?.nombre||id||'';}catch(e){return id||'';}
  }

  function fmtFechaCortaPdfV1(iso){
    try{return new Intl.DateTimeFormat('es-AR',{dateStyle:'short'}).format(new Date(String(iso)+'T00:00:00'));}catch(e){return iso||'';}
  }
  function fmtTamanoPdfV1(bytes){
    if(!bytes)return '';
    const mb=bytes/1024/1024;
    return mb>=1?mb.toFixed(1)+' MB':Math.max(1,Math.round(bytes/1024))+' KB';
  }
  function hoyIsoPdfV1(){return new Date().toISOString().slice(0,10);}

  // ---------------------------------------------------------------------
  // Modal de subida
  // ---------------------------------------------------------------------
  function cerrarModalPdfV1(){document.getElementById('pdfDocsModalV1')?.remove();}

  function opcionesTipoPdfV1(sel){
    return TIPOS_PDF_V1.map(t=>`<option value="${escPdfV1(t)}"${t===sel?' selected':''}>${escPdfV1(t)}</option>`).join('');
  }
  function opcionesProfesionalPdfV1(){
    const profs=(typeof data!=='undefined'&&data&&data.profesionales)||[];
    return '<option value="">(sin especificar)</option>'+profs.map(pr=>`<option value="${escPdfV1(pr.id)}">${escPdfV1(pr.nombre||pr.id)}</option>`).join('');
  }

  function abrirModalSubirPdfV1(patientId){
    if(!puedeListarSubirPdfV1())return;
    cerrarModalPdfV1();
    const modal=document.createElement('div');
    modal.id='pdfDocsModalV1';
    modal.className='hc-modal-overlay';
    modal.innerHTML=`<div class="hc-modal-card">
      <div class="hc-modal-head"><div><h2>Subir PDF</h2><p class="muted">Se asocia automáticamente al paciente de esta ficha.</p></div><button type="button" class="modal-close" data-pdf-close-v1>×</button></div>
      <div class="hc-modal-grid">
        <div class="full"><label for="pdfFileV1">Archivo PDF (máx. 20 MB)</label><input type="file" id="pdfFileV1" accept="application/pdf,.pdf"></div>
        <div><label for="pdfTipoV1">Tipo</label><select id="pdfTipoV1">${opcionesTipoPdfV1('Estudio')}</select></div>
        <div><label for="pdfFechaV1">Fecha</label><input type="date" id="pdfFechaV1" value="${hoyIsoPdfV1()}"></div>
        <div class="full"><label for="pdfTituloV1">Título</label><input type="text" id="pdfTituloV1" placeholder="Ej: Ecocardiograma 07/10/2026" maxlength="200"></div>
        <div><label for="pdfProfesionalV1">Profesional (opcional)</label><select id="pdfProfesionalV1">${opcionesProfesionalPdfV1()}</select></div>
        <div class="full"><label for="pdfDescripcionV1">Descripción (opcional)</label><textarea id="pdfDescripcionV1" maxlength="500"></textarea></div>
        <div class="full"><p class="muted" data-pdf-error-v1 style="color:#b91c1c;display:none"></p></div>
      </div>
      <div class="hc-modal-actions"><button class="secondary" type="button" data-pdf-close-v1>Cancelar</button><button class="primary" type="button" id="pdfSubirBtnV1" data-pdf-patient-v1="${escPdfV1(patientId)}">Subir</button></div>
    </div>`;
    document.body.appendChild(modal);
  }

  function mostrarErrorPdfV1(msg){
    const el=document.querySelector('#pdfDocsModalV1 [data-pdf-error-v1]');
    if(el){el.textContent=msg;el.style.display='block';}
    else alert(msg);
  }

  async function subirPdfV1(){
    const btn=document.getElementById('pdfSubirBtnV1');
    if(!btn||btn.disabled)return;
    const patientId=btn.dataset.pdfPatientV1||'';
    // Resuelve por id real (pacientePorIdPdfV1), no por
    // pacienteSeleccionadoPanelId: este modal puede abrirse tanto desde
    // la ficha como desde "Nueva evolución" (Historia Clínica), y ese
    // tracker es específico de la ficha - usarlo acá rompía la subida
    // cuando se llegaba sin haber visitado antes la ficha de ese
    // paciente. El botón que abrió el modal ya puso el id correcto en su
    // dataset (nunca DNI/nombre - ver nota de la migración sobre el path
    // de Storage), solo confirmamos que corresponde a un paciente real.
    const p=pacientePorIdPdfV1(patientId);
    if(!patientId||!p){mostrarErrorPdfV1('No se pudo identificar al paciente activo. Cerrá y volvé a abrir la ficha.');return;}

    const fileInput=document.getElementById('pdfFileV1');
    const file=fileInput?.files?.[0];
    if(!file){mostrarErrorPdfV1('Elegí un archivo PDF.');return;}
    const nombreArchivo=file.name||'documento.pdf';
    const esPdfMime=file.type==='application/pdf';
    const esPdfExt=/\.pdf$/i.test(nombreArchivo);
    if(!esPdfMime||!esPdfExt){mostrarErrorPdfV1('El archivo debe ser un PDF válido (.pdf).');return;}
    if(file.size>MAX_BYTES_PDF_V1){mostrarErrorPdfV1('El archivo supera el máximo de 20 MB.');return;}

    const titulo=(document.getElementById('pdfTituloV1')?.value||'').trim();
    if(!titulo){mostrarErrorPdfV1('Completá un título.');return;}
    const tipo=document.getElementById('pdfTipoV1')?.value||'Otro';
    const fecha=document.getElementById('pdfFechaV1')?.value||hoyIsoPdfV1();
    const profesionalId=document.getElementById('pdfProfesionalV1')?.value||null;
    const descripcion=(document.getElementById('pdfDescripcionV1')?.value||'').trim()||null;

    btn.disabled=true;btn.textContent='Subiendo...';

    const uuid=(window.crypto&&typeof crypto.randomUUID==='function')?crypto.randomUUID():('xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=Math.random()*16|0;const v=c==='x'?r:(r&0x3|0x8);return v.toString(16);}));
    const storagePath=`${patientId}/${uuid}.pdf`;

    // 1) Subir a Storage primero.
    try{
      const {error:upErr}=await supabaseClient.storage.from(BUCKET_PDF_V1).upload(storagePath,file,{contentType:'application/pdf',upsert:false});
      if(upErr)throw upErr;
    }catch(e){
      btn.disabled=false;btn.textContent='Subir';
      mostrarErrorPdfV1('No se pudo subir el archivo: '+(e?.message||e));
      return;
    }

    let uploadedUserId=null;
    try{uploadedUserId=(await supabaseClient.auth.getUser())?.data?.user?.id||null;}catch(e){}

    const metadata={
      patient_id:patientId,
      attention_id:null,
      document_date:fecha,
      document_type:tipo,
      title:titulo,
      description:descripcion,
      professional_id:profesionalId,
      storage_path:storagePath,
      original_filename:nombreArchivo,
      mime_type:'application/pdf',
      size_bytes:file.size,
      uploaded_by:uploadedUserId
    };

    // 2) Guardar metadata. Si falla, borrar el archivo recién subido para
    //    no dejar huérfanos en Storage. select().single() para tener el
    //    id real de la fila - lo necesita el flujo de "adjunto pendiente"
    //    de abajo (Bloque 6D.2).
    const {data:inserted,error:insErr}=await supabaseClient.from('cardiolink_patient_documents').insert(metadata).select().single();
    if(insErr){
      try{await supabaseClient.storage.from(BUCKET_PDF_V1).remove([storagePath]);}catch(e2){console.warn('No se pudo revertir el archivo huérfano en Storage:',e2);}
      btn.disabled=false;btn.textContent='Subir';
      mostrarErrorPdfV1('No se pudo guardar la información del documento (se revirtió la subida): '+(insErr?.message||insErr));
      return;
    }

    cerrarModalPdfV1();
    // Bloque 6D.2 - si este modal se abrió desde "Nueva evolución" (ese
    // modal queda abierto DEBAJO de este), el documento recién subido se
    // agrega a la lista de adjuntos pendientes de esa evolución. Todavía
    // no se vincula en la base (evolution_id sigue null hasta guardar la
    // evolución) - por eso también se refresca la lista normal abajo, el
    // documento ya existe y es, por ahora, independiente.
    const evoModal=document.getElementById('hcEvolutionModal');
    if(evoModal&&inserted)agregarAdjuntoPendienteV1(evoModal,inserted);
    await cargarYRenderizarListaPdfV1(p);
  }

  // ---------------------------------------------------------------------
  // Bloque 6D.3 - Imagen clínica desde cámara/webcam.
  //
  // Estado de la cámara: una sola variable de módulo para el stream
  // activo (nunca más de uno a la vez - punto 3 de la tarea) y una para
  // el object URL de la foto ya capturada (se libera siempre al
  // descartarla/reemplazarla). "camStreamV1" se detiene con
  // detenerCamaraV1() en TODOS los puntos que pide el punto 6: al tomar
  // la foto, al cambiar de cámara, al cancelar, al cerrar este modal, al
  // cerrar "Nueva evolución" (ver el observer en bootPdfV1) y ante
  // cualquier error.
  // ---------------------------------------------------------------------
  let camStreamV1=null;
  let camPreviewUrlV1=null;
  let camBlobV1=null;

  function detenerCamaraV1(){
    try{camStreamV1?.getTracks?.().forEach(t=>t.stop());}catch(e){}
    camStreamV1=null;
  }
  function liberarPreviewCamV1(){
    try{if(camPreviewUrlV1)URL.revokeObjectURL(camPreviewUrlV1);}catch(e){}
    camPreviewUrlV1=null;
  }
  function cerrarModalCamaraV1(){
    detenerCamaraV1();
    liberarPreviewCamV1();
    camBlobV1=null;
    document.getElementById('pdfCameraModalV1')?.remove();
  }

  function mostrarEstadoCamaraV1(modal,estado){
    ['live','captured','fallback','form'].forEach(k=>{
      const el=modal.querySelector('[data-pdf-cam-'+k+'-v1]');
      if(el)el.classList.toggle('hidden',k!==estado);
    });
  }
  function mostrarErrorCamaraV1(modal,msg){
    const el=modal?.querySelector('[data-pdf-cam-error-v1]');
    if(el){el.textContent=msg;el.style.display='block';}
  }

  async function poblarSelectorCamarasV1(modal,preferirId){
    try{
      if(!navigator.mediaDevices?.enumerateDevices)return;
      const devices=await navigator.mediaDevices.enumerateDevices();
      const cams=devices.filter(d=>d.kind==='videoinput');
      const wrap=modal.querySelector('[data-pdf-cam-select-wrap-v1]');
      const sel=modal.querySelector('#pdfCameraSelectV1');
      if(!sel||!wrap)return;
      if(cams.length<2){wrap.classList.add('hidden');return;}
      wrap.classList.remove('hidden');
      sel.innerHTML=cams.map((c,i)=>`<option value="${escPdfV1(c.deviceId)}">${escPdfV1(c.label||('Cámara '+(i+1)))}</option>`).join('');
      const activeId=preferirId||camStreamV1?.getVideoTracks?.()[0]?.getSettings?.()?.deviceId||cams[0]?.deviceId;
      if(activeId&&[...sel.options].some(o=>o.value===activeId))sel.value=activeId;
    }catch(e){console.warn('No se pudieron listar las cámaras:',e);}
  }

  // Inicia (o reinicia, en el caso de cambiar de cámara) la cámara.
  // deviceId undefined = primera vez, preferir cámara trasera en
  // móvil/tablet (facingMode ideal environment - punto 4). deviceId
  // explícito = selector de cámaras (punto 3).
  async function iniciarCamaraV1(deviceId){
    const modal=document.getElementById('pdfCameraModalV1');
    if(!modal)return;
    detenerCamaraV1();
    if(!navigator.mediaDevices||typeof navigator.mediaDevices.getUserMedia!=='function'){
      mostrarFallbackCamaraV1(modal);
      return;
    }
    const constraints=deviceId
      ?{video:{deviceId:{exact:deviceId}},audio:false}
      :{video:{facingMode:{ideal:'environment'}},audio:false};
    try{
      const stream=await navigator.mediaDevices.getUserMedia(constraints);
      camStreamV1=stream;
      const video=modal.querySelector('#pdfCameraVideoV1');
      if(video){video.srcObject=stream;try{await video.play();}catch(e){}}
      mostrarEstadoCamaraV1(modal,'live');
      await poblarSelectorCamarasV1(modal,deviceId);
    }catch(e){
      console.warn('No se pudo iniciar la cámara:',e);
      mostrarFallbackCamaraV1(modal);
    }
  }
  function mostrarFallbackCamaraV1(modal){
    mostrarEstadoCamaraV1(modal,'fallback');
    mostrarErrorCamaraV1(modal,'No se pudo acceder a una cámara en este dispositivo.');
  }

  function tomarFotoV1(){
    const modal=document.getElementById('pdfCameraModalV1');
    const video=modal?.querySelector('#pdfCameraVideoV1');
    if(!modal||!video||!video.videoWidth){mostrarErrorCamaraV1(modal,'La cámara todavía no está lista. Esperá un instante y volvé a intentar.');return;}
    let w=video.videoWidth,h=video.videoHeight;
    if(w>IMG_MAX_DIMENSION_V1||h>IMG_MAX_DIMENSION_V1){const r=Math.min(IMG_MAX_DIMENSION_V1/w,IMG_MAX_DIMENSION_V1/h);w=Math.round(w*r);h=Math.round(h*r);}
    const canvas=document.createElement('canvas');
    canvas.width=w;canvas.height=h;
    const ctx=canvas.getContext('2d');
    ctx.drawImage(video,0,0,w,h);
    // Apagar la cámara apenas se captura el frame (punto 6): ya no hace
    // falta el stream en vivo, el canvas ya tiene la foto.
    detenerCamaraV1();
    canvas.toBlob(blob=>{
      if(!blob){mostrarErrorCamaraV1(modal,'No se pudo procesar la foto. Probá de nuevo.');mostrarEstadoCamaraV1(modal,'fallback');return;}
      usarBlobCapturadoV1(modal,blob);
    },'image/jpeg',IMG_JPEG_QUALITY_V1);
  }

  function usarBlobCapturadoV1(modal,blob){
    liberarPreviewCamV1();
    camBlobV1=blob;
    camPreviewUrlV1=URL.createObjectURL(blob);
    const img=modal.querySelector('#pdfCameraPreviewV1');
    if(img)img.src=camPreviewUrlV1;
    mostrarEstadoCamaraV1(modal,'captured');
  }

  function repetirFotoV1(){
    const modal=document.getElementById('pdfCameraModalV1');
    if(!modal)return;
    liberarPreviewCamV1();
    camBlobV1=null;
    iniciarCamaraV1();
  }

  function usarEstaImagenV1(){
    const modal=document.getElementById('pdfCameraModalV1');
    if(!modal||!camBlobV1)return;
    const small=modal.querySelector('#pdfCameraPreviewSmallV1');
    if(small)small.src=camPreviewUrlV1;
    mostrarEstadoCamaraV1(modal,'form');
  }

  // Normaliza un archivo elegido por el usuario (fallback de archivo o
  // cámara nativa de celular vía <input capture>) a JPEG mediante canvas:
  // esto además elimina cualquier metadata EXIF/GPS del original (canvas
  // sólo conserva los píxeles, nunca la metadata) - punto 8 de la tarea.
  function normalizarArchivoAJpegV1(file){
    return new Promise((resolve,reject)=>{
      const url=URL.createObjectURL(file);
      const img=new Image();
      const limpiar=()=>{try{URL.revokeObjectURL(url);}catch(e){}};
      img.onload=()=>{
        try{
          let w=img.naturalWidth,h=img.naturalHeight;
          if(!w||!h)throw new Error('Imagen sin dimensiones válidas.');
          if(w>IMG_MAX_DIMENSION_V1||h>IMG_MAX_DIMENSION_V1){const r=Math.min(IMG_MAX_DIMENSION_V1/w,IMG_MAX_DIMENSION_V1/h);w=Math.round(w*r);h=Math.round(h*r);}
          const canvas=document.createElement('canvas');
          canvas.width=w;canvas.height=h;
          const ctx=canvas.getContext('2d');
          ctx.drawImage(img,0,0,w,h);
          canvas.toBlob(blob=>{
            limpiar();
            if(!blob)reject(new Error('No se pudo generar la imagen.'));
            else resolve(blob);
          },'image/jpeg',IMG_JPEG_QUALITY_V1);
        }catch(e){limpiar();reject(e);}
      };
      img.onerror=()=>{limpiar();reject(new Error('Formato de imagen no compatible.'));};
      img.src=url;
    });
  }

  async function manejarArchivoFallbackCamaraV1(file){
    const modal=document.getElementById('pdfCameraModalV1');
    if(!modal||!file)return;
    try{
      const blob=await normalizarArchivoAJpegV1(file);
      usarBlobCapturadoV1(modal,blob);
    }catch(e){
      console.warn('No se pudo procesar el archivo de imagen:',e);
      mostrarEstadoCamaraV1(modal,'fallback');
      mostrarErrorCamaraV1(modal,'No se pudo procesar este archivo de imagen. Probá con otro formato (JPEG o PNG).');
    }
  }

  async function adjuntarImagenV1(){
    const btn=document.getElementById('pdfImgAdjuntarBtnV1');
    if(!btn||btn.disabled)return;
    const modal=document.getElementById('pdfCameraModalV1');
    const patientId=btn.dataset.pdfPatientV1||'';
    const p=pacientePorIdPdfV1(patientId);
    if(!patientId||!p||!camBlobV1){mostrarErrorImagenV1(modal,'No se pudo identificar la imagen o el paciente. Repetí la captura.');return;}
    const titulo=(document.getElementById('pdfImgTituloV1')?.value||'').trim();
    if(!titulo){mostrarErrorImagenV1(modal,'Completá el título / qué es.');return;}
    const descripcion=(document.getElementById('pdfImgDescripcionV1')?.value||'').trim()||null;

    btn.disabled=true;btn.textContent='Subiendo...';

    const uuid=(window.crypto&&typeof crypto.randomUUID==='function')?crypto.randomUUID():('xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=Math.random()*16|0;const v=c==='x'?r:(r&0x3|0x8);return v.toString(16);}));
    // clinical-images/{patient_id}/{uuid}.jpg - nunca DNI/apellido/nombre/
    // diagnóstico en el path (punto 9 de la tarea).
    const storagePath=`clinical-images/${patientId}/${uuid}.jpg`;
    const blob=camBlobV1;

    try{
      const {error:upErr}=await supabaseClient.storage.from(BUCKET_PDF_V1).upload(storagePath,blob,{contentType:'image/jpeg',upsert:false});
      if(upErr)throw upErr;
    }catch(e){
      btn.disabled=false;btn.textContent='Adjuntar imagen';
      mostrarErrorImagenV1(modal,'No se pudo subir la imagen: '+(e?.message||e));
      return;
    }

    let uploadedUserId=null;
    try{uploadedUserId=(await supabaseClient.auth.getUser())?.data?.user?.id||null;}catch(e){}
    const profesionalIdActual=(typeof profesionalIdUsuarioActual==='function'?profesionalIdUsuarioActual():'')||null;

    const metadata={
      patient_id:patientId,
      attention_id:null,
      evolution_id:null,
      document_date:hoyIsoPdfV1(),
      document_type:TIPO_IMAGEN_CLINICA_V1,
      title:titulo,
      description:descripcion,
      professional_id:profesionalIdActual,
      storage_path:storagePath,
      original_filename:'imagen_clinica_'+Date.now()+'.jpg',
      mime_type:'image/jpeg',
      size_bytes:blob.size,
      uploaded_by:uploadedUserId
    };

    const {data:inserted,error:insErr}=await supabaseClient.from('cardiolink_patient_documents').insert(metadata).select().single();
    if(insErr){
      try{await supabaseClient.storage.from(BUCKET_PDF_V1).remove([storagePath]);}catch(e2){console.warn('No se pudo revertir la imagen huérfana en Storage:',e2);}
      btn.disabled=false;btn.textContent='Adjuntar imagen';
      mostrarErrorImagenV1(modal,'No se pudo guardar la información de la imagen (se revirtió la subida): '+(insErr?.message||insErr));
      return;
    }

    cerrarModalCamaraV1();
    const evoModal=document.getElementById('hcEvolutionModal');
    if(evoModal&&inserted)agregarAdjuntoPendienteV1(evoModal,inserted);
    await cargarYRenderizarListaPdfV1(p);
  }
  function mostrarErrorImagenV1(modal,msg){
    const el=modal?.querySelector('[data-pdf-img-error-v1]');
    if(el){el.textContent=msg;el.style.display='block';}
    else alert(msg);
  }

  function abrirModalCamaraV1(patientId){
    // Mismo gate que el resto de Historia Clínica: Secretaría no entra
    // (y de todas formas nunca ve este botón, ver inyectarBotonEvolucionPdfV1).
    if(!puedeAccederClinicaPdfV1())return;
    cerrarModalCamaraV1();
    const modal=document.createElement('div');
    modal.id='pdfCameraModalV1';
    modal.className='hc-modal-overlay';
    modal.innerHTML=`<div class="hc-modal-card">
      <div class="hc-modal-head"><div><h2>Tomar imagen clínica</h2><p class="muted">Fotografiá material con relevancia clínica (lesión, ECG, monitor, estudio previo, etc). No se interpreta automáticamente.</p></div><button type="button" class="modal-close" data-pdf-cam-cancelar-v1>×</button></div>
      <p class="muted" data-pdf-cam-error-v1 style="color:#b91c1c;display:none;margin:0 0 10px"></p>
      <div data-pdf-cam-live-v1>
        <div data-pdf-cam-select-wrap-v1 class="hidden" style="margin-bottom:10px"><label for="pdfCameraSelectV1">Cámara</label><select id="pdfCameraSelectV1"></select></div>
        <video id="pdfCameraVideoV1" autoplay playsinline muted class="pdf-cam-video-v1"></video>
        <div class="hc-modal-actions">
          <button class="secondary" type="button" data-pdf-cam-elegir-archivo-v1>Seleccionar imagen desde archivo</button>
          <button class="primary" type="button" data-pdf-cam-tomar-v1>Tomar foto</button>
        </div>
      </div>
      <div data-pdf-cam-captured-v1 class="hidden">
        <img id="pdfCameraPreviewV1" class="pdf-cam-video-v1" alt="Foto capturada">
        <div class="hc-modal-actions">
          <button class="secondary" type="button" data-pdf-cam-repetir-v1>Repetir</button>
          <button class="primary" type="button" data-pdf-cam-usar-v1>Usar esta imagen</button>
        </div>
      </div>
      <div data-pdf-cam-fallback-v1 class="hidden">
        <div class="hc-modal-actions">
          <button class="primary" type="button" data-pdf-cam-elegir-archivo-v1>Seleccionar imagen</button>
        </div>
      </div>
      <div data-pdf-cam-form-v1 class="hidden">
        <img id="pdfCameraPreviewSmallV1" class="pdf-cam-thumb-v1" alt="Imagen a adjuntar">
        <div class="hc-modal-grid">
          <div class="full"><label for="pdfImgTituloV1">Título / Qué es</label><input type="text" id="pdfImgTituloV1" placeholder="Ej: ECG previo, Lesión miembro inferior" maxlength="200"></div>
          <div class="full"><label for="pdfImgDescripcionV1">Descripción (opcional)</label><textarea id="pdfImgDescripcionV1" maxlength="500"></textarea></div>
          <div class="full"><p class="muted" data-pdf-img-error-v1 style="color:#b91c1c;display:none"></p></div>
        </div>
        <div class="hc-modal-actions">
          <button class="secondary" type="button" data-pdf-cam-repetir-v1>Repetir</button>
          <button class="primary" type="button" id="pdfImgAdjuntarBtnV1" data-pdf-patient-v1="${escPdfV1(patientId)}">Adjuntar imagen</button>
        </div>
      </div>
      <input type="file" id="pdfCameraFileV1" accept="image/*" capture="environment" class="hidden">
    </div>`;
    document.body.appendChild(modal);
    iniciarCamaraV1();
  }

  // ---------------------------------------------------------------------
  // Listado
  // ---------------------------------------------------------------------
  function esImagenClinicaV1(d){return d?.document_type===TIPO_IMAGEN_CLINICA_V1;}

  // Bloque 6E.1 - sólo vista previa de UI (mostrar/ocultar el botón
  // "Enviar"). Mismo criterio que la RLS real de 6D.3: acceso clínico
  // general (incluye Secretaría) salvo Imagen clínica, reservada a
  // owner/admin/médico. La autorización que de verdad importa es la que
  // valida la Edge Function del lado servidor (ver patient-document-delivery).
  function puedeEnviarDocumentoV1(d){
    if(!puedeListarSubirPdfV1())return false;
    if(esImagenClinicaV1(d))return puedeAccederClinicaPdfV1();
    return true;
  }

  function tarjetaDocumentoPdfV1(d){
    const esImg=esImagenClinicaV1(d);
    return `<article class="pdf-doc-row-v1">
      <div>
        <strong>${escPdfV1(d.title)}</strong>
        <span>${escPdfV1(d.document_type)} · ${fmtFechaCortaPdfV1(d.document_date)}${d.professional_id?' · '+escPdfV1(profNombrePdfV1(d.professional_id)):''}</span>
        ${esImg?'':`<span>${escPdfV1(d.original_filename)}${d.size_bytes?' · '+fmtTamanoPdfV1(d.size_bytes):''}</span>`}
        ${d.description?`<span>${escPdfV1(d.description)}</span>`:''}
      </div>
      <div class="pdf-doc-actions-v1">
        <button class="secondary small-btn" type="button" data-pdf-ver-v1="${escPdfV1(d.storage_path)}">${esImg?'Ver imagen':'Ver'}</button>
        ${esImg?'':`<button class="secondary small-btn" type="button" data-pdf-descargar-v1="${escPdfV1(d.storage_path)}" data-pdf-name-v1="${escPdfV1(d.original_filename)}">Descargar</button>`}
        ${puedeEnviarDocumentoV1(d)?`<button class="secondary small-btn" type="button" data-pdf-enviar-v1="${escPdfV1(d.id)}" data-pdf-patient-v1="${escPdfV1(d.patient_id)}">Enviar</button>`:''}
        ${puedeAccederClinicaPdfV1()?`<button class="danger small-btn" type="button" data-pdf-eliminar-v1="${escPdfV1(d.id)}" data-pdf-path-v1="${escPdfV1(d.storage_path)}">Eliminar</button>`:''}
      </div>
    </article>`;
  }

  // Un mismo documento puede estar visible a la vez en la ficha
  // (#pacienteDetalle) y en Historia Clínica (#hcPacienteDetalle): una
  // sola consulta a la tabla de metadata por refresco. Nunca se duplica
  // el archivo, la fila ni el bucket - solo se distribuye la misma data:
  //   - Ficha (#pacienteDetalle): TODOS los documentos del paciente,
  //     vinculados o no (repositorio administrativo general).
  //   - "Estudios y documentos" dentro de Historia Clínica: SOLO los
  //     independientes (evolution_id null) - los vinculados ya se
  //     muestran anidados dentro de su propia evolución (ver
  //     inyectarDocumentosEnEvolucionesV1), nunca los dos a la vez.
  async function cargarYRenderizarListaPdfV1(p){
    if(!p?.id)return;
    const conts=Array.from(document.querySelectorAll('[data-pdf-docs-list-v1]'))
      .filter(el=>el.closest('[data-pdf-docs-section-v1]')?.dataset.pdfDocsSectionV1===String(p.id));
    const hcRoot=document.getElementById('hcPacienteDetalle');
    if(!conts.length&&!hcRoot)return;
    let rows=[];
    try{
      const {data:fetched,error}=await supabaseClient.from('cardiolink_patient_documents').select('*').eq('patient_id',p.id).order('document_date',{ascending:false}).order('created_at',{ascending:false});
      if(error)throw error;
      rows=fetched||[];
    }catch(e){
      const html=`<p class="muted">No se pudo cargar la lista de documentos: ${escPdfV1(e?.message||e)}</p>`;
      conts.forEach(c=>c.innerHTML=html);
      return;
    }
    conts.forEach(cont=>{
      const dentroDeHC=hcRoot&&hcRoot.contains(cont);
      const visibles=dentroDeHC?rows.filter(d=>!d.evolution_id):rows;
      cont.innerHTML=visibles.length?visibles.map(tarjetaDocumentoPdfV1).join(''):'<p class="muted">Todavía no hay documentos subidos.</p>';
    });
    if(hcRoot)inyectarDocumentosEnEvolucionesV1(hcRoot,rows);
  }

  // Bloque 6D.2/6D.3 - bloque anidado "Estudios / documentos asociados"
  // dentro de cada artículo de evolución de la línea de tiempo on-screen
  // (renderEvolutionEventHC, app.js, ya trae data-hc-evolution-id en cada
  // <article> - no hace falta tocar app.js para esto). PDFs: Ver/Descargar
  // (sin Eliminar, igual que 6D.2). Imagen clínica: solo "Ver imagen" +
  // descripción si existe, sin nombre de archivo (punto 15 de la tarea).
  function tarjetaDocumentoAnidadaV1(d){
    const btnEnviar=puedeEnviarDocumentoV1(d)?` <button class="secondary small-btn" type="button" data-pdf-enviar-v1="${escPdfV1(d.id)}" data-pdf-patient-v1="${escPdfV1(d.patient_id)}">Enviar</button>`:'';
    if(esImagenClinicaV1(d)){
      return `<div class="pdf-doc-linked-item-v1 pdf-doc-linked-img-v1"><strong>${escPdfV1(d.document_type)}</strong><br>${escPdfV1(d.title)}${d.description?`<br><em>"${escPdfV1(d.description)}"</em>`:''}<br>${fmtFechaCortaPdfV1(d.document_date)}${d.professional_id?' · '+escPdfV1(profNombrePdfV1(d.professional_id)):''}<br><button class="secondary small-btn" type="button" data-pdf-ver-v1="${escPdfV1(d.storage_path)}">Ver imagen</button>${btnEnviar}</div>`;
    }
    return `<p class="pdf-doc-linked-item-v1">[${escPdfV1(d.document_type)}] <strong>${escPdfV1(d.title)}</strong> · ${fmtFechaCortaPdfV1(d.document_date)}${d.professional_id?' · '+escPdfV1(profNombrePdfV1(d.professional_id)):''} <button class="secondary small-btn" type="button" data-pdf-ver-v1="${escPdfV1(d.storage_path)}">Ver</button> <button class="secondary small-btn" type="button" data-pdf-descargar-v1="${escPdfV1(d.storage_path)}" data-pdf-name-v1="${escPdfV1(d.original_filename)}">Descargar</button>${btnEnviar}</p>`;
  }
  function inyectarDocumentosEnEvolucionesV1(hcRoot,rows){
    const porEvolucion={};
    rows.forEach(d=>{if(d.evolution_id)(porEvolucion[d.evolution_id]=porEvolucion[d.evolution_id]||[]).push(d);});
    hcRoot.querySelectorAll('[data-hc-evolution-id]').forEach(art=>{
      const evId=art.dataset.hcEvolutionId;
      const docs=(evId&&porEvolucion[evId])||[];
      let box=art.querySelector('[data-pdf-evo-linked-v1]');
      if(!docs.length){box?.remove();return;}
      const html=`<div class="hc-event-section pdf-evo-linked-v1" data-pdf-evo-linked-v1><label>Estudios / documentos asociados</label>${docs.map(tarjetaDocumentoAnidadaV1).join('')}</div>`;
      if(box)box.outerHTML=html;
      else art.insertAdjacentHTML('beforeend',html);
    });
  }

  // ---------------------------------------------------------------------
  // Ver / Descargar (URL firmada temporal - el bucket es privado)
  // ---------------------------------------------------------------------
  async function verPdfV1(path){
    try{
      const {data:signed,error}=await supabaseClient.storage.from(BUCKET_PDF_V1).createSignedUrl(path,120);
      if(error)throw error;
      window.open(signed.signedUrl,'_blank');
    }catch(e){alert('No se pudo abrir el documento: '+(e?.message||e));}
  }
  async function descargarPdfV1(path,filename){
    try{
      const {data:signed,error}=await supabaseClient.storage.from(BUCKET_PDF_V1).createSignedUrl(path,120,{download:filename||true});
      if(error)throw error;
      window.open(signed.signedUrl,'_blank');
    }catch(e){alert('No se pudo descargar el documento: '+(e?.message||e));}
  }

  // ---------------------------------------------------------------------
  // Eliminar: confirmar -> borrar Storage -> si confirma, borrar metadata.
  // ---------------------------------------------------------------------
  async function eliminarPdfV1(id,path,patientId){
    if(!confirm('¿Eliminar este documento? Esta acción no se puede deshacer.'))return;
    try{
      const {error:rmErr}=await supabaseClient.storage.from(BUCKET_PDF_V1).remove([path]);
      if(rmErr)throw rmErr;
      const {error:delErr}=await supabaseClient.from('cardiolink_patient_documents').delete().eq('id',id);
      if(delErr)throw delErr;
    }catch(e){
      alert('No se pudo eliminar el documento: '+(e?.message||e));
      return;
    }
    // patientId viene del data-pdf-docs-section-v1 más cercano al botón
    // (ver listener de click) - no de pacienteActivoPdfV1(), por el mismo
    // motivo que subirPdfV1(): esta tarjeta puede estar en la ficha o en
    // Historia Clínica, pantallas con trackers de "paciente activo"
    // distintos. cargarYRenderizarListaPdfV1 sólo necesita el id.
    if(patientId)await cargarYRenderizarListaPdfV1({id:patientId});
  }

  // ---------------------------------------------------------------------
  // Inserción en la ficha del paciente (#pacienteDetalle), sin mezclar con
  // evoluciones ni con "Documentos clínicos e informes rápidos" (406).
  // ---------------------------------------------------------------------
  function seccionPdfV1(p){
    return `<section class="pdf-docs-v1" data-pdf-docs-section-v1="${escPdfV1(p.id)}"><div class="pdf-docs-head-v1"><div><h3>Documentos y estudios</h3><p class="muted">PDFs reales (estudios, informes, laboratorio, etc) subidos a este paciente.</p></div><button class="primary" type="button" data-pdf-nuevo-v1="${escPdfV1(p.id)}">+ Subir PDF</button></div><div class="pdf-doc-list-v1" data-pdf-docs-list-v1><p class="muted">Cargando documentos...</p></div></section>`;
  }

  function enhancePatientFichaPdfV1(){
    const root=document.getElementById('pacienteDetalle');
    if(!root)return;
    if(!puedeListarSubirPdfV1()){root.querySelectorAll('[data-pdf-docs-section-v1]').forEach(x=>x.remove());return;}
    const p=pacienteActivoPdfV1();
    // Sin id real todavía (paciente legacy sin sincronizar): no se ofrece
    // subir para no construir un path de Storage con DNI/nombre.
    if(!p||!p.id)return;
    let section=root.querySelector('[data-pdf-docs-section-v1]');
    if(section&&section.dataset.pdfDocsSectionV1!==String(p.id)){section.remove();section=null;}
    if(section)return;
    const html=seccionPdfV1(p);
    const anchor=root.querySelector('[data-docs-section406]');
    if(anchor)anchor.insertAdjacentHTML('afterend',html);
    else{
      const hist=root.querySelector('.paciente-historial-wrap');
      if(hist)hist.insertAdjacentHTML('beforebegin',html);
      else root.insertAdjacentHTML('beforeend',html);
    }
    cargarYRenderizarListaPdfV1(p);
  }

  // ---------------------------------------------------------------------
  // Bloque 6D.1 — Historia clínica: misma lista, sección "Estudios y
  // documentos", solo lectura + acciones (la subida vive en el botón
  // "Subir estudio / PDF" de "Nueva evolución", más abajo). Secretaría NO
  // ve esta sección (puedeAccederClinicaPdfV1), aunque sí vea la de la
  // ficha.
  // ---------------------------------------------------------------------
  function seccionPdfHCV1(p){
    return `<section class="pdf-docs-v1" data-pdf-docs-section-v1="${escPdfV1(p.id)}"><div class="pdf-docs-head-v1"><div><h3>Estudios y documentos</h3><p class="muted">PDFs reales (estudios, informes, laboratorio, etc) subidos a este paciente.</p></div></div><div class="pdf-doc-list-v1" data-pdf-docs-list-v1><p class="muted">Cargando documentos...</p></div></section>`;
  }

  // Resolver genérico "paciente por id real", sin depender de en qué
  // pantalla se originó la acción: pacienteSeleccionadoPanelId (usado por
  // pacienteActivoPdfV1) es un tracker específico de la FICHA
  // (#pacienteDetalle) y queda desactualizado/irrelevante cuando la
  // acción viene de Historia Clínica o del modal "Nueva evolución" - este
  // helper evita ese acoplamiento, buscando directo por el id que cada
  // botón ya trae en su propio dataset. patientKeyHC(p) (app.js) es p.id
  // cuando el paciente tiene id real - mismo caso que exigimos siempre -
  // así que alcanza con buscar por id directo, sin necesitar esa función
  // (vive en otro IIFE, no accesible desde este módulo independiente).
  function pacientePorIdPdfV1(key){
    if(!key)return null;
    try{
      const lista=(typeof todosPacientes==='function'?todosPacientes():((typeof data!=='undefined'&&data&&data.pacientes)||[]));
      return lista.find(x=>String(x.id||'')===String(key))||null;
    }catch(e){return null;}
  }

  function enhanceHCPdfV1(){
    const root=document.getElementById('hcPacienteDetalle');
    if(!root)return;
    if(!puedeAccederClinicaPdfV1()){root.querySelectorAll('[data-pdf-docs-section-v1]').forEach(x=>x.remove());return;}
    const key=root.querySelector('[data-hc-new]')?.dataset.hcNew||'';
    const p=pacientePorIdPdfV1(key);
    if(!p||!p.id)return;
    let section=root.querySelector('[data-pdf-docs-section-v1]');
    if(section&&section.dataset.pdfDocsSectionV1!==String(p.id)){section.remove();section=null;}
    if(section)return;
    const html=seccionPdfHCV1(p);
    const docs406=root.querySelector('[data-docs-section406]');
    const summary=root.querySelector('.hc-clinical-summary');
    if(docs406)docs406.insertAdjacentHTML('afterend',html);
    else if(summary)summary.insertAdjacentHTML('afterend',html);
    else root.insertAdjacentHTML('beforeend',html);
    cargarYRenderizarListaPdfV1(p);
  }

  // "Nueva evolución" (#hcEvolutionModal, app.js): se le agregan los
  // botones "Subir estudio / PDF" (data-pdf-nuevo-v1, ya existente desde
  // 6D.1) y "Tomar imagen clínica" (data-pdf-tomar-imagen-v1, 6D.3) -
  // ambos manejados por el listener de click de abajo. Este modal ya
  // está gateado a owner/admin/médico (requireClinicalHC() en app.js), no
  // hace falta un chequeo de permiso extra acá para Secretaría.
  function inyectarBotonEvolucionPdfV1(modal){
    try{
      if(!modal||modal.querySelector('[data-pdf-nuevo-v1]'))return;
      const key=modal.querySelector('[data-hc-edit-patient409]')?.dataset.hcEditPatient409||'';
      const p=pacientePorIdPdfV1(key);
      if(!p||!p.id)return;
      const actions=modal.querySelector('.hc-patient-title-actions409');
      if(!actions)return;
      const bImg=document.createElement('button');
      bImg.type='button';
      bImg.className='secondary small-btn';
      bImg.dataset.pdfTomarImagenV1=p.id;
      bImg.textContent='Tomar imagen clínica';
      actions.prepend(bImg);
      const b=document.createElement('button');
      b.type='button';
      b.className='secondary small-btn';
      b.dataset.pdfNuevoV1=p.id;
      b.textContent='Subir estudio / PDF';
      actions.prepend(b);
    }catch(e){}
  }

  // ---------------------------------------------------------------------
  // Bloque 6D.2 - "Estudios / documentos adjuntos" dentro del modal
  // "Nueva evolución": lista en memoria (dataset del propio modal, se
  // pierde al cerrarlo - no es persistencia real, solo estado de UI
  // mientras se edita). "Quitar de esta evolución" ANTES de guardar sólo
  // la saca de esta lista: nunca borra archivo ni metadata, el documento
  // sigue existiendo como estudio independiente del paciente.
  // ---------------------------------------------------------------------
  function pendingDocsGetV1(modal){
    try{return JSON.parse(modal.dataset.pdfPendingDocsV1||'[]');}catch(e){return [];}
  }
  function pendingDocsSetV1(modal,list){
    modal.dataset.pdfPendingDocsV1=JSON.stringify(list||[]);
  }
  // Bloque 6D.3 - distingue PDFs ("Estudios / documentos adjuntos") de
  // imágenes clínicas ("Imágenes clínicas adjuntas", con descripción y
  // botón "Ver imagen" - punto 12 de la tarea). Si hay de ambos tipos en
  // la lista pendiente, se muestran en dos bloques separados.
  function itemPendienteHtmlV1(d){
    const esImg=esImagenClinicaV1(d);
    return `<article class="pdf-doc-row-v1"><div><strong>[${escPdfV1(d.document_type)}] ${escPdfV1(d.title)}</strong><span>${fmtFechaCortaPdfV1(d.document_date)}</span>${esImg&&d.description?`<span>${escPdfV1(d.description)}</span>`:''}</div><div class="pdf-doc-actions-v1"><button class="secondary small-btn" type="button" data-pdf-ver-v1="${escPdfV1(d.storage_path)}">${esImg?'Ver imagen':'Ver'}</button><button class="secondary small-btn" type="button" data-pdf-quitar-pendiente-v1="${escPdfV1(d.id)}">Quitar de esta evolución</button></div></article>`;
  }
  function renderAdjuntosPendientesV1(modal){
    const list=pendingDocsGetV1(modal);
    let box=modal.querySelector('[data-pdf-pending-box-v1]');
    if(!list.length){box?.remove();return;}
    const pdfs=list.filter(d=>!esImagenClinicaV1(d));
    const imagenes=list.filter(esImagenClinicaV1);
    const bloque=(titulo,items)=>items.length?`<section class="pdf-docs-v1 pdf-docs-pending-v1"><div class="pdf-docs-head-v1"><div><h3>${escPdfV1(titulo)}</h3><p class="muted">Se vincularán a esta evolución al guardar.</p></div></div><div class="pdf-doc-list-v1">${items.map(itemPendienteHtmlV1).join('')}</div></section>`:'';
    const html=`<div data-pdf-pending-box-v1>${bloque('Estudios / documentos adjuntos',pdfs)}${bloque('Imágenes clínicas adjuntas',imagenes)}</div>`;
    if(box)box.outerHTML=html;
    else{
      const actionsRow=modal.querySelector('.hc-modal-actions');
      if(actionsRow)actionsRow.insertAdjacentHTML('beforebegin',html);
      else modal.querySelector('.hc-modal-card')?.insertAdjacentHTML('beforeend',html);
    }
  }
  function agregarAdjuntoPendienteV1(modal,doc){
    const list=pendingDocsGetV1(modal);
    list.push({id:doc.id,document_type:doc.document_type,title:doc.title,description:doc.description||null,document_date:doc.document_date,storage_path:doc.storage_path});
    pendingDocsSetV1(modal,list);
    renderAdjuntosPendientesV1(modal);
  }

  // Al abrir el modal (nueva evolución o editando una existente): botón
  // de subida + precarga de adjuntos ya vinculados (si se está editando)
  // para poder verlos/quitarlos sin perder de vista qué ya tenía.
  async function inicializarEvolucionModalPdfV1(){
    const modal=document.getElementById('hcEvolutionModal');
    if(!modal||modal.dataset.pdfPendingInitV1)return;
    modal.dataset.pdfPendingInitV1='1';
    inyectarBotonEvolucionPdfV1(modal);
    const evolutionId=modal.dataset.hcEvolutionId||'';
    if(!evolutionId)return;
    try{
      const {data:rows,error}=await supabaseClient.from('cardiolink_patient_documents').select('*').eq('evolution_id',evolutionId);
      if(error)throw error;
      const lista=(rows||[]).map(d=>({id:d.id,document_type:d.document_type,title:d.title,description:d.description||null,document_date:d.document_date,storage_path:d.storage_path}));
      pendingDocsSetV1(modal,lista);
      // Set original, separado de la lista "pendiente" editable: al
      // guardar, lo que quedó afuera de la lista pendiente respecto de
      // este set es lo que hay que desvincular.
      modal.dataset.pdfYaVinculadosV1=JSON.stringify((rows||[]).map(d=>d.id));
      renderAdjuntosPendientesV1(modal);
    }catch(e){console.warn('No se pudieron precargar los documentos ya vinculados a esta evolución:',e);}
  }

  // Hook llamado por app.js (saveEvolutionHC) una vez que la evolución ya
  // se guardó y tiene un id real confirmado - ver el comentario en
  // saveEvolutionHC. Vincula los pendientes actuales y desvincula los que
  // el usuario sacó de la lista con "Quitar de esta evolución". Si algo
  // falla acá, la evolución YA está guardada: nunca se deshace nada, el
  // documento simplemente queda independiente y se avisa brevemente.
  async function vincularAdjuntosPendientesEvolucionV1(evolutionId){
    const modal=document.getElementById('hcEvolutionModal');
    if(!modal)return;
    const pendientes=pendingDocsGetV1(modal);
    const pendientesIds=new Set(pendientes.map(d=>String(d.id)));
    let yaVinculadosIds=[];
    try{yaVinculadosIds=JSON.parse(modal.dataset.pdfYaVinculadosV1||'[]');}catch(e){}
    const aVincular=[...pendientesIds];
    const aDesvincular=yaVinculadosIds.map(String).filter(id=>!pendientesIds.has(id));
    const fallos=[];
    for(const id of aVincular){
      try{
        const {error}=await supabaseClient.from('cardiolink_patient_documents').update({evolution_id:evolutionId}).eq('id',id);
        if(error)throw error;
      }catch(e){fallos.push(id);console.warn('No se pudo vincular el documento '+id+' a la evolución:',e);}
    }
    for(const id of aDesvincular){
      try{
        const {error}=await supabaseClient.from('cardiolink_patient_documents').update({evolution_id:null}).eq('id',id);
        if(error)throw error;
      }catch(e){fallos.push(id);console.warn('No se pudo desvincular el documento '+id+' de la evolución:',e);}
    }
    // Bug UI Fase 7 - hasta acá el evolution_id ya quedó actualizado en
    // Supabase, pero ninguna lista en pantalla se enteraba: ni Ficha del
    // paciente ni Historia Clínica volvían a pedir los datos (dependía
    // por completo de que el guardado de la evolución reconstruyera HC
    // desde cero - Ficha nunca se tocaba). Mismo patientId que ya resuelve
    // inyectarBotonEvolucionPdfV1 para este mismo modal (atributo que ya
    // existe en el banner, "Editar ficha") - no se agrega estado nuevo,
    // sólo se reutiliza. cargarYRenderizarListaPdfV1 ya actualiza todos
    // los contenedores que coincidan (Ficha y HC a la vez, estén o no
    // montados en este momento) - mismo mecanismo que ya usan subirPdfV1/
    // adjuntarImagenV1/guardarPdfDocumentoGenerado406.
    const patientKey=modal.querySelector('[data-hc-edit-patient409]')?.dataset.hcEditPatient409||'';
    if(patientKey){try{await cargarYRenderizarListaPdfV1({id:patientKey});}catch(e){console.warn('No se pudo refrescar la lista de documentos tras vincular/desvincular:',e);}}
    if(fallos.length)alert('La evolución se guardó, pero '+fallos.length+' documento(s) no se pudieron vincular/desvincular y quedaron como estudios independientes del paciente.');
  }
  window.vincularAdjuntosPendientesEvolucionV1=vincularAdjuntosPendientesEvolucionV1;

  // ---------------------------------------------------------------------
  // Bloque 6D.2 (impresión de HC) — helper reutilizable para
  // printHC402() (app.js): devuelve los documentos del paciente para que
  // la impresión los intercale en la línea de tiempo. Misma tabla, misma
  // consulta que la pantalla - no se duplica nada. Expuesto en window
  // porque printHC402() vive en otro IIFE (app.js) y no puede ver los
  // identificadores internos de este módulo.
  // ---------------------------------------------------------------------
  async function obtenerDocumentosParaImpresionHC402(patientId){
    if(!patientId)return [];
    try{
      const {data:rows,error}=await supabaseClient.from('cardiolink_patient_documents').select('*').eq('patient_id',patientId).order('document_date',{ascending:false}).order('created_at',{ascending:false});
      if(error)throw error;
      return rows||[];
    }catch(e){
      console.warn('No se pudieron obtener documentos para la impresión de HC:',e);
      return [];
    }
  }
  window.obtenerDocumentosParaImpresionHC402=obtenerDocumentosParaImpresionHC402;

  // ---------------------------------------------------------------------
  // Bloque 6E.1 - Enviar documento/estudio ya almacenado (Email/WhatsApp/
  // Ambos) vía la Edge Function patient-document-delivery. Este módulo
  // NUNCA decide quién puede ver qué: eso ya lo hace la RLS (6D.3) y lo
  // vuelve a validar la propia Edge Function con el JWT real de quien
  // llama. Lo de acá es sólo UI: abrir el modal, mostrar una vista previa
  // razonable del destinatario, invocar la función y mostrar el resultado.
  // ---------------------------------------------------------------------
  async function invocarEntregaDocumentoV1(action,documentId){
    if(!supabaseClient?.functions?.invoke)return {ok:false,error:'Sin conexión a Supabase.'};
    try{
      const {data,error}=await supabaseClient.functions.invoke('patient-document-delivery',{body:{action,documentId}});
      if(error)return {ok:false,error:error.message||'No se pudo contactar el servicio de envío.'};
      return data||{ok:false,error:'Respuesta vacía del servicio de envío.'};
    }catch(e){
      return {ok:false,error:e?.message||'Error inesperado contactando el servicio de envío.'};
    }
  }

  // Vista previa de UI únicamente (mismo orden de prioridad que
  // resolverDestinatarios() del lado servidor: canal propio del paciente
  // primero, contacto responsable si falta). El envío real vuelve a
  // resolver esto en la Edge Function - si algo cambiara entre la
  // vista previa y el envío, gana siempre el servidor.
  function resolverContactoPreviewV1(p){
    const email=(p?.email&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email))?p.email:((p?.contactoResponsableEmail&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.contactoResponsableEmail))?p.contactoResponsableEmail:'');
    const telefono=p?.telefono||p?.contactoResponsableTelefono||'';
    const nombre=p?.nombreCompleto||p?.paciente||'';
    return {email,telefono,nombre};
  }

  function cerrarModalEnviarV1(){document.getElementById('pdfEnviarModalV1')?.remove();}

  function abrirModalEnviarV1(documentId,patientId){
    const p=pacientePorIdPdfV1(patientId);
    const contacto=resolverContactoPreviewV1(p);
    cerrarModalEnviarV1();
    const modal=document.createElement('div');
    modal.id='pdfEnviarModalV1';
    modal.className='hc-modal-overlay';
    modal.innerHTML=`<div class="hc-modal-card">
      <div class="hc-modal-head"><div><h2>Enviar documento</h2><p class="muted">Destinatario resuelto automáticamente - no hace falta volver a escribirlo.</p></div><button type="button" class="modal-close" data-pdf-enviar-close-v1>×</button></div>
      <div class="hc-modal-grid">
        <div class="full"><label>Destinatario</label><p>${escPdfV1(contacto.nombre||'Paciente')}</p></div>
        <div><label>Email</label><p>${contacto.email?escPdfV1(contacto.email):'<span class="muted">Sin email registrado</span>'}</p></div>
        <div><label>WhatsApp</label><p>${contacto.telefono?escPdfV1(contacto.telefono):'<span class="muted">Sin teléfono registrado</span>'}</p></div>
        <div class="full"><label>Canal</label>
          <div class="pdf-enviar-canales-v1">
            <label><input type="radio" name="pdfEnviarCanalV1" value="email" ${contacto.email?'checked':''} ${contacto.email?'':'disabled'}> Email</label>
            <label><input type="radio" name="pdfEnviarCanalV1" value="whatsapp" ${!contacto.email&&contacto.telefono?'checked':''} ${contacto.telefono?'':'disabled'}> WhatsApp</label>
            <label><input type="radio" name="pdfEnviarCanalV1" value="ambos" ${contacto.email&&contacto.telefono?'':'disabled'}> Ambos</label>
          </div>
        </div>
        <div class="full" data-pdf-enviar-estado-v1></div>
      </div>
      <div class="hc-modal-actions"><button class="secondary" type="button" data-pdf-enviar-close-v1>Cancelar</button><button class="primary" type="button" id="pdfEnviarConfirmarBtnV1" data-pdf-document-v1="${escPdfV1(documentId)}">Enviar</button></div>
    </div>`;
    document.body.appendChild(modal);
  }

  function mostrarEstadoEnvioV1(texto){
    const el=document.querySelector('[data-pdf-enviar-estado-v1]');
    if(el)el.innerHTML=texto;
  }

  // Mismo truco que comms460AbrirVentanaWhatsapp (app.js, Patient
  // Communications V1): abrir la pestaña en blanco de forma SÍNCRONA,
  // dentro del mismo click, y recién navegarla cuando llega la respuesta
  // async - abrir después de un await pierde el "user activation" y el
  // navegador la bloquea como popup.
  function abrirVentanaWhatsappV1(){
    try{return window.open('about:blank','_blank');}catch(e){return null;}
  }
  function navegarOFallbackWhatsappV1(winRef,url){
    if(winRef&&!winRef.closed){
      try{winRef.location.href=url;return true;}catch(e){}
    }
    const el=document.querySelector('[data-pdf-enviar-estado-v1]');
    if(el)el.insertAdjacentHTML('beforeend',`<p><a href="${escPdfV1(url)}" target="_blank" rel="noopener">El navegador bloqueó la apertura automática. Tocá acá para abrir WhatsApp.</a></p>`);
    return false;
  }

  async function confirmarEnvioV1(){
    const btn=document.getElementById('pdfEnviarConfirmarBtnV1');
    if(!btn||btn.disabled)return;
    const documentId=btn.dataset.pdfDocumentV1||'';
    const canal=document.querySelector('input[name="pdfEnviarCanalV1"]:checked')?.value||'';
    if(!documentId||!canal){mostrarEstadoEnvioV1('<p class="muted" style="color:#b91c1c">Elegí un canal.</p>');return;}

    // La ventana de WhatsApp se abre SÍNCRONAMENTE acá (si corresponde),
    // antes de cualquier await - ver nota de abrirVentanaWhatsappV1.
    const necesitaWhatsapp=canal==='whatsapp'||canal==='ambos';
    const winWhatsapp=necesitaWhatsapp?abrirVentanaWhatsappV1():null;

    btn.disabled=true;btn.textContent='Enviando...';
    mostrarEstadoEnvioV1('<p class="muted">Enviando...</p>');

    let resultadoEmail=null,resultadoWhatsapp=null;
    if(canal==='email'||canal==='ambos'){
      resultadoEmail=await invocarEntregaDocumentoV1('send-email',documentId);
    }
    if(necesitaWhatsapp){
      resultadoWhatsapp=await invocarEntregaDocumentoV1('prepare-whatsapp',documentId);
      if(resultadoWhatsapp?.ok&&resultadoWhatsapp.telefono){
        const url='https://wa.me/'+resultadoWhatsapp.telefono+'?text='+encodeURIComponent(resultadoWhatsapp.mensaje||'');
        navegarOFallbackWhatsappV1(winWhatsapp,url);
      }else{
        try{winWhatsapp&&!winWhatsapp.closed&&winWhatsapp.close();}catch(e){}
      }
    }

    btn.disabled=false;btn.textContent='Enviar';

    // Feedback por canal (punto 14 de la tarea): si uno falla, nunca
    // ocultar que el otro funcionó.
    const partes=[];
    if(resultadoEmail){
      if(resultadoEmail.duplicado)partes.push('<p>Email: ya se había enviado hace un instante (no se reenvió).</p>');
      else if(resultadoEmail.ok&&resultadoEmail.enviado)partes.push('<p>Email ✓ Documento enviado por email.'+(resultadoEmail.adjuntoReal?'':' (como enlace, el archivo era muy grande para adjuntar)')+'</p>');
      else partes.push('<p style="color:#b91c1c">Email: no se pudo enviar'+(resultadoEmail.error||resultadoEmail.motivo?' ('+(resultadoEmail.error||resultadoEmail.motivo)+')':'')+'.</p>');
    }
    if(resultadoWhatsapp){
      if(resultadoWhatsapp.duplicado)partes.push('<p>WhatsApp: ya se había preparado hace un instante (no se repitió).</p>');
      else if(resultadoWhatsapp.ok)partes.push('<p>WhatsApp preparado ✓ Se abrió con el mensaje y el enlace al documento.</p>');
      else partes.push('<p style="color:#b91c1c">No se pudo preparar WhatsApp'+(resultadoWhatsapp.error?' ('+resultadoWhatsapp.error+')':'')+'.</p>');
    }
    const avisoProf=(resultadoEmail?.avisoProfesional)||(resultadoWhatsapp?.avisoProfesional);
    if(avisoProf?.enviado)partes.push('<p class="muted">Se avisó automáticamente al profesional.</p>');
    mostrarEstadoEnvioV1(partes.join(''));
  }

  // ---------------------------------------------------------------------
  // Bloque 6E.2 - "Guardar PDF" / "Enviar" para documentos generados
  // (Orden/Certificado/Constancia). El PDF en sí lo genera app.js
  // (window.generarPdfDocumentoGenerado406, única fuente de contenido -
  // ver su comentario en app.js); acá sólo se archiva (mismo patrón que
  // subirPdfV1: Storage primero, metadata después, revertir huérfano si
  // falla) y se evitan duplicados/se versiona por source_document_id +
  // source_content_hash (migración 20261008110000).
  // ---------------------------------------------------------------------

  // Busca si este documento fuente YA tiene un PDF archivado. Si el
  // contenido no cambió desde ese archivado (mismo hash), lo reutiliza
  // (punto 10: nunca duplicar). Si cambió, archiva una fila NUEVA sin
  // tocar la anterior (punto 11: versionar, no sobrescribir). Devuelve
  // {ok, documentId, patientId, reusado, error}.
  async function asegurarDocumentoArchivadoV1(docId){
    let generado;
    try{
      generado=await window.generarPdfDocumentoGenerado406?.(docId,null);
    }catch(e){
      return {ok:false,error:'No se pudo generar el PDF: '+(e?.message||e)};
    }
    if(!generado)return {ok:false,error:'No se pudo generar el PDF.'};
    if(!generado.ok)return {ok:false,error:generado.error||'No se pudo generar el PDF.'};

    try{
      const {data:existentes,error:buscarError}=await supabaseClient
        .from('cardiolink_patient_documents')
        .select('id,source_content_hash')
        .eq('source_document_id',generado.sourceDocumentId)
        .order('created_at',{ascending:false})
        .limit(1);
      if(buscarError)throw buscarError;
      const existente=existentes&&existentes.length?existentes[0]:null;
      if(existente&&existente.source_content_hash===generado.sourceContentHash){
        // Mismo contenido ya archivado: reutilizar, no subir de nuevo.
        return {ok:true,documentId:existente.id,patientId:generado.patientId,reusado:true};
      }

      const uuid=(window.crypto&&typeof crypto.randomUUID==='function')?crypto.randomUUID():('xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=Math.random()*16|0;const v=c==='x'?r:(r&0x3|0x8);return v.toString(16);}));
      // documents/{patient_id}/{uuid}.pdf - punto 9 de la tarea: sin
      // DNI/nombre/apellido/diagnóstico en el path.
      const storagePath=`documents/${generado.patientId}/${uuid}.pdf`;

      const {error:upErr}=await supabaseClient.storage.from(BUCKET_PDF_V1).upload(storagePath,generado.blob,{contentType:'application/pdf',upsert:false});
      if(upErr)throw upErr;

      let uploadedUserId=null;
      try{uploadedUserId=(await supabaseClient.auth.getUser())?.data?.user?.id||null;}catch(e){}

      const {data:inserted,error:insErr}=await supabaseClient.from('cardiolink_patient_documents').insert({
        patient_id:generado.patientId,
        attention_id:null,
        evolution_id:null, // nunca se inventa: estos documentos no nacen dentro de una evolución
        document_date:generado.documentDate,
        document_type:generado.documentType,
        title:generado.title,
        description:generado.description,
        professional_id:generado.professionalId,
        storage_path:storagePath,
        original_filename:generado.originalFilename,
        mime_type:'application/pdf',
        size_bytes:generado.blob.size,
        uploaded_by:uploadedUserId,
        source_document_id:generado.sourceDocumentId,
        source_content_hash:generado.sourceContentHash
      }).select().single();
      if(insErr){
        try{await supabaseClient.storage.from(BUCKET_PDF_V1).remove([storagePath]);}catch(e2){console.warn('No se pudo revertir el PDF huérfano en Storage:',e2);}
        throw insErr;
      }
      return {ok:true,documentId:inserted.id,patientId:generado.patientId,reusado:false};
    }catch(e){
      return {ok:false,error:'No se pudo archivar el PDF: '+(e?.message||e)};
    }
  }

  window.guardarPdfDocumentoGenerado406=async function(docId,btn){
    if(btn){if(btn.disabled)return;btn.disabled=true;btn.textContent='Generando PDF...';}
    const r=await asegurarDocumentoArchivadoV1(docId);
    if(btn){btn.disabled=false;btn.textContent='Guardar PDF';}
    if(!r.ok){alert(r.error||'No se pudo guardar el PDF.');return;}
    if(r.patientId)await cargarYRenderizarListaPdfV1({id:r.patientId});
    alert('Documento guardado.');
  };

  window.enviarPdfDocumentoGenerado406=async function(docId,btn){
    if(btn){if(btn.disabled)return;btn.disabled=true;btn.textContent='Generando PDF...';}
    const r=await asegurarDocumentoArchivadoV1(docId);
    if(btn){btn.disabled=false;btn.textContent='Enviar';}
    if(!r.ok){
      // Punto 21 de la tarea: si falla ANTES de archivar, no hay nada que
      // "quedó guardado" - mensaje distinto del caso "se guardó pero no
      // se pudo enviar" (ese lo maneja el propio modal de 6E.1 por canal).
      alert(r.error||'No se pudo generar/archivar el documento.');
      return;
    }
    if(r.patientId)await cargarYRenderizarListaPdfV1({id:r.patientId});
    // Reutiliza íntegramente el modal/flujo de 6E.1 (patient-document-delivery) -
    // ningún sistema de envío nuevo, ningún segundo motor de WhatsApp.
    abrirModalEnviarV1(r.documentId,r.patientId);
  };

  function wrapSeleccionarPacientePanelPdfV1(){
    const old=window.seleccionarPacientePanel;
    if(typeof old!=='function'||old.__pdfV1)return;
    const wrapped=function(){const r=old.apply(this,arguments);setTimeout(enhancePatientFichaPdfV1,60);return r;};
    wrapped.__pdfV1=true;
    window.seleccionarPacientePanel=seleccionarPacientePanel=wrapped;
  }

  document.addEventListener('click',e=>{
    const nuevo=e.target.closest?.('[data-pdf-nuevo-v1]');
    if(nuevo){abrirModalSubirPdfV1(nuevo.dataset.pdfNuevoV1);return;}
    if(e.target.closest?.('[data-pdf-close-v1]')){cerrarModalPdfV1();return;}
    if(e.target.id==='pdfSubirBtnV1'){subirPdfV1();return;}
    // Bloque 6D.3 - Tomar imagen clínica
    const tomarImg=e.target.closest?.('[data-pdf-tomar-imagen-v1]');
    if(tomarImg){abrirModalCamaraV1(tomarImg.dataset.pdfTomarImagenV1);return;}
    if(e.target.closest?.('[data-pdf-cam-cancelar-v1]')){cerrarModalCamaraV1();return;}
    if(e.target.closest?.('[data-pdf-cam-tomar-v1]')){tomarFotoV1();return;}
    if(e.target.closest?.('[data-pdf-cam-repetir-v1]')){repetirFotoV1();return;}
    if(e.target.closest?.('[data-pdf-cam-usar-v1]')){usarEstaImagenV1();return;}
    if(e.target.closest?.('[data-pdf-cam-elegir-archivo-v1]')){document.getElementById('pdfCameraFileV1')?.click();return;}
    if(e.target.id==='pdfImgAdjuntarBtnV1'){adjuntarImagenV1();return;}
    const ver=e.target.closest?.('[data-pdf-ver-v1]');
    if(ver){verPdfV1(ver.dataset.pdfVerV1);return;}
    const desc=e.target.closest?.('[data-pdf-descargar-v1]');
    if(desc){descargarPdfV1(desc.dataset.pdfDescargarV1,desc.dataset.pdfNameV1);return;}
    const del=e.target.closest?.('[data-pdf-eliminar-v1]');
    if(del){eliminarPdfV1(del.dataset.pdfEliminarV1,del.dataset.pdfPathV1,del.closest('[data-pdf-docs-section-v1]')?.dataset.pdfDocsSectionV1||'');return;}
    // Bloque 6E.1 - Enviar documento/estudio
    const enviar=e.target.closest?.('[data-pdf-enviar-v1]');
    if(enviar){abrirModalEnviarV1(enviar.dataset.pdfEnviarV1,enviar.dataset.pdfPatientV1);return;}
    if(e.target.closest?.('[data-pdf-enviar-close-v1]')){cerrarModalEnviarV1();return;}
    if(e.target.id==='pdfEnviarConfirmarBtnV1'){confirmarEnvioV1();return;}
    const quitar=e.target.closest?.('[data-pdf-quitar-pendiente-v1]');
    if(quitar){
      const modal=quitar.closest('#hcEvolutionModal');
      if(modal){
        const list=pendingDocsGetV1(modal).filter(d=>String(d.id)!==String(quitar.dataset.pdfQuitarPendienteV1));
        pendingDocsSetV1(modal,list);
        renderAdjuntosPendientesV1(modal);
      }
      return;
    }
  },true);

  // Bloque 6D.3 - cambio de cámara (selector, sólo visible con >1
  // dispositivo) y selección de archivo del fallback.
  document.addEventListener('change',e=>{
    if(e.target.id==='pdfCameraSelectV1'){iniciarCamaraV1(e.target.value);return;}
    if(e.target.id==='pdfCameraFileV1'){
      const file=e.target.files?.[0];
      e.target.value='';
      if(file)manejarArchivoFallbackCamaraV1(file);
      return;
    }
  });

  function bootPdfV1(){
    wrapSeleccionarPacientePanelPdfV1();
    enhancePatientFichaPdfV1();
    enhanceHCPdfV1();
    const pd=document.getElementById('pacienteDetalle');
    if(pd)new MutationObserver(()=>setTimeout(enhancePatientFichaPdfV1,0)).observe(pd,{childList:true,subtree:true});
    const hc=document.getElementById('hcPacienteDetalle');
    if(hc)new MutationObserver(()=>setTimeout(enhanceHCPdfV1,0)).observe(hc,{childList:true,subtree:true});
    // #hcEvolutionModal ("Nueva evolución") se crea/destruye como hijo
    // directo de <body> (ver openEvolutionModalHC en app.js) - alcanza con
    // observar los hijos directos de body, sin subtree. Bloque 6D.3: si
    // "Nueva evolución" se cierra mientras la cámara sigue montada/activa
    // (caso límite), se fuerza a apagarla - la luz de la cámara nunca
    // debe quedar encendida después de cerrar (punto 6 de la tarea).
    new MutationObserver(()=>{
      if(document.getElementById('hcEvolutionModal')){
        setTimeout(inicializarEvolucionModalPdfV1,0);
      }else if(document.getElementById('pdfCameraModalV1')||camStreamV1){
        cerrarModalCamaraV1();
      }
    }).observe(document.body,{childList:true});
    setTimeout(()=>{wrapSeleccionarPacientePanelPdfV1();enhancePatientFichaPdfV1();enhanceHCPdfV1();},900);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bootPdfV1);else bootPdfV1();
})();
