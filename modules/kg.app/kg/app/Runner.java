package kg.app;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;
import javax.swing.SwingUtilities;

/**
 * Runs the CLI as a separate process with --format=lines and streams its events to the UI thread.
 * The app never decides anything itself: it only shows what the coordinator reports.
 */
final class Runner {
    /** One parsed event: kind is run, agent, gate, check, verdict, triage, ... ; f holds the fields. */
    record Event(String kind, String[] f, String raw) { }

    private final Path home;
    private Process proc;

    Runner(Path home) {
        this.home = home;
    }

    boolean busy() {
        return proc != null && proc.isAlive();
    }

    void cancel() {
        if (busy()) {
            proc.descendants().forEach(ProcessHandle::destroy);
            proc.destroy();
        }
    }

    /** Starts a command; events and the exit code arrive on the Swing thread. */
    void start(Path project, List<String> args, Consumer<Event> onEvent, Consumer<Integer> onExit) throws IOException {
        if (busy()) {
            throw new IOException("a run is already in progress");
        }
        if (!Files.isDirectory(home.resolve("build").resolve("mods"))) {
            throw new IOException("Kindgleam modules not found in " + home);
        }
        List<String> all = new ArrayList<>(args);
        all.add("--project=" + project);
        all.add("--format=lines");
        List<String> cmd = kg.core.Places.cli(home, all);
        ProcessBuilder pb = new ProcessBuilder(cmd).redirectErrorStream(true);
        pb.environment().remove("JAVA_TOOL_OPTIONS");
        proc = pb.start();
        Process p = proc;
        Thread t = new Thread(() -> {
            try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
                String l;
                while ((l = r.readLine()) != null) {
                    if (l.length() > 4000) {
                        l = l.substring(0, 4000);
                    }
                    Event e;
                    if (l.startsWith("KG|")) {
                        String[] f = l.substring(3).split("\\|", -1);
                        e = new Event(f[0], f, l);
                    } else {
                        e = new Event("text", new String[] {"text", l}, l);
                    }
                    SwingUtilities.invokeLater(() -> onEvent.accept(e));
                }
                int code = p.waitFor();
                SwingUtilities.invokeLater(() -> onExit.accept(code));
            } catch (IOException | InterruptedException ex) {
                SwingUtilities.invokeLater(() -> onExit.accept(-1));
            }
        }, "kg-runner");
        t.setDaemon(true);
        t.start();
    }
}
