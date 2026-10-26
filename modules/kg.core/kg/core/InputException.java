package kg.core;

/** Any input that is missing, malformed, oversized or unsafe. Always treated as a failure. */
public final class InputException extends Exception {
    private static final long serialVersionUID = 1L;

    public InputException(String message) {
        super(message);
    }
}
