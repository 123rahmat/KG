package kg.app;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import kg.core.InputException;
import kg.core.Interface;
import kg.core.SafeFiles;
import kg.core.Trace;
import kg.core.Vector;
import kg.gates.Requirements;
import kg.sil.Plant;

/** Read-only view of a project folder and its runs. The app never writes evidence. */
final class ProjectData {
    record Agent(String no, String name, String status, String ms, String reason) { }

    record Gate(String id, boolean pass, String detail) { }

    record Run(String id, String verdict, String reason, Instant when, List<Agent> agents, List<Gate> gates,
               List<String> notes, String report) {
        boolean isEval() {
            return id.startsWith("eval");
        }

        String label() {
            if (verdict != null) {
                return verdict;
            }
            boolean failed = agents.stream().anyMatch(a -> a.status().equals("FAILED") || a.status().equals("BLOCKED"));
            return isEval() ? (failed ? "FAIL" : "PASS") : (failed ? "FAIL" : "OK");
        }

        String kind() {
            if (isEval()) {
                return "Eval";
            }
            return verdict == null ? "Check" : "Verify";
        }
    }

    final Path project;
    final Path home;

    ProjectData(Path home, Path project) {
        this.home = home;
        this.project = project;
    }

    String name() {
        return project.getFileName().toString();
    }

    List<Run> runs() {
        List<Run> out = new ArrayList<>();
        Path jobs = project.resolve("jobs");
        if (!Files.isDirectory(jobs)) {
            return out;
        }
        try (Stream<Path> s = Files.list(jobs)) {
            for (Path d : s.filter(Files::isDirectory).filter(p -> p.getFileName().toString().matches("(run|eval)-\\d{4}"))
                    .sorted(Comparator.comparing((Path p) -> {
                        try {
                            return Files.getLastModifiedTime(p).toInstant();
                        } catch (IOException e) {
                            return Instant.EPOCH;
                        }
                    }).reversed()).toList()) {
                out.add(run(d));
            }
        } catch (IOException e) {
            // empty list
        }
        return out;
    }

    Run run(Path d) {
        List<Agent> agents = new ArrayList<>();
        List<Gate> gates = new ArrayList<>();
        List<String> notes = new ArrayList<>();
        String verdict = null;
        String reason = "";
        String report = "";
        Instant when = Instant.EPOCH;
        try {
            when = Files.getLastModifiedTime(d).toInstant();
            try (Stream<Path> s = Files.list(d)) {
                for (Path rp : s.filter(x -> x.toString().endsWith(".report")).sorted().toList()) {
                    Map<String, String> kv = new HashMap<>();
                    for (String l : SafeFiles.readLines(rp, 65536, 4000)) {
                        int sp = l.indexOf(' ');
                        if (sp > 0) {
                            kv.put(l.substring(0, sp), l.substring(sp + 1));
                        }
                    }
                    String n = rp.getFileName().toString();
                    agents.add(new Agent(n.substring(0, 2), kv.getOrDefault("AGENT", "?"), kv.getOrDefault("STATUS", "?"),
                            kv.getOrDefault("DURATION_MS", ""), "-".equals(kv.get("REASON")) ? "" : kv.getOrDefault("REASON", "")));
                }
            }
            Path g = d.resolve("gates.txt");
            if (Files.exists(g)) {
                for (String l : SafeFiles.readLines(g, 1 << 20, 8000)) {
                    String[] f = l.split(" ", 3);
                    if (f.length >= 2) {
                        gates.add(new Gate(f[0], f[1].equals("PASS"), f.length > 2 ? f[2] : ""));
                    }
                }
            }
            Path v = d.resolve("verdict.txt");
            if (Files.exists(v)) {
                List<String> vl = SafeFiles.readLines(v, 8192, 4000);
                verdict = vl.get(0).replace("VERDICT ", "");
                reason = vl.size() > 1 ? vl.get(1).replace("REASON ", "") : "";
            }
            Path r = d.resolve("report.txt");
            if (Files.exists(r)) {
                List<String> rl = SafeFiles.readLines(r, 1 << 20, 8000);
                report = String.join("\n", rl);
                boolean in = false;
                for (String l : rl) {
                    if (l.equals("Notes")) {
                        in = true;
                    } else if (in && l.startsWith("  - ")) {
                        notes.add(l.substring(4));
                    } else if (in && !l.isBlank()) {
                        in = false;
                    }
                }
            }
        } catch (IOException | InputException e) {
            reason = "unreadable run folder: " + e.getMessage();
        }
        return new Run(d.getFileName().toString(), verdict, reason, when, agents, gates, notes, report);
    }

    Interface itf() {
        try {
            return Interface.load(SafeFiles.inside(project, "interface.cfg"));
        } catch (InputException e) {
            return null;
        }
    }

