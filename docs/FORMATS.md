# File formats

All project files are plain UTF-8 text with one directive per line; `#` starts a comment. Every parser is
strict: an unknown keyword, a missing value, a name that does not exist or a number out of range is an error
that names the file and line.

## Project layout

```
interface.cfg          the firmware's inputs and outputs
profile.cfg            the rules in force for this project
fw_*.c, fw_*.h         firmware (C11); wd_*.c/h for a watchdog unit
spec/spec.req          requirements
vectors/*.vec          hand-written test vectors
tests/gen_*.py         Python test generators (optional) and their helpers, e.g. tests/kgvec.py
models/*.model         plant model (and an .fmu if the model uses one)
limits.cfg, limits.sig signed safe operating limits of the board
board.cfg              the target board (PIL/HIL)
mutation_review.txt    reviewed equivalent mutants (optional)
registers.cfg          register map the assistant may use (optional)
jobs/, evidence/, memory/   written by Kindgleam
```

## interface.cfg

```
INTERFACE heater-controller v2
RATE_HZ 200
INPUT  setpoint C   0    120 COMMAND 60          set by vectors (SET); 60 is the default
INPUT  sensor   C  -100  300 SENSOR TOL 0.01     read from the plant model
OUTPUT heater   -   0    1   SAFE 0 TOL 0.001    SAFE is the value the board falls back to
HANG_LATCH max | last | safe                      what outputs do while the firmware hangs
TIMING_BUDGET_US 200                              per step, on the real target
```
The order of INPUT and OUTPUT lines is the order of the firmware's `in[]` and `out[]` arrays. TOL is the
allowed SIL/PIL difference for that signal (G10).

## Firmware ABI (version 2)

```c
uint32_t fw_abi_version(void);                 /* returns 2 */
uint32_t fw_n_in(void);  uint32_t fw_n_out(void);
uint32_t fw_state_size(void);                  /* bytes of state the host allocates */
void     fw_init(void *state);
void     fw_step(void *state, const float *in, float *out);
uint32_t fw_progress_token(const void *state, uint32_t tick);
```
All seven must be exported with these plain C names (checked by G3).

## spec/spec.req

`REQ-NNN | requirement text with a measurable number | tiers (SIL PIL HIL)`

## vectors/*.vec

```
REQ REQ-001                         the requirement this vector proves (exactly one)
TICKS 4000                          run length (max 100000)
SEED 7                              seed for noise faults
WATCHDOG on | off                   off only in negative controls
SET <tick> <command-input> <value>
FAULT <tick> hang
FAULT <tick> stuck   <sensor> <value>
FAULT <tick> offset  <sensor> <delta>
FAULT <tick> noise   <sensor> <amplitude>
FAULT <tick> freeze  <sensor>
FAULT <tick> disturb <value>        disturbance into the plant
ASSERT always <condition>
ASSERT from <tick | fault | fault+N> always <condition>
ASSERT eventually by <tick> <condition>
```
Conditions use signal names (inputs, outputs, plant outputs, `wd`), numbers, `+ - * /`, `abs() min() max()`,
comparisons `< <= > >= == !=`, `and`, `or`, `not`, parentheses, and `a -> b` ("whenever a, also b").
A vector without an ASSERT is rejected: it would prove nothing.

## tests/gen_*.py (Python test generators, gate G17)

A generator prints vectors and nothing else:
```
### VECTOR sp030
REQ REQ-002
TICKS 4000
SET 0 setpoint 30
ASSERT from 3000 always abs(temp - setpoint) <= 0.5
### VECTOR sp035
...
```
Rules, all enforced:
- Only files named `gen_<name>.py` run; other `.py` files in `tests/` are helpers they may import.
- Each generator runs twice, in an empty working folder, with a clean environment, the Python flags
  `-E -s -B`, the agent time limit and (on Linux) no network. Both runs must print identical bytes.
