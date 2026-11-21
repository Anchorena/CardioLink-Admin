#!/usr/bin/env python3
"""CardioLink · incidente 19/11/2026 (1001 fichas sin nombre ni DNI) · generador del SQL de RESTAURACIÓN SELECTIVA por ID.

NO se ejecuta nada: este script solo ESCRIBE archivos .sql y una tabla de comparación. Los datos personales (nombres/DNI) viven en la tabla CSV y en los respaldos locales, NUNCA en el repositorio.

Entradas (todas locales y privadas):
  --tabla   CSV de recuperación (paciente_id, estado, nombre_propuesto, dni_propuesto, fuentes, nota)
  --backup  JSON de respaldo de la app (config.pacientes) del que se completan los DEMÁS campos de la ficha, solo donde hoy están vacíos (p. ej. CardioLink_Admin_backup del 29/10)
  --antes   JSON con la foto ANTES de la tabla (id, actualizado_en y todas las columnas) tomada de Production: base del rollback y de la comparación
  --estados estados a restaurar (por defecto CONFIRMADO_ALTO,CONFIRMADO_1_FUENTE). Los CONFLICTO_* y POSIBLE requieren decisión humana y NO se incluyen salvo que se pidan.
  --excluir archivo con ids (uno por línea) a dejar afuera (p. ej. choques de DNI)

Salidas (en --salida): restauracion_ensayo.sql (termina SIEMPRE en ROLLBACK), restauracion_aplicar.sql (COMMIT), rollback.sql, comparacion_antes_despues.csv, resumen.txt.

Garantías del SQL generado:
  · una sola transacción; TEMP TABLE (sin cambios de esquema); no toca RLS, atenciones, evoluciones, documentos ni la fila de configuración;
  · precondiciones que ABORTAN: ids inexistentes, fila que YA NO está vacía (alguien la corrigió), choque con el índice único de DNI, DNI repetido dentro del lote;
  · solo escribe en filas con nombre_completo Y dni NULL, y por columna usa COALESCE (jamás pisa un dato existente);
  · verifica que las filas afectadas sean exactamente las esperadas antes de confirmar.
"""
import argparse, csv, json, os, re, sys

CAMPOS_EXTRA = [  # (clave del respaldo, columna de la tabla, tipo)
    ('telefono', 'telefono', 'text'), ('email', 'email', 'text'), ('fechaNacimiento', 'fecha_nacimiento', 'date'), ('sexo', 'sexo', 'text'),
    ('localidad', 'localidad', 'text'), ('direccion', 'direccion', 'text'), ('provincia', 'provincia', 'text'),
    ('coberturaHabitual', 'cobertura_habitual', 'text'), ('numeroAfiliadoHabitual', 'numero_afiliado_habitual', 'text'),
]

def q(v):
    return 'NULL' if v is None or v == '' else "'" + str(v).replace("'", "''") + "'"

