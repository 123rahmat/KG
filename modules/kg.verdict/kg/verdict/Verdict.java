package kg.verdict;

import java.util.List;
import kg.gates.GateResult;

/**
 * The only code allowed to say PASS. PASS needs every required gate present and passing,
 * and no failing result anywhere. Anything else is FAIL.
 */
public final class Verdict {
    public record Outcome(boolean pass, String reason) {
        public String word() {
            return pass ? "PASS" : "FAIL";
        }
    }

    private Verdict() {
    }

    public static Outcome decide(List<String> requiredGates, List<GateResult> results) {
        if (requiredGates == null || requiredGates.isEmpty()) {
            return new Outcome(false, "profile requires no gates; refusing to pass");
        }
        for (GateResult r : results) {
            if (!r.pass()) {
                return new Outcome(false, "first violated gate " + r.gate() + ": " + r.detail());
            }
        }
        for (String g : requiredGates) {
            boolean seen = false;
            for (GateResult r : results) {
                if (r.gate().equals(g)) {
                    seen = true;
                    break;
                }
            }
            if (!seen) {
                return new Outcome(false, "required gate " + g + " did not run");
            }
        }
        return new Outcome(true, "all " + requiredGates.size() + " required gates passed");
    }
}
