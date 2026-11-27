#!/bin/sh
# CardioLink · corredor de suites para CI (GitHub Actions). Sin dependencias: sólo Node (previsto: 22) y sh/awk. NO usa red, secretos ni Supabase: las suites son estáticas.
#
#   sh tests/ci-suites.sh run <salida.tsv>                 corre TODAS las suites del repositorio desde el directorio actual (la raíz del checkout)
#   sh tests/ci-suites.sh comparar <base.tsv> <head.tsv>   compara dos corridas: sólo falla ante una falla NUEVA (las preexistentes se informan, no se ocultan)
#
# Qué corre: las pruebas de contrato de la raíz (`*.test.cjs`, con `node --test`) y las suites de `tests/*.js` (`node archivo`, desde `tests/`).
# Cada línea de la salida: suite <TAB> código de salida <TAB> pruebas OK <TAB> pruebas con falla <TAB> nombres de las que fallaron (separados por « || »).
# Los registros completos de cada suite quedan en $CI_LOGS_DIR (por defecto ./ci-logs) para subirlos como artefacto.
set -u
modo="${1:-}"

resumir() {   # resumir <log> <código>  -> imprime «pasaron<TAB>fallaron<TAB>nombres»
  awk -v cod="$2" '
    /^[[:space:]]*# pass [0-9]+/ { tp = $3 }
    /^[[:space:]]*# fail [0-9]+/ { tf = $3 }
    /[0-9]+\/[0-9]+ +(pruebas OK|PASS)/ { if (match($0, /[0-9]+\/[0-9]+ +(pruebas OK|PASS)/)) { s = substr($0, RSTART, RLENGTH); split(s, a, "/"); cp = a[1] + 0; split(a[2], b, " "); ct = b[1] + 0 } }
    /^[[:space:]]*not ok [0-9]+ - / { n = $0; sub(/^[[:space:]]*not ok [0-9]+ - /, "", n); sub(/[[:space:]]+#.*$/, "", n); nom[n] = 1 }
    /^(FALLA|FAIL|✗) / { n = $0; sub(/^(FALLA|FAIL|✗)[[:space:]]+/, "", n); nom[n] = 1 }
    END {
      pass = (tp != "" ? tp : (cp != "" ? cp : "")); fail = (tf != "" ? tf : (cp != "" ? ct - cp : ""))
      lista = ""; for (k in nom) lista = lista (lista == "" ? "" : " || ") k
      print pass "\t" fail "\t" lista
    }' "$1"
}

correr() {   # correr <nombre> <directorio> <comando...>
  nombre="$1"; dir="$2"; shift 2
  log="${CI_LOGS_DIR:-./ci-logs}/$(printf '%s' "$nombre" | tr '/ ' '__').log"
  ( cd "$dir" && "$@" ) > "$log" 2>&1
  cod=$?
  r=$(resumir "$log" "$cod")
  printf '%s\t%s\t%s\n' "$nombre" "$cod" "$r" >> "$SALIDA"
  printf '%-58s salida=%s  %s\n' "$nombre" "$cod" "$(printf '%s' "$r" | awk -F'\t' '{ printf "OK=%s FALLAN=%s", $1, $2 }')"
}

if [ "$modo" = "run" ]; then
  SALIDA="${2:?falta la ruta de salida}"; : > "$SALIDA"
  mkdir -p "${CI_LOGS_DIR:-./ci-logs}"
  raiz="$(pwd)"
  echo "Node $(node --version) · $raiz"
  for f in $(ls "$raiz"/*.test.cjs 2>/dev/null | sort); do
    correr "$(basename "$f")" "$raiz" node --test --test-reporter=tap "$f"
  done
  for f in $(ls "$raiz"/tests/*.js 2>/dev/null | sort); do
    correr "tests/$(basename "$f")" "$raiz/tests" node "$f"
  done
  echo "Listo: $(wc -l < "$SALIDA" | tr -d ' ') suites. Resultados en $SALIDA"
  exit 0   # el veredicto lo da «comparar»: acá sólo se registra
fi

if [ "$modo" = "comparar" ]; then
  base="${2:?falta base.tsv}"; head="${3:?falta head.tsv}"
  awk -F'\t' -v SEP=' \\|\\| ' '
    function partir(s, dst,   n, i, p) { n = split(s, p, SEP); for (i = 1; i <= n; i++) if (p[i] != "") dst[p[i]] = 1; }
    FNR == NR { bcod[$1] = $2; bnom[$1] = $5; bpas[$1] = $3; next }
    {
      s = $1; cod = $2; nuevas = ""; viejas = ""; delete h; delete b; partir($5, h); if (s in bcod) partir(bnom[s], b)
      for (k in h) { if (k in b) viejas = viejas "\n      · " k; else nuevas = nuevas "\n      · " k }
      if (nuevas == "" && cod != 0 && !(s in bcod)) nuevas = "\n      · (la suite nueva terminó con código " cod ")"
      if (nuevas == "" && cod != 0 && (s in bcod) && bcod[s] == 0) nuevas = "\n      · (la suite pasaba en la base y ahora termina con código " cod ")"
      estado = "OK"; if (nuevas != "") { estado = "REGRESIÓN"; malas++ } else if (viejas != "" || cod != 0) estado = "preexistente"
      printf "%-12s %-58s base=%s head=%s OK=%s FALLAN=%s\n", estado, s, (s in bcod ? bcod[s] : "—"), cod, $3, $4
      if (nuevas != "") printf "    fallas NUEVAS:%s\n", nuevas
      if (viejas != "") printf "    fallas PREEXISTENTES (ya fallaban en la base; no son de este cambio):%s\n", viejas
      visto[s] = 1
    }
    END {
      for (s in bcod) if (!(s in visto)) { printf "%-12s %-58s (estaba en la base y ya no corre en el head)\n", "AVISO", s }
      if (malas > 0) { printf "\n%d suite(s) con fallas NUEVAS respecto de la base: NO se puede aprobar.\n", malas; exit 1 }
      printf "\nSin fallas nuevas respecto de la base.\n"
    }' "$base" "$head"
  exit $?
fi

# verificar: barrera contra la NORMALIZACIÓN de fallas. Toda prueba que falla en el head debe estar en el registro explícito (tests/fallas-conocidas.tsv: suite, nombre, clase, deuda, motivo).
# Complementa a «comparar»: si una regresión llegara a main, un PR posterior la vería como «preexistente»; con el registro sigue siendo una falla NO registrada y el CI la rechaza.
# Las fallas registradas que ya no fallan se informan como RESUELTAS (hay que retirarlas del registro): el registro sólo puede achicarse con una decisión explícita en un PR.
if [ "$modo" = "verificar" ]; then
  head="${2:?falta head.tsv}"; registro="${3:?falta el registro de fallas conocidas}"
  awk -F'\t' -v SEP=' \\|\\| ' '
    FNR == NR { if ($0 ~ /^#/ || $0 == "") next; conocida[$1 "\t" $2] = $3; nreg++; next }
    {
      s = $1; cod = $2; n = split($5, p, SEP); algun = 0
      for (i = 1; i <= n; i++) if (p[i] != "") { algun = 1; vistos[s "\t" p[i]] = 1; if ((s "\t" p[i]) in conocida) activas++; else { printf "NO REGISTRADA  %s :: %s\n", s, p[i]; malas++ } }
      if (cod != 0 && !algun) { clave = s "\t(sin nombre de prueba)"; vistos[clave] = 1; if (clave in conocida) activas++; else { printf "NO REGISTRADA  %s :: la suite termina con código %s sin nombrar la prueba\n", s, cod; malas++ } }
    }
    END {
      for (k in conocida) if (!(k in vistos)) { gsub("\t", " :: ", k); printf "RESUELTA (retirar del registro)  %s\n", k; resueltas++ }
      printf "\nFallas conocidas activas: %d de %d registradas · resueltas: %d · NO registradas: %d\n", activas + 0, nreg + 0, resueltas + 0, malas + 0
      if (malas > 0) { print "Hay fallas que no están en el registro: son nuevas o fueron normalizadas. NO se puede aprobar."; exit 1 }
      print "Todas las fallas están registradas (ninguna nueva ni normalizada)."
    }' "$registro" "$head"
  exit $?
fi

echo "uso: sh tests/ci-suites.sh run <salida.tsv> | comparar <base.tsv> <head.tsv> | verificar <head.tsv> <tests/fallas-conocidas.tsv>" >&2
exit 2