def fecha(v):
    m = re.match(r'^(\d{4})-(\d{2})-(\d{2})', str(v or ''))
    return m.group(0) if m else None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--tabla', required=True); ap.add_argument('--backup'); ap.add_argument('--antes', required=True)
    ap.add_argument('--estados', default='CONFIRMADO_ALTO,CONFIRMADO_1_FUENTE'); ap.add_argument('--excluir'); ap.add_argument('--salida', required=True)
    a = ap.parse_args()
    estados = set(a.estados.split(','))
    excluir = set(open(a.excluir).read().split()) if a.excluir else set()
    antes = {p['id']: p for p in json.load(open(a.antes))}
    bk = {}
    if a.backup:
        for p in json.load(open(a.backup))['config']['pacientes']:
            bk[str(p.get('id'))] = p
    filas = []
    for r in csv.DictReader(open(a.tabla, newline='')):
        if r['estado'] not in estados or r['paciente_id'] in excluir: continue
        pid = r['paciente_id']
        if pid not in antes: sys.exit('el id %s no está en la foto "antes"' % pid)
        if antes[pid].get('nombre_completo') or antes[pid].get('dni'): sys.exit('el id %s ya NO está vacío en la foto "antes"' % pid)
        dni = re.sub(r'\D', '', r['dni_propuesto'] or '') or None
        extra = {}
        b = bk.get(pid) or {}
        for k, col, tipo in CAMPOS_EXTRA:
            v = fecha(b.get(k)) if tipo == 'date' else (str(b.get(k) or '').strip() or None)
            extra[col] = v
        filas.append({'id': pid, 'nombre': r['nombre_propuesto'].strip(), 'dni': dni, 'extra': extra, 'estado': r['estado'], 'fuentes': r['fuentes']})
    if not filas: sys.exit('no hay filas para restaurar con esos estados')
    os.makedirs(a.salida, exist_ok=True)
    cols = ['id', 'nombre', 'dni'] + [c for _, c, _ in CAMPOS_EXTRA]
    tipos = {'id': 'text', 'nombre': 'text', 'dni': 'text', **{c: t for _, c, t in CAMPOS_EXTRA}}
    valores = ',\n'.join('(' + ', '.join(q(f['id'] if c == 'id' else f['nombre'] if c == 'nombre' else f['dni'] if c == 'dni' else f['extra'][c]) + ('::date' if tipos[c] == 'date' else '') for c in cols) + ')' for f in filas)
    n = len(filas)

    def cuerpo(final):
        return f"""-- Restauración selectiva por ID de cardiolink_pacientes (incidente del 19/11/2026). {n} filas. Generado, NO ejecutado.
BEGIN;
SET LOCAL statement_timeout = '120s';
CREATE TEMP TABLE recup ({', '.join(c + ' ' + tipos[c] for c in cols)}, PRIMARY KEY (id)) ON COMMIT DROP;
INSERT INTO recup ({', '.join(cols)}) VALUES
{valores};

DO $$
DECLARE k int;
BEGIN
  SELECT count(*) INTO k FROM recup;                                                                   IF k <> {n} THEN RAISE EXCEPTION 'lote incompleto: % filas', k; END IF;
  SELECT count(*) INTO k FROM recup r LEFT JOIN public.cardiolink_pacientes p ON p.id = r.id WHERE p.id IS NULL;
  IF k > 0 THEN RAISE EXCEPTION 'ABORTA: % ids no existen en cardiolink_pacientes', k; END IF;
  SELECT count(*) INTO k FROM recup r JOIN public.cardiolink_pacientes p ON p.id = r.id WHERE p.nombre_completo IS NOT NULL OR p.dni IS NOT NULL;
  IF k > 0 THEN RAISE EXCEPTION 'ABORTA: % filas ya no están vacías (alguien las corrigió); revisar antes de seguir', k; END IF;
  SELECT count(*) INTO k FROM (SELECT regexp_replace(dni, '\\D', '', 'g') d FROM recup WHERE dni IS NOT NULL GROUP BY 1 HAVING count(*) > 1) x;
  IF k > 0 THEN RAISE EXCEPTION 'ABORTA: % DNI repetidos dentro del lote', k; END IF;
  SELECT count(*) INTO k FROM recup r WHERE r.dni IS NOT NULL AND EXISTS (SELECT 1 FROM public.cardiolink_pacientes q WHERE q.dni_normalizado = regexp_replace(r.dni, '\\D', '', 'g') AND q.id <> r.id);
  IF k > 0 THEN RAISE EXCEPTION 'ABORTA: % DNI ya pertenecen a otra ficha (índice único)', k; END IF;
END $$;

WITH u AS (
  UPDATE public.cardiolink_pacientes p SET
    nombre_completo = r.nombre,
    dni = r.dni,
    {(','+chr(10)+'    ').join(c + ' = COALESCE(p.' + c + ', r.' + c + ')' for _, c, _ in CAMPOS_EXTRA)},
    actualizado_en = now()
  FROM recup r
  WHERE p.id = r.id AND p.nombre_completo IS NULL AND p.dni IS NULL
  RETURNING p.id)
SELECT CASE WHEN (SELECT count(*) FROM u) = {n} THEN 'OK: {n} filas restauradas' ELSE 'ABORTA: se esperaban {n} filas' END AS resultado,
       (SELECT count(*) FROM u) AS filas_afectadas;
DO $$ BEGIN IF (SELECT count(*) FROM public.cardiolink_pacientes p JOIN recup r ON r.id = p.id WHERE p.nombre_completo = r.nombre) <> {n} THEN RAISE EXCEPTION 'ABORTA: verificación posterior distinta de {n}'; END IF; END $$;
SELECT count(*) FILTER (WHERE nombre_completo IS NULL) AS fichas_sin_nombre_despues, count(*) AS total FROM public.cardiolink_pacientes;
{final};
"""
    final_ensayo = ("DO $$ BEGIN RAISE EXCEPTION 'ENSAYO COMPLETADO (todo REVERTIDO, no queda ningún cambio): % filas se restaurarían; fichas sin nombre quedarían: %', "
                    f"{n}, (SELECT count(*) FROM public.cardiolink_pacientes WHERE nombre_completo IS NULL); END $$;\nROLLBACK")
    open(os.path.join(a.salida, 'restauracion_ensayo.sql'), 'w').write(cuerpo(final_ensayo))   # termina SIEMPRE en error controlado + ROLLBACK: imposible confirmar por accidente
    open(os.path.join(a.salida, 'restauracion_aplicar.sql'), 'w').write(cuerpo('COMMIT') + "SELECT count(*) FILTER (WHERE nombre_completo IS NULL) AS fichas_sin_nombre_confirmado, count(*) AS total FROM public.cardiolink_pacientes;\n")
    # rollback: vuelve exactamente al estado «antes» (solo filas que siguen con el nombre restaurado: no deshace correcciones posteriores)
    rb = [f"-- ROLLBACK de la restauración selectiva ({n} filas): vuelve a la foto «antes». No toca filas que cambiaron después de la restauración.", "BEGIN;"]
    for f in filas:
        p = antes[f['id']]
        sets = ', '.join(f"{c} = {q(p.get(c))}" + ('::date' if tipos.get(c) == 'date' else '') for c in ['nombre_completo', 'dni'] + [c for _, c, _ in CAMPOS_EXTRA]) + f", actualizado_en = {q(p.get('actualizado_en'))}::timestamptz"
        rb.append(f"UPDATE public.cardiolink_pacientes SET {sets} WHERE id = {q(f['id'])} AND nombre_completo = {q(f['nombre'])};")
    rb.append("COMMIT;")
    open(os.path.join(a.salida, 'rollback.sql'), 'w').write('\n'.join(rb) + '\n')
    with open(os.path.join(a.salida, 'comparacion_antes_despues.csv'), 'w', newline='') as fh:
        w = csv.writer(fh); w.writerow(['paciente_id', 'estado', 'fuentes', 'nombre_antes', 'nombre_despues', 'dni_antes', 'dni_despues', 'campos_extra_completados'])
        for f in filas:
            w.writerow([f['id'], f['estado'], f['fuentes'], '', f['nombre'], '', f['dni'] or '', ','.join(k for k, v in f['extra'].items() if v)])
    open(os.path.join(a.salida, 'resumen.txt'), 'w').write(f"filas: {n}\nestados: {sorted(estados)}\ncon DNI: {sum(1 for f in filas if f['dni'])}\n")
    print('generado:', n, 'filas ->', a.salida)

if __name__ == '__main__':
    main()
