package kg.app;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import kg.core.InputException;
import kg.core.Proc;
import kg.core.Profile;
import kg.core.SafeFiles;
import kg.gates.SourceScan;

/**
 * Turns Kindgleam's own checks into line markers for the code editor. Everything here is fixed
 * code (compiler, source policy, run results); assistant suggestions are added separately and
 * always labelled as such.
 */
final class Diagnostics {
    enum Sev { ERROR, WARNING, SUGGEST, INFO }

    /** One marker: file name (e.g. fw_ctrl.c), 1-based line, severity, who found it, the message. */
    record Diag(String file, int line, Sev sev, String source, String text) { }

    private Diagnostics() {
    }

    private static final List<String> STRICT = List.of("-std=c11", "-Wall", "-Wextra", "-Werror", "-pedantic", "-Wshadow",
            "-Wstrict-prototypes", "-Wcast-qual", "-Wdouble-promotion", "-Wconversion", "-Wundef", "-fno-common",
            "-ffreestanding", "-fno-builtin", "-fsyntax-only");
    private static final Pattern GCC = Pattern.compile("(?:^|[/\\\\])((?:fw|wd)_[A-Za-z0-9_]+\\.[ch]):(\\d+):(?:(\\d+):)?\\s*(fatal error|error|warning|note):\\s*(.*)");
    private static final Pattern SCAN = Pattern.compile("((?:fw|wd)_[A-Za-z0-9_]+\\.[ch]):(\\d+) (.*)");
    private static final Pattern SURVIVED = Pattern.compile("SURVIVED ((?:fw|wd)_[A-Za-z0-9_]+\\.c):(\\d+):(\\d+) (.*?)\\s+<-.*");
    private static final Pattern SU = Pattern.compile(".*[/\\\\]?((?:fw|wd)_[A-Za-z0-9_]+\\.c):(\\d+):\\d+:([A-Za-z0-9_]+)\\t(\\d+)\\t(\\S+)");
    private static final Pattern GCOV_LINE = Pattern.compile("\\s*(#####|=====):\\s*(\\d+):(.*)");

    /**
     * Live check of the files as they are in the editor: source policy (G1) and a strict compile
     * with the project's compiler, syntax only. Runs in the job sandbox in a scratch folder.
     */
    static List<Diag> live(Path project, java.util.Map<String, String> openText) {
        List<Diag> out = new ArrayList<>();
        Path tmp = null;
        try {
            tmp = Files.createTempDirectory("kg-live");
            List<String> names = new ArrayList<>();
            try (Stream<Path> s = Files.list(project)) {
                for (Path p : s.toList()) {
                    String n = p.getFileName().toString();
                    if (n.matches("(fw|wd)_[a-z0-9_]{1,40}\\.[ch]") && Files.isRegularFile(p) && !Files.isSymbolicLink(p)) {
                        names.add(n);
                    }
                }
            }
            for (String n : names) {
                String text = openText.containsKey(n) ? openText.get(n) : Files.readString(project.resolve(n));
                Files.writeString(tmp.resolve(n), text, StandardCharsets.UTF_8);
                for (String v : SourceScan.scan(tmp.resolve(n))) {
                    Matcher m = SCAN.matcher(v);
                    if (m.matches()) {
                        out.add(new Diag(m.group(1), Integer.parseInt(m.group(2)), Sev.ERROR, "G1 source policy", m.group(3)));
                    }
                }
            }
            String cc = "gcc";
            try {
                cc = Profile.load(project.resolve("profile.cfg")).compiler;
            } catch (InputException e) {
                // profile problems are reported by Check; use gcc for the live view
            }
            for (String n : names) {
                if (!n.endsWith(".c")) {
                    continue;
                }
                Path log = tmp.resolve(n + ".log");
                List<String> cmd = new ArrayList<>();
                cmd.add(cc);
                cmd.addAll(STRICT);
                cmd.add(n);
                Proc.run(cmd, tmp, log, Duration.ofSeconds(30));
                for (String l : Files.readAllLines(log, StandardCharsets.UTF_8)) {
                    Matcher m = GCC.matcher(l);
                    if (m.find() && !m.group(4).equals("note")) {
                        out.add(new Diag(m.group(1), Integer.parseInt(m.group(2)), Sev.ERROR, "compiler", clean(m.group(5))));
                    }
                }
            }
        } catch (IOException | InputException e) {
            out.add(new Diag("", 0, Sev.WARNING, "live check", "could not run the live check: " + e.getMessage()));
        } finally {
            deleteQuietly(tmp);
        }
        return dedupe(out);
    }

