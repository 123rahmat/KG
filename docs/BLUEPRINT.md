# Kindgleam: SIL and HIL Co-Verification Platform - Blueprint v3

> Release note: this blueprint describes the verification core. The current feature set (desktop app,
> generic interface, coverage gate G6, 34 self-test controls, packages for three systems and the optional
> local coding assistant) is summarised in `README.md`; the assistant is specified in `docs/ASSISTANT.md`.

Oct 26, 2026 · @Rahmat

## 1. Purpose and what is different

This platform proves that embedded firmware is safe by running the same tests in simulation (SIL), on the real processor (PIL) and on real hardware (HIL), then comparing the results with fixed, auditable Java programs. Engineers write the firmware themselves. The platform checks it and keeps the proof. It runs fully offline and is not built on any one industry's standard.

Many parts already exist separately: safety coding rules, simulators, and hardware test benches. What is uncommon is the combination below, and the blueprint is built around it.

1. **One test, three tiers.** The same test vector runs in SIL, PIL and HIL. The traces are compared signal by signal, so a bug that appears only on the real chip or the real board cannot hide.
2. **Fixed code decides.** Only deterministic programs issue PASS or FAIL. No opinion counts as evidence.
3. **The models are evidence too.** The plant model is versioned, hashed and calibrated against hardware. An uncalibrated model cannot count toward a PASS.
4. **The gates test themselves.** Known faults and known-bad code are fed in on purpose, and the system must catch every one. Mutation testing checks that the tests themselves are strong.
5. **Every run leaves tamper-evident proof.** Source, binary, traces, model and verdict are hash-chained and signed.
6. **One core, many rule sets.** Aerospace, automotive or any other rule set is a configuration file layered on top, never the foundation.
7. **Air-gapped by construction.** The tools have no network code and the sandbox has no network.

Engineers write all firmware. A harness of project memory, skills, local tool servers and evals (section 14) supports the engineer, but it has no authority over any verdict.

## 2. Non-negotiable principles

Every later section must obey these ten rules. A design that breaks one is rejected.

1. **Fixed code decides.** Only deterministic, reviewable programs may issue PASS or FAIL.
2. **Fail closed.** Missing data, an unknown state or a tool error counts as FAIL, never as pass.
3. **Zero external communication.** No network stack, no cloud call, no telemetry and no wireless initialization, in the tools or in the firmware.
4. **Static memory only.** No `malloc`, `calloc`, `realloc` or `free` in firmware. Every buffer has a size fixed at build time.
5. **One test, many tiers.** A requirement is verified by one test vector that runs in SIL and, where the profile demands, in PIL and HIL. The results must agree within set tolerances.
6. **Models are versioned evidence.** A plant model has a version, a hash and a calibration record against measured data.
7. **Gates are locked.** The firmware author cannot edit the Makefile, compiler flags, scanner, verdict program, profile or sandbox.
8. **Flat source folder.** All `.c`, `.h` and `Makefile` files live in one directory. Data (requirements, vectors, builds, traces, evidence) lives in separate data folders that contain no source.
9. **Evidence over trust.** A claim counts only if a hashed artifact in the ledger backs it.
10. **The harness helps but never approves.** Memory, skills, tool servers and evals save effort. None of them can issue or change a verdict.

## 3. What was wrong in v1, and the fix

Version 1 had the right instinct but twelve defects that would break it in practice or make it unsafe. Each is fixed in this blueprint.

| # | v1 problem | Why it matters | v3 fix |
| --- | --- | --- | --- |
| 1 | A review step, not fixed code, issued `TEST_PASS` | A review opinion is not proof and can miss the same errors as the author | Only the verdict program issues PASS or FAIL (section 9) |
| 2 | Register values were never checked against datasheets | A wrong address or bit field typed from memory looks right but fails on the chip | Register tables come from datasheets and are checked by a gate (sections 6 and 8) |
| 3 | SIL and HIL were two separate modes with no comparison | A bug that exists only on the real chip or board passes SIL unseen | Same test vector on every tier and a trace comparison gate (section 7) |
| 4 | Gate was a keyword search for `malloc` and `goto` | Easy to bypass with macros or indirect calls | Token-level scan, object-file symbol check, stack and size budget (section 8) |
| 5 | 200 Hz software ISR called a "hard" watchdog | A software check on the same CPU cannot catch a stuck CPU | Independent hardware watchdog plus supervisor (section 10) |
| 6 | Heartbeat was a toggled flag | A stuck loop can still toggle a flag | Progress token that proves tasks really finished (section 10) |
| 7 | Two `main` functions (`main.c`, `core_cli.c`) | Link error | Separate targets: firmware, simulator, tools (section 5) |
| 8 | `atomic_bool` with `-std=c99` | Needs C11, so the build fails | `-std=c11` for host tools, MCU cross-compiler flags per target |
| 9 | Makefile target names did not match and MCU code was built with host `gcc` | Commands fail, wrong binary | One verified target list, a cross-compiler per target |
| 10 | Flat-folder rule contradicted `include/ src/ cli/` | The rule was not actually followed | Truly flat source folder with name prefixes (section 5) |
| 11 | Sandbox used path-prefix checks | Bypassable with symbolic links and race conditions | Kernel isolation: namespaces, syscall filter, resource limits (section 11) |
| 12 | Missing: traceability, timing, coverage, mutation tests, signing, hardware interlock | A PASS cannot be trusted without them | Sections 8, 9, 12 and 13 |