- Vector names are 1-24 of `a-z 0-9 _`; the stored name is `<generator>_<name>`, for example
  `setpoint_sweep_sp030`. Names may not clash with `vectors/` or each other. At most 500 vectors per script,
  64 KB per vector, 4 MB per script, 20 scripts.
- The output is parsed by the same strict vector parser as hand-written vectors, then used by every later
  gate and tier exactly like them. Generated vectors are kept in `jobs/run-NNNN/generated/` and hashed into the
  run's evidence, together with every file in `tests/`.
- A generator cannot run a test, read a result or influence a verdict.

`firmware-support/kgvec.py` is a small helper (copy it into `tests/`):
```python
from kgvec import Vector
for sp in range(30, 86, 5):
    v = Vector("sp%03d" % sp, req="REQ-002", ticks=4000)
    v.set(0, "setpoint", sp)
    v.check("always temp <= setpoint + 0.5")
    v.check("from 3000 always abs(temp - setpoint) <= 0.5")
    v.emit()
```

## profile.cfg

Required: `PROFILE`, `REQUIRED_GATES`, `STACK_MAX_FRAME`, `AGENT_TIMEOUT_S`, `COMPILER gcc|clang`, `PLANT_MODEL`,
`AIRGAP enforce|warn`, `SANDBOX required|best-effort`, `CALIBRATION required|optional`, `MUTANTS_MAX`,
`MUTATION_MIN_SCORE`, `COVERAGE_MIN_LINES`, `COVERAGE_MIN_BRANCHES`, `TIMING required|advisory`, `LEDGER_KEY_FP`.
Optional: `LANGUAGE c` (the only firmware language in this release), `PYTHON <interpreter>` (default `python3`,
`python` on Windows). Unknown keys, duplicate keys and missing required keys are errors.

## models/*.model

```
MODEL first_order | second_order | fmu
OUTPUT <name> <unit> <initial> [VAR <fmu variable>] [TOL <t>]
DRIVE <firmware output> [VAR <fmu variable>]
DISTURB
SENSOR <sensor input> <plant output>
PARAM <name> <value>            first_order: TAU_S GAIN AMBIENT; second_order: WN ZETA GAIN OFFSET LIMIT_MIN LIMIT_MAX
FMU <path to .fmu>              fmu models only (FMI 2.0 co-simulation)
CALIBRATION none | <measurement file>
```

## limits.cfg (signed into limits.sig with `kindgleam sign-limits`)

```
BOARD <name> <revision>
RANGE <input> <min> <max>         SET values and stuck/offset values on that input
NOISE_MAX <amplitude>
DISTURB_MAX <absolute value>
CONST <FIRMWARE_DEFINE> <min> <max>
```

## mutation_review.txt

`<mutant id exactly as reported> | <reason, at least 20 characters>`. At most 30% of valid mutants may be
excused, and an entry that no longer matches a surviving mutant fails G7.

## Trace (jobs/run-NNNN/traces/*.trace, *.pil)

```
# kindgleam-trace v2
tick,<inputs>,<outputs>,<plant outputs>,wd,exec_ns,state_hash
```
One line per tick, identical in layout on every tier.

## Ledger (evidence/ledger.log)

`E1 <entry_hash> <prev_hash> <run> <verdict> <platform> <n> <path>=<sha256> ... SIG <base64 Ed25519>`

## Memory (memory/*.log)

`M1 <hash> <prev> <date> <source> | <text>`; logs: decisions, facts, runs, review_queue.

## Model seal (model/model.seal)

`KGSEAL 1`, `FILE`, `SIZE`, `SHA256`, `SIG <base64 Ed25519 over the four lines above>`.

## Link protocol v2

`A5 5A | ver | type | seq LE16 | len LE16 | payload <= 256 | CRC-32 LE` over ver..payload.
Types: HELLO, INIT, STEP, HANG (test builds), SAFE, HEARTBEAT and NAK. A repeated sequence number is a retry:
the board resends its last reply and never acts twice.
