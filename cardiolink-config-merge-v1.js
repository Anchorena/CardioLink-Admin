/* CardioLink · Persistencia V1 / R2B · Motor de fusión de tres vías de la configuración.
   Módulo INDEPENDIENTE y puro: no toca el DOM, Supabase, localStorage ni ningún global de la app. Todavía no está integrado a app.js ni a Secretaría
   (esa integración es el segundo bloque de R2B y requiere autorización aparte). Se carga en Node (module.exports) y en el navegador (window.cardiolinkConfigMergeV1).

   fusionar(base, local, remoto, opciones) → { ok, config, conflictos[], resumen }
     base   : la configuración tal como se cargó / confirmó por última vez del servidor.
     local  : el estado local modificado.
     remoto : el estado actual del servidor.
   Nunca modifica sus argumentos ni comparte referencias con ellos (clona antes de fusionar).

   REGLAS
    1. Cambios independientes se fusionan por ENTIDAD y por CAMPO (no por arreglo completo).
    2. Dos altas con el mismo id y contenido distinto → conflicto de IDENTIDAD (no se fusionan campo a campo).
    3. Convenios: la identidad es la clave `obraSocial` EXACTA; nunca por similitud. Claves repetidas, vacías o que sólo difieren por mayúsculas, tildes o
       espacios (ambiguas) → conflicto que bloquea esa lista; no se adivina.
    4. Eliminación frente a modificación → conflicto explícito. Una entidad eliminada y no tocada por el otro lado NO se resucita.
    5. Listas sin regla registrada (esquema) → se tratan como BLOQUE: si ambos lados las cambiaron distinto es un conflicto; no se inventa una regla.
    6. Listas de auditoría: sólo se agregan entradas (nunca se pierde ni se duplica una entrada idéntica entre las dos vías).
    7. Se distinguen ausente / null / 0 / false / '' (nada de equivalencias).
    8. El motor NO normaliza. Para que una normalización de carga (p. ej. normalizarConfigCritica) no se tome como cambio del usuario, el integrador pasa
       `opciones.neutro` = la normalización aplicada a la BASE: lo que en `local` coincida con ese neutro (y difiera de la base) se considera «sin cambio».
    Con conflictos, `config` conserva el valor LOCAL en cada punto conflictivo (nada se descarta) y `ok` es false. Se resuelven pasando
    `opciones.resoluciones = { [ruta]: 'local' | 'remoto' }`: sólo cambian esos puntos y se preservan todos los cambios independientes. */