## 4. Architecture: one test, three tiers, one fixed verdict

Engineers supply four inputs. Locked gates check them, the same test vector runs on three tiers, and only the verdict program can say PASS.

&#91;embedded content: architecture · 3 tiers, 1 verdict\]

Reading it top to bottom: the static gates run first and cost nothing. SIL gives fast, repeatable runs. PIL and HIL add the real chip and the real board, and nothing flashes to hardware before the human sign-off. The verdict program reads the traces and gate results and writes one signed ledger entry.

## 5. Workspace layout and build rules

This section is the engineer's project folder. The product's own layout, including the Java desktop app, is in section 5a.

All source files sit in one flat folder, `/workspace/`. A file's name prefix says what it is and who may edit it. Data folders hold no source code.

| Prefix | Contents | Engineer may edit? |
| --- | --- | --- |
| `fw_` | Firmware: application, drivers, protocol header | Yes |
| `wd_` | Watchdog and supervisor code | Yes, with a second reviewer |
| `sim_` | Plant models and the simulation harness | Yes, and every change needs a new calibration record |
| `tst_` | Test code. Vectors are data and live in `vectors/` | Yes, but deleting a test fails a gate |
| `gate_` | Scanner, coverage, timing, mutation and traceability tools | **No, locked** |
| `ver_` | Verdict program, trace comparer and ledger writer | **No, locked** |
| `rig_` | PIL and HIL rig control, trace capture and interlock monitor | **No, locked** |
| `sbx_` | Sandbox and process isolation | **No, locked** |
| `hrn_` | Harness: tool servers, memory loader, skill runner, eval runner | **No, locked** |
| `Makefile`, `profile.cfg` | Build rules and the rule set in force | **No, locked** |

Data folders (no source files inside):

- `spec/` holds requirements (`spec.req`), the design notes and datasheet-derived register tables.
- `vectors/` holds test vectors: inputs, injected faults and expected assertions, each tagged with a requirement ID.
- `models/` holds plant model parameters and their calibration records.
- `build/` holds objects, binaries and map files.
- `traces/` holds the recorded output of every SIL, PIL and HIL run.
- `evidence/` holds coverage reports, the hash-chained ledger and signed bundles.
- `memory/` and `skills/` hold the harness data (section 14).

**Build rules.** The firmware is compiled for the target microcontroller with its cross-compiler. The simulator and tools are compiled for the host. Both use strict flags (`-Wall -Wextra -Werror -pedantic`, plus `-fstack-usage` for stack budgets). Locked files are mounted read-only inside the sandbox, so they cannot change during a run.

## 5a. Languages, desktop app and product layout

All system and desktop code is Java. The only C is firmware: the code on the chip, the small PIL test helper on the chip, and the HIL bench controller. Jobs that need the operating system or hardware use existing, proven tools instead of custom C.

| Part | Language or tool | Note |
| --- | --- | --- |
| Firmware, PIL test helper, HIL bench controller | C | Runs on microcontrollers |
| SIL runner | Java, calling the firmware compiled as a host library through the Foreign Function and Memory API | Runs in its own process, so a firmware crash cannot touch the app or the coordinator |
| Plant models | Java | Used by SIL and by the PC side of PIL |
| Coordinator, CLI and agents | Java | One sequential agent chain |
| Gates, vector parser, trace checker and comparer | Java | Memory-safe parsing of every input file |
| Verdict and ledger | Java | SHA-256 and Ed25519 signatures come built into Java, so no outside library |
| Harness: memory, skills, evals, hooks | Java |  |
| Desktop app and simulated oscilloscope | Java with Swing (built into Java, no extra library) | Separate process from the coordinator, so a window crash never affects a run |
| Flashing and debug probe | OpenOCD, started by Java | Existing open-source tool |
| Serial and USB link | Java, plus one small pinned native library on Windows | See section 5b |
| Sandbox | The operating system's own isolation tools | See section 5b |
| Compilers | GCC or Clang cross-compiler for the chip, and the same compiler family for the SIL host library | Named in the profile |
| Build | Make, `javac`, `jlink`, `jpackage` | Builds fully offline |

**Java rules.** Java 25 (long-term support), split into Java modules. No third-party libraries at all; the desktop app uses Swing, which ships with Java. The Windows serial library is the only planned addition, pinned with its hash. A gate scans the compiled classes and fails the build if any networking class is used. `jlink` packs a trimmed Java runtime inside the product, so the target machine needs no Java installed.

**How the desktop app talks to the system.** The app starts the `kindgleam` command as a child process with a fixed argument list, never through a shell, and reads its machine-readable progress lines (`--format=lines`) and the run folders. It never decides PASS or FAIL, never opens hardware ports and never opens a network connection.

**Product source layout:**

```text
kindgleam/
  Makefile                 builds everything offline
  modules/
    kg.cli/                kindgleam command and coordinator
    kg.agents/             agent chain
    kg.gates/              gates, vector parser, trace checker, comparer
    kg.sil/                SIL runner and plant models
    kg.rig/                PIL and HIL adapters: OpenOCD, serial, USB
    kg.platform/           sandbox, serial and air-gap code per OS
    kg.verdict/            verdict and ledger
    kg.harness/            memory, skills, evals, hooks
    kg.app/                desktop window and navigation
    kg.scope/              simulated oscilloscope
    kg.spec/               requirement and vector editor
  firmware-support/        C: PIL test helper, HIL bench controller
  lib/                     pinned JavaFX and serial library, with hashes
  docs/                    this blueprint and guides
```

