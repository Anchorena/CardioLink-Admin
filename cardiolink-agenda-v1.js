/* =====================================================================
   CardioLink - Agenda V1 (asignar/reprogramar con proteccion de choques)
   v1 . 2026-09-14

   Modulo independiente:
   - NO modifica cardiolink_atenciones (mismo esquema, mismos campos:
     fecha/horaInicio/horaFin/profesionalId).
   - NO crea tablas nuevas.
   - NO reimplementa Comunicaciones: al reprogramar, reutiliza EXACTAMENTE
     las funciones ya existentes notificarProfesionalAsignado460 (evento
     'reschedule', igual que ya hace el wrapper de guardarEdicionModal) y
     abrirModalNotificarPaciente460 (tipo 'reschedule', ya soportado por
     ese modal - COMMS460_TIPOS_LABEL/el <select> de tipo de aviso ya lo
     incluian, sólo no tenian un punto de disparo). Mismo selector de canal
     Email/WhatsApp/Ambos que ya usa el resto de la app.
   - NO toca la cancelacion de turnos (ya resuelta por el estado "Cancelado"
     dentro de "Estado del turno", ver comentario UI Interna V1 - Bloque 2
     en el bloque de Comunicaciones de app.js).
   - NO toca patient-reminders-24h.

   Que agrega:
   1) Proteccion de superposicion de turnos: bloquea el guardado (alta desde
      Carga de turno, y reprogramacion desde Agenda) si el profesional ya
      tiene otro turno cuyo horario se solapa. Excepcion deliberada ya
      existente en el sistema y preservada: las "prestaciones adicionales"
      del mismo turno comparten grupoTurnoId, fecha, hora y profesional a
      proposito (ver crearAtencionDesdeFormulario/guardarAtencion en
      app.js) - nunca se cuentan como choque entre si.
   2) Reprogramar rapido desde Agenda: boton "Reprogramar" dentro del mismo
      modal "Ver" (data-action="agenda-ver" -> abrirAgendaModal), con un
      panel chico (fecha/hora/profesional) sin volver a pedir paciente ni
      prestacion. Si el turno tiene grupoTurnoId (prestaciones adicionales
      del mismo turno), reprograma TODAS las atenciones de ese grupo juntas
      y dispara un unico aviso (no uno por cada prestacion).
   3) Bugfix: reprogramar fecha/horaInicio/horaFin desde Listado/Filtro
      (editarAtencion -> abrirModalEdicion -> guardarEdicionModal) ahora
      tambien abre el aviso al paciente (antes sólo avisaba al profesional).
   4) Duracion configurable por prestacion (Bloque 2): data.duracionesPrestacion
      (mapa nombrePrestacion -> minutos, guardado en el mismo config/blob
      existente via saveConfig() - NO tabla nueva). Editable desde la misma
      lista de prestaciones de Configuracion. horaFin se calcula sola en
      Carga de turno (horaInicio + duracion de la prestacion elegida) salvo
      que Secretaria la haya tocado a mano. La superposicion usa: 1) horaFin
      real: 2) duracion configurada de la prestacion (o la mayor del grupo,
      si el turno tiene grupoTurnoId): 3) fallback 30 min.
   5) Disponibilidad simple por profesional (Bloque 3): data.horariosProfesionales
      (mismo config/blob existente - NO tabla nueva), editable desde una
      tarjeta nueva en Configuracion → Profesionales y equipo. Botón "Ver
      horarios disponibles" en Carga de turno y en Reprogramar, que sugiere
      horarios libres reutilizando turnoQueSuperpone411AG/duracionBloqueTurno411AG
      (misma logica de choque/duracion/grupos/cancelados de Bloques 1 y 2 -
      sin segunda lógica de superposición). Es ayuda, NO restricción dura:
      cargar/reprogramar fuera de la disponibilidad configurada sólo muestra
      una advertencia confirmable, nunca bloquea. Matías arranca con L-V
      08:00-20:00 por defecto (seed único, no pisa configuración existente).
   6) Vista "Día agenda" (Bloque 4): nueva opción en el selector #agendaVista
      de Agenda/sala de espera, además de Tabla/Tarjetas/Semana/Mes (que no
      se tocan). Lista cronológica de la jornada para la fecha/profesional/
      estado ya filtrados, con: bloques de turno cuya altura refleja la
      duración real (misma ventanaTurno411AG/duracionBloqueTurno411AG de
      Bloques 1-2, sin lógica nueva), agrupación visual por grupoTurnoId,
      huecos libres calculados con las MISMAS franjas de Bloque 3 (nunca una
      segunda lógica de disponibilidad), botón "+ Dar turno" sobre un hueco
      que reutiliza el formulario YA EXISTENTE de Carga de turno (no crea
      un segundo formulario), acciones que reutilizan el mismo sistema de
      data-action ya cableado en app.js (agenda-ver/agenda-estado, sin
      reimplementar cambiarEstadoAgenda/abrirAgendaModal) y una línea
      discreta de "ahora" cuando la fecha mostrada es hoy.
   ===================================================================== */
