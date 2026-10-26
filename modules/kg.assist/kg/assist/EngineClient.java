package kg.assist;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.function.Consumer;
import kg.core.Proc;

/**
 * Talks to the kg-infer engine process. The engine runs with the same isolation as every other
 * Kindgleam child process (no network namespace on Linux, clean environment) and is given only
 * the model path and its sealed hash. Stopping a request kills the process.
 */
public final class EngineClient implements AutoCloseable {
    /** One chat message. Role is system, user or assistant. */
    public record Msg(String role, String text) { }

    /** Outcome of one generation. */
    public record Result(String text, String reason, int promptTokens, int tokens, long millis) { }

    private final Path home;
    private final Path model;
    private final String sha;
    private final Path log;
    private Process proc;
    private BufferedReader in;
    private OutputStream out;
    private String ready = "";

    public EngineClient(Path home, ModelStore.Status st, Path log) {
        this.home = home;
        this.model = st.file();
        this.sha = st.sha256();
        this.log = log;
    }

    public static Path binary(Path home) {
        boolean win = System.getProperty("os.name", "").toLowerCase(java.util.Locale.ROOT).startsWith("windows");
        return home.resolve("engine").resolve("build").resolve(win ? "kg-infer.exe" : "kg-infer");
    }

    public String info() {
        return ready;
    }

    public boolean running() {
        return proc != null && proc.isAlive();
    }

    public synchronized void start() throws IOException {
        if (running()) {
            return;
        }
        Path bin = binary(home);
        if (!Files.isExecutable(bin)) {
            throw new IOException("engine not built: " + bin);
        }
        int threads = Math.max(1, Math.min(8, Runtime.getRuntime().availableProcessors()));
        List<String> argv = List.of(bin.toString(), "--model", model.toString(), "--sha256", sha, "--ctx", "8192",
                "--threads", String.valueOf(threads));
        proc = Proc.startPiped(argv, home, log);
        in = new BufferedReader(new InputStreamReader(proc.getInputStream(), StandardCharsets.UTF_8));
        out = proc.getOutputStream();
        String first = in.readLine();
        if (first == null || !first.startsWith("READY")) {
            String why = first == null ? "engine exited while loading; see " + log : first;
            stop();
            throw new IOException(why.startsWith("ERR ") ? why.substring(4) : why);
        }
        ready = first.substring(6);
    }

    public synchronized void stop() {
        if (proc != null) {
            proc.destroyForcibly();
            proc = null;
        }
    }

    /** Runs one request. Each token's text is passed to onToken as soon as it arrives. */
    public Result generate(List<Msg> msgs, int maxTokens, int maxSeconds, Consumer<String> onToken) throws IOException {
        start();
        StringBuilder req = new StringBuilder();
        req.append("GEN ").append(maxTokens).append(" 0 1 ").append(maxSeconds).append(' ').append(msgs.size()).append('\n');
        ByteBuf all = new ByteBuf();
        all.add(req.toString().getBytes(StandardCharsets.US_ASCII));
        for (Msg m : msgs) {
            byte[] b = m.text().getBytes(StandardCharsets.UTF_8);
            all.add(("MSG " + m.role() + " " + b.length + "\n").getBytes(StandardCharsets.US_ASCII));
            all.add(b);
        }
        out.write(all.bytes());
        out.flush();
        java.io.ByteArrayOutputStream text = new java.io.ByteArrayOutputStream();
        Utf8Stream stream = new Utf8Stream(onToken);
        String l;
        while ((l = in.readLine()) != null) {
            if (l.startsWith("T ")) {
                byte[] b = unhex(l.substring(2));
                text.write(b, 0, b.length);
                stream.push(b);
            } else if (l.startsWith("END ")) {
                stream.flush();
                String[] f = l.split(" ");
                return new Result(text.toString(StandardCharsets.UTF_8), f[1], Integer.parseInt(f[2]), Integer.parseInt(f[3]),
                        Long.parseLong(f[4]));
            } else if (l.startsWith("ERR ")) {
                throw new IOException(l.substring(4));
            }
        }
        stop();
        throw new IOException("engine stopped unexpectedly; see " + log);
    }