The engineer's project folder (section 5) is separate from the product, and one installed product can open many projects. The installed product (Java modules, the trimmed runtime and the pinned libraries) is covered by the signed tool baseline (section 12), so a changed file is detected before any run.

## 5b. Operating system support

The system supports every operating system version its vendor still maintains with security updates, on x64 and ARM64 processors. Versions the vendor no longer patches are not supported: an unpatched machine cannot be trusted to hold evidence, and Java 25 does not run on them.

| Operating system | Supported at launch | Sandbox | Serial and USB | Air-gap check |
| --- | --- | --- | --- | --- |
| Linux | Ubuntu 22.04 and 24.04 LTS, Debian 12, RHEL 9 and compatible | bubblewrap: namespaces, syscall filter, no network | Serial port opened as a file; probes through OpenOCD | Lists interfaces and refuses to run if any non-loopback one is up |
| Windows | Windows 10 22H2 and Windows 11 | Job Objects for limits, plus a firewall rule that blocks the job's network | Pinned native serial library; probes through OpenOCD | Same check through Java's interface list |
| macOS | The three most recent versions, Apple silicon first | Sandbox profile with network denied | Serial port opened as a file; probes through OpenOCD | Same check |

**Rules that keep every platform equal:**

1. **One platform module.** All OS-specific code lives in `kg.platform` behind one interface. Everything else is identical on every OS.
2. **Same result everywhere.** SIL uses the same pinned compiler family and floating-point flags on every OS. The correlation eval compares traces across operating systems, and any difference fails.
3. **Evidence names the platform.** Each ledger entry records the OS, its version and the processor. The profile can name which platforms count toward a PASS.
4. **Every release is tested on every supported OS.** Installers are built per OS with `jpackage`, and the full eval set runs on each.
5. **Clear support window.** New OS versions are added after they pass the full eval set. Versions leaving vendor support get six months' notice before they are dropped.
6. **No platform surprises in files.** Text is always UTF-8 with `\n` line endings, and paths, file locks and case sensitivity are handled only in `kg.platform`.

The Linux sandbox is the strongest of the three. On Windows and macOS the evidence records the weaker isolation, and the profile can require Linux for safety-critical PASS results.

## 6. Authoring workflow and roles

People write; fixed programs check. Each stage has a clear owner, the files it may write and a gate that must pass before the next stage starts. A stage cannot start until the previous output is saved and hashed.

| Stage | Role | Reads | Writes | Exit gate |
| --- | --- | --- | --- | --- |
| 0 | Systems engineer | Idea, schematic, datasheets | `spec/spec.req` (REQ-001 and up), register tables | G0 spec lint |
| 1 | Firmware engineer | Requirements | `fw_protocol.h`, `spec/design.md` (pins, registers, packets, task periods, timing budgets) | Header compiles alone; every REQ maps to a design item |
| 2 | Firmware engineer | Design | `fw_*.c`, `fw_*.h`, `wd_*.c` | G1 source policy |
| 3 | Build pipeline | Source | `build/` | G2 to G4 |
| 4 | Test engineer | Requirements, design | `tst_*.c`, `vectors/*.vec`, plant model in `sim_*` | G5 every REQ has tests |
| 5 | Rig and simulator tools | Binary, vectors, models | `traces/` for SIL, PIL and HIL | G6 to G10 |
| 6 | Independent reviewer | All of the above | `spec/review.md` | Recorded in the ledger. Advisory only |
| 7 | Verdict program | Evidence folder | Ledger entry and signed bundle | PASS or FAIL (section 9) |

Rules that apply at every stage:

- **Two-person rule.** For requirements the profile marks safety-relevant, the reviewer must be a different person from the author.
- **No silent edits to the checks.** Locked files cannot be changed from the working folder. Changing one creates a new tool baseline and forces a full eval run (section 14).
- **Tests only grow.** Deleting or weakening a test fails the run, because a requirement would lose its evidence.
- **Registers come from datasheets.** Any register address or bit field in the code must match the datasheet-derived table in `spec/`, and a gate checks this.

## 6a. Agent system: fixed programs that manage the work

The work after a code change is run by a chain of agents. Each agent is a small locked Java component (`agt_` files) with one job. None of them uses AI, and none of them writes firmware. A coordinator runs exactly one agent at a time and passes the work on, so no two agents ever touch the workspace together.

&#91;embedded content: agent chain · 10 agents, 1 coordinator\]

