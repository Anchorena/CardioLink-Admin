/* CardioLink · COPIAS PARA FACTURACIÓN V1
 *
 * Módulo independiente (NO modifica app.js). Cargar DESPUÉS de app.js.
 * Sube, lista, descarga, imprime y elimina PDF destinados a la facturación mensual al Círculo Médico
 * (Holter / MAPA: primera página firmada y sellada; Eco: versión de EcoApp). Son archivos INDEPENDIENTES de los
 * informes clínicos: no tocan cardiolink_patient_documents, la HC, el portal del paciente ni los documentos enviados.
 *
 * Infraestructura (docs/propuestas/pending_review_copias_facturacion_v1.sql):
 *   - bucket privado "billing-copies" (sólo PDF, 10 MB, ruta "{uuid}.pdf"; sin URL pública: se abre con descarga autenticada)
 *   - tabla cardiolink_copias_facturacion (metadata + estado de impresión)
 *   - RPC cardiolink_copia_facturacion_impresion_v1 (marcar impreso / reimprimir)
 * La autorización REAL vive en el servidor (RLS + asociaciones Secretaría–Médico). Lo que este módulo decide en pantalla
 * (qué botones mostrar) sólo evita ofrecer acciones que el servidor rechazaría.
 *
 * Enganches (todos por envoltura, sin tocar app.js):
 *   - seccionPermitida / showSection: sección "Copias para facturación" (grupo Administrativo).
 *   - abrirAgendaModal: bloque "Copia de facturación" dentro de la ficha del turno.
 *   - renderTabla (Listado): estado "Copia de facturación subida" y botón por atención de estudio.
 */
