package kg.cli;

import java.io.IOException;
import java.io.PrintStream;
import java.net.NetworkInterface;
import java.net.SocketException;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import kg.core.Hashing;
import kg.core.InputException;
import kg.core.Interface;
import kg.core.Proc;
import kg.core.Profile;
import kg.core.SafeFiles;
import kg.core.Trace;
import kg.core.Vector;
import kg.gates.BinaryChecks;
import kg.gates.GateResult;
import kg.gates.Limits;
import kg.gates.Mutator;
import kg.gates.NetScan;
import kg.gates.Requirements;
import kg.gates.SourceScan;
import kg.gates.TestGen;
import kg.gates.TraceCheck;
import kg.gates.TraceCompare;
import kg.rig.BoardSpec;
import kg.rig.Detect;
import kg.rig.Link;
import kg.rig.PilRunner;
import kg.sil.Engine;
import kg.sil.Plant;
import kg.verdict.Keys;
import kg.verdict.Ledger;
import kg.verdict.Verdict;

/**
 * The coordinator. Holds the workspace lock and runs exactly one agent at a time, in a fixed
 * order. Each agent writes a hand-off report; the chain stops at the first failure and goes
 * to Triage. Only the Verdict agent can say PASS.
 */
final class Coordinator {
    private static final Pattern FW_NAME = Pattern.compile("(fw|wd)_[a-z0-9_]{1,40}\\.(c|h)");
    private static final Pattern VEC_NAME = Pattern.compile("[a-z0-9_]{1,40}\\.vec");
    private static final List<String> WARN_FLAGS = List.of(
            "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-pedantic", "-Wshadow", "-Wstrict-prototypes",
            "-Wcast-qual", "-Wdouble-promotion", "-Wconversion", "-Wundef", "-fno-common");
    /** Host firmware library name for this OS: libfw.so, fw.dll or libfw.dylib. */
    private static final String LIBFW = System.mapLibraryName("fw");
    private static final Pattern GCOV_LINES = Pattern.compile("Lines executed:\\s*([0-9.]+)% of (\\d+)");
    private static final Pattern GCOV_TAKEN = Pattern.compile("Taken at least once:\\s*([0-9.]+)% of (\\d+)");

    private final Path home;
    private final Path project;
    private final boolean machine;
    private final PrintStream out = System.out;
    private final List<GateResult> gates = new ArrayList<>();
    private final List<String> notes = new ArrayList<>();
    private final Map<String, String> manifest = new LinkedHashMap<>();
    private final List<Path> fwFiles = new ArrayList<>();
    private final List<Path> vectorPaths = new ArrayList<>();
    private final List<Path> genScripts = new ArrayList<>();
    private final List<Path> pyFiles = new ArrayList<>();
    private final List<Vector> vectors = new ArrayList<>();
    private Profile profile;
    private Interface itf;
    private Plant.Spec plantSpec;
    private float[] tolerance;
    private Path runDir;
    private Path buildDir;
    private Path traceDir;
    private Path progress;
    private String runId;
    private int agentNo;
    private String failedAgent;
    private String failReason;
    private Path failLog;
    private Requirements.Req[] reqArray = new Requirements.Req[0];

    Coordinator(Path home, Path project, boolean machine) {
        this.home = home;
        this.project = project;
        this.machine = machine;
    }

    /* ------------------------------------------------------------ output */

    private void say(String human, String machineLine) {
        if (machine) {
            if (machineLine != null) {
                out.println("KG|" + machineLine);
            }
        } else if (human != null) {
            out.println(human);
        }
        if (progress != null && human != null) {
            try {
                Files.writeString(progress, human + "\n", StandardCharsets.UTF_8,
                        StandardOpenOption.CREATE, StandardOpenOption.APPEND);
            } catch (IOException e) {
                out.println("warning: cannot write progress log: " + e.getMessage());
            }
        }
    }

