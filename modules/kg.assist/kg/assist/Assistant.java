package kg.assist;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import kg.core.InputException;
import kg.core.Interface;
import kg.core.SafeFiles;
import kg.core.Vector;
import kg.harness.Memory;
import kg.sil.Plant;

/**
 * The write, check and fix loop. The assistant only proposes: it works on a scratch copy of the
 * project, runs Kindgleam's own fast gates on its proposal, feeds failures back to the model and
 * tries again. The person decides whether to apply the result, and a real verdict still needs a
 * normal Verify run. Every request, reply and check is written to a transcript in jobs/.
 */
public final class Assistant {
    /** The fixed jobs the assistant can do. There is no open chat. */
    public enum Task {
        FIX("Fix a failed check"),
        WRITE("Write code for a requirement"),
        OPTIMIZE("Make a firmware file faster and smaller"),
        EXPLAIN("Explain a firmware file"),
        VECTOR("Write a test vector for a requirement"),
        PYTEST("Write a Python test generator for a requirement"),
        REVIEW("Review the last run and suggest improvements");

        public final String label;

        Task(String label) {
            this.label = label;
        }
    }

    /** target is a firmware file name (FIX, WRITE, EXPLAIN) or a requirement id (WRITE, VECTOR). */
    public record Request(Task task, String file, String requirement, String note) { }

    /** What the assistant hands back for the person to accept or reject. */
    public record Proposal(Request request, String relPath, String before, String after, String explanation,
                           boolean checked, boolean checkPassed, String checkSummary, int attempts, Path transcript) {
        public boolean hasChange() {
            return after != null && !after.equals(before);
        }
    }

    /** Progress callbacks, called from the worker thread. */
    public interface Listener {
        void status(String text);

        void token(String text);
    }

    static final String SYSTEM = """
            You are the Kindgleam firmware assistant. You help only with the embedded firmware project described \
            below and its tests.
            Rules:
            - C is C11 for small microcontrollers: static memory only, no malloc/free, no recursion, no printf or \
            other stdio, no floating-point exceptions, every loop bounded.
            - C++ (if used) has no exceptions, no RTTI and no heap.
            - Keep the firmware interface exactly as given (function names, signatures, signal order).
            - Use only names, signals, limits and registers that appear in the project context. If something you \
            need is not given, write a comment saying it is unknown instead of inventing a value or address.
            - Never write code that uses a network, starts processes, deletes files or loads code.
            - Keep the answer short: one or two sentences, then the complete file in one fenced code block.""";

    private static final int MAX_ATTEMPTS = 3;
    private static final int MAX_FILE_CHARS = 14000;
    private static final Pattern FENCE = Pattern.compile("```[a-zA-Z+]*\\s*\\n(.*?)```", Pattern.DOTALL);

    private final Path home;
    private final Path project;
    private final EngineClient engine;
    private volatile boolean cancelled;

    public Assistant(Path home, Path project, EngineClient engine) {
        this.home = home;
        this.project = project;
        this.engine = engine;
    }

    public void cancel() {
        cancelled = true;
        engine.stop();
    }

    /** Firmware files the assistant may read and propose changes to. */
    public static List<String> firmwareFiles(Path project) {
        List<String> out = new ArrayList<>();
        try (Stream<Path> s = Files.list(project)) {
            s.map(p -> p.getFileName().toString()).filter(n -> n.matches("(fw|wd)_[A-Za-z0-9_]+\\.(c|h|cpp|hpp)")).sorted()
                    .forEach(out::add);
        } catch (IOException e) {
            // none
        }
        return out;
    }

