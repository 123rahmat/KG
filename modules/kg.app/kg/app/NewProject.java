package kg.app;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.GeneralSecurityException;
import java.util.Base64;
import java.util.Comparator;
import java.util.Locale;
import java.util.stream.Stream;
import kg.core.InputException;
import kg.core.SafeFiles;
import kg.gates.Limits;
import kg.verdict.Keys;

/**
 * Creates a new project workspace: a folder with its own firmware, spec, vectors, plant model,
 * profile bound to this computer's signing key, and signed board limits. Templates are a blank C
 * controller (ready to build) or a copy of an example project.
 */
final class NewProject {
    private NewProject() {
    }

    static final String[] TEMPLATES = {"Blank C controller", "Heater example", "Valve example"};

    /** Every project lives in the user's own Kindgleam folder: ~/.kindgleam/projects/<name>. */
    static Path defaultRoot() {
        return Workspace.projects();
    }

    /** Creates the project and returns its folder. */
    static Path create(Path home, Path parent, String name, int template)
            throws IOException, InputException, GeneralSecurityException {
        if (!name.matches("[A-Za-z0-9][A-Za-z0-9 _-]{0,47}")) {
            throw new InputException("use 1-48 letters, digits, spaces, - or _ for the project name");
        }
        Path dir = parent.resolve(name.strip()).toAbsolutePath().normalize();
        if (Files.exists(dir)) {
            throw new InputException("a folder named '" + name + "' already exists there");
        }
        String fp = Keys.fingerprint(Keys.loadPublic(Keys.defaultDir()));
        Files.createDirectories(dir);
        try {
            if (template == 0) {
                blank(dir, name);
            } else {
                copy(home.resolve("examples").resolve(template == 1 ? "heater-demo" : "valve-demo"), dir);
            }
            Path prof = dir.resolve("profile.cfg");
            String p = Files.readString(prof).replaceAll("(?m)^LEDGER_KEY_FP .*$", "LEDGER_KEY_FP " + fp)
                    .replaceAll("(?m)^PROFILE .*$", "PROFILE " + slug(name));
            SafeFiles.writeAtomic(prof, p);
            Path cfg = dir.resolve("limits.cfg");
            Limits.load(cfg);
            byte[] sig = Keys.sign(Keys.loadPrivate(Keys.defaultDir()), Files.readAllBytes(cfg));
            SafeFiles.writeAtomic(dir.resolve("limits.sig"), Base64.getEncoder().encodeToString(sig) + "\n");
            kg.harness.Memory.add(dir, "decisions", "app", "project created from template '" + TEMPLATES[template] + "'");
        } catch (IOException | InputException | GeneralSecurityException | RuntimeException e) {
            deleteTree(dir);
            throw e;
        }
        return dir;
    }