    private void gate(GateResult r) throws IOException {
        gates.add(r);
        Files.writeString(runDir.resolve("gates.txt"), r.line() + "\n", StandardCharsets.UTF_8,
                StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        say(String.format(Locale.ROOT, "       %-4s %s  %s", r.gate(), r.pass() ? "PASS" : "FAIL", r.detail()),
                "gate|" + r.gate() + "|" + (r.pass() ? "PASS" : "FAIL") + "|" + r.detail());
    }

    private static String more(List<String> l) {
        return l.get(0) + (l.size() > 1 ? " (+" + (l.size() - 1) + " more)" : "");
    }

    /* ------------------------------------------------------------ agents */

    private interface Body {
        /** Returns null when done, or a failure reason. */
        String run(Path log) throws Exception;
    }

    private static final class Blocked extends Exception {
        private static final long serialVersionUID = 1L;

        Blocked(String m) {
            super(m);
        }
    }

    private boolean agent(String name, Body body) throws IOException {
        agentNo++;
        String tag = String.format(Locale.ROOT, "%02d_%s", agentNo, name.toLowerCase(Locale.ROOT).replace(' ', '_'));
        Path log = runDir.resolve(tag + ".log");
        say(String.format(Locale.ROOT, "[%02d] %-10s START", agentNo, name), "agent|" + agentNo + "|" + name + "|START");
        long t0 = System.nanoTime();
        String status;
        String reason;
        try {
            reason = body.run(log);
            status = reason == null ? "DONE" : "FAILED";
        } catch (Blocked e) {
            status = "BLOCKED";
            reason = e.getMessage();
        } catch (InputException e) {
            status = "FAILED";
            reason = "input error: " + e.getMessage();
        } catch (Exception e) {
            status = "FAILED";
            reason = "agent error: " + e;
        }
        long ms = (System.nanoTime() - t0) / 1_000_000;
        SafeFiles.writeAtomic(runDir.resolve(tag + ".report"), "AGENT " + name + "\nSTATUS " + status
                + "\nDURATION_MS " + ms + "\nREASON " + (reason == null ? "-" : reason.replace('\n', ' '))
                + "\nLOG " + (Files.exists(log) ? project.relativize(log) : "-") + "\n");
        say(String.format(Locale.ROOT, "[%02d] %-10s %s (%d ms)%s", agentNo, name, status, ms,
                reason == null ? "" : " - " + reason),
                "agent|" + agentNo + "|" + name + "|" + status + "|" + ms + "|" + (reason == null ? "" : reason));
        if (!status.equals("DONE") && failedAgent == null) {
            failedAgent = name;
            failReason = reason;
            failLog = log;
        }
        return status.equals("DONE");
    }

    /* ------------------------------------------------------------ run */

    private Path newRun(Path jobs, String prefix) throws Exception {
        for (int i = 1; ; i++) {
            runId = String.format(Locale.ROOT, "%s-%04d", prefix, i);
            try {
                Files.createDirectory(jobs.resolve(runId));
                break;
            } catch (FileAlreadyExistsException e) {
                if (i > 9999) {
                    throw new InputException("too many runs in jobs/");
                }
            }
        }
        runDir = jobs.resolve(runId);
        buildDir = Files.createDirectories(runDir.resolve("build"));
        traceDir = Files.createDirectories(runDir.resolve("traces"));
        progress = runDir.resolve("progress.log");
        return runDir;
    }

    int run(boolean full, String tier) throws Exception {
        profile = Profile.load(SafeFiles.inside(project, "profile.cfg"));
        Path jobs = project.resolve("jobs");
        Files.createDirectories(jobs);
        try (FileChannel ch = FileChannel.open(jobs.resolve(".lock"), StandardOpenOption.CREATE,
                StandardOpenOption.WRITE); FileLock lock = ch.tryLock()) {
            if (lock == null) {
                throw new InputException("another kindgleam run holds the workspace lock");
            }
            return runLocked(jobs, full, tier);
        }
    }

    private int runLocked(Path jobs, boolean full, String tier) throws Exception {
        newRun(jobs, "run");
        SafeFiles.writeAtomic(jobs.resolve("latest"), runId + "\n");
        say("Kindgleam " + (full ? "verify --tier=" + tier : "check") + "  " + runId + "  profile "
                + profile.name + "  " + Instant.now(), "run|" + runId + "|" + (full ? "verify" : "check") + "|" + tier);

        boolean ok = agent("Intake", this::intake)
                && agent("Spec", this::spec)
                && agent("Build", this::build);
        if (!full) {
            say(ok ? "CHECK OK (advisory only; run 'kindgleam verify' for a verdict)" : "CHECK FAILED",
                    "check|" + (ok ? "OK" : "FAIL"));
            if (!ok) {
                agent("Triage", this::triage);
            }
            return ok ? 0 : 1;
        }
        ok = ok && agent("SIL", this::sil)
                && agent("Quality", this::quality)
                && agent("Compare", this::compare)
                && agent("Coverage", this::coverage)
                && agent("Mutation", this::mutation)
                && agent("Selftest", this::selftest);
        if (ok && !tier.equals("sil")) {
            ok = agent("PIL", this::pil);
        }
        if (ok && tier.equals("hil")) {
            ok = agent("HIL", this::hil);
        }
        if (!ok) {
            agent("Triage", this::triage);
        }
        agent("Integrity", this::integrity);
        Verdict.Outcome[] verdict = new Verdict.Outcome[1];
        agent("Verdict", log -> {
            List<String> required = new ArrayList<>(profile.requiredGates);
            if (!tier.equals("sil")) {
                required.addAll(List.of("G15", "G16"));
                if (profile.timingRequired) {
                    required.add("G9");
                }
            }
            if (tier.equals("hil")) {
                required.add("G13");
            }
            Verdict.Outcome v = Verdict.decide(required, gates);
            if (failedAgent != null) {
                v = new Verdict.Outcome(false, "agent " + failedAgent + " stopped the chain: " + failReason);
            }
            verdict[0] = v;
            SafeFiles.writeAtomic(runDir.resolve("verdict.txt"), "VERDICT " + v.word() + "\nREASON " + v.reason() + "\n");
            return null;
        });
        if (verdict[0] == null) {
            verdict[0] = new Verdict.Outcome(false, "verdict agent failed");
        }
        writeReport(verdict[0], tier);
        boolean ledgered = agent("Ledger", log -> ledger(verdict[0]));
        agent("Memory", log -> memoryKeeper(verdict[0], tier));
        Verdict.Outcome v = verdict[0];
        say("", null);
        say("VERDICT " + v.word() + "  " + v.reason(), "verdict|" + v.word() + "|" + v.reason());
        if (!ledgered) {
            say("Evidence could not be written to the ledger; the result is not recorded.", "ledger|FAIL");
            return 1;
        }
        return v.pass() ? 0 : 1;
    }

    /* ------------------------------------------------------------ 1. Intake */

    private String intake(Path log) throws Exception {
        PublicKey pub = Keys.loadPublic(Keys.defaultDir());
        if (!Keys.fingerprint(pub).equals(profile.ledgerKeyFingerprint)) {
            return "signing key on this machine does not match LEDGER_KEY_FP in profile.cfg";
        }
        List<String> base = Baseline.verify(home, pub);
        if (!base.isEmpty()) {
            return "tool integrity: " + base.get(0);
        }
        List<String> net = NetScan.scanJars(NetScan.jarsIn(home.resolve("build/mods")));
        if (!net.isEmpty()) {
            return "product contains networking code: " + net.get(0);
        }
        String air = airgap();
        if (air != null) {
            if (profile.airgapEnforce) {
                return "air-gap check: " + air;
            }
            notes.add("AIR-GAP NOT ENFORCED: " + air);
        }
        if (Proc.isolation() == Proc.Isolation.NONE) {
            if (profile.sandboxRequired) {
                return "sandbox required but no isolation available on this machine (" + System.getProperty("os.name") + ")";
            }
            notes.add("SANDBOX NOT AVAILABLE: jobs ran without network isolation");
        } else {
            notes.add("Sandbox: every compile and simulation ran in an isolated network namespace");
        }
        try (Stream<Path> s = Files.list(project)) {
            for (Path p : s.sorted().toList()) {
                String n = p.getFileName().toString();
                if (n.endsWith(".c") || n.endsWith(".h")) {
                    if (!FW_NAME.matcher(n).matches()) {
                        return "source file name not allowed: " + n + " (use fw_*.c/h or wd_*.c/h)";
                    }
                    fwFiles.add(SafeFiles.inside(project, n));
                }
            }
        }
        if (fwFiles.stream().noneMatch(p -> p.toString().endsWith(".c"))) {
            return "no firmware source files (fw_*.c) in the project";
        }
        try (Stream<Path> s = Files.list(SafeFiles.inside(project, "vectors"))) {
            for (Path p : s.sorted().toList()) {
                String n = p.getFileName().toString();
                if (!VEC_NAME.matcher(n).matches()) {
                    return "unexpected file in vectors/: " + n;
                }
                vectorPaths.add(SafeFiles.inside(project, "vectors/" + n));
            }
        }
        Path tests = project.resolve("tests");
        if (Files.isDirectory(tests) && !Files.isSymbolicLink(tests)) {
            try (Stream<Path> s = Files.list(tests)) {
                for (Path p : s.sorted().toList()) {
                    String n = p.getFileName().toString();
                    if (n.equals("__pycache__")) {
                        continue;
                    }
                    if (!TestGen.HELPER.matcher(n).matches() || Files.isDirectory(p) || Files.isSymbolicLink(p)) {
                        return "unexpected file in tests/: " + n + " (only Python files named like gen_sweep.py or helper.py)";
                    }
                    pyFiles.add(SafeFiles.inside(project, "tests/" + n));
                    if (TestGen.SCRIPT.matcher(n).matches()) {
                        genScripts.add(SafeFiles.inside(project, "tests/" + n));
                    }
                }
            }
        }
        if (!genScripts.isEmpty()) {
            java.util.Set<String> taken = new java.util.HashSet<>();
            for (Path v : vectorPaths) {
                taken.add(base(v));
            }
            Path gen = Files.createDirectories(runDir.resolve("generated"));
            TestGen.Result g = TestGen.run(profile.python, genScripts, taken, gen.resolve("work"), log,
                    Duration.ofSeconds(profile.agentTimeoutS));
            if (!g.problems().isEmpty()) {
                gate(GateResult.fail("G17", more(g.problems())));
                return "test generator failed: " + g.problems().get(0);
            }
            for (TestGen.Generated v : g.vectors()) {
                Path f = gen.resolve(v.name() + ".vec");
                SafeFiles.writeAtomic(f, v.text());
                vectorPaths.add(f);
            }
            gate(GateResult.pass("G17", genScripts.size() + " Python generator(s) produced " + g.vectors().size()
                    + " vectors, identical on two runs (Python " + g.pythonVersion() + ")"));
            notes.add("Generated vectors: " + g.vectors().size() + " from " + genScripts.size() + " script(s) in tests/, Python "
                    + g.pythonVersion() + "; kept in " + project.relativize(gen).toString().replace('\\', '/'));
        }
        if (vectorPaths.isEmpty()) {
            return "no test vectors in vectors/ and no generators in tests/";
        }
        itf = Interface.load(SafeFiles.inside(project, "interface.cfg"));
        plantSpec = Plant.load(SafeFiles.inside(project, profile.plantModel), itf);
        List<String> cols = Vector.columns(itf, plantSpec.outputNames());
        tolerance = new float[cols.size()];
        int k = 0;
        for (Interface.Input in : itf.inputs) {
            tolerance[k++] = in.tol();
        }
        for (Interface.Output o : itf.outputs) {
            tolerance[k++] = o.tol();
        }
        for (Plant.Out o : plantSpec.outputs) {
            tolerance[k++] = o.tol();
        }
        List<Path> inputs = new ArrayList<>(fwFiles);
        for (String f : List.of("profile.cfg", "interface.cfg", "spec/spec.req", profile.plantModel, "limits.cfg", "limits.sig")) {
            inputs.add(SafeFiles.inside(project, f));
        }
        if (plantSpec.fmu != null) {
            inputs.add(SafeFiles.inside(project, plantSpec.fmu));
        }
        for (String f : List.of("mutation_review.txt", "board.cfg")) {
            if (Files.exists(project.resolve(f))) {
                inputs.add(SafeFiles.inside(project, f));
            }
        }
        inputs.addAll(pyFiles);
        inputs.addAll(vectorPaths);
        StringBuilder sb = new StringBuilder();
        for (Path p : inputs) {
            String h = Hashing.sha256(p);
            manifest.put(project.relativize(p).toString().replace('\\', '/'), h);
            sb.append(h).append("  ").append(project.relativize(p).toString().replace('\\', '/')).append('\n');
        }
        SafeFiles.writeAtomic(runDir.resolve("manifest.txt"), sb.toString());
        Path last = project.resolve("jobs").resolve("last_manifest.txt");
        int changed = 0;
        if (Files.exists(last)) {
            List<String> old = Files.readAllLines(last);
            for (String l : sb.toString().split("\n")) {
                if (!old.contains(l)) {
                    changed++;
                    say("       changed: " + l.substring(l.indexOf("  ") + 2), "changed|" + l.substring(l.indexOf("  ") + 2));
                }
            }
        } else {
            changed = inputs.size();
        }
        SafeFiles.writeAtomic(last, sb.toString());
        say("       " + itf.name + ": " + itf.inputs.size() + " inputs, " + itf.outputs.size() + " outputs at "
                + itf.rateHz + " Hz; plant " + plantSpec.kind + " with " + plantSpec.outputs.size() + " output(s)",
                "interface|" + itf.inputs.size() + "|" + itf.outputs.size() + "|" + itf.rateHz);
        say("       " + inputs.size() + " inputs hashed, " + changed + " changed since last run; tools verified",
                "intake|" + inputs.size() + "|" + changed);
        return null;
    }

    private static String airgap() {
        try {
            List<String> up = new ArrayList<>();
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (ni.isUp() && !ni.isLoopback()) {
                    up.add(ni.getName());
                }
            }
            return up.isEmpty() ? null : "network interface(s) up: " + String.join(", ", up);
        } catch (SocketException e) {
            return "cannot list network interfaces";
        }
    }

