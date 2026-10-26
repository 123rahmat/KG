package kg.core;

import java.io.BufferedWriter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.regex.Pattern;

/**
 * One line per tick, same format on every tier. Values are written with Float.toString, the
 * shortest text that reads back to the identical float, so exact comparisons stay exact.
 *
 *   # kindgleam-trace v2
 *   tick,<signal>,<signal>,...,wd,exec_ns,state_hash
 */
public final class Trace {
    public static final String MAGIC = "# kindgleam-trace v2";
    private static final Pattern NAME = Pattern.compile("[a-z][a-z0-9_]{0,23}");

    public final List<String> columns;
    private final float[][] v;
    private final long[] execNs;
    private final String[] hash;

    private Trace(List<String> columns, float[][] v, long[] execNs, String[] hash) {
        this.columns = Collections.unmodifiableList(columns);
        this.v = v;
        this.execNs = execNs;
        this.hash = hash;
    }

    public int ticks() {
        return v.length;
    }

    public int col(String name) {
        return columns.indexOf(name);
    }

    public float get(int tick, int col) {
        return v[tick][col];
    }

    public long execNs(int tick) {
        return execNs[tick];
    }

    public String hash(int tick) {
        return hash[tick];
    }

    public static Trace read(Path p) throws InputException {
        List<String> lines = SafeFiles.readLines(p, 128L * 1024 * 1024, 4000);
        if (lines.size() < 2 || !lines.get(0).equals(MAGIC)) {
            throw new InputException(p.getFileName() + ": not a kindgleam v2 trace");
        }
        String[] h = lines.get(1).split(",", -1);
        if (h.length < 5 || !h[0].equals("tick") || !h[h.length - 3].equals("wd") || !h[h.length - 2].equals("exec_ns")
                || !h[h.length - 1].equals("state_hash")) {
            throw new InputException(p.getFileName() + ": bad trace header");
        }
        List<String> cols = new ArrayList<>();
        for (int i = 1; i < h.length - 2; i++) {
            if (!NAME.matcher(h[i]).matches() || cols.contains(h[i])) {
                throw new InputException(p.getFileName() + ": bad column name " + h[i]);
            }
            cols.add(h[i]);
        }
        int n = lines.size() - 2;
        if (n > Vector.MAX_TICKS) {
            throw new InputException(p.getFileName() + ": too many ticks");
        }
        float[][] v = new float[n][cols.size()];
        long[] ex = new long[n];
        String[] hs = new String[n];
        for (int i = 0; i < n; i++) {
            String[] f = lines.get(i + 2).split(",", -1);
            String where = p.getFileName() + ":" + (i + 3) + ": ";
            if (f.length != h.length) {
                throw new InputException(where + "wrong number of fields");
            }
            try {
                if (Integer.parseInt(f[0]) != i) {
                    throw new InputException(where + "tick out of sequence");
                }
                for (int c = 0; c < cols.size(); c++) {
                    float x = Float.parseFloat(f[c + 1]);
                    if (!Float.isFinite(x)) {
                        throw new InputException(where + "non-finite value");
                    }
                    v[i][c] = x;
                }
                ex[i] = Long.parseLong(f[f.length - 2]);
                if (ex[i] < 0) {
                    throw new InputException(where + "negative exec time");
                }
            } catch (NumberFormatException e) {
                throw new InputException(where + "bad number");
            }
            if (!f[f.length - 1].matches("[0-9a-f]{8}")) {
                throw new InputException(where + "bad state hash");
            }
            hs[i] = f[f.length - 1];
        }
        return new Trace(cols, v, ex, hs);
    }

    /** Streaming writer; one row per tick. */
    public static final class Writer implements AutoCloseable {
        private final BufferedWriter w;
        private final int ncol;
        private final StringBuilder sb = new StringBuilder(256);
        private int next;

        public Writer(Path p, List<String> cols) throws IOException {
            this.w = Files.newBufferedWriter(p, StandardCharsets.UTF_8);
            this.ncol = cols.size();
            w.write(MAGIC);
            w.write('\n');
            w.write("tick," + String.join(",", cols) + ",exec_ns,state_hash".replace(",exec_ns", ",exec_ns"));
            w.write('\n');
        }

        public void row(int tick, float[] vals, long execNs, int stateHash) throws IOException {
            if (tick != next++ || vals.length != ncol) {
                throw new IllegalStateException("trace rows out of order or wrong width");
            }
            sb.setLength(0);
            sb.append(tick);
            for (float x : vals) {
                sb.append(',').append(Float.toString(x));
            }
            sb.append(',').append(execNs).append(',').append(String.format("%08x", stateHash)).append('\n');
            w.write(sb.toString());
        }

        @Override
        public void close() throws IOException {
            w.close();
        }
    }
}
