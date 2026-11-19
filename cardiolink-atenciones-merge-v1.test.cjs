'use strict';
// Persistencia V1 / R2C · pruebas unitarias de la fusión de tres vías de UNA atención.
// Ejecutar: node --test cardiolink-atenciones-merge-v1.test.cjs
const test = require('node:test');
const assert = require('node:assert');
const A = require('./cardiolink-atenciones-merge-v1.js');

const clon = (o) => JSON.parse(JSON.stringify(o));
const fus = (b, l, r, ctx) => A.fusionarAtencion(b, l, r, Object.assign({ rol: 'secretaria', ahora: '2026-11-17T12:00:00Z' }, ctx || {}));
const base = () => ({
  id: 'a1', pacienteId: 'p1', paciente: 'Ana Pérez', dni: '100', profesionalId: 'matias', profesional: 'Dr. M', tipoRegistro: 'turno',
  fecha: '2026-11-20', horaInicio: '09:00', horaFin: '09:30', duracion: 30,
  estadoTurno: 'reservado', estado: 'reservado',
  prestacion: 'Consulta', cobertura: 'OSDE', observaciones: 'x',
  montoConsulta: 1000, montoEstudio: 0, montoCopago: 0, montoTotal: 1000, tipoCobro: 'os', formaPago: 'efectivo', noCobrar: false, cajaPerfil: 'matias',
  estadoCobro: 'pendiente', cobroPendienteEn: '2026-11-17T09:00:00Z', cobroPendientePor: 'Secre', bonoFirmado: false, copiaImpresa: false, estudioInformado: false,
  editadoPor: 'u1', editadoUsuario: 'Secre', editadoRol: 'secretaria', editadoEn: '2026-11-17T10:00:00Z',
  auditoriaPendientes: [{ tipo: 'firma', accion: 'resuelto', fecha: '2026-11-16T10:00:00Z', usuario: 'Secre' }]
});
const con = (o, c) => Object.assign(clon(o), c);
const confirmado = (o) => con(o, { estadoCobro: 'cobrado', cobroConfirmadoEn: '2026-11-17T11:00:00Z', cobroConfirmadoPor: 'Caja', cobroConfirmadoPorId: 'u9', cobroConfirmadoPorRol: 'admin', cobroConfirmadoPorEmail: 'c@x', cobroMedioPago: 'efectivo', cobroAuditoria: [{ accion: 'confirmar' }] });

test('sin cambios: idéntico, sin conflictos ni rechazos', () => {
  const b = base(); const m = fus(b, clon(b), clon(b));
  assert.equal(m.ok, true); assert.deepStrictEqual(m.payload, b); assert.equal(m.rechazos.length, 0);
});

test('campos independientes (observaciones vs prestación): se conservan ambos', () => {
  const b = base(); const m = fus(b, con(b, { observaciones: 'nota local' }), con(b, { cobertura: 'Swiss' }));
  assert.equal(m.ok, true); assert.equal(m.payload.observaciones, 'nota local'); assert.equal(m.payload.cobertura, 'Swiss');
  assert.ok(m.payload.auditoriaConcurrencia && m.payload.auditoriaConcurrencia.length === 1, 'deja traza de la fusión');
  assert.ok(!JSON.stringify(m.payload.auditoriaConcurrencia).includes('nota local'), 'la traza no copia valores');
});

test('mismo campo distinto: conflicto de campo; conservar mi valor / servidor', () => {
  const b = base(); const l = con(b, { observaciones: 'L' }), r = con(b, { observaciones: 'R' });
  const m = fus(b, l, r); assert.equal(m.ok, false); assert.equal(m.conflictos[0].atencionId, 'a1');
  const c = m.conflictos[0];
  assert.equal(fus(b, l, r, { resoluciones: { [c.clave]: 'local' } }).payload.observaciones, 'L');
  assert.equal(fus(b, l, r, { resoluciones: { [c.clave]: 'remoto' } }).payload.observaciones, 'R');
});

