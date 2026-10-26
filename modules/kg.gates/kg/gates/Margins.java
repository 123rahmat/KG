package kg.gates;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import kg.core.Expr;
import kg.core.Trace;
import kg.core.Vector;

/**
 * How close each assertion came to failing. Fixed arithmetic on the recorded trace, no judgement:
 * for "a <= b" the margin is b - a, for "a >= b" it is a - b, "and" takes the smaller margin, "or"
 * the larger, and "a -> b" only counts ticks where a holds. A negative worst margin means the
 * assertion failed; a small positive one means it passed with little room to spare.
 * Used for information only; G8 alone decides pass or fail.
 */
public final class Margins {
    /** Worst margin of one assertion over its window, where it happened and the signals there. */
    public record Margin(String assertion, Vector.Mode mode, double worst, int tick, String values, int deadline, boolean applied) {
        private String text() {
            return assertion;
        }

        /** True when the number says something about robustness (finite margin, not an exact match). */
        public boolean informative() {
            return mode == Vector.Mode.EVENTUALLY || !Double.isInfinite(worst);
        }

        public boolean neverApplied() {
            return !applied;
        }

        public boolean failed() {
            return mode == Vector.Mode.EVENTUALLY ? tick < 0 : worst < 0;
        }

        public String describe() {
            if (mode == Vector.Mode.EVENTUALLY) {
                return tick < 0 ? "never became true by tick " + deadline
                        : "became true at tick " + tick + ", " + (deadline - tick) + " ticks before the deadline " + deadline;
            }
            if (Double.isInfinite(worst)) {
                return !applied ? "never applied: the part before '->' never happened in this test, so it proved nothing"
                        : "held exactly whenever it applied";
            }
            return String.format(Locale.ROOT, "worst margin %.4g at tick %d (%s)", worst + 0.0, tick, values);
        }
    }

    private Margins() {
    }

    public static List<Margin> of(Vector v, Trace tr) {
        List<Margin> out = new ArrayList<>();
        int[] tick = new int[1];
        Expr.Row row = c -> tr.get(tick[0], c);
        for (Vector.Assertion a : v.asserts) {
            if (a.mode() == Vector.Mode.EVENTUALLY) {
                int met = -1;
                for (int t = 0; t <= a.fromTick() && t < tr.ticks(); t++) {
                    tick[0] = t;
                    if (Expr.test(a.cond(), row)) {
                        met = t;
                        break;
                    }
                }
                out.add(new Margin(a.text(), a.mode(), met < 0 ? -1 : a.fromTick() - met, met, "", a.fromTick(), true));
                continue;
            }
            double worst = Double.POSITIVE_INFINITY;
            int at = -1;
            boolean applied = !(a.cond() instanceof Expr.Implies);
            for (int t = Math.max(0, a.fromTick()); t < tr.ticks(); t++) {
                tick[0] = t;
                if (!applied && Expr.test(((Expr.Implies) a.cond()).a(), row)) {
                    applied = true;
                }
                double m = margin(a.cond(), row);
                if (m < worst) {
                    worst = m;
                    at = t;
                }
            }
            String vals = "";
            if (at >= 0) {
                List<Expr.Sig> sigs = new ArrayList<>();
                Expr.signals(a.cond(), sigs);
                StringBuilder sb = new StringBuilder();
                for (Expr.Sig s : sigs) {
                    if (sb.indexOf(s.name() + "=") >= 0) {
                        continue;
                    }
                    sb.append(sb.length() > 0 ? ", " : "").append(s.name()).append('=')
                            .append(String.format(Locale.ROOT, "%.4g", tr.get(at, s.col())));
                }
                vals = sb.toString();
            }
            out.add(new Margin(a.text(), a.mode(), worst, at, vals, -1, applied));
        }
        return out;
    }

    static double margin(Expr.Cond c, Expr.Row r) {
        if (c instanceof Expr.Cmp cmp) {
            double a = Expr.eval(cmp.a(), r);
            double b = Expr.eval(cmp.b(), r);
            return switch (cmp.op()) {
                case "<=", "<" -> b - a;
                case ">=", ">" -> a - b;
                case "==" -> a == b ? Double.POSITIVE_INFINITY : -Math.abs(a - b);
                default -> Math.abs(a - b);
            };
        }
        if (c instanceof Expr.And and) {
            return Math.min(margin(and.a(), r), margin(and.b(), r));
        }
        if (c instanceof Expr.Or or) {
            return Math.max(margin(or.a(), r), margin(or.b(), r));
        }
        if (c instanceof Expr.Not not) {
            return -margin(not.a(), r);
        }
        if (c instanceof Expr.Implies imp) {
            return Expr.test(imp.a(), r) ? margin(imp.b(), r) : Double.POSITIVE_INFINITY;
        }
        return Expr.test(c, r) ? 0 : -1;
    }
}
