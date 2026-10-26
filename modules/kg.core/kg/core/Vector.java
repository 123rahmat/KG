package kg.core;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.regex.Pattern;

/**
 * A test vector (format v2): one text file, read identically by every tier.
 *
 *   REQ REQ-001
 *   TICKS 4000                       run length in ticks (max 100000)
 *   SEED 7                           random seed for noise faults
 *   WATCHDOG on | off                off only in negative controls
 *   SET <tick> <command-input> <value>
 *   FAULT <tick> hang
 *   FAULT <tick> stuck   <sensor-input> <value>
 *   FAULT <tick> offset  <sensor-input> <value>
 *   FAULT <tick> noise   <sensor-input> <amplitude>
 *   FAULT <tick> freeze  <sensor-input>
 *   FAULT <tick> disturb <value>     external disturbance into the plant
 *   ASSERT always <condition>
 *   ASSERT from <tick | fault | fault+N> always <condition>
 *   ASSERT eventually by <tick> <condition>
 *
 * Every signal name is checked against interface.cfg and the plant model when the file is loaded.
 */
public final class Vector {
    public static final int MAX_TICKS = 100_000;
    private static final Pattern REQ_ID = Pattern.compile("REQ-\\d{3}");

    public enum FaultKind { HANG, STUCK, OFFSET, NOISE, FREEZE, DISTURB }

    public enum Mode { ALWAYS, FROM, EVENTUALLY }

    public record Set(int tick, int input, float value) { }

    public record Fault(int tick, FaultKind kind, int input, float value) { }

    public record Assertion(Mode mode, int fromTick, Expr.Cond cond, String text) { }

    public final String source;
    public final String req;
    public final long seed;
    public final int ticks;
    public final boolean watchdogOn;
    public final List<Set> sets;
    public final List<Fault> faults;
    public final List<Assertion> asserts;

    private Vector(String source, String req, long seed, int ticks, boolean wd, List<Set> sets, List<Fault> faults,
                   List<Assertion> asserts) {
        this.source = source;
        this.req = req;
        this.seed = seed;
        this.ticks = ticks;
        this.watchdogOn = wd;
        this.sets = Collections.unmodifiableList(sets);
        this.faults = Collections.unmodifiableList(faults);
        this.asserts = Collections.unmodifiableList(asserts);
    }

    public int firstFaultTick() {
        return faults.stream().mapToInt(Fault::tick).min().orElse(-1);
    }

    /** Trace columns are: inputs, outputs, plant outputs, then wd. */
    public static List<String> columns(Interface itf, List<String> plantOutputs) {
        List<String> c = new ArrayList<>();
        itf.inputs.forEach(i -> c.add(i.name()));
        itf.outputs.forEach(o -> c.add(o.name()));
        c.addAll(plantOutputs);
        c.add("wd");
        return c;
    }