    public Proposal run(Request r, Listener ui) throws IOException, InputException {
        cancelled = false;
        String why = Guard.checkNote(r.note());
        if (why != null) {
            throw new InputException(why);
        }
        Path job = newJob();
        Path transcript = job.resolve("transcript.txt");
        log(transcript, "Kindgleam assistant  " + Instant.now() + "\nTASK " + r.task() + "  file=" + r.file() + "  req="
                + r.requirement() + "\nNOTE " + (r.note() == null ? "" : r.note()) + "\n");

        String rel = target(r);
        String before = rel == null ? null : read(rel);
        List<EngineClient.Msg> msgs = new ArrayList<>();
        msgs.add(new EngineClient.Msg("system", SYSTEM + "\n\n" + context(r, rel, before)));
        msgs.add(new EngineClient.Msg("user", instruction(r, rel)));
        log(transcript, "\n=== SYSTEM ===\n" + msgs.get(0).text() + "\n\n=== USER ===\n" + msgs.get(1).text() + "\n");

        if (r.task() == Task.EXPLAIN || r.task() == Task.REVIEW) {
            ui.status(r.task() == Task.REVIEW ? "Reading the last run..." : "Reading " + rel + "...");
            EngineClient.Result res = engine.generate(msgs, r.task() == Task.REVIEW ? 1000 : 700, 600, ui::token);
            log(transcript, "\n=== REPLY (" + res.tokens() + " tokens, " + res.millis() + " ms) ===\n" + res.text() + "\n");
            List<String> p = Guard.checkReply(res.text());
            String text = p.isEmpty() ? res.text().strip() : "The reply was withheld: " + String.join("; ", p);
            return new Proposal(r, rel, before, before, text, false, false, "", 1, transcript);
        }

        Path work = job.resolve("work");
        copyProject(work);
        if (r.task() == Task.PYTEST) {
            ensureHelper(work);
        }
        String after = null;
        String explanation = "";
        String summary = "";
        boolean passed = false;
        int attempt = 0;
        while (attempt < MAX_ATTEMPTS && !cancelled) {
            attempt++;
            ui.status(attempt == 1 ? "Writing a proposal..." : "Fixing what the check found (attempt " + attempt + " of " + MAX_ATTEMPTS + ")...");
            EngineClient.Result res = engine.generate(msgs, 1800, 600, ui::token);
            log(transcript, "\n=== REPLY " + attempt + " (" + res.tokens() + " tokens, " + res.millis() + " ms, " + res.reason() + ") ===\n"
                    + res.text() + "\n");
            Matcher m = FENCE.matcher(res.text());
            if (!m.find()) {
                summary = "The model did not return a code block.";
                msgs.add(new EngineClient.Msg("assistant", res.text()));
                msgs.add(new EngineClient.Msg("user", "Reply again with the complete file in one fenced code block."));
                continue;
            }
            String code = m.group(1);
            explanation = res.text().substring(0, m.start()).strip();
            List<String> bad = Guard.checkReply(code);
            if (!bad.isEmpty()) {
                summary = "Rejected by the safety rules: " + String.join("; ", bad);
                log(transcript, "GUARD " + summary + "\n");
                msgs.add(new EngineClient.Msg("assistant", res.text()));
                msgs.add(new EngineClient.Msg("user", "That is not allowed: " + String.join("; ", bad) + ". Rewrite the file without it."));
                continue;
            }
            after = code.endsWith("\n") ? code : code + "\n";
            ui.status("Checking the proposal with Kindgleam's gates...");
            List<String> problems = r.task() == Task.VECTOR ? checkVector(work, rel, after) : checkCode(work, rel, after, transcript);
            if (problems.isEmpty()) {
                passed = true;
                summary = r.task() == Task.VECTOR ? "The vector parses and every signal and requirement it names exists."
                        : r.task() == Task.PYTEST ? "The generator ran twice in the sandbox with identical output, and every vector it "
                        + "printed passed the vector checks and fast gates (G17, G0-G5, G14, G1-G4). Run Verify for a verdict."
                        : "Fast gates G0-G4 passed on the proposal (spec, source scan, strict build, symbols, stack). "
                        + "Run Verify after applying it for a real verdict.";
                break;
            }
            summary = String.join("\n", problems);
            log(transcript, "CHECK FAILED\n" + summary + "\n");
            msgs.add(new EngineClient.Msg("assistant", res.text()));
            msgs.add(new EngineClient.Msg("user", "Kindgleam checked your file and it failed:\n" + trim(summary, 3000)
                    + "\nFix these problems and reply with the complete corrected file."));
        }
        if (cancelled) {
            summary = "Stopped.";
        }
        log(transcript, "\nRESULT " + (passed ? "checks passed" : "not passing") + " after " + attempt + " attempt(s)\n");
        return new Proposal(r, rel, before, after, explanation, true, passed, summary, attempt, transcript);
    }

