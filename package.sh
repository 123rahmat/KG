#!/bin/sh
# Builds the Kindgleam package for THIS computer's system (Linux or macOS):
#   dist/kindgleam-<os>-<arch>/        ready-to-run folder
#   dist/kindgleam-<os>-<arch>.tar.gz  the same folder, compressed
# Windows packages are made on Windows with package.ps1.
#
# If model/kindgleam-coder.gguf is present it is checked against the pinned SHA-256 in
# model/MODEL.txt and packed unchanged. If it is missing the package is built without it and the
# assistant asks for it on first use (everything else works).
set -eu
cd "$(dirname "$0")"
unset JAVA_TOOL_OPTIONS _JAVA_OPTIONS JDK_JAVA_OPTIONS || true

case "$(uname -s)" in
  Linux) OS=linux ;;
  Darwin) OS=macos ;;
  *) echo "package.sh is for Linux and macOS; use package.ps1 on Windows"; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) echo "unsupported CPU: $(uname -m)"; exit 1 ;;
esac
NAME="kindgleam-$OS-$ARCH"
OUT="dist/$NAME"

if command -v sha256sum >/dev/null 2>&1; then SHA="sha256sum"; else SHA="shasum -a 256"; fi

echo "== building"
make

echo "== checking the engine against the reference implementation"
if python3 -c "import numpy, regex, gguf" >/dev/null 2>&1; then
  T=$(mktemp -d)
  python3 -I engine/test/check_engine.py engine/build/kg-infer "$T" | tail -1
  rm -rf "$T"
else
  echo "   (skipped: needs python3 with numpy, regex and gguf; run it in CI)"
fi

echo "== assembling $OUT"
rm -rf "$OUT" "dist/$NAME.tar.gz"
mkdir -p "$OUT/bin" "$OUT/build" "$OUT/engine/build" "$OUT/model"
cp bin/kindgleam bin/kindgleam-app "$OUT/bin/"
cp -R build/mods "$OUT/build/"
[ -d build/native ] && cp -R build/native "$OUT/build/"
cp engine/build/kg-infer "$OUT/engine/build/"
cp -R engine/src "$OUT/engine/"
for d in firmware-support skills selftest docs; do cp -R "$d" "$OUT/"; done
mkdir -p "$OUT/examples"
for e in examples/*; do
  if [ -f "$e" ]; then cp "$e" "$OUT/examples/"; continue; fi
  mkdir -p "$OUT/$e"
  (cd "$e" && find . -path ./jobs -prune -o -path ./evidence -prune -o -path ./memory -prune -o -type f -print) |
    while read -r f; do mkdir -p "$OUT/$e/$(dirname "$f")"; cp "$e/$f" "$OUT/$e/$f"; done
done
cp README.md "$OUT/"
cp model/MODEL.txt "$OUT/model/"
[ -f model/LICENSE-MODEL.txt ] && cp model/LICENSE-MODEL.txt "$OUT/model/"
printf 'PLATFORM %s %s\n' "$OS" "$ARCH" > "$OUT/platform.txt"

PIN=$(sed -n 's/^SHA256 //p' model/MODEL.txt)
MFILE=$(sed -n 's/^FILE //p' model/MODEL.txt)
if [ -f "model/$MFILE" ]; then
  echo "== checking model/$MFILE against the pinned fingerprint"
  GOT=$($SHA "model/$MFILE" | cut -d' ' -f1)
  ALSO=$(sed -n 's/^ALSO \([0-9a-f]*\).*/\1/p' model/MODEL.txt)
  if [ "$GOT" != "$PIN" ] && ! printf '%s\n' $ALSO | grep -qx "$GOT"; then
    echo "model/$MFILE is not the published model (got $GOT, need $PIN); refusing to package it"
    exit 1
  fi
  cp "model/$MFILE" "$OUT/model/$MFILE"
  echo "   model packed unchanged"
else
  echo "   NOTE: no model file in model/; the package's assistant will ask for it on first use"
fi

echo "== fingerprints"
(cd "$OUT" && find . -type f ! -name SHA256SUMS | LC_ALL=C sort | while read -r f; do $SHA "$f"; done > SHA256SUMS)
cat > "$OUT/VERIFY.txt" <<EOF
Checking this Kindgleam package

Every file is listed with its SHA-256 fingerprint in SHA256SUMS.
  Linux:   cd $NAME && sha256sum -c SHA256SUMS
  macOS:   cd $NAME && shasum -a 256 -c SHA256SUMS
Any line that does not say OK means the file was changed after packaging; do not use the package.

The assistant's model file is also checked against model/MODEL.txt every time it is installed,
and the engine re-checks the exact bytes it loads on every start.
EOF

echo "== compressing"
(cd dist && tar -czf "$NAME.tar.gz" "$NAME")
echo "done: dist/$NAME.tar.gz ($(du -h "dist/$NAME.tar.gz" | cut -f1))"