test('pendientes distintos de dos sesiones: ambos se conservan', () => {
  const b = base(); const m = fus(b, con(b, { bonoFirmado: true }), con(b, { copiaImpresa: true }));
  assert.equal(m.ok, true); assert.equal(m.payload.bonoFirmado, true); assert.equal(m.payload.copiaImpresa, true);
});

test('un pendiente resuelto por otra sesión NO se reabre desde una copia desactualizada', () => {
  const b = base(); const r = con(b, { bonoFirmado: true });
  // local reabre (false→false = sin cambio) o cambia otra cosa
  const m = fus(b, con(b, { observaciones: 'y' }), r); assert.equal(m.payload.bonoFirmado, true);
  // reapertura deliberada del local con el remoto sin cambios en ese pendiente: es una acción propia, se respeta
  const b2 = con(b, { bonoFirmado: true }); const l2 = con(b2, { bonoFirmado: false }); const r2 = con(b2, { observaciones: 'z' });
  assert.equal(fus(b2, l2, r2).payload.bonoFirmado, false);
  // pero si el remoto también lo cambió (p. ej. lo volvió a resolver con otro dato), gana el resuelto
  const b3 = base(); const l3 = con(b3, { bonoFirmado: true }); const r3 = con(b3, { bonoFirmado: false, noAplicaFirmaBono: true });
  assert.equal(fus(b3, l3, r3).payload.bonoFirmado, true);
});

test('mismo pendiente resuelto por ambos con medios distintos: unión, sin conflicto', () => {
  const b = Object.assign(base(), { estudioInformado: true });
  const m = fus(b, con(b, { estudioImpreso: true, disponibleRetiro: true }), con(b, { estudioEnviadoMail: true, estudioImpreso: true }));
  assert.equal(m.ok, true); assert.equal(m.payload.estudioImpreso, true); assert.equal(m.payload.estudioEnviadoMail, true); assert.equal(m.payload.disponibleRetiro, true);
});

test('auditoriaPendientes: se agregan entradas de ambos lados sin duplicar', () => {
  const b = base(); const e1 = { tipo: 'copia', accion: 'resuelto', fecha: 'F1', usuario: 'A' }, e2 = { tipo: 'firma', accion: 'resuelto', fecha: 'F2', usuario: 'B' };
  const l = con(b, { copiaImpresa: true, auditoriaPendientes: b.auditoriaPendientes.concat([e1]) });
  const r = con(b, { bonoFirmado: true, auditoriaPendientes: b.auditoriaPendientes.concat([e2]) });
  const m = fus(b, l, r); const a = m.payload.auditoriaPendientes;
  assert.equal(a.length, 3); assert.ok(a.some((x) => x.fecha === 'F1') && a.some((x) => x.fecha === 'F2'));
  const m2 = fus(b, l, l); assert.equal(m2.payload.auditoriaPendientes.length, 2);
});

test('sellos de edición no generan conflicto y se toma la unidad completa del más reciente', () => {
  const b = base();
  const l = con(b, { observaciones: 'L', editadoPor: 'u2', editadoUsuario: 'Otro', editadoRol: 'admin', editadoEn: '2026-11-17T10:05:00Z' });
  const r = con(b, { cobertura: 'Swiss', editadoPor: 'u3', editadoUsuario: 'Tercero', editadoRol: 'medico', editadoEn: '2026-11-17T10:09:00Z' });
  const m = fus(b, l, r); assert.equal(m.ok, true);
  assert.equal(m.payload.editadoEn, r.editadoEn); assert.equal(m.payload.editadoUsuario, 'Tercero'); assert.equal(m.payload.editadoPor, 'u3'); assert.equal(m.payload.editadoRol, 'medico');
  const m2 = fus(b, r, l); assert.equal(m2.payload.editadoUsuario, 'Tercero');
});

test('sólo cambia el sello local (nada más): se toma el local, sin falso conflicto', () => {
  const b = base(); const l = con(b, { editadoEn: '2026-11-17T10:30:00Z' });
  const m = fus(b, l, clon(b)); assert.equal(m.ok, true); assert.equal(m.payload.editadoEn, l.editadoEn);
  assert.equal(m.payload.auditoriaConcurrencia, undefined);
});