    Plant.Spec plant(Interface itf) {
        try {
            String model = null;
            for (String l : SafeFiles.readLines(SafeFiles.inside(project, "profile.cfg"), 8192, 300)) {
                if (l.startsWith("PLANT_MODEL ")) {
                    model = l.substring(12).strip();
                }
            }
            return model == null || itf == null ? null : Plant.load(SafeFiles.inside(project, model), itf);
        } catch (InputException e) {
            return null;
        }
    }

    List<Requirements.Req> requirements() {
        try {
            List<String> errs = new ArrayList<>();
            return new ArrayList<>(Requirements.lint(SafeFiles.inside(project, "spec/spec.req"), errs).values());
        } catch (InputException e) {
            return List.of();
        }
    }

    List<String> vectorNames() {
        List<String> out = new ArrayList<>();
        try (Stream<Path> s = Files.list(project.resolve("vectors"))) {
            s.map(p -> p.getFileName().toString()).filter(n -> n.endsWith(".vec")).sorted()
                    .forEach(n -> out.add(n.substring(0, n.length() - 4)));
        } catch (IOException e) {
            // none
        }
        return out;
    }

    /** Hand-written vectors plus those Python generators produced in the given run. */
    List<String> vectorNames(String run) {
        List<String> out = vectorNames();
        if (run == null) {
            return out;
        }
        try (Stream<Path> s = Files.list(SafeFiles.inside(project, "jobs/" + run + "/generated"))) {
            s.map(p -> p.getFileName().toString()).filter(n -> n.endsWith(".vec")).sorted()
                    .forEach(n -> out.add(n.substring(0, n.length() - 4)));
        } catch (IOException | InputException e) {
            // no generated vectors in this run
        }
        return out;
    }

    boolean generated(String name) {
        return !Files.exists(project.resolve("vectors").resolve(name + ".vec"));
    }

    private Path vectorPath(String name, String run) throws InputException {
        Path hand = SafeFiles.inside(project, "vectors/" + name + ".vec");
        if (Files.exists(hand) || run == null) {
            return hand;
        }
        return SafeFiles.inside(project, "jobs/" + run + "/generated/" + name + ".vec");
    }

    Vector vector(String name, Interface itf, Plant.Spec plant, String run) {
        try {
            return Vector.load(vectorPath(name, run), itf, plant.outputNames());
        } catch (InputException e) {
            return null;
        }
    }

    String vectorText(String name, String run) {
        try {
            return String.join("\n", SafeFiles.readLines(vectorPath(name, run), 65536, 600));
        } catch (InputException e) {
            return e.getMessage();
        }
    }

    Vector vector(String name, Interface itf, Plant.Spec plant) {
        try {
            return Vector.load(SafeFiles.inside(project, "vectors/" + name + ".vec"), itf, plant.outputNames());
        } catch (InputException e) {
            return null;
        }
    }

    String vectorText(String name) {
        try {
            return String.join("\n", SafeFiles.readLines(SafeFiles.inside(project, "vectors/" + name + ".vec"), 65536, 600));
        } catch (InputException e) {
            return e.getMessage();
        }
    }

    Trace trace(String run, String vector, String suffix) {
        try {
            Path p = SafeFiles.inside(project, "jobs/" + run + "/traces/" + vector + suffix);
            return Files.exists(p) ? Trace.read(p) : null;
        } catch (InputException e) {
            return null;
        }
    }

    /** Pass/fail per vector from the Quality agent's log of a run. */
    Map<String, String> vectorResults(String run) {
        Map<String, String> m = new HashMap<>();
        try (Stream<Path> s = Files.list(SafeFiles.inside(project, "jobs/" + run))) {
            for (Path p : s.filter(x -> x.getFileName().toString().endsWith("_quality.log")).toList()) {
                for (String l : SafeFiles.readLines(p, 1 << 20, 4000)) {
                    String[] f = l.split(" ");
                    if (f.length >= 2 && (f[0].equals("PASS") || f[0].equals("FAIL"))) {
                        m.merge(f[1], f[0], (a, b) -> a.equals("FAIL") || b.equals("FAIL") ? "FAIL" : "PASS");
                    }
                }
            }
        } catch (IOException | InputException e) {
            // no results
        }
        return m;
    }

    String profileText() {
        try {
            return String.join("\n", SafeFiles.readLines(SafeFiles.inside(project, "profile.cfg"), 65536, 400));
        } catch (InputException e) {
            return "";
        }
    }

    List<String> ledgerLines() {
        List<String> out = new ArrayList<>();
        Path l = project.resolve("evidence").resolve("ledger.log");
        try {
            if (Files.exists(l)) {
                for (String s : SafeFiles.readLines(l, 64L << 20, 200_000)) {
                    String[] f = s.split(" ");
                    if (f.length > 7) {
                        out.add(f[3] + "  " + f[4] + "  " + f[5] + "  " + f[6] + " files  entry " + f[1].substring(0, 16) + "...");
                    }
                }
            }
        } catch (InputException e) {
            out.add("ledger unreadable: " + e.getMessage());
        }
        java.util.Collections.reverse(out);
        return out;
    }
}