    /** Markers from a finished run: build errors, uncovered code, surviving planted bugs, stack frames. */
    static List<Diag> fromRun(Path project, String run, int stackMax) {
        List<Diag> out = new ArrayList<>();
        if (run == null) {
            return out;
        }
        Path dir;
        try {
            dir = SafeFiles.inside(project, "jobs/" + run);
        } catch (InputException e) {
            return out;
        }
        Set<String> reviewed = reviewedMutants(project);
        try (Stream<Path> s = Files.list(dir)) {
            for (Path p : s.sorted().toList()) {
                String n = p.getFileName().toString();
                if (n.endsWith("_build.log")) {
                    for (String l : lines(p)) {
                        Matcher m = GCC.matcher(l);
                        if (m.find() && !m.group(4).equals("note")) {
                            out.add(new Diag(m.group(1), Integer.parseInt(m.group(2)), Sev.ERROR, "G2 build (" + run + ")", clean(m.group(5))));
                        }
                    }
                } else if (n.endsWith("_mutation.log")) {
                    for (String l : lines(p)) {
                        Matcher m = SURVIVED.matcher(l);
                        if (m.matches()) {
                            String id = m.group(1) + ":" + m.group(2) + ":" + m.group(3) + " " + m.group(4);
                            boolean ok = reviewed.contains(id);
                            out.add(new Diag(m.group(1), Integer.parseInt(m.group(2)), ok ? Sev.INFO : Sev.WARNING, "G7 mutation (" + run + ")",
                                    ok ? "reviewed: changing " + m.group(4) + " here makes no measurable difference"
                                       : "no test notices if " + m.group(4) + " here; add a test that would"));
                        }
                    }
                }
            }
        } catch (IOException e) {
            return out;
        }
        Path gates = dir.resolve("gates.txt");
        for (String l : lines(gates)) {
            if (l.startsWith("G1 FAIL ")) {
                for (String part : l.substring(8).split("; ")) {
                    Matcher m = SCAN.matcher(part.strip());
                    if (m.matches()) {
                        out.add(new Diag(m.group(1), Integer.parseInt(m.group(2)), Sev.ERROR, "G1 source policy (" + run + ")", m.group(3)));
                    }
                }
            }
        }
        Path build = dir.resolve("build");
        try (Stream<Path> s = Files.isDirectory(build) ? Files.list(build) : Stream.empty()) {
            for (Path p : s.filter(x -> x.toString().endsWith(".su")).toList()) {
                for (String l : lines(p)) {
                    Matcher m = SU.matcher(l);
                    if (m.matches()) {
                        int bytes = Integer.parseInt(m.group(4));
                        boolean dynamic = !m.group(5).equals("static");
                        if (dynamic || bytes > stackMax) {
                            out.add(new Diag(m.group(1), Integer.parseInt(m.group(2)), Sev.ERROR, "G4 stack (" + run + ")",
                                    m.group(3) + " uses " + bytes + " bytes of stack" + (dynamic ? " (" + m.group(5) + ")" : "")
                                            + "; the limit is " + stackMax + " and it must be static"));
                        }
                    }
                }
            }
        } catch (IOException e) {
            // no stack data
        }
        Path cov = build.resolve("coverage");
        try (Stream<Path> s = Files.isDirectory(cov) ? Files.list(cov) : Stream.empty()) {
            for (Path p : s.filter(x -> x.getFileName().toString().matches("(fw|wd)_[a-z0-9_]+\\.c\\.gcov")).toList()) {
                String file = p.getFileName().toString().replace(".gcov", "");
                for (String l : lines(p)) {
                    Matcher m = GCOV_LINE.matcher(l);
                    if (m.matches()) {
                        out.add(new Diag(file, Integer.parseInt(m.group(2)), Sev.INFO, "G6 coverage (" + run + ")",
                                "no test ever runs this line"));
                    }
                }
            }
        } catch (IOException e) {
            // no coverage data
        }
        return dedupe(out);
    }

    /**
     * Assistant review lines: "fw_ctrl.c:42: text" for a code line, or "vectors/x.vec: text",
     * "spec/spec.req: text", "models/m.model: text" and similar for other project files (line 1).
     */
    static List<Diag> suggestions(String text) {
        List<Diag> out = new ArrayList<>();
        Pattern p = Pattern.compile("^\\s*(?:[-*\\d.)]+\\s*)?`?((?:fw|wd)_[A-Za-z0-9_]+\\.[ch]|vectors/[a-z0-9_]{1,40}\\.vec|spec/spec\\.req"
                + "|models/[A-Za-z0-9_.-]{1,60}\\.model|interface\\.cfg|limits\\.cfg|board\\.cfg|profile\\.cfg)`?"
                + "\\s*(?:[:(]\\s*(?:line\\s*)?(\\d{1,5})\\)?)?\\s*[:\\-]\\s*(.+)$", Pattern.CASE_INSENSITIVE);
        for (String l : text.split("\n")) {
            Matcher m = p.matcher(l);
            if (m.matches()) {
                int line = m.group(2) == null ? 1 : Integer.parseInt(m.group(2));
                out.add(new Diag(m.group(1), line, Sev.SUGGEST, "assistant", m.group(3).strip()));
            }
        }
        return out;
    }

    private static Set<String> reviewedMutants(Path project) {
        Set<String> out = new HashSet<>();
        for (String l : lines(project.resolve("mutation_review.txt"))) {
            int bar = l.indexOf('|');
            if (bar > 0 && !l.startsWith("#")) {
                out.add(l.substring(0, bar).strip());
            }
        }
        return out;
    }

    private static List<String> lines(Path p) {
        try {
            return Files.exists(p) ? SafeFiles.readLines(p, 8L << 20, 20000) : List.of();
        } catch (InputException e) {
            return List.of();
        }
    }

    private static String clean(String s) {
        return s.replaceAll("\\s*\\[-W[a-z0-9=-]+\\]", "").replace('‘', '\'').replace('’', '\'').strip();
    }

    private static List<Diag> dedupe(List<Diag> in) {
        List<Diag> out = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (Diag d : in) {
            if (seen.add(d.file() + ":" + d.line() + ":" + d.text().toLowerCase(Locale.ROOT))) {
                out.add(d);
            }
        }
        return out;
    }

    private static void deleteQuietly(Path dir) {
        if (dir == null) {
            return;
        }
        try (Stream<Path> w = Files.walk(dir)) {
            for (Path p : w.sorted(java.util.Comparator.reverseOrder()).toList()) {
                Files.deleteIfExists(p);
            }
        } catch (IOException e) {
            // temporary folder; the OS cleans it eventually
        }
    }
}
