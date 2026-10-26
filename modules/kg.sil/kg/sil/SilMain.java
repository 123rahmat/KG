package kg.sil;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import kg.core.InputException;
import kg.core.Interface;
import kg.core.Vector;

/**
 * SIL runner. Always started as its own process, so a crash in the C firmware or an FMU can never
 * affect the coordinator, the verdict or the desktop app.
 *
 * usage: SilMain <libfw> <project dir> <interface.cfg> <plant.model> <work dir> <vec> <trace> [<vec> <trace> ...]
 * exit:  0 = traces written, 2 = input or runtime error
 */
public final class SilMain {
    private SilMain() {
    }

    public static void main(String[] a) {
        if (a.length < 7 || (a.length - 5) % 2 != 0 || a.length > 405) {
            System.err.println("usage: SilMain <libfw> <project> <interface.cfg> <plant.model> <workdir> <vec> <trace> [...]");
            System.exit(2);
        }
        try {
            Path project = Path.of(a[1]);
            Interface itf = Interface.load(Path.of(a[2]));
            Plant.Spec spec = Plant.load(Path.of(a[3]), itf);
            Path work = Path.of(a[4]);
            List<String> plantOut = spec.outputNames();
            try (Firmware fw = new Firmware(Path.of(a[0]), itf.inputs.size(), itf.outputs.size())) {
                Engine.Local stepper = new Engine.Local(fw);
                List<Path[]> jobs = new ArrayList<>();
                for (int i = 5; i < a.length; i += 2) {
                    jobs.add(new Path[] {Path.of(a[i]), Path.of(a[i + 1])});
                }
                for (Path[] j : jobs) {
                    Vector v = Vector.load(j[0], itf, plantOut);
                    try (Plant plant = Plant.create(spec, project, work)) {
                        Engine.run(itf, spec, plant, v, stepper, j[1]);
                    }
                }
            }
        } catch (InputException e) {
            System.err.println("INPUT ERROR: " + e.getMessage());
            System.exit(2);
        } catch (Throwable t) {
            System.err.println("SIL ERROR: " + t);
            System.exit(2);
        }
    }
}
