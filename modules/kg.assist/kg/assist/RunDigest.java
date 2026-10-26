package kg.assist;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import kg.core.InputException;
import kg.core.Interface;
import kg.core.Profile;
import kg.core.SafeFiles;
import kg.core.Trace;
import kg.core.Vector;
import kg.gates.Margins;
import kg.sil.Plant;

/**
 * A compact, factual summary of one run for the assistant to reason about: what the gates
 * decided, how close every requirement came to failing, what the signals did around a failure,
 * whether SIL and PIL agreed, link and timing figures, untested lines, surviving planted bugs and
 * stack use, each with the actual source line. Everything here is computed by fixed code from the
 * run folder; the assistant only reads it.
 */
public final class RunDigest {
    private static final Pattern SURVIVED = Pattern.compile("SURVIVED ((?:fw|wd)_[a-z0-9_]+\\.c):(\\d+):(\\d+) (.*?)\\s+<-.*");
    private static final Pattern GCOV = Pattern.compile("\\s*(#####|=====):\\s*(\\d+):(.*)");
    private static final Pattern SU = Pattern.compile(".*?((?:fw|wd)_[a-z0-9_]+\\.c):(\\d+):\\d+:([A-Za-z0-9_]+)\\t(\\d+)\\t(\\S+)");
    private static final int MAX_LINES = 140;

    private RunDigest() {
    }

    /** The latest run folder that has a report (verify) or, failing that, any run (check). */
    public static Path latest(Path project) {
        try (Stream<Path> s = Files.list(project.resolve("jobs"))) {
            List<Path> runs = s.filter(p -> p.getFileName().toString().matches("run-\\d{4}"))
                    .sorted(Comparator.comparing((Path p) -> p.getFileName().toString()).reversed()).toList();
            for (Path r : runs) {
                if (Files.exists(r.resolve("report.txt"))) {
                    return r;
                }
            }
            return runs.isEmpty() ? null : runs.get(0);
        } catch (IOException e) {
            return null;
        }
    }