| Agent | Job | May write | Hands off when |
| --- | --- | --- | --- |
| Coordinator | Owns the job queue and workspace lock, starts each agent, enforces time limits, stops the chain | `jobs/`, the progress log | Never. It supervises the whole run |
| Intake | Hashes the workspace, finds what changed, and uses the trace map to list affected requirements | Job ticket | Change list written |
| Spec | Runs G0 and rebuilds the requirement trace map | `jobs/` report | G0 passed |
| Build | Fast or evidence build, then G1 to G5 | `build/` | Binary and budgets recorded |
| SIL | Runs the vectors for affected requirements, or all of them in an evidence run | `traces/sil/` | Traces written |
| PIL | Loads the binary on the chip or emulator and runs the same vectors | `traces/pil/` | Traces written |
| HIL rig | Rig health check, waits for the human token, flashes, runs vectors and bench checks | `traces/hil/` | Traces written, power safely off |
| Quality | Coverage, mutation, fault and timing gates (G6 to G9) | `evidence/` reports | All four gates recorded |
| Compare | Compares traces across tiers and checks model calibration (G10) | `evidence/` report | Comparison recorded |
| Verdict | Runs G11 and G12, reads every report, issues PASS or FAIL | Verdict file | Verdict written |
| Ledger | Appends the ledger, builds the bundle and the report | `evidence/ledger.log` | Entry hashed |
| Triage | On FAIL only: finds the first failing gate, requirement and tick, and the first baseline where it started failing | Triage report | Report sent to the engineer |
| Memory keeper | Between jobs: files run history, adds new facts proposed in reports to a review list | `memory/` | Entry dated and sourced |
| Eval scheduler | Between jobs: queues the evals in section 14 on schedule or on a tool change | Job queue | Evals queued |

**How agents hand off.** Agents never call each other and share no memory. Each one reads a job ticket in `jobs/` and writes a hand-off report next to it. The report holds the status (DONE, FAILED or BLOCKED), the hashes of everything it read and wrote, a duration, and a short reason on failure. The coordinator checks those hashes before it starts the next agent, so if anything changed in between, the chain stops.

**Rules for the chain:**

1. **One at a time.** The coordinator holds a single workspace lock. Only the agent holding it may run.
2. **Fixed order.** Agents cannot skip ahead or start another agent. Only the coordinator moves the chain on.
3. **Write lists.** Each agent is sandboxed (section 11) and can write only the folders in its row.
4. **Stop on the first failure.** A FAILED or BLOCKED report stops the chain and sends the job to Triage. A timeout counts as FAILED.
5. **Human hold point.** The chain pauses before HIL until a person confirms (G13). With no confirmation, the run ends at PIL and is marked incomplete.
6. **Resume, not restart.** After a stop the chain can resume from the failed agent, as long as the hashes of earlier outputs still match.

**Two modes.** In *watch mode* the coordinator starts a fast chain each time a file is saved (Intake, Spec, Build and SIL for the affected requirements, as in section 18). In *evidence mode* it runs the whole chain, which is the only way to get a PASS.

**Step-by-step visibility.** The coordinator writes a progress log that shows every agent's start, finish, duration, result and reason. The CLI shows it live (`kindgleam status`) and the report includes it, so the engineer always sees exactly which step is running and why a run stopped.

## 7. SIL, PIL and HIL co-verification method

The same test vector runs on three tiers, each tier writes a trace in the same format, and a locked program compares the traces. A requirement is verified only if every tier the profile demands passes and the traces agree.

| Tier | What runs | Plant (the thing being controlled) | Clock | What it catches |
| --- | --- | --- | --- | --- |
| SIL (software in the loop) | Firmware compiled for the host PC | Software model | Virtual, fixed step | Logic and control errors, missing requirements. Thousands of fast runs, including fault sweeps |
| PIL (processor in the loop) | The real target binary on the real chip, or a cycle-accurate emulator | Software model on the host, linked over the debug or serial port | Target hardware timer | Compiler and number-format differences, integer width, stack and memory use, execution time |
| HIL (hardware in the loop) | Real board with real peripherals | Real-time plant emulator or the real device, behind a hardware interlock | Target hardware timer, captured by an independent logic analyzer | Peripheral and electrical behavior, real timing, real watchdog action, noise |

**Test vector.** One text file in `vectors/` holds the requirement ID, a fixed random seed, duration in ticks, the input timeline, the injected faults on a timeline, and the expected assertions. The same file is read by all three tiers.

**Trace.** Every tier writes one line per tick: tick number, inputs, outputs, a hash of the internal state, and flags such as watchdog tripped and safe state active. Real hardware time stamps come from a hardware timer, aligned to tick 0 by a start trigger.

**How traces are compared.** The profile sets the rules. Defaults:

| Signal kind | Rule |
| --- | --- |
| Discrete outputs, state hash, flags | Must match exactly, tick by tick |
| Analog values | Within an absolute and a relative tolerance set per signal |
| Event order | Must be identical across tiers |
| Reaction latency (fault to safe output) | Measured value within the profile limit, and within a stated margin of the SIL model value |

If any rule fails, the comparer reports the first tick where the traces diverge and the signals involved. It does not guess which tier is right.

**Plant model validation.** A model is only evidence if it is calibrated. A fit gate compares the model's step response with measurements from the rig or the real device and fails if the error exceeds the profile limit. An uncalibrated model produces SIL results labeled `UNCALIBRATED`, and these cannot count toward a PASS.

**Fault injection parity.** One shared fault catalog, with IDs, runs on every tier. Faults include a hung task, stuck output, sensor open and short, noisy sensor, corrupted packet, supply brown-out and clock drift. SIL injects them in software, and HIL injects them through a switching board.

**Determinism.** SIL uses virtual time only, never the wall clock. Random numbers come from the seed. Floating-point settings and compiler flags are fixed, and run-to-run differences in the same tier fail the flaky-test eval (section 14).

