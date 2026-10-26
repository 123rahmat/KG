package kg.core;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.regex.Pattern;

/**
 * The firmware's signal interface (interface.cfg). Every project declares its own channels,
 * so Kindgleam verifies any controller: heater, motor, battery, flight control.
 *
 *   INTERFACE <name> <version>
 *   RATE_HZ <ticks per second>
 *   INPUT  <name> <unit> <min> <max> COMMAND <default> [TOL <t>]   set by test vectors (SET)
 *   INPUT  <name> <unit> <min> <max> SENSOR [TOL <t>]              read from the plant model
 *   OUTPUT <name> <unit> <min> <max> SAFE <value> [TOL <t>]        actuator commands
 *   HANG_LATCH max | last | safe                                    what outputs do when firmware hangs
 *   TIMING_BUDGET_US <microseconds per step on the target>
 *
 * Order of INPUT and OUTPUT lines is the order of the firmware's in[] and out[] arrays.
 */
public final class Interface {
    private static final Pattern NAME = Pattern.compile("[a-z][a-z0-9_]{0,23}");
    private static final Pattern UNIT = Pattern.compile("[A-Za-z0-9/%_.-]{1,12}");

    public enum Source { COMMAND, SENSOR }

    public enum HangLatch { MAX, LAST, SAFE }

    public record Input(String name, String unit, float min, float max, Source source, float dflt, float tol) { }

    public record Output(String name, String unit, float min, float max, float safe, float tol) { }

    public final String name;
    public final int rateHz;
    public final List<Input> inputs;
    public final List<Output> outputs;
    public final HangLatch hangLatch;
    public final int timingBudgetUs;

    private Interface(String name, int rate, List<Input> in, List<Output> out, HangLatch latch, int budget) {
        this.name = name;
        this.rateHz = rate;
        this.inputs = Collections.unmodifiableList(in);
        this.outputs = Collections.unmodifiableList(out);
        this.hangLatch = latch;
        this.timingBudgetUs = budget;
    }

    public float dt() {
        return 1.0f / rateHz;
    }

    public int inputIndex(String n) {
        for (int i = 0; i < inputs.size(); i++) {
            if (inputs.get(i).name().equals(n)) {
                return i;
            }
        }
        return -1;
    }

    public int outputIndex(String n) {
        for (int i = 0; i < outputs.size(); i++) {
            if (outputs.get(i).name().equals(n)) {
                return i;
            }
        }
        return -1;
    }

