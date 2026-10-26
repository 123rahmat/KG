package kg.cli;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import kg.core.Expr;
import kg.core.InputException;
import kg.core.Interface;
import kg.core.Proc;
import kg.core.SafeFiles;
import kg.core.Trace;
import kg.core.Vector;
import kg.gates.BinaryChecks;
import kg.gates.GateResult;
import kg.gates.Limits;
import kg.gates.Mutator;
import kg.gates.Requirements;
import kg.gates.SourceScan;
import kg.gates.TestGen;
import kg.gates.TraceCheck;
import kg.gates.TraceCompare;
import kg.rig.BoardSpec;
import kg.rig.FlashPlan;
import kg.rig.Frame;
import kg.rig.PilRunner;
import kg.sil.Plant;
import kg.verdict.Ledger;
import kg.verdict.Verdict;

/**
 * G11: negative controls. Every gate is fed input that is known to be bad and must reject it.
 * The SIL controls are generated from the project's own interface, so they work for any firmware.
 */
final class SelfTest {
    private interface Control {
        boolean run() throws Exception;
    }

    private interface Attempt {
        Object run() throws Exception;
    }

    private final Path dir;
    private final Path work;
    private final Path log;
    private final Coordinator coord;
    private final Path project;
    private final Duration timeout;
    private final Interface itf;
    private final Plant.Spec plant;
    private final Path lib;
    private final Path buildDir;
    private final String python;
    private final List<String> problems = new ArrayList<>();
    private int count;

    SelfTest(Path dir, Path work, Path log, Coordinator coord, Path project, Duration timeout, Interface itf,
             Plant.Spec plant, Path lib, Path buildDir, String python) {
        this.dir = dir;
        this.work = work;
        this.log = log;
        this.coord = coord;
        this.project = project;
        this.timeout = timeout;
        this.itf = itf;
        this.plant = plant;
        this.lib = lib;
        this.buildDir = buildDir;
        this.python = python;
    }

    int count() {
        return count;
    }