    public static String build(Path project, Path run) {
        if (run == null) {
            return "No run yet. Press Check or Verify first.";
        }
        List<String> out = new ArrayList<>();
        out.add("RUN " + run.getFileName());
        List<String> report = lines(run.resolve("report.txt"));
        for (String l : report) {
            if (l.startsWith("Tier ") || l.startsWith("VERDICT ") || l.startsWith("Interface ")) {
                out.add(l.strip());
            }
        }
        for (String l : lines(run.resolve("verdict.txt"))) {
            if (l.startsWith("REASON ")) {
                out.add(l);
            }
        }
        out.add("");
        out.add("GATES");
        for (String l : lines(run.resolve("gates.txt"))) {
            out.add("  " + l);
        }
        // failures with the agent's own reason (covers check runs without a report)
        try (Stream<Path> s = Files.list(run)) {
            for (Path p : s.filter(x -> x.toString().endsWith(".report")).sorted().toList()) {
                String agent = "";
                String status = "";
                String reason = "";
                for (String l : lines(p)) {
                    if (l.startsWith("AGENT ")) {
                        agent = l.substring(6);
                    } else if (l.startsWith("STATUS ")) {
                        status = l.substring(7);
                    } else if (l.startsWith("REASON ")) {
                        reason = l.substring(7);
                    }
                }
                if (!status.equals("DONE") && !status.isEmpty()) {
                    out.add("STOPPED at agent " + agent + " (" + status + "): " + reason);
                }
            }
        } catch (IOException e) {
            // no reports
        }

        Interface itf = null;
        Plant.Spec plant = null;
        int stackMax = 256;
        try {
            itf = Interface.load(project.resolve("interface.cfg"));
            Profile prof = Profile.load(project.resolve("profile.cfg"));
            stackMax = prof.stackMaxFrame;
            plant = Plant.load(SafeFiles.inside(project, prof.plantModel), itf);
        } catch (InputException e) {
            out.add("(interface, profile or plant could not be read: " + e.getMessage() + ")");
        }

        // requirement margins and failures, from the recorded SIL traces
        if (itf != null && plant != null && Files.isDirectory(run.resolve("traces"))) {
            List<Object[]> rows = new ArrayList<>();
            List<String> unproven = new ArrayList<>();
            List<String> atLimit = new ArrayList<>();
            List<String> fails = new ArrayList<>();
            for (Path vp : vectorFiles(project, run)) {
                String name = vp.getFileName().toString().replace(".vec", "");
                Path tp = run.resolve("traces").resolve(name + ".trace");
                if (!Files.exists(tp)) {
                    continue;
                }
                try {
                    Vector v = Vector.load(vp, itf, plant.outputNames());
                    Trace tr = Trace.read(tp);
                    for (Margins.Margin m : Margins.of(v, tr)) {
                        if (!m.informative()) {
                            if (m.neverApplied() && unproven.size() < 10) {
                                unproven.add("  " + v.req + " " + name + " '" + m.assertion() + "': " + m.describe());
                            }
                            continue;
                        }
                        if (m.mode() != Vector.Mode.EVENTUALLY && m.worst() == 0.0) {
                            atLimit.add(v.req + " " + name + " '" + m.assertion() + "'");
                            continue;
                        }
                        double key = m.mode() == Vector.Mode.EVENTUALLY ? (m.tick() < 0 ? -1e9 : m.worst() * 1e-3) : m.worst();
                        rows.add(new Object[] {key, v.req + " " + name + " '"
                                + m.assertion() + "': " + m.describe() + (m.failed() ? "  [FAILED]" : "")});
                        if (m.failed() && fails.size() < 3) {
                            fails.add(window(name, tr, Math.max(0, m.tick() < 0 ? m.deadline() : m.tick())));
                        }
                    }
                } catch (InputException e) {
                    out.add("(vector " + name + " could not be read: " + e.getMessage() + ")");
                }
            }
            rows.sort(Comparator.comparingDouble(r -> (Double) r[0]));
            out.add("");
            out.add("REQUIREMENT MARGINS (closest to failing first; units are those of the signals)");
            for (Object[] r : rows.subList(0, Math.min(14, rows.size()))) {
                out.add("  " + r[1]);
            }
            if (!atLimit.isEmpty()) {
                out.add("  Exactly at the limit (margin 0, usually an intended clamp or saturation), " + atLimit.size() + " check(s), e.g. "
                        + String.join("; ", atLimit.subList(0, Math.min(2, atLimit.size()))));
            }
            if (!unproven.isEmpty()) {
                out.add("");
                out.add("CHECKS THAT NEVER APPLIED (the test never created the situation they guard)");
                out.addAll(unproven);
            }
            for (String f : fails) {
                out.add("");
                out.add(f);
            }
        }

        // tier-specific facts from the report notes
        List<String> notes = new ArrayList<>();
        boolean in = false;
        for (String l : report) {
            if (l.equals("Notes")) {
                in = true;
            } else if (in && l.startsWith("  - ")) {
                String n = l.substring(4);
                if (!n.startsWith("REVIEWED EQUIVALENT")) {
                    notes.add("  " + n);
                }
            } else if (in && !l.isBlank()) {
                in = false;
            }
        }
        if (!notes.isEmpty()) {
            out.add("");
            out.add("NOTES FROM THE RUN (SIL/PIL/HIL environment, link, timing, calibration)");
            out.addAll(notes);
        }

        // untested lines, surviving planted bugs, stack
        List<String> cov = new ArrayList<>();
        Path covDir = run.resolve("build").resolve("coverage");
        try (Stream<Path> s = Files.isDirectory(covDir) ? Files.list(covDir) : Stream.empty()) {
            for (Path p : s.filter(x -> x.getFileName().toString().matches("(fw|wd)_[a-z0-9_]+\\.c\\.gcov")).sorted().toList()) {
                String f = p.getFileName().toString().replace(".gcov", "");
                for (String l : lines(p)) {
                    Matcher m = GCOV.matcher(l);
                    if (m.matches() && cov.size() < 20) {
                        cov.add("  " + f + ":" + m.group(2) + ": never run by any test:  " + m.group(3).strip());
                    }
                }
            }
        } catch (IOException e) {
            // none
        }
        if (!cov.isEmpty()) {
            out.add("");
            out.add("LINES NO TEST RUNS (G6)");
            out.addAll(cov);
        }
        List<String> mut = new ArrayList<>();
        try (Stream<Path> s = Files.list(run)) {
            for (Path p : s.filter(x -> x.getFileName().toString().endsWith("_mutation.log")).toList()) {
                for (String l : lines(p)) {
                    Matcher m = SURVIVED.matcher(l);
                    if (m.matches() && mut.size() < 15) {
                        mut.add("  " + m.group(1) + ":" + m.group(2) + ": changing " + m.group(4) + " was not noticed by any test:  "
                                + sourceLine(project, m.group(1), Integer.parseInt(m.group(2))));
                    }
                }
            }
        } catch (IOException e) {
            // none
        }
        if (!mut.isEmpty()) {
            out.add("");
            out.add("PLANTED BUGS NO TEST CAUGHT (G7; some may be reviewed as harmless in mutation_review.txt)");
            out.addAll(mut);
        }
        List<String> stack = new ArrayList<>();
        try (Stream<Path> s = Files.isDirectory(run.resolve("build")) ? Files.list(run.resolve("build")) : Stream.empty()) {
            for (Path p : s.filter(x -> x.toString().endsWith(".su")).toList()) {
                for (String l : lines(p)) {
                    Matcher m = SU.matcher(l);
                    if (m.matches() && Integer.parseInt(m.group(4)) * 4 >= stackMax * 3) {
                        stack.add("  " + m.group(1) + ":" + m.group(2) + ": " + m.group(3) + " uses " + m.group(4) + " of " + stackMax
                                + " bytes of stack (" + m.group(5) + ")");
                    }
                }
            }
        } catch (IOException e) {
            // none
        }
        if (!stack.isEmpty()) {
            out.add("");
            out.add("STACK FRAMES ABOVE 75% OF THE LIMIT (G4)");
            out.addAll(stack);
        }
        if (out.size() > MAX_LINES) {
            out = new ArrayList<>(out.subList(0, MAX_LINES));
            out.add("[... digest cut ...]");
        }
        return String.join("\n", out);
    }

