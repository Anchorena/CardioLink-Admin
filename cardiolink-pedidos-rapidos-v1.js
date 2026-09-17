/* =====================================================================
   CardioLink - Pedidos rápidos configurables (Documentos/PDF V1, Bloque A)
   v1 . 2026-09-17

   Módulo independiente:
   - NO modifica app.js.
   - NO crea tabla nueva ni cambia el esquema de Supabase: las plantillas
     viven como un array más dentro del mismo config/blob existente
     (data.plantillasPedidos), persistido con saveConfig()+
     guardarConfigEnSupabase298() - mismo mecanismo exacto que
     data.duracionesPrestacion/data.horariosProfesionales/data.obrasSociales.
   - NO toca el módulo documental 406 (openDocumentModal406/
     printDocument406/data.documentosClinicos) ni Agenda V1 ni
     Comunicaciones ni Caja/Facturación/HC.
   - NO genera pedidos todavía ni abre el modal de documento: sólo
     administra las plantillas (crear/editar/activar/ordenar/eliminar).
     La integración con el paciente/documento es el Bloque B.

   Estructura de datos (plana, sin relaciones entre plantillas):
     data.plantillasPedidos = [
       { id, nombre, activo, orden, items: [string, ...] }, ...
     ]

   Permisos: reutiliza puedeAccederInformacionClinica() (ya existente,
   misma familia Matías/Admin/Médico que usa el módulo documental 406) -
   Secretaría no ve esta tarjeta en este Bloque A. No se crea ningún
   sistema de permisos paralelo.
   ===================================================================== */