    /** Writes an accepted proposal into the project and records the decision. */
    public void apply(Proposal p) throws IOException, InputException {
        if (!p.hasChange()) {
            return;
        }
        Path dst = SafeFiles.inside(project, p.relPath());
        String now = Files.exists(dst) ? Files.readString(dst) : null;
        if (now != null && p.before() != null && !now.equals(p.before())) {
            throw new InputException(p.relPath() + " changed since the proposal was made; ask again");
        }
        if (p.request().task() == Task.PYTEST) {
            ensureHelper(project);
        }
        Files.createDirectories(dst.getParent());
        SafeFiles.writeAtomic(dst, p.after());
        Memory.add(project, "decisions", "assistant",
                "applied assistant proposal to " + p.relPath() + " (" + p.request().task() + ", checks " + (p.checkPassed() ? "passed" : "NOT passing")
                        + ", transcript " + project.relativize(p.transcript()) + ")");
    }

    public void reject(Proposal p) throws IOException, InputException {
        Memory.add(project, "decisions", "assistant", "rejected assistant proposal for " + p.relPath() + " (" + p.request().task()
                + ", transcript " + project.relativize(p.transcript()) + ")");
    }

    /* ------------------------------------------------------------ prompt parts */

    private String target(Request r) throws InputException {
        switch (r.task()) {
            case VECTOR, PYTEST -> {
                if (r.requirement() == null || !r.requirement().matches("REQ-[0-9]{3,4}")) {
                    throw new InputException("choose a requirement");
                }
                String id = r.requirement().toLowerCase(Locale.ROOT).replace("-", "_");
                return r.task() == Task.VECTOR ? "vectors/" + id + "_assist.vec" : "tests/gen_" + id + ".py";
            }
            case REVIEW -> {
                return null;
            }
            default -> {
                boolean newFile = r.task() == Task.WRITE && r.file() != null && r.file().matches("(fw|wd)_[a-z0-9_]{1,40}\\.[ch]")
                        && !Files.exists(project.resolve(r.file()));
                if (r.file() == null || !(firmwareFiles(project).contains(r.file()) || newFile)) {
                    throw new InputException("choose a firmware file from this project");
                }
                return r.file();
            }
        }
    }

    private String read(String rel) {
        try {
            Path p = SafeFiles.inside(project, rel);
            return Files.exists(p) ? String.join("\n", SafeFiles.readLines(p, 512 * 1024, 4000)) + "\n" : null;
        } catch (InputException e) {
            return null;
        }
    }

