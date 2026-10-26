package kg.gates;

/** The outcome of one gate. Gates only ever report; the verdict decides. */
public record GateResult(String gate, boolean pass, String detail) {
    public static GateResult pass(String gate, String detail) {
        return new GateResult(gate, true, detail);
    }

    public static GateResult fail(String gate, String detail) {
        return new GateResult(gate, false, detail);
    }

    public String line() {
        return gate + " " + (pass ? "PASS" : "FAIL") + " " + detail.replace('\n', ' ');
    }
}
