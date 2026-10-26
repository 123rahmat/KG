package kg.core;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/**
 * Runs external programs safely: argument list only (never a shell), cleared environment,
 * hard timeout that kills the whole process tree, output captured to a log file,
 * and Linux network isolation when available.
 */
public final class Proc {
    public record Result(int exit, boolean timedOut, long millis) {
        public boolean ok() {
            return !timedOut && exit == 0;
        }
    }

    public enum Isolation { NETWORK_NAMESPACE, NONE }

    private static final Isolation ISOLATION = detect();

    private Proc() {
    }

    private static Isolation detect() {
        if (!System.getProperty("os.name", "").toLowerCase(java.util.Locale.ROOT).contains("linux")) {
            return Isolation.NONE;
        }
        if (!Files.isExecutable(Path.of("/usr/bin/unshare"))) {
            return Isolation.NONE;
        }
        try {
            Process p = new ProcessBuilder("/usr/bin/unshare", "--net", "--map-root-user", "/bin/true")
                    .redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.DISCARD).start();
            if (p.waitFor(5, TimeUnit.SECONDS) && p.exitValue() == 0) {
                return Isolation.NETWORK_NAMESPACE;
            }
            p.destroyForcibly();
        } catch (IOException e) {
            return Isolation.NONE;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        return Isolation.NONE;
    }

    static boolean windows() {
        return System.getProperty("os.name", "").toLowerCase(java.util.Locale.ROOT).startsWith("windows");
    }

    /** Minimal, fixed PATH on Unix; on Windows the system PATH is kept so compilers can be found. */
    private static void cleanEnv(Map<String, String> env) {
        String javaHome = System.getProperty("java.home");
        String winPath = windows() ? System.getenv("PATH") : null;
        String sysRoot = windows() ? System.getenv("SystemRoot") : null;
        env.clear();
        if (windows()) {
            env.put("PATH", winPath == null ? "" : winPath);
            if (sysRoot != null) {
                env.put("SystemRoot", sysRoot);
            }
        } else {
            env.put("PATH", "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin");
        }
        env.put("LC_ALL", "C");
        env.put("TZ", "UTC");
        env.put("SOURCE_DATE_EPOCH", "0");
        env.put("JAVA_HOME", javaHome);
    }

    private static java.io.File nullDevice() {
        return new java.io.File(windows() ? "NUL" : "/dev/null");
    }

    public static Isolation isolation() {
        return ISOLATION;
    }

    /** Starts a long-running child (a simulated board) with pipes, same isolation and clean environment. */
    public static Process startPiped(List<String> argv, Path workDir, Path errLog) throws IOException {
        List<String> cmd = new ArrayList<>();
        if (ISOLATION == Isolation.NETWORK_NAMESPACE) {
            cmd.add("/usr/bin/unshare");
            cmd.add("--net");
            cmd.add("--map-root-user");
            cmd.add("--");
        }
        cmd.addAll(argv);
        Files.createDirectories(errLog.toAbsolutePath().getParent());
        Files.writeString(errLog, "$ " + String.join(" ", argv) + "\n", StandardCharsets.UTF_8,
                StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.directory(workDir.toFile());
        cleanEnv(pb.environment());
        pb.redirectError(ProcessBuilder.Redirect.appendTo(errLog.toFile()));
        return pb.start();
    }

    /**
     * Like run, but standard output goes to its own file (for programs whose output is data,
     * such as test generators) and errors go to the log. Same isolation and clean environment.
     */
    public static Result runCapture(List<String> argv, Path workDir, Path stdout, Path log, Duration timeout) throws IOException {
        List<String> cmd = new ArrayList<>();
        if (ISOLATION == Isolation.NETWORK_NAMESPACE) {
            cmd.add("/usr/bin/unshare");
            cmd.add("--net");
            cmd.add("--map-root-user");
            cmd.add("--");
        }
        cmd.addAll(argv);
        Files.createDirectories(log.toAbsolutePath().getParent());
        Files.writeString(log, "$ " + String.join(" ", argv) + "\n", StandardCharsets.UTF_8,
                StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.directory(workDir.toFile());
        cleanEnv(pb.environment());
        pb.redirectOutput(ProcessBuilder.Redirect.to(stdout.toFile()));
        pb.redirectError(ProcessBuilder.Redirect.appendTo(log.toFile()));
        pb.redirectInput(ProcessBuilder.Redirect.from(nullDevice()));
        long t0 = System.nanoTime();
        Process p = pb.start();
        boolean done;
        try {
            done = p.waitFor(timeout.toMillis(), TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            done = false;
        }
        if (!done) {
            p.descendants().forEach(ProcessHandle::destroyForcibly);
            p.destroyForcibly();
            return new Result(-1, true, (System.nanoTime() - t0) / 1_000_000);
        }
        return new Result(p.exitValue(), false, (System.nanoTime() - t0) / 1_000_000);
    }

    public static Result run(List<String> argv, Path workDir, Path log, Duration timeout) throws IOException {
        if (argv.isEmpty()) {
            throw new IllegalArgumentException("empty command");
        }
        List<String> cmd = new ArrayList<>();
        if (ISOLATION == Isolation.NETWORK_NAMESPACE) {
            cmd.add("/usr/bin/unshare");
            cmd.add("--net");
            cmd.add("--map-root-user");
            cmd.add("--");
        }
        cmd.addAll(argv);
        Files.createDirectories(log.toAbsolutePath().getParent());
        Files.writeString(log, "$ " + String.join(" ", argv) + "\n", StandardCharsets.UTF_8,
                StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.directory(workDir.toFile());
        cleanEnv(pb.environment());
        pb.redirectErrorStream(true);
        pb.redirectOutput(ProcessBuilder.Redirect.appendTo(log.toFile()));
        pb.redirectInput(ProcessBuilder.Redirect.from(nullDevice()));
        long t0 = System.nanoTime();
        Process p = pb.start();
        boolean done;
        try {
            done = p.waitFor(timeout.toMillis(), TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            done = false;
        }
        if (!done) {
            p.descendants().forEach(ProcessHandle::destroyForcibly);
            p.destroyForcibly();
            try {
                p.waitFor(5, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            Files.writeString(log, "TIMEOUT_ABORT after " + timeout.toSeconds() + " s\n", StandardCharsets.UTF_8,
                    StandardOpenOption.APPEND);
            return new Result(-1, true, (System.nanoTime() - t0) / 1_000_000);
        }
        return new Result(p.exitValue(), false, (System.nanoTime() - t0) / 1_000_000);
    }
}