    private String context(Request r, String rel, String before) {
        StringBuilder c = new StringBuilder("PROJECT CONTEXT\n");
        section(c, "interface.cfg", read("interface.cfg"));
        for (String f : firmwareFiles(project)) {
            if (f.endsWith(".h") || f.endsWith(".hpp")) {
                section(c, f, read(f));
            }
        }
        String reqs = read("spec/spec.req");
        if (r.requirement() != null && reqs != null) {
            section(c, "requirement " + r.requirement(), requirementText(reqs, r.requirement()));
        } else {
            section(c, "spec/spec.req", reqs);
        }
        String regs = read("registers.cfg");
        if (regs != null) {
            section(c, "registers.cfg (the only register addresses that exist)", regs);
        }
        if (r.task() == Task.FIX || r.task() == Task.OPTIMIZE) {
            section(c, "last run (digest)", RunDigest.build(project, RunDigest.latest(project)));
        }
        if (r.task() == Task.WRITE && before == null) {
            for (String f : firmwareFiles(project)) {
                if (f.endsWith(".c")) {
                    section(c, f + " (existing)", read(f));
                }
            }
        }
        if (r.task() == Task.REVIEW) {
            section(c, "last run (digest)", RunDigest.build(project, RunDigest.latest(project)));
            for (String f : List.of("limits.cfg", "board.cfg")) {
                section(c, f, read(f));
            }
            for (String f : firmwareFiles(project)) {
                if (f.endsWith(".c")) {
                    section(c, f, read(f));
                }
            }
        }
        if (r.task() == Task.PYTEST) {
            section(c, "vector format", VECTOR_HELP);
            section(c, "kgvec helper (tests/kgvec.py)", PY_HELP);
            for (String v : listVectors()) {
                section(c, "example hand-written vector " + v, read("vectors/" + v));
                break;
            }
        }
        if (r.task() == Task.VECTOR) {
            section(c, "vector format", VECTOR_HELP);
            for (String v : listVectors()) {
                section(c, "example " + v, read("vectors/" + v));
                break;
            }
        } else if (before != null && rel != null && !rel.endsWith(".h")) {
            section(c, rel + " (current)", before);
        }
        return c.toString();
    }

    private static void section(StringBuilder c, String title, String body) {
        if (body == null || body.isBlank()) {
            return;
        }
        c.append("\n--- ").append(title).append(" ---\n").append(trim(body, MAX_FILE_CHARS)).append('\n');
    }

    private static String trim(String s, int n) {
        return s.length() <= n ? s : s.substring(0, n) + "\n[... cut ...]";
    }

    private String instruction(Request r, String rel) {
        String note = r.note() == null || r.note().isBlank() ? "" : "\nExtra instructions from the engineer: " + r.note().strip();
        return switch (r.task()) {
            case FIX -> "The last Kindgleam run failed (see 'last check or verify run'). Fix " + rel
                    + " so it passes. Change only what is needed." + note;
            case WRITE -> (read(rel) == null
                    ? "Write the new file " + rel + " from scratch. It is added to the existing firmware files shown above, so do not "
                    + "define the fw_* interface functions again; write helper functions the existing code can call, with a short "
                    + "comment for each. "
                    : "Update " + rel + " so the firmware meets " + (r.requirement() == null ? "the requirements" : r.requirement())
                    + ". Keep everything that already works. ")
                    + (r.requirement() != null && read(rel) == null ? "It must help meet " + r.requirement() + ". " : "") + note;
            case OPTIMIZE -> "Improve " + rel + " for a small microcontroller without changing what it does: fewer CPU "
                    + "cycles per step, less stack and code size, simpler logic, clearer names and comments. Keep the interface, "
                    + "every output value and all safety behaviour exactly the same, and keep every loop bounded. If the code is "
                    + "already good, change nothing and say so. Start the answer with one line per change saying why it helps." + note;
            case EXPLAIN -> "Explain what " + rel + " does in plain words for an engineer new to the project: inputs, outputs, "
                    + "states, safety behaviour, and anything that looks risky. Do not write code." + note;
            case VECTOR -> "Write one test vector file that checks " + r.requirement()
                    + ", including its edge cases. Use the vector format exactly." + note;
            case PYTEST -> "Write the Python 3 script " + rel + " that uses 'from kgvec import Vector' to print test vectors for "
                    + r.requirement() + ": sweep its whole stated range and its edge cases. It must be deterministic (no clock, "
                    + "random only as random.Random(1234)), use only the Python standard library and kgvec, read and write no "
                    + "files, and only print vectors with emit(). Reply with one sentence, then the complete script in one "
                    + "```python block." + note;
            case REVIEW -> "Review the last Kindgleam run (see 'last run (digest)') for the engineer. SIL runs the firmware "
                    + "against the plant model on this PC; PIL runs the same firmware on the board over the link and must agree "
                    + "with SIL; HIL adds the real hardware and a person's sign-off. Use only facts from the digest and the files. "
                    + "Write, in plain words: (1) what passed, what failed and why, naming the tier; (2) the most useful "
                    + "improvements to the firmware code, especially requirements that passed with a small margin and any "
                    + "failure; (3) improvements to the tests: missing cases, planted bugs that survived, lines no test runs; "
                    + "(4) improvements to other parts where the digest shows a need: requirements (spec/spec.req), the plant "
                    + "model (for example calibration), board limits, timing on the real chip, or the HIL set-up. "
                    + "Write every suggestion on its own line in exactly one of these forms: 'fw_ctrl.c:42: text' for a code "
                    + "line, 'vectors/name.vec: text' or 'spec/spec.req: text' or 'models/name.model: text' for other files. "
                    + "Suggest only; do not write whole files." + note;
        };
    }

