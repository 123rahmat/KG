# Heater demo project

A complete Kindgleam project: a 200 Hz PI heater controller in C (`fw_ctrl.c`), six requirements
(`spec/spec.req`), ten test vectors including faults and exact-boundary cases (`vectors/`), a thermal
plant model (`models/`), signed board limits (`limits.cfg`), and a target description for PIL (`board.cfg`).

The firmware is the engineer's part. Everything else Kindgleam reads and checks:

| File | Role |
| --- | --- |
| `fw_ctrl.c`, `fw_ctrl.h` | Firmware. Exports fw_state_size, fw_init, fw_step, fw_progress_token |
| `spec/spec.req` | Requirements, each with a measurable number |
| `vectors/*.vec` | One test per file, same file on every tier |
| `models/thermal.model` | Plant model (UNCALIBRATED until measured on the real heater) |
| `limits.cfg` + `limits.sig` | Board ratings, signed by the hardware owner |
| `board.cfg` | Expected board, chip, probe and flash regions |
| `profile.cfg` | Which gates are required, and the trusted key fingerprint |
| `mutation_review.txt` | Measured, reviewed equivalent mutants |

Created by Kindgleam when you run it: `jobs/` (every run, its traces and reports), `evidence/ledger.log`
(signed), `memory/` (hash-chained logs), `evals/golden/`.

Setup: from the product folder run `sh examples/setup-demo.sh` once.