(function () {
  'use strict';
  if (window.CardioLinkCopiasFacturacionV1) return;

  const BUCKET = 'billing-copies';
  const TABLA = 'cardiolink_copias_facturacion';
  const SECCION = 'copiasFacturacion';
  const MAX_BYTES = 10 * 1024 * 1024;
  const TIPOS = ['Holter', 'MAPA', 'Ecocardiograma'];
  const COLS = 'id,copy_type,patient_id,patient_name,patient_dni,attention_id,professional_id,professional_name,service,obra_social,study_date,original_filename,size_bytes,print_status,print_count,printed_at,uploaded_by,created_at';

  // ---------------------------------------------------------------- utilidades
  // Acceso a los globales de app.js: las variables "let" de nivel superior NO son propiedades de window (se leen por nombre); las funciones sí.
  const g = (name) => {
    try {
      switch (name) {
        case 'supabaseClient': return typeof supabaseClient !== 'undefined' ? supabaseClient : undefined;
        case 'usuarioSupabase': return typeof usuarioSupabase !== 'undefined' ? usuarioSupabase : undefined;
        case 'data': return typeof data !== 'undefined' ? data : undefined;
        case 'atenciones': return typeof atenciones !== 'undefined' ? atenciones : undefined;
        default: return window[name];
      }
    } catch (e) { return undefined; }
  };
  function sb() { const c = g('supabaseClient'); return c || null; }
  function usuarioId() { const u = g('usuarioSupabase'); return u && u.id ? String(u.id) : ''; }
  function rolEs(fn) { try { const f = g(fn); return typeof f === 'function' && !!f(); } catch (e) { return false; } }
  const esOwnerAdmin = () => rolEs('esMatiasDuenio') || rolEs('esAdminComun');
  const esMedicoRol = () => rolEs('esMedico');
  const esSecretariaRol = () => rolEs('esSecretaria');
  function puedeUsar() { return esOwnerAdmin() || esMedicoRol() || esSecretariaRol(); }
  function miProfesionalId() { try { const f = g('profesionalIdUsuarioActual'); return typeof f === 'function' ? String(f() || '') : ''; } catch (e) { return ''; } }
  function profesionales() { try { const d = g('data'); return ((d && d.profesionales) || []).filter((p) => p && p.id && p.id !== 'general'); } catch (e) { return []; } }
  function nombreProfesional(id) { const p = profesionales().find((x) => String(x.id) === String(id)); return (p && p.nombre) || String(id || ''); }
  function norm(s) { return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim(); }
  function soloDigitos(s) { return String(s == null ? '' : s).replace(/\D/g, ''); }
  function hoyIso() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function mesActual() { return hoyIso().slice(0, 7); }
  function fmtFecha(iso) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? m[3] + '/' + m[2] + '/' + m[1] : String(iso || ''); }
  function fmtFechaHora(ts) { try { return new Date(ts).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }); } catch (e) { return String(ts || ''); } }
  function fmtTam(b) { if (!b) return ''; const mb = b / 1048576; return mb >= 1 ? mb.toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }
  function uuid() {
    if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); });
  }
  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (v == null || v === false) return;
      if (k === 'className') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'dataset') Object.entries(v).forEach(([dk, dv]) => { n.dataset[dk] = dv; });
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    });
    [].concat(children == null ? [] : children).forEach((c) => { if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c))); });
    return n;
  }
  function tipoDesdePrestacion(prestacion) {
    try { const f = g('tipoPrest'); const t = typeof f === 'function' ? f(prestacion) : ''; return t === 'HOLTER' ? 'Holter' : t === 'MAPA' ? 'MAPA' : t === 'ECO' ? 'Ecocardiograma' : ''; } catch (e) { return ''; }
  }
  const esAtencionDeEstudio = (a) => !!a && !!tipoDesdePrestacion(a.prestacion);
  function textoErrorPermiso(e, base) {
    const m = String((e && (e.message || e.details)) || e || '');
    if (e && (e.code === '42501' || /row-level security|violates row|permission denied|sin permiso/i.test(m))) {
      return base + 'no tenés permiso para este profesional o esta copia. Si corresponde, pedile al administrador que revise tus asociaciones.';
    }
    return base + m;
  }

  // Profesionales autorizados de Secretaría (RPC existente de Seguridad clínica V1); null = no se pudo consultar (el servidor decide).
  let autorizados = { uid: null, lista: null };
  async function profesionalesAutorizados() {
    if (!esSecretariaRol()) return null;
    try {
      const uid = usuarioId();
      if (autorizados.uid === uid && Array.isArray(autorizados.lista)) return autorizados.lista;
      const { data: lista, error } = await sb().rpc('cardiolink_profesionales_autorizados_secretaria_v1');
      if (error || !Array.isArray(lista)) return null;
      autorizados = { uid, lista: lista.map(String) };
      return autorizados.lista;
    } catch (e) { return null; }
  }
  // Lista de profesionales entre los que el usuario puede cargar/ver copias.
  async function profesionalesElegibles() {
    const todos = profesionales();
    if (esOwnerAdmin()) return todos.map((p) => ({ id: String(p.id), nombre: p.nombre || p.id }));
    if (esMedicoRol()) { const mio = miProfesionalId(); return mio ? [{ id: mio, nombre: nombreProfesional(mio) }] : []; }
    if (esSecretariaRol()) {
      const lista = await profesionalesAutorizados();
      if (!lista) return todos.map((p) => ({ id: String(p.id), nombre: p.nombre || p.id }));   // el servidor rechazará lo no autorizado
      return lista.map((id) => ({ id, nombre: nombreProfesional(id) }));
    }
    return [];
  }
  // ¿Se ofrece eliminar? Espejo de cardiolink_copia_facturacion_puede_eliminar_v1 (el servidor decide).
  function puedeEliminar(fila) {
    if (esOwnerAdmin()) return true;
    if (esMedicoRol()) return !!miProfesionalId() && String(fila.professional_id) === miProfesionalId();
    if (esSecretariaRol()) return !!fila.uploaded_by && String(fila.uploaded_by) === usuarioId();
    return false;
  }

  // ---------------------------------------------------------------- Storage / archivo
  // storage_path no se trae en el listado (no hace falta exponerlo en pantalla): se resuelve por id al abrir.
  const rutas = new Map();
  async function rutaPorId(id) {
    if (rutas.has(id)) return rutas.get(id);
    const { data: r, error } = await sb().from(TABLA).select('storage_path').eq('id', id).single();
    if (error || !r) throw (error || new Error('Copia inexistente o sin permiso.'));
    rutas.set(id, r.storage_path);
    return r.storage_path;
  }
  async function obtenerBlob(fila) {
    const ruta = await rutaPorId(fila.id);
    const { data: blob, error } = await sb().storage.from(BUCKET).download(ruta);   // descarga autenticada: el bucket es privado, no hay URL pública
    if (error || !blob) throw (error || new Error('No se pudo leer el archivo.'));
    return blob;
  }
  function nombreArchivoDescarga(fila) {
    const limpio = (s) => norm(s).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'paciente';
    return 'Copia_facturacion_' + limpio(fila.copy_type) + '_' + limpio(fila.patient_name) + '_' + String(fila.study_date || '').slice(0, 10) + '.pdf';
  }
  async function descargar(fila) {
    const blob = await obtenerBlob(fila);
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: nombreArchivoDescarga(fila) });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  const esDispositivoTactil = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  // Imprime UNA copia: en escritorio con un iframe oculto (diálogo de impresión directo); en iPad/iPhone (donde ese camino imprime en blanco) abre el PDF en una pestaña.
  async function imprimir(fila) {
    let ventana = null;
    if (esDispositivoTactil()) ventana = window.open('', '_blank');   // se abre en el clic (antes del await) para que Safari no la bloquee
    let url = '';
    try {
      const blob = await obtenerBlob(fila);
      url = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
      if (ventana) { ventana.location.href = url; return; }
      await new Promise((resolve) => {
        const f = el('iframe', { 'aria-hidden': 'true', style: 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden' });
        let hecho = false;
        const fin = () => { if (hecho) return; hecho = true; resolve(); setTimeout(() => f.remove(), 120000); };
        f.addEventListener('load', () => {
          try { f.contentWindow.focus(); f.contentWindow.print(); fin(); }
          catch (e) { window.open(url, '_blank'); fin(); }
        });
        f.src = url;
        document.body.append(f);
        setTimeout(() => { if (!hecho) { window.open(url, '_blank'); fin(); } }, 8000);
      });
    } catch (e) {
      if (ventana) ventana.close();
      throw e;
    } finally {
      if (url) setTimeout(() => URL.revokeObjectURL(url), 180000);
    }
  }
  async function registrarImpresion(id, accion) {
    const { data: r, error } = await sb().rpc('cardiolink_copia_facturacion_impresion_v1', { p_id: id, p_accion: accion });
    if (error) throw error;
    if (!r || r.ok !== true) throw new Error('El servidor no confirmó el cambio.');
    return r;
  }
  // Eliminar: primero el archivo (la política de Storage exige que la fila exista), después la fila. Si la fila no se pudo eliminar, la copia sigue en la lista y se reintenta.
  async function eliminarCopia(fila) {
    // Mismo predicado que usa el servidor: si no corresponde, se corta ANTES de tocar el archivo (nunca queda una fila sin archivo por falta de permiso).
    const { data: permitido, error: permErr } = await sb().rpc('cardiolink_copia_facturacion_puede_eliminar_v1', { p_prof: fila.professional_id, p_uploaded_by: fila.uploaded_by || null });
    if (permErr) throw permErr;
    if (permitido !== true) throw Object.assign(new Error('Sin permiso para eliminar esta copia.'), { code: '42501' });
    const ruta = await rutaPorId(fila.id);
    const { error: rmErr } = await sb().storage.from(BUCKET).remove([ruta]);
    if (rmErr) throw rmErr;
    const { data: borradas, error } = await sb().from(TABLA).delete().eq('id', fila.id).select('id');
    if (error) throw error;
    if (!borradas || !borradas.length) throw new Error('El servidor no eliminó la copia: sin permiso para eliminarla.');
    rutas.delete(fila.id);
  }

  // Quita un archivo recién subido cuyo alta de fila falló. Un reintento; devuelve true si quedó limpio (false = hay que avisar: el archivo sigue en Storage sin fila).
  async function limpiarHuerfano(ruta) {
    for (let i = 0; i < 2; i++) {
      try {
        const { error } = await sb().storage.from(BUCKET).remove([ruta]);
        if (!error) return true;
      } catch (e) { /* reintenta */ }
    }
    return false;
  }

  // ---------------------------------------------------------------- Modal de subida
  function cerrarModal() { document.getElementById('copiasFactModalV1')?.remove(); }
  function atencionesDeEstudio() {
    try {
      const f = g('atenciones');
      const lista = Array.isArray(f) ? f : [];
      const op = g('atencionesOperativas');
      return (typeof op === 'function' ? op(lista) : lista).filter((a) => a && a.tipoRegistro !== 'mensaje' && esAtencionDeEstudio(a));
    } catch (e) { return []; }
  }
  function atencionPorId(id) { try { const l = g('atenciones'); return (Array.isArray(l) ? l : []).find((a) => String(a.id) === String(id)) || null; } catch (e) { return null; } }
  function pacienteIdDeAtencion(a) {
    if (a.pacienteId) return String(a.pacienteId);
    const dni = soloDigitos(a.dni);
    try { const f = g('pacienteIdPorDni'); const id = typeof f === 'function' ? f(dni) : ''; if (id) return String(id); } catch (e) { /* sigue */ }
    return dni ? 'legacy_' + dni : '';
  }
  function pacienteIdDesdeDni(dni) {
    const d = soloDigitos(dni);
    if (!d) return '';
    try { const f = g('pacienteIdPorDni'); const id = typeof f === 'function' ? f(d) : ''; if (id) return String(id); } catch (e) { /* sigue */ }
    return 'legacy_' + d;
  }

  async function abrirModalSubir(opciones) {
    if (!puedeUsar()) return;
    cerrarModal();
    const pre = (opciones && opciones.atencion) || null;
    const elegibles = await profesionalesElegibles();
    const st = { atencionId: pre ? String(pre.id) : '' };

    const err = el('p', { className: 'copias-fact-error', role: 'alert', hidden: true });
    const inFile = el('input', { type: 'file', id: 'cfFile', accept: 'application/pdf,.pdf' });
    const inBuscar = el('input', { type: 'search', id: 'cfBuscar', placeholder: 'Apellido o DNI (opcional)', autocomplete: 'off' });
    const lista = el('div', { className: 'copias-fact-sugerencias' });
    const chip = el('div', { className: 'copias-fact-vinculo', hidden: true });
    const inNombre = el('input', { type: 'text', id: 'cfNombre', maxlength: '200' });
    const inDni = el('input', { type: 'text', id: 'cfDni', inputmode: 'numeric', maxlength: '15' });
    const inOs = el('input', { type: 'text', id: 'cfOs', maxlength: '120' });
    const inServicio = el('input', { type: 'text', id: 'cfServicio', maxlength: '160' });
    const inFecha = el('input', { type: 'date', id: 'cfFecha', value: hoyIso() });
    const selTipo = el('select', { id: 'cfTipo' }, [el('option', { value: '', text: '(elegí el tipo)' })].concat(TIPOS.map((t) => el('option', { value: t, text: t }))));
    const selProf = el('select', { id: 'cfProf' }, (elegibles.length === 1 ? [] : [el('option', { value: '', text: elegibles.length ? '(elegí el profesional)' : '(sin profesionales disponibles)' })])
      .concat(elegibles.map((p) => el('option', { value: p.id, text: p.nombre }))));
    const btnSubir = el('button', { type: 'button', className: 'primary', id: 'cfSubir', text: 'Subir copia' });
    const btnSinVincular = el('button', { type: 'button', className: 'secondary', id: 'cfSinVincular', hidden: true, text: 'Cargar sin vincular a la atención', onclick: () => {
      st.atencionId = ''; chip.hidden = true; btnSinVincular.hidden = true; [inNombre, inDni].forEach((i) => { i.readOnly = false; }); mostrarError(''); btnSubir.click();
    } });
    const mostrarError = (m) => { err.textContent = m; err.hidden = !m; if (!m) btnSinVincular.hidden = true; };

    function aplicarAtencion(a) {
      st.atencionId = String(a.id);
      inNombre.value = a.paciente || '';
      inDni.value = a.dni || '';
      inOs.value = a.obraSocial || a.coberturaAtencion || '';
      inServicio.value = a.prestacion || '';
      if (a.fecha) inFecha.value = String(a.fecha).slice(0, 10);
      const t = tipoDesdePrestacion(a.prestacion); if (t) selTipo.value = t;
      const pid = String(a.profesionalId || '');
      // Owner/admin: si el profesional de la atención no figura en la configuración local, se ofrece igual (el servidor valida contra la atención).
      if (pid && esOwnerAdmin() && !elegibles.some((p) => p.id === pid)) {
        elegibles.push({ id: pid, nombre: a.profesional || pid });
        selProf.append(el('option', { value: pid, text: a.profesional || pid }));
      }
      if (pid && elegibles.some((p) => p.id === pid)) selProf.value = pid;
      else if (elegibles.length === 1) selProf.value = elegibles[0].id;
      [inNombre, inDni].forEach((i) => { i.readOnly = true; });
      chip.hidden = false;
      chip.replaceChildren(el('span', { text: 'Vinculada a la atención del ' + fmtFecha(a.fecha) + ' · ' + (a.paciente || '') + ' · ' + (a.prestacion || '') + ' (se cargan automáticamente paciente, DNI, profesional, prestación, obra social y fecha)' }),
        el('button', { type: 'button', className: 'secondary', text: 'Desvincular', onclick: () => {
          st.atencionId = ''; chip.hidden = true; [inNombre, inDni].forEach((i) => { i.readOnly = false; });
        } }));
      lista.replaceChildren();
    }
    function sugerir() {
      const q = norm(inBuscar.value), qd = soloDigitos(inBuscar.value);
      lista.replaceChildren();
      if (q.length < 2) return;
      const hits = atencionesDeEstudio()
        .filter((a) => norm(a.paciente).includes(q) || (qd.length >= 3 && soloDigitos(a.dni).includes(qd)))
        .filter((a) => esOwnerAdmin() || !elegibles.length || elegibles.some((p) => p.id === String(a.profesionalId || '')))
        .sort((x, y) => String(y.fecha || '').localeCompare(String(x.fecha || ''))).slice(0, 8);
      if (!hits.length) { lista.append(el('p', { className: 'muted', text: 'Sin atenciones de Holter, MAPA o Eco que coincidan. Podés cargar los datos a mano.' })); return; }
      hits.forEach((a) => lista.append(el('button', { type: 'button', className: 'copias-fact-sugerencia', onclick: () => aplicarAtencion(a) },
        [el('strong', { text: a.paciente || '' }), ' · ' + fmtFecha(a.fecha) + ' · ' + (a.prestacion || '') + ' · ' + (a.profesional || '') + ' · ' + (a.obraSocial || '')])));
    }
    inBuscar.addEventListener('input', sugerir);

    btnSubir.addEventListener('click', async () => {
      if (btnSubir.disabled) return;
      mostrarError('');
      const file = inFile.files && inFile.files[0];
      if (!file) return mostrarError('Elegí el archivo PDF.');
      if (!/\.pdf$/i.test(file.name || '') || (file.type && file.type !== 'application/pdf')) return mostrarError('El archivo debe ser un PDF válido (.pdf).');
      if (file.size > MAX_BYTES) return mostrarError('El archivo supera el máximo de 10 MB.');
      if (file.size < 100) return mostrarError('El archivo está vacío o dañado.');
      try { const cab = new TextDecoder().decode(await file.slice(0, 5).arrayBuffer()); if (cab !== '%PDF-') return mostrarError('El archivo no parece un PDF válido.'); } catch (e) { /* el servidor igual restringe a PDF */ }
      const nombre = inNombre.value.trim(), dni = soloDigitos(inDni.value), tipo = selTipo.value, prof = selProf.value, fecha = inFecha.value;
      if (!nombre) return mostrarError('Completá el nombre del paciente.');
      if (!dni) return mostrarError('Completá el DNI del paciente.');
      if (!tipo) return mostrarError('Elegí el tipo de copia (Holter, MAPA o Ecocardiograma).');
      if (!prof) return mostrarError('Elegí el profesional.');
      if (!fecha) return mostrarError('Completá la fecha del estudio.');
      const atencion = st.atencionId ? atencionPorId(st.atencionId) : null;
      const pacienteId = (atencion ? pacienteIdDeAtencion(atencion) : '') || pacienteIdDesdeDni(dni);
      if (!pacienteId) return mostrarError('No se pudo identificar al paciente: revisá el DNI.');

      // aviso de duplicado (misma atención y tipo): se permite subir otra, pero se pregunta
      if (st.atencionId) {
        try {
          const { data: ex } = await sb().from(TABLA).select('id').eq('attention_id', st.atencionId).eq('copy_type', tipo).limit(1);
          if (ex && ex.length && !window.confirm('Esta atención ya tiene una copia de facturación de tipo ' + tipo + '. ¿Subir otra igual?')) return;
        } catch (e) { /* el aviso es una ayuda; no bloquea */ }
      }
      btnSubir.disabled = true; btnSubir.textContent = 'Subiendo…';
      const ruta = uuid() + '.pdf';
      try {
        const { error: upErr } = await sb().storage.from(BUCKET).upload(ruta, file, { contentType: 'application/pdf', upsert: false });
        if (upErr) throw upErr;
      } catch (e) {
        btnSubir.disabled = false; btnSubir.textContent = 'Subir copia';
        return mostrarError(textoErrorPermiso(e, 'No se pudo subir el archivo: '));
      }
      const fila = {
        copy_type: tipo, patient_id: pacienteId, patient_name: nombre, patient_dni: dni,
        attention_id: st.atencionId || null, professional_id: prof, professional_name: (atencion && String(atencion.profesionalId) === prof && atencion.profesional) || nombreProfesional(prof),
        service: inServicio.value.trim() || null, obra_social: inOs.value.trim() || null, study_date: fecha,
        storage_path: ruta, original_filename: file.name || 'copia.pdf', mime_type: 'application/pdf', size_bytes: file.size
      };
      const { data: insertada, error: insErr } = await sb().from(TABLA).insert(fila).select(COLS).single();
      if (insErr) {
        const limpio = await limpiarHuerfano(ruta);
        btnSubir.disabled = false; btnSubir.textContent = 'Subir copia';
        const sinSync = !!st.atencionId && (insErr.code === 'CF001' || /no existe en el servidor/i.test(String(insErr.message || '')));
        if (sinSync) {
          mostrarError('La atención todavía no está sincronizada con el servidor, así que no se puede vincular. Esperá la sincronización o cargá la copia SIN vincular a la atención.' + (limpio ? '' : ' (El archivo quedó en el servidor sin registrar: avisá al administrador.)'));
          btnSinVincular.hidden = false;
          return;
        }
        return mostrarError(textoErrorPermiso(insErr, limpio ? 'No se pudo guardar la copia (se revirtió la subida): ' : 'No se pudo guardar la copia y TAMBIÉN falló la limpieza del archivo (avisá al administrador): '));
      }
      cerrarModal();
      cacheAtencion.delete(String(st.atencionId || ''));
      if (opciones && typeof opciones.alTerminar === 'function') opciones.alTerminar(insertada);
      if (seccionVisible()) cargarLista();
    });

    const campo = (rotulo, control, cls) => el('div', { className: cls || '' }, [el('label', { for: control.id, text: rotulo }), control]);
    const modal = el('div', { id: 'copiasFactModalV1', className: 'hc-modal-overlay', role: 'dialog', 'aria-modal': 'true' }, [
      el('div', { className: 'hc-modal-card' }, [
        el('div', { className: 'hc-modal-head' }, [
          el('div', {}, [el('h2', { text: 'Subir copia para facturación' }), el('p', { className: 'muted', text: 'Holter y MAPA: primera página firmada y sellada. Eco: versión para facturación de EcoApp. No se envía al paciente ni modifica el informe clínico.' })]),
          el('button', { type: 'button', className: 'modal-close', text: '×', 'aria-label': 'Cerrar', onclick: cerrarModal })
        ]),
        el('div', { className: 'hc-modal-grid' }, [
          campo('Archivo PDF (máx. 10 MB)', inFile, 'full'),
          el('div', { className: 'full' }, [el('label', { for: 'cfBuscar', text: 'Vincular a una atención (recomendado)' }), inBuscar, chip, lista]),
          campo('Paciente', inNombre), campo('DNI', inDni),
          campo('Tipo de copia', selTipo), campo('Fecha del estudio', inFecha),
          campo('Profesional', selProf), campo('Obra social', inOs),
          campo('Prestación', inServicio, 'full'),
          el('div', { className: 'full' }, [err, btnSinVincular])
        ]),
        el('div', { className: 'hc-modal-actions' }, [el('button', { type: 'button', className: 'secondary', text: 'Cancelar', onclick: cerrarModal }), btnSubir])
      ])
    ]);
    document.body.append(modal);
    if (pre) aplicarAtencion(pre);
    else if (elegibles.length === 1) selProf.value = elegibles[0].id;
    if (esSecretariaRol() && !elegibles.length) mostrarError('No tenés profesionales asociados: pedile al administrador que te asocie a un médico para poder subir copias.');
  }

  // ---------------------------------------------------------------- Sección "Copias para facturación"
  const filtros = { mes: mesActual(), prof: '', os: '', estado: '', texto: '' };
  let filas = [];
  let elegiblesFiltro = [];   // profesionales que el usuario puede ver (aunque todavía no tengan copias): alimentan el filtro «Profesional»
  let cargando = false;
  let ultimaCarga = 0;
  const seccionVisible = () => !!document.getElementById(SECCION)?.classList.contains('visible');

  function rangoMes(mes) {
    const m = /^(\d{4})-(\d{2})$/.exec(mes || '');
    if (!m) return null;
    const y = Number(m[1]), mo = Number(m[2]);
    const fin = new Date(y, mo, 0).getDate();
    return { desde: m[1] + '-' + m[2] + '-01', hasta: m[1] + '-' + m[2] + '-' + String(fin).padStart(2, '0') };
  }
  function badgeEstado(f) {
    return el('span', { className: 'copias-fact-estado ' + (f.print_status === 'impreso' ? 'impreso' : 'pendiente'),
      text: f.print_status === 'impreso' ? 'Impreso' + (f.print_count > 1 ? ' ×' + f.print_count : '') : 'Pendiente' });
  }
  async function accion(boton, fn, errorBase) {
    if (boton.disabled) return;
    const rotulo = boton.textContent;
    boton.disabled = true;
    try { await fn(); }
    catch (e) { console.warn(errorBase, e); window.alert(textoErrorPermiso(e, errorBase + ' ')); }
    finally { boton.disabled = false; boton.textContent = rotulo; }
  }
  function filaTabla(f) {
    const b = (txt, cls, fn, err) => { const x = el('button', { type: 'button', className: cls || 'secondary', text: txt }); x.addEventListener('click', () => accion(x, fn, err)); return x; };
    const acciones = el('div', { className: 'copias-fact-acciones' }, [
      b('Descargar', 'secondary', () => descargar(f), 'No se pudo descargar la copia:'),
      b(f.print_status === 'impreso' ? 'Reimprimir' : 'Imprimir', 'secondary', async () => {
        await imprimir(f);
        if (f.print_status === 'impreso') { await registrarImpresion(f.id, 'reimprimir'); await cargarLista(); }
      }, 'No se pudo imprimir la copia:')
    ]);
    if (f.print_status !== 'impreso') acciones.append(b('Marcar impreso', 'primary', async () => { await registrarImpresion(f.id, 'marcar_impreso'); await cargarLista(); }, 'No se pudo marcar la copia:'));
    if (puedeEliminar(f)) {
      acciones.append(b('Eliminar', 'danger', async () => {
        const ok = window.confirm('¿Eliminar esta copia para facturación?\n\n' + f.copy_type + ' · ' + f.patient_name + ' · ' + fmtFecha(f.study_date) +
          '\n\nSe elimina SÓLO esta copia. El informe clínico y los documentos de la historia clínica no se tocan. Esta acción no se puede deshacer.');
        if (!ok) return;
        await eliminarCopia(f); await cargarLista();
      }, 'No se pudo eliminar la copia:'));
    }
    return el('tr', { dataset: { copiaId: f.id } }, [
      el('td', { text: fmtFecha(f.study_date) }),
      el('td', {}, [el('strong', { text: f.patient_name }), el('br'), el('small', { className: 'muted', text: f.patient_dni ? 'DNI ' + f.patient_dni : '' })]),
      el('td', {}, [el('span', { className: 'copias-fact-tipo', text: f.copy_type }), f.service ? el('br') : null, f.service ? el('small', { className: 'muted', text: f.service }) : null]),
      el('td', { text: f.professional_name || nombreProfesional(f.professional_id) }),
      el('td', { text: f.obra_social || '—' }),
      el('td', {}, [badgeEstado(f), f.printed_at ? el('br') : null, f.printed_at ? el('small', { className: 'muted', text: fmtFechaHora(f.printed_at) }) : null]),
      el('td', { className: 'no-print' }, [acciones])
    ]);
  }
  function opcionesDistintas(valores, rotuloTodos, actual) {
    const set = [...new Set(valores.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), 'es'));
    return [el('option', { value: '', text: rotuloTodos })].concat(set.map((v) => el('option', { value: v.id || v, text: v.nombre || v, selected: (v.id || v) === actual ? true : null })));
  }
  function pintar() {
    const raiz = document.getElementById(SECCION);
    if (!raiz) return;
    const texto = norm(filtros.texto), digitos = soloDigitos(filtros.texto);
    const visibles = filas.filter((f) => (!filtros.os || f.obra_social === filtros.os)
      && (!texto || norm(f.patient_name).includes(texto) || (digitos.length >= 3 && soloDigitos(f.patient_dni).includes(digitos))));
    const pendientes = visibles.filter((f) => f.print_status !== 'impreso').length;
    const profs = new Map(); filas.forEach((f) => profs.set(f.professional_id, f.professional_name || nombreProfesional(f.professional_id)));
    elegiblesFiltro.forEach((p) => { if (!profs.has(String(p.id))) profs.set(String(p.id), p.nombre || p.id); });
    const selProf = el('select', { id: 'cfFiltroProf', 'aria-label': 'Profesional' }, [el('option', { value: '', text: 'Todos los profesionales' })]
      .concat([...profs.entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1]), 'es')).map(([id, nom]) => el('option', { value: id, text: nom, selected: id === filtros.prof ? true : null }))));
    const oss = [...new Set(filas.map((f) => f.obra_social).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
    const selOs = el('select', { id: 'cfFiltroOs', 'aria-label': 'Obra social' }, [el('option', { value: '', text: 'Todas las obras sociales' })]
      .concat(oss.map((o) => el('option', { value: o, text: o, selected: o === filtros.os ? true : null }))));
    const selEstado = el('select', { id: 'cfFiltroEstado', 'aria-label': 'Estado' }, [['', 'Todos los estados'], ['pendiente', 'Pendientes de imprimir'], ['impreso', 'Impresos']]
      .map(([v, t]) => el('option', { value: v, text: t, selected: v === filtros.estado ? true : null })));
    const inMes = el('input', { type: 'month', id: 'cfFiltroMes', value: filtros.mes, 'aria-label': 'Mes y año' });
    const inTexto = el('input', { type: 'search', id: 'cfFiltroTexto', placeholder: 'Buscar paciente o DNI', value: filtros.texto, 'aria-label': 'Buscar paciente o DNI' });
    inMes.addEventListener('change', () => { filtros.mes = inMes.value; cargarLista(); });
    selProf.addEventListener('change', () => { filtros.prof = selProf.value; cargarLista(); });
    selEstado.addEventListener('change', () => { filtros.estado = selEstado.value; cargarLista(); });
    selOs.addEventListener('change', () => { filtros.os = selOs.value; pintar(); });
    let t = null;
    inTexto.addEventListener('input', () => { filtros.texto = inTexto.value; clearTimeout(t); t = setTimeout(() => { pintar(); document.getElementById('cfFiltroTexto')?.focus(); }, 200); });

    const cuerpo = visibles.length
      ? visibles.map(filaTabla)
      : [el('tr', {}, [el('td', { colspan: '7', className: 'muted', text: cargando ? 'Cargando…' : 'No hay copias para estos filtros.' })])];
    raiz.replaceChildren(el('div', { className: 'card copias-fact' }, [
      el('div', { className: 'copias-fact-head' }, [
        el('div', {}, [el('h2', { text: 'Copias para facturación' }),
          el('p', { className: 'muted', text: 'PDF para la facturación mensual al Círculo Médico (Holter/MAPA: primera página firmada y sellada; Eco: versión EcoApp). Se conservan para reimprimir. No se envían al paciente.' })]),
        el('div', { className: 'copias-fact-head-acciones' }, [el('button', { type: 'button', className: 'primary', text: '+ Subir copia', onclick: () => abrirModalSubir({}) })])
      ]),
      el('div', { className: 'copias-fact-filtros' }, [
        el('div', {}, [el('label', { for: 'cfFiltroMes', text: 'Mes y año' }), inMes]),
        el('div', {}, [el('label', { for: 'cfFiltroProf', text: 'Profesional' }), selProf]),
        el('div', {}, [el('label', { for: 'cfFiltroOs', text: 'Obra social' }), selOs]),
        el('div', {}, [el('label', { for: 'cfFiltroEstado', text: 'Estado' }), selEstado]),
        el('div', {}, [el('label', { for: 'cfFiltroTexto', text: 'Paciente / DNI' }), inTexto])
      ]),
      el('p', { className: 'copias-fact-resumen', role: 'status', text: cargando ? 'Cargando…' : visibles.length + ' copia(s) · ' + pendientes + ' pendiente(s) de imprimir' }),
      el('div', { className: 'copias-fact-wrap' }, [el('table', { className: 'copias-fact-tabla' }, [
        el('thead', {}, [el('tr', {}, ['Fecha estudio', 'Paciente', 'Tipo', 'Profesional', 'Obra social', 'Estado', 'Acciones'].map((h) => el('th', { text: h })))]),
        el('tbody', {}, cuerpo)
      ])])
    ]));
  }
  async function cargarLista() {
    if (!sb()) return;
    const rango = rangoMes(filtros.mes);
    try { elegiblesFiltro = await profesionalesElegibles(); } catch (e) { /* el filtro igual lista los de las copias */ }
    cargando = true; pintar();
    try {
      let q = sb().from(TABLA).select(COLS).order('study_date', { ascending: true }).order('patient_name', { ascending: true }).limit(1000);
      if (rango) q = q.gte('study_date', rango.desde).lte('study_date', rango.hasta);
      if (filtros.prof) q = q.eq('professional_id', filtros.prof);
      if (filtros.estado) q = q.eq('print_status', filtros.estado);
      const { data: r, error } = await q;
      if (error) throw error;
      filas = r || [];
      ultimaCarga = Date.now();
    } catch (e) {
      console.warn('No se pudieron cargar las copias para facturación:', e);
      filas = [];
      cargando = false; pintar();
      const resumen = document.querySelector('#' + SECCION + ' .copias-fact-resumen');
      if (resumen) { resumen.textContent = 'No se pudieron cargar las copias: ' + String((e && e.message) || e) + (/relation .* does not exist|schema cache/i.test(String((e && e.message) || '')) ? ' (¿falta aplicar el SQL de Copias para facturación en este entorno?)' : ''); resumen.classList.add('error'); }
      return;
    }
    cargando = false; pintar();
  }

  // ---------------------------------------------------------------- Estado en la atención (Agenda y Listado)
  const cacheAtencion = new Map();   // attention_id -> { total, pendientes, impresas }
  async function resumenPorAtenciones(ids) {
    const limpios = [...new Set(ids.map(String).filter(Boolean))];
    const faltan = limpios.filter((id) => !cacheAtencion.has(id));
    if (faltan.length && sb()) {
      try {
        const { data: r, error } = await sb().from(TABLA).select('attention_id,print_status').in('attention_id', faltan).limit(1000);
        if (error) throw error;
        faltan.forEach((id) => cacheAtencion.set(id, { total: 0, impresas: 0 }));
        (r || []).forEach((x) => { const c = cacheAtencion.get(String(x.attention_id)); if (c) { c.total += 1; if (x.print_status === 'impreso') c.impresas += 1; } });
      } catch (e) { return new Map(); }   // sin tabla / sin permiso: no se muestra nada (nunca rompe la pantalla)
    }
    return new Map(limpios.map((id) => [id, cacheAtencion.get(id) || { total: 0, impresas: 0 }]));
  }
  function etiquetaEstado(c) {
    return el('span', { className: 'copias-fact-chip', title: c.impresas + ' de ' + c.total + ' impresa(s)' },
      ['Copia de facturación subida' + (c.total > 1 ? ' (' + c.total + ')' : ''), c.impresas >= c.total ? ' · impresa' : '']);
  }
  async function puedeCargarParaAtencion(a) {
    if (!puedeUsar() || !esAtencionDeEstudio(a)) return false;
    const prof = String(a.profesionalId || '');
    if (esOwnerAdmin()) return true;
    if (esMedicoRol()) return !!prof && prof === miProfesionalId();
    const lista = await profesionalesAutorizados();
    return !lista || lista.includes(prof);
  }

  // Ficha del turno (Agenda)
  async function decorarAgendaModal(id) {
    const body = document.getElementById('agendaModalBody');
    const a = atencionPorId(id);
    if (!body || !a || !esAtencionDeEstudio(a) || !(await puedeCargarParaAtencion(a))) return;
    body.querySelectorAll('.copias-fact-bloque').forEach((n) => n.remove());
    const bloque = el('div', { className: 'copias-fact-bloque', dataset: { atencionId: String(id) } });
    body.append(bloque);
    const pintarBloque = async () => {
      cacheAtencion.delete(String(id));
      const r = (await resumenPorAtenciones([id])).get(String(id)) || { total: 0, impresas: 0 };
      bloque.replaceChildren(el('h3', { text: 'Copia para facturación' }),
        el('div', { className: 'copias-fact-bloque-fila' }, [
          r.total ? etiquetaEstado(r) : el('span', { className: 'muted', text: 'Sin copia de facturación cargada.' }),
          el('button', { type: 'button', className: 'secondary', text: r.total ? 'Subir otra copia' : 'Subir copia de facturación', onclick: () => abrirModalSubir({ atencion: a, alTerminar: pintarBloque }) })
        ]));
    };
    await pintarBloque();
  }
  // Listado de atenciones
  let timerListado = null;
  function decorarListado() {
    clearTimeout(timerListado);
    timerListado = setTimeout(async () => {
      const tbody = document.getElementById('tablaAtenciones');
      if (!tbody || !puedeUsar()) return;
      const filasUI = [...tbody.querySelectorAll('tr')].map((tr) => ({ tr, btn: tr.querySelector('[data-action="listado-editar"][data-id]') })).filter((x) => x.btn);
      const ids = filasUI.map((x) => x.btn.dataset.id);
      const conEstudio = filasUI.filter((x) => esAtencionDeEstudio(atencionPorId(x.btn.dataset.id)));
      if (!conEstudio.length) return;
      const resumen = await resumenPorAtenciones(ids);
      for (const { tr, btn } of conEstudio) {
        const a = atencionPorId(btn.dataset.id);
        tr.querySelectorAll('.copias-fact-listado').forEach((n) => n.remove());
        const celdaEstado = tr.querySelector('.estado-cell');
        const r = resumen.get(String(btn.dataset.id));
        if (celdaEstado && r && r.total) celdaEstado.append(el('div', { className: 'copias-fact-listado' }, [etiquetaEstado(r)]));
        if (await puedeCargarParaAtencion(a)) {
          const cont = btn.parentElement;
          if (cont && !cont.querySelector('.copias-fact-listado')) {
            cont.append(el('button', { type: 'button', className: 'copias-fact-listado', text: r && r.total ? 'Copia fact. +' : 'Copia fact.', title: 'Subir copia para facturación (Círculo Médico)',
              onclick: () => abrirModalSubir({ atencion: a, alTerminar: () => { cacheAtencion.delete(String(a.id)); decorarListado(); } }) }));
          }
        }
      }
    }, 150);
  }

  // ---------------------------------------------------------------- Enganches (sin tocar app.js)
  function instalar() {
    const prevPermitida = g('seccionPermitida');
    if (typeof prevPermitida === 'function' && !prevPermitida.__copiasFactV1) {
      const w = function (section) { if (section === SECCION) return puedeUsar(); return prevPermitida.apply(this, arguments); };
      w.__copiasFactV1 = true;
      window.seccionPermitida = w;
    }
    const prevShow = g('showSection');
    if (typeof prevShow === 'function' && !prevShow.__copiasFactV1) {
      const w = function (id) {
        const r = prevShow.apply(this, arguments);
        if (id === SECCION && puedeUsar()) {
          const t = document.getElementById('tituloBienvenida'), s = document.getElementById('subtituloPerfil');
          if (t) t.textContent = 'Copias para facturación';
          if (s) s.textContent = 'PDF para el Círculo Médico: descargar, imprimir y controlar lo impreso';
          cargarLista();
        }
        return r;
      };
      w.__copiasFactV1 = true;
      window.showSection = w;
    }
    const prevAgenda = g('abrirAgendaModal');
    if (typeof prevAgenda === 'function' && !prevAgenda.__copiasFactV1) {
      const w = function (id) { const r = prevAgenda.apply(this, arguments); try { decorarAgendaModal(id); } catch (e) { /* nunca rompe la agenda */ } return r; };
      w.__copiasFactV1 = true;
      window.abrirAgendaModal = w;
    }
    const prevTabla = g('renderTabla');
    if (typeof prevTabla === 'function' && !prevTabla.__copiasFactV1) {
      const w = function () { const r = prevTabla.apply(this, arguments); try { decorarListado(); } catch (e) { /* nunca rompe el listado */ } return r; };
      w.__copiasFactV1 = true;
      window.renderTabla = w;
    }
    // El botón del menú puede haber quedado oculto por aplicarPermisosUI antes de instalar el enganche
    try { const ap = g('aplicarPermisosUI'); if (typeof ap === 'function') ap(); } catch (e) { /* sin sesión todavía */ }
  }
  instalar();

  window.CardioLinkCopiasFacturacionV1 = { abrirModalSubir, recargar: cargarLista, _test: { rangoMes, tipoDesdePrestacion, nombreArchivoDescarga, eliminarCopia } };
})();
