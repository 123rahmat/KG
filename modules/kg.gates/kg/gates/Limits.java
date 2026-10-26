package kg.gates;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import kg.core.InputException;
import kg.core.Interface;
import kg.core.SafeFiles;
import kg.core.Vector;

/**
 * G14 safe operating limits. The board's limits file, written and signed by the hardware owner,
 * bounds every value a test may apply and every safety constant in the firmware. Values outside
 * the limits are rejected, never clipped. This protects real hardware before PIL and HIL run.
 *
 * limits.cfg:
 *   BOARD <name> <revision>
 *   RANGE <input channel> <min> <max>         commands (SET) and stuck/offset values on that channel
 *   NOISE_MAX <amplitude>
 *   DISTURB_MAX <absolute value>
 *   CONST <FIRMWARE_DEFINE> <min> <max>       a #define in the firmware that must stay inside limits
 */
public final class Limits {
    private static final Pattern DEFINE =
            Pattern.compile("^\\s*#\\s*define\\s+([A-Z0-9_]+)\\s+\\(?\\s*(-?[0-9]+(?:\\.[0-9]+)?)[fFuU]*\\s*\\)?\\s*(?:/\\*.*)?$");

    public final String board;
    private final Map<String, float[]> ranges;
    private final float noiseMax;
    private final float disturbMax;
    private final Map<String, float[]> consts;

    private Limits(String board, Map<String, float[]> ranges, float noiseMax, float disturbMax, Map<String, float[]> consts) {
        this.board = board;
        this.ranges = ranges;
        this.noiseMax = noiseMax;
        this.disturbMax = disturbMax;
        this.consts = consts;
    }

    public static Limits load(Path p) throws InputException {
        String board = null;
        Float noise = null;
        Float disturb = null;
        Map<String, float[]> ranges = new LinkedHashMap<>();
        Map<String, float[]> consts = new LinkedHashMap<>();
        int ln = 0;
        for (String raw : SafeFiles.readLines(p, 16384, 200)) {
            ln++;
            String l = raw.strip();
            if (l.isEmpty() || l.startsWith("#")) {
                continue;
            }
            String[] t = l.split("\\s+");
            String w = p.getFileName() + ":" + ln + ": ";
            try {
                switch (t[0]) {
                    case "BOARD" -> {
                        if (t.length != 3) {
                            throw new InputException(w + "BOARD <name> <revision>");
                        }
                        board = t[1] + " " + t[2];
                    }
                    case "RANGE" -> {
                        if (t.length != 4 || !t[1].matches("[a-z][a-z0-9_]{0,23}")) {
                            throw new InputException(w + "RANGE <channel> <min> <max>");
                        }
                        if (ranges.put(t[1], pair(t[2], t[3], w)) != null) {
                            throw new InputException(w + "duplicate RANGE for " + t[1]);
                        }
                    }
                    case "NOISE_MAX" -> noise = single(t, w);
                    case "DISTURB_MAX" -> disturb = single(t, w);
                    case "CONST" -> {
                        if (t.length != 4 || !t[1].matches("[A-Z0-9_]+")) {
                            throw new InputException(w + "CONST <NAME> <min> <max>");
                        }
                        if (consts.put(t[1], pair(t[2], t[3], w)) != null) {
                            throw new InputException(w + "duplicate CONST " + t[1]);
                        }
                    }
                    default -> throw new InputException(w + "unknown key " + t[0]);
                }
            } catch (NumberFormatException e) {
                throw new InputException(w + "bad number");
            }
        }
        if (board == null || noise == null || disturb == null) {
            throw new InputException(p.getFileName() + ": needs BOARD, NOISE_MAX and DISTURB_MAX");
        }
        return new Limits(board, ranges, noise, disturb, consts);
    }

    private static float[] pair(String a, String b, String w) throws InputException {
        float[] r = {Float.parseFloat(a), Float.parseFloat(b)};
        if (!Float.isFinite(r[0]) || !Float.isFinite(r[1]) || r[0] > r[1]) {
            throw new InputException(w + "bad range");
        }
        return r;
    }

    private static float single(String[] t, String w) throws InputException {
        if (t.length != 2) {
            throw new InputException(w + t[0] + " <value>");
        }
        float v = Float.parseFloat(t[1]);
        if (!Float.isFinite(v) || v < 0f) {
            throw new InputException(w + "bad value");
        }
        return v;
    }

    public List<String> check(List<Vector> vectors, List<Path> fwFiles, Interface itf) throws InputException {
        List<String> out = new ArrayList<>();
        for (String ch : ranges.keySet()) {
            if (itf.inputIndex(ch) < 0) {
                out.add("limits.cfg RANGE names " + ch + ", which is not an input in interface.cfg");
            }
        }
        for (Vector v : vectors) {
            String n = Path.of(v.source).getFileName().toString();
            for (Vector.Set s : v.sets) {
                inRange(itf.inputs.get(s.input()).name(), s.value(), n + ": SET", out);
            }
            for (Vector.Fault f : v.faults) {
                switch (f.kind()) {
                    case STUCK -> inRange(itf.inputs.get(f.input()).name(), f.value(), n + ": stuck value", out);
                    case OFFSET -> {
                        float[] r = ranges.get(itf.inputs.get(f.input()).name());
                        if (r != null && Math.abs(f.value()) > r[1] - r[0]) {
                            out.add(n + ": offset " + f.value() + " larger than the whole board range of "
                                    + itf.inputs.get(f.input()).name());
                        }
                    }
                    case NOISE -> {
                        if (f.value() > noiseMax) {
                            out.add(n + ": noise " + f.value() + " above board limit " + noiseMax);
                        }
                    }
                    case DISTURB -> {
                        if (Math.abs(f.value()) > disturbMax) {
                            out.add(n + ": disturbance " + f.value() + " above board limit " + disturbMax);
                        }
                    }
                    default -> {
                        // hang and freeze apply no value
                    }
                }
            }
        }
        Map<String, List<Float>> found = new LinkedHashMap<>();
        for (Path f : fwFiles) {
            for (String line : SafeFiles.readLines(f, 512 * 1024, 400)) {
                Matcher m = DEFINE.matcher(line);
                if (m.matches() && consts.containsKey(m.group(1))) {
                    found.computeIfAbsent(m.group(1), k -> new ArrayList<>()).add(Float.parseFloat(m.group(2)));
                }
            }
        }
        for (Map.Entry<String, float[]> c : consts.entrySet()) {
            List<Float> vals = found.get(c.getKey());
            if (vals == null) {
                out.add("firmware does not define safety constant " + c.getKey() + " as a plain number");
            } else if (vals.size() > 1) {
                out.add("safety constant " + c.getKey() + " is defined " + vals.size() + " times");
            } else if (vals.get(0) < c.getValue()[0] || vals.get(0) > c.getValue()[1]) {
                out.add(c.getKey() + " = " + vals.get(0) + " outside board limit " + c.getValue()[0] + ".." + c.getValue()[1]);
            }
        }
        return out;
    }

    private void inRange(String ch, float v, String what, List<String> out) {
        float[] r = ranges.get(ch);
        if (r != null && (v < r[0] || v > r[1])) {
            out.add(what + " " + ch + " = " + v + " outside board limit " + r[0] + ".." + r[1]);
        }
    }
}
