# Operating systems

| | Linux | Windows | macOS |
| --- | --- | --- | --- |
| Build | `make` | `build.ps1` (MinGW-w64 `g++` or MSVC `cl`) | `make` (Xcode command-line tools) |
| Package | `package.sh` | `package.ps1` | `package.sh` |
| Launchers | `bin/kindgleam`, `bin/kindgleam-app` | `bin\kindgleam.cmd`, `bin\kindgleam-app.cmd` | same as Linux |
| Firmware host library | `libfw.so` | `fw.dll` | `libfw.dylib` |
| Network isolation for jobs and the assistant engine | network namespace (`unshare`) | not available: set `SANDBOX best-effort`; the engine still has no network code | same as Windows |
| Engine import check | `nm` | import-table scan in `build.ps1` | `nm` |
| USB probe detection | `/sys/bus/usb` | to do | to do |
| Status | tested in this release | scripts and CI ready, not yet run | scripts and CI ready, not yet run |

Every package carries `platform.txt` (`PLATFORM <os> <x64|arm64>`) and refuses to start on any other system.

Evidence records the operating system, its version and the CPU on every ledger entry, so results from a weaker
platform are always visible as such. A profile can demand `SANDBOX required` to accept Linux evidence only.