    /* ------------------------------------------------------------ 2. Spec (G0, G5, G14) */

    private String spec(Path log) throws Exception {
        List<String> errors = new ArrayList<>();
        Map<String, Requirements.Req> reqs = Requirements.lint(SafeFiles.inside(project, "spec/spec.req"), errors);
        reqArray = reqs.values().toArray(new Requirements.Req[0]);
        gate(errors.isEmpty() ? GateResult.pass("G0", reqs.size() + " requirements, all numbered, unique and measurable")
                : GateResult.fail("G0", more(errors)));
        if (!errors.isEmpty()) {
            return "spec lint failed";
        }
        for (Path p : vectorPaths) {
            try {
                vectors.add(Vector.load(p, itf, plantSpec.outputNames()));
            } catch (InputException e) {
                gate(GateResult.fail("G5", "invalid vector: " + e.getMessage()));
                return "a test vector is invalid";
            }
        }
        List<String> tr = Requirements.trace(reqs, vectors);
        gate(tr.isEmpty() ? GateResult.pass("G5", "every requirement has a test vector (" + vectors.size() + " vectors, "
                + vectors.stream().mapToInt(v -> v.asserts.size()).sum() + " assertions)") : GateResult.fail("G5", tr.get(0)));
        if (!tr.isEmpty()) {
            return "requirement coverage failed";
        }
        Path cfg = SafeFiles.inside(project, "limits.cfg");
        byte[] s;
        try {
            s = java.util.Base64.getDecoder().decode(Files.readString(SafeFiles.inside(project, "limits.sig")).strip());
        } catch (IllegalArgumentException e) {
            s = new byte[0];
        }
        if (!Keys.verify(Keys.loadPublic(Keys.defaultDir()), Files.readAllBytes(cfg), s)) {
            gate(GateResult.fail("G14", "limits.cfg is not signed by the key owner (changed or unsigned)"));
            return "board limits not trusted";
        }
        Limits lim = Limits.load(cfg);
        List<String> p = lim.check(vectors, fwFiles, itf);
        gate(p.isEmpty() ? GateResult.pass("G14", "all test values and firmware safety constants inside signed limits for "
                + lim.board) : GateResult.fail("G14", more(p)));
        return p.isEmpty() ? null : "value outside safe operating limits";
    }

    /* ------------------------------------------------------------ 3. Build (G1-G4) */

    private List<String> compileShared(Path outLib, List<String> sources, boolean coverage) {
        List<String> so = new ArrayList<>(List.of(profile.compiler));
        if (coverage) {
            so.addAll(List.of("-std=c11", "-O0", "-g", "--coverage", "-fPIC", "-shared"));
        } else {
            so.addAll(WARN_FLAGS);
            so.addAll(List.of("-fPIC", "-shared", "-nostdlib"));
        }
        so.addAll(List.of("-o", outLib.toString()));
        so.addAll(sources);
        return so;
    }

    private List<String> cSources() {
        List<String> c = new ArrayList<>();
        for (Path p : fwFiles) {
            if (p.toString().endsWith(".c")) {
                c.add(p.toString());
            }
        }
        return c;
    }

