# Kindgleam

An offline SIL / PIL / HIL co-verification system for embedded firmware, with a desktop app and an
optional local coding assistant.

Engineers write the firmware in C. Kindgleam checks it with fixed, auditable gates,
runs the same test vectors in simulation (SIL) and on the target processor (PIL), compares the results
tick by tick, and records signed, tamper-evident evidence. Nothing talks to the network, and **only the
fixed verdict code can say PASS**. The assistant can propose code, but it has no say in any verdict.

```
requirements + interface + firmware (C) + plant model + test vectors
        |
   static gates  G0 G1 G2 G3 G4 G5 G14         spec, source policy, strict build, symbols, stack, coverage of reqs, limits
        |
   SIL  ->  G8 G10 G6 G7 G11                   assertions, repeatability, code coverage, mutation testing, gate self-test
        |
   PIL  ->  G15 G16 G10 G9                     target identity, link integrity, SIL vs PIL tick by tick, timing
        |
   HIL  ->  G13 + bench                        human sign-off, physical interlocks (pre-flight in this release)
        |
   G12 integrity -> Verdict -> signed ledger -> memory
```

## What is in this folder

| Path | What it is |
| --- | --- |
| `bin/` | Launchers: `kindgleam` (CLI) and `kindgleam-app` (desktop app); `.cmd` versions for Windows |
| `modules/` | Java source, one folder per module (see below) |
| `engine/` | The assistant engine: C++17 source (`src/`), its reference test and fuzz tests (`test/`) |
| `model/` | `MODEL.txt` pins the one model file the assistant may run; its licence; the model itself once installed |
| `firmware-support/` | On-chip C: link protocol and PIL handler for real boards |
| `selftest/` | Known-bad inputs every gate must reject on every run (G11) |
| `skills/` | Step-by-step procedures for common jobs |
| `examples/` | `heater-demo`, `valve-demo` (second-order plant with end stops) and `fmu-thermal` (FMI 2.0 plant) |
| `docs/` | Blueprint, formats, hardware bring-up, security, platforms, assistant, first run, acceptable use |
| `Makefile`, `build.ps1` | Offline build for Linux/macOS and for Windows |
| `package.sh`, `package.ps1` | Build the ready-to-run package for this computer's system |

Java modules: `kg.core` (safe files, parsers, process runner, platform check) · `kg.gates` (all gates) ·
`kg.sil` (SIL runner, plant models, FMU loader, watchdog model) · `kg.rig` (link protocol, detection, PIL,
flash safety) · `kg.verdict` (verdict, ledger, keys) · `kg.harness` (memory, skills) · `kg.assist` (model seal,
engine client, scope guard, write-check-fix loop) · `kg.cli` (coordinator and agents) · `kg.app` (desktop app).

## Install (desktop app)

| System | File | How |
| --- | --- | --- |
| Windows | `Kindgleam-<version>.msi` (or `.exe`) | Double-click; adds a Start-menu entry and a desktop shortcut |
| macOS | `Kindgleam-<version>.dmg` | Open it and drag Kindgleam to Applications |
| Linux | `kindgleam_<version>.deb` or `Kindgleam-<version>-linux-x64.tar.gz` | `sudo apt install ./kindgleam_*.deb`, or unpack and run `Kindgleam/bin/Kindgleam` |

Each app carries its own Java runtime: nothing else to install. On first start it creates this computer's signing
key and seals the installed tools (one click). Everything Kindgleam writes for you goes to your own folder,
`~/.kindgleam` (Windows: `C:\Users\<you>\.kindgleam`): keys, settings, the tool seal, the assistant model and your
projects in `~/.kindgleam/projects/`.

Like VS Code's own folder, `~/.kindgleam` is looked for on every start. After an update or a reinstall the app finds
it and carries on: same key, same settings and model, and every project in `~/.kindgleam/projects/` is listed again,
including folders you copied in by hand. On a new computer the folder is created. To move to another computer,
copy the projects (and the `keys` folder if you want the same signing identity).