    public static Interface load(Path p) throws InputException {
        String name = null;
        Integer rate = null;
        HangLatch latch = HangLatch.MAX;
        int budget = 0;
        List<Input> in = new ArrayList<>();
        List<Output> out = new ArrayList<>();
        List<String> names = new ArrayList<>();
        int ln = 0;
        for (String raw : SafeFiles.readLines(p, 32768, 300)) {
            ln++;
            String l = raw.strip();
            if (l.isEmpty() || l.startsWith("#")) {
                continue;
            }
            String[] t = l.split("\\s+");
            String w = p.getFileName() + ":" + ln + ": ";
            try {
                switch (t[0]) {
                    case "INTERFACE" -> {
                        if (t.length != 3 || !NAME.matcher(t[1].replace('-', '_')).matches()) {
                            throw new InputException(w + "INTERFACE <name> <version>");
                        }
                        name = t[1] + " " + t[2];
                    }
                    case "RATE_HZ" -> {
                        rate = Integer.parseInt(one(t, w));
                        if (rate < 1 || rate > 1_000_000) {
                            throw new InputException(w + "RATE_HZ out of range 1..1000000");
                        }
                    }
                    case "HANG_LATCH" -> latch = switch (one(t, w)) {
                        case "max" -> HangLatch.MAX;
                        case "last" -> HangLatch.LAST;
                        case "safe" -> HangLatch.SAFE;
                        default -> throw new InputException(w + "HANG_LATCH must be max, last or safe");
                    };
                    case "TIMING_BUDGET_US" -> {
                        budget = Integer.parseInt(one(t, w));
                        if (budget < 1 || budget > 10_000_000) {
                            throw new InputException(w + "TIMING_BUDGET_US out of range");
                        }
                    }
                    case "INPUT" -> {
                        if (t.length < 6) {
                            throw new InputException(w + "INPUT <name> <unit> <min> <max> COMMAND <default> | SENSOR [TOL t]");
                        }
                        String n = name(t[1], w, names);
                        String unit = unit(t[2], w);
                        float mn = num(t[3], w);
                        float mx = num(t[4], w);
                        range(mn, mx, w);
                        int k = 5;
                        Source src;
                        float dflt = 0f;
                        if (t[k].equals("COMMAND")) {
                            if (t.length < 7) {
                                throw new InputException(w + "COMMAND needs a default value");
                            }
                            src = Source.COMMAND;
                            dflt = num(t[6], w);
                            if (dflt < mn || dflt > mx) {
                                throw new InputException(w + "default outside min..max");
                            }
                            k = 7;
                        } else if (t[k].equals("SENSOR")) {
                            src = Source.SENSOR;
                            k = 6;
                        } else {
                            throw new InputException(w + "INPUT source must be COMMAND or SENSOR");
                        }
                        float tol = tol(t, k, w);
                        in.add(new Input(n, unit, mn, mx, src, dflt, tol));
                    }
                    case "OUTPUT" -> {
                        if (t.length < 7 || !t[5].equals("SAFE")) {
                            throw new InputException(w + "OUTPUT <name> <unit> <min> <max> SAFE <value> [TOL t]");
                        }
                        String n = name(t[1], w, names);
                        String unit = unit(t[2], w);
                        float mn = num(t[3], w);
                        float mx = num(t[4], w);
                        range(mn, mx, w);
                        float safe = num(t[6], w);
                        if (safe < mn || safe > mx) {
                            throw new InputException(w + "SAFE value outside min..max");
                        }
                        out.add(new Output(n, unit, mn, mx, safe, tol(t, 7, w)));
                    }
                    default -> throw new InputException(w + "unknown key " + t[0]);
                }
            } catch (NumberFormatException e) {
                throw new InputException(w + "bad number");
            }
        }
        if (name == null || rate == null || in.isEmpty() || out.isEmpty()) {
            throw new InputException(p.getFileName() + ": needs INTERFACE, RATE_HZ, at least one INPUT and one OUTPUT");
        }
        if (in.size() > 32 || out.size() > 32) {
            throw new InputException(p.getFileName() + ": at most 32 inputs and 32 outputs");
        }
        return new Interface(name, rate, in, out, latch, budget);
    }

    private static String one(String[] t, String w) throws InputException {
        if (t.length != 2) {
            throw new InputException(w + t[0] + " expects one value");
        }
        return t[1];
    }

    private static String name(String s, String w, List<String> names) throws InputException {
        if (!NAME.matcher(s).matches()) {
            throw new InputException(w + "channel names: lowercase letter first, then a-z 0-9 _, max 24");
        }
        if (names.contains(s) || s.equals("wd") || s.equals("tick")) {
            throw new InputException(w + "duplicate or reserved channel name " + s);
        }
        names.add(s);
        return s;
    }

    private static String unit(String s, String w) throws InputException {
        if (!UNIT.matcher(s).matches()) {
            throw new InputException(w + "bad unit '" + s + "'");
        }
        return s;
    }

    static float num(String s, String w) throws InputException {
        float v;
        try {
            v = Float.parseFloat(s);
        } catch (NumberFormatException e) {
            throw new InputException(w + "'" + s + "' is not a number");
        }
        if (!Float.isFinite(v)) {
            throw new InputException(w + "number must be finite");
        }
        return v;
    }

    private static void range(float mn, float mx, String w) throws InputException {
        if (!(mn < mx)) {
            throw new InputException(w + "min must be below max");
        }
    }

    private static float tol(String[] t, int k, String w) throws InputException {
        if (t.length == k) {
            return 0f;
        }
        if (t.length != k + 2 || !t[k].equals("TOL")) {
            throw new InputException(w + "unexpected text after the channel definition (only TOL <value> allowed)");
        }
        float v = num(t[k + 1], w);
        if (v < 0f) {
            throw new InputException(w + "TOL must be zero or positive");
        }
        return v;
    }
}
