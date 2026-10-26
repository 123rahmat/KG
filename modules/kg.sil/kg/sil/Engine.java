package kg.sil;

import java.nio.file.Path;
import kg.core.Interface;
import kg.core.Trace;
import kg.core.Vector;

/**
 * The one test loop shared by every tier. It applies the vector's commands and faults, feeds the
 * plant's outputs to the firmware's sensor inputs, asks a Stepper for one firmware tick (local
 * library for SIL, a board over the link for PIL), drives the plant and writes the trace.
 * Because SIL and PIL share this loop, any difference between their traces comes from the
 * firmware's execution environment, which is exactly what co-verification must expose.
 */
public final class Engine {
    /** One firmware tick on some execution target. */
    public interface Stepper {
        /** Start a run: fresh firmware state, watchdog armed, outputs safe on trip. */
        void init(float[] safeOutputs, Interface.HangLatch latch, float[] maxOutputs) throws Exception;

        Result step(int tick, float[] inputs, boolean watchdogOn) throws Exception;

        /** Test command: the firmware stops running from now on. */
        void hang() throws Exception;
    }

    public record Result(float[] outputs, boolean watchdogTripped, int stateHash, long execNs) { }

    private Engine() {
    }

    public static void run(Interface itf, Plant.Spec spec, Plant plant, Vector v, Stepper s, Path traceOut) throws Exception {
        int nIn = itf.inputs.size();
        int nOut = itf.outputs.size();
        int nPlant = spec.outputs.size();
        float[] safe = new float[nOut];
        float[] max = new float[nOut];
        for (int i = 0; i < nOut; i++) {
            safe[i] = itf.outputs.get(i).safe();
            max[i] = itf.outputs.get(i).max();
        }
        s.init(safe, itf.hangLatch, max);

        float[] command = new float[nIn];
        for (int i = 0; i < nIn; i++) {
            command[i] = itf.inputs.get(i).dflt();
        }
        Float[] stuck = new Float[nIn];
        float[] offset = new float[nIn];
        float[] noise = new float[nIn];
        boolean[] freeze = new boolean[nIn];
        Float[] frozen = new Float[nIn];
        float disturb = 0f;
        long rng = v.seed == 0 ? 1 : v.seed;
        float[] in = new float[nIn];
        float[] row = new float[nIn + nOut + nPlant + 1];
        float dt = itf.dt();

        try (Trace.Writer w = new Trace.Writer(traceOut, Vector.columns(itf, spec.outputNames()))) {
            for (int t = 0; t < v.ticks; t++) {
                for (Vector.Set st : v.sets) {
                    if (st.tick() == t) {
                        command[st.input()] = st.value();
                    }
                }
                boolean hangNow = false;
                for (Vector.Fault f : v.faults) {
                    if (f.tick() != t) {
                        continue;
                    }
                    switch (f.kind()) {
                        case HANG -> hangNow = true;
                        case STUCK -> stuck[f.input()] = f.value();
                        case OFFSET -> offset[f.input()] += f.value();
                        case NOISE -> noise[f.input()] = f.value();
                        case FREEZE -> freeze[f.input()] = true;
                        case DISTURB -> disturb += f.value();
                        default -> throw new IllegalStateException("unknown fault");
                    }
                }
                for (int i = 0; i < nIn; i++) {
                    Interface.Input d = itf.inputs.get(i);
                    if (d.source() == Interface.Source.COMMAND) {
                        in[i] = command[i];
                        continue;
                    }
                    float x = 0f;
                    for (Plant.Sensor sn : spec.sensors) {
                        if (sn.fwInput() == i) {
                            x = plant.output(sn.plantOutput());
                        }
                    }
                    if (noise[i] > 0f) {
                        rng = (rng * 1664525L + 1013904223L) & 0xFFFF_FFFFL;
                        x += ((float) (rng >>> 8) / 16777216.0f * 2.0f - 1.0f) * noise[i];
                    }
                    x += offset[i];
                    if (freeze[i]) {
                        if (frozen[i] == null) {
                            frozen[i] = x;
                        }
                        x = frozen[i];
                    }
                    if (stuck[i] != null) {
                        x = stuck[i];
                    }
                    in[i] = x;
                }
                if (hangNow) {
                    s.hang();
                }
                Result r = s.step(t, in, v.watchdogOn);
                float[] out = r.outputs();
                if (out.length != nOut) {
                    throw new IllegalStateException("target returned " + out.length + " outputs, expected " + nOut);
                }
                for (int i = 0; i < nOut; i++) {
                    if (!Float.isFinite(out[i])) {
                        throw new IllegalStateException("firmware output " + itf.outputs.get(i).name()
                                + " is not a finite number at tick " + t);
                    }
                }
                plant.step(out, disturb, dt);
                int k = 0;
                for (float x : in) {
                    row[k++] = x;
                }
                for (float x : out) {
                    row[k++] = x;
                }
                for (int i = 0; i < nPlant; i++) {
                    float p = plant.output(i);
                    if (!Float.isFinite(p)) {
                        throw new IllegalStateException("plant output " + spec.outputs.get(i).name() + " diverged at tick " + t);
                    }
                    row[k++] = p;
                }
                row[k] = r.watchdogTripped() ? 1f : 0f;
                w.row(t, row, r.execNs(), r.stateHash());
            }
        }
    }

    /** SIL stepper: the firmware library in this process plus the watchdog model. */
    public static final class Local implements Stepper {
        private final Firmware fw;
        private WatchdogModel wd;
        private boolean hung;
        private float[] safe;
        private float[] max;
        private float[] last;
        private Interface.HangLatch latch;

        public Local(Firmware fw) {
            this.fw = fw;
        }

        @Override
        public void init(float[] safeOutputs, Interface.HangLatch l, float[] maxOutputs) throws Exception {
            try {
                fw.init();
            } catch (Exception e) {
                throw e;
            } catch (Throwable t) {
                throw new IllegalStateException(t);
            }
            wd = new WatchdogModel(1, 2);
            hung = false;
            safe = safeOutputs.clone();
            max = maxOutputs.clone();
            last = safeOutputs.clone();
            latch = l;
        }

        @Override
        public Result step(int tick, float[] inputs, boolean wdOn) throws Exception {
            try {
                if (wdOn) {
                    wd.tick();
                }
                float[] out;
                if (hung) {
                    out = switch (latch) {
                        case MAX -> max.clone();
                        case LAST -> last.clone();
                        case SAFE -> safe.clone();
                    };
                } else {
                    out = fw.step(inputs);
                    last = out.clone();
                    if (wdOn) {
                        wd.kick(fw.progressToken(tick));
                    }
                }
                if (wd.tripped()) {
                    out = safe.clone();
                }
                return new Result(out, wd.tripped(), fw.stateHash(), 0L);
            } catch (Exception e) {
                throw e;
            } catch (Throwable t) {
                throw new IllegalStateException(t);
            }
        }

        @Override
        public void hang() {
            hung = true;
        }
    }
}
