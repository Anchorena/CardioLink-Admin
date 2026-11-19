/* CardioLink · Persistencia V1 / R2C · Fusión de tres vías de UNA atención (payload de cardiolink_atenciones).
   Módulo puro (sin DOM, Supabase ni globales de la app). Reutiliza el motor de R2B (cardiolink-config-merge-v1.js) para los campos «sueltos» y aplica reglas por GRUPO
   de campos donde una fusión campo a campo sería incorrecta (dinero, estado, identidad, sellos, pendientes).

   fusionarAtencion(base, local, remoto, ctx) → { ok, payload, conflictos[], rechazos[], camposLocales[], camposRemotos[] }
     base  = contenido de la atención tal como esta sesión la cargó/confirmó; local = su copia con cambios; remoto = la fila actual del servidor.
     ctx   = { rol: 'admin'|'secretaria'|'medico', resoluciones: {clave:'local'|'remoto'}, ahora: ISO, usuario: texto }
   Nunca modifica sus argumentos.

   REGLAS (decisiones R2C)
    - CONFIRMACIÓN de cobro (cobroConfirmado*, cobroMedioPago): SIEMPRE la del remoto. La fusión genérica NUNCA confirma ni altera una confirmación (camino especializado de cobros).
      Un cambio local ahí se informa como RECHAZO (no se aplica) y se conserva su valor para recuperación.
    - ECONÓMICO (monto..., tipoCobro, formaPago, noCobrar, cajaPerfil, reglaOS, consultaA, prestacionA, facturador + estadoCobro, cobroPendienteEn/Por y cobroAuditoria): grupo INDIVISIBLE.
      Con cobro CONFIRMADO en el remoto (cobroConfirmadoPorRol, criterio del guard v4.2.1) está congelado: se conserva el remoto y el cambio local se informa. Sin cobro confirmado:
      si cambió un solo lado se toma ese lado completo; si cambiaron los dos de forma distinta es conflicto (nunca se combinan valores de lados distintos).
    - ESTADO (estadoTurno/estado, cancelación, sellos del estado): grupo indivisible; estados incompatibles = conflicto explícito (NO se resuelve por fecha de edición).
      La cancelación del paciente ya confirmada en el remoto NO se revierte (el cambio local se informa y no es resoluble con «mi valor»). Con cobro confirmado el Médico no
      puede cancelar ni marcar ausente (el guard lo rechaza): se informa; para los demás roles decide el servidor.
    - IDENTIDAD/PERTENENCIA (id, pacienteId, paciente, dni, profesionalId, profesional, grupoTurnoId, tipoRegistro) y AGENDA (fecha, horarios, duraciones): grupos indivisibles; cualquier
      cambio de identidad es conflicto explícito; agenda: un lado → ese lado, dos lados distintos → conflicto.
    - SELLOS (editadoPor/Usuario/Rol/En): se toma la UNIDAD COMPLETA del lado con editadoEn más reciente (nunca se mezclan campos de usuarios distintos) y no generan falsos conflictos.
      Si hubo cambios de ambos lados se agrega una entrada a auditoriaConcurrencia (fecha, usuario que guarda, campos de cada lado; sin valores) para la trazabilidad.
    - PENDIENTES (bonoFirmado, copiaImpresa, estudioInformado, entrega, retiro, autorización, cancelación): cada pendiente es un grupo; un lado → ese lado; si dos lados difieren gana el
      que lo tiene RESUELTO (nunca se reabre un pendiente resuelto por una copia desactualizada). auditoriaPendientes: se agregan entradas sin duplicar.
    - Resto de los campos: motor de fusión genérico (campo a campo; listas sin regla = bloque). */