Installers that already contain the assistant model are built by `.github/workflows/release.yml`: GitHub's build
machines download the model, check its fingerprint and build all installers (Run workflow, or push a tag `v3.0.0`).
To build an app on your own computer: `sh tools/get-model.sh model` (optional, puts the model in), then
`./packaging/make-app.sh` (Linux, macOS) or `packaging\make-app.ps1` (Windows). Without the model, the app still
works; the assistant asks you to run `tools/get-model` once.

## Requirements

- Java 21 or newer (JDK). Java 21 builds with `--enable-preview`; Java 22+ needs no flag. Java 25 LTS recommended.
- GCC or Clang with `make` and `nm` (Linux, macOS); on Windows MinGW-w64 `g++` or Visual Studio Build Tools.
- For the assistant: 4 GB of RAM is enough (1.5 GB in use while it answers), plus 1.1 GB of disk for the model.

## Quick start

```sh
make                                   # 9 Java modules, link helper and assistant engine; warnings are errors
bin/kindgleam keygen                   # once per computer: Ed25519 signing key in ~/.kindgleam/keys (or $KINDGLEAM_KEYS)
bin/kindgleam baseline                 # signs the installed tool files; any later change is detected
sh examples/setup-demo.sh              # puts your key fingerprint in the demo profile and signs its board limits

cd examples/heater-demo
../../bin/kindgleam check              # fast: spec, limits, strict build              (~1 s)
../../bin/kindgleam verify             # full SIL chain with verdict and ledger entry   (~1 min)
../../bin/kindgleam verify --tier=pil  # adds PIL against the simulated board           (~1 min)
../../bin/kindgleam eval --accept-golden
../../bin/kindgleam ledger-verify
```