(function () {
  'use strict';
  if (window.__cardiolinkPedidosRapidosV1) return;
  window.__cardiolinkPedidosRapidosV1 = true;

  function puedeConfigurarPedidosRapidos411PR() {
    try { return typeof puedeAccederInformacionClinica === 'function' && puedeAccederInformacionClinica(); } catch (_) { return false; }
  }

  // Seed inicial de ejemplo (Laboratorio básico / Perfil lipídico / Estudios
  // cardiovasculares / Prequirúrgico) - deliberadamente chico y 100% editable
  // desde la UI. NO se persiste solo por mostrarse: ver
  // obtenerListaEditor411PR().
  function seedPlantillas411PR() {
    return [
      { id: 'seed_lab_basico_411pr', nombre: 'Laboratorio básico', activo: true, orden: 0, items: ['Hemograma', 'Glucemia', 'Urea', 'Creatinina', 'Hepatograma', 'Ionograma', 'Orina completa'] },
      { id: 'seed_perfil_lipidico_411pr', nombre: 'Perfil lipídico', activo: true, orden: 1, items: ['Colesterol total', 'HDL colesterol', 'LDL colesterol', 'Triglicéridos'] },
      { id: 'seed_estudios_cv_411pr', nombre: 'Estudios cardiovasculares', activo: true, orden: 2, items: ['Electrocardiograma', 'Holter', 'MAPA', 'Ecocardiograma 2D Doppler color', 'Ergometría'] },
      { id: 'seed_prequirurgico_411pr', nombre: 'Prequirúrgico', activo: true, orden: 3, items: ['Hemograma', 'Glucemia', 'Urea', 'Creatinina', 'Ionograma', 'Coagulograma', 'Electrocardiograma'] }
    ];
  }

  // Copia de trabajo EN MEMORIA de esta pestaña. NO se inicializa una única
  // vez por sesión: mientras no haya ediciones locales sin guardar
  // (editorDirty411PR === false), CADA llamada refleja el estado ACTUAL de
  // data.plantillasPedidos (o el seed, si esa clave todavía no existe). Esto
  // es lo que permite que, si el primer render mostró el seed porque
  // Supabase todavía no había resuelto la carga remota, el próximo render
  // (disparado por el mismo hook de siempre, ver wrap de renderConfig más
  // abajo) tome solo las plantillas reales apenas lleguen - sin depender de
  // ningún polling ni setInterval nuevo.
  //
  // En cuanto el usuario hace CUALQUIER edición local (nueva/editar/eliminar/
  // activar/mover), se marca editorDirty411PR = true y esta función deja de
  // re-clonar desde `data` - conserva la copia local tal cual quedó, incluso
  // si mientras tanto `data.plantillasPedidos` cambiara por otro motivo
  // (ej. una recarga remota concurrente), hasta que el usuario guarde
  // explícitamente (ver guardarPlantillasPedidos411PR) o descarte los
  // cambios recargando la página.
  let listaEditor411PR = null;
  let editorDirty411PR = false;
  let origenEditor411PR = null; // 'seed' | 'persistido'

  function obtenerListaEditor411PR() {
    if (!editorDirty411PR) {
      const reales = (typeof data !== 'undefined' && data && Array.isArray(data.plantillasPedidos)) ? data.plantillasPedidos : null;
      if (reales) {
        listaEditor411PR = JSON.parse(JSON.stringify(reales));
        origenEditor411PR = 'persistido';
      } else {
        listaEditor411PR = seedPlantillas411PR();
        origenEditor411PR = 'seed';
      }
    }
    return listaEditor411PR;
  }

  function crearIdPlantilla411PR() {
    return 'pr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  }

  // Un ítem por línea: trim, descarta líneas vacías, evita duplicados
  // dentro de la misma plantilla (comparación case-insensitive, conserva
  // la primera aparición y su capitalización), conserva el orden.
  function normalizarItems411PR(texto) {
    const vistos = new Set();
    const resultado = [];
    String(texto || '').split('\n').forEach(linea => {
      const limpio = linea.trim();
      if (!limpio) return;
      const clave = limpio.toLowerCase();
      if (vistos.has(clave)) return;
      vistos.add(clave);
      resultado.push(limpio);
    });
    return resultado;
  }

  function moverPlantilla411PR(id, direccion) {
    const lista = obtenerListaEditor411PR();
    const idx = lista.findIndex(p => p.id === id);
    const destino = idx + direccion;
    if (idx < 0 || destino < 0 || destino >= lista.length) return;
    const tmp = lista[idx];
    lista[idx] = lista[destino];
    lista[destino] = tmp;
    editorDirty411PR = true;
    renderListaPlantillas411PR();
  }

  function alternarActivaPlantilla411PR(id) {
    const p = obtenerListaEditor411PR().find(x => x.id === id);
    if (!p) return;
    p.activo = !p.activo;
    editorDirty411PR = true;
    renderListaPlantillas411PR();
  }

  function eliminarPlantilla411PR(id) {
    const lista = obtenerListaEditor411PR();
    const p = lista.find(x => x.id === id);
    if (!p) return;
    if (!confirm(`¿Eliminar la plantilla "${p.nombre}"? Esta acción no se puede deshacer (recordá presionar "Guardar plantillas" después).`)) return;
    const idx = lista.indexOf(p);
    lista.splice(idx, 1);
    editorDirty411PR = true;
    renderListaPlantillas411PR();
  }

  function cerrarEditorPlantilla411PR() {
    document.getElementById('pedidoRapidoEditorModal411PR')?.remove();
  }

  function abrirEditorPlantilla411PR(id) {
    cerrarEditorPlantilla411PR();
    const esNueva = !id;
    const lista = obtenerListaEditor411PR();
    const existente = esNueva ? null : lista.find(p => p.id === id);
    if (!esNueva && !existente) return;
    const nombreActual = existente ? existente.nombre : '';
    const itemsActuales = existente ? existente.items : [];

    const modal = document.createElement('div');
    modal.id = 'pedidoRapidoEditorModal411PR';
    modal.className = 'hc-modal-overlay';
    modal.innerHTML = `<div class="hc-modal-card">
      <div class="hc-modal-head">
        <h2>${esNueva ? 'Nueva plantilla' : 'Editar plantilla'}</h2>
        <button type="button" class="modal-close" data-cerrar-editor-411pr>×</button>
      </div>
      <div class="hc-modal-grid">
        <label class="full">Nombre<input type="text" id="pedidoRapidoNombre411PR" value="${escapeHtml(nombreActual)}" placeholder="Ej: Laboratorio básico"></label>
        <label class="full">Ítems (uno por línea)<textarea id="pedidoRapidoItems411PR" rows="10" placeholder="Un ítem por línea">${escapeHtml(itemsActuales.join('\n'))}</textarea></label>
      </div>
      <p class="muted">Al aceptar se recortan espacios, se descartan líneas vacías y se evitan ítems duplicados dentro de esta plantilla. Esto todavía no guarda en el servidor - hace falta presionar "Guardar plantillas" después.</p>
      <div class="hc-modal-actions">
        <button type="button" class="secondary" data-cerrar-editor-411pr>Cancelar</button>
        <button type="button" class="primary" id="btnAceptarEditorPlantilla411PR">Aceptar</button>
      </div>
    </div>`;
    document.body.appendChild(modal);
    document.getElementById('pedidoRapidoNombre411PR')?.focus();

    modal.querySelectorAll('[data-cerrar-editor-411pr]').forEach(btn => { btn.onclick = cerrarEditorPlantilla411PR; });
    document.getElementById('btnAceptarEditorPlantilla411PR').onclick = () => {
      const nombre = (document.getElementById('pedidoRapidoNombre411PR')?.value || '').trim();
      if (!nombre) { alert('Ingresá un nombre para la plantilla.'); return; }
      const items = normalizarItems411PR(document.getElementById('pedidoRapidoItems411PR')?.value || '');
      if (esNueva) {
        lista.push({ id: crearIdPlantilla411PR(), nombre, activo: true, orden: lista.length, items });
      } else {
        existente.nombre = nombre;
        existente.items = items;
      }
      editorDirty411PR = true;
      cerrarEditorPlantilla411PR();
      renderListaPlantillas411PR();
    };
  }

  function filaPlantillaHTML411PR(p, idx, total) {
    return `<div class="pedido-rapido-row-411pr" data-id="${escapeHtml(p.id)}">
      <div class="pedido-rapido-info-411pr">
        <strong>${escapeHtml(p.nombre)}</strong>
        <span class="muted">${p.items.length} ítem${p.items.length === 1 ? '' : 's'}</span>
      </div>
      <span class="pedido-rapido-badge-411pr ${p.activo ? 'activa' : 'inactiva'}">${p.activo ? 'Activa' : 'Inactiva'}</span>
      <div class="pedido-rapido-actions-411pr">
        <button type="button" data-accion="subir" ${idx === 0 ? 'disabled' : ''} title="Subir">↑</button>
        <button type="button" data-accion="bajar" ${idx === total - 1 ? 'disabled' : ''} title="Bajar">↓</button>
        <button type="button" data-accion="activar">${p.activo ? 'Desactivar' : 'Activar'}</button>
        <button type="button" data-accion="editar">Editar</button>
        <button type="button" data-accion="eliminar">Eliminar</button>
      </div>
    </div>`;
  }

  function renderListaPlantillas411PR() {
    const cont = document.getElementById('pedidosRapidosLista411PR');
    if (!cont) return;
    const lista = obtenerListaEditor411PR();
    cont.innerHTML = lista.length
      ? lista.map((p, idx) => filaPlantillaHTML411PR(p, idx, lista.length)).join('')
      : '<p class="muted">Todavía no hay plantillas. Usá "+ Nueva plantilla" para crear la primera.</p>';
    cont.querySelectorAll('.pedido-rapido-row-411pr').forEach(row => {
      const id = row.dataset.id;
      row.querySelectorAll('button[data-accion]').forEach(btn => {
        btn.onclick = () => {
          const accion = btn.dataset.accion;
          if (accion === 'subir') moverPlantilla411PR(id, -1);
          else if (accion === 'bajar') moverPlantilla411PR(id, 1);
          else if (accion === 'activar') alternarActivaPlantilla411PR(id);
          else if (accion === 'editar') abrirEditorPlantilla411PR(id);
          else if (accion === 'eliminar') eliminarPlantilla411PR(id);
        };
      });
    });
    const estado = document.getElementById('pedidosRapidosEstado411PR');
    if (estado) {
      if (editorDirty411PR) {
        estado.textContent = origenEditor411PR === 'seed'
          ? 'Mostrando plantillas de ejemplo con cambios sin guardar. Presioná "Guardar plantillas" para persistirlas.'
          : 'Hay cambios sin guardar. Presioná "Guardar plantillas" para persistirlos.';
      } else if (origenEditor411PR === 'seed') {
        estado.textContent = 'Mostrando plantillas de ejemplo, todavía no guardadas. Editalas o agregá/quitá lo que necesites y presioná "Guardar plantillas".';
      } else {
        estado.textContent = '';
      }
    }
  }

  // Guardado explícito, único momento en que se escribe algo: local
  // (saveConfig) y recién después se espera (await) la confirmación REAL de
  // guardarConfigEnSupabase298() (ya existente en app.js, no se modifica -
  // sube el mismo blob `data` completo que cualquier otro guardado de
  // configuración) antes de avisar éxito. Mismo criterio que ya se corrigió
  // en Horarios de atención: nunca se afirma sincronización remota sin
  // haberla confirmado.
  async function guardarPlantillasPedidos411PR() {
    if (typeof data === 'undefined') return;
    const lista = obtenerListaEditor411PR();
    const normalizada = lista.map((p, idx) => ({
      id: p.id,
      nombre: p.nombre,
      activo: !!p.activo,
      orden: idx,
      items: Array.isArray(p.items) ? p.items.slice() : []
    }));
    data.plantillasPedidos = normalizada;
    try {
      saveConfig();
    } catch (e) {
      console.warn('Pedidos rápidos: no se pudieron guardar las plantillas localmente:', e);
      alert('No se pudieron guardar las plantillas.');
      return;
    }
    let sincronizado = false;
    try {
      sincronizado = await window.guardarConfigEnSupabase298?.();
    } catch (e) {
      console.warn('Pedidos rápidos: no se pudo sincronizar con Supabase:', e);
    }
    if (sincronizado) {
      // Éxito confirmado: recién acá se "limpia" el editor - se libera
      // editorDirty411PR para que, de ahora en más, vuelva a reflejar
      // data.plantillasPedidos en cada render (que ya es exactamente lo que
      // se acaba de guardar).
      editorDirty411PR = false;
      origenEditor411PR = 'persistido';
      listaEditor411PR = null;
      renderListaPlantillas411PR();
      alert('Plantillas guardadas.');
    } else {
      // La nube no confirmó: se conserva editorDirty411PR = true a
      // propósito - la copia local (ya reflejada también en
      // data.plantillasPedidos, arriba) NO debe ser reemplazada por un
      // eventual valor remoto desactualizado mientras la sincronización
      // real siga pendiente.
      renderListaPlantillas411PR();
      alert('Las plantillas quedaron guardadas en este dispositivo, pero no se pudieron sincronizar con la nube todavía. Revisá la conexión y volvé a presionar "Guardar plantillas".');
    }
  }

  function asegurarCardPedidosRapidos411PR() {
    if (document.getElementById('cfgPedidosRapidosV1PR')) { renderListaPlantillas411PR(); return; }
    const grid = document.querySelector('#config .config-grid');
    if (!grid) return;
    const card = document.createElement('div');
    card.id = 'cfgPedidosRapidosV1PR';
    card.className = 'config-smart-card-310';
    card.dataset.configGroupCard = 'documentos';
    card.dataset.configAccess = 'operational';
    card.innerHTML = `
      <h3>Plantillas de pedidos</h3>
      <p class="muted">Grupos de ítems reutilizables (laboratorio, estudios, controles) para armar pedidos médicos rápidos. Este bloque todavía sólo administra las plantillas - generarlas como documento es un paso posterior.</p>
      <div id="pedidosRapidosLista411PR" class="pedidos-rapidos-lista-411pr"></div>
      <div class="pedidos-rapidos-toolbar-411pr">
        <button type="button" class="secondary" id="btnNuevaPlantilla411PR">+ Nueva plantilla</button>
        <button type="button" class="primary" id="btnGuardarPlantillas411PR">Guardar plantillas</button>
      </div>
      <p class="muted" id="pedidosRapidosEstado411PR"></p>`;
    // Mismo fix ya validado en Agenda V1 (Bloque 3): cardiolink-config-v1.js
    // reorganiza las tarjetas dentro de regiones por pestaña
    // (data-config-v1-body="...") muy temprano, independiente de cuándo
    // corre renderConfig() - insertar directo en la región "documentos" ya
    // armada si existe; si config-v1 todavía no corrió, se apendea a
    // .config-grid y su propio reorganizador la mueve sola (mismo
    // dataset.configGroupCard).
    const regionDocumentos = document.querySelector('[data-config-v1-body="documentos"]');
    if (regionDocumentos) regionDocumentos.appendChild(card);
    else grid.appendChild(card);
    // Contenido clínico: misma familia de permiso que ya usa el módulo
    // documental 406 (puedeAccederInformacionClinica = Matías/Admin/Médico).
    // Secretaría no ve esta tarjeta en este Bloque A - podrá "usar" las
    // plantillas ya guardadas en el flujo de Orden médica del Bloque B, sin
    // poder editarlas acá.
    card.classList.toggle('hidden-permission', !puedeConfigurarPedidosRapidos411PR());
    document.getElementById('btnNuevaPlantilla411PR').onclick = () => abrirEditorPlantilla411PR(null);
    document.getElementById('btnGuardarPlantillas411PR').onclick = guardarPlantillasPedidos411PR;
    renderListaPlantillas411PR();
  }

  /* ---------------------------------------------------------------------
     BLOQUE B - Picker de "Pedido rápido" desde Ficha del paciente / HC.
     Usa EXCLUSIVAMENTE data.plantillasPedidos ya persistidas (activo===true,
     ordenadas por `orden`) - nunca el seed visual de Bloque A. Al terminar,
     entrega el contenido combinado a la API nueva de app.js
     (window.openClinicalDocumentPrefilled406) y termina ahí su
     responsabilidad: fecha, título, indicaciones, firma, profesional
     responsable, guardado, impresión e historial siguen siendo 100% del
     módulo documental 406 existente, sin cambios.
     --------------------------------------------------------------------- */

  // Sólo plantillas REALMENTE guardadas (nunca el seed en memoria de
  // Bloque A, aunque esté visible en Configuración) - si data.plantillasPedidos
  // no existe todavía, no hay nada para ofrecer acá.
  function plantillasActivasOrdenadas411PR() {
    if (typeof data === 'undefined' || !data || !Array.isArray(data.plantillasPedidos)) return [];
    return data.plantillasPedidos
      .filter(p => p && p.activo === true && Array.isArray(p.items) && p.items.length)
      .slice()
      .sort((a, b) => (Number(a.orden) || 0) - (Number(b.orden) || 0));
  }

  // Mismo criterio de nombre ya usado en el resto de la app
  // (nombreCompleto||paciente||nombre) - no depende de ninguna función
  // interna del módulo 406 (no expuesta).
  function nombrePacientePedido411PR(key) {
    try {
      const p = (typeof data !== 'undefined' && Array.isArray(data.pacientes)) ? data.pacientes.find(x => String(x.id) === String(key)) : null;
      return p ? (p.nombreCompleto || p.paciente || p.nombre || 'Paciente') : 'Paciente';
    } catch (_) { return 'Paciente'; }
  }

  function cerrarPedidoRapido411PR() {
    document.getElementById('pedidoRapidoPickerModal411PR')?.remove();
  }

  // Recalcula el "pedido resultante" desde cero a partir de las plantillas
  // tildadas en ESTE momento (combinación + deduplicación, misma
  // normalizarItems411PR de Bloque A). Es intencional que esto REEMPLACE el
  // contenido actual del textarea: tildar/destildar plantillas siempre
  // parte de la combinación real de lo tildado - las ediciones manuales del
  // pedido se hacen DESPUÉS de terminar de elegir plantillas.
  function recomputarPedidoResultado411PR(contenedor, plantillas) {
    const idsTildados = new Set(Array.from(contenedor.querySelectorAll('.pedido-rapido-picker-check-411pr:checked')).map(chk => chk.dataset.id));
    const seleccionadas = plantillas.filter(p => idsTildados.has(p.id));
    const combinado = seleccionadas.flatMap(p => p.items).join('\n');
    const textarea = document.getElementById('pedidoRapidoResultado411PR');
    if (textarea) textarea.value = normalizarItems411PR(combinado).join('\n');
  }

  function abrirPedidoRapido411PR(patientKey) {
    cerrarPedidoRapido411PR();
    const plantillas = plantillasActivasOrdenadas411PR();
    const nombrePaciente = nombrePacientePedido411PR(patientKey);

    const modal = document.createElement('div');
    modal.id = 'pedidoRapidoPickerModal411PR';
    modal.className = 'hc-modal-overlay';

    if (!plantillas.length) {
      modal.innerHTML = `<div class="hc-modal-card">
        <div class="hc-modal-head">
          <h2>Pedido rápido</h2>
          <button type="button" class="modal-close" data-cerrar-picker-411pr>×</button>
        </div>
        <p class="muted">${escapeHtml(nombrePaciente)}</p>
        <p class="muted">No hay plantillas de pedidos activas. Configuralas primero en Configuración → Documentos e identidad.</p>
        <div class="hc-modal-actions"><button type="button" class="secondary" data-cerrar-picker-411pr>Cerrar</button></div>
      </div>`;
      document.body.appendChild(modal);
      modal.querySelectorAll('[data-cerrar-picker-411pr]').forEach(btn => { btn.onclick = cerrarPedidoRapido411PR; });
      return;
    }

    modal.innerHTML = `<div class="hc-modal-card">
      <div class="hc-modal-head">
        <h2>Pedido rápido</h2>
        <button type="button" class="modal-close" data-cerrar-picker-411pr>×</button>
      </div>
      <p class="muted">${escapeHtml(nombrePaciente)}</p>
      <div class="pedido-rapido-picker-lista-411pr">
        ${plantillas.map(p => `<label class="pedido-rapido-picker-item-411pr">
          <input type="checkbox" class="pedido-rapido-picker-check-411pr" data-id="${escapeHtml(p.id)}">
          ${escapeHtml(p.nombre)} <span class="muted">(${p.items.length})</span>
        </label>`).join('')}
      </div>
      <label class="full">Pedido resultante
        <textarea id="pedidoRapidoResultado411PR" rows="8" placeholder="Elegí una o varias plantillas arriba, o escribí acá directamente"></textarea>
      </label>
      <p class="muted">Podés quitar, editar o agregar ítems a mano antes de continuar - esto no modifica las plantillas guardadas.</p>
      <div class="hc-modal-actions">
        <button type="button" class="secondary" data-cerrar-picker-411pr>Cancelar</button>
        <button type="button" class="primary" id="btnContinuarOrdenMedica411PR">Continuar a Orden médica</button>
      </div>
    </div>`;
    document.body.appendChild(modal);
    modal.querySelectorAll('[data-cerrar-picker-411pr]').forEach(btn => { btn.onclick = cerrarPedidoRapido411PR; });
    modal.querySelectorAll('.pedido-rapido-picker-check-411pr').forEach(chk => {
      chk.onchange = () => recomputarPedidoResultado411PR(modal, plantillas);
    });
    document.getElementById('btnContinuarOrdenMedica411PR').onclick = () => {
      // Punto 7: normalizar y deduplicar NUEVAMENTE justo antes de
      // continuar (el usuario pudo haber tipeado líneas vacías/duplicadas a
      // mano después de tildar las plantillas).
      const items = normalizarItems411PR(document.getElementById('pedidoRapidoResultado411PR')?.value || '');
      if (!items.length) { alert('Agregá al menos un ítem antes de continuar.'); return; }
      const texto = items.join('\n');
      cerrarPedidoRapido411PR();
      // Única responsabilidad de este módulo: entregar el contenido. Fecha,
      // título, indicaciones por defecto, profesional responsable, firma,
      // membrete, guardado, impresión e historial son 100% del módulo 406
      // existente - no se reimplementa nada de eso acá.
      if (typeof window.openClinicalDocumentPrefilled406 === 'function') {
        window.openClinicalDocumentPrefilled406(patientKey, 'orden', { contenido: texto });
      } else {
        alert('El módulo de documentos todavía no terminó de cargar. Esperá un instante y volvé a intentar.');
      }
    };
  }

  // Inserta "Pedido rápido" junto a CADA botón [data-new-doc406] existente
  // (Ficha del paciente y HC ya insertan ese botón - ver app.js,
  // enhancePatientFicha406/enhanceHC406). Se reutiliza EXACTAMENTE el mismo
  // patientKey del botón vecino (dataset.newDoc406), así "Pedido rápido"
  // siempre actúa sobre el paciente correcto sin resolverlo por su cuenta.
  // Y, al depender de que [data-new-doc406] ya exista, hereda EXACTAMENTE
  // la misma visibilidad que "+ Documento" hoy (sólo médico/Admin - ver
  // isMedical406() en app.js) sin necesidad de re-derivar ningún permiso
  // acá. Para este Bloque B, V1, Secretaría NO ve este botón (ver decisión
  // explícita: se deja para un bloque aparte, reutilizando su permiso ya
  // existente para emitir Orden médica en nombre de un profesional).
  function intentarInyectarBotonesPedidoRapido411PR() {
    document.querySelectorAll('[data-new-doc406]').forEach(btnDoc => {
      if (btnDoc.dataset.pedidoRapidoHecho411pr) return;
      btnDoc.dataset.pedidoRapidoHecho411pr = '1';
      const key = btnDoc.dataset.newDoc406;
      if (!key) return;
      const boton = document.createElement('button');
      boton.type = 'button';
      boton.className = 'secondary';
      boton.textContent = 'Pedido rápido';
      boton.onclick = () => abrirPedidoRapido411PR(key);
      btnDoc.insertAdjacentElement('afterend', boton);
    });
  }

  // Mismo patrón que ya usa app.js para reaccionar a estos mismos
  // contenedores (module 406: MutationObserver sobre #pacienteDetalle/
  // #hcPacienteDetalle) - observers INDEPENDIENTES, sin tocar los ya
  // existentes, sin polling ni setInterval.
  function instalarObserversPedidoRapido411PR() {
    intentarInyectarBotonesPedidoRapido411PR();
    ['pacienteDetalle', 'hcPacienteDetalle'].forEach(id => {
      const root = document.getElementById(id);
      if (root) new MutationObserver(() => intentarInyectarBotonesPedidoRapido411PR()).observe(root, { childList: true, subtree: true });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', instalarObserversPedidoRapido411PR);
  else instalarObserversPedidoRapido411PR();
  setTimeout(instalarObserversPedidoRapido411PR, 900);

  const renderConfigOriginal411PR = typeof renderConfig === 'function' ? renderConfig : null;
  if (renderConfigOriginal411PR && !renderConfigOriginal411PR.__pedidosRapidosV1) {
    const wrapped = function () {
      const r = renderConfigOriginal411PR.apply(this, arguments);
      try { asegurarCardPedidosRapidos411PR(); } catch (e) { console.warn('Pedidos rápidos: no se pudo agregar la tarjeta de plantillas:', e); }
      return r;
    };
    wrapped.__pedidosRapidosV1 = true;
    window.renderConfig = renderConfig = wrapped;
  }

  if (!document.getElementById('cardiolink-pedidos-rapidos-v1-style')) {
    const style = document.createElement('style');
    style.id = 'cardiolink-pedidos-rapidos-v1-style';
    style.textContent = `
      .pedidos-rapidos-lista-411pr{display:flex;flex-direction:column;gap:8px;margin:12px 0}
      .pedido-rapido-row-411pr{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 14px;border:1px solid var(--border,#dbe3ea);border-radius:12px;background:var(--panel-alt,#f8fbfc)}
      .pedido-rapido-info-411pr{flex:1 1 180px;display:flex;flex-direction:column;gap:2px}
      .pedido-rapido-info-411pr span{font-size:12px;color:var(--muted,#64748b)}
      .pedido-rapido-badge-411pr{padding:4px 10px;border-radius:999px;font-size:11px;font-weight:800}
      .pedido-rapido-badge-411pr.activa{background:#ddfbf7;color:#0f9f93}
      .pedido-rapido-badge-411pr.inactiva{background:#e2e8f0;color:#475569}
      .pedido-rapido-actions-411pr{display:flex;gap:6px;flex-wrap:wrap}
      .pedido-rapido-actions-411pr button{background:#eef2f7;color:var(--text,#0f172a);font-weight:700;padding:6px 10px;font-size:11.5px;border-radius:9px;border:0;cursor:pointer}
      .pedido-rapido-actions-411pr button:disabled{opacity:.4;cursor:default}
      .pedidos-rapidos-toolbar-411pr{display:flex;gap:10px;flex-wrap:wrap;margin-top:6px}
      body.dark .pedido-rapido-row-411pr{background:#142e3b;border-color:#25465a;color:#f8fafc}
      body.dark .pedido-rapido-actions-411pr button{background:#0f2633;color:#f8fafc}
      @media (max-width:640px){.pedido-rapido-row-411pr{flex-direction:column;align-items:flex-start}.pedido-rapido-actions-411pr{width:100%}}
      .pedido-rapido-picker-lista-411pr{display:flex;flex-direction:column;gap:6px;margin:14px 0}
      .pedido-rapido-picker-item-411pr{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--border,#dbe3ea);border-radius:10px;background:var(--panel-alt,#f8fbfc);cursor:pointer;font-size:14px}
      body.dark .pedido-rapido-picker-item-411pr{background:#142e3b;border-color:#25465a;color:#f8fafc}
    `;
    document.head.appendChild(style);
  }
})();
