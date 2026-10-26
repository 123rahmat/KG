package kg.gates;

import java.util.List;
import java.util.Locale;
import kg.core.Trace;

/**
 * G10: compares two traces tick by tick with a tolerance per signal (from interface.cfg and the
 * plant model). Returns null if they agree, else the first tick and signal that differ.
 */
public final class TraceCompare {
    private TraceCompare() {
    }

    /** tol: one tolerance per value column (same order as the trace columns); the wd column is always exact. */
    public static String firstDivergence(Trace a, Trace b, float[] tol, boolean compareState) {
        if (!a.columns.equals(b.columns)) {
            return "different signals: " + a.columns + " vs " + b.columns;
        }
        if (a.ticks() != b.ticks()) {
            return "length differs: " + a.ticks() + " vs " + b.ticks() + " ticks";
        }
        List<String> cols = a.columns;
        for (int t = 0; t < a.ticks(); t++) {
            for (int c = 0; c < cols.size(); c++) {
                float x = a.get(t, c);
                float y = b.get(t, c);
                float allowed = cols.get(c).equals("wd") ? 0f : (c < tol.length ? tol[c] : 0f);
                if (Math.abs(x - y) > allowed || (allowed == 0f && Float.compare(x, y) != 0 && !(x == 0f && y == 0f))) {
                    return String.format(Locale.ROOT, "tick %d: %s %s vs %s (tolerance %s)", t, cols.get(c),
                            Float.toString(x), Float.toString(y), Float.toString(allowed));
                }
            }
            if (compareState && !a.hash(t).equals(b.hash(t))) {
                return "tick " + t + ": firmware internal state differs";
            }
        }
        return null;
    }

    /** All-zero tolerance: exact comparison (used for repeatability). */
    public static float[] exact(Trace t) {
        return new float[t.columns.size()];
    }
}
