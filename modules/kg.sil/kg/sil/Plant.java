package kg.sil;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.regex.Pattern;
import kg.core.InputException;
import kg.core.Interface;
import kg.core.SafeFiles;

/**
 * The simulated device the firmware controls. Built-in models cover common cases; any other model
 * comes in as an FMI 2.0 co-simulation FMU exported from Simulink, Modelica, OpenModelica, etc.
 *
 * Model file (models/*.model):
 *   MODEL first_order | second_order | fmu
 *   FMU <path.fmu>                                  (fmu only)
 *   OUTPUT <name> <unit> <initial> [VAR <fmu var>] [TOL <t>]   plant outputs, recorded in traces
 *   DRIVE <firmware output> [GAIN <g>] [VAR <fmu var>]         firmware output that drives the plant
 *   DISTURB [VAR <fmu var>]                         where FAULT disturb enters (built-ins: added to the rate)
 *   SENSOR <firmware sensor input> <plant output>   what each sensor reads
 *   PARAM <NAME> <value>                            built-in model parameters
 *   CALIBRATION none | <measurement file>
 *
 *   first_order:  y' = (-(y - AMBIENT) + GAIN * u) / TAU_S + d            one OUTPUT
 *   second_order: y'' = WN^2 * (GAIN * u - (y - OFFSET)) - 2 ZETA WN y' + d  OUTPUTs: y, then y'
 *                 optional PARAM LIMIT_MIN / LIMIT_MAX: mechanical end stops (motion stops there)
 */
public abstract class Plant implements AutoCloseable {
    private static final Pattern NAME = Pattern.compile("[a-z][a-z0-9_]{0,23}");
    private static final Pattern VAR = Pattern.compile("[A-Za-z_][A-Za-z0-9_.\\[\\]]{0,80}");

    public record Out(String name, String unit, float initial, String var, float tol) { }

    public record Drive(int fwOutput, float gain, String var) { }

    public record Sensor(int fwInput, int plantOutput) { }

    /** Parsed model file; also used to build the plant for each run. */
    public static final class Spec {
        public String kind;
        public String fmu;
        public final List<Out> outputs = new ArrayList<>();
        public final List<Drive> drives = new ArrayList<>();
        public final List<Sensor> sensors = new ArrayList<>();
        public final java.util.Map<String, Float> params = new java.util.LinkedHashMap<>();
        public String disturbVar;
        public boolean hasDisturb;
        public String calibration;

        Spec() {
            // built only by Plant.load
        }

        public List<String> outputNames() {
            List<String> n = new ArrayList<>();
            outputs.forEach(o -> n.add(o.name()));
            return Collections.unmodifiableList(n);
        }

        public boolean calibrated() {
            return calibration != null && !calibration.equals("none");
        }

        public float param(String n) throws InputException {
            Float v = params.get(n);
            if (v == null) {
                throw new InputException("plant model needs PARAM " + n);
            }
            return v;
        }
    }

