package kg.gates;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import kg.core.Expr;
import kg.core.Trace;
import kg.core.Vector;

/** G8: checks a trace against its vector's assertions. Fails closed. */
public final class TraceCheck {
    private TraceCheck() {
    }

    public static List<String> check(Vector v, Trace tr) {
        List<String> out = new ArrayList<>();
        if (tr.ticks() != v.ticks) {
            out.add("trace has " + tr.ticks() + " ticks, vector expects " + v.ticks);
            return out;
        }
        int[] tick = new int[1];
        Expr.Row row = c -> tr.get(tick[0], c);
        for (Vector.Assertion a : v.asserts) {
            switch (a.mode()) {
                case ALWAYS, FROM -> {
                    for (int t = a.fromTick(); t < tr.ticks(); t++) {
                        tick[0] = t;
                        if (!Expr.test(a.cond(), row)) {
                            out.add("'" + a.text() + "' broken at tick " + t + " (" + values(a, tr, t) + ")");
                            break;
                        }
                    }
                }
                case EVENTUALLY -> {
                    boolean met = false;
                    for (int t = 0; t <= a.fromTick() && !met; t++) {
                        tick[0] = t;
                        met = Expr.test(a.cond(), row);
                    }
                    if (!met) {
                        out.add("'" + a.text() + "' never became true (at tick " + a.fromTick() + ": "
                                + values(a, tr, a.fromTick()) + ")");
                    }
                }
                default -> out.add("unknown assertion mode");
            }
        }
        return out;
    }

    private static String values(Vector.Assertion a, Trace tr, int t) {
        List<Expr.Sig> sigs = new ArrayList<>();
        Expr.signals(a.cond(), sigs);
        StringBuilder sb = new StringBuilder();
        for (Expr.Sig s : sigs) {
            if (sb.length() > 0) {
                sb.append(", ");
            }
            sb.append(s.name()).append('=').append(String.format(Locale.ROOT, "%.4g", tr.get(t, s.col())));
        }
        return sb.toString();
    }
}