    private static String slug(String n) {
        return n.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]+", "-").replaceAll("(^-|-$)", "");
    }

    private static void copy(Path src, Path dst) throws IOException {
        try (Stream<Path> w = Files.walk(src)) {
            for (Path p : w.toList()) {
                Path rel = src.relativize(p);
                String first = rel.getNameCount() > 0 ? rel.getName(0).toString() : "";
                if (first.equals("jobs") || first.equals("evidence") || first.equals("memory") || first.equals("tests")
                        || Files.isSymbolicLink(p)) {
                    continue;
                }
                Path d = dst.resolve(rel.toString());
                if (Files.isDirectory(p)) {
                    Files.createDirectories(d);
                } else {
                    Files.copy(p, d);
                }
            }
        }
    }

    private static void write(Path dir, String rel, String text) throws IOException {
        Path p = dir.resolve(rel);
        Files.createDirectories(p.getParent());
        Files.writeString(p, text, StandardCharsets.UTF_8);
    }

    /** A small, complete C controller that builds and passes the fast gates; a starting point. */
    private static void blank(Path dir, String name) throws IOException {
        write(dir, "interface.cfg", """
                # Firmware inputs and outputs. The order is the order of in[] and out[] in fw_step.
                INTERFACE %s v1
                RATE_HZ 100
                INPUT  command   -  0     100  COMMAND 0
                INPUT  feedback  -  -1000 1000 SENSOR TOL 0.01
                OUTPUT drive     -  0     1    SAFE 0 TOL 0.001
                HANG_LATCH safe
                TIMING_BUDGET_US 500
                """.formatted(slug(name).isEmpty() ? "controller" : slug(name)));
        write(dir, "profile.cfg", """
                PROFILE new-project
                REQUIRED_GATES G0 G1 G2 G3 G4 G5 G6 G7 G8 G10 G11 G12 G14
                LANGUAGE c
                STACK_MAX_FRAME 256
                AGENT_TIMEOUT_S 120
                COMPILER gcc
                PLANT_MODEL models/plant.model
                AIRGAP warn
                SANDBOX best-effort
                CALIBRATION optional
                MUTANTS_MAX 24
                MUTATION_MIN_SCORE 80
                COVERAGE_MIN_LINES 90
                COVERAGE_MIN_BRANCHES 80
                TIMING advisory
                LEDGER_KEY_FP 0000000000000000000000000000000000000000000000000000000000000000
                """);
        write(dir, "models/plant.model", """
                # First-order plant: feedback follows drive with time constant TAU_S. Replace with your process.
                MODEL first_order
                OUTPUT y - 0 TOL 0.01
                DRIVE drive
                DISTURB
                SENSOR feedback y
                PARAM TAU_S 1
                PARAM GAIN 100
                PARAM AMBIENT 0
                CALIBRATION none
                """);
        write(dir, "limits.cfg", """
                # Safe operating limits of the board, set by the hardware owner and signed.
                BOARD my-board rev-A
                RANGE command 0 100
                RANGE feedback -1000 1000
                NOISE_MAX 5
                DISTURB_MAX 50
                CONST FW_DRIVE_MAX 0 1
                """);
        write(dir, "spec/spec.req", """
                # id | requirement with a measurable limit | tiers that must verify it
                REQ-001 | With command 50, feedback shall settle within 2 of the command by tick 600 (6 s) and stay there | SIL PIL
                REQ-002 | The drive output shall always stay between 0 and 1 | SIL PIL
                REQ-003 | With command 0 the drive output shall stay at exactly 0 (off) for at least 500 ticks | SIL PIL
                REQ-004 | If the firmware hangs, the drive output shall reach its safe value 0 within 3 ticks and stay 0 | SIL HIL
                """);
        write(dir, "vectors/off_at_zero.vec", """
                REQ REQ-003
                TICKS 500
                SET 0 command 0
                ASSERT always drive == 0
                """);
        write(dir, "vectors/hang.vec", """
                REQ REQ-004
                TICKS 800
                SET 0 command 50
                FAULT 400 hang
                ASSERT from fault+3 always drive == 0
                """);
        write(dir, "board.cfg", """
                # The target board. TARGET virtual uses Kindgleam's simulated board, which speaks the real on-chip
                # protocol over a link with injected errors. For a real board set TARGET to its serial port and
                # fill in its chip ID and flash map (see docs/HARDWARE.md).
                BOARD my-board rev-A
                CHIP_ID 0x413
                TARGET virtual
                VIRTUAL_IDENTITY my-board rev-A 0x413
                VIRTUAL_LINK_FAULTS_PPM 200
                LINK_TIMEOUT_MS 20
                LINK_RETRIES 5
                FLASH_APP 0x08008000 0x08100000
                FLASH_PROTECTED 0x08000000 0x08008000
                """);
        write(dir, "mutation_review.txt", """
                # Planted bugs that make no measurable difference, each with a reason (at most 30%).
                fw_main.c:48:18 '+' -> '-' | progress token offset by a constant still rises every tick; the watchdog only checks that it advances
                """);
        write(dir, "vectors/step_50.vec", """
                REQ REQ-001
                TICKS 1000
                SET 0 command 50
                ASSERT from 600 always abs(feedback - command) <= 2
                """);
        write(dir, "vectors/drive_range.vec", """
                REQ REQ-002
                TICKS 1500
                SET 0 command 100
                SET 500 command 0
                SET 1000 command 30
                ASSERT always drive >= 0 and drive <= 1
                """);
        write(dir, "fw_main.h", """
                #ifndef FW_MAIN_H
                #define FW_MAIN_H

                #include <stdint.h>

                /* Kindgleam firmware ABI v2. Runs at 100 Hz. Static memory only.
                 * in[0]  command   (set point)
                 * in[1]  feedback  (measured value)
                 * out[0] drive     0..1                                                    */

                #define FW_N_IN  2u
                #define FW_N_OUT 1u
                #define FW_DRIVE_MAX 1.0f

                typedef struct {
                    float    integ;
                    uint32_t done_mask;  /* tasks completed this cycle, proves progress to the watchdog */
                } fw_state_t;

                uint32_t fw_abi_version(void);
                uint32_t fw_n_in(void);
                uint32_t fw_n_out(void);
                uint32_t fw_state_size(void);
                void     fw_init(fw_state_t *s);
                void     fw_step(fw_state_t *s, const float *in, float *out);
                uint32_t fw_progress_token(const fw_state_t *s, uint32_t tick);

                #endif
                """);
        write(dir, "fw_main.c", """
                #include "fw_main.h"

                /* PI controller. Tune KP and KI for your plant; keep the anti-windup limit. */
                #define KP        0.02f
                #define KI        0.0004f
                #define INTEG_MAX 2500.0f

                #define TASK_READ 1u
                #define TASK_CTRL 2u
                #define TASK_OUT  4u

                static float clampf(float v, float lo, float hi)
                {
                    if (v < lo) { return lo; }
                    if (v > hi) { return hi; }
                    return v;
                }

                uint32_t fw_abi_version(void) { return 2u; }
                uint32_t fw_n_in(void)        { return FW_N_IN; }
                uint32_t fw_n_out(void)       { return FW_N_OUT; }
                uint32_t fw_state_size(void)  { return (uint32_t)sizeof(fw_state_t); }

                void fw_init(fw_state_t *s)
                {
                    s->integ = 0.0f;
                    s->done_mask = 0u;
                }

                void fw_step(fw_state_t *s, const float *in, float *out)
                {
                    float command = in[0];
                    float feedback = in[1];
                    float err;

                    s->done_mask = TASK_READ;

                    err = command - feedback;
                    s->integ = clampf(s->integ + err, -INTEG_MAX, INTEG_MAX);
                    s->done_mask |= TASK_CTRL;

                    out[0] = clampf(KP * err + KI * s->integ, 0.0f, FW_DRIVE_MAX);
                    s->done_mask |= TASK_OUT;
                }

                uint32_t fw_progress_token(const fw_state_t *s, uint32_t tick)
                {
                    return ((tick + 1u) << 3) | (s->done_mask & 7u);
                }
                """);
    }

    private static void deleteTree(Path dir) {
        try (Stream<Path> w = Files.walk(dir)) {
            for (Path p : w.sorted(Comparator.reverseOrder()).toList()) {
                Files.deleteIfExists(p);
            }
        } catch (IOException e) {
            // best effort
        }
    }
}