    public static Spec load(Path p, Interface itf) throws InputException {
        Spec s = new Spec();
        int ln = 0;
        for (String raw : SafeFiles.readLines(p, 16384, 300)) {
            ln++;
            String l = raw.strip();
            if (l.isEmpty() || l.startsWith("#")) {
                continue;
            }
            String[] t = l.split("\\s+");
            String w = p.getFileName() + ":" + ln + ": ";
            try {
                switch (t[0]) {
                    case "MODEL" -> {
                        n(t, 2, w);
                        if (!List.of("first_order", "second_order", "fmu").contains(t[1])) {
                            throw new InputException(w + "MODEL must be first_order, second_order or fmu");
                        }
                        s.kind = t[1];
                    }
                    case "FMU" -> {
                        n(t, 2, w);
                        if (!t[1].matches("[A-Za-z0-9_./-]{1,200}\\.fmu") || t[1].contains("..")) {
                            throw new InputException(w + "FMU must be a relative path ending in .fmu");
                        }
                        s.fmu = t[1];
                    }
                    case "OUTPUT" -> {
                        if (t.length < 4 || !NAME.matcher(t[1]).matches() || itf.inputIndex(t[1]) >= 0
                                || itf.outputIndex(t[1]) >= 0 || s.outputNames().contains(t[1])) {
                            throw new InputException(w + "OUTPUT <unique name> <unit> <initial> [VAR v] [TOL t]");
                        }
                        String var = null;
                        float tol = 0f;
                        for (int k = 4; k < t.length; k += 2) {
                            if (k + 1 >= t.length) {
                                throw new InputException(w + t[k] + " needs a value");
                            }
                            if (t[k].equals("VAR")) {
                                var = var(t[k + 1], w);
                            } else if (t[k].equals("TOL")) {
                                tol = Float.parseFloat(t[k + 1]);
                                if (!(tol >= 0f)) {
                                    throw new InputException(w + "bad TOL");
                                }
                            } else {
                                throw new InputException(w + "unknown option " + t[k]);
                            }
                        }
                        s.outputs.add(new Out(t[1], t[2], fin(t[3], w), var, tol));
                    }
                    case "DRIVE" -> {
                        if (t.length < 2) {
                            throw new InputException(w + "DRIVE <firmware output> [GAIN g] [VAR v]");
                        }
                        int o = itf.outputIndex(t[1]);
                        if (o < 0) {
                            throw new InputException(w + t[1] + " is not an OUTPUT in interface.cfg");
                        }
                        float gain = 1f;
                        String var = null;
                        for (int k = 2; k < t.length; k += 2) {
                            if (k + 1 >= t.length) {
                                throw new InputException(w + t[k] + " needs a value");
                            }
                            if (t[k].equals("GAIN")) {
                                gain = fin(t[k + 1], w);
                            } else if (t[k].equals("VAR")) {
                                var = var(t[k + 1], w);
                            } else {
                                throw new InputException(w + "unknown option " + t[k]);
                            }
                        }
                        s.drives.add(new Drive(o, gain, var));
                    }
                    case "DISTURB" -> {
                        s.hasDisturb = true;
                        if (t.length == 3 && t[1].equals("VAR")) {
                            s.disturbVar = var(t[2], w);
                        } else if (t.length != 1) {
                            throw new InputException(w + "DISTURB [VAR v]");
                        }
                    }
                    case "SENSOR" -> {
                        n(t, 3, w);
                        int in = itf.inputIndex(t[1]);
                        if (in < 0 || itf.inputs.get(in).source() != Interface.Source.SENSOR) {
                            throw new InputException(w + t[1] + " is not a SENSOR input in interface.cfg");
                        }
                        int po = s.outputNames().indexOf(t[2]);
                        if (po < 0) {
                            throw new InputException(w + t[2] + " is not a plant OUTPUT declared above");
                        }
                        s.sensors.add(new Sensor(in, po));
                    }
                    case "PARAM" -> {
                        n(t, 3, w);
                        if (!t[1].matches("[A-Z][A-Z0-9_]{0,23}")) {
                            throw new InputException(w + "PARAM names are UPPER_CASE");
                        }
                        s.params.put(t[1], fin(t[2], w));
                    }
                    case "CALIBRATION" -> {
                        n(t, 2, w);
                        s.calibration = t[1];
                    }
                    default -> throw new InputException(w + "unknown key " + t[0]);
                }
            } catch (NumberFormatException e) {
                throw new InputException(w + "bad number");
            }
        }
        if (s.kind == null || s.outputs.isEmpty() || s.drives.isEmpty() || s.calibration == null) {
            throw new InputException(p.getFileName() + ": needs MODEL, OUTPUT, DRIVE and CALIBRATION");
        }
        for (Interface.Input in : itf.inputs) {
            if (in.source() == Interface.Source.SENSOR
                    && s.sensors.stream().noneMatch(x -> itf.inputs.get(x.fwInput()).name().equals(in.name()))) {
                throw new InputException(p.getFileName() + ": sensor input " + in.name() + " has no SENSOR line");
            }
        }
        if (s.kind.equals("fmu")) {
            if (s.fmu == null) {
                throw new InputException(p.getFileName() + ": MODEL fmu needs an FMU line");
            }
            for (Out o : s.outputs) {
                if (o.var() == null) {
                    throw new InputException(p.getFileName() + ": FMU output " + o.name() + " needs VAR");
                }
            }
            for (Drive d : s.drives) {
                if (d.var() == null) {
                    throw new InputException(p.getFileName() + ": FMU drive needs VAR");
                }
            }
        } else if (s.kind.equals("first_order")) {
            if (s.outputs.size() != 1) {
                throw new InputException(p.getFileName() + ": first_order has exactly one OUTPUT");
            }
            for (String k : List.of("TAU_S", "GAIN", "AMBIENT")) {
                s.param(k);
            }
            if (s.param("TAU_S") <= 0f) {
                throw new InputException(p.getFileName() + ": TAU_S must be positive");
            }
        } else {
            if (s.outputs.size() != 2) {
                throw new InputException(p.getFileName() + ": second_order has two OUTPUTs: value, then rate");
            }
            for (String k : List.of("WN", "ZETA", "GAIN", "OFFSET")) {
                s.param(k);
            }
            if (s.param("WN") <= 0f || s.param("ZETA") < 0f) {
                throw new InputException(p.getFileName() + ": WN must be positive and ZETA not negative");
            }
            if (s.params.containsKey("LIMIT_MIN") != s.params.containsKey("LIMIT_MAX")
                    || (s.params.containsKey("LIMIT_MIN") && !(s.param("LIMIT_MIN") < s.param("LIMIT_MAX")))) {
                throw new InputException(p.getFileName() + ": end stops need both LIMIT_MIN and LIMIT_MAX, with MIN below MAX");
            }
        }
        return s;
    }