    private void control(String name, Control c) {
        count++;
        boolean ok;
        String why = "";
        try {
            ok = c.run();
        } catch (Exception e) {
            ok = false;
            why = " (" + e.getMessage() + ")";
        }
        try {
            Files.writeString(log, (ok ? "OK      " : "BROKEN  ") + name + why + "\n", StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        } catch (java.io.IOException e) {
            problems.add("cannot write selftest log");
        }
        if (!ok) {
            problems.add("negative control failed: " + name + why);
        }
    }

    private static boolean throwsInput(Attempt c) {
        try {
            c.run();
            return false;
        } catch (InputException e) {
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    List<String> run() throws Exception {
        Files.createDirectories(work);
        Interface sti = Interface.load(dir.resolve("interface_test.cfg"));
        Plant.Spec stp = Plant.load(dir.resolve("model_test.model"), sti);
        List<String> stOut = stp.outputNames();

        /* ---- source and build gates */
        control("G1 rejects malloc/free in code", () -> !SourceScan.scan(dir.resolve("bad_source.ctxt")).isEmpty());
        control("G1 rejects #pragma used to silence warnings", () -> !SourceScan.scan(dir.resolve("bad_pragma.ctxt")).isEmpty());
        control("G1 rejects a non-allowed #include", () -> !SourceScan.scan(dir.resolve("bad_include.ctxt")).isEmpty());
        control("G1 ignores banned words inside comments and strings", () -> SourceScan.scan(dir.resolve("tricky_ok.ctxt")).isEmpty());
        control("G3 rejects a firmware object that needs malloc", () -> !BinaryChecks.undefinedSymbols(dir.resolve("nm_bad.txt")).isEmpty());
        control("G4 rejects a dynamic stack frame", () -> !BinaryChecks.stack(List.of(dir.resolve("stack_bad.su")), 256).isEmpty());

        /* ---- requirement and input parsing */
        generatorControls();
        control("G0 rejects a requirement with no measurable limit", () -> {
            List<String> e = new ArrayList<>();
            Requirements.lint(dir.resolve("bad_spec.req"), e);
            return !e.isEmpty();
        });
        control("G5 rejects a requirement with no test", () -> {
            List<String> e = new ArrayList<>();
            var reqs = Requirements.lint(dir.resolve("uncovered_spec.req"), e);
            Vector v = Vector.load(dir.resolve("ok.vec"), sti, stOut);
            return e.isEmpty() && !Requirements.trace(reqs, List.of(v)).isEmpty();
        });
        control("vector parser rejects an oversized run", () -> throwsInput(() -> Vector.load(dir.resolve("evil_ticks.vec"), sti, stOut)));
        control("vector parser rejects unknown keywords", () -> throwsInput(() -> Vector.load(dir.resolve("evil_keyword.vec"), sti, stOut)));
        control("assertion language rejects an unknown signal", () -> throwsInput(() -> Vector.load(dir.resolve("unknown_signal.vec"), sti, stOut)));
        control("assertion language rejects code-like text", () -> throwsInput(() -> Vector.load(dir.resolve("injection.vec"), sti, stOut)));
        control("a command value outside the interface range is rejected", () -> throwsInput(() -> Vector.load(dir.resolve("out_of_range.vec"), sti, stOut)));
        control("an assertion that divides by zero can never pass", () -> {
            Expr.Cond c = Expr.parse("1 / (cmd - cmd) > 0", n -> n.equals("cmd") ? 0 : -1);
            return !Expr.test(c, k -> 1.0) && !Expr.test(Expr.parse("not (1 / (cmd - cmd) > 0) -> 1 / (cmd - cmd) > 0", n -> 0), k -> 1.0);
        });
        control("trace parser rejects a corrupted trace", () -> throwsInput(() -> Trace.read(dir.resolve("bad.trace"))));
        control("workspace guard rejects path escape", () -> throwsInput(() -> SafeFiles.inside(project, "../outside.txt")));
        control("interface parser rejects a SAFE value outside the output range", () -> throwsInput(() -> Interface.load(dir.resolve("bad_interface.cfg"))));

        /* ---- generated from THIS project's interface: the watchdog and the checkers on real SIL runs */
        Interface.Output o0 = itf.outputs.get(0);
        Path wdOn = work.resolve("wd_on.vec");
        Path wdOff = work.resolve("wd_off.vec");
        String body = "REQ REQ-000\nTICKS 200\nFAULT 100 hang\nASSERT from fault+3 always wd == 1\n";
        Files.writeString(wdOn, body);
        Files.writeString(wdOff, "WATCHDOG off\n" + body);
        List<Path[]> pairs = List.of(new Path[] {wdOn, work.resolve("wd_on.trace")}, new Path[] {wdOff, work.resolve("wd_off.trace")});
        Proc.Result r = Proc.run(coord.silCommand(lib, buildDir, pairs), project, log, timeout);
        if (!r.ok()) {
            control("SIL runs the generated watchdog controls", () -> false);
        } else {
            List<String> pOut = plant.outputNames();
            Vector vOn = Vector.load(wdOn, itf, pOut);
            Vector vOff = Vector.load(wdOff, itf, pOut);
            Trace tOn = Trace.read(work.resolve("wd_on.trace"));
            Trace tOff = Trace.read(work.resolve("wd_off.trace"));
            control("the watchdog trips within 3 ticks when this firmware hangs", () -> TraceCheck.check(vOn, tOn).isEmpty());
            control("G8 catches a hang when the watchdog is disabled", () -> !TraceCheck.check(vOff, tOff).isEmpty());
            control("after the trip every output of this firmware is at its SAFE value", () -> {
                for (int t = 103; t < tOn.ticks(); t++) {
                    for (Interface.Output o : itf.outputs) {
                        if (tOn.get(t, tOn.col(o.name())) != o.safe()) {
                            return false;
                        }
                    }
                }
                return true;
            });
            control("G8 catches an impossible output value (" + o0.name() + " above its max)", () -> {
                Path imp = work.resolve("impossible.vec");
                Files.writeString(imp, "REQ REQ-000\nTICKS 200\nFAULT 100 hang\nASSERT always " + o0.name() + " > " + o0.max() + "\n");
                return !TraceCheck.check(Vector.load(imp, itf, pOut), tOn).isEmpty();
            });
            control("G10 detects two different traces", () -> TraceCompare.firstDivergence(tOn, tOff, TraceCompare.exact(tOn), true) != null);
        }

        /* ---- limits, mutation, verdict, ledger */
        control("G14 rejects a command above the board limit", () -> Limits.load(dir.resolve("limits_test.cfg"))
                .check(List.of(Vector.load(dir.resolve("over_limit.vec"), sti, stOut)), List.of(), sti).stream()
                .anyMatch(p -> p.contains("outside board limit")));
        control("G14 rejects a firmware safety constant outside the board limit", () -> Limits.load(dir.resolve("limits_test.cfg"))
                .check(List.of(), List.of(dir.resolve("bad_const.ctxt")), sti).stream().anyMatch(p -> p.contains("outside board limit")));
        control("G7 finds mutation sites and really changes the code", () -> {
            List<Mutator.Mutant> m = Mutator.sites(dir.resolve("mutation_sample.ctxt"));
            String orig = Files.readString(dir.resolve("mutation_sample.ctxt"));
            return m.size() >= 10 && m.stream().allMatch(x -> !x.mutatedSource().equals(orig));
        });
        control("verdict refuses PASS when a required gate is missing", () -> !Verdict.decide(List.of("G0", "G1"),
                List.of(GateResult.pass("G0", "ok"))).pass());
        control("verdict refuses PASS when any gate failed", () -> !Verdict.decide(List.of("G0"),
                List.of(GateResult.pass("G0", "ok"), GateResult.fail("G9", "bad"))).pass());
        control("ledger detects an altered verdict, a changed evidence file and a foreign key", () -> {
            KeyPair kp = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
            Path led = work.resolve("test-ledger.log");
            Path ev = work.resolve("evidence.txt");
            Files.deleteIfExists(led);
            Files.writeString(ev, "original evidence\n");
            Map<String, Path> files = new LinkedHashMap<>();
            files.put(project.relativize(ev).toString().replace('\\', '/'), ev);
            Ledger.append(led, project, "run-0001", "FAIL", "test", files, kp.getPrivate());
            Ledger.append(led, project, "run-0002", "FAIL", "test", files, kp.getPrivate());
            if (!Ledger.verify(led, project, kp.getPublic(), true).isEmpty()) {
                return false;
            }
            String text = Files.readString(led);
            Files.writeString(led, text.replaceFirst(" run-0001 FAIL ", " run-0001 PASS "));
            boolean caughtEdit = !Ledger.verify(led, project, kp.getPublic(), true).isEmpty();
            Files.writeString(led, text);
            Files.writeString(ev, "forged evidence\n");
            boolean caughtFile = !Ledger.verify(led, project, kp.getPublic(), true).isEmpty();
            KeyPair other = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
            boolean caughtKey = !Ledger.verify(led, project, other.getPublic(), false).isEmpty();
            return caughtEdit && caughtFile && caughtKey;
        });

        /* ---- rig and link */
        control("link decoder rejects a frame with one flipped bit", () -> {
            byte[] w = new Frame(Frame.STEP, 7, new byte[] {1, 2, 3, 4}).encode();
            w[9] ^= 0x04;
            Frame.Decoder d = new Frame.Decoder();
            Frame got = null;
            for (byte x : w) {
                Frame f = d.feed(x);
                if (f != null) {
                    got = f;
                }
            }
            return got == null && d.crcErrors() == 1;
        });
        control("link decoder recovers the next good frame after garbage", () -> {
            Frame.Decoder d = new Frame.Decoder();
            for (int x : new int[] {0xA5, 0x13, 0xA5, 0x5A, 0x09, 0x00}) {
                d.feed(x);
            }
            Frame got = null;
            for (byte x : new Frame(Frame.HEARTBEAT, 9, new byte[0]).encode()) {
                Frame f = d.feed(x);
                if (f != null) {
                    got = f;
                }
            }
            return got != null && got.seq() == 9;
        });
        control("board.cfg rejects an application region overlapping a protected region",
                () -> throwsInput(() -> BoardSpec.load(dir.resolve("board_overlap.cfg"))));
        control("flash plan refuses to write outside the application region or into protected areas", () -> {
            BoardSpec b = BoardSpec.load(dir.resolve("board_ok.cfg"));
            return !FlashPlan.check(b, 0x08000000L, 4096).isEmpty() && !FlashPlan.check(b, 0x080FF000L, 8192).isEmpty()
                    && FlashPlan.check(b, 0x08008000L, 4096).isEmpty();
        });
        control("identity check refuses a wrong chip, board, firmware or interface", () -> {
            BoardSpec b = BoardSpec.load(dir.resolve("board_ok.cfg"));
            String h = "ab".repeat(32);
            return PilRunner.checkIdentity(new PilRunner.Identity(2, 0x411, "selftest-board", "A", h, 2, 1), b, h, sti).size() == 1
                    && PilRunner.checkIdentity(new PilRunner.Identity(2, 0x413, "other-board", "A", h, 2, 1), b, h, sti).size() == 1
                    && PilRunner.checkIdentity(new PilRunner.Identity(2, 0x413, "selftest-board", "A", h, 2, 1), b, "cd".repeat(32), sti).size() == 1
                    && PilRunner.checkIdentity(new PilRunner.Identity(2, 0x413, "selftest-board", "A", h, 3, 1), b, h, sti).size() == 1
                    && PilRunner.checkIdentity(new PilRunner.Identity(2, 0x413, "selftest-board", "A", h, 2, 1), b, h, sti).isEmpty();
        });
        control("on-chip C link and Java link agree on 500 random frames, including corrupted ones", () -> {
            Path home = dir.getParent();
            Path java = Path.of(System.getProperty("java.home"), "bin", "java");
            Proc.Result x = Proc.run(List.of(java.toString(), "--enable-preview", "--enable-native-access=kg.rig", "-Xshare:off",
                    "-p", home.resolve("build/mods").toString(), "-m", "kg.rig/kg.rig.LinkInterop",
                    home.resolve("build/native").resolve(System.mapLibraryName("kglink")).toString()), project, log, timeout);
            return x.ok();
        });
        return problems;
    }

    /** G17: the Python test generator safeguards. Script controls need Python; the parser controls do not. */
    private void generatorControls() throws Exception {
        control("G17 rejects generator output with text outside a vector", () -> {
            List<String> p = new ArrayList<>();
            TestGen.parse("gen_x.py", "x", "debug: hello\n### VECTOR v1\nREQ REQ-002\n", p);
            return !p.isEmpty();
        });
        control("G17 rejects an unsafe vector name", () -> {
            List<String> p = new ArrayList<>();
            TestGen.parse("gen_x.py", "x", "### VECTOR ../../evil\nREQ REQ-002\n", p);
            return !p.isEmpty();
        });
        Path gw = Files.createDirectories(work.resolve("generators"));
        List<String> why = new ArrayList<>();
        if (TestGen.pythonVersion(python, gw, log, timeout, why) == null) {
            Files.writeString(log, "SKIPPED G17 script controls: " + why.get(0) + "\n", StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE, StandardOpenOption.APPEND);
            return;
        }
        control("G17 accepts a correct deterministic generator", () -> {
            TestGen.Result r = TestGen.run(python, List.of(dir.resolve("gen_ok.py")), java.util.Set.of(), gw.resolve("ok"), log, timeout);
            return r.problems().isEmpty() && r.vectors().size() == 1;
        });
        control("G17 rejects a generator whose output changes between runs", () ->
                !TestGen.run(python, List.of(dir.resolve("gen_nondet.py")), java.util.Set.of(), gw.resolve("nd"), log, timeout)
                        .problems().isEmpty());
        control("G17 rejects a generator that fails part-way", () ->
                !TestGen.run(python, List.of(dir.resolve("gen_crash.py")), java.util.Set.of(), gw.resolve("cr"), log, timeout)
                        .problems().isEmpty());
        control("G17 rejects a generated vector whose name is already used", () ->
                !TestGen.run(python, List.of(dir.resolve("gen_ok.py")), java.util.Set.of("ok_v1"), gw.resolve("dup"), log, timeout)
                        .problems().isEmpty());
        if (kg.core.Proc.isolation() == kg.core.Proc.Isolation.NETWORK_NAMESPACE) {
            control("G17 sandbox stops a generator from reaching the network", () ->
                    !TestGen.run(python, List.of(dir.resolve("gen_network.py")), java.util.Set.of(), gw.resolve("net"), log,
                            timeout).problems().isEmpty());
        }
    }
}
