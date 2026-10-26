# Hardware: PIL on a real chip, HIL on a bench

## What runs where

| Tier | Firmware runs on | Plant runs on | Link |
| --- | --- | --- | --- |
| SIL | your PC (host library) | PC (Java plant model) | none |
| PIL, simulated board | separate PC process, same protocol as a chip | PC | pipes, with optional injected byte errors |
| PIL, real chip | the microcontroller | PC | USB serial through the debug probe or a USB-UART |
| HIL | the microcontroller on the real board | real device or bench emulator | serial + bench I/O |

## Bringing up a real board for PIL

1. **Describe the board** in `board.cfg`: `BOARD`, `CHIP_ID`, `TARGET serial`, `PROBE vid:pid`, `PORT`,
   `OPENOCD_INTERFACE`, `OPENOCD_TARGET`, `FLASH_APP` and every `FLASH_PROTECTED` region.
2. **Port the on-chip helper.** Add `firmware-support/kg_link.c` and `kg_pil_target.c` to your firmware build and
   implement the five hooks in `kg_pil_target.h`:
   `kg_port_chip_id`, `kg_port_uart_write`, `kg_port_watchdog_kick` (the independent hardware watchdog),
   `kg_port_watchdog_tripped`, `kg_port_outputs_safe`. Provide `kg_board_name`, `kg_board_rev` and
   `kg_firmware_hash` (SHA-256 of the image, injected by your build). Call `kg_pil_on_byte()` for each UART byte.
   Build with `-DKG_PIL_TEST_BUILD` only for PIL images (it enables the deliberate-hang test command).
3. **Bench safety first:** current-limited supply set below the damage level, load disconnected, emergency stop.
4. `kindgleam verify --tier=pil`

Detection order: USB scan for the expected probe (`kg.rig.Detect`, 24 known probes and USB-serial bridges) ->
chip identity registers read through OpenOCD with read-only commands -> HELLO over the link (board, revision,
chip id, firmware hash, protocol version). Any mismatch stops the run before anything executes (G15).

## Status in this release

| Piece | State |
| --- | --- |
| Link protocol, Java side | done, tested with injected corruption (38,000+ requests per run) |
| Link protocol, C side (`kg_link.c`) | done; byte-identical with Java on 500 random frames; strict build, 40-byte stack |
| On-chip PIL handler (`kg_pil_target.c`) | done; strict build, 32-byte stack; needs the five board hooks |
| USB probe detection (Linux) | done |
| OpenOCD identity read, flash plan with region checks | done and self-tested; not yet run against a chip |
| PIL over a real serial port | detection path done; stops BLOCKED until a cross-compiled image is configured |
| HIL bench runner (power, relays, logic analyzer) | pre-flight only; the HIL tier stops BLOCKED |

These are the next build steps once a target board and probe are available.

## Why the simulated board matters

It speaks exactly the protocol the chip will speak, runs the same firmware, and injects byte errors in both
directions. A PIL PASS against it proves the PC side, the protocol, retries, duplicate handling and the tier
comparison. Moving to the real chip then changes only the transport and the firmware's execution environment,
which is exactly what G10 (SIL vs PIL) is there to expose.