    private static void n(String[] t, int k, String w) throws InputException {
        if (t.length != k) {
            throw new InputException(w + t[0] + " has the wrong number of values");
        }
    }

    private static String var(String s, String w) throws InputException {
        if (!VAR.matcher(s).matches()) {
            throw new InputException(w + "bad variable name " + s);
        }
        return s;
    }

    private static float fin(String s, String w) throws InputException {
        float v = Float.parseFloat(s);
        if (!Float.isFinite(v)) {
            throw new InputException(w + "number must be finite");
        }
        return v;
    }

    /* ------------------------------------------------------------ the running plant */

    protected final Spec spec;
    protected final float[] y;

    protected Plant(Spec spec) {
        this.spec = spec;
        this.y = new float[spec.outputs.size()];
    }

    /** Builds a fresh plant for one run. projectDir resolves the FMU path. */
    public static Plant create(Spec s, Path projectDir, Path workDir) throws Exception {
        return switch (s.kind) {
            case "first_order" -> new FirstOrder(s);
            case "second_order" -> new SecondOrder(s);
            default -> new FmuPlant(s, projectDir, workDir);
        };
    }

    public float output(int i) {
        return y[i];
    }

    public int outputCount() {
        return y.length;
    }

    /** Combined drive from the firmware outputs (built-ins sum DRIVE * GAIN). */
    protected float drive(float[] fwOut) {
        float u = 0f;
        for (Drive d : spec.drives) {
            u += d.gain() * fwOut[d.fwOutput()];
        }
        return u;
    }

    public abstract void step(float[] fwOutputs, float disturbance, float dt) throws Exception;

    @Override
    public void close() {
        // built-in models hold no resources
    }

    static final class FirstOrder extends Plant {
        private final float tau;
        private final float gain;
        private final float ambient;

        FirstOrder(Spec s) throws InputException {
            super(s);
            tau = s.param("TAU_S");
            gain = s.param("GAIN");
            ambient = s.param("AMBIENT");
            y[0] = s.outputs.get(0).initial();
        }

        @Override
        public void step(float[] fwOut, float d, float dt) {
            float rate = (-(y[0] - ambient) + gain * drive(fwOut)) / tau + d;
            y[0] += rate * dt;
        }
    }

    static final class SecondOrder extends Plant {
        private final float wn;
        private final float zeta;
        private final float gain;
        private final float offset;
        private final boolean stops;
        private final float lo;
        private final float hi;

        SecondOrder(Spec s) throws InputException {
            super(s);
            wn = s.param("WN");
            zeta = s.param("ZETA");
            gain = s.param("GAIN");
            offset = s.param("OFFSET");
            stops = s.params.containsKey("LIMIT_MIN");
            lo = stops ? s.param("LIMIT_MIN") : 0f;
            hi = stops ? s.param("LIMIT_MAX") : 0f;
            y[0] = s.outputs.get(0).initial();
            y[1] = s.outputs.get(1).initial();
        }

        @Override
        public void step(float[] fwOut, float d, float dt) {
            float acc = wn * wn * (gain * drive(fwOut) - (y[0] - offset)) - 2f * zeta * wn * y[1] + d;
            y[1] += acc * dt;     /* semi-implicit Euler: stable for stiff second-order systems */
            y[0] += y[1] * dt;
            if (stops && y[0] < lo) {
                y[0] = lo;          /* inelastic end stop: the mechanism stops dead */
                y[1] = Math.max(0f, y[1]);
            } else if (stops && y[0] > hi) {
                y[0] = hi;
                y[1] = Math.min(0f, y[1]);
            }
        }
    }
}
