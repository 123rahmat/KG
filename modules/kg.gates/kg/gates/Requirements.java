package kg.gates;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Pattern;
import kg.core.InputException;
import kg.core.SafeFiles;
import kg.core.Vector;

/** G0 spec lint and G5 requirement-to-test coverage. */
public final class Requirements {
    private static final Pattern ID = Pattern.compile("REQ-\\d{3}");
    private static final Set<String> TIERS = Set.of("SIL", "PIL", "HIL");

    public record Req(String id, String text, Set<String> tiers) { }

    private Requirements() {
    }

    /** Parses the spec. Problems are added to errors; returns the requirements that parsed. */
    public static Map<String, Req> lint(Path spec, List<String> errors) throws InputException {
        Map<String, Req> reqs = new LinkedHashMap<>();
        int ln = 0;
        for (String raw : SafeFiles.readLines(spec, 256 * 1024, 600)) {
            ln++;
            String line = raw.strip();
            if (line.isEmpty() || line.startsWith("#")) {
                continue;
            }
            String[] f = line.split("\\|", -1);
            String where = spec.getFileName() + ":" + ln + ": ";
            if (f.length != 3) {
                errors.add(where + "expected 'REQ-NNN | requirement | tiers'");
                continue;
            }
            String id = f[0].strip();
            String text = f[1].strip();
            if (!ID.matcher(id).matches()) {
                errors.add(where + "bad id '" + id + "'");
                continue;
            }
            if (reqs.containsKey(id)) {
                errors.add(where + "duplicate id " + id);
                continue;
            }
            if (!text.matches(".*\\d.*")) {
                errors.add(where + id + " has no measurable limit (no number)");
            }
            Set<String> tiers = new TreeSet<>();
            for (String t : f[2].strip().split("[\\s,]+")) {
                if (!TIERS.contains(t)) {
                    errors.add(where + id + " unknown tier '" + t + "'");
                } else {
                    tiers.add(t);
                }
            }
            if (tiers.isEmpty()) {
                errors.add(where + id + " names no tier");
            }
            reqs.put(id, new Req(id, text, tiers));
        }
        if (reqs.isEmpty()) {
            errors.add(spec.getFileName() + ": no requirements");
        }
        return reqs;
    }

    /** Every requirement has a vector, and every vector names a real requirement. */
    public static List<String> trace(Map<String, Req> reqs, List<Vector> vectors) {
        List<String> errors = new ArrayList<>();
        Set<String> covered = new TreeSet<>();
        for (Vector vec : vectors) {
            if (!reqs.containsKey(vec.req)) {
                errors.add(Path.of(vec.source).getFileName() + " names unknown requirement " + vec.req);
            }
            covered.add(vec.req);
        }
        for (String id : reqs.keySet()) {
            if (!covered.contains(id)) {
                errors.add(id + " has no test vector");
            }
        }
        return errors;
    }
}
