#!/bin/sh
# One-time setup of the demo project for THIS machine's signing key.
set -eu
KG_HOME=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
K="$KG_HOME/bin/kindgleam"
DEMO="$KG_HOME/examples/heater-demo"
if ! FP=$("$K" fingerprint 2>/dev/null); then
  echo "No signing key yet: run '$K keygen' first."; exit 1
fi
sed -i.bak "s/^LEDGER_KEY_FP .*/$FP/" "$DEMO/profile.cfg" && rm -f "$DEMO/profile.cfg.bak"
cd "$DEMO" && "$K" sign-limits
echo "Demo ready. Next: cd $DEMO && $K verify"
