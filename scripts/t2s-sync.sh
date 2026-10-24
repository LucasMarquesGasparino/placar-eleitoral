#!/usr/bin/env sh
# t2s-sync.sh — Regenera t2s.html a partir de t2.html e confere o android-t2s contra o android-t2.
# Rode sempre que t2.html ou android-t2/ mudarem (o t2s.html NÃO deve ser editado à mão).
#   sh scripts/t2s-sync.sh          # regenera t2s.html e mostra as diferenças do Android
# Trocas aplicadas em t2.html (cada uma é conferida; se uma não casar, o script falha em voz alta):
#   1) <title> ............ "Placar 2T · Seção"
#   2) manifest ........... manifest-t2.webmanifest -> manifest-t2s.webmanifest
#   3) link da marca ...... href="./t2.html" -> href="./t2s.html"
#   4) etiqueta da marca .. "2º turno" -> "2º turno · seção"
#   5) scripts ............ t2-pertenca.js e t2s-plugin.js ANTES de t2.js
set -eu
cd "$(dirname "$0")/.."
SRC=t2.html
DST=t2s.html
[ -f "$SRC" ] || { echo "falta $SRC" >&2; exit 1; }

sed \
  -e 's#<title>[^<]*</title>#<title>Placar 2T · Seção</title>#' \
  -e 's#manifest-t2\.webmanifest#manifest-t2s.webmanifest#' \
  -e 's#href="\./t2\.html"#href="./t2s.html"#' \
  -e 's#\(<small class="t2-brand-tag">\)2º turno\(</small>\)#\12º turno · seção\2#' \
  -e 's#^\([[:space:]]*\)<script src="\./t2\.js" defer></script>#\1<script src="./t2-pertenca.js" defer></script>\n\1<script src="./t2s-plugin.js" defer></script>\n\1<script src="./t2.js" defer></script>#' \
  "$SRC" > "$DST.tmp"

falhou=0
conferir() {   # conferir "descrição" "padrão fixo"
  if ! grep -qF -- "$2" "$DST.tmp"; then echo "ERRO: troca não aplicada: $1 (procurei: $2). Ajuste scripts/t2s-sync.sh." >&2; falhou=1; fi
}
conferir "título" '<title>Placar 2T · Seção</title>'
conferir "manifest" 'manifest-t2s.webmanifest'
conferir "link da marca" 'href="./t2s.html"'
conferir "etiqueta da marca" '2º turno · seção</small>'
conferir "pertença antes de t2.js" '<script src="./t2-pertenca.js" defer></script>'
conferir "plugin antes de t2.js" '<script src="./t2s-plugin.js" defer></script>'
# ordem: pertença < plugin < t2.js
ordem=$(grep -n -F -e 't2-pertenca.js' -e 't2s-plugin.js' -e './t2.js' "$DST.tmp" | cut -d: -f1 | tr '\n' ' ')
set -- $ordem
if [ "$#" -ne 3 ] || [ "$1" -ge "$2" ] || [ "$2" -ge "$3" ]; then echo "ERRO: ordem dos scripts inesperada ($ordem)" >&2; falhou=1; fi
if [ "$falhou" -ne 0 ]; then rm -f "$DST.tmp"; exit 1; fi
mv "$DST.tmp" "$DST"
echo "ok: $DST regenerado a partir de $SRC"

# --- conferência do Android: a lista de arquivos do android-t2 deve estar contida na do android-t2s ---
lista() { sed -n "/tasks.register('syncWebAssets'/,/^}/p" "$1" | grep -o "'[^']*'" | tr -d "'" | sort -u; }
if [ -f android-t2/app/build.gradle ] && [ -f android-t2s/app/build.gradle ]; then
  lista android-t2/app/build.gradle  > "$DST.a"
  lista android-t2s/app/build.gradle > "$DST.b"
  faltam=$(comm -23 "$DST.a" "$DST.b" | grep -v -e '^www$' -e '^Sync$' -e '^syncWebAssets$' || true)
  rm -f "$DST.a" "$DST.b"
  if [ -n "$faltam" ]; then echo "ATENÇÃO: arquivos do android-t2 que faltam no syncWebAssets do android-t2s:"; echo "$faltam" | sed 's/^/  - /'; else echo "ok: syncWebAssets do android-t2s cobre o do android-t2"; fi
  for f in app/src/main/java/br/com/lucasgasparino/placar/MainActivity.java app/src/main/AndroidManifest.xml gradle.properties build.gradle gradle/wrapper/gradle-wrapper.properties; do
    if ! cmp -s "android-t2/$f" "android-t2s/$f"; then echo "ATENÇÃO: android-t2/$f mudou em relação ao android-t2s (copie à mão se for relevante)"; fi
  done
fi
