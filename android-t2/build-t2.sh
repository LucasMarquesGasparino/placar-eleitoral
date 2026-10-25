#!/usr/bin/env sh
# Gera o APK do Placar 2T: testes, keystore estável (fora do repo) e assembleRelease assinado.
set -eu
cd "$(dirname "$0")"
REPO=..
: "${JAVA_HOME:=/data/data/com.termux/files/usr/lib/jvm/java-21-openjdk}"
export JAVA_HOME

# O aapt2 do Termux depende da libc++ atual; põe essa biblioteca antes de cópias antigas de ferramentas no LD_LIBRARY_PATH.
if [ -n "${PREFIX:-}" ] && [ -d "$PREFIX/lib" ]; then
  LD_LIBRARY_PATH="$PREFIX/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  export LD_LIBRARY_PATH
fi

if [ ! -f local.properties ] && [ -z "${ANDROID_HOME:-}" ]; then
  echo "Falta o Android SDK: crie android-t2/local.properties com sdk.dir=... ou defina ANDROID_HOME. Veja a seção 'APK do 2º turno' do README." >&2
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
cp "$OUT" build/placar-2t.apk
chmod 644 build/placar-2t.apk
echo "APK pronto: $(pwd)/build/placar-2t.apk"
