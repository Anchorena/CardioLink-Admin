// CardioLink Admin — Portal Público V1 · Lógica pura del gateway
//
// Sin dependencias de Deno ni de Supabase: sólo validación, normalización y
// formato. Se importa desde index.ts (la Edge Function real, Deno) vía un
// import relativo ESM estándar. También se lee/analiza estáticamente desde
// tests/portal-gateway-logica.js, ya que este entorno no tiene Deno ni Node
// disponibles para ejecutarla de verdad.
//
// Esta es la validación AUTORITATIVA (server-side). portal.js hace una
// validación liviana aparte, sólo para UX; nunca reemplaza a esta.

export const LIMITES = Object.freeze({
  nombre: 80,
  apellido: 80,
  dniMinDigitos: 6,
  dniMaxDigitos: 9,
  telefono: 30,
  email: 200,
  cobertura: 120,
  numeroAfiliado: 60,
  prestacion: 160
});

export const FUENTES_VALIDAS = Object.freeze(['qr', 'whatsapp', 'web']);

// Mismos nombres, en el mismo orden, que portal/contenido-publico.js →
// coberturas. Si se agrega/saca una opción acá hay que actualizar las dos
// listas (un test cruza ambos archivos para detectar que se desincronicen).
export const COBERTURAS_VALIDAS = Object.freeze([
  'Particular', 'OSDE', 'Swiss Medical', 'Medicus', 'Galeno', 'IOMA', 'PAMI', 'Sancor', 'Otra', 'No sé / consultar'
]);

export function normalizarDni(valor) {
  return String(valor || '').replace(/\D/g, '');
}

export function fuenteValida(valor) {
  const v = String(valor || '').trim().toLowerCase();
  return FUENTES_VALIDAS.includes(v) ? v : 'web';
}

function texto(valor, limite) {
  return String(valor ?? '').trim().slice(0, limite);
}

export function validarDni(dniCrudo) {
  const dni = normalizarDni(dniCrudo);
  if (dni.length < LIMITES.dniMinDigitos || dni.length > LIMITES.dniMaxDigitos) {
    return { valido: false, error: 'DNI inválido.' };
  }
  return { valido: true, dni };
}

// Alta de paciente nuevo. Nunca acepta ni devuelve un id: el id se genera
// server-side (generarIdPaciente) recién después de confirmar que el DNI no
// existe todavía.
export function validarAlta(input) {
  const errores = [];

  const dniResultado = validarDni(input?.dni);
  if (!dniResultado.valido) errores.push(dniResultado.error);

  const nombre = texto(input?.nombre, LIMITES.nombre);
  if (!nombre) errores.push('Falta el nombre.');

  const apellido = texto(input?.apellido, LIMITES.apellido);
  if (!apellido) errores.push('Falta el apellido.');

  const fechaNacimiento = texto(input?.fechaNacimiento, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaNacimiento)) errores.push('Fecha de nacimiento inválida.');

  const telefono = texto(input?.telefono, LIMITES.telefono);
  if (!telefono) errores.push('Falta el teléfono.');

  const email = texto(input?.email, LIMITES.email);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errores.push('El email no es válido.');

  // Obra social/prepaga es un select cerrado, no texto libre: se valida
  // contra COBERTURAS_VALIDAS igual que se valida cualquier otro catálogo
  // cerrado (fuenteValida, prestación en index.ts).
  const coberturaHabitual = texto(input?.coberturaHabitual, LIMITES.cobertura);
  if (!COBERTURAS_VALIDAS.includes(coberturaHabitual)) errores.push('Elegí una cobertura válida.');

  const numeroAfiliado = texto(input?.numeroAfiliado, LIMITES.numeroAfiliado);

  if (errores.length) return { valido: false, errores };
  return {
    valido: true,
    datos: { dni: dniResultado.dni, nombre, apellido, fechaNacimiento, telefono, email, coberturaHabitual, numeroAfiliado }
  };
}

// nombre_completo compatible con el resto de CardioLink: "Apellido Nombre",
// igual al criterio ya usado en el admin (ver app.js, importación por lote:
// [apellido, nombre].filter(Boolean).join(' ')).
export function construirNombreCompleto(nombre, apellido) {
  return `${texto(apellido, LIMITES.apellido)} ${texto(nombre, LIMITES.nombre)}`.trim().replace(/\s+/g, ' ');
}

// Solicitud de turno. Pide DNI, prestación y la cobertura de ESTA
// solicitud puntual (select cerrado, misma lista COBERTURAS_VALIDAS que el
// alta; nunca sobrescribe cardiolink_pacientes.cobertura_habitual, sólo
// queda en la fila de la solicitud). El teléfono se pidió una única vez en
// el alta y se resuelve server-side desde cardiolink_pacientes (nunca se
// vuelve a pedir acá); no hay selección de profesional (queda null, se
// asigna después dentro de CardioLink Admin); no hay texto libre (message
// queda null). El paciente se resuelve server-side por DNI, siempre: nunca
// se acepta un patient_id del cliente.
export function validarSolicitud(input) {
  const errores = [];

  const dniResultado = validarDni(input?.dni);
  if (!dniResultado.valido) errores.push(dniResultado.error);

  const prestacion = texto(input?.prestacion, LIMITES.prestacion);
  if (!prestacion) errores.push('Falta la prestación.');

  const cobertura = texto(input?.cobertura, LIMITES.cobertura);
  if (!COBERTURAS_VALIDAS.includes(cobertura)) errores.push('Elegí una cobertura válida para esta solicitud.');

  const source = fuenteValida(input?.source);

  if (errores.length) return { valido: false, errores };
  return {
    valido: true,
    datos: { dni: dniResultado.dni, prestacion, cobertura, source }
  };
}

// Mismo prefijo que ya usa el admin para pacientes nuevos (ver app.js:
// 'pac_'+Date.now()+'_'+Math.random().toString(36).slice(2,8)), pero con una
// fuente aleatoria criptográfica: este endpoint es público, sin sesión, y no
// conviene que el id sea adivinable/enumerable como el Math.random() interno.
export function generarIdPaciente(randomUUID) {
  const fuente = typeof randomUUID === 'function' ? randomUUID : () => {
    throw new Error('Se requiere una fuente de aleatoriedad criptográfica (crypto.randomUUID).');
  };
  return 'pac_' + String(fuente()).replace(/-/g, '');
}