(function (raiz, fabrica) {
  'use strict';
  var api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.cardiolinkConfigMergeV1 = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var AUSENTE = { ausente: true };   // «la clave no existe» (distinto de null, 0, false y '')

  // ---------- esquema por defecto (estructura REAL de la config; ver app.js y docs). Todo lo no registrado es BLOQUE. ----------
  // regla: {tipo:'indexada', campo:'id'|'obraSocial', similitud?} | {tipo:'conjunto'} | {tipo:'auditoria'} | {tipo:'entidades'} (mapa cuyos valores son entidades)
  var ESQUEMA_CONFIG_V1 = [
    ['pacientes', { tipo: 'indexada', campo: 'id' }],
    ['profesionales', { tipo: 'indexada', campo: 'id' }],
    ['usuarios', { tipo: 'indexada', campo: 'id' }],
    ['roles', { tipo: 'indexada', campo: 'id' }],
    ['especialidades', { tipo: 'indexada', campo: 'id' }],
    ['destinosFacturacion', { tipo: 'indexada', campo: 'id' }],
    ['plantillasPedidos', { tipo: 'indexada', campo: 'id' }],
    ['documentosClinicos', { tipo: 'indexada', campo: 'id' }],
    ['evolucionesClinicas', { tipo: 'indexada', campo: 'id' }],
    ['movimientosFinancieros411C', { tipo: 'indexada', campo: 'id' }],
    ['importacionesMedicloudEvoluciones', { tipo: 'indexada', campo: 'id' }],
    ['arancelesConvenios', { tipo: 'indexada', campo: 'id' }],
    ['arancelesPorProfesional.*', { tipo: 'indexada', campo: 'id' }],
    ['conveniosFacturacion', { tipo: 'indexada', campo: 'obraSocial', similitud: true }],
    ['conveniosPorProfesional.*', { tipo: 'indexada', campo: 'obraSocial', similitud: true }],
    ['obrasSociales', { tipo: 'conjunto' }],
    ['motivosConsulta', { tipo: 'conjunto' }],
    ['colocadores', { tipo: 'conjunto' }],
    ['catalogoPrestaciones411P', { tipo: 'conjunto' }],
    ['bloquesPrestaciones.*', { tipo: 'conjunto' }],
    ['profesionales.*.prestaciones', { tipo: 'conjunto' }],
    ['profesionales.*.especialidadIds', { tipo: 'conjunto' }],
    ['profesionales.*.bloquesPrestaciones', { tipo: 'conjunto' }],
    ['usuarios.*.especialidadIds', { tipo: 'conjunto' }],
    ['usuarios.*.aliases', { tipo: 'conjunto' }],
    ['configFinanzas411F.sueldosSecretaria', { tipo: 'indexada', campo: 'id' }],
    ['pacientes.*.historialCoberturas', { tipo: 'auditoria' }],   // historial de coberturas: sólo se agrega, nunca se pierde
    ['auditoriaPacientes', { tipo: 'auditoria' }],
    ['resumenesClinicos', { tipo: 'entidades' }],
    ['horariosProfesionales', { tipo: 'entidades' }]
  ].map(function (par) { return { patron: par[0].split('.'), regla: par[1] }; });

  function reglaDe(esquema, tokens) {
    for (var i = 0; i < esquema.length; i++) {
      var p = esquema[i].patron;
      if (p.length !== tokens.length) continue;
      var ok = true;
      for (var j = 0; j < p.length; j++) { if (p[j] !== '*' && p[j] !== patronTok(tokens[j])) { ok = false; break; } }
      if (ok) return esquema[i].regla;
    }
    return null;
  }

  // ---------- utilidades ----------
  function esObjeto(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function esPrimitivo(v) { return v === null || (typeof v !== 'object' && typeof v !== 'function' && v !== undefined); }

  function iguales(a, b) {
    if (a === AUSENTE || b === AUSENTE) return a === b;
    if (a === b) return true;
    if (typeof a === 'number' && typeof b === 'number') return a !== a && b !== b;       // NaN
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    var aa = Array.isArray(a), ab = Array.isArray(b);
    if (aa !== ab) return false;
    if (aa) {
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) if (!iguales(a[i], b[i])) return false;
      return true;
    }
    var ka = Object.keys(a).filter(function (k) { return a[k] !== undefined; });
    var kb = Object.keys(b).filter(function (k) { return b[k] !== undefined; });
    if (ka.length !== kb.length) return false;
    for (var j = 0; j < ka.length; j++) {
      var k = ka[j];
      if (!Object.prototype.hasOwnProperty.call(b, k) || b[k] === undefined || !iguales(a[k], b[k])) return false;
    }
    return true;
  }

  function clonar(v) {
    if (v === AUSENTE || v === undefined) return v;
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(function (x) { return x === undefined ? null : clonar(x); });
    var o = {};
    Object.keys(v).forEach(function (k) { if (v[k] !== undefined) o[k] = clonar(v[k]); });
    return o;
  }

  function claveCanonica(v) {
    if (v === null || typeof v !== 'object') return typeof v + ':' + String(v);
    if (Array.isArray(v)) return '[' + v.map(claveCanonica).join(',') + ']';
    return '{' + Object.keys(v).filter(function (k) { return v[k] !== undefined; }).sort().map(function (k) { return JSON.stringify(k) + ':' + claveCanonica(v[k]); }).join(',') + '}';
  }

  // La ruta es inequívoca: los caracteres especiales de una clave (\ . [ ]) se escapan con «\», de modo que dos entidades o campos distintos nunca producen la misma ruta.
  function esc(s) { return String(s).replace(/([\\.\[\]])/g, '\\$1'); }
  function rutaATexto(tokens) {
    return tokens.map(function (t, i) { var e = t && t.elemento ? '[' + esc(t.clave) + ']' : esc(t); return i === 0 || (t && t.elemento) ? e : '.' + e; }).join('');
  }
  function tokenElemento(clave) { return { elemento: true, clave: String(clave) }; }
  function patronTok(t) { return t && t.elemento ? t.clave : t; }

  function sinAcentos(s) { try { return s.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (e) { return s; } }
  function similar(s) { return sinAcentos(String(s)).toLowerCase().replace(/\s+/g, ' ').trim(); }

  // ---------- contexto ----------
  function Contexto(opciones) {
    this.esquema = (opciones && opciones.esquema) || ESQUEMA_CONFIG_V1;
    this.resoluciones = (opciones && opciones.resoluciones) || {};
    this.conflictos = [];
    this.cambiosLocales = 0;
    this.cambiosRemotos = 0;
  }
  // Un punto conflictivo: si hay resolución explícita se aplica; si no, se registra y se conserva el valor LOCAL.
  Contexto.prototype.conflicto = function (tipo, tokens, base, local, remoto, extra) {
    var ruta = rutaATexto(tokens), dec = this.resoluciones[ruta];
    if (dec === 'local') return { valor: local };
    if (dec === 'remoto') return { valor: remoto };
    var c = { tipo: tipo, ruta: ruta, tokens: tokens.map(patronTok), base: base === AUSENTE ? undefined : clonar(base), local: local === AUSENTE ? undefined : clonar(local), remoto: remoto === AUSENTE ? undefined : clonar(remoto), baseAusente: base === AUSENTE, localAusente: local === AUSENTE, remotoAusente: remoto === AUSENTE };
    if (extra) Object.keys(extra).forEach(function (k) { c[k] = extra[k]; });
    this.conflictos.push(c);
    return { valor: local };
  };

  // ---------- fusión recursiva ----------
  function fusionarValor(ctx, b, l, r, tokens, esEntidad) {
    if (iguales(l, r)) return l;                                   // mismo resultado (incluye ambos ausentes)
    if (iguales(b, l)) { ctx.cambiosRemotos++; return r; }         // sólo cambió el remoto
    if (iguales(b, r)) { ctx.cambiosLocales++; return l; }         // sólo cambió el local
    // ambos cambiaron, de forma distinta
    if (b === AUSENTE) {                                           // alta simultánea con el mismo identificador
      if (esEntidad) return ctx.conflicto('identidad', tokens, b, l, r).valor;
      if (esObjeto(l) && esObjeto(r)) return fusionarObjetos(ctx, {}, l, r, tokens);
      if (Array.isArray(l) && Array.isArray(r)) return fusionarArreglo(ctx, [], l, r, tokens);
      return ctx.conflicto('campo', tokens, b, l, r).valor;
    }
    if (l === AUSENTE || r === AUSENTE) return ctx.conflicto('eliminacion_vs_modificacion', tokens, b, l, r).valor;
    if (esObjeto(b) && esObjeto(l) && esObjeto(r)) return fusionarObjetos(ctx, b, l, r, tokens);
    if (Array.isArray(b) && Array.isArray(l) && Array.isArray(r)) return fusionarArreglo(ctx, b, l, r, tokens);
    return ctx.conflicto('campo', tokens, b, l, r).valor;
  }

  function fusionarObjetos(ctx, b, l, r, tokens) {
    var regla = reglaDe(ctx.esquema, tokens);
    var entidadesHijas = !!(regla && regla.tipo === 'entidades');
    var claves = [], vistas = {};
    [r, l, b].forEach(function (o) { Object.keys(o).forEach(function (k) { if (o[k] !== undefined && !vistas[k]) { vistas[k] = true; claves.push(k); } }); });
    var salida = {};
    claves.forEach(function (k) {
      var vb = (k in b && b[k] !== undefined) ? b[k] : AUSENTE, vl = (k in l && l[k] !== undefined) ? l[k] : AUSENTE, vr = (k in r && r[k] !== undefined) ? r[k] : AUSENTE;
      var v = fusionarValor(ctx, vb, vl, vr, tokens.concat([k]), entidadesHijas);
      if (v !== AUSENTE) salida[k] = v;
    });
    return salida;
  }

  function fusionarArreglo(ctx, b, l, r, tokens) {
    var regla = reglaDe(ctx.esquema, tokens);
    if (!regla) return ctx.conflicto('bloque', tokens, b, l, r).valor;          // lista desconocida: bloque
    if (regla.tipo === 'indexada') return fusionarIndexada(ctx, b, l, r, tokens, regla);
    if (regla.tipo === 'conjunto') return fusionarConjunto(ctx, b, l, r, tokens);
    if (regla.tipo === 'auditoria') return fusionarAuditoria(ctx, b, l, r);
    return ctx.conflicto('bloque', tokens, b, l, r).valor;
  }

  // Lista de entidades con identidad inequívoca. Devuelve {mapa, orden, problemas}.
  function indexar(lista, regla) {
    var mapa = {}, orden = [], problemas = [], normalizadas = {};
    lista.forEach(function (e) {
      if (!esObjeto(e)) { problemas.push({ tipo: 'clave_ambigua', motivo: 'elemento sin identidad (no es un objeto)' }); return; }
      var v = e[regla.campo];
      var valida = (typeof v === 'string' && v.trim() !== '') || (typeof v === 'number' && isFinite(v));
      if (!valida) { problemas.push({ tipo: 'clave_ambigua', motivo: 'elemento sin «' + regla.campo + '» utilizable', valor: v === undefined ? undefined : v }); return; }
      var k = String(v);
      if (Object.prototype.hasOwnProperty.call(mapa, k)) { problemas.push({ tipo: 'clave_duplicada', clave: k }); return; }
      if (regla.similitud) {
        var n = similar(k);
        if (Object.prototype.hasOwnProperty.call(normalizadas, n) && normalizadas[n] !== k) problemas.push({ tipo: 'clave_ambigua', motivo: '«' + k + '» y «' + normalizadas[n] + '» sólo difieren por mayúsculas, tildes o espacios', clave: k });
        else normalizadas[n] = k;
      }
      mapa[k] = e; orden.push(k);
    });
    return { mapa: mapa, orden: orden, problemas: problemas };
  }

  // Orden del resultado: respeta el del servidor; si SÓLO el local reordenó (y el servidor no), respeta el local. Los elementos que no están en el esqueleto
  // (altas del otro lado) se insertan justo después de su predecesor en su lista de origen (o al principio si eran los primeros).
  function ordenFinal(ob, ol, or_, presentes) {
    var en = function (lista) { var s = {}; lista.forEach(function (k) { s[k] = true; }); return s; };
    var sb = en(ob), sl = en(ol), sr = en(or_);
    var comunes = ob.filter(function (k) { return sl[k] && sr[k]; });
    var cs = en(comunes);
    var sub = function (o) { return o.filter(function (k) { return cs[k]; }); };
    var igual = function (x, y) { return x.length === y.length && x.every(function (k, i) { return k === y[i]; }); };
    var localReordenado = !igual(sub(ol), comunes), remotoReordenado = !igual(sub(or_), comunes);
    var usaLocal = localReordenado && !remotoReordenado;
    var esqueleto = usaLocal ? ol : or_, otras = usaLocal ? [or_, ob] : [ol, ob];
    var res = esqueleto.filter(function (k) { return presentes[k]; });
    var puestos = en(res);
    otras.forEach(function (lista) {
      lista.forEach(function (k, i) {
        if (!presentes[k] || puestos[k]) return;
        var pos = res.length;                                   // si era el último de su lista, queda al final
        if (i < lista.length - 1) {
          pos = 0;                                              // si era el primero, queda al principio; si no, tras su predecesor
          for (var j = i - 1; j >= 0; j--) { var idx = res.indexOf(lista[j]); if (idx >= 0) { pos = idx + 1; break; } }
        }
        res.splice(pos, 0, k); puestos[k] = true;
      });
    });
    return res;
  }

  function fusionarIndexada(ctx, b, l, r, tokens, regla) {
    var ib = indexar(b, regla), il = indexar(l, regla), ir = indexar(r, regla);
    var problemas = [];
    [['base', ib], ['local', il], ['remoto', ir]].forEach(function (par) { par[1].problemas.forEach(function (p) { problemas.push(Object.assign({ lado: par[0] }, p)); }); });
    if (problemas.length) {
      var tipo = problemas.some(function (p) { return p.tipo === 'clave_duplicada'; }) ? 'clave_duplicada' : 'clave_ambigua';
      return ctx.conflicto(tipo, tokens, b, l, r, { problemas: problemas }).valor;
    }
    var valores = {}, presentes = {}, usadas = {};
    function agregar(k) {
      if (usadas[k]) return; usadas[k] = true;
      var vb = ib.mapa[k] !== undefined ? ib.mapa[k] : AUSENTE, vl = il.mapa[k] !== undefined ? il.mapa[k] : AUSENTE, vr = ir.mapa[k] !== undefined ? ir.mapa[k] : AUSENTE;
      var v = fusionarValor(ctx, vb, vl, vr, tokens.concat([tokenElemento(k)]), true);
      if (v !== AUSENTE) { valores[k] = v; presentes[k] = true; }
    }
    ir.orden.forEach(agregar); il.orden.forEach(agregar); ib.orden.forEach(agregar);   // la base sólo decide eliminaciones
    return ordenFinal(ib.orden, il.orden, ir.orden, presentes).map(function (k) { return valores[k]; });
  }

  function fusionarConjunto(ctx, b, l, r, tokens) {
    var todos = b.concat(l, r);
    if (!todos.every(esPrimitivo)) return ctx.conflicto('bloque', tokens, b, l, r, { motivo: 'la lista contiene elementos no primitivos' }).valor;
    var k = function (x) { return typeof x + ':' + String(x); };
    var cb = {}, cl = {}, cr = {};
    b.forEach(function (x) { cb[k(x)] = true; }); l.forEach(function (x) { cl[k(x)] = true; }); r.forEach(function (x) { cr[k(x)] = true; });
    var valores = {}, presentes = {};
    r.forEach(function (x) { var c = k(x); if (cb[c] && !cl[c]) { ctx.cambiosLocales++; return; } valores[c] = x; presentes[c] = true; });   // quitado localmente
    l.forEach(function (x) { var c = k(x); if (!cb[c] && !presentes[c]) { ctx.cambiosLocales++; valores[c] = x; presentes[c] = true; } });    // alta local
    var oc = function (lista) { var seen = {}; return lista.map(k).filter(function (c) { if (seen[c]) return false; seen[c] = true; return true; }); };
    return ordenFinal(oc(b), oc(l), oc(r), presentes).map(function (c) { return valores[c]; });
  }

  function fusionarAuditoria(ctx, b, l, r) {
    var cuenta = function (lista) { var m = {}; lista.forEach(function (e) { var c = claveCanonica(e); m[c] = (m[c] || 0) + 1; }); return m; };
    var cb = cuenta(b), cl = cuenta(l), cr = cuenta(r), salida = [], puestos = {};
    function max(c) { return Math.max(cb[c] || 0, cl[c] || 0, cr[c] || 0); }
    function volcar(lista) { lista.forEach(function (e) { var c = claveCanonica(e); if ((puestos[c] || 0) < max(c)) { puestos[c] = (puestos[c] || 0) + 1; salida.push(clonar(e)); } }); }
    volcar(b.filter(function (e) { var c = claveCanonica(e); return !cl[c] && !cr[c]; }));   // entradas que ningún lado conserva: se preservan igual
    volcar(r); volcar(l);
    return salida;
  }

  // ---------- neutralización de la normalización de carga ----------
  // Deja en `local` el valor de la BASE donde local sólo difiere de ella porque coincide con el NEUTRO (= normalizar(base)).
  function purgarNeutro(esquema, b, l, n, tokens, protegidos) {
    if (n === AUSENTE || l === AUSENTE || iguales(l, b)) return l;
    var hayProtegidoDentro = false;
    if (protegidos && protegidos.length) {     // rutas editadas explícitamente por el usuario: nunca se neutralizan aunque coincidan con la normalización
      var ruta = rutaATexto(tokens);
      for (var q = 0; q < protegidos.length; q++) {
        var pr = protegidos[q];
        if (ruta === pr || ruta.indexOf(pr + '.') === 0 || ruta.indexOf(pr + '[') === 0) return l;
        if (ruta === '' || pr.indexOf(ruta + '.') === 0 || pr.indexOf(ruta + '[') === 0) hayProtegidoDentro = true;
      }
    }
    if (!hayProtegidoDentro && iguales(l, n)) return b === AUSENTE ? AUSENTE : clonar(b);
    if (esObjeto(l) && esObjeto(n) && esObjeto(b === AUSENTE ? {} : b)) {
      var bo = b === AUSENTE ? {} : b, salida = {};
      Object.keys(l).forEach(function (k) {
        if (l[k] === undefined) return;
        var v = purgarNeutro(esquema, k in bo && bo[k] !== undefined ? bo[k] : AUSENTE, l[k], k in n && n[k] !== undefined ? n[k] : AUSENTE, tokens.concat([k]), protegidos);
        if (v !== AUSENTE) salida[k] = v;
      });
      return salida;
    }
    if (Array.isArray(l) && Array.isArray(n) && Array.isArray(b)) {
      var regla = reglaDe(esquema, tokens);
      if (regla && regla.tipo === 'conjunto') {
        var k = function (x) { return typeof x + ':' + String(x); }, cb = {}, cn = {};
        b.forEach(function (x) { cb[k(x)] = true; }); n.forEach(function (x) { cn[k(x)] = true; });
        return l.filter(function (x) { return !(cn[k(x)] && !cb[k(x)]); });          // agregados por la normalización: no son del usuario
      }
      if (regla && regla.tipo === 'indexada') {
        var ib = indexar(b, regla), inn = indexar(n, regla);
        if (ib.problemas.length || inn.problemas.length) return l;
        var out = [];
        l.forEach(function (e) {
          if (!esObjeto(e)) { out.push(e); return; }
          var kk = e[regla.campo], ks = (typeof kk === 'string' || typeof kk === 'number') ? String(kk) : null;
          if (ks === null) { out.push(e); return; }
          var eb = ib.mapa[ks], en = inn.mapa[ks];
          if (eb === undefined && en !== undefined && iguales(e, en)) return;           // elemento agregado por la normalización
          var v = purgarNeutro(esquema, eb === undefined ? AUSENTE : eb, e, en === undefined ? AUSENTE : en, tokens.concat([tokenElemento(ks)]), protegidos);
          if (v !== AUSENTE) out.push(v);
        });
        return out;
      }
    }
    return l;
  }

  // ---------- API ----------
  function fusionar(base, local, remoto, opciones) {
    var ctx = new Contexto(opciones);
    var b = clonar(base), l = clonar(local), r = clonar(remoto);
    if (opciones && opciones.neutro !== undefined) l = purgarNeutro(ctx.esquema, b, l, clonar(opciones.neutro), [], opciones.protegidos);
    var config = fusionarValor(ctx, b, l, r, [], false);
    return {
      ok: ctx.conflictos.length === 0,
      config: config === AUSENTE ? undefined : clonar(config),
      conflictos: ctx.conflictos,
      resumen: { cambiosLocales: ctx.cambiosLocales, cambiosRemotos: ctx.cambiosRemotos, conflictos: ctx.conflictos.length }
    };
  }

  // ¿El local tiene cambios reales respecto de la base? (para no escribir cuando no los hay). Descuenta la normalización si se pasa `neutro`.
  function hayCambiosLocales(base, local, opciones) {
    var esquema = (opciones && opciones.esquema) || ESQUEMA_CONFIG_V1;
    var b = clonar(base), l = clonar(local);
    if (opciones && opciones.neutro !== undefined) l = purgarNeutro(esquema, b, l, clonar(opciones.neutro), [], opciones.protegidos);
    return !iguales(b, l);
  }

  return {
    fusionar: fusionar,
    hayCambiosLocales: hayCambiosLocales,
    iguales: function (a, b) { return iguales(a === undefined ? AUSENTE : a, b === undefined ? AUSENTE : b); },
    clonar: clonar,
    rutaATexto: rutaATexto,
    ESQUEMA_CONFIG_V1: ESQUEMA_CONFIG_V1,
    VERSION: 'r2b-motor-2'
  };
});