**Which tier a requirement needs** is set in the profile. By default, logic requirements need SIL and PIL. Timing, watchdog, power and peripheral requirements need HIL as well.

## 8. Gate catalog

Thirteen automatic gates (G0 to G12) and one human gate (G13) stand between a code change and a PASS. Every gate is a small, auditable Java program or a fixed standard tool. Thresholds come from `profile.cfg`, so the same gates serve any industry rule set.

| Gate | Name | What it checks | Fails when |
| --- | --- | --- | --- |
| G0 | Spec lint | Requirements are numbered, unique and testable | A requirement has no ID or no measurable limit |
| G1 | Source policy | Token-level scan that skips comments and strings | Banned call or keyword found (`malloc`, `free`, `goto`, `system`, `socket` and others) |
| G2 | Strict build | `-std=c11 -Wall -Wextra -Werror -pedantic` with locked flags | Any warning or error |
| G3 | Object symbols | Symbol table of the linked binary | Forbidden symbol present, even if the source scan missed it |
| G4 | Budgets | Stack depth, flash and RAM use | Any budget in the profile exceeded |
| G5 | Requirements and registers | Each REQ has at least one test, and every register address and bit field in the code matches the datasheet table | A REQ has no test, a test was deleted, or a register does not match |
| G6 | Coverage | Statement and branch coverage from SIL runs, plus on-target coverage where the chip supports it | Below the profile threshold |
| G7 | Mutation testing | The tool makes small deliberate bugs in the firmware (flip a comparison, shift a limit, remove a watchdog kick) and reruns the tests | Fewer mutants caught than the profile requires |
| G8 | Fault injection | Hang, stuck output, sensor loss, corrupted packet, brown-out and clock drift on every required tier | Any fault is not contained in the safe state within the latency budget |
| G9 | Timing | Measured worst-case run time of each task on PIL and HIL | A task exceeds its budget or misses a deadline |
| G10 | Co-verification | Trace comparison across tiers and plant model calibration (section 7) | Any trace outside tolerance, or an uncalibrated model |
| G11 | Gate self-test | Negative controls: known-bad code, known-bad traces and known faults the gates must reject | Any known-bad input is accepted |
| G12 | Evidence integrity | All hashes in the ledger match the files on disk, and tool hashes match the baseline | Any mismatch or missing artifact |
| G13 | Human sign-off | A person reviews the PASS bundle before real hardware is flashed (section 13) | No recorded confirmation |

## 9. Deterministic verdict and evidence ledger

The verdict program `ver_verdict.c` is the only thing allowed to say PASS. It contains no network code, uses static memory, and is small enough for a person to read in one sitting.

**Verdict rule.** PASS is issued only if every automatic gate (G0 to G12) passed and every requirement has at least one passing, hashed test result. Anything missing, unreadable or inconsistent gives FAIL. A FAIL names the first violated gate and, for timing faults, the exact tick.

**Ledger.** Each run appends one entry to `evidence/ledger.log`. An entry holds:

- the run number and the hash of the previous entry, so changing history breaks the chain;
- the hash of the source set, the binary, the SIL, PIL and HIL traces, the coverage report and `profile.cfg`;
- the plant model version and calibration record, the toolchain baseline hash and the log of every harness session;
- every gate result, and the final verdict.

**Hashing and signing.** Hashes are SHA-256, computed with Java's built-in SHA-256, so there is no outside library. The finished bundle is signed with a key that lives on an offline machine or hardware token, never on the build machine. Anyone can later verify a bundle without the build tools.

## 10. Watchdog and fault containment

A real safety watchdog must work even when the main processor is stuck, so v3 uses four layers. The 200 Hz rate (5 ms) is the default and is set in `profile.cfg`, not fixed by this document.

1. **Independent hardware watchdog.** An external watchdog chip, or the microcontroller's independent watchdog running on its own clock, in windowed mode. Kicking it too early or too late both trigger a reset.
2. **Progress token.** The value used to kick the watchdog is built from a checksum of the tasks that really finished this cycle, in order. A loop that only toggles a flag cannot produce it.
3. **200 Hz supervisor.** A timer interrupt checks task deadlines, stack canaries and the token. It only sets flags and writes a few bytes to RAM. It never writes flash or non-volatile memory.
4. **Fail-safe outputs.** Hardware defaults de-energize everything: pull-downs on PWM lines and normally-open relays. The safe state does not depend on software still running.

After a reset, the boot code reads the retained RAM record and writes it to non-volatile storage, so the failure is logged without doing risky work inside an interrupt.

**In simulation (SIL)**, the watchdog is a software model that applies the same trip rules. The evidence labels it as a model. Real behavior is proven later on hardware (section 13) by deliberately stopping the heartbeat and measuring how fast the outputs go safe.

**Trip latency budget.** The profile sets the maximum time from a missed heartbeat to a safe output. Gate G8 measures it and fails the run if it is exceeded.

## 11. Sandbox and air-gap enforcement

Every compile, simulation and test runs inside a sandbox that uses the operating system's own isolation instead of string checks on file paths, because string checks can be bypassed with symbolic links and timing tricks.

