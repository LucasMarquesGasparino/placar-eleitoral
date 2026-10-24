#!/usr/bin/env sh
# Gera o APK do Placar 2T Seção: testes, keystore estável (fora do repo) e assembleRelease assinado.
set -eu
cd "$(dirname "$0")"
REPO=..
: "${JAVA_HOME:=/data/data/com.termux/files/usr/lib/jvm/java-21-openjdk}"
export JAVA_HOME

# O SDK é o mesmo do android-t2: reaproveita o local.properties dele (arquivo local, fora do Git).
if [ ! -f local.properties ] && [ -f ../android-t2/local.properties ]; then cp ../android-t2/local.properties local.properties; fi
if [ ! -f local.properties ] && [ -z "${ANDROID_HOME:-}" ]; then
  echo "Falta o Android SDK: crie android-t2s/local.properties com sdk.dir=... ou defina ANDROID_HOME. Veja a seção 'APK do 2º turno' do README." >&2
  exit 1
fi

if [ ! -d ../data/t2/secoes ]; then
  echo "Falta data/t2/secoes (base por seção). Gere com: python3 -I scripts/t2_build_secoes.py --votos ~/dl/votacao_secao_2026_BR.zip --detalhe ~/dl/detalhe_votacao_secao_2026.zip" >&2
  exit 1
fi

echo "==> Testes (node --test)"
if ! (cd "$REPO" && node --test); then
  echo "Testes falharam: APK não gerado." >&2
  exit 1
fi

KS="$HOME/.android-keys/placar-t2.keystore"
if [ ! -f "$KS" ]; then
  echo "==> Criando keystore estável em $KS (faça backup dele: sem ele não há atualização do APK)"
  mkdir -p "$HOME/.android-keys"
  keytool -genkeypair -v -keystore "$KS" -storepass placart2 -keypass placart2 -alias placart2 \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Placar 2T, OU=Local, O=Placar Eleitoral, L=Local, ST=SP, C=BR"
fi

echo "==> Gradle assembleRelease"
./gradlew --no-daemon assembleRelease

OUT=app/build/outputs/apk/release/app-release.apk
echo "==> Assinatura"
apksigner verify --print-certs "$OUT"
echo "==> Pacote"
aapt dump badging "$OUT" | head -3
mkdir -p build
cp "$OUT" build/placar-2t-secao.apk
echo "APK pronto: $(pwd)/build/placar-2t-secao.apk"