    private String build(Path log) throws Exception {
        List<String> v = new ArrayList<>();
        for (Path p : fwFiles) {
            v.addAll(SourceScan.scan(p));
        }
        gate(v.isEmpty() ? GateResult.pass("G1", fwFiles.size() + " firmware files clean") : GateResult.fail("G1", more(v)));
        if (!v.isEmpty()) {
            return "source policy violation";
        }
        Duration to = Duration.ofSeconds(profile.agentTimeoutS);
        List<Path> objs = new ArrayList<>();
        for (Path src : fwFiles) {
            String n = src.getFileName().toString();
            if (!n.endsWith(".c")) {
                continue;
            }
            Path obj = buildDir.resolve(n.replace(".c", ".o"));
            List<String> cmd = new ArrayList<>(List.of(profile.compiler));
            cmd.addAll(WARN_FLAGS);
            cmd.addAll(List.of("-ffreestanding", "-fno-builtin", "-fstack-usage", "-c", src.toString(), "-o", obj.toString()));
            Proc.Result r = Proc.run(cmd, buildDir, log, to);
            if (!r.ok()) {
                gate(GateResult.fail("G2", "compile of " + n + (r.timedOut() ? " timed out" : " failed with warnings or errors")));
                return "build failed; see " + project.relativize(log);
            }
            objs.add(obj);
        }
        if (!Proc.run(compileShared(buildDir.resolve(LIBFW), cSources(), false), buildDir, log, to).ok()) {
            gate(GateResult.fail("G2", "host library build failed"));
            return "build failed; see " + project.relativize(log);
        }
        List<String> link = new ArrayList<>(List.of(profile.compiler, "-r", "-nostdlib", "-o", buildDir.resolve("fw_all.o").toString()));
        objs.forEach(o -> link.add(o.toString()));
        if (!Proc.run(link, buildDir, log, to).ok()) {
            gate(GateResult.fail("G2", "partial link failed"));
            return "link failed";
        }
        gate(GateResult.pass("G2", objs.size() + " unit(s), strict flags, zero warnings (" + profile.compiler + ")"));
        Path nm = buildDir.resolve("nm.txt");
        if (!Proc.run(List.of("nm", "-u", buildDir.resolve("fw_all.o").toString()), buildDir, nm, to).ok()) {
            gate(GateResult.fail("G3", "nm failed"));
            return "symbol check failed";
        }
        List<String> syms = BinaryChecks.undefinedSymbols(nm);
        gate(syms.isEmpty() ? GateResult.pass("G3", "linked firmware needs no outside symbols (no libc, no OS calls)")
                : GateResult.fail("G3", syms.get(0)));
        if (!syms.isEmpty()) {
            return "forbidden dependency in object code";
        }
        Path nmDef = buildDir.resolve("nm_defined.txt");
        if (!Proc.run(List.of("nm", "-g", "--defined-only", buildDir.resolve("fw_all.o").toString()), buildDir, nmDef, to).ok()) {
            gate(GateResult.fail("G3", "nm failed"));
            return "symbol check failed";
        }
        List<String> abi = BinaryChecks.abi(nmDef, List.of("fw_abi_version", "fw_n_in", "fw_n_out", "fw_state_size", "fw_init",
                "fw_step", "fw_progress_token"));
        if (!abi.isEmpty()) {
            gate(GateResult.fail("G3", abi.get(0)));
            return "firmware interface not exported";
        }
        List<Path> su = new ArrayList<>();
        try (Stream<Path> s = Files.list(buildDir)) {
            s.filter(p -> p.toString().endsWith(".su")).sorted().forEach(su::add);
        }
        List<String> st = BinaryChecks.stack(su, profile.stackMaxFrame);
        gate(st.isEmpty() ? GateResult.pass("G4", "all stack frames static and within " + profile.stackMaxFrame + " bytes")
                : GateResult.fail("G4", st.get(0)));
        return st.isEmpty() ? null : "stack budget exceeded";
    }

    /* ------------------------------------------------------------ SIL helpers */

    private List<String> javaCmd(String module, String mainClass) {
        Path java = Path.of(System.getProperty("java.home"), "bin", "java");
        return new ArrayList<>(List.of(java.toString(), "--enable-preview", "--enable-native-access=" + module,
                "-Xshare:off", "-p", home.resolve("build/mods").toString(), "-m", module + "/" + mainClass));
    }

    /** One SIL process for many vectors: lib, project, interface, model, work dir, then vec/trace pairs. */
    List<String> silCommand(Path lib, Path work, List<Path[]> pairs) throws InputException {
        List<String> c = javaCmd("kg.sil", "kg.sil.SilMain");
        c.addAll(List.of(lib.toString(), project.toString(), SafeFiles.inside(project, "interface.cfg").toString(),
                SafeFiles.inside(project, profile.plantModel).toString(), work.toString()));
        for (Path[] p : pairs) {
            c.add(p[0].toString());
            c.add(p[1].toString());
        }
        return c;
    }

    private static String base(Path vec) {
        String n = vec.getFileName().toString();
        return n.substring(0, n.length() - 4);
    }

    private String runVectors(Path lib, Path dir, String suffix, Path log) throws Exception {
        List<Path[]> pairs = new ArrayList<>();
        for (Path vec : vectorPaths) {
            pairs.add(new Path[] {vec, dir.resolve(base(vec) + suffix)});
        }
        Proc.Result r = Proc.run(silCommand(lib, buildDir, pairs), project, log, Duration.ofSeconds(profile.agentTimeoutS));
        return r.ok() ? null : (r.timedOut() ? "SIL timed out" : "SIL crashed or rejected its input; see " + project.relativize(log));
    }

    /* ------------------------------------------------------------ 4. SIL, 5. Quality, 6. Compare */

    private String sil(Path log) throws Exception {
        String e = runVectors(buildDir.resolve(LIBFW), traceDir, ".trace", log);
        if (e != null) {
            return e;
        }
        e = runVectors(buildDir.resolve(LIBFW), traceDir, ".rerun", log);
        if (e != null) {
            return e;
        }
        say("       " + vectors.size() + " vectors run, then run again in a second independent process", "sil|" + vectors.size());
        return null;
    }