    public static Vector load(Path p, Interface itf, List<String> plantOutputs) throws InputException {
        List<String> cols = columns(itf, plantOutputs);
        List<String> lines = SafeFiles.readLines(p, 32768, 500);
        String req = null;
        long seed = 1;
        Integer ticks = null;
        boolean wd = true;
        List<Set> sets = new ArrayList<>();
        List<Fault> faults = new ArrayList<>();
        List<String[]> pendingAsserts = new ArrayList<>();
        int ln = 0;
        for (String raw : lines) {
            ln++;
            String line = raw.strip();
            if (line.isEmpty() || line.startsWith("#")) {
                continue;
            }
            String w = p.getFileName() + ":" + ln + ": ";
            String[] t = line.split("\\s+");
            try {
                switch (t[0]) {
                    case "REQ" -> {
                        need(t, 2, w);
                        if (!REQ_ID.matcher(t[1]).matches()) {
                            throw new InputException(w + "bad requirement id " + t[1]);
                        }
                        req = t[1];
                    }
                    case "SEED" -> {
                        need(t, 2, w);
                        seed = Long.parseLong(t[1]);
                        if (seed < 0 || seed > 0xFFFF_FFFFL) {
                            throw new InputException(w + "SEED out of range");
                        }
                    }
                    case "TICKS" -> {
                        need(t, 2, w);
                        ticks = Integer.parseInt(t[1]);
                        if (ticks < 1 || ticks > MAX_TICKS) {
                            throw new InputException(w + "TICKS out of range 1.." + MAX_TICKS);
                        }
                    }
                    case "WATCHDOG" -> {
                        need(t, 2, w);
                        if (!t[1].equals("on") && !t[1].equals("off")) {
                            throw new InputException(w + "WATCHDOG must be on or off");
                        }
                        wd = t[1].equals("on");
                    }
                    case "SET" -> {
                        need(t, 4, w);
                        int tick = tick(t[1], w);
                        int k = itf.inputIndex(t[2]);
                        if (k < 0 || itf.inputs.get(k).source() != Interface.Source.COMMAND) {
                            throw new InputException(w + t[2] + " is not a COMMAND input in interface.cfg");
                        }
                        float v = Interface.num(t[3], w);
                        Interface.Input in = itf.inputs.get(k);
                        if (v < in.min() || v > in.max()) {
                            throw new InputException(w + t[2] + " value outside its interface range " + in.min() + ".." + in.max());
                        }
                        sets.add(new Set(tick, k, v));
                    }
                    case "FAULT" -> {
                        if (t.length < 3) {
                            throw new InputException(w + "FAULT <tick> <kind> ...");
                        }
                        int tick = tick(t[1], w);
                        FaultKind k = switch (t[2]) {
                            case "hang" -> FaultKind.HANG;
                            case "stuck" -> FaultKind.STUCK;
                            case "offset" -> FaultKind.OFFSET;
                            case "noise" -> FaultKind.NOISE;
                            case "freeze" -> FaultKind.FREEZE;
                            case "disturb" -> FaultKind.DISTURB;
                            default -> throw new InputException(w + "unknown fault " + t[2]);
                        };
                        int input = -1;
                        float v = 0f;
                        switch (k) {
                            case HANG -> need(t, 3, w);
                            case DISTURB -> {
                                need(t, 4, w);
                                v = bounded(t[3], w);
                            }
                            case FREEZE -> {
                                need(t, 4, w);
                                input = sensor(itf, t[3], w);
                            }
                            default -> {
                                need(t, 5, w);
                                input = sensor(itf, t[3], w);
                                v = bounded(t[4], w);
                                if (k == FaultKind.NOISE && v < 0f) {
                                    throw new InputException(w + "noise amplitude must be positive");
                                }
                            }
                        }
                        faults.add(new Fault(tick, k, input, v));
                        if (faults.size() > 16) {
                            throw new InputException(w + "at most 16 faults per vector");
                        }
                    }
                    case "ASSERT" -> {
                        pendingAsserts.add(new String[] {line.substring(6).strip(), w});
                        if (pendingAsserts.size() > 16) {
                            throw new InputException(w + "at most 16 assertions per vector");
                        }
                    }
                    default -> throw new InputException(w + "unknown keyword " + t[0]);
                }
            } catch (NumberFormatException e) {
                throw new InputException(w + "bad number");
            }
        }
        if (req == null || ticks == null) {
            throw new InputException(p.getFileName() + ": needs REQ and TICKS");
        }
        if (pendingAsserts.isEmpty()) {
            throw new InputException(p.getFileName() + ": a vector with no ASSERT proves nothing");
        }
        for (Set s : sets) {
            if (s.tick() >= ticks) {
                throw new InputException(p.getFileName() + ": SET at tick " + s.tick() + " is after the run ends");
            }
        }
        for (Fault f : faults) {
            if (f.tick() >= ticks) {
                throw new InputException(p.getFileName() + ": FAULT at tick " + f.tick() + " is after the run ends");
            }
        }
        int firstFault = faults.stream().mapToInt(Fault::tick).min().orElse(-1);
        List<Assertion> asserts = new ArrayList<>();
        for (String[] a : pendingAsserts) {
            asserts.add(assertion(a[0], a[1], cols, firstFault, ticks));
        }
        return new Vector(p.toString(), req, seed, ticks, wd, sets, faults, asserts);
    }

    private static Assertion assertion(String text, String w, List<String> cols, int firstFault, int ticks)
            throws InputException {
        String[] t = text.split("\\s+", 4);
        try {
            if (t[0].equals("always") && t.length >= 2) {
                String c = text.substring(6).strip();
                return new Assertion(Mode.ALWAYS, 0, Expr.parse(c, cols::indexOf), "always " + c);
            }
            if (t[0].equals("from") && t.length == 4 && t[2].equals("always")) {
                int from;
                if (t[1].equals("fault") || t[1].startsWith("fault+")) {
                    if (firstFault < 0) {
                        throw new InputException(w + "'from fault' but the vector injects no fault");
                    }
                    from = firstFault + (t[1].equals("fault") ? 0 : Integer.parseInt(t[1].substring(6)));
                } else {
                    from = Integer.parseInt(t[1]);
                }
                if (from < 0 || from >= ticks) {
                    throw new InputException(w + "'from' tick " + from + " is outside the run");
                }
                return new Assertion(Mode.FROM, from, Expr.parse(t[3], cols::indexOf), text);
            }
            if (t[0].equals("eventually") && t.length == 4 && t[1].equals("by")) {
                int by = Integer.parseInt(t[2]);
                if (by < 0 || by >= ticks) {
                    throw new InputException(w + "'eventually by' tick outside the run");
                }
                return new Assertion(Mode.EVENTUALLY, by, Expr.parse(t[3], cols::indexOf), text);
            }
        } catch (NumberFormatException e) {
            throw new InputException(w + "bad tick number in assertion");
        } catch (InputException e) {
            throw e.getMessage().startsWith(w) ? e : new InputException(w + e.getMessage());
        }
        throw new InputException(w + "ASSERT must be 'always <c>', 'from <tick|fault+N> always <c>' or 'eventually by <tick> <c>'");
    }

    private static void need(String[] t, int n, String w) throws InputException {
        if (t.length != n) {
            throw new InputException(w + "'" + String.join(" ", t) + "' has the wrong number of values");
        }
    }

    private static int tick(String s, String w) throws InputException {
        int v = Integer.parseInt(s);
        if (v < 0 || v >= MAX_TICKS) {
            throw new InputException(w + "tick out of range");
        }
        return v;
    }

    private static float bounded(String s, String w) throws InputException {
        float v = Interface.num(s, w);
        if (Math.abs(v) > 1e6f) {
            throw new InputException(w + "value too large");
        }
        return v;
    }

    private static int sensor(Interface itf, String name, String w) throws InputException {
        int k = itf.inputIndex(name);
        if (k < 0 || itf.inputs.get(k).source() != Interface.Source.SENSOR) {
            throw new InputException(w + name + " is not a SENSOR input in interface.cfg");
        }
        return k;
    }
}