// ---- estados ----
test('estados incompatibles: conflicto explícito; no se resuelve por fecha', () => {
  const b = base();
  const l = con(b, { estadoTurno: 'atendido', estado: 'atendido', estadoTurnoEditadoEn: '2026-11-17T12:30:00Z' });
  const r = con(b, { estadoTurno: 'ausente', estado: 'ausente', estadoTurnoEditadoEn: '2026-11-17T09:00:00Z' });
  const m = fus(b, l, r); assert.equal(m.ok, false); assert.equal(m.conflictos[0].tipo, 'estado');
  assert.equal(fus(b, l, r, { resoluciones: { 'grupo:estado': 'remoto' } }).payload.estadoTurno, 'ausente');
  assert.equal(fus(b, l, r, { resoluciones: { 'grupo:estado': 'local' } }).payload.estadoTurno, 'atendido');
});

test('cambio de estado de un solo lado: se toma ese lado completo', () => {
  const b = base(); const r = con(b, { estadoTurno: 'confirmado', estado: 'confirmado' });
  assert.equal(fus(b, clon(b), r).payload.estadoTurno, 'confirmado');
  assert.equal(fus(b, r, clon(b)).payload.estadoTurno, 'confirmado');
});

test('cancelación del paciente confirmada en el servidor NO se revierte (ni con «mi valor»)', () => {
  const b = base();
  const r = con(b, { estadoTurno: 'cancelado', estado: 'cancelado', canceladoPor: 'paciente', canceladoEn: '2026-11-17T11:00:00Z' });
  const l = con(b, { estadoTurno: 'confirmado', estado: 'confirmado' });
  const m = fus(b, l, r, { resoluciones: { 'grupo:estado': 'local' } });
  assert.equal(m.ok, true); assert.equal(m.payload.estadoTurno, 'cancelado'); assert.equal(m.payload.canceladoPor, 'paciente');
  assert.equal(m.rechazos.length, 1); assert.equal(m.rechazos[0].grupo, 'estado');
  assert.equal(m.rechazos[0].valoresLocales.estadoTurno, 'confirmado', 'el valor rechazado se conserva para recuperación');
  // si además el local cambió otro campo, ese sí se conserva
  const m2 = fus(b, con(l, { observaciones: 'otra' }), r); assert.equal(m2.payload.observaciones, 'otra'); assert.equal(m2.payload.estadoTurno, 'cancelado');
});

test('con cobro confirmado el Médico no puede cancelar/ausentar (guard); Secretaría/Admin lo decide el servidor', () => {
  const b = confirmado(base()); const l = con(b, { estadoTurno: 'cancelado', estado: 'cancelado', canceladoPor: 'secretaria' });
  const m = fus(b, l, clon(b), { rol: 'medico' }); assert.equal(m.payload.estadoTurno, 'reservado'); assert.equal(m.rechazos[0].grupo, 'estado');
  const m2 = fus(b, l, clon(b), { rol: 'admin' }); assert.equal(m2.payload.estadoTurno, 'cancelado'); assert.equal(m2.rechazos.length, 0);
  const m3 = fus(b, l, clon(b), { rol: 'secretaria' }); assert.equal(m3.payload.estadoTurno, 'cancelado', 'se intenta; si el guard lo rechaza queda retenida e informada');
});

// ---- integridad financiera ----
test('cobro confirmado en el remoto: importes congelados; cambio local rechazado e informado; otros cambios se conservan', () => {
  const b = base(); const r = confirmado(b);
  const l = con(b, { montoConsulta: 5000, montoTotal: 5000, formaPago: 'tarjeta', observaciones: 'adm' });
  const m = fus(b, l, r); assert.equal(m.ok, true);
  assert.equal(m.payload.montoConsulta, 1000); assert.equal(m.payload.montoTotal, 1000); assert.equal(m.payload.formaPago, 'efectivo');
  assert.equal(m.payload.estadoCobro, 'cobrado'); assert.equal(m.payload.cobroConfirmadoPorRol, 'admin'); assert.deepStrictEqual(m.payload.cobroAuditoria, r.cobroAuditoria);
  assert.equal(m.payload.observaciones, 'adm');
  assert.equal(m.rechazos.length, 1); assert.equal(m.rechazos[0].grupo, 'financiero');
  assert.ok(m.rechazos[0].campos.includes('montoConsulta') && m.rechazos[0].valoresLocales.montoConsulta === 5000);
  // «conservar mi valor» no puede saltar el guard (no hay conflicto resoluble)
  const m2 = fus(b, l, r, { resoluciones: { 'grupo:financiero': 'local' } }); assert.equal(m2.payload.montoConsulta, 1000);
});