(function () {
  'use strict';
  if (window.__cardiolinkAgendaV1) return;
  window.__cardiolinkAgendaV1 = true;

  // Fallback final cuando la prestación no tiene duracionMinutos configurada
  // (prestaciones viejas, o ninguna prestación evaluable). Nunca se escribe
  // en la atención - sólo se usa para poder evaluar superposición.
  const DURACION_DEFAULT_MIN_411AG = 30;

  function minutosDesdeHora411AG(h) {
    const m = String(h || '').trim().match(/^(\d{1,2}):(\d{2})/);
    if (!m) return null;
    const hh = Number(m[1]), mm = Number(m[2]);
    if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
    return hh * 60 + mm;
  }

  // data.duracionesPrestacion: mapa {nombrePrestacion: minutos}, guardado en
  // el mismo config/blob existente (saveConfig()) - no es tabla nueva, mismo
  // mecanismo que data.medicosDerivantes/data.motivosConsulta.
  function duracionPrestacion411AG(nombrePrestacion) {
    try {
      const mapa = (typeof data !== 'undefined' && data && data.duracionesPrestacion) ? data.duracionesPrestacion : null;
      const val = mapa ? Number(mapa[nombrePrestacion]) : NaN;
      if (Number.isFinite(val) && val > 0) return val;
    } catch (_) {}
    return DURACION_DEFAULT_MIN_411AG;
  }

  function setDuracionPrestacion411AG(nombrePrestacion, minutos) {
    if (typeof data === 'undefined' || !nombrePrestacion) return;
    if (!data.duracionesPrestacion || typeof data.duracionesPrestacion !== 'object') data.duracionesPrestacion = {};
    const n = Number(minutos);
    if (Number.isFinite(n) && n > 0) {
      data.duracionesPrestacion[nombrePrestacion] = Math.round(n);
    } else {
      delete data.duracionesPrestacion[nombrePrestacion]; // vuelve al fallback de 30 min
    }
    try { saveConfig(); } catch (e) { console.warn('Agenda V1: no se pudo guardar la duración de la prestación:', e); }
  }

  // Duración "de bloque" de un turno para superposición: si tiene
  // grupoTurnoId (prestaciones adicionales del mismo turno), usa la MAYOR
  // duración configurada entre todas las prestaciones del grupo (no las
  // suma - no asumimos que son secuenciales). Sin grupo, usa la duración de
  // su propia prestación.
  function duracionBloqueTurno411AG(a, lista) {
    if (a && a.grupoTurnoId && Array.isArray(lista)) {
      const miembros = lista.filter(x => x && String(x.grupoTurnoId || '') === String(a.grupoTurnoId));
      if (miembros.length) return Math.max(...miembros.map(x => duracionPrestacion411AG(x.prestacion)));
    }
    return duracionPrestacion411AG(a && a.prestacion);
  }

  // Ventana [inicio,fin] en minutos. Orden: 1) horaFin real si existe;
  // 2) duracion configurada de la prestacion (o la mayor del grupo);
  // 3) fallback 30 min (dentro de duracionPrestacion411AG).
  function ventanaTurno411AG(a, lista) {
    const ini = minutosDesdeHora411AG(a && a.horaInicio);
    if (ini == null) return null;
    let fin = a.horaFin ? minutosDesdeHora411AG(a.horaFin) : null;
    if (fin == null || fin <= ini) fin = ini + duracionBloqueTurno411AG(a, lista);
    return [ini, fin];
  }

  function estadoTurno411AG(a) {
    try { return typeof estadoTurno === 'function' ? estadoTurno(a) : (a.estadoTurno || 'reservado'); }
    catch (_) { return a && a.estadoTurno || 'reservado'; }
  }

  // Busca un turno existente que se superponga con `candidato`. Devuelve el
  // registro con el que choca, o null si no hay superposicion evaluable.
  // candidato: {id, grupoTurnoId, profesionalId, fecha, horaInicio, horaFin}
  function turnoQueSuperpone411AG(candidato, lista) {
    const ventanaC = ventanaTurno411AG(candidato, lista);
    if (!ventanaC) return null; // sin hora cargada: no se puede evaluar, no bloquea
    const [iniC, finC] = ventanaC;
    return (lista || []).find(ex => {
      if (!ex) return false;
      if (candidato.id != null && String(ex.id) === String(candidato.id)) return false;
      // Excepcion deliberada: prestaciones adicionales del mismo turno.
      if (candidato.grupoTurnoId && ex.grupoTurnoId && String(ex.grupoTurnoId) === String(candidato.grupoTurnoId)) return false;
      if (String(ex.profesionalId || '') !== String(candidato.profesionalId || '')) return false;
      if ((ex.fecha || '') !== (candidato.fecha || '')) return false;
      if (estadoTurno411AG(ex) === 'cancelado') return false;
      const ventanaE = ventanaTurno411AG(ex, lista);
      if (!ventanaE) return false;
      const [iniE, finE] = ventanaE;
      return iniC < finE && iniE < finC;
    }) || null;
  }

  function descripcionChoque411AG(ex) {
    const rango = ex.horaInicio ? `${ex.horaInicio}${ex.horaFin ? '-' + ex.horaFin : ''}` : 's/h';
    return `${ex.paciente || 'otro paciente'} (${rango})`;
  }

  /* ---------------------------------------------------------------------
     BLOQUE 3 - Disponibilidad simple por profesional (ayuda, no restricción
     dura). data.horariosProfesionales: mismo config/blob existente (mismo
     mecanismo que data.duracionesPrestacion) - sin tabla nueva.

     data.horariosProfesionales = {
       [profesionalId]: { lunes: [["08:00","20:00"]], martes: [...], ... }
     }

     El array de franjas por día ya soporta más de una en el futuro
     (ej. [["08:00","12:00"],["16:00","20:00"]]) aunque la UI de esta etapa
     sólo edite una franja por día.
     --------------------------------------------------------------------- */
  const DIAS_SEMANA_411AG = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
  const DIAS_LABORALES_411AG = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes']; // UI v1: sólo L-V editable

  function minutosAHora411AG(mins) {
    const hh = Math.floor(mins / 60) % 24;
    const mm = mins % 60;
    return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
  }

  function diaSemanaDesdeFecha411AG(fechaISO) {
    if (!fechaISO) return null;
    const d = new Date(fechaISO + 'T00:00:00');
    if (Number.isNaN(d.getTime())) return null;
    return DIAS_SEMANA_411AG[d.getDay()];
  }

  function franjasProfesionalDia411AG(profesionalId, dia) {
    try {
      const cfg = (typeof data !== 'undefined' && data && data.horariosProfesionales) ? data.horariosProfesionales[profesionalId] : null;
      const franjas = cfg && dia && Array.isArray(cfg[dia]) ? cfg[dia] : null;
      return franjas || [];
    } catch (_) { return []; }
  }

  // null = sin franjas configuradas ese día (no hay nada que advertir).
  // true/false = está o no dentro de alguna franja configurada.
  function horaDentroDeFranjas411AG(horaTexto, franjas) {
    if (!Array.isArray(franjas) || !franjas.length) return null;
    const min = minutosDesdeHora411AG(horaTexto);
    if (min == null) return null;
    return franjas.some(f => {
      const ini = minutosDesdeHora411AG(f && f[0]);
      const fin = minutosDesdeHora411AG(f && f[1]);
      return ini != null && fin != null && min >= ini && min < fin;
    });
  }

  // Distingue "día explícitamente marcado No atiende" (cfg[dia] presente
  // como array VACÍO, ver guardarHorariosProfesional411AG) de "profesional/
  // día todavía sin configurar" (la clave del día no existe en absoluto).
  // Ambos casos hoy devuelven [] desde franjasProfesionalDia411AG (correcto
  // para calcular horarios libres: en los dos casos no hay nada que
  // ofrecer), pero para la advertencia SÍ hace falta diferenciarlos:
  //  - null  : sin configurar todavía -> NO advertir (compatibilidad).
  //  - false : "No atiende" explícito, o franja configurada pero la hora
  //            cae afuera -> SÍ advertir.
  //  - true  : hora dentro de alguna franja configurada -> no advertir.
  function evaluarDisponibilidad411AG(profesionalId, fecha, horaTexto) {
    const dia = diaSemanaDesdeFecha411AG(fecha);
    if (!dia) return null;
    let cfg = null;
    try {
      cfg = (typeof data !== 'undefined' && data && data.horariosProfesionales) ? data.horariosProfesionales[profesionalId] : null;
    } catch (_) { cfg = null; }
    if (!cfg || !Object.prototype.hasOwnProperty.call(cfg, dia)) return null; // sin configurar ese día
    const franjas = Array.isArray(cfg[dia]) ? cfg[dia] : [];
    if (!franjas.length) return false; // "No atiende" explícito ese día
    return horaDentroDeFranjas411AG(horaTexto, franjas);
  }

  // Punto 5: advertencia NO bloqueante. Devuelve true si hay que continuar
  // (dentro de horario, sin config, o el usuario confirmó igual) y false si
  // el usuario eligió no continuar.
  function confirmarSiFueraDeHorario411AG(profesionalId, fecha, horaInicio) {
    const disponible = evaluarDisponibilidad411AG(profesionalId, fecha, horaInicio);
    if (disponible === false) {
      return confirm('El horario seleccionado está fuera del horario habitual del profesional.\n\n¿Querés continuar igual?');
    }
    return true;
  }

  function asegurarHorarioDefaultMatias411AG() {
    try {
      if (typeof data === 'undefined' || !data) return;
      if (!data.horariosProfesionales || typeof data.horariosProfesionales !== 'object') data.horariosProfesionales = {};
      if (!data.horariosProfesionales.matias) {
        data.horariosProfesionales.matias = {
          lunes: [['08:00', '20:00']], martes: [['08:00', '20:00']], miercoles: [['08:00', '20:00']],
          jueves: [['08:00', '20:00']], viernes: [['08:00', '20:00']]
        };
        try { saveConfig(); } catch (_) {}
      }
    } catch (_) {}
  }
  asegurarHorarioDefaultMatias411AG();

  // Horarios libres para profesionalId/fecha con bloques de `duracionMinutos`.
  // Reutiliza turnoQueSuperpone411AG (misma lógica de choque/duración/grupos/
  // cancelados de Bloques 1 y 2 - no se duplica). excluirId: al calcular
  // disponibilidad para REPROGRAMAR un turno existente, para que no choque
  // consigo mismo.
  function horariosDisponibles411AG(profesionalId, fecha, duracionMinutos, excluirId) {
    const dia = diaSemanaDesdeFecha411AG(fecha);
    const franjas = franjasProfesionalDia411AG(profesionalId, dia);
    if (!franjas.length) return [];
    const duracion = Number(duracionMinutos) > 0 ? Number(duracionMinutos) : DURACION_DEFAULT_MIN_411AG;
    const lista = typeof atenciones !== 'undefined' ? atenciones : [];
    const libres = [];
    franjas.forEach(f => {
      const ini = minutosDesdeHora411AG(f && f[0]);
      const fin = minutosDesdeHora411AG(f && f[1]);
      if (ini == null || fin == null) return;
      for (let t = ini; t + duracion <= fin; t += duracion) {
        const horaInicio = minutosAHora411AG(t);
        const horaFin = minutosAHora411AG(t + duracion);
        const candidato = { id: excluirId || null, grupoTurnoId: null, profesionalId, fecha, horaInicio, horaFin };
        if (!turnoQueSuperpone411AG(candidato, lista)) libres.push(horaInicio);
      }
    });
    return libres;
  }

  // Panel chico de horarios clickeables, inyectado dentro de `contenedor`
  // (toggle: si ya está abierto, lo cierra). onSelect(hora) recibe "HH:MM".
  function togglePopoverHorarios411AG(contenedor, profesionalId, fecha, duracion, excluirId, onSelect) {
    const existente = contenedor.querySelector('.horarios-libres-411ag');
    if (existente) { existente.remove(); return; }
    const panel = document.createElement('div');
    panel.className = 'horarios-libres-411ag';
    if (!profesionalId || !fecha) {
      panel.innerHTML = '<p class="muted">Elegí profesional y fecha primero.</p>';
    } else {
      const dia = diaSemanaDesdeFecha411AG(fecha);
      const franjas = franjasProfesionalDia411AG(profesionalId, dia);
      if (!franjas.length) {
        panel.innerHTML = '<p class="muted">Este profesional no tiene horario configurado para ese día (Configuración → Profesionales y equipo → Horarios de atención).</p>';
      } else {
        const libres = horariosDisponibles411AG(profesionalId, fecha, duracion, excluirId);
        panel.innerHTML = libres.length
          ? libres.map(h => `<button type="button" class="horario-libre-btn-411ag" data-hora="${h}">${h}</button>`).join('')
          : '<p class="muted">No quedan horarios libres ese día con esa duración.</p>';
        panel.querySelectorAll('.horario-libre-btn-411ag').forEach(btn => {
          btn.onclick = () => { onSelect(btn.dataset.hora); panel.remove(); };
        });
      }
    }
    contenedor.appendChild(panel);
  }

  /* ---------------------------------------------------------------------
     1) Asignar turno (Carga de turno): bloquear ANTES de crear la atencion
        si el profesional ya tiene un choque a esa fecha/hora.
     --------------------------------------------------------------------- */
  const guardarAtencionOriginal411AG = typeof guardarAtencion === 'function' ? guardarAtencion : null;
  if (guardarAtencionOriginal411AG && !guardarAtencionOriginal411AG.__agendaV1411AG) {
    const wrapped = function (e) {
      try {
        const candidato = {
          id: null,
          grupoTurnoId: null,
          profesionalId: document.getElementById('profesional')?.value || '',
          fecha: document.getElementById('fecha')?.value || '',
          horaInicio: document.getElementById('horaInicio')?.value || '',
          horaFin: document.getElementById('horaFin')?.value || ''
        };
        if (candidato.profesionalId && candidato.fecha && candidato.horaInicio) {
          const lista = typeof atenciones !== 'undefined' ? atenciones : [];
          const choque = turnoQueSuperpone411AG(candidato, lista);
          if (choque) {
            if (e) e.preventDefault();
            alert('Ese profesional ya tiene un turno que se superpone con ' + descripcionChoque411AG(choque) + '. Elegí otro horario o profesional.');
            return;
          }
          // Bloque 3, punto 5: advertencia NO bloqueante si el horario está
          // fuera de las franjas configuradas del profesional. La
          // superposición (arriba) sigue siendo la única regla dura.
          if (!confirmarSiFueraDeHorario411AG(candidato.profesionalId, candidato.fecha, candidato.horaInicio)) {
            if (e) e.preventDefault();
            return;
          }
        }
      } catch (err) {
        // Fail-open: un error en la evaluacion de superposicion nunca debe
        // impedir un guardado legitimo.
        console.warn('Agenda V1: no se pudo evaluar superposición antes de guardar:', err);
      }
      return guardarAtencionOriginal411AG.apply(this, arguments);
    };
    wrapped.__agendaV1411AG = true;
    window.guardarAtencion = guardarAtencion = wrapped;
  }

  /* ---------------------------------------------------------------------
     1b) Carga de turno: horaInicio + duracion de la prestacion -> horaFin
         automatica, salvo que Secretaria ya haya tocado horaFin a mano.
         #prestacion/#horaInicio/#horaFin son campos estaticos del formulario
         (index.html), siempre presentes - se instala una sola vez.
     --------------------------------------------------------------------- */
  function recalcularHoraFinCarga411AG() {
    const horaInicioEl = document.getElementById('horaInicio');
    const horaFinEl = document.getElementById('horaFin');
    const prestacionEl = document.getElementById('prestacion');
    if (!horaInicioEl || !horaFinEl || !prestacionEl) return;
    if (horaFinEl.dataset.autocalculada411ag === '0') return; // Secretaría ya la tocó a mano, no pisar
    const horaInicio = horaInicioEl.value;
    if (!horaInicio) return;
    const duracion = duracionPrestacion411AG(prestacionEl.value);
    const nuevaHoraFin = typeof sumarMinutosHora === 'function' ? sumarMinutosHora(horaInicio, duracion) : '';
    if (nuevaHoraFin) {
      horaFinEl.value = nuevaHoraFin;
      horaFinEl.dataset.autocalculada411ag = '1';
    }
  }

  function instalarListenersCargaTurno411AG() {
    const horaInicioEl = document.getElementById('horaInicio');
    const horaFinEl = document.getElementById('horaFin');
    const prestacionEl = document.getElementById('prestacion');
    if (horaInicioEl && !horaInicioEl.dataset.agendaV1Listener411ag) {
      horaInicioEl.addEventListener('change', recalcularHoraFinCarga411AG);
      horaInicioEl.dataset.agendaV1Listener411ag = '1';
    }
    if (prestacionEl && !prestacionEl.dataset.agendaV1Listener411ag) {
      prestacionEl.addEventListener('change', recalcularHoraFinCarga411AG);
      prestacionEl.dataset.agendaV1Listener411ag = '1';
    }
    if (horaFinEl && !horaFinEl.dataset.agendaV1Listener411ag) {
      // .value= (nuestro autocalculo) NO dispara 'input' - sólo lo dispara
      // que Secretaría tipee. Así distinguimos "automático" de "manual".
      horaFinEl.addEventListener('input', () => { horaFinEl.dataset.autocalculada411ag = '0'; });
      horaFinEl.dataset.agendaV1Listener411ag = '1';
    }
  }
  instalarListenersCargaTurno411AG();
  document.addEventListener('DOMContentLoaded', instalarListenersCargaTurno411AG);

  // Bloque 3, punto 4: "Ver horarios disponibles" en Carga de turno. No pide
  // datos nuevos - usa #profesional/#fecha/#prestacion ya cargados.
  function instalarBotonHorariosCarga411AG() {
    const horaFinEl = document.getElementById('horaFin');
    if (!horaFinEl || document.getElementById('btnVerHorarios411AG')) return;
    const anchorDiv = horaFinEl.closest('div');
    if (!anchorDiv || !anchorDiv.parentNode) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'btnVerHorarios411AG';
    btn.className = 'secondary horarios-btn-411ag';
    btn.textContent = 'Ver horarios disponibles';
    const contenedor = document.createElement('div');
    contenedor.id = 'horariosLibresCargaWrap411AG';
    btn.onclick = () => {
      const profesionalId = document.getElementById('profesional')?.value || '';
      const fecha = document.getElementById('fecha')?.value || '';
      const duracion = duracionPrestacion411AG(document.getElementById('prestacion')?.value || '');
      togglePopoverHorarios411AG(contenedor, profesionalId, fecha, duracion, null, (hora) => {
        const horaInicioElAhora = document.getElementById('horaInicio');
        const horaFinElAhora = document.getElementById('horaFin');
        if (!horaInicioElAhora || !horaFinElAhora) return;
        horaInicioElAhora.value = hora;
        const finCalculada = typeof sumarMinutosHora === 'function' ? sumarMinutosHora(hora, duracion) : '';
        if (finCalculada) {
          horaFinElAhora.value = finCalculada;
          horaFinElAhora.dataset.autocalculada411ag = '1';
        }
      });
    };
    anchorDiv.insertAdjacentElement('afterend', btn);
    btn.insertAdjacentElement('afterend', contenedor);
  }
  instalarBotonHorariosCarga411AG();
  document.addEventListener('DOMContentLoaded', instalarBotonHorariosCarga411AG);

  /* ---------------------------------------------------------------------
     2) Reprogramar rapido desde el modal "Ver" de Agenda.
     --------------------------------------------------------------------- */
  function inyectarBotonReprogramar411AG(id) {
    const body = document.getElementById('agendaModalBody');
    if (!body || document.getElementById('btnReprogramar411AG')) return;
    const destino = body.querySelector('#agendaModalAccionesComs') || body.querySelector('.agenda-actions') || body.querySelector('.modal-actions');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'btnReprogramar411AG';
    btn.className = 'secondary';
    btn.textContent = 'Reprogramar';
    btn.onclick = () => mostrarFormReprogramar411AG(id);
    if (destino) destino.appendChild(btn); else body.appendChild(btn);
  }

  function mostrarFormReprogramar411AG(id) {
    const panelPrevio = document.getElementById('panelReprogramar411AG');
    if (panelPrevio) { panelPrevio.remove(); return; } // toggle: si ya estaba abierto, cerrar

    const lista = typeof atenciones !== 'undefined' ? atenciones : [];
    const a = lista.find(x => String(x.id) === String(id));
    const body = document.getElementById('agendaModalBody');
    if (!a || !body) return;

    const profesionales = (typeof data !== 'undefined' && Array.isArray(data.profesionales)) ? data.profesionales : [];
    const opcionesProfesional = profesionales.filter(p => p.id !== 'general')
      .map(p => `<option value="${escapeHtml(p.id)}" ${p.id === a.profesionalId ? 'selected' : ''}>${escapeHtml(p.nombre)}</option>`)
      .join('');

    const panel = document.createElement('div');
    panel.id = 'panelReprogramar411AG';
    panel.className = 'reprogramar-panel-411ag';
    panel.innerHTML = `
      <h3>Reprogramar turno</h3>
      <div class="reprogramar-grid-411ag">
        <label>Fecha<input type="date" id="reprogFecha411AG" value="${escapeHtml(a.fecha || '')}"></label>
        <label>Hora inicio<input type="text" id="reprogHoraInicio411AG" placeholder="13:00" value="${escapeHtml(a.horaInicio || '')}"></label>
        <label>Hora fin<input type="text" id="reprogHoraFin411AG" placeholder="opcional" value="${escapeHtml(a.horaFin || '')}"></label>
        <label>Profesional<select id="reprogProfesional411AG">${opcionesProfesional}</select></label>
      </div>
      <button type="button" class="secondary horarios-btn-411ag" id="btnVerHorariosReprogramar411AG">Ver horarios disponibles</button>
      <div id="horariosLibresReprogramarWrap411AG"></div>
      <p class="reprogramar-aviso-411ag" id="reprogAviso411AG"></p>
      <div class="agenda-actions modal-actions">
        <button type="button" class="secondary" id="btnCancelarReprogramar411AG">Cancelar</button>
        <button type="button" class="primary" id="btnGuardarReprogramar411AG">Guardar cambio</button>
      </div>`;
    body.appendChild(panel);

    // Punto 5: preservar la duración ACTUAL del turno (horaFin - horaInicio
    // ya cargados; si no hay ambos, la duración de bloque configurada) - si
    // Secretaría sólo cambia la hora de inicio, horaFin se recalcula
    // manteniendo esa duración. Si toca horaFin a mano, se respeta.
    const duracionOriginal411ag = calcularDuracionOriginal411AG(a, lista);
    const horaInicioInput = document.getElementById('reprogHoraInicio411AG');
    const horaFinInput = document.getElementById('reprogHoraFin411AG');
    horaFinInput.dataset.autocalculada411ag = '1';
    horaFinInput.addEventListener('input', () => { horaFinInput.dataset.autocalculada411ag = '0'; });
    horaInicioInput.addEventListener('input', () => {
      if (horaFinInput.dataset.autocalculada411ag === '0') return;
      const nuevaHoraFin = typeof sumarMinutosHora === 'function' ? sumarMinutosHora(horaInicioInput.value, duracionOriginal411ag) : '';
      if (nuevaHoraFin) horaFinInput.value = nuevaHoraFin;
    });

    document.getElementById('btnVerHorariosReprogramar411AG').onclick = () => {
      const contenedor = document.getElementById('horariosLibresReprogramarWrap411AG');
      if (!contenedor) return;
      const profesionalIdActual = document.getElementById('reprogProfesional411AG')?.value || a.profesionalId;
      const fechaActual = document.getElementById('reprogFecha411AG')?.value || a.fecha;
      togglePopoverHorarios411AG(contenedor, profesionalIdActual, fechaActual, duracionOriginal411ag, a.id, (hora) => {
        horaInicioInput.value = hora;
        const finCalculada = typeof sumarMinutosHora === 'function' ? sumarMinutosHora(hora, duracionOriginal411ag) : '';
        if (finCalculada) {
          horaFinInput.value = finCalculada;
          horaFinInput.dataset.autocalculada411ag = '1';
        }
      });
    };

    document.getElementById('btnCancelarReprogramar411AG').onclick = () => panel.remove();
    document.getElementById('btnGuardarReprogramar411AG').onclick = () => guardarReprogramacion411AG(id, panel);
  }

  // Duración actual (minutos) del turno, ANTES de reprogramar: si tiene
  // horaInicio+horaFin válidos, esa diferencia real (aunque sea distinta de
  // la duración configurada de la prestación - respeta lo que ya se había
  // cargado); si no, la duración de bloque (prestación / mayor del grupo).
  function calcularDuracionOriginal411AG(a, lista) {
    const ini = minutosDesdeHora411AG(a.horaInicio);
    const fin = a.horaFin ? minutosDesdeHora411AG(a.horaFin) : null;
    if (ini != null && fin != null && fin > ini) return fin - ini;
    return duracionBloqueTurno411AG(a, lista);
  }

  function guardarReprogramacion411AG(id, panel) {
    const lista = typeof atenciones !== 'undefined' ? atenciones : [];
    const a = lista.find(x => String(x.id) === String(id));
    const aviso = document.getElementById('reprogAviso411AG');
    if (!a) return;

    const nuevaFecha = document.getElementById('reprogFecha411AG')?.value || '';
    const nuevaHoraInicio = (document.getElementById('reprogHoraInicio411AG')?.value || '').trim();
    const nuevaHoraFin = (document.getElementById('reprogHoraFin411AG')?.value || '').trim();
    const nuevoProfesionalId = document.getElementById('reprogProfesional411AG')?.value || a.profesionalId;

    if (!nuevaFecha || !nuevaHoraInicio) {
      if (aviso) aviso.textContent = 'Completá al menos fecha y hora de inicio.';
      return;
    }

    // AJUSTE 1: si el turno tiene grupoTurnoId (prestaciones adicionales del
    // mismo turno, ej. Consulta + Holter), reprogramar TODO el grupo junto -
    // nunca puede quedar una prestación en el horario nuevo y otra en el
    // viejo. Sin grupoTurnoId, el grupo es sólo esta atención.
    const grupo = a.grupoTurnoId
      ? lista.filter(x => String(x.grupoTurnoId || '') === String(a.grupoTurnoId))
      : [a];

    // El chequeo de superposición se hace una sola vez, con el grupoTurnoId
    // del turno: turnoQueSuperpone411AG ya excluye a todos los miembros del
    // mismo grupo entre sí (ver excepción deliberada), así que un choque
    // contra un turno ajeno aplica igual a todo el grupo.
    const candidato = {
      id: a.id,
      grupoTurnoId: a.grupoTurnoId,
      profesionalId: nuevoProfesionalId,
      fecha: nuevaFecha,
      horaInicio: nuevaHoraInicio,
      horaFin: nuevaHoraFin
    };
    const choque = turnoQueSuperpone411AG(candidato, lista);
    if (choque) {
      if (aviso) aviso.textContent = 'No se puede: se superpone con ' + descripcionChoque411AG(choque) + '.';
      return;
    }

    // Bloque 3, punto 5: advertencia NO bloqueante (la superposición de
    // arriba sigue siendo la única regla dura).
    if (!confirmarSiFueraDeHorario411AG(nuevoProfesionalId, nuevaFecha, nuevaHoraInicio)) {
      return;
    }

    const fechaAntes = a.fecha, horaInicioAntes = a.horaInicio;
    const profesionales = (typeof data !== 'undefined' && Array.isArray(data.profesionales)) ? data.profesionales : [];
    const nuevoProfesional = profesionales.find(p => p.id === nuevoProfesionalId);

    grupo.forEach(x => {
      x.fecha = nuevaFecha;
      x.horaInicio = nuevaHoraInicio;
      x.horaFin = nuevaHoraFin;
      if (nuevoProfesionalId !== x.profesionalId) {
        x.profesionalId = nuevoProfesionalId;
        x.profesional = nuevoProfesional ? nuevoProfesional.nombre : x.profesional;
      }
      try { if (typeof selloAuditoriaEdicion === 'function') selloAuditoriaEdicion(x); } catch (_) {}
    });

    try { saveAtenciones(); } catch (e) { console.warn('Agenda V1: no se pudo guardar la reprogramación:', e); }
    try { renderAgenda?.(); renderTabla?.(); renderStats?.(); } catch (_) {}

    // AJUSTE 2: reutiliza el flujo YA EXISTENTE de Comunicaciones V1 -
    // abrirModalNotificarPaciente460 ya soporta tipo:'reschedule' (etiqueta
    // "Reprogramación", ver COMMS460_TIPOS_LABEL) con el mismo selector de
    // canal Email/WhatsApp/Ambos que usa el resto de la app; simplemente
    // nunca tenía un punto de disparo para reprogramación. Se dispara UNA
    // sola vez con el id del turno ancla (no una vez por cada atención del
    // grupo): las N prestaciones son una sola visita/turno para el
    // paciente y el profesional, así que una sola notificación evita
    // duplicar el aviso. No se toca patient-reminders-24h ni se crea
    // ningún mecanismo de comunicación nuevo.
    if (a.fecha !== fechaAntes || a.horaInicio !== horaInicioAntes) {
      (typeof sincronizarAtencionesSupabase === 'function' ? sincronizarAtencionesSupabase(false) : Promise.resolve())
        .catch(e => console.warn('Agenda V1: no se pudo forzar la sincronización antes de avisar:', e))
        .finally(() => {
          window.notificarProfesionalAsignado460?.(id, 'reschedule');
          window.abrirModalNotificarPaciente460?.(id, 'reschedule');
        });
    }

    panel.remove();
    try { abrirAgendaModal(id); } catch (_) {} // refresca el modal con los datos ya guardados
  }

  const abrirAgendaModalOriginal411AG = typeof abrirAgendaModal === 'function' ? abrirAgendaModal : null;
  if (abrirAgendaModalOriginal411AG && !abrirAgendaModalOriginal411AG.__agendaV1411AG) {
    const wrapped = function (id) {
      abrirAgendaModalOriginal411AG.apply(this, arguments);
      try { inyectarBotonReprogramar411AG(id); } catch (e) { console.warn('Agenda V1: no se pudo agregar el botón de reprogramar:', e); }
    };
    wrapped.__agendaV1411AG = true;
    window.abrirAgendaModal = abrirAgendaModal = wrapped;
  }

  /* ---------------------------------------------------------------------
     3) BUGFIX - reprogramar desde Listado/Filtro (editarAtencion ->
        abrirModalEdicion -> "Guardar" -> guardarEdicionModal) no abria el
        aviso al paciente. El wrapper de Comunicaciones V1 sobre
        guardarEdicionModal (app.js) YA detecta el cambio de fecha/horaInicio
        y YA sincroniza + avisa automaticamente al profesional
        (notificarProfesionalAsignado460(id,'reschedule')) - eso funciona
        bien y no se toca. Lo que faltaba es abrir
        abrirModalNotificarPaciente460(id,'reschedule') para el paciente,
        exactamente como ya hace el flujo de Reprogramar de Agenda V1 (arriba).
        Este wrapper se agrega ENCIMA del de Comunicaciones (este modulo
        carga despues de app.js) y sólo agrega esa pieza faltante - no
        duplica sincronizacion ni el aviso al profesional, que ya ocurren
        dentro de la llamada original. Guarda una sola atencion por click
        (igual que hoy): si el turno tiene grupoTurnoId, el aviso sigue
        siendo uno por click de "Guardar", nunca uno por cada prestacion
        del grupo en la misma operacion.
     --------------------------------------------------------------------- */
  const guardarEdicionModalOriginal411AG = typeof guardarEdicionModal === 'function' ? guardarEdicionModal : null;
  if (guardarEdicionModalOriginal411AG && !guardarEdicionModalOriginal411AG.__agendaV1411AG) {
    const wrapped = function (id) {
      const lista = typeof atenciones !== 'undefined' ? atenciones : [];
      const antes = lista.find(x => String(x.id) === String(id));
      const fechaAntes = antes ? antes.fecha : undefined;
      const horaAntes = antes ? antes.horaInicio : undefined;
      const r = guardarEdicionModalOriginal411AG.apply(this, arguments);
      try {
        const despues = lista.find(x => String(x.id) === String(id));
        // Sólo fecha/hora: si cambió cobertura, observación, prestación,
        // etc. sin tocar fecha/horaInicio, no se muestra ningún aviso de
        // reprogramación.
        if (despues && (despues.fecha !== fechaAntes || despues.horaInicio !== horaAntes)) {
          window.abrirModalNotificarPaciente460?.(id, 'reschedule');
        }
      } catch (e) {
        console.warn('Agenda V1: no se pudo evaluar si el turno fue reprogramado desde Listado/Filtro:', e);
      }
      return r;
    };
    wrapped.__agendaV1411AG = true;
    window.guardarEdicionModal = guardarEdicionModal = wrapped;
  }

  /* ---------------------------------------------------------------------
     4) Duración por prestación en la UI de Configuración existente
        (#listaPrestaciones, ya renderizada por renderConfig() en app.js).
        No se reescribe esa lista: se opera sobre el DOM ya renderizado
        (mismo patrón que copiarWsTurno350/notificar460 en app.js), así
        convive con cualquier otra capa que ya la modifique.
     --------------------------------------------------------------------- */
  const OPCIONES_DURACION_411AG = ['10', '15', '20', '30', '45', '60'];

  function inyectarDuracionesEnListaPrestaciones411AG() {
    const ul = document.getElementById('listaPrestaciones');
    if (!ul) return;
    ul.querySelectorAll('li').forEach(li => {
      if (li.querySelector('.duracion-prestacion-411ag')) return; // ya inyectado en este render
      const boton = li.querySelector('button[onclick^="delPrestacion("]');
      if (!boton) return;
      const m = (boton.getAttribute('onclick') || '').match(/delPrestacion\('([^']*)'\)/);
      if (!m) return;
      const nombrePrestacion = decodeURIComponent(m[1]);

      const wrap = document.createElement('span');
      wrap.className = 'duracion-prestacion-411ag';
      wrap.innerHTML = ` · Duración: <select class="duracion-select-411ag">` +
        OPCIONES_DURACION_411AG.map(v => `<option value="${v}">${v} min</option>`).join('') +
        `<option value="__otro__">Otro…</option></select>` +
        `<input type="number" min="1" step="1" class="duracion-otro-411ag" placeholder="min">`;
      li.insertBefore(wrap, boton);

      const select = wrap.querySelector('.duracion-select-411ag');
      const inputOtro = wrap.querySelector('.duracion-otro-411ag');
      const actual = duracionPrestacion411AG(nombrePrestacion);
      if (OPCIONES_DURACION_411AG.includes(String(actual))) {
        select.value = String(actual);
        inputOtro.style.display = 'none';
      } else {
        select.value = '__otro__';
        inputOtro.style.display = '';
        inputOtro.value = actual;
      }

      select.onchange = () => {
        if (select.value === '__otro__') {
          inputOtro.style.display = '';
          inputOtro.focus();
        } else {
          inputOtro.style.display = 'none';
          setDuracionPrestacion411AG(nombrePrestacion, select.value);
        }
      };
      inputOtro.onchange = () => setDuracionPrestacion411AG(nombrePrestacion, inputOtro.value);
    });
  }

  /* ---------------------------------------------------------------------
     5) Bloque 3 - editor de "Horarios de atención" por profesional. Nueva
        tarjeta en Configuración → Profesionales y equipo (mismo patrón de
        tarjetas dinámicas ya usado en app.js: dataset.configGroupCard +
        dataset.configAccess, ver p.ej. cfgEspecialidades310/
        cfgPerfilProfesional310). Reutiliza el selector YA EXISTENTE
        #cfgProfesionalValores (tarjeta "Valores por profesional") en vez de
        crear un segundo selector de profesional.
     --------------------------------------------------------------------- */
  // Misma fuente que ya usa Configuración para #cfgProfesionalValores
  // (app.js: llenarSelect($('cfgProfesionalValores'), data.profesionales.
  // filter(p=>p.id!=='general'), ...)) - no se crea una segunda lista.
  function profesionalesActivos411AG() {
    return (typeof data !== 'undefined' && Array.isArray(data.profesionales)) ? data.profesionales.filter(p => p && p.id !== 'general') : [];
  }

  // Llena/actualiza el selector PROPIO de la tarjeta. `preferido` fuerza una
  // selección (ej. al sincronizar desde #cfgProfesionalValores); si se omite,
  // se preserva la selección actual del propio selector si sigue existiendo.
  function poblarSelectHorarios411AG(preferido) {
    const sel = document.getElementById('cfgHorariosProfesionalSelect411AG');
    if (!sel) return;
    const profesionales = profesionalesActivos411AG();
    const actual = preferido || sel.value;
    sel.innerHTML = profesionales.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.nombre || p.id)}</option>`).join('');
    const existe = profesionales.some(p => String(p.id) === String(actual));
    sel.value = existe ? actual : (profesionales[0] ? profesionales[0].id : '');
  }

  function renderHorariosProfesionalPanel411AG() {
    const cuerpo = document.querySelector('#cfgHorariosProfesionalV1AG .horarios-cuerpo-411ag');
    if (!cuerpo) return;
    poblarSelectHorarios411AG(); // por si cambió la lista de profesionales (alta/baja); preserva la selección actual si sigue existiendo
    const selPropio = document.getElementById('cfgHorariosProfesionalSelect411AG');
    const profId = selPropio ? selPropio.value : '';
    if (!profId) { cuerpo.innerHTML = '<p class="muted">No hay profesionales cargados todavía.</p>'; return; }
    const cfg = (typeof data !== 'undefined' && data.horariosProfesionales && data.horariosProfesionales[profId]) || {};
    cuerpo.innerHTML = DIAS_LABORALES_411AG.map(dia => {
      // Distinguir "día sin configurar todavía" (clave ausente: mostrar
      // vacío, sin marcar "No atiende") de "explícitamente marcado No
      // atiende" (clave presente como array vacío) - ver
      // evaluarDisponibilidad411AG(), que depende de esta misma distinción.
      const configurado = Object.prototype.hasOwnProperty.call(cfg, dia);
      const franja = (configurado && Array.isArray(cfg[dia]) && cfg[dia][0]) || ['', ''];
      const noAtiende = configurado && (!Array.isArray(cfg[dia]) || !cfg[dia].length);
      return `<div class="horario-dia-row-411ag" data-dia="${dia}">
        <span class="horario-dia-label-411ag">${dia.charAt(0).toUpperCase() + dia.slice(1)}</span>
        <input type="text" class="horario-ini-411ag" placeholder="08:00" value="${escapeHtml(franja[0] || '')}" ${noAtiende ? 'disabled' : ''}>
        <span>a</span>
        <input type="text" class="horario-fin-411ag" placeholder="20:00" value="${escapeHtml(franja[1] || '')}" ${noAtiende ? 'disabled' : ''}>
        <label class="horario-libre-check-411ag"><input type="checkbox" class="horario-nolabora-411ag" ${noAtiende ? 'checked' : ''}> No atiende</label>
      </div>`;
    }).join('');
    cuerpo.querySelectorAll('.horario-nolabora-411ag').forEach(chk => {
      chk.onchange = () => {
        const row = chk.closest('.horario-dia-row-411ag');
        row.querySelector('.horario-ini-411ag').disabled = chk.checked;
        row.querySelector('.horario-fin-411ag').disabled = chk.checked;
      };
    });
  }

  function guardarHorariosProfesional411AG() {
    const selPropio = document.getElementById('cfgHorariosProfesionalSelect411AG');
    const profId = selPropio ? selPropio.value : '';
    if (!profId) { alert('Elegí un profesional primero.'); return; }
    if (typeof data === 'undefined') return;
    if (!data.horariosProfesionales || typeof data.horariosProfesionales !== 'object') data.horariosProfesionales = {};
    const nuevo = {};
    document.querySelectorAll('#cfgHorariosProfesionalV1AG .horario-dia-row-411ag').forEach(row => {
      const dia = row.dataset.dia;
      const noAtiende = row.querySelector('.horario-nolabora-411ag')?.checked;
      const ini = (row.querySelector('.horario-ini-411ag')?.value || '').trim();
      const fin = (row.querySelector('.horario-fin-411ag')?.value || '').trim();
      // "No atiende" se guarda como array VACÍO explícito (no se omite la
      // clave) para poder distinguirlo de "día sin configurar todavía" -
      // ver evaluarDisponibilidad411AG(). Si no está tildado y tampoco hay
      // franja cargada, el día queda sin decidir (no se escribe la clave).
      if (noAtiende) nuevo[dia] = [];
      else if (ini && fin) nuevo[dia] = [[ini, fin]];
    });
    data.horariosProfesionales[profId] = nuevo;
    try { saveConfig(); alert('Horarios guardados.'); } catch (e) { console.warn('Agenda V1: no se pudo guardar los horarios:', e); }
  }

  function asegurarCardHorarios411AG() {
    if (document.getElementById('cfgHorariosProfesionalV1AG')) { renderHorariosProfesionalPanel411AG(); return; }
    const grid = document.querySelector('#config .config-grid');
    if (!grid) return;
    const card = document.createElement('div');
    card.id = 'cfgHorariosProfesionalV1AG';
    card.className = 'config-smart-card-310';
    card.dataset.configGroupCard = 'profesionales';
    card.dataset.configAccess = 'operational';
    card.innerHTML = `
      <h3>Horarios de atención</h3>
      <p class="muted">Configurá los horarios habituales para sugerir turnos libres. No bloquea la carga manual.</p>
      <label>Profesional<select id="cfgHorariosProfesionalSelect411AG"></select></label>
      <div class="horarios-cuerpo-411ag"></div>
      <button type="button" class="primary" id="btnGuardarHorarios411AG">Guardar horarios</button>`;
    // BUGFIX: cardiolink-config-v1.js (Configuración) reorganiza las
    // tarjetas dentro de regiones por pestaña (data-config-v1-body="...")
    // y saca #cfgObrasSocialesV1A de ser hija directa de .config-grid en
    // cuanto corre por primera vez (moveKnownCards, ver ese archivo). Usar
    // grid.insertBefore(card, refYaMovida) tira una excepción de DOM
    // ("el nodo de referencia no es hijo de este nodo") que quedaba
    // atrapada en el try/catch del wrapper de renderConfig - la tarjeta se
    // creaba en memoria pero nunca llegaba a insertarse en ningún lado. Se
    // inserta directo en la región "profesionales" ya armada si existe; si
    // config-v1 todavía no corrió, se apendea a .config-grid y su propio
    // reorganizador la mueve sola (mismo dataset.configGroupCard).
    const regionProfesionales = document.querySelector('[data-config-v1-body="profesionales"]');
    if (regionProfesionales) regionProfesionales.appendChild(card);
    else grid.appendChild(card);
    try { card.classList.toggle('hidden-permission', typeof puedeGestionarConfigOperativa === 'function' && !puedeGestionarConfigOperativa()); } catch (_) {}
    document.getElementById('btnGuardarHorarios411AG').onclick = guardarHorariosProfesional411AG;

    // Selector PROPIO de la tarjeta - es la fuente de verdad de qué
    // profesional se está editando acá (nunca hace falta recordar qué
    // quedó elegido en otra tarjeta/pestaña). Se inicializa con el mismo
    // profesional que ya esté elegido en #cfgProfesionalValores si existe,
    // pura continuidad de UX - a partir de ahí es independiente.
    const selCompartido = document.getElementById('cfgProfesionalValores');
    poblarSelectHorarios411AG(selCompartido ? selCompartido.value : '');
    document.getElementById('cfgHorariosProfesionalSelect411AG').addEventListener('change', renderHorariosProfesionalPanel411AG);

    // Sincronización EN UN SOLO SENTIDO: si cambian "Valores por
    // profesional" en otra tarjeta, el selector propio de Horarios los
    // sigue (para no mostrar datos de un profesional que ya no es el que
    // se está mirando en el resto de Configuración). Al revés no: cambiar
    // el selector de esta tarjeta no toca #cfgProfesionalValores - evita
    // loops y no hace depender a esta tarjeta de la otra.
    if (selCompartido && !selCompartido.dataset.agendaV1Listener411ag) {
      selCompartido.addEventListener('change', () => {
        poblarSelectHorarios411AG(selCompartido.value);
        renderHorariosProfesionalPanel411AG();
      });
      selCompartido.dataset.agendaV1Listener411ag = '1';
    }
    renderHorariosProfesionalPanel411AG();
  }

  const renderConfigOriginal411AG = typeof renderConfig === 'function' ? renderConfig : null;
  if (renderConfigOriginal411AG && !renderConfigOriginal411AG.__agendaV1411AG) {
    const wrapped = function () {
      const r = renderConfigOriginal411AG.apply(this, arguments);
      try { inyectarDuracionesEnListaPrestaciones411AG(); } catch (e) { console.warn('Agenda V1: no se pudo agregar el selector de duración:', e); }
      try { asegurarCardHorarios411AG(); } catch (e) { console.warn('Agenda V1: no se pudo agregar la tarjeta de horarios:', e); }
      return r;
    };
    wrapped.__agendaV1411AG = true;
    window.renderConfig = renderConfig = wrapped;
  }

  /* ---------------------------------------------------------------------
     6) BLOQUE 4 - Vista "Día agenda" dentro de Agenda / sala de espera.
        No reemplaza Tabla/Tarjetas/Semana/Mes (siguen intactas, ver
        renderTablaAgenda321/renderTarjetasAgenda321/renderSemanaAgenda321/
        renderMesAgenda321 en app.js, no tocadas). Se agrega como una opción
        más de #agendaVista y un contenedor propio (#agendaDiaAgenda411AG)
        insertado junto a #agendaTarjetas, mostrado/ocultado desde el mismo
        wrapper que decide qué vista dibujar.
     --------------------------------------------------------------------- */
  function ensureOpcionDiaAgenda411AG() {
    const sel = document.getElementById('agendaVista');
    if (!sel) return;
    if (!Array.from(sel.options).some(o => o.value === 'dia')) {
      sel.insertAdjacentHTML('afterbegin', '<option value="dia">Día agenda</option>');
    }
  }
  ensureOpcionDiaAgenda411AG();
  document.addEventListener('DOMContentLoaded', ensureOpcionDiaAgenda411AG);

  function ensureDiaAgendaContainer411AG() {
    let cont = document.getElementById('agendaDiaAgenda411AG');
    if (cont) return cont;
    const ref = document.getElementById('agendaTarjetas');
    if (!ref || !ref.parentNode) return null;
    cont = document.createElement('div');
    cont.id = 'agendaDiaAgenda411AG';
    cont.className = 'agenda-dia-411ag hidden';
    cont.innerHTML = `<div id="diaAgendaEncabezado411AG" class="dia-agenda-encabezado-411ag"></div>
      <div id="diaAgendaCuerpo411AG" class="dia-agenda-cuerpo-411ag"></div>`;
    ref.insertAdjacentElement('afterend', cont);
    return cont;
  }

  function ocultarDiaAgenda411AG() {
    document.getElementById('agendaDiaAgenda411AG')?.classList.add('hidden');
  }

  // Mismo criterio de filtro de profesional que ya usa Agenda (agendaDatos()/
  // datosAgendaDia() en app.js): médico ve el propio, Matías por defecto ve
  // el suyo salvo que elija otro, Secretaría/Admin ven el filtro tal cual.
  function filtroProfesionalDia411AG() {
    let prof = document.getElementById('agendaProfesional')?.value || '';
    try {
      if (typeof esMedico === 'function' && esMedico()) prof = (typeof profesionalIdUsuarioActual === 'function' ? profesionalIdUsuarioActual() : prof);
      if (typeof esMatiasDuenio === 'function' && esMatiasDuenio() && !prof) prof = 'matias';
    } catch (_) {}
    return prof;
  }

  // Excluye mensajes internos / registros corruptos igual que el resto de
  // Agenda (atencionesOperativas() ya existe en app.js - no se duplica).
  function operativasDia411AG() {
    return (typeof atencionesOperativas === 'function') ? atencionesOperativas() : (typeof atenciones !== 'undefined' ? atenciones : []);
  }

  function datosDiaAgenda411AG(fecha, profesionalId, estadoFiltro) {
    return operativasDia411AG().filter(a => {
      if ((a.fecha || '') !== fecha) return false;
      if (profesionalId && String(a.profesionalId || '') !== String(profesionalId)) return false;
      if (estadoFiltro && estadoTurno411AG(a) !== estadoFiltro) return false;
      return true;
    });
  }

  // Agrupa por grupoTurnoId (prestaciones adicionales del mismo turno, ej.
  // Consulta + ECG) en UNA sola unidad visual. Ventana/duración: misma
  // ventanaTurno411AG/duracionBloqueTurno411AG de Bloques 1-2 (MAYOR
  // duración del grupo, no la suma) - sin lógica nueva de duración.
  function agruparItemsDia411AG(datosDia, listaCompleta) {
    const vistos = new Set();
    const items = [];
    datosDia.forEach(a => {
      const key = a.grupoTurnoId ? 'g:' + a.grupoTurnoId : 'a:' + a.id;
      if (vistos.has(key)) return;
      vistos.add(key);
      const miembros = a.grupoTurnoId
        ? datosDia.filter(x => String(x.grupoTurnoId || '') === String(a.grupoTurnoId))
        : [a];
      const ventana = ventanaTurno411AG(a, listaCompleta);
      items.push({
        anchor: a,
        miembros,
        ini: ventana ? ventana[0] : null,
        fin: ventana ? ventana[1] : null,
        prestaciones: miembros.map(m => m.prestacion).filter(Boolean).join(' + ') || (a.prestacion || 's/prestación')
      });
    });
    return items.sort((x, y) => {
      if (x.ini == null && y.ini == null) return 0;
      if (x.ini == null) return 1;
      if (y.ini == null) return -1;
      return x.ini - y.ini;
    });
  }

  // Huecos libres del día para un profesional puntual: franjas configuradas
  // (Bloque 3, franjasProfesionalDia411AG) MENOS los turnos ya ocupados ese
  // día (cualquier estado salvo cancelado, que nunca bloquea - misma regla
  // que turnoQueSuperpone411AG). Independiente del filtro de Estado que esté
  // eligiendo Secretaría en pantalla: la disponibilidad real no cambia
  // porque se esté mirando sólo, por ejemplo, "Atendidos".
  function huecosLibresDia411AG(profesionalId, fecha, itemsDelDia) {
    if (!profesionalId) return [];
    const dia = diaSemanaDesdeFecha411AG(fecha);
    const franjas = franjasProfesionalDia411AG(profesionalId, dia);
    if (!franjas.length) return [];
    const ocupadas = itemsDelDia
      .filter(it => estadoTurno411AG(it.anchor) !== 'cancelado' && it.ini != null && it.fin != null)
      .map(it => [it.ini, it.fin])
      .sort((a, b) => a[0] - b[0]);
    const huecos = [];
    franjas.forEach(f => {
      let ini = minutosDesdeHora411AG(f && f[0]);
      const fin = minutosDesdeHora411AG(f && f[1]);
      if (ini == null || fin == null) return;
      ocupadas.forEach(([oIni, oFin]) => {
        if (oFin <= ini || oIni >= fin) return;
        if (oIni > ini) huecos.push([ini, Math.min(oIni, fin)]);
        ini = Math.max(ini, oFin);
      });
      if (ini < fin) huecos.push([ini, fin]);
    });
    return huecos.filter(([i, f]) => (f - i) >= 5); // ignorar resabios menores a 5 min
  }

  // BLOQUE 5: formato compacto "6h30" (sin "min" cuando ya hay horas) para
  // que el texto del hueco libre quede corto - "08:30 LIBRE · 6h30".
  function formatDuracionMin411AG(mins) {
    const h = Math.floor(mins / 60), m = mins % 60;
    if (h && m) return `${h}h${m}`;
    if (h) return `${h}h`;
    return `${m}min`;
  }

  // Reduccion de ruido visual (punto 6 del pedido): sólo la acción de
  // estado que tiene sentido para el estado ACTUAL, reutilizando el mismo
  // data-action="agenda-estado" ya cableado globalmente en app.js (no se
  // reimplementa cambiarEstadoAgenda). Atendido/Ausente/Cancelado no suman
  // una acción de estado más - siguen editables desde "Ver ficha".
  function accionContextualHTML411AG(a, estado) {
    const id = escapeHtml(String(a.id));
    if (estado === 'reservado' || estado === 'confirmado') return `<button type="button" data-action="agenda-estado" data-estado="sala_espera" data-id="${id}">Sala</button>`;
    if (estado === 'sala_espera') return `<button type="button" data-action="agenda-estado" data-estado="en_consulta" data-id="${id}">Atender</button>`;
    if (estado === 'en_consulta') return `<button type="button" data-action="agenda-estado" data-estado="atendido" data-id="${id}">Atendido</button>`;
    return '';
  }

  // Nombre de paciente clickeable: EXACTAMENTE el mismo mecanismo que ya usa
  // Tabla hoy (módulo "4.0.3 · evolución directa desde Agenda" en app.js,
  // ver decorateAgenda403/makeClickable403 - no expuestos en window, así que
  // no se llaman directamente, pero SÍ se reutiliza tal cual: 1) el mismo
  // atributo data-evolve-attention403 que ya escuchan, en document, captura,
  // los listeners de click/keydown YA INSTALADOS por ese módulo (líneas
  // ~9649-9658 de app.js - no se agrega ningún listener nuevo acá) y que
  // llaman a la misma función clínica existente (openEvolutionFromAgenda403,
  // expuesta como window.abrirEvolucionAtencion403); 2) la misma clase CSS
  // .agenda-patient-evolve-403 (ya definida en styles.css) para el cursor
  // pointer/hover/focus discreto - no se agrega CSS nuevo. El gate de
  // permiso reutiliza puedeAccederInformacionClinica() (ya existente y
  // global, misma familia de roles que el gate interno de
  // openEvolutionFromAgenda403) en vez de re-derivar el permiso: sin
  // permiso, el nombre queda como texto plano (igual que en Tabla).
  function nombrePacienteClickHTML411AG(a) {
    const nombre = escapeHtml(a.paciente || '');
    let puede = false;
    try { puede = typeof puedeAccederInformacionClinica === 'function' && puedeAccederInformacionClinica(); } catch (_) {}
    if (!puede) return `<strong>${nombre}</strong>`;
    const id = escapeHtml(String(a.id));
    return `<strong class="agenda-patient-evolve-403" data-evolve-attention403="${id}" role="button" tabindex="0" title="Abrir evolución clínica vinculada a este turno" aria-label="Evolucionar ${nombre}">${nombre}</strong>`;
  }

  function bloqueTurnoHTML411AG(it) {
    const a = it.anchor;
    const estado = estadoTurno411AG(a);
    const dur = (it.ini != null && it.fin != null) ? Math.max(it.fin - it.ini, 0) : null;
    // BLOQUE 5 (pulido visual): mismo criterio de "más corto/más largo" según
    // duración real, pero con piso y techo razonables - un turno de 10 min
    // sigue siendo usable (no queda diminuto) y uno de 60+ min no ocupa una
    // pantalla entera. La duración real sigue escrita en el bloque (no se
    // pierde información, sólo se acota el alto).
    const alto = Math.max(46, Math.min(88, Math.round((dur || 30) * 1.3)));
    const atenuado = (estado === 'cancelado' || estado === 'ausente') ? ' dia-atenuado-411ag' : '';
    const rango = (it.ini != null && it.fin != null) ? `${minutosAHora411AG(it.ini)} - ${minutosAHora411AG(it.fin)}` : (a.horaInicio || 's/h');
    const badge = (typeof estadoAgendaBadge === 'function') ? estadoAgendaBadge(a) : '';
    return `<div class="dia-turno-411ag estado-${escapeHtml(estado)}${atenuado}" style="min-height:${alto}px" data-id="${escapeHtml(String(a.id))}">
      <div class="dia-turno-hora-411ag">${escapeHtml(rango)}${dur ? ` <small>(${dur} min)</small>` : ''}</div>
      <div class="dia-turno-info-411ag">
        ${nombrePacienteClickHTML411AG(a)}
        <span>${escapeHtml(it.prestaciones)} · ${escapeHtml(a.obraSocial || a.coberturaAtencion || '')}</span>
      </div>
      <div class="dia-turno-badge-411ag">${badge}</div>
      <div class="dia-turno-actions-411ag">
        <button type="button" data-action="agenda-ver" data-id="${escapeHtml(String(a.id))}">Ver ficha</button>
        ${accionContextualHTML411AG(a, estado)}
      </div>
    </div>`;
  }

  // BLOQUE 5 (pulido visual): altura SIEMPRE compacta y fija, sin importar
  // cuántas horas dure el hueco - la duración se sigue mostrando como texto
  // ("LIBRE · 6h30"), nunca como cientos de píxeles. No cambia qué huecos
  // existen ni cómo se calculan (huecosLibresDia411AG intacta) - sólo cómo
  // se dibuja cada uno.
  function bloqueLibreHTML411AG(ini, fin) {
    const dur = fin - ini;
    return `<button type="button" class="dia-libre-411ag" data-hora="${minutosAHora411AG(ini)}">
      <strong>${minutosAHora411AG(ini)}</strong>
      <span class="dia-libre-label-411ag">LIBRE · ${formatDuracionMin411AG(dur)}</span>
      <span class="dia-libre-cta-411ag">+ Dar turno</span>
    </button>`;
  }

  function lineaAhoraHTML411AG(ahoraMin) {
    return `<div class="dia-ahora-411ag"><span>Ahora · ${minutosAHora411AG(ahoraMin)}</span></div>`;
  }

  // "+ Dar turno" sobre un hueco libre: NO abre un formulario nuevo. Va a la
  // sección "Carga de turno/atención" YA EXISTENTE (showSection('carga')),
  // limpia el paciente que hubiera quedado seleccionado (mismo helper que ya
  // usa el botón global "Nuevo turno" del Dashboard, quitarPacienteSeleccionadoCarga())
  // y precarga profesional/fecha/horaInicio en los campos estáticos del
  // formulario. horaFin se calcula sola apenas se elija la prestación,
  // reutilizando el listener de Bloque 2 (instalarListenersCargaTurno411AG).
  function irACargaTurnoDesdeHueco411AG(profesionalId, fecha, horaInicio) {
    try { if (typeof quitarPacienteSeleccionadoCarga === 'function') quitarPacienteSeleccionadoCarga(); } catch (_) {}
    try { showSection('carga'); } catch (e) { console.warn('Agenda V1 (Bloque 4): no se pudo abrir Carga de turno:', e); return; }
    setTimeout(() => {
      const profEl = document.getElementById('profesional');
      const fechaEl = document.getElementById('fecha');
      const horaInicioEl = document.getElementById('horaInicio');
      if (profEl && profesionalId) profEl.value = profesionalId;
      if (fechaEl && fecha) fechaEl.value = fecha;
      if (horaInicioEl && horaInicio) {
        horaInicioEl.value = horaInicio;
        horaInicioEl.dispatchEvent(new Event('change'));
      }
      document.getElementById('paciente')?.focus();
    }, 60);
  }

  function renderEncabezadoDia411AG(fecha, profesionalId, items) {
    const encabezado = document.getElementById('diaAgendaEncabezado411AG');
    if (!encabezado) return;
    const dia = diaSemanaDesdeFecha411AG(fecha);
    const diaLabel = dia ? dia.charAt(0).toUpperCase() + dia.slice(1) : '';
    const fechaLabel = (typeof formatFecha === 'function') ? formatFecha(fecha) : fecha;
    const prof = profesionalesActivos411AG().find(p => String(p.id) === String(profesionalId));
    const profLabel = prof ? (prof.nombre || prof.id) : 'Todos los profesionales';
    const total = items.length;
    const atendidos = items.filter(it => estadoTurno411AG(it.anchor) === 'atendido').length;
    const pendientes = total - atendidos;
    const resumen = total ? `${total} turno${total === 1 ? '' : 's'} · ${atendidos} atendido${atendidos === 1 ? '' : 's'} · ${pendientes} pendiente${pendientes === 1 ? '' : 's'}` : 'Sin turnos para esta fecha.';
    encabezado.innerHTML = `<strong>${escapeHtml(diaLabel)} ${escapeHtml(fechaLabel)}</strong><span>${escapeHtml(profLabel)}</span><span class="muted">${escapeHtml(resumen)}</span>`;
  }

  function renderTimelineDia411AG(fecha, profesionalId, items, itemsVisibles) {
    const cuerpo = document.getElementById('diaAgendaCuerpo411AG');
    if (!cuerpo) return;
    const huecos = huecosLibresDia411AG(profesionalId, fecha, items);
    const entradas = itemsVisibles.map(it => ({ tipo: 'turno', ini: it.ini, fin: it.fin, item: it }))
      .concat(huecos.map(([ini, fin]) => ({ tipo: 'libre', ini, fin })))
      .sort((a, b) => (a.ini ?? 9999) - (b.ini ?? 9999));

    if (!entradas.length) {
      cuerpo.innerHTML = profesionalId
        ? '<p class="muted">No hay turnos ni horario configurado para mostrar ese día.</p>'
        : '<p class="muted">No hay turnos para esta fecha. Elegí un profesional para ver también los horarios libres.</p>';
      return;
    }

    const esHoy = fecha === (typeof todayISO === 'function' ? todayISO() : '');
    const ahoraMin = esHoy ? (new Date().getHours() * 60 + new Date().getMinutes()) : null;
    let lineaInsertada = ahoraMin == null;

    let html = '';
    entradas.forEach(e => {
      if (!lineaInsertada && e.ini != null && ahoraMin <= e.ini) {
        html += lineaAhoraHTML411AG(ahoraMin);
        lineaInsertada = true;
      }
      html += (e.tipo === 'turno') ? bloqueTurnoHTML411AG(e.item) : bloqueLibreHTML411AG(e.ini, e.fin);
    });
    if (!lineaInsertada) html += lineaAhoraHTML411AG(ahoraMin);
    cuerpo.innerHTML = html;

    cuerpo.querySelectorAll('.dia-libre-411ag').forEach(btn => {
      btn.onclick = () => irACargaTurnoDesdeHueco411AG(profesionalId, fecha, btn.dataset.hora);
    });
  }

  function renderDiaAgenda411AG() {
    const cont = ensureDiaAgendaContainer411AG();
    if (!cont) return;
    document.getElementById('agendaTablaWrap')?.classList.add('hidden');
    document.getElementById('agendaTarjetas')?.classList.add('hidden');
    document.getElementById('agendaCalendario320')?.classList.add('hidden');
    cont.classList.remove('hidden');

    const fecha = document.getElementById('agendaFecha')?.value || (typeof todayISO === 'function' ? todayISO() : '');
    const profesionalId = filtroProfesionalDia411AG();
    const estadoFiltro = document.getElementById('agendaEstado')?.value || '';
    const listaCompleta = typeof atenciones !== 'undefined' ? atenciones : [];

    // Sin filtro de Estado para agrupar/calcular huecos: la disponibilidad y
    // los grupos son un hecho del día, no de lo que Secretaría esté mirando.
    const datosDiaProf = datosDiaAgenda411AG(fecha, profesionalId, '');
    const items = agruparItemsDia411AG(datosDiaProf, listaCompleta);
    const itemsVisibles = estadoFiltro ? items.filter(it => estadoTurno411AG(it.anchor) === estadoFiltro) : items;

    if (document.getElementById('agendaResumen')) document.getElementById('agendaResumen').textContent = '';
    renderEncabezadoDia411AG(fecha, profesionalId, items);
    renderTimelineDia411AG(fecha, profesionalId, items, itemsVisibles);
  }

  // Nombre de paciente clickeable en Tarjetas: MISMA técnica que
  // nombrePacienteClickHTML411AG (arriba) - mismo atributo/clase que ya
  // escuchan los listeners existentes de app.js, mismo gate de permiso. No
  // se toca renderTarjetasAgenda321 (app.js): se decora el DOM ya renderizado
  // (mismo patrón que inyectarDuracionesEnListaPrestaciones411AG sobre
  // #listaPrestaciones), buscando el nombre en el mismo lugar donde ya lo
  // busca decorateAgenda403 (".agenda-card-top + div strong", el <div> que
  // sigue al encabezado de hora/estado de cada tarjeta) - esto es un
  // refuerzo redundante-pero-inofensivo: si el decorador de app.js ya lo
  // marcó (dataset.evolveAttention403 presente), no hace nada.
  function decorarNombreTarjetasAgenda411AG() {
    let puede = false;
    try { puede = typeof puedeAccederInformacionClinica === 'function' && puedeAccederInformacionClinica(); } catch (_) { return; }
    if (!puede) return;
    document.querySelectorAll('#agendaTarjetas .agenda-turno-card[data-id]').forEach(card => {
      const id = card.dataset.id;
      const nombreEl = card.querySelector('.agenda-card-top + div strong') || Array.from(card.querySelectorAll('strong'))[1];
      if (!nombreEl || nombreEl.dataset.evolveAttention403) return;
      nombreEl.dataset.evolveAttention403 = String(id);
      nombreEl.classList.add('agenda-patient-evolve-403');
      nombreEl.setAttribute('role', 'button');
      nombreEl.setAttribute('tabindex', '0');
      nombreEl.setAttribute('title', 'Abrir evolución clínica vinculada a este turno');
      nombreEl.setAttribute('aria-label', `Evolucionar ${nombreEl.textContent.trim() || 'paciente'}`);
    });
  }

  const renderAgendaOriginal411AG = typeof renderAgenda === 'function' ? renderAgenda : null;
  if (renderAgendaOriginal411AG && !renderAgendaOriginal411AG.__agendaV1411AG) {
    const wrapped = function () {
      try { ensureOpcionDiaAgenda411AG(); } catch (_) {}
      const vista = document.getElementById('agendaVista')?.value || 'tabla';
      if (vista === 'dia') {
        try { if (typeof agendaTextoPerfil === 'function') agendaTextoPerfil(); } catch (_) {}
        try { renderDiaAgenda411AG(); } catch (e) { console.warn('Agenda V1 (Bloque 4): no se pudo renderizar Día agenda:', e); }
        return;
      }
      const r = renderAgendaOriginal411AG.apply(this, arguments);
      try { ocultarDiaAgenda411AG(); } catch (_) {}
      if (vista === 'tarjetas') { try { decorarNombreTarjetasAgenda411AG(); } catch (e) { console.warn('Agenda V1 (Bloque 4): no se pudo marcar el nombre clickeable en Tarjetas:', e); } }
      return r;
    };
    wrapped.__agendaV1411AG = true;
    window.renderAgenda = renderAgenda = wrapped;
  }

  /* ---------------------------------------------------------------------
     Estilos minimos del panel de reprogramar. No es un rediseño: sólo el
     panel nuevo, reutiliza clases existentes (.agenda-actions, .modal-actions,
     .secondary, .primary) para todo lo demas.
     --------------------------------------------------------------------- */
  if (!document.getElementById('cardiolink-agenda-v1-style')) {
    const style = document.createElement('style');
    style.id = 'cardiolink-agenda-v1-style';
    style.textContent = `
      .reprogramar-panel-411ag{margin-top:14px;padding:12px;border:1px solid var(--border,#dbe3ea);border-radius:12px;background:var(--panel-alt,#f8fbfc)}
      .reprogramar-panel-411ag h3{margin:0 0 10px}
      .reprogramar-grid-411ag{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 14px}
      .reprogramar-grid-411ag label{font-size:12px;font-weight:700}
      .reprogramar-grid-411ag input,.reprogramar-grid-411ag select{width:100%;margin-top:5px;box-sizing:border-box}
      .reprogramar-aviso-411ag{color:var(--danger,#a13636);font-size:13px;font-weight:600;min-height:1em;margin:10px 0 0}
      @media (max-width:640px){.reprogramar-grid-411ag{grid-template-columns:1fr}}
      .duracion-prestacion-411ag{margin-left:8px;font-size:12px;color:var(--muted,#64748b)}
      .duracion-prestacion-411ag select,.duracion-prestacion-411ag input{font-size:12px;padding:2px 4px}
      .duracion-otro-411ag{width:56px;margin-left:4px}
      .horarios-btn-411ag{margin-top:8px}
      .horarios-libres-411ag{margin-top:8px;padding:10px;border:1px solid var(--border,#dbe3ea);border-radius:10px;background:var(--panel-alt,#f8fbfc);display:flex;flex-wrap:wrap;gap:6px}
      .horario-libre-btn-411ag{padding:4px 10px;border-radius:999px;border:1px solid var(--cl-accent,#0e6e82);background:#fff;color:var(--cl-accent,#0e6e82);font-weight:700;font-size:12px;cursor:pointer}
      .horario-libre-btn-411ag:hover{background:var(--cl-accent-soft,rgba(14,110,130,.10))}
      .horario-dia-row-411ag{display:flex;align-items:center;gap:8px;padding:5px 0;flex-wrap:wrap}
      .horario-dia-label-411ag{width:90px;font-weight:700;font-size:13px}
      .horario-dia-row-411ag input[type="text"]{width:72px}
      .horario-libre-check-411ag{font-size:12px;color:var(--muted,#64748b);display:flex;align-items:center;gap:4px;margin-left:8px}
      /* BLOQUE 5 - pulido visual de "Día agenda" (sólo presentación: no
         cambia huecosLibresDia411AG, ventanaTurno411AG ni ningún cálculo). */
      .agenda-dia-411ag{margin-top:10px}
      .dia-agenda-encabezado-411ag{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 14px;padding:10px 16px;border:1px solid var(--border,#dbe3ea);border-radius:14px;background:var(--panel-alt,#f8fbfc);margin-bottom:10px}
      .dia-agenda-encabezado-411ag strong{font-size:15px}
      .dia-agenda-cuerpo-411ag{display:flex;flex-direction:column;gap:6px}
      .dia-turno-411ag{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:6px 14px;border-radius:12px;border:1px solid #dbe3ee;border-left:6px solid #6366f1;background:#f1f5ff}
      .dia-turno-411ag.estado-confirmado{border-left-color:#2dd4bf;background:#ecfeff}
      .dia-turno-411ag.estado-sala_espera{border-left-color:#06b6d4;background:#ecfeff}
      .dia-turno-411ag.estado-en_consulta{border-left-color:#9333ea;background:#f5f3ff}
      .dia-turno-411ag.estado-atendido{border-left-color:#6d5bb5;background:#f4f0ff}
      .dia-turno-411ag.estado-ausente{border-left-color:#ec4899;background:#fff1f2}
      .dia-turno-411ag.estado-cancelado{border-left-color:#64748b;background:#f1f5f9}
      .dia-turno-411ag.dia-atenuado-411ag{opacity:.55}
      .dia-turno-hora-411ag{min-width:112px;font-weight:800;font-size:13px}
      .dia-turno-hora-411ag small{color:var(--muted,#64748b);font-weight:600}
      .dia-turno-info-411ag{flex:1 1 220px;display:flex;flex-direction:column;gap:1px;font-size:13px}
      /* Más jerarquía para el nombre del paciente (punto 4 del pedido) -
         escalado sólo acá adentro, sin tocar la clase compartida
         .agenda-patient-evolve-403 que usan también Tabla/Tarjetas. */
      .dia-turno-info-411ag strong{font-size:14.5px}
      .dia-turno-info-411ag span{color:var(--muted,#64748b);font-size:12px}
      .dia-turno-actions-411ag{display:flex;gap:6px;flex-wrap:wrap}
      /* Menos peso visual en los botones secundarios: estilo "ghost" en vez
         del chip sólido gris anterior. */
      .dia-turno-actions-411ag button{background:transparent;color:var(--muted,#64748b);font-weight:600;padding:4px 9px;font-size:11px;border-radius:8px;border:1px solid #d7dee6;cursor:pointer}
      .dia-turno-actions-411ag button:hover{background:#eef2f7;color:var(--text,#0f172a)}
      /* Huecos libres: SIEMPRE altura compacta y fija, sin importar cuántas
         horas dure el hueco - la duración se lee en el texto, no en el alto. */
      .dia-libre-411ag{display:flex;align-items:center;gap:8px;min-height:38px;padding:6px 14px;border-radius:10px;border:1.5px dashed var(--cl-accent,#0e6e82);background:transparent;color:var(--cl-accent,#0e6e82);font-size:12.5px;font-weight:700;cursor:pointer;width:100%;text-align:left}
      .dia-libre-411ag:hover{background:var(--cl-accent-soft,rgba(14,110,130,.08))}
      .dia-libre-label-411ag{font-weight:600;color:var(--muted,#64748b)}
      .dia-libre-cta-411ag{margin-left:auto;font-size:11.5px;font-weight:700}
      .dia-ahora-411ag{display:flex;align-items:center;gap:8px;margin:0}
      .dia-ahora-411ag::before,.dia-ahora-411ag::after{content:'';flex:1;height:1px;background:var(--danger,#a13636)}
      .dia-ahora-411ag span{font-size:11px;font-weight:800;color:var(--danger,#a13636);white-space:nowrap}
      body.dark .dia-turno-411ag{background:#142e3b;border-color:#25465a;color:#f8fafc}
      body.dark .dia-turno-info-411ag span{color:#cbd5e1}
      body.dark .dia-turno-actions-411ag button{border-color:#25465a;color:#cbd5e1}
      body.dark .dia-turno-actions-411ag button:hover{background:#0f2633;color:#f8fafc}
      body.dark .dia-agenda-encabezado-411ag{background:#0f2633;border-color:#25465a;color:#f8fafc}
      @media (max-width:640px){.dia-turno-411ag{flex-direction:column;align-items:flex-start}.dia-turno-actions-411ag{width:100%}}
    `;
    document.head.appendChild(style);
  }
})();