    private static String requirementText(String spec, String id) {
        StringBuilder b = new StringBuilder();
        boolean in = false;
        for (String l : spec.split("\n")) {
            if (l.startsWith("REQ-")) {
                in = l.startsWith(id + " ") || l.equals(id);
            }
            if (in) {
                b.append(l).append('\n');
            }
        }
        return b.length() == 0 ? null : b.toString();
    }

    private List<String> listVectors() {
        List<String> out = new ArrayList<>();
        try (Stream<Path> s = Files.list(project.resolve("vectors"))) {
            s.map(p -> p.getFileName().toString()).filter(n -> n.endsWith(".vec")).sorted().forEach(out::add);
        } catch (IOException e) {
            // none
        }
        return out;
    }

    /** Generators import kgvec; make sure the scratch copy (and later the project) has it. */
    private void ensureHelper(Path root) throws IOException {
        Path dst = root.resolve("tests").resolve("kgvec.py");
        if (!Files.exists(dst)) {
            Files.createDirectories(dst.getParent());
            Files.copy(home.resolve("firmware-support").resolve("kgvec.py"), dst);
        }
    }

    static final String PY_HELP = """
            from kgvec import Vector
            v = Vector("name", req="REQ-001", ticks=4000, comment="optional")   # name: 1-24 of a-z 0-9 _
            v.set(tick, "signal", value)            # SET line, COMMAND inputs only
            v.fault(tick, "stuck", "sensor", 90)    # FAULT line: hang | stuck | offset | noise | freeze | disturb
            v.check("from 2000 always abs(temp - setpoint) <= 0.5")   # ASSERT line without the word ASSERT
            v.emit()                                # prints the vector; call once per vector
            Every vector name must be unique within the script.""";

    static final String VECTOR_HELP = """
            One directive per line, # starts a comment.
            REQ <requirement id>                  the requirement this vector tests (exactly one)
            TICKS <n>                             how many control steps to run
            SET <tick> <input> <value>            set a COMMAND input from that tick on
            FAULT <tick> hang                     firmware stops responding (watchdog must act)
            FAULT <tick> stuck <sensor> <value>   sensor reads a fixed value
            FAULT <tick> offset <sensor> <delta>  sensor reads off by delta
            FAULT <tick> noise <sensor> <amp>     sensor gets random noise
            FAULT <tick> freeze <sensor>          sensor holds its last value
            FAULT <tick> disturb <value>          extra disturbance into the plant
            ASSERT always <expr>
            ASSERT from <tick> always <expr>
            ASSERT from fault always <expr>          (from the first FAULT tick; also fault+<n>)
            ASSERT eventually by <tick> <expr>
            Expressions use signal names, numbers, + - * /, abs(), min(), max(), comparisons (< <= > >= == !=), and, or, not, and a -> b (whenever a, also b).""";

    /* ------------------------------------------------------------ checks on the scratch copy */

    private Path newJob() throws IOException, InputException {
        Path jobs = Files.createDirectories(project.resolve("jobs"));
        for (int i = 1; i < 10000; i++) {
            Path d = jobs.resolve(String.format(Locale.ROOT, "assist-%04d", i));
            if (!Files.exists(d)) {
                return Files.createDirectory(d);
            }
        }
        throw new InputException("too many assistant jobs in jobs/");
    }