test('la fusión genérica jamás confirma un cobro ni altera su auditoría', () => {
  const b = base(); const l = confirmado(b); const m = fus(b, l, clon(b));
  assert.equal(m.payload.cobroConfirmadoPorRol, undefined); assert.equal(m.payload.cobroMedioPago, undefined); assert.equal(m.payload.cobroConfirmadoPor, undefined);
  assert.ok(m.rechazos.some((x) => x.grupo === 'cobro'));
});

test('cobro pendiente: corrección económica de un solo lado se acepta como grupo indivisible', () => {
  const b = base(); const l = con(b, { montoConsulta: 2000, montoTotal: 2000, tipoCobro: 'particular' });
  const m = fus(b, l, clon(b)); assert.equal(m.ok, true); assert.equal(m.payload.montoConsulta, 2000); assert.equal(m.payload.montoTotal, 2000); assert.equal(m.payload.tipoCobro, 'particular');
  const m2 = fus(b, clon(b), l); assert.equal(m2.payload.montoTotal, 2000);
});

test('cobro pendiente: ambos cambian el dinero distinto = conflicto único, nunca se combinan valores', () => {
  const b = base(); const l = con(b, { montoConsulta: 2000, montoTotal: 2000 }); const r = con(b, { montoCopago: 300, montoTotal: 1300 });
  const m = fus(b, l, r); assert.equal(m.ok, false); assert.equal(m.conflictos.length, 1); assert.equal(m.conflictos[0].grupo, 'Datos económicos');
  const ml = fus(b, l, r, { resoluciones: { 'grupo:financiero': 'local' } }); assert.equal(ml.payload.montoCopago, 0); assert.equal(ml.payload.montoTotal, 2000);
  const mr = fus(b, l, r, { resoluciones: { 'grupo:financiero': 'remoto' } }); assert.equal(mr.payload.montoConsulta, 1000); assert.equal(mr.payload.montoTotal, 1300);
});

test('el cobro confirmado por otra sesión congela el dinero también si el local tocó importes', () => {
  const b = base(); const l = con(b, { montoTotal: 7000, montoConsulta: 7000 }); const r = confirmado(b);
  const m = fus(b, l, r); assert.equal(m.payload.montoTotal, 1000); assert.equal(m.payload.estadoCobro, 'cobrado'); assert.equal(m.rechazos[0].grupo, 'financiero');
});

// ---- identidad / agenda ----
test('cambio de identidad/pertenencia (paciente, profesional) es conflicto y médico no puede imponer el suyo', () => {
  const b = base(); const l = con(b, { profesionalId: 'otro', profesional: 'Dr. O' });
  const m = fus(b, l, clon(b), { rol: 'secretaria' }); assert.equal(m.ok, false); assert.equal(m.conflictos[0].tipo, 'identidad');
  assert.equal(fus(b, l, clon(b), { rol: 'secretaria', resoluciones: { 'grupo:identidad': 'local' } }).payload.profesionalId, 'otro');
  const mm = fus(b, l, clon(b), { rol: 'medico', resoluciones: { 'grupo:identidad': 'local' } }); assert.equal(mm.ok, false, 'médico: sólo «servidor»');
  assert.equal(fus(b, l, clon(b), { rol: 'medico' }).conflictos[0].opciones.local, false);
});

test('identidad cambiada por el servidor y local sin tocar: se toma la del servidor', () => {
  const b = base(); const r = con(b, { pacienteId: 'p2', paciente: 'Juan', dni: '200' });
  const m = fus(b, clon(b), r); assert.equal(m.ok, true); assert.equal(m.payload.pacienteId, 'p2');
});