    private String quality(Path log) throws Exception {
        int passed = 0;
        List<String> fails = new ArrayList<>();
        StringBuilder detail = new StringBuilder();
        for (int i = 0; i < vectors.size(); i++) {
            Vector v = vectors.get(i);
            String b = base(vectorPaths.get(i));
            List<String> problems = TraceCheck.check(v, Trace.read(traceDir.resolve(b + ".trace")));
            if (problems.isEmpty()) {
                passed++;
                detail.append("PASS ").append(b).append(' ').append(v.req).append('\n');
            } else {
                for (String p : problems) {
                    fails.add(b + " (" + v.req + "): " + p);
                    detail.append("FAIL ").append(b).append(' ').append(v.req).append(": ").append(p).append('\n');
                }
            }
        }
        Files.writeString(log, detail.toString(), StandardCharsets.UTF_8, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        gate(fails.isEmpty() ? GateResult.pass("G8", passed + "/" + vectors.size()
                + " vectors meet every assertion, including injected faults") : GateResult.fail("G8", more(fails)));
        return fails.isEmpty() ? null : "requirement or fault assertion failed";
    }

    private String compare(Path log) throws Exception {
        for (Path vec : vectorPaths) {
            Trace a = Trace.read(traceDir.resolve(base(vec) + ".trace"));
            String d = TraceCompare.firstDivergence(a, Trace.read(traceDir.resolve(base(vec) + ".rerun")),
                    TraceCompare.exact(a), true);
            if (d != null) {
                gate(GateResult.fail("G10", base(vec) + " is not repeatable: " + d));
                return "non-deterministic result";
            }
        }
        if (!plantSpec.calibrated()) {
            if (profile.calibrationRequired) {
                gate(GateResult.fail("G10", "plant model is UNCALIBRATED and the profile requires calibration"));
                return "uncalibrated plant model";
            }
            notes.add("PLANT MODEL UNCALIBRATED: SIL results prove firmware logic against the model only, "
                    + "not against the real device");
        }
        gate(GateResult.pass("G10", "every trace repeated bit-for-bit in an independent process"
                + (plantSpec.calibrated() ? "" : "; plant model uncalibrated")));
        return null;
    }

    /* ------------------------------------------------------------ 7. Coverage (G6) */

    private String coverage(Path log) throws Exception {
        Path cov = Files.createDirectories(buildDir.resolve("coverage"));
        List<String> copies = new ArrayList<>();
        for (Path f : fwFiles) {
            Path dst = cov.resolve(f.getFileName().toString());
            Files.copy(f, dst);
            if (dst.toString().endsWith(".c")) {
                copies.add(dst.getFileName().toString());
            }
        }
        Duration to = Duration.ofSeconds(profile.agentTimeoutS);
        Path lib = cov.resolve(LIBFW);
        List<String> link = new ArrayList<>(List.of(profile.compiler, "--coverage", "-shared", "-o", lib.toString()));
        for (String c : copies) {
            String obj = c.substring(0, c.length() - 2) + ".o";
            if (!Proc.run(List.of(profile.compiler, "-std=c11", "-O0", "-g", "--coverage", "-fPIC", "-c", c, "-o", obj),
                    cov, log, to).ok()) {
                gate(GateResult.fail("G6", "could not build the coverage-instrumented library"));
                return "coverage build failed";
            }
            link.add(obj);
        }
        if (!Proc.run(link, cov, log, to).ok()) {
            gate(GateResult.fail("G6", "could not link the coverage-instrumented library"));
            return "coverage build failed";
        }
        String e = runVectors(lib, cov, ".covtrace", log);
        if (e != null) {
            return "coverage run: " + e;
        }
        double linesHit = 0;
        double linesTotal = 0;
        double brHit = 0;
        double brTotal = 0;
        for (String c : copies) {
            Path gl = cov.resolve(c + ".gcov.txt");
            String gcov = profile.compiler.equals("clang") ? "llvm-cov" : "gcov";
            List<String> gc = gcov.equals("gcov") ? List.of("gcov", "-b", "-c", "-o", cov.toString(), c)
                    : List.of("llvm-cov", "gcov", "-b", "-c", "-o", cov.toString(), c);
            if (!Proc.run(gc, cov, gl, to).ok()) {
                gate(GateResult.fail("G6", gcov + " failed on " + c));
                return "coverage report failed";
            }
            String txt = Files.readString(gl);
            int at = txt.indexOf("File '" + c + "'");
            if (at < 0) {
                at = txt.indexOf(c + "'");
            }
            String section = at >= 0 ? txt.substring(at) : txt;
            Matcher ml = GCOV_LINES.matcher(section);
            if (ml.find()) {
                double n = Double.parseDouble(ml.group(2));
                linesTotal += n;
                linesHit += n * Double.parseDouble(ml.group(1)) / 100.0;
            }
            Matcher mb = GCOV_TAKEN.matcher(section);
            if (mb.find()) {
                double n = Double.parseDouble(mb.group(2));
                brTotal += n;
                brHit += n * Double.parseDouble(mb.group(1)) / 100.0;
            }
        }
        if (linesTotal == 0) {
            gate(GateResult.fail("G6", "no coverage data was produced"));
            return "coverage measured nothing";
        }
        double lp = 100.0 * linesHit / linesTotal;
        double bp = brTotal == 0 ? 100.0 : 100.0 * brHit / brTotal;
        String detail = String.format(Locale.ROOT, "lines %.1f%% of %.0f (need %d%%), branches taken %.1f%% of %.0f (need %d%%)",
                lp, linesTotal, profile.coverageMinLines, bp, brTotal, profile.coverageMinBranches);
        boolean pass = lp + 1e-9 >= profile.coverageMinLines && bp + 1e-9 >= profile.coverageMinBranches;
        gate(pass ? GateResult.pass("G6", detail) : GateResult.fail("G6", detail));
        return pass ? null : "tests do not exercise enough of the firmware";
    }

    /* ------------------------------------------------------------ 8. Mutation (G7) */

    private String mutation(Path log) throws Exception {
        List<Mutator.Mutant> all = new ArrayList<>();
        for (Path f : fwFiles) {
            if (f.toString().endsWith(".c")) {
                all.addAll(Mutator.sites(f));
            }
        }
        List<Mutator.Mutant> picked = Mutator.pick(all, profile.mutantsMax);
        if (picked.isEmpty()) {
            gate(GateResult.fail("G7", "no mutation sites found in firmware"));
            return "mutation testing impossible";
        }
        Path mdir = Files.createDirectories(runDir.resolve("mutants"));
        Duration to = Duration.ofSeconds(profile.agentTimeoutS);
        int killed = 0;
        int valid = 0;
        List<String> survivors = new ArrayList<>();
        StringBuilder rep = new StringBuilder();
        for (int k = 0; k < picked.size(); k++) {
            Mutator.Mutant m = picked.get(k);
            Path d = Files.createDirectories(mdir.resolve(String.format(Locale.ROOT, "m%03d", k)));
            List<String> cfiles = new ArrayList<>();
            for (Path f : fwFiles) {
                Path dst = d.resolve(f.getFileName().toString());
                if (f.equals(m.file())) {
                    Files.writeString(dst, m.mutatedSource(), StandardCharsets.UTF_8);
                } else {
                    Files.copy(f, dst);
                }
                if (dst.toString().endsWith(".c")) {
                    cfiles.add(dst.toString());
                }
            }
            if (!Proc.run(compileShared(d.resolve(LIBFW), cfiles, false), d, d.resolve("build.log"), to).ok()) {
                rep.append("INVALID  ").append(m.describe()).append(" (rejected by the compiler)\n");
                continue;
            }
            valid++;
            List<Path[]> pairs = new ArrayList<>();
            for (Path vec : vectorPaths) {
                pairs.add(new Path[] {vec, d.resolve(base(vec) + ".trace")});
            }
            Proc.Result r = Proc.run(silCommand(d.resolve(LIBFW), d, pairs), project, d.resolve("sil.log"), to);
            String killedBy = r.ok() ? null : (r.timedOut() ? "timeout" : "crash");
            if (killedBy == null) {
                for (int i = 0; i < vectors.size() && killedBy == null; i++) {
                    Path tr = d.resolve(base(vectorPaths.get(i)) + ".trace");
                    if (!TraceCheck.check(vectors.get(i), Trace.read(tr)).isEmpty()) {
                        killedBy = vectorPaths.get(i).getFileName().toString();
                    }
                }
            }
            if (killedBy != null) {
                killed++;
                rep.append("KILLED   ").append(m.describe()).append(" by ").append(killedBy).append('\n');
            } else {
                survivors.add(m.describe());
                rep.append("SURVIVED ").append(m.describe()).append("  <- no test notices this bug\n");
            }
        }
        Files.writeString(log, rep.toString(), StandardCharsets.UTF_8, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        if (valid == 0) {
            gate(GateResult.fail("G7", "every mutant was rejected by the compiler; nothing measured"));
            return "mutation testing measured nothing";
        }
        Map<String, String> review = loadReview();
        List<String> unexplained = new ArrayList<>();
        int excused = 0;
        for (String sv : survivors) {
            if (review.containsKey(sv)) {
                excused++;
                notes.add("REVIEWED EQUIVALENT MUTANT: " + sv + " - " + review.get(sv));
            } else {
                unexplained.add(sv);
                notes.add("WEAK TEST: planted bug not caught: " + sv);
            }
        }
        for (String id : review.keySet()) {
            if (!survivors.contains(id)) {
                gate(GateResult.fail("G7", "mutation_review.txt excuses '" + id + "', which is not a current survivor; remove it"));
                return "stale mutation review";
            }
        }
        if (excused * 100 > valid * 30) {
            gate(GateResult.fail("G7", excused + " of " + valid + " mutants excused by review; at most 30% may be excused"));
            return "too many reviewed exceptions";
        }
        int denom = valid - excused;
        int score = denom == 0 ? 100 : killed * 100 / denom;
        String detail = killed + "/" + denom + " planted bugs caught (" + score + "%, need "
                + profile.mutationMinScore + "%)" + (excused > 0 ? ", " + excused + " reviewed equivalent" : "")
                + (unexplained.isEmpty() ? "" : "; survivor: " + unexplained.get(0));
        gate(score >= profile.mutationMinScore ? GateResult.pass("G7", detail) : GateResult.fail("G7", detail));
        return score >= profile.mutationMinScore ? null : "tests too weak: planted bugs survived";
    }

    /** Reviewed equivalent mutants: "<mutant id> | <reason of at least 20 characters>". */
    private Map<String, String> loadReview() throws InputException {
        Map<String, String> m = new LinkedHashMap<>();
        if (!Files.exists(project.resolve("mutation_review.txt"))) {
            return m;
        }
        int ln = 0;
        for (String raw : SafeFiles.readLines(SafeFiles.inside(project, "mutation_review.txt"), 65536, 500)) {
            ln++;
            String l = raw.strip();
            if (l.isEmpty() || l.startsWith("#")) {
                continue;
            }
            int bar = l.indexOf(" | ");
            if (bar < 0 || l.substring(bar + 3).strip().length() < 20) {
                throw new InputException("mutation_review.txt:" + ln + ": needs '<mutant> | <reason, 20+ characters>'");
            }
            if (m.put(l.substring(0, bar).strip(), l.substring(bar + 3).strip()) != null) {
                throw new InputException("mutation_review.txt:" + ln + ": duplicate entry");
            }
        }
        return m;
    }

    /* ------------------------------------------------------------ 9. Selftest (G11) */

    private String selftest(Path log) throws Exception {
        SelfTest st = new SelfTest(home.resolve("selftest"), runDir.resolve("selftest"), log, this, project,
                Duration.ofSeconds(profile.agentTimeoutS), itf, plantSpec, buildDir.resolve(LIBFW), buildDir, profile.python);
        List<String> problems = st.run();
        gate(problems.isEmpty() ? GateResult.pass("G11", st.count() + " negative controls all rejected as expected")
                : GateResult.fail("G11", problems.get(0)));
        return problems.isEmpty() ? null : "a gate accepted known-bad input";
    }

    /* ------------------------------------------------------------ PIL (G15, G16, G10 SIL vs PIL, G9) */

    private BoardSpec board() throws Exception {
        if (!Files.exists(project.resolve("board.cfg"))) {
            throw new Blocked("this tier needs a board.cfg describing the target; none in the project");
        }
        return BoardSpec.load(SafeFiles.inside(project, "board.cfg"));
    }

    private String pil(Path log) throws Exception {
        BoardSpec b = board();
        if (!b.virtual) {
            List<Detect.UsbDevice> usb = Detect.scanUsb();
            say("       USB scan: " + (usb.isEmpty() ? "no known probe or USB-serial device found"
                    : usb.stream().map(Detect.UsbDevice::describe).reduce((x, y) -> x + "; " + y).orElse("")), "usb|" + usb.size());
            if (usb.stream().noneMatch(d -> d.id().equals(b.probe))) {
                throw new Blocked("expected probe " + b.probe + " (" + Detect.KNOWN.getOrDefault(b.probe, "unknown") + ") is not connected");
            }
            throw new Blocked("probe found; on-chip PIL needs the cross-compiled image and kg_pil_target port (see docs/HARDWARE.md)");
        }
        String fwHash = Hashing.sha256(buildDir.resolve(LIBFW));
        List<String> cmd = javaCmd("kg.rig", "kg.rig.VirtualBoard");
        cmd.set(2, "--enable-native-access=kg.sil");
        cmd.addAll(List.of(buildDir.resolve(LIBFW).toString(), Integer.toString(itf.inputs.size()),
                Integer.toString(itf.outputs.size()), b.virtualName, b.virtualRev, Long.toHexString(b.virtualChip),
                Integer.toString(b.virtualFaultPpm), "20261026"));
        Process p = Proc.startPiped(cmd, project, log);
        Link link = new Link(p.getInputStream(), p.getOutputStream(), Duration.ofMillis(b.timeoutMs), b.retries);
        try {
            PilRunner.Identity id = PilRunner.hello(link);
            say("       detected: " + id.describe(), "detected|" + id.describe());
            List<String> idp = PilRunner.checkIdentity(id, b, fwHash, itf);
            gate(idp.isEmpty() ? GateResult.pass("G15", "connected target matches board.cfg: " + id.describe())
                    : GateResult.fail("G15", more(idp)));
            if (!idp.isEmpty()) {
                return "wrong target connected; nothing was run on it";
            }
            PilRunner.Remote remote = new PilRunner.Remote(link, itf.inputs.size(), itf.outputs.size());
            long deadline = System.nanoTime() + Duration.ofSeconds(profile.agentTimeoutS).toNanos();
            for (int i = 0; i < vectors.size(); i++) {
                try (Plant plant = Plant.create(plantSpec, project, buildDir)) {
                    Engine.run(itf, plantSpec, plant, vectors.get(i), remote, traceDir.resolve(base(vectorPaths.get(i)) + ".pil"));
                }
                if (System.nanoTime() > deadline) {
                    gate(GateResult.fail("G16", "PIL exceeded its " + profile.agentTimeoutS + " s budget; link too slow or too noisy ("
                            + link.stats().summary() + ")"));
                    return "PIL time budget exceeded";
                }
            }
            Link.Stats st = link.stats();
            gate(GateResult.pass("G16", "link held for " + vectors.size() + " vectors: " + st.summary()));
            notes.add("PIL link (" + (b.virtual ? "simulated board, " + b.virtualFaultPpm + " ppm injected byte errors" : "serial")
                    + "): " + st.summary());
            for (Path vec : vectorPaths) {
                Trace a = Trace.read(traceDir.resolve(base(vec) + ".trace"));
                Trace c = Trace.read(traceDir.resolve(base(vec) + ".pil"));
                String d = TraceCompare.firstDivergence(a, c, tolerance, b.virtual);
                if (d != null) {
                    gate(GateResult.fail("G10", "SIL and PIL disagree on " + base(vec) + ": " + d));
                    return "tiers disagree";
                }
                List<String> pc = TraceCheck.check(vectors.get(vectorPaths.indexOf(vec)), c);
                if (!pc.isEmpty()) {
                    gate(GateResult.fail("G8", "on PIL, " + base(vec) + ": " + pc.get(0)));
                    return "requirement fails on the target";
                }
            }
            gate(GateResult.pass("G10", "SIL and PIL agree tick by tick on all " + vectors.size() + " vectors"
                    + (b.virtual ? " (exactly)" : " (within per-signal tolerances)")));
            return timing(remote, b.virtual);
        } catch (Link.LinkLost e) {
            boolean safe = PilRunner.commandSafe(link);
            gate(GateResult.fail("G16", "link lost: " + e.getMessage()));
            return "link to the target was lost; " + (safe ? "board confirmed safe state"
                    : "board did not confirm safe state - check hardware before touching it");
        } finally {
            link.close();
            p.descendants().forEach(ProcessHandle::destroyForcibly);
            p.destroyForcibly();
        }
    }

    /**
     * G9: worst-case execution time of one firmware step against the interface budget. Only a real
     * target can prove timing; a simulated board reports host-CPU numbers as an estimate.
     */
    private String timing(PilRunner.Remote remote, boolean virtual) throws IOException {
        String stats = String.format(Locale.ROOT, "median %.1f us, p99 %.1f us, worst %.1f us",
                remote.percentileNs(50) / 1000.0, remote.percentileNs(99) / 1000.0, remote.maxExecNs() / 1000.0);
        if (virtual) {
            notes.add("TIMING IS A HOST PROXY: simulated board step times (" + stats + ") come from this PC's CPU; "
                    + "real step time must be measured on the target chip");
            if (profile.timingRequired) {
                gate(GateResult.fail("G9", "timing can only be proven on a real target; the simulated board gives host-CPU numbers ("
                        + stats + ")"));
                return "timing needs a real target";
            }
            return null;
        }
        if (itf.timingBudgetUs <= 0) {
            gate(GateResult.fail("G9", "interface.cfg declares no TIMING_BUDGET_US, so step time cannot be judged"));
            return "no timing budget";
        }
        boolean ok = remote.maxExecNs() <= itf.timingBudgetUs * 1000L;
        String detail = "measured on the target: " + stats + " against a " + itf.timingBudgetUs + " us budget";
        gate(ok ? GateResult.pass("G9", detail) : GateResult.fail("G9", detail));
        return ok ? null : "a firmware step exceeded its time budget";
    }

    private String hil(Path log) throws Exception {
        BoardSpec b = board();
        if (b.virtual) {
            throw new Blocked("HIL needs real hardware; board.cfg has TARGET virtual (PIL already verified the simulated board)");
        }
        throw new Blocked("HIL bench controller not connected; flashing and bench tests stay disabled (see docs/HARDWARE.md)");
    }

    /* ------------------------------------------------------------ Integrity, Ledger, Triage, Memory */

    private String integrity(Path log) throws Exception {
        for (Map.Entry<String, String> e : manifest.entrySet()) {
            Path p = SafeFiles.inside(project, e.getKey());
            if (!Files.exists(p) || !Hashing.sha256(p).equals(e.getValue())) {
                gate(GateResult.fail("G12", "input changed during the run: " + e.getKey()));
                return "inputs changed during the run";
            }
        }
        PublicKey pub = Keys.loadPublic(Keys.defaultDir());
        List<String> base = Baseline.verify(home, pub);
        if (!base.isEmpty()) {
            gate(GateResult.fail("G12", "tool integrity: " + base.get(0)));
            return "tools changed during the run";
        }
        List<String> led = Ledger.verify(project.resolve("evidence").resolve("ledger.log"), project, pub, true);
        if (!led.isEmpty()) {
            gate(GateResult.fail("G12", "existing evidence ledger: " + led.get(0)));
            return "ledger integrity failed";
        }
        gate(GateResult.pass("G12", "inputs unchanged during run, tools match signed baseline, ledger intact"));
        return null;
    }

    private String ledger(Verdict.Outcome v) throws Exception {
        PrivateKey key = Keys.loadPrivate(Keys.defaultDir());
        Map<String, Path> files = new LinkedHashMap<>();
        for (String f : List.of("manifest.txt", "gates.txt", "verdict.txt", "report.txt")) {
            Path p = runDir.resolve(f);
            if (Files.exists(p)) {
                files.put(project.relativize(p).toString().replace('\\', '/'), p);
            }
        }
        try (Stream<Path> s = Files.list(traceDir)) {
            for (Path p : s.sorted().toList()) {
                if (p.toString().endsWith(".trace") || p.toString().endsWith(".pil")) {
                    files.put(project.relativize(p).toString().replace('\\', '/'), p);
                }
            }
        }
        String platform = (System.getProperty("os.name") + "-" + System.getProperty("os.version") + "-"
                + System.getProperty("os.arch")).replaceAll("[^A-Za-z0-9._+:-]", "_");
        Path ledgerFile = project.resolve("evidence").resolve("ledger.log");
        Files.createDirectories(ledgerFile.getParent());
        String h = Ledger.append(ledgerFile, project, runId, v.word(), platform, files, key);
        say("       entry " + h.substring(0, 16) + "... signed, " + files.size() + " evidence files hashed",
                "ledger|" + h + "|" + files.size());
        return null;
    }

    private String triage(Path log) throws Exception {
        say("       first failure: agent " + failedAgent + " - " + failReason, "triage|" + failedAgent + "|" + failReason);
        for (GateResult g : gates) {
            if (!g.pass()) {
                say("       failing gate:  " + g.gate() + " - " + g.detail(), "triage-gate|" + g.gate() + "|" + g.detail());
                break;
            }
        }
        if (failLog != null && Files.exists(failLog)) {
            List<String> l = Files.readAllLines(failLog, StandardCharsets.UTF_8);
            for (String s : l.subList(Math.max(0, l.size() - 8), l.size())) {
                say("       | " + s, "triage-log|" + s);
            }
        }
        return null;
    }

    private String memoryKeeper(Verdict.Outcome v, String tier) throws Exception {
        String firstFail = gates.stream().filter(g -> !g.pass()).map(GateResult::gate).findFirst().orElse("-");
        kg.harness.Memory.add(project, "runs", runId, v.word() + " tier=" + tier + " gates=" + gates.size()
                + " first-failing=" + firstFail + " profile=" + profile.name);
        List<String> queued = kg.harness.Memory.list(project, "review_queue");
        int added = 0;
        for (String n : notes) {
            if (n.startsWith("WEAK TEST") || n.startsWith("PLANT MODEL UNCALIBRATED") || n.startsWith("AIR-GAP NOT")
                    || n.startsWith("TIMING IS A HOST PROXY")) {
                String text = n.length() > 480 ? n.substring(0, 480) : n;
                if (queued.stream().noneMatch(q -> q.endsWith(text))) {
                    kg.harness.Memory.add(project, "review_queue", runId, text);
                    added++;
                }
            }
        }
        say("       run recorded in memory; " + added + " new item(s) for review", "memory|" + added);
        return null;
    }

    private void writeReport(Verdict.Outcome v, String tier) throws IOException {
        StringBuilder sb = new StringBuilder();
        sb.append("KINDGLEAM VERIFICATION REPORT\n");
        sb.append("Run        ").append(runId).append('\n');
        sb.append("Project    ").append(project.getFileName()).append('\n');
        sb.append("Profile    ").append(profile.name).append('\n');
        sb.append("Tier       ").append(tier.toUpperCase(Locale.ROOT)).append('\n');
        sb.append("Platform   ").append(System.getProperty("os.name")).append(' ')
                .append(System.getProperty("os.version")).append(' ').append(System.getProperty("os.arch")).append('\n');
        if (itf != null) {
            sb.append("Interface  ").append(itf.name).append(", ").append(itf.rateHz).append(" Hz\n");
            sb.append("\nSignals\n");
            for (Interface.Input in : itf.inputs) {
                sb.append(String.format(Locale.ROOT, "  in   %-14s %-6s %s..%s  %s%n", in.name(), in.unit(), in.min(), in.max(),
                        in.source().name().toLowerCase(Locale.ROOT)));
            }
            for (Interface.Output o : itf.outputs) {
                sb.append(String.format(Locale.ROOT, "  out  %-14s %-6s %s..%s  safe %s%n", o.name(), o.unit(), o.min(), o.max(), o.safe()));
            }
            if (plantSpec != null) {
                for (Plant.Out o : plantSpec.outputs) {
                    sb.append(String.format(Locale.ROOT, "  plant %-13s %-6s (%s model)%n", o.name(), o.unit(), plantSpec.kind));
                }
            }
        }
        sb.append("\nRequirements\n");
        for (Requirements.Req r : reqArray) {
            sb.append("  ").append(r.id()).append("  [").append(String.join(",", r.tiers())).append("]  ").append(r.text()).append('\n');
        }
        sb.append("\nGates\n");
        for (GateResult g : gates) {
            sb.append("  ").append(g.line()).append('\n');
        }
        sb.append("\nNotes\n");
        for (String n : notes) {
            sb.append("  - ").append(n).append('\n');
        }
        sb.append("\nVERDICT ").append(v.word()).append("  ").append(v.reason()).append('\n');
        SafeFiles.writeAtomic(runDir.resolve("report.txt"), sb.toString());
        for (String n : notes) {
            say("       note: " + n, "note|" + n);
        }
    }

    /* ------------------------------------------------------------ Eval mode */

    int runEval(boolean acceptGolden) throws Exception {
        profile = Profile.load(SafeFiles.inside(project, "profile.cfg"));
        Path jobs = project.resolve("jobs");
        Files.createDirectories(jobs);
        try (FileChannel ch = FileChannel.open(jobs.resolve(".lock"), StandardOpenOption.CREATE,
                StandardOpenOption.WRITE); FileLock lock = ch.tryLock()) {
            if (lock == null) {
                throw new InputException("another kindgleam run holds the workspace lock");
            }
            newRun(jobs, "eval");
            say("Kindgleam eval  " + runId + "  (checks the verification system, not the firmware)", "eval|" + runId);
            boolean ok = agent("Intake", this::intake) && agent("Spec", this::spec) && agent("Build", this::build)
                    && agent("SIL", this::sil)
                    && agent("Flaky", this::flaky)
                    && agent("Golden", log -> golden(acceptGolden))
                    && agent("Selftest", this::selftest)
                    && agent("Integrity", this::integrity);
            if (!ok) {
                agent("Triage", this::triage);
            }
            kg.harness.Memory.add(project, "runs", runId, "EVAL " + (ok ? "PASS" : "FAIL"));
            say("", null);
            say("EVAL " + (ok ? "PASS" : "FAIL") + (ok ? "  the verification system is behaving correctly"
                    : "  " + failedAgent + ": " + failReason), "eval-result|" + (ok ? "PASS" : "FAIL"));
            return ok ? 0 : 1;
        }
    }

    private String flaky(Path log) throws Exception {
        for (int k = 1; k <= 3; k++) {
            String e = runVectors(buildDir.resolve(LIBFW), traceDir, ".repeat" + k, log);
            if (e != null) {
                return e;
            }
            for (Path vec : vectorPaths) {
                Trace a = Trace.read(traceDir.resolve(base(vec) + ".trace"));
                String d = TraceCompare.firstDivergence(a, Trace.read(traceDir.resolve(base(vec) + ".repeat" + k)),
                        TraceCompare.exact(a), true);
                if (d != null) {
                    gate(GateResult.fail("E1", base(vec) + " is flaky: " + d));
                    return "non-repeatable result";
                }
            }
        }
        gate(GateResult.pass("E1", vectors.size() + " vectors x 5 independent runs, all bit-identical"));
        return null;
    }

    private String golden(boolean accept) throws Exception {
        Path g = project.resolve("evals").resolve("golden");
        String manifestNow = Files.readString(runDir.resolve("manifest.txt"));
        if (accept) {
            Files.createDirectories(g);
            try (Stream<Path> s = Files.list(g)) {
                for (Path old : s.toList()) {
                    Files.delete(old);
                }
            }
            for (Path vec : vectorPaths) {
                Files.copy(traceDir.resolve(base(vec) + ".trace"), g.resolve(base(vec) + ".trace"));
            }
            SafeFiles.writeAtomic(g.resolve("manifest.txt"), manifestNow);
            gate(GateResult.pass("E2", "golden traces accepted for " + vectors.size() + " vectors"));
            kg.harness.Memory.add(project, "decisions", runId, "golden traces accepted for " + vectors.size() + " vectors");
            return null;
        }
        if (!Files.exists(g.resolve("manifest.txt"))) {
            gate(GateResult.pass("E2", "no golden set yet; run 'kindgleam eval --accept-golden' once to create one"));
            return null;
        }
        if (!Files.readString(g.resolve("manifest.txt")).equals(manifestNow)) {
            gate(GateResult.pass("E2", "inputs changed since the golden set; drift check needs a new golden set"));
            notes.add("GOLDEN SET STALE: firmware or tests changed; re-accept after review");
            return null;
        }
        for (Path vec : vectorPaths) {
            Trace a = Trace.read(SafeFiles.inside(project, "evals/golden/" + base(vec) + ".trace"));
            String d = TraceCompare.firstDivergence(a, Trace.read(traceDir.resolve(base(vec) + ".trace")), TraceCompare.exact(a), true);
            if (d != null) {
                gate(GateResult.fail("E2", "same inputs, different result than the golden set (tool drift) on " + base(vec) + ": " + d));
                return "verification drift";
            }
        }
        gate(GateResult.pass("E2", "same inputs give the same traces as the golden set: no tool drift"));
        return null;
    }
}
