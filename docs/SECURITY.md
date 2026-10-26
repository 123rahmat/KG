# Security and safety controls

Every control below is enforced in code and was tested by planting the attack in a copy of the demo
project. Each attack had to produce FAIL; none did otherwise.

## Attack results (this release)

| Attack | Caught by | Result |
| --- | --- | --- |
| Delete the 90 C hard cutoff from firmware | G8 (boundary vector at exactly 90 C) | FAIL |
| Weaken the open-sensor check (`<=` to `<`, or off) | G8 (boundary vector at exactly -40 C) | FAIL |
| Firmware stops proving progress to the watchdog | G8 | FAIL |
| `malloc` in firmware | G1 | FAIL |
| `malloc` hidden behind a token-pasting macro | G3 (object symbols) | FAIL |
| `#pragma` to silence a warning | G1 | FAIL |
| Delete a test vector | G5 | FAIL |
| Test value above the board's rated limit | G14 | FAIL |
| Loosen limits.cfg without the owner's key | G14 (signature) | FAIL |
| Raise a firmware safety constant above its limit | G14 | FAIL |
| Invent an excuse for a surviving mutant | G7 (stale review) | FAIL |
| Symbolic link smuggled into vectors/ | Intake | FAIL |
| Change a verdict in the ledger | G12 and ledger-verify | FAIL |
| Edit a recorded trace after the run | G12 and ledger-verify | FAIL |
| Wrong signing key / wrong project key fingerprint | Intake | FAIL |
| Wrong chip connected | G15 | FAIL, nothing run on it |
| Wrong board connected | G15 | FAIL, nothing run on it |
| Missing board description for PIL | PIL agent | BLOCKED |
| Bad commit (malloc) | git pre-commit hook | commit refused |
| Edited memory entry | memory verify | FAIL |

Mutation testing also exposed weak tests in the demo itself (first 50%, then 70% of planted bugs caught).
The tests were strengthened until every meaningful planted bug was caught; the 7 remaining survivors were
measured (largest effect 0.058 C against a 0.5 C tolerance) and recorded with reasons in `mutation_review.txt`.

## Controls

- **Fixed code decides.** Only `kg.verdict.Verdict` issues PASS; it needs every required gate present and passing,
  and fails closed on anything missing. The desktop app only displays verdicts.
- **Air gap.** No product class may reference networking classes (scanned in every run). Each compile, simulation
  and simulated board runs in a Linux network namespace with no interfaces. The air-gap self-check lists network
  interfaces; `AIRGAP enforce` refuses to run while any is up.
- **No shell.** Every external program is started from an argument list with a cleared environment, a hard timeout
  and process-tree kill.
- **Strict input parsing.** Every file is size-limited, strict UTF-8, line-limited, and parsed with a whitelist of
  keywords and numeric ranges. Paths cannot leave the project and symbolic links are refused.
- **Signed tool baseline.** All product jars, the native link library, self-test data, skills and firmware-support
  sources are hashed and signed; a run refuses to start if anything changed.
- **Evidence ledger.** Hash-chained, Ed25519-signed; every evidence file's SHA-256 is recorded; `ledger-verify`
  re-checks all of it. The private key is owner-only and outside every project.
- **Firmware isolation.** The C firmware is only ever loaded inside a separate SIL or simulated-board process, so a
  firmware crash cannot affect the coordinator, the verdict or the app.
- **Hardware protection.** Signed board limits (G14); identity check of board, chip and firmware hash (G15); flash
  plans restricted to the application region with protected regions never touched; human confirmation before HIL;
  link loss commands the board safe and reports whether the board confirmed.
- **Gate self-test.** 27 negative controls run on every verify and every eval.

## Known limits

- The Linux namespace sandbox isolates the network. A full syscall filter (seccomp) and bubblewrap are used when the
  OS provides them; Windows and macOS use weaker isolation, which is recorded in the evidence.
- In this release the signing key is a file protected by permissions. For releases, use a hardware token.

## The coding assistant (added in this release)

The assistant is outside the verdict path: nothing it produces can change a gate result, the ledger or a
verdict. Its own protections are listed in `docs/ASSISTANT.md`. In short: one pinned model file, sealed with
this computer's key and re-hashed by the engine on every load; a strict, fuzz-tested file parser; an engine
binary that the build proves imports no network or process functions, run in the job sandbox on Linux; fixed
task types with a rule-checked note; replies scanned for forbidden constructs; every code proposal built and
checked by G0-G4 on a scratch copy; nothing written to the project without the person pressing Apply; every
request, reply and decision kept in `jobs/assist-NNNN/` and project memory.