| Control | How it works |
| --- | --- |
| No network | Each job runs in a new network namespace with no interfaces, so even a bug cannot open a connection |
| Syscall filter | A seccomp allow-list lets through only the file, memory and process calls the compiler and simulator need |
| File access | Path resolution stays beneath `/workspace/` using `openat2` with `RESOLVE_BENEATH`, and symbolic links are not followed |
| Locked files | Gate, verdict, rig, sandbox, harness, Makefile and profile are bind-mounted read-only |
| Resource limits | CPU time, memory, file size and process count are limited with `rlimit`. The parent kills the whole process group on timeout and logs `TIMEOUT_ABORT` |
| Clean environment | Fixed locale, time zone and `SOURCE_DATE_EPOCH`, so builds do not vary between runs |
| Device access | Only the debug probe and serial port named in `profile.cfg` are passed into the job. HIL jobs additionally need the human confirmation token (section 13) |
| Air-gap self-check | At start the CLI refuses to run if any non-loopback network interface is up |
| Tool integrity | The hash of every gate, verdict and rig program is checked against the signed baseline before each run |

Tool servers (section 14) talk only over local pipes or Unix sockets. They never listen on a network port.

## 12. Reproducibility, traceability and qualification

**Pinned toolchain.** The compiler, linker, simulator, debug-probe software and every gate program are recorded by version and hash in a signed baseline. Any change creates a new baseline and forces a full eval run (section 14). Builds use fixed flags and `SOURCE_DATE_EPOCH`, so the same source gives the same binary.

**Traceability.** A tool builds a matrix from requirement to design item to source symbol to test vector to result on each tier. A requirement with no test, or a test with no requirement, fails the run.

**Configuration management.** Each baseline is a set of hashes that is signed and stored. The engineer's source, the vectors, the plant model, the profile and the tools are all part of it, and the ledger entry names the exact baseline used.

**Tool qualification.** The gate, comparer and verdict programs are kept small on purpose so they can be reviewed line by line. Their own tests are the negative controls in G11 and the mutation runs in G7, and both run on every build. This is the evidence an auditor asks for when a rule set demands that the tools be shown to work.

**Rig qualification.** Before every HIL session the rig runs a health check: loopback test, sensor calibration check and interlock test. The result is stored in the ledger. A session without a passing health check cannot produce evidence.

## 13. HIL rig and hardware safety

Real hardware is where a mistake can cause damage, so the rig has fixed parts and fixed safety controls that nobody can skip. The sizes below are design targets to be confirmed for the first chip.

| Rig part | Job | Design target |
| --- | --- | --- |
| Device under test | The real board, flashed and debugged through a probe | Same board revision as production |
| Plant emulator | Behaves like the real device: sensors, loads, motors or thermal response | Runs the plant model at least 10 times faster than the control loop |
| Fault injection board | Opens, shorts or sticks signals using relays and analog switches | Every fault in the shared catalog can be applied from the vector file |
| Programmable supply | Powers the board, with current limit and brown-out profiles | Hardware current limit set below the damage level |
| Independent logic analyzer | Measures real timing without using the board's own clock | Resolution at most one twentieth of the watchdog window |
| Data acquisition | Records analog signals for trace comparison | Sampling at least 10 times the fastest signal of interest |
| Hardware interlock | Cuts power on emergency stop, over-current or over-temperature, independent of all software | Tested before every session |
| Rig controller | Air-gapped host that runs `rig_` programs and writes traces | No network interface |

**Safety rules for every HIL session:**

1. **Verdict first.** Only a binary whose bundle passed G0 to G12, and whose hash matches the bundle, can be flashed.
2. **Human confirmation (G13).** A person reviews the bundle and confirms the flash at the console. Unattended flashing is off by default and can only be enabled in the profile by the owner.
3. **Rig health check.** Loopback test, sensor calibration check and interlock test must pass in the same session.
4. **Physical interlock.** Load disconnected by default, current-limited supply and an emergency stop that works without software.
5. **Port allow-list.** Only the probe and serial device named in `profile.cfg` can be opened, never a general `/dev/tty*` match.
6. **Read-back verification.** After flashing, the tool reads the memory back and compares its hash with the binary.
7. **Automatic abort.** If any limit in the profile is crossed during a test, the rig cuts power and records the tick.
8. **Watchdog proof on real hardware.** A test deliberately stops the heartbeat and measures, with the logic analyzer, how fast the outputs go safe.

## 14. Harness: memory, skills, tool servers and evals

The harness is the working environment around the gates. It saves the engineer effort and keeps knowledge from being lost, but it cannot approve anything. All harness programs are locked (`hrn_` files) and run offline.

| Part | What it is | Rules |
| --- | --- | --- |
| Project memory | Plain files in `memory/`: an append-only decision log, hardware facts (errata, pin quirks, measured values with their source and date), a run history index and a known-issues list | Every entry names a source and a date. The decision log is hashed into the ledger. A memory entry never becomes a requirement without the owner's approval |
| Skills | Versioned procedure packs in `skills/`. Each is a checklist plus scripts plus the evidence it must produce | A skill cannot skip a gate. Starting set: add a requirement, bring up a peripheral, add a fault case, calibrate the plant model, flash and verify, triage a regression |
| Tool servers | Small local servers that expose typed tools over pipes or Unix sockets, in the style of MCP: `gate_run`, `sim_run`, `pil_run`, `hil_run`, `trace_compare`, `memory_query`, `ledger_read` | Offline only. Each tool has a read or write permission. `hil_run` needs the human token. No tool can edit locked files or write a verdict |
| Evals | Automatic checks of the verification system itself (list below) | Run on every tool baseline change and on a schedule |
| Hooks | Small actions that fire at fixed moments | Before commit: run G0 to G2. Before flash: check verdict and human token. After a run: append the ledger. At session start: verify tool hashes |

