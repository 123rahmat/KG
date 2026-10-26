#!/bin/sh
# Builds the real desktop application for THIS computer's system, with its own Java runtime inside
# (users need no Java):
#   Linux:  dist/app/Kindgleam/ (portable folder, run bin/Kindgleam)  +  .deb when dpkg-deb is present
#   macOS:  dist/app/Kindgleam.app  +  Kindgleam-<version>.dmg
# Windows uses packaging/make-app.ps1.
#
# If model/kindgleam-coder.gguf is present (see tools/get-model.sh model) it is checked against
# the pinned fingerprint and shipped inside the app, so the assistant works straight away.
set -eu
cd "$(dirname "$0")/.."
unset JAVA_TOOL_OPTIONS _JAVA_OPTIONS JDK_JAVA_OPTIONS || true
VERSION=${KG_VERSION:-3.0.0}
case "$(uname -s)" in Linux) OS=linux ;; Darwin) OS=macos ;; *) echo "use make-app.ps1 on Windows"; exit 1 ;; esac
case "$(uname -m)" in x86_64|amd64) ARCH=x64 ;; arm64|aarch64) ARCH=arm64 ;; *) echo "unsupported CPU"; exit 1 ;; esac
if command -v sha256sum >/dev/null 2>&1; then SHA="sha256sum"; else SHA="shasum -a 256"; fi

echo "== build"
make
OUT=dist/app
STAGE=build/stage
rm -rf "$OUT" "$STAGE"
mkdir -p "$OUT" "$STAGE/content"

echo "== app content (becomes Kindgleam's home inside the app)"
C="$STAGE/content"
mkdir -p "$C/build" "$C/engine/build" "$C/model" "$C/examples"
cp -R build/mods "$C/build/"
[ -d build/native ] && cp -R build/native "$C/build/"
cp engine/build/kg-infer "$C/engine/build/"
for d in selftest skills firmware-support docs tools; do cp -R "$d" "$C/"; done
for e in examples/*; do
  if [ -f "$e" ]; then cp "$e" "$C/examples/"; continue; fi
  (cd "$e" && find . -path ./jobs -prune -o -path ./evidence -prune -o -path ./memory -prune -o -type f -print) |
    while read -r f; do mkdir -p "$C/$e/$(dirname "$f")"; cp "$e/$f" "$C/$e/$f"; done
done
cp model/MODEL.txt model/LICENSE-MODEL.txt "$C/model/"
cp README.md "$C/"
printf 'PLATFORM %s %s\n' "$OS" "$ARCH" > "$C/platform.txt"
MFILE=$(sed -n 's/^FILE //p' model/MODEL.txt)
if [ -f "model/$MFILE" ]; then
  GOT=$($SHA "model/$MFILE" | cut -d' ' -f1)
  OK=$(sed -n 's/^SHA256 //p; s/^ALSO \([0-9a-f]*\).*/\1/p' model/MODEL.txt | grep -x "$GOT" || true)
  if [ -z "$OK" ]; then echo "model/$MFILE is not a published model file; refusing to ship it"; exit 1; fi
  cp "model/$MFILE" "$C/model/"
  echo "   assistant model included ($(du -h "model/$MFILE" | cut -f1))"
else
  echo "   no model file in model/: the app will offer tools/get-model on first use of the assistant"
fi

echo "== Java runtime for the app"
MODS=java.base,java.desktop,java.xml,jdk.crypto.ec,jdk.zipfs
jlink --add-modules "$MODS" --strip-debug --no-man-pages --no-header-files --compress=2 --output "$STAGE/runtime"

echo "== application"
ICON=packaging/icons/kindgleam.png
[ "$OS" = macos ] && ICON=packaging/icons/kindgleam.icns
CONTENT=""
for d in "$C"/*; do CONTENT="${CONTENT:+$CONTENT,}$d"; done
jpackage --type app-image --dest "$OUT" --name Kindgleam --app-version "$VERSION" \
  --vendor "Kindgleam" --description "Offline SIL / PIL / HIL co-verification for embedded firmware" \
  --icon "$ICON" --runtime-image "$STAGE/runtime" \
  --module-path build/mods --module kg.app/kg.app.App \
  --app-content "$CONTENT" \
  --java-options "--enable-preview -Xshare:off -Dkg.installed=true -Dkg.home=\$APPDIR/.. -Dawt.useSystemAAFontSettings=on"

if [ "$OS" = linux ]; then
  (cd "$OUT" && tar -czf "Kindgleam-$VERSION-linux-$ARCH.tar.gz" Kindgleam)
  if command -v dpkg-deb >/dev/null 2>&1; then
    jpackage --type deb --dest "$OUT" --app-image "$OUT/Kindgleam" --name kindgleam --app-version "$VERSION" \
      --vendor "Kindgleam" --description "Offline SIL / PIL / HIL co-verification for embedded firmware" \
      --linux-shortcut --linux-menu-group Development --linux-app-category devel --icon "$ICON" \
      || echo "   (.deb not built: jpackage needs dpkg-deb and fakeroot)"
  fi
else
  jpackage --type dmg --dest "$OUT" --app-image "$OUT/Kindgleam.app" --name Kindgleam --app-version "$VERSION" \
    --vendor "Kindgleam"
fi
echo "done:"
ls -la "$OUT"