test('agenda: un solo lado → ese lado completo; dos lados distintos → conflicto', () => {
  const b = base(); const l = con(b, { fecha: '2026-11-21', horaInicio: '10:00', horaFin: '10:30' });
  assert.equal(fus(b, l, clon(b)).payload.horaInicio, '10:00');
  const r = con(b, { fecha: '2026-11-22', horaInicio: '11:00', horaFin: '11:30' });
  const m = fus(b, l, r); assert.equal(m.ok, false); assert.equal(m.conflictos[0].tipo, 'agenda');
  const mr = fus(b, l, r, { resoluciones: { 'grupo:agenda': 'remoto' } }); assert.equal(mr.payload.fecha, '2026-11-22'); assert.equal(mr.payload.horaFin, '11:30');
});

// ---- no mutación / orden ----
test('no modifica sus argumentos', () => {
  const b = base(), l = con(b, { observaciones: 'L', bonoFirmado: true }), r = con(b, { cobertura: 'S' });
  const sb = JSON.stringify(b), sl = JSON.stringify(l), sr = JSON.stringify(r);
  fus(b, l, r); assert.equal(JSON.stringify(b), sb); assert.equal(JSON.stringify(l), sl); assert.equal(JSON.stringify(r), sr);
});

test('campo nuevo sólo local / sólo remoto se conserva; valores falsy legítimos no se pierden', () => {
  const b = base(); const m = fus(b, con(b, { nuevoLocal: 0 }), con(b, { nuevoRemoto: '' }));
  assert.equal(m.payload.nuevoLocal, 0); assert.equal(m.payload.nuevoRemoto, '');
});

test('cobro pendiente: el cambio de estado/económico del local viaja junto (grupo indivisible) y no confirma nada', () => {
  const b = base(); const l = con(b, { estadoCobro: 'sin_cobro', montoConsulta: 0, montoTotal: 0 });
  const m = fus(b, l, con(b, { observaciones: 'otro' })); assert.equal(m.ok, true);
  assert.equal(m.payload.estadoCobro, 'sin_cobro'); assert.equal(m.payload.montoTotal, 0); assert.equal(m.payload.observaciones, 'otro'); assert.equal(m.payload.cobroConfirmadoPorRol, undefined);
});

test('guard v4.2.1: el cobro confirmado congela también la auditoría del cobro (se conserva la remota)', () => {
  const b = base(); const r = confirmado(b); const l = con(b, { cobroAuditoria: [{ accion: 'otra' }] });
  const m = fus(b, l, r); assert.deepStrictEqual(m.payload.cobroAuditoria, r.cobroAuditoria);
});

test('cobro confirmado: cobertura/arancel relacionados son un grupo indivisible aparte (no congelado, no mezclado)', () => {
  const b = Object.assign(base(), { obraSocial: 'OSDE', arancelId: 'ar1', valorArancelEstimado: 1000 }); const r = confirmado(b);
  const l = con(b, { obraSocial: 'Swiss', arancelId: 'ar2', valorArancelEstimado: 2000 });
  const m = fus(b, l, r); assert.equal(m.ok, true); assert.equal(m.payload.obraSocial, 'Swiss'); assert.equal(m.payload.arancelId, 'ar2'); assert.equal(m.payload.montoConsulta, 1000);
  const r2 = confirmado(con(b, { obraSocial: 'PAMI', arancelId: 'ar3' })); const m2 = fus(b, l, r2);
  assert.equal(m2.ok, false); assert.equal(m2.conflictos[0].grupo, 'Cobertura y arancel');
});

test('un paso local a «cobrado» (sin pasar por Cobros) se rechaza aunque no traiga marcas de confirmación; el resto del grupo económico sí viaja', () => {
  const b = base(); const l = con(b, { estadoCobro: 'cobrado', montoConsulta: 2000, montoTotal: 2000 });
  const m = fus(b, l, con(b, { observaciones: 'otro' })); assert.equal(m.ok, true);
  assert.equal(m.payload.estadoCobro, 'pendiente'); assert.equal(m.payload.montoConsulta, 2000); assert.ok(m.rechazos.some((r) => r.grupo === 'cobro'));
});