**Evals.** These prove the verification system still works, not that the firmware is good:

1. **Gate self-test.** Known-bad code, traces and faults must be rejected (G11).
2. **Mutation testing.** Deliberate bugs in the firmware must be caught by the tests (G7).
3. **Correlation regression.** Stored golden traces are replayed. Any drift between tiers beyond tolerance fails.
4. **Flaky-test detector.** Each test runs many times with different seeds. Any run-to-run difference in the same tier fails.
5. **Model regression.** The plant model is rerun against its calibration data after any change.
6. **Rig health.** The HIL rig is checked before each session (section 12).
7. **Baseline eval.** Any compiler, tool or profile change triggers the full eval set before new results are accepted.

## 15. Threat model

The main risks are quiet mistakes that let a bad build look good, and mistakes on real hardware. Each risk below has a named control.

| # | Threat | Control |
| --- | --- | --- |
| 1 | A failing test is deleted or loosened so the run passes | Tests only grow (G5). Mutation testing exposes weak tests (G7) |
| 2 | Warnings are silenced with pragmas, flag edits or disabled checks | Locked Makefile and flags, pragma ban in the source scan (G1), strict build (G2) |
| 3 | A gate, verdict or rig program is modified | Signed tool baseline and hash check (G12), read-only mounts, gate self-test (G11) |
| 4 | The plant model is tuned until the results pass | Calibration against measured data (G10), model versioning, second reviewer on any `sim_` change |
| 5 | Wrong register address or bit field from memory or a copy error | Datasheet-derived tables checked by G5. Errata kept in memory with source and date |
| 6 | A bug exists only on the real chip or the real board | PIL and HIL tiers with trace comparison (G10) |
| 7 | A test passes sometimes and fails sometimes | Fixed seeds, virtual time, flaky-test detector (section 14) |
| 8 | The HIL rig is miscalibrated and records wrong evidence | Health check before every session and a stored record (section 12) |
| 9 | The wrong binary is flashed, or the load is damaged | Verdict-first rule, hash match, human confirmation (G13), interlock, read-back |
| 10 | The ledger or evidence is altered afterwards | Hash chain, signature from an offline key, evidence integrity check (G12) |
| 11 | Data leaves the building | No network namespace, air-gap self-check, no network code in any tool. Exports are signed bundles only, moved by a one-way process |
| 12 | A malformed vector, datasheet table or trace crashes or fools a parser | Fixed-size parsers, fuzz testing, parsing inside the sandbox |
| 13 | One person writes and approves the same work | Two-person rule for safety-relevant requirements |
| 14 | The signing key is stolen or misused | Offline key or hardware token, rotation, two signatures for a release |

## 16. Target profiles: existing chips and new custom chips

One firmware source supports two kinds of target, chosen by a target profile file. The firmware never contains a chip's addresses directly. It reads them from the profile, and gate G5 checks the profile against the datasheet table.

| Profile type | Example | Where register data comes from | Extra checks |
| --- | --- | --- | --- |
| Existing silicon | An off-the-shelf microcontroller such as an STM32 part | Vendor datasheet and reference manual, converted to a table in `spec/` | Errata list in project memory, with source and date |
| New custom chip | Your own RISC-V or ASIC design | The chip's register specification, version-stamped | Register table must match the chip's hardware description version. PIL runs on an emulator of the chip until silicon exists |

Each profile (`tgt_<name>.h` plus `spec/<name>.reg`) states clock speed, memory base and size, register addresses, pin map, the cross-compiler and the debug probe. A run records which profile and which version it used, so evidence for one chip is never mistaken for another.

## 17. Lab bench checks, the single report and the commands

One command runs firmware tests and hardware bench checks together and prints one report. Every line in that report must point to a measured value and a stored trace. A result that is typed into the code as `true` is not allowed, and gate G11 includes a test that catches it.

**Hardware bench checks (HIL only):**

| Check | What is measured | Fails when |
| --- | --- | --- |
| Quiescent current | Supply current at idle on each rail | Above the profile limit |
| Clock and PLL lock | Measured clock frequency and lock flag | Drift beyond tolerance or no lock |
| Signal integrity | Noise floor and crosstalk on analog inputs | Above the profile limit |
| Closed-loop step response | Settling time and overshoot | Outside the requirement |
| Brown-out recovery | Supply dipped to a set voltage | Data lost or unsafe output during the dip |
| Watchdog timing | Heartbeat jitter and trip latency, from the logic analyzer | Jitter or latency above the limit |
| Fault injection recovery | Each catalog fault applied by the switching board | Safe state not reached in time |

**Commands.** The CLI is a Java program packaged with its own runtime:

- `kindgleam check` runs G0 to G5 only, in seconds.
- `kindgleam verify --tier=sil` runs the full SIL suite.
- `kindgleam verify --tier=pil` runs on the real chip.
- `kindgleam verify --tier=hil --bench` asks for the human confirmation, then runs HIL and bench checks.
- `kindgleam report <run>` prints the report for a stored run.
- `kindgleam ledger verify` checks every hash and signature.

