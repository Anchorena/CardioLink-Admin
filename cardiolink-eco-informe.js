
/* =====================================================================
   CardioLink — Informes de estudios (Ecocardiograma / Ecografía general)
   No modifica app.js. Agrega botones en la ficha de Historia Clínica
   que abren ventanas con dictado por voz (reutiliza el sistema propio
   de la app: botones con data-cl-voice-target4094) y guardan el
   resultado como una evolución clínica real, usando el propio
   formulario y botón "Guardar evolución" de la app.
   Para revertir: quitar el <script> a este archivo en index.html.
   ===================================================================== */
(function () {
  if (window.__cardiolinkEcoInstalled) return;
  window.__cardiolinkEcoInstalled = true;
 
  const STATS_KEY = 'cl_eco_solicitantes';
  const CUSTOM_SOLICITANTES_KEY = 'cl_eco_solicitantes_custom';
 
  const COLEGAS_FRECUENTES = [
    'Dr. Anchorena Rogelio', 'Dr. Cabrera Horacio', 'Dr. Camilletti Jesus',
    'Dr. Garavaglia Carlos', 'Dr. Ruiz Sala Martin', 'Dr. Alonso',
    'Dr. Drago Humberto', 'Dra. Rutter', 'Dra. Mozotegui Adriana',
    'Dra. Grima Victoria', 'Dr. Moldes', 'Dr. Carpio', 'Dr. Duarte Ender',
    'Dr. Centeno Pablo', 'Dra. Benavente Ximena', 'Dr. Montiel Ernesto',
    'Dr. Canelon Roger', 'Dr. Rokos Juan Martin', 'Dra. Benavente Fernanda',
    'Dra. Arena', 'Dra. Vairo Natalia', 'Dr. Spala Jose', 'Dr. Olmedo Pablo',
    'Dra. Izzo Gabriela', 'Dra. Rodriguez Eva', 'Dra. Da Fonseca Mariangeles',
    'Dr. Monteagudo German', 'Dr. Baquerizzo Andres', 'Dr. Del Rio Leonardo',
    'Dr. Domanico Mariano', 'Dr. Bernasconi Orlando', 'Dra. Velazquez',
    'Dra. Betelu', 'Dra. Maggi Romina', 'Dr. Angulo Jason',
    'Dr. Fasah Luis', 'Dra. Piñero Lucia', 'Dr. Arfus',
    'Dra. Leon Nayrra', 'Dra. Emke Mariela',
  ];
  const ESPECIALIDADES_GENERICAS = [
    'Cardiología', 'Neumonología', 'Clínica médica', 'Pediatría',
    'Terapia intensiva', 'Infectología', 'Hematología', 'Obra social',
  ];

  function puedeUsarClinica() {
    try { return typeof puedeAccederInformacionClinica === 'function' && !!puedeAccederInformacionClinica(); }
    catch (e) { return false; }
  }
 
  const ORGANOS_REGION = [
    'Abdominal', 'Renal / vías urinarias', 'Tiroides / cuello',
    'Partes blandas', 'Vascular (Doppler)', 'Ginecológica', 'Obstétrica',
    'Próstata', 'Mama', 'Otro / no listado',
  ];
 
  const CAMPOS_ECO = [
    { id: 'clEcoDsvi', label: 'Diámetro sistólico de VI', unidad: 'mm' },
    { id: 'clEcoDdvi', label: 'Diámetro diastólico de VI', unidad: 'mm' },
    { id: 'clEcoAorta', label: 'Raíz de aorta', unidad: 'mm' },
    { id: 'clEcoAiMm', label: 'Aurícula izquierda', unidad: 'mm' },
    { id: 'clEcoAiVol', label: 'Aurícula izquierda (volumen)', unidad: 'ml' },
    { id: 'clEcoAd', label: 'Aurícula derecha', unidad: '' },
    { id: 'clEcoVd', label: 'Ventrículo derecho', unidad: '' },
    { id: 'clEcoTapse', label: 'TAPSE', unidad: 'mm' },
    { id: 'clEcoRelajacion', label: 'Patrón de relajación', unidad: '' },
    { id: 'clEcoFuncsist', label: 'Función sistólica', unidad: '' },
    { id: 'clEcoMotilidad', label: 'Motilidad', unidad: '' },
    { id: 'clEcoVPulmonar', label: 'Válvula pulmonar', unidad: '' },
    { id: 'clEcoVMitral', label: 'Válvula mitral', unidad: '' },
    { id: 'clEcoTsvi', label: 'TSVI', unidad: '' },
    { id: 'clEcoVAortica', label: 'Válvula aórtica', unidad: '' },
    { id: 'clEcoVTricuspide', label: 'Válvula tricúspide', unidad: '' },
    { id: 'clEcoPericardio', label: 'Pericardio', unidad: '' },
  ];
 
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c];
    });
  }
  function val(id) {
    var el = document.getElementById(id);
    return el ? String(el.value || '').trim() : '';
  }
 
  function leerCustomSolicitantes() {
    try { return JSON.parse(localStorage.getItem(CUSTOM_SOLICITANTES_KEY) || '[]'); } catch (e) { return []; }
  }
  function agregarCustomSolicitante(nombre) {
    if (!nombre) return;
    var lista = leerCustomSolicitantes();
    var low = nombre.toLowerCase();
    var yaExiste = lista.some(function (n) { return n.toLowerCase() === low; })
      || COLEGAS_FRECUENTES.some(function (n) { return n.toLowerCase() === low; });
    if (!yaExiste) {
      lista.push(nombre);
      try { localStorage.setItem(CUSTOM_SOLICITANTES_KEY, JSON.stringify(lista)); } catch (e) {}
    }
  }
 
  function leerStats() {
    try { return JSON.parse(localStorage.getItem(STATS_KEY) || '{}'); } catch (e) { return {}; }
  }
  function sumarSolicitante(nombre) {
    if (!nombre) return;
    var s = leerStats();
    s[nombre] = (s[nombre] || 0) + 1;
    try { localStorage.setItem(STATS_KEY, JSON.stringify(s)); } catch (e) {}
  }
  function mostrarStats() {
    if (!puedeUsarClinica()) { alert('Tu perfil no puede acceder a informes clínicos.'); return; }
    var s = leerStats();
    var filas = Object.entries(s).sort(function (a, b) { return b[1] - a[1]; });
    var cuerpo = filas.length
      ? filas.map(function (f) { return '<div class="cl-eco-stat-row"><span>' + esc(f[0]) + '</span><strong>' + f[1] + '</strong></div>'; }).join('')
      : '<p class="muted">Todavía no hay estudios registrados con médico solicitante.</p>';
    var overlay = document.createElement('div');
    overlay.className = 'hc-modal-overlay';
    overlay.innerHTML = '<div class="hc-modal-card" style="width:min(420px,94vw)">'
      + '<div class="hc-modal-head"><h2>Estudios por médico solicitante</h2><button type="button" class="modal-close" data-cl-eco-stats-close>\u00d7</button></div>'
      + '<div class="cl-eco-stats-list">' + cuerpo + '</div></div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay || e.target.closest('[data-cl-eco-stats-close]')) overlay.remove();
    });
  }
 
  function solicitanteSelectHtml(id) {
    var extra = leerCustomSolicitantes();
    function opt(n) { return '<option value="' + esc(n) + '">' + esc(n) + '</option>'; }
    var html = '<div><label for="' + id + '">Médico solicitante</label>'
      + '<select id="' + id + '">'
      + '<option value="">No consignado / sin solicitante</option>'
      + '<optgroup label="Colegas frecuentes">' + COLEGAS_FRECUENTES.map(opt).join('') + '</optgroup>';
    if (extra.length) html += '<optgroup label="Agregados por vos">' + extra.map(opt).join('') + '</optgroup>';
    html += '<optgroup label="Especialidades / genéricos">' + ESPECIALIDADES_GENERICAS.map(opt).join('') + '</optgroup>'
      + '<option value="__otro__">Otro / no listado</option></select>'
      + '<input id="' + id + 'Otro" type="text" placeholder="Nombre del profesional" style="display:none;margin-top:6px"></div>';
    return html;
  }
  function activarSolicitanteSelect(id) {
    var sel = document.getElementById(id);
    var otro = document.getElementById(id + 'Otro');
    if (!sel || !otro) return;
    sel.addEventListener('change', function () {
      var esOtro = sel.value === '__otro__';
      otro.style.display = esOtro ? 'block' : 'none';
      if (esOtro) otro.focus();
    });
  }
  function resolverSolicitante(id) {
    var sel = document.getElementById(id);
    if (!sel) return '';
    if (sel.value === '__otro__') return val(id + 'Otro');
    return sel.value || '';
  }
 
  function generarNarrativaEco() {
    var partes = ['Ecocardiograma Doppler color.'];
    var peso = val('clEcoPeso'), talla = val('clEcoTalla');
    if (peso || talla) {
      var linea = 'Paciente de';
      if (peso) linea += ' ' + peso + ' kg';
      if (peso && talla) linea += ' y';
      if (talla) linea += ' ' + talla + ' cm';
      partes.push(linea + '.');
    }
    function g(id) { return val(id); }
    if (g('clEcoDsvi')) partes.push('Diámetro sistólico de VI: ' + g('clEcoDsvi') + ' mm.');
    if (g('clEcoDdvi')) partes.push('Diámetro diastólico de VI: ' + g('clEcoDdvi') + ' mm.');
    if (g('clEcoAorta')) partes.push('Raíz de aorta: ' + g('clEcoAorta') + ' mm.');
    if (g('clEcoAiMm') || g('clEcoAiVol')) {
      var l2 = 'Aurícula izquierda:';
      if (g('clEcoAiMm')) l2 += ' ' + g('clEcoAiMm') + ' mm';
      if (g('clEcoAiVol')) l2 += (g('clEcoAiMm') ? ',' : '') + ' volumen ' + g('clEcoAiVol') + ' ml';
      partes.push(l2 + '.');
    }
    if (g('clEcoAd')) partes.push('Aurícula derecha: ' + g('clEcoAd') + '.');
    if (g('clEcoVd')) partes.push('Ventrículo derecho: ' + g('clEcoVd') + '.');
    if (g('clEcoTapse')) partes.push('TAPSE: ' + g('clEcoTapse') + ' mm.');
    if (g('clEcoRelajacion')) partes.push('Patrón de relajación: ' + g('clEcoRelajacion') + '.');
    if (g('clEcoFuncsist')) partes.push('Función sistólica: ' + g('clEcoFuncsist') + '.');
    if (g('clEcoMotilidad')) partes.push('Motilidad: ' + g('clEcoMotilidad') + '.');
    if (g('clEcoVPulmonar')) partes.push('Válvula pulmonar: ' + g('clEcoVPulmonar') + '.');
    if (g('clEcoVMitral')) partes.push('Válvula mitral: ' + g('clEcoVMitral') + '.');
    if (g('clEcoTsvi')) partes.push('TSVI: ' + g('clEcoTsvi') + '.');
    if (g('clEcoVAortica')) partes.push('Válvula aórtica: ' + g('clEcoVAortica') + '.');
    if (g('clEcoVTricuspide')) partes.push('Válvula tricúspide: ' + g('clEcoVTricuspide') + '.');
    if (g('clEcoPericardio')) partes.push('Pericardio: ' + g('clEcoPericardio') + '.');
    if (g('clEcoObs')) partes.push('Observaciones: ' + g('clEcoObs'));
    var libre = val('clEcoLibre');
    if (libre) partes.push(libre);
    return partes.join(' ');
  }
 
  function campoEcoHtml(c) {
    return '<div class="cl-eco-field">'
      + '<div class="cl-voice-label4094"><label for="' + c.id + '">' + esc(c.label) + (c.unidad ? ' (' + c.unidad + ')' : '') + '</label>'
      + '<button class="cl-voice-btn4094" type="button" data-cl-voice-target4094="' + c.id + '" aria-label="Dictar ' + esc(c.label) + '">\u{1F3A4} Dictar</button></div>'
      + '<input id="' + c.id + '" type="text" placeholder="' + (c.unidad ? 'Ej. valor en ' + c.unidad : '') + '"></div>';
  }
 
  function deshabilitarVozSiNoHay(overlay) {
    if (window.CardioLinkVoice4094 && !window.CardioLinkVoice4094.supported) {
      overlay.querySelectorAll('.cl-voice-btn4094').forEach(function (b) {
        b.disabled = true;
        b.title = 'Dictado por voz no disponible en este navegador';
      });
    }
  }
 
  function esperarCampo(id, intentosMax, cb) {
    var intentos = 0;
    var t = setInterval(function () {
      intentos++;
      var el = document.getElementById(id);
      if (el || intentos > intentosMax) { clearInterval(t); cb(el); }
    }, 150);
  }
 
  function buscarPaciente(key) {
    try {
      var lista = (typeof data !== 'undefined' && data && Array.isArray(data.pacientes))
        ? data.pacientes
        : (window.data && Array.isArray(window.data.pacientes) ? window.data.pacientes : []);
      return lista.find(function (p) {
        return String(p.id) === String(key) || String(p.dni || '') === String(key);
      }) || null;
    } catch (e) { return null; }
  }
  function calcularEdad(fechaISO) {
    if (!fechaISO) return '';
    var f = new Date(fechaISO);
    if (isNaN(f.getTime())) return '';
    var hoy = new Date();
    var edad = hoy.getFullYear() - f.getFullYear();
    var m = hoy.getMonth() - f.getMonth();
    if (m < 0 || (m === 0 && hoy.getDate() < f.getDate())) edad--;
    return edad >= 0 ? edad : '';
  }
  function lineaDatosPaciente(key) {
    var p = buscarPaciente(key);
    if (!p) return '';
    var partes = [];
    var edad = calcularEdad(p.fechaNacimiento);
    if (edad !== '') partes.push('Edad: ' + edad + ' años');
    if (p.sexo) partes.push('Sexo: ' + p.sexo);
    if (p.numeroAfiliadoHabitual) partes.push('N° de afiliado: ' + p.numeroAfiliadoHabitual);
    return partes.join(' · ');
  }
 
  function esperarCampos(ids, intentosMax, cb) {
    var intentos = 0;
    var t = setInterval(function () {
      intentos++;
      var todos = ids.every(function (id) { return !!document.getElementById(id); });
      if (todos || intentos > intentosMax) { clearInterval(t); cb(todos); }
    }, 150);
  }
 
  // Genera el informe imprimible/PDF con membrete, DNI, obra social y
  // fecha, reutilizando el sistema de "Documentos clínicos" que ya
  // tiene la app (tipo "Ecografía") — no crea un diseño de impresión
  // propio, así respeta el membrete y firma reales del profesional.
  // Precarga el documento y lo deja abierto para que el usuario mismo
  // apriete "Guardar e imprimir": si lo hace el script solo, el
  // navegador bloquea la ventana de impresión por no venir de un clic
  // directo de la persona.
  function imprimirInforme(patientKey, datos) {
    if (typeof window.openClinicalDocumentTyped406 !== 'function') {
      alert('No se encontró el sistema de documentos clínicos de la app. No se pudo imprimir.');
      return;
    }
    window.openClinicalDocumentTyped406(patientKey, 'ecografia');
    esperarCampos(['docTitle406', 'docBody406', 'savePrintDoc406'], 40, function (ok) {
      if (!ok) { alert('No se pudo abrir el documento para imprimir. Probá de nuevo.'); return; }
      var tituloEl = document.getElementById('docTitle406');
      var cuerpoEl = document.getElementById('docBody406');
      if (tituloEl) tituloEl.value = datos.motivo;
      if (cuerpoEl) {
        var datosLinea = lineaDatosPaciente(patientKey);
        var encabezado = '';
        if (datosLinea) encabezado += datosLinea + '\n';
        if (datos.solicitante) encabezado += 'Médico solicitante: ' + datos.solicitante + '\n';
        if (encabezado) encabezado += '\n';
        cuerpoEl.value = encabezado + datos.narrativa;
      }
      // No se hace clic automático: queda listo para que la persona
      // revise y apriete "Guardar e imprimir" ella misma.
    });
  }
 
  function guardarComoEvolucion(patientKey, datos, onDone) {
    if (typeof window.abrirNuevaEvolucionHC !== 'function') {
      alert('No se encontró el formulario de evolución de la app. No se pudo guardar.');
      return;
    }
    window.abrirNuevaEvolucionHC(patientKey);
    esperarCampo('hcGuardarEvolucion', 40, function (btnGuardar) {
      if (!btnGuardar) {
        alert('No se pudo abrir el formulario de evolución. Probá de nuevo.');
        return;
      }
      var motivoEl = document.getElementById('hcMotivo');
      var evolucionEl = document.getElementById('hcEvolucion');
      var pesoEl = document.getElementById('hcPeso410');
      var tallaEl = document.getElementById('hcTalla410');
      if (motivoEl) motivoEl.value = datos.motivo;
      if (evolucionEl) {
        var encabezado = datos.solicitante ? ('Médico solicitante: ' + datos.solicitante + '\n\n') : '';
        evolucionEl.value = encabezado + datos.narrativa;
      }
      if (pesoEl && datos.peso) { pesoEl.value = datos.peso; pesoEl.dispatchEvent(new Event('input', { bubbles: true })); }
      if (tallaEl && datos.talla) { tallaEl.value = datos.talla; tallaEl.dispatchEvent(new Event('input', { bubbles: true })); }
      btnGuardar.click();
      if (datos.solicitante) { sumarSolicitante(datos.solicitante); agregarCustomSolicitante(datos.solicitante); }
      if (onDone) onDone();
    });
  }
 
  function abrirModalEco(patientKey, patientNombre) {
    if (!puedeUsarClinica()) { alert('Tu perfil no puede crear informes clínicos.'); return; }
    var existente = document.getElementById('clEcoModal');
    if (existente) existente.remove();
    var overlay = document.createElement('div');
    overlay.id = 'clEcoModal';
    overlay.className = 'hc-modal-overlay';
    overlay.innerHTML = '<div class="hc-modal-card" style="width:min(760px,96vw)">'
      + '<div class="hc-modal-head"><div><h2>Ecocardiograma</h2><p class="muted">' + esc(patientNombre || '') + '</p></div>'
      + '<button type="button" class="modal-close" data-cl-eco-close>\u00d7</button></div>'
      + '<div class="hc-modal-grid">' + solicitanteSelectHtml('clEcoSolicitante')
      + '<div><label for="clEcoPeso">Peso (kg)</label><input id="clEcoPeso" type="number" step="0.1" min="0"></div>'
      + '<div><label for="clEcoTalla">Talla (cm)</label><input id="clEcoTalla" type="number" step="0.1" min="0"></div></div>'
      + '<p class="cl-eco-hint">Ayuda memoria: completá en orden, con el micrófono de cada campo si preferís dictar.</p>'
      + '<div class="cl-eco-grid">' + CAMPOS_ECO.map(campoEcoHtml).join('') + '</div>'
      + '<div class="cl-eco-field full"><div class="cl-voice-label4094"><label for="clEcoObs">Observaciones / comentarios</label>'
      + '<button class="cl-voice-btn4094" type="button" data-cl-voice-target4094="clEcoObs" aria-label="Dictar observaciones">\u{1F3A4} Dictar</button></div>'
      + '<textarea id="clEcoObs" rows="2"></textarea></div>'
      + '<details class="cl-eco-libre"><summary>Dictado libre continuo (opcional)</summary>'
      + '<p class="muted">Hablá todo seguido, en el orden de la ayuda memoria de arriba, y después revisá o repartí el texto a mano.</p>'
      + '<div class="cl-voice-label4094"><label for="clEcoLibre">Transcripción libre</label>'
      + '<button class="cl-voice-btn4094" type="button" data-cl-voice-target4094="clEcoLibre" aria-label="Dictado libre continuo">\u{1F3A4} Dictar</button></div>'
      + '<textarea id="clEcoLibre" rows="4"></textarea></details>'
      + '<div class="cl-eco-narrativa"><div class="cl-eco-narrativa-head"><label for="clEcoNarrativa">Narrativa (queda en la evolución del paciente)</label>'
      + '<button type="button" class="secondary small-btn" id="clEcoGenerarNarrativa">Generar narrativa automática</button></div>'
      + '<textarea id="clEcoNarrativa" rows="6" placeholder="Se arma sola al generar, o escribila/dictala vos."></textarea></div>'
      + '<div class="hc-modal-actions"><button type="button" class="secondary" id="clEcoVerStats">Ver estadística de solicitantes</button>'
      + '<button type="button" class="secondary" data-cl-eco-close>Cancelar</button>'
      + '<button type="button" class="secondary" id="clEcoImprimir">Guardar e imprimir informe</button>'
      + '<button type="button" class="primary" id="clEcoGuardar">Guardar estudio</button></div></div>';
    document.body.appendChild(overlay);
    deshabilitarVozSiNoHay(overlay);
    activarSolicitanteSelect('clEcoSolicitante');
    document.getElementById('clEcoGenerarNarrativa').onclick = function () {
      document.getElementById('clEcoNarrativa').value = generarNarrativaEco();
    };
    document.getElementById('clEcoVerStats').onclick = function () { mostrarStats(); };
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay || e.target.closest('[data-cl-eco-close]')) overlay.remove();
    });
    document.getElementById('clEcoImprimir').onclick = function () {
      var narrativa1 = val('clEcoNarrativa');
      if (!narrativa1) narrativa1 = generarNarrativaEco();
      var datos1 = {
        motivo: 'Ecocardiograma Doppler color',
        narrativa: narrativa1,
        peso: val('clEcoPeso'),
        talla: val('clEcoTalla'),
        solicitante: resolverSolicitante('clEcoSolicitante'),
      };
      guardarComoEvolucion(patientKey, datos1, function () {
        overlay.remove();
        imprimirInforme(patientKey, datos1);
      });
    };
    document.getElementById('clEcoGuardar').onclick = function () {
      var narrativa = val('clEcoNarrativa');
      if (!narrativa) narrativa = generarNarrativaEco();
      guardarComoEvolucion(patientKey, {
        motivo: 'Ecocardiograma Doppler color',
        narrativa: narrativa,
        peso: val('clEcoPeso'),
        talla: val('clEcoTalla'),
        solicitante: resolverSolicitante('clEcoSolicitante'),
      }, function () { overlay.remove(); });
    };
  }
 
  function abrirModalEcoGeneral(patientKey, patientNombre) {
    if (!puedeUsarClinica()) { alert('Tu perfil no puede crear informes clínicos.'); return; }
    var existente = document.getElementById('clUsgModal');
    if (existente) existente.remove();
    var overlay = document.createElement('div');
    overlay.id = 'clUsgModal';
    overlay.className = 'hc-modal-overlay';
    overlay.innerHTML = '<div class="hc-modal-card" style="width:min(680px,96vw)">'
      + '<div class="hc-modal-head"><div><h2>Ecografía general</h2><p class="muted">' + esc(patientNombre || '') + '</p></div>'
      + '<button type="button" class="modal-close" data-cl-usg-close>\u00d7</button></div>'
      + '<div class="hc-modal-grid">' + solicitanteSelectHtml('clUsgSolicitante')
      + '<div><label for="clUsgOrgano">Órgano / región</label><select id="clUsgOrgano">'
      + ORGANOS_REGION.map(function (o) { return '<option value="' + esc(o) + '">' + esc(o) + '</option>'; }).join('')
      + '</select></div></div>'
      + '<div class="cl-eco-field full"><div class="cl-voice-label4094"><label for="clUsgInforme">Informe</label>'
      + '<button class="cl-voice-btn4094" type="button" data-cl-voice-target4094="clUsgInforme" aria-label="Dictar informe">\u{1F3A4} Dictar</button></div>'
      + '<textarea id="clUsgInforme" rows="8" placeholder="Hallazgos, en el orden que prefieras."></textarea></div>'
      + '<div class="hc-modal-actions"><button type="button" class="secondary" id="clUsgVerStats">Ver estadística de solicitantes</button>'
      + '<button type="button" class="secondary" data-cl-usg-close>Cancelar</button>'
      + '<button type="button" class="secondary" id="clUsgImprimir">Guardar e imprimir informe</button>'
      + '<button type="button" class="primary" id="clUsgGuardar">Guardar estudio</button></div></div>';
    document.body.appendChild(overlay);
    deshabilitarVozSiNoHay(overlay);
    activarSolicitanteSelect('clUsgSolicitante');
    document.getElementById('clUsgVerStats').onclick = function () { mostrarStats(); };
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay || e.target.closest('[data-cl-usg-close]')) overlay.remove();
    });
    document.getElementById('clUsgImprimir').onclick = function () {
      var organo1 = val('clUsgOrgano') || 'General';
      var informe1 = val('clUsgInforme');
      if (!informe1) { alert('Cargá el informe antes de guardar.'); return; }
      var datos2 = {
        motivo: 'Ecografía general \u2014 ' + organo1,
        narrativa: informe1,
        peso: '',
        talla: '',
        solicitante: resolverSolicitante('clUsgSolicitante'),
      };
      guardarComoEvolucion(patientKey, datos2, function () {
        overlay.remove();
        imprimirInforme(patientKey, datos2);
      });
    };
    document.getElementById('clUsgGuardar').onclick = function () {
      var organo = val('clUsgOrgano') || 'General';
      var informe = val('clUsgInforme');
      if (!informe) { alert('Cargá el informe antes de guardar.'); return; }
      guardarComoEvolucion(patientKey, {
        motivo: 'Ecografía general \u2014 ' + organo,
        narrativa: informe,
        peso: '',
        talla: '',
        solicitante: resolverSolicitante('clUsgSolicitante'),
      }, function () { overlay.remove(); });
    };
  }
 
  function insertarBotones() {
    if (!puedeUsarClinica()) {
      document.querySelectorAll('[data-cl-eco-open],[data-cl-usg-open],#clEcoModal,#clUsgModal').forEach(function (el) { el.remove(); });
      return;
    }
    document.querySelectorAll('.hc-patient-actions').forEach(function (actions) {
      var keyEl = actions.querySelector('[data-hc-new]');
      if (!keyEl) return;
      var key = keyEl.dataset.hcNew;
      var header = actions.closest('.hc-patient-header');
      var nombre = header ? (header.querySelector('h2') ? header.querySelector('h2').textContent : '') : '';
      var imprimirBtn = actions.querySelector('[data-hc-print]');
 
      if (!actions.querySelector('[data-cl-eco-open]')) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'secondary'; b.dataset.clEcoOpen = key;
        b.textContent = '+ Ecocardiograma';
        b.onclick = function () { abrirModalEco(key, nombre); };
        actions.insertBefore(b, imprimirBtn || null);
      }
      if (!actions.querySelector('[data-cl-usg-open]')) {
        var b2 = document.createElement('button');
        b2.type = 'button'; b2.className = 'secondary'; b2.dataset.clUsgOpen = key;
        b2.textContent = '+ Ecografía general';
        b2.onclick = function () { abrirModalEcoGeneral(key, nombre); };
        actions.insertBefore(b2, imprimirBtn || null);
      }
    });
  }
 
  var observer = new MutationObserver(function () { insertarBotones(); });
  observer.observe(document.body, { childList: true, subtree: true });
  insertarBotones();
})();