    private void copyProject(Path work) throws IOException {
        Files.createDirectories(work);
        try (Stream<Path> s = Files.list(project)) {
            for (Path p : s.toList()) {
                String n = p.getFileName().toString();
                if (Files.isSymbolicLink(p) || n.equals("jobs") || n.equals("evidence") || n.equals("memory") || n.startsWith(".")) {
                    continue;
                }
                if (Files.isDirectory(p)) {
                    try (Stream<Path> w = Files.walk(p)) {
                        for (Path q : w.toList()) {
                            if (Files.isSymbolicLink(q)) {
                                continue;
                            }
                            Path d = work.resolve(project.relativize(q).toString());
                            if (Files.isDirectory(q)) {
                                Files.createDirectories(d);
                            } else {
                                Files.copy(q, d);
                            }
                        }
                    }
                } else {
                    Files.copy(p, work.resolve(n));
                }
            }
        }
    }

    private List<String> checkVector(Path work, String rel, String text) {
        List<String> problems = new ArrayList<>();
        try {
            Path p = SafeFiles.inside(work, rel);
            SafeFiles.writeAtomic(p, text);
            Interface itf = Interface.load(work.resolve("interface.cfg"));
            String model = null;
            for (String l : SafeFiles.readLines(work.resolve("profile.cfg"), 8192, 300)) {
                if (l.startsWith("PLANT_MODEL ")) {
                    model = l.substring(12).strip();
                }
            }
            Plant.Spec plant = Plant.load(SafeFiles.inside(work, model), itf);
            Vector.load(p, itf, plant.outputNames());
        } catch (InputException | IOException | RuntimeException e) {
            problems.add(e.getMessage());
        }
        return problems;
    }

    private List<String> checkCode(Path work, String rel, String code, Path transcript) throws IOException {
        Path dst;
        try {
            dst = SafeFiles.inside(work, rel);
        } catch (InputException e) {
            return List.of(e.getMessage());
        }
        SafeFiles.writeAtomic(dst, code);
        List<String> cmd = kg.core.Places.cli(home, List.of("check", "--project=" + work, "--format=lines"));
        ProcessBuilder pb = new ProcessBuilder(cmd).redirectErrorStream(true);
        pb.environment().remove("JAVA_TOOL_OPTIONS");
        Process proc = pb.start();
        List<String> problems = new ArrayList<>();
        boolean ok = false;
        StringBuilder all = new StringBuilder();
        try (BufferedReader in = new BufferedReader(new InputStreamReader(proc.getInputStream(), StandardCharsets.UTF_8))) {
            String l;
            while ((l = in.readLine()) != null) {
                all.append(l).append('\n');
                if (l.startsWith("KG|gate|") && l.contains("|FAIL|")) {
                    String[] f = l.split("\\|", 5);
                    problems.add(f[2] + ": " + (f.length > 4 ? f[4] : ""));
                } else if (l.startsWith("KG|triage-log|")) {
                    problems.add("  " + l.substring(14));
                } else if (l.startsWith("KG|triage|")) {
                    problems.add(l.substring(10).replace('|', ' '));
                } else if (l.equals("KG|check|OK")) {
                    ok = true;
                }
            }
        }
        try {
            if (!proc.waitFor(300, TimeUnit.SECONDS)) {
                proc.destroyForcibly();
                problems.add("the check took too long");
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            proc.destroyForcibly();
        }
        log(transcript, "\n=== CHECK ===\n" + all);
        if (ok) {
            return List.of();
        }
        if (problems.isEmpty()) {
            problems.add("the check failed without a gate report; see the transcript");
        }
        return problems;
    }

    private static void log(Path f, String s) {
        try {
            Files.writeString(f, s, StandardCharsets.UTF_8, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        } catch (IOException e) {
            // the transcript is best effort; the memory log still records decisions
        }
    }
}