Desktop app: `bin/kindgleam-app` (Windows: `bin\kindgleam-app.cmd`). The left bar lists your projects, each in its own
folder (workspace) with its own firmware, runs, evidence and history; **New project** creates one from a blank C
controller template (it passes every gate, PIL included, out of the box) or from an example. The right bar holds the
pages: Overview, Code (editor, markers, assistant), Runs (with each requirement's margin), Oscilloscope,
Requirements, Evidence and Settings.

## The coding assistant (optional, off by default)

One model, used unchanged: Qwen2.5-Coder-1.5B-Instruct, 4-bit, 1.1 GB, Apache-2.0. Kindgleam's own C++ engine
runs it on the CPU (no GPU needed). Download the file once from the address in `model/MODEL.txt`, then:

```sh
bin/kindgleam model install qwen2.5-coder-1.5b-instruct-q4_k_m.gguf   # checks the published fingerprint, seals it
bin/kindgleam model status
```

Turn it on in Settings. It lives beside the editor on the **Code** page:

- Kindgleam's own checks mark problems on your code as you type and after every run: compiler errors and source
  policy (red), lines a planted bug changed without any test noticing (amber), and code no test runs (grey).
- Click a marker to ask the assistant to fix that line, or use **Fix this file**, **Explain**, **Review last run**,
  or describe what to write (in the open file or a **New file**). After each run it can review the results in the
  background and put its suggestions on the exact lines (accent colour).
- Every code proposal is built and checked with gates G0-G4 on a scratch copy, failures go back to it automatically
  (up to three attempts), and you see a diff to **Apply** or **Reject**. It never runs SIL, PIL or HIL itself and has
  no say in any verdict. See `docs/ASSISTANT.md`.

## Commands

| Command | Does |
| --- | --- |
| `keygen` / `fingerprint` | Creates the signing key / prints this computer's `LEDGER_KEY_FP` line |
| `baseline` | Signs the list of installed tool files |
| `sign-limits` | Signs the project's `limits.cfg`; only the key holder can change board limits |
| `check` | Intake, Spec and Build agents only. Advisory, no verdict |
| `verify [--tier=sil\|pil\|hil]` | Full agent chain, verdict, signed ledger entry, memory update |
| `eval [--accept-golden]` | Repeatability, golden-trace drift, gate self-test, tool integrity |
| `status` / `report run-NNNN` | Progress log of the latest run / report of any run |
| `ledger-verify` | Verifies the whole evidence ledger |
| `memory add\|list\|verify` / `skill list\|show` | Project memory / procedures |
| `model status\|install <file>\|verify` | The assistant's model: check, install and seal, full re-hash |
| `install-hooks` | Git pre-commit hook that runs `check` |

Add `--format=lines` for machine-readable output (used by the desktop app) and `--project=<dir>` to point at a project.

## Gates

| Gate | Checks |
| --- | --- |
| G0 | Every requirement is numbered, unique, has a measurable number and names its tiers |
| G1 | Firmware source: no heap, goto, I/O, pragmas, asm; only allowed headers |
| G2 | Strict build: C11, `-Wall -Wextra -Werror -pedantic -Wconversion ...`, freestanding |
| G3 | Linked firmware object needs no outside symbol at all |
| G4 | Every stack frame static and within the profile limit |
| G5 | Every requirement has a test vector; every vector names a real requirement |
| G6 | Line and branch coverage of the firmware by the vectors meets the profile minimum |
| G7 | Mutation testing: planted bugs must be caught; reviewed equivalents are capped at 30% |
| G8 | Every vector's assertions hold, including injected faults |
| G9 | Step time within the interface's timing budget (real target only; the simulated board only notes it) |
| G10 | Traces repeat bit-for-bit, and SIL and PIL agree tick by tick within each signal's tolerance |
| G11 | 34 negative controls: every gate rejects known-bad input (41 when Python is installed) |
| G12 | Inputs unchanged during the run, tools match the signed baseline, ledger intact |
| G13 | Human sign-off before hardware (HIL) |
| G14 | Every test value and firmware safety constant inside the signed board limits |
| G15 | The connected target is the right board, chip and firmware |
| G16 | The link held: every corrupted frame detected and recovered |
| G17 | Optional, off unless a project has `tests/gen_*.py`: Python test generators (see `docs/FORMATS.md`) |
| E1, E2 | Eval only: flakiness and golden-trace drift |

## Packages

`./package.sh` (Linux, macOS) or `.\package.ps1` (Windows) builds `dist/kindgleam-<os>-<arch>` and a compressed
copy. Each package contains `platform.txt` and refuses to start on a different system or CPU family, plus
`SHA256SUMS` and `VERIFY.txt` so anyone can check that no file was changed. If the model file is in `model/`
it is checked against the pinned fingerprint and packed unchanged. `.github/workflows/build.yml` builds and
tests all three systems. First-run steps, including the one-time Windows and macOS warnings for unsigned
programs, are in `docs/FIRST_RUN.md`.

## What this release proves, and what it does not

Proven here (Linux): the full SIL and PIL chains on two example projects and an FMU plant; PIL against a
simulated board with injected byte corruption; 34 self-test controls; the assistant engine matching an
independent reference implementation (tokenizer exactly; logits within 0.0003% in exact mode, correlation
0.9999 in fast mode, and portable kernels equal to the AVX2 ones); a full-size model shape running at 6.5 tokens/s
on 2 cores in 1.5 GB; 300 corrupted model files and 131 hostile requests handled without a crash under
AddressSanitizer; the assistant loop catching broken and
harmful proposals; a fresh unpacked package passing a full verify.

Not yet proven: Windows and macOS builds (scripts and CI are ready but have not run); the assistant with the real
1.1 GB model (this build machine cannot download it; the engine is checked against a small model of the same
design instead); PIL on a real chip and HIL on a real bench. The HIL tier stops with BLOCKED rather than
pretending. See `docs/HARDWARE.md` and `docs/PLATFORMS.md`.
