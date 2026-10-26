package kg.gates;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import kg.core.Proc;

/**
 * G17: Python test generators.
 *
 * A generator is tests/gen_*.py. It runs in the job sandbox (no network on Linux, clean
 * environment, empty working folder, time limit) and may only print test vectors:
 *
 *     ### VECTOR <name>
 *     REQ REQ-001
 *     TICKS 4000
 *     ...
 *
 * Kindgleam runs every generator twice and requires byte-identical output, so the vectors are
 * reproducible evidence. The text is then parsed by the same strict vector parser as hand-written
 * vectors. A generator cannot run a test, read a result or influence a verdict.
 */
public final class TestGen {
    /** One generated vector: final name (unique in the run) and its text. */
    public record Generated(String name, String script, String text) { }

    /** Outcome: vectors, or problems (never both). */
    public record Result(List<Generated> vectors, List<String> problems, String pythonVersion) { }

    public static final Pattern SCRIPT = Pattern.compile("gen_[a-z0-9_]{1,30}\\.py");
    public static final Pattern HELPER = Pattern.compile("[a-z0-9_]{1,40}\\.py");
    private static final Pattern NAME = Pattern.compile("[a-z0-9_]{1,24}");
    private static final int MAX_SCRIPTS = 20;
    private static final int MAX_PER_SCRIPT = 500;
    private static final int MAX_VECTOR_BYTES = 64 * 1024;
    private static final long MAX_OUTPUT_BYTES = 4L * 1024 * 1024;

    private TestGen() {
    }

    /** The interpreter's version as "3.12", or null with the reason in problems. */
    public static String pythonVersion(String python, Path work, Path log, Duration to, List<String> problems) throws IOException {
        Path out = work.resolve("python_version.txt");
        Proc.Result r;
        try {
            r = Proc.runCapture(List.of(python, "-E", "-s", "-B", "-c",
                    "import sys; print('%d.%d' % sys.version_info[:2])"), work, out, log, to);
        } catch (IOException e) {
            problems.add("Python not found ('" + python + "'). Install Python 3.8 or newer, or set PYTHON in profile.cfg");
            return null;
        }
        String v = Files.exists(out) ? Files.readString(out).strip() : "";
        if (!r.ok() || !v.matches("3\\.\\d{1,2}")) {
            problems.add("'" + python + "' is not a working Python 3 interpreter");
            return null;
        }
        if (Integer.parseInt(v.substring(2)) < 8) {
            problems.add("Python " + v + " is too old; test generators need Python 3.8 or newer");
            return null;
        }
        return v;
    }

    /** Runs every generator twice, checks the output, returns the vectors. */
    public static Result run(String python, List<Path> scripts, Set<String> takenNames, Path work, Path log, Duration to)
            throws IOException {
        List<String> problems = new ArrayList<>();
        Files.createDirectories(work);
        String ver = pythonVersion(python, work, log, to, problems);
        if (ver == null) {
            return new Result(List.of(), problems, null);
        }
        if (scripts.size() > MAX_SCRIPTS) {
            problems.add("more than " + MAX_SCRIPTS + " test generators in tests/");
            return new Result(List.of(), problems, ver);
        }
        List<Generated> all = new ArrayList<>();
        Map<String, String> seen = new LinkedHashMap<>();
        for (Path script : scripts) {
            String file = script.getFileName().toString();
            String stem = file.substring(4, file.length() - 3);
            byte[][] outs = new byte[2][];
            for (int pass = 0; pass < 2; pass++) {
                Path dir = Files.createDirectories(work.resolve(stem + "_run" + (pass + 1)));
                Path out = dir.resolve("stdout.txt");
                Proc.Result r = Proc.runCapture(List.of(python, "-E", "-s", "-B", script.toString()), dir, out, log, to);
                if (r.timedOut()) {
                    problems.add(file + ": took longer than " + to.toSeconds() + " s");
                    break;
                }
                if (r.exit() != 0) {
                    problems.add(file + ": exited with code " + r.exit() + " (see the log; a generator may not use the network)");
                    break;
                }
                if (Files.size(out) > MAX_OUTPUT_BYTES) {
                    problems.add(file + ": printed more than " + (MAX_OUTPUT_BYTES >> 20) + " MB");
                    break;
                }
                outs[pass] = Files.readAllBytes(out);
            }
            if (outs[0] == null || outs[1] == null) {
                continue;
            }
            if (!Arrays.equals(outs[0], outs[1])) {
                problems.add(file + ": two runs printed different vectors; generators must be deterministic "
                        + "(use random.Random(<fixed seed>), no clock or file listings)");
                continue;
            }
            int before = problems.size();
            List<Generated> mine = parse(file, stem, new String(outs[0], StandardCharsets.UTF_8), problems);
            for (Generated g : mine) {
                if (takenNames.contains(g.name()) || seen.containsKey(g.name())) {
                    problems.add(file + ": vector name '" + g.name() + "' is already used"
                            + (seen.containsKey(g.name()) ? " by " + seen.get(g.name()) : " in vectors/"));
                }
                seen.put(g.name(), file);
            }
            if (problems.size() == before) {
                all.addAll(mine);
            }
        }
        return problems.isEmpty() ? new Result(all, List.of(), ver) : new Result(List.of(), problems, ver);
    }

    /** Splits generator output into vectors. Anything outside a vector is an error. */
    public static List<Generated> parse(String file, String stem, String text, List<String> problems) {
        List<Generated> out = new ArrayList<>();
        String name = null;
        StringBuilder body = new StringBuilder();
        int ln = 0;
        for (String line : text.split("\n", -1)) {
            ln++;
            String l = line.endsWith("\r") ? line.substring(0, line.length() - 1) : line;
            if (l.startsWith("### VECTOR")) {
                if (name != null) {
                    add(out, file, stem, name, body, problems);
                }
                String n = l.substring(10).strip();
                if (!NAME.matcher(n).matches()) {
                    problems.add(file + ": line " + ln + ": vector name '" + n + "' must be 1-24 of a-z, 0-9, _");
                    return out;
                }
                name = n;
                body.setLength(0);
            } else if (name == null) {
                if (!l.isBlank()) {
                    problems.add(file + ": line " + ln + ": text before the first '### VECTOR <name>' line: " + clip(l));
                    return out;
                }
            } else {
                body.append(l).append('\n');
                if (body.length() > MAX_VECTOR_BYTES) {
                    problems.add(file + ": vector '" + name + "' is larger than " + (MAX_VECTOR_BYTES >> 10) + " KB");
                    return out;
                }
            }
            if (out.size() > MAX_PER_SCRIPT) {
                problems.add(file + ": more than " + MAX_PER_SCRIPT + " vectors");
                return out;
            }
        }
        if (name != null) {
            add(out, file, stem, name, body, problems);
        }
        if (out.isEmpty() && problems.isEmpty()) {
            problems.add(file + ": printed no vectors");
        }
        return out;
    }

    private static void add(List<Generated> out, String file, String stem, String name, StringBuilder body, List<String> problems) {
        String full = (stem + "_" + name).toLowerCase(Locale.ROOT);
        if (full.length() > 40) {
            problems.add(file + ": '" + stem + "_" + name + "' is longer than 40 characters; use shorter names");
            return;
        }
        out.add(new Generated(full, file, body.toString()));
    }

    private static String clip(String s) {
        return s.length() > 60 ? s.substring(0, 60) + "..." : s;
    }
}