    /** Ten rows of every signal around a tick, from a trace. */
    private static String window(String name, Trace tr, int t) {
        StringBuilder b = new StringBuilder("SIGNALS AROUND THE FAILURE in " + name + " (tick, then each column):\n  tick");
        for (String c : tr.columns) {
            if (!c.equals("exec_ns") && !c.equals("state_hash")) {
                b.append(", ").append(c);
            }
        }
        for (int k = Math.max(0, t - 5); k <= Math.min(tr.ticks() - 1, t + 4); k++) {
            b.append("\n  ").append(k);
            for (int c = 0; c < tr.columns.size(); c++) {
                String cn = tr.columns.get(c);
                if (!cn.equals("exec_ns") && !cn.equals("state_hash")) {
                    b.append(", ").append(String.format(Locale.ROOT, "%.4g", tr.get(k, c)));
                }
            }
            if (k == t) {
                b.append("   <- here");
            }
        }
        return b.toString();
    }

    private static List<Path> vectorFiles(Path project, Path run) {
        List<Path> out = new ArrayList<>();
        for (Path dir : List.of(project.resolve("vectors"), run.resolve("generated"))) {
            try (Stream<Path> s = Files.isDirectory(dir) ? Files.list(dir) : Stream.empty()) {
                s.filter(p -> p.toString().endsWith(".vec")).sorted().forEach(out::add);
            } catch (IOException e) {
                // none
            }
        }
        return out;
    }

    private static String sourceLine(Path project, String file, int line) {
        List<String> l = lines(project.resolve(file));
        return line >= 1 && line <= l.size() ? l.get(line - 1).strip() : "";
    }

    private static List<String> lines(Path p) {
        try {
            return p != null && Files.exists(p) ? SafeFiles.readLines(p, 8L << 20, 20000) : List.of();
        } catch (InputException e) {
            return List.of();
        }
    }
}
