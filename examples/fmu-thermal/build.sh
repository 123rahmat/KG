#!/bin/sh
# Builds thermal.fmu for this machine (FMI 2.0 co-simulation, binaries/<platform>/).
set -eu
cd "$(dirname "$0")"
case "$(uname -s)" in
  Linux)  P=linux64;  EXT=so ;;
  Darwin) P=darwin64; EXT=dylib ;;
  *)      P=win64;    EXT=dll ;;
esac
rm -rf stage && mkdir -p stage/binaries/$P stage/resources
cc -std=c11 -O2 -Wall -Wextra -fPIC -shared -fvisibility=hidden -o stage/binaries/$P/thermal_fmu.$EXT thermal_fmu.c
cp modelDescription.xml stage/
(cd stage && rm -f ../thermal.fmu && zip -qr ../thermal.fmu .)
rm -rf stage
echo "built thermal.fmu ($P)"
