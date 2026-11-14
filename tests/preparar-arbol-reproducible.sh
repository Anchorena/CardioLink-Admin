#!/bin/sh
# Prepara un ÁRBOL REPRODUCIBLE de las pruebas: copia todos los archivos del repositorio (versionados y nuevos no ignorados) que las suites leen —app.js, módulos, index.html, migraciones, Edge Functions,
# docs/propuestas, verificacion-publica, portal, etc.— en un directorio NUEVO, con la URL y la clave publishable de Supabase de app.js REDACTADAS. No usa red, no ejecuta SQL ni instala nada.
# Uso: sh tests/preparar-arbol-reproducible.sh <directorio-destino-que-no-exista>   y luego:  cd <destino>/tests && node run-bloque4c1.js
set -eu
[ $# -eq 1 ] || { echo "Uso: sh tests/preparar-arbol-reproducible.sh <directorio-destino-nuevo>" >&2; exit 2; }
DEST="$1"
[ ! -e "$DEST" ] || { echo "El destino ya existe: $DEST (usar uno nuevo)" >&2; exit 1; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$DEST"
cd "$ROOT"
git ls-files --cached --others --exclude-standard | grep -v '^supabase/\.temp/' | tar -cf - -T - | (cd "$DEST" && tar -xf -)
# Redacción de credenciales (sólo app.js las lleva)
sed -E 's#^(const SUPABASE_URL = ")[^"]*(";)#\1https://REDACTED-PROJECT.supabase.co\2#; s#^(const SUPABASE_KEY = ")[^"]*(";)#\1sb_publishable_REDACTED\2#' "$DEST/app.js" > "$DEST/app.js.redactado"
mv "$DEST/app.js.redactado" "$DEST/app.js"
if grep -rIl -E 'sb_publishable_[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{30,}' "$DEST" 2>/dev/null | grep -v '/tests/'; then echo "Quedaron credenciales sin redactar (ver arriba)" >&2; exit 1; fi
echo "Árbol reproducible en: $DEST ($(find "$DEST" -type f | wc -l | tr -d ' ') archivos). Credenciales de app.js redactadas."