    /**
     * Fill-in-the-middle completion: the model sees the code before and after the cursor and writes
     * what belongs in between (Qwen2.5-Coder's native completion format). Returns the inserted text.
     */
    public synchronized Result complete(String prefix, String suffix, int maxTokens, int maxSeconds) throws IOException {
        start();
        byte[] p = prefix.getBytes(StandardCharsets.UTF_8);
        byte[] q = suffix.getBytes(StandardCharsets.UTF_8);
        out.write(("FIM " + maxTokens + " " + maxSeconds + " " + p.length + " " + q.length + "\n").getBytes(StandardCharsets.US_ASCII));
        out.write(p);
        out.write(q);
        out.flush();
        java.io.ByteArrayOutputStream text = new java.io.ByteArrayOutputStream();
        String l;
        while ((l = in.readLine()) != null) {
            if (l.startsWith("T ")) {
                byte[] b = unhex(l.substring(2));
                text.write(b, 0, b.length);
            } else if (l.startsWith("END ")) {
                String[] f = l.split(" ");
                return new Result(text.toString(StandardCharsets.UTF_8), f[1], Integer.parseInt(f[2]), Integer.parseInt(f[3]),
                        Long.parseLong(f[4]));
            } else if (l.startsWith("ERR ")) {
                throw new IOException(l.substring(4));
            }
        }
        stop();
        throw new IOException("engine stopped unexpectedly; see " + log);
    }

    @Override
    public void close() {
        stop();
    }

    private static byte[] unhex(String h) throws IOException {
        if (h.length() % 2 != 0 || h.length() > 4096) {
            throw new IOException("bad token from engine");
        }
        byte[] b = new byte[h.length() / 2];
        for (int i = 0; i < b.length; i++) {
            int hi = Character.digit(h.charAt(2 * i), 16);
            int lo = Character.digit(h.charAt(2 * i + 1), 16);
            if (hi < 0 || lo < 0) {
                throw new IOException("bad token from engine");
            }
            b[i] = (byte) (hi << 4 | lo);
        }
        return b;
    }

    /** Collects bytes. */
    private static final class ByteBuf {
        private final java.io.ByteArrayOutputStream o = new java.io.ByteArrayOutputStream();

        void add(byte[] b) {
            o.write(b, 0, b.length);
        }

        byte[] bytes() {
            return o.toByteArray();
        }
    }

    /** Passes on only whole UTF-8 characters, holding back a split multi-byte sequence. */
    private static final class Utf8Stream {
        private final Consumer<String> sink;
        private final java.io.ByteArrayOutputStream pend = new java.io.ByteArrayOutputStream();

        Utf8Stream(Consumer<String> sink) {
            this.sink = sink;
        }

        void push(byte[] b) {
            pend.write(b, 0, b.length);
            byte[] all = pend.toByteArray();
            int cut = all.length;
            for (int back = 1; back <= Math.min(3, all.length); back++) {
                int c = all[all.length - back] & 0xFF;
                if ((c & 0xC0) == 0xC0) {
                    int need = c >= 0xF0 ? 4 : c >= 0xE0 ? 3 : 2;
                    if (back < need) {
                        cut = all.length - back;
                    }
                    break;
                }
                if ((c & 0x80) == 0) {
                    break;
                }
            }
            if (cut > 0 && sink != null) {
                sink.accept(new String(all, 0, cut, StandardCharsets.UTF_8));
            }
            pend.reset();
            pend.write(all, cut, all.length - cut);
        }

        void flush() {
            if (pend.size() > 0 && sink != null) {
                sink.accept(pend.toString(StandardCharsets.UTF_8));
            }
            pend.reset();
        }
    }
}
