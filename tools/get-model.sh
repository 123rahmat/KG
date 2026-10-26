#!/bin/sh
# Downloads the assistant's model ONCE, checks it against the fingerprint pinned in model/MODEL.txt,
# and puts it where Kindgleam looks for it. Run it on any computer with internet; to set up an
# air-gapped computer, copy the downloaded file across and run 'kindgleam model install <file>'.
#
# This helper is the only thing in the Kindgleam folder that uses the network, and only to fetch
# this one file from its official address. Kindgleam itself contains no network code.
#
#   sh tools/get-model.sh            put it in this Kindgleam's own model folder (uninstalling removes it)
#   sudo sh tools/get-model.sh       the same, when Kindgleam is installed system-wide (/opt, /Applications)
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
MANIFEST="$HERE/model/MODEL.txt"
URL=$(sed -n 's/^SOURCE //p' "$MANIFEST" | sed 's#/blob/#/resolve/#')
PIN=$(sed -n 's/^SHA256 //p' "$MANIFEST")
FILE=$(sed -n 's/^FILE //p' "$MANIFEST")
DEST=${1:-"$HERE/model"}
[ "$DEST" = model ] && DEST="$HERE/model"
mkdir -p "$DEST" 2>/dev/null || true
if [ ! -w "$DEST" ]; then
  echo "Kindgleam's program folder $DEST is read-only for this user."
  echo "Run this again as administrator:  sudo sh \"$0\""
  exit 1
fi
OUT="$DEST/$FILE"
if command -v sha256sum >/dev/null 2>&1; then SHA="sha256sum"; else SHA="shasum -a 256"; fi
if [ -f "$OUT" ] && [ "$($SHA "$OUT" | cut -d' ' -f1)" = "$PIN" ]; then
  echo "The model is already in place and correct: $OUT"
  exit 0
fi
echo "Downloading the Kindgleam assistant model (about 1.1 GB) from:"
echo "  $URL"
if command -v curl >/dev/null 2>&1; then
  curl -L --fail --retry 3 -C - -o "$OUT.part" "$URL"
else
  wget -c -O "$OUT.part" "$URL"
fi
echo "Checking the fingerprint..."
GOT=$($SHA "$OUT.part" | cut -d' ' -f1)
if [ "$GOT" != "$PIN" ]; then
  echo "WRONG FILE: fingerprint $GOT, expected $PIN. Nothing was installed."
  rm -f "$OUT.part"
  exit 1
fi
mv "$OUT.part" "$OUT"
echo "Done: $OUT"
echo "The assistant is ready: open Kindgleam, go to Code and turn the assistant on in Settings."