(function (raiz, fabrica) {
  'use strict';
  var motor = (typeof module === 'object' && module.exports) ? require('./cardiolink-config-merge-v1.js') : raiz.cardiolinkConfigMergeV1;
  var api = fabrica(motor);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.cardiolinkAtencionesMergeV1 = api;
})(typeof self !== 'undefined' ? self : this, function (M) {
  'use strict';
  if (!M) return null;

  var COBRO_ESTADO = ['estadoCobro', 'cobroPendienteEn', 'cobroPendientePor', 'cobroAuditoria'];
  var COBRO_CONFIRMACION = ['cobroConfirmadoEn', 'cobroConfirmadoPor', 'cobroConfirmadoPorId', 'cobroConfirmadoPorRol', 'cobroConfirmadoPorEmail', 'cobroMedioPago'];
  var COBRO = COBRO_ESTADO.concat(COBRO_CONFIRMACION);   // los 10 campos protegidos por el guard v4.2.1
  // Los 8 campos económicos que el guard v4.2.1 congela con cobro confirmado (restrictivo) + los datos económicos RELACIONADOS (cobertura, arancel, destino de facturación, colocación): un solo grupo indivisible.
  var FINANCIERO = ['montoConsulta', 'montoEstudio', 'montoCopago', 'montoTotal', 'tipoCobro', 'formaPago', 'noCobrar', 'cajaPerfil'];
  var ECON_RELACIONADO = ['reglaOS', 'consultaA', 'prestacionA', 'facturador', 'obraSocial', 'coberturaAtencion', 'arancelId', 'arancelVigencia', 'arancelCalculadoEn', 'valorArancelEstimado', 'destinoFacturacionEstimado', 'cuentaConsulta', 'colocacionLiquidable', 'colocador'];
  var IDENTIDAD = ['id', 'pacienteId', 'paciente', 'dni', 'profesionalId', 'profesional', 'grupoTurnoId', 'tipoRegistro'];
  var AGENDA = ['fecha', 'horaInicio', 'horaFin', 'duracion', 'duracionMinutos', 'duracionOriginal', 'duracionBloqueTurno'];
  var ESTADO = ['estadoTurno', 'estado', 'estadoTurnoEditadoPor', 'estadoTurnoEditadoEn', 'canceladoPor', 'canceladoEn', 'motivoCancelacion', 'reprogramado'];
  var SELLO = ['editadoPor', 'editadoUsuario', 'editadoRol', 'editadoEn'];
  // Pendientes: [nombre, campo principal (true = resuelto), campos auxiliares]
  var PENDIENTES = [
    ['firma', 'bonoFirmado', ['noAplicaFirmaBono']], ['copia', 'copiaImpresa', ['noAplicaCopiaFacturacion']], ['informe', 'estudioInformado', []],
    ['entrega', 'estudioImpreso', ['disponibleRetiro', 'estudioEnviadoMail', 'estudioEnviadoWS']],
    ['retiro', 'retiradoFisico', ['fechaRetiroFisico']], ['autorizacion', 'autorizacionCompleta', []],
    ['cancelacion', 'pendienteCancelacionResuelto', ['pendienteCancelacionResueltoEn', 'pendienteCancelacionResueltoPor']]
  ];
  var AUDITORIA_PEND = 'auditoriaPendientes', AUDITORIA_CONC = 'auditoriaConcurrencia';

  var ESQUEMA = [
    { patron: [AUDITORIA_PEND], regla: { tipo: 'auditoria' } },
    { patron: [AUDITORIA_CONC], regla: { tipo: 'auditoria' } }
  ];

  var AUSENTE = { ausente: true };
  function tiene(o, k) { return Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined; }
  function sub(o, campos) { var s = {}; campos.forEach(function (k) { if (tiene(o, k)) s[k] = o[k]; }); return s; }
  function iguales(a, b) { return M.iguales(a, b); }
  function cambiados(b, l, campos) { return campos.filter(function (k) { return !iguales(tiene(b, k) ? b[k] : AUSENTE, tiene(l, k) ? l[k] : AUSENTE) && !(tiene(b, k) === false && tiene(l, k) === false); }); }
  function texto(v) {
    if (v === undefined) return '(sin valor)';
    if (v === null) return '(vacío)';
    if (typeof v === 'string') return v === '' ? '(texto vacío)' : (v.length > 60 ? v.slice(0, 57) + '…' : v);
    if (typeof v === 'object') return '(' + (Array.isArray(v) ? 'lista' : 'objeto') + ')';
    return String(v);
  }
  function resumen(o, campos) { return campos.filter(function (k) { return tiene(o, k); }).map(function (k) { return k + ': ' + texto(o[k]); }).join(' · ') || '(sin datos)'; }
  function minusculas(v) { return String(v == null ? '' : v).toLowerCase(); }
  function estadoDe(o) { return minusculas(tiene(o, 'estadoTurno') ? o.estadoTurno : o.estado); }
  function confirmadoRemoto(r) { return tiene(r, 'cobroConfirmadoPorRol') && r.cobroConfirmadoPorRol !== '' && r.cobroConfirmadoPorRol !== null; }
  function cancelacionPaciente(r) { return estadoDe(r) === 'cancelado' && /^paciente/i.test(String(r.canceladoPor || '')); }

  function fusionarAtencion(base, local, remoto, ctx) {
    ctx = ctx || {};
    var res = ctx.resoluciones || {};
    var b = M.clonar(base) || {}, l = M.clonar(local) || {}, r = M.clonar(remoto) || {};
    var out = {}, conflictos = [], rechazos = [], camposLocales = [], camposRemotos = [];
    var admin = ctx.rol === 'admin', medico = ctx.rol === 'medico';
    var id = String(tiene(r, 'id') ? r.id : (tiene(l, 'id') ? l.id : (tiene(b, 'id') ? b.id : '')));

    function copiar(campos, origen) { campos.forEach(function (k) { if (tiene(origen, k)) out[k] = origen[k]; }); }
    function anotarCambios(campos) {
      cambiados(b, l, campos).forEach(function (k) { camposLocales.push(k); });
      cambiados(b, r, campos).forEach(function (k) { camposRemotos.push(k); });
    }
    function conflicto(clave, tipo, grupo, campos, opciones, extra) {
      var dec = res[clave];
      if (dec === 'local' && opciones.local) return 'local';
      if (dec === 'remoto' && opciones.remoto) return 'remoto';
      var c = { clave: clave, tipo: tipo, grupo: grupo, atencionId: id, campos: campos.slice(), opciones: opciones, localTexto: resumen(l, campos), remotoTexto: resumen(r, campos) };
      if (extra) Object.keys(extra).forEach(function (k) { c[k] = extra[k]; });
      conflictos.push(c); return null;
    }
    function rechazo(grupo, campos, motivo) {
      var valores = {}; campos.forEach(function (k) { valores[k] = tiene(l, k) ? l[k] : null; });
      rechazos.push({ grupo: grupo, campos: campos.slice(), motivo: motivo, valoresLocales: valores });
    }
    // grupo indivisible genérico: devuelve 'local' | 'remoto' | 'igual' | null (conflicto sin resolver)
    function decidirGrupo(clave, tipo, grupo, campos, opciones, extra) {
      var bs = sub(b, campos), ls = sub(l, campos), rs = sub(r, campos);
      if (iguales(ls, rs)) return 'igual';
      var cl = !iguales(bs, ls), cr = !iguales(bs, rs);
      if (!cl) return 'remoto';
      if (!cr) return 'local';
      return conflicto(clave, tipo, grupo, campos, opciones, extra);
    }
    var PERMITE = { local: true, remoto: true };

    // ---- COBRO y FINANCIERO ----
    // Confirmación de cobro (cobroConfirmado*, medio): sólo por el camino especializado de cobros; la fusión genérica nunca la crea ni la altera.
    var confirmado = confirmadoRemoto(r);
    var confLocal = cambiados(b, l, COBRO_CONFIRMACION);
    copiar(COBRO_CONFIRMACION, r);
    if (confLocal.length) rechazo('cobro', confLocal, 'La confirmación de un cobro sólo se realiza desde Pendientes › Cobros; este cambio no se aplicó.');
    cambiados(b, r, COBRO_CONFIRMACION).forEach(function (k) { camposRemotos.push(k); });
    var CONGELADOS = FINANCIERO.concat(COBRO_ESTADO);
    var congLocal = cambiados(b, l, CONGELADOS);
    if (confirmado) {
      // cobro confirmado (guard v4.2.1): importes, forma de pago, caja, estado y auditoría del cobro quedan congelados
      copiar(CONGELADOS, r);
      if (congLocal.length) rechazo('financiero', congLocal, 'El cobro ya fue confirmado: importes, forma de pago, caja y auditoría están congelados y no se modificaron.');
      cambiados(b, r, CONGELADOS).forEach(function (k) { camposRemotos.push(k); });
      // lo económico relacionado (cobertura, arancel, destino) sigue siendo un grupo indivisible por sí mismo
      var dr = decidirGrupo('grupo:economico_relacionado', 'financiero', 'Cobertura y arancel', ECON_RELACIONADO, PERMITE);
      if (dr === 'local') { copiar(ECON_RELACIONADO, l); cambiados(b, l, ECON_RELACIONADO).forEach(function (k) { camposLocales.push(k); }); }
      else { copiar(ECON_RELACIONADO, dr === null ? l : r); if (dr !== null) cambiados(b, r, ECON_RELACIONADO).forEach(function (k) { camposRemotos.push(k); }); }
    } else {
      // sin cobro confirmado: los datos económicos son UN grupo indivisible (nunca se combinan valores de lados distintos)
      // un paso a «cobrado» NUNCA viaja por la fusión genérica (la confirmación es sólo del camino de cobros): se descarta del local ese cambio de estado
      if (l.estadoCobro === 'cobrado' && b.estadoCobro !== 'cobrado') {
        rechazo('cobro', cambiados(b, l, COBRO_ESTADO), 'Pasar un cobro a «cobrado» sólo se hace desde Pendientes › Cobros; este cambio no se aplicó.');
        COBRO_ESTADO.forEach(function (k) { if (tiene(b, k)) l[k] = b[k]; else delete l[k]; });
      }
      var GRUPO_ECON = CONGELADOS.concat(ECON_RELACIONADO), econLocal = cambiados(b, l, GRUPO_ECON);
      var df = decidirGrupo('grupo:financiero', 'financiero', 'Datos económicos', GRUPO_ECON, PERMITE);
      if (df === 'local') { copiar(GRUPO_ECON, l); econLocal.forEach(function (k) { camposLocales.push(k); }); }
      else if (df === 'remoto' || df === 'igual') { copiar(GRUPO_ECON, r); cambiados(b, r, GRUPO_ECON).forEach(function (k) { camposRemotos.push(k); }); }
      else { copiar(GRUPO_ECON, l); }
    }

    // ---- IDENTIDAD / PERTENENCIA: cualquier cambio es conflicto explícito ----
    (function () {
      var bs = sub(b, IDENTIDAD), ls = sub(l, IDENTIDAD), rs = sub(r, IDENTIDAD);
      if (iguales(ls, rs)) { copiar(IDENTIDAD, r); return; }
      var cl = !iguales(bs, ls), cr = !iguales(bs, rs);
      if (!cl) { copiar(IDENTIDAD, r); return; }       // el local no tocó la identidad: se acepta la del servidor
      // el local cambió identidad/pertenencia mientras otra sesión modificó la atención: nunca se fusiona sola
      var d = conflicto('grupo:identidad', 'identidad', 'Paciente / profesional / pertenencia', IDENTIDAD, { local: !medico, remoto: true });
      if (d === 'local') { copiar(IDENTIDAD, l); camposLocales.push('identidad'); } else if (d === 'remoto') copiar(IDENTIDAD, r); else copiar(IDENTIDAD, l);
    })();

    // ---- AGENDA ----
    var da = decidirGrupo('grupo:agenda', 'agenda', 'Fecha y horario', AGENDA, PERMITE);
    if (da === 'local') { copiar(AGENDA, l); cambiados(b, l, AGENDA).forEach(function (k) { camposLocales.push(k); }); }
    else {
      copiar(AGENDA, da === null ? l : r);
      if (da !== null) cambiados(b, r, AGENDA).forEach(function (k) { camposRemotos.push(k); });
    }

    // ---- ESTADO ----
    (function () {
      var bs = sub(b, ESTADO), ls = sub(l, ESTADO), rs = sub(r, ESTADO);
      var cl = !iguales(bs, ls), cr = !iguales(bs, rs);
      if (iguales(ls, rs)) { copiar(ESTADO, r); return; }
      if (cancelacionPaciente(r) && estadoDe(l) !== 'cancelado') {
        copiar(ESTADO, r);
        if (cl) rechazo('estado', cambiados(b, l, ESTADO), 'El paciente canceló el turno: la cancelación confirmada no se revierte automáticamente. Para reactivarlo hay que reprogramar o dar otro turno.');
        cambiados(b, r, ESTADO).forEach(function (k) { camposRemotos.push(k); });
        return;
      }
      var nuevoLocal = estadoDe(l);
      if (cl && confirmado && medico && (nuevoLocal === 'cancelado' || nuevoLocal === 'ausente') && nuevoLocal !== estadoDe(b)) {   // el guard sólo restringe a los roles no globales; para Secretaría decide el servidor (asociación)
        copiar(ESTADO, r);
        rechazo('estado', cambiados(b, l, ESTADO), 'Con el cobro confirmado sólo Administración/Dueño puede cancelar o marcar ausente la atención.');
        cambiados(b, r, ESTADO).forEach(function (k) { camposRemotos.push(k); });
        return;
      }
      if (!cl) { copiar(ESTADO, r); cambiados(b, r, ESTADO).forEach(function (k) { camposRemotos.push(k); }); return; }
      if (!cr) { copiar(ESTADO, l); cambiados(b, l, ESTADO).forEach(function (k) { camposLocales.push(k); }); return; }
      var d = conflicto('grupo:estado', 'estado', 'Estado del turno', ESTADO, { local: !cancelacionPaciente(r), remoto: true });
      if (d === 'local') { copiar(ESTADO, l); cambiados(b, l, ESTADO).forEach(function (k) { camposLocales.push(k); }); } else if (d === 'remoto') copiar(ESTADO, r); else copiar(ESTADO, l);
    })();

    // ---- PENDIENTES (cada uno es un grupo; el resuelto nunca se reabre) ----
    PENDIENTES.forEach(function (p) {
      var campos = [p[1]].concat(p[2]), bs = sub(b, campos), ls = sub(l, campos), rs = sub(r, campos);
      if (iguales(ls, rs)) { copiar(campos, r); return; }
      var cl = !iguales(bs, ls), cr = !iguales(bs, rs);
      if (!cl) { copiar(campos, r); cambiados(b, r, campos).forEach(function (k) { camposRemotos.push(k); }); return; }
      if (!cr) { copiar(campos, l); cambiados(b, l, campos).forEach(function (k) { camposLocales.push(k); }); return; }
      var lr = l[p[1]] === true, rr = r[p[1]] === true;
      if (lr && rr) {                                     // ambos lo resolvieron (p. ej. uno imprimió y otro envió): unión de lo resuelto
        copiar(campos, r); campos.forEach(function (k) { if (tiene(l, k) && l[k] && !(tiene(r, k) && r[k])) out[k] = l[k]; });
        return;
      }
      if (lr !== rr) {                                    // sólo uno lo tiene resuelto: gana el resuelto
        copiar(campos, lr ? l : r); (lr ? cambiados(b, l, campos) : cambiados(b, r, campos)).forEach(function (k) { (lr ? camposLocales : camposRemotos).push(k); });
        return;
      }
      var d = conflicto('grupo:pendiente:' + p[0], 'pendiente', 'Pendiente «' + p[0] + '»', campos, PERMITE);
      if (d === 'local') copiar(campos, l); else if (d === 'remoto') copiar(campos, r); else copiar(campos, l);
    });

    // ---- RESTO: motor genérico ----
    var propios = {}; [COBRO, FINANCIERO, ECON_RELACIONADO, IDENTIDAD, AGENDA, ESTADO, SELLO].forEach(function (g) { g.forEach(function (k) { propios[k] = true; }); });
    PENDIENTES.forEach(function (p) { propios[p[1]] = true; p[2].forEach(function (k) { propios[k] = true; }); });
    function resto(o) { var s = {}; Object.keys(o).forEach(function (k) { if (!propios[k] && o[k] !== undefined) s[k] = o[k]; }); return s; }
    var resRes = {}; Object.keys(res).forEach(function (k) { if (k.indexOf('campo:') === 0) resRes[k.slice(6)] = res[k]; });
    var gen = M.fusionar(resto(b), resto(l), resto(r), { esquema: ESQUEMA, resoluciones: resRes });
    gen.conflictos.forEach(function (c) {
      var clave = 'campo:' + c.ruta, tp = c.tipo;
      var tx = function (v, aus) { return aus ? '(no existe)' : texto(v); };
      conflictos.push({ clave: clave, tipo: tp === 'campo' ? 'campo' : tp, grupo: c.ruta, atencionId: id, campos: [c.ruta], opciones: PERMITE, localTexto: c.ruta + ': ' + tx(c.local, c.localAusente), remotoTexto: c.ruta + ': ' + tx(c.remoto, c.remotoAusente) });
    });
    if (gen.config) Object.keys(gen.config).forEach(function (k) { out[k] = gen.config[k]; });
    cambiados(resto(b), resto(l), Object.keys(resto(l)).concat(Object.keys(resto(b)))).forEach(function (k) { if (k !== AUDITORIA_PEND && k !== AUDITORIA_CONC && camposLocales.indexOf(k) < 0) camposLocales.push(k); });
    cambiados(resto(b), resto(r), Object.keys(resto(r)).concat(Object.keys(resto(b)))).forEach(function (k) { if (k !== AUDITORIA_PEND && k !== AUDITORIA_CONC && camposRemotos.indexOf(k) < 0) camposRemotos.push(k); });

    // ---- SELLOS: unidad completa del lado más reciente ----
    (function () {
      var bs = sub(b, SELLO), ls = sub(l, SELLO), rs = sub(r, SELLO);
      var cl = !iguales(bs, ls), cr = !iguales(bs, rs);
      if (iguales(ls, rs)) { copiar(SELLO, r); return; }
      if (!cl) { copiar(SELLO, r); return; }
      if (!cr) { copiar(SELLO, l); return; }
      var tl = Date.parse(l.editadoEn || '') || 0, tr = Date.parse(r.editadoEn || '') || 0;
      copiar(SELLO, tl > tr ? l : r);                     // empate: el remoto (ya confirmado por el servidor)
    })();

    // ---- trazabilidad de una fusión real (sin valores) ----
    var locales = camposLocales.filter(function (k, i, a) { return SELLO.indexOf(k) < 0 && a.indexOf(k) === i; });
    var remotos = camposRemotos.filter(function (k, i, a) { return SELLO.indexOf(k) < 0 && a.indexOf(k) === i; });
    if (conflictos.length === 0 && locales.length && remotos.length) {
      var prev = Array.isArray(out[AUDITORIA_CONC]) ? out[AUDITORIA_CONC].slice() : [];
      prev.push({ accion: 'fusion', fecha: ctx.ahora || new Date().toISOString(), usuario: String(l.editadoUsuario || l.editadoPor || ctx.usuario || ''), rol: String(l.editadoRol || ctx.rol || ''), camposLocales: locales, camposRemotos: remotos });
      out[AUDITORIA_CONC] = prev;
    }
    return { ok: conflictos.length === 0, payload: out, conflictos: conflictos, rechazos: rechazos, camposLocales: locales, camposRemotos: remotos };
  }

  return { fusionarAtencion: fusionarAtencion, GRUPOS: { COBRO: COBRO, FINANCIERO: FINANCIERO, ECON_RELACIONADO: ECON_RELACIONADO, IDENTIDAD: IDENTIDAD, AGENDA: AGENDA, ESTADO: ESTADO, SELLO: SELLO, PENDIENTES: PENDIENTES }, VERSION: 'r2c-atencion-1' };
});