**The report** lists target and profile version, tier, each requirement with its result per tier, each bench check with its measured value and limit, the gate results, and the final verdict. A FAIL names the first failing gate, the requirement and the tick. The report is produced from the ledger, never typed by hand.

## 18. Fast feedback loop

The engineer gets a fast answer while working, but only the full evidence build can produce a PASS. The two builds are kept apart so speed never weakens the proof.

|  | Fast loop (while editing) | Evidence build (for a PASS) |
| --- | --- | --- |
| Rebuilds | Only changed files, using header dependency tracking (`-MMD`) and an object cache | Clean build from nothing |
| Optimization | `-O0 -g` for quick compiles and easy debugging | The exact flags that ship, from the profile |
| Tests | Static gates plus the SIL tests linked to the changed requirements | Every gate and every required tier |
| HIL loading | Firmware may be loaded into the chip's RAM to save flash wear | Flashed to flash memory exactly as shipped, then read back |
| Result | Advice only, never written as evidence | Ledger entry and signed bundle |

Testing at `-O0` alone is not enough, because some bugs only appear with the shipping optimization level. That is why the evidence build always uses the shipping flags.

## 19. Interfaces and fit with existing tools

Companies already own compilers, test racks and debug probes, so Kindgleam uses them through adapters instead of replacing them. Its own value is the part they lack: one test vector across tiers, trace comparison, self-testing gates and signed evidence.

| Area | Existing tools it can drive | How |
| --- | --- | --- |
| Compilers | GCC, Clang and certified commercial compilers | Named in the profile. Kindgleam only calls them |
| Flashing and debug | OpenOCD, J-Link and vendor probes | `rig_` adapters with a fixed command set |
| Processor emulation | QEMU or a vendor emulator | Used as a PIL tier before silicon is available |
| Test racks | Commercial real-time HIL racks | An adapter that sends vectors and reads traces in Kindgleam's format |
| Unit test code | Existing C unit tests | Wrapped as SIL tests and tagged with requirement IDs |
| Bus interfaces | UART, SPI, I2C, GPIO, CAN and CAN FD, LIN, RS-485 | Bus adapters on the rig, each with its own fault cases |

The central piece is one abstraction header, `sim_bridge.h`, used by both the SIL harness and the rig: initialize, step one tick, read the trace line, inject a fault. Because SIL and HIL share it, the same vector and the same comparer work on both.

## 20. Build phases and gates

The build is seven phases in order, and no hardware is needed until phase 4. Phases are not drawn to scale. Each diamond is the gate that must pass before the next phase starts.

&#91;embedded content: roadmap · 7 phases, 7 gates\]

The gate kernel comes first on purpose: the verdict, scanner and self-test are the foundation, so they must work before any firmware is checked by them.

## 21. Open decisions for the owner

These choices change the first build, so they need an answer before coding starts.

1. **First target chip.** Which microcontroller and board (STM32, NXP, ESP32 or another)? This sets the cross-compiler, debug probe and the PIL method.
2. **First plant.** Which device does the first demo control: a thermal element, a motor, a power converter? This sets the plant model and the fault catalog.
3. **HIL rig budget.** Build a minimal rig first (one board, programmable supply, logic analyzer, relay board) or the full rig in section 13?
4. **Vector and trace format.** A simple text format that is easy to inspect by eye, or a compact binary one?
5. **Orchestrator language.** Decided: Java for all system and desktop code, C for firmware only (section 5a).
6. **Signing method.** Offline machine with a software key, or a hardware token?
7. **First rule set.** Start with no external standard and add profiles later, or begin with one profile (for example an automotive-style or aerospace-style set of thresholds)?
8. **Default tick rate.** Keep 200 Hz as the default, or choose per plant?

## 22. Build status (as built 2026-10-26)

Phases 1 to 4 of the roadmap are built and tested on Linux, plus the desktop app and the PIL tier against a simulated board. Real-chip PIL and the HIL bench are written up to the hardware boundary and stop with BLOCKED until hardware is connected.

| Part | State | Evidence |
| --- | --- | --- |
| Gate kernel, verdict, signed ledger | Done | 27 negative controls pass on every run |
| SIL tier, plant and watchdog models | Done | 10 vectors, bit-identical reruns |
| G7 mutation testing | Done | Found weak demo tests (50%, then 70%); fixed to 100% of meaningful bugs |
| G14 signed safe operating limits | Done | Over-limit value, edited limits and raised safety constant all rejected |
| PIL, simulated board, link protocol | Done | 38,000+ requests per run with injected corruption; SIL = PIL every tick |
| G15 target identity, G16 link integrity | Done | Wrong chip and wrong board refused before running |
| On-chip C link and PIL handler | Done, needs board hooks | C and Java agree on 500 random frames |
| Harness: memory, skills, evals, hooks | Done | Tampered memory and a bad commit both caught |
| Desktop app with simulated oscilloscope | Done (Swing) | Screenshots of live runs and SIL/PIL overlay |
| Real-chip PIL, HIL bench runner | Pre-flight only | Needs target board, probe and bench |
| Windows and macOS | Paths and launchers in place | Untested |

New gates added while building: G14 safe operating limits, G15 target identity, G16 link integrity, and eval checks E1 (flakiness) and E2 (golden-trace drift). In all, 20 planted bugs and attacks were each caught.
